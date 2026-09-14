/**
 * Reading one of a SCI game's own recordings back out of its folder.
 *
 * The other end of `authoring/sci/audioList.ts`. That side lists what a release
 * has, by the numbers its own maps say and without keeping a byte; this side
 * turns one of those numbers back into bytes at the moment an author presses
 * play or save.
 *
 * ## Two containers, one decode
 *
 * A row that names a **file** is in `RESOURCE.AUD` or `RESOURCE.SFX`, and its
 * offset comes from the base audio map — read once per folder and kept, because
 * it is a few kilobytes and every row needs it. A row that names none is an
 * `audio` resource in the ordinary resource map, read through `SciResources`
 * like any View.
 *
 * Either way what arrives is one sample, and there are two kinds of those:
 * Freddy Pharkas's demo ships RIFF WAVE and Space Quest 6 ships Sierra's SOL,
 * and no Version predicts which. A RIFF sample is already a file and is handed
 * over as it lies. A SOL sample is a header and raw PCM with no container, so a
 * WAVE is written around it by `engine/sound/wave.ts` — the same writer Broken Sword's
 * speech goes through, rather than a second one that could disagree.
 *
 * ## What it refuses
 *
 * **A DPCM sample.** SOL's flag bit 0 says the body is Sierra's delta
 * compression, and this project has no decoder for it. Handing those bytes over
 * as PCM would play noise at the right length — the one fault class that cannot
 * be seen in a report and can only be heard — so the row answers nothing
 * instead, exactly as a Broken Sword line that will not decode does.
 *
 * Nothing here reads more than the sample asked for. A SCI2.1 talkie's
 * `RESOURCE.AUD` is hundreds of megabytes and is addressed by range (ADR 0021),
 * which is what makes a play button on row four thousand cost the same as one
 * on row one.
 */

import type { AudioResource } from '../../authoring/audio.js';
import { SourceVolumeReader } from '../../engine/resource/VolumeReader.js';
import {
  looksLikeRiffSample,
  readSciAudioHeader,
  readSciAudioMap,
  SCI_BASE_AUDIO_MAP,
  type SciAudioSample,
} from '../../engine/sci/sound/sciAudio.js';
import type { AudioResourceReader } from '../audioBytes.js';
import { writeWavePcm } from '../../engine/sound/wave.js';
import type { SciGameFolder } from './resupply.js';

/** The bulk files a row can name, in the order a folder is asked for them. */
const CONTAINERS = ['RESOURCE.AUD', 'RESOURCE.SFX'] as const;

/** The bytes a row addresses, or null when this folder cannot answer it. */
export function sciAudioReader(folder: SciGameFolder): AudioResourceReader {
  const volumes = new SourceVolumeReader(folder.source);

  /** Number to offset, read once: the base map is a table, not a Volume. */
  let offsets: Map<number, number> | null = null;
  const baseMap = async (): Promise<Map<number, number>> => {
    if (offsets) return offsets;
    const table = new Map<number, number>();
    const resource = await folder.resources.read('map', SCI_BASE_AUDIO_MAP);
    if (resource) {
      for (const entry of readSciAudioMap(resource)) {
        if (entry.number !== undefined) table.set(entry.number, entry.offset);
      }
    }
    offsets = table;
    return table;
  };

  /**
   * Which file to read, from the row's name and what the folder actually has.
   *
   * The named one when it is there. A release ships one of the two rather than
   * both, and the base map says nothing about which — so a row naming
   * `RESOURCE.AUD` in a folder that only has `RESOURCE.SFX` reads the file that
   * is present instead of answering nothing about a file that is not.
   */
  const containerFor = (named: string | undefined): string | null => {
    const present = new Set(folder.source.list().map((file) => baseName(file).toUpperCase()));
    const wanted = named?.toUpperCase();
    if (wanted && present.has(wanted)) return wanted;
    return CONTAINERS.find((file) => present.has(file)) ?? null;
  };

  const fromContainer = async (file: string, number: number): Promise<Uint8Array | null> => {
    const offset = (await baseMap()).get(number);
    if (offset === undefined) return null;

    const head = await volumes.read(file, offset, 64);
    const header = readSciAudioHeader(head);
    if (!header) return null;

    // The whole sample, header included, so the decode below sees the same
    // shape whichever container it came out of.
    const sample = await volumes.read(file, offset, sampleLength(header, head));
    return waveFrom(sample);
  };

  return async (resource: AudioResource) => {
    if (resource.engine !== 'sci') return null;

    if (!resource.file) {
      const bytes = await folder.resources.read('audio', resource.number);
      return bytes ? waveFrom(bytes) : null;
    }

    const file = containerFor(resource.file);
    return file ? fromContainer(file, resource.number) : null;
  };
}

/** How many bytes this sample occupies, header and all. */
function sampleLength(header: SciAudioSample, head: Uint8Array): number {
  // A RIFF's own size field measures everything after the first eight bytes;
  // a SOL's measures the audio alone, and its header sits in front of it.
  return looksLikeRiffSample(head) ? header.length + 8 : header.dataOffset + header.length;
}

/**
 * One sample as a file something can play.
 *
 * Null for a sample that is not one, and for DPCM — the difference being
 * reported the same way because it is the same answer to the author: these
 * bytes are not reachable as sound.
 */
export function waveFrom(sample: Uint8Array): Uint8Array | null {
  const header = readSciAudioHeader(sample);
  if (!header) return null;
  if (looksLikeRiffSample(sample)) return sample;
  if (header.compressed) return null;

  const body = sample.subarray(header.dataOffset, header.dataOffset + header.length);
  return writeWavePcm(pcmOf(body, header.sixteenBit), header.sampleRate || 11025);
}

/**
 * Sierra's raw bodies as signed 16-bit samples.
 *
 * Eight-bit SOL is **unsigned**, centred on 128, so it is not sign-extended but
 * shifted: a byte of 128 is silence and a byte of 0 is the negative peak.
 * Getting that backwards produces audio that plays at the right length with a
 * constant offset on it, which sounds like a click and a hum rather than like
 * a bug.
 */
function pcmOf(body: Uint8Array, sixteenBit: boolean): Int16Array {
  if (!sixteenBit) {
    const samples = new Int16Array(body.length);
    for (let at = 0; at < body.length; at++) samples[at] = (body[at] - 128) << 8;
    return samples;
  }

  const samples = new Int16Array(body.length >> 1);
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  for (let at = 0; at < samples.length; at++) samples[at] = view.getInt16(at * 2, true);
  return samples;
}

function baseName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}
