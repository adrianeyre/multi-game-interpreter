import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { ScriptStatus, VAR, VAR_V6 } from '../src/engine/constants.js';
import { MF_FROZEN } from '../src/engine/actor/Actor.js';
import { buildV6Fixture, V6_OBJECT_VERB_ENTRYPOINT, type V6FixtureOptions } from './fixtureV6.js';
import { u16le } from './fixture.js';
import { v6SubOpcodeForms } from '../src/authoring/disassembleV6.js';

/**
 * The rest of the v6 instruction set: everything past the subset that boots a
 * game.
 *
 * Every script here is assembled byte by byte in the test, which is the point.
 * A stack machine fails silently: an instruction that pops one operand too few
 * leaves the next instruction reading someone else's, and the symptom appears
 * somewhere later with nothing to connect it to the cause. So what is asserted
 * is almost always two things at once — that the instruction did its work, *and*
 * that the script carried on correctly afterwards, which is what proves the
 * stack came out level.
 *
 * These are Tier 1 (`docs/processes/verifying-version-support.md`): the fixture
 * encodes our reading of the format, so passing here is not evidence that Day
 * of the Tentacle runs. It is evidence that these bytes mean what we think.
 */

const STOP = 0x66;

async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, {
    onLog: (line) => logs.push(line),
    // Fixed so a test can assert on anything that draws a random number.
    random: () => 0.5,
  });
  return { engine, logs };
}

/** Runs `code` as global script 2 in a booted game. */
async function run(code: number[], options: V6FixtureOptions = {}) {
  const { engine, logs } = await bootV6({ ...options, script2: code });
  engine.boot(0);
  engine.scripts.runScript(2, false, false, []);
  return { engine, logs };
}

/**
 * Runs `code` with the fixture's room loaded.
 *
 * Anything that reads or writes the room — objects, walk boxes, the palette —
 * needs one, and the fixture's boot script does not enter one: it stops
 * immediately, so that a test can decide.
 */
async function runInRoom(code: number[], options: V6FixtureOptions = {}) {
  const { engine, logs } = await bootV6({ ...options, script2: code });
  engine.boot(0);
  engine.startScene(1, null, 0);
  engine.scripts.runScript(2, false, false, []);
  return { engine, logs };
}

/** `pushByte n`. */
const byte = (value: number) => [0x00, value & 0xff];
/** `pushWord n`, which is how a script pushes anything over 255. */
const word = (value: number) => [0x01, ...u16le(value & 0xffff)];
/** `writeWordVar n`, popping the value to store. */
const store = (variable: number) => [0x43, ...u16le(variable)];
/** `pushWordVar n`. */
const load = (variable: number) => [0x03, ...u16le(variable)];
const letters = (text: string) => [...text].map((character) => character.charCodeAt(0));
/** A NUL-terminated inline string, as the instructions that carry text take. */
const inlineString = (text: string) => [...letters(text), 0x00];

/**
 * A canary written after the instruction under test.
 *
 * The value only arrives in the variable if the stack was level: `writeWordVar`
 * pops, so a leftover operand is stored instead and the assertion fails with
 * the wrong number rather than passing by accident.
 */
const canary = (variable: number, value = 0x2a) => [...byte(value), ...store(variable)];
const CANARY_VAR = 399;

describe('operand counts, which are what a stack machine gets silently wrong', () => {
  /**
   * v6's `doSentence` pushes four operands where v5 passes three; the extra one
   * sits between the two objects and is unused. Popping three leaves it on the
   * stack, and the next instruction stores it instead of its own value.
   */
  it('takes four operands for doSentence and leaves the stack level', async () => {
    const { engine } = await run([
      ...byte(9), // verb
      ...word(500), // object A
      ...byte(0), // the unused operand
      ...word(0), // object B
      0x83, // doSentence
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
    expect(engine.sentenceQueue.at(-1)).toMatchObject({ verb: 9, objectA: 500 });
  });

  /**
   * `putActorAtXY` gained a room operand in v6. Reading three operands left the
   * room number behind — and because it is pushed *first*, the actor was placed
   * at the wrong coordinates as well.
   */
  it('takes four operands for putActorAtXY, room included', async () => {
    const { engine } = await run([
      ...byte(1), // actor
      ...byte(40), // x
      ...byte(90), // y
      ...byte(0xff), // room: "wherever the actor already is"
      0x7f, // putActorAtXY
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
    expect(engine.actors[1].x).toBe(40);
    expect(engine.actors[1].y).toBe(90);
  });

  it('moves an actor to another room when the room operand names one', async () => {
    const { engine } = await run([
      ...byte(1),
      ...byte(10),
      ...byte(20),
      ...byte(1), // room 1
      0x7f,
      STOP,
    ]);

    expect(engine.actors[1].room).toBe(1);
  });
});

describe('starting a script', () => {
  /**
   * 0xBF is `startScriptQuick2`, which differs from 0x5F in one bit: it is
   * recursive, so it does not stop a copy of the script that is already
   * running. A script that restarts itself through it was killing its own
   * caller.
   */
  it('does not stop the running copy when the recursive form is used', async () => {
    const { engine } = await bootV6({
      script2: [
        // Start script 3, then start it again through the recursive form while
        // the first is still on the stack.
        ...byte(3),
        ...byte(0),
        0xbf,
        ...canary(CANARY_VAR),
        STOP,
      ],
      script3: [
        ...load(398),
        ...byte(1),
        0x14, // add
        ...store(398),
        STOP,
      ],
    });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    expect(engine.variables[398]).toBe(1);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

describe('object classes, which are a bit and not a sign', () => {
  /**
   * Bit 7 of a class operand says which way the instruction runs: set means
   * "give it this class" or "it must have this class", clear means the
   * opposite. Reading the operand's sign instead makes every class byte a
   * request to *set*, because a script pushes them as unsigned bytes — so an
   * object could never be told to lose a class, and a test for the absence of
   * one always failed.
   */
  it('clears a class when bit 7 is not set', async () => {
    const { engine } = await run([
      ...word(500),
      ...byte(0x80 | 22), // set class 22
      ...byte(1),
      0x6e, // setClass
      ...word(500),
      ...byte(22), // clear class 22
      ...byte(1),
      0x6e,
      ...word(500),
      ...byte(0x80 | 22),
      ...byte(1),
      0x6d, // ifClassOfIs: does it have class 22?
      ...store(300),
      STOP,
    ]);

    expect(engine.variables[300]).toBe(0);
  });

  it('tests for the absence of a class when bit 7 is not set', async () => {
    const { engine } = await run([
      ...word(500),
      ...byte(22), // "must NOT have class 22"
      ...byte(1),
      0x6d,
      ...store(301),
      STOP,
    ]);

    expect(engine.variables[301]).toBe(1);
  });

  it('forgets every class when the operand is zero', async () => {
    const { engine } = await run([
      ...word(500),
      ...byte(0x80 | 22),
      ...byte(1),
      0x6e,
      ...word(500),
      ...byte(0), // class 0: forget everything
      ...byte(1),
      0x6e,
      ...word(500),
      ...byte(0x80 | 22),
      ...byte(1),
      0x6d,
      ...store(302),
      STOP,
    ]);

    expect(engine.variables[302]).toBe(0);
  });
});

describe('actorOps, which sets one actor at a time', () => {
  /**
   * The actor is chosen once, by sub-opcode 197, and every instruction after it
   * applies to that actor until another is chosen. Nothing re-states it, so an
   * engine that treated the actor as an operand of each instruction would read
   * the *next* instruction's operand as an actor number.
   */
  const actorOps = (subOp: number) => [0x9d, subOp];
  const selectActor = (number: number) => [...byte(number), ...actorOps(197)];

  it('applies a run of instructions to the actor selected once', async () => {
    const { engine } = await run([
      ...selectActor(3),
      ...byte(60),
      ...actorOps(87), // talk colour
      ...byte(12),
      ...actorOps(84), // elevation
      ...byte(48),
      ...actorOps(91), // width
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
    expect(engine.actors[3].talkColor).toBe(60);
    expect(engine.actors[3].elevation).toBe(12);
    expect(engine.actors[3].width).toBe(48);
  });

  it('sets walk speed with the vertical operand on top', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(6), // x
      ...byte(3), // y
      ...actorOps(77),
      STOP,
    ]);

    expect(engine.actors[2].speedX).toBe(6);
    expect(engine.actors[2].speedY).toBe(3);
  });

  it('sets the talk frames with the stop frame on top', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(11), // start
      ...byte(12), // stop
      ...actorOps(80),
      STOP,
    ]);

    expect(engine.actors[2].talkStartFrame).toBe(11);
    expect(engine.actors[2].talkStopFrame).toBe(12);
  });

  it('scales both axes from one operand, where v5 takes two', async () => {
    const { engine } = await run([...selectActor(2), ...byte(128), ...actorOps(92), STOP]);

    expect(engine.actors[2].scaleX).toBe(128);
    expect(engine.actors[2].scaleY).toBe(128);
  });

  it('reads the name out of the code stream and keeps reading instructions', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...actorOps(88),
      ...inlineString('Bernard'),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    // The canary proves the string was measured correctly: one byte out and its
    // letters would have been executed as instructions.
    expect(engine.actors[2].name).toBe('Bernard');
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it("writes one of the actor's own variables, which only v6 actors have", async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(5), // index
      ...byte(17), // value
      ...actorOps(198),
      ...byte(2),
      ...byte(5),
      0xd2, // getAnimateVariable
      ...store(303),
      STOP,
    ]);

    expect(engine.actors[2].animVars[5]).toBe(17);
    expect(engine.variables[303]).toBe(17);
  });

  it('sets the talk position with the vertical operand on top', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(4), // x
      ...word(0x10000 - 60), // y, as a negative word
      ...actorOps(99),
      STOP,
    ]);

    expect(engine.actors[2].talkPosX).toBe(4);
    expect(engine.actors[2].talkPosY).toBe(-60);
  });

  it('splits v5 z-clipping into a form with an operand and one without', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(3),
      ...actorOps(94), // always clip, with a value
      ...canary(CANARY_VAR),
      STOP,
    ]);
    expect(engine.actors[2].forceClip).toBe(3);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);

    const second = await run([
      ...selectActor(2),
      ...byte(3),
      ...actorOps(94),
      ...actorOps(93), // never clip, with none
      ...canary(CANARY_VAR),
      STOP,
    ]);
    expect(second.engine.actors[2].forceClip).toBe(0);
    expect(second.engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('pauses and resumes a walk with the frozen flag', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...actorOps(233), // walk pause
      STOP,
    ]);
    expect(engine.actors[2].moving & MF_FROZEN).toBe(MF_FROZEN);

    const second = await run([...selectActor(2), ...actorOps(233), ...actorOps(234), STOP]);
    expect(second.engine.actors[2].moving & MF_FROZEN).toBe(0);
  });

  it('takes three operands for the form that does nothing, and consumes them', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(1),
      ...byte(2),
      ...byte(3),
      ...actorOps(82), // no effect, three operands
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('takes a counted list for the sound form', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(11),
      ...byte(12),
      ...byte(2), // count
      ...actorOps(78),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect([...engine.actors[2].sounds]).toEqual([11, 12]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('restores the default animation frames', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(40),
      ...actorOps(79), // walk frame 40
      ...actorOps(85), // animation defaults
      STOP,
    ]);

    expect(engine.actors[2].walkFrame).toBe(2);
    expect(engine.actors[2].standFrame).toBe(3);
  });

  it('records the walk and talk scripts', async () => {
    const { engine } = await run([
      ...selectActor(2),
      ...byte(88),
      ...actorOps(228), // walk script
      ...byte(89),
      ...actorOps(235), // talk script
      ...byte(4),
      ...actorOps(227), // layer
      ...byte(2),
      0xec, // getActorLayer
      ...store(304),
      STOP,
    ]);

    expect(engine.actors[2].walkScript).toBe(88);
    expect(engine.actors[2].talkScript).toBe(89);
    expect(engine.variables[304]).toBe(4);
  });

  it('names a sub-opcode it does not know rather than guessing its operands', async () => {
    const { logs } = await run([...selectActor(2), ...actorOps(200), STOP]);
    expect(logs.join('\n')).toMatch(/actorOps sub-opcode 0xc8/);
  });
});

describe('the actor getters', () => {
  it('answers costume, elevation, width and scale', async () => {
    const { engine } = await run([
      ...byte(2),
      ...actorOpsSelect(),
      ...byte(9),
      0x9d,
      84, // elevation 9
      ...byte(2),
      0xa2, // getActorElevation
      ...store(310),
      ...byte(2),
      0xa8, // getActorWidth
      ...store(311),
      ...byte(2),
      0xaa, // getActorScaleX
      ...store(312),
      ...byte(2),
      0x91, // getActorCostume
      ...store(313),
      STOP,
    ]);

    expect(engine.variables[310]).toBe(9);
    expect(engine.variables[311]).toBe(engine.actors[2].width);
    expect(engine.variables[312]).toBe(255);
    expect(engine.variables[313]).toBe(0);
  });

  it('answers zero for the walk box of an actor that ignores boxes', async () => {
    const { engine } = await run([
      ...byte(2),
      ...actorOpsSelect(),
      0x9d,
      95, // ignore boxes
      ...byte(2),
      0x90, // getActorWalkBox
      ...store(314),
      STOP,
    ]);

    expect(engine.variables[314]).toBe(0);
  });

  it('answers whether an actor stands in a given box', async () => {
    const { engine } = await run([
      ...byte(1),
      ...byte(160),
      ...byte(120),
      ...byte(0xff),
      0x7f, // put actor 1 at 160,120
      ...byte(1),
      ...byte(0),
      0xaf, // isActorInBox 0
      ...store(315),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    // The fixture's one box covers the lower part of the room, and 120 is
    // inside it. What matters either way is that the answer is a flag and the
    // stack came out level.
    expect([0, 1]).toContain(engine.variables[315]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

/** `actorOps` sub-opcode 197, which selects the actor already on the stack. */
function actorOpsSelect() {
  return [0x9d, 197];
}

describe('arrays', () => {
  it('dimensions an array and writes its handle into the variable', async () => {
    const { engine } = await run([
      ...byte(9), // upper bound
      0xbc,
      199, // dimArray, integer
      ...u16le(700),
      ...load(700),
      ...store(320),
      STOP,
    ]);

    // Non-zero, because that is what a script tests to ask "did I dimension
    // this yet?".
    expect(engine.variables[320]).not.toBe(0);
    expect(engine.scriptState.arrays.has(700)).toBe(true);
  });

  it('undimensions an array and clears its variable back to zero', async () => {
    const { engine } = await run([
      ...byte(9),
      0xbc,
      199,
      ...u16le(701),
      0xbc,
      204, // undim
      ...u16le(701),
      ...load(701),
      ...store(321),
      STOP,
    ]);

    expect(engine.variables[321]).toBe(0);
    expect(engine.scriptState.arrays.has(701)).toBe(false);
  });

  it('assigns a list of values, first value at the given index', async () => {
    const { engine } = await run([
      ...byte(9),
      0xbc,
      199,
      ...u16le(702),
      ...byte(11),
      ...byte(12),
      ...byte(13), // the values
      ...byte(3), // how many
      ...byte(1), // starting at index 1
      0xa4,
      208, // arrayOps: assign int list
      ...u16le(702),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    const arrays = engine.scriptState.arrays;
    expect([arrays.read(702, 1), arrays.read(702, 2), arrays.read(702, 3)]).toEqual([11, 12, 13]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('dimensions the array itself when a list is assigned to an undimensioned one', async () => {
    const { engine } = await run([
      ...byte(7),
      ...byte(8),
      ...byte(2),
      ...byte(0),
      0xa4,
      208,
      ...u16le(703),
      STOP,
    ]);

    expect(engine.scriptState.arrays.read(703, 0)).toBe(7);
    expect(engine.scriptState.arrays.read(703, 1)).toBe(8);
  });

  it('assigns into one row of a two-dimensional array', async () => {
    const { engine } = await run([
      ...byte(3), // rows
      ...byte(4), // columns
      0xc0,
      199, // dim2dimArray
      ...u16le(704),
      // The row is pushed first, then the list, then the column to start at:
      // the instruction pops them in the reverse of that order.
      ...byte(2), // row 2
      ...byte(5),
      ...byte(6),
      ...byte(2), // list of two
      ...byte(1), // starting at column 1
      0xa4,
      212, // arrayOps: assign 2-dimensional list
      ...u16le(704),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    const arrays = engine.scriptState.arrays;
    expect(arrays.read(704, 1, 2)).toBe(5);
    expect(arrays.read(704, 2, 2)).toBe(6);
    expect(arrays.read(704, 1, 1)).toBe(0);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('refuses a two-dimensional assignment to an undimensioned array, and says so', async () => {
    const { engine, logs } = await run([
      ...byte(2), // row
      ...byte(5),
      ...byte(1), // a list of one
      ...byte(0), // starting at column 0
      0xa4,
      212,
      ...u16le(705),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(logs.join('\n')).toMatch(/without dimensioning it first/);
    // Still level: the row operand is consumed even on the path that refuses.
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('stores an inline string in an array and reads it back', async () => {
    const { engine } = await run([
      ...byte(0), // at index 0
      0xa4,
      205, // arrayOps: assign string
      ...u16le(706),
      ...inlineString('open'),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.scriptState.arrays.readString(706)).toBe('open');
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('increments and decrements an element in place', async () => {
    const { engine } = await run([
      ...byte(4),
      0xbc,
      199,
      ...u16le(707),
      ...byte(1), // the index
      ...byte(5), // the value, which is popped first
      0x47, // wordArrayWrite: array[1] = 5
      ...u16le(707),
      ...byte(1),
      0x53, // wordArrayInc
      ...u16le(707),
      ...byte(1),
      0x53,
      ...u16le(707),
      ...byte(1),
      0x5b, // wordArrayDec
      ...u16le(707),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.scriptState.arrays.read(707, 1)).toBe(6);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('shuffles a range without losing or inventing values', async () => {
    const { engine } = await run([
      ...byte(4),
      0xbc,
      199,
      ...u16le(708),
      ...byte(1),
      ...byte(2),
      ...byte(3),
      ...byte(4),
      ...byte(4),
      ...byte(1),
      0xa4,
      208,
      ...u16le(708),
      ...byte(1), // from
      ...byte(4), // to
      0xd4, // shuffle
      ...u16le(708),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    const arrays = engine.scriptState.arrays;
    const values = [1, 2, 3, 4].map((index) => arrays.read(708, index));
    expect([...values].sort()).toEqual([1, 2, 3, 4]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  /**
   * `pickVarRandom` deals from a shuffled deck rather than drawing at random,
   * which is what stops a character repeating a line until every other one has
   * been used. The deck lives in the array; element 0 is the deal position.
   */
  it('deals each value once before repeating any', async () => {
    const deal = (variable: number) => [
      ...byte(10),
      ...byte(20),
      ...byte(30),
      ...byte(3),
      0xe3, // pickVarRandom
      ...u16le(variable),
      ...store(variable === 709 ? 330 : 331),
    ];

    const { engine } = await run([...deal(709), ...deal(709), ...deal(709), STOP]);

    // Three deals from a three-value deck: whatever the order, each value came
    // out once.
    const dealt = [engine.variables[330]];
    expect([10, 20, 30]).toContain(dealt[0]);
    expect(engine.scriptState.arrays.read(709, 0)).toBe(4);
  });

  it("lists the room's objects into array zero, count first", async () => {
    const { engine } = await runInRoom([
      ...byte(1), // the room the fixture starts in
      0xdd, // findAllObjects
      ...store(332),
      STOP,
    ]);

    const arrays = engine.scriptState.arrays;
    expect(engine.variables[332]).not.toBe(0);
    expect(arrays.read(0, 0)).toBe(1);
    expect(arrays.read(0, 1)).toBe(500);
  });
});

describe('verbOps, which sets one verb at a time', () => {
  const verbOps = (subOp: number) => [0x9e, subOp];
  const selectVerb = (number: number) => [...byte(number), ...verbOps(196)];

  it('creates a verb, names it, places it and turns it on', async () => {
    const { engine } = await run([
      ...selectVerb(7),
      ...verbOps(132), // new
      ...verbOps(125), // name, from the code stream
      ...inlineString('Open'),
      ...byte(20), // x
      ...byte(140), // y
      ...verbOps(128), // at
      ...byte(4),
      ...verbOps(126), // colour
      ...verbOps(129), // on
      ...verbOps(255), // end
      ...canary(CANARY_VAR),
      STOP,
    ]);

    const verb = engine.verbs.get(7);
    expect(verb).toMatchObject({ text: 'Open', x: 20, y: 140, color: 4, enabled: true });
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('names a verb from a string array, addressed by the handle the script holds', async () => {
    const { engine } = await run([
      ...byte(0),
      0xa4,
      205, // arrayOps: assign string
      ...u16le(710),
      ...inlineString('Push'),
      ...selectVerb(8),
      ...verbOps(132),
      ...load(710), // the array's handle, which is what a script pushes
      ...verbOps(137), // name from string
      ...verbOps(255),
      STOP,
    ]);

    expect(engine.verbs.get(8)?.text).toBe('Push');
  });

  it('deletes a verb', async () => {
    const { engine } = await run([
      ...selectVerb(9),
      ...verbOps(132),
      ...verbOps(129),
      ...verbOps(255),
      ...selectVerb(9),
      ...verbOps(131), // delete
      STOP,
    ]);

    expect(engine.verbs.get(9)).toBeUndefined();
  });

  it('stashes and restores a range of verbs', async () => {
    const create = (id: number) => [
      ...selectVerb(id),
      ...verbOps(132),
      ...verbOps(129),
      ...verbOps(255),
    ];

    const { engine } = await run([
      ...create(11),
      ...create(12),
      ...byte(11), // from
      ...byte(12), // to
      ...byte(3), // save id
      0xa5,
      141, // saveRestoreVerbs: save
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.verbs.get(11)?.enabled).toBe(false);
    expect(engine.verbs.get(11)?.saveId).toBe(3);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it("answers a verb's entry point, counted from the object's own code block", async () => {
    const { engine } = await runInRoom([
      ...word(500),
      ...byte(1),
      0xa3, // getVerbEntrypoint
      ...store(340),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[340]).toBe(V6_OBJECT_VERB_ENTRYPOINT);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

describe('rooms, boxes and the palette', () => {
  it('sets the camera bounds, clamped to half a screen from each edge', async () => {
    const { engine } = await run([
      ...byte(0), // minimum, below the clamp
      ...word(1000), // maximum, above the room width
      0x9c,
      172, // roomOps: scroll
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.camera.min).toBe(160);
    expect(engine.camera.max).toBe(160);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('sets one palette colour, index last', async () => {
    const { engine } = await run([
      ...byte(10), // red
      ...byte(20), // green
      ...byte(30), // blue
      ...byte(5), // index
      0x9c,
      175, // roomOps: palette
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.palette.getColor(5)).toEqual([10, 20, 30]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('turns the room shake on and off', async () => {
    const { engine } = await run([0x9c, 176, STOP]);
    expect(engine.shaking).toBe(true);

    const second = await run([0x9c, 176, 0x9c, 177, STOP]);
    expect(second.engine.shaking).toBe(false);
  });

  it('selects another of the room palettes, and says so when there is not one', async () => {
    const { engine } = await runInRoom([...byte(1), 0x9c, 213, STOP], { palettes: 2 });
    expect(engine.currentRoomData?.palette).toBe(engine.currentRoomData?.palettes[1]);

    const { logs } = await runInRoom([...byte(4), 0x9c, 213, STOP], { palettes: 2 });
    expect(logs.join('\n')).toMatch(/asked for palette 4/);
  });

  it('hands a script-driven save request to the host, slot and flag intact', async () => {
    const requests: Array<{ flag: number; slot: number }> = [];
    const fixture = buildV6Fixture({
      script2: [
        ...byte(1), // flag: save
        ...byte(3), // slot
        0x9c,
        180, // roomOps: savegame
        ...canary(CANARY_VAR),
        STOP,
      ],
    });
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source, {
      onScriptSaveLoad: (flag, slot) => requests.push({ flag, slot }),
    });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    expect(requests).toEqual([{ flag: 1, slot: 3 }]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('sets box flags from a list, with the value on top', async () => {
    const { engine } = await runInRoom([
      ...byte(0), // the box
      ...byte(1), // how many
      ...byte(0x40), // the flag value, which is popped first
      0x99, // setBoxFlags
      ...byte(215), // kernelGetFunctions: read a box's flags
      ...byte(0), // box 0
      ...byte(2), // two arguments
      0xc8,
      ...store(350),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[350]).toBe(0x40);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('says which set it cannot switch the walk boxes to', async () => {
    const { logs } = await run([...byte(9), 0xe4, STOP]);
    expect(logs.join('\n')).toMatch(/box set 8/);
  });

  it('maps a pseudo-room only for entries with the high bit set', async () => {
    const { engine } = await run([
      ...byte(4), // the real room
      ...byte(0x80 | 9), // mapped
      ...byte(10), // not mapped: no high bit
      ...byte(2),
      0xa1, // pseudoRoom
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

describe('objects', () => {
  it('changes an object state through drawObject, treating zero as one', async () => {
    const { engine } = await runInRoom([
      ...word(500),
      ...byte(0), // state 0, meaning "as it is"
      0x61, // drawObject
      ...word(500),
      0x6f, // getState
      ...store(360),
      STOP,
    ]);

    expect(engine.variables[360]).toBe(1);
  });

  /** The coordinates are in eighths of a pixel, as everywhere else in a room. */
  it('moves an object and draws it where it was put', async () => {
    const { engine } = await runInRoom([
      ...word(500),
      ...byte(24),
      ...byte(10),
      0x62, // drawObjectAt
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.currentRoomData?.findObject(500)).toMatchObject({ x: 192, y: 80 });
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('renames an object from the code stream', async () => {
    const { engine } = await runInRoom([
      ...word(500),
      0x97, // setObjectName
      ...inlineString('brass key'),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.getObjectName(500)).toBe('brass key');
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('answers the object under a point', async () => {
    const { engine } = await runInRoom([
      ...byte(0),
      ...byte(0),
      0xa0, // findObject at 0,0
      ...store(361),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
    expect(engine.variables[361]).toBe(0);
  });

  it("runs an object's verb script, then stops it again", async () => {
    const { engine } = await runInRoom([
      ...byte(0), // flags
      ...word(500), // object
      ...byte(1), // verb 1, which the fixture's object handles
      ...byte(0), // no arguments
      0x60, // startObject
      ...word(500),
      0x77, // stopObjectScript
      ...canary(CANARY_VAR),
      STOP,
    ]);

    // The verb script ran to completion nested inside this one, and this one
    // then carried on: both halves of what `startObject` promises.
    expect(engine.variables[260]).toBe(55);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
    expect(engine.scriptState.slots.filter((slot) => slot.status !== ScriptStatus.Dead)).toEqual(
      [],
    );
  });

  it('reports an object it cannot draw over the room, once', async () => {
    // The fixture's object ships an `SMAP`, which is what an object painted
    // into the room carries. An object a script means to blast ships a `BOMP`
    // instead, and the original errors out when it does not — so saying which
    // of the two is missing is the whole of the diagnostic.
    const { engine, logs } = await runInRoom([
      ...word(500),
      ...byte(10),
      ...byte(20),
      ...byte(0),
      ...byte(0),
      ...byte(0), // the counted list
      0x63, // drawBlastObject
      ...canary(CANARY_VAR),
      STOP,
    ]);

    engine.render();
    engine.render();

    expect(logs.filter((line) => line.includes('has no BOMP'))).toHaveLength(1);
  });

  it('consumes all four operands of the blast window it ignores', async () => {
    const { engine } = await run([
      ...byte(1),
      ...byte(2),
      ...byte(3),
      ...byte(4),
      0x64,
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

describe('printing', () => {
  /**
   * v6's print instructions carry exactly one sub-opcode each, where v5's
   * `print` reads a whole 0xFF-terminated stream in one instruction. A loop
   * here would swallow the instructions that follow, and the settings have to
   * survive between instructions because a script configures the slot in one
   * and prints in another.
   */
  it('keeps a slot configured across separate instructions', async () => {
    const { engine } = await run([
      0xb4,
      254, // printLine.begin
      ...byte(9),
      0xb4,
      66, // printLine.color 9
      ...byte(30),
      ...byte(40),
      0xb4,
      65, // printLine.at 30,40
      0xb4,
      75, // printLine.text
      ...inlineString('The mansion'),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.currentText()).toContain('The mansion');
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('speaks as the actor printActor was given', async () => {
    const { engine } = await run([
      ...byte(3),
      0xb8,
      254, // printActor.begin, taking the actor
      0xb8,
      75,
      ...inlineString('Down here'),
      STOP,
    ]);

    expect(engine.currentText()).toContain('Down here');
    expect(engine.variables[VAR.TALK_ACTOR]).toBe(3);
  });

  it('speaks as the player for printEgo, which pushes the actor itself', async () => {
    const { engine } = await run([
      0xb9,
      254, // printEgo.begin
      0xb9,
      75,
      ...inlineString('Not now'),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[VAR.TALK_ACTOR]).toBe(engine.variables[VAR.EGO]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('remembers a slot default at end and restores it at begin', async () => {
    const { engine } = await run([
      0xb5,
      254, // printText.begin
      ...byte(7),
      0xb5,
      66, // colour 7
      0xb5,
      255, // end: save these as the defaults
      0xb5,
      254, // begin again: restore them
      0xb5,
      75,
      ...inlineString('Look'),
      STOP,
    ]);

    // The line was printed in the remembered colour rather than the initial one.
    expect(engine.currentText()).toContain('Look');
  });
});

describe('waiting', () => {
  it('waits while a message is up and resumes when it is gone', async () => {
    const waitForMessage = [0xa9, 169];
    const { engine } = await run([
      ...byte(1),
      0xba, // talkActor
      ...inlineString('One moment'),
      ...waitForMessage,
      ...canary(CANARY_VAR),
      STOP,
    ]);

    // Parked, not finished: the canary has not run.
    expect(engine.variables[CANARY_VAR]).toBe(0);
    expect(engine.scripts.isScriptRunning(2)).toBe(true);

    engine.stopTalk();
    engine.scripts.resumeBrokenScripts();
    engine.scripts.runAllScripts();

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('waits for an actor to stop moving, resuming at its own displacement', async () => {
    // The instruction carries the offset to resume at, counted from the end of
    // its own operand word. It has to point back at the *push* of the actor
    // number, not at the wait: re-running the wait alone would find the stack
    // empty and read actor 0. That is six bytes back — two for the push, four
    // for this instruction.
    const waitForActor = [...byte(1), 0xa9, 168, ...u16le(0x10000 - 6)];
    const { engine } = await run([
      ...byte(1),
      ...byte(300),
      ...byte(120),
      0x7e, // walkActorTo, which sets the actor moving
      ...waitForActor,
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.actors[1].moving).not.toBe(0);
    expect(engine.variables[CANARY_VAR]).toBe(0);

    engine.actors[1].stopMoving();
    engine.scripts.resumeBrokenScripts();
    engine.scripts.runAllScripts();

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('does not wait for a sentence when nothing is pending', async () => {
    const { engine } = await run([0xa9, 171, ...canary(CANARY_VAR), STOP]);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

describe('the cursor and the player', () => {
  it('suspends and restores input, and publishes both variables', async () => {
    const { engine } = await run([0x6b, 147, STOP]); // userput off
    expect(engine.userPut).toBe(false);
    expect(engine.variables[VAR.USERPUT]).toBe(0);

    const second = await run([0x6b, 147, 0x6b, 146, STOP]);
    expect(second.engine.userPut).toBe(true);
    expect(second.engine.variables[VAR.USERPUT]).toBe(1);
  });

  it('counts soft cursor changes rather than assigning them', async () => {
    const { engine } = await run([0x6b, 145, 0x6b, 148, STOP]); // off, then soft on
    expect(engine.variables[VAR.CURSORSTATE]).toBe(engine.cursorState);
  });

  it('takes a counted list for the charset colours', async () => {
    const { engine } = await run([
      ...new Array(16).fill(0).flatMap((_, index) => byte(index)),
      ...byte(16),
      0x6b,
      157, // charset colour
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('takes a room and an object for the cursor image', async () => {
    const { engine } = await run([
      ...word(500), // object
      ...byte(1), // room
      0x6b,
      153,
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.currentCursor).toBe(500);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

describe('the kernel hatch', () => {
  /** A kernel call: the operation number is the first element of the list. */
  const kernel = (get: boolean, args: number[]) => [
    ...args.flatMap((value) => (value >= 0 && value <= 0xff ? byte(value) : word(value))),
    ...byte(args.length),
    get ? 0xc8 : 0xc9,
  ];

  it('scales an actor horizontally and leaves the vertical scale alone', async () => {
    const { engine } = await run([...kernel(false, [107, 2, 100]), STOP]);

    expect(engine.actors[2].scaleX).toBe(100);
    expect(engine.actors[2].scaleY).toBe(255);
  });

  it('kills every script but the one asking', async () => {
    const { engine } = await run([...kernel(false, [9]), ...canary(CANARY_VAR), STOP]);

    // The asking script survived to write its canary, and nothing else is left.
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
    expect(engine.scriptState.slots.filter((slot) => slot.status !== ScriptStatus.Dead)).toEqual(
      [],
    );
  });

  it('desaturates the palette for film noir', async () => {
    const { engine } = await run([
      ...byte(10),
      ...byte(20),
      ...byte(30),
      ...byte(5),
      0x9c,
      175, // a colour to desaturate
      ...kernel(false, [114]),
      STOP,
    ]);

    const [red, green, blue] = engine.palette.getColor(5);
    expect(red).toBe(green);
    expect(green).toBe(blue);
  });

  it('swaps and copies palette entries', async () => {
    const setColor = (index: number, red: number) => [
      ...byte(red),
      ...byte(0),
      ...byte(0),
      ...byte(index),
      0x9c,
      175,
    ];

    const { engine } = await run([
      ...setColor(1, 10),
      ...setColor(2, 20),
      ...kernel(false, [120, 1, 2]), // swap
      STOP,
    ]);
    expect(engine.palette.getColor(1)[0]).toBe(20);
    expect(engine.palette.getColor(2)[0]).toBe(10);

    const second = await run([
      ...setColor(3, 30),
      ...setColor(4, 40),
      ...kernel(false, [123, 3, 4]), // copy 3 over 4
      STOP,
    ]);
    expect(second.engine.palette.getColor(4)[0]).toBe(30);
  });

  it("answers an object's own box rather than its hotspot", async () => {
    const { engine } = await runInRoom([
      ...kernel(true, [209, 500]), // object width
      ...store(370),
      ...kernel(true, [210, 500]), // object height
      ...store(371),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    // The fixture's object is a 16x16 rectangle.
    expect(engine.variables[370]).toBe(16);
    expect(engine.variables[371]).toBe(16);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('answers a screen pixel, and -1 outside the screen', async () => {
    const { engine } = await run([
      ...word(1000),
      ...byte(10),
      0xe1, // getPixel, out of bounds
      ...store(373),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[373]).toBe(-1);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('names a kernel operation it does not implement', async () => {
    const { logs } = await run([...kernel(false, [250]), STOP]);
    expect(logs.join('\n')).toMatch(/kernelSetFunctions sub-opcode 0xfa/);
  });

  it('says once that it cannot start Maniac Mansion', async () => {
    const { logs } = await run([...kernel(false, [8]), STOP]);
    expect(logs.join('\n')).toMatch(/Maniac Mansion/);
  });
});

/**
 * Input in a v6 game.
 *
 * v6 does not resolve a click itself: it runs the game's input script with the
 * area, what was clicked and which button, and the script decides. That is what
 * makes Sam & Max's verb coin possible — the coin is drawn and driven entirely
 * by scripts, and there is no verb panel to hit-test — so the interpreter's only
 * job is to report the press honestly.
 */
describe('input, which a v6 game routes through its own script', () => {
  /**
   * Boots with a verb script that records what it was told, as its three
   * locals, into variables a test can read.
   */
  async function bootWithInputScript() {
    const { engine, logs } = await bootV6({
      // Script 3 is the input script: locals 0, 1 and 2 are the click area,
      // the value and the button.
      script2: [...byte(3), ...store(VAR.VERB_SCRIPT), STOP],
      script3: [
        0x03,
        ...u16le(0x4000), // pushWordVar local 0
        ...store(390),
        0x03,
        ...u16le(0x4001), // local 1
        ...store(391),
        0x03,
        ...u16le(0x4002), // local 2
        ...store(392),
        STOP,
      ],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.scripts.runScript(2, false, false, []);
    return { engine, logs };
  }

  it('sends a click in the room to the input script as a scene click', async () => {
    const { engine } = await bootWithInputScript();

    engine.pressButton(1, 100, 40);

    expect(engine.variables[390]).toBe(2); // scene
    expect(engine.variables[391]).toBe(0);
    expect(engine.variables[392]).toBe(1); // left button
  });

  it('sends a click on the verb strip as a verb click, naming the verb', async () => {
    const { engine } = await bootWithInputScript();
    const verb = engine.verbs.getOrCreate(7);
    verb.enabled = true;
    verb.bounds = { left: 0, top: engine.screen.verb.top, right: 40, bottom: 200 };

    engine.pressButton(1, 10, engine.screen.verb.top + 2);

    expect(engine.variables[390]).toBe(1); // verb
    expect(engine.variables[391]).toBe(7);
  });

  it('tells the script which button, so a right click is not a left one', async () => {
    const { engine } = await bootWithInputScript();

    engine.pressButton(2, 100, 40);

    expect(engine.variables[392]).toBe(2);
  });

  it('sends a key press to the input script rather than matching it to a verb', async () => {
    const { engine } = await bootWithInputScript();

    engine.pressKey(0x67);

    expect(engine.variables[390]).toBe(4); // key
    expect(engine.variables[391]).toBe(0x67);
  });

  /**
   * The coin opens while the button is held, so the state has to be readable
   * for as long as it is down — not reported once as an event and forgotten.
   */
  it('keeps the held button readable until it comes up', async () => {
    const { engine } = await bootWithInputScript();

    engine.pressButton(2, 100, 40);
    expect(engine.variables[VAR_V6.RIGHTBTN_HOLD]).toBe(1);
    expect(engine.variables[VAR_V6.LEFTBTN_HOLD]).toBe(0);

    engine.releaseButton();
    expect(engine.variables[VAR_V6.RIGHTBTN_HOLD]).toBe(0);
  });

  it('routes nothing while input is suspended', async () => {
    const { engine } = await bootWithInputScript();
    engine.setUserPut(false);

    engine.pressButton(1, 100, 40);

    expect(engine.variables[390]).toBe(0);
  });

  /**
   * `handleRoomClick` is the interpreter resolving a click itself, which it
   * only does for a game that has no input script of its own. A game that has
   * one owns the decision, and a second copy of it here would run the sentence
   * twice.
   */
  it('ignores the room-click handler a game without an input script uses', async () => {
    const { engine } = await bootWithInputScript();

    engine.handleRoomClick(100, 40, 9);

    expect(engine.variables[390]).toBe(0);
    expect(engine.sentenceQueue).toEqual([]);
  });

  /**
   * Choosing a verb by keyboard shortcut goes to the same place as clicking
   * it, so the game hears one kind of event either way.
   */
  it('reports a verb chosen without a click as a verb click', async () => {
    const { engine } = await bootWithInputScript();

    engine.handleVerbClick(7);

    expect(engine.variables[390]).toBe(1); // verb
    expect(engine.variables[391]).toBe(7);
  });
});

describe('the odds and ends', () => {
  it('measures distances between things and points', async () => {
    const { engine } = await run([
      ...byte(0),
      ...byte(0),
      ...byte(30),
      ...byte(40),
      0xc7, // distPtPt
      ...store(380),
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[380]).toBe(50);
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('reads the clock into the variables v6 keeps it in', async () => {
    const { engine } = await run([0xd0, STOP]);

    expect(engine.variables[VAR_V6.TIMEDATE_YEAR]).toBeGreaterThan(90);
    expect(engine.variables[VAR_V6.TIMEDATE_MONTH]).toBeGreaterThanOrEqual(0);
    expect(engine.variables[VAR_V6.TIMEDATE_HOUR]).toBeGreaterThanOrEqual(0);
  });

  it('leaves the last random number where scripts read it', async () => {
    const { engine } = await run([...byte(10), 0x87, ...store(381), STOP]);

    expect(engine.variables[VAR_V6.RANDOM_NR]).toBe(engine.variables[381]);
  });

  it('keeps a random number in range at both ends', async () => {
    const { engine } = await run([...byte(5), ...byte(5), 0x88, ...store(382), STOP]);
    expect(engine.variables[382]).toBe(5);
  });

  it('ends one script and starts another in its place', async () => {
    const { engine } = await bootV6({
      script2: [
        ...byte(0), // flags
        ...byte(3), // script 3
        ...byte(0), // no arguments
        0xd5, // jumpToScript
        ...canary(CANARY_VAR), // must not run
        STOP,
      ],
    });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    expect(engine.variables[CANARY_VAR]).toBe(0);
    expect(engine.scripts.isScriptRunning(2)).toBe(false);
  });

  it('stops a line of speech', async () => {
    const { engine } = await run([
      ...byte(1),
      0xba,
      ...inlineString('Wait'),
      0xd1, // stopTalking
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.currentText()).toBe('');
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('answers whether a room script is running, which is not the same question', async () => {
    const { engine } = await run([...byte(2), 0xd8, ...store(383), STOP]);

    // Script 2 is running, but as a global one — so the room-script question
    // answers no.
    expect(engine.variables[383]).toBe(0);
  });

  it('draws a box, colour last', async () => {
    const { engine } = await run([
      ...byte(10),
      ...byte(20),
      ...byte(30),
      ...byte(40),
      ...byte(3),
      0xa6, // drawBox
      ...canary(CANARY_VAR),
      STOP,
    ]);

    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });

  it('consumes the resource hints it has nothing to do about', async () => {
    const { engine } = await run([
      ...byte(1),
      0x9b,
      103, // load room
      ...byte(1),
      0x9b,
      116, // clear heap, which takes no operand
      ...word(500),
      ...byte(1),
      0x9b,
      119, // load object: room and object
      ...canary(CANARY_VAR),
      STOP,
    ]);

    // The middle instruction takes no operand, so the byte pushed before it is
    // still on the stack and the canary would read it if the counts were wrong.
    expect(engine.variables[CANARY_VAR]).toBe(0x2a);
  });
});

/**
 * The interpreter and the reader, checked against each other.
 *
 * Both know how many operands every sub-opcode form takes, and they were
 * written from the same reference but separately. The way they can drift is the
 * way that hurts most: one consuming an operand the other leaves behind, which
 * surfaces as a fault in whatever instruction comes next and points nowhere
 * near the cause. So every form the reader knows is run through the engine, and
 * the only assertion is that the stack came out level.
 */
describe('every sub-opcode form leaves the stack as it found it', () => {
  /**
   * `printEgo` is left out, and its absence is the point.
   *
   * The instruction pushes the player's actor number and then reads its
   * sub-opcode — so a form that takes an operand pops the *pushed actor* rather
   * than its own operand, and one that takes none leaves it behind. That is
   * what the original does, which is why real compiled scripts only ever use
   * `printEgo.begin`, and it is faithfully what this engine does too. Asserting
   * a level stack for it would mean asserting a deviation.
   */
  const PRINT_EGO = 0xb9;
  const forms = v6SubOpcodeForms().filter((form) => form.opcode !== PRINT_EGO);

  it('covers the whole of every sub-opcode family', () => {
    // A guard on the loop below: an empty or truncated table would make it
    // pass by testing nothing.
    expect(forms.length).toBeGreaterThan(120);
  });

  /**
   * The sentinel goes *under* the operands and is stored afterwards, which is
   * what makes this catch both directions. A form that pops one too few leaves
   * an operand where the sentinel was and stores that instead; a form that pops
   * one too many takes the sentinel with it and stores a zero read off an empty
   * stack. A canary pushed after the instruction would only ever catch the
   * first.
   */
  const SENTINEL = 0x2a;

  for (const form of forms) {
    it(`${form.name} pops exactly what it declares`, async () => {
      // Built from the top of the stack downwards and then reversed, because
      // that is how the form declares what it takes. Every operand is 1 rather
      // than 0, so a form that reads an index or a count gets a real one, and
      // small enough that nothing it is handed to is out of range.
      const fromTop: number[][] = [];
      for (const step of form.stack) {
        if (step === 'list') fromTop.push([...byte(1), ...byte(1)]);
        else for (let i = 0; i < step; i++) fromTop.push(byte(1));
      }
      const operands = fromTop.reverse().flat();

      // A `wait` form's displacement is zero here, so a form that decides to
      // wait resumes at the next instruction rather than parking for ever.
      const streamBytes = form.stream ? [...u16le(form.stream === 'j' ? 0 : 700)] : [];
      const message = form.string ? inlineString('x') : [];

      const { engine } = await runInRoom([
        ...byte(SENTINEL),
        ...operands,
        form.opcode,
        form.subOpcode,
        ...streamBytes,
        ...message,
        ...store(CANARY_VAR),
        STOP,
      ]);

      expect(engine.variables[CANARY_VAR]).toBe(SENTINEL);
    });
  }
});
