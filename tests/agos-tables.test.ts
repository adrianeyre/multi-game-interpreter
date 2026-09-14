import { describe, expect, it } from 'vitest';
import {
  LOCAL_STRING_BASE,
  readTableList,
  readTableSource,
  readTextList,
} from '../src/engine/agos/resource/tableSource.js';
import { archiveBasesFor } from '../src/engine/agos/agosVersion.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

function bytes(...parts: (string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      for (const character of part) out.push(character.charCodeAt(0));
      out.push(0);
    } else {
      out.push(...part);
    }
  }
  return Uint8Array.from(out);
}

/**
 * The two indexes beside a game that say where the rest of its code is.
 *
 * `CONTEXT.md` says a game's Subroutines are split across `GAMEPC` and its
 * table resources. Reading only the first half is not a partial game: Simon 1's
 * boot calls Subroutine 101 and queues Subroutine 1, and neither is in
 * `GAMEPC`, so the engine executed nothing at all.
 */
describe('TBLLIST, which says which file a Subroutine is in', () => {
  it('reads a record as a name and its ranges', () => {
    // Simon 1's own first record: TABLES01 holds Subroutines 101 and 1.
    const list = readTableList(
      bytes('TABLES01', [0, 101, 0, 101, 0, 1, 0, 1, 0, 0], 'TABLES02', [3, 233, 4, 15, 0, 0]),
    );

    expect(list).toEqual([
      {
        file: 'TABLES01',
        ranges: [
          { min: 101, max: 101 },
          { min: 1, max: 1 },
        ],
      },
      { file: 'TABLES02', ranges: [{ min: 0x03e9, max: 0x040f }] },
    ]);
  });

  it('stops at a record whose ranges run off the end rather than half-reading it', () => {
    const list = readTableList(bytes('TABLES01', [0, 101, 0, 101, 0, 0], 'TABLES02', [3]));

    expect(list.map((entry) => entry.file)).toEqual(['TABLES01']);
  });
});

describe('STRIPPED.txt, which says which file a local string is in', () => {
  it('reads each record as the id the next file starts at', () => {
    // The first file starts at 0x8000 and a record's word is where the *next*
    // one begins, so a range is the previous word to this one.
    const list = readTextList(bytes('TEXT02 ', [0x80, 0xa9], 'TEXT03 ', [0x81, 0x1d]));

    expect(list).toEqual([
      { file: 'TEXT02 ', min: LOCAL_STRING_BASE, max: 0x80a9 },
      { file: 'TEXT03 ', min: 0x80a9, max: 0x811d },
    ]);
  });
});

describe('the two Simons address these through the archive', () => {
  it('puts TABLES01 at the table base and TEXT01 one below the text base', () => {
    // The numbers Adventure Soft's interpreter carried, and the only table of
    // contents `SIMON.GME` has.
    expect(archiveBasesFor('Simon1')).toEqual({
      tables: 394,
      text: 365,
      music: 329,
      sound: 0,
    });
    // Elvira and Waxworks pack nothing, so they have none — which is a cue to
    // look beside the game rather than a gap.
    expect(archiveBasesFor('Waxworks')).toBeUndefined();
  });
});

describe('a game whose table files sit beside it', () => {
  it('finds a Subroutine in the file TBLLIST names', async () => {
    const source = new MemoryDataSource('loose');
    source.set('TBLLIST', bytes('TABLES01', [0, 101, 0, 101, 0, 0]));
    // A block holding Subroutine 101 with one empty line: 0000 for "a
    // Subroutine follows", the id, 0000 for "a line follows", 0xFF to end the
    // line, then non-zero markers to end the Subroutine and the block.
    source.set('TABLES01', Uint8Array.from([0, 0, 0, 101, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff]));

    const tables = await readTableSource(source, SIMON1, undefined);

    expect(tables.subroutinesFor(101)?.subroutines[0]?.id).toBe(101);
    // A number no record covers is not an error: it means `GAMEPC` has it, or
    // nothing does.
    expect(tables.subroutinesFor(500)).toBeUndefined();
  });

  it('is not an error for a game with neither index', async () => {
    const source = new MemoryDataSource('bare');

    const tables = await readTableSource(source, SIMON1, undefined);

    expect(tables.tables).toEqual([]);
    expect(tables.subroutinesFor(1)).toBeUndefined();
    expect(tables.stringsFor(0x8000)).toBeUndefined();
  });

  it('keys local strings from the file’s own first id', async () => {
    const source = new MemoryDataSource('loose');
    source.set('STRIPPED.txt', bytes('TEXT02', [0x80, 0x03]));
    source.set('TEXT02', bytes('first', 'second', 'third'));

    const tables = await readTableSource(source, SIMON1, undefined);
    const held = tables.stringsFor(0x8001);

    expect(held?.min).toBe(LOCAL_STRING_BASE);
    expect(held?.lines[0x8001 - LOCAL_STRING_BASE]).toBe('second');
  });
});
