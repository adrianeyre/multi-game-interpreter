import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';

/**
 * A `00.LFL` index built to one of the two readings.
 *
 * The whole file is generated from the counts, which is what makes the test
 * meaningful: the discriminator works by walking to the end of the file, so a
 * fixture that did not add up would pass for the wrong reason.
 */
function lflIndex(objectEntryBytes: number, counts: number[]): Uint8Array {
  const objects = 40;
  const size =
    4 + objects * objectEntryBytes + counts.reduce((total, count) => total + 1 + count * 3, 0);
  const out = new Uint8Array(size);
  out[0] = 0x00;
  out[1] = 0x01; // magic 0x0100, little-endian
  out[2] = objects & 0xff;
  out[3] = objects >> 8;

  let at = 4 + objects * objectEntryBytes;
  for (const count of counts) {
    out[at] = count;
    at += 1 + count * 3;
  }
  return out;
}

function xored(data: Uint8Array, key: number): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key;
  return out;
}

/** A v4 index: a little-endian block size, then a two-character tag. */
function lecIndex(): Uint8Array {
  const out = new Uint8Array(32);
  out[0] = 32; // itemsize, little-endian, including the six byte header
  out[4] = 'R'.charCodeAt(0);
  out[5] = 'N'.charCodeAt(0);
  return out;
}

function folder(entries: Record<string, Uint8Array>, label = 'game'): MemoryDataSource {
  return new MemoryDataSource(label, Object.entries(entries));
}

describe('a game is a set of files', () => {
  it('finds a v4 install by its three-digit index and its LEC disks', async () => {
    const source = folder({
      '000.LFL': lecIndex(),
      'DISK01.LEC': new Uint8Array(16),
      'DISK02.LEC': new Uint8Array(16),
      '901.LFL': new Uint8Array(4),
      '904.LFL': new Uint8Array(4),
    });

    const game = await detectGame(source);

    expect(game.version).toBe(4);
    expect(game.layout).toBe('lec-disks');
    expect(game.dataFiles).toEqual(['DISK01.LEC', 'DISK02.LEC']);
    expect(game.charsetFiles).toEqual(['901.LFL', '904.LFL']);
    // The index is in the clear and the containers are not, which one key for
    // the whole install gets wrong either way.
    expect(game.xorKey).toBe(0);
    expect(game.dataXorKey).toBe(0x69);
  });

  it('says which containers a v4 index is missing rather than not finding it', async () => {
    const source = folder({ '000.LFL': lecIndex() });
    await expect(detectGame(source)).rejects.toThrow(/no DISKnn\.LEC containers/);
  });

  it('tells v2 from v3 by the width of the global object table', async () => {
    const v2 = folder({
      '00.LFL': lflIndex(1, [55, 35, 200, 100]),
      '01.LFL': new Uint8Array(8),
    });
    const v3 = folder({
      '00.LFL': lflIndex(4, [55, 35, 200, 100]),
      '01.LFL': new Uint8Array(8),
    });

    const detectedV2 = await detectGame(v2);
    const detectedV3 = await detectGame(v3);

    expect(detectedV2.version).toBe(2);
    expect(detectedV3.version).toBe(3);
    // Decided by which width walks the index to its last byte, so both are
    // read rather than guessed — which is what lets either one be edited.
    expect(detectedV2.identification).toBe('index-structure');
    expect(detectedV3.identification).toBe('index-structure');
    expect(detectedV2.layout).toBe('lfl-rooms');
  });

  it('reads a v3 index through its 0xFF encryption', async () => {
    const source = folder({
      '00.LFL': xored(lflIndex(4, [55, 35, 200, 100]), 0xff),
      '01.LFL': new Uint8Array(8),
    });
    const game = await detectGame(source);

    expect(game.version).toBe(3);
    expect(game.xorKey).toBe(0xff);
  });

  it('refuses an LFL index with no rooms beside it', async () => {
    const source = folder({ '00.LFL': lflIndex(4, [55, 35, 200, 100]) });
    await expect(detectGame(source)).rejects.toThrow(/no room files/);
  });

  it('leaves the v5-v8 container pair exactly as it was', async () => {
    // A `.000`/`.001` pair still takes the container path: the LFL branches are
    // reached by filename shape, and this has neither shape.
    const source = folder({ 'X.000': new Uint8Array(4), 'X.001': new Uint8Array(4) });
    await expect(detectGame(source)).rejects.toThrow(/no matching data file|not SCUMM game data/);
  });
});

describe('editing a game whose Version was guessed', () => {
  /**
   * ADR 0013's rule, now on the SCUMM side as well as AGI's.
   *
   * v2 and v3 share a filename shape and are told apart by the width of one
   * column inside the index. When that reading does not add up the Version is
   * a guess — and a guess is safe to *play* on and not to edit on, because
   * decoding a script with the wrong Version's table misreads every boundary
   * after the first renumbered instruction and then re-emits its own
   * misreading byte for byte.
   */
  it('plays on a guess and refuses to edit on one', async () => {
    const { describeUneditableTarget } = await import('../src/authoring/target.js');

    expect(describeUneditableTarget({ engine: 'scumm', version: 5 })).toBeNull();
    expect(
      describeUneditableTarget({
        engine: 'scumm',
        version: 5,
        identification: 'index-structure',
      }),
    ).toBeNull();

    const refusal = describeUneditableTarget({
      engine: 'scumm',
      version: 5,
      identification: 'guess',
    });
    expect(refusal).toMatch(/cannot be edited/);
    expect(refusal).toMatch(/ADR 0013/);
  });

  it('keeps the identification through a round trip of the project file', async () => {
    const { parseTarget } = await import('../src/authoring/target.js');
    const parsed = parseTarget({ engine: 'scumm', version: 6, identification: 'guess' });

    expect(parsed).toEqual({ engine: 'scumm', version: 6, identification: 'guess' });
  });
});
