/**
 * Reading a `games/` folder on the machine running the dev server.
 *
 * A browser cannot list a directory over HTTP, which is why self-hosted game
 * data has needed a hand-written `manifest.json` next to it. A dev server can
 * list one — so this does, and the manifest becomes optional.
 *
 * That matters most for the games this engine has only just started running.
 * Day of the Tentacle's data is a megabyte and Sam & Max's talkie is thirteen,
 * and picking them through the browser's folder dialog on every reload is the
 * kind of friction that stops you testing. Dropping them in `games/` once and
 * clicking a name is the difference.
 *
 * **Node only.** It reads the filesystem, so it is imported by the Vite plugin
 * and never by anything that ships to the browser.
 *
 * Nothing here is redistributable: `games/` is git-ignored, and this module
 * only ever reads it.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Pure text-to-AST, no DOM: the same reader the browser renders a README with,
// so the title in the listing is the heading the modal goes on to show rather
// than a second rule about what a first line means.
import { markdownSubtitle, markdownTitle } from '../ui/markdown.js';

/** One thing in the folder that could be loaded as a game. */
export interface GamesFolderEntry {
  /**
   * The path segment that addresses it, relative to the folder.
   *
   * A subfolder's own name, a zip's filename, or the empty string for the
   * loose files sitting in the folder root.
   */
  id: string;
  /** What to show in the UI. */
  name: string;
  kind: 'folder' | 'zip' | 'loose';
  /**
   * The files it holds, for the browser to fetch.
   *
   * Empty for a zip, which is fetched whole and unpacked in the browser.
   */
  files: string[];
  /** Total size, so the UI can say how big a game is before loading it. */
  bytes: number;
  /**
   * The game's own `README.md`, relative to its folder, when it has one.
   *
   * A name rather than the file's contents: a README can be long and there can
   * be a folder of games, and the listing is fetched on every page load while
   * the text is read only when someone asks to see it.
   */
  readme?: string;
  /**
   * What the README calls the game, when it says.
   *
   * Kept apart from `name`, which stays the folder's own name: `name` is what
   * the loader logs and what a data source is labelled with, and a title is
   * what a person reads. A folder with no README has no title and is listed
   * exactly as it was before.
   */
  title?: string;
  /**
   * What the README's second line says the game runs on — `SCUMM v5`.
   *
   * A label the author wrote, not a parsed Target and not a detection: nothing
   * here opens the game's index. It is shown beside the name so which
   * interpreter a folder is for is visible before anything is loaded, and the
   * loader's own detector still has the last word on what the files are.
   */
  engine?: string;
}

/**
 * Names that are never game data.
 *
 * `manifest.json` is skipped as a *file* but still honoured when a folder
 * carries one, so a directory laid out for static hosting keeps working.
 */
const IGNORED = new Set(['manifest.json', '.ds_store', 'thumbs.db']);

/**
 * What a game's folder holds for the reader rather than for the interpreter.
 *
 * A README and the pictures it shows are documentation, so they are not
 * offered to the engine, not counted in the size the UI reports and not part of
 * the file list a data source is built from. No release ships any of these, so
 * nothing is being hidden from the loader that it could have used.
 */
const DOCUMENTATION = new Set([
  '.md',
  '.markdown',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
]);

function isDocumentation(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot > 0 && DOCUMENTATION.has(name.slice(dot).toLowerCase());
}

function isIgnored(name: string): boolean {
  return name.startsWith('.') || IGNORED.has(name.toLowerCase()) || isDocumentation(name);
}

/** How much of a README is read to find its title. */
const TITLE_BYTES = 8 * 1024;

/**
 * A folder's README, what it calls the game, and what it runs on.
 *
 * Only the head of the file is read. A title is in the first line or it is not
 * in the file, and a README with a game's whole history in it should not be
 * loaded in full to list a name.
 *
 * The filename is recorded as it is spelled on disk, because `README.md` and
 * `readme.md` are two different URLs to a case-sensitive filesystem and the
 * browser has to ask for the one that exists.
 */
export async function readFolderReadme(
  dir: string,
): Promise<{ readme: string; title?: string; engine?: string } | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const readme = names.find((name) => /^readme\.(md|markdown)$/i.test(name));
  if (readme === undefined) return null;

  let head: string;
  try {
    const handle = await open(join(dir, readme), 'r');
    try {
      const buffer = Buffer.alloc(TITLE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, TITLE_BYTES, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    // An unreadable README is still a README: the browser will say so when it
    // tries to show it, which is a better report than dropping it here.
    return { readme };
  }

  const title = markdownTitle(head);
  const engine = markdownSubtitle(head);
  return {
    readme,
    ...(title === null ? {} : { title }),
    ...(engine === null ? {} : { engine }),
  };
}

/** A prettier label than a bare directory name, without inventing one. */
function displayName(id: string, kind: GamesFolderEntry['kind']): string {
  if (kind === 'loose') return 'games folder';
  if (kind === 'zip') return id;
  return id;
}

/**
 * How deep a game's own folders are followed.
 *
 * A cap rather than unbounded recursion: this walks a directory the user
 * pointed at, and a symlink loop or a mistakenly-nested backup would otherwise
 * be a hang at startup. Four is past anything a release ships — the deepest
 * real case is one level, `VIDEO/` or `VOICE/` beside the index.
 */
const MAX_GAME_FOLDER_DEPTH = 4;

/**
 * Every file in a game's folder, including the ones in its subfolders.
 *
 * v7 releases do not keep everything beside the index. Full Throttle and The
 * Dig put their videos, their audio bundles and their subtitle fonts in
 * subfolders — `VIDEO/`, `VOICE/` — and a listing one level deep finds the
 * index and none of that, so a game boots and then plays no cutscene, no music
 * and no speech, with each of those reported separately as a missing file.
 *
 * Paths come back relative to the game's folder so the server can serve them,
 * while a lookup by name still matches on the base name alone — which is what
 * lets a script ask for `INTRO.SAN` without knowing it is in `VIDEO/`.
 */
export async function listGameFiles(dir: string, prefix = '', depth = 0): Promise<string[]> {
  if (depth > MAX_GAME_FOLDER_DEPTH) return [];

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const name of names) {
    if (isIgnored(name)) continue;
    const path = join(dir, name);

    let info;
    try {
      info = await stat(path);
    } catch {
      continue;
    }

    if (info.isFile()) files.push(prefix + name);
    else if (info.isDirectory()) {
      files.push(...(await listGameFiles(path, `${prefix}${name}/`, depth + 1)));
    }
  }
  return files;
}

async function fileSizes(dir: string, names: string[]): Promise<number> {
  let total = 0;
  for (const name of names) {
    try {
      total += (await stat(join(dir, name))).size;
    } catch {
      // A file that vanished between listing and sizing is simply not counted.
    }
  }
  return total;
}

/**
 * What is in one `games/` folder.
 *
 * Three shapes are recognised, because all three are things people actually
 * have on disk:
 *
 * - **a subfolder per game**, which is the tidy way and the only way to keep
 *   two games apart;
 * - **a `.zip`**, because that is how a game arrives — the demos from
 *   scummvm.org are zips — and unpacking it first is a step worth sparing;
 * - **loose files in the folder root**, offered as a single entry.
 *
 * The loose case deliberately hands over *everything* rather than guessing
 * which files pair up. That is what the browser's folder picker does too, and
 * the engine's own detector is what decides — so a folder with two games in it
 * loads one of them and says which, rather than this module inventing a rule
 * about filenames. The fix, and the docs say so, is a subfolder each.
 */
export async function scanGamesFolder(root: string): Promise<GamesFolderEntry[]> {
  const base = resolve(root);

  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    // No folder is the ordinary case, not an error: most people pick files.
    return [];
  }

  const entries: GamesFolderEntry[] = [];
  const loose: string[] = [];

  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (isIgnored(name)) continue;

    let info;
    try {
      info = await stat(join(base, name));
    } catch {
      continue;
    }

    if (info.isDirectory()) {
      const files = await listGameFiles(join(base, name));
      if (files.length === 0) continue;
      files.sort((a, b) => a.localeCompare(b));
      entries.push({
        id: name,
        name: displayName(name, 'folder'),
        kind: 'folder',
        files,
        bytes: await fileSizes(join(base, name), files),
        ...(await readFolderReadme(join(base, name))),
      });
      continue;
    }

    if (!info.isFile()) continue;

    if (/\.zip$/i.test(name)) {
      entries.push({
        id: name,
        name: displayName(name, 'zip'),
        kind: 'zip',
        files: [],
        bytes: info.size,
      });
      continue;
    }

    loose.push(name);
  }

  if (loose.length > 0) {
    // The folder's own README describes the folder, not a game in it, so the
    // loose entry is offered its text but never takes its title: "Your games
    // folder" as the name of a game would be a worse label than the one it has,
    // which says what the entry actually is.
    const folderReadme = await readFolderReadme(base);
    entries.push({
      id: '',
      name: displayName('', 'loose'),
      kind: 'loose',
      files: loose,
      bytes: await fileSizes(base, loose),
      // Its title and its second line are the folder's, not a game's, for the
      // same reason.
      ...(folderReadme ? { readme: folderReadme.readme } : {}),
    });
  }

  return entries;
}

/**
 * Whether a request path stays inside the folder.
 *
 * The server serves whatever the URL names, so this is the only thing between
 * a crafted request and the rest of the disk. Checked on the *resolved* path
 * rather than by looking for `..` in the text, because there is always another
 * way to write `..`.
 *
 * The containment test goes through `relative` rather than a string prefix,
 * because a resolved path is spelled in the platform's own separator: on
 * Windows the base is `C:\\...\\games`, no path under it begins with
 * `C:\\...\\games/`, and a prefix test written with a forward slash there
 * refuses *every* file in the folder. The server then falls through to Vite,
 * which sees an extensionless name like AGI's `LOGDIR`, decides it must be a
 * module and fails to parse the bytes as JavaScript — a game that will not
 * load, reported as a syntax error. `relative` also keeps the sibling guard
 * that the prefix test existed for: `games-private` is reached only by
 * climbing out, so it comes back starting with `..`.
 */
export function isInsideFolder(root: string, requested: string): boolean {
  const base = resolve(root);
  const target = resolve(base, `.${requested.startsWith('/') ? requested : `/${requested}`}`);
  const step = relative(base, target);
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}
