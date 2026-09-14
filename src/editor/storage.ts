import { migrate, type Project } from '../authoring/project.js';
import { isZip, readZip } from '../engine/resource/zip.js';
import { STORAGE_KEYS } from '../ui/storageKeys.js';
import { putAudioBytes } from './audioStore.js';

/**
 * Where a project lives.
 *
 * Three tiers, deliberately: local storage for "don't lose my work on a
 * refresh", a JSON file for "this is mine and I can back it up", and the
 * compiled container for "let someone play it". Only the middle one is a real
 * save — local storage is per-browser and evaporates when site data is cleared,
 * so the editor nags toward exporting rather than pretending otherwise.
 */

const STORAGE_KEY = STORAGE_KEYS.project;
const BACKUP_KEY = STORAGE_KEYS.projectBackup;
const META_KEY = STORAGE_KEYS.projectMeta;

export interface SaveMeta {
  savedAt: number;
  /** Bytes used, so the UI can warn before the quota is hit. */
  size: number;
  /** Whether the last export is older than the last edit. */
  exportedAt: number | null;
}

function storage(): Storage | null {
  try {
    // Private browsing and blocked-cookie settings both make this throw rather
    // than return null, so the access itself has to be guarded.
    const test = '__mgi_probe__';
    window.localStorage.setItem(test, '1');
    window.localStorage.removeItem(test);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isStorageAvailable(): boolean {
  return storage() !== null;
}

/**
 * Writes the project, keeping the previous copy as a one-deep backup.
 *
 * The backup exists because the most likely way to lose work is a bug in the
 * editor writing something broken, not the browser losing the key.
 */
export function saveLocal(project: Project): SaveMeta | null {
  const store = storage();
  if (!store) return null;

  const serialised = JSON.stringify(project);

  try {
    const previous = store.getItem(STORAGE_KEY);
    if (previous) store.setItem(BACKUP_KEY, previous);
    store.setItem(STORAGE_KEY, serialised);

    const meta: SaveMeta = {
      savedAt: Date.now(),
      size: serialised.length,
      exportedAt: readMeta()?.exportedAt ?? null,
    };
    store.setItem(META_KEY, JSON.stringify(meta));
    return meta;
  } catch (error) {
    // Almost always the quota. Drop the backup to make room and try once more,
    // because losing the backup is much better than losing the save.
    try {
      store.removeItem(BACKUP_KEY);
      store.setItem(STORAGE_KEY, serialised);
      return { savedAt: Date.now(), size: serialised.length, exportedAt: null };
    } catch {
      throw new Error(
        `Could not autosave: browser storage is full (${Math.round(serialised.length / 1024)} KB). ` +
          `Export the project to a file — your work is still here until you close the tab.`,
        { cause: error },
      );
    }
  }
}

export function loadLocal(): Project | null {
  const store = storage();
  if (!store) return null;

  const raw = store.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    return migrate(JSON.parse(raw));
  } catch {
    // A corrupt autosave should not lock the author out of the editor.
    return loadBackup();
  }
}

export function loadBackup(): Project | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(BACKUP_KEY);
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function readMeta(): SaveMeta | null {
  const store = storage();
  if (!store) return null;
  const raw = store.getItem(META_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SaveMeta;
  } catch {
    return null;
  }
}

export function markExported(): void {
  const store = storage();
  if (!store) return;
  const meta = readMeta();
  store.setItem(
    META_KEY,
    JSON.stringify({
      savedAt: meta?.savedAt ?? Date.now(),
      size: meta?.size ?? 0,
      exportedAt: Date.now(),
    } satisfies SaveMeta),
  );
}

export function clearLocal(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(STORAGE_KEY);
  store.removeItem(BACKUP_KEY);
  store.removeItem(META_KEY);
}

/** True when there are edits newer than the last export. */
export function hasUnexportedChanges(): boolean {
  const meta = readMeta();
  if (!meta) return false;
  if (meta.exportedAt === null) return true;
  return meta.savedAt > meta.exportedAt;
}

// ------------------------------------------------------------------ files ---

/** Triggers a download. The only way a browser page can hand over a file. */
export function downloadBlob(filename: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportProjectFile(project: Project): void {
  const safeName = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'game';
  downloadBlob(`${safeName}.scummproj.json`, JSON.stringify(project, null, 2), 'application/json');
  markExported();
}

/**
 * Reads a project back in, from either form it can be exported as.
 *
 * A zip carries the document and the audio that was too large to live inside
 * it; the audio is put back into the store before the project is returned, so
 * that by the time the editor sees it every track can be played. A plain
 * `.json` is returned as it always was.
 */
export async function importProjectFile(file: File): Promise<Project> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isZip(bytes)) return migrate(JSON.parse(new TextDecoder().decode(bytes)));

  const source = await readZip(bytes, file.name);
  const names = source.list();

  const documentName = names.find((name) => name.endsWith('.json'));
  if (!documentName) throw new Error('That archive has no project file in it');

  const document = await source.read(documentName);
  if (!document) throw new Error("That archive's project file could not be read");
  const project = migrate(JSON.parse(new TextDecoder().decode(document)));

  for (const name of names) {
    if (!name.startsWith('audio/')) continue;
    const key = name.slice('audio/'.length);
    if (!key) continue;

    const audio = await source.read(name);
    // Restored under the key the project already refers to, so nothing in the
    // document has to be rewritten to point at it.
    if (audio) await putAudioBytes(key, audio);
  }

  return project;
}
