import { describe, expect, it } from 'vitest';
import {
  parseLureDisk,
  readLureResource,
  LureDiskError,
  LURE_HEADER_BYTES,
  LURE_OFFSET_UNIT,
  LURE_DIRECTORY_ENTRIES,
  isLurePalette,
  parseLurePalette,
  LURE_PALETTE_COLOURS,
  writeLureDisk,
} from '../src/engine/lure/resource/lureDisk.js';

interface Entry {
  id: number;
  byte3?: number;
  size: number;
  offset: number;
}

/**
 * Builds a container from the format — magic, disk number, 191 eight-byte
 * entries — rather than from what the parser happens to accept. That is the
 * distinction `verifying-version-support.md` calls Tier 1's trap.
 */
function buildDisk(diskNumber: number, entries: Entry[], totalBytes = 4096): Uint8Array {
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 6; i += 1) out[i] = 'heywow'.charCodeAt(i);
  out[7] = diskNumber;
  entries.forEach((e, i) => {
    const at = 8 + i * 8;
    view.setUint16(at, e.id, true);
    out[at + 2] = 0xff;
    out[at + 3] = e.byte3 ?? 0;
    view.setUint16(at + 4, e.size, true);
    view.setUint16(at + 6, e.offset / LURE_OFFSET_UNIT, true);
  });
  return out;
}

describe('parseLureDisk', () => {
  it('reads the disk number and the resources this container holds', () => {
    const disk = parseLureDisk(
      buildDisk(3, [
        { id: 25, size: 660, offset: LURE_HEADER_BYTES },
        { id: 24, size: 100, offset: LURE_HEADER_BYTES + 704 },
      ]),
    );
    expect(disk.diskNumber).toBe(3);
    expect(disk.resources).toEqual([
      { id: 25, offset: 1536, size: 660 },
      { id: 24, offset: 2240, size: 100 },
    ]);
  });

  /**
   * Byte 3 carries the size's bits above sixteen — the field that has defeated
   * three readings of this directory, the third being this reader's own. It
   * skipped every entry whose byte 3 was non-zero as "living on another disk",
   * which dropped thirteen real resources from the shipped containers.
   *
   * What settles it is arithmetic: for each of those thirteen, the distance to
   * the next resource matches the extended size to within the containers' own
   * 32-byte alignment slack, while the 16-bit size leaves 60 to 130 KB
   * unaccounted for.
   */
  it('reads byte 3 as the size’s high byte', () => {
    const disk = parseLureDisk(
      buildDisk(
        1,
        [
          { id: 10, size: 32, offset: LURE_HEADER_BYTES },
          { id: 12, byte3: 0x01, size: 32, offset: LURE_HEADER_BYTES + 32 },
        ],
        0x20000,
      ),
    );
    expect(disk.resources).toEqual([
      { id: 10, offset: 1536, size: 32 },
      { id: 12, offset: 1568, size: 32 | (1 << 16) },
    ]);
  });

  it('ignores a slot whose id is the empty marker, whatever its other bytes say', () => {
    // 902 of the shipped directory's 1,528 non-zero-id slots are these, and the
    // id alone tells them apart from a resource with no exceptions.
    const disk = parseLureDisk(
      buildDisk(1, [
        { id: 10, size: 32, offset: LURE_HEADER_BYTES },
        { id: 0xffff, byte3: 0xff, size: 0xffff, offset: LURE_HEADER_BYTES },
      ]),
    );
    expect(disk.resources.map((r) => r.id)).toEqual([10]);
  });

  it('ignores empty directory slots', () => {
    const disk = parseLureDisk(buildDisk(1, [{ id: 0, size: 999, offset: LURE_HEADER_BYTES }]));
    expect(disk.resources).toEqual([]);
  });

  // The header is 1536 bytes and every shipped container's first resource
  // begins exactly there, so nothing may address into the header.
  it('refuses a directory that disagrees with the file', () => {
    expect(() => parseLureDisk(buildDisk(1, [{ id: 5, size: 64, offset: 1024 }]))).toThrow(
      LureDiskError,
    );
    expect(() => parseLureDisk(buildDisk(1, [{ id: 5, size: 64, offset: 4096 }], 4096))).toThrow(
      /does not fit inside/,
    );
  });

  it('refuses a file that is not a container, and one that is too short', () => {
    const notOurs = new Uint8Array(LURE_HEADER_BYTES + 64);
    expect(() => parseLureDisk(notOurs)).toThrow(/marker/);
    expect(() => parseLureDisk(buildDisk(1, [], 100))).toThrow(/shorter than/);
  });

  // The game checks this, and reading the wrong disk finds the wrong resources.
  it('refuses a container that is not the disk asked for', () => {
    const bytes = buildDisk(2, [{ id: 1, size: 32, offset: LURE_HEADER_BYTES }]);
    expect(() => parseLureDisk(bytes, 1)).toThrow(/disk 2 .* disk 1/);
    expect(parseLureDisk(bytes, 2).diskNumber).toBe(2);
  });

  it('exposes a directory of exactly 191 entries', () => {
    const many = Array.from({ length: LURE_DIRECTORY_ENTRIES }, (_, i) => ({
      id: i + 1,
      size: LURE_OFFSET_UNIT,
      offset: LURE_HEADER_BYTES + i * LURE_OFFSET_UNIT,
    }));
    const disk = parseLureDisk(buildDisk(1, many, 32768));
    expect(disk.resources).toHaveLength(LURE_DIRECTORY_ENTRIES);
  });
});

describe('readLureResource', () => {
  it('returns a resource by id, and null for one this container does not hold', () => {
    const bytes = buildDisk(1, [
      { id: 7, size: 4, offset: LURE_HEADER_BYTES },
      { id: 0xffff, byte3: 0xff, size: 0xffff, offset: LURE_HEADER_BYTES },
    ]);
    bytes.set([0xde, 0xad, 0xbe, 0xef], LURE_HEADER_BYTES);
    const disk = parseLureDisk(bytes);
    expect(readLureResource(bytes, disk, 7)).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    // The empty marker is not a resource, and neither is an id nobody wrote.
    expect(readLureResource(bytes, disk, 0xffff)).toBeNull();
    expect(readLureResource(bytes, disk, 999)).toBeNull();
  });
});

describe('Lure palettes', () => {
  const palette = (fill: number[]): Uint8Array => {
    const out = new Uint8Array(660);
    fill.forEach((v, i) => (out[i] = v));
    return out;
  };

  /**
   * The size alone is not the test. Across the four shipped VGA containers,
   * 49 resources are exactly 660 bytes and every byte of all 49 falls inside
   * the 6-bit VGA range — which is also what establishes that Lure stores its
   * resources uncompressed (#261).
   */
  it('recognises a palette by size and by the 6-bit VGA range', () => {
    expect(isLurePalette(palette([0x3f, 0x00, 0x2a]))).toBe(true);
    expect(isLurePalette(palette([0x40]))).toBe(false);
    expect(isLurePalette(new Uint8Array(659))).toBe(false);
    expect(isLurePalette(new Uint8Array(768))).toBe(false);
  });

  it('carries 220 colours, not 256', () => {
    expect(LURE_PALETTE_COLOURS).toBe(220);
    expect(parseLurePalette(palette([]))).toHaveLength(220);
  });

  // Full-scale must stay full-scale: `c * 4` would cap white at 252 and tint
  // every bright area very slightly dark.
  it('widens six bits to eight without losing the endpoints', () => {
    const colours = parseLurePalette(palette([0x3f, 0x3f, 0x3f, 0x00, 0x00, 0x00, 0x20, 0, 0]));
    expect(colours[0]).toEqual({ r: 255, g: 255, b: 255 });
    expect(colours[1]).toEqual({ r: 0, g: 0, b: 0 });
    expect(colours[2].r).toBeGreaterThan(128);
  });

  it('refuses a resource that is not a palette', () => {
    expect(() => parseLurePalette(new Uint8Array(100))).toThrow(LureDiskError);
    expect(() => parseLurePalette(palette([0xff]))).toThrow(/6-bit VGA range/);
  });
});

describe('writeLureDisk', () => {
  const container = (): Uint8Array => {
    const bytes = buildDisk(2, [
      { id: 7, size: 32, offset: LURE_HEADER_BYTES },
      { id: 0xffff, byte3: 0xff, size: 0xffff, offset: LURE_HEADER_BYTES },
      { id: 9, size: 64, offset: LURE_HEADER_BYTES + 32 },
    ]);
    bytes.set(new Uint8Array(32).fill(0xaa), LURE_HEADER_BYTES);
    bytes.set(new Uint8Array(64).fill(0xbb), LURE_HEADER_BYTES + 32);
    return bytes;
  };

  /**
   * The property that makes an export safe before every field is understood:
   * whatever this project has not learned to read, it has at least not
   * destroyed.
   */
  it('is byte-identical when nothing is replaced', () => {
    const bytes = container();
    expect(writeLureDisk(bytes, parseLureDisk(bytes))).toEqual(bytes);
  });

  // Empty slots are omitted from `resources` but must survive a rewrite —
  // rebuilding a shorter directory than the game's own scan expects would
  // change what the scan walks.
  it('carries through the slots that are not resources', () => {
    const bytes = container();
    const written = writeLureDisk(bytes, parseLureDisk(bytes));
    expect(written.subarray(8, 8 + 191 * 8)).toEqual(bytes.subarray(8, 8 + 191 * 8));
  });

  it('substitutes a replacement and leaves everything else alone', () => {
    const bytes = container();
    const disk = parseLureDisk(bytes);
    const written = writeLureDisk(bytes, disk, new Map([[7, new Uint8Array(32).fill(0xcc)]]));
    expect(readLureResource(written, disk, 7)).toEqual(new Uint8Array(32).fill(0xcc));
    expect(readLureResource(written, disk, 9)).toEqual(new Uint8Array(64).fill(0xbb));
    expect(written.subarray(0, LURE_HEADER_BYTES)).toEqual(bytes.subarray(0, LURE_HEADER_BYTES));
  });

  // A resource that grew would move every later one and invalidate the offsets
  // in directory entries this writer copies rather than recomputes.
  it('refuses a replacement that changes size, and one for a resource it does not hold', () => {
    const bytes = container();
    const disk = parseLureDisk(bytes);
    expect(() => writeLureDisk(bytes, disk, new Map([[7, new Uint8Array(33)]]))).toThrow(
      /Sizes must match/,
    );
    expect(() => writeLureDisk(bytes, disk, new Map([[8, new Uint8Array(32)]]))).toThrow(
      /does not hold resource 8/,
    );
  });
});
