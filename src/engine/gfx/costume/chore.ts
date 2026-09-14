import type { AkosCostume } from './akos.js';

/**
 * The AKSQ chore language: what a v6 costume's animations are made of.
 *
 * A chore is a byte stream of tokens. Most are **cel references** — "draw
 * picture 12" — and the rest are commands that move around the stream, set
 * animation variables, or start another animation. Stepping a chore means
 * advancing from where a limb currently rests until it comes to rest on
 * something drawable again.
 *
 * Two encodings share the stream, which is the part that has to be right:
 *
 * - A token is one byte, unless bit 0x80 is set, in which case it is a
 *   **big-endian** 16-bit value. Big-endian, in a format that is little-endian
 *   everywhere else.
 * - A token is a command when `(token & 0xC000) === 0xC000`. Anything else is a
 *   cel index. So the distinction is not a range check — a cel index of 0xC001
 *   cannot exist, which is what makes the encoding unambiguous.
 *
 * Every command's operand width is fixed and known; a stepper that got one
 * wrong would resume in the middle of an operand and read it as a token, which
 * is how an animation becomes plausible nonsense rather than an obvious fault.
 *
 * Token values and operand widths follow ScummVM's `akos.h` and
 * `akos_increaseAnim`.
 */

const EXTEND_BIT = 0x80;
const EXTEND_WORD_BIT = 0x8000;
const COMMAND_MASK = 0xc000;

export const AkcToken = {
  EmptyCel: 0xc001,
  SetVar: 0xc010,
  DrawMany: 0xc020,
  GoToState: 0xc030,
  IfVarGoTo: 0xc031,
  StartAnim: 0xc080,
  SetDrawOffs: 0xc087,
  JumpToOffsetInVar: 0xc088,
  Flip: 0xc08a,
  EndSeq: 0xc0ff,
} as const;

/** Where a chore came to rest, and what it wants drawn there. */
export interface ChoreStep {
  /** The new position within the chore stream. */
  position: number;
  /** Cel to draw, or null when the resting token draws nothing. */
  cel: number | null;
  /** True once the chore has run to its end and should not advance again. */
  ended: boolean;
  /** An animation the chore asked to start, if any. */
  startAnim?: number;
  /** Whether the limb should be drawn mirrored. */
  flip?: boolean;
}

/** Animation variables a chore can set and test. */
export type ChoreVars = Record<number, number>;

function tokenAt(sequence: Uint8Array, at: number): { code: number; width: number } {
  const first = sequence[at] ?? 0;
  if (first & EXTEND_BIT) {
    return { code: ((first << 8) | (sequence[at + 1] ?? 0)) & 0xffff, width: 2 };
  }
  return { code: first, width: 1 };
}

function isCommand(code: number): boolean {
  return (code & COMMAND_MASK) === COMMAND_MASK;
}

/** How many bytes a token and its operands occupy. */
function sizeOf(sequence: Uint8Array, at: number, code: number, width: number): number {
  if (!isCommand(code)) return code & EXTEND_WORD_BIT ? 2 : 1;

  switch (code) {
    case AkcToken.EmptyCel:
    case AkcToken.EndSeq:
      return 2;
    case AkcToken.StartAnim:
    case AkcToken.JumpToOffsetInVar:
      return 3;
    case AkcToken.GoToState:
    case AkcToken.Flip:
      return 4;
    case AkcToken.SetVar:
    case AkcToken.IfVarGoTo:
      return 5;
    case AkcToken.SetDrawOffs:
      return 6;
    case AkcToken.DrawMany: {
      // Three bytes, then a count, then one sub-cel per count: four bytes of
      // offsets plus a cel index that is itself one or two bytes.
      const count = sequence[at + 2] ?? 0;
      let size = 3;
      for (let i = 0; i < count; i++) {
        size += 4;
        size += (sequence[at + size] ?? 0) & EXTEND_BIT ? 2 : 1;
      }
      return size;
    }
    default:
      // An unknown command's width is unknown, and guessing it desynchronises
      // everything after. The caller stops instead.
      return width;
  }
}

/** True when a chore may come to rest on this token. */
function isDrawable(code: number): boolean {
  return (
    !isCommand(code) ||
    code === AkcToken.EmptyCel ||
    code === AkcToken.EndSeq ||
    code === AkcToken.DrawMany
  );
}

/**
 * Steps one limb's chore forward from `position` to its next resting place.
 *
 * Commands are executed as they are passed; the walk ends at the first token
 * that draws. A budget bounds it, because a chore whose jumps form a cycle with
 * no drawable token in it would otherwise spin — and a costume is data, so that
 * is a thing a game can ship.
 */
export function stepChore(
  costume: AkosCostume,
  sequence: Uint8Array,
  position: number,
  vars: ChoreVars = {},
  budget = 128,
): ChoreStep {
  let at = position;
  let startAnim: number | undefined;
  let flip: boolean | undefined;

  for (let steps = 0; steps < budget; steps++) {
    if (at < 0 || at >= sequence.length) return { position, cel: null, ended: true };

    const { code, width } = tokenAt(sequence, at);
    const size = sizeOf(sequence, at, code, width);

    if (isDrawable(code)) {
      const cel = isCommand(code) ? null : code & ~EXTEND_WORD_BIT;
      return {
        position: at,
        cel: cel !== null && cel < costume.cels.length ? cel : null,
        ended: code === AkcToken.EndSeq,
        ...(startAnim !== undefined ? { startAnim } : {}),
        ...(flip !== undefined ? { flip } : {}),
      };
    }

    switch (code) {
      case AkcToken.GoToState:
        at = ((sequence[at + 2] ?? 0) | ((sequence[at + 3] ?? 0) << 8)) & 0xffff;
        continue;
      case AkcToken.IfVarGoTo: {
        const variable = sequence[at + 4] ?? 0;
        if (!vars[variable]) break;
        // Taking the jump clears the variable, so the same test does not fire
        // again on the next pass round the chore.
        vars[variable] = 0;
        at = ((sequence[at + 2] ?? 0) | ((sequence[at + 3] ?? 0) << 8)) & 0xffff;
        continue;
      }
      case AkcToken.SetVar: {
        const value = (sequence[at + 2] ?? 0) | ((sequence[at + 3] ?? 0) << 8);
        vars[sequence[at + 4] ?? 0] = value & 0x8000 ? value - 0x10000 : value;
        break;
      }
      case AkcToken.StartAnim:
        startAnim = sequence[at + 2] ?? 0;
        break;
      case AkcToken.Flip:
        flip = ((sequence[at + 2] ?? 0) | ((sequence[at + 3] ?? 0) << 8)) !== 0;
        break;
      case AkcToken.SetDrawOffs:
      case AkcToken.JumpToOffsetInVar:
        // Read past: the first is a draw offset this renderer does not apply
        // yet, the second needs the AKFO table, which is not parsed.
        break;
      default:
        // An unknown command whose width is a guess. Stopping here loses one
        // animation; continuing would misread every token after it.
        return { position: at, cel: null, ended: true };
    }

    at += size;
  }

  // A cycle of jumps with nothing drawable in it. Resting where we started is
  // wrong, but it is a still frame rather than a hung frame loop.
  return { position, cel: null, ended: true };
}
