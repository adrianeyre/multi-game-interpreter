import type { SavedGameEnvelope } from '../AdventureEngine.js';

/**
 * Where saved games are kept between sessions.
 *
 * Deliberately over an injected key/value store rather than reaching for
 * `localStorage` directly. The browser's storage is not available in a test
 * runner, and a save format is exactly the sort of thing that has to be tested
 * — including its failure cases, which are the ones a player meets: storage
 * full, storage disabled, a save written by a newer version.
 *
 * Saves are namespaced by game, because a save's numbers only mean anything in
 * the game that wrote them, and listing another game's saves in this game's
 * menu invites exactly the mistake `describeIncompatibleSave` then has to
 * refuse.
 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** One save, as the UI lists them: enough to choose by, without the state. */
export interface SaveSummary {
  slot: number;
  name: string;
  savedAt: number;
  room: number;
}

/**
 * How many slots a game gets.
 *
 * Ten, and a fixed ten rather than a growing list, because the menu is the
 * feature: a player picking “the one before the maze” wants a board they can
 * see all of, and a list that grows by one every time you save is a list you
 * stop reading. Ten is also what the games themselves offered, so a save menu
 * here is the shape the player already knows.
 *
 * The number lives with the store rather than with the dialog because the store
 * is what refuses a slot outside it — a dialog is one caller, and `write` is
 * reachable without one.
 */
export const SAVE_SLOTS = 10;

/** Whether a slot number is one this store will accept. */
export function isSaveSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 1 && slot <= SAVE_SLOTS;
}

/**
 * What a game is called, kept beside its saves rather than inside them.
 *
 * A save's envelope carries `gameId` — `monkey2`, `tentacle` — which is an
 * identifier and not a title, and the Load menu has to name games the player
 * never loaded in this session: there is no engine in hand to ask. So the title
 * is written next to the saves at save time, when the shell does know it, and
 * read back by a menu that has nothing else to go on.
 *
 * `sourceId` is the games-folder entry the game was loaded from, when it came
 * from one. It is what lets the Load menu boot a game that is not running and
 * then put the save into it, instead of asking the player to find the files
 * again for a game it can name.
 */
export interface SaveMeta {
  title: string;
  /** "SCUMM v5", for the line under the title. Absent in an older record. */
  targetName?: string;
  /** Games-folder entry id, when the game came from the folder. */
  sourceId?: string;
}

/** One game in the Load menu: what to call it, and what it has saved. */
export interface SavedGameSummary {
  gameId: string;
  /** The meta's title, or the id when no meta was ever written. */
  title: string;
  targetName?: string;
  sourceId?: string;
  /** Its occupied slots, newest first. */
  saves: SaveSummary[];
}

/**
 * The storage key prefix, which is historical rather than descriptive.
 *
 * It says `scumm` because that is what this project was when saves arrived, and
 * an AGI save goes under the same prefix with its own game id. Renaming it
 * would orphan every save already in a player's browser to buy a tidier key,
 * which is the same trade ADR 0011 declined for the package name.
 */
const PREFIX = 'scumm.save';

/**
 * The key suffix that holds a game's title instead of a save.
 *
 * A word rather than a number, which is what keeps it out of every slot
 * listing: those parse the last segment as an integer and skip what is not one,
 * so the record sits in the same namespace as the saves it describes without
 * ever being mistaken for one.
 */
const META_SUFFIX = 'meta';

/**
 * Saves for one game, whichever Engine family wrote them.
 *
 * Generic over the payload, because the store's job is the envelope — list it,
 * read it, refuse one from the future — and everything inside a save is its
 * family's business. AGI's state is 255 flags and 255 vars where SCUMM's is a
 * script slot array and a cutscene stack, and neither belongs here.
 */
export class SaveStore<T extends SavedGameEnvelope = SavedGameEnvelope> {
  private readonly storage: StorageLike;
  private readonly gameId: string;
  /**
   * The newest save format this build can read.
   *
   * Injected rather than imported, because the two families version their
   * payloads independently: a SCUMM format 4 and an AGI format 1 are not
   * comparable numbers, and one module importing the other's constant is how
   * they would end up compared.
   */
  private readonly formatCeiling: number;

  constructor(storage: StorageLike, gameId: string, formatCeiling: number) {
    this.storage = storage;
    this.gameId = gameId;
    this.formatCeiling = formatCeiling;
  }

  private keyFor(slot: number): string {
    return `${PREFIX}.${this.gameId}.${slot}`;
  }

  private metaKey(): string {
    return `${PREFIX}.${this.gameId}.${META_SUFFIX}`;
  }

  /**
   * Records what this game is called, so a menu can name it later.
   *
   * Written on every save rather than once, because the title can improve: a
   * game first opened as loose files knows only its id, and the same game
   * opened later from a folder with a README knows the release's real name.
   * Last write wins, which is the more informative one in practice.
   *
   * Swallows a storage failure. A title is a nicety and the save beside it is
   * not; failing the save because its label could not be written would be the
   * wrong half to lose.
   */
  writeMeta(meta: SaveMeta): void {
    try {
      this.storage.setItem(this.metaKey(), JSON.stringify(meta));
    } catch {
      // Deliberately ignored — see above.
    }
  }

  /** What this game is called, or null when nothing was ever recorded. */
  readMeta(): SaveMeta | null {
    return parseMeta(this.storage.getItem(this.metaKey()));
  }

  /**
   * Writes a save, or throws with something a player can act on.
   *
   * Storage failures are not hypothetical: a browser with site data disabled
   * throws on write, and a full quota throws mid-game. Both look identical from
   * here, and both need saying out loud rather than silently losing the save.
   */
  write(slot: number, saved: T): void {
    // Refused here rather than in the dialog: a slot outside the board is a
    // save the player can write and never see again, because nothing lists it.
    if (!isSaveSlot(slot)) {
      throw new Error(`There is no slot ${slot}. Slots are numbered 1 to ${SAVE_SLOTS}.`);
    }
    try {
      this.storage.setItem(this.keyFor(slot), JSON.stringify(saved));
    } catch (error) {
      throw new Error(
        `The save could not be written. The browser may have storage disabled, ` +
          `or be out of space for this site. (${error instanceof Error ? error.message : error})`,
        { cause: error },
      );
    }
  }

  /**
   * Reads a save back, or null when the slot is empty.
   *
   * Unparseable content is treated as an empty slot rather than an error: a
   * corrupt entry is not something the player can fix, and refusing to open the
   * menu because one slot is damaged loses the other slots too.
   */
  read(slot: number): T | null {
    const raw = this.storage.getItem(this.keyFor(slot));
    if (raw === null) return null;
    return parseSave<T>(raw, this.formatCeiling);
  }

  remove(slot: number): void {
    this.storage.removeItem(this.keyFor(slot));
  }

  /** Every save for this game, newest first, for a load menu. */
  list(): SaveSummary[] {
    const prefix = `${PREFIX}.${this.gameId}.`;
    const summaries: SaveSummary[] = [];

    for (let i = 0; i < this.storage.length; i++) {
      const key = this.storage.key(i);
      if (!key || !key.startsWith(prefix)) continue;

      const slot = Number(key.slice(prefix.length));
      if (!Number.isInteger(slot)) continue;

      const raw = this.storage.getItem(key);
      const saved = raw === null ? null : parseSave<T>(raw, this.formatCeiling);
      if (!saved) continue;

      summaries.push({ slot, name: saved.name, savedAt: saved.savedAt, room: saved.room });
    }

    return summaries.sort((a, b) => b.savedAt - a.savedAt);
  }
}

/**
 * What to tell the player about where their saves live.
 *
 * Worth saying plainly, because both halves surprise people: these saves are
 * not interchangeable with ScummVM's (ADR 0002), and they live in this
 * browser's storage rather than in a file, so clearing site data takes them
 * with it.
 */
export const SAVE_LOCATION_NOTE =
  'Saves are kept in this browser, for this game, and are specific to this ' +
  'interpreter — ScummVM cannot read them and they are not saved to a file. ' +
  'Clearing this site’s data will delete them.';

function parseSave<T extends SavedGameEnvelope>(raw: string, ceiling: number): T | null {
  try {
    const parsed = JSON.parse(raw) as T;
    // A newer version's save is not readable here, and pretending otherwise
    // would hand the engine something it would only refuse later, further from
    // the cause.
    if (typeof parsed?.format !== 'number' || parsed.format > ceiling) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseMeta(raw: string | null): SaveMeta | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SaveMeta;
    // A title is the whole point of the record, so one without a usable title
    // is no better than no record at all.
    if (typeof parsed?.title !== 'string' || parsed.title.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Splits a storage key into the game it belongs to and what it holds.
 *
 * Parsed from the right, because the game id is the part that may contain a
 * dot and the suffix never does. Reading left to right — the way `list()` does
 * for a single game, where the id is already known — would cut `monkey.cd` in
 * half at the first separator and file its saves under a game called `monkey`.
 */
function splitKey(key: string): { gameId: string; suffix: string } | null {
  if (!key.startsWith(`${PREFIX}.`)) return null;
  const rest = key.slice(PREFIX.length + 1);
  const cut = rest.lastIndexOf('.');
  if (cut <= 0 || cut === rest.length - 1) return null;
  return { gameId: rest.slice(0, cut), suffix: rest.slice(cut + 1) };
}

/**
 * Every game this browser holds saves for, for the Load menu.
 *
 * Across games, which is the one thing `SaveStore` deliberately will not do:
 * an instance is one game's saves and refusing to see another's is what stops a
 * save being restored into the wrong engine. This is the other question — "what
 * have I got?" — and it is asked before any game is loaded, so there is no
 * store to ask and no format ceiling to check against.
 *
 * **No ceiling check here, on purpose.** A ceiling is a family's number and
 * this listing spans families; a save from a newer build is therefore listed
 * and refused at the point it is opened, by the store that knows which number
 * applies. Hiding it instead would answer "where did my saves go?" with
 * silence, which is the worse of the two failures.
 *
 * Games are ordered by their most recent save, so the one you were last playing
 * is the one at the top.
 */
export function listSavedGames(storage: StorageLike): SavedGameSummary[] {
  const games = new Map<string, SavedGameSummary>();
  const metas = new Map<string, SaveMeta>();

  const of = (gameId: string): SavedGameSummary => {
    let game = games.get(gameId);
    if (!game) {
      game = { gameId, title: gameId, saves: [] };
      games.set(gameId, game);
    }
    return game;
  };

  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key) continue;
    const parts = splitKey(key);
    if (!parts) continue;

    if (parts.suffix === META_SUFFIX) {
      const meta = parseMeta(storage.getItem(key));
      if (meta) metas.set(parts.gameId, meta);
      continue;
    }

    const slot = Number(parts.suffix);
    if (!isSaveSlot(slot)) continue;

    const raw = storage.getItem(key);
    const saved = raw === null ? null : parseAnySave(raw);
    if (!saved) continue;

    of(parts.gameId).saves.push({
      slot,
      name: saved.name,
      savedAt: saved.savedAt,
      room: saved.room,
    });
  }

  // Applied after the sweep rather than during it, because a meta record can be
  // read before or after the saves it describes depending on key order, and a
  // title that only lands when it happens to come first is a title that comes
  // and goes between reloads.
  for (const [gameId, meta] of metas) {
    // A meta with no saves left beside it names nothing — the saves were
    // deleted and the label outlived them.
    const game = games.get(gameId);
    if (!game) continue;
    game.title = meta.title;
    if (meta.targetName !== undefined) game.targetName = meta.targetName;
    if (meta.sourceId !== undefined) game.sourceId = meta.sourceId;
  }

  for (const game of games.values()) game.saves.sort((a, b) => b.savedAt - a.savedAt);

  return [...games.values()].sort((a, b) => newest(b) - newest(a));
}

function newest(game: SavedGameSummary): number {
  return game.saves.reduce((latest, save) => Math.max(latest, save.savedAt), 0);
}

/**
 * Reads an envelope without judging its format number.
 *
 * The cross-game listing has no ceiling to judge against — see
 * `listSavedGames`. What is still checked is that the thing parses and carries
 * the envelope's fields, so a menu row is never built from a fragment.
 */
function parseAnySave(raw: string): SavedGameEnvelope | null {
  try {
    const parsed = JSON.parse(raw) as SavedGameEnvelope;
    if (typeof parsed?.format !== 'number') return null;
    if (typeof parsed.name !== 'string' || typeof parsed.savedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
