/**
 * Adding an instance to a SCI1.1-to-SCI2.1 code-and-heap script, and deleting
 * one this editor added (row 12, the heap half of `sciObjects.ts`).
 *
 * ## The layout, as ScummVM's `Script::load` and `initializeObjectsSci11` read it
 *
 * ```
 * heap:  [relocation table offset][locals count][locals…]
 *        [object][object]…            ← walked while the magic is 0x1234
 *        [strings…]
 *        [relocation table: count, then heap positions]   ← always last
 * code:  [code table offset][…][export count][exports…][bodies, dictionaries…]
 *        [code table: count, then code positions]          ← always last
 * ```
 *
 * The object list has to stay contiguous — the loader walks it until a word
 * is not the magic — so a new instance goes straight after the last object,
 * and **everything after it in the heap moves**: the strings and the
 * relocation table. That is why this needs a linker where the SCI0 case did
 * not. What can point at a moved byte, and what rewrites it:
 *
 * - A heap word that holds a heap address. Sierra lists every one in the
 *   heap's relocation table (ScummVM's `relocateSci0Sci21` relocates exactly
 *   those), so each listed word is moved if it points past the insertion.
 * - A code word that holds a heap address: a `lofsa`/`lofss` operand, or an
 *   export naming an object. Sierra's interpreter loaded the heap separately
 *   and added its address to exactly the words the **code table** lists, so
 *   the same rule applies to each of them.
 * - The heap's own first word, which says where its relocation table is.
 *
 * Nothing else holds a heap address: method dictionaries and `-propDict-` are
 * code offsets, and objects before the insertion do not move, so an export or
 * another script naming one is untouched.
 *
 * **The code table is trusted only after it is checked.** Every `lofsa` and
 * `lofss` the project disassembled must have its operand in the table, wide.
 * A disassembled one that is not would be a heap reference this linker cannot
 * see, and the script is refused rather than written with one string pointer
 * quietly wrong.
 *
 * A name for the copy is a new string at the end of the string area, where
 * only the relocation table follows — so it moves the table and nothing else.
 */

import { fromBase64, toBase64 } from '../base64.js';
import type { SciProjectMethod, SciProjectObject, SciProjectScript } from '../project.js';
import { sci11CodeEnd } from '../../engine/sci/script/scriptResource.js';

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function putU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
}

/** Where the SCI1.1 name word is among an object's variables (`-name-`). */
const NAME_VARIABLE = 6;

/** One recorded addition, heap flavour. */
export interface SciHeapAddition {
  at: number;
  relocations: number;
  resource: 'heap';
  /** Bytes of object inserted at `at`. */
  length: number;
  /** Bytes of name string inserted before the relocation table, or 0. */
  name: number;
}

interface HeapShape {
  heap: Uint8Array;
  code: Uint8Array;
  /** End of the last object: where a new one goes. */
  end: number;
  relocationAt: number;
  relocations: number[];
  codeTable: number[];
}

/** The heap and code as the linker needs them, or a sentence. */
function shapeOf(script: SciProjectScript): HeapShape | string {
  const heap = writeGraphWords(script);
  const code = fromBase64(script.bytes);

  let at = 4 + u16(heap, 2) * 2;
  while (at + 4 <= heap.length && u16(heap, at) === 0x1234) {
    const words = u16(heap, at + 2);
    if (words < 2) return 'an object in the heap declares fewer than two words';
    at += words * 2;
  }

  const relocationAt = u16(heap, 0);
  const count = relocationAt + 2 <= heap.length ? u16(heap, relocationAt) : -1;
  if (count < 0 || relocationAt < at || relocationAt + 2 + count * 2 !== heap.length) {
    return (
      'the heap does not end in its relocation table, so where its strings stop is not known ' +
      'and moving them would write over whatever is there'
    );
  }
  const relocations: number[] = [];
  for (let i = 0; i < count; i++) relocations.push(u16(heap, relocationAt + 2 + i * 2));

  const tableAt = sci11CodeEnd(code);
  if (tableAt >= code.length) {
    return (
      'the code resource does not end in the table of words that hold heap addresses, so a ' +
      'string that moved could not be followed into the code'
    );
  }
  const codeTable: number[] = [];
  for (let i = 0; i < u16(code, tableAt); i++) codeTable.push(u16(code, tableAt + 2 + i * 2));

  // The check that makes the table trustworthy.
  const listed = new Set(codeTable);
  for (const object of [
    ...script.objects,
    { name: 'a procedure', methods: script.procedures ?? [] },
  ]) {
    for (const method of object.methods) {
      for (const instruction of method.instructions) {
        if (instruction.name !== 'lofsa' && instruction.name !== 'lofss') continue;
        const operandAt = instruction.offset + 1;
        if (!listed.has(operandAt) || (instruction.raw & 1) !== 0) {
          return (
            `the ${instruction.name} at ${instruction.offset} in ${object.name} holds a heap ` +
            `address the code table does not list as a wide word, so it could not be moved ` +
            `with the strings it points at`
          );
        }
      }
    }
  }
  return { heap, code, end: at, relocationAt, relocations, codeTable };
}

/** The heap bytes with the graph's property and local words written in. */
function writeGraphWords(script: SciProjectScript): Uint8Array {
  const heap = fromBase64(script.heapBytes!);
  const put = (offset: number, value: number): void => {
    if (offset >= 0 && offset + 2 <= heap.length) putU16(heap, offset, value & 0xffff);
  };
  if (script.localsAt?.resource === 'heap') {
    for (const [i, value] of script.locals.entries()) put(script.localsAt.offset + i * 2, value);
  }
  for (const object of script.objects) {
    if (object.variablesAt?.resource !== 'heap') continue;
    for (const [i, value] of object.variables.entries())
      put(object.variablesAt.offset + i * 2, value);
  }
  return heap;
}

/**
 * Moves a heap layout: inserts or removes a span at `at` and one before the
 * relocation table, and rewrites every heap address the two tables name.
 *
 * `map` turns an old heap position into a new one; it is applied to the
 * relocation entries' positions and, for every listed word, to its value.
 */
function relink(
  script: SciProjectScript,
  heap: Uint8Array,
  code: Uint8Array,
  codeTable: readonly number[],
  map: (at: number) => number,
): { code: Uint8Array; objects: SciProjectObject[]; procedures?: SciProjectMethod[] } {
  const outCode = new Uint8Array(code);
  for (const position of codeTable) {
    putU16(outCode, position, map(u16(code, position)));
  }
  // A heap address in a body is a `lofs` operand, and it moves with its target.
  const retarget = (method: SciProjectMethod): SciProjectMethod => ({
    ...method,
    instructions: method.instructions.map((instruction) =>
      instruction.name === 'lofsa' || instruction.name === 'lofss'
        ? {
            ...instruction,
            operands: [map(instruction.operands[0] ?? 0), ...instruction.operands.slice(1)],
          }
        : instruction,
    ),
  });
  const objects = script.objects.map((object) => ({
    ...object,
    variables:
      object.variablesAt?.resource === 'heap'
        ? object.variables.map((_, i) => u16(heap, object.variablesAt!.offset + i * 2))
        : [...object.variables],
    methods: object.methods.map(retarget),
  }));
  return {
    code: outCode,
    objects,
    ...(script.procedures ? { procedures: script.procedures.map(retarget) } : {}),
  };
}

/** The heap half of `addSciInstance`. */
export function addSciHeapInstance(
  script: SciProjectScript,
  index: number,
  name?: string,
): SciProjectScript | string {
  const source = script.objects[index];
  if (!source?.variablesAt || source.variablesAt.resource !== 'heap') {
    return `${source?.name ?? `object ${index}`} was read without recording where it is in the heap`;
  }
  const shape = shapeOf(script);
  if (typeof shape === 'string') return shape;
  const { heap, code, end, relocationAt, relocations, codeTable } = shape;

  const start = source.variablesAt.offset - 4;
  const length = u16(heap, start + 2) * 2;
  if (u16(heap, start) !== 0x1234) return `${source.name}'s record in the heap has lost its magic`;

  const inside = relocations.filter((at) => at >= start && at < start + length);
  const nameWord = start + 4 + NAME_VARIABLE * 2;
  const nameBytes =
    name === undefined ? [] : [...name].map((letter) => letter.charCodeAt(0) & 0xff);
  if (name !== undefined) {
    if (!inside.includes(nameWord)) {
      return (
        `${source.name}'s name word is not in the heap's relocation table, so a new name ` +
        `written there would be read as a number rather than as the string's address`
      );
    }
    nameBytes.push(0);
    if (nameBytes.length % 2 === 1) nameBytes.push(0);
  }
  const named = nameBytes.length;

  const grown = heap.length + length + named + inside.length * 2;
  if (code.length + (code.length & 1) + grown > 0xffff) {
    return `script ${script.number}'s code and heap would pass 64KB, which a SCI1.1 address cannot`;
  }

  // Old position to new: nothing before the insertion moves; the strings move
  // by the object; the relocation table by the object and the name.
  const map = (at: number): number =>
    at < end ? at : at < relocationAt ? at + length : at + length + named;

  const out = new Uint8Array(grown);
  out.set(heap.subarray(0, end), 0);
  out.set(heap.subarray(start, start + length), end);
  out.set(heap.subarray(end, relocationAt), end + length);
  out.set(nameBytes, relocationAt + length);
  const tableAt = relocationAt + length + named;
  putU16(out, 0, tableAt);
  const entries = [...relocations.map(map), ...inside.map((at) => at - start + end)];
  putU16(out, tableAt, entries.length);
  for (const [i, at] of entries.entries()) putU16(out, tableAt + 2 + i * 2, at);

  // Every listed word, now at its new place, holds an old address: move it.
  // The copy's words were copied from the source and are old addresses too.
  for (const at of entries) putU16(out, at, map(u16(out, at)));
  if (name !== undefined) putU16(out, end + 4 + NAME_VARIABLE * 2, relocationAt + length);

  const linked = relink(script, out, code, codeTable, map);
  const copyAt = end + 4;
  const copy: SciProjectObject = {
    ...source,
    ...(name === undefined ? {} : { name }),
    variables: source.variables.map((_, i) => u16(out, copyAt + i * 2)),
    variableSelectors: [...source.variableSelectors],
    variablesAt: { resource: 'heap', offset: copyAt },
    methods: [],
  };
  const addition: SciHeapAddition = {
    at: end,
    relocations: inside.length,
    resource: 'heap',
    length,
    name: named,
  };
  return {
    ...script,
    bytes: toBase64(linked.code),
    heapBytes: toBase64(out),
    locals:
      script.localsAt?.resource === 'heap'
        ? script.locals.map((_, i) => u16(out, script.localsAt!.offset + i * 2))
        : script.locals,
    objects: [...linked.objects, copy],
    ...(linked.procedures ? { procedures: linked.procedures } : {}),
    addedObjects: [...(script.addedObjects ?? []), addition],
  };
}

/** The heap half of `deleteSciInstance`: the exact inverse of the above. */
export function deleteSciHeapInstance(
  script: SciProjectScript,
  index: number,
  addition: SciHeapAddition,
): SciProjectScript | string {
  const shape = shapeOf(script);
  if (typeof shape === 'string') return shape;
  const { heap, code, relocationAt, relocations, codeTable } = shape;
  const { at, length, name, relocations: added } = addition;

  const oldTable = relocationAt - length - name;
  const map = (value: number): number =>
    value < at + length
      ? value
      : value < oldTable + length
        ? value - length
        : value - length - name;

  const kept = relocations.slice(0, relocations.length - added);
  const out = new Uint8Array(heap.length - length - name - added * 2);
  out.set(heap.subarray(0, at), 0);
  out.set(heap.subarray(at + length, oldTable + length), at);
  putU16(out, 0, oldTable);
  putU16(out, oldTable, kept.length);
  const entries = kept.map(map);
  for (const [i, entry] of entries.entries()) putU16(out, oldTable + 2 + i * 2, entry);
  for (const entry of entries) putU16(out, entry, map(u16(out, entry)));

  const remaining = { ...script, objects: script.objects.filter((_, each) => each !== index) };
  const linked = relink(remaining, out, code, codeTable, map);
  return {
    ...script,
    bytes: toBase64(linked.code),
    heapBytes: toBase64(out),
    locals:
      script.localsAt?.resource === 'heap'
        ? script.locals.map((_, i) => u16(out, script.localsAt!.offset + i * 2))
        : script.locals,
    objects: linked.objects,
    ...(linked.procedures ? { procedures: linked.procedures } : {}),
    addedObjects: (script.addedObjects ?? []).slice(0, -1),
  };
}
