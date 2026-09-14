import { describe, expect, it } from 'vitest';
import {
  instructionWords,
  isSword1Token,
  IT,
  parseSword1ScriptModule,
  sword1TokenName,
  Sword1ScriptError,
} from '../src/engine/sword1/script/swordTokens.js';
import {
  checkSword1ScriptModule,
  interpretSword1Script,
  SWORD1_MAX_STACK,
  type SwordScriptHost,
} from '../src/engine/sword1/script/SwordInterpreter.js';
import {
  SwordCompact,
  SWORD1_COMPACT_WORDS,
  CPT,
} from '../src/engine/sword1/resource/swordCompact.js';
import { buildScriptResource } from './fixtureSword.js';
import { SWORD1_HEADER_SIZE } from '../src/engine/sword1/resource/swordDefs.js';
import {
  Sword1HelperScript,
  Sword1StartOpcode,
  SWORD1_HELPER_DATA,
  SWORD1_MAX_START_POSITION,
  SWORD1_START_DATA,
  SWORD1_UNTERMINATED_START_DATA,
} from '../src/engine/sword1/script/startPositions.js';

/** A compact with room for every field a script can reach. */
function compact(id = 0x100000): SwordCompact {
  return new SwordCompact(new Int32Array(SWORD1_COMPACT_WORDS), id);
}

/** A host that records what the script asked for. */
function host(overrides: Partial<SwordScriptHost> = {}): SwordScriptHost & {
  vars: Map<number, number>;
  calls: Array<{ number: number; args: number[] }>;
  faults: string[];
} {
  const vars = new Map<number, number>();
  const calls: Array<{ number: number; args: number[] }> = [];
  const faults: string[] = [];
  return {
    vars,
    calls,
    faults,
    getVar: (number) => vars.get(number) ?? 0,
    setVar: (number, value) => void vars.set(number, value),
    callMcode: (number, args) => {
      calls.push({ number, args: [...args] });
      return 1;
    },
    onFault: (message) => void faults.push(message),
    ...overrides,
  };
}

/** Runs a single script's words through the machine. */
function run(words: number[], scriptHost = host(), target = compact()) {
  const resource = buildScriptResource([words]);
  const module = parseSword1ScriptModule(resource.subarray(SWORD1_HEADER_SIZE));
  return {
    result: interpretSword1Script(module, scriptHost, target, target.id, 0, 0),
    scriptHost,
    target,
  };
}

describe('the token table', () => {
  it('derives every instruction length from the instruction itself', () => {
    // The claim the family's Decompilation rests on: a fixed-operand token, the
    // two-operand mcode call, and a switch whose count is its first operand.
    const code = Int32Array.from([
      IT.PUSHNUMBER,
      7,
      IT.MCODE,
      42,
      1,
      IT.SWITCH,
      2,
      10,
      5,
      20,
      8,
      8,
      IT.SCRIPTEND,
    ]);
    expect(instructionWords(code, 0)).toBe(2);
    expect(instructionWords(code, 2)).toBe(3);
    expect(instructionWords(code, 5)).toBe(3 + 2 * 2);
    expect(instructionWords(code, 12)).toBe(1);
  });

  it('answers zero for a word that is not a token, so data is told from code', () => {
    expect(instructionWords(Int32Array.from([999]), 0)).toBe(0);
    expect(isSword1Token(999)).toBe(false);
    expect(sword1TokenName(999)).toBe('token999');
  });

  it('keeps Revolution’s spelling of IT_DEVIDE', () => {
    expect(sword1TokenName(IT.DEVIDE)).toBe('IT_DEVIDE');
  });
});

describe('reading a script module', () => {
  it('refuses a payload that is not a whole number of words', () => {
    expect(() => parseSword1ScriptModule(new Uint8Array(6))).toThrow(Sword1ScriptError);
  });

  it('refuses a script version other than the one every release ships', () => {
    expect(() => checkSword1ScriptModule('Script', 12)).toThrow(/version 12/);
    expect(() => checkSword1ScriptModule('File', 13)).toThrow(/not bytecode/);
  });
});

describe('the script machine', () => {
  it('pushes, adds and pops to a variable', () => {
    const { scriptHost } = run([
      IT.PUSHNUMBER,
      20,
      IT.PUSHNUMBER,
      22,
      IT.PLUS,
      IT.POPVAR,
      5,
      IT.SCRIPTEND,
    ]);
    expect(scriptHost.vars.get(5)).toBe(42);
  });

  it('reads and writes a compact by byte offset, which is what the bytecode does', () => {
    const target = compact();
    target.set(CPT.YCOORD, 300);
    const { scriptHost } = run(
      [
        IT.PUSHLONGOFFSET,
        CPT.YCOORD,
        IT.PUSHNUMBER,
        8,
        IT.MINUS,
        IT.POPLONGOFFSET,
        CPT.YCOORD,
        IT.PUSHLONGOFFSET,
        CPT.YCOORD,
        IT.POPVAR,
        1,
        IT.SCRIPTEND,
      ],
      host(),
      target,
    );
    expect(target.get(CPT.YCOORD)).toBe(292);
    expect(scriptHost.vars.get(1)).toBe(292);
  });

  it('masks a word offset to sixteen bits, both ways', () => {
    const target = compact();
    target.set(CPT.TAG, -1);
    const { scriptHost } = run(
      [IT.PUSHWORDOFFSET, CPT.TAG, IT.POPVAR, 2, IT.SCRIPTEND],
      host(),
      target,
    );
    expect(scriptHost.vars.get(2)).toBe(0xffff);
  });

  it('hands an mcode its arguments in script order, not stack order', () => {
    const { scriptHost } = run([
      IT.PUSHNUMBER,
      1,
      IT.PUSHNUMBER,
      2,
      IT.PUSHNUMBER,
      3,
      IT.MCODE,
      69,
      3,
      IT.SCRIPTEND,
    ]);
    expect(scriptHost.calls).toEqual([{ number: 69, args: [1, 2, 3] }]);
  });

  it('stops the cycle where an mcode returns zero, and resumes after it', () => {
    const stopping = host({ callMcode: () => 0 });
    const words = [IT.MCODE, 5, 0, IT.PUSHNUMBER, 1, IT.SCRIPTEND];
    const { result } = run(words, stopping);
    // The pc it answers is past the mcode call, so next cycle starts at the
    // push rather than calling the mcode again.
    expect(result.pc).toBe(1 + 1 + 3);
  });

  it('skips forward on a false condition and falls through on a true one', () => {
    const taken = run([
      IT.PUSHNUMBER,
      0,
      IT.SKIPONFALSE,
      5,
      IT.PUSHNUMBER,
      111,
      IT.POPVAR,
      9,
      IT.PUSHNUMBER,
      222,
      IT.POPVAR,
      9,
      IT.SCRIPTEND,
    ]);
    expect(taken.scriptHost.vars.get(9)).toBe(222);

    const fallen = run([
      IT.PUSHNUMBER,
      1,
      IT.SKIPONFALSE,
      5,
      IT.PUSHNUMBER,
      111,
      IT.POPVAR,
      9,
      IT.SCRIPTEND,
    ]);
    expect(fallen.scriptHost.vars.get(9)).toBe(111);
  });

  it('walks a switch to the matching case and to the default when none matches', () => {
    // Two cases; the jump is relative to the case pair's own position.
    const body = (value: number) => [
      IT.PUSHNUMBER,
      value,
      IT.SWITCH,
      2,
      1,
      5,
      2,
      8,
      11,
      IT.PUSHNUMBER,
      10,
      IT.POPVAR,
      0,
      IT.SCRIPTEND,
      IT.PUSHNUMBER,
      20,
      IT.POPVAR,
      0,
      IT.SCRIPTEND,
      IT.PUSHNUMBER,
      30,
      IT.POPVAR,
      0,
      IT.SCRIPTEND,
    ];
    expect(run(body(1)).scriptHost.vars.get(0)).toBe(10);
    expect(run(body(2)).scriptHost.vars.get(0)).toBe(20);
    expect(run(body(99)).scriptHost.vars.get(0)).toBe(30);
  });

  it('restarts at the script’s own start, not at where it was resumed', () => {
    const counting = host();
    let visits = 0;
    counting.callMcode = (): number => {
      visits++;
      return visits > 2 ? 0 : 1;
    };
    const { result } = run([IT.MCODE, 1, 0, IT.RESTARTSCRIPT, IT.SCRIPTEND], counting);
    expect(visits).toBe(3);
    expect(result.steps).toBeGreaterThan(3);
  });

  it('reports a stack overflow as a decoding fault rather than growing', () => {
    const words: number[] = [];
    for (let at = 0; at <= SWORD1_MAX_STACK; at++) words.push(IT.PUSHNUMBER, at);
    words.push(IT.SCRIPTEND);
    const { result, scriptHost } = run(words);
    expect(result.fault).toMatch(/stack/);
    expect(scriptHost.faults[0]).toMatch(/decoding fault/);
  });

  it('reports an underflow rather than reading past the stack', () => {
    const { result } = run([IT.PLUS, IT.SCRIPTEND]);
    expect(result.fault).toMatch(/popped an empty stack/);
  });

  it('reads a division by zero as zero and says so', () => {
    const { scriptHost } = run([
      IT.PUSHNUMBER,
      10,
      IT.PUSHNUMBER,
      0,
      IT.DEVIDE,
      IT.POPVAR,
      3,
      IT.SCRIPTEND,
    ]);
    expect(scriptHost.vars.get(3)).toBe(0);
    expect(scriptHost.faults.join(' ')).toMatch(/divided by zero/);
  });

  it('truncates division toward zero, as C does', () => {
    const { scriptHost } = run([
      IT.PUSHNUMBER,
      -7,
      IT.PUSHNUMBER,
      2,
      IT.DEVIDE,
      IT.POPVAR,
      4,
      IT.SCRIPTEND,
    ]);
    expect(scriptHost.vars.get(4)).toBe(-3);
  });

  it('refuses a word that is not a token rather than guessing', () => {
    const { result } = run([12345, IT.SCRIPTEND]);
    expect(result.fault).toMatch(/not a Broken Sword token/);
  });

  it('caps a runaway script instead of hanging', () => {
    // `IT_SKIP -1` jumps back onto itself: an infinite loop with no mcode.
    const { result } = run([IT.SKIP, -1, IT.SCRIPTEND]);
    expect(result.fault).toMatch(/runaway/);
  });
});

describe('the start-position table', () => {
  /** Every program, plus the seven helpers, so a sweep can reach all of them. */
  const programs = (): Array<readonly number[]> => [
    ...SWORD1_START_DATA.filter((entry): entry is readonly number[] => entry !== null),
    ...SWORD1_HELPER_DATA,
  ];

  /** How many operand bytes each opcode carries; the terminator is not here. */
  const WIDTHS: Record<number, number> = {
    [Sword1StartOpcode.opcCallFn]: 2,
    [Sword1StartOpcode.opcCallFnLong]: 13,
    [Sword1StartOpcode.opcSetVar8]: 3,
    [Sword1StartOpcode.opcSetVar16]: 4,
    [Sword1StartOpcode.opcSetVar32]: 6,
    [Sword1StartOpcode.opcGeorge]: 8,
    [Sword1StartOpcode.opcRunStart]: 1,
    [Sword1StartOpcode.opcRunHelper]: 1,
  };

  /**
   * Walks one program the way `runStartScript` does.
   *
   * Throws on a width that does not fit, which is the defect this is looking
   * for; running out of bytes with no terminator is reported rather than
   * thrown, because Revolution ships one array that does exactly that.
   */
  function walk(program: readonly number[]): {
    steps: Array<{ opcode: number; at: number }>;
    ended: boolean;
  } {
    const steps: Array<{ opcode: number; at: number }> = [];
    let at = 0;
    while (at < program.length) {
      const opcode = program[at] as number;
      if (opcode === Sword1StartOpcode.opcSeqEnd) return { steps, ended: true };
      const width = WIDTHS[opcode];
      if (width === undefined) throw new Error(`byte ${opcode} at ${at} is not an opcode`);
      if (at + 1 + width > program.length) {
        throw new Error(`opcode ${opcode} at ${at} wants ${width} bytes and the program ends`);
      }
      steps.push({ opcode, at: at + 1 });
      // A tail jump replaces the stream rather than returning to it, so nothing
      // after one is reachable and the walk stops there.
      if (opcode === Sword1StartOpcode.opcRunStart) return { steps, ended: true };
      if (opcode === Sword1StartOpcode.opcRunHelper) return { steps, ended: true };
      at += 1 + width;
    }
    return { steps, ended: false };
  }

  it('covers every section the original can be started in, and no more', () => {
    // Not a count for its own sake: `startPositions` bounds-checks against
    // this, so a table that came out short would refuse a section the game
    // supports and one that came out long would index past the array.
    expect(SWORD1_START_DATA).toHaveLength(SWORD1_MAX_START_POSITION + 1);
    expect(SWORD1_START_DATA.filter((entry) => entry !== null)).toHaveLength(54);
    expect(SWORD1_HELPER_DATA).toHaveLength(Object.keys(Sword1HelperScript).length);
  });

  it('opens a new game by playing sequence 4 and standing George at 481,413', () => {
    // Entry 0 is the whole of "new game", and its three instructions exercise
    // every operand width the macros use: a byte pair, then the 16/16/8/24 of a
    // George position, then the terminator. A generator that read the place as
    // thirty-two bits would swallow the terminator with it.
    expect(SWORD1_START_DATA[0]).toEqual([
      Sword1StartOpcode.opcCallFn,
      Sword1StartOpcode.opcPlaySequence,
      4,
      Sword1StartOpcode.opcGeorge,
      0xe1,
      0x01, // 481
      0x9d,
      0x01, // 413
      4, // DOWN
      0x00,
      0x00,
      0x01, // FLOOR_1 = 0x010000, twenty-four bits
      Sword1StartOpcode.opcSeqEnd,
    ]);
  });

  it('is self-describing: every program walks to an end with no byte left over', () => {
    // The widths are the whole risk in this table. A byte too few or too many
    // anywhere leaves the walk reading operands as opcodes, and this is the
    // cheapest way to find that out — every shipped program, every frame.
    for (const [at, program] of programs().entries()) {
      expect(() => walk(program), `program ${at}`).not.toThrow();
    }
  });

  it('jumps only to programs the table has', () => {
    for (const program of programs()) {
      for (const step of walk(program).steps) {
        if (step.opcode === Sword1StartOpcode.opcRunStart) {
          expect(SWORD1_START_DATA[program[step.at] as number]).not.toBeNull();
        }
        if (step.opcode === Sword1StartOpcode.opcRunHelper) {
          expect(SWORD1_HELPER_DATA[program[step.at] as number]).toBeDefined();
        }
      }
    }
  });

  it('records the one array of Revolution’s that carries no terminator', () => {
    // `runStartScript` loops on `while (*data != opcSeqEnd)` with no bound, so
    // in C this array reads on into whichever one the linker placed after it.
    // Recording it is the honest option: appending a terminator the source does
    // not have would make the generated table disagree with the game.
    expect(SWORD1_UNTERMINATED_START_DATA).toEqual(['g_startPos73']);
    // And the list is exactly the programs that walk off the end, so it cannot
    // go stale against a regenerated table in either direction.
    const runsOff = SWORD1_START_DATA.map((program, at) =>
      program && !walk(program).ended ? `g_startPos${at}` : null,
    ).filter((name): name is string => name !== null);
    expect(runsOff).toEqual([...SWORD1_UNTERMINATED_START_DATA]);
  });
});
