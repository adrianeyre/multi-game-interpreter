/**
 * Reads Lure of the Temptress's disk containers — `DISK1.VGA` and its siblings.
 *
 * Every field below was derived from the game's own executable and then
 * confirmed against the shipped files, rather than inferred from what the bytes
 * looked like. That order matters: three earlier readings of this directory
 * looked right and were wrong, and each was caught by arithmetic rather than by
 * inspection (#261).
 *
 * **The lookup is a linear scan**, not a hash or a binary search: the game walks
 * 192 eight-byte records comparing a requested id against each record's first
 * word. The count is 192 rather than 191 because the scan starts at the header,
 * which occupies the first slot. Resource ids therefore need no ordering.
 *
 * **Offsets are in 32-byte units.** The seek routine multiplies by `0x20`
 * before calling DOS, which is where the unit comes from; it is not a guess
 * fitted to the data. A 16-bit unit count reaches ~2.1 MB, comfortably past the
 * largest shipped disk at ~699 KB.
 *
 * **Byte 3 is the size's high byte**, and reading it as anything else costs
 * resources. It has defeated three readings now, and the third was this file's
 * own: it took byte 3 as a *disk indicator* and skipped every entry whose byte 3
 * was non-zero, on the evidence that "613 of 613" entries with byte 3 of zero
 * addressed data inside their own file. That evidence was self-confirming —
 * it only ever looked at the entries the rule kept — and it silently dropped
 * **13 real resources**, among them one of 106,716 bytes and one of 129,431.
 *
 * What settles it is the gap to the next resource. For each of those 13, the
 * distance from its offset to the next resource's offset matches the
 * **extended** size to within 4 to 28 bytes — the same 32-byte alignment slack
 * every container ends with — while the 16-bit size alone leaves 60 to 130 KB
 * of hole that nothing accounts for. ScummVM's `create_lure` names the field
 * `sizeExtension` and derives it as `(size >> 16) & 0xff`, which agrees.
 *
 * **An empty slot is `0xffff`, not a byte-3 value.** Across all eight
 * containers there are 626 real ids and 902 slots whose id is `0xffff`, and the
 * two sets are told apart by the id alone with no exceptions — so that is the
 * test, rather than inferring emptiness from a field that means something else.
 *
 * Verified over all eight containers: 626 resources, no two of which overlap,
 * every first resource beginning at 1536 — the header size exactly — and every
 * last resource ending 6 to 29 bytes from the end of its file.
 */

const MAGIC = 'heywow';
const MAGIC_BYTES = 6;

/** 8 header bytes plus 191 entries; the header occupies the scan's first slot. */
export const LURE_HEADER_BYTES = 1536;
export const LURE_DIRECTORY_ENTRIES = 191;
const ENTRY_BYTES = 8;

/** The seek routine multiplies a directory entry's unit count by this. */
export const LURE_OFFSET_UNIT = 32;

/** An id no resource has; it marks a directory slot as unused. */
const EMPTY_SLOT = 0xffff;

/**
 * The disk number a container file declares, worked out from its name.
 *
 * **The EGA set numbers itself 5 to 8**, not 1 to 4 again. Measured on all
 * eight shipped files: byte 7 of `Disk1.vga` through `Disk4.vga` holds 1–4, and
 * of `disk1.ega` through `disk4.ega` holds 5–8. So a disk number identifies a
 * container across both sets rather than a position within one, which is the
 * only reading under which the game's own check — the one `parseLureDisk`
 * mirrors — can pass for an EGA install.
 *
 * This was found by a sweep expecting 1–4 and being told 5–8 by all four files,
 * which is the good shape for such a finding: the reader was right and the
 * caller's expectation was wrong.
 */
export function lureDiskNumberFor(fileName: string): number | null {
  const match = /(?:^|[/\\])disk(\d)\.(vga|ega)$/i.exec(fileName);
  if (!match) return null;
  const index = Number(match[1]);
  return match[2].toLowerCase() === 'ega' ? index + 4 : index;
}

export interface LureResource {
  readonly id: number;
  readonly offset: number;
  readonly size: number;
}

export interface LureDisk {
  /** One-based, and checked against the file the caller asked for. */
  readonly diskNumber: number;
  /** Only entries this container actually holds. */
  readonly resources: readonly LureResource[];
  /**
   * All 191 directory slots as they were read, held so a rewrite can put back
   * what it did not touch.
   *
   * `resources` deliberately omits the empty slots, because a caller asking
   * what this container holds does not want 902 of them. A *writer* does:
   * dropping them would rebuild a directory shorter than the game's own scan
   * expects. `CONTEXT.md`'s Resource layout rule is one principle across every
   * family — copy what was not touched, substitute what was, rebuild the index
   * — and this is the "copy" half.
   */
  readonly directory: readonly Uint8Array[];
  /** Byte 6, whose meaning is not established, carried through unchanged. */
  readonly headerByte6: number;
}

export class LureDiskError extends Error {}

/**
 * Parses a disk container's header and directory.
 *
 * Refuses rather than returning something partial: a container whose magic or
 * length is wrong yields entries that look plausible and address the wrong
 * bytes, which is the failure that never errors.
 */
export function parseLureDisk(bytes: Uint8Array, expectedDisk?: number): LureDisk {
  if (bytes.length < LURE_HEADER_BYTES) {
    throw new LureDiskError(
      `This file is ${bytes.length} bytes, which is shorter than a Lure disk container's ` +
        `${LURE_HEADER_BYTES}-byte header. It is not a Lure resource file.`,
    );
  }

  const magic = String.fromCharCode(...bytes.subarray(0, MAGIC_BYTES));
  if (magic !== MAGIC) {
    throw new LureDiskError(
      `This file does not start with a Lure disk container's marker, so it is not one.`,
    );
  }

  const diskNumber = bytes[7];
  if (expectedDisk !== undefined && diskNumber !== expectedDisk) {
    throw new LureDiskError(
      `This container reports disk ${diskNumber} but disk ${expectedDisk} was asked for. ` +
        `The game checks this too, and reading the wrong disk finds the wrong resources.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const resources: LureResource[] = [];

  for (let i = 0; i < LURE_DIRECTORY_ENTRIES; i += 1) {
    const at = 8 + i * ENTRY_BYTES;
    const id = view.getUint16(at, true);
    if (id === 0 || id === EMPTY_SLOT) continue;

    // Byte 3 carries the size's bits above sixteen. Thirteen of the shipped
    // resources need it, and dropping them was this reader's own third
    // misreading of this directory — see the header.
    const size = view.getUint16(at + 4, true) | (bytes[at + 3] << 16);
    const offset = view.getUint16(at + 6, true) * LURE_OFFSET_UNIT;

    if (offset < LURE_HEADER_BYTES || offset + size > bytes.length) {
      throw new LureDiskError(
        `Resource ${id} claims ${size} bytes at offset ${offset}, which does not fit inside ` +
          `this ${bytes.length}-byte container. The directory disagrees with the file.`,
      );
    }
    resources.push({ id, offset, size });
  }

  const directory: Uint8Array[] = [];
  for (let i = 0; i < LURE_DIRECTORY_ENTRIES; i += 1) {
    const at = 8 + i * ENTRY_BYTES;
    directory.push(bytes.slice(at, at + ENTRY_BYTES));
  }

  return { diskNumber, resources, directory, headerByte6: bytes[6] };
}

/**
 * Rebuilds a container, substituting the resources given and copying the rest.
 *
 * Byte-identical when nothing is replaced, which is the property that makes an
 * export safe before every field is understood: whatever this project has not
 * learned to read, it has at least not destroyed. Byte 2 of every entry and
 * byte 6 of the header are carried through for that reason — neither has an
 * established meaning, and inventing a value for them on write would be the
 * same guess this reader refuses on read.
 *
 * Replacement is by resource id and must preserve size. A resource that grew
 * would push every later one along and invalidate the offsets in entries this
 * writer is copying rather than recomputing, so it is refused with a message
 * saying so rather than producing a container that loads and is wrong.
 */
export function writeLureDisk(
  original: Uint8Array,
  disk: LureDisk,
  replacements: ReadonlyMap<number, Uint8Array> = new Map(),
): Uint8Array {
  const out = original.slice();

  for (let i = 0; i < 6; i += 1) out[i] = MAGIC.charCodeAt(i);
  out[6] = disk.headerByte6;
  out[7] = disk.diskNumber;
  disk.directory.forEach((entry, i) => out.set(entry, 8 + i * ENTRY_BYTES));

  for (const [id, data] of replacements) {
    const target = disk.resources.find((r) => r.id === id);
    if (!target) {
      throw new LureDiskError(
        `This container does not hold resource ${id}, so it cannot be replaced here. ` +
          `Check which disk holds it before writing.`,
      );
    }
    if (data.length !== target.size) {
      throw new LureDiskError(
        `Resource ${id} is ${target.size} bytes and the replacement is ${data.length}. ` +
          `Sizes must match: a resource that changed length would move every resource ` +
          `after it, and this writer copies their directory entries rather than ` +
          `recomputing them.`,
      );
    }
    out.set(data, target.offset);
  }

  return out;
}

/** The bytes of one resource, or null when this container does not hold it. */
export function readLureResource(bytes: Uint8Array, disk: LureDisk, id: number): Uint8Array | null {
  const found = disk.resources.find((r) => r.id === id);
  return found ? bytes.subarray(found.offset, found.offset + found.size) : null;
}

/**
 * The number of colours a Lure palette resource carries.
 *
 * Not 256. Every palette in the shipped VGA containers is 660 bytes, which is
 * 220 RGB triplets — the game reserves the rest of the hardware palette rather
 * than shipping it.
 */
export const LURE_PALETTE_COLOURS = 220;
export const LURE_PALETTE_BYTES = LURE_PALETTE_COLOURS * 3;

/** VGA DACs take six bits per channel, so a component never exceeds this. */
const VGA_MAX_COMPONENT = 0x3f;

/**
 * True when a resource is a palette.
 *
 * Both halves are needed and the second is what makes this a test rather than a
 * guess. Across all four shipped VGA containers there are 49 resources of
 * exactly 660 bytes, and **every byte of all 49** falls within the 6-bit VGA
 * range — which neither compressed nor arbitrary data would do. That is also
 * the measurement establishing that Lure stores its resources uncompressed:
 * a compressed palette could not satisfy the constraint (#261).
 */
export function isLurePalette(data: Uint8Array): boolean {
  if (data.length !== LURE_PALETTE_BYTES) return false;
  return data.every((component) => component <= VGA_MAX_COMPONENT);
}

/** One palette entry, widened from the hardware's six bits to eight. */
export interface LureColour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Reads a palette resource into 8-bit RGB.
 *
 * Scaling is `(c << 2) | (c >> 4)` rather than `c * 255 / 63`, which spreads
 * six bits across eight so that full-scale stays full-scale and black stays
 * black. Multiplying by four alone would cap white at 252 and tint every
 * bright area of the game very slightly dark.
 */
export function parseLurePalette(data: Uint8Array): LureColour[] {
  if (!isLurePalette(data)) {
    throw new LureDiskError(
      `This resource is ${data.length} bytes and a Lure palette is ${LURE_PALETTE_BYTES}, ` +
        `or it holds a component above the 6-bit VGA range. It is not a palette.`,
    );
  }
  const out: LureColour[] = [];
  for (let i = 0; i < LURE_PALETTE_COLOURS; i += 1) {
    const at = i * 3;
    const widen = (c: number): number => ((c << 2) | (c >> 4)) & 0xff;
    out.push({ r: widen(data[at]), g: widen(data[at + 1]), b: widen(data[at + 2]) });
  }
  return out;
}

/**
 * Writes palette colours back to resource bytes, narrowing eight bits to six.
 *
 * The inverse of `parseLurePalette` for the values it produced: `widen` then
 * this `narrow` is the identity, so a palette nobody edits re-emits
 * byte-identically — the round-trip that makes the palette an editable surface
 * (ADR 0025's condition, applied to Lure's own format). An edit to an arbitrary
 * eight-bit value loses the low two bits the VGA DAC never carried, which is the
 * one thing a six-bit palette cannot hold and is said rather than hidden.
 */
export function writeLurePalette(colours: readonly LureColour[]): Uint8Array {
  const out = new Uint8Array(colours.length * 3);
  const narrow = (c: number): number => (c >> 2) & VGA_MAX_COMPONENT;
  colours.forEach((colour, i) => {
    const at = i * 3;
    out[at] = narrow(colour.r);
    out[at + 1] = narrow(colour.g);
    out[at + 2] = narrow(colour.b);
  });
  return out;
}
