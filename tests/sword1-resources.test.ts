import { describe, expect, it } from 'vitest';
import {
  allResourceIds,
  clusterOf,
  formatResourceId,
  groupOf,
  indexOf,
  locateResource,
  parseRif,
  resourceId,
  RifError,
} from '../src/engine/sword1/resource/rif.js';
import {
  SwordResources,
  SwordResourceError,
} from '../src/engine/sword1/resource/SwordResources.js';
import { MemoryDataSource, type DataSource } from '../src/engine/resource/DataSource.js';
import { buildSwordFixture, swordHeader, Writer } from './fixtureSword.js';

function source(
  fixture: ReturnType<typeof buildSwordFixture>,
  extra: Array<[string, Uint8Array]> = [],
) {
  const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
  for (const [label, bytes] of fixture.clusters) entries.push([`clusters/${label}.CLU`, bytes]);
  return new MemoryDataSource('fixture', [...entries, ...extra]);
}

const MINIMAL = [
  {
    label: 'COMPACTS',
    groups: 2,
    resources: [{ group: 1, index: 0, bytes: new Uint8Array([1, 2, 3, 4]) }],
  },
  {
    label: 'GENERAL',
    groups: 1,
    resources: [{ group: 0, index: 0, bytes: new Uint8Array([9, 9]) }],
  },
  {
    label: 'SCRIPTS',
    groups: 1,
    resources: [{ group: 0, index: 0, bytes: new Uint8Array([7]) }],
  },
];

describe('the resource id', () => {
  it('is the path: a one-based cluster, a group and an index', () => {
    const id = resourceId(2, 6, 0x1234);
    expect(clusterOf(id)).toBe(2);
    expect(groupOf(id)).toBe(6);
    expect(indexOf(id)).toBe(0x1234);
    expect(formatResourceId(id)).toBe('0x03061234');
  });

  it('never yields zero for cluster 0, which is what makes 0 an invalid id', () => {
    expect(resourceId(0, 0, 0)).toBe(0x01000000);
  });
});

describe('parsing swordres.rif', () => {
  it('reads clusters, groups and resources, and skips holes correctly', () => {
    const fixture = buildSwordFixture([
      {
        label: 'MAPS',
        groups: 3,
        // Group 1 is a hole; index 1 inside group 2 is a hole too. Both are
        // normal in a shipped index and both desynchronise a naive reader.
        resources: [
          { group: 0, index: 0, bytes: new Uint8Array([1]) },
          { group: 2, index: 0, bytes: new Uint8Array([2, 2]) },
          { group: 2, index: 2, bytes: new Uint8Array([3, 3, 3]) },
        ],
      },
    ]);
    const index = parseRif(fixture.rif);
    expect(index.clusters).toHaveLength(1);
    expect(index.resourceCount).toBe(3);

    const groups = index.clusters[0].groups;
    expect(groups.map((group) => group.group)).toEqual([0, 2]);
    // The declared count includes the hole; the resources list does not.
    expect(groups[1].declared).toBe(3);
    expect(groups[1].resources.map((resource) => resource.index)).toEqual([0, 2]);
  });

  it('locates a resource at the offset and length the index recorded', () => {
    const fixture = buildSwordFixture([
      {
        label: 'TEXT',
        groups: 1,
        resources: [
          { group: 0, index: 0, bytes: new Uint8Array([1, 1, 1, 1]) },
          { group: 0, index: 1, bytes: new Uint8Array([2, 2]) },
        ],
      },
    ]);
    const index = parseRif(fixture.rif);
    const found = locateResource(index, resourceId(0, 0, 1));
    expect(found?.resource).toEqual({ index: 1, offset: 4, length: 2 });
  });

  it('lists every id ascending, for a sweep', () => {
    const fixture = buildSwordFixture(MINIMAL);
    const ids = allResourceIds(parseRif(fixture.rif));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(ids).toHaveLength(3);
  });

  it('refuses a file that is not an index rather than inventing clusters', () => {
    const notAnIndex = new Uint8Array(64).fill(0xff);
    expect(() => parseRif(notAnIndex)).toThrow(RifError);
  });

  it('refuses an index that ends mid-table', () => {
    const fixture = buildSwordFixture(MINIMAL);
    expect(() => parseRif(fixture.rif.subarray(0, 24))).toThrow(/ends after/);
  });

  it('refuses an index whose clusters are all absent', () => {
    // Two clusters declared, both marked missing: a valid shape with no game.
    const rif = new Writer().u32(2).u32(0).u32(0).done();
    expect(() => parseRif(rif)).toThrow(/none of them is present/);
  });
});

describe('the resource manager', () => {
  it('refuses a folder with no index, by name', async () => {
    const bare = new MemoryDataSource('bare', [['general.clu', new Uint8Array([1])]]);
    await expect(SwordResources.create(bare)).rejects.toThrow(/No swordres\.rif/);
  });

  it('refuses a folder missing a cluster the game cannot start without', async () => {
    const fixture = buildSwordFixture(MINIMAL);
    const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
    // Deliberately drop SCRIPTS, which ScummVM flags as needed immediately.
    for (const [label, bytes] of fixture.clusters) {
      if (label !== 'SCRIPTS') entries.push([`clusters/${label}.CLU`, bytes]);
    }
    await expect(SwordResources.create(new MemoryDataSource('partial', entries))).rejects.toThrow(
      /SCRIPTS/,
    );
  });

  it('reads a resource once its cluster is resident, and says so when it is not', async () => {
    const fixture = buildSwordFixture([
      ...MINIMAL,
      {
        label: 'PARIS1',
        groups: 1,
        resources: [{ group: 0, index: 0, bytes: swordHeader('File', 4) }],
      },
    ]);
    const resources = await SwordResources.create(source(fixture));
    await resources.loadResident();

    const parisId = fixture.ids.get('PARIS1:0:0');
    expect(parisId).toBeDefined();
    // PARIS1 is a section cluster, so it is not resident and the fetch reports
    // rather than throwing — which is the contract the logic path relies on.
    expect(resources.fetch(parisId as number)).toBeNull();
    expect(resources.describeMissingResource(parisId as number)).toMatch(/not resident/);

    expect(await resources.satisfyWanted()).toBe(1);
    expect(resources.fetch(parisId as number)).not.toBeNull();
  });

  it('names which step of a resource id’s path failed, not one reason for all three', async () => {
    // A resource id is a path — cluster, then group, then index — so "not in
    // swordres.rif" has three meanings that call for three different actions.
    // This used to be one sentence offering one reason, "a localised build has
    // six subtitle groups where another has seven", which is true of the TEXT
    // cluster's language groups and is not what happened to, say, the Czech
    // game font: `GENERAL` is there, its group 0 is there, and index 4 is not.
    const fixture = buildSwordFixture([
      MINIMAL[0],
      // A GENERAL resource with a real 20-byte header, so the last assertion
      // below can prove the fetch succeeds rather than only that the message
      // changed.
      {
        label: 'GENERAL',
        groups: 1,
        resources: [{ group: 0, index: 0, bytes: swordHeader('Sprit', 0) }],
      },
      MINIMAL[2],
    ]);
    const resources = await SwordResources.create(source(fixture));

    // A cluster the index does not list: the id is wrong.
    expect(resources.describeMissingResource(resourceId(9, 0, 0))).toMatch(
      /names cluster 10, and swordres\.rif lists 3 clusters \(COMPACTS, GENERAL, SCRIPTS\)/,
    );
    // A group the cluster does not have.
    expect(resources.describeMissingResource(resourceId(0, 7, 0))).toMatch(
      /names group 7 of COMPACTS, which has 1 group with anything in it \(1\)/,
    );
    // An index past the end of a group that does exist — which is the Czech
    // game font's case, and the one the old message described wrongly.
    expect(resources.describeMissingResource(resourceId(1, 0, 4))).toMatch(
      /names index 4 of GENERAL group 0, which declares 1 slot and has 1 of them filled/,
    );
    expect(resources.describeMissingResource(resourceId(1, 0, 4))).not.toMatch(/subtitle groups/);

    // And a resource that is present is not described as "not resident yet".
    await resources.loadResident();
    const id = fixture.ids.get('GENERAL:0:0') as number;
    expect(resources.fetch(id)).not.toBeNull();
    expect(resources.describeMissingResource(id)).toMatch(/is not missing/);
  });

  it('refuses a resource whose offset runs past its cluster', async () => {
    const fixture = buildSwordFixture(MINIMAL);
    // Truncate GENERAL so its one resource no longer fits.
    const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
    for (const [label, bytes] of fixture.clusters) {
      entries.push([`clusters/${label}.CLU`, label === 'GENERAL' ? bytes.subarray(0, 1) : bytes]);
    }
    const resources = await SwordResources.create(new MemoryDataSource('short', entries));
    await resources.loadResident();
    const id = fixture.ids.get('GENERAL:0:0') as number;
    expect(() => resources.fetch(id)).toThrow(SwordResourceError);
  });

  it('reads a section cluster once when the same frame asks for it twice', async () => {
    // `step()` is synchronous and a cluster read is not, so the engine asks for
    // the same cluster on every frame until one of the asks lands, and without
    // a promise cache each ask starts another read. Measured on the mounted
    // Broken Sword II demo, where the same seam had the same bug: 400 frames
    // issued 382 reads of a 20 MB cluster and the room never arrived. Sword1's
    // clusters are smaller, so the symptom there is cost rather than a black
    // screen — which is why it needs a test and not a screenshot.
    const fixture = buildSwordFixture([
      ...MINIMAL,
      {
        label: 'PARIS1',
        groups: 1,
        resources: [{ group: 0, index: 0, bytes: new Uint8Array([4, 4]) }],
      },
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
    const resources = await SwordResources.create(counted);
    await resources.loadResident();
    const before = reads;
    const answers = await Promise.all([
      resources.loadCluster('PARIS1'),
      resources.loadCluster('paris1'),
      resources.loadCluster('PARIS1'),
    ]);
    expect(answers).toEqual([true, true, true]);
    expect(reads - before).toBe(1);
    expect(await resources.loadCluster('PARIS1')).toBe(true);
    expect(reads - before).toBe(1);
  });

  it('reads Macintosh clusters big-endian and the index little-endian', async () => {
    const fixture = buildSwordFixture(MINIMAL);
    const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
    for (const [label, bytes] of fixture.clusters) entries.push([`clusters/${label}.CLM`, bytes]);
    const resources = await SwordResources.create(new MemoryDataSource('mac', entries));
    // The index parsed — which it could only do read little-endian — and the
    // clusters are flagged big-endian from the extension.
    expect(resources.bigEndian).toBe(true);
    expect(resources.availableClusters).toContain('GENERAL');
  });
});
