import { describe, expect, it } from 'vitest';
import { AkcToken, stepChore, type ChoreVars } from '../src/engine/gfx/costume/chore.js';
import type { AkosCostume } from '../src/engine/gfx/costume/akos.js';

/**
 * The AKSQ chore language.
 *
 * Two encodings share one stream: a token is a byte unless bit 0x80 is set, in
 * which case it is a **big-endian** 16-bit value — big-endian, in a format
 * little-endian everywhere else — and a token is a command when
 * `(token & 0xC000) === 0xC000`, so a cel index can never collide with one.
 *
 * Every operand width below is fixed and known. A stepper that got one wrong
 * would resume mid-operand and read it as a token, which turns an animation
 * into plausible nonsense rather than an obvious fault, so each is asserted.
 */
const costume = { cels: new Array(16).fill({}) } as unknown as AkosCostume;

/** A command token, big-endian, as it sits in the stream. */
const cmd = (token: number) => [(token >> 8) & 0xff, token & 0xff];
/** A 16-bit little-endian operand. */
const word = (value: number) => [value & 0xff, (value >> 8) & 0xff];

function step(sequence: number[], position = 0, vars: ChoreVars = {}) {
  return stepChore(costume, new Uint8Array(sequence), position, vars);
}

describe('resting on something drawable', () => {
  it('rests on a cel and reports it', () => {
    expect(step([5])).toMatchObject({ position: 0, cel: 5, ended: false });
  });

  it('rests on an empty cel, which draws nothing', () => {
    expect(step(cmd(AkcToken.EmptyCel))).toMatchObject({ cel: null, ended: false });
  });

  it('reports the end of a sequence', () => {
    expect(step(cmd(AkcToken.EndSeq))).toMatchObject({ cel: null, ended: true });
  });

  it('ignores a cel index the costume does not have', () => {
    expect(step([200]).cel).toBeNull();
  });
});

describe('moving around the stream', () => {
  it('follows an unconditional jump', () => {
    // GoToState is four bytes: the token, then a 16-bit destination. Note the
    // filler is a small value — 0xff would have its extend bit set and be read
    // as the first half of a 16-bit token.
    const sequence = [...cmd(AkcToken.GoToState), ...word(5), 1, 7];
    expect(step(sequence)).toMatchObject({ position: 5, cel: 7 });
  });

  it('takes a conditional jump only when its variable is set', () => {
    // IfVarGoTo is five bytes: token, 16-bit destination, then the variable.
    // Falling through lands on the cel at 5; taking the jump lands on 6.
    const sequence = [...cmd(AkcToken.IfVarGoTo), ...word(6), 3, 1, 9];
    expect(step(sequence, 0, { 3: 0 }).cel).toBe(1);
    expect(step(sequence, 0, { 3: 1 }).cel).toBe(9);
  });

  it('clears the variable when it takes the jump', () => {
    // Otherwise the same test fires again on the next pass round the chore.
    const vars: ChoreVars = { 3: 1 };
    const sequence = [...cmd(AkcToken.IfVarGoTo), ...word(6), 3, 1, 9];
    step(sequence, 0, vars);

    expect(vars[3]).toBe(0);
  });

  it('sets an animation variable and carries on', () => {
    // SetVar is five bytes: token, 16-bit value, variable index.
    const vars: ChoreVars = {};
    const sequence = [...cmd(AkcToken.SetVar), ...word(42), 2, 6];

    expect(step(sequence, 0, vars).cel).toBe(6);
    expect(vars[2]).toBe(42);
  });

  it('reads a negative value into a variable', () => {
    const vars: ChoreVars = {};
    step([...cmd(AkcToken.SetVar), ...word(0x10000 - 3), 1, 4], 0, vars);

    expect(vars[1]).toBe(-3);
  });
});

describe('operand widths', () => {
  /**
   * Each of these places a cel immediately after a command. Landing on it
   * proves the command's width was read correctly — a wrong width lands inside
   * the operand and reads part of it as a token.
   */
  it('steps over StartAnim, which is three bytes', () => {
    const result = step([...cmd(AkcToken.StartAnim), 9, 3]);
    expect(result.cel).toBe(3);
    expect(result.startAnim).toBe(9);
  });

  it('steps over Flip, which is four bytes', () => {
    const result = step([...cmd(AkcToken.Flip), ...word(1), 3]);
    expect(result.cel).toBe(3);
    expect(result.flip).toBe(true);
  });

  it('steps over SetDrawOffs, which is six bytes', () => {
    expect(step([...cmd(AkcToken.SetDrawOffs), ...word(2), ...word(3), 8]).cel).toBe(8);
  });

  it('steps over JumpToOffsetInVar, which is three bytes', () => {
    expect(step([...cmd(AkcToken.JumpToOffsetInVar), 1, 8]).cel).toBe(8);
  });

  it('rests on DrawMany rather than walking into its sub-cels', () => {
    // Three bytes, a count, then per sub-cel four bytes of offsets and an
    // index. It draws, so the walk ends on it.
    const sequence = [...cmd(AkcToken.DrawMany), 1, 0, 0, 0, 0, 6];
    expect(step(sequence)).toMatchObject({ position: 0, cel: null });
  });
});

describe('a chore that cannot be followed', () => {
  it('stops at a command whose width it does not know', () => {
    /**
     * Its length is a guess, and a guessed length misreads every token after
     * it. Stopping loses one animation; continuing loses the costume.
     */
    const sequence = [...cmd(0xc0aa), 0, 0, 4];
    expect(step(sequence)).toMatchObject({ cel: null, ended: true });
  });

  it('does not spin on a jump that loops with nothing drawable in it', () => {
    // A costume is data, so a game can ship this.
    const sequence = [...cmd(AkcToken.GoToState), ...word(0)];
    expect(step(sequence)).toMatchObject({ ended: true });
  });

  it('stops when the position runs past the end of the sequence', () => {
    expect(step([5], 99)).toMatchObject({ cel: null, ended: true });
  });
});
