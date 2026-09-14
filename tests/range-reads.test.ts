import { describe, expect, it, vi } from 'vitest';
import {
  FileListDataSource,
  HttpDataSource,
  MemoryDataSource,
  readRangeFrom,
  type DataSource,
} from '../src/engine/resource/DataSource.js';

/**
 * Range reads (#114, ADR 0010's engine-side counterpart).
 *
 * The resource layer holds whole files in memory for a stated reason: the
 * script engine asks for a costume synchronously mid-frame, and keeping that
 * removes a class of async plumbing from the hot path. Full Throttle does not
 * fit — ~148 MB before its videos and bundles, and The Dig is larger.
 *
 * The answer is not to make the whole layer async but to narrow what the
 * whole-file model has to cover: the container stays in memory, and the files
 * that are offset-addressed blobs consumed asynchronously — `.SAN`, `.BUN`,
 * `MONSTER.SOU` — are range-read instead.
 */
describe('reading a range from a source that supports it', () => {
  it('returns exactly the bytes asked for', async () => {
    const source = new MemoryDataSource('m', [
      ['GAME.BUN', new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])],
    ]);
    expect([...(await source.readRange('GAME.BUN', 2, 5))!]).toEqual([2, 3, 4]);
  });

  it('clamps a range that runs past the end rather than failing', async () => {
    const source = new MemoryDataSource('m', [['A.BUN', new Uint8Array([1, 2, 3])]]);
    expect([...(await source.readRange('A.BUN', 1, 99))!]).toEqual([2, 3]);
  });

  it('gives nothing for a file that is not there', async () => {
    const source = new MemoryDataSource('m');
    expect(await source.readRange('MISSING.BUN', 0, 4)).toBeNull();
  });

  it('matches a name whatever case it is asked in', async () => {
    // SCUMM releases are inconsistent about case and extraction tools change
    // it, which the whole-file path already accounts for.
    const source = new MemoryDataSource('m', [['VOICE.BUN', new Uint8Array([9, 8])]]);
    expect([...(await source.readRange('voice.bun', 0, 2))!]).toEqual([9, 8]);
  });
});

describe('a local file', () => {
  it('slices rather than reading the whole thing', async () => {
    // The case #114 was written about: reading a few kilobytes out of a
    // hundreds-of-megabytes bundle should cost a few kilobytes.
    const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const sliced: Array<[number, number]> = [];
    const file = {
      name: 'MUSIC.BUN',
      size: bytes.length,
      slice: (start: number, end: number) => {
        sliced.push([start, end]);
        return { arrayBuffer: async () => bytes.slice(start, end).buffer };
      },
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;

    const source = new FileListDataSource([file]);
    expect([...(await source.readRange('MUSIC.BUN', 1, 4))!]).toEqual([1, 2, 3]);
    expect(sliced).toEqual([[1, 4]]);
  });
});

describe('an HTTP source', () => {
  it('asks for the range and takes a 206 at its word', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 206,
      arrayBuffer: async () => new Uint8Array([7, 8]).buffer,
    }));
    vi.stubGlobal('fetch', fetchMock);

    const source = new HttpDataSource('/games/ft/', ['FT.LA1']);
    expect([...(await source.readRange('FT.LA1', 3, 5))!]).toEqual([7, 8]);

    const headers = (fetchMock.mock.calls[0] as unknown[])[1] as {
      headers: Record<string, string>;
    };
    expect(headers.headers.Range).toBe('bytes=3-4');
    vi.unstubAllGlobals();
  });

  it('slices a 200, because a server ignoring Range is correct, not broken', async () => {
    // The distinction worth checking rather than assuming: treating a whole-file
    // 200 as though it were the range would silently read the wrong bytes.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new Uint8Array([0, 1, 2, 3, 4, 5]).buffer,
      })),
    );

    const source = new HttpDataSource('/games/ft/', ['FT.LA1']);
    expect([...(await source.readRange('FT.LA1', 2, 4))!]).toEqual([2, 3]);
    vi.unstubAllGlobals();
  });
});

describe('a source with no range support', () => {
  it('falls back to reading whole and slicing, so callers never have to ask', async () => {
    const plain: DataSource = {
      label: 'plain',
      list: () => ['A.BUN'],
      read: async () => new Uint8Array([0, 1, 2, 3, 4]),
    };

    expect([...(await readRangeFrom(plain, 'A.BUN', 1, 3))!]).toEqual([1, 2]);
  });

  it('uses the real range read when the source has one', async () => {
    const source = new MemoryDataSource('m', [['A.BUN', new Uint8Array([5, 6, 7, 8])]]);
    expect([...(await readRangeFrom(source, 'A.BUN', 2, 4))!]).toEqual([7, 8]);
  });
});
