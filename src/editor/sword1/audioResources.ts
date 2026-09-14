/**
 * Reading one of Broken Sword's own recordings back out of its folder.
 *
 * The other end of `authoring/sword1/audioList.ts`. That side lists what a
 * release has, by the numbers its own scripts say and without keeping a byte;
 * this side turns one of those numbers back into bytes at the moment an author
 * presses play or save.
 *
 * ## Three kinds, three different reads
 *
 * **Music** is a file beside the install, so it is read whole — a tune is a
 * couple of megabytes and is wanted entire.
 *
 * **An effect** is a resource inside a cluster, and it is read by *range*
 * rather than through `SwordResources`. That class answers `fetch` only for a
 * resident cluster and `load` makes one resident, which for `PARIS1.CLU` is
 * 13.5 MB held to hand back a twenty-kilobyte footstep. The index already says
 * where the resource sits, so the two numbers it gives are the read.
 *
 * **A line of speech** is the one that cannot be handed over as it lies. The
 * container's entries are a WAVE header wrapping Revolution's own 16-bit RLE,
 * so a browser handed those bytes decodes silence at best, and a file saved
 * from them opens in nothing. So this decodes the line and writes a real WAVE
 * around it — which is why the listing calls a speech row `wav`: by the time
 * anything sees its bytes, it is one.
 */

import type { AudioResource } from '../../authoring/audio.js';
import { readRangeFrom } from '../../engine/resource/DataSource.js';
import { locateResource } from '../../engine/sword1/resource/rif.js';
import { sword1SampleId } from '../../engine/sword1/sound/fxTable.js';
import { sword1MusicFileIn } from '../../engine/sword1/sound/musicFiles.js';
import {
  checkSpeechEndianness,
  expandSpeech,
  SwordAudioError,
  type Sword1SpeechMode,
} from '../../engine/sword1/sound/swordAudio.js';
import { writeWavePcm } from '../../engine/sound/wave.js';
import type { AudioResourceReader } from '../audioBytes.js';
import type { Sword1GameFolder } from './resupply.js';

/** Speech is 11.025 kHz mono, as `speechSample` says and every release is. */
const SPEECH_RATE = 11025;

/** The bytes a resource entry addresses, or null when this folder has none. */
export function sword1AudioReader(folder: Sword1GameFolder): AudioResourceReader {
  // Decided once per container, not once per line: the check decodes a sample
  // both ways to see which stays in bounds, and the answer is a fact about the
  // file rather than about the line.
  let bigEndian: boolean | null = null;

  const readEffect = async (fx: number): Promise<Uint8Array | null> => {
    const id = sword1SampleId(fx, folder.windowsDemo);
    if (id === null) return null;
    const located = locateResource(folder.index, id);
    if (!located) return null;
    const file = folder.clusterFiles.get(located.cluster.label.toUpperCase());
    if (!file) return null;
    const { offset, length } = located.resource;
    return readRangeFrom(folder.source, file, offset, offset + length);
  };

  const readSpeech = async (room: number, line: number): Promise<Uint8Array | null> => {
    const index = folder.speech;
    if (!index) return null;
    const entry = index.locate(room, line);
    if (!entry) return null;
    const bytes = await readRangeFrom(folder.source, index.file, entry.at, entry.at + entry.length);
    if (!bytes || bytes.length === 0) return null;
    const mode = sword1SpeechModeFor(index.file);
    try {
      bigEndian ??= checkSpeechEndianness(bytes, mode);
      return waveOf(expandSpeech(bytes, bigEndian, mode), SPEECH_RATE);
    } catch (error) {
      // A line that will not decode is a line, not a fault in the folder, so
      // it answers nothing and the row says its bytes could not be reached.
      if (error instanceof SwordAudioError) return null;
      throw error;
    }
  };

  return async (resource: AudioResource) => {
    if (resource.engine !== 'sword1') return null;
    switch (resource.kind) {
      case 'music': {
        const file = resource.file ?? sword1MusicFileIn(folder.source.list(), resource.number);
        return file ? folder.source.read(file) : null;
      }
      case 'effects':
        return readEffect(resource.number);
      case 'speech':
        return resource.bank === undefined ? null : readSpeech(resource.bank, resource.number);
      default:
        return null;
    }
  };
}

/**
 * Which of the two containers this is, from its name.
 *
 * The same rule `SwordSound` uses and for the same evidence — the original
 * sets `CowDemo` exactly when it opened `cows.mad` (`sound.cpp:784`).
 */
function sword1SpeechModeFor(file: string): Sword1SpeechMode {
  return /(?:^|[/\\])cows\.mad$/i.test(file) ? 'demo' : 'wave';
}

/**
 * 16-bit mono PCM wrapped in the smallest WAVE that plays everywhere.
 *
 * `writeWavePcm`'s forty-four bytes, with speech's own rate as the default.
 * Kept as a name here because this is the one surface that has decoded samples
 * and needs a file, and every caller of it means *a line of Broken Sword
 * speech* rather than a WAVE in general.
 */
export function waveOf(samples: Int16Array, sampleRate = SPEECH_RATE): Uint8Array {
  return writeWavePcm(samples, sampleRate);
}
