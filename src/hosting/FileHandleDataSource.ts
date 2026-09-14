/**
 * A `DataSource` over files on disk, read by offset rather than whole.
 *
 * The Node half of ADR 0021. The browser already had one — `FileListDataSource`
 * backed by `File.slice` — and the tools under `bin/` did not: `openGame` read
 * every file of a game folder into memory before anything asked for a byte of
 * it. That is the same failure `VolumeReader` exists to prevent, and it bites
 * harder here, because `npm run diagnose` and `npm run sweep` are exactly the
 * tools someone would point at a seven-disc SCI32 install.
 *
 * A handle is opened per read and closed after it. That is a syscall pair per
 * resource rather than a pool, and it is the right trade for a command-line
 * tool: no descriptor outlives its read, so nothing leaks when a walk over a
 * game throws halfway through — which, for a diagnostic, is the normal ending
 * rather than the exceptional one.
 */

import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ByteProgress, DataSource } from '../engine/resource/DataSource.js';

/**
 * The keys a name is looked up under, most specific first.
 *
 * The same two-key rule as `MemoryDataSource`, and it has to be the same or a
 * game would resolve differently depending on which tool opened it: a script
 * naming `INTRO.SAN` finds it in `VIDEO/`, and a caller that knows the folder
 * can give the whole path and get exactly that file.
 */
function lookupKeys(name: string): [path: string, base: string] {
  const path = name
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
  return [path, path.split('/').pop() ?? path];
}

export class FileHandleDataSource implements DataSource {
  readonly label: string;
  private readonly root: string;
  private readonly paths = new Map<string, string>();
  private readonly originalNames: string[] = [];

  /** `names` are relative to `root`, as `listGameFiles` returns them. */
  constructor(root: string, names: Iterable<string>, label = root) {
    this.root = root;
    this.label = label;
    for (const name of names) {
      const [path, base] = lookupKeys(name);
      this.paths.set(path, name);
      if (base !== path && !this.paths.has(base)) this.paths.set(base, name);
      this.originalNames.push(name);
    }
  }

  list(): string[] {
    return [...this.originalNames];
  }

  private find(name: string): string | null {
    const [path, base] = lookupKeys(name);
    const relative = this.paths.get(path) ?? this.paths.get(base);
    return relative === undefined ? null : join(this.root, relative);
  }

  /**
   * Reads exactly `[start, end)`.
   *
   * A short read is not an error: the caller's index said the resource was
   * there and the file says otherwise, which is a fact about the install and
   * belongs in that caller's message about its own game rather than in an
   * exception from here. So the buffer is trimmed to what arrived.
   */
  async readRange(name: string, start: number, end: number): Promise<Uint8Array | null> {
    const path = this.find(name);
    if (path === null) return null;

    const length = Math.max(0, end - start);
    if (length === 0) return new Uint8Array(0);

    const handle = await open(path, 'r');
    try {
      const buffer = new Uint8Array(length);
      const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, start));
      return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async read(name: string, onBytes?: ByteProgress): Promise<Uint8Array | null> {
    const path = this.find(name);
    if (path === null) return null;
    const data = new Uint8Array(await readFile(path));
    onBytes?.(data.length, data.length);
    return data;
  }
}
