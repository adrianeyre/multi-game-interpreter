/**
 * AGI Views: loops of cels, which are AGI's sprites.
 *
 * A family sibling of `src/engine/gfx/Costume.ts` and
 * `src/engine/gfx/costume/akos.ts`, not a version leaf under them. Per ADR 0003
 * as narrowed by ADR 0007, version leaves live inside subsystems — but AGI is a
 * second Engine family, and its View format is unrelated to either SCUMM
 * costume format rather than being a third variant of one.
 *
 * The part with a trap in it is mirroring. A mirrored loop is stored **once**
 * and flipped at render time, so two entries in the View's loop offset table
 * point at the same bytes, and which of them is the original is written into
 * every cel's third byte. Read that as "this cel is flipped" rather than "this
 * cel is flipped when it is not the source loop" and the source loop renders
 * backwards — which looks like art, not like a bug (#128, #136).
 */

import { readU16LE } from '../../util/ByteStream.js';

export interface AgiCel {
  readonly width: number;
  readonly height: number;
  readonly transparent: number;
  /**
   * The loop this cel's bytes are stored under, when it is a mirror source.
   *
   * Read from the resource rather than inferred (#128). Null when the cel
   * carries no mirror flag at all, which is the common case.
   */
  readonly mirrorSourceLoop: number | null;
  /**
   * Row-major colour indices, `width * height` of them.
   *
   * Decoded once at load rather than per frame: a cel is at most 160x168 and a
   * game has a few hundred of them, so the whole set is well under a megabyte
   * and the alternative is re-running the run-length decoder every time an
   * object moves.
   */
  readonly pixels: Uint8Array;
  /** Where this cel's bytes start, so an editor can re-emit exactly. */
  readonly offset: number;
}

export interface AgiLoop {
  readonly cels: readonly AgiCel[];
  /** Where this loop's bytes start; two loops may share one offset. */
  readonly offset: number;
  /**
   * The loop whose bytes these are, when this loop is a mirror of another.
   *
   * Null for a loop that owns its own bytes. Set from the cels' own mirror
   * source rather than from the offset table, because sharing an offset is how
   * mirroring is *stored* and the source is what says which way round it is.
   */
  readonly mirrorOf: number | null;
}

export interface AgiViewResource {
  readonly loops: readonly AgiLoop[];
  /** The author's note, which some Views carry and most do not. */
  readonly description: string | null;
}

/**
 * Reads a View resource.
 *
 *   0     unknown, always 1 or 2 in real games
 *   1     unknown, always 1
 *   2     number of loops
 *   3..4  offset to the description string, or 0 for none
 *   5..   one 16-bit offset per loop, relative to the resource start
 *
 * A loop:
 *
 *   0     number of cels
 *   1..   one 16-bit offset per cel, relative to the *loop* start
 *
 * A cel:
 *
 *   0     width in AGI pixels, each two EGA pixels wide
 *   1     height
 *   2     bit 7 says this cel is mirrored, bits 6..4 hold the number of the
 *         loop that is *not* mirrored, bits 3..0 the transparent colour
 *   3..   run-length encoded rows
 *
 * The two offset bases differ — loops from the resource, cels from their loop —
 * and mixing them up puts every cel in the wrong place in a way that still
 * decodes to a plausible-looking sprite.
 */
export function readView(bytes: Uint8Array): AgiViewResource {
  if (bytes.length < 5) {
    throw new Error(
      `A View resource is ${bytes.length} bytes, which is shorter than its own ` +
        `five-byte header.`,
    );
  }

  const loopCount = bytes[2];
  const descriptionAt = readU16LE(bytes, 3);
  const headerEnd = 5 + loopCount * 2;
  if (headerEnd > bytes.length) {
    throw new Error(
      `This View claims ${loopCount} loops, whose offset table would end at ` +
        `${headerEnd} in a ${bytes.length} byte resource.`,
    );
  }

  const loopOffsets: number[] = [];
  for (let index = 0; index < loopCount; index++) {
    loopOffsets.push(readU16LE(bytes, 5 + index * 2));
  }

  const loops: AgiLoop[] = [];
  for (const [index, offset] of loopOffsets.entries()) {
    if (offset >= bytes.length) {
      throw new Error(
        `This View puts loop ${index} at offset ${offset} in a ${bytes.length} ` + `byte resource.`,
      );
    }
    const cels = readLoopCels(bytes, offset, index);
    // Two entries pointing at one place is how a mirror is stored, and the
    // cels' own mirror source is what says which of them owns the bytes.
    const source = cels[0]?.mirrorSourceLoop ?? null;
    loops.push({
      cels,
      offset,
      mirrorOf: source !== null && source !== index ? source : null,
    });
  }

  let description: string | null = null;
  if (descriptionAt > 0 && descriptionAt < bytes.length) {
    let end = descriptionAt;
    while (end < bytes.length && bytes[end] !== 0) end++;
    description = String.fromCharCode(...bytes.subarray(descriptionAt, end));
  }

  return { loops, description };
}

function readLoopCels(bytes: Uint8Array, loopAt: number, loopNumber: number): AgiCel[] {
  const celCount = bytes[loopAt];
  const cels: AgiCel[] = [];

  for (let index = 0; index < celCount; index++) {
    const tableAt = loopAt + 1 + index * 2;
    if (tableAt + 1 >= bytes.length) {
      throw new Error(
        `Loop ${loopNumber} claims ${celCount} cels, whose offset table runs ` +
          `past the end of the resource.`,
      );
    }
    // Relative to the loop, not the resource. This is the one that is easy to
    // get wrong, and getting it wrong still produces a sprite.
    const celAt = loopAt + readU16LE(bytes, tableAt);
    cels.push(readCel(bytes, celAt, loopNumber));
  }

  return cels;
}

function readCel(bytes: Uint8Array, at: number, loopNumber: number): AgiCel {
  if (at + 3 > bytes.length) {
    throw new Error(
      `Loop ${loopNumber} has a cel at offset ${at}, which is past the end of a ` +
        `${bytes.length} byte resource.`,
    );
  }

  const width = bytes[at];
  const height = bytes[at + 1];
  const flags = bytes[at + 2];
  const transparent = flags & 0x0f;
  const mirrored = (flags & 0x80) !== 0;
  const mirrorSourceLoop = mirrored ? (flags >> 4) & 0x07 : null;

  const pixels = new Uint8Array(width * height).fill(transparent);
  let cursor = at + 3;

  for (let y = 0; y < height; y++) {
    let x = 0;
    for (;;) {
      if (cursor >= bytes.length) {
        // A truncated cel is a truncated cel. The rows decoded so far are
        // kept — the transparent fill above means the rest is simply absent
        // rather than garbage — because refusing the whole View would lose
        // every other cel in it.
        return { width, height, transparent, mirrorSourceLoop, pixels, offset: at };
      }
      const chunk = bytes[cursor++];
      // A zero byte ends the row, which is also why a run can never be zero
      // pixels long: there would be no way to tell it from the terminator.
      if (chunk === 0) break;

      const colour = (chunk >> 4) & 0x0f;
      const run = chunk & 0x0f;
      for (let step = 0; step < run && x < width; step++) {
        pixels[y * width + x] = colour;
        x++;
      }
    }
    // A trailing run of the transparent colour is omitted by Sierra's own
    // tools, so a short row is normal rather than damaged — the fill above is
    // what makes that work.
  }

  return { width, height, transparent, mirrorSourceLoop, pixels, offset: at };
}

/**
 * Whether a loop renders flipped.
 *
 * The trap named at the top of this file. A mirrored cel carries the number of
 * the loop that is *not* flipped, so the same bytes render one way under their
 * own loop number and the other way under any loop that shares them.
 */
export function loopIsMirrored(cel: AgiCel, loopNumber: number): boolean {
  return cel.mirrorSourceLoop !== null && cel.mirrorSourceLoop !== loopNumber;
}

/**
 * Draws a cel into a 160-wide buffer, clipped and priority-tested.
 *
 * `x` and `y` are AGI's own convention: **`y` is the cel's bottom row**, not its
 * top, because an AGI object's position is where it stands. Treating it as the
 * top draws every sprite a cel-height too high, which looks like an art
 * alignment problem rather than a coordinate one.
 *
 * A pixel is drawn where the object's priority is at least the priority buffer's
 * value there. That is the whole of AGI's occlusion: scenery drawn into a high
 * band hides a sprite in a lower one, and the sprite needs no per-pixel mask of
 * its own (#127 produces the buffer, this consumes it).
 */
export function drawCel(
  cel: AgiCel,
  x: number,
  y: number,
  options: {
    /** Buffer to draw into, 160 wide. */
    target: Uint8Array;
    width: number;
    height: number;
    /** The Picture's priority buffer, same dimensions. Absent skips the test. */
    priority?: Uint8Array;
    /** The object's own priority, tested against the buffer. */
    objectPriority?: number;
    mirrored?: boolean;
  },
): void {
  const { target, width, height, priority, objectPriority = 15, mirrored = false } = options;
  const top = y - cel.height + 1;

  for (let row = 0; row < cel.height; row++) {
    const screenY = top + row;
    if (screenY < 0 || screenY >= height) continue;

    for (let column = 0; column < cel.width; column++) {
      const source = mirrored ? cel.width - 1 - column : column;
      const colour = cel.pixels[row * cel.width + source];
      if (colour === cel.transparent) continue;

      const screenX = x + column;
      if (screenX < 0 || screenX >= width) continue;

      const at = screenY * width + screenX;
      if (priority && objectPriority < priority[at]) continue;
      target[at] = colour;
    }
  }
}

/**
 * Re-emits a View, byte for byte where nothing changed.
 *
 * A mirrored loop is emitted once and pointed at twice, because that is how it
 * arrived — emitting it a second time would produce a working View that is not
 * the same bytes, which ADR 0013 counts as Unrecovered.
 */
export function writeView(view: AgiViewResource, description = view.description): Uint8Array {
  const loopBodies: number[][] = [];
  /** Which emitted body each loop points at, so mirrors share one. */
  const bodyForLoop: number[] = [];

  for (const [index, loop] of view.loops.entries()) {
    if (loop.mirrorOf !== null) {
      bodyForLoop[index] = bodyForLoop[loop.mirrorOf];
      continue;
    }

    const cels = loop.cels.map((cel) => {
      const flags =
        (cel.mirrorSourceLoop === null ? 0 : 0x80 | ((cel.mirrorSourceLoop & 0x07) << 4)) |
        (cel.transparent & 0x0f);
      return [cel.width, cel.height, flags, ...encodeCelRows(cel)];
    });

    const header = 1 + cels.length * 2;
    const offsets: number[] = [];
    let cursor = header;
    for (const cel of cels) {
      offsets.push(cursor);
      cursor += cel.length;
    }

    bodyForLoop[index] = loopBodies.length;
    loopBodies.push([
      cels.length,
      ...offsets.flatMap((offset) => [offset & 0xff, (offset >> 8) & 0xff]),
      ...cels.flat(),
    ]);
  }

  const descriptionBytes = description
    ? [...[...description].map((character) => character.charCodeAt(0)), 0]
    : [];

  const headerSize = 5 + view.loops.length * 2;
  const bodyStarts: number[] = [];
  let cursor = headerSize + descriptionBytes.length;
  for (const body of loopBodies) {
    bodyStarts.push(cursor);
    cursor += body.length;
  }

  const out: number[] = [
    2,
    1,
    view.loops.length,
    description ? headerSize & 0xff : 0,
    description ? (headerSize >> 8) & 0xff : 0,
  ];
  for (const index of view.loops.keys()) {
    const start = bodyStarts[bodyForLoop[index]];
    out.push(start & 0xff, (start >> 8) & 0xff);
  }
  out.push(...descriptionBytes, ...loopBodies.flat());
  return new Uint8Array(out);
}

/**
 * Run-length encodes a cel's rows.
 *
 * Runs cap at fifteen pixels because the count is a nibble, and a trailing run
 * of the transparent colour is dropped — both because that is what Sierra's
 * tools did, and byte-identity is measured against their output.
 */
function encodeCelRows(cel: AgiCel): number[] {
  const out: number[] = [];
  for (let y = 0; y < cel.height; y++) {
    const row = cel.pixels.subarray(y * cel.width, (y + 1) * cel.width);
    let end = row.length;
    while (end > 0 && row[end - 1] === cel.transparent) end--;

    let x = 0;
    while (x < end) {
      const colour = row[x];
      let run = 1;
      while (x + run < end && row[x + run] === colour && run < 15) run++;
      out.push(((colour & 0x0f) << 4) | run);
      x += run;
    }
    out.push(0);
  }
  return out;
}
