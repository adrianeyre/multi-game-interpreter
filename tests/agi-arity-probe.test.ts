/**
 * Identifying an AGI interpreter from the game's own bytecode.
 *
 * ADR 0013 refuses to edit on a version the engine guessed, and set the bar as
 * *reading* one out of the game. This is the second way to clear it, and it is
 * ADR 0020's reasoning applied to AGI: the candidate space is tiny — three
 * possible tables on DOS v2, two on v3 — and a wrong table is not quietly
 * wrong, because a misread boundary breaks the game's own jumps.
 *
 * The fixtures here are hand-assembled Logics rather than a real game's,
 * because the whole point is what happens when a table is wrong, and only a
 * fixture can be wrong in exactly one place on purpose.
 */

import { describe, expect, it } from 'vitest';

import { probeArityTable } from '../src/engine/agi/resource/arityProbe.js';

/**
 * A Logic resource: a two-byte message-table offset, then code, then an empty
 * message table.
 *
 * The header is what the disassembler measures the code section by, so it has
 * to be right or every candidate fails for the same uninteresting reason.
 */
function logic(code: number[]): Uint8Array {
  const messages = [0, 0, 0]; // no messages, and a zero table size
  const out = new Uint8Array(2 + code.length + messages.length);
  out[0] = code.length & 0xff;
  out[1] = (code.length >> 8) & 0xff;
  out.set(code, 2);
  out.set(messages, 2 + code.length);
  return out;
}

/** `quit N` — one argument under every build but exactly 2.089. */
const QUIT_WITH_ARGUMENT = [0x86, 0x01];
/** `return`, which every table agrees is one byte and no operands. */
const RETURN = [0x00];
/**
 * `quit 1` then nothing — three bytes, read two ways.
 *
 * Under 2.917 this is `quit(1)` followed by `return`. Under 2.089, where `quit`
 * takes no argument, it is `quit()` followed by `increment(0)` and then the
 * code section simply stops. King's Quest III's logic 98 is exactly these
 * bytes, and they are the only thing in the game that separates the two.
 */
const QUIT_THEN_RETURN = [0x86, 0x01, 0x00];

function probe(logics: Uint8Array[]): ReturnType<typeof probeArityTable> {
  return probeArityTable({
    major: 2,
    platform: 'dos',
    gameId: 'fixture',
    logics: logics.map((_, index) => index),
    read: (number) => logics[number],
    encrypted: () => false,
  });
}

describe('the arity probe', () => {
  /**
   * `new.room` — 0x12 — takes one argument in every build, and `set.view.v` at
   * 0x2a takes two. A Logic built out of those decodes the same way under all
   * three candidate tables, so all three survive and nothing is identified.
   * That is the honest outcome and the test asserts it rather than a decision.
   */
  it('reports every table as possible when the game never reaches a difference', () => {
    const result = probe([logic([...RETURN])]);

    expect(result.survivors.map((candidate) => candidate.interpreter)).toEqual([
      0x2072, 0x2089, 0x2917,
    ]);
  });

  /**
   * The opcodes the pre-2.089 table reads differently are 0x97 and 0x98 —
   * `print.at` and `print.at.v`. Under 2.089 and later they take one argument
   * fewer, so a Logic calling one desynchronises the walk under exactly one
   * table and its own jump stops landing on an instruction.
   */
  it('rules out a table the game’s own jumps contradict', () => {
    // `print.at` is `mnnn` — four arguments — in the base table, and `mnn` in
    // the pre-2.089 one. So the same bytes end it at different offsets, and an
    // `if` that jumps to where the *four*-argument reading ends lands one byte
    // inside the instruction under the three-argument reading.
    //
    //   0..5   if (isset 1) -> 11
    //   6..10  print.at 1, 2, 3, 4
    //   11     return
    const code = [
      0xff,
      0x07,
      0x01,
      0xff,
      0x05,
      0x00, // if (isset 1), false → skip 5 bytes
      0x97,
      0x01,
      0x02,
      0x03,
      0x04, // print.at, four arguments
      0x00, // return
    ];
    const result = probe([logic(code)]);

    const ruled = result.candidates.filter((candidate) => !candidate.consistent);
    expect(ruled.map((candidate) => candidate.interpreter)).toEqual([0x2072]);
    // And the surviving two are named, so a report can say which.
    expect(result.survivors).toHaveLength(2);
  });

  it('names what two surviving tables disagree about, rather than only their numbers', () => {
    // A Logic that reaches no difference at all leaves all three standing, so
    // the pair to look at is one that reaches exactly one: `quit` separates
    // 2.089 from the rest, which leaves 2.072 and 2.917 disagreeing about
    // `print.at` and nothing else.
    const result = probe([logic([...QUIT_WITH_ARGUMENT, ...RETURN])]);

    expect(result.survivors.map((candidate) => candidate.interpreter)).toEqual([0x2072, 0x2917]);
    expect(result.notes.join('\n')).toContain('narrowed rather than identified');
    expect(result.notes.join('\n')).toContain('print.at (0x97)');
  });

  /**
   * The check that settled King's Quest III, and the only one that could.
   *
   * `quit`'s operand byte decodes as a valid instruction, so no jump lands
   * wrong and no opcode falls outside either table — both readings are
   * internally consistent. What is not consistent is where the Logic *ends*: a
   * Logic that runs off the end of its code has no `return` to stop the
   * interpreter and would execute its own message table.
   */
  it('rules out a table under which a Logic does not end on return', () => {
    const result = probe([logic(QUIT_THEN_RETURN)]);

    expect(result.survivors.map((candidate) => candidate.interpreter)).toEqual([0x2072, 0x2917]);
    const ruled = result.candidates.find((candidate) => candidate.interpreter === 0x2089);
    expect(ruled).toMatchObject({
      unknownOpcodes: 0,
      truncated: 0,
      strayJumps: 0,
      unterminated: 1,
      consistent: false,
    });
    expect(result.notes.join('\n')).toContain('1 Logics not ending on return');
  });

  it('counts what it measured, so a reader can check the verdict', () => {
    const result = probe([logic([...RETURN])]);
    const candidate = result.candidates.find((entry) => entry.interpreter === 0x2917);

    expect(candidate).toMatchObject({
      unknownOpcodes: 0,
      truncated: 0,
      strayJumps: 0,
      consistent: true,
    });
    expect(candidate!.instructions).toBeGreaterThan(0);
  });
});
