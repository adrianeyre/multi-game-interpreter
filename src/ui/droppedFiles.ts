/**
 * Turning a dropped folder into files, which `dataTransfer.files` will not do.
 *
 * **`dataTransfer.files` does not contain a dropped folder's contents.** A
 * folder dropped on the page appears there as a single zero-length entry named
 * after the folder, so the loader was handed one file called `fate` and
 * reported, correctly and uselessly, that it could not find an index and
 * container pair — "Found: fate". Indiana Jones and the Fate of Atlantis and
 * Day of the Tentacle both failed exactly that way while loading fine from the
 * games folder and from the folder picker, which is what named it: the picker
 * fills `webkitRelativePath` in and a drop has never had it.
 *
 * A directory's contents are only reachable through `DataTransferItem`, so this
 * walks `webkitGetAsEntry` instead. Nothing is read here — an entry yields a
 * `File` handle, and a 95 MB speech file stays on disk until a script asks for
 * a byte of it (ADR 0021).
 *
 * Its own module rather than a closure in `main.ts` because the walk is the
 * part with the two traps in it — a paged directory reader and an item list
 * that empties itself — and both are worth a test.
 */

import type { PathedFile } from '../engine/resource/DataSource.js';

/**
 * How deep a dropped folder is walked.
 *
 * The same limit `gamesFolder.ts` puts on the server side and for the same
 * reason: a v7 release keeps its videos and speech one level down, and nothing
 * legitimate is deeper than a couple. A bound rather than trust, because a
 * dropped tree is whatever the user dropped.
 */
const MAX_DROP_DEPTH = 4;

/**
 * Every file inside a dropped directory, with the path it sat at.
 *
 * **`dataTransfer.files` does not contain them.** A folder dropped on the page
 * appears there as a single zero-length entry named after the folder, so the
 * loader was handed one file called `fate` and reported, correctly and
 * uselessly, that it could not find an index and container pair — "Found:
 * fate". Indiana Jones and the Fate of Atlantis and Day of the Tentacle both
 * failed exactly that way while loading fine from the games folder and from
 * the folder picker, which is what named this: the picker fills
 * `webkitRelativePath` in and a drop has never had it.
 *
 * The directory's contents are only reachable through `DataTransferItem`, so
 * this walks `webkitGetAsEntry` instead. Nothing is read here — an entry
 * yields a `File` handle, and a 95 MB speech file stays on disk until a script
 * asks for a byte of it (ADR 0021).
 */
export async function filesFromEntry(
  entry: FileSystemEntry,
  prefix: string,
  depth = 0,
): Promise<PathedFile[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    return file ? [{ file, path }] : [];
  }

  if (!entry.isDirectory || depth >= MAX_DROP_DEPTH) return [];

  // `readEntries` returns a page at a time and an empty page means the end,
  // which is the one part of this API that silently truncates a large folder
  // if it is called once.
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  for (;;) {
    const page = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (page.length === 0) break;
    children.push(...page);
  }

  const found: PathedFile[] = [];
  for (const child of children) found.push(...(await filesFromEntry(child, path, depth + 1)));
  return found;
}

/**
 * The entries a drop carried, read before anything awaits.
 *
 * A `DataTransferItemList` is emptied when the event handler returns, so the
 * items have to be turned into entries synchronously — a walk that awaits
 * first finds an empty list and reports an empty folder.
 */
export function readDropEntries(transfer: DataTransfer): FileSystemEntry[] {
  return [...transfer.items]
    .filter((item) => item.kind === 'file')
    .map((item) => (item.webkitGetAsEntry?.() ?? null) as FileSystemEntry | null)
    .filter((entry): entry is FileSystemEntry => entry !== null);
}

/** Every file under every dropped entry, paths and all. */
export async function filesFromDropEntries(entries: FileSystemEntry[]): Promise<PathedFile[]> {
  const found: PathedFile[] = [];
  for (const entry of entries) found.push(...(await filesFromEntry(entry, '')));
  return found;
}
