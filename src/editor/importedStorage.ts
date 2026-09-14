import type { EditableSource } from '../authoring/exportEdits.js';
import { migrate, type Project } from '../authoring/project.js';
import type { ResourceLayout } from '../engine/resource/GameDetector.js';
import { DATABASE_NAME, LEGACY_DATABASE_NAME } from '../ui/storageKeys.js';

/**
 * The hand-off between the player and the editor.
 *
 * A decompiled game is far too big for local storage — a hundred rooms of
 * decoded backgrounds is megabytes, and the whole autosave budget is about
 * five — so the import goes through IndexedDB, which has room for it and does
 * not charge the main thread for the write.
 *
 * It is a hand-off, not a save: the editor takes the project out on arrival and
 * autosaves it as its own from then on. Leaving it here would mean every reload
 * of the editor silently discarded the author's edits in favour of the original
 * import, which is the worst possible way to lose work.
 */

const DB_NAME = DATABASE_NAME;
/** Bumped when a store is added; version 2 introduced the audio store. */
const DB_VERSION = 2;
const STORE = 'handoff';
/** Audio too large to live inside the project document. */
export const AUDIO_STORE = 'audio';
const KEY = 'imported-project';
/**
 * The original game files, kept beside the imported project.
 *
 * A project is not a complete description of the game it came from: art,
 * sound and every resource no importer understands live only in these files.
 * Exporting an edited game rewrites *them* rather than compiling a new game,
 * so they have to survive the handoff or the edit has nowhere to go.
 */
const SOURCE_KEY = 'imported-source';
const AUTOSAVE_KEY = 'large-project';

/**
 * Opens the database, creating whichever stores are missing.
 *
 * Both stores are created here rather than each module opening the database
 * for itself: two openers with different version numbers race, and the loser
 * gets a blocked connection rather than an error anyone can act on.
 */
export function openDatabase(): Promise<IDBDatabase> {
  // The rename comes first, so a build that finds an older one's database
  // reads what is in it rather than opening an empty one beside it.
  return adoptLegacyDatabase().then(() => openNamed(DB_NAME));
}

function openNamed(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of [STORE, AUDIO_STORE]) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the database'));
  });
}

// ----------------------------------------------------------- the rename ----

/**
 * The database was called `scumm-web` before the project was.
 *
 * What is in it is an author's work — a project too large for local storage
 * autosaves here, and so does any audio too large to sit inside the project —
 * so the new name takes over the old one's contents rather than starting
 * empty beside them. Records are copied one at a time: a CD soundtrack in that
 * store is hundreds of megabytes, and reading every value at once to move them
 * would be the one way this could fail on the data it exists to protect.
 *
 * Run once per page, and best-effort throughout: a failure anywhere leaves the
 * old database untouched, so the worst case is that the next visit tries again.
 */
let adoption: Promise<void> | null = null;

function adoptLegacyDatabase(): Promise<void> {
  adoption ??= copyLegacyDatabase().catch(() => undefined);
  return adoption;
}

async function copyLegacyDatabase(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (!(await legacyDatabaseExists())) return;

  const legacy = await openNamed(LEGACY_DATABASE_NAME);
  try {
    const target = await openNamed(DB_NAME);
    try {
      for (const store of [STORE, AUDIO_STORE]) {
        if (!legacy.objectStoreNames.contains(store)) continue;
        for (const key of await allKeys(legacy, store)) {
          // Anything already under the new name was written by a later build
          // than the one that wrote the old, so it wins.
          if (await has(target, store, key)) continue;
          await copyRecord(legacy, target, store, key);
        }
      }
    } finally {
      target.close();
    }
  } finally {
    legacy.close();
  }

  // Only now: an old database left behind would be adopted again on the next
  // visit and could overwrite nothing, but it would sit in the browser's
  // storage under a name this project no longer uses.
  await deleteDatabase(LEGACY_DATABASE_NAME);
}

/**
 * Whether the old database is there at all.
 *
 * `indexedDB.databases()` answers directly where it exists. Where it does not,
 * opening the database says so a different way: `onupgradeneeded` fires only
 * when the open call had to create it, so a fire means there was nothing there
 * — and what it just created is deleted again rather than left behind.
 */
async function legacyDatabaseExists(): Promise<boolean> {
  if ('databases' in indexedDB) {
    try {
      const names = await indexedDB.databases();
      return names.some((entry) => entry.name === LEGACY_DATABASE_NAME);
    } catch {
      // Falls through to the open-and-see route below.
    }
  }

  return await new Promise<boolean>((resolve) => {
    let created = false;
    const request = indexedDB.open(LEGACY_DATABASE_NAME);
    request.onupgradeneeded = () => {
      created = true;
    };
    request.onsuccess = () => {
      request.result.close();
      if (created) void deleteDatabase(LEGACY_DATABASE_NAME);
      resolve(!created);
    };
    request.onerror = () => resolve(false);
  });
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    // Resolved either way, including `blocked` — another tab holding the old
    // database open is not a reason to fail the one being opened here.
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function request<T>(work: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = work();
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(pending.error ?? new Error('Database request failed'));
  });
}

function allKeys(db: IDBDatabase, store: string): Promise<IDBValidKey[]> {
  return request(() => db.transaction(store, 'readonly').objectStore(store).getAllKeys());
}

async function has(db: IDBDatabase, store: string, key: IDBValidKey): Promise<boolean> {
  const found = await request(() =>
    db.transaction(store, 'readonly').objectStore(store).getKey(key),
  );
  return found !== undefined;
}

async function copyRecord(
  from: IDBDatabase,
  to: IDBDatabase,
  store: string,
  key: IDBValidKey,
): Promise<void> {
  const value = await request<unknown>(() =>
    from.transaction(store, 'readonly').objectStore(store).get(key),
  );
  if (value === undefined) return;
  await request(() => to.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

const open = openDatabase;

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Database request failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Database write aborted'));
  });
}

/** True when the browser will let us store an import at all. */
export function isHandoffAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * The files a published game ships as, decrypted, with the keys they want back.
 *
 * `EditableSource` itself, so the handoff and the exporter agree by
 * construction rather than by two structures being kept in step. It used to be
 * an index and a data file, which is true of exactly one of the three Resource
 * layouts.
 */
export type ImportedSource = EditableSource;

/** What a stored handoff looks like on the way out of IndexedDB. */
interface StoredSource {
  index: ArrayLike<number>;
  /** The pre-file-set shape: one data file, unnamed. */
  data?: ArrayLike<number>;
  dataFiles?: Array<{ name: string; data: ArrayLike<number> }>;
  /**
   * The charsets the pre-v5 layouts keep outside the data.
   *
   * Optional because a handoff written before they were carried has none, and
   * because `lecf-container` never has any — its charsets are resources inside
   * the container.
   */
  charsetFiles?: Array<{ name: string; data: ArrayLike<number> }>;
  xorKey: number;
  dataXorKey?: number;
  layout?: ResourceLayout;
  version?: number;
  indexFile?: string;
}

/** Keeps the original files so an edited game can be written back over them. */
export async function putImportedSource(source: ImportedSource): Promise<void> {
  if (!isHandoffAvailable()) return;
  const db = await open();
  try {
    await run(db, 'readwrite', (store) =>
      // Copied rather than converted. A structured clone of a `Uint8Array`
      // *view* carries its whole backing buffer, which for a game file is the
      // entire file however small the view — so the view has to go. `slice`
      // gives a typed array with a buffer of its own exact size, which is the
      // cheap way to do that.
      //
      // `Array.from` also solved the view problem and was how this was written,
      // at a cost that only showed up on a big game: Sam & Max's 16 MB data
      // file became a JS array of sixteen million numbers, an order of
      // magnitude more memory, and slow enough that clicking Edit looked like
      // nothing happening.
      store.put(
        {
          index: source.index.slice(),
          dataFiles: source.dataFiles.map((file) => ({
            name: file.name,
            data: file.data.slice(),
          })),
          charsetFiles: (source.charsetFiles ?? []).map((file) => ({
            name: file.name,
            data: file.data.slice(),
          })),
          xorKey: source.xorKey,
          dataXorKey: source.dataXorKey,
          layout: source.layout,
          version: source.version,
          indexFile: source.indexFile,
        },
        SOURCE_KEY,
      ),
    );
  } finally {
    db.close();
  }
}

/** The original files for the project in hand, or null when there are none. */
export async function getImportedSource(): Promise<ImportedSource | null> {
  if (!isHandoffAvailable()) return null;

  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return null;
  }

  try {
    const stored = await run<StoredSource | undefined>(db, 'readonly', (store) =>
      store.get(SOURCE_KEY),
    );
    if (!stored) return null;

    // `Uint8Array.from` reads either shape, so a handoff written by an older
    // build — which stored plain arrays — still loads.
    const indexFile = stored.indexFile ?? 'GAME.000';
    // A handoff written before the file set existed held one unnamed data
    // file, and could only ever have been a container game: those are the
    // Versions the editor reached at the time. Named the way that layout names
    // it, so an export of an old handoff writes the pair it always wrote.
    const dataFiles = stored.dataFiles
      ? stored.dataFiles.map((file) => ({ name: file.name, data: Uint8Array.from(file.data) }))
      : stored.data
        ? [{ name: indexFile.replace(/0$/, '1'), data: Uint8Array.from(stored.data) }]
        : [];

    return {
      layout: stored.layout ?? 'lecf-container',
      version: stored.version ?? 5,
      indexFile,
      index: Uint8Array.from(stored.index),
      dataFiles,
      charsetFiles: (stored.charsetFiles ?? []).map((file) => ({
        name: file.name,
        data: Uint8Array.from(file.data),
      })),
      xorKey: stored.xorKey,
      dataXorKey: stored.dataXorKey ?? stored.xorKey,
    };
  } catch {
    // A project without its source is still editable; it just cannot be
    // exported back over the original game.
    return null;
  } finally {
    db.close();
  }
}

export async function putImportedProject(project: Project): Promise<void> {
  const db = await open();
  try {
    // Stored as JSON rather than as a live object: structured clone would keep
    // whatever the importer happened to build, and the editor should receive
    // exactly what a saved project looks like.
    await run(db, 'readwrite', (store) => store.put(JSON.stringify(project), KEY));
  } finally {
    db.close();
  }
}

/**
 * Takes the pending import, removing it.
 *
 * Returns null when there is none, which is the normal case: the editor is
 * usually opened on its own work, not on an import.
 */
export async function takeImportedProject(): Promise<Project | null> {
  if (!isHandoffAvailable()) return null;

  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return null;
  }

  try {
    const raw = await run<string | undefined>(db, 'readonly', (store) => store.get(KEY));
    if (!raw) return null;

    await run(db, 'readwrite', (store) => store.delete(KEY));
    return migrate(JSON.parse(raw));
  } catch {
    // A corrupt hand-off should drop the author into the editor, not a blank
    // page. Clearing it stops the same failure repeating on every reload.
    try {
      await run(db, 'readwrite', (store) => store.delete(KEY));
    } catch {
      // Nothing further to try.
    }
    return null;
  } finally {
    db.close();
  }
}

/**
 * Autosave for a project too big for local storage.
 *
 * A decompiled game is megabytes of decoded art, and the local-storage budget
 * is about five for everything. Rather than telling the author their work
 * cannot be saved, the editor falls back to here, which has room.
 */
export async function putAutosave(project: Project): Promise<void> {
  const db = await open();
  try {
    await run(db, 'readwrite', (store) => store.put(JSON.stringify(project), AUTOSAVE_KEY));
  } finally {
    db.close();
  }
}

export async function getAutosave(): Promise<Project | null> {
  if (!isHandoffAvailable()) return null;

  let db: IDBDatabase;
  try {
    db = await open();
  } catch {
    return null;
  }

  try {
    const raw = await run<string | undefined>(db, 'readonly', (store) => store.get(AUTOSAVE_KEY));
    return raw ? migrate(JSON.parse(raw)) : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
