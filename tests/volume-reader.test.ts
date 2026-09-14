/**
 * ADR 0021's read seam: the bytes of a volume, from here, this many.
 *
 * The two implementations are tested against each other rather than separately,
 * because the claim the seam makes is that a caller cannot tell which one it
 * has — that is what lets SCUMM keep its container in memory while SCI streams
 * a seven-disc install through the same interface.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import {
  BufferVolumeReader,
  SourceVolumeReader,
  type VolumeReader,
} from '../src/engine/resource/VolumeReader.js';
import { FileHandleDataSource } from '../src/hosting/FileHandleDataSource.js';

const BYTES = new Uint8Array(256);
for (let i = 0; i < BYTES.length; i++) BYTES[i] = i;

let directory = '';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mgi-volume-'));
  await writeFile(join(directory, 'RESOURCE.000'), BYTES);
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function readers(): Array<[string, () => VolumeReader]> {
  return [
    ['buffer', () => new BufferVolumeReader('t', [['RESOURCE.000', BYTES]])],
    [
      'memory source',
      () => new SourceVolumeReader(new MemoryDataSource('t', [['RESOURCE.000', BYTES]])),
    ],
    [
      'file handle',
      () => new SourceVolumeReader(new FileHandleDataSource(directory, ['RESOURCE.000'])),
    ],
  ];
}

describe.each(readers())('a %s volume reader', (_name, make) => {
  it('reads exactly the range asked for', async () => {
    expect([...(await make().read('RESOURCE.000', 10, 4))]).toEqual([10, 11, 12, 13]);
  });

  it('matches names the way DataSource does, case and path insensitively', async () => {
    expect([...(await make().read('resource.000', 0, 2))]).toEqual([0, 1]);
  });

  it('returns what is there rather than throwing when a read runs past the end', async () => {
    expect((await make().read('RESOURCE.000', 250, 20)).length).toBe(6);
  });

  it('returns nothing for a volume it does not have, rather than throwing', async () => {
    expect((await make().read('RESOURCE.999', 0, 4)).length).toBe(0);
  });
});

describe('a buffer-backed reader', () => {
  it('answers without awaiting, which is what SCUMM and AGI need mid-frame', () => {
    const reader = new BufferVolumeReader('t', [['VOL.0', BYTES]]);
    expect([...reader.readSync('VOL.0', 3, 2)]).toEqual([3, 4]);
  });

  it('hands out the whole volume for a caller that has to walk a chunk tree', () => {
    const reader = new BufferVolumeReader('t', [['VOL.0', BYTES]]);
    expect(reader.whole('VOL.0').length).toBe(256);
    expect(reader.whole('VOL.7').length).toBe(0);
  });
});

describe('a file-handle source', () => {
  it('lists the names it was given without opening any of them', () => {
    const source = new FileHandleDataSource(directory, ['RESOURCE.000']);
    expect(source.list()).toEqual(['RESOURCE.000']);
  });

  it('reads a whole file when a caller genuinely wants one', async () => {
    const source = new FileHandleDataSource(directory, ['RESOURCE.000']);
    expect((await source.read('RESOURCE.000'))?.length).toBe(256);
    expect(await source.read('nothing.000')).toBeNull();
  });
});
