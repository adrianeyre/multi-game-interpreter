import { describe, expect, it } from 'vitest';
import {
  describeMismatchedSource,
  shouldStoreOriginals,
  STORE_ORIGINALS_BELOW_BYTES,
  type ImportOrigin,
} from '../src/editor/importOrigin.js';
import { resupplyFrom } from '../src/editor/resupply.js';

/**
 * Exporting a game whose originals were never stored (ADR 0010).
 *
 * The store-nothing path is the one exercised least often, because reaching it
 * needs a large game. That is exactly why the threshold is a constant a test
 * can force rather than a quota probe: otherwise the path that is already rare
 * would be exercised unpredictably as well.
 */
const origin: ImportOrigin = {
  indexFile: 'FT.LA0',
  dataFile: 'FT.LA1',
  indexBytes: 1024,
  dataBytes: 148_000_000,
  engineVersion: 'FT 1.0',
  dataVersion: 'FT data 1.0',
};

describe('deciding whether to keep the originals', () => {
  it('keeps them for a game the size of a v5 or v6 release', () => {
    expect(shouldStoreOriginals(16 * 1024 * 1024)).toBe(true);
  });

  it('does not keep them for a game the size of Full Throttle', () => {
    expect(shouldStoreOriginals(148 * 1024 * 1024)).toBe(false);
  });

  it('sits above every v5 and v6 release and below Full Throttle’s data file', () => {
    expect(STORE_ORIGINALS_BELOW_BYTES).toBeGreaterThan(32 * 1024 * 1024);
    expect(STORE_ORIGINALS_BELOW_BYTES).toBeLessThan(148 * 1024 * 1024);
  });

  it('can be forced low, which is the only way CI runs the other path', () => {
    expect(shouldStoreOriginals(1024, 512)).toBe(false);
  });
});

describe('refusing a folder that is not the game this project came from', () => {
  it('accepts the folder it was imported from', () => {
    expect(describeMismatchedSource(origin, { ...origin })).toBeNull();
  });

  it('refuses a different game by name', () => {
    const refusal = describeMismatchedSource(origin, {
      ...origin,
      indexFile: 'DIG.LA0',
      dataFile: 'DIG.LA1',
    });
    expect(refusal).toMatch(/FT\.LA0/);
    expect(refusal).toMatch(/DIG\.LA0/);
  });

  it('refuses a different release of the same game by size', () => {
    // The failure worth spending a check on: names alone match, and the
    // resources are at different offsets, so the export would produce a game
    // that loads and is wrong.
    const refusal = describeMismatchedSource(origin, { ...origin, dataBytes: 149_000_000 });
    expect(refusal).toMatch(/different release/);
  });

  it('refuses a different data build of the same size', () => {
    // Two builds of one release can be byte-for-byte the same length and still
    // hold different scripts, which is what the version strings separate.
    const refusal = describeMismatchedSource(origin, { ...origin, dataVersion: 'FT data 1.2' });
    expect(refusal).toMatch(/data build/);
  });

  it('does not refuse on a version string the origin never recorded', () => {
    // v5 and v6 have no such strings, so their absence must not read as a
    // mismatch.
    const noVersions: ImportOrigin = {
      indexFile: 'TENTACLE.000',
      dataFile: 'TENTACLE.001',
      indexBytes: 100,
      dataBytes: 200,
    };
    expect(
      describeMismatchedSource(noVersions, { ...noVersions, dataVersion: 'anything' }),
    ).toBeNull();
  });

  it('matches a file name whatever case the folder uses', () => {
    // SCUMM releases are inconsistent about case and extraction tools change
    // it, which the data source already accounts for.
    expect(
      describeMismatchedSource(origin, { ...origin, indexFile: 'ft.la0', dataFile: 'ft.la1' }),
    ).toBeNull();
  });
});

describe('reading the originals back at export', () => {
  const file = (bytes: number) => ({
    name: 'x',
    createWritable: async () => ({ write: async () => {}, close: async () => {} }),
    getFile: async () => ({
      size: bytes,
      arrayBuffer: async () => new ArrayBuffer(bytes),
    }),
  });

  const folder = (files: Record<string, number>) => ({
    name: 'FullThrottle',
    getFileHandle: async (name: string) => {
      if (!(name in files)) throw new Error('not found');
      return file(files[name]);
    },
  });

  it('reads the pair the project was imported from', async () => {
    const result = await resupplyFrom(folder({ 'FT.LA0': 1024, 'FT.LA1': 148_000_000 }), origin, 0);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source.index).toHaveLength(1024);
      // A set of one, which is what a container game's data is. The names come
      // back too, because the exporter writes files rather than a pair.
      expect(result.source.dataFiles).toHaveLength(1);
      expect(result.source.dataFiles[0].name).toBe('FT.LA1');
      expect(result.source.dataFiles[0].data).toHaveLength(148_000_000);
    }
  });

  it('refuses a folder missing the index, naming the file it wanted', async () => {
    const result = await resupplyFrom(folder({ 'FT.LA1': 148_000_000 }), origin, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('FT.LA0');
  });

  it('refuses a folder with the index but not the data', async () => {
    const result = await resupplyFrom(folder({ 'FT.LA0': 1024 }), origin, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('FT.LA1');
  });

  it('refuses a different release before writing anything', async () => {
    // The whole point of the check: names match, sizes do not, resources are at
    // different offsets, and the export would produce a game that loads and is
    // wrong.
    const result = await resupplyFrom(folder({ 'FT.LA0': 1024, 'FT.LA1': 149_000_000 }), origin, 0);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/different release/);
  });

  it('checks both files before accepting either', async () => {
    // A folder with the right index and the wrong data must be refused on the
    // mismatch rather than half-accepted on the name.
    const result = await resupplyFrom(folder({ 'FT.LA0': 1024, 'FT.LA1': 1 }), origin, 0);
    expect(result.ok).toBe(false);
  });
});
