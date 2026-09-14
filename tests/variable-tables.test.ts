import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import {
  ABSENT_IN_V7,
  VAR,
  VAR_V6,
  VAR_V7,
  VAR_V8,
  variablesFor,
} from '../src/engine/constants.js';
import { buildV7Fixture } from './fixtureV7.js';
import { buildV6Fixture } from './fixtureV6.js';
import { buildFixture } from './fixture.js';

/**
 * Which slot a well-known variable lives in, per version.
 *
 * The interpreter and the game's scripts share these by number, so a wrong
 * number is not a wrong value — it is two parties reading different variables
 * and neither of them failing. That is why this is asserted per version rather
 * than trusted to a base table with overrides: v6 *is* the base with
 * overrides, and v7 is not.
 */
describe('the table a version resolves to', () => {
  it('gives v5 its own numbers unchanged', () => {
    const vars = variablesFor(5, 999);
    expect(vars.ROOM).toBe(VAR.ROOM);
    expect(vars.EGO).toBe(VAR.EGO);
    expect(vars.KEYPRESS).toBe(VAR.KEYPRESS);
  });

  it('gives v6 the base plus its overrides, and nothing else moved', () => {
    const vars = variablesFor(6, 999);
    expect(vars.ROOM_WIDTH).toBe(VAR_V6.ROOM_WIDTH);
    expect(vars.VOICE_MODE).toBe(VAR_V6.VOICE_MODE);
    // Not overridden by v6, so still the base's.
    expect(vars.ROOM).toBe(VAR.ROOM);
    expect(vars.EGO).toBe(VAR.EGO);
  });

  it('gives v7 a table of its own, which agrees with the base almost nowhere', () => {
    const vars = variablesFor(7, 999);

    expect(vars.ROOM).toBe(10);
    expect(vars.EGO).toBe(111);
    expect(vars.HAVE_MSG).toBe(13);
    expect(vars.TALK_ACTOR).toBe(12);

    // The collision worth naming: 118 is v6's last random number and v7's last
    // key. Reading the base table under v7 finds one where it wants the other.
    expect(vars.KEYPRESS).toBe(118);
    expect(VAR_V6.RANDOM_NR).toBe(118);
    expect(VAR_V7.RANDOM_NR).toBe(34);
  });

  it('sends a name v7 has no variable for to the bin, not to slot zero', () => {
    // Slot 0 is v5's `VAR_KEYPRESS` and a live slot under v7 as well, so
    // "absent" cannot be spelled as zero — and it cannot be spelled as -1
    // either, which reads back undefined and propagates as NaN.
    const vars = variablesFor(7, 999);
    expect(vars.MACHINE_SPEED).toBe(999);
    expect(vars.SOUNDCARD).toBe(999);
    expect(vars.CURRENTDRIVE).toBe(999);
    expect(vars.NUM_ACTOR).toBe(999);
  });

  it('agrees with the written list of what v7 has no variable for', () => {
    // The tripwire: "v7 has no such variable" and "the v7 table has not been
    // transcribed yet" produce the same lookup miss, and only the first is safe
    // to resolve to nowhere. A name dropped from `VAR_V7` by accident fails
    // here rather than reading as zero for the rest of the game.
    const vars = variablesFor(7, 999);
    const derived = Object.entries(vars)
      .filter(([, slot]) => slot === 999)
      .map(([name]) => name)
      .sort();

    expect(derived).toEqual([...ABSENT_IN_V7].sort());
  });

  it('answers for every name any version knows, whichever is running', () => {
    // One shape per version, so a caller does not have to know which table it
    // is reading. Names a version lacks are present and absent, not missing.
    const everyName = new Set([
      ...Object.keys(VAR),
      ...Object.keys(VAR_V6),
      ...Object.keys(VAR_V7),
      ...Object.keys(VAR_V8),
    ]);
    for (const version of [5, 6, 7, 8]) {
      expect(Object.keys(variablesFor(version, 999)).sort()).toEqual([...everyName].sort());
    }
  });

  it('holds v5’s held-button names absent rather than defaulting them', () => {
    // v6 added these and Sam & Max's verb coin is built on them; v5's numbers
    // 74 and 75 hold something else entirely.
    expect(variablesFor(5, 999).LEFTBTN_HOLD).toBe(999);
    expect(variablesFor(6, 999).LEFTBTN_HOLD).toBe(VAR_V6.LEFTBTN_HOLD);
    expect(variablesFor(7, 999).LEFTBTN_HOLD).toBe(VAR_V7.LEFTBTN_HOLD);
  });

  it('gives v8 a table of its own, which agrees with v7 about even less', () => {
    // v7 already agreed with the base almost nowhere; v8 agrees with v7 almost
    // nowhere either. `ROOM` is 4, 10 and 31; `EGO` is 1, 111 and 126;
    // `KEYPRESS` is 0, 118 and 132. There is no arithmetic between them, which
    // is why this is a whole table and not a delta.
    const vars = variablesFor(8, 999);

    expect(vars.ROOM).toBe(31);
    expect(vars.EGO).toBe(126);
    expect(vars.KEYPRESS).toBe(132);
    expect(vars.HAVE_MSG).toBe(15);

    expect(vars.ROOM).not.toBe(VAR.ROOM);
    expect(vars.ROOM).not.toBe(VAR_V7.ROOM);
  });

  it('does not let a later version inherit an earlier one’s table', () => {
    // Written as exact matches per version for the reason the interpreter is
    // chosen that way: a `>=` is how v8 would quietly acquire v7's numbers.
    for (const name of ['ROOM', 'EGO', 'KEYPRESS'] as const) {
      expect(variablesFor(8, 999)[name]).toBe(VAR_V8[name]);
      expect(variablesFor(7, 999)[name]).toBe(VAR_V7[name]);
    }
  });
});

describe('an engine playing a version', () => {
  async function boot(fixture: {
    indexName: string;
    index: Uint8Array;
    dataName: string;
    data: Uint8Array;
  }) {
    const source = new MemoryDataSource('game');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    return engine;
  }

  it('ticks a v7 game’s timers at v7’s numbers', async () => {
    const engine = await boot(buildV7Fixture());
    const before = engine.variables[VAR_V7.TMR_1];
    engine.step();

    expect(engine.variables[VAR_V7.TMR_1]).toBe(before + 1);
    // And not at v5's, which under v7 is an ordinary variable a game may use.
    expect(engine.variables[VAR.TMR_1]).toBe(0);
  });

  it('keeps a v5 game on the base table', async () => {
    const engine = await boot(buildFixture());
    const before = engine.variables[VAR.TMR_1];
    engine.step();
    expect(engine.variables[VAR.TMR_1]).toBe(before + 1);
  });

  it('keeps a v6 game on the base table plus its overrides', async () => {
    const engine = await boot(buildV6Fixture());
    expect(engine.vars.ROOM_WIDTH).toBe(VAR_V6.ROOM_WIDTH);
    expect(engine.vars.EGO).toBe(VAR.EGO);
  });

  it('reserves the bin past the game’s own variables, where no script reaches', async () => {
    const engine = await boot(buildV7Fixture());
    // Writing a variable v7 does not have must not disturb one it does. The
    // engine sets several of these at reset, so this is not hypothetical.
    expect(engine.vars.MACHINE_SPEED).toBe(engine.variables.length - 1);
    expect(engine.variables[engine.vars.ROOM]).toBe(0);
  });
});
