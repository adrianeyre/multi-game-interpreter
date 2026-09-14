import { AUDIO_STORE, openDatabase } from './importedStorage.js';

/**
 * Where large audio lives.
 *
 * A project is one JSON document, and audio is the only asset that will not
 * fit in one. A twenty kilobyte sound effect is fine inline, next to the room
 * art; a CD soundtrack is not — twenty four FLAC tracks are two hundred
 * megabytes, which becomes two hundred and seventy eight as base64, in a
 * document the editor re-serialises every time an author moves an object.
 *
 * So bytes above a threshold go here instead, keyed by a name the project
 * carries, and the project keeps only what it needs to list the track. Below
 * the threshold nothing changes: a small sound stays inline, where it travels
 * with the project for free.
 */

/**
 * The largest audio kept inside the project document.
 *
 * Chosen so that a game's own sound effects — a few tens of kilobytes each —
 * stay inline and keep travelling with a plain `.json` export, while anything
 * of a size that would break local storage is moved out. A quarter of a
 * megabyte is comfortably above the largest effect in a v5 game and
 * comfortably below a minute of music.
 */
export const INLINE_LIMIT = 256 * 1024;

export function isAudioStoreAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(AUDIO_STORE, mode);
    const request = work(transaction.objectStore(AUDIO_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Audio store request failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('Audio write aborted'));
  });
}

/**
 * A key that identifies these bytes and nothing else.
 *
 * Random rather than derived from the track's id, because ids are reused: a
 * track deleted and another imported into the same number must not inherit the
 * first one's audio. Random rather than a content hash because hashing two
 * hundred megabytes to file it costs more than the collision it would avoid.
 */
export function newAudioKey(): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `audio-${random}`;
}

export async function putAudioBytes(key: string, bytes: Uint8Array): Promise<void> {
  const db = await openDatabase();
  try {
    // Stored as a plain buffer: structured clone handles it without copying it
    // through a string, which is the whole reason this is not in the project.
    await run(db, 'readwrite', (store) => store.put(bytes.slice().buffer, key));
  } finally {
    db.close();
  }
}

export async function getAudioBytes(key: string): Promise<Uint8Array | null> {
  const db = await openDatabase();
  try {
    const value = await run<ArrayBuffer | undefined>(db, 'readonly', (store) => store.get(key));
    return value ? new Uint8Array(value) : null;
  } finally {
    db.close();
  }
}

export async function deleteAudioBytes(key: string): Promise<void> {
  const db = await openDatabase();
  try {
    await run(db, 'readwrite', (store) => store.delete(key));
  } finally {
    db.close();
  }
}

/** Every key the store holds, for finding audio no project refers to. */
export async function listAudioKeys(): Promise<string[]> {
  const db = await openDatabase();
  try {
    const keys = await run<IDBValidKey[]>(db, 'readonly', (store) => store.getAllKeys());
    return keys.map(String);
  } finally {
    db.close();
  }
}

/**
 * Removes stored audio that nothing points at any more.
 *
 * Deleting a track removes its bytes, but a project replaced wholesale — an
 * import, or an undo across one — leaves the previous project's audio behind
 * with nothing to delete it. Without a sweep the store would only ever grow,
 * and it grows in hundreds of megabytes.
 */
export async function collectOrphanedAudio(liveKeys: Iterable<string>): Promise<number> {
  const live = new Set(liveKeys);
  const stored = await listAudioKeys();

  let removed = 0;
  for (const key of stored) {
    if (live.has(key)) continue;
    await deleteAudioBytes(key);
    removed++;
  }
  return removed;
}
