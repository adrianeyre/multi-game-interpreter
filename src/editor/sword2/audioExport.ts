/**
 * Which of Broken Sword II's recordings an author replaced, and where each goes.
 *
 * The same join Sword 1's `audioExport.ts` makes, against a family that keeps
 * its three kinds in two places rather than three:
 *
 * | kind    | where it lives                   | what an export does                        |
 * | ------- | -------------------------------- | ------------------------------------------ |
 * | effects | a `WAV_FILE` resource in a cluster | substitutes the payload, cluster relaid    |
 * | speech  | an entry in `SPEECH1.CLU`         | re-encodes and rebuilds the container       |
 * | music   | an entry in `MUSIC1.CLU`          | re-encodes and rebuilds the container       |
 *
 * An effect is a RIFF WAVE where it lies, so the author's file is written as it
 * stands once the game's own reader has agreed it can read it. The other two
 * are one byte per sample of Revolution's own delta compression, so the samples
 * themselves are re-encoded — `soundContainer.ts` does that and says, at
 * length, that no install reachable from this repository has a container to
 * prove it against.
 *
 * A track is a *replacement* only when it has bytes of its own, which is the
 * same test Sword 1's uses and for the same reason: every one of the game's own
 * recordings carries a `resource` and none of them carries bytes.
 */

import type { ProjectAudio } from '../../authoring/audio.js';
import type { Project } from '../../authoring/project.js';
import type { Sword2SoundReplacement } from '../../authoring/sword2/soundContainer.js';
import { parseWave, SwordAudioError } from '../../engine/sword1/sound/swordAudio.js';
import { readTrackBytes } from '../audioBytes.js';
import type { Sword2GameFolder } from './resupply.js';

/** Raised when a replacement cannot be written, with what was wrong. */
export class Sword2AudioExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2AudioExportError';
  }
}

/** Everything an author replaced, sorted into the two things an export does. */
export interface Sword2AudioReplacements {
  /** An effect, as the resource id whose payload it becomes. */
  readonly effects: ReadonlyArray<{ readonly id: number; readonly data: Uint8Array }>;
  /** A container this install holds, and the entries in it that changed. */
  readonly sounds: ReadonlyArray<{
    /** The file as the folder spells it, which is what an export writes over. */
    readonly file: string;
    readonly replacements: readonly Sword2SoundReplacement[];
  }>;
}

/** Whether this track is one of the game's recordings with new bytes behind it. */
export function isSword2Replacement(track: ProjectAudio): boolean {
  const resource = track.resource;
  if (!resource || resource.engine !== 'sword2') return false;
  const inline = typeof track.data === 'string' && track.data.length > 0;
  const stored = typeof track.storeKey === 'string' && track.storeKey.length > 0;
  return inline || stored;
}

/**
 * The game's own reader, asked whether it can read these bytes.
 *
 * For effects only: they are written into the install as they arrive, so the
 * question "will this play" has to be answered by the reader that would have
 * played it. Speech and music are re-encoded instead, and `sword2SoundSamples`
 * refuses anything that is not a PCM WAVE with a sentence of its own.
 */
function checkPlayable(bytes: Uint8Array, what: string): void {
  try {
    parseWave(bytes);
  } catch (error) {
    if (!(error instanceof SwordAudioError)) throw error;
    throw new Sword2AudioExportError(
      `The replacement for ${what} is not something Broken Sword II's own reader will play: ` +
        `${error.message} An effect is a RIFF WAVE inside its resource, so save the replacement ` +
        `as a WAV and it will be written.`,
    );
  }
}

/**
 * Every replaced recording, with the bytes the author dropped in.
 *
 * Refuses rather than skips where a replacement has a destination this install
 * cannot provide — an effect whose resource is in a cluster the folder does not
 * hold, or a line of speech whose container is not there — because an export
 * that quietly dropped one would be a Replace button that works until the
 * author listens to the game.
 */
export async function sword2AudioReplacements(
  project: Project,
  folder: Sword2GameFolder,
): Promise<Sword2AudioReplacements> {
  const effects: Array<{ id: number; data: Uint8Array }> = [];
  const sounds = new Map<string, Sword2SoundReplacement[]>();

  for (const track of project.audio) {
    const resource = track.resource;
    if (!resource || resource.engine !== 'sword2') continue;
    if (!isSword2Replacement(track)) continue;

    const bytes = await readTrackBytes(track);
    // A track whose bytes cannot be found is left out rather than written as
    // silence: the row already says so, and exporting silence over a recording
    // the author can still hear elsewhere is the worst of the outcomes.
    if (!bytes || bytes.length === 0) continue;

    if (resource.file === undefined) {
      if (!folder.resources.locate(resource.number)) {
        throw new Sword2AudioExportError(
          `${track.name} has been replaced and resource ${resource.number} is not in any cluster ` +
            `${folder.name} holds, so the new bytes would have nowhere to go. The export is ` +
            `refused rather than made without them.`,
        );
      }
      checkPlayable(bytes, track.name);
      effects.push({ id: resource.number, data: bytes });
      continue;
    }

    const container = folder.resources.soundFiles.find((each) => each.file === resource.file);
    if (!container) {
      throw new Sword2AudioExportError(
        `${track.name} has been replaced and ${folder.name} holds no ${resource.file}. Broken ` +
          `Sword II keeps its speech and its music outside the resource index, in containers ` +
          `opened by name — so open the folder that has that file and the replacement will be ` +
          `written.`,
      );
    }
    const list = sounds.get(container.file) ?? [];
    list.push({ index: resource.number, wav: bytes });
    sounds.set(container.file, list);
  }

  return {
    effects,
    sounds: [...sounds].map(([file, replacements]) => ({ file, replacements })),
  };
}
