/**
 * The SCI resource layer: the map, the Volumes and the Version probes.
 *
 * Tier 1 over `fixtureSci.ts`. Worth saying what this does and does not carry:
 * the same code has been run against seventeen freely distributed Sierra
 * demos, from Christmas Card 1988 to Lighthouse, and read every one of their
 * 4,157 resources without a failure. This file's job is to keep that true in
 * CI, where none of that data can live.
 */

import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { looksLikeSci, sciLayout } from '../src/engine/sci/resource/sciDetect.js';
import { detectMapVersion } from '../src/engine/sci/resource/resourceMap.js';
import { compressionFor, decompressSci } from '../src/engine/sci/resource/sciCompression.js';
import { DCL_TABLES } from '../src/engine/sci/resource/dcl.js';
import { identifyForeignEngine } from '../src/engine/resource/engineSignatures.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { describeUneditableTarget } from '../src/authoring/target.js';
import {
  buildSci32Fixture,
  buildSci3Fixture,
  buildSci0Fixture,
  buildSci11Fixture,
} from './fixtureSci.js';

function sourceFrom(files: Map<string, Uint8Array>): MemoryDataSource {
  return new MemoryDataSource('sci fixture', files);
}

/**
 * A decoder that fills rather than failing is the same fault as a compression
 * method nobody knows, and this layer already refuses that one by name.
 */
describe('a resource that decompressed to noise', () => {
  it('is one repeated byte, and that is detectable', async () => {
    const { isOneRepeatedByteForTest } = await import('../src/engine/sci/resource/SciResources.js');
    expect(isOneRepeatedByteForTest(new Uint8Array(100).fill(0x0c))).toBe(true);
    const mixed = new Uint8Array(100).fill(0x0c);
    mixed[99] = 1;
    expect(isOneRepeatedByteForTest(mixed)).toBe(false);
  });
});

describe('recognising SCI data', () => {
  it('claims a map beside a volume, and nothing less', () => {
    expect(looksLikeSci(['RESOURCE.MAP', 'RESOURCE.001'])).toBe(true);
    expect(looksLikeSci(['RESMAP.000', 'RESSCI.000'])).toBe(true);
    // A lone map is half an extracted archive, not a game.
    expect(looksLikeSci(['RESOURCE.MAP'])).toBe(false);
    expect(looksLikeSci(['RESOURCE.001'])).toBe(false);
    expect(looksLikeSci(['MONKEY2.000', 'MONKEY2.001'])).toBe(false);
  });

  it('does not read RESOURCE.CFG or RESOURCE.MT as volume data', () => {
    const layout = sciLayout(['RESOURCE.MAP', 'RESOURCE.001', 'RESOURCE.CFG', 'RESOURCE.MT']);
    expect([...(layout?.volumes.keys() ?? [])]).toEqual([1]);
  });

  /**
   * The decision #211 took. SCI used to be refused by name here with a comment
   * saying so, and the structural half of retiring that is that the table stops
   * matching — a message that still fires would beat the router to a game that
   * now runs.
   */
  it('no longer names SCI as an engine this project refuses', () => {
    expect(identifyForeignEngine(['resource.map', 'resource.001'])).toBeNull();
  });
});

describe('a SCI0 game', () => {
  it('reads its flat map and every resource in it', async () => {
    const fixture = buildSci0Fixture();
    const { game, resources } = await detectSciGame(sourceFrom(fixture.files));

    expect(game.mapVersion).toBe('sci0-sci1-early');
    expect(resources.count('script')).toBe(1);
    expect(resources.count('vocab')).toBe(1);

    for (const spec of fixture.resources) {
      const bytes = await resources.read(spec.type, spec.number);
      expect([...(bytes ?? [])]).toEqual(spec.body);
    }
    expect(resources.unreadable).toEqual([]);
  });

  it('reads the volume number out of the top six bits of the offset', () => {
    const fixture = buildSci0Fixture();
    const map = fixture.files.get('RESOURCE.MAP')!;
    expect(detectMapVersion(map, (volume) => volume === 1)).toBe('sci0-sci1-early');
    // With volume 1 absent, the six-bit reading names a volume that is not
    // there and the four-bit reading is preferred — which is exactly the test
    // ScummVM's detectMapVersion makes, and the only thing separating the two.
    expect(detectMapVersion(map, () => false)).toBe('sci1-middle');
  });
});

describe('a SCI1.1 game', () => {
  it('reads its type directory and five-byte entries', async () => {
    const fixture = buildSci11Fixture();
    const { game, resources } = await detectSciGame(sourceFrom(fixture.files));

    expect(game.mapVersion).toBe('sci11');
    expect(game.version).toBe('sci1-1');
    // Narrowed by a probe rather than guessed, so this one may be edited.
    expect(game.identification).toBe('probe');

    for (const spec of fixture.resources) {
      const bytes = await resources.read(spec.type, spec.number);
      expect([...(bytes ?? [])]).toEqual(spec.body);
    }
  });

  it('pairs a heap with every script, which is what the probe reads', async () => {
    const { resources } = await detectSciGame(sourceFrom(buildSci11Fixture().files));
    expect(resources.hasHeaps).toBe(true);
    expect(resources.count('heap')).toBe(resources.count('script'));
  });
});

describe('compression methods', () => {
  /**
   * A hang, not a wrong answer — and the probe that found it reads resources
   * under the *wrong* codec on purpose, so this path is exercised for half of
   * every game detected.
   *
   * A Huffman node whose high nibble is zero steps to itself. Nothing advances,
   * the bit reader runs dry, an exhausted reader answers zero to every
   * question, and the loop takes that branch forever. Castle of Dr. Brain's
   * demo carries one such resource, and before this the whole detector hung on
   * that game rather than identifying it.
   */
  it('refuses a Huffman node that steps nowhere, rather than looping on it', () => {
    // One node, whose branch byte has a zero high nibble and a non-zero low
    // one: taking the zero bit steps by zero, forever.
    const packed = new Uint8Array([1, 0xff, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);

    expect(() => decompressSci('huffman', packed, 64)).toThrow(/not a tree/);
  });

  it('refuses a Huffman code that runs past the end of its bit stream', () => {
    // A tree that keeps stepping legitimately still has to stop when the bits
    // it is reading are no longer in the resource.
    const packed = new Uint8Array([3, 0xff, 0x00, 0x11, 0x00, 0x11, 0x00, 0x11, 0x00]);

    expect(() => decompressSci('huffman', packed, 64)).toThrow(/Huffman/);
  });

  /**
   * The swap, which is the single most consequential Version-dependent fact in
   * the resource layer: reading it backwards yields a full-length output of
   * plausible bytes rather than an error.
   */
  it('means the opposite things at SCI0 and at SCI1', () => {
    expect(compressionFor(1, 'sci0-late')).toBe('lzw');
    expect(compressionFor(2, 'sci0-late')).toBe('huffman');
    expect(compressionFor(1, 'sci1-early')).toBe('huffman');
    expect(compressionFor(2, 'sci1-early')).toBe('lzw1');
  });

  it('reports an unknown method rather than copying the bytes through', () => {
    expect(compressionFor(99, 'sci1-1')).toBeNull();
  });

  /**
   * A canonical Huffman table is checkable in a way a transcribed tree is not:
   * the Kraft sum must be exactly one, or the code is incomplete and every
   * symbol after the gap decodes to something else. This is why `dcl.ts` holds
   * bit lengths rather than the ~670 lines of tree nodes it could have.
   */
  it('builds three complete DCL codes', () => {
    for (const [name, code] of Object.entries(DCL_TABLES)) {
      let left = 1;
      for (let length = 1; length <= 13; length++) {
        left = left * 2 - code.count[length];
        expect(left, `${name} is over-subscribed at length ${length}`).toBeGreaterThanOrEqual(0);
      }
      expect(left, `${name} is not a complete code`).toBe(0);
    }
  });
});

describe('the Version, and what may be edited on it', () => {
  it('refuses to edit a game whose Version could only be guessed (ADR 0013)', () => {
    const refusal = describeUneditableTarget({
      engine: 'sci',
      version: 'sci0-early',
      platform: 'dos',
      identification: 'guess',
    });
    expect(refusal).toMatch(/could not be narrowed past a guess/);
    expect(refusal).toMatch(/probe/);
  });

  it('allows editing a game a probe identified', () => {
    expect(
      describeUneditableTarget({
        engine: 'sci',
        version: 'sci1-1',
        platform: 'dos',
        identification: 'probe',
      }),
    ).toBeNull();
  });

  /**
   * Absent is read as a guess rather than as "nobody wrote it down, so it must
   * have been fine". SCI stamps its Version nowhere, so silence is not
   * evidence.
   */
  it('treats an unrecorded identification as a guess', () => {
    expect(
      describeUneditableTarget({ engine: 'sci', version: 'sci2', platform: 'dos' }),
    ).not.toBeNull();
  });
});

describe('the shared loader', () => {
  it('routes SCI data to the SCI engine rather than to SCUMM detection', async () => {
    const engine = await loadAdventureEngine(sourceFrom(buildSci11Fixture().files));
    expect(engine.targetName).toBe('SCI1.1');
    expect(engine.saveFormat).toBeGreaterThan(0);
    expect(engine.resolution.script).toEqual({ width: 320, height: 200 });
  });

  it('keeps a SCI16 game in one space, because both of its spaces are 320x200', async () => {
    const engine = await loadAdventureEngine(sourceFrom(buildSci0Fixture().files));
    expect(engine.resolution.display).toEqual(engine.resolution.script);
  });

  /**
   * The two spaces, which is #213's whole reason for existing and #225's
   * criterion.
   *
   * A SCI32 game runs its scripts at 320x200 and composites to 640x480. A
   * single resolution number cannot express that, and picking one silently
   * misplaces every click and every actor — the worst shape of bug here,
   * because nothing errors.
   */
  it('gives a SCI32 game a display space larger than its script space (#213, #225)', async () => {
    const engine = await loadAdventureEngine(sourceFrom(buildSci32Fixture().files));
    expect(engine.resolution.script).toEqual({ width: 320, height: 200 });
    expect(engine.resolution.display).toEqual({ width: 640, height: 480 });
  });

  /**
   * SCI2.1 and SCI3 reaching the engine at all (#228, #229).
   *
   * Tier 1 and stated as Tier 1: this is a fixture agreeing with the reader,
   * which `verifying-version-support.md` is explicit proves nothing on its own.
   * What it does establish is that the resource layer, the Version probes and
   * the PMachine are wired together for both — so a person with a real disc is
   * testing the game rather than the plumbing.
   */
  it('boots a SCI2.1 game through the SCI32 map and the SCI32 half of the axis', async () => {
    const engine = await loadAdventureEngine(sourceFrom(buildSci32Fixture().files));
    expect(engine.targetName).toBe('SCI2.1 middle');
    engine.boot();
    engine.step();
    expect(engine.hasQuit).toBe(false);
  });

  it('boots a SCI3 game, whose Script resource has no heap beside it', async () => {
    const engine = await loadAdventureEngine(sourceFrom(buildSci3Fixture().files));
    expect(engine.targetName).toBe('SCI3');
    engine.boot();
    engine.step();
    expect(engine.hasQuit).toBe(false);
  });
});

/**
 * The engine's clock, which used to be the machine's.
 *
 * `kGetTime` answered `Date.now()` since boot, divided into sixtieths. In the
 * browser that is right, because something paces the loop to real time. In a
 * headless run **nothing does**, and the clock and the cycle count come apart
 * completely: the same 480 cycles spanned about thirty seconds of game time on
 * a loaded machine and about three on an idle one, so a game that waits two
 * seconds for a room to settle had settled in one run and had not in the other.
 *
 * That is not a flaky probe. It is a clock measuring the machine rather than
 * the game, and it made every headless reading in
 * `docs/processes/verifying-version-support.md` depend on what else the
 * computer happened to be doing.
 *
 * SCI's tick is a sixtieth of a second and `ticksPerStep` is one, so a cycle
 * **is** a tick — Sierra's interpreter counted them in its own loop. Counting
 * cycles is both faithful and deterministic.
 */
describe("the engine's clock counts its own cycles", () => {
  async function booted() {
    const engine = await loadAdventureEngine(sourceFrom(buildSci32Fixture().files));
    engine.boot();
    return engine;
  }

  it('answers nought before a cycle has run, however long booting took', async () => {
    const engine = await booted();
    expect(engine.frame).toBe(0);
  });

  it('advances one tick per cycle, and not with the wall clock', async () => {
    const engine = await booted();
    for (let cycle = 0; cycle < 40; cycle++) engine.step();
    expect(engine.frame).toBe(40);

    // Wall-clock time passing on its own moves nothing, which is the whole
    // difference: a run that sleeps is not a run that advanced the game.
    const before = engine.frame;
    await new Promise((done) => setTimeout(done, 60));
    expect(engine.frame).toBe(before);
  });

  /**
   * Two engines, the same cycles, the same clock — which is what "deterministic"
   * means here and is exactly what the wall clock could not promise.
   */
  it('gives two engines the same clock for the same number of cycles', async () => {
    const first = await booted();
    for (let cycle = 0; cycle < 30; cycle++) first.step();

    // A gap between the two runs, long enough that a wall clock would notice.
    await new Promise((done) => setTimeout(done, 80));

    const second = await booted();
    for (let cycle = 0; cycle < 30; cycle++) second.step();
    expect(second.frame).toBe(first.frame);
  });
});
