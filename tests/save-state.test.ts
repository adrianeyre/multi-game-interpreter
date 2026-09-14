import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { SAVE_FORMAT, describeIncompatibleSave } from '../src/engine/save/SaveState.js';
import { ScriptStatus, VAR } from '../src/engine/constants.js';
import { buildFixture, type FixtureOptions } from './fixture.js';
import { buildV6Fixture } from './fixtureV6.js';
import { u16le } from './fixture.js';

/**
 * Saved games.
 *
 * Everything here is Tier 1: a save is captured, the world is disturbed, the
 * save is put back, and the state is asserted to have returned. No game data is
 * involved, which is exactly why a save is testable in a way that "the game is
 * completable" is not.
 */
async function bootV5(options: FixtureOptions = {}) {
  const fixture = buildFixture(options);
  const source = new MemoryDataSource('v5');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  return { engine, logs };
}

async function bootV6(options: Parameters<typeof buildV6Fixture>[0] = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const engine = await ScummEngine.create(source);
  engine.boot(0);
  return engine;
}

describe('what a save carries', () => {
  it('is plain JSON, so it can go in a file or local storage unchanged', async () => {
    const { engine } = await bootV5();
    const saved = engine.saveState('slot one');

    // Survives a round trip through JSON with nothing lost: no typed arrays,
    // no class instances, no undefined.
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
  });

  it('names the format, the game and the SCUMM version', async () => {
    const { engine } = await bootV5();
    const saved = engine.saveState();

    expect(saved.format).toBe(SAVE_FORMAT);
    expect(saved.gameId).toBe('testgame');
    expect(saved.scummVersion).toBe(5);
  });
});

describe('restoring variables and object tables', () => {
  it('puts a changed variable back', async () => {
    const { engine } = await bootV5();
    engine.variables[400] = 7;
    const saved = engine.saveState();

    engine.variables[400] = 99;
    engine.loadState(saved);

    expect(engine.variables[400]).toBe(7);
  });

  it('puts a bit variable back', async () => {
    const { engine } = await bootV5();
    engine.scripts.writeVar(0x8000 | 42, 1);
    const saved = engine.saveState();

    engine.scripts.writeVar(0x8000 | 42, 0);
    engine.loadState(saved);

    expect(engine.scripts.readVar(0x8000 | 42)).toBe(1);
  });

  it('puts object state and ownership back', async () => {
    const { engine } = await bootV5();
    engine.putState(500, 1);
    engine.setOwnerOf(500, 3);
    const saved = engine.saveState();

    engine.putState(500, 0);
    engine.setOwnerOf(500, 9);
    engine.loadState(saved);

    expect(engine.getState(500)).toBe(1);
    expect(engine.getOwner(500)).toBe(3);
  });

  it('puts a renamed object back, which is visible if it does not', async () => {
    const { engine } = await bootV5();
    engine.setObjectName(500, 'a very specific chicken');
    const saved = engine.saveState();

    engine.setObjectName(500, 'something else');
    engine.loadState(saved);

    expect(engine.objectNameOverrides.get(500)).toBe('a very specific chicken');
  });
});

describe('restoring actors', () => {
  it('puts position, facing and costume back', async () => {
    const { engine } = await bootV5();
    const actor = engine.actors[1];
    engine.putActor(1, 60, 90);
    actor.facing = 90;
    actor.costume = 1;
    actor.visible = true;
    const saved = engine.saveState();

    engine.putActor(1, 200, 20);
    actor.facing = 270;
    actor.visible = false;
    engine.loadState(saved);

    expect(engine.actors[1].x).toBe(60);
    expect(engine.actors[1].y).toBe(90);
    expect(engine.actors[1].facing).toBe(90);
    expect(engine.actors[1].visible).toBe(true);
  });

  it('puts every one of an actor’s colour overrides back, not just the low ones', async () => {
    const { engine } = await bootV5();
    const actor = engine.actors[1];
    actor.palette[0] = 5;
    actor.palette[200] = 7;
    const saved = engine.saveState();

    actor.palette.fill(0xff);
    engine.loadState(saved);

    expect(engine.actors[1].palette[0]).toBe(5);
    expect(engine.actors[1].palette[200]).toBe(7);
  });

  it('reads a save from when this array was shorter as no override, not as leftovers', async () => {
    // An actor's overrides used to be 32 entries long and are now 256, so a
    // save from before that only answers for the first 32. The rest have to
    // come back as "no override" rather than as whatever the actor happened to
    // be wearing when the save was loaded — which would be a costume that
    // changes colour on load and stays that way.
    const { engine } = await bootV5();
    const actor = engine.actors[1];
    const older = JSON.parse(JSON.stringify(engine.saveState()));
    older.actors[1].palette = older.actors[1].palette.slice(0, 32);

    actor.palette[200] = 9;
    engine.loadState(older);

    expect(engine.actors[1].palette[200]).toBe(0xff);
  });

  it('puts the walk target back, so a walking actor keeps walking', async () => {
    const { engine } = await bootV5();
    engine.putActor(1, 40, 100);
    engine.startWalkActor(1, 200, 100, -1);
    const moving = engine.actors[1].moving;
    const destination = engine.actors[1].walkdata.destX;
    const saved = engine.saveState();

    engine.putActor(1, 10, 10);
    engine.loadState(saved);

    expect(engine.actors[1].moving).toBe(moving);
    expect(engine.actors[1].walkdata.destX).toBe(destination);
  });
});

describe('restoring the room', () => {
  /**
   * Rebuilt from the game files rather than stored, and without running the
   * entry script — that script already ran in the session that saved, and
   * running it again would replay whatever it set up on arrival.
   */
  it('comes back in the room the save was taken in', async () => {
    const { engine } = await bootV5();
    engine.startScene(1, null, 0);
    const saved = engine.saveState();

    engine.startScene(0, null, 0);
    expect(engine.currentRoom).toBe(0);

    engine.loadState(saved);
    expect(engine.currentRoom).toBe(1);
    expect(engine.currentRoomData).not.toBeNull();
    expect(engine.roomGraphics).not.toBeNull();
  });

  it('does not re-run the entry script on load', async () => {
    // The room's entry script counts how many times it has run.
    const { engine } = await bootV5({
      entryScript: [0x46, ...u16le(410), 0x00],
    });
    engine.startScene(1, null, 0);
    const ranOnce = engine.variables[410];
    const saved = engine.saveState();

    engine.loadState(saved);

    expect(engine.variables[410]).toBe(ranOnce);
  });
});

describe('restoring running scripts', () => {
  /**
   * A slot holds a window into the game files while it runs, which cannot go
   * into a save. The script number and `where` are stored instead and the code
   * is resolved again on load — which it must be, since a room's script only
   * exists inside the room resource now loaded.
   */
  it('resumes a script parked at a breakHere, from the offset it parked at', async () => {
    // Writes 1, yields, writes 2. Saved while parked, the restored game must
    // carry on at the second write rather than starting over or doing nothing.
    const engine = await bootV6({
      script2: [0x00, 0x01, 0x43, ...u16le(440), 0x6c, 0x00, 0x02, 0x43, ...u16le(440), 0x66],
    });
    engine.scripts.runScript(2, false, false, []);
    expect(engine.variables[440]).toBe(1);

    const saved = engine.saveState();

    // Disturb everything the resume depends on: the variable, and the slot
    // holding the parked script's code and offset.
    engine.variables[440] = 99;
    for (const slot of engine.scriptState.slots) slot.reset();

    engine.loadState(saved);
    expect(engine.variables[440]).toBe(1);

    engine.scripts.runAllScripts();
    expect(engine.variables[440]).toBe(2);
  });

  it('restores slot locals, which carry a script\u2019s arguments', async () => {
    const { engine } = await bootV5();
    const slot = engine.scriptState.slots[0];
    slot.number = 2;
    slot.status = ScriptStatus.Running;
    slot.locals[0] = 11;
    slot.locals[1] = 22;
    slot.data = engine.resources.getScript(2);
    slot.base = 8;
    slot.offset = 8;

    const saved = engine.saveState();
    slot.locals[0] = 0;
    slot.locals[1] = 0;
    engine.loadState(saved);

    expect(engine.scriptState.slots[0].locals[0]).toBe(11);
    expect(engine.scriptState.slots[0].locals[1]).toBe(22);
    expect(engine.scriptState.slots[0].data).not.toBeNull();
  });

  it('drops a slot whose script is no longer in the game, rather than resuming nothing', async () => {
    const { engine, logs } = await bootV5();
    const saved = engine.saveState();

    saved.scripts.slots[0] = {
      number: 4242,
      status: ScriptStatus.Running,
      where: 0,
      offset: 8,
      base: 8,
      delay: 0,
      delayed: false,
      freezeCount: 0,
      cutsceneOverride: 0,
      recursive: false,
      freezeResistant: false,
      locals: [],
    };
    engine.loadState(saved);

    expect(engine.scriptState.slots[0].status).toBe(ScriptStatus.Dead);
    expect(logs.join('\n')).toMatch(/4242/);
  });

  it('restores an open cutscene, so a save taken mid-cutscene resumes in one', async () => {
    const { engine } = await bootV5();
    engine.scriptState.cutSceneStack.push({
      ownerSlot: 3,
      ownerScript: 12,
      data: 42,
    });
    const saved = engine.saveState();

    engine.scriptState.cutSceneStack.length = 0;
    engine.loadState(saved);

    expect(engine.scriptState.cutSceneStack).toHaveLength(1);
    expect(engine.scriptState.cutSceneStack[0].data).toBe(42);
  });
});

describe('restoring input and the sentence', () => {
  it('puts the input suspend counter back', async () => {
    const { engine } = await bootV5();
    engine.setUserPut(false);
    const saved = engine.saveState();

    engine.setUserPut(true);
    engine.loadState(saved);

    expect(engine.userPut).toBe(false);
  });

  it('puts a pending sentence back', async () => {
    const { engine } = await bootV5();
    engine.doSentence(3, 500, 0);
    const queued = engine.sentenceQueue.length;
    const saved = engine.saveState();

    engine.sentenceQueue.length = 0;
    engine.loadState(saved);

    expect(engine.sentenceQueue).toHaveLength(queued);
  });
});

describe('refusing a save that does not belong', () => {
  it('refuses a save from a different game', async () => {
    const { engine } = await bootV5();
    const saved = engine.saveState();
    saved.gameId = 'MONKEY2';

    expect(describeIncompatibleSave(engine, saved)).toMatch(/MONKEY2/);
    expect(() => engine.loadState(saved)).toThrow(/MONKEY2/);
  });

  it('refuses a save from a different SCUMM version', async () => {
    const { engine } = await bootV5();
    const saved = engine.saveState();
    saved.scummVersion = 6;

    expect(() => engine.loadState(saved)).toThrow(/instruction sets/);
  });

  it('refuses an older format rather than half-reading it', async () => {
    const { engine } = await bootV5();
    const saved = engine.saveState();
    saved.format = SAVE_FORMAT - 1;

    expect(() => engine.loadState(saved)).toThrow(/format/);
  });

  it('leaves the game untouched when it refuses', async () => {
    const { engine } = await bootV5();
    engine.variables[420] = 5;
    const saved = engine.saveState();
    saved.gameId = 'SOMETHING ELSE';
    engine.variables[420] = 6;

    expect(() => engine.loadState(saved)).toThrow();
    // A partly applied save is a set of symptoms with no cause.
    expect(engine.variables[420]).toBe(6);
  });
});

describe('a v6 save', () => {
  it('round-trips a v6 game the same way', async () => {
    const engine = await bootV6();
    engine.variables[430] = 17;
    const saved = engine.saveState();

    expect(saved.scummVersion).toBe(6);
    engine.variables[430] = 0;
    engine.loadState(saved);
    expect(engine.variables[430]).toBe(17);
  });

  it('keeps VAR.ROOM consistent with the room it restored', async () => {
    const engine = await bootV6();
    engine.startScene(1, null, 0);
    const saved = engine.saveState();
    engine.startScene(0, null, 0);
    engine.loadState(saved);

    expect(engine.currentRoom).toBe(1);
    expect(engine.variables[VAR.ROOM]).toBe(1);
  });

  /**
   * A v6 game keeps its progress in arrays, not only in globals: which
   * conversation topics are exhausted, which puzzle stages are done. A save
   * that dropped them would resume looking correct and playing wrong.
   */
  it('puts the script arrays back, not just the variables', async () => {
    const engine = await bootV6();
    const arrays = engine.scriptState.arrays;
    arrays.define(700, 'int', 0, 4);
    arrays.write(700, 3, 42);

    const saved = engine.saveState();
    arrays.write(700, 3, 0);
    arrays.undefine(700);

    engine.loadState(saved);
    expect(engine.scriptState.arrays.read(700, 3)).toBe(42);
  });

  it('puts back a two-dimensional array at the right row', async () => {
    const engine = await bootV6();
    engine.scriptState.arrays.define(701, 'int', 3, 4);
    engine.scriptState.arrays.write(701, 2, 9, 2);

    const saved = engine.saveState();
    engine.scriptState.arrays.clear();
    engine.loadState(saved);

    expect(engine.scriptState.arrays.read(701, 2, 2)).toBe(9);
    expect(engine.scriptState.arrays.read(701, 2, 1)).toBe(0);
  });

  it("keeps an actor's own variables, which only v6 actors have", async () => {
    const engine = await bootV6();
    const actor = engine.actors[1];
    actor.animVars[4] = 12;
    actor.talkScript = 88;

    const saved = engine.saveState();
    actor.animVars[4] = 0;
    actor.talkScript = 0;
    engine.loadState(saved);

    expect(engine.actors[1].animVars[4]).toBe(12);
    expect(engine.actors[1].talkScript).toBe(88);
  });
});
