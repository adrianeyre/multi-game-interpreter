/**
 * Adding an instance to a SCI3 script, and deleting one this editor added
 * (row 12, the SCI3 half of `sciObjects.ts`).
 *
 * ## The layout, as ScummVM reads it (`script.cpp`, `object.cpp`)
 *
 * ```
 * [u32 code][u32 strings][u32 relocations][u16 locals]…[u16 relocation count]
 * [u16 export count][exports…]  [locals…, dword aligned]
 * [object][object]…             ← walked while the magic is 0x1234; each
 *                                  object's size word is in *bytes*
 * [code…][strings…]
 * [relocation records: u32 location, u32 base, u16]   ← last
 * ```
 *
 * One resource, so a new object after the last one moves the code, the
 * strings and the relocation table. That is less work than it sounds, because
 * SCI3 addresses almost nothing absolutely:
 *
 * - a method's word in its selector group is **relative to the code**
 *   (`value + codeOffset`), and the code moves as one piece;
 * - branches and calls are relative, inside that piece;
 * - an export with no relocation record is relative to the code too
 *   (`validateExportFunc`);
 * - everything else that is an address — a `lofsa` operand, a property that
 *   holds a string, an export that names an object — is a **relocation
 *   record**: the word at `location` plus `base` (`relocateOffsetSci3`).
 *
 * So the linker rewrites the three header offsets and every record: its
 * location moves with the word it names, and where the address it resolves
 * to moved, the record's *base* moves by the same amount. The stored 16-bit
 * word is left alone, which means nothing in the code changes at all.
 *
 * A name for the copy is a string written after the existing strings, where
 * only the relocation table follows; ScummVM takes an object's name from its
 * first property (`_propertyOffsetsSci3[0]`), so that word has to be a
 * relocated one for a new name to be an address.
 */

import { fromBase64, toBase64 } from '../base64.js';
import type { SciProjectMethod, SciProjectObject, SciProjectScript } from '../project.js';
import { readSci3Script } from '../../engine/sci/script/scriptResource.js';

const RECORD = 10;
const OBJECT_HEADER = 16;
const BANK = 256;
const GROUP = 64;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function putU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
}

function putU32(bytes: Uint8Array, at: number, value: number): void {
  putU16(bytes, at, value & 0xffff);
  putU16(bytes, at + 2, value >>> 16);
}

/** One SCI3 addition, as `addedObjects` records it. */
export interface SciSci3Addition {
  at: number;
  relocations: number;
  resource: 'sci3';
  length: number;
  name: number;
}

interface Record3 {
  location: number;
  base: number;
  extra: number;
}

interface Shape {
  bytes: Uint8Array;
  end: number;
  codeAt: number;
  stringsAt: number;
  relocationsAt: number;
  records: Record3[];
}

/** The resource with the graph's words written in, and its layout, or a sentence. */
function shapeOf(script: SciProjectScript): Shape | string {
  const bytes = fromBase64(script.bytes);
  const put = (offset: number, value: number): void => {
    if (offset >= 0 && offset + 2 <= bytes.length) putU16(bytes, offset, value & 0xffff);
  };
  if (script.localsAt?.resource === 'code') {
    for (const [i, value] of script.locals.entries()) put(script.localsAt.offset + i * 2, value);
  }
  for (const object of script.objects) {
    if (object.variablesAt?.resource !== 'code') continue;
    for (const [i, value] of object.variables.entries())
      put(object.variablesAt.offset + i * 2, value);
  }

  let header;
  try {
    header = readSci3Script(bytes);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const { codeAt, stringsAt, relocationsAt, relocationCount } = header;
  if (relocationsAt + relocationCount * RECORD !== bytes.length) {
    return (
      'this SCI3 script does not end in its relocation table, so where its strings stop is not ' +
      'known and moving them would write over whatever is there'
    );
  }
  let end = header.objectsAt;
  while (end + 4 <= bytes.length && u16(bytes, end) === 0x1234) {
    const size = u16(bytes, end + 2);
    if (size < 4 || size % 2 !== 0)
      return 'an object in this SCI3 script declares an impossible size';
    end += size;
  }
  if (end > codeAt || codeAt > stringsAt || stringsAt > relocationsAt) {
    return 'this SCI3 script’s header offsets are not in the order objects, code, strings, relocations';
  }
  const records: Record3[] = [];
  for (let i = 0; i < relocationCount; i++) {
    const at = relocationsAt + i * RECORD;
    records.push({ location: u32(bytes, at), base: u32(bytes, at + 4), extra: u16(bytes, at + 8) });
  }
  return { bytes, end, codeAt, stringsAt, relocationsAt, records };
}

/** Where an object's first property word is: the one ScummVM names it by. */
function firstPropertyAt(bytes: Uint8Array, start: number): number | null {
  for (let bank = 0; bank < BANK; bank++) {
    const index = bytes[start + OBJECT_HEADER + bank];
    if (index === 0) continue;
    const group = start + OBJECT_HEADER + BANK + (index - 1) * GROUP;
    const mask = u32(bytes, group);
    for (let bit = 2; bit < 32; bit++) if (mask & (1 << bit)) return group + bit * 2;
  }
  return null;
}

/**
 * Applies a position map to a relaid resource: header offsets, records, and
 * the graph's code offsets.
 */
function relink(
  script: SciProjectScript,
  out: Uint8Array,
  shape: Shape,
  records: Record3[],
  map: (at: number) => number,
  tableAt: number,
): {
  objects: SciProjectObject[];
  exports: number[];
  procedures?: SciProjectMethod[];
  unreadProcedures?: number[];
} {
  putU32(out, 0, map(shape.codeAt));
  putU32(out, 4, map(shape.stringsAt));
  putU32(out, 8, tableAt);
  putU16(out, 18, records.length);
  for (const [i, record] of records.entries()) {
    const at = tableAt + i * RECORD;
    putU32(out, at, record.location);
    putU32(out, at + 4, record.base);
    putU16(out, at + 8, record.extra);
  }

  // Bodies move with the code, as a piece.
  const shift = (method: SciProjectMethod): SciProjectMethod => ({
    ...method,
    offset: map(method.offset),
    instructions: method.instructions.map((instruction) => ({
      ...instruction,
      offset: map(instruction.offset),
    })),
  });
  const objects = script.objects.map((object) => ({
    ...object,
    methods: object.methods.map(shift),
  }));
  return {
    objects,
    exports: readSci3Script(out).exports,
    ...(script.procedures ? { procedures: script.procedures.map(shift) } : {}),
    ...(script.unreadProcedures ? { unreadProcedures: script.unreadProcedures.map(map) } : {}),
  };
}

/** A record moved: its location with its word, its base with its target. */
function moved(source: Uint8Array, record: Record3, map: (at: number) => number): Record3 {
  const target = u16(source, record.location) + record.base;
  return { ...record, location: map(record.location), base: record.base + map(target) - target };
}

/** The SCI3 half of `addSciInstance`. */
export function addSci3Instance(
  script: SciProjectScript,
  index: number,
  name?: string,
): SciProjectScript | string {
  const source = script.objects[index];
  if (!source?.variablesAt || source.variablesAt.resource !== 'code') {
    return `${source?.name ?? `object ${index}`} was read without recording where it is`;
  }
  const shape = shapeOf(script);
  if (typeof shape === 'string') return shape;
  const { bytes, end, relocationsAt, records } = shape;

  const start = source.variablesAt.offset - 4;
  if (u16(bytes, start) !== 0x1234) return `${source.name}'s record has lost its magic`;
  const length = u16(bytes, start + 2);
  const inside = records.filter((one) => one.location >= start && one.location < start + length);

  const nameBytes =
    name === undefined ? [] : [...name].map((letter) => letter.charCodeAt(0) & 0xff);
  const nameWord = firstPropertyAt(bytes, start);
  if (name !== undefined) {
    if (nameWord === null || !inside.some((one) => one.location === nameWord)) {
      return (
        `${source.name}'s first property — the word ScummVM reads its name from — has no ` +
        `relocation record, so a new name written there would be a number rather than an address`
      );
    }
    nameBytes.push(0);
    while (nameBytes.length % 4 !== 0) nameBytes.push(0);
  }
  const named = nameBytes.length;

  const map = (at: number): number =>
    at < end ? at : at < relocationsAt ? at + length : at + length + named;

  const tableAt = relocationsAt + length + named;
  const out = new Uint8Array(bytes.length + length + named + inside.length * RECORD);
  out.set(bytes.subarray(0, end), 0);
  out.set(bytes.subarray(start, start + length), end);
  out.set(bytes.subarray(end, relocationsAt), end + length);
  out.set(nameBytes, relocationsAt + length);

  // Resolved against the bytes the words were read from: a copy's record
  // names a word the copy has, which holds the same value as the source's.
  const relocated = [
    ...records.map((record) => moved(bytes, record, map)),
    ...inside.map((record) => {
      const shifted = moved(bytes, record, map);
      return { ...shifted, location: record.location - start + end };
    }),
  ];

  if (name !== undefined) {
    const copyName = nameWord! - start + end;
    const record = relocated[records.length + inside.findIndex((one) => one.location === nameWord)];
    const stringAt = relocationsAt + length;
    const word = stringAt - record.base;
    if (word < 0 || word > 0xffff) {
      return `the new name would be ${word} past its record's base, which a 16-bit word cannot hold`;
    }
    putU16(out, copyName, word);
  }

  const linked = relink(script, out, shape, relocated, map, tableAt);
  const copyAt = end + 4;
  const copy: SciProjectObject = {
    ...source,
    ...(name === undefined ? {} : { name }),
    variables: Array.from({ length: (length - 4) / 2 }, (_, i) => u16(out, copyAt + i * 2)),
    variableSelectors: [...source.variableSelectors],
    variablesAt: { resource: 'code', offset: copyAt },
    methods: [],
  };
  const addition: SciSci3Addition = {
    at: end,
    relocations: inside.length,
    resource: 'sci3',
    length,
    name: named,
  };
  return {
    ...script,
    bytes: toBase64(out),
    exports: linked.exports,
    objects: [...linked.objects, copy],
    ...(linked.procedures ? { procedures: linked.procedures } : {}),
    ...(linked.unreadProcedures ? { unreadProcedures: linked.unreadProcedures } : {}),
    addedObjects: [...(script.addedObjects ?? []), addition],
  };
}

/** The SCI3 half of `deleteSciInstance`: the exact inverse of the above. */
export function deleteSci3Instance(
  script: SciProjectScript,
  index: number,
  addition: SciSci3Addition,
): SciProjectScript | string {
  const shape = shapeOf(script);
  if (typeof shape === 'string') return shape;
  const { bytes, relocationsAt, records } = shape;
  const { at, length, name, relocations } = addition;

  const oldTable = relocationsAt - length - name;
  const map = (value: number): number =>
    value < at + length
      ? value
      : value < oldTable + length
        ? value - length
        : value - length - name;

  const kept = records
    .slice(0, records.length - relocations)
    .map((record) => moved(bytes, record, map));
  const out = new Uint8Array(bytes.length - length - name - relocations * RECORD);
  out.set(bytes.subarray(0, at), 0);
  out.set(bytes.subarray(at + length, oldTable + length), at);

  const remaining = { ...script, objects: script.objects.filter((_, each) => each !== index) };
  const linked = relink(remaining, out, shape, kept, map, oldTable);
  return {
    ...script,
    bytes: toBase64(out),
    exports: linked.exports,
    objects: linked.objects,
    ...(linked.procedures ? { procedures: linked.procedures } : {}),
    ...(linked.unreadProcedures ? { unreadProcedures: linked.unreadProcedures } : {}),
    addedObjects: (script.addedObjects ?? []).slice(0, -1),
  };
}
