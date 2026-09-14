/**
 * The games folder, from the browser's side.
 *
 * Game data is big — Day of the Tentacle's demo is a megabyte and Sam & Max's
 * talkie thirteen — and picking it through the browser's folder dialog on every
 * reload is the kind of friction that stops you testing at all. So the dev
 * server offers a `games/` folder next to `package.json`, lists what is in it,
 * and this turns an entry of that listing into something the engine can load.
 *
 * Three shapes, because all three are what people have on disk: a subfolder per
 * game, a `.zip` as downloaded, and loose files in the folder root.
 *
 * **The listing is a development convenience and its absence is normal.** A
 * static production build has no server to ask, so `list()` answers with an
 * empty array and the UI simply shows nothing — the file picker and the
 * drop zone are unchanged and remain the only route there.
 */
import { HttpDataSource, type DataSource } from '../engine/resource/DataSource.js';
import { isZip, readZip } from '../engine/resource/zip.js';
import type { LoadProgressTracker } from '../engine/resource/progress.js';

/** One loadable thing in the folder, as the server described it. */
export interface GamesFolderEntry {
  /** Path segment relative to the folder; empty for the loose files. */
  id: string;
  name: string;
  kind: 'folder' | 'zip' | 'loose';
  files: string[];
  bytes: number;
  /** The game's own README, relative to its folder, when the server found one. */
  readme?: string;
  /** What that README calls the game, when it says. */
  title?: string;
  /**
   * What its second line says the game runs on — `SCUMM v5`.
   *
   * The author's own label rather than a detection, so it is shown and never
   * acted on: the loader is what decides what the files actually are.
   */
  engine?: string;
}

interface GamesFolderListing {
  /** The absolute path on the serving machine, for the UI to name. */
  root: string;
  entries: GamesFolderEntry[];
}

/** Where the folder is served. Relative, so a sub-path deployment still works. */
const LISTING_URL = 'games/index.json';

/** Empty rather than throwing: no listing is the ordinary production case. */
export async function listGamesFolder(): Promise<GamesFolderListing> {
  try {
    const response = await fetch(LISTING_URL, { headers: { Accept: 'application/json' } });
    if (!response.ok) return { root: '', entries: [] };

    // A static host that answers every path with index.html would otherwise
    // have its HTML parsed as JSON and throw somewhere less obvious.
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) return { root: '', entries: [] };

    const listing = (await response.json()) as Partial<GamesFolderListing>;
    return { root: listing.root ?? '', entries: listing.entries ?? [] };
  } catch {
    return { root: '', entries: [] };
  }
}

/** "1.8 MB" — enough to know what a click is about to fetch. */
export function describeSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${bytes} B`;
}

/**
 * How the entry will be read, in the terms the person choosing it cares about.
 *
 * Named rather than inlined because "7 files" and "unpacked in your browser"
 * answer different questions, and a folder of twenty files where two are the
 * game is worth being able to see before it is loaded.
 */
export function describeEntry(entry: GamesFolderEntry): string {
  const size = describeSize(entry.bytes);
  if (entry.kind === 'zip') return `${size} zip, unpacked in your browser`;
  const count = `${entry.files.length} file${entry.files.length === 1 ? '' : 's'}`;
  if (entry.kind === 'loose') return `${count} loose in the folder · ${size}`;
  return `${count} · ${size}`;
}

/**
 * What to call the entry.
 *
 * The README's title where there is one, and the folder name otherwise — a
 * folder is named for typing, not for reading, and `indy` beside a nine
 * megabyte file says less than "Indiana Jones and the Fate of Atlantis".
 */
export function entryTitle(entry: GamesFolderEntry): string {
  const title = entry.title?.trim();
  return title === undefined || title === '' ? entry.name : title;
}

/**
 * The line under the name: what it runs on, how it will be read, how big it is.
 *
 * The engine first, because it is the shortest and the most useful of the
 * three — "SCUMM v6" says whether a game is on the version this project has
 * played end to end before the size says whether it is worth the wait.
 */
export function entrySubtitle(entry: GamesFolderEntry): string {
  const engine = entry.engine?.trim();
  return [engine === '' ? undefined : engine, describeEntry(entry)].filter(Boolean).join(' · ');
}

/** Where the entry's files are served from, and what its README links resolve against. */
export function entryBaseUrl(entry: GamesFolderEntry): string {
  return entry.id === '' ? 'games/' : `games/${encodeURIComponent(entry.id)}/`;
}

/**
 * The text of the entry's README, or null when it has none or it could not be read.
 *
 * Fetched when someone asks to see it rather than with the listing: a README is
 * prose and there may be a folder of games, and none of it is needed to draw
 * the list.
 */
export async function fetchEntryReadme(entry: GamesFolderEntry): Promise<string | null> {
  if (entry.readme === undefined) return null;
  try {
    const response = await fetch(`${entryBaseUrl(entry)}${encodeURIComponent(entry.readme)}`);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Turns an entry into a data source the engine can load.
 *
 * A folder or the loose files are fetched file by file as the engine asks for
 * them, so a thirteen-megabyte talkie costs nothing until something reads it. A
 * zip has to come whole, because that is what unpacking one means.
 */
export async function sourceFromGamesFolderEntry(
  entry: GamesFolderEntry,
  progress: LoadProgressTracker,
): Promise<DataSource> {
  if (entry.kind === 'zip') {
    progress.report('reading-archive', `Fetching ${entry.name}…`, 0.25);
    const response = await fetch(`games/${encodeURIComponent(entry.id)}`);
    if (!response.ok) {
      throw new Error(`Could not read games/${entry.id} (HTTP ${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isZip(bytes)) {
      throw new Error(`games/${entry.id} is named like a zip but does not contain one.`);
    }
    progress.report('reading-archive', `Unpacking ${entry.name}…`, 0.5);
    await progress.yieldToUi();
    return readZip(bytes, entry.name);
  }

  // An id of "" is the folder root, and `games//FILE` is not the same URL as
  // `games/FILE` to every server.
  const base = entryBaseUrl(entry);
  progress.report('reading-archive', `Reading ${entry.name} from the games folder…`);
  return new HttpDataSource(base, entry.files, entry.name);
}
