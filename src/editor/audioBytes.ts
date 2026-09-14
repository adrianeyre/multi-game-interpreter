import {
  isExternal,
  loadAudio,
  type AudioResource,
  type ProjectAudio,
} from '../authoring/audio.js';
import { getAudioBytes } from './audioStore.js';

/**
 * Reads one recording out of the game it is still in.
 *
 * Session-scoped and deliberately not part of the project: the thing that can
 * answer is whichever folder the author re-supplied this session (ADR 0034),
 * and a folder handle is not serialisable. Null where nothing has been opened,
 * which is the ordinary state of a project that was reloaded rather than just
 * imported.
 */
export type AudioResourceReader = (resource: AudioResource) => Promise<Uint8Array | null>;

let readResource: AudioResourceReader | null = null;

/**
 * Points the resolver at the open game folder, or takes it away again.
 *
 * A module-level hook rather than an argument threaded through every caller,
 * for the reason `readTrackBytes` exists at all: `AudioLibrary`, the play
 * overlay and the project export all ask the same question, and three of them
 * learning about game folders would be three places to get it wrong.
 */
export function setAudioResourceReader(reader: AudioResourceReader | null): void {
  readResource = reader;
}

/**
 * The bytes of a track, wherever they happen to live.
 *
 * The one place that knows a track can be inline, in the editor's store, or
 * still in the game, so nothing else has to. Returns null rather than throwing
 * when the bytes are not reachable — which happens after importing a project
 * on a machine that never had the store, and every time a game's own recording
 * is asked for before its folder has been opened — so the caller can say which
 * of those it is instead of failing as though the file were corrupt.
 */
export async function readTrackBytes(track: ProjectAudio): Promise<Uint8Array | null> {
  // The project's own bytes first, and the game's only where there are none.
  //
  // The order matters and used to be the other way round. A replaced recording
  // keeps its `resource` — that is how the export knows which of the game's
  // sounds this one stands in for — so asking the game first would play the
  // original over the top of every replacement an author made, which reads as
  // a Replace button that silently does nothing.
  if (track.data) {
    try {
      return loadAudio(track);
    } catch {
      return null;
    }
  }

  if (isExternal(track)) {
    try {
      return await getAudioBytes(track.storeKey!);
    } catch {
      return null;
    }
  }

  if (track.resource) {
    if (!readResource) return null;
    try {
      return await readResource(track.resource);
    } catch {
      return null;
    }
  }

  return null;
}

/** Why a track's bytes could not be found, for the message shown on its row. */
export function missingBytesReason(track: ProjectAudio): string {
  if (track.resource) {
    return (
      'This is one of the game’s own recordings, so its bytes are read from the game ' +
      `folder rather than kept in the project (ADR 0034). ${whereTheFolderBarIs(
        track.resource.engine,
      )}`
    );
  }
  return isExternal(track)
    ? 'The audio for this track is not on this computer. Large audio is kept outside the project file; re-import it, or open the project where it was added.'
    : 'This track has no audio in it.';
}

/**
 * Where the author has to go to open the folder, per family.
 *
 * Four surfaces put the control in two places, and a message that names the
 * wrong one is worse than one that names none: it sends somebody looking at a
 * pane that has no such button. AGOS's sits above its properties pane; both
 * Broken Swords and SCI put theirs at the top of the Audio section itself,
 * which is where the author already is when they read this.
 *
 * It is the reason a row gives and not always the whole reason. A SCI sample
 * compressed with Sierra's DPCM has no decoder here, so its row answers nothing
 * with the folder open — the same shape as a Broken Sword line that will not
 * decode, and the same honest limit: the editor cannot say "these bytes are
 * unreachable" in more detail than it knows.
 */
function whereTheFolderBarIs(engine: AudioResource['engine']): string {
  return engine === 'agos'
    ? 'Open the folder from the bar above the properties and it will play.'
    : 'Open the folder from the button at the top of this section and it will play.';
}
