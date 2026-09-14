/**
 * The second kind of Picture: an arrangement of cels (ADR 0018).
 *
 * `pictureKind.ts` already draws the line — vector and cel Pictures are **two
 * resource kinds that happen to share a resource type number**, not one reader
 * with a Version mode. This file is the second kind's reader, and it exists
 * because `SciPicture` was right to refuse these rather than walk a bitmap as
 * though it were a list of drawing operations.
 *
 * ## One reader for two Versions, which is not the same as one for two kinds
 *
 * SCI1.1 introduced cel Pictures alongside its vectors behind a header size of
 * `0x26`; by SCI2 they are essentially all there is, behind a header size of
 * `0x0e` that carries the display resolution. The two containers differ, and
 * **the cel header inside them does not** — and it is not a Picture's cel
 * header either. It is the V56 View's, byte for byte, which is why this file
 * reads containers and `SciView.readSci11Cel` reads cels.
 *
 * That is a claim about the format rather than a convenience, and it is the
 * same claim ADR 0018 makes: the drift from SCI1.1 to SCI2 is a Picture growing
 * more cels and losing its vectors, not a new way of storing a cel.
 *
 * ## What SCI32 adds, and why it matters to the editor
 *
 * A SCI32 cel header carries a **priority and a position of its own** at the
 * end. That is a screen item written down: a SCI2 room's composition is Planes
 * with items at priorities, and the Picture is where the authored ones live.
 * Read here rather than inferred at draw time, because #227 wants them as
 * structure an author can edit and not as an accident of draw order.
 *
 * ## Verified against real data, not from memory
 *
 * Every offset below was read out of the demos in `games/`: King's Quest VI and
 * Gabriel Knight for the `0x26` container, Torin's Passage, Space Quest 6,
 * King's Quest VII and Lighthouse for `0x0e`. The uncompressed case is
 * self-checking and was checked — `dataOffset + width * height` is exactly the
 * resource length for Torin's 632x316, Space Quest 6's 640x480 and Lighthouse's
 * 500x300 backgrounds.
 */

import { readSci11Cel, type SciCel } from './SciView.js';

/** One cel placed into a Picture, with what SCI32 says about where it goes. */
export interface SciPlacedCel {
  cel: SciCel;
  /**
   * Where the cel sits on its Plane.
   *
   * Zero for a SCI1.1 Picture, whose single cel is the whole background, and
   * meaningful from SCI2 on, where a Picture is several items at positions.
   */
  x: number;
  y: number;
  /**
   * What this item occludes and is occluded by.
   *
   * A SCI32 Plane carries no mask, so this only orders the item in the display
   * list — which is the whole of ADR 0015's claim about the two renderers, and
   * the reason this is the same field `ScreenItem.priority` is.
   */
  priority: number;
}

export interface SciCelPictureResult {
  /** `0x26` for SCI1.1's container and `0x0e` for SCI32's. */
  container: 'sci11' | 'sci32';
  cels: SciPlacedCel[];
  /** Where the palette sits in the resource, for the caller to read. */
  paletteOffset: number;
  /**
   * The span of vector operations after the cels, for a SCI1.1 Picture.
   *
   * SCI1.1 kept both in one resource — the bitmap first and the drawing
   * operations after it, which is what still paints the priority and control
   * buffers a SCI16 Plane needs. Handed back as a span rather than drawn here,
   * so that the vector reader stays the one thing that knows about vectors.
   */
  vectorData: Uint8Array | null;
  /** The display size a SCI32 Picture declares, when it declares one. */
  resolution: { width: number; height: number } | null;
  /** What could not be read, by offset — never silently skipped. */
  unknown: { at: number; why: string } | null;
}

/**
 * The cel header is 42 bytes in both containers.
 *
 * Not a coincidence and not worth two constants: SCI1.1's Picture cel and
 * SCI32's are the same record — the same one a V56 View carries — and SCI2 only
 * started using the fields at the end of it.
 */
const CEL_HEADER_SIZE = 42;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function s16(bytes: Uint8Array, at: number): number {
  const value = u16(bytes, at);
  return value > 0x7fff ? value - 0x10000 : value;
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * Reads a cel Picture, whichever container it arrived in.
 *
 * Refuses rather than guesses at every step where the resource disagrees with
 * itself, because a Picture read at the wrong offset still produces pixels —
 * `docs/processes/verifying-version-support.md` names that fault class exactly,
 * and it is the reason this reader reports `unknown` instead of returning
 * something plausible.
 */
export function readSciCelPicture(resource: Uint8Array): SciCelPictureResult {
  if (resource.length < 14) {
    return blank('sci32', { at: 0, why: 'shorter than a Picture header' });
  }

  const header = u16(resource, 0);
  if (header === 0x26) return readSci11CelPicture(resource);
  if (header === 0x0e) return readSci32CelPicture(resource);
  return blank('sci32', { at: 0, why: `header size 0x${header.toString(16)} is neither kind` });
}

function blank(
  container: 'sci11' | 'sci32',
  unknown: { at: number; why: string },
): SciCelPictureResult {
  return { container, cels: [], paletteOffset: 0, vectorData: null, resolution: null, unknown };
}

/**
 * SCI1.1's container: one background cel, then the vector operations.
 *
 * The header is a fixed 38 bytes with three offsets in it that matter — where
 * the vectors start, where the palette is, and where the single cel's header
 * sits. `hasCel` at offset 4 is a count in name only: every SCI1.1 Picture this
 * project has seen carries exactly one, and a Picture claiming none is a
 * Picture that is all vectors, which is the other reader's job.
 */
function readSci11CelPicture(resource: Uint8Array): SciCelPictureResult {
  const hasCel = u16(resource, 4);
  const vectorAt = u32(resource, 16);
  const paletteOffset = u32(resource, 28);
  const celHeaderAt = u32(resource, 32);

  const vectorData =
    vectorAt > 0 && vectorAt < resource.length ? resource.subarray(vectorAt) : null;

  if (!hasCel) {
    return {
      container: 'sci11',
      cels: [],
      paletteOffset,
      vectorData,
      resolution: null,
      unknown: null,
    };
  }

  if (celHeaderAt + CEL_HEADER_SIZE > resource.length) {
    return blank('sci11', { at: celHeaderAt, why: 'cel header past the end of the resource' });
  }

  const placed = readPlacedCel(resource, celHeaderAt, 'sci11');
  if ('why' in placed) return blank('sci11', placed);

  return {
    container: 'sci11',
    cels: [placed],
    paletteOffset,
    vectorData,
    resolution: null,
    unknown: null,
  };
}

/**
 * SCI32's container: a count of cels, each an item with its own place.
 *
 * The header is 14 bytes and the cel headers follow it end to end. The
 * resolution at offsets 10 and 12 is the display size this Picture was composed
 * for — 640x480 for every full-screen one read here, and zero for the handful
 * that carry SCI1.1-sized artwork inside a SCI32 game, which means "whatever
 * the game is running at" rather than "no size".
 */
function readSci32CelPicture(resource: Uint8Array): SciCelPictureResult {
  const headerSize = u16(resource, 0);
  const celCount = resource[2];
  const celHeaderSize = u16(resource, 4) || CEL_HEADER_SIZE;
  const paletteOffset = u32(resource, 6);
  const width = u16(resource, 10);
  const height = u16(resource, 12);

  const cels: SciPlacedCel[] = [];
  let unknown: { at: number; why: string } | null = null;

  for (let index = 0; index < celCount; index++) {
    const at = headerSize + celHeaderSize * index;
    if (at + CEL_HEADER_SIZE > resource.length) {
      unknown ??= { at, why: `cel ${index}'s header is past the end of the resource` };
      break;
    }
    const placed = readPlacedCel(resource, at, 'sci32');
    // One unreadable cel does not discard the ones that read: a Picture with
    // nine good items and a tenth this project cannot decode is more useful
    // shown with nine and the fault named than refused whole.
    if ('why' in placed) unknown ??= placed;
    else cels.push(placed);
  }

  return {
    container: 'sci32',
    cels,
    paletteOffset,
    vectorData: null,
    // Zero means the Picture declines to say, which is not the same as zero by
    // the width. Reported as null so a caller falls back to the game's own
    // resolution rather than compositing into nothing.
    resolution: width > 0 && height > 0 ? { width, height } : null,
    unknown,
  };
}

/**
 * One 42-byte cel header and the pixels it points at.
 *
 * The SCI32 fields at the end are read for both containers because reading a
 * zero costs nothing and a branch costs a reader that has to know which Version
 * it is in — which is the shape ADR 0018 rejects.
 */
function readPlacedCel(
  resource: Uint8Array,
  at: number,
  container: 'sci11' | 'sci32',
): SciPlacedCel | { at: number; why: string } {
  // Only SCI32's container puts a compression method at offset 9. SCI1.1's
  // Pictures carry something else there — `0x0a` in King's Quest VI — and
  // reading it as a method refuses every background in the game.
  const cel = readSci11Cel(resource, at, container === 'sci32');
  if (!cel) {
    return {
      at,
      why:
        `a cel header this reader could not use — an implausible size, a compression ` +
        `method it does not read, or data running past the end of the resource`,
    };
  }

  // SCI1.1's cel header stops before these fields; SCI32 uses them to say where
  // the item goes and what it occludes. Read for both because reading a zero
  // costs nothing, and a branch costs a reader that has to know its Version —
  // which is the shape ADR 0018 rejects.
  const priority = container === 'sci32' ? s16(resource, at + 36) : 0;
  const x = container === 'sci32' ? s16(resource, at + 38) : 0;
  const y = container === 'sci32' ? s16(resource, at + 40) : 0;

  return { cel, x, y, priority };
}
