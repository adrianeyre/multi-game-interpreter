/**
 * Builds a synthetic but structurally valid SLUDGE data file, in memory.
 *
 * `docs/processes/verifying-version-support.md`'s Tier 1, and its trap applies
 * here as hard as anywhere: this fixture encodes *this project's* reading of
 * the container, so the fixture and `sludgeFile.ts` agree with each other by
 * construction and may both disagree with a real game. What guards against
 * that is that the reader was checked against Above The Waves — a freeware
 * SLUDGE 2.2 game — before this file existed, and one test below encodes a
 * fault that only the real game exposed.
 *
 * The builder takes a version so the header's three conditional fields can be
 * exercised from both sides rather than only the newest.
 */

export interface SludgeFixtureOptions {
  /** `major * 256 + minor`. Defaults to 2.2, which is what shipped games use. */
  readonly version?: number;
  readonly builtinNames?: readonly string[];
  readonly userFunctionNames?: readonly string[];
  readonly resourceNames?: readonly string[];
  readonly windowWidth?: number;
  readonly windowHeight?: number;
  readonly fpsDivisor?: number;
  readonly dataFolder?: string;
  /** One entry per translation beyond the original. */
  readonly languages?: readonly { readonly id: number; readonly name: string }[];
  readonly globalCount?: number;
  /** Bytes of each resource, in resource-number order. */
  readonly resources?: readonly Uint8Array[];
  /** Absolute-addressed subroutine entry points to write into the Sub index. */
  readonly subroutines?: readonly number[];
  /**
   * Compiled function bodies to write, with the Sub index pointed at them.
   *
   * Takes precedence over `subroutines`, which writes bare offsets for testing
   * that the Sub index is read as absolute. One entry per name in
   * `userFunctionNames`, since the name table is what bounds the Sub index.
   */
  readonly functions?: readonly SludgeFixtureFunction[];
  /** Absolute-addressed object definitions to write into the Object index. */
  readonly objects?: readonly number[];
  /** Set to write a non-zero icon/logo flag, which the reader refuses. */
  readonly iconLogoFlags?: number;
  /** Set to break the header checkpoint, which the reader refuses. */
  readonly checkpoint?: string;
}

export interface SludgeFixtureFunction {
  readonly unfreezable?: boolean;
  readonly argumentCount?: number;
  readonly localCount?: number;
  readonly instructions: readonly { readonly command: number; readonly parameter: number }[];
  /**
   * Overstates the instruction count in the header without writing the bytes,
   * which is the one fault a fixed-width listing can still have.
   */
  readonly overstateInstructionCount?: number;
}

class Writer {
  private readonly parts: number[] = [];

  get length(): number {
    return this.parts.length;
  }

  byte(value: number): this {
    this.parts.push(value & 0xff);
    return this;
  }

  uint16BE(value: number): this {
    return this.byte(value >> 8).byte(value);
  }

  uint32LE(value: number): this {
    return this.byte(value)
      .byte(value >> 8)
      .byte(value >> 16)
      .byte(value >> 24);
  }

  /** SLUDGE's length-prefixed, every-byte-plus-one string. */
  string(value: string): this {
    this.uint16BE(value.length);
    for (const character of value) this.byte((character.charCodeAt(0) + 1) & 0xff);
    return this;
  }

  raw(bytes: Uint8Array | readonly number[]): this {
    for (const byte of bytes) this.parts.push(byte & 0xff);
    return this;
  }

  at(offset: number, bytes: readonly number[]): this {
    for (let index = 0; index < bytes.length; index += 1) {
      this.parts[offset + index] = bytes[index] as number;
    }
    return this;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

const VERSION_RESOURCE_NAMES = 0x0103;
const VERSION_ANTIALIAS_BLOCK = 0x0106;
const VERSION_LANGUAGE_NAMES = 0x0200;

export function buildSludgeFixture(options: SludgeFixtureOptions = {}): Uint8Array {
  const version = options.version ?? 0x0202;
  const resources = options.resources ?? [
    new Uint8Array([1, 2, 3, 4]),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    new Uint8Array([9]),
  ];
  const languages = options.languages ?? [];
  const subroutines = options.subroutines ?? [0x1111, 0x2222];
  const objects = options.objects ?? [0x3333];

  const writer = new Writer();
  for (const character of 'SLUDGE') writer.byte(character.charCodeAt(0));
  writer.byte(0);
  writer.raw([...'\r\nSLUDGE data file\r\n'].map((c) => c.charCodeAt(0))).byte(0);
  writer.byte(version >> 8).byte(version & 0xff);

  // The name-tables flag, then the three tables it gates.
  writer.byte(1);
  writeStrings(writer, options.builtinNames ?? ['say', 'pause']);
  writeStrings(writer, options.userFunctionNames ?? ['init', 'startGame']);
  if (version >= VERSION_RESOURCE_NAMES) {
    writeStrings(writer, options.resourceNames ?? resources.map((_, index) => `res${index}.duc`));
  }

  writer.uint16BE(options.windowWidth ?? 640);
  writer.uint16BE(options.windowHeight ?? 480);
  writer.byte(0);
  writer.byte(options.fpsDivisor ?? 20);
  writer.string('');
  writer.raw(new Uint8Array(8));

  if (version >= VERSION_RESOURCE_NAMES) writer.string(options.dataFolder ?? 'save');

  if (version >= VERSION_RESOURCE_NAMES) writer.byte(languages.length);
  for (let index = 0; index <= languages.length; index += 1) {
    if (index > 0) writer.uint16BE(languages[index - 1]?.id ?? 0);
    if (version >= VERSION_LANGUAGE_NAMES && languages.length > 0) {
      writer.string(index === 0 ? 'original' : (languages[index - 1]?.name ?? ''));
    }
  }

  if (version >= VERSION_ANTIALIAS_BLOCK) writer.raw(new Uint8Array(10));

  writer.string(options.checkpoint ?? 'okSoFar');
  writer.byte(options.iconLogoFlags ?? 0);
  writer.uint16BE(options.globalCount ?? 4);

  // Everything from here is the four indices, and their offsets depend on
  // where they land, so each is written with a placeholder and patched.

  // One Text block per language plus the original. Each opens with an absolute
  // offset to the next, which is the linked list the reader walks.
  const textNextPatches: number[] = [];
  for (let index = 0; index <= languages.length; index += 1) {
    textNextPatches.push(writer.length);
    writer.uint32LE(0);
    writeStrings(writer, [`text for language ${index}`]);
  }

  const subBlockStart = writer.length;
  writer.uint32LE(0);
  const subEntryPatches: number[] = [];
  if (options.functions) {
    for (let index = 0; index < options.functions.length; index += 1) {
      subEntryPatches.push(writer.length);
      writer.uint32LE(0);
    }
  } else {
    for (const entry of subroutines) writer.uint32LE(entry);
  }

  // Function bodies sit between the Sub index and the Object block, which is
  // where a real game puts them.
  const functionStarts: number[] = [];
  for (const fn of options.functions ?? []) {
    functionStarts.push(writer.length);
    writer.byte(fn.unfreezable ? 1 : 0);
    writer.uint16BE(fn.overstateInstructionCount ?? fn.instructions.length);
    writer.uint16BE(fn.argumentCount ?? 0);
    writer.uint16BE(fn.localCount ?? 0);
    for (const instruction of fn.instructions) {
      writer.byte(instruction.command);
      writer.uint16BE(instruction.parameter);
    }
  }

  const objectBlockStart = writer.length;
  writer.uint32LE(0);
  for (const entry of objects) writer.uint32LE(entry);

  const dataIndexStart = writer.length;
  for (let index = 0; index < resources.length; index += 1) writer.uint32LE(0);

  // Resource bodies, each a length then its bytes, and each index entry
  // patched to the displacement from just past itself.
  const dataPatches: { entry: number; displacement: number }[] = [];
  for (let index = 0; index < resources.length; index += 1) {
    const body = resources[index] as Uint8Array;
    const lengthFieldAt = writer.length;
    const entryAt = dataIndexStart + index * 4;
    dataPatches.push({ entry: entryAt, displacement: lengthFieldAt - (entryAt + 4) });
    writer.uint32LE(body.length);
    writer.raw(body);
  }

  // Patch the linked list: each Text block points at the one after it, and the
  // last points at the Sub block.
  for (let index = 0; index < textNextPatches.length; index += 1) {
    const target =
      index + 1 < textNextPatches.length ? (textNextPatches[index + 1] as number) : subBlockStart;
    writer.at(textNextPatches[index] as number, littleEndian32(target));
  }
  // Sub and Object each carry the displacement from just past their own
  // four-byte header to the block after them.
  writer.at(subBlockStart, littleEndian32(objectBlockStart - (subBlockStart + 4)));
  for (let index = 0; index < subEntryPatches.length; index += 1) {
    writer.at(subEntryPatches[index] as number, littleEndian32(functionStarts[index] as number));
  }
  writer.at(objectBlockStart, littleEndian32(dataIndexStart - (objectBlockStart + 4)));
  for (const patch of dataPatches) {
    writer.at(patch.entry, littleEndian32(patch.displacement));
  }

  return writer.toBytes();
}

function writeStrings(writer: Writer, values: readonly string[]): void {
  writer.uint16BE(values.length);
  for (const value of values) writer.string(value);
}

function littleEndian32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}
