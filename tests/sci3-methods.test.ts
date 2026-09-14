/**
 * A SCI3 object's methods, which are in a selector bank rather than a table.
 *
 * **This is the single reason `docs/editor-parity.md` row 21 failed on SCI3.**
 * The importer read SCI3 objects and their property words and emitted
 * `methods: []`, so a SCI3 script opened with no bodies to decompile while
 * every other Version showed its instructions.
 *
 * SCI0 and SCI1.1 keep methods in a dictionary — a count, then `(selector,
 * offset)` pairs. SCI3 does not: after a 16-byte header comes a **256-byte
 * selector bank**, one byte per group of 32 selectors, holding a *one-based*
 * index into the 64-byte groups that follow. A group is a 32-bit type mask and
 * thirty-two words; a set bit makes the word a property's value, a clear bit
 * makes it a method's offset, and `0xffff` means the selector is not defined on
 * this object.
 *
 * **Tier 1, and it says so.** The reader and the fixture below are transcribed
 * from the same source — ScummVM's `Object::initSelectorsSci3` — so these prove
 * the documented shape is implemented and read back, and **not** that a Sierra
 * SCI3 release matches it. No SCI3 game data is on the machine this was written
 * on; Lighthouse, RAMA or Phantasmagoria 2 would move it to Tier 2 and nothing
 * short of one will.
 */

import { describe, expect, it } from 'vitest';

import { readSci3Methods } from '../src/authoring/sci/importSciGame.js';

const OBJECT_HEADER = 16;
const BANK = 256;
const GROUP = 64;

/**
 * One SCI3 object at `objectAt`, with the selectors named in `methods` as
 * methods and those in `properties` as properties.
 */
function object(
  objectAt: number,
  codeAt: number,
  methods: ReadonlyArray<{ selector: number; offset: number }>,
  properties: readonly number[] = [],
): Uint8Array {
  const groups = new Map<number, number>();
  for (const one of [...methods.map((m) => m.selector), ...properties]) {
    const group = Math.floor(one / 32);
    if (!groups.has(group)) groups.set(group, groups.size + 1);
  }
  const bytes = new Uint8Array(objectAt + OBJECT_HEADER + BANK + groups.size * GROUP + 64);
  const put16 = (at: number, value: number): void => {
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >> 8) & 0xff;
  };

  const bankAt = objectAt + OBJECT_HEADER;
  const groupsAt = bankAt + BANK;
  for (const [group, index] of groups) {
    bytes[bankAt + group] = index;
    const at = groupsAt + (index - 1) * GROUP;
    for (let bit = 2; bit < 32; bit++) put16(at + bit * 2, 0xffff);
  }
  const groupAt = (selector: number): number =>
    groupsAt + ((groups.get(Math.floor(selector / 32)) ?? 1) - 1) * GROUP;

  for (const method of methods) {
    put16(groupAt(method.selector) + (method.selector % 32) * 2, method.offset - codeAt);
  }
  for (const property of properties) {
    const at = groupAt(property);
    put16(at + (property % 32) * 2, 0x1111);
    // Set this selector's bit in the group's 32-bit type mask, which is what
    // makes it a property rather than a method.
    const bit = property % 32;
    const mask =
      (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
    const next = (mask | (1 << bit)) >>> 0;
    bytes[at] = next & 0xff;
    bytes[at + 1] = (next >> 8) & 0xff;
    bytes[at + 2] = (next >> 16) & 0xff;
    bytes[at + 3] = (next >>> 24) & 0xff;
  }
  return bytes;
}

describe('a SCI3 object carries its methods in a selector bank', () => {
  it('finds a method and resolves its offset against the code, not the resource', () => {
    const bytes = object(0, 100, [{ selector: 5, offset: 140 }]);
    expect(readSci3Methods(bytes, 0, 64, 100)).toEqual([{ selector: 5, offset: 140 }]);
  });

  /**
   * The half a reader gets wrong by starting at bit 0: the first two words of
   * every group *are* the type mask, so SCI3 has no selector 0, 1, 32 or 33.
   */
  it('never reports a selector the type mask occupies', () => {
    const bytes = object(0, 100, [{ selector: 5, offset: 140 }]);
    const found = readSci3Methods(bytes, 0, 64, 100);
    for (const method of found) expect(method.selector % 32).toBeGreaterThan(1);
  });

  it('leaves a property out, however inviting its word looks', () => {
    const bytes = object(0, 100, [{ selector: 5, offset: 140 }], [6, 7]);
    expect(readSci3Methods(bytes, 0, 64, 100)).toEqual([{ selector: 5, offset: 140 }]);
  });

  /** `0xffff` is "not defined on this object", not a method at offset 65535. */
  it('leaves an undefined selector out', () => {
    // A real group — every word 0xffff — with its one method blanked back out,
    // so the group is present and defines nothing.
    const bytes = object(0, 100, [{ selector: 5, offset: 140 }]);
    const groupAt = OBJECT_HEADER + BANK;
    bytes[groupAt + 5 * 2] = 0xff;
    bytes[groupAt + 5 * 2 + 1] = 0xff;
    expect(readSci3Methods(bytes, 0, 64, 100)).toEqual([]);
  });

  it('reads a selector in a later group, at the number that group gives it', () => {
    const bytes = object(0, 100, [{ selector: 70, offset: 200 }]);
    expect(readSci3Methods(bytes, 0, 128, 100)).toEqual([{ selector: 70, offset: 200 }]);
  });

  /** A group the bank does not point at is not read, however it looks. */
  it('skips a group the bank says this object has none of', () => {
    const bytes = object(0, 100, [{ selector: 5, offset: 140 }]);
    bytes[OBJECT_HEADER] = 0;
    expect(readSci3Methods(bytes, 0, 64, 100)).toEqual([]);
  });

  it('answers nothing rather than reading off the end of a short resource', () => {
    expect(readSci3Methods(new Uint8Array(8), 0, 64, 0)).toEqual([]);
    expect(readSci3Methods(new Uint8Array(OBJECT_HEADER + 4), 0, 64, 0)).toEqual([]);
  });
});
