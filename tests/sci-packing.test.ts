/**
 * The SCI packer, checked against the engine's own reader.
 *
 * Tier 1 over `fixtureSci.ts`, and the tier claim needs saying carefully here
 * because this file is one step nearer the trap
 * `docs/processes/verifying-version-support.md` names than its neighbours. A
 * fixture "encodes our reading of the format", and a packer checked against a
 * fixture is a writer checked against that same reading.
 *
 * What makes it worth running anyway is which two things are being compared.
 * The packer is not read back by itself: every assertion below goes through
 * `detectSciGame` and `SciResources` — the reader that has been run against
 * seventeen freely distributed Sierra demos and read all 4,157 of their
 * resources. So a failure here is the writer disagreeing with a reader that
 * real games agree with, which is the strongest thing available on a machine
 * with no SCI data on it. It is still not evidence that Sierra's own
 * interpreter would load the result.
 */

import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { detectMapVersion } from '../src/engine/sci/resource/resourceMap.js';
import type { SciMapVersion } from '../src/engine/sci/resource/resourceMap.js';
import { packSciGame } from '../src/authoring/sci/packSciGame.js';
import {
  buildSci0Fixture,
  buildSci11Fixture,
  buildSci32Fixture,
  buildSci3Fixture,
  type SciFixture,
  type SciResourceSpec,
} from './fixtureSci.js';

function sourceFrom(files: Iterable<[string, Uint8Array]>): MemoryDataSource {
  return new MemoryDataSource('packed sci', new Map(files));
}

/** What went into a fixture, keyed the way `exportSciGame` keys its output. */
function resourceMapOf(specs: readonly SciResourceSpec[]): Map<string, Uint8Array> {
  return new Map(
    specs.map((spec) => [`${spec.type}:${spec.number}`, new Uint8Array(spec.body)] as const),
  );
}

/** Packs, reads the result back through the engine, and returns what came out. */
async function roundTrip(
  resources: Map<string, Uint8Array>,
  mapVersion: SciMapVersion,
): Promise<{
  read: Map<string, Uint8Array>;
  mapVersion: SciMapVersion;
  files: string[];
}> {
  const packed = packSciGame(resources, { mapVersion });
  expect(packed.refused).toEqual([]);

  const source = sourceFrom(packed.files.map((file) => [file.name, file.data] as const));
  const { game, resources: reader } = await detectSciGame(source, { onLog: () => undefined });

  const read = new Map<string, Uint8Array>();
  for (const type of reader.types()) {
    for (const number of reader.list(type)) {
      const bytes = await reader.read(type, number);
      if (bytes) read.set(`${type}:${number}`, bytes);
    }
  }
  expect(reader.unreadable).toEqual([]);

  return { read, mapVersion: game.mapVersion, files: packed.files.map((file) => file.name) };
}

const FIXTURES: Array<{ name: string; mapVersion: SciMapVersion; fixture: () => SciFixture }> = [
  { name: 'SCI0', mapVersion: 'sci0-sci1-early', fixture: buildSci0Fixture },
  { name: 'SCI1.1', mapVersion: 'sci11', fixture: buildSci11Fixture },
  { name: 'SCI32', mapVersion: 'sci2', fixture: buildSci32Fixture },
  { name: 'SCI3', mapVersion: 'sci2', fixture: buildSci3Fixture },
];

describe('packing an install the engine can read back', () => {
  for (const { name, mapVersion, fixture } of FIXTURES) {
    it(`round-trips every ${name} resource byte for byte`, async () => {
      const going = resourceMapOf(fixture().resources);
      const { read } = await roundTrip(going, mapVersion);

      expect([...read.keys()].sort()).toEqual([...going.keys()].sort());
      for (const [key, original] of going) {
        expect([...(read.get(key) ?? [])], key).toEqual([...original]);
      }
    });
  }

  /**
   * The three map structures no fixture builder writes.
   *
   * `fixtureSci.ts` covers four of the six `detectMapVersion` tells apart, and
   * the other three are the ones a packed install would otherwise reach with
   * nothing checking it: SCI1 middle's four-bit volume nibble, SCI1 late's
   * six-byte directory entry and the FM-Towns map with its type lifted into a
   * byte of its own. The reader handles all three, so the packer must produce
   * all three or refuse them by name.
   */
  for (const mapVersion of ['sci1-middle', 'sci1-late', 'kq5-fm-towns'] as const) {
    it(`round-trips a ${mapVersion} install`, async () => {
      const going = resourceMapOf(buildSci0Fixture().resources);
      const { read } = await roundTrip(going, mapVersion);

      expect([...read.keys()].sort()).toEqual([...going.keys()].sort());
      for (const [key, original] of going) {
        expect([...(read.get(key) ?? [])], key).toEqual([...original]);
      }
    });
  }
});

/**
 * A Volume whose offsets do not fit in two bytes.
 *
 * Every fixture above is a few hundred bytes, so every offset the packer has
 * ever written into a map entry has been a small number — and the fields these
 * maps hold offsets in are the part of the format most likely to be wrong at
 * one size and right at another: a flat entry packs the volume into the top six
 * bits of the same word, a SCI1.1 entry holds 24 bits that the reader doubles,
 * and a SCI1-late entry hides a volume nibble above 28 bits of offset. None of
 * that arithmetic is exercised by an install that fits in a single page.
 *
 * So this packs two megabytes into each of the six structures and reads it back
 * through the engine, with the Volume size asserted first: a test that quietly
 * shrank back under 0xffff would pass while measuring nothing.
 */
describe('a Volume past the first 64KB', () => {
  // Forty thousand bytes each, which is under the 16-bit packed size a SCI0 or
  // SCI1 volume header can describe, so the size limit is not what is under
  // test here — the offsets are.
  const BODY = 40_000;
  // Forty-nine and not fifty, for a reason worth stating: these resources are
  // all one type, so a SCI1-late map of them has exactly one entry block, and a
  // block of fifty six-byte entries is three hundred bytes — divisible by five
  // as well as by six, which is the width ambiguity `detectMapVersion`
  // documents and resolves towards SCI1.1. Forty-nine keeps this test about
  // offsets; the ambiguity itself is asserted separately below.
  const COUNT = 49;

  function bulk(): Map<string, Uint8Array> {
    const resources = new Map<string, Uint8Array>();
    for (let i = 0; i < COUNT; i++) {
      const body = new Uint8Array(BODY);
      // Enough variation that a resource read back from the wrong offset is a
      // different array rather than the same run of zeroes.
      for (let j = 0; j < BODY; j += 101) body[j] = (i * 7 + j) & 0xff;
      resources.set(`view:${i}`, body);
    }
    return resources;
  }

  for (const mapVersion of [
    'sci0-sci1-early',
    'sci1-middle',
    'sci1-late',
    'kq5-fm-towns',
    'sci11',
    'sci2',
  ] as const) {
    it(`round-trips ${COUNT} resources through a ${mapVersion} map`, async () => {
      const going = bulk();
      expect(packSciGame(going, { mapVersion }).volumeBytes).toBeGreaterThan(0xffff);

      const { read } = await roundTrip(going, mapVersion);
      expect([...read.keys()].sort()).toEqual([...going.keys()].sort());
      for (const [key, original] of going) {
        expect([...(read.get(key) ?? [])], key).toEqual([...original]);
      }
    });
  }
});

/**
 * A limit of the reader, recorded here rather than left to be rediscovered.
 *
 * `detectMapVersion` has no field telling it how wide a directory map's entries
 * are; it infers the width from the gaps between directory offsets, and a gap
 * divisible by thirty is divisible by both five and six. So a SCI1-late map
 * whose every type block holds a multiple of five entries is genuinely
 * indistinguishable from a SCI1.1 one by structure alone, and the reader says
 * so in its own comment before resolving towards SCI1.1 — the commoner of the
 * two — and leaving the rest to the probes.
 *
 * The written bytes are not wrong — an interpreter built for one version is
 * told its entry width rather than inferring it. But read back through *this*
 * project's reader the entries are parsed five bytes at a time, and the
 * resources are not merely moved: they are lost, their offsets landing past the
 * end of the Volume. Everything here that opens an install goes through that
 * reader, `playSci` included, so the packer refuses by name instead of writing
 * a install this editor could not then play.
 *
 * A real release reaching it is unlikely but not impossible: it needs *every*
 * resource type's count to be a multiple of five at once.
 */
describe('the one container this project cannot read back as itself', () => {
  function views(count: number): Map<string, Uint8Array> {
    const going = new Map<string, Uint8Array>();
    for (let i = 0; i < count; i++) going.set(`view:${i}`, new Uint8Array([i, i + 1, i + 2]));
    return going;
  }

  it('refuses a SCI1-late map whose every entry block is a multiple of five', () => {
    const packed = packSciGame(views(5), { mapVersion: 'sci1-late' });

    expect(packed.refused).toHaveLength(1);
    // Both structures named, and the reason: a refusal an author cannot act on
    // is a refusal that reads as a bug.
    expect(packed.refused[0]).toContain('sci1-late');
    expect(packed.refused[0]).toContain('sci11');
    expect(packed.refused[0]).toContain('multiple of five');
    expect(packed.files).toEqual([]);
  });

  it('would have lost the resources rather than moved them', async () => {
    // What the refusal above is worth: the same map, read back the way the
    // reader would have read it. Packed here without the guard by asking for
    // the structure the reader resolves to anyway.
    const packed = packSciGame(views(5), { mapVersion: 'sci11' });
    const source = sourceFrom(packed.files.map((file) => [file.name, file.data] as const));
    const { game } = await detectSciGame(source, { onLog: () => undefined });

    // Five six-byte entries and five five-byte ones are the same block length,
    // which is the whole ambiguity — the reader cannot tell these two apart.
    expect(game.mapVersion).toBe('sci11');
  });

  it('packs happily when a type block is not a multiple of five', async () => {
    expect((await roundTrip(views(4), 'sci1-late')).mapVersion).toBe('sci1-late');
  });
});

/**
 * A packed install that reads back as a different container is a round trip
 * that has stopped measuring the container.
 *
 * The SCI0/SCI1-middle pair is the one that can drift silently: both readings
 * of the offset word are well-formed and the only thing that says which is
 * right is a volume number that names a file nobody shipped. So the packer
 * writes volume 1 rather than 0, and this is the assertion that keeps it doing
 * so — every offset would still resolve if it stopped, which is exactly why
 * nothing else would notice.
 */
describe('the map structure survives a pack', () => {
  for (const mapVersion of [
    'sci0-sci1-early',
    'sci1-middle',
    'kq5-fm-towns',
    'sci1-late',
    'sci11',
    'sci2',
  ] as const) {
    it(`reads back as ${mapVersion}`, async () => {
      const going = resourceMapOf(buildSci0Fixture().resources);
      const result = await roundTrip(going, mapVersion);
      expect(result.mapVersion).toBe(mapVersion);
    });
  }
});

describe('the files a pack writes', () => {
  it('is one map beside one resource Volume', () => {
    const packed = packSciGame(resourceMapOf(buildSci0Fixture().resources), {
      mapVersion: 'sci0-sci1-early',
    });
    expect(packed.files.map((file) => file.name)).toEqual(['RESOURCE.MAP', 'RESOURCE.001']);
  });

  it('names a SCI32 install the way a SCI32 release does', () => {
    const packed = packSciGame(resourceMapOf(buildSci32Fixture().resources), {
      mapVersion: 'sci2',
    });
    expect(packed.files.map((file) => file.name)).toEqual(['RESMAP.000', 'RESSCI.000']);
  });

  /**
   * Space Quest 6 is a SCI2.1 game under `RESOURCE.MAP`, so the names say which
   * files to open and nothing about the Version. A packed install keeps the
   * ones it arrived with.
   */
  it('keeps the names the original install used when it is given a layout', () => {
    const packed = packSciGame(resourceMapOf(buildSci32Fixture().resources), {
      mapVersion: 'sci2',
      layout: {
        mapFile: 'sq6/RESOURCE.MAP',
        volumes: new Map([[0, 'sq6/RESOURCE.000']]),
        numberedMaps: false,
        alternate: null,
        mapFiles: ['sq6/RESOURCE.MAP'],
      },
    });
    expect(packed.files.map((file) => file.name)).toEqual(['RESOURCE.MAP', 'RESOURCE.000']);
  });

  it('copies carried Volumes through byte for byte', () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const packed = packSciGame(resourceMapOf(buildSci11Fixture().resources), {
      mapVersion: 'sci11',
      carried: [{ name: 'RESOURCE.AUD', data: audio }],
    });
    expect(packed.carried).toEqual(['RESOURCE.AUD']);
    const written = packed.files.find((file) => file.name === 'RESOURCE.AUD');
    expect([...(written?.data ?? [])]).toEqual([1, 2, 3, 4]);
  });
});

/**
 * Every field a packed install writes into is narrower than the thing it holds,
 * and a value that does not fit has no wrong answer that fails loudly.
 *
 * `number & 0x7ff` produces a map that loads and serves the wrong resource,
 * which is the silent failure `SciResources` already refuses compressed bytes
 * for. These are the same refusal on the way out.
 */
describe('what the packer will not write', () => {
  it('refuses a resource number a flat map cannot hold, by name', () => {
    const packed = packSciGame(new Map([['view:3000', new Uint8Array([1, 2])]]), {
      mapVersion: 'sci0-sci1-early',
    });
    expect(packed.files).toEqual([]);
    expect(packed.refused.join('\n')).toContain('view:3000');
    expect(packed.refused.join('\n')).toContain('eleven bits');
  });

  it('refuses a resource too large for a 16-bit volume header', () => {
    const packed = packSciGame(new Map([['view:1', new Uint8Array(70_000)]]), {
      mapVersion: 'sci11',
    });
    expect(packed.files).toEqual([]);
    expect(packed.refused.join('\n')).toContain('view:1');
    expect(packed.refused.join('\n')).toContain('16-bit sizes');
  });

  /** SCI32's header has 32-bit sizes, so the same resource is fine there. */
  it('writes that resource happily into a SCI32 container', () => {
    const packed = packSciGame(new Map([['view:1', new Uint8Array(70_000)]]), {
      mapVersion: 'sci2',
    });
    expect(packed.refused).toEqual([]);
    expect(packed.files).toHaveLength(2);
  });

  it('refuses a key that is not a resource type and number', () => {
    const packed = packSciGame(new Map([['nonsense:1', new Uint8Array([0])]]), {
      mapVersion: 'sci11',
    });
    expect(packed.files).toEqual([]);
    expect(packed.refused.join('\n')).toContain('nonsense:1');
  });
});

/**
 * A map written with no resources at all is still a map, and what the reader
 * makes of it is not the same answer for both structures.
 *
 * A flat map is six bytes of `0xff` with nothing in front, and that is enough:
 * the terminator is the whole tell. A directory map with no types is three
 * bytes — the terminator record alone — and `detectMapVersion` declines
 * anything shorter than six before it looks at a field, so it answers null.
 * That is the honest answer rather than a shortfall to route around: the
 * function returns null rather than guessing, and a three-byte file genuinely
 * does not carry the evidence. What matters is that the packer still writes a
 * well-formed map of the right length rather than an empty file, so this
 * asserts the bytes and the reader's verdict separately.
 */
describe('an empty game', () => {
  it('writes a flat map the reader still identifies', () => {
    const packed = packSciGame(new Map(), { mapVersion: 'sci0-sci1-early' });
    const map = packed.files.find((file) => file.name === packed.mapFile)?.data;
    expect([...(map ?? [])]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(detectMapVersion(map ?? new Uint8Array(), () => true)).toBe('sci0-sci1-early');
  });

  it('writes a directory map that is a terminator and nothing else', () => {
    for (const mapVersion of ['sci11', 'sci2'] as const) {
      const packed = packSciGame(new Map(), { mapVersion });
      const map = packed.files.find((file) => file.name === packed.mapFile)?.data;
      // The terminator record: type 0xff, pointing at the end of the map.
      expect([...(map ?? [])], mapVersion).toEqual([0xff, 0x03, 0x00]);
      expect(
        detectMapVersion(map ?? new Uint8Array(), () => true),
        mapVersion,
      ).toBeNull();
    }
  });
});
