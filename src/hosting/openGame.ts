import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { MemoryDataSource, type DataSource } from '../engine/resource/DataSource.js';
import { isZip, readZip } from '../engine/resource/zip.js';
import { FileHandleDataSource } from './FileHandleDataSource.js';
import { listGameFiles } from './gamesFolder.js';

/**
 * Reads a game from a path: a folder of files, a zip of them, or one file.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always given by whoever is running the tool.
 */
export async function openGame(path: string): Promise<DataSource> {
  const info = await stat(path);

  if (info.isDirectory()) {
    // Subfolders included. A v7 release does not keep everything beside its
    // index: Full Throttle and The Dig put their videos, their audio bundles
    // and their subtitle fonts in `VIDEO/`, `VOICE/` and the like. Listing one
    // level deep found the index and none of that, so the diagnostic reported
    // no .NUT font beside a game that ships eight of them — a fault in the
    // diagnosis, which is the worst place to have one, because it sends you
    // looking for a file that is right there. A lookup matches on the base
    // name, so a script asking for `INTRO.SAN` still finds it in `VIDEO/`.
    //
    // Nothing is read here (ADR 0021). This used to load every file of the
    // folder into memory before anything asked for a byte, which is precisely
    // the allocation a SCI32 install cannot survive — and the tools under
    // `bin/` are the ones most likely to be pointed at one.
    return new FileHandleDataSource(path, await listGameFiles(path), path);
  }

  const data = new Uint8Array(await readFile(path));
  if (isZip(data)) return readZip(data, path);

  // A single file is still worth trying: the pair usually sits beside it.
  const source = new MemoryDataSource(path);
  source.set(basename(path), data);
  return source;
}
