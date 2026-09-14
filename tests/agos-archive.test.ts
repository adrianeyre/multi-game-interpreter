/**
 * Writing an AGOS resource archive.
 *
 * The half of export ADR 0030 requires and that did not exist, so a painted
 * image survived in a saved project and could not reach a game folder.
 *
 * **The round trip is the test that matters**, and for a specific reason: an
 * entry's length is not stored, it is implied by the next higher offset. So an
 * off-by-one in the table does not corrupt the entry it belongs to — it
 * corrupts the *previous* one, by moving where that one ends. Only reading back
 * what was written catches that.
 */
import { describe, expect, it } from 'vitest';
import { exportAgosArchive, writeAgosArchive } from '../src/authoring/agos/archive.js';
import { readAgosArchive } from '../src/engine/agos/resource/gameArchive.js';
import { paintedFrom } from '../src/authoring/agos/paint.js';
import { exportAgosGame } from '../src/authoring/agos/archive.js';
import { importAgosProject } from '../src/authoring/agos/project.js';
import { buildGamePc } from './fixtureAgos.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};
import { decodeSprite } from '../src/engine/agos/gfx/agosImage.js';

describe('an archive round trip', () => {
  it('reads back the entries it was given', () => {
    const entries = [
      // Entry 0 is required: word 0 is both the table length and its offset.
      { number: 0, data: new Uint8Array([9, 9]) },
      { number: 1, data: new Uint8Array([1, 2, 3]) },
      { number: 2, data: new Uint8Array([4, 5]) },
      { number: 3, data: new Uint8Array([6, 7, 8, 9]) },
    ];

    const archive = readAgosArchive(writeAgosArchive(entries));

    for (const entry of entries) {
      expect([...archive.read(entry.number)!]).toEqual([...entry.data]);
    }
  });

  it('keeps a gap a gap, rather than closing it up', () => {
    // Closing a gap renumbers every entry above it, and an entry number is
    // what a script asks for — so a game would fetch the wrong resource.
    const archive = readAgosArchive(
      writeAgosArchive([
        { number: 0, data: new Uint8Array([9]) },
        { number: 1, data: new Uint8Array([1]) },
        { number: 4, data: new Uint8Array([4]) },
      ]),
    );

    expect(archive.read(1)).toBeDefined();
    expect(archive.read(2)).toBeUndefined();
    expect(archive.read(3)).toBeUndefined();
    expect([...archive.read(4)!]).toEqual([4]);
  });

  it('gets the last entry length right, which nothing after it implies', () => {
    // The final entry ends at the end of the file rather than at a neighbour,
    // so it is the one case the "next offset" rule does not cover.
    const archive = readAgosArchive(
      writeAgosArchive([
        { number: 0, data: new Uint8Array([9]) },
        { number: 1, data: new Uint8Array([1, 2]) },
        { number: 2, data: new Uint8Array([3, 4, 5, 6, 7]) },
      ]),
    );

    expect([...archive.read(2)!]).toEqual([3, 4, 5, 6, 7]);
  });

  it('refuses a duplicate entry number rather than dropping one silently', () => {
    expect(() =>
      writeAgosArchive([
        { number: 0, data: new Uint8Array([9]) },
        { number: 1, data: new Uint8Array([1]) },
        { number: 1, data: new Uint8Array([2]) },
      ]),
    ).toThrow(/given twice/);
  });

  it('refuses an archive with no entries, which has no table', () => {
    expect(() => writeAgosArchive([])).toThrow(/no offset table/);
  });
});

describe('applying paint at export', () => {
  /** A zone's pixel resource holding one 4x2 uncompressed image. */
  function pixelResource(): Uint8Array {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    const at = 1 * 8;
    view.setUint32(at, 32, false);
    bytes[at + 4] = 0;
    bytes[at + 5] = 2;
    view.setUint16(at + 6, 4, false); // four pixels wide, so two bytes a row
    bytes.set([0x12, 0x34, 0x56, 0x78], 32);
    return bytes;
  }

  /** Zone 1: scripts at entry 2, pixels at entry 3. */
  function archiveOfOneZone(): Uint8Array {
    return writeAgosArchive([
      { number: 0, data: new Uint8Array([9, 9]) },
      { number: 2, data: new Uint8Array([0xaa, 0xbb]) },
      { number: 3, data: pixelResource() },
    ]);
  }

  it('writes a painted image into its zone pixel resource', () => {
    const bitmap = decodeSprite(pixelResource().subarray(32, 36), 2, 2, { opaque: true });
    bitmap.pixels[0] = 0xf;

    const rebuilt = readAgosArchive(
      exportAgosArchive(archiveOfOneZone(), [paintedFrom(1, 1, bitmap)]),
    );

    // Pixel (0,0) is the high nibble of the first byte.
    expect(rebuilt.read(3)![32]).toBe(0xf2);
    // The zone's *script* resource is untouched — only odd entries are pixels.
    expect([...rebuilt.read(2)!]).toEqual([0xaa, 0xbb]);
  });

  it('leaves an unedited archive byte-identical', () => {
    // The property that matters for a game nobody painted: export must not
    // rewrite what it did not change.
    const original = archiveOfOneZone();

    expect([...exportAgosArchive(original, [])]).toEqual([...original]);
  });
});

/**
 * A slot whose offset is not a resource.
 *
 * Simon 2's `SIMON2.GME` has one: its last table slot holds `07 00 00 43`, an
 * offset a gigabyte past a seven-megabyte file. ScummVM reads every slot into
 * an array and follows only the ones a resource id names, so this one is never
 * dereferenced — it is dead leftover the count still includes. It cannot be
 * dropped (the count is word 0, so every entry would shift) and cannot be
 * recomputed (it names no data), so its four bytes are carried through
 * verbatim: ADR 0035's preserved region, as an offset rather than as content.
 */
describe('a table slot whose offset points outside the file', () => {
  /** An archive whose final slot holds an out-of-range offset. */
  function archiveWithPreservedSlot(): Uint8Array {
    const table = 4 * 4;
    const data = Uint8Array.of(9, 9, 1, 2, 3, 4, 5);
    const out = new Uint8Array(table + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, table, true); // word 0: table length and entry 0's offset
    view.setUint32(4, table + 2, true); // entry 1
    view.setUint32(8, table + 5, true); // entry 2, the last real one
    view.setUint32(12, 0x43000007, true); // a gigabyte past the file: preserved
    out.set(data, table);
    return out;
  }

  it('marks it preserved and answers nothing when asked to read it', () => {
    const archive = readAgosArchive(archiveWithPreservedSlot());

    expect(archive.entries.find((entry) => entry.number === 3)?.preserved).toBe(true);
    expect(archive.read(3)).toBeUndefined();
    // The real entries are unaffected: the out-of-range slot is not a candidate
    // for any other entry's implied length.
    expect([...archive.read(2)!]).toEqual([4, 5]);
  });

  it('re-emits the slot byte for byte rather than recomputing its offset', () => {
    // The fault this pins: the writer used to give it the running position after
    // all data — the file length — overwriting the original 07 00 00 43.
    const original = archiveWithPreservedSlot();

    expect([...exportAgosArchive(original, [])]).toEqual([...original]);
  });
});

describe('the entry 0 the format requires', () => {
  it('refuses an archive without one, because word 0 is also its offset', () => {
    // Found by a byte-identity test rather than reasoned out: re-exporting an
    // unedited archive grew it by two bytes, because the reader took the table
    // length as entry 0's offset and reported the following entry's data twice.
    expect(() => writeAgosArchive([{ number: 1, data: new Uint8Array([1]) }])).toThrow(
      /must have an entry 0/,
    );
  });
});

/**
 * Exporting both artefacts, or neither.
 *
 * ADR 0030 makes this one operation, because a rebuilt base file beside its
 * *original* archive is precisely the mismatch it warns about — "a game that
 * loads and then misbehaves". So the property worth asserting is not that both
 * are produced, but that a failure in either yields nothing.
 */
describe('exporting an AGOS game as both files', () => {
  /**
   * An editable Project from the shared AGOS fixture.
   *
   * `importAgosProject` is given no zones, so it carries no art — which is the
   * right shape here: what these tests exercise is the *join*, and paint intent
   * is passed to the exporter separately.
   */
  function editableProject() {
    return importAgosProject(buildGamePc({ withSpeech: true }), {
      baseFile: 'GAMEPC',
      identification: 'file-names',
      candidates: ['Simon1'],
      target: SIMON1,
    } as never);
  }

  it('produces both artefacts for an editable game', () => {
    const archive = writeAgosArchive([{ number: 0, data: new Uint8Array([9, 9]) }]);

    const exported = exportAgosGame(editableProject(), archive);

    expect(exported.gamePc.length).toBeGreaterThan(0);
    expect(exported.archive.length).toBeGreaterThan(0);
  });

  it('leaves the archive byte-identical when nothing was painted', () => {
    // An export of an unedited game must not rewrite what it did not change,
    // which is the assertion that found the entry-0 bug.
    const archive = writeAgosArchive([
      { number: 0, data: new Uint8Array([9, 9]) },
      { number: 1, data: new Uint8Array([1, 2, 3]) },
    ]);

    expect([...exportAgosGame(editableProject(), archive).archive]).toEqual([...archive]);
  });

  it('produces neither when the base file cannot be written', () => {
    // The base file is built first, so its refusal has to stop the archive
    // half too — otherwise a caller could write an archive for a game whose
    // structure was misread.
    const notEditable = {
      ...editableProject(),
      editable: {
        versionProbed: false,
        structurallyAgrees: true,
        roundTrips: true,
        editable: false,
        unrecovered: 1,
        reasons: ['the Version is narrowed rather than identified'],
      },
    };
    const archive = writeAgosArchive([{ number: 0, data: new Uint8Array([9]) }]);

    expect(() => exportAgosGame(notEditable, archive)).toThrow(/not editable/);
  });
});

/**
 * Two numbers, one resource.
 *
 * Simon 1's `simon.gme` aliases six times, and nothing in the reader can say
 * so: it derives an entry's length from the next offset above, so an alias
 * reads back as an ordinary second copy of the same bytes. A writer that took
 * that at face value emitted both, and an unedited Simon 1 archive came back
 * 9,436 bytes longer than it went in — which is the byte identity ADR 0030
 * rests on, lost on the family's flagship game.
 */
describe('an archive that aliases one resource under two numbers', () => {
  /** Entry 1 and entry 2 sharing an offset, the way a real one does. */
  function aliasedArchive(): Uint8Array {
    const table = 3 * 4;
    const zero = Uint8Array.of(9, 9);
    const shared = Uint8Array.of(1, 2, 3, 4);
    const out = new Uint8Array(table + zero.length + shared.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, table, true);
    view.setUint32(4, table + zero.length, true);
    // The same offset as entry 1: this is the alias.
    view.setUint32(8, table + zero.length, true);
    out.set(zero, table);
    out.set(shared, table + zero.length);
    return out;
  }

  it('re-emits it byte for byte rather than writing the resource twice', () => {
    const original = aliasedArchive();

    expect(exportAgosArchive(original, [])).toEqual(original);
  });

  it('still answers both numbers with the shared bytes after a round trip', () => {
    const archive = readAgosArchive(exportAgosArchive(aliasedArchive(), []));

    expect(archive.read(1)).toEqual(archive.read(2));
    expect(archive.read(1)).toEqual(Uint8Array.of(1, 2, 3, 4));
  });

  it('refuses an alias chain rather than laying one out on a guess', () => {
    expect(() =>
      writeAgosArchive([
        { number: 0, data: Uint8Array.of(1) },
        { number: 1, data: Uint8Array.of(2), sameAs: 2 },
        { number: 2, data: Uint8Array.of(2), sameAs: 0 },
      ]),
    ).toThrow(/itself an alias/);
  });

  it('refuses an alias naming an entry that is not there', () => {
    expect(() =>
      writeAgosArchive([
        { number: 0, data: Uint8Array.of(1) },
        { number: 1, data: Uint8Array.of(2), sameAs: 7 },
      ]),
    ).toThrow(/which is not here/);
  });

  it('breaks the alias when only one of the two is painted', () => {
    // The two numbers no longer name the same bytes, so keeping the alias would
    // silently repaint whatever else shared them.
    const original = aliasedPixelArchive();
    const painted = exportAgosArchive(original, [
      {
        zone: 0,
        id: 1,
        width: 4,
        height: 2,
        pixels: btoa('\u000f\u000f\u000f\u000f\u000f\u000f\u000f\u000f'),
      },
    ]);
    const archive = readAgosArchive(painted);

    // Entry 1 is zone 0's pixels and was painted; entry 2 shared its offset and
    // must not have moved with it.
    expect(archive.read(1)).not.toEqual(archive.read(2));
    expect(archive.read(2)).toEqual(readAgosArchive(original).read(2));
  });

  /** The same aliasing, over bytes that are a readable pixel resource. */
  function aliasedPixelArchive(): Uint8Array {
    const pixels = new Uint8Array(24);
    const entry = new DataView(pixels.buffer);
    entry.setUint32(8, 16, false); // image 1's pixels start at 16
    pixels[12] = 0; // uncompressed
    pixels[13] = 2; // two rows
    entry.setUint16(14, 4, false); // four pixels wide
    pixels.set([0x12, 0x34, 0x56, 0x78], 16);

    const table = 3 * 4;
    const zero = Uint8Array.of(9, 9);
    const out = new Uint8Array(table + zero.length + pixels.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, table, true);
    view.setUint32(4, table + zero.length, true);
    view.setUint32(8, table + zero.length, true);
    out.set(zero, table);
    out.set(pixels, table + zero.length);
    return out;
  }
});
