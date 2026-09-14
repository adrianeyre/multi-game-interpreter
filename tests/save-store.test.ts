import { describe, expect, it } from 'vitest';
import {
  SaveStore,
  SAVE_LOCATION_NOTE,
  SAVE_SLOTS,
  isSaveSlot,
  listSavedGames,
  type StorageLike,
} from '../src/engine/save/SaveStore.js';
import { SAVE_FORMAT, type SavedGame } from '../src/engine/save/SaveState.js';

/** The browser's key/value store, in memory, so the failure cases are testable. */
class MemoryStorage implements StorageLike {
  private readonly entries = new Map<string, string>();
  /** Set to make every write throw, as a full or disabled store does. */
  failWrites = false;

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error('quota exceeded');
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  get length(): number {
    return this.entries.size;
  }
}

function save(overrides: Partial<SavedGame> = {}): SavedGame {
  return {
    format: SAVE_FORMAT,
    scummVersion: 6,
    gameId: 'tentacle',
    languageBundle: null,
    musicState: null,
    savedAt: 1000,
    name: 'outside the mansion',
    room: 1,
    variables: [],
    bitVariables: [],
    objectState: [],
    objectOwner: [],
    objectClass: [],
    objectNames: [],
    inventory: [],
    strings: [],
    camera: {
      current: 160,
      destination: 160,
      min: 160,
      max: 160,
      currentY: 0,
      destinationY: 0,
      minY: 0,
      maxY: 0,
      following: 0,
      moving: false,
    },
    cursorState: 1,
    userPutCount: 1,
    currentCursor: 0,
    currentCharsetId: 0,
    sentenceQueue: [],
    sentenceFrozen: 0,
    actors: [],
    scriptArrays: [],
    scripts: { currentSlot: -1, startingCutsceneSlot: -1, cutSceneStack: [], slots: [] },
    ...overrides,
  };
}

describe('keeping saves between sessions', () => {
  it('reads back what it wrote', () => {
    const store = new SaveStore(new MemoryStorage(), 'tentacle', SAVE_FORMAT);
    store.write(1, save({ name: 'in the attic' }));

    expect(store.read(1)?.name).toBe('in the attic');
  });

  it('treats an empty slot as empty rather than an error', () => {
    const store = new SaveStore(new MemoryStorage(), 'tentacle', SAVE_FORMAT);
    expect(store.read(3)).toBeNull();
  });

  it('removes a save', () => {
    const store = new SaveStore(new MemoryStorage(), 'tentacle', SAVE_FORMAT);
    store.write(1, save());
    store.remove(1);

    expect(store.read(1)).toBeNull();
  });
});

describe('keeping games apart', () => {
  /**
   * A save's numbers only mean anything in the game that wrote them, so listing
   * another game's saves here invites the mistake the loader then has to refuse.
   */
  it('does not list another game’s saves', () => {
    const storage = new MemoryStorage();
    new SaveStore(storage, 'tentacle', SAVE_FORMAT).write(1, save({ gameId: 'tentacle' }));
    new SaveStore(storage, 'samnmax', SAVE_FORMAT).write(1, save({ gameId: 'samnmax' }));

    expect(new SaveStore(storage, 'tentacle', SAVE_FORMAT).list()).toHaveLength(1);
    expect(new SaveStore(storage, 'samnmax', SAVE_FORMAT).list()).toHaveLength(1);
  });

  it('does not read another game’s slot', () => {
    const storage = new MemoryStorage();
    new SaveStore(storage, 'samnmax', SAVE_FORMAT).write(1, save({ gameId: 'samnmax' }));

    expect(new SaveStore(storage, 'tentacle', SAVE_FORMAT).read(1)).toBeNull();
  });
});

describe('listing saves for a menu', () => {
  it('returns newest first', () => {
    const store = new SaveStore(new MemoryStorage(), 'tentacle', SAVE_FORMAT);
    store.write(1, save({ savedAt: 1000, name: 'older' }));
    store.write(2, save({ savedAt: 5000, name: 'newer' }));

    expect(store.list().map((entry) => entry.name)).toEqual(['newer', 'older']);
  });

  it('carries enough to choose by without the state', () => {
    const store = new SaveStore(new MemoryStorage(), 'tentacle', SAVE_FORMAT);
    store.write(4, save({ name: 'the chron-o-john', room: 12, savedAt: 77 }));

    expect(store.list()).toEqual([{ slot: 4, name: 'the chron-o-john', room: 12, savedAt: 77 }]);
  });
});

describe('when storage will not cooperate', () => {
  /**
   * Not hypothetical: a browser with site data disabled throws on write, and a
   * full quota throws mid-game. Silently losing the save is the one response a
   * player cannot recover from.
   */
  it('says a write failed, and why it might have', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const store = new SaveStore(storage, 'tentacle', SAVE_FORMAT);

    expect(() => store.write(1, save())).toThrow(/storage disabled|out of space/);
  });

  it('treats a corrupt entry as an empty slot rather than breaking the menu', () => {
    const storage = new MemoryStorage();
    storage.setItem('scumm.save.tentacle.1', 'not json at all');
    storage.setItem('scumm.save.tentacle.2', JSON.stringify(save({ name: 'fine' })));
    const store = new SaveStore(storage, 'tentacle', SAVE_FORMAT);

    expect(store.read(1)).toBeNull();
    // The damaged slot must not take the healthy ones with it.
    expect(store.list().map((entry) => entry.name)).toEqual(['fine']);
  });

  it('ignores a save written by a newer version', () => {
    const storage = new MemoryStorage();
    storage.setItem('scumm.save.tentacle.1', JSON.stringify(save({ format: SAVE_FORMAT + 1 })));

    expect(new SaveStore(storage, 'tentacle', SAVE_FORMAT).read(1)).toBeNull();
  });
});

describe('telling the player where their saves are', () => {
  it('says both surprising parts: not ScummVM’s, and not a file', () => {
    expect(SAVE_LOCATION_NOTE).toMatch(/ScummVM cannot read them/);
    expect(SAVE_LOCATION_NOTE).toMatch(/not saved to a file/);
    expect(SAVE_LOCATION_NOTE).toMatch(/data will delete them/);
  });
});

describe('the board of slots', () => {
  it('is ten, which is what a menu can show all of at once', () => {
    expect(SAVE_SLOTS).toBe(10);
    expect(isSaveSlot(1)).toBe(true);
    expect(isSaveSlot(10)).toBe(true);
  });

  /**
   * A slot outside the board is a save the player can write and never see
   * again, because nothing lists it. Refused by the store rather than by the
   * dialog: a dialog is one caller and `write` is reachable without one.
   */
  it('refuses a slot the menu could never show', () => {
    const store = new SaveStore(new MemoryStorage(), 'tentacle', SAVE_FORMAT);

    expect(() => store.write(0, save())).toThrow(/no slot 0/);
    expect(() => store.write(11, save())).toThrow(/Slots are numbered 1 to 10/);
    expect(() => store.write(1.5, save())).toThrow(/no slot/);
  });
});

describe('naming a game for a menu that has not loaded it', () => {
  /**
   * A `gameId` is `monkey2`, which is an identifier and not a title — and the
   * Load menu has to name games the player has not opened this visit, with no
   * engine in hand to ask.
   */
  it('keeps a title beside the saves and reads it back', () => {
    const storage = new MemoryStorage();
    const store = new SaveStore(storage, 'monkey2', SAVE_FORMAT);
    store.writeMeta({ title: 'Monkey Island 2', targetName: 'SCUMM v5', sourceId: 'monkey2-cd' });

    expect(store.readMeta()).toEqual({
      title: 'Monkey Island 2',
      targetName: 'SCUMM v5',
      sourceId: 'monkey2-cd',
    });
  });

  it('has no title until one is written', () => {
    expect(new SaveStore(new MemoryStorage(), 'monkey2', SAVE_FORMAT).readMeta()).toBeNull();
  });

  /** A record with no usable title names nothing, so it is no record at all. */
  it('ignores a damaged or empty title record', () => {
    const storage = new MemoryStorage();
    storage.setItem('scumm.save.monkey2.meta', 'not json');
    expect(new SaveStore(storage, 'monkey2', SAVE_FORMAT).readMeta()).toBeNull();

    storage.setItem('scumm.save.monkey2.meta', JSON.stringify({ title: '' }));
    expect(new SaveStore(storage, 'monkey2', SAVE_FORMAT).readMeta()).toBeNull();
  });

  /**
   * The record sits in the same namespace as the saves it describes, which is
   * only safe because every slot listing parses the last segment as an integer
   * and skips what is not one.
   */
  it('is never mistaken for a save', () => {
    const storage = new MemoryStorage();
    const store = new SaveStore(storage, 'monkey2', SAVE_FORMAT);
    store.write(1, save({ gameId: 'monkey2', name: 'the boat' }));
    store.writeMeta({ title: 'Monkey Island 2' });

    expect(store.list().map((entry) => entry.name)).toEqual(['the boat']);
  });

  /**
   * A title is a nicety and the save beside it is not. Failing the save because
   * its label could not be written would lose the wrong half.
   */
  it('does not fail a save when the title cannot be written', () => {
    const storage = new MemoryStorage();
    const store = new SaveStore(storage, 'monkey2', SAVE_FORMAT);
    storage.failWrites = true;

    expect(() => store.writeMeta({ title: 'Monkey Island 2' })).not.toThrow();
  });
});

describe('every game this browser holds saves for', () => {
  it('is empty when nothing has been saved', () => {
    expect(listSavedGames(new MemoryStorage())).toEqual([]);
  });

  it('groups saves under the game that wrote them', () => {
    const storage = new MemoryStorage();
    new SaveStore(storage, 'tentacle', SAVE_FORMAT).write(1, save({ gameId: 'tentacle' }));
    new SaveStore(storage, 'tentacle', SAVE_FORMAT).write(2, save({ gameId: 'tentacle' }));
    new SaveStore(storage, 'samnmax', SAVE_FORMAT).write(1, save({ gameId: 'samnmax' }));

    const games = listSavedGames(storage);
    expect(games.map((game) => game.gameId).sort()).toEqual(['samnmax', 'tentacle']);
    expect(games.find((game) => game.gameId === 'tentacle')!.saves).toHaveLength(2);
  });

  it('names a game from its title record, and falls back to the id', () => {
    const storage = new MemoryStorage();
    new SaveStore(storage, 'monkey2', SAVE_FORMAT).write(1, save({ gameId: 'monkey2' }));
    new SaveStore(storage, 'monkey2', SAVE_FORMAT).writeMeta({
      title: 'Monkey Island 2',
      targetName: 'SCUMM v5',
      sourceId: 'monkey2-cd',
    });
    new SaveStore(storage, 'tentacle', SAVE_FORMAT).write(1, save({ gameId: 'tentacle' }));

    const games = listSavedGames(storage);
    const monkey = games.find((game) => game.gameId === 'monkey2')!;
    expect(monkey.title).toBe('Monkey Island 2');
    expect(monkey.targetName).toBe('SCUMM v5');
    expect(monkey.sourceId).toBe('monkey2-cd');
    expect(games.find((game) => game.gameId === 'tentacle')!.title).toBe('tentacle');
  });

  /** The game you were last playing is the one you are most likely to want. */
  it('puts the most recently saved game first, and its newest save first', () => {
    const storage = new MemoryStorage();
    new SaveStore(storage, 'tentacle', SAVE_FORMAT).write(
      1,
      save({ gameId: 'tentacle', savedAt: 100, name: 'old' }),
    );
    new SaveStore(storage, 'samnmax', SAVE_FORMAT).write(
      1,
      save({ gameId: 'samnmax', savedAt: 500, name: 'older' }),
    );
    new SaveStore(storage, 'samnmax', SAVE_FORMAT).write(
      2,
      save({ gameId: 'samnmax', savedAt: 900, name: 'newest' }),
    );

    const games = listSavedGames(storage);
    expect(games.map((game) => game.gameId)).toEqual(['samnmax', 'tentacle']);
    expect(games[0].saves.map((entry) => entry.name)).toEqual(['newest', 'older']);
  });

  /**
   * Parsed from the right, because a game id may contain a dot and the suffix
   * never does. Left to right would file `monkey.cd`'s saves under `monkey`.
   */
  it('keeps a game whose id contains a dot in one piece', () => {
    const storage = new MemoryStorage();
    new SaveStore(storage, 'monkey.cd', SAVE_FORMAT).write(3, save({ gameId: 'monkey.cd' }));
    new SaveStore(storage, 'monkey.cd', SAVE_FORMAT).writeMeta({ title: 'Monkey Island (CD)' });

    const games = listSavedGames(storage);
    expect(games).toHaveLength(1);
    expect(games[0].gameId).toBe('monkey.cd');
    expect(games[0].title).toBe('Monkey Island (CD)');
    expect(games[0].saves.map((entry) => entry.slot)).toEqual([3]);
  });

  it('ignores keys that are not ours, and entries that will not parse', () => {
    const storage = new MemoryStorage();
    storage.setItem('unrelated.key', 'whatever');
    storage.setItem('scumm.save.tentacle.2', 'not json at all');
    storage.setItem('scumm.save.tentacle.99', JSON.stringify(save({ gameId: 'tentacle' })));
    new SaveStore(storage, 'tentacle', SAVE_FORMAT).write(1, save({ gameId: 'tentacle' }));

    const games = listSavedGames(storage);
    expect(games).toHaveLength(1);
    // Slot 99 is off the board and slot 2 is damaged; only slot 1 is real.
    expect(games[0].saves.map((entry) => entry.slot)).toEqual([1]);
  });

  /**
   * A ceiling is a family's number and this listing spans families, so a save
   * from a newer build is listed here and refused at the point it is opened.
   * Hiding it instead answers "where did my saves go?" with silence.
   */
  it('lists a save from a newer build rather than hiding it', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      'scumm.save.tentacle.1',
      JSON.stringify(
        save({ gameId: 'tentacle', format: SAVE_FORMAT + 1, name: 'from the future' }),
      ),
    );

    expect(listSavedGames(storage)[0].saves.map((entry) => entry.name)).toEqual([
      'from the future',
    ]);
    // And the store that knows the ceiling is still the one that refuses it.
    expect(new SaveStore(storage, 'tentacle', SAVE_FORMAT).read(1)).toBeNull();
  });

  /** A label that outlived the saves it described names nothing. */
  it('does not list a game whose saves have all been deleted', () => {
    const storage = new MemoryStorage();
    const store = new SaveStore(storage, 'tentacle', SAVE_FORMAT);
    store.write(1, save({ gameId: 'tentacle' }));
    store.writeMeta({ title: 'Day of the Tentacle' });
    store.remove(1);

    expect(listSavedGames(storage)).toEqual([]);
  });
});
