/**
 * Opening an AGOS game's folder again, so the editor can see its art.
 *
 * ADR 0034's route, taken. The problem it states is a serialisation boundary:
 * the shell hands the editor a Project through IndexedDB, so no live object
 * crosses into the editor and a `ZoneSource` cannot be passed down. The two
 * shapes it weighs are storing the zones beside the Project — which is exactly
 * what ADR 0010's size threshold exists to refuse, for the family with the
 * largest resources — and asking the player for the folder again, which is
 * ADR 0010's own export-time gesture moved earlier. It recommends the second,
 * "not because the second gesture is pleasant, but because the alternative
 * contradicts a decision this repository has already taken and applied
 * elsewhere".
 *
 * ## The check, and why it is not a formality
 *
 * "If re-supply is taken, it needs a same-game check with teeth." A different
 * release of the same title does not fail to open: its resources are at
 * different offsets, so its art renders as **plausible nonsense**, and an
 * author would paint over the wrong sprite and see nothing wrong until export.
 * So the base file is fingerprinted at import (`agos.baseFingerprint`) and the
 * folder offered here has to produce the same one, and is refused in words when
 * it does not.
 *
 * The archive is checked by size against what the origin recorded rather than
 * by fingerprint, and that is deliberate rather than lazy: a talkie's archive
 * is tens of megabytes and hashing it would stall the gesture, while the base
 * file beside it already identifies the release exactly. A folder holding the
 * right `GAMEPC` and a differently-sized archive is refused on the size.
 */

import type { Project } from '../../authoring/project.js';
import { describeFingerprintMismatch, fingerprintOf } from '../../authoring/agos/fingerprint.js';
import { readAgosArchive } from '../../engine/agos/resource/gameArchive.js';
import { packedZones, zoneLayoutFor } from '../../engine/agos/resource/zoneSource.js';
import type { AgosVersion } from '../../engine/agos/agosVersion.js';
import { interpreterCandidates } from '../../engine/agos/gfx/agosFont.js';
import { pickReadableFolder, type DirectoryHandleLike } from '../files.js';
import type { ZoneReader } from './zonePixels.js';

/** A folder that was offered, checked, and accepted. */
export interface AgosGameFolder {
  readonly name: string;
  /** The base file as it sits on disk, unedited. */
  readonly gamePc: Uint8Array;
  /** The resource archive, which is what an export rewrites onto. */
  readonly archive: Uint8Array;
  readonly readZonePixels: ZoneReader;
  /**
   * The same zones' *script* resources, which is where their colours are.
   *
   * A zone's palette banks sit at offset 6 of its script half, not beside the
   * pixels — which is why a script can recolour a room without a pixel moving,
   * and why an editor that read only the pixel half could show a game's art
   * only in greys.
   */
  readonly readZoneScripts: ZoneReader;
  /**
   * Files beside the game that are not the game, by name.
   *
   * The interpreter executable, in practice. AGOS keeps its font in the
   * interpreter rather than in the data (ADR 0032), so a preview built from the
   * rebuilt pair alone runs with no font and draws none of the game's words —
   * which reads as a broken game rather than as a missing file.
   *
   * Tried by name rather than listed, because a `DirectoryHandleLike` has no
   * listing: this interface exists to be satisfiable by a few objects in a
   * test, and widening it to enumerate a folder would be widening it for one
   * caller's convenience.
   */
  readonly support: ReadonlyArray<readonly [string, Uint8Array]>;
  /**
   * Speech and effects files that are in the folder, by name only.
   *
   * Names and not bytes, and that is the whole point. A talkie's speech is the
   * largest thing in the folder and ADR 0010 refuses copying it — but the
   * *release kind* is detected from the file names alone (`agosDetect`), and a
   * preview built without them runs Simon 1's talkie as its floppy release,
   * which is a different game rather than a quieter one. So the preview source
   * advertises the names and reads the bytes only if a script actually asks.
   */
  readonly speechNames: readonly string[];
  /**
   * `ICON.DAT`, whole, or null where the folder ships none.
   *
   * Carried rather than named, unlike the speech beside it, and the difference
   * is size: this is 14 KB in Simon 1 and 18 KB in Simon 2 against a talkie's
   * tens of megabytes, and every item the editor lists may want a picture out
   * of it. Reading it once at open is cheaper than a file handle per item and
   * nowhere near ADR 0010's threshold.
   *
   * Null is the ordinary case for most of the family — Elvira and Waxworks
   * keep no such file — rather than a fault in the folder.
   */
  readonly icons: Uint8Array | null;
  /**
   * A music track out of the archive, by the number the game uses.
   *
   * Exposed for the same reason the zones are: the archive holds five kinds of
   * resource in one offset table, and the editor's Audio section addresses two
   * of them. Undefined for a track this release does not ship, which is a
   * normal answer rather than a fault.
   */
  music(track: number): Uint8Array | undefined;
  /**
   * A bank of sound effects out of the archive, by its `TABLES` file's number.
   *
   * Simon 2's route. Simon 1 keeps its banks in loose files beside the game
   * and this answers nothing for it, which is why the Audio section's entries
   * carry the file name where there is one.
   */
  sound(bank: number): Uint8Array | undefined;
  /** Reads any file out of the folder, for the preview's lazy source. */
  read(name: string): Promise<Uint8Array | null>;
}

/**
 * Asks for the folder and reads it, or says why it was refused.
 *
 * A string rather than a thrown error, because every failure here is something
 * the author can act on — the wrong folder, a missing file, a different
 * release — and none of them is a fault in the editor.
 */
export async function openAgosGameFolder(project: Project): Promise<AgosGameFolder | string> {
  const origin = project.origin;
  if (!origin) {
    return (
      'This project does not record which files it came from, so there is nothing to ' +
      'match a folder against. Only a game imported from its own files can be re-supplied.'
    );
  }
  const agos = project.agos;
  if (!agos) return 'This is not an AGOS project.';

  const folder = await pickReadableFolder();
  if (!folder) return 'No folder was chosen.';

  return readAgosGameFolder(folder, project);
}

/**
 * The reading and the checking, without the picker.
 *
 * Separate so it can be tested against a folder that is a few objects rather
 * than a browser dialogue nothing can drive.
 */
export async function readAgosGameFolder(
  folder: DirectoryHandleLike,
  project: Project,
): Promise<AgosGameFolder | string> {
  const origin = project.origin;
  const agos = project.agos;
  if (!origin || !agos) return 'This project cannot be matched against a folder.';

  const gamePc = await readFile(folder, origin.indexFile);
  if (!gamePc) {
    return (
      `${folder.name} does not hold ${origin.indexFile}. This project was imported from ` +
      `that file, so opening its art needs the folder it came from.`
    );
  }

  // Both files are read before either is checked, so a folder holding the right
  // base file and the wrong archive is refused on the mismatch rather than
  // half-accepted on the name.
  const archive = await readFile(folder, origin.dataFile);
  if (!archive) {
    return (
      `${folder.name} holds ${origin.indexFile} but not ${origin.dataFile}. Both are ` +
      `needed: the base file says what the game is and the archive holds its art.`
    );
  }

  const mismatch = describeFingerprintMismatch(
    agos.baseFingerprint,
    fingerprintOf(gamePc),
    origin.indexFile,
  );
  if (mismatch) return mismatch;

  if (archive.length !== origin.dataBytes) {
    return (
      `${origin.dataFile} in that folder is ${archive.length} bytes and this project was ` +
      `built beside one of ${origin.dataBytes}. Its ${origin.indexFile} matches, so this ` +
      `is a folder with one file swapped rather than a different release — and its ` +
      `resources would be at the wrong offsets.`
    );
  }

  // Asked once and passed down. A folder that will not list is not an error —
  // every name below has a fallback — but asking twice would walk it twice.
  const listing = await listNamesOf(folder);

  const version = project.target.engine === 'agos' ? project.target.version : undefined;
  if (!version) return 'This project has no AGOS Version, so its zones cannot be addressed.';

  const layout = zoneLayoutFor(version as AgosVersion);
  if (layout !== 'packed') {
    // Said rather than guessed at. The other two layouts keep their zones in
    // separate files or in a different table, and reading one as the other
    // produces the plausible nonsense this whole check exists to prevent.
    return (
      `This game packages its zones as “${layout}”, and only the packed layout can be ` +
      `read out of a single archive here yet.`
    );
  }

  let zones;
  try {
    zones = packedZones(readAgosArchive(archive), version as AgosVersion);
  } catch (error) {
    return `${origin.dataFile} could not be read as an AGOS archive: ${
      error instanceof Error ? error.message : 'unknown reason'
    }.`;
  }

  return {
    name: folder.name,
    gamePc,
    archive,
    readZonePixels: (zone) => zones.zone(zone)?.pixels,
    readZoneScripts: (zone) => zones.zone(zone)?.scripts,
    support: await readSupportFiles(folder, listing),
    speechNames: await speechNamesIn(folder, listing),
    // Both spellings, because a folder that will not list itself can only be
    // asked — and the retail releases ship it upper case while an extracted
    // copy is as often lower.
    icons: (await readFile(folder, 'ICON.DAT')) ?? (await readFile(folder, 'icon.dat')),
    music: (track) => zones.music?.(track),
    sound: (bank) => zones.sound?.(bank),
    read: (name) => readFile(folder, name),
  };
}

/**
 * Which speech files are in the folder, by asking for each name.
 *
 * The stems and extensions `agosDetect` scores, both cases, because a
 * `DirectoryHandleLike` has no listing and this interface exists to be
 * satisfiable by a few objects in a test. Sixty lookups against a local folder
 * is nothing; widening the interface to enumerate would be widening it for one
 * caller.
 */
async function speechNamesIn(
  folder: DirectoryHandleLike,
  listing: readonly string[] | null,
): Promise<string[]> {
  const stems = ['simon', 'simon2', 'effects', 'voices', 'speech'];
  const extensions = ['.voc', '.wav', '.mp3', '.ogg', '.fla', '.flac'];

  if (listing) {
    return listing.filter((name) => {
      const base = name.toLowerCase();
      const dot = base.lastIndexOf('.');
      return dot > 0 && stems.includes(base.slice(0, dot)) && extensions.includes(base.slice(dot));
    });
  }

  const found: string[] = [];
  for (const stem of stems) {
    for (const extension of extensions) {
      for (const name of [`${stem}${extension}`, `${stem}${extension}`.toUpperCase()]) {
        if (found.some((each) => each.toLowerCase() === name.toLowerCase())) continue;
        if (await exists(folder, name)) found.push(name);
      }
    }
  }
  return found;
}

async function exists(folder: DirectoryHandleLike, name: string): Promise<boolean> {
  try {
    const handle = await folder.getFileHandle(name);
    return Boolean(handle.getFile);
  } catch {
    return false;
  }
}

/**
 * The interpreter beside the game, if it is there.
 *
 * Every candidate is tried and the ones that answer are kept, rather than
 * stopping at the first: the engine's own font search scores them, and handing
 * it one file because it happened to be first would make that scoring moot.
 */
async function readSupportFiles(
  folder: DirectoryHandleLike,
  listing: readonly string[] | null,
): Promise<Array<readonly [string, Uint8Array]>> {
  // The engine's own scoring, over the folder's real names where there are any.
  // That matters: Simon 1 retail ships `Simon1.exe`, which is on nobody's list
  // of known interpreter names and is found only by the `*.exe` sweep.
  const candidates = listing ? interpreterCandidates(listing) : INTERPRETERS;
  const found: Array<readonly [string, Uint8Array]> = [];
  for (const name of candidates) {
    const bytes = await readFile(folder, name);
    if (bytes) found.push([name, bytes]);
  }
  return found;
}

/** The folder's names, or null where the platform will not say. */
async function listNamesOf(folder: DirectoryHandleLike): Promise<string[] | null> {
  try {
    return (await folder.listNames?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The interpreter names worth asking a folder that will not list itself.
 *
 * The same names `interpreterCandidates` knows, minus its `*.exe` sweep — that
 * needs a listing, and this is the fallback for when there is none. A release
 * whose interpreter is named something else then loses its font in the preview
 * and nothing else, which is why this is a list rather than a refusal.
 */
const INTERPRETERS = [
  'SIMON.EXE',
  'simon.exe',
  'SIMON2.EXE',
  'simon2.exe',
  'ELVIRA.EXE',
  'elvira.exe',
  'ELVIRA2.EXE',
  'elvira2.exe',
  'WAXWORKS.EXE',
  'waxworks.exe',
  'FEEBLE.EXE',
  'feeble.exe',
];

async function readFile(folder: DirectoryHandleLike, name: string): Promise<Uint8Array | null> {
  try {
    const handle = await folder.getFileHandle(name);
    if (!handle.getFile) return null;
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    // Not present, or not readable. Both mean "this is not the folder", and
    // saying which adds nothing the author can act on.
    return null;
  }
}
