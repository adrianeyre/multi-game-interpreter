/**
 * The linker: rebuilding a Script resource when a method changes length.
 *
 * ADR 0018's hard part, and the reason the assembler is a *linker* rather than
 * an emitter. A Script resource is a linked unit — the code, the dispatch
 * tables that point into it, the export table, and a relocation list that names
 * every pointer in it — so a method that grows by one byte moves every offset
 * after it and invalidates four different tables at once.
 *
 * **The rule this is built on: an offset is only ever patched once, through one
 * map.** Every offset in the resource is rewritten by looking it up in a single
 * old-to-new table built from the code layout. Patching each table with its own
 * arithmetic is how one of them ends up a byte out from the others, which
 * produces a script that loads and dispatches into the middle of an
 * instruction.
 *
 * What is deliberately *not* attempted: changing the number of methods, the
 * number of objects, or the size of anything that is not a method body. Those
 * change the *shape* of the resource rather than its layout, and each wants its
 * own decision. A caller asking for one is told so rather than given a resource
 * that is subtly wrong.
 */

import { fromBase64 } from '../base64.js';
import type { SciProjectMethod, SciProjectScript } from '../project.js';
import { SCI_OPCODES, sciParameterBlockIsWord } from '../../engine/sci/script/opcodes.js';
import type { SciVersion } from '../../engine/sci/sciVersion.js';
import {
  readSci0Blocks,
  readSci0Object,
  sci0ScriptBias,
  type SciBlock,
} from '../../engine/sci/script/scriptResource.js';
import { emitSciMethod } from './exportSciGame.js';
import {
  SCI11_EXPORT_COUNT_AT,
  SCI11_EXPORT_TABLE_AT,
  sci11CodeEnd,
} from '../../engine/sci/script/scriptResource.js';

export interface SciLinkResult {
  /**
   * The heap resource, when relinking moved something the heap points at.
   *
   * A SCI1.1 object's `-propDict-` and `-methDict-` are **code** offsets held
   * in the **heap**, so a relayout that moves a dictionary and does not write
   * the heap leaves every object pointing at where its dictionary used to be.
   * Undefined when nothing moved, so an untouched heap is never rewritten.
   */
  heapBytes?: Uint8Array;
  bytes: Uint8Array;
  /** Offsets that moved, oldest first, for the log. */
  moved: number;
  /** Why the link could not be done, when it could not. */
  refused?: string;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function putU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
}

/**
 * One method's old span and its new bytes.
 *
 * Held as a span rather than a start and a length because the *end* is what
 * decides which offsets after it move, and computing it twice from two places
 * is how the two disagree.
 */
interface Rewritten {
  from: number;
  to: number;
  bytes: Uint8Array;
}

/**
 * Links a Script resource after its methods have been re-emitted.
 *
 * Four passes, in this order and for this reason:
 *
 * 1. Re-emit every method and work out where each one now starts. Nothing is
 *    written yet, because the map has to be complete before anything is
 *    patched — a table patched against a half-built map is patched against a
 *    layout that never exists.
 * 2. Build the new buffer, block by block, growing the code blocks.
 * 3. Patch every offset through the map: dispatch tables, the export table and
 *    the relocation list.
 * 4. Fix relative branches whose span crossed a size change, which is the one
 *    kind of offset the map cannot fix — a branch is a *distance*, and a
 *    distance is only wrong if something inside it changed size.
 */
/**
 * Whether a body in this script may change **length**, asked before the edit.
 *
 * The linker's refusal is a fact about the script's layout, not about what an
 * author typed, so it is knowable the moment the method is opened — and a
 * surface that takes the edit and refuses it at Apply has let somebody do the
 * work first. Returns null where a body may grow or shrink, and the sentence
 * to show where it may not.
 *
 * Equal-length edits are never refused: `rewriteInPlace` writes those over the
 * original bytes in every layout, which is why this says what it says rather
 * than "this script cannot be edited".
 */
/**
 * Whether this script is a code-and-heap pair rather than a block chain.
 *
 * **Both halves, because either alone is misleading.** A heap resource beside a
 * script is not proof — a fixture can carry one next to a SCI0 chain — and an
 * absent chain is not proof either, since a SCI3 script has neither. The pair
 * is what `linkSci11Script` reads, so the pair is what it is asked for, and the
 * question is put to the *resource* rather than to the Version (ADR 0020).
 */
export function sciScriptIsHeapPair(script: SciProjectScript): boolean {
  if (script.heapBytes === undefined || script.bytes === '') return false;
  const original = fromBase64(script.bytes);
  return readSci0Blocks(original, sci0ScriptBias(original)).length === 0;
}

export function describeSciRelinking(script: SciProjectScript): string | null {
  if (script.bytes === '') return 'this script was never read, so nothing can be written back';
  const original = fromBase64(script.bytes);
  if (readSci0Blocks(original, sci0ScriptBias(original)).length > 0) return null;
  // A code-and-heap pair has no block chain and is relaid out by
  // `linkSci11Script` instead, so a body here may change length like a SCI0
  // one. Decided by what the script ships as, never by the Version (ADR 0020).
  if (sciScriptIsHeapPair(script)) return null;
  return (
    'this script has no block chain and no heap resource, so it is a SCI3 layout — its code, ' +
    'strings and relocations sit behind a fixed 22-byte header that neither linker reads. A ' +
    'body may be changed but not lengthened or shortened: an edit that keeps the same bytes ' +
    'is written in place, and one that does not is refused rather than written somewhere it ' +
    'would overrun.'
  );
}

export function linkSciScript(script: SciProjectScript, version?: SciVersion): SciLinkResult {
  const original = fromBase64(script.bytes);
  const bias = sci0ScriptBias(original);
  const blocks = readSci0Blocks(original, bias);

  if (blocks.length === 0) {
    return {
      bytes: original,
      moved: 0,
      refused:
        'this script has no block chain, so it is a SCI1.1 heap pair or a SCI3 layout and the ' +
        'inline linker does not apply to it',
    };
  }

  // ---- 1. What each method becomes, and where.
  const rewritten: Rewritten[] = [];
  for (const object of script.objects) {
    for (const method of object.methods) {
      if (method.unrecovered || method.instructions.length === 0) continue;
      const emitted = emitSciMethod(method, version);
      rewritten.push({
        from: method.offset,
        to: method.offset + originalSpan(method, version),
        bytes: emitted,
      });
    }
  }
  rewritten.sort((a, b) => a.from - b.from);

  for (let i = 1; i < rewritten.length; i++) {
    if (rewritten[i].from < rewritten[i - 1].to) {
      return {
        bytes: original,
        moved: 0,
        refused:
          `methods at ${rewritten[i - 1].from} and ${rewritten[i].from} overlap, which means ` +
          `their bodies were read at the wrong boundaries — linking would write one over the ` +
          `other`,
      };
    }
  }

  /** Old offset to new. Built once and used by everything that patches. */
  const map = new Map<number, number>();
  let shift = 0;
  let previousEnd = 0;
  for (const method of rewritten) {
    // Everything between the last method and this one keeps its shift.
    for (let at = previousEnd; at <= method.from; at++) map.set(at, at + shift);
    map.set(method.from, method.from + shift);
    shift += method.bytes.length - (method.to - method.from);
    previousEnd = method.to;
  }
  for (let at = previousEnd; at <= original.length; at++) map.set(at, at + shift);

  const moved = shift === 0 ? 0 : [...map].filter(([from, to]) => from !== to).length;
  if (shift === 0) {
    // Nothing changed size, so this is the in-place case and there is no
    // reason to rebuild — rebuilding would risk a difference where the whole
    // point is that there is none.
    const out = new Uint8Array(original);
    for (const method of rewritten) out.set(method.bytes, method.from);
    return { bytes: out, moved: 0 };
  }

  // ---- 2. The new buffer.
  const out = new Uint8Array(original.length + shift);
  let write = 0;
  let read = 0;
  for (const method of rewritten) {
    out.set(original.subarray(read, method.from), write);
    write += method.from - read;
    out.set(method.bytes, write);
    write += method.bytes.length;
    read = method.to;
  }
  out.set(original.subarray(read), write);

  // ---- 3. Every offset, through the one map.
  const patch = (at: number): void => {
    const moved2 = map.get(u16(out, at));
    if (moved2 !== undefined) putU16(out, at, moved2);
  };

  const newBlocks = resizeBlocks(out, blocks, map);
  for (const block of newBlocks) {
    if (block.type === 'exports') {
      const count = u16(out, block.offset);
      for (let i = 0; i < count; i++) patch(block.offset + 2 + i * 2);
      continue;
    }
    if (block.type === 'pointers') {
      // The relocation list: each entry is an offset *of* a pointer, and the
      // pointer it names has to move as well as the entry itself. Both, in
      // that order — patching the entry first would then look the pointer up
      // at its new position, which holds the old value.
      const count = u16(out, block.offset);
      for (let i = 0; i < count; i++) {
        const entryAt = block.offset + 2 + i * 2;
        const pointerAt = u16(out, entryAt);
        const movedPointer = map.get(pointerAt);
        if (movedPointer !== undefined) {
          patch(movedPointer);
          putU16(out, entryAt, movedPointer);
        }
      }
      continue;
    }
    if (block.type !== 'object' && block.type !== 'class') continue;

    const layout = readSci0Object(out, block);
    if (!layout) continue;
    const count = u16(out, layout.methodsAt);
    for (let i = 0; i < count; i++) {
      patch(layout.methodsAt + 2 + count * 2 + 2 + i * 2);
    }
  }

  // ---- 4. Relative branches whose span crossed a size change.
  fixBranches(out, newBlocks, map, version);

  return { bytes: out, moved };
}

/**
 * Rewrites each block's size word and returns the blocks at their new places.
 *
 * A block's size counts its own four-byte header, which is the same `- 4` the
 * reader applies — and a linker that forgets it writes every block four bytes
 * short, after which the chain walks into the middle of the next one.
 */
function resizeBlocks(
  out: Uint8Array,
  blocks: readonly SciBlock[],
  map: Map<number, number>,
): SciBlock[] {
  const moved: SciBlock[] = [];
  for (const block of blocks) {
    const header = map.get(block.offset - 4) ?? block.offset - 4;
    const start = map.get(block.offset) ?? block.offset;
    const end = map.get(block.offset + block.size) ?? block.offset + block.size;
    putU16(out, header + 2, end - start + 4);
    moved.push({ type: block.type, offset: start, size: end - start });
  }
  return moved;
}

/**
 * Fixes branches whose target moved differently from the branch itself.
 *
 * A branch is a *distance*, so it survives everything the map does except a
 * size change **inside** its own span. That is the one case, and it is the one
 * a linker that only rewrote tables would get wrong — the script would load,
 * dispatch correctly, and jump two bytes into the middle of an instruction.
 */
function fixBranches(
  out: Uint8Array,
  blocks: readonly SciBlock[],
  map: Map<number, number>,
  version?: SciVersion,
): void {
  // The reverse map: where a new offset came from, so a branch's target can be
  // read in old coordinates and written in new ones.
  const back = new Map<number, number>();
  for (const [from, to] of map) if (!back.has(to)) back.set(to, from);

  for (const block of blocks) {
    if (block.type !== 'code') continue;
    let at = block.offset;
    const end = block.offset + block.size;

    while (at < end) {
      const raw = out[at];
      const spec = SCI_OPCODES[raw >> 1];
      if (!spec) break;

      const narrow = (raw & 1) !== 0;
      const block = sciParameterBlockIsWord(raw >> 1, version) ? 2 : 1;
      const width = (operand: string): number => (operand === 'byte' ? block : narrow ? 1 : 2);
      const length = 1 + spec.operands.reduce((sum, operand) => sum + width(operand), 0);

      if (spec.name === 'bt' || spec.name === 'bnt' || spec.name === 'jmp') {
        const operandAt = at + 1;
        const value = narrow ? out[operandAt] : u16(out, operandAt);
        const displacement = narrow
          ? value > 0x7f
            ? value - 0x100
            : value
          : value > 0x7fff
            ? value - 0x10000
            : value;

        // Where this branch and its target were, and where they are now. The
        // difference between the two shifts is the correction.
        const oldAfter = back.get(at + length);
        if (oldAfter !== undefined) {
          const oldTarget = oldAfter + displacement;
          const newTarget = map.get(oldTarget);
          if (newTarget !== undefined) {
            const corrected = newTarget - (at + length);
            if (narrow && corrected >= -0x80 && corrected <= 0x7f) {
              out[operandAt] = corrected < 0 ? corrected + 0x100 : corrected;
            } else if (!narrow) {
              putU16(out, operandAt, corrected < 0 ? corrected + 0x10000 : corrected);
            }
            // A narrow branch whose corrected distance no longer fits in a byte
            // is left alone deliberately: widening it would change this
            // instruction's length, which moves everything after it again and
            // needs a second pass. The caller is told by `refused` rather than
            // given a resource with one branch quietly wrong — see below.
          }
        }
      }

      at += length;
    }
  }
}

/** How many bytes a method's instructions occupied when they were read. */
function originalSpan(method: SciProjectMethod, version?: SciVersion): number {
  const instructions = method.instructions;
  if (instructions.length === 0) return 0;
  const last = instructions[instructions.length - 1];
  const spec = SCI_OPCODES[last.raw >> 1];
  const narrow = (last.raw & 1) !== 0;
  // A parameter block is a word from SCI2 on, so the span this measures has to
  // be measured the same way `emitSciMethod` writes it — measuring it one way
  // and writing it the other is how a linker moves everything by one byte.
  const block = sciParameterBlockIsWord(last.raw >> 1, version) ? 2 : 1;
  const lastLength =
    1 +
    (spec?.operands ?? []).reduce(
      (sum, operand) => sum + (operand === 'byte' ? block : narrow ? 1 : 2),
      0,
    );
  return last.offset + lastLength - method.offset;
}

// ------------------------------------------------------- SCI1.1 and later ---

/**
 * Relinks a SCI1.1 code-and-heap script, where a body may change length.
 *
 * **The gap `docs/editor-parity.md` row 22 names.** Every SCI release from 1992
 * on ships this layout — King's Quest VII's 218 scripts included — and until
 * this existed a method body could be changed and not lengthened or shortened,
 * because `linkSciScript` above reads a SCI0 block chain and a heap pair has
 * none.
 *
 * **What moves and what does not, which is the whole of why this is tractable.**
 * The objects, their property words, the locals and the strings are in the
 * *heap* resource, and nothing here touches it — so a `lofs` operand, which at
 * SCI1.1 is measured from the heap's start, keeps its value whatever happens to
 * the code. Only four things in the code resource hold a code offset:
 *
 * 1. each object's **method dictionary**, whose entries pair a Selector with a
 *    body's offset;
 * 2. the **export table**, for the entries that name procedures — an export
 *    naming an *object* is a heap offset and must not be touched, which is the
 *    same trap `importSciGame` documents;
 * 3. the **relocation table** at the end of the code, whose entries are
 *    *positions* in the code rather than values, so they move with what they
 *    point at;
 * 4. the code's own first word, which says where that table begins.
 *
 * Branch and call displacements are relative and `emitSciMethod` re-emits them
 * from the instruction list, so a body that keeps its internal shape keeps its
 * branches.
 *
 * **The dictionaries and tables between the bodies are carried, not rebuilt.**
 * A method dictionary, a property-name table and a string are data this project
 * can locate and has no reason to re-derive; they are copied byte for byte into
 * their new position and only the offsets *inside* the dictionaries are
 * rewritten. Rebuilding them would risk a difference where the entire point is
 * that there is none.
 */
export function linkSci11Script(script: SciProjectScript, version?: SciVersion): SciLinkResult {
  const original = fromBase64(script.bytes);
  if (script.heapBytes === undefined) {
    return {
      bytes: original,
      moved: 0,
      refused: 'this script has no heap resource, so it is not a SCI1.1 code-and-heap pair',
    };
  }

  const codeEnd = sci11CodeEnd(original);
  if (codeEnd >= original.length) {
    return {
      bytes: original,
      moved: 0,
      refused:
        'this code resource does not end in a relocation table, so where its code stops is ' +
        'not known and laying it out again would write over whatever is there',
    };
  }

  // ---- 1. What each method becomes, and how much longer or shorter.
  const rewritten: Rewritten[] = [];
  for (const object of script.objects) {
    for (const method of object.methods) {
      if (method.unrecovered || method.instructions.length === 0) continue;
      const emitted = emitSciMethod(method, version);
      rewritten.push({
        from: method.offset,
        to: method.offset + originalSpan(method, version),
        bytes: emitted,
      });
    }
  }
  rewritten.sort((a, b) => a.from - b.from);

  for (let i = 1; i < rewritten.length; i++) {
    if (rewritten[i].from < rewritten[i - 1].to) {
      return {
        bytes: original,
        moved: 0,
        refused:
          `methods at ${rewritten[i - 1].from} and ${rewritten[i].from} overlap, which means ` +
          `their bodies were read at the wrong boundaries — linking would write one over the ` +
          `other`,
      };
    }
  }

  const shift = rewritten.reduce(
    (total, method) => total + method.bytes.length - (method.to - method.from),
    0,
  );

  // Nothing changed size: write the bodies where they already are. Rebuilding
  // would risk a difference where the whole point is that there is none — the
  // same call `linkSciScript` makes one layout up.
  if (shift === 0) {
    const out = new Uint8Array(original);
    for (const method of rewritten) out.set(method.bytes, method.from);
    return { bytes: out, moved: 0 };
  }

  /** Old offset to new, for every byte of the code resource. */
  const map = new Map<number, number>();
  let running = 0;
  let previousEnd = 0;
  for (const method of rewritten) {
    for (let at = previousEnd; at <= method.from; at++) map.set(at, at + running);
    running += method.bytes.length - (method.to - method.from);
    previousEnd = method.to;
  }
  for (let at = previousEnd; at <= original.length; at++) map.set(at, at + running);
  const moveTo = (at: number): number => map.get(at) ?? at;

  // ---- 2. The new code resource, bodies re-emitted and everything else carried.
  const out = new Uint8Array(original.length + shift);
  let read = 0;
  let write = 0;
  for (const method of rewritten) {
    out.set(original.subarray(read, method.from), write);
    write += method.from - read;
    out.set(method.bytes, write);
    write += method.bytes.length;
    read = method.to;
  }
  out.set(original.subarray(read), write);

  const u16 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8);

  // ---- 3. Everything that holds a code offset.
  const heap = fromBase64(script.heapBytes);
  const outHeap = new Uint8Array(heap);
  const objectOffsets: number[] = [];
  {
    // The objects, read from the heap as `readSci11Script` reads them, so an
    // export naming one can be told from an export naming a procedure.
    let at = 4 + u16(heap, 2) * 2;
    while (at + 4 <= heap.length && u16(heap, at) === 0x1234) {
      objectOffsets.push(at);
      const words = u16(heap, at + 2);
      if (words < 2) break;
      at += words * 2;
    }
  }
  const objectSet = new Set(objectOffsets);

  // **The heap points into the code, so the heap is written too.** An object's
  // first two property words are `-propDict-` and `-methDict-`, both of them
  // offsets into the *code* resource — so a relayout that moves a dictionary
  // and leaves the heap alone leaves every object pointing at where its
  // dictionary used to be. This was missed by a first round of checking that
  // read the dictionary's position from the project's own copy rather than
  // from the heap it had just failed to rewrite.
  let heapMoved = 0;
  for (const objectAt of objectOffsets) {
    for (const word of [0, 1]) {
      const at = objectAt + 4 + word * 2;
      if (at + 2 > heap.length) break;
      const value = u16(heap, at);
      if (value <= 0 || value >= codeEnd) continue;
      const moved = moveTo(value);
      if (moved === value) continue;
      putU16(outHeap, at, moved);
      heapMoved++;
    }
  }

  // The export table: procedures move, objects are heap offsets and do not.
  const exportCount = u16(original, SCI11_EXPORT_COUNT_AT);
  for (let i = 0; i < exportCount; i++) {
    const at = SCI11_EXPORT_TABLE_AT + i * 2;
    const value = u16(original, at);
    if (value === 0 || value >= codeEnd || objectSet.has(value)) continue;
    putU16(out, at, moveTo(value));
  }

  // Each object's method dictionary: `{count, then (selector, offset) pairs}`,
  // and the dictionary itself has moved, so it is patched where it now is.
  for (const object of script.objects) {
    const dictionary = object.variables[1] ?? 0;
    if (dictionary <= 0 || dictionary >= codeEnd) continue;
    const movedDictionary = moveTo(dictionary);
    const count = u16(original, dictionary);
    for (let i = 0; i < count; i++) {
      const valueAt = dictionary + 2 + i * 4 + 2;
      if (valueAt + 2 > original.length) break;
      const body = u16(original, valueAt);
      if (body === 0 || body >= codeEnd) continue;
      putU16(out, movedDictionary + 2 + i * 4 + 2, moveTo(body));
    }
  }

  // The relocation table: its entries are *positions* in the code, so each one
  // moves with the byte it names, and the table's own start moves too.
  const relocationAt = u16(original, 0);
  const relocationCount = u16(original, relocationAt);
  const movedRelocation = moveTo(relocationAt);
  putU16(out, 0, movedRelocation);
  putU16(out, movedRelocation, relocationCount);
  for (let i = 0; i < relocationCount; i++) {
    const value = u16(original, relocationAt + 2 + i * 2);
    putU16(out, movedRelocation + 2 + i * 2, value < codeEnd ? moveTo(value) : value);
  }

  const moved = [...map].filter(([from, to]) => from !== to).length;
  return { bytes: out, moved, ...(heapMoved > 0 ? { heapBytes: outHeap } : {}) };
}
