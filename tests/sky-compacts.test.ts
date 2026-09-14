import { describe, expect, it } from 'vitest';
import {
  parseSkyCompacts,
  writeSkyCompacts,
  describeMissingCompacts,
  SkyCompactError,
  SKY_COMPACT_FIELDS,
  SKY_MEGA_SET_FIELDS,
  skyCompactFieldAt,
} from '../src/engine/sky/resource/skyCompacts.js';
import {
  buildSkyCompactFixture,
  FIXTURE_FULL_COMPACT,
  FIXTURE_SHORT_COMPACT,
} from './fixtureSkyCompacts.js';

describe('parseSkyCompacts', () => {
  it('reads records with their ids, names and types', () => {
    const compacts = parseSkyCompacts(buildSkyCompactFixture());
    expect(compacts.records).toHaveLength(3);

    const [full, short, turns] = compacts.records;
    expect(full.name).toBe('foster');
    expect(full.type).toBe('compact');
    // (list << 12) | index, which is how a script names one.
    expect(full.id).toBe(0);
    expect(short.id).toBe(1);
    expect(turns.type).toBe('turnTable');
    expect(compacts.emptySlots).toBe(1);
    expect(compacts.notes).toHaveLength(0);
  });

  it('names a Compact’s fields, in the order they sit in the record', () => {
    const compacts = parseSkyCompacts(buildSkyCompactFixture());
    const foster = compacts.records[0];
    expect(foster.fields.get('logic')).toBe(FIXTURE_FULL_COMPACT.words[0]);
    expect(foster.fields.get('xcood')).toBe(FIXTURE_FULL_COMPACT.words[6]);
    expect(foster.fields.get('megaSet')).toBe(
      FIXTURE_FULL_COMPACT.words[SKY_COMPACT_FIELDS.length - 1],
    );
    expect(foster.megaSets).toHaveLength(1);
    expect(foster.megaSets[0].get('gridWidth')).toBe(
      FIXTURE_FULL_COMPACT.words[SKY_COMPACT_FIELDS.length],
    );
    expect(foster.megaSets[0].get('turnTableId')).toBe(
      FIXTURE_FULL_COMPACT.words[SKY_COMPACT_FIELDS.length + SKY_MEGA_SET_FIELDS.length - 1],
    );
  });

  it('stops naming where a short record stops', () => {
    // 200-odd shipped records are shorter than the field list. Reading past the
    // end would name a field out of the next record's words.
    const compacts = parseSkyCompacts(buildSkyCompactFixture());
    const short = compacts.records[1];
    expect(short.words).toHaveLength(FIXTURE_SHORT_COMPACT.words.length);
    expect(short.fields.size).toBe(FIXTURE_SHORT_COMPACT.words.length);
    expect(short.fields.has('logic')).toBe(true);
    expect(short.fields.has('megaSet')).toBe(false);
    expect(short.megaSets).toHaveLength(0);
  });

  it('reads a turn table as five frames per direction', () => {
    const compacts = parseSkyCompacts(buildSkyCompactFixture());
    const turns = compacts.records[2];
    expect(turns.turns.get('turnTableUp')).toEqual([400, 401, 402, 403, 404]);
    expect(turns.turns.get('turnTableTalk')).toEqual([420, 421, 422, 423, 424]);
  });

  it('reads aliases, save ids and one starting state per Release', () => {
    const compacts = parseSkyCompacts(buildSkyCompactFixture());
    expect(compacts.aliases).toEqual([{ id: 0x0800, targetId: 0, name: 'foster_alias' }]);
    expect(compacts.saveIds).toEqual([0, 1, 2]);

    expect(compacts.resetStates.map((state) => state.build)).toEqual([348, 372]);
    // A Release's starting state is the shared base with its own changes on it.
    expect(compacts.resetStates[0].words[0]).toBe(0x1111);
    expect(compacts.resetStates[1].words[0]).toBe(0xaaaa);
    expect(compacts.resetStates[0].changed).toBe(1);
  });

  it('refuses a word count that disagrees with the records', () => {
    // The check that catches a misread section length: everything after the
    // misread would be in the wrong place, and this is where it shows.
    expect(() => parseSkyCompacts(buildSkyCompactFixture({ declareWrongWordCount: true }))).toThrow(
      /must agree exactly/,
    );
  });

  it('refuses a file with bytes left over after its last section', () => {
    expect(() => parseSkyCompacts(buildSkyCompactFixture({ trailingByte: true }))).toThrow(
      /should have none/,
    );
  });

  it('refuses an unknown file version rather than guessing at the layout', () => {
    expect(() => parseSkyCompacts(buildSkyCompactFixture({ fileVersion: 1 }))).toThrow(
      /only version 0 has ever existed/,
    );
  });

  it('refuses a truncated file', () => {
    const bytes = buildSkyCompactFixture();
    expect(() => parseSkyCompacts(bytes.subarray(0, 6))).toThrow(SkyCompactError);
  });

  it('reports an undefined record type rather than dropping the record', () => {
    const bytes = buildSkyCompactFixture({
      compacts: [{ name: 'odd', type: 9, words: [1, 2, 3] }],
      aliases: [],
    });
    const compacts = parseSkyCompacts(bytes);
    expect(compacts.notes).toHaveLength(1);
    expect(compacts.notes[0].reason).toMatch(/type 9/);
    // Still carried: an export has to write its words back untouched.
    expect(compacts.records[0].words).toHaveLength(3);
  });
});

describe('writeSkyCompacts', () => {
  it('round-trips byte-identically when nothing is replaced', () => {
    const bytes = buildSkyCompactFixture();
    expect(writeSkyCompacts(bytes, parseSkyCompacts(bytes))).toEqual(bytes);
  });

  it('substitutes a record’s words in place', () => {
    const bytes = buildSkyCompactFixture();
    const compacts = parseSkyCompacts(bytes);
    const foster = compacts.records[0];
    const edited = new Uint16Array(foster.words);
    edited[6] = 0x4321;

    const out = writeSkyCompacts(bytes, compacts, new Map([[foster.id, edited]]));
    expect(parseSkyCompacts(out).records[0].fields.get('xcood')).toBe(0x4321);
    // Everything else is the file it came from, byte for byte.
    const differing = [...out].filter((byte, i) => byte !== bytes[i]).length;
    expect(differing).toBeLessThanOrEqual(2);
  });

  it('refuses a replacement that changes a record’s shape', () => {
    // ADR 0024's size rule: values may change, the shape may not. A longer
    // record would move every record after it and invalidate the ids the
    // game's own scripts hold.
    const bytes = buildSkyCompactFixture();
    const compacts = parseSkyCompacts(bytes);
    const foster = compacts.records[0];
    expect(() =>
      writeSkyCompacts(bytes, compacts, new Map([[foster.id, new Uint16Array(4)]])),
    ).toThrow(/Values may change; the shape may not/);
  });

  it('refuses to write against a different file from the one it read', () => {
    const bytes = buildSkyCompactFixture();
    const compacts = parseSkyCompacts(bytes);
    expect(() => writeSkyCompacts(bytes.subarray(0, bytes.length - 1), compacts)).toThrow(
      /do not address it/,
    );
  });
});

describe('describeMissingCompacts', () => {
  it('says nothing when the freeware release’s table is there', () => {
    expect(describeMissingCompacts(['sky.dnr', 'sky.dsk', 'sky.cpt'])).toBeNull();
  });

  it('names the freeware floppy’s problem, which is that it ships neither', () => {
    const message = describeMissingCompacts(['sky.dnr', 'sky.dsk']);
    expect(message).toMatch(/no Compact table/);
    expect(message).toMatch(/freeware floppy/);
  });

  it('says plainly that reading SKY.EXE is not implemented', () => {
    // Unchecked is the point: this is the structure the whole world lives in,
    // and no reader for it has been written. A release to check one against is
    // fetchable now (ADR 0024's fifth amendment), which changes what the
    // message says is missing and not that it refuses.
    const message = describeMissingCompacts(['sky.dnr', 'sky.dsk', 'SKY.EXE']);
    expect(message).toMatch(/not implemented/);
    expect(message).toMatch(/SKY\.EXE/);
  });
});

describe('skyCompactFieldAt', () => {
  it('maps the offsets the shipped scripts actually use', () => {
    // All 22 of them, measured over every script in the game. A script's
    // operand is a byte offset into the *original* structure, where four
    // fields were 32 bits, so it cannot be halved to get a word index.
    const expected: [number, string][] = [
      [2, 'status'],
      [4, 'sync'],
      [6, 'screen'],
      [8, 'place'],
      [14, 'xcood'],
      [16, 'ycood'],
      [18, 'frame'],
      [20, 'cursorText'],
      [22, 'mouseOn'],
      [26, 'mouseClick'],
      [28, 'mouseRelX'],
      [30, 'mouseRelY'],
      [32, 'mouseSizeX'],
      [34, 'mouseSizeY'],
      [36, 'actionScript'],
      [38, 'upFlag'],
      [40, 'downFlag'],
      [42, 'getToFlag'],
      [44, 'flag'],
      [72, 'dir'],
      [80, 'atWatch'],
      [82, 'atWas'],
    ];
    for (const [offset, name] of expected) {
      expect(skyCompactFieldAt(offset)?.name).toBe(name);
    }
  });

  it('reads a field’s value through its byte offset', () => {
    const compacts = parseSkyCompacts(buildSkyCompactFixture());
    const foster = compacts.records[0];
    const xcood = skyCompactFieldAt(14)!;
    expect(foster.words[xcood.index]).toBe(FIXTURE_FULL_COMPACT.words[6]);
    expect(foster.fields.get('xcood')).toBe(foster.words[xcood.index]);
  });

  it('refuses an offset that is not a field’s first byte', () => {
    // Rounding down would silently read the field before the one asked for.
    expect(skyCompactFieldAt(1)).toBeNull();
    expect(skyCompactFieldAt(3)).toBeNull();
    // A wide field's second half, which ScummVM maps to `logic` and no shipped
    // script asks for.
    expect(skyCompactFieldAt(12)).toBeNull();
    expect(skyCompactFieldAt(50)).toBeNull();
  });
});
