/**
 * A synthetic Smacker file, built byte by byte.
 *
 * Real game data never lives in this repository
 * (`docs/processes/verifying-version-support.md`), so the fixture stands in for
 * a Feeble Files `.smk` — with the trap that process names kept in mind: *a
 * fixture encodes our reading of the format*. Everything here is written from
 * the format's own side, so a decoder that agrees with it has agreed with
 * something written independently of it:
 *
 * - the **encoder** builds trees and picks codes, where the decoder walks trees
 *   and reads codes, so the two meet only at the bit level;
 * - the block kinds are written by what they mean — "these sixteen pixels",
 *   "this colour everywhere", "leave the last frame alone" — and the test
 *   asserts on the pixels, not on the bytes;
 * - the trees are built right-leaning rather than balanced, which produces
 *   codes of every length from one bit to *n*, so a decoder that mishandled
 *   long codes could not pass.
 *
 * What it does not stand in for is a real file's *content*. Whether The Feeble
 * Files' intro looks right is Tier 2 and needs the disc.
 */

/** Bits, least significant first within each byte — Smacker's own order. */
export class SmackerBits {
  private readonly bytes: number[] = [];
  private current = 0;
  private used = 0;

  bit(value: number): this {
    if (value) this.current |= 1 << this.used;
    this.used += 1;
    if (this.used === 8) {
      this.bytes.push(this.current);
      this.current = 0;
      this.used = 0;
    }
    return this;
  }

  bits(value: number, count: number): this {
    for (let index = 0; index < count; index += 1) this.bit((value >> index) & 1);
    return this;
  }

  /** Pads to a byte boundary and hands back what was written. */
  finish(): Uint8Array {
    if (this.used > 0) {
      this.bytes.push(this.current);
      this.current = 0;
      this.used = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

/**
 * A right-leaning Huffman tree over a symbol list.
 *
 * Symbol *i* is `i` one-bits then a zero, and the last is all ones — so the
 * codes run from one bit long to *n* long and nothing about the decoder's
 * handling of depth goes untested.
 */
export class RightLeaningTree {
  constructor(readonly symbols: readonly number[]) {
    if (symbols.length === 0) throw new Error('a tree needs at least one symbol');
  }

  /** Writes the tree itself, as the format stores it. */
  writeShape(out: SmackerBits, writeLeaf: (value: number) => void): void {
    for (let index = 0; index < this.symbols.length - 1; index += 1) {
      out.bit(1); // a node: its left child is a leaf, its right child the rest
      out.bit(0);
      writeLeaf(this.symbols[index]!);
    }
    out.bit(0);
    writeLeaf(this.symbols[this.symbols.length - 1]!);
  }

  /** Writes the code for one symbol. */
  writeCode(out: SmackerBits, symbol: number): void {
    const index = this.symbols.indexOf(symbol);
    if (index < 0) throw new Error(`symbol ${symbol} is not in this tree`);
    for (let step = 0; step < index; step += 1) out.bit(1);
    if (index < this.symbols.length - 1) out.bit(0);
  }
}

/** An 8-bit tree, wrapped in the leading and trailing bits the format has. */
function writeSmallTree(out: SmackerBits, tree: RightLeaningTree): void {
  out.bit(1);
  tree.writeShape(out, (value) => out.bits(value, 8));
  out.bit(0);
}

/**
 * A 16-bit tree: two 8-bit trees for the halves of a value, then the shape.
 *
 * The three markers are values this fixture never uses, so the decoder appends
 * three unreachable slots for them. That is deliberate — it exercises the
 * "marker not present in the tree" path, which a file whose markers are all
 * used would not.
 */
export class SmackerBigTree {
  readonly low: RightLeaningTree;
  readonly high: RightLeaningTree;
  readonly shape: RightLeaningTree;

  constructor(values: readonly number[]) {
    const unique = [...new Set(values)];
    this.shape = new RightLeaningTree(unique);
    this.low = new RightLeaningTree([...new Set(unique.map((value) => value & 0xff))]);
    this.high = new RightLeaningTree([...new Set(unique.map((value) => value >> 8))]);
  }

  write(out: SmackerBits): void {
    out.bit(1);
    writeSmallTree(out, this.low);
    writeSmallTree(out, this.high);
    for (const marker of [0xfffd, 0xfffe, 0xffff]) out.bits(marker, 16);
    this.shape.writeShape(out, (value) => {
      this.low.writeCode(out, value & 0xff);
      this.high.writeCode(out, value >> 8);
    });
    out.bit(0);
  }

  writeCode(out: SmackerBits, value: number): void {
    this.shape.writeCode(out, value);
  }
}

/** One 4x4 block of a frame, said in terms of what it means. */
export type SmackerBlock =
  /** Two colours and a 4x4 bitmask choosing between them. */
  | { readonly kind: 'mono'; readonly low: number; readonly high: number; readonly map: number }
  /** Sixteen pixels, row-major. */
  | { readonly kind: 'full'; readonly pixels: readonly number[] }
  /** Whatever the previous frame had here. */
  | { readonly kind: 'skip' }
  /** One colour, sixteen times. */
  | { readonly kind: 'fill'; readonly colour: number };

export interface SmackerFrameSpec {
  readonly blocks: readonly SmackerBlock[];
  /** 256 RGB triples of six-bit components, when this frame sets the palette. */
  readonly palette?: readonly (readonly [number, number, number])[];
  /** Raw 8-bit unsigned mono samples on track 0, uncompressed. */
  readonly audio?: Uint8Array;
}

export interface SmackerSpec {
  readonly width: number;
  readonly height: number;
  readonly frames: readonly SmackerFrameSpec[];
  readonly version?: '2' | '4';
  /** Milliseconds per frame; the header's positive convention. */
  readonly frameRateMs?: number;
  /** Whether track 0 carries uncompressed 8-bit mono audio. */
  readonly audioRate?: number;
  /** Y-doubled, which means the picture is shown at twice its height. */
  readonly doubled?: boolean;
}

/** The type code a block is written with, at a run of one. */
function typeCodeOf(block: SmackerBlock): number {
  switch (block.kind) {
    case 'mono':
      return 0;
    case 'full':
      return 1;
    case 'skip':
      return 2;
    case 'fill':
      return (block.colour << 8) | 3;
  }
}

/** The `full` tree codes a block needs, in the order the format reads them. */
function fullCodesOf(pixels: readonly number[]): number[] {
  const codes: number[] = [];
  for (let row = 0; row < 4; row += 1) {
    const at = row * 4;
    // The right-hand pair first, then the left, which is the format's order.
    codes.push((pixels[at + 3]! << 8) | pixels[at + 2]!);
    codes.push((pixels[at + 1]! << 8) | pixels[at]!);
  }
  return codes;
}

function u32(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Builds a whole Smacker file from a description of what it should show. */
export function buildSmacker(spec: SmackerSpec): Uint8Array {
  const version = spec.version ?? '2';

  // Every code any frame will need, gathered so the four trees can be built
  // once and shared — which is what the format does.
  const types: number[] = [];
  const colours: number[] = [];
  const maps: number[] = [];
  const fulls: number[] = [];
  for (const frame of spec.frames) {
    for (const block of frame.blocks) {
      types.push(typeCodeOf(block));
      if (block.kind === 'mono') {
        colours.push((block.high << 8) | block.low);
        maps.push(block.map);
      }
      if (block.kind === 'full') fulls.push(...fullCodesOf(block.pixels));
    }
  }
  // A tree needs a symbol even when no frame uses it.
  const mmap = new SmackerBigTree(maps.length > 0 ? maps : [0]);
  const mclr = new SmackerBigTree(colours.length > 0 ? colours : [0]);
  const full = new SmackerBigTree(fulls.length > 0 ? fulls : [0]);
  const type = new SmackerBigTree(types.length > 0 ? types : [2]);

  const treeBits = new SmackerBits();
  mmap.write(treeBits);
  mclr.write(treeBits);
  full.write(treeBits);
  type.write(treeBits);
  const trees = treeBits.finish();

  // Each frame's bytes: palette, then audio, then the picture bitstream.
  const bodies: Uint8Array[] = [];
  const kinds: number[] = [];
  for (const frame of spec.frames) {
    const body: number[] = [];
    let kind = 0;

    if (frame.palette) {
      kind |= 1;
      const record: number[] = [];
      for (const [red, green, blue] of frame.palette) record.push(red, green, blue);
      // The size byte counts itself, in units of four bytes.
      const total = Math.ceil((record.length + 1) / 4) * 4;
      body.push(total / 4, ...record);
      while (body.length < total) body.push(0);
    }

    if (frame.audio) {
      kind |= 2;
      u32(body, frame.audio.length + 4);
      for (const sample of frame.audio) body.push(sample);
    }

    const picture = new SmackerBits();
    for (const block of frame.blocks) {
      type.writeCode(picture, typeCodeOf(block));
      if (block.kind === 'mono') {
        mclr.writeCode(picture, (block.high << 8) | block.low);
        mmap.writeCode(picture, block.map);
      }
      if (block.kind === 'full') {
        // Smacker 4 spends up to two bits saying which of three ways a full
        // block is written. Mode 0 is a single clear bit.
        if (version === '4') picture.bit(0);
        for (const code of fullCodesOf(block.pixels)) full.writeCode(picture, code);
      }
    }
    for (const byte of picture.finish()) body.push(byte);

    while (body.length % 4 !== 0) body.push(0);
    bodies.push(Uint8Array.from(body));
    kinds.push(kind);
  }

  const out: number[] = [];
  for (const character of `SMK${version}`) out.push(character.charCodeAt(0));
  u32(out, spec.width);
  u32(out, spec.height);
  u32(out, spec.frames.length);
  u32(out, spec.frameRateMs ?? 100);
  u32(out, spec.doubled ? 4 : 0);
  for (let index = 0; index < 7; index += 1) u32(out, 0); // audio sizes, unread
  u32(out, trees.length);
  // The four tree sizes, which this reader does not need but the format carries.
  for (let index = 0; index < 4; index += 1) u32(out, 0x10000);
  for (let track = 0; track < 7; track += 1) {
    // Track 0 present and uncompressed 8-bit mono, when the spec asks for it.
    u32(out, track === 0 && spec.audioRate ? 0x40000000 | spec.audioRate : 0);
  }
  u32(out, 0); // the header's trailing word

  for (const body of bodies) u32(out, body.length);
  for (const kind of kinds) out.push(kind);
  for (const byte of trees) out.push(byte);
  for (const body of bodies) for (const byte of body) out.push(byte);
  return Uint8Array.from(out);
}
