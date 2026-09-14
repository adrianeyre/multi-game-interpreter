import { describe, expect, it } from 'vitest';
import { GUARD_ANY } from '../src/engine/agos/script/subroutines.js';
import { AgosInterpreter, AgosState } from '../src/engine/agos/script/AgosInterpreter.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { formatSubroutineBlock, unnamedOpcodes } from '../src/authoring/agos/disassemble.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type {
  AgosSubroutineBlock,
  AgosInstruction,
} from '../src/engine/agos/script/subroutines.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import { buildGamePc } from './fixtureAgos.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

/**
 * The opcode number for a handler name, in Simon 1's table.
 *
 * Looked up rather than written down. Seven Versions number their opcodes
 * differently and this project's tables are generated, so a hardcoded number
 * here would be a second, silently drifting copy of the table — which is the
 * failure the generator exists to avoid.
 */
function opcodeFor(name: string): number {
  const index = OPCODE_NAMES.simon1!.indexOf(name);
  if (index < 0) throw new Error(`Simon 1 has no opcode called ${name}`);
  return index;
}

const O_ZERO = opcodeFor('o_zero');
const O_LET = opcodeFor('o_let');
const O_PLACE = opcodeFor('o_place');
const INVERT = 0;

function instruction(opcode: number, ...operands: AgosInstruction['operands']): AgosInstruction {
  return { opcode, operands };
}

function blockOf(instructions: AgosInstruction[]): AgosSubroutineBlock {
  return {
    subroutines: [{ id: 1, lines: [{ instructions }], endMarker: 0xffff }],
    endMarker: 0xffff,
  };
}

function stateFor(): AgosState {
  return new AgosState(readGamePc(buildGamePc({ withSpeech: true }), SIMON1).items);
}

describe('a line is a conjunction, which is what AGOS has instead of an if', () => {
  it('runs on while each condition holds', () => {
    const state = stateFor();
    state.write(5, 0);
    const run = new AgosInterpreter(
      blockOf([
        instruction(O_ZERO, { kind: 'byte', value: 5 }),
        instruction(O_LET, { kind: 'byte', value: 9 }, { kind: 'word', value: 42 }),
      ]),
      state,
      SIMON1,
    );

    run.run(1);

    expect(state.read(9)).toBe(42);
    expect(run.report.linesStopped).toBe(0);
  });

  it('stops the line at the first condition that fails', () => {
    const state = stateFor();
    state.write(5, 7); // so o_zero is false
    const run = new AgosInterpreter(
      blockOf([
        instruction(O_ZERO, { kind: 'byte', value: 5 }),
        instruction(O_LET, { kind: 'byte', value: 9 }, { kind: 'word', value: 42 }),
      ]),
      state,
      SIMON1,
    );

    run.run(1);

    // The assignment never happened, which is the whole of AGOS's control flow.
    expect(state.read(9)).toBe(0);
    expect(run.report.linesStopped).toBe(1);
  });

  it('inverts the sense of the instruction that follows opcode 0', () => {
    const state = stateFor();
    state.write(5, 7);
    const run = new AgosInterpreter(
      blockOf([
        instruction(INVERT),
        instruction(O_ZERO, { kind: 'byte', value: 5 }),
        instruction(O_LET, { kind: 'byte', value: 9 }, { kind: 'word', value: 1 }),
      ]),
      state,
      SIMON1,
    );

    run.run(1);

    // "unless var5 is zero" — and it is not, so the line carries on.
    expect(state.read(9)).toBe(1);
  });
});

describe('what the interpreter does not implement, it reports', () => {
  /**
   * The discipline this file exists to keep: an unimplemented opcode is a named
   * gap, not a silent no-op. A no-op produces a game that runs and is wrong,
   * which is the failure this project's documentation spends most of its time
   * trying to avoid.
   */
  /**
   * Every opcode in Simon 1's table now has a case, so this cannot be tested
   * with an opcode that has none. It is tested with one whose case *records a
   * gap*: `os1_getPathPosn` answers "where you asked" because a room's walk
   * path table is graphics data this engine does not read, and it says so.
   *
   * This test has now rotted twice, both times because the opcode it named was
   * implemented — which is a good reason to fail but a bad way to find out.
   * Picking one whose gap is structural rather than merely unwritten is what
   * stops it happening a third time.
   */
  it('names an opcode it cannot fully run rather than passing over it', () => {
    const state = stateFor();
    const run = new AgosInterpreter(
      blockOf([
        instruction(
          opcodeFor('os1_getPathPosn'),
          { kind: 'word', value: 10 },
          { kind: 'word', value: 20 },
          { kind: 'byte', value: 1 },
          { kind: 'byte', value: 2 },
        ),
      ]),
      state,
      SIMON1,
    );

    run.run(1);

    expect(run.report.unimplemented).toHaveLength(1);
    expect(run.report.unimplemented[0]).toContain('os1_getPathPosn');
  });

  it('carries on past one, so the gap does not look like a failed condition', () => {
    const state = stateFor();
    const run = new AgosInterpreter(
      blockOf([
        instruction(
          opcodeFor('os1_getPathPosn'),
          { kind: 'word', value: 0 },
          { kind: 'word', value: 0 },
          { kind: 'byte', value: 1 },
          { kind: 'byte', value: 2 },
        ),
        instruction(O_LET, { kind: 'byte', value: 4 }, { kind: 'word', value: 8 }),
      ]),
      state,
      SIMON1,
    );

    run.run(1);

    expect(state.read(4)).toBe(8);
  });
});

describe('moving items is how an AGOS world changes', () => {
  it('re-parents an item and leaves the tree navigable from both ends', () => {
    const state = stateFor();

    expect(state.parentOf(3)).toBe(2);
    new AgosInterpreter(
      blockOf([
        instruction(
          O_PLACE,
          { kind: 'item', lead: 0, id: 1 },
          { kind: 'item', lead: 0, id: 0xfffffffd },
        ),
      ]),
      state,
      SIMON1,
    ).run(1);

    // Item 3 placed into item 0xFFFFFFFF+2, which is nothing: destroyed.
    expect(state.parentOf(3)).not.toBe(2);
  });
});

describe('a verb reaches code through the verb table', () => {
  it('runs the lines whose guard matches the verb', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    const run = new AgosInterpreter(game.subroutines, state, SIMON1);

    expect(run.runVerb(101, 202, 303)).toBe(true);
    expect(run.runVerb(999)).toBe(false);
  });

  /**
   * The wildcard, which for a long time this could not recognise.
   *
   * A guard's words are read **unsigned**, so the "any noun" sentinel arrives
   * as `0xFFFF`. The match tested it against `-1` — the same bits read signed
   * — so it saw 65535, took that for a real noun, found it did not equal what
   * the player had clicked, and skipped the line.
   *
   * The scale is the reason this has a test of its own rather than a note. In
   * Simon 1's DOS floppy demo **every** noun slot in the verb table is that
   * value, 74 of 74, and no guard anywhere holds `-1`. So on real data almost
   * nothing a player did could reach code at all.
   */
  it('matches a guard whose noun is the stored 0xFFFF wildcard', () => {
    const block = {
      endMarker: 0xffff,
      subroutines: [
        {
          id: 0,
          endMarker: 0xffff,
          // Guarded by a verb, and by "any" for both nouns — the shape almost
          // every real line has.
          lines: [
            {
              guard: { verb: 7, noun1: GUARD_ANY, noun2: GUARD_ANY },
              instructions: [],
            },
          ],
        },
      ],
    };
    const state = new AgosState([]);
    const run = new AgosInterpreter(block, state, SIMON1);

    // Any nouns at all must reach it, including none.
    expect(run.runVerb(7, 42, 99)).toBe(true);
    expect(run.runVerb(7)).toBe(true);
    // A different verb still must not.
    expect(run.runVerb(8, 42, 99)).toBe(false);
  });

  it('still honours a guard that names a real noun', () => {
    // The other half: making the wildcard work must not make every guard a
    // wildcard, or every verb would run every line.
    const block = {
      endMarker: 0xffff,
      subroutines: [
        {
          id: 0,
          endMarker: 0xffff,
          lines: [{ guard: { verb: 7, noun1: 42, noun2: GUARD_ANY }, instructions: [] }],
        },
      ],
    };
    const run = new AgosInterpreter(block, new AgosState([]), SIMON1);

    expect(run.runVerb(7, 42, 1)).toBe(true);
    expect(run.runVerb(7, 43, 1)).toBe(false);
  });
});

describe('the disassembly listing', () => {
  it('names opcodes rather than printing numbers', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const listing = formatSubroutineBlock(game.subroutines, SIMON1);

    expect(listing).toContain('subroutine 0');
    expect(listing).toContain('; verb 101');
    expect(listing).toContain('o_at');
    // Reconstructs no control flow, because there is none in the instructions.
    expect(listing).not.toContain('if ');
  });

  it('counts opcodes this project cannot name, which is a wrong Target or a gap', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);

    expect(unnamedOpcodes(game.subroutines, SIMON1)).toEqual([]);
  });
});

describe('timers are how anything happens later', () => {
  /**
   * AGOS's whole notion of "later": a script says *run subroutine 160 in three
   * seconds* and stops caring. The game's own opening move is one of these, so
   * a game with no clock does not merely lose its timers — it never starts.
   */
  function withTimer(): AgosState {
    const state = new AgosState(readGamePc(buildGamePc({ withSpeech: true }), SIMON1).items);
    return state;
  }

  it('runs a queued Subroutine once its time has come, and not before', () => {
    const state = withTimer();
    const block = {
      subroutines: [
        {
          id: 1,
          lines: [
            {
              instructions: [
                {
                  opcode: opcodeFor('o_when'),
                  operands: [
                    { kind: 'word' as const, value: 3 },
                    { kind: 'word' as const, value: 2 },
                  ],
                },
              ],
            },
          ],
          endMarker: 0xffff,
        },
        {
          id: 2,
          lines: [
            {
              instructions: [
                {
                  opcode: opcodeFor('o_let'),
                  operands: [
                    { kind: 'byte' as const, value: 40 },
                    { kind: 'word' as const, value: 7 },
                  ],
                },
              ],
            },
          ],
          endMarker: 0xffff,
        },
      ],
      endMarker: 0xffff,
    };
    const run = new AgosInterpreter(block, state, SIMON1);

    run.run(1);
    expect(run.runDueEvents(2)).toBe(0);
    expect(state.read(40)).toBe(0);

    expect(run.runDueEvents(3)).toBe(1);
    expect(state.read(40)).toBe(7);
    // Taken off the queue before it ran, so it does not run again.
    expect(run.runDueEvents(10)).toBe(0);
  });
});

describe('the words a game asks to show', () => {
  /**
   * Collected rather than drawn. A font renderer is separate work and a game's
   * words are worth having before it exists: they are the fastest evidence the
   * interpreter is walking the same path the game does.
   */
  it('resolves a message operand through the string pool', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    const run = new AgosInterpreter(
      blockOf([
        {
          opcode: opcodeFor('o_msg'),
          operands: [{ kind: 'string', lead: 1, id: 1 }],
        },
      ]),
      state,
      SIMON1,
      undefined,
      game.strings,
    );

    run.run(1);

    expect(state.messages).toEqual(['two']);
  });
});

describe('item classes and chance', () => {
  function stateAnd(instructions: AgosInstruction[], random = () => 0.5) {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    const run = new AgosInterpreter(
      blockOf(instructions),
      state,
      SIMON1,
      undefined,
      game.strings,
      random,
    );
    run.run(1);
    return { state, run };
  }

  it('sets and tests a class flag, which is how AGOS groups items', () => {
    const { state } = stateAnd([
      {
        opcode: opcodeFor('o_setClass'),
        operands: [
          { kind: 'item', lead: 0, id: 0 },
          { kind: 'byte', value: 3 },
        ],
      },
    ]);

    expect(state.classFlags.get(2)).toBe(1 << 3);
  });

  it('says what an item is from the sub-structures hanging off it', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    const run = new AgosInterpreter(
      blockOf([
        {
          opcode: opcodeFor('o_isRoom'),
          operands: [{ kind: 'item', lead: 0, id: 0 }],
        },
        {
          opcode: opcodeFor('o_let'),
          operands: [
            { kind: 'byte', value: 12 },
            { kind: 'word', value: 1 },
          ],
        },
      ]),
      state,
      SIMON1,
    );

    run.run(1);

    // Item 2 carries a room sub-structure, so the condition held and the line
    // carried on to the assignment.
    expect(state.read(12)).toBe(1);
  });

  it('takes a chance against a source a test can pin', () => {
    const always = stateAnd(
      [
        { opcode: opcodeFor('o_chance'), operands: [{ kind: 'word', value: 60 }] },
        {
          opcode: opcodeFor('o_let'),
          operands: [
            { kind: 'byte', value: 3 },
            { kind: 'word', value: 9 },
          ],
        },
      ],
      () => 0.1,
    );
    const never = stateAnd(
      [
        { opcode: opcodeFor('o_chance'), operands: [{ kind: 'word', value: 60 }] },
        {
          opcode: opcodeFor('o_let'),
          operands: [
            { kind: 'byte', value: 3 },
            { kind: 'word', value: 9 },
          ],
        },
      ],
      () => 0.9,
    );

    expect(always.state.read(3)).toBe(9);
    expect(never.state.read(3)).toBe(0);
  });
});

describe('the talkie operand reaches the speaker', () => {
  /**
   * The loop closing on the finding that started this branch. ADR 0027's
   * tripwire fired because a talkie decodes two opcodes with an extra operand;
   * that operand is the **speech id**, and this is it arriving where it was
   * always going. A floppy release has no such operand, so nothing here asks
   * which release it is.
   */
  it('plays the line a talkie names and stays silent where a floppy does not', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    const played: number[] = [];
    const run = new AgosInterpreter(
      blockOf([
        {
          // `os1_screenTextMsg`, which is the opcode that *says* a line. This
          // was written against `oww_setLongText` and that one records a
          // room object's description for later rather than showing it — see
          // `AgosState.longText`.
          opcode: opcodeFor('os1_screenTextMsg'),
          operands: [
            { kind: 'byte', value: 1 },
            { kind: 'byte', value: 0 },
            { kind: 'string', lead: 1, id: 2 },
            { kind: 'word', value: 4242 },
          ],
        },
      ]),
      state,
      SIMON1,
      {
        loadZone: () => false,
        animate: () => false,
        playSpeech: (id) => {
          played.push(id);
          // Two seconds of recording, which is what a script waiting on speech
          // is told to wait for.
          return 2;
        },
      },
      game.strings,
    );

    run.run(1);

    expect(played).toEqual([4242]);
    expect(state.messages).toEqual(['three']);
  });

  it('says nothing when the operand is absent, which is a floppy release', () => {
    // Read with a floppy Target, because a floppy file read as a talkie is the
    // very misdecode ADR 0027's amendment exists to prevent — and it throws
    // here rather than quietly producing a line with no speech.
    const floppy = { ...SIMON1, releaseKind: 'floppy' as const };
    const game = readGamePc(buildGamePc({ withSpeech: false }), floppy);
    const state = new AgosState(game.items);
    const played: number[] = [];
    const run = new AgosInterpreter(
      blockOf([
        {
          opcode: opcodeFor('oww_setLongText'),
          operands: [
            { kind: 'byte', value: 1 },
            { kind: 'string', lead: 1, id: 2 },
          ],
        },
      ]),
      state,
      floppy,
      {
        loadZone: () => false,
        animate: () => false,
        playSpeech: (id) => {
          played.push(id);
          // Two seconds of recording, which is what a script waiting on speech
          // is told to wait for.
          return 2;
        },
      },
      game.strings,
    );

    run.run(1);

    expect(played).toEqual([]);
  });
});

describe('a script waiting on speech waits the same whether or not anyone hears it', () => {
  /**
   * `CONTEXT.md`'s **Speech wait**: the timing comes from the recording, so an
   * interpreter that plays speech and does not know its length runs a talkie at
   * a speed it was never written for.
   */
  it('holds time events until the line finishes', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    const run = new AgosInterpreter(
      blockOf([
        {
          opcode: opcodeFor('os1_screenTextMsg'),
          operands: [
            { kind: 'byte', value: 1 },
            { kind: 'byte', value: 0 },
            { kind: 'string', lead: 1, id: 0 },
            { kind: 'word', value: 5 },
          ],
        },
        {
          opcode: opcodeFor('o_when'),
          operands: [
            { kind: 'word', value: 0 },
            { kind: 'word', value: 9 },
          ],
        },
      ]),
      state,
      SIMON1,
      {
        loadZone: () => false,
        animate: () => false,
        playSpeech: () => 2,
      },
      game.strings,
    );

    run.run(1);
    expect(state.speechUntil).toBe(2);

    // The queued event is due immediately and still does not run: the line is
    // still being spoken.
    expect(run.runDueEvents(1)).toBe(0);
    expect(run.runDueEvents(2)).toBe(1);
  });
});
