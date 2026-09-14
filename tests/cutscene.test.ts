import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ObjectWhere, ScriptStatus, VAR } from '../src/engine/constants.js';
import { MAX_CUTSCENE_DEPTH } from '../src/engine/script/ScriptState.js';
import { Assembler } from '../src/authoring/Assembler.js';
import { global } from '../src/authoring/values.js';
import { buildFixture, type FixtureOptions } from './fixture.js';

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** `VAR[200] = LOCAL[0]`, so a script can report the argument it was given. */
const reportFirstArgument = [0x9a, ...u16(200), ...u16(0x4000), 0x00];

async function makeEngine(
  options: FixtureOptions = {},
  messages: string[] = [],
): Promise<ScummEngine> {
  const fixture = buildFixture(options);
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return ScummEngine.create(source, { onLog: (message) => messages.push(message) });
}

/**
 * Stands a script slot up as if it were mid-execution.
 *
 * Cutscenes are opened by whichever script is running, so every assertion here
 * needs an owner; driving one in through bytecode would say nothing extra.
 */
function occupySlot(
  engine: ScummEngine,
  index: number,
  script: number,
  where = ObjectWhere.Global,
) {
  const slot = engine.scriptState.slots[index];
  slot.reset();
  slot.number = script;
  slot.status = ScriptStatus.Running;
  slot.where = where;
  engine.scriptState.currentSlot = index;
  return slot;
}

describe('cutscene bookkeeping', () => {
  it('keeps the cutscene argument when an override is armed', async () => {
    const engine = await makeEngine({ script2: reportFirstArgument });
    engine.boot(0);
    engine.variables[VAR.CUTSCENE_END_SCRIPT] = 2;

    const slot = occupySlot(engine, 0, 99);
    engine.beginCutscene([7]);
    // Arming a skip point used to share storage with the argument above.
    engine.beginOverride(0, 1234);
    engine.scriptState.currentSlot = 0;
    engine.endCutscene();

    expect(engine.variables[200]).toBe(7);
    expect(slot.cutsceneOverride).toBe(0);
  });

  it('records the script that opened each level rather than a constant', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    occupySlot(engine, 0, 88);
    engine.beginCutscene([0]);
    occupySlot(engine, 1, 77);
    engine.beginCutscene([0]);

    expect(engine.scriptState.cutSceneStack.map((level) => level.ownerScript)).toEqual([88, 77]);
  });

  it('remembers the skip point separately from the cutscene argument', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    occupySlot(engine, 0, 99);
    engine.beginCutscene([42]);
    engine.beginOverride(0, 5150);

    const [level] = engine.scriptState.cutSceneStack;
    expect(level.data).toBe(42);
    expect(engine.scriptState.currentOverride).toEqual({ slot: 0, pointer: 5150 });

    engine.endOverride();
    expect(engine.scriptState.cutSceneStack[0].data).toBe(42);
    expect(engine.scriptState.currentOverride.pointer).toBe(-1);
  });

  it('keeps a skip point armed with no cutscene open', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    occupySlot(engine, 0, 99);
    // Day of the Tentacle's driver script arms one for the whole intro without
    // ever opening a cutscene.
    engine.beginOverride(0, 4270);

    expect(engine.scriptState.cutSceneStack).toHaveLength(0);
    expect(engine.scriptState.currentOverride).toEqual({ slot: 0, pointer: 4270 });
  });

  it('resumes the armed script at its skip point when the player skips', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    const slot = occupySlot(engine, 0, 99);
    engine.beginCutscene([0]);
    engine.beginOverride(0, 5150);
    slot.offset = 900;
    slot.freezeCount = 3;

    engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY]);

    expect(slot.offset).toBe(5150);
    expect(slot.freezeCount).toBe(0);
    expect(engine.variables[engine.vars.OVERRIDE]).toBe(1);
    // Armed once: a second press must not jump a script that has moved on.
    slot.offset = 6000;
    engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY]);
    expect(slot.offset).toBe(6000);
  });

  it('does nothing when the game has armed no skip point', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    const slot = occupySlot(engine, 0, 99);
    engine.beginCutscene([0]);
    slot.offset = 900;

    engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY]);

    expect(slot.offset).toBe(900);
    expect(engine.variables[engine.vars.OVERRIDE]).toBe(0);
  });

  it('refuses to nest deeper than the cutscene stack allows', async () => {
    const messages: string[] = [];
    const engine = await makeEngine({}, messages);
    engine.boot(0);

    occupySlot(engine, 0, 99);
    for (let i = 0; i < MAX_CUTSCENE_DEPTH + 3; i++) engine.beginCutscene([0]);

    expect(engine.scriptState.cutSceneStack.length).toBe(MAX_CUTSCENE_DEPTH);
    expect(messages.some((message) => /Cutscene stack overflow/.test(message))).toBe(true);
  });

  it('unwinds a cutscene whose owning script a room change kills', async () => {
    const messages: string[] = [];
    const engine = await makeEngine({}, messages);
    engine.boot(0);

    occupySlot(engine, 0, 55, ObjectWhere.Local);
    engine.beginCutscene([0]);
    // What the game's own cutscene start script would have done.
    engine.setUserPut(false);
    engine.setCursorVisible(false);
    expect(engine.userPut).toBe(false);

    engine.startScene(0, null, 0);

    expect(engine.scriptState.cutSceneStack.length).toBe(0);
    expect(engine.userPut).toBe(true);
    expect(engine.cursorVisible).toBe(true);
    expect(messages.some((message) => /orphaned/.test(message))).toBe(true);
  });

  it('leaves a global script its cutscene across a room change', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    occupySlot(engine, 0, 55, ObjectWhere.Global);
    engine.beginCutscene([0]);
    engine.setUserPut(false);

    engine.startScene(0, null, 0);

    // A global script survives the room change, so it can still end its own
    // cutscene; unwinding here would cut the game off mid-sequence.
    expect(engine.scriptState.cutSceneStack.length).toBe(1);
    expect(engine.userPut).toBe(false);
  });

  it('thaws scripts frozen by a cutscene it has to unwind', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    occupySlot(engine, 1, 56, ObjectWhere.Global);
    const bystander = engine.scriptState.slots[1];
    occupySlot(engine, 0, 55, ObjectWhere.Local);
    engine.beginCutscene([0]);
    engine.scripts.freezeScripts(1);
    expect(bystander.freezeCount).toBeGreaterThan(0);

    engine.startScene(0, null, 0);

    expect(bystander.freezeCount).toBe(0);
  });

  it('warns when a room change kills a script holding a cutscene', async () => {
    const messages: string[] = [];
    const engine = await makeEngine({}, messages);
    engine.boot(0);

    occupySlot(engine, 0, 55, ObjectWhere.Local);
    engine.beginCutscene([0]);
    engine.startScene(0, null, 0);

    expect(messages.some((message) => /active cutscene or override/.test(message))).toBe(true);
  });
});

describe('input suspension', () => {
  it('balances nested soft user-put suspends', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    engine.setUserPut(false, true);
    engine.setUserPut(false, true);
    engine.setUserPut(true, true);
    // The inner sequence restored its own suspend; the outer one still holds.
    expect(engine.userPut).toBe(false);

    engine.setUserPut(true, true);
    expect(engine.userPut).toBe(true);
  });

  it('balances nested soft cursor suspends', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    engine.setCursorVisible(false, true);
    engine.setCursorVisible(false, true);
    engine.setCursorVisible(true, true);
    expect(engine.cursorVisible).toBe(false);

    engine.setCursorVisible(true, true);
    expect(engine.cursorVisible).toBe(true);
  });

  it('lets a hard restore override any depth of soft suspend', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    engine.setUserPut(false, true);
    engine.setUserPut(false, true);
    engine.setUserPut(true);

    expect(engine.userPut).toBe(true);
    expect(engine.variables[VAR.USERPUT]).toBe(1);
  });

  it('publishes the suspend counts to the script variables', async () => {
    const engine = await makeEngine();
    engine.boot(0);

    engine.setUserPut(false, true);
    engine.setUserPut(false, true);

    // SCUMM writes the raw counter, not a flag, so scripts can see the nesting.
    expect(engine.variables[VAR.USERPUT]).toBe(-1);
    expect(engine.userPut).toBe(false);
  });
});

/**
 * A cutscene has to be able to end.
 *
 * `cutscene` runs the game's own cutscene start script nested, and that script
 * freezes every other script so the scene plays undisturbed. The script that
 * opened the cutscene is waiting mid-opcode while that happens, so it is not
 * the current script and nothing else marks it out — freezing it stops the one
 * slot that would ever reach `endCutscene`. Indiana Jones 4 hit exactly that:
 * its intro opened a cutscene, the start script froze the opener, and the game
 * sat in room 4 for good with input suspended, no player and no verbs.
 *
 * Driven through real bytecode rather than `occupySlot`, because the fault is
 * in how the nested start script and its caller interleave.
 */
async function runBooted(
  build: (s: Assembler) => void,
  startScript: number[],
  frames: number,
  entryScript?: number[],
) {
  const boot = new Assembler();
  build(boot);

  const engine = await makeEngine({
    bootScript: [...boot.build()],
    script2: startScript,
    entryScript,
  });
  engine.boot(0);
  for (let i = 0; i < frames; i++) engine.step();
  return engine;
}

/** A cutscene start script that freezes the world, as the real ones do. */
function freezingStartScript(): number[] {
  const script = new Assembler();
  script.freezeScripts(1);
  script.stop();
  return [...script.build()];
}

describe('a cutscene whose start script freezes the scripts', () => {
  it('leaves the script that opened it running', async () => {
    const engine = await runBooted(
      (s) => {
        s.loadRoom(1);
        s.move(global(VAR.CUTSCENE_START_SCRIPT), 2);
        s.cutscene([]);
        s.breakHere();
        s.move(global(201), 99);
        s.endCutscene();
        s.stop();
      },
      freezingStartScript(),
      20,
    );

    // The opener got past its cutscene and closed it: the code after
    // `cutscene` ran and the level is gone.
    expect(engine.variables[201]).toBe(99);
    expect(engine.scriptState.cutSceneStack.length).toBe(0);
    expect(engine.scriptState.startingCutsceneSlot).toBe(-1);
  });

  it('still freezes the other scripts while the cutscene runs', async () => {
    // The room's entry code loops forever, so it is a running slot that the
    // cutscene ought to suspend. Exempting the opener must not exempt this.
    const entry = new Assembler();
    const loop = entry.label();
    entry.place(loop);
    entry.breakHere();
    entry.jump(loop);

    const engine = await runBooted(
      (s) => {
        s.loadRoom(1);
        s.move(global(VAR.CUTSCENE_START_SCRIPT), 2);
        s.cutscene([]);
        // Parks inside the cutscene, so both slots are still alive to inspect.
        const wait = s.label();
        s.place(wait);
        s.breakHere();
        s.jump(wait);
      },
      freezingStartScript(),
      4,
      [...entry.build()],
    );

    const opener = engine.scriptState.slots.find((slot) => slot.number === 1);
    const roomEntry = engine.scriptState.slots.find(
      (slot) => slot.isRunning && slot.number !== 1 && slot.number !== 2,
    );

    expect(opener?.freezeCount).toBe(0);
    expect(roomEntry?.freezeCount).toBe(1);
  });
});
