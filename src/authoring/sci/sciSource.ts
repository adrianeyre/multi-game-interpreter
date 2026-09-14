/**
 * The Source view, which is a view (ADR 0018).
 *
 * The obvious ambition is to decompile to Sierra Script and recompile. As the
 * **stored** form that is disqualified by this project's own vocabulary:
 * `Unrecovered` counts a resource that "re-emitted as different bytes than it
 * arrived as", with a target of zero, and reconstructing `if`/`while` from
 * jumps and recompiling cannot guarantee the original layout. Store source, and
 * every Script resource in every game is permanently Unrecovered.
 *
 * As a **view** it costs nothing, because `Unrecovered` is an *import*-time
 * check and bytes are meant to change once someone edits. So: rendered from the
 * instruction list on demand, edited, parsed straight back into instructions.
 *
 * **Where control flow cannot be reconstructed with certainty it degrades to
 * the instruction list rather than guessing at an `if`** — and the degradation
 * is visible. A view that silently guessed would be a view an author trusts to
 * mean what it says.
 */

import type { SciProjectInstruction, SciProjectMethod } from '../project.js';

/** One line of the rendered view. */
export interface SciSourceLine {
  /** The offset this line came from, for mapping an edit back. */
  offset: number;
  text: string;
  /**
   * True when this line is an instruction shown as itself because the
   * structure above it could not be recovered.
   *
   * Shown differently in the editor, and counted — an author needs to know
   * which parts of what they are reading are a reconstruction and which are the
   * bytes.
   */
  degraded: boolean;
}

export interface SciSourceView {
  lines: SciSourceLine[];
  /** How many instructions could not be folded into a structure. */
  degradedCount: number;
}

/**
 * Renders a method as source.
 *
 * The structure recognised is deliberately narrow: a backward branch is a loop
 * and a forward `bnt` over a block is an `if`, and **only when the branch lands
 * exactly on an instruction boundary this list contains**. A branch into the
 * middle of an instruction, or out of the method, is not a structure — it is
 * either something Sierra's compiler did that this does not model, or a
 * boundary read wrongly, and both are reasons to show the instruction rather
 * than a shape.
 */
export function renderSciSource(method: SciProjectMethod): SciSourceView {
  const lines: SciSourceLine[] = [];
  const offsets = new Set(method.instructions.map((instruction) => instruction.offset));
  let degradedCount = 0;
  let indent = 0;

  const lengthOf = (instruction: SciProjectInstruction): number =>
    1 + instruction.operands.length * ((instruction.raw & 1) !== 0 ? 1 : 2);

  /** Offsets a branch jumps to, so the renderer can close a block there. */
  const closesAt = new Map<number, number>();

  for (const instruction of method.instructions) {
    if (instruction.name !== 'bnt' && instruction.name !== 'bt') continue;
    const target = instruction.offset + lengthOf(instruction) + instruction.operands[0];
    if (instruction.operands[0] > 0 && offsets.has(target)) {
      closesAt.set(target, (closesAt.get(target) ?? 0) + 1);
    }
  }

  for (const instruction of method.instructions) {
    const closing = closesAt.get(instruction.offset) ?? 0;
    for (let i = 0; i < closing; i++) {
      indent = Math.max(0, indent - 1);
      lines.push({ offset: instruction.offset, text: `${'  '.repeat(indent)})`, degraded: false });
    }

    const target = instruction.offset + lengthOf(instruction) + instruction.operands[0];
    const structured =
      (instruction.name === 'bnt' || instruction.name === 'bt') &&
      instruction.operands[0] > 0 &&
      offsets.has(target);

    if (structured) {
      lines.push({
        offset: instruction.offset,
        text: `${'  '.repeat(indent)}${instruction.name === 'bnt' ? 'if' : 'ifnot'} (`,
        degraded: false,
      });
      indent++;
      continue;
    }

    // Everything else is shown as itself. That includes every backward branch:
    // a loop's shape depends on where its condition is evaluated, and this does
    // not model that, so claiming a `while` would be a guess.
    const degraded =
      instruction.name === 'bnt' || instruction.name === 'bt' || instruction.name === 'jmp';
    if (degraded) degradedCount++;
    lines.push({
      offset: instruction.offset,
      text: `${'  '.repeat(indent)}${formatLine(instruction)}`,
      degraded,
    });
  }

  return { lines, degradedCount };
}

function formatLine(instruction: SciProjectInstruction): string {
  if (instruction.operands.length === 0) return instruction.name;
  return `${instruction.name} ${instruction.operands.join(', ')}`;
}

/**
 * Parses a rendered view back into instructions.
 *
 * The inverse of the above, and deliberately no more than that: `if (` and `)`
 * are dropped because they were rendered from the branches that are still in
 * the list, and every other line is an instruction. So an author editing an
 * operand or an opcode gets exactly what they wrote, and an author who deletes
 * an `if (` gets an error rather than a silently unbalanced method.
 */
export function parseSciSource(
  text: string,
  original: SciProjectMethod,
): { instructions: SciProjectInstruction[]; problems: string[] } {
  const problems: string[] = [];
  const instructions: SciProjectInstruction[] = [];
  const byOffset = new Map(original.instructions.map((one) => [one.offset, one]));
  let index = 0;

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    // A closing bracket was rendered from nothing — it marks where a branch
    // lands — so it parses back to nothing.
    if (line === '' || line === ')') continue;

    // An `if (` *was* rendered from an instruction: the branch itself is still
    // in the list, and the structure is a way of showing it. So it parses back
    // to that branch rather than to nothing, or the method loses an
    // instruction every time it is rendered and read back — which the
    // instruction count then reports as an author having deleted something.
    if (line.startsWith('if (') || line.startsWith('ifnot (')) {
      const branch = original.instructions[index];
      if (branch) {
        instructions.push({ ...branch });
        index++;
      }
      continue;
    }

    const [name, ...rest] = line.split(/\s+/);
    const operands = rest
      .join(' ')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));

    // The opcode byte comes from the instruction that was at this position, so
    // an unedited line re-emits at the width it arrived at. An author who
    // changed the opcode name gets the width of the one they replaced, which is
    // the right default: it is what the surrounding code expects, and the
    // emitter widens it if an operand no longer fits.
    const previous = original.instructions[index];
    if (!previous) {
      problems.push(`"${line}" is past the end of the method that was rendered`);
      continue;
    }
    const source = byOffset.get(previous.offset);
    instructions.push({
      offset: previous.offset,
      name,
      operands,
      raw: source?.raw ?? previous.raw,
    });
    index++;
  }

  if (index < original.instructions.length) {
    problems.push(
      `The edited source has ${index} instructions where the method had ` +
        `${original.instructions.length}. Removing an instruction moves every offset after it, ` +
        `which needs the linker rather than a rewrite in place.`,
    );
  }

  return { instructions, problems };
}

/**
 * What to tell an author about where this game's words are.
 *
 * #222 asks for it and it applies from SCI0 onwards: "edit this game's words"
 * names two different places depending on Version — inline in the Script
 * resource for SCI0 and SCI1, in `MESSAGE` for SCI1.1 and later — and the
 * editor should say which rather than implying completeness.
 */
export function describeTextSurface(hasMessages: boolean): string {
  return hasMessages
    ? 'This game keeps its displayable text in MESSAGE resources, keyed by noun, verb, ' +
        'condition and sequence. Editing them reaches the dialogue and the descriptions.'
    : 'This game keeps its displayable text inline in its Script resources, so it is edited ' +
        'as strings inside the instructions that print them. It has no MESSAGE resources.';
}
