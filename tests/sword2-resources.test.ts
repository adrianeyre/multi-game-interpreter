import { describe, expect, it } from 'vitest';
import {
  Sword2Resources,
  Sword2ResourceError,
  SWORD2_RESIDENT_CLUSTERS,
} from '../src/engine/sword2/resource/Sword2Resources.js';
import {
  checkStructureSizes,
  OBJECT_HUB_SIZE,
  RES_HEADER_SIZE,
  readSword2AnimHeader,
  readSword2CdtEntry,
  readSword2MultiScreenHeader,
  readSword2ResHeader,
  Sword2FileType,
  Sword2FrameType,
} from '../src/engine/sword2/resource/sword2Headers.js';
import { MemoryDataSource, type DataSource } from '../src/engine/resource/DataSource.js';
import {
  buildSword2Fixture,
  buildSword2Globals,
  buildSword2Object,
  buildSword2RunList,
  buildSword2Text,
  sword2Header,
  SWORD2_RES_HEADER_SIZE,
  Writer,
} from './fixtureSword.js';
import { readSword2Text, readSword2TextEntries } from '../src/authoring/sword2/import.js';

function source(fixture: ReturnType<typeof buildSword2Fixture>, skip: string[] = []) {
  const entries: Array<[string, Uint8Array]> = [
    ['resource.inf', fixture.inf],
    ['resource.tab', fixture.tab],
    ['cd.inf', fixture.cdInf],
  ];
  for (const [name, bytes] of fixture.clusters) {
    if (!skip.includes(name)) entries.push([name, bytes]);
  }
  return new MemoryDataSource('sword2 fixture', entries);
}

const FIXTURE = buildSword2Fixture([
  {
    name: 'general.clu',
    resources: [
      { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'unused', 0) },
      { id: 1, bytes: buildSword2Globals([0, 0, 0, 42]) },
      { id: 2, bytes: buildSword2RunList([8]) },
      { id: 8, bytes: buildSword2Object('george', [[0]]) },
    ],
  },
  {
    name: 'docks.clu',
    resources: [{ id: 20, bytes: sword2Header(Sword2FileType.SCREEN_FILE, 'docks', 0) }],
  },
]);

describe('the record shapes', () => {
  it('add up to the sizes the game’s own compiler was told', () => {
    // These are the format, not a convenience: `ResHeader` is 44, `ObjectHub`
    // is 44, and a slip in either reads the next structure's first field.
    expect(() => checkStructureSizes()).not.toThrow();
    expect(RES_HEADER_SIZE).toBe(44);
    expect(OBJECT_HUB_SIZE).toBe(44);
  });

  it('reads a resource header’s type and name', () => {
    const header = readSword2ResHeader(sword2Header(Sword2FileType.GAME_OBJECT, 'mop_73', 120));
    expect(header.fileType).toBe(Sword2FileType.GAME_OBJECT);
    expect(header.name).toBe('mop_73');
    expect(header.decompSize).toBe(120);
  });

  it('reads an animation header’s frame count from its 15 bytes', () => {
    const bytes = new Writer()
      .raw(sword2Header(Sword2FileType.ANIMATION_FILE, 'walk', 0))
      .u8(1)
      .u16(12)
      .u16(0)
      .u16(0)
      .u8(0)
      .u16(0)
      .u16(0)
      .u8(0)
      .u16(0)
      .done();
    expect(readSword2AnimHeader(bytes, RES_HEADER_SIZE).noAnimFrames).toBe(12);
  });

  it('reads a CDT entry’s frame type bits, which decide how a frame is placed', () => {
    const bytes = new Writer().u16(0xfff0).u16(4).u32(100).u8(Sword2FrameType.OFFSET).done();
    const cdt = readSword2CdtEntry(bytes, 0);
    // x is signed: a sprite offset from a mega's feet is often negative.
    expect(cdt.x).toBe(-16);
    expect(cdt.frameOffset).toBe(100);
    expect(cdt.frameType & Sword2FrameType.OFFSET).toBeTruthy();
  });

  it('reads the nine offsets a screen file is described by', () => {
    const bytes = new Writer();
    for (let word = 1; word <= 9; word++) bytes.u32(word * 10);
    const multi = readSword2MultiScreenHeader(bytes.done(), 0);
    expect(multi.palette).toBe(10);
    expect(multi.bgParallax).toEqual([20, 30]);
    expect(multi.screen).toBe(40);
    expect(multi.maskOffset).toBe(90);
  });
});

describe('the index', () => {
  it('refuses a folder missing either index file, by name', async () => {
    await expect(
      Sword2Resources.create(new MemoryDataSource('half', [['resource.inf', FIXTURE.inf]])),
    ).rejects.toThrow(/resource\.tab/);
    await expect(
      Sword2Resources.create(new MemoryDataSource('half', [['resource.tab', FIXTURE.tab]])),
    ).rejects.toThrow(/resource\.inf/);
  });

  it('refuses a PC folder with no cd.inf and no screens.clu', async () => {
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', FIXTURE.inf],
      ['resource.tab', FIXTURE.tab],
    ];
    for (const [name, bytes] of FIXTURE.clusters) entries.push([name, bytes]);
    await expect(Sword2Resources.create(new MemoryDataSource('nocdinf', entries))).rejects.toThrow(
      Sword2ResourceError,
    );
  });

  it('reads the cluster list and the id table', async () => {
    const resources = await Sword2Resources.create(source(FIXTURE));
    expect(resources.clusterNames).toEqual(['general.clu', 'docks.clu']);
    expect(resources.resourceCount).toBeGreaterThan(8);
  });

  it('answers null for an id the table marks absent, which is a normal hole', async () => {
    const resources = await Sword2Resources.create(source(FIXTURE));
    await resources.loadResident();
    expect(resources.fetch(5)).toBeNull();
    expect(resources.describeMissingResource(5)).toMatch(/normal hole/);
  });

  it('reads a cluster’s own index from its tail, not from a second file', async () => {
    const resources = await Sword2Resources.create(source(FIXTURE));
    await resources.loadResident();
    const globals = resources.fetch(1);
    expect(globals?.header.fileType).toBe(Sword2FileType.GLOBAL_VAR_FILE);
    expect(globals?.payload.length).toBe(16);
  });

  it('says a cluster is not in this folder rather than that the id is wrong', async () => {
    const resources = await Sword2Resources.create(source(FIXTURE, ['docks.clu']));
    expect(resources.absentClusters).toEqual(['docks.clu']);
    expect(resources.describeMissingResource(20)).toMatch(/not in this folder/);
  });

  it('loads a region cluster on demand and evicts nothing under the cap', async () => {
    const resources = await Sword2Resources.create(source(FIXTURE));
    await resources.loadResident();
    expect(resources.fetch(20)).toBeNull();
    expect(await resources.satisfyWanted()).toBe(1);
    expect(resources.fetch(20)).not.toBeNull();
  });

  it('separates a resource that is merely early from one that will never come', async () => {
    // Both answer null from `fetch`, and only one of them is a defect. The
    // engine files a fault on the second and stays quiet about the first.
    const resources = await Sword2Resources.create(source(FIXTURE));
    await resources.loadResident();
    expect(resources.fetch(20)).toBeNull();
    expect(resources.willBecomeResident(20)).toBe(true);
    await resources.satisfyWanted();
    // Resident now, so there is nothing left to wait for.
    expect(resources.willBecomeResident(20)).toBe(false);

    const withoutDocks = await Sword2Resources.create(source(FIXTURE, ['docks.clu']));
    await withoutDocks.loadResident();
    expect(withoutDocks.willBecomeResident(20)).toBe(false);
    // And neither is a hole in the table or an id off the end of it.
    expect(resources.willBecomeResident(5)).toBe(false);
    expect(resources.willBecomeResident(99999)).toBe(false);
  });

  it('lists only the ids that really exist, for a sweep', async () => {
    const resources = await Sword2Resources.create(source(FIXTURE));
    expect(resources.allIds()).toEqual([0, 1, 2, 8, 20]);
  });

  it('holds scripts.clu resident, because nothing else holds code', async () => {
    // Measured against the mounted demo: every GAME_OBJECT, every
    // SCREEN_MANAGER and the one GLOBAL_VAR_FILE live in scripts.clu, so a
    // residency list without it cannot answer `fetch(1)` and the game does not
    // start. The fixture puts the globals in a `scripts.clu` to say so.
    const fixture = buildSword2Fixture([
      {
        name: 'scripts.clu',
        resources: [{ id: 1, bytes: buildSword2Globals([0, 0, 0, 7]) }],
      },
      { name: 'general.clu', resources: [{ id: 0, bytes: sword2Header(3, 'x', 0) }] },
    ]);
    expect(SWORD2_RESIDENT_CLUSTERS).toContain('scripts.clu');
    const resources = await Sword2Resources.create(source(fixture));
    await resources.loadResident();
    expect(resources.fetch(1)?.header.fileType).toBe(Sword2FileType.GLOBAL_VAR_FILE);
  });

  it('reads a LOCAL_PERM cluster as needing no disc, whichever disc bit is set', async () => {
    // The demo's own cd.inf marks its hard-disk clusters 0x9 — LOCAL_PERM and
    // CD1 together — so a normalisation that tests CD1 first calls a file that
    // is always present "disc 1" and tells the player to go and find a disc
    // that was never the reason it is missing.
    const fixture = buildSword2Fixture([
      { name: 'general.clu', resources: [{ id: 0, bytes: sword2Header(3, 'x', 0) }] },
      { name: 'docks.clu', resources: [{ id: 20, bytes: sword2Header(5, 'y', 0) }] },
      { name: 'paris.clu', resources: [{ id: 30, bytes: sword2Header(5, 'z', 0) }] },
    ]);
    const cdInf = new Writer();
    cdInf.ascii('general.clu', 20).u8(0x9);
    cdInf.ascii('docks.clu', 20).u8(0x9);
    cdInf.ascii('paris.clu', 20).u8(0x2);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', cdInf.done()],
      ['general.clu', fixture.clusters.get('general.clu') as Uint8Array],
    ];
    const resources = await Sword2Resources.create(new MemoryDataSource('flags', entries));
    // `docks.clu` is flagged LOCAL_PERM, so its absence is an absence and not
    // a disc to swap.
    expect(resources.describeMissingResource(20)).toMatch(/not in this folder\.$/);
    // `paris.clu` is flagged CD2 alone, and that still says which disc.
    expect(resources.describeMissingResource(30)).toMatch(/disc 2/);
  });

  it('reads a cluster once when the same frame asks for it twice', async () => {
    // `step()` is synchronous and a cluster read is not, so the engine asks for
    // the same cluster on every frame until one of the asks lands. Measured on
    // the mounted demo before the promise cache: 400 frames issued **382**
    // reads of the 20 MB `Docks.clu` — 7.7 GB — and the docks never arrived,
    // because the read that would have satisfied a frame was always the one
    // still in flight. After: seven file reads for the whole run.
    const fixture = buildSword2Fixture([
      { name: 'general.clu', resources: [{ id: 0, bytes: sword2Header(3, 'x', 0) }] },
      { name: 'docks.clu', resources: [{ id: 20, bytes: sword2Header(5, 'y', 0) }] },
    ]);
    const inner = source(fixture);
    let reads = 0;
    const counted: DataSource = {
      label: inner.label,
      list: () => inner.list(),
      read: (name) => {
        reads++;
        return inner.read(name);
      },
    };
    const resources = await Sword2Resources.create(counted);
    await resources.loadResident();
    const before = reads;
    const answers = await Promise.all([
      resources.loadCluster('docks.clu'),
      resources.loadCluster('docks.clu'),
      resources.loadCluster('docks.clu'),
    ]);
    expect(answers).toEqual([true, true, true]);
    expect(reads - before).toBe(1);
    // And once it is resident the cache is out of the way: no read at all.
    expect(await resources.loadCluster('docks.clu')).toBe(true);
    expect(reads - before).toBe(1);
  });

  it('reads a resource by range out of a cluster bigger than two kilobytes', async () => {
    /*
     * The range this asks for was `(tableOffset + 1) << 20`, which is a
     * precedence slip for `tableOffset + (1 << 20)` and shifts a byte offset
     * rather than a megabyte. `<<` works on int32, so any cluster whose body
     * runs past 2,047 bytes wraps — and roughly half the time it wraps
     * negative, the read comes back empty, and the cluster's entry table is
     * cached as zero entries. Every resource in it is then "not shipped".
     *
     * In the mounted demo that was `General.clu` and `SCRIPTS.CLU` — two of
     * the five clusters it ships — so speech, music and the editor's audio
     * reader all answered nothing for a third of the game. The fixture below
     * is the smallest thing that reproduces it: one resource of three
     * kilobytes puts the tail index past the 2,048-byte cliff.
     */
    const payload = new Uint8Array(3000).fill(7);
    const big = buildSword2Fixture([
      {
        name: 'speech.clu',
        resources: [
          {
            id: 3,
            bytes: new Writer()
              .raw(sword2Header(Sword2FileType.WAV_FILE, 'Wav line', payload.length))
              .raw(payload)
              .done(),
          },
        ],
      },
    ]);
    const resources = await Sword2Resources.create(source(big));
    const loaded = await resources.loadStreamed(3);
    expect(loaded?.header.name).toBe('Wav line');
    expect(loaded?.payload.length).toBe(payload.length);
    // And the entry table it read on the way is usable afterwards, rather than
    // cached empty — `locate` is what the audio listing asks.
    expect(resources.locate(3)?.length).toBe(payload.length + RES_HEADER_SIZE);
  });

  it('refuses a cluster whose tail index is not whole pairs', async () => {
    const broken = buildSword2Fixture([
      { name: 'general.clu', resources: [{ id: 0, bytes: sword2Header(3, 'x', 0) }] },
    ]);
    const bytes = broken.clusters.get('general.clu') as Uint8Array;
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', broken.inf],
      ['resource.tab', broken.tab],
      ['cd.inf', broken.cdInf],
      // Lop three bytes off the tail so the index is no longer pairs of words.
      ['general.clu', bytes.subarray(0, bytes.length - 3)],
    ];
    const resources = await Sword2Resources.create(new MemoryDataSource('short', entries));
    await expect(resources.loadCluster('general.clu', true)).rejects.toThrow(/truncated/);
  });
});

describe('Broken Sword II text modules', () => {
  it('addresses a line from the resource’s start, not from its payload', () => {
    // ScummVM's `fetchTextLine` is `file + READ_LE_UINT32(file +
    // ResHeader::size() + 4 + 4 * line)`, and `file` is the resource with its
    // 44-byte header on the front. Reading the same offsets against the
    // payload lands 44 bytes late in every line: the demo's first subtitle
    // came back as "0I was sure Titipoco wasn't pointing at that barrel."
    // instead of "The barrel contained cool refreshing water.", and the wav id
    // in front of it came back as two bytes of the previous sentence.
    const resource = buildSword2Text(['The barrel contained cool refreshing water.', 'Again']);
    expect(readSword2Text(resource)).toEqual([
      'The barrel contained cool refreshing water.',
      'Again',
    ]);
    // The offsets really are resource-relative, so the fixture is not agreeing
    // with a reader that is wrong in the same direction.
    const view = new DataView(resource.buffer, resource.byteOffset, resource.byteLength);
    expect(view.getUint32(SWORD2_RES_HEADER_SIZE + 4, true)).toBe(SWORD2_RES_HEADER_SIZE + 12);
  });

  it('keeps the wav id each line names, which is what fnISpeak plays', () => {
    const resource = buildSword2Text(['first', 'second'], [3887, 3888]);
    expect(readSword2TextEntries(resource)).toEqual([
      { text: 'first', wavId: 3887 },
      { text: 'second', wavId: 3888 },
    ]);
  });
});
