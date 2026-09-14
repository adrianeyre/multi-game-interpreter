/**
 * Where the engine gets game data from.
 *
 * The engine never reads the filesystem itself. A browser cannot, and keeping
 * the seam here means the same resource code runs under Node in the tests
 * against a fixture directory.
 *
 * Names are matched case-insensitively: SCUMM releases are inconsistent about
 * case (`MONKEY2.000` on the CD, `monkey2.000` after most extraction tools).
 */

/**
 * Called as a file is read, so the caller can show progress.
 *
 * `total` is absent when the size is not known up front, which is the case for
 * an HTTP response without a `Content-Length`.
 */
export type ByteProgress = (loaded: number, total: number | undefined) => void;

export interface DataSource {
  /** File names available, in their original case. */
  list(): string[];
  /**
   * Reads a whole file, or returns `null` if it is not present.
   *
   * Passing `onBytes` asks for a chunked read that reports as it goes. Sources
   * that cannot stream ignore it and report the whole file at once, so callers
   * never have to ask whether progress is available.
   */
  read(name: string, onBytes?: ByteProgress): Promise<Uint8Array | null>;
  /**
   * Reads bytes `[start, end)` of a file, or null if it is not present.
   *
   * For the files that are offset-addressed blobs consumed asynchronously — a
   * v7 game's `.SAN` videos and `.BUN` bundles, and a talkie's `MONSTER.SOU` —
   * which together are the bulk of an install and are never wanted whole.
   *
   * The main container is deliberately **not** among them. It stays in memory
   * so the script engine can ask for a costume synchronously mid-frame, which
   * is the property the whole-file model was chosen for (ADR 0010, #114); what
   * changes is only which files that model has to cover.
   *
   * Optional, and a source that cannot do better may read the whole file and
   * slice it — the caller gets the right bytes either way, and the ones that
   * matter (a local file, an HTTP server that honours Range) can do it
   * properly.
   */
  readRange?(name: string, start: number, end: number): Promise<Uint8Array | null>;
  /** A human readable name for the source, used in error messages. */
  readonly label: string;
}

/**
 * Reads a range from any source, however capable.
 *
 * Falls back to reading the whole file and slicing, so a caller never has to
 * ask whether a source supports ranges — the same reasoning as `onBytes` on
 * `read`. The fallback costs what it always cost; the point is that the sources
 * that can avoid it now do.
 */
export async function readRangeFrom(
  source: DataSource,
  name: string,
  start: number,
  end: number,
): Promise<Uint8Array | null> {
  if (source.readRange) return source.readRange(name, start, end);
  const whole = await source.read(name);
  return whole ? whole.subarray(start, Math.min(end, whole.length)) : null;
}

/**
 * Reads a stream to completion, reporting as chunks arrive.
 *
 * The chunks are kept and joined at the end rather than copied into a
 * pre-sized buffer, because `total` is a hint: an HTTP server can be wrong
 * about it, and trusting it would truncate the game data.
 */
async function drainStream(
  stream: ReadableStream<Uint8Array>,
  total: number | undefined,
  onBytes: ByteProgress,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  // Written straight into one buffer when the size is known — a game file is
  // megabytes, and keeping every chunk to join afterwards would hold a second
  // copy of the whole thing. `total` is only a hint, so overflow falls back to
  // collecting the rest.
  const out = total !== undefined ? new Uint8Array(total) : null;
  const overflow: Uint8Array[] = [];
  let loaded = 0;

  onBytes(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    if (out && loaded + value.length <= out.length) {
      out.set(value, loaded);
    } else {
      overflow.push(value);
    }
    loaded += value.length;
    onBytes(loaded, total);
  }

  if (out && overflow.length === 0) {
    // A server that over-reported the length leaves a short read, so the
    // buffer is trimmed to what actually arrived.
    return loaded === out.length ? out : out.subarray(0, loaded);
  }

  const joined = new Uint8Array(loaded);
  let at = 0;
  if (out) {
    const kept = Math.min(out.length, loaded);
    joined.set(out.subarray(0, kept), 0);
    at = kept;
  }
  for (const piece of overflow) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

/**
 * The keys a name is looked up under, most specific first.
 *
 * Two of them, because SCUMM releases are asked for both ways. A script names
 * `INTRO.SAN` and the file is in `VIDEO/`, so a bare name has to find a file in
 * a subfolder — that is the base-name key. But The Dig's demo keeps its speech
 * in `audio/logo.1/1111.voc`, one folder per room, and the *same* line numbers
 * recur across rooms: 39 of its 225 recordings share a base name with another.
 * Matching on the base name alone plays whichever of them was read last, which
 * is a wrong line of dialogue rather than a missing one — so a caller that
 * knows the folder can give the whole path and get exactly that file.
 */
function lookupKeys(name: string): [path: string, base: string] {
  const path = name
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .toLowerCase();
  return [path, path.split('/').pop() ?? path];
}

function normalise(name: string): string {
  return lookupKeys(name)[0];
}

/** Backed by an in-memory map. Used by the file picker and by the tests. */
export class MemoryDataSource implements DataSource {
  readonly label: string;
  private readonly files = new Map<string, Uint8Array>();
  private readonly originalNames = new Map<string, string>();

  constructor(label = 'memory', entries: Iterable<[string, Uint8Array]> = []) {
    this.label = label;
    for (const [name, data] of entries) this.set(name, data);
  }

  /**
   * Files are stored under their whole path and, where that is free, under
   * their base name too.
   *
   * "Where that is free" is what keeps a top-level file's own name pointing at
   * it: a file at the root has one key, which *is* its base name, so it always
   * claims it. A subfolder's file takes the short name only when nothing else
   * has, which is the honest answer for a genuine collision — asking for
   * `1111.voc` when eight rooms have one cannot be resolved, and the caller
   * that knows which room should say so.
   */
  set(name: string, data: Uint8Array): void {
    const [path, base] = lookupKeys(name);
    this.files.set(path, data);
    if (base !== path && !this.files.has(base)) this.files.set(base, data);
    this.originalNames.set(path, name);
  }

  list(): string[] {
    return [...this.originalNames.values()];
  }

  private find(name: string): Uint8Array | null {
    const [path, base] = lookupKeys(name);
    return this.files.get(path) ?? this.files.get(base) ?? null;
  }

  async readRange(name: string, start: number, end: number): Promise<Uint8Array | null> {
    const data = this.find(name);
    if (!data) return null;
    return data.subarray(Math.max(0, start), Math.min(end, data.length));
  }

  async read(name: string, onBytes?: ByteProgress): Promise<Uint8Array | null> {
    const data = this.find(name);
    if (data) onBytes?.(data.length, data.length);
    return data;
  }
}

/**
 * A `File` and the path it was found at, for a route that knows one.
 *
 * The directory *picker* fills `webkitRelativePath` in and a **drop** does not:
 * a folder dropped on the page arrives as a `DataTransferItem` and its files
 * come out of `webkitGetAsEntry`, which yields plain `File`s whose
 * `webkitRelativePath` is empty and whose read-only-ness means it cannot be
 * filled in afterwards. So the path travels beside the file instead.
 */
export interface PathedFile {
  file: File;
  /** Where it sat, relative to what the user chose — `fate/monster.so3`. */
  path: string;
}

/**
 * Told apart by shape rather than by `instanceof File`.
 *
 * A `File` from jsdom, from Node and from a browser are three different
 * constructors, and a test that hands in a stub has a fourth — so `instanceof`
 * says "not a File" about things that are one. The pair has a `file` property
 * and a `File` does not, which is the difference that actually holds.
 */
function isPathed(entry: File | PathedFile): entry is PathedFile {
  return typeof entry === 'object' && entry !== null && 'file' in entry;
}

function fileOf(entry: File | PathedFile): File {
  return isPathed(entry) ? entry.file : entry;
}

/** Backed by browser `File` handles, so nothing is read until it is needed. */
export class FileListDataSource implements DataSource {
  readonly label: string;
  private readonly handles = new Map<string, File>();
  private readonly originalNames = new Map<string, string>();

  constructor(files: Iterable<File | PathedFile>, label = 'selected files') {
    this.label = label;
    for (const entry of files) {
      const file = fileOf(entry);
      // `webkitRelativePath` is what a directory picker fills in, and it is the
      // only place the folder a file came from survives — `name` is the base
      // name alone. A game whose speech is one folder per room needs it, so it
      // is preferred where the browser supplied it. A dropped folder has no
      // `webkitRelativePath` at all and carries its path beside the file.
      const full = (isPathed(entry) ? entry.path : '') || file.webkitRelativePath || file.name;
      const [path, base] = lookupKeys(full);
      this.handles.set(path, file);
      if (base !== path && !this.handles.has(base)) this.handles.set(base, file);
      this.originalNames.set(path, full);
    }
  }

  list(): string[] {
    return [...this.originalNames.values()];
  }

  private find(name: string): File | undefined {
    const [path, base] = lookupKeys(name);
    return this.handles.get(path) ?? this.handles.get(base);
  }

  async read(name: string, onBytes?: ByteProgress): Promise<Uint8Array | null> {
    const file = this.find(name);
    if (!file) return null;

    if (onBytes && typeof file.stream === 'function') {
      return drainStream(file.stream(), file.size, onBytes);
    }

    const data = new Uint8Array(await file.arrayBuffer());
    onBytes?.(data.length, data.length);
    return data;
  }

  /**
   * A real range read: `File.slice` reads only what is asked for.
   *
   * This is the case #114 was written about. Full Throttle's bundles and videos
   * are hundreds of megabytes and are addressed by offset, so reading one whole
   * to take a few kilobytes out of it is the cost that makes a retail v7 game
   * unreliable in a browser.
   */
  async readRange(name: string, start: number, end: number): Promise<Uint8Array | null> {
    const file = this.find(name);
    if (!file) return null;
    const slice = file.slice(Math.max(0, start), Math.min(end, file.size));
    return new Uint8Array(await slice.arrayBuffer());
  }
}

/**
 * Backed by HTTP, for game data placed under `public/games/<id>/`.
 *
 * A directory listing is not available over plain HTTP, so the caller supplies
 * the file names — normally from a `manifest.json` sitting next to the data.
 */
export class HttpDataSource implements DataSource {
  readonly label: string;
  private readonly baseUrl: string;
  private readonly names: string[];
  private readonly cache = new Map<string, Uint8Array>();

  constructor(baseUrl: string, names: string[], label = baseUrl) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    this.names = names;
    this.label = label;
  }

  static async fromManifest(baseUrl: string): Promise<HttpDataSource> {
    const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const response = await fetch(`${base}manifest.json`);
    if (!response.ok) {
      throw new Error(`No manifest.json at ${base} (HTTP ${response.status})`);
    }
    const manifest = (await response.json()) as { files?: string[]; name?: string };
    return new HttpDataSource(base, manifest.files ?? [], manifest.name ?? base);
  }

  list(): string[] {
    return [...this.names];
  }

  /**
   * The manifest entry a name refers to: the whole path where one matches, and
   * otherwise the first entry with that base name.
   *
   * Same two-key rule as the local sources, for the same reason — a manifest
   * lists `audio/logo.1/1111.voc` and a script may ask for either form.
   */
  private resolve(name: string): { actual: string; key: string } | null {
    const [path, base] = lookupKeys(name);
    const byPath = this.names.find((candidate) => normalise(candidate) === path);
    if (byPath) return { actual: byPath, key: path };
    const byBase = this.names.find((candidate) => lookupKeys(candidate)[1] === base);
    return byBase ? { actual: byBase, key: normalise(byBase) } : null;
  }

  /**
   * An HTTP Range request.
   *
   * A server that honours it answers 206 with just those bytes. One that does
   * not answers 200 with the whole file — which is correct, not an error, so
   * the response is sliced rather than refused. Checking the status rather than
   * assuming is the difference between "this works everywhere, fast where it
   * can be" and "this silently reads the wrong bytes on a server that ignores
   * the header".
   */
  async readRange(name: string, start: number, end: number): Promise<Uint8Array | null> {
    const found = this.resolve(name);
    if (!found) return null;
    const { actual, key } = found;

    const cached = this.cache.get(key);
    if (cached) return cached.subarray(start, Math.min(end, cached.length));

    const response = await fetch(this.baseUrl + actual, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    });
    if (!response.ok) return null;

    const data = new Uint8Array(await response.arrayBuffer());
    if (response.status === 206) return data;
    return data.subarray(start, Math.min(end, data.length));
  }

  async read(name: string, onBytes?: ByteProgress): Promise<Uint8Array | null> {
    const found = this.resolve(name);
    if (!found) return null;
    const { actual, key } = found;

    const cached = this.cache.get(key);
    if (cached) {
      onBytes?.(cached.length, cached.length);
      return cached;
    }

    const response = await fetch(this.baseUrl + actual);
    if (!response.ok) return null;

    let data: Uint8Array;
    if (onBytes && response.body) {
      const header = response.headers.get('content-length');
      const total = header === null ? undefined : Number(header);
      data = await drainStream(
        response.body,
        total !== undefined && Number.isFinite(total) ? total : undefined,
        onBytes,
      );
    } else {
      data = new Uint8Array(await response.arrayBuffer());
      onBytes?.(data.length, data.length);
    }

    this.cache.set(key, data);
    return data;
  }
}
