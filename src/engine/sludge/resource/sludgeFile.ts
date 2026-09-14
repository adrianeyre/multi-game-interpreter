/**
 * Reads a SLUDGE game's single data file — its header and its four indices.
 *
 * SLUDGE ships one container per game and everything is inside it: the
 * bytecode, the strings, the objects and every image and sound. There is no
 * second file to cross-reference and, unlike every other family here, no
 * generated support file from anybody — which is the property that made this
 * family worth reading before the eleven others on
 * `docs/scummvm-parity-roadmap.md`. Queen was tried first and refused itself:
 * its retail container carries no directory at all, so reading it needs
 * ScummVM's `queen.tbl`, and ADR 0024 refuses a support file the publisher did
 * not ship.
 *
 * ## The four indices, and why they are not one
 *
 * A SLUDGE file has a header, then four separately addressed tables. They are
 * not interchangeable and the asymmetry between them is the one thing worth
 * knowing before reading a byte:
 *
 * | Index | Entry is | Addresses |
 * | ----- | -------- | --------- |
 * | Text | a string | the translated strings, one table per language |
 * | Sub | an **absolute** file offset | a compiled function's bytecode |
 * | Object | an **absolute** file offset | an object type's definition |
 * | Data | a **relative** displacement | every resource: images, sounds, fonts |
 *
 * **Sub and Object entries are absolute; Data entries are not.** A Data entry
 * is a displacement measured from the byte just past the entry itself, and the
 * four bytes at the resource's own start are its length. Reading a Data entry
 * as absolute lands in the middle of the file and reads a plausible-looking
 * length out of whatever is there, which is a fault that looks like a corrupt
 * game rather than like a reader bug.
 *
 * ## What the version gates
 *
 * The header grew across SLUDGE's releases and three fields are conditional,
 * so a reader that does not branch on the version misreads every file that is
 * not the newest. `1.3` added the resource-name table and the data-folder
 * string; `1.6` added a ten-byte anti-aliasing block; `2.0` added names to the
 * language table.
 *
 * ## `okSoFar`
 *
 * SLUDGE's own author put a literal `okSoFar` in the header at the point where
 * every conditional field has been read. It is a checkpoint rather than a
 * checksum, and this reader treats it as the assertion it was meant to be: if
 * the string is not there, some version gate above it was read wrong, and
 * saying so at that byte is worth far more than continuing into an index whose
 * offsets will be nonsense.
 */

/** Every SLUDGE data file opens with these six bytes. */
const SIGNATURE = 'SLUDGE';

/** The literal that ends the header, and the reader's one self-check. */
const HEADER_CHECKPOINT = 'okSoFar';

/** Versions as `major * 256 + minor`, which is how the file's own gates read. */
const VERSION_RESOURCE_NAMES = 0x0103;
const VERSION_ANTIALIAS_BLOCK = 0x0106;
const VERSION_LANGUAGE_NAMES = 0x0200;

/** Thrown for a file this reader will not guess at. */
export class SludgeFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SludgeFormatError';
  }
}

/** Where each of the four tables begins, in bytes from the start of the file. */
export interface SludgeIndexStarts {
  readonly text: number;
  readonly sub: number;
  readonly object: number;
  readonly data: number;
}

/** A resource's bytes, located but not decoded. */
export interface SludgeSlice {
  readonly offset: number;
  readonly length: number;
}

export interface SludgeFile {
  /** `major * 256 + minor`, the form the header's own gates compare against. */
  readonly version: number;
  readonly versionMajor: number;
  readonly versionMinor: number;
  /** The engine's builtin function names, in the order the bytecode indexes them. */
  readonly builtinNames: readonly string[];
  /** The game's own function names, in the order the Sub index addresses them. */
  readonly userFunctionNames: readonly string[];
  /**
   * The author's name for each resource, where the file carries them.
   *
   * Empty before version 1.3, which shipped no such table — and an empty list
   * is why `resourceCount` is not derived from this. A 1.2 game has resources
   * and no names for them.
   */
  readonly resourceNames: readonly string[];
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly specialSettings: number;
  /** Frames per second, as the file states it: a divisor of 1000. */
  readonly desiredFps: number;
  /** The subfolder the game keeps its saves in. Empty before version 1.3. */
  readonly dataFolder: string;
  /** One entry per translation, plus the untranslated original at index 0. */
  readonly languageTable: readonly number[];
  /** Names for those languages, where version 2.0 or later supplied them. */
  readonly languageNames: readonly string[];
  readonly globalCount: number;
  readonly indexStarts: SludgeIndexStarts;
  /** How many entries the Data index holds, established by walking it. */
  readonly resourceCount: number;
}

/** A forward-only cursor over the file, with the readers SLUDGE's header needs. */
class Cursor {
  position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  private require(count: number, what: string): void {
    if (this.position + count > this.bytes.length) {
      throw new SludgeFormatError(
        `${what} runs past the end of the file at byte ${this.position} (file is ${this.bytes.length} bytes)`,
      );
    }
  }

  byte(what = 'a byte'): number {
    this.require(1, what);
    return this.bytes[this.position++] as number;
  }

  /**
   * Big-endian, which is what the header uses throughout.
   *
   * The indices are little-endian. Mixing the two in one file looks like an
   * oversight and is simply what SLUDGE does, so the two readers are named
   * rather than defaulted.
   */
  uint16BE(what = 'a 16-bit field'): number {
    this.require(2, what);
    const value =
      ((this.bytes[this.position] as number) << 8) | (this.bytes[this.position + 1] as number);
    this.position += 2;
    return value;
  }

  /**
   * A length-prefixed string with every byte one higher than its character.
   *
   * The plus-one is SLUDGE's whole obfuscation and reversing it is the read.
   * Latin-1 rather than UTF-8: the count is a byte count and the bytes are
   * single-byte characters, so decoding as UTF-8 turns an accented character in
   * a French game into a replacement character.
   */
  string(what = 'a string'): string {
    const length = this.uint16BE(`the length of ${what}`);
    this.require(length, what);
    let out = '';
    for (let index = 0; index < length; index += 1) {
      out += String.fromCharCode(((this.bytes[this.position + index] as number) - 1) & 0xff);
    }
    this.position += length;
    return out;
  }

  /** Reads to and past the next zero byte, returning what came before it. */
  nulTerminated(what = 'a banner'): string {
    let out = '';
    for (;;) {
      const byte = this.byte(what);
      if (byte === 0) return out;
      out += String.fromCharCode(byte);
    }
  }

  skip(count: number, what: string): void {
    this.require(count, what);
    this.position += count;
  }
}

/** Little-endian, which is what all four indices use. */
function uint32LE(bytes: Uint8Array, at: number): number {
  if (at < 0 || at + 4 > bytes.length) {
    throw new SludgeFormatError(
      `an index entry at byte ${at} is outside the file (file is ${bytes.length} bytes)`,
    );
  }
  return (
    ((bytes[at] as number) |
      ((bytes[at + 1] as number) << 8) |
      ((bytes[at + 2] as number) << 16) |
      ((bytes[at + 3] as number) << 24)) >>>
    0
  );
}

/**
 * Reads the header and locates the four indices.
 *
 * `languageId` picks which translation's Text index to address. It changes
 * where the Text index starts and **nothing else**: the walk past the language
 * tables is what finds the Sub, Object and Data starts, so those come out the
 * same whichever language is asked for. A game with no translations ignores it.
 */
export function readSludgeFile(bytes: Uint8Array, languageId = 0): SludgeFile {
  const cursor = new Cursor(bytes);

  for (const expected of SIGNATURE) {
    if (cursor.byte('the signature') !== expected.charCodeAt(0)) {
      throw new SludgeFormatError('not a SLUDGE data file — the first six bytes are not "SLUDGE"');
    }
  }

  // One byte, then the human-readable banner the compiler writes so that
  // `type`ing the file says what it is. Neither carries information.
  cursor.byte('the byte after the signature');
  cursor.nulTerminated('the banner');

  const versionMajor = cursor.byte('the major version');
  const versionMinor = cursor.byte('the minor version');
  const version = versionMajor * 256 + versionMinor;

  let builtinNames: string[] = [];
  let userFunctionNames: string[] = [];
  let resourceNames: string[] = [];

  // A zero here means a file that carries no name tables at all. It is not a
  // fault: the names exist for the debugger and for error messages, and a game
  // compiled without them runs.
  if (cursor.byte('the name-tables flag') !== 0) {
    builtinNames = readStrings(cursor, 'the builtin function names');
    userFunctionNames = readStrings(cursor, 'the user function names');
    if (version >= VERSION_RESOURCE_NAMES) {
      resourceNames = readStrings(cursor, 'the resource names');
    }
  }

  const windowWidth = cursor.uint16BE('the window width');
  const windowHeight = cursor.uint16BE('the window height');
  const specialSettings = cursor.byte('the special settings');
  const fpsDivisor = cursor.byte('the frame-rate divisor');
  cursor.string('the registration string');
  cursor.skip(8, 'the build timestamp');

  const dataFolder = version >= VERSION_RESOURCE_NAMES ? cursor.string('the data folder') : '';

  const languageCount = version >= VERSION_RESOURCE_NAMES ? cursor.byte('the language count') : 0;
  const languageTable: number[] = [];
  const languageNames: string[] = [];
  for (let index = 0; index <= languageCount; index += 1) {
    // Index 0 is the untranslated original and has no entry in the file.
    languageTable.push(index === 0 ? 0 : cursor.uint16BE('a language id'));
    if (version >= VERSION_LANGUAGE_NAMES && languageCount > 0) {
      languageNames.push(cursor.string('a language name'));
    }
  }

  if (version >= VERSION_ANTIALIAS_BLOCK) {
    cursor.skip(10, 'the anti-aliasing block');
  }

  const checkpoint = cursor.string('the header checkpoint');
  if (checkpoint !== HEADER_CHECKPOINT) {
    throw new SludgeFormatError(
      `the header checkpoint reads "${checkpoint}" rather than "${HEADER_CHECKPOINT}" — ` +
        `this file declares version ${versionMajor}.${versionMinor} and a field gated on a ` +
        `version was read wrongly`,
    );
  }

  // The icon and the logo are optional images. This reader locates indices and
  // does not decode pictures, so a file carrying either is refused by name
  // rather than skipped by guess: skipping an image means parsing it, and a
  // wrong guess at its length moves every index that follows.
  const iconLogoFlags = cursor.byte('the icon and logo flags');
  if (iconLogoFlags !== 0) {
    throw new SludgeFormatError(
      `this game embeds ${describeIconLogo(iconLogoFlags)} in its header, which sits between ` +
        `the header and the indices — reading past it needs the image decoder this family ` +
        `does not have yet`,
    );
  }

  const globalCount = cursor.uint16BE('the global variable count');
  const indexStarts = walkIndices(bytes, cursor.position, languageCount, languageId);
  const resourceCount = countDataEntries(bytes, indexStarts.data);

  return {
    version,
    versionMajor,
    versionMinor,
    builtinNames,
    userFunctionNames,
    resourceNames,
    windowWidth,
    windowHeight,
    specialSettings,
    desiredFps: fpsDivisor === 0 ? 0 : Math.floor(1000 / fpsDivisor),
    dataFolder,
    languageTable,
    languageNames,
    globalCount,
    indexStarts,
    resourceCount,
  };
}

function describeIconLogo(flags: number): string {
  if ((flags & 3) === 3) return 'both an icon and a logo';
  return (flags & 1) !== 0 ? 'an icon' : 'a logo';
}

function readStrings(cursor: Cursor, what: string): string[] {
  const count = cursor.uint16BE(`the count of ${what}`);
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(cursor.string(`entry ${index} of ${what}`));
  }
  return out;
}

/**
 * Follows the chain of forward pointers past the language tables.
 *
 * Each language's Text index is a block that begins with an absolute offset to
 * the next one, so the tables form a linked list rather than an array — and the
 * Sub, Object and Data starts are wherever that list ends. Asking for language
 * *n* therefore means stepping *n* links, reading the Text start, and then
 * stepping the remaining links to reach everything else.
 */
function walkIndices(
  bytes: Uint8Array,
  startIndex: number,
  languageCount: number,
  languageId: number,
): SludgeIndexStarts {
  const skipBefore = languageId >= 0 && languageId <= languageCount ? languageId : 0;

  let at = startIndex;
  for (let step = 0; step < skipBefore; step += 1) {
    at = uint32LE(bytes, at);
  }

  const text = at + 4;
  at = uint32LE(bytes, at);

  for (let step = skipBefore; step < languageCount; step += 1) {
    at = uint32LE(bytes, at);
  }

  // Sub and Object each begin four bytes into their block; the four bytes
  // themselves are the displacement to the block after it.
  const subDisplacement = uint32LE(bytes, at);
  const sub = at + 4;
  at = sub + subDisplacement;

  const objectDisplacement = uint32LE(bytes, at);
  const object = at + 4;
  at = object + objectDisplacement;

  return { text, sub, object, data: at };
}

/**
 * How many entries the Data index has, derived from where the index table ends.
 *
 * **The count is not written down anywhere**, and the obvious two substitutes
 * are both wrong.
 *
 * The resource-name table is the right length in every file that has one, and
 * using it looks like the answer — but a game compiled before version 1.3 has
 * resources and no names for them, and a game compiled with no name tables at
 * all has neither.
 *
 * Walking the index until an entry does not fit is worse, and it is worth
 * recording why, because it passes on a real game while being wrong. Above The
 * Waves has 124 resources whose last one ends on the file's final byte; the
 * four bytes just past the end of its index table are the beginning of a
 * resource, and read as a displacement they happen to land back on resource 1.
 * So a walk reports 125 resources, the 125th being resource 1 under another
 * number, and the only outward sign is that the resource lengths sum to more
 * than the file.
 *
 * What is always in band is the shape of the file: the index table starts at
 * `dataStart` and the resource data follows it, so the table ends where the
 * earliest resource begins and its extent over four is the count. Entry 0
 * gives a first estimate; scanning under that estimate finds the earliest
 * resource, and if anything starts inside the table the estimate was too big
 * and shrinks. That converges, because the estimate strictly decreases.
 */
function countDataEntries(bytes: Uint8Array, dataStart: number): number {
  // Entry 0's own resource bounds the table from above.
  let estimate: number;
  try {
    estimate = Math.floor((lengthFieldOffset(bytes, dataStart, 0) - dataStart) / 4);
  } catch {
    return 0;
  }
  if (estimate <= 0) return 0;

  for (;;) {
    let earliest = Number.POSITIVE_INFINITY;
    let fits = true;
    for (let number = 0; number < estimate; number += 1) {
      let at: number;
      try {
        at = lengthFieldOffset(bytes, dataStart, number);
      } catch {
        fits = false;
        break;
      }
      const length = uint32LE(bytes, at);
      if (at + 4 + length > bytes.length) {
        fits = false;
        break;
      }
      if (at < earliest) earliest = at;
    }

    if (!fits) {
      // An entry under the estimate does not resolve, so the estimate is too
      // big and the table is shorter than entry 0 implied.
      estimate -= 1;
      if (estimate <= 0) return 0;
      continue;
    }

    const implied = Math.floor((earliest - dataStart) / 4);
    if (implied >= estimate) return estimate;
    estimate = implied;
    if (estimate <= 0) return 0;
  }
}

/** Where resource `number`'s four-byte length field sits. */
function lengthFieldOffset(bytes: Uint8Array, dataStart: number, number: number): number {
  const entryAt = dataStart + number * 4;
  // Measured from just past the entry — see the note on the four indices above.
  return entryAt + 4 + uint32LE(bytes, entryAt);
}

/** Where resource `number` lives, without reading it. */
function locate(bytes: Uint8Array, dataStart: number, number: number): SludgeSlice {
  const at = lengthFieldOffset(bytes, dataStart, number);
  return { offset: at + 4, length: uint32LE(bytes, at) };
}

/** Where resource `number` lives in `file`, without copying its bytes. */
export function locateResource(bytes: Uint8Array, file: SludgeFile, number: number): SludgeSlice {
  if (number < 0 || number >= file.resourceCount) {
    throw new SludgeFormatError(
      `resource ${number} is outside this game's ${file.resourceCount} resources`,
    );
  }
  return locate(bytes, file.indexStarts.data, number);
}

/** Resource `number`'s bytes, as a view rather than a copy. */
export function readResource(bytes: Uint8Array, file: SludgeFile, number: number): Uint8Array {
  const slice = locateResource(bytes, file, number);
  return bytes.subarray(slice.offset, slice.offset + slice.length);
}

/**
 * Where a compiled function's bytecode starts, as an absolute file offset.
 *
 * Absolute, unlike a Data entry. There is no length: a function's end is where
 * its own return instruction is, which is the disassembler's business.
 */
export function locateSubroutine(bytes: Uint8Array, file: SludgeFile, number: number): number {
  return uint32LE(bytes, file.indexStarts.sub + number * 4);
}

/** Where an object type's definition starts, as an absolute file offset. */
export function locateObject(bytes: Uint8Array, file: SludgeFile, number: number): number {
  return uint32LE(bytes, file.indexStarts.object + number * 4);
}

/** The author's name for a resource, where the file carries one. */
export function resourceName(file: SludgeFile, number: number): string {
  return file.resourceNames[number] ?? '';
}
