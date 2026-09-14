import type { DirectoryHandleLike } from './files.js';
import { describeMismatchedSource, type ImportOrigin } from './importOrigin.js';
import type { ImportedSource } from './importedStorage.js';

/**
 * Reading a game's original files back at export time (ADR 0010).
 *
 * Above the size threshold the originals were never stored, so export becomes
 * original plus diff: the author supplies the folder again and the edits are
 * written over what it holds.
 *
 * The whole risk here is supplying the *wrong* folder — a different release of
 * the same title, whose resources are at different offsets. That produces a
 * game which loads and is wrong, which is the failure this codebase keeps
 * meeting and the one worth spending a check on. So the files are read, matched
 * against what the project recorded at import, and **refused before anything is
 * written**.
 */

export type ResupplyResult = { ok: true; source: ImportedSource } | { ok: false; error: string };

/**
 * Reads the index and data files an origin names out of a folder.
 *
 * Both files are read before either is checked, so a folder holding the right
 * index and the wrong data is refused on the mismatch rather than half-accepted
 * on the name.
 */
export async function resupplyFrom(
  folder: DirectoryHandleLike,
  origin: ImportOrigin,
  xorKey: number,
): Promise<ResupplyResult> {
  const index = await readFile(folder, origin.indexFile);
  if (!index) {
    return {
      ok: false,
      error:
        `${folder.name} does not hold ${origin.indexFile}. This project was imported ` +
        `from that file, so exporting needs the folder it came from.`,
    };
  }

  const data = await readFile(folder, origin.dataFile);
  if (!data) {
    return {
      ok: false,
      error:
        `${folder.name} holds ${origin.indexFile} but not ${origin.dataFile}. Both are ` +
        `needed: the index says where resources are and the data file holds them.`,
    };
  }

  // Names and sizes only. The version strings the origin may carry cannot be
  // read without parsing the index, and the two cheap checks already separate a
  // different game from a different release.
  const mismatch = describeMismatchedSource(origin, {
    indexFile: origin.indexFile,
    dataFile: origin.dataFile,
    indexBytes: index.length,
    dataBytes: data.length,
  });
  if (mismatch) return { ok: false, error: mismatch };

  return {
    ok: true,
    source: {
      // Re-supply only ever happens for a game too big to keep a copy of, and
      // those are container games — the layout is not a guess so much as the
      // only one this path can be reached from.
      layout: 'lecf-container',
      version: 7,
      indexFile: origin.indexFile,
      index,
      dataFiles: [{ name: origin.dataFile, data }],
      xorKey,
      dataXorKey: xorKey,
    },
  };
}

async function readFile(folder: DirectoryHandleLike, name: string): Promise<Uint8Array | null> {
  try {
    const handle = await folder.getFileHandle(name);
    if (!handle.getFile) return null;
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    // Not present, or not readable. Both mean "this is not the folder", and
    // saying which adds nothing the author can act on.
    return null;
  }
}
