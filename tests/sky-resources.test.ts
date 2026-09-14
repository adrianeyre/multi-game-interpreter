import { describe, expect, it } from 'vitest';
import {
  SkyResources,
  SkyResourceError,
  SKY_RESOURCE_HEADER_BYTES,
} from '../src/engine/sky/resource/SkyResources.js';
import {
  looksRncPacked,
  readRncHeader,
  rncCrc,
  rncUnpack,
  RncError,
  RNC_HEADER_BYTES,
} from '../src/engine/sky/resource/rnc.js';
import { buildSkyFixture, SKY_FIXTURE_ENTRIES } from './fixtureSky.js';

/**
 * What these tests can and cannot establish, said plainly.
 *
 * The addressing is checkable here, because a fixture can be built from the
 * format and read back. **The decompressor is not**, and the honest thing is to
 * say so rather than to build a fixture that would pass: an RNC stream can only
 * be produced by a compressor, so writing one here would mean writing an
 * encoder against this decoder's reading of the interleave — which is precisely
 * Tier 1's trap in `docs/processes/verifying-version-support.md`, "the fixture
 * and the engine agree with each other and disagree with the game".
 *
 * The decompressor's evidence is Tier 2 instead, and it is much stronger than a
 * fixture would have been: every packed resource carries a CRC of its own
 * unpacked bytes, and `npm run sweep:vt` checks all 5,907 of them across both
 * shipped releases. What is tested here is everything around it — the marker,
 * the header, the CRC function against a published check value, and every
 * refusal.
 */
describe('RNC ProPack method 1', () => {
  it('computes the CRC the format checks itself with', () => {
    // CRC-16/ARC's published check value: the digest of "123456789" is 0xBB3D.
    // An independent oracle, which a fixture of our own could not be.
    expect(rncCrc(new TextEncoder().encode('123456789'))).toBe(0xbb3d);
    expect(rncCrc(new Uint8Array(0))).toBe(0);
    expect(rncCrc(new Uint8Array(80))).toBe(0);
  });

  it('recognises its own marker and nothing else', () => {
    const header = new Uint8Array(RNC_HEADER_BYTES);
    header.set([0x52, 0x4e, 0x43, 0x01]);
    expect(looksRncPacked(header)).toBe(true);

    // Method 2 shares three bytes and is a different algorithm, so it must not
    // be claimed: being fed to the wrong decoder is worse than being refused.
    header[3] = 0x02;
    expect(looksRncPacked(header)).toBe(false);

    expect(looksRncPacked(new Uint8Array([0x52, 0x4e, 0x43, 0x01]))).toBe(false);
  });

  it('reads the header without decompressing', () => {
    const bytes = new Uint8Array(RNC_HEADER_BYTES);
    bytes.set([0x52, 0x4e, 0x43, 0x01]);
    new DataView(bytes.buffer).setUint32(4, 64_000, false);
    new DataView(bytes.buffer).setUint32(8, 2_383, false);
    new DataView(bytes.buffer).setUint16(12, 0x1234, false);
    new DataView(bytes.buffer).setUint16(14, 0x6649, false);
    bytes[17] = 6;

    const header = readRncHeader(bytes);
    expect(header.unpackedLength).toBe(64_000);
    expect(header.packedLength).toBe(2_383);
    expect(header.unpackedCrc).toBe(0x1234);
    expect(header.packedCrc).toBe(0x6649);
    expect(header.blocks).toBe(6);
  });

  it('refuses bytes that are not a stream, and a stream that is truncated', () => {
    expect(() => readRncHeader(new Uint8Array(RNC_HEADER_BYTES))).toThrow(RncError);

    const bytes = new Uint8Array(RNC_HEADER_BYTES + 4);
    bytes.set([0x52, 0x4e, 0x43, 0x01]);
    new DataView(bytes.buffer).setUint32(8, 1_000, false);
    expect(() => rncUnpack(bytes)).toThrow(/truncated/);
  });

  it('blames the file rather than itself when the packed bytes are wrong', () => {
    const bytes = new Uint8Array(RNC_HEADER_BYTES + 8);
    bytes.set([0x52, 0x4e, 0x43, 0x01]);
    new DataView(bytes.buffer).setUint32(4, 16, false);
    new DataView(bytes.buffer).setUint32(8, 8, false);
    new DataView(bytes.buffer).setUint16(14, 0xffff, false);
    expect(() => rncUnpack(bytes)).toThrow(/Suspect the index read/);
  });
});

describe('SkyResources', () => {
  it('identifies the release from the entry count and the data length', () => {
    const floppy = SkyResources.open(
      ...buildSkyFixture({ entryCount: 1_445, dataLength: 8_830_435 }),
    );
    expect(floppy.releaseInfo.build).toBe(348);
    expect(floppy.releaseInfo.release).toBe('floppy');
    expect(floppy.releaseInfo.offsetUnit).toBe(16);

    // The one tie the count alone does not break, and it decides the unit a
    // stored offset counts — which is not a difference to get wrong quietly.
    const older = SkyResources.open(
      ...buildSkyFixture({ entryCount: 1_445, dataLength: 4_000_000 }),
    );
    expect(older.releaseInfo.build).toBe(331);
    expect(older.releaseInfo.offsetUnit).toBe(8);

    const cd = SkyResources.open(...buildSkyFixture({ entryCount: 5_097, dataLength: 72_395_713 }));
    expect(cd.releaseInfo.release).toBe('cd');
  });

  it('refuses an index whose entry count matches no known release', () => {
    expect(() =>
      SkyResources.open(...buildSkyFixture({ entryCount: 7, dataLength: 4_096 })),
    ).toThrow(/matches no Beneath a Steel Sky release/);
  });

  it('cuts a stored resource out at the offset the index gives', () => {
    const [index, data] = buildSkyFixture({});
    const resources = SkyResources.open(index, data);
    const first = SKY_FIXTURE_ENTRIES[0];
    expect(resources.read(first.id)).toEqual(
      data.subarray(first.offset, first.offset + first.size),
    );
  });

  it('scales an offset stored in units', () => {
    const [index, data] = buildSkyFixture({});
    const resources = SkyResources.open(index, data);
    const inUnits = SKY_FIXTURE_ENTRIES.find((entry) => entry.offsetInUnits)!;
    const entry = resources.entry(inUnits.id)!;
    expect(entry.offset).toBe(inUnits.offset);
    expect(resources.read(inUnits.id)[0]).toBe(data[inUnits.offset]);
  });

  it('passes a resource through when the marker is not actually there', () => {
    // Twenty-six entries per shipped release say "packed" in the prefix and
    // carry no marker. The game passes those through; so must this, and
    // silently is right here because the game is not surprised by it either.
    const [index, data] = buildSkyFixture({});
    const resources = SkyResources.open(index, data);
    const claimed = SKY_FIXTURE_ENTRIES.find((entry) => entry.claimsPackedWithoutMarker)!;
    expect(resources.read(claimed.id).length).toBe(claimed.size);
  });

  it('reports a resource that addresses past the end of the data file', () => {
    const [index, data] = buildSkyFixture({ overrunLastEntry: true });
    const resources = SkyResources.open(index, data);
    expect(resources.notes.some((note) => /past the end/.test(note.reason))).toBe(true);
    expect(resources.describe()).toMatch(/unreadable or unusual/);
  });

  it('refuses an id the index does not address, naming the count', () => {
    const resources = SkyResources.open(...buildSkyFixture({}));
    expect(() => resources.read(0xdead)).toThrow(SkyResourceError);
    expect(() => resources.read(0xdead)).toThrow(/does not address resource/);
  });

  it('says nothing is unreadable when nothing is', () => {
    const resources = SkyResources.open(...buildSkyFixture({}));
    expect(resources.describe()).toMatch(/Nothing unreadable\./);
  });

  it('keeps the 22-byte prefix reachable', () => {
    // Nine of its eleven words have no established meaning, so a reader that
    // dropped it would be discarding bytes it cannot yet regenerate.
    expect(SKY_RESOURCE_HEADER_BYTES).toBe(22);
  });
});
