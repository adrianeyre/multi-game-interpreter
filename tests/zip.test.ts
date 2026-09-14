import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { isZip, readZip } from '../src/engine/resource/zip.js';
import {
  describeForeignEngine,
  identifyForeignEngine,
} from '../src/engine/resource/engineSignatures.js';
import { IMPLEMENTED_FAMILIES } from '../src/engine/resource/families.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';

/** Builds a zip archive in memory, so the reader is tested against real bytes. */
/**
 * `method` writes an arbitrary compression method into the entry, for the
 * methods a browser cannot read. `deflate` is the shorthand for method 8.
 */
function buildZip(
  files: Array<{ name: string; data: Uint8Array; deflate?: boolean; method?: number }>,
): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];

  const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v: number): number[] => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >> 24) & 0xff,
  ];

  for (const file of files) {
    const nameBytes = [...new TextEncoder().encode(file.name)];
    const stored = file.deflate ? new Uint8Array(deflateRawSync(file.data)) : file.data;
    const method = file.method ?? (file.deflate ? 8 : 0);

    offsets.push(local.length);
    local.push(
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(method),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(stored.length),
      ...u32(file.data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...nameBytes,
      ...stored,
    );
  }

  const centralStart = local.length;
  files.forEach((file, index) => {
    const nameBytes = [...new TextEncoder().encode(file.name)];
    const stored = file.deflate ? new Uint8Array(deflateRawSync(file.data)) : file.data;
    central.push(
      ...u32(0x02014b50),
      ...u16(20),
      ...u16(20),
      ...u16(0),
      ...u16(file.method ?? (file.deflate ? 8 : 0)),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(stored.length),
      ...u32(file.data.length),
      ...u16(nameBytes.length),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(0),
      ...u32(offsets[index]),
      ...nameBytes,
    );
  });

  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(files.length),
    ...u16(files.length),
    ...u32(central.length),
    ...u32(centralStart),
    ...u16(0),
  ];

  return new Uint8Array([...local, ...central, ...end]);
}

describe('zip reading', () => {
  it('recognises the archive signature', () => {
    expect(isZip(buildZip([{ name: 'a.txt', data: new Uint8Array([1]) }]))).toBe(true);
    expect(isZip(new Uint8Array([0, 1, 2, 3]))).toBe(false);
  });

  it('reads a stored (uncompressed) entry', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const source = await readZip(buildZip([{ name: 'GAME.000', data: payload }]));
    expect([...(await source.read('GAME.000'))!]).toEqual([...payload]);
  });

  it('reads a deflated entry', async () => {
    const payload = new Uint8Array(512).fill(7);
    const source = await readZip(buildZip([{ name: 'GAME.001', data: payload, deflate: true }]));
    const read = await source.read('GAME.001');
    expect(read).not.toBeNull();
    expect(read!.length).toBe(512);
    expect(read!.every((value) => value === 7)).toBe(true);
  });

  it('ignores directory entries', async () => {
    const source = await readZip(
      buildZip([
        { name: 'game/', data: new Uint8Array(0) },
        { name: 'game/GAME.000', data: new Uint8Array([9]) },
      ]),
    );
    expect(source.list()).toEqual(['game/GAME.000']);
  });

  it('matches names case-insensitively and ignores the directory prefix', async () => {
    const source = await readZip(
      buildZip([{ name: 'Some Folder/monkey2.000', data: new Uint8Array([1]) }]),
    );
    expect(await source.read('MONKEY2.000')).not.toBeNull();
  });
});

describe('foreign engine detection', () => {
  // Sky used to be this test's example and left the table when it gained an
  // interpreter (#255). Lure was the one still here — a verified container
  // reader is not an interpreter — and it has now left too, the fifth family to
  // do so, once `LureEngine` reached its world state (ADR 0026, #263).
  it('identifies Flight of the Amazon Queen', () => {
    expect(identifyForeignEngine(['queen.1c'])?.engine).toBe('Queen');
  });

  it('no longer claims Lure data, which has an engine of its own now', () => {
    expect(identifyForeignEngine(['readme.txt', 'disk1.vga', 'disk2.vga'])).toBeNull();
  });

  /**
   * AGI left this table when it gained an interpreter (#125), and SCI has now
   * followed it for the same reason. #115 deferred the decision — "a separate
   * decision, not a follow-on" — and #211 took it (#216).
   */
  it('no longer claims AGI data, which has an engine of its own now', () => {
    expect(identifyForeignEngine(['logdir', 'object'])).toBeNull();
  });

  it('no longer claims SCI data either', () => {
    expect(identifyForeignEngine(['resource.map', 'resource.001'])).toBeNull();
  });

  it('does not claim SCUMM data', () => {
    expect(identifyForeignEngine(['MONKEY2.000', 'MONKEY2.001'])).toBeNull();
  });

  it('explains the mismatch and points somewhere useful', () => {
    const message = describeForeignEngine(identifyForeignEngine(['packet.001'])!);
    expect(message).toContain('Dráscula');
    expect(message).toContain('scummvm.org/demos');
  });

  // Asserted as behaviour rather than as a phrase, because the phrase is what
  // went stale: the message claimed SCUMM-only support for three families'
  // worth of releases after AGI and SCI landed, and a test pinned to the
  // wording held the mistake in place instead of catching it.
  it('names every family this project implements, not just SCUMM', () => {
    const message = describeForeignEngine(identifyForeignEngine(['packet.001'])!);
    expect(message).not.toContain('implements SCUMM only');
    for (const family of IMPLEMENTED_FAMILIES) {
      expect(message).toContain(family);
    }
  });

  it('surfaces through the game detector', async () => {
    const source = new MemoryDataSource('drascula');
    source.set('packet.001', new Uint8Array([1]));
    await expect(detectGame(source)).rejects.toThrow(/Dráscula/);
  });
});

describe('a zip a browser cannot unpack', () => {
  /**
   * The zips on scummvm.org are the original 1993 archives and are compressed
   * with PKWARE's Implode, which no browser can inflate — `DecompressionStream`
   * does Deflate and nothing else. Every file was silently skipped, the archive
   * unpacked to nothing, and the engine then reported that it could not find an
   * index file. That is a true statement about the wrong thing: it sends you
   * looking at the game data rather than at the compression.
   */
  it('says which compression it cannot read, rather than unpacking to nothing', async () => {
    // One entry, method 6 (Implode), with bytes that are never inspected
    // because nothing can read them.
    const archive = buildZip([{ name: 'DOTTDEMO.000', method: 6, data: new Uint8Array([1, 2]) }]);

    await expect(readZip(archive, 'dott-demo.zip')).rejects.toThrow(/Implode/);
    await expect(readZip(archive, 'dott-demo.zip')).rejects.toThrow(/Extract the archive/);
  });

  it('keeps the readable files when only some entries are unreadable', async () => {
    const archive = buildZip([
      { name: 'READABLE.000', method: 0, data: new Uint8Array([7, 7, 7]) },
      { name: 'ODD.001', method: 6, data: new Uint8Array([1, 2]) },
    ]);

    const source = await readZip(archive, 'mixed.zip');

    // The one it could read is there, and the one it could not is simply
    // absent — a game that does not need that file still loads.
    expect(source.list()).toEqual(['READABLE.000']);
    expect(await source.read('READABLE.000')).toEqual(new Uint8Array([7, 7, 7]));
  });
});
