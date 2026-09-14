/**
 * The names this project writes into the browser, in one place.
 *
 * They were all `scumm-web:…`, from when the project was called that. It runs
 * two engine families now and is called MGI, and a key that still says SCUMM is
 * a thing an author has to read in their own browser's storage inspector and
 * work out. So they say `mgi-web:` — and because a rename that dropped what was
 * already written would cost an author their autosaved project, the old names
 * are read once and moved across rather than abandoned.
 *
 * Collected here rather than declared beside each use because the storage
 * notice in `consent.ts` has to list them, and a list written out a second time
 * is a list that drifts from what the code actually writes.
 */

/** What the project writes today. */
export const STORAGE_KEYS = {
  project: 'mgi-web:project',
  projectBackup: 'mgi-web:project:previous',
  projectMeta: 'mgi-web:project:meta',
  editorSections: 'mgi-web:editor:sections',
  /*
   * One per family, because the sidebars are not the same sidebar.
   *
   * A SCUMM project has Rooms and Costumes, an AGOS project has Zones and a
   * Broken Sword project has Compacts, so one shared set of open sections
   * would either remember a name the next family does not have or fold
   * everything on the way in. They are named here rather than beside each
   * editor for this file's own reason: the storage notice lists what the
   * project writes, and a key declared somewhere else is a key the notice
   * silently stops mentioning.
   */
  editorSectionsAgos: 'mgi-web:editor:agos-sections',
  editorSectionsSword1: 'mgi-web:editor:sword1-sections',
  editorSectionsSword2: 'mgi-web:editor:sword2-sections',
  editorSectionsSci: 'mgi-web:editor:sci-sections',
  consent: 'mgi-web:cookie-consent',
} as const;

/** The IndexedDB database, which holds what is too large for the above. */
export const DATABASE_NAME = 'mgi-web';

/** The prefix every one of these keys used before the rename. */
const LEGACY_PREFIX = 'scumm-web:';
const PREFIX = 'mgi-web:';

/** What the database was called then. */
export const LEGACY_DATABASE_NAME = 'scumm-web';

/** The name a key was written under before the rename. */
export function legacyKey(key: string): string {
  return key.startsWith(PREFIX) ? LEGACY_PREFIX + key.slice(PREFIX.length) : key;
}

/** Only what a migration needs, so this is testable without a browser. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Moves anything written under the old names to the new ones.
 *
 * Run at startup on both pages, and cheap enough to: five `getItem` calls
 * against keys that are absent in every browser that has not seen an older
 * build. Idempotent, because it removes what it moved.
 *
 * A key already present under the new name wins and the old one is dropped —
 * the new one was written by a later build than the one that wrote the old, and
 * restoring an older autosave over a newer one is the shape of losing work.
 *
 * Nothing here throws. Reading `localStorage` can fail outright in a private
 * window or with site data blocked, and a page that will not load because it
 * could not tidy its own key names would be a poor trade.
 */
export function migrateLegacyStorage(store: KeyValueStore | null = localStorageOrNull()): void {
  if (!store) return;

  for (const key of Object.values(STORAGE_KEYS)) {
    const from = legacyKey(key);
    try {
      const value = store.getItem(from);
      if (value === null) continue;
      if (store.getItem(key) === null) store.setItem(key, value);
      store.removeItem(from);
    } catch {
      // A full or unavailable store: the old key stays where it is, and the
      // next visit tries again.
    }
  }
}

function localStorageOrNull(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
