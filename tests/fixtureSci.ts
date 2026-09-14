/**
 * Builds synthetic but structurally valid SCI games in memory.
 *
 * `docs/processes/verifying-version-support.md` names the trap this walks into,
 * and SCI walks into it harder than either sibling: a fixture "encodes our
 * reading of the format — if that reading is wrong, the fixture and the engine
 * agree with each other and disagree with the game."
 *
 * Two things reduce that risk here, and both are worth stating because neither
 * is available for SCUMM or AGI.
 *
 * **Every layout below is transcribed from ScummVM's readers**, with the file
 * and function named at each one, rather than from what this project's code
 * expects — `readResourceMapSCI0`, `readResourceMapSCI1` and
 * `Resource::readResourceInfo` in `engines/sci/resource/resource.cpp`.
 *
 * **And the reader these exercise has already been run against real data.**
 * Seventeen freely distributed Sierra demos, spanning SCI0 early to SCI3, read
 * every one of their 4,157 resources without a failure. So this fixture's job
 * is to keep that working in CI, not to establish that it works — which is the
 * right division, and the one AGI's fixture could not have.
 */

import {
  SCI_RESOURCE_TYPES,
  type SciResourceType,
} from '../src/engine/sci/resource/sciResourceTypes.js';

export function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

function typeNumber(type: SciResourceType): number {
  return SCI_RESOURCE_TYPES.indexOf(type);
}

/** One resource to put in a fixture, uncompressed. */
export interface SciResourceSpec {
  type: SciResourceType;
  number: number;
  body: number[];
}

export interface SciFixture {
  files: Map<string, Uint8Array>;
  /** What went in, so a test can assert what comes back out. */
  resources: SciResourceSpec[];
}

/**
 * A SCI0 game: a flat six-byte map over one volume.
 *
 * Map entry, per `readResourceMapSCI0`: a 16-bit id whose top five bits are the
 * type and low eleven the number, then a 32-bit offset whose **top six bits**
 * are the volume. Terminated by six bytes of `0xff`.
 *
 * Volume header, per `readResourceInfo`'s `kResVersionSci0Sci1Early` case:
 * `{id:u16, packed:u16, unpacked:u16, compression:u16}` — eight bytes, and
 * `packed` **includes the four bytes of header after the id**, which is the
 * `- 4` in ScummVM's reader and the single easiest thing here to get wrong.
 */
export function buildSci0Fixture(resources: SciResourceSpec[] = defaultResources()): SciFixture {
  const volume: number[] = [];
  const map: number[] = [];

  for (const resource of resources) {
    const offset = volume.length;
    const id = (typeNumber(resource.type) << 11) | resource.number;

    volume.push(...u16le(id));
    volume.push(...u16le(resource.body.length + 4));
    volume.push(...u16le(resource.body.length));
    volume.push(...u16le(0));
    volume.push(...resource.body);

    // Volume 1, in the top six bits: `1 << 26`.
    map.push(...u16le(id));
    map.push(...u32le((1 << 26) | offset));
  }
  map.push(0xff, 0xff, 0xff, 0xff, 0xff, 0xff);

  return {
    files: new Map([
      ['RESOURCE.MAP', new Uint8Array(map)],
      ['RESOURCE.001', new Uint8Array(volume)],
    ]),
    resources,
  };
}

/**
 * A SCI1.1 game: a type directory over five-byte entries.
 *
 * Directory record, per `readResourceMapSCI1`: a type byte OR-ed with `0x80`
 * and a 16-bit offset, three bytes each, ending with a record of type `0xff`
 * whose offset is the **length of the map file** — that terminator is what
 * gives the last type its entry count, so a map that ends anywhere else has a
 * last type of nonsense length.
 *
 * Entry: a 16-bit number and a 24-bit offset that is **halved** on the way in,
 * because SCI1.1 volumes are word-aligned and the reader doubles it. Every
 * resource therefore starts at an even offset, which the padding below keeps
 * true.
 *
 * Volume header, per the `kResVersionSci11` case: `{type:u8, number:u16,
 * packed:u16, unpacked:u16, compression:u16}` — nine bytes, and `packed` here
 * does **not** carry SCI0's `+ 4`.
 */
export function buildSci11Fixture(
  resources: SciResourceSpec[] = defaultResources(true),
): SciFixture {
  const byType = new Map<SciResourceType, SciResourceSpec[]>();
  for (const resource of resources) {
    const list = byType.get(resource.type) ?? [];
    list.push(resource);
    byType.set(resource.type, list);
  }

  const volume: number[] = [];
  const offsets = new Map<SciResourceSpec, number>();
  for (const resource of resources) {
    if (volume.length % 2 === 1) volume.push(0);
    offsets.set(resource, volume.length);
    volume.push(typeNumber(resource.type));
    volume.push(...u16le(resource.number));
    volume.push(...u16le(resource.body.length));
    volume.push(...u16le(resource.body.length));
    volume.push(...u16le(0));
    volume.push(...resource.body);
  }

  const types = [...byType.keys()];
  const directoryBytes = (types.length + 1) * 3;
  const entriesFor = new Map<SciResourceType, number[]>();
  let at = directoryBytes;
  const directory: number[] = [];

  for (const type of types) {
    directory.push(typeNumber(type) | 0x80);
    directory.push(...u16le(at));
    const entries: number[] = [];
    for (const resource of byType.get(type) ?? []) {
      const offset = offsets.get(resource) ?? 0;
      entries.push(...u16le(resource.number));
      const halved = offset >> 1;
      entries.push(halved & 0xff, (halved >> 8) & 0xff, (halved >> 16) & 0xff);
    }
    entriesFor.set(type, entries);
    at += entries.length;
  }
  directory.push(0xff);
  directory.push(...u16le(at));

  const map = [...directory];
  for (const type of types) map.push(...(entriesFor.get(type) ?? []));

  return {
    files: new Map([
      ['RESOURCE.MAP', new Uint8Array(map)],
      ['RESOURCE.000', new Uint8Array(volume)],
    ]),
    resources,
  };
}

/**
 * The resources every fixture ships.
 *
 * A `script` and a `heap` because the pair is what the heap-split probe reads;
 * a `vocab` 997 because Selectors come from it; a `view` and a `pic` so the
 * renderer has something; and, for the SCI1.1 fixture, a `message` so the
 * probe that looks for one has something to find.
 */
/**
 * A `vocab.997` that names both Selectors the fixture's object uses.
 *
 * The format is a **short count** — `readSelectorTable` reads `u16(0) + 1` —
 * then an offset each, then a length-prefixed string each. The blob this
 * replaced was `[0x01, 0x00, 0x02, 0x00, 0x41, 0x42]`, which declares two
 * Selectors and supplies one: the second offset read as `0x4241`, ran off the
 * end of the resource, and the reader stopped there with a single name.
 *
 * That made the fixture disagree with itself rather than with the reader. The
 * object in `sci0Script` has a method dictionary naming Selector **1**, so
 * `npm run sweep:sci` correctly reported an unresolved Selector on every layout
 * built from these resources — while the same sweep over King's Quest IV, whose
 * `vocab.997` holds 510 names, reports none. A fixture that fails a check a
 * real game passes is a fixture teaching the wrong lesson, which is Tier 1's
 * trap running the other way.
 */
function selectorTable(): number[] {
  const names = ['AB', 'CD'];
  const header = 2 + names.length * 2;
  const offsets: number[] = [];
  const strings: number[] = [];
  for (const name of names) {
    offsets.push(...u16le(header + strings.length));
    strings.push(...u16le(name.length), ...[...name].map((letter) => letter.charCodeAt(0)));
  }
  // The count field is one less than the count, which is Sierra's own encoding
  // and the reason a table of two reads `0x0001` here.
  return [...u16le(names.length - 1), ...offsets, ...strings];
}

function defaultResources(sci11 = false): SciResourceSpec[] {
  const resources: SciResourceSpec[] = [
    { type: 'script', number: 0, body: sci0Script() },
    { type: 'vocab', number: 997, body: selectorTable() },
    { type: 'view', number: 0, body: [0x01, 0x00, 0x00, 0x00] },
    // A vector Picture: set a colour, draw nothing, terminate. Two bytes at
    // least, because a Picture is told from a cel Picture by its first *word*
    // (ADR 0018) and a one-byte resource is neither kind.
    { type: 'pic', number: 1, body: [0xf0, 0x04, 0xff] },
    { type: 'font', number: 0, body: [0x00, 0x00, 0x01, 0x00] },
  ];
  if (sci11) {
    resources.push({ type: 'heap', number: 0, body: [0x00, 0x00, 0x00, 0x00] });
    resources.push({ type: 'message', number: 0, body: [0xe8, 0x03, 0x00, 0x00] });
  }
  return resources;
}

/**
 * A structurally valid SCI0 Script resource.
 *
 * A block chain of `{type:u16, size:u16}` where **the size counts its own
 * four-byte header** — the `- 4` in ScummVM's `findBlockSCI0`, and the single
 * easiest thing here to get wrong. Three blocks: an exports table, a code block
 * with two real instructions, and one object whose single method points into
 * that code.
 *
 * Written out with the offsets computed rather than spelled, because a fixture
 * whose offsets are literals is a fixture that stops agreeing with itself the
 * first time a block changes size — and a Script resource that does not parse
 * is indistinguishable here from a reader that cannot parse one.
 */
function sci0Script(): number[] {
  const exportsBlock = [7, 0, 0, 0, ...u16le(1), ...u16le(0)];
  exportsBlock[2] = exportsBlock.length & 0xff;
  exportsBlock[3] = exportsBlock.length >> 8;

  // `pushi 1; ret` — two instructions whose lengths follow from their own
  // opcode bytes, which is the property ADR 0017's whole claim rests on.
  const code = [0x39, 0x01, 0x48];
  const codeBlock = [2, 0, 0, 0, ...code];
  codeBlock[2] = codeBlock.length & 0xff;
  codeBlock[3] = codeBlock.length >> 8;

  const codeAt = exportsBlock.length + 4;

  // The object: a magic word, a locals offset, a function-area offset measured
  // from the selector counter, the variable count, then the variables, then the
  // method dictionary — a count, the Selector numbers, a zero word, and the
  // code offsets.
  const variables = [...u16le(1), ...u16le(0), ...u16le(0), ...u16le(0)];
  const methodDictionary = [...u16le(1), ...u16le(1), ...u16le(0), ...u16le(codeAt)];
  const objectBody = [
    ...u16le(0x1234),
    ...u16le(0),
    ...u16le(variables.length + 2),
    ...u16le(variables.length / 2),
    ...variables,
    ...methodDictionary,
  ];
  const objectBlock = [1, 0, 0, 0, ...objectBody];
  objectBlock[2] = objectBlock.length & 0xff;
  objectBlock[3] = objectBlock.length >> 8;

  return [...exportsBlock, ...codeBlock, ...objectBlock, ...u16le(0), ...u16le(0)];
}

/**
 * A SCI32 game: `RESMAP.000` over `RESSCI.000`, and no volume nibble anywhere.
 *
 * The file names are the ones a SCI32 release actually ships — a numbered map
 * beside a numbered `RESSCI` volume, one pair per disc — rather than a
 * `RESSCI.MAP`, which nothing has. `sciLayout` is written against seventeen
 * real demos and only claims these two shapes.
 *
 * The two structural differences from SCI1 late, both from ScummVM's own
 * readers and both small enough to be got wrong silently:
 *
 * **The directory type is not OR-ed with `0x80`.** `detectMapVersion`'s whole
 * test for SCI32 is "only SCI32 has a directory type below `0x80`", so a
 * fixture that sets the bit builds a SCI1 late game that happens to be named
 * `RESSCI`.
 *
 * **An entry's offset is a plain 32-bit word.** SCI1 late keeps the volume in
 * the top nibble and SCI1.1 halves a 24-bit one; a SCI32 map belongs to one
 * volume by its own file name, so there is nothing to pack.
 *
 * The Volume header is thirteen bytes with 32-bit sizes — `{type:u8,
 * number:u16, packed:u32, unpacked:u32, method:u16}` — and the method field is
 * the one SCI3 writes without meaning, which is why the reader derives
 * compression from whether the sizes differ rather than believing it.
 */
export function buildSci32Fixture(
  resources: SciResourceSpec[] = sci32Resources(),
  options: { mapFile?: string; volumeFile?: string } = {},
): SciFixture {
  const byType = new Map<SciResourceType, SciResourceSpec[]>();
  for (const resource of resources) {
    const list = byType.get(resource.type) ?? [];
    list.push(resource);
    byType.set(resource.type, list);
  }

  const volume: number[] = [];
  const offsets = new Map<SciResourceSpec, number>();
  for (const resource of resources) {
    offsets.set(resource, volume.length);
    volume.push(typeNumber(resource.type));
    volume.push(...u16le(resource.number));
    volume.push(...u32le(resource.body.length));
    volume.push(...u32le(resource.body.length));
    volume.push(...u16le(0));
    volume.push(...resource.body);
  }

  const types = [...byType.keys()];
  const directoryBytes = (types.length + 1) * 3;
  const entriesFor = new Map<SciResourceType, number[]>();
  let at = directoryBytes;
  const directory: number[] = [];

  for (const type of types) {
    // No `| 0x80`. That is the whole of what makes this map SCI32's.
    directory.push(typeNumber(type));
    directory.push(...u16le(at));
    const entries: number[] = [];
    for (const resource of byType.get(type) ?? []) {
      entries.push(...u16le(resource.number));
      entries.push(...u32le(offsets.get(resource) ?? 0));
    }
    entriesFor.set(type, entries);
    at += entries.length;
  }
  directory.push(0xff);
  directory.push(...u16le(at));

  const map = [...directory];
  for (const type of types) map.push(...(entriesFor.get(type) ?? []));

  return {
    files: new Map([
      [options.mapFile ?? 'RESMAP.000', new Uint8Array(map)],
      [options.volumeFile ?? 'RESSCI.000', new Uint8Array(volume)],
    ]),
    resources,
  };
}

/**
 * What a SCI32 fixture ships.
 *
 * A `script` and a `heap`, because SCI2 and SCI2.1 kept SCI1.1's pair; a
 * `vocab` 997 for the Selectors; and a V56 `view` whose cel record is
 * **52 bytes**, which is the probe that separates SCI2.1 middle from
 * everything before it.
 */
export function sci32Resources(): SciResourceSpec[] {
  return [
    { type: 'script', number: 0, body: sci0Script() },
    { type: 'heap', number: 0, body: [0x00, 0x00, 0x00, 0x00] },
    { type: 'vocab', number: 997, body: selectorTable() },
    { type: 'view', number: 0, body: v56View(52) },
    { type: 'pic', number: 1, body: [0xf0, 0x04, 0xff] },
    { type: 'font', number: 0, body: [0x00, 0x00, 0x01, 0x00] },
  ];
}

/**
 * A SCI3 game, which is SCI32's container over a Script resource of its own.
 *
 * The heap is gone — SCI3 folded the object data back into one resource behind
 * a fixed header — which is exactly what `probeHeapSplit` reads, so a fixture
 * that shipped a `heap` beside a SCI3 script would be a SCI3 game the probes
 * call SCI1.1.
 */
export function buildSci3Fixture(): SciFixture {
  return buildSci32Fixture([
    { type: 'script', number: 0, body: sci3Script() },
    { type: 'vocab', number: 997, body: selectorTable() },
    { type: 'view', number: 0, body: v56View(52) },
    { type: 'pic', number: 1, body: [0xf0, 0x04, 0xff] },
    { type: 'font', number: 0, body: [0x00, 0x00, 0x01, 0x00] },
  ]);
}

/**
 * A V56 View whose cel records are `recordSize` bytes.
 *
 * Fifty-two is SCI2.1 middle and later; thirty-six is everything before it.
 * The size is the argument because that byte *is* the probe.
 */
function v56View(recordSize: number): number[] {
  const header = new Array(16).fill(0);
  header[0] = 18; // the header size, which is what tells a V56 from an EGA View
  header[2] = 1; // one loop
  header[12] = 16; // the loop record size
  header[13] = recordSize;
  // A loop record and one cel record, so a reader that follows the table has
  // somewhere to land.
  return [...header, ...new Array(16).fill(0), ...new Array(recordSize).fill(0)];
}

/**
 * A structurally valid SCI3 Script resource.
 *
 * Three 32-bit offsets at 0, 4 and 8; a locals count at 12; a relocation count
 * at 18; an export count at 20; the export table at 22. One export, whose real
 * offset lives in the relocation table rather than in the slot — which is
 * Lighthouse's own arrangement and the thing a reader that trusts the slot gets
 * wrong on the first script it opens.
 */
function sci3Script(): number[] {
  const exportCount = 1;
  const localCount = 0;
  // The export table, padded to a dword, then the locals, padded again.
  let objectsAt = 22 + exportCount * 2;
  objectsAt += objectsAt % 4 === 0 ? 0 : 4 - (objectsAt % 4);
  objectsAt += localCount * 2;
  objectsAt += objectsAt % 4 === 0 ? 0 : 4 - (objectsAt % 4);

  // One object where the header's arithmetic lands: the `0x1234` magic, a word
  // count that includes those two words, then the variables. Positions three,
  // four and five are the species, superclass and info flags the reader takes.
  //
  // **A SCI3 object is a header, a selector bank and its groups**, which is
  // what makes its methods findable at all: sixteen bytes of header, then 256
  // bytes with one byte per group of 32 selectors holding a *one-based* index
  // into the 64-byte groups after it. This fixture carries one group so that a
  // reader has a method to find — without it the object is a bare header and
  // "no methods" is indistinguishable from "the reader is broken".
  const OBJECT_HEADER = 16;
  const BANK = 256;
  const GROUP = 64;
  const objectWords = (OBJECT_HEADER + BANK + GROUP) / 2;
  const codeAt = objectsAt + objectWords * 2;
  const relocationsAt = codeAt + 4;

  const script = new Array(relocationsAt + 10).fill(0);
  const put32 = (at: number, value: number): void => {
    script[at] = value & 0xff;
    script[at + 1] = (value >> 8) & 0xff;
    script[at + 2] = (value >> 16) & 0xff;
    script[at + 3] = (value >>> 24) & 0xff;
  };
  const put16 = (at: number, value: number): void => {
    script[at] = value & 0xff;
    script[at + 1] = (value >> 8) & 0xff;
  };

  put32(0, codeAt);
  put32(4, relocationsAt); // strings, which this fixture has none of
  put32(8, relocationsAt);
  put16(12, localCount);
  put16(18, 1); // one relocation entry
  put16(20, exportCount);
  put16(22, 0); // the placeholder the relocation table replaces

  put16(objectsAt, 0x1234);
  put16(objectsAt + 2, objectWords);
  put16(objectsAt + 4 + 3 * 2, 1); // species
  put16(objectsAt + 4 + 4 * 2, 0); // superclass

  // The selector bank: group 0 is present, and its one-based index is 1.
  const bankAt = objectsAt + OBJECT_HEADER;
  const groupAt = bankAt + BANK;
  script[bankAt] = 1;
  // The group's first four bytes are its type mask, which is why a selector
  // never has the number 0, 1, 32 or 33. Bit 5 clear makes selector 5 a method;
  // every other word is left 0xffff, meaning "not defined on this object".
  put32(groupAt, 0);
  for (let bit = 2; bit < 32; bit++) put16(groupAt + bit * 2, 0xffff);
  // A method's stored word is relative to the code, not to the resource.
  put16(groupAt + 5 * 2, 0);

  // `pushi 1; ret`, so the code offset points at something whose length comes
  // from the low bit of its own opcode byte.
  script[codeAt] = 0x39;
  script[codeAt + 1] = 0x01;
  script[codeAt + 2] = 0x48;

  put32(relocationsAt, 22); // the export slot being relocated
  put32(relocationsAt + 4, objectsAt); // and what it really points at

  return script;
}

/**
 * A real SCI1.1 code-and-heap pair, with a class whose method has a body.
 *
 * The default fixture ships a four-byte heap, which is enough to say "this
 * release is in the pair layout" and nothing at all about what is in it — so
 * every reader that follows a heap object's pointers was, until this existed,
 * tested only against shipped games. What that missed is the whole of why the
 * SCI1.1-and-later importer returned objects with no methods: the pointers it
 * needed to follow are in the *heap*, and the fixture had none.
 *
 * Everything a heap reader has to get right is here and is computed rather
 * than spelled:
 *
 * - the export count at 6 and the table at 8, which is where SCI1.1 moved them
 *   from SCI0's block;
 * - an export that names the **object**, measured from the heap, sitting in the
 *   same undistinguished list as an export that names a procedure — the pair
 *   that makes "which of these is a code offset" a question at all;
 * - a method dictionary of `(Selector, offset)` **pairs**, which is not SCI0's
 *   two separate runs with a zero word between them;
 * - a property-name table with an entry for every property *including* the two
 *   in the object's header, so a reader that starts at its front is two slots
 *   out for every property it names;
 * - a name pointer that is heap-relative, not combined-buffer-relative;
 * - a **relocation table at the end of the code resource**, named by word 0 of
 *   the header, with a method body immediately in front of it — so a reader
 *   that runs a body to `code.length` decodes that table's ascending pointers
 *   as instructions instead of stopping.
 */
export function sci11ScriptPair(): { code: number[]; heap: number[] } {
  const methodDictionaryAt = 12;
  const methodAt = 22;
  const procedureAt = 25;
  const propertyTableAt = 28;
  /** The last method, put here so the relocation table is what follows it. */
  const lastMethodAt = 46;
  const relocationAt = 49;
  /** The object's offset in the heap: past the relocation pointer and one local. */
  const objectAt = 6;
  /** Header words plus seven properties, which is what the size word counts. */
  const objectWords = 9;

  const code = [
    // Word 0 of a SCI1.1 code resource names its relocation table, which is
    // also where its code stops.
    ...u16le(relocationAt),
    ...u16le(0),
    ...u16le(0),
    // Two exports: the object, measured from the heap, and a procedure.
    ...u16le(2),
    ...u16le(objectAt),
    ...u16le(procedureAt),
    // Two methods, as `(Selector, offset)` pairs: `CD` at `methodAt` and `AB`
    // at `lastMethodAt`.
    ...u16le(2),
    ...u16le(1),
    ...u16le(methodAt),
    ...u16le(0),
    ...u16le(lastMethodAt),
    // `pushi 1; ret`
    0x39,
    0x01,
    0x48,
    // The procedure: `pushi 2; ret`
    0x39,
    0x02,
    0x48,
    // The property-name table: `-objID-` and `-size-` first, because they are
    // properties too, then one per property the reader will see.
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(1),
    ...u16le(0),
    ...u16le(1),
    ...u16le(0),
    ...u16le(1),
    ...u16le(0),
    // The last method: `pushi 3; ret`, with nothing after it but the table.
    0x39,
    0x03,
    0x48,
    // The relocation table: a count and one `lofs` operand position. It ends
    // exactly at the end of the resource, which is what tells it from a header
    // word that means something else.
    ...u16le(1),
    ...u16le(8),
  ];

  const className = [...'Thing'].map((letter) => letter.charCodeAt(0));
  const instanceName = [...'Widget'].map((letter) => letter.charCodeAt(0));
  /** The instance's record, straight after the class's. */
  const instanceAt = objectAt + objectWords * 2;
  const classNameAt = instanceAt + objectWords * 2;
  const instanceNameAt = classNameAt + className.length + 1;
  const heapRelocationAt = instanceNameAt + instanceName.length + 1;

  const heap = [
    // The heap opens with a pointer to its own relocation table and a count of
    // locals; the object list follows them.
    ...u16le(heapRelocationAt),
    ...u16le(1),
    ...u16le(0),
    // The class.
    ...u16le(0x1234),
    ...u16le(objectWords),
    ...u16le(propertyTableAt),
    ...u16le(methodDictionaryAt),
    ...u16le(0),
    // `-species-`: a class holds its own class number.
    ...u16le(0),
    ...u16le(0xffff),
    // The class bit, which is how an instance and a class are told apart here.
    ...u16le(0x8000),
    ...u16le(classNameAt),
    // An instance of it. **On disk its `-species-` is `0xffff`** — the engine
    // fills that in when the script loads — and the class number it is an
    // instance of is in `-super-`. It carries no property-name table of its
    // own, because at SCI1.1 only a class does.
    ...u16le(0x1234),
    ...u16le(objectWords),
    ...u16le(propertyTableAt),
    ...u16le(methodDictionaryAt),
    ...u16le(0),
    ...u16le(0xffff),
    ...u16le(0),
    ...u16le(0),
    ...u16le(instanceNameAt),
    ...className,
    0,
    ...instanceName,
    0,
    ...u16le(0),
  ];

  return { code, heap };
}

/**
 * A `vocab.996` naming one class: number 0, in script 0.
 *
 * The table an instance's property names are reached through — `{offset,
 * script}` per class — and the reason it is here is that without it a heap
 * fixture can show an instance and cannot show its properties being named.
 */
export function sci11ClassTable(): number[] {
  return [...u16le(0), ...u16le(0)];
}
