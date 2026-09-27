/**
 * Adding an instance to a SCI3 script (row 12, `sciSci3Objects.ts`).
 *
 * The script here is written from ScummVM's reading of the layout — the
 * three 32-bit header offsets, objects sized in bytes, a selector bank and
 * groups, and ten-byte relocation records of (location, base) — with every
 * kind of address the linker has to keep true: an export naming an object, a
 * `lofsa` whose operand resolves through a record, and two objects whose
 * first property is a relocated name.
 */

import { describe, expect, it } from 'vitest';

import type { SciProjectScript } from '../src/authoring/project.js';
import { fromBase64 } from '../src/authoring/base64.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { addSciInstance, deleteSciInstance } from '../src/authoring/sci/sciObjects.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { readSci3Script } from '../src/engine/sci/script/scriptResource.js';
import { buildSci32Fixture, buildSci3Fixture } from './fixtureSci.js';

const OBJECT = 16 + 256 + 64;
const OBJECTS_AT = 32;
const CODE_AT = OBJECTS_AT + OBJECT * 2;
const LOFSA_OPERAND = CODE_AT + 1;
const STRINGS_AT = CODE_AT + 8;
const RELOCATIONS_AT = STRINGS_AT + 8;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}
function u32(bytes: Uint8Array, at: number): number {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
}

function script(): number[] {
  const out = new Array(RELOCATIONS_AT + 4 * 10).fill(0);
  const put16 = (at: number, value: number) => {
    out[at] = value & 0xff;
    out[at + 1] = (value >> 8) & 0xff;
  };
  const put32 = (at: number, value: number) => {
    put16(at, value & 0xffff);
    put16(at + 2, value >>> 16);
  };
  put32(0, CODE_AT);
  put32(4, STRINGS_AT);
  put32(8, RELOCATIONS_AT);
  put16(12, 1); // one local
  put16(18, 4); // four relocation records
  put16(20, 2); // two exports: an object and a procedure
  put16(24, 4); // the procedure, relative to the code
  const nameWords: number[] = [];
  for (const [index, name] of [STRINGS_AT, STRINGS_AT + 4].entries()) {
    const at = OBJECTS_AT + index * OBJECT;
    put16(at, 0x1234);
    put16(at + 2, OBJECT);
    put16(at + 4 + 3 * 2, 1 + index);
    const group = at + 16 + 256;
    out[at + 16] = 1;
    put32(group, 1 << 2); // bit 2 is a property: the name
    for (let bit = 3; bit < 32; bit++) put16(group + bit * 2, 0xffff);
    put16(group + 2 * 2, name);
    put16(group + 5 * 2, 0); // a method at the start of the code
    nameWords.push(group + 4);
  }
  // `lofsa` (resolved through a record), `ret`, then the procedure.
  out.splice(CODE_AT, 7, 0x72, 0, 0, 0x48, 0x39, 0x01, 0x48);
  out.splice(STRINGS_AT, 8, 0x4f, 0x62, 0, 0, 0x42, 0x6f, 0, 0);
  const records = [
    [22, OBJECTS_AT],
    [LOFSA_OPERAND, STRINGS_AT],
    [nameWords[0], 0],
    [nameWords[1], 0],
  ];
  for (const [i, [location, base]] of records.entries()) {
    put32(RELOCATIONS_AT + i * 10, location);
    put32(RELOCATIONS_AT + i * 10 + 4, base);
  }
  return out;
}

async function importOf(body: number[]): Promise<SciProjectScript> {
  const resources = buildSci3Fixture().resources.map((one) =>
    one.type === 'script' ? { ...one, body } : one,
  );
  const fixture = buildSci32Fixture(resources);
  const { game, resources: read } = await detectSciGame(new MemoryDataSource('t', fixture.files), {
    onLog: () => undefined,
  });
  return (await importSciGame(game, read)).scripts.find((one) => one.number === 0)!;
}

/** What a record at a location resolves to: the word there plus its base. */
function resolve(bytes: Uint8Array, location: number): number {
  const at = u32(bytes, 8);
  for (let i = 0; i < u16(bytes, 18); i++) {
    if (u32(bytes, at + i * 10) === location)
      return u16(bytes, location) + u32(bytes, at + i * 10 + 4);
  }
  throw new Error(`no record for ${location}`);
}

function stringAt(bytes: Uint8Array, at: number): string {
  let text = '';
  while (bytes[at]) text += String.fromCharCode(bytes[at++]);
  return text;
}

describe('an instance added to a SCI3 script', () => {
  it('is read back with the others, and every address still resolves', async () => {
    const original = await importOf(script());
    expect(original.objects).toHaveLength(2);
    const next = addSciInstance(original, 1, 'Copy');
    if (typeof next === 'string') throw new Error(next);
    const bytes = fromBase64(next.bytes);
    const header = readSci3Script(bytes);

    expect(u32(bytes, 0)).toBe(CODE_AT + OBJECT);
    expect(header.exports[0]).toBe(OBJECTS_AT);
    // The lofsa's word is unchanged; its record's base followed the string.
    expect(stringAt(bytes, resolve(bytes, LOFSA_OPERAND + OBJECT))).toBe('Ob');
    // Each object's name, the copy's included.
    const names = [0, 1, 2].map((i) => {
      const group = OBJECTS_AT + i * OBJECT + 16 + 256;
      return stringAt(bytes, resolve(bytes, group + 4));
    });
    expect(names).toEqual(['Ob', 'Bo', 'Copy']);

    const reread = await importOf([...bytes]);
    expect(reread.objects).toHaveLength(3);
    // The methods moved with the code, and the graph says where.
    expect(reread.objects[0].methods.map((m) => m.offset)).toEqual(
      next.objects[0].methods.map((m) => m.offset),
    );
  });

  it('is carried by the export and deletes back to the bytes it was', async () => {
    const original = await importOf(script());
    const next = addSciInstance(original, 1);
    if (typeof next === 'string') throw new Error(next);
    const exported = exportSciGame({
      identification: { how: 'probe', evidence: [] },
      version: 'sci3',
      selectors: [],
      classes: [],
      scripts: [next],
      resources: [],
      messages: [],
      vectorPictures: [],
      celPictures: [],
      languages: [],
      unrecoveredCount: 0,
    });
    expect(exported.resources.get('script:0')).toEqual(fromBase64(next.bytes));

    const back = deleteSciInstance(next, 2);
    if (typeof back === 'string') throw new Error(back);
    expect(back.bytes).toBe(original.bytes);
    expect(back.objects).toEqual(original.objects);
  });
});
