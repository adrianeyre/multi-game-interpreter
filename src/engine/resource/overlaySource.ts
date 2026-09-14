/**
 * A `DataSource` that serves some files from memory and the rest from another.
 *
 * What Play needs from an export it is not going to write to disc. The editor's
 * Play button runs the game the *export* would produce, so the preview reads
 * exactly the bytes Save would write — anything else previews a second code
 * path rather than the game.
 *
 * Family-neutral on purpose, and beside `DataSource.ts` rather than in any
 * family's tree: an overlay knows nothing about clusters, archives or rooms.
 * AGOS has `agos/previewSource.ts` because its preview does know something —
 * which names a talkie must advertise for the detector to read the release
 * right. This one knows nothing, so it belongs where the interface does.
 *
 * Two things it does that a `Map` lookup would not:
 *
 * **Names match the way a folder matches them.** A game folder lists
 * `CLUSTERS/SCRIPTS.CLU` and an exporter names its output `SCRIPTS.CLU`, so a
 * strict comparison overlays nothing at all and the preview silently runs the
 * unedited game — the worst possible failure for a preview. Matching falls back
 * to the base name, case-insensitively, which is how `openGame`'s own folder
 * source resolves a lookup.
 *
 * **`readRange` is served from the buffer.** Both Broken Swords read a resource
 * out of a cluster by range rather than holding the cluster, and the largest is
 * 20 MB. Without this the fallback in `readRangeFrom` would take the whole file
 * per resource, which is ADR 0010's threshold being crossed once a frame.
 */

import { readRangeFrom, type ByteProgress, type DataSource } from './DataSource.js';

/** A file to serve from memory, named as the export names it. */
export interface OverlayFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/** The base name of a path, lower-cased — the key both halves are matched on. */
function key(name: string): string {
  return (name.split(/[/\\]/).pop() ?? name).toLowerCase();
}

/**
 * `files` in front of `base`, with everything else read through.
 *
 * The listing keeps the base's own paths, so a reader that lists the folder and
 * then asks for what it found gets the overlaid bytes under the name it saw.
 * An overlaid file the base does not list is added to the listing, because an
 * export may write a file the folder did not have.
 */
export function overlaySource(base: DataSource, files: readonly OverlayFile[]): DataSource {
  const overlaid = new Map<string, Uint8Array>();
  for (const file of files) overlaid.set(key(file.name), file.data);

  const listed = base.list();
  const extra = [...overlaid.keys()].filter((name) => !listed.some((each) => key(each) === name));
  const names = [
    ...listed,
    ...files.filter((file) => extra.includes(key(file.name))).map((f) => f.name),
  ];

  return {
    label: `${base.label} (preview)`,
    list: () => names,
    async read(name: string, onBytes?: ByteProgress) {
      const held = overlaid.get(key(name));
      if (!held) return base.read(name, onBytes);
      onBytes?.(held.length, held.length);
      return held;
    },
    async readRange(name: string, start: number, end: number) {
      const held = overlaid.get(key(name));
      if (!held) return readRangeFrom(base, name, start, end);
      // Clamped rather than refused: a range past the end of a file is what
      // `readRangeFrom` already returns short, and a reader that asks for the
      // last four bytes of a cluster should not have to know its length twice.
      return held.subarray(Math.min(start, held.length), Math.min(end, held.length));
    },
  };
}
