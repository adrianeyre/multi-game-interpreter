import { readS16LE, readU16LE } from '../util/ByteStream.js';

/**
 * A parsed classic costume — the animated sprite format v2 to v6 all use.
 *
 * A costume is a bank of up to 16 independently animated *limbs*. Each limb
 * runs its own little program of animation commands, and a "frame" (walk,
 * stand, talk) is really a table saying where each limb's program should start
 * and stop. That is how a character can blink and talk while walking without
 * the artists drawing every combination.
 *
 * Every offset inside a costume is relative to `base`, and **`base` depends on
 * the version**: v4 counts from byte 0 of the `CO` block, v5 from byte 2 of the
 * `COST` chunk, v6 from byte 8 — past the chunk header. A few bytes, and they
 * are the difference between a costume and noise. It is worth saying what the noise looks like, because it
 * does not look like a failure: a v6 costume read at v5's base yields a
 * plausible animation count and a nonsense format byte, decodes to no limbs at
 * all, and drew *something* on screen while making the importer walk a table
 * of garbage for minutes.
 *
 * Layout, relative to `base`:
 *
 *   +6   number of animations
 *   +7   format byte; bit 7 suppresses mirroring
 *   +8   palette, 16 or 32 bytes depending on format
 *   then 16 bit offset of the animation command stream
 *        16 limb frame tables, 16 bit offsets
 *        32 animation definitions, 16 bit offsets
 *
 * From `ClassicCostumeLoader::loadCostume`, which advances the pointer by 8
 * for v6 and by 2 for v5.
 */
export class Costume {
  readonly id: number;
  readonly data: Uint8Array;
  /** Where this version's offsets are counted from. */
  readonly base: number;

  readonly numAnim: number;
  readonly format: number;
  /** When set, the costume supplies its own left-facing frames. */
  readonly noMirror: boolean;
  readonly numColors: number;
  readonly palette: Uint8Array;

  readonly animCmdsOffset: number;
  readonly frameOffsetsOffset: number;
  readonly dataOffsetsOffset: number;

  constructor(id: number, data: Uint8Array, version = 5) {
    this.id = id;
    this.data = data;
    // Two numbers that look like one. The offsets inside a costume are
    // counted from a fixed distance into the resource *as this engine hands it
    // over*, header included — and the header is eight bytes at v5 and six at
    // v4, so the same point in the costume is two bytes earlier in a v4
    // resource. All 165 costumes in the Loom CD install carry format byte 0x58
    // at base 0 and none of them do at base 2, which is what settled it.
    this.base = version >= 6 ? 8 : version >= 5 ? 2 : 0;

    this.numAnim = data[this.base + 6];
    const formatByte = data[this.base + 7];
    this.format = formatByte & 0x7f;
    this.noMirror = (formatByte & 0x80) !== 0;

    switch (this.format) {
      case 0x58:
        this.numColors = 16;
        break;
      case 0x59:
        this.numColors = 32;
        break;
      // 0x60 and 0x61 are v6's own, and the only difference from 0x58 and
      // 0x59 is that they exist.
      case 0x60:
        this.numColors = 16;
        break;
      case 0x61:
        this.numColors = 32;
        break;
      default:
        // Refused rather than guessed at. A wrong format byte means the base
        // is wrong, and everything read after it — the palette, the offset
        // tables, every cel — is somebody else's bytes. Assuming 16 colours
        // and carrying on is what let a whole version's costumes be misread
        // in silence.
        throw new Error(
          `Costume ${id} has format byte 0x${this.format.toString(16)}, which is not one of ` +
            `0x58, 0x59, 0x60 or 0x61. Either this is not a costume or it is not the ` +
            `version it was read as (v${version}).`,
        );
    }

    this.palette = data.subarray(this.base + 8, this.base + 8 + this.numColors);

    const tableBase = this.base + 8 + this.numColors;
    this.animCmdsOffset = this.base + readU16LE(data, tableBase);
    this.frameOffsetsOffset = tableBase + 2;
    this.dataOffsetsOffset = tableBase + 34;
  }

  /** Colour bits per RLE byte: 16 colour costumes pack 4, 32 colour pack 5. */
  get colorShift(): number {
    return this.numColors === 32 ? 3 : 4;
  }

  get colorMask(): number {
    return this.numColors === 32 ? 7 : 15;
  }

  animCommand(index: number): number {
    return this.data[this.animCmdsOffset + index] ?? 0;
  }
}

/** Per-limb animation state for one actor. */
export interface CostumeData {
  /** Current position in the command stream, 0xFFFF when the limb is unused. */
  curpos: Uint16Array;
  start: Uint16Array;
  end: Uint16Array;
  frame: Uint16Array;
  /** Bit mask of limbs frozen by a `0x79` command. */
  stopped: number;
  animCounter: number;
  soundCounter: number;
}

export function createCostumeData(): CostumeData {
  return {
    curpos: new Uint16Array(16).fill(0xffff),
    start: new Uint16Array(16),
    end: new Uint16Array(16),
    frame: new Uint16Array(16),
    stopped: 0,
    animCounter: 0,
    soundCounter: 0,
  };
}

/** SCUMM facings are degrees; costumes index frames by a 0-3 quadrant. */
export function newDirToOldDir(dir: number): number {
  if (dir >= 71 && dir <= 109) return 1; // east
  if (dir >= 109 && dir <= 251) return 2; // south
  if (dir >= 251 && dir <= 289) return 0; // west
  return 3; // north
}

export function oldDirToNewDir(dir: number): number {
  return [270, 90, 180, 0][dir & 3];
}

/**
 * Points each limb at the animation for `frame` in the actor's current facing.
 *
 * `useMask` selects which limbs to update, so a script can restart only the
 * legs (walking) and leave the head mid-sentence.
 */
export function costumeDecodeData(
  costume: Costume,
  cost: CostumeData,
  facing: number,
  frame: number,
  useMask: number,
): void {
  // `anim` picks the animation for this frame *in this direction*; `frame` is
  // the direction-independent number. Only the latter may be recorded per limb:
  // turning an actor re-decodes each limb by feeding `cost.frame[limb]` back in
  // as `frame`, so storing `anim` there compounds the direction on every turn
  // until it exceeds `numAnim`, and the limb is then left undecoded — an actor
  // that turns loses the parts of its body whose limbs had been animating.
  const anim = newDirToOldDir(facing) + frame * 4;
  if (anim > costume.numAnim) return;

  const { data, base } = costume;
  const animOffset = readU16LE(data, costume.dataOffsetsOffset + anim * 2);
  let cursor = base + animOffset;
  if (cursor === base) return; // offset 0 means "no animation"

  let mask = readU16LE(data, cursor);
  cursor += 2;

  let usemask = useMask;
  let limb = 0;

  while (mask & 0xffff) {
    if (mask & 0x8000) {
      const j = readU16LE(data, cursor);
      cursor += 2;

      if (usemask & 0x8000) {
        if (j === 0xffff) {
          cost.curpos[limb] = 0xffff;
          cost.start[limb] = 0;
          cost.frame[limb] = frame;
        } else {
          const extra = data[cursor++];
          const cmd = costume.animCommand(j);
          if (cmd === 0x7a) {
            cost.stopped &= ~(1 << limb);
          } else if (cmd === 0x79) {
            cost.stopped |= 1 << limb;
          } else {
            cost.start[limb] = j;
            cost.end[limb] = j + (extra & 0x7f);
            // Bit 7 means "play once and hold" rather than loop.
            cost.curpos[limb] = extra & 0x80 ? j | 0x8000 : j;
            cost.frame[limb] = frame;
          }
        }
      } else if (j !== 0xffff) {
        cursor++;
      }
    }
    limb++;
    usemask = (usemask << 1) & 0xffff;
    mask = (mask << 1) & 0xffff;
  }
}

/** Advances one limb; returns true if the drawn cel changed. */
export function increaseAnim(costume: Costume, cost: CostumeData, limb: number): boolean {
  if (cost.curpos[limb] === 0xffff) return false;

  const highflag = cost.curpos[limb] & 0x8000;
  let i = cost.curpos[limb] & 0x7fff;
  const end = cost.end[limb];
  const code = costume.animCommand(i) & 0x7f;

  // The loop below only exits on a command that is not a counter tick. A limb
  // whose whole range is ticks — which garbage or unexpected costume data
  // decodes to — would never leave it, so the range length is also the bound.
  let guard = Math.max(1, end - cost.start[limb]) + 2;

  for (;;) {
    if (guard-- <= 0) {
      cost.curpos[limb] = i | highflag;
      return false;
    }

    if (!highflag) {
      if (i++ >= end) i = cost.start[limb];
    } else if (i !== end) {
      i++;
    }

    const next = costume.animCommand(i);

    if (next === 0x7c) {
      // "Tick the animation counter" — used by scripts waiting on animation.
      cost.animCounter++;
      if (cost.start[limb] !== end) continue;
    } else if (next === 0x78) {
      cost.soundCounter++;
      if (cost.start[limb] !== end) continue;
    }

    cost.curpos[limb] = i | highflag;
    return (costume.animCommand(i) & 0x7f) !== code;
  }
}

export function increaseAnims(costume: Costume, cost: CostumeData): boolean {
  let changed = false;
  for (let limb = 0; limb < 16; limb++) {
    if (cost.curpos[limb] !== 0xffff) changed = increaseAnim(costume, cost, limb) || changed;
  }
  return changed;
}

export interface Cel {
  width: number;
  height: number;
  /** Offset in the costume of the run-length encoded pixel data. */
  dataOffset: number;
  /** Position of this cel relative to the actor's feet. */
  relX: number;
  relY: number;
  /** How far the actor's origin moves after drawing this cel. */
  moveX: number;
  moveY: number;
}

/**
 * Resolves which cel a limb should draw, or `null` for "draw nothing".
 *
 * Command `0x7B` is the explicit "this limb is empty in this frame" marker,
 * which is how e.g. a character's sword disappears when sheathed.
 */
export function getLimbCel(costume: Costume, cost: CostumeData, limb: number): Cel | null {
  if (cost.curpos[limb] === 0xffff || cost.stopped & (1 << limb)) return null;

  const { data, base } = costume;
  const i = cost.curpos[limb] & 0x7fff;
  const code = costume.animCommand(i) & 0x7f;
  if (code === 0x7b) return null;

  const frameOffset = readU16LE(data, costume.frameOffsetsOffset + limb * 2);
  const framePtr = base + frameOffset;
  const celOffset = readU16LE(data, framePtr + code * 2);
  const src = base + celOffset;
  if (src + 12 > data.length) return null;

  const cel: Cel = {
    width: readU16LE(data, src),
    height: readU16LE(data, src + 2),
    relX: readS16LE(data, src + 4),
    relY: readS16LE(data, src + 6),
    moveX: readS16LE(data, src + 8),
    moveY: readS16LE(data, src + 10),
    dataOffset: src + 12,
  };

  if (cel.width === 0 || cel.height === 0) return null;
  return cel;
}

/**
 * Expands a cel's run-length encoding into column-major pixel indices.
 *
 * Each byte packs a colour and a run length; a zero length means the real
 * length follows in the next byte. Runs continue across column boundaries,
 * which is why this decodes the whole cel rather than working row by row.
 */
/**
 * Expands a cel's run-length data.
 *
 * The result is **column-major**: pixel (x, y) is at `x * height + y`. That is
 * the order the runs themselves are stored in — each one fills downward and
 * wraps to the top of the next column — and the order the renderer walks, so
 * decoding writes the stream straight out without reordering. Anything that
 * wants an image rather than something to draw needs `celToRowMajor`.
 */
export function decodeCel(costume: Costume, cel: Cel): Uint8Array {
  const out = new Uint8Array(cel.width * cel.height);
  const { data } = costume;
  const shift = costume.colorShift;
  const mask = costume.colorMask;

  let src = cel.dataOffset;
  let index = 0;
  const total = cel.width * cel.height;

  while (index < total && src < data.length) {
    const byte = data[src++];
    const color = byte >> shift;
    let len = byte & mask;
    if (len === 0) len = data[src++] ?? 0;
    if (len === 0) break;

    for (let n = 0; n < len && index < total; n++) out[index++] = color;
  }

  return out;
}

/**
 * Reorders a decoded cel into ordinary row-major pixels.
 *
 * The renderer reads cels column by column and never needs this. An editor, an
 * exporter or anything else treating a cel as a picture does: read
 * column-major data as rows and every sprite comes out transposed and smeared
 * into blobs of colour.
 */
export function celToRowMajor(cel: Cel, pixels: Uint8Array): Uint8Array {
  const out = new Uint8Array(cel.width * cel.height);
  for (let x = 0; x < cel.width; x++) {
    for (let y = 0; y < cel.height; y++) {
      out[y * cel.width + x] = pixels[x * cel.height + y];
    }
  }
  return out;
}
