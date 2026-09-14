/**
 * The AGOS resource archive — `SIMON.GME` and its siblings.
 *
 * `CONTEXT.md`'s Resource layout rule, applied here: nothing in the archive is
 * found by walking it. A table of offsets sits at the front and a resource is
 * asked for by number, which is what makes a large one tractable and what a
 * writer has to rebuild rather than recompute from scratch.
 *
 * The one surprise is byte order. `GAMEPC` is big-endian throughout, because
 * AGOS grew up on the Amiga; the archive's offset table is **little**-endian.
 * Reading it the same way as its neighbour produces offsets in the hundreds of
 * millions and a failure that looks like a corrupt file rather than a wrong
 * assumption, so it is worth the sentence.
 *
 * Not every AGOS Version has one. Elvira and Waxworks ship their graphics as
 * loose numbered files — ScummVM's old-bundle layout — and ADR 0030 gives that
 * its own reader rather than teaching this one to be both.
 */

/** A resource's place in the archive: where it starts and how long it is. */
export interface ArchiveEntry {
  readonly number: number;
  readonly offset: number;
  readonly length: number;
  /**
   * A slot whose offset points outside the file, kept only to be written back.
   *
   * Simon 2's `SIMON2.GME` has one: slot 529 holds `07 00 00 43`, an offset of
   * 0x43000007 — a gigabyte past a seven-megabyte file. It is not a resource.
   * ScummVM reads `size / 4` offsets into an array and dereferences only the
   * slots a resource id actually names, so this one is read into the array and
   * never followed; it is dead leftover in the table, not data.
   *
   * It cannot be dropped and it cannot be recomputed. Dropping it lowers the
   * count from 530 to 529, and the count *is* word 0 (the table's byte length),
   * which is also entry 0's offset — so every entry would shift and the file
   * would read back differently. Recomputing it means inventing an offset for a
   * resource that does not exist. So its four bytes are carried out and back
   * verbatim, which is ADR 0035's shape: a region outside the model is
   * preserved, not refused. `offset` holds the literal value for the writer;
   * `length` is zero and {@link AgosArchive.read} answers `undefined`, because
   * there is nothing here to read.
   */
  readonly preserved?: boolean;
}

export interface AgosArchive {
  /** Every entry, in number order. */
  readonly entries: readonly ArchiveEntry[];
  /** The bytes of one resource, or undefined when there is no such number. */
  read(number: number): Uint8Array | undefined;
}

function readU32LE(data: Uint8Array, offset: number): number {
  return (
    data[offset]! +
    data[offset + 1]! * 0x100 +
    data[offset + 2]! * 0x10000 +
    data[offset + 3]! * 0x1000000
  );
}

/**
 * Reads the archive's index.
 *
 * The first word is the table's own size in bytes, and the table starts at
 * offset zero — so the first entry is that size, and it is both the count and
 * the first resource's offset. A length comes from the next entry's offset
 * rather than from a field, which is why a zero offset means "no such resource"
 * rather than "a resource at the start of the file".
 */
export function readAgosArchive(data: Uint8Array): AgosArchive {
  if (data.length < 4) throw new Error('archive is too short to hold an offset table');
  const tableBytes = readU32LE(data, 0);
  if (tableBytes < 4 || tableBytes % 4 !== 0 || tableBytes > data.length) {
    throw new Error(`archive offset table claims ${tableBytes} bytes, which cannot be right`);
  }

  const count = tableBytes / 4;
  const offsets: number[] = [];
  for (let index = 0; index < count; index += 1) offsets.push(readU32LE(data, index * 4));

  const entries: ArchiveEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = offsets[index]!;
    if (offset === 0) continue;
    // An offset below the table or past the end of the file is not a resource:
    // its data would begin inside the offset table or beyond the last byte. It
    // is a dead slot the table still counts (see ArchiveEntry.preserved), kept
    // with its literal offset so the writer can put the same bytes back.
    if (offset < tableBytes || offset > data.length) {
      entries.push({ number: index, offset, length: 0, preserved: true });
      continue;
    }
    // The next non-zero offset above this one ends it; nothing else does. A
    // preserved slot's offset is out of range and so is never a candidate here.
    let end = data.length;
    for (const candidate of offsets) {
      if (candidate > offset && candidate <= data.length && candidate < end) end = candidate;
    }
    entries.push({ number: index, offset, length: end - offset });
  }

  const byNumber = new Map(entries.map((entry) => [entry.number, entry]));
  return {
    entries,
    read(number) {
      const entry = byNumber.get(number);
      if (!entry || entry.preserved) return undefined;
      return data.subarray(entry.offset, entry.offset + entry.length);
    },
  };
}
