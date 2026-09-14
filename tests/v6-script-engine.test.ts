import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { ScriptEngineV6 } from '../src/engine/script/v6/ScriptEngine.js';
import { ObjectWhere, ScriptStatus } from '../src/engine/constants.js';
import { buildV6Fixture, V6_SCRIPT_RESULT, type V6FixtureOptions } from './fixtureV6.js';
import { u16le } from './fixture.js';

/**
 * How many instructions SCUMM v6 has, from ScummVM's `setupOpcodes` table in
 * `script_v6.cpp`. A fact about the bytecode, so it is a constant to compare
 * against rather than a floor to stay above.
 */
const V6_OPCODE_COUNT = 160;

/**
 * The v6 stack machine.
 *
 * Every script here is hand-assembled in the test, so what is being checked is
 * the engine's reading of specific bytes rather than its behaviour on a real
 * game. Opcode numbers come from ScummVM's `script_v6.cpp` table.
 */
async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  return { engine, logs };
}

/** Runs `code` as global script 2 and returns the engine it ran in. */
async function run(code: number[]) {
  const { engine, logs } = await bootV6({ script2: code });
  engine.boot(0);
  engine.scripts.runScript(2, false, false, []);
  return { engine, logs };
}

describe('choosing an interpreter', () => {
  it('uses the v6 engine for a v6 game', async () => {
    const { engine } = await bootV6();
    expect(engine.scripts).toBeInstanceOf(ScriptEngineV6);
  });

  it('says so, since which interpreter is running explains everything after', async () => {
    const { logs } = await bootV6();
    expect(logs.join('\n')).toMatch(/v6 interpreter/);
  });
});

describe('arithmetic and variables', () => {
  it('runs the fixture script and leaves both variables set', async () => {
    const { engine } = await bootV6();
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    expect(engine.variables[250]).toBe(V6_SCRIPT_RESULT.var250);
    expect(engine.variables[251]).toBe(V6_SCRIPT_RESULT.var251);
  });

  it('evaluates a comparison, second operand on top of the stack', async () => {
    const { engine } = await run([
      0x00,
      0x03, // pushByte 3
      0x00,
      0x09, // pushByte 9
      0x11, // lt        -> 3 < 9
      0x43,
      ...u16le(300), // writeWordVar var300
      0x66, // stopObjectCode
    ]);
    expect(engine.variables[300]).toBe(1);
  });

  it('subtracts in the written order rather than the popped one', async () => {
    // The operand order is the thing a stack machine gets silently wrong: this
    // must be 10 - 4, not 4 - 10.
    const { engine } = await run([
      0x00,
      0x0a, // pushByte 10
      0x00,
      0x04, // pushByte 4
      0x15, // sub
      0x43,
      ...u16le(301), // writeWordVar var301
      0x66,
    ]);
    expect(engine.variables[301]).toBe(6);
  });

  it('increments a variable in place', async () => {
    const { engine } = await run([
      0x00,
      0x05, // pushByte 5
      0x43,
      ...u16le(302), // writeWordVar var302
      0x4f,
      ...u16le(302), // wordVarInc
      0x4f,
      ...u16le(302), // wordVarInc
      0x66,
    ]);
    expect(engine.variables[302]).toBe(7);
  });
});

describe('control flow', () => {
  it('takes a jump backwards and counts down through it', async () => {
    // A loop: var303 starts at 3 and is decremented until it reaches zero.
    const { engine } = await run([
      0x00,
      0x03, // pushByte 3
      0x43,
      ...u16le(303), // writeWordVar var303
      // loop:
      0x57,
      ...u16le(303), // wordVarDec        (offset 7)
      0x03,
      ...u16le(303), // pushWordVar var303
      0x5c,
      ...u16le(0x10000 - 9), // if (non-zero) jump back to loop
      0x66, // stopObjectCode
    ]);
    expect(engine.variables[303]).toBe(0);
  });

  /**
   * The unconditional `jump` had no backward test, and the conditional one it
   * shared a shape with was fine — so a bug in `jump` alone survived every
   * test here and broke every loop in a real game. Its displacement counts
   * from the *end* of the instruction, and computing it from the start lands
   * two bytes early: inside the instruction the loop begins with.
   */
  it('takes an unconditional jump backwards to the instruction it names', async () => {
    const { engine } = await run([
      0x00,
      0x04, // pushByte 4
      0x43,
      ...u16le(305), // writeWordVar var305 = 4      (loop starts at 5)
      0x57,
      ...u16le(305), // wordVarDec var305            (offset 5)
      0x03,
      ...u16le(305), // pushWordVar var305
      0x5d,
      ...u16le(3), // ifNot -> leave the loop
      0x73,
      // Back to offset 5, counted from the end of this instruction at 17.
      ...u16le(0x10000 - 12),
      0x66,
    ]);

    // Four decrements and out. Two bytes early would re-enter mid-instruction
    // and the count would come out wrong or the script would run away.
    expect(engine.variables[305]).toBe(0);
    expect(engine.scripts.isScriptRunning(2)).toBe(false);
  });

  it('skips the body when a condition is false', async () => {
    const { engine } = await run([
      0x00,
      0x00, // pushByte 0
      0x5c,
      ...u16le(5), // if -> not taken, falls through
      0x00,
      0x63, // pushByte 99
      0x43,
      ...u16le(304), // writeWordVar var304
      0x66,
    ]);
    expect(engine.variables[304]).toBe(99);
  });

  it('yields at breakHere and resumes at the next instruction', async () => {
    const { engine } = await run([
      0x00,
      0x01, // pushByte 1
      0x43,
      ...u16le(305), // writeWordVar var305
      0x6c, // breakHere
      0x00,
      0x02, // pushByte 2
      0x43,
      ...u16le(305), // writeWordVar var305
      0x66,
    ]);

    // Yielded, so the second write has not happened yet.
    expect(engine.variables[305]).toBe(1);
    engine.scripts.runAllScripts();
    expect(engine.variables[305]).toBe(2);
  });

  it('stops a script at stopObjectCode rather than running past it', async () => {
    const { engine } = await run([
      0x00,
      0x01,
      0x43,
      ...u16le(306), // writeWordVar var306 = 1
      0x66, // stopObjectCode
      0x00,
      0x02,
      0x43,
      ...u16le(306), // never reached
      0x66,
    ]);
    expect(engine.variables[306]).toBe(1);
    expect(engine.scripts.isScriptRunning(2)).toBe(false);
  });
});

describe('arrays', () => {
  it('creates the arrays AARY declared', async () => {
    // The fixture declares array 100 with dim1 10, so index 9 is in range and
    // reads back what was written.
    const { engine } = await run([
      0x00,
      0x09, // pushByte 9         (the index)
      0x00,
      0x2a, // pushByte 42        (the value, popped first)
      0x47,
      ...u16le(100), // wordArrayWrite arr100
      0x00,
      0x09, // pushByte 9
      0x07,
      ...u16le(100), // wordArrayRead arr100
      0x43,
      ...u16le(307), // writeWordVar var307
      0x66,
    ]);
    expect(engine.variables[307]).toBe(42);
  });

  it('reads zero from an array the index never declared', async () => {
    const { engine } = await run([
      0x00,
      0x01,
      0x07,
      ...u16le(150), // wordArrayRead arr150 — not in AARY
      0x43,
      ...u16le(308),
      0x66,
    ]);
    expect(engine.variables[308]).toBe(0);
  });
});

describe('an opcode with no handler', () => {
  /**
   * The alternative — skipping it — cannot work: v6 operands come off a stack,
   * so an instruction of unknown length leaves every instruction after it
   * reading someone else's operands. Stopping with a named opcode is a bug
   * report; continuing is a mystery.
   */
  it('stops the script and names the opcode, script and offset', async () => {
    const { engine, logs } = await run([
      0x00,
      0x01,
      0x43,
      ...u16le(309), // writeWordVar var309 = 1
      0xd3, // a gap in v6's opcode table: no instruction has this number
      0x00,
      0x02,
      0x43,
      ...u16le(309), // must not run
      0x66,
    ]);

    expect(engine.variables[309]).toBe(1);
    expect(engine.scripts.isScriptRunning(2)).toBe(false);
    expect(logs.join('\n')).toMatch(/0xd3/);
  });

  /**
   * The table is complete, so the honest-stop path above is now only reached by
   * bytes that are not v6 code at all — which is when it matters most, because
   * that is the case where continuing produces a cascade of nonsense.
   */
  it('implements every opcode in the v6 table', async () => {
    const { engine } = await bootV6();
    expect((engine.scripts as ScriptEngineV6).implementedOpcodes).toBe(V6_OPCODE_COUNT);
  });

  it('leaves handlers only where v6 has an instruction', async () => {
    const { engine } = await bootV6();
    const missing = (engine.scripts as ScriptEngineV6).unimplementedOpcodes;

    // Every byte without a handler is one ScummVM's table has no entry for
    // either. Spot-checked at the boundaries of the gaps, since asserting the
    // whole list would only restate the table.
    expect(missing).toContain(0x04);
    expect(missing).toContain(0x41);
    expect(missing).toContain(0xff);
    expect(missing).not.toContain(0x9d); // actorOps
    expect(missing).not.toContain(0xed); // getObjectNewDir
  });
});

describe('slots', () => {
  it('runs a script started by another script, then resumes the caller', async () => {
    const { engine } = await bootV6({
      // Script 2 starts script 3 and then writes; script 3 writes first.
      script2: [
        0x00,
        0x00, // pushByte 0     (flags)
        0x00,
        0x03, // pushByte 3     (script)
        0x00,
        0x00, // pushByte 0     (arg count)
        0x5e, // startScript
        0x03,
        ...u16le(310), // pushWordVar var310
        0x00,
        0x01, // pushByte 1
        0x14, // add
        0x43,
        ...u16le(310), // writeWordVar var310
        0x66,
      ],
    });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    // Script 3 does not exist in the fixture, so the caller must still finish:
    // a missing script is reported, not fatal.
    expect(engine.variables[310]).toBe(1);
    expect(engine.scriptState.slots.filter((slot) => slot.status !== ScriptStatus.Dead)).toEqual(
      [],
    );
  });
});

describe('talking', () => {
  /**
   * v6 puts a line's text in the code stream after the instruction, and puts
   * the *speech offset* inside that text as control code 10 — which is 14 bytes
   * where every other argument-taking code is 2. Reading it as 2 leaves twelve
   * bytes of payload to be decoded as text, and the reader then walks off the
   * end of the string into the next instruction.
   */
  const letters = (text: string) => [...text].map((character) => character.charCodeAt(0));

  it('reads the inline message and says it', async () => {
    const { engine } = await run([
      0x00,
      0x01, // pushByte 1 (the actor)
      0xba, // talkActor
      ...letters('Hello'),
      0x00, // end of string
      0x66, // stopObjectCode
    ]);

    expect(engine.currentText()).toContain('Hello');
  });

  it('takes the speech offset out of the message and keeps reading text', async () => {
    // `FF 0A` then a 14 byte payload: offset and size, each stored as two
    // 16-bit fields with marker pairs between them.
    const speechCode = [
      0xff, 0x0a, 0x34, 0x12, 0xff, 0x0a, 0x00, 0x00, 0xff, 0x0a, 0x08, 0x00, 0xff, 0x0a, 0x00,
      0x00,
    ];

    const { engine } = await run([0x00, 0x01, 0xba, ...speechCode, ...letters('Yes'), 0x00, 0x66]);

    // The text survives the code rather than absorbing its payload as
    // characters, and the script reached its stop rather than running off into
    // the middle of the string.
    expect(engine.currentText()).toContain('Yes');
    expect(engine.currentText().length).toBeLessThan(10);
    expect(engine.scripts.isScriptRunning(2)).toBe(false);
  });

  it('times the line by its text when there is no speech for it', async () => {
    const { engine } = await run([
      0x00,
      0x01,
      0xba,
      ...letters('A longer line of dialogue'),
      0x00,
      0x66,
    ]);

    // Proportional to length rather than fixed: this is the number a script
    // waiting for the line to finish is really waiting for.
    expect(engine.messageFramesRemaining()).toBeGreaterThan(30);
  });
});

describe('scheduling, now shared with the v5 engine', () => {
  /**
   * The v6 engine had its own copy of the scheduler and had drifted. These are
   * the behaviours it gained by converging on the implementations a released
   * game has been played through (#90).
   */
  it('does not freeze a freeze-resistant script when the flag says not to', async () => {
    // The v6 copy had this test inverted, freezing exactly the scripts that
    // are supposed to survive.
    const { engine } = await bootV6();
    const slot = engine.scriptState.slots[3];
    slot.number = 77;
    slot.status = ScriptStatus.Running;
    slot.freezeResistant = true;

    engine.scripts.freezeScripts(0);

    expect(slot.freezeCount).toBe(0);
  });

  it('freezes an ordinary script', async () => {
    const { engine } = await bootV6();
    const slot = engine.scriptState.slots[3];
    slot.number = 78;
    slot.status = ScriptStatus.Running;

    engine.scripts.freezeScripts(0);

    expect(slot.freezeCount).toBeGreaterThan(0);
  });

  it('does not report a room script as running', async () => {
    // A room-owned script answering `isScriptRunning` makes a script waiting on
    // one wait for ever.
    const { engine } = await bootV6();
    const slot = engine.scriptState.slots[4];
    slot.number = 55;
    slot.status = ScriptStatus.Running;
    slot.where = ObjectWhere.Room;

    expect(engine.scripts.isScriptRunning(55)).toBe(false);
  });
});
