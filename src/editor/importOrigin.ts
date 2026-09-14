import type { Project } from '../authoring/project.js';

/**
 * Exporting a game whose originals were never stored.
 *
 * The editor keeps a whole imported game in IndexedDB beside its Project,
 * because export rewrites the original files rather than compiling a new game,
 * and a Project is not a complete description of the game it came from — art,
 * sound and every resource no importer understands live only in those files. At
 * v5 and v6 sizes that works.
 *
 * Full Throttle is around 148 MB of data before its videos and audio bundles,
 * and The Dig is several hundred; with the Project beside it, an edited v7 game
 * wants roughly two copies of a CD in browser storage. IndexedDB quota is a
 * browser policy rather than a machine specification, so there is no desktop
 * big enough to make that reliable (ADR 0010).
 *
 * So above a threshold the originals are not stored and the folder is asked for
 * again at export, which becomes original plus diff.
 */

/**
 * Above this many bytes of source files, the originals are not stored.
 *
 * A fixed number rather than a probe of `navigator.storage.estimate()`, and
 * deliberately: a quota probe makes the path taken depend on the machine and
 * the browser, so the path that stores nothing — already the one exercised
 * least, because reaching it needs a large game — would be exercised
 * unpredictably as well. A constant can be forced low by a test, which is the
 * only way the re-supply path gets run in CI at all.
 *
 * 64 MB sits above every v5 and v6 release, so their one-step export is
 * untouched, and below Full Throttle's data file alone.
 */
export const STORE_ORIGINALS_BELOW_BYTES = 64 * 1024 * 1024;

/**
 * Enough about the game a Project came from to refuse the wrong folder.
 *
 * Not a checksum: hashing hundreds of megabytes at import to compare at export
 * costs more than it settles, and the failure being guarded against is supplying
 * a *different release* rather than a corrupted copy. File names and sizes
 * separate those, and the two version strings a v7 `MAXS` carries separate two
 * releases of the same title, which names alone do not.
 */
export interface ImportOrigin {
  indexFile: string;
  dataFile: string;
  indexBytes: number;
  dataBytes: number;
  /** The engine and data build strings from a v7 `MAXS`, when there are any. */
  engineVersion?: string;
  dataVersion?: string;
}

/** Whether a game of this size keeps its originals in the browser. */
export function shouldStoreOriginals(
  totalBytes: number,
  threshold = STORE_ORIGINALS_BELOW_BYTES,
): boolean {
  return totalBytes < threshold;
}

/** What a re-supplied folder offers, as far as this check is concerned. */
export interface SuppliedFiles {
  indexFile: string;
  dataFile: string;
  indexBytes: number;
  dataBytes: number;
  engineVersion?: string;
  dataVersion?: string;
}

/**
 * Why a re-supplied folder is not the game this Project came from, or null.
 *
 * Refused **by name, before anything is written**. The alternative is an export
 * that rewrites one release's resources into another's container, which
 * produces a game that loads and is wrong — the failure this codebase keeps
 * meeting, and the one worth spending a check on.
 */
export function describeMismatchedSource(
  origin: ImportOrigin,
  supplied: SuppliedFiles,
): string | null {
  const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

  if (!sameName(origin.indexFile, supplied.indexFile)) {
    return (
      `This project was imported from ${origin.indexFile}, and the folder supplied ` +
      `holds ${supplied.indexFile}. Exporting against a different game would write ` +
      `these edits into resources they do not belong to.`
    );
  }

  if (origin.indexBytes !== supplied.indexBytes || origin.dataBytes !== supplied.dataBytes) {
    return (
      `${supplied.indexFile} and ${supplied.dataFile} are not the same size as the ` +
      `files this project was imported from (${origin.indexBytes} and ` +
      `${origin.dataBytes} bytes, against ${supplied.indexBytes} and ` +
      `${supplied.dataBytes}). This is a different release of the same game, and ` +
      `its resources are at different offsets.`
    );
  }

  if (origin.dataVersion && supplied.dataVersion && origin.dataVersion !== supplied.dataVersion) {
    return (
      `This project was imported from data build "${origin.dataVersion}" and the ` +
      `folder supplied is "${supplied.dataVersion}". Two builds of one release can ` +
      `be the same size and still hold different scripts.`
    );
  }

  return null;
}

/** Where a Project records its origin, for the exports that need it. */
export interface ProjectWithOrigin extends Project {
  origin?: ImportOrigin;
}
