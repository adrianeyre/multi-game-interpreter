/**
 * Which of Broken Sword's recordings an author replaced, and where each goes.
 *
 * The join between two things that deliberately do not know about each other.
 * A replaced recording is an ordinary `ProjectAudio` track: it keeps the
 * `resource` that says which of the game's sounds it stands in for, and its
 * new bytes live inline or in the editor's audio store (`replaceAudio`). The
 * export is synchronous and knows nothing about stores or browsers. So this
 * reads the bytes — the one step that has to be asynchronous — resolves each
 * track to the place in the install its bytes belong, and hands over plain
 * lists.
 *
 * A track is a *replacement* only when it has bytes of its own. Every one of
 * the game's own recordings carries a `resource` and none of them carries
 * bytes, which is the whole of the test: `readTrackBytes` would happily read
 * any of them back out of the folder, and writing all 913 of them back through
 * the encoders would turn a save into nine re-encoding ties nobody asked for.
 *
 * ## Three kinds, three destinations
 *
 * They are as different on the way out as `audioResources.ts` found them on
 * the way in, and the difference is the whole reason this file exists:
 *
 * | kind    | where it lives                  | what an export does                     |
 * | ------- | ------------------------------- | --------------------------------------- |
 * | speech  | `SPEECH/COWS.MAD`, `SPEECH*.CLU` | re-encodes to Revolution's RLE and rebuilds the container |
 * | music   | `MUSIC/1M10.WAV` beside it      | writes the file                         |
 * | effects | a resource inside a cluster     | substitutes the resource, cluster relaid |
 *
 * Speech is the one that is re-encoded, because the container holds
 * Revolution's own 16-bit RLE and nothing else will play. Music and effects
 * are PCM WAVE where they lie — `MUSIC/1M10.WAV` is 11,025 Hz mono 16-bit and
 * so is every fx resource in `PARIS1.CLU` — so the author's file is written as
 * it stands, once the game's own reader has agreed it can read it.
 */

import type { ProjectAudio } from '../../authoring/audio.js';
import type { Project } from '../../authoring/project.js';
import type { Sword1SpeechReplacement } from '../../authoring/sword1/speechContainer.js';
import { locateResource } from '../../engine/sword1/resource/rif.js';
import { sword1SampleId } from '../../engine/sword1/sound/fxTable.js';
import { sword1MusicFileIn } from '../../engine/sword1/sound/musicFiles.js';
import { sword1TuneName } from '../../engine/sword1/sound/tuneNames.js';
import { parseWave, SwordAudioError } from '../../engine/sword1/sound/swordAudio.js';
import { readTrackBytes } from '../audioBytes.js';
import type { Sword1GameFolder } from './resupply.js';

/** Raised when a replacement cannot be written, with what was wrong. */
export class Sword1AudioExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword1AudioExportError';
  }
}

/** Everything an author replaced, sorted into the three things an export does. */
export interface Sword1AudioReplacements {
  readonly speech: readonly Sword1SpeechReplacement[];
  /** A tune, and the file in this install it is the bytes of. */
  readonly music: ReadonlyArray<{ readonly tune: number; readonly file: string; data: Uint8Array }>;
  /** An effect, as the resource id the fx table gives it. */
  readonly effects: ReadonlyArray<{ readonly fx: number; readonly id: number; data: Uint8Array }>;
}

/** Whether this track is one of the game's recordings with new bytes behind it. */
export function isSword1Replacement(track: ProjectAudio, kind: string): boolean {
  const resource = track.resource;
  if (!resource || resource.engine !== 'sword1' || resource.kind !== kind) return false;
  const inline = typeof track.data === 'string' && track.data.length > 0;
  const stored = typeof track.storeKey === 'string' && track.storeKey.length > 0;
  return inline || stored;
}

/** Whether this track is one of the game's speech lines with new bytes behind it. */
export function isSword1SpeechReplacement(track: ProjectAudio): boolean {
  // A line is addressed by screen *and* line, and `bank` is the screen. A
  // speech track without one names no line, so there is nowhere to put it.
  return isSword1Replacement(track, 'speech') && track.resource?.bank !== undefined;
}

/**
 * The game's own reader, asked whether it can read these bytes.
 *
 * Rather than a format check of this file's own. Music and effects are handed
 * to `parseWave` at the moment they play, so the question "will this play" has
 * exactly one correct answer and `parseWave` is where it is — an author who
 * drops an MP3 on a tune row should be told now, by the reader that would have
 * refused it, rather than hear silence in the exported game.
 */
function checkPlayable(bytes: Uint8Array, what: string): void {
  try {
    parseWave(bytes);
  } catch (error) {
    if (!(error instanceof SwordAudioError)) throw error;
    throw new Sword1AudioExportError(
      `The replacement for ${what} is not something Broken Sword's own reader will play: ` +
        `${error.message} The game reads a tune and an effect as PCM WAVE where they lie, so ` +
        `save the replacement as a WAV and it will be written.`,
    );
  }
}

/** Which file in this install holds a tune, refusing where the answer is no file. */
function musicFileFor(folder: Sword1GameFolder, track: ProjectAudio, tune: number): string {
  const named = track.resource?.file;
  const file = named ?? sword1MusicFileIn(folder.source.list(), tune);
  const stem = sword1TuneName(tune);
  if (!file) {
    throw new Sword1AudioExportError(
      `Tune ${tune}${stem ? ` (${stem})` : ''} has been replaced, and ${folder.name} holds no ` +
        `file for it. Broken Sword keeps its music beside the install rather than in a cluster, ` +
        `and this export writes over the file a tune already has rather than inventing one — ` +
        `open the folder that holds ${stem ? `${stem}.WAV` : 'that tune'} and it will be written.`,
    );
  }
  if (!/\.wav$/i.test(file)) {
    // A ScummVM re-encoding, which `sword1MusicFileIn` finds on purpose so a
    // re-encoded install still plays. Writing WAVE bytes into a name ending
    // `.ogg` would produce a file whose own reader rejects it.
    throw new Sword1AudioExportError(
      `Tune ${tune}${stem ? ` (${stem})` : ''} is ${file} in ${folder.name}, which is a ` +
        `re-encoding rather than the WAV Revolution shipped. This export writes PCM WAVE, and ` +
        `writing it under that name would leave a file nothing can read — so it is refused. ` +
        `Export against a folder holding the original ${stem ? `${stem}.WAV` : 'tune'}.`,
    );
  }
  return file;
}

/** Which resource an effect is, refusing where this install does not hold it. */
function effectResourceFor(folder: Sword1GameFolder, fx: number): number {
  const id = sword1SampleId(fx, folder.windowsDemo);
  if (id === null) {
    throw new Sword1AudioExportError(
      `Effect ${fx} has been replaced, and the fx table this release uses gives it no sample ` +
        `at all. There is no resource to write the new bytes into, so the export is refused ` +
        `rather than made without them.`,
    );
  }
  if (!locateResource(folder.index, id)) {
    throw new Sword1AudioExportError(
      `Effect ${fx} has been replaced, and swordres.rif in ${folder.name} names no resource for ` +
        `it. The new bytes would have nowhere to go, so the export is refused rather than made ` +
        `without them.`,
    );
  }
  return id;
}

/**
 * Every replaced recording, with the bytes the author dropped in.
 *
 * Refuses rather than skips where a replacement has a destination this install
 * cannot provide, for the reason every other refusal here exists: an export
 * that quietly dropped one would be a Replace button that works until the
 * author listens to the game.
 */
export async function sword1AudioReplacements(
  project: Project,
  folder: Sword1GameFolder,
): Promise<Sword1AudioReplacements> {
  const speech: Sword1SpeechReplacement[] = [];
  const music: Array<{ tune: number; file: string; data: Uint8Array }> = [];
  const effects: Array<{ fx: number; id: number; data: Uint8Array }> = [];

  for (const track of project.audio) {
    const resource = track.resource;
    if (!resource || resource.engine !== 'sword1') continue;
    if (!isSword1Replacement(track, resource.kind)) continue;

    const bytes = await readTrackBytes(track);
    // A track whose bytes cannot be found is left out rather than written as
    // silence. It is the case `missingBytesReason` already explains on the
    // row — a project reopened on a machine that never had the store — and
    // exporting silence over a recording the author can still hear elsewhere
    // would be the worst of the three possible outcomes.
    if (!bytes || bytes.length === 0) continue;

    switch (resource.kind) {
      case 'speech': {
        if (resource.bank === undefined) continue;
        speech.push({ room: resource.bank, line: resource.number, wav: bytes });
        break;
      }
      case 'music': {
        const file = musicFileFor(folder, track, resource.number);
        checkPlayable(bytes, track.name);
        music.push({ tune: resource.number, file, data: bytes });
        break;
      }
      case 'effects': {
        const id = effectResourceFor(folder, resource.number);
        checkPlayable(bytes, track.name);
        effects.push({ fx: resource.number, id, data: bytes });
        break;
      }
      default:
        break;
    }
  }

  return { speech, music, effects };
}
