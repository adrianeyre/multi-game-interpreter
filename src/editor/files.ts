/**
 * Getting files out of the browser and onto disk.
 *
 * Two mechanisms, because browsers disagree. Chromium has the File System
 * Access API, which lets the author pick a folder once and then re-save into it
 * with no dialog — the thing that makes an editor feel like an editor. Firefox
 * and Safari do not, so everything falls back to downloads, which always work
 * but land in the downloads folder and pile up duplicates.
 */

export interface DirectoryHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  /**
   * The names in the folder, where the platform will say.
   *
   * Optional, because the write path never needed it and a test's folder is a
   * few objects rather than a filesystem. Reading a game folder does want it:
   * an AGOS release keeps its font in whatever the interpreter happens to be
   * called, and `Simon1.exe` is not on any list of known names. Asking for
   * candidates one at a time can only find the ones somebody thought of; a
   * listing finds the one that is there.
   *
   * The real `FileSystemDirectoryHandle` is async-iterable, which is what
   * `pickReadableFolder` adapts into this.
   */
  listNames?(): Promise<string[]>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

export interface FileHandleLike {
  readonly name: string;
  createWritable(): Promise<{
    write(data: Blob | string): Promise<void>;
    close(): Promise<void>;
  }>;
  /**
   * Reads the file back.
   *
   * Optional because the write path never needed it: a folder was somewhere to
   * put an export, not somewhere to get a game from. Exporting a large game
   * against re-supplied originals reads from the same handle it will write to
   * (ADR 0010), so the read side has to exist.
   */
  getFile?(): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> }>;
}

interface FileSystemWindow {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<DirectoryHandleLike>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileHandleLike>;
}

export function canSaveInPlace(): boolean {
  return typeof (window as unknown as FileSystemWindow).showDirectoryPicker === 'function';
}

/** Asks the author to choose a folder to read the original game from. */
export async function pickReadableFolder(): Promise<DirectoryHandleLike | null> {
  const picker = (window as unknown as FileSystemWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return withListing(await picker({ mode: 'read' }));
  } catch {
    return null;
  }
}

/**
 * Adds `listNames` to a real directory handle.
 *
 * A wrapper rather than a cast, because the platform spells it as async
 * iteration over `[name, handle]` pairs and this interface wants an array — and
 * because a browser that has the picker without the iterator should degrade to
 * "no listing" rather than throw the first time something asks.
 */
function withListing(handle: DirectoryHandleLike): DirectoryHandleLike {
  const iterable = handle as unknown as AsyncIterable<[string, unknown]>;
  if (
    typeof (iterable as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== 'function'
  ) {
    return handle;
  }
  return {
    ...handle,
    name: handle.name,
    getFileHandle: (name, options) => handle.getFileHandle(name, options),
    listNames: async () => {
      const names: string[] = [];
      for await (const [name] of iterable) names.push(name);
      return names;
    },
  };
}

/**
 * A folder chosen for reading, as files rather than as a handle.
 *
 * The second route into a folder, and it exists because the first one cannot
 * reach a subdirectory. `DirectoryHandleLike` has `getFileHandle` and no
 * `getDirectoryHandle`, so a game that keeps anything one level down is
 * invisible to it — which is most of Broken Sword: its clusters are in
 * `CLUSTERS/`, its tunes in `MUSIC/` and its speech container is
 * `SPEECH/COWS.MAD`. A `webkitdirectory` input hands back every file under the
 * chosen folder with its relative path attached, which is exactly what
 * `FileListDataSource` is built to take.
 *
 * Widening the handle interface instead was the alternative, and it was
 * refused for the reason its own note gives: it exists to be satisfiable by a
 * few objects in a test, and a recursive walk would be widening it for one
 * caller. This adds nothing to it.
 *
 * Null when the author dismissed the dialogue, which every browser reports
 * differently — a `cancel` event where it has one, and otherwise nothing at
 * all, which is why the input is left attached rather than resolved falsely.
 */
export async function pickFolderFiles(): Promise<{ name: string; files: File[] } | null> {
  if (typeof document === 'undefined') return null;

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  // Not in the DOM typings, and set the way the platform spells it.
  input.setAttribute('webkitdirectory', '');
  input.className = 'visually-hidden';
  input.tabIndex = -1;
  input.setAttribute('aria-hidden', 'true');
  document.body.appendChild(input);

  try {
    return await new Promise<{ name: string; files: File[] } | null>((resolve) => {
      input.addEventListener('change', () => {
        const files = [...(input.files ?? [])];
        if (files.length === 0) {
          resolve(null);
          return;
        }
        // The chosen folder's own name is the first segment of any file's
        // relative path; `input.value` is a fake path a browser will not
        // resolve, so it is no use here.
        const relative = files[0].webkitRelativePath;
        const name = relative ? (relative.split('/')[0] ?? relative) : files[0].name;
        resolve({ name, files });
      });
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  } finally {
    input.remove();
  }
}

/** Asks the author to choose an output folder. Returns null if they cancel. */
export async function pickFolder(): Promise<DirectoryHandleLike | null> {
  const picker = (window as unknown as FileSystemWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    return await picker({ mode: 'readwrite' });
  } catch {
    // The user dismissed the picker; not an error worth reporting.
    return null;
  }
}

/** Re-checks write permission, which a browser may drop between sessions. */
export async function ensureWritable(handle: DirectoryHandleLike): Promise<boolean> {
  const descriptor = { mode: 'readwrite' } as const;
  const current = await handle.queryPermission?.(descriptor);
  if (current === 'granted') return true;
  const requested = await handle.requestPermission?.(descriptor);
  return requested === 'granted';
}

export async function writeInto(
  folder: DirectoryHandleLike,
  name: string,
  data: Uint8Array | string,
): Promise<void> {
  const file = await folder.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  // Wrapping in a Blob sidesteps the typed-array/ArrayBuffer variance dance and
  // is what the API accepts everywhere it exists.
  await writable.write(typeof data === 'string' ? data : new Blob([data as BlobPart]));
  await writable.close();
}

/** Triggers a browser download — the fallback that works everywhere. */
export function download(
  filename: string,
  data: BlobPart,
  mime = 'application/octet-stream',
): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------------- zip writing --

/**
 * CRC-32, which the zip format requires for every entry.
 *
 * The table is built once on first use rather than being a 1 KB literal in the
 * source.
 */
let crcTable: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

/**
 * Builds a zip archive.
 *
 * Entries are deflated when the platform can, and stored when it cannot or when
 * compression made them bigger — which happens with already-compressed data and
 * with very small files.
 */
export async function createZip(files: ZipFile[]): Promise<Uint8Array> {
  const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number): number[] => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];

  const local: number[] = [];
  const central: number[] = [];
  const encoder = new TextEncoder();

  for (const file of files) {
    const nameBytes = [...encoder.encode(file.name)];
    const crc = crc32(file.data);

    const compressed = await deflate(file.data);
    const useDeflate = compressed !== null && compressed.length < file.data.length;
    const stored = useDeflate ? compressed! : file.data;
    const method = useDeflate ? 8 : 0;

    const offset = local.length;

    local.push(
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0), // flags
      ...u16(method),
      ...u16(0), // modification time
      ...u16(0), // modification date
      ...u32(crc),
      ...u32(stored.length),
      ...u32(file.data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...stored,
    );

    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(stored.length),
      ...u32(file.data.length),
      ...u16(nameBytes.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk number
      ...u16(0), // internal attributes
      ...u32(0), // external attributes
      ...u32(offset),
      ...nameBytes,
    );
  }

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(central.length),
    ...u32(local.length),
    ...u16(0),
  ];

  return new Uint8Array([...local, ...central, ...end]);
}
