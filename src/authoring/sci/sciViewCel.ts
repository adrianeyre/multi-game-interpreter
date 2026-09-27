/**
 * A V56 cel's artwork, re-encoded and written back where it was (row 17).
 *
 * `writeSciView` patches a V56 View in place and until this file patched only
 * the displacement: a cel body is two run-length streams whose length would
 * change on re-encoding, and every record after it points at a fixed offset.
 * That argument is about a body that *grows*. A body that re-encodes into no
 * more bytes than the original occupied can be written over it and nothing
 * else moves — which is the case `packSci11Cel` was written for and was never
 * called for.
 *
 * ## The fit, measured rather than guessed
 *
 * A V56 record does not store its streams' lengths, so the room is measured:
 * the old cel is decoded and the control and literal bytes it actually
 * consumed are its extent. Anything past that belongs to someone else or to
 * nobody, and is never written. A new body that needs more than either
 * extent is refused with both numbers in the sentence, because "it does not
 * fit" without the sizes is not something an author can act on — a simpler
 * image, or fewer colours, often does fit.
 *
 * ## SCI32's row table
 *
 * ScummVM's SCI32 renderer (`celobj32.cpp`, `READER_Compressed`) does not
 * decode a cel as one stream: offset 32 of the record names a table of
 * `2 × height` words, each row's start in the control stream and in the
 * literal stream, and each row is decoded from its own start. So every row is
 * encoded on its own here, runs never crossing a row boundary — which is also
 * a valid single stream for the SCI1.1 reader and for this project's — and
 * the table is rewritten when the record has one.
 *
 * Whether it has one is asked of the bytes, the way ADR 0020 asks everything:
 * the word at 32 is taken for a row table only when the table it points at is
 * exactly the row starts the old cel's own decode produced. A SCI1.1 record
 * has no such table and whatever is at 32 there is left alone.
 *
 * ## What else it refuses
 *
 * - A cel whose streams another cel's record also names. Writing one would
 *   repaint both, and the author asked for one.
 *
 * Where the control bytes end exactly where the literals begin, the two
 * extents are pooled and the literal offset in this cel's own record moves —
 * see the comment at the fit test.
 * - A mirrored loop's cel, which has no record of its own (`recordAt`).
 * - Anything whose re-read does not come back as exactly the pixels asked
 *   for. That check runs on every patch: the encoder and the reader are two
 *   pieces of code, and the only proof they agree about this cel is the cel.
 */

import {
  packSci11Cel,
  readSci11Cel,
  type SciCel,
  type SciViewResource,
} from '../../engine/sci/gfx/SciView.js';

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

function putU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
  bytes[at + 2] = (value >> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

/** How far the old body reached, and where each of its rows began. */
interface Extent {
  controlBytes: number;
  literalBytes: number;
  /** Row starts relative to each stream, or null when a run crossed a row. */
  rows: { control: number[]; literal: number[] } | null;
}

/**
 * Decodes the old body for its size, with the same reading `readSci11Cel`
 * makes: a control byte's top two bits are the operation and the low six the
 * run, and literals follow inline when there is no literal offset.
 */
function measure(
  resource: Uint8Array,
  rleAt: number,
  literalAt: number,
  width: number,
  height: number,
): Extent {
  const inline = literalAt === 0;
  const total = width * height;
  let control = rleAt;
  let literal = literalAt;
  let written = 0;
  const rows = { control: [] as number[], literal: [] as number[] };
  let crossed = false;

  while (written < total && control < resource.length) {
    if (written % width === 0 && rows.control.length === written / width) {
      rows.control.push(control - rleAt);
      rows.literal.push(inline ? 0 : literal - literalAt);
    }
    const byte = resource[control++];
    const run = byte & 0x3f;
    const operation = byte & 0xc0;
    const start = written;
    if (operation === 0x00) {
      const taken = Math.min(run, total - written);
      if (inline) control += taken;
      else literal += taken;
      written += taken;
    } else if (operation === 0x80) {
      if (inline) control++;
      else literal++;
      written = Math.min(total, written + run);
    } else {
      written = Math.min(total, written + run);
    }
    // A run that ends past the next row's first pixel crossed a boundary.
    if (Math.floor(start / width) !== Math.floor((written - 1) / width) && run > 0) crossed = true;
  }

  return {
    controlBytes: control - rleAt,
    literalBytes: inline ? 0 : literal - literalAt,
    rows: crossed || rows.control.length !== height ? null : rows,
  };
}

/** Whether the word at 32 names exactly this cel's row table. */
function rowTableAt(
  resource: Uint8Array,
  recordAt: number,
  height: number,
  extent: Extent,
): number | null {
  if (!extent.rows) return null;
  const at = u32(resource, recordAt + 32);
  if (at === 0 || at + height * 8 > resource.length) return null;
  for (let y = 0; y < height; y++) {
    if (u32(resource, at + y * 4) !== extent.rows.control[y]) return null;
    if (u32(resource, at + (height + y) * 4) !== extent.rows.literal[y]) return null;
  }
  return at;
}

/**
 * The View's bytes with one cel's pixels written into its own record, or a
 * sentence saying why they cannot be.
 *
 * `pixels` is one index per pixel at the cel's own size, `clearKey` where the
 * cel is transparent.
 */
export function patchSciV56CelPixels(
  view: SciViewResource,
  cel: SciCel,
  pixels: Uint8Array,
  label: string,
): Uint8Array | string {
  const source = view.source;
  if (view.encoding !== 'v56' || !source) {
    return `${label} is not a V56 cel with its bytes kept, so there is no record to patch`;
  }
  if (cel.recordAt === undefined) {
    return (
      `${label} is a mirrored loop's cel and has no record of its own — its pixels are the ` +
      `loop it mirrors, and writing them would repaint that loop too`
    );
  }
  const others: number[] = [];
  for (const loop of view.loops) {
    for (const other of loop.cels) {
      if (other.recordAt !== undefined && other.recordAt !== cel.recordAt) {
        others.push(other.recordAt);
      }
    }
  }
  return patchSciCelRecord(source, cel.recordAt, cel, pixels, label, {
    declaresCompression: true,
    others,
  });
}

/**
 * A cel Picture's bytes with one item's pixels written into its own header.
 *
 * The same record as a V56 View's cel (`SciCelPicture.ts` says why: SCI1.1's
 * Picture cel, SCI2's and the V56 View's are one 42-byte header), so the same
 * patch — fit measured, row table kept true, re-read before it is kept. The one
 * difference is SCI1.1's container, which puts something other than a
 * compression method at offset 9 and is always run-length encoded.
 */
export function patchSciCelPicturePixels(
  bytes: Uint8Array,
  container: 'sci11' | 'sci32',
  item: { headerAt: number; width: number; height: number },
  otherItems: readonly number[],
  pixels: Uint8Array,
  label: string,
): Uint8Array | string {
  const cel = readSci11Cel(bytes, item.headerAt, container === 'sci32');
  if (!cel) return `${label} has no cel header this project can read, so there is nothing to patch`;
  return patchSciCelRecord(bytes, item.headerAt, cel, pixels, label, {
    declaresCompression: container === 'sci32',
    others: otherItems.filter((at) => at !== item.headerAt),
  });
}

/**
 * The shared half: one V56-shaped cel record, re-encoded where it lies.
 *
 * `others` are the other records in the same resource, so a body two of them
 * name is refused rather than repainted twice.
 */
function patchSciCelRecord(
  source: Uint8Array,
  at: number,
  cel: { width: number; height: number; clearKey: number },
  pixels: Uint8Array,
  label: string,
  options: { declaresCompression: boolean; others: readonly number[] },
): Uint8Array | string {
  if (pixels.length !== cel.width * cel.height) {
    return `${label} is ${cel.width}x${cel.height}, and the pixels are a different size`;
  }

  // SCI1.1's Picture cel has no method byte at 9; its body is always RLE.
  const compression = options.declaresCompression ? source[at + 9] : 138;
  const rleAt = u32(source, at + 24);
  const literalAt = u32(source, at + 28);
  const out = new Uint8Array(source);

  // Another record naming the same body would be repainted with this one.
  for (const other of options.others) {
    const otherLiteral = u32(source, other + 28);
    if (u32(source, other + 24) === rleAt || (literalAt !== 0 && otherLiteral === literalAt)) {
      return (
        `${label} shares its pixel data with the cel whose record is at ${other}, so ` +
        `writing over one would repaint both`
      );
    }
  }

  if (compression === 0 && literalAt === 0) {
    // SCI32's uncompressed cel: the pixels are simply there, so they always fit.
    out.set(pixels, rleAt);
  } else {
    const extent = measure(source, rleAt, literalAt, cel.width, cel.height);
    const table = rowTableAt(source, at, cel.height, extent);
    const inline = literalAt === 0;

    // Row by row, so a renderer that seeks to a row finds one starting there.
    const control: number[] = [];
    const literal: number[] = [];
    const starts = { control: [] as number[], literal: [] as number[] };
    for (let y = 0; y < cel.height; y++) {
      starts.control.push(control.length);
      starts.literal.push(literal.length);
      const row = pixels.subarray(y * cel.width, (y + 1) * cel.width);
      const packed = packSci11Cel(row, cel.clearKey, inline);
      control.push(...packed.control);
      literal.push(...packed.literal);
    }

    // **Pooled when the two streams are neighbours.** The record names both
    // starts, and it is this cel's own record, so where the literal stream
    // begins can move: when the old control bytes end exactly where the old
    // literals begin, the two extents are one run of bytes and the new body
    // may divide it differently. A repaint that trades literals for runs is
    // the common case, and refusing it because each half did not fit on its
    // own would refuse bodies that are smaller than the original.
    const pooled = !inline && rleAt + extent.controlBytes === literalAt;
    const room = extent.controlBytes + extent.literalBytes;
    const fits = pooled
      ? control.length + literal.length <= room
      : control.length <= extent.controlBytes && literal.length <= extent.literalBytes;
    if (!fits) {
      return (
        `${label} re-encodes to ${control.length} control and ${literal.length} literal bytes, ` +
        `and the original occupied ${extent.controlBytes} and ${extent.literalBytes}` +
        (pooled ? ` (${room} between them, which the new body may divide as it needs)` : '') +
        `. A V56 cel is patched in place — every record after it points at a fixed offset — ` +
        `so a body that grows is refused rather than written over the next one. Fewer ` +
        `colours or larger flat areas re-encode smaller.`
      );
    }

    out.set(control, rleAt);
    if (!inline) {
      const newLiteralAt = pooled ? rleAt + control.length : literalAt;
      out.set(literal, newLiteralAt);
      putU32(out, at + 28, newLiteralAt);
    }
    if (table !== null) {
      for (let y = 0; y < cel.height; y++) {
        putU32(out, table + y * 4, starts.control[y]);
        putU32(out, table + (cel.height + y) * 4, starts.literal[y]);
      }
    }
  }

  // The proof: read back through the reader the rest of this project uses.
  const reread = readSci11Cel(out, at, options.declaresCompression);
  if (!reread || reread.pixels.some((value, index) => value !== pixels[index])) {
    return `${label} did not read back as the pixels written, so it was not patched`;
  }
  return out;
}
