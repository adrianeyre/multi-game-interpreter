/**
 * Which of a SCI game's recordings an author replaced, as an export needs them.
 *
 * The same join the two Broken Swords' `audioExport.ts` make: a track is a
 * *replacement* when it is one of the game's recordings (it carries a `sci`
 * `resource`) and has bytes of its own. Every row the listing makes carries the
 * first and none carries the second, so the test cannot mistake an unedited row
 * for an edit — which is what keeps an unedited export byte-identical.
 *
 * What happens to one is `authoring/sci/sciAudioVolume.ts`'s business; this
 * only fetches the bytes, from the project or the audio store, at the moment
 * an export is made.
 */

import type { ProjectAudio } from '../../authoring/audio.js';
import type { Project } from '../../authoring/project.js';
import type { SciAudioReplacement } from '../../authoring/sci/sciAudioVolume.js';
import { readTrackBytes } from '../audioBytes.js';

/** Whether this track is one of the game's recordings with new bytes behind it. */
export function isSciReplacement(track: ProjectAudio): boolean {
  if (track.resource?.engine !== 'sci') return false;
  const inline = typeof track.data === 'string' && track.data.length > 0;
  const stored = typeof track.storeKey === 'string' && track.storeKey.length > 0;
  return inline || stored;
}

/**
 * Every replaced recording, with the bytes the author dropped in.
 *
 * A track whose bytes cannot be found is left out rather than written as
 * silence, as both Broken Swords do: the row already says so, and exporting
 * silence over a recording the author can still hear is the worst outcome.
 */
export async function sciAudioReplacements(project: Project): Promise<SciAudioReplacement[]> {
  const replacements: SciAudioReplacement[] = [];
  for (const track of project.audio) {
    if (!isSciReplacement(track)) continue;
    const bytes = await readTrackBytes(track);
    if (!bytes || bytes.length === 0) continue;
    const resource = track.resource!;
    replacements.push({
      number: resource.number,
      ...(resource.file === undefined ? {} : { file: resource.file }),
      wave: bytes,
      name: track.name,
    });
  }
  return replacements;
}
