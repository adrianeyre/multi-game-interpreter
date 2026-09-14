/**
 * The files an AGOS preview runs from.
 *
 * The two rebuilt ones come from the export and live in memory, because they
 * are what is being previewed and the engine reads a base file and an archive
 * synchronously all through a frame. Everything else in the folder — the
 * interpreter the font is read out of (ADR 0032), and a talkie's speech — is
 * **listed but not copied**.
 *
 * The listing is not a nicety. `agosDetect` decides a release is a talkie from
 * the *names* beside it, and a preview with no speech name in its list runs
 * Simon 1's talkie as the floppy release — a different game, with different
 * Subroutines, rather than the same game without sound. The bytes stay in the
 * folder, which is ADR 0010's rule: a talkie's speech is the largest thing
 * there and copying it into the browser is exactly what the threshold refuses.
 */

import type { ByteProgress, DataSource } from '../../engine/resource/DataSource.js';

export interface PreviewFiles {
  /** The rebuilt game, in memory. */
  readonly inMemory: ReadonlyArray<{ name: string; data: Uint8Array }>;
  /** Small files beside it that are wanted whole, such as the interpreter. */
  readonly support: ReadonlyArray<readonly [string, Uint8Array]>;
  /** Names to advertise without reading, such as a talkie's speech. */
  readonly lazyNames: readonly string[];
  /** Reads one of the lazy names, when something finally asks. */
  read(name: string): Promise<Uint8Array | null>;
}

export function agosPreviewSource(files: PreviewFiles): DataSource {
  const memory = new Map<string, Uint8Array>();
  for (const file of files.inMemory) memory.set(file.name, file.data);
  for (const [name, data] of files.support) memory.set(name, data);

  const lazy = files.lazyNames.filter((name) => !memory.has(name));
  /** Read once and kept, so a script asking twice does not re-read a disc. */
  const fetched = new Map<string, Uint8Array | null>();

  return {
    label: 'preview',
    list: () => [...memory.keys(), ...lazy],
    async read(name: string, onBytes?: ByteProgress) {
      const held = memory.get(name);
      if (held) {
        onBytes?.(held.length, held.length);
        return held;
      }
      if (!lazy.includes(name)) return null;
      if (!fetched.has(name)) fetched.set(name, await files.read(name));
      const bytes = fetched.get(name) ?? null;
      if (bytes) onBytes?.(bytes.length, bytes.length);
      return bytes;
    },
  };
}
