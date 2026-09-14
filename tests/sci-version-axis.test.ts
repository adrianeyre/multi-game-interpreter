/**
 * #214's answers, pinned.
 *
 * This file is not testing behaviour — there is barely any yet. It is testing
 * that the two things #214 established stay established: the shape of the
 * Version axis, and ADR 0017's verdict. Both are the kind of fact that gets
 * quietly widened by a later change and then never re-checked, and both are
 * indexed off by every other SCI issue.
 */

import { describe, expect, it } from 'vitest';

import {
  KERNEL_TABLE_SHAPE,
  SCI3_ENCODING_EVIDENCE,
  SCI_VERSIONS,
  atLeast,
  before,
  describeSciVersion,
  editableVersionGap,
  isSci16,
  type SciVersion,
} from '../src/engine/sci/sciVersion.js';
import { probeViewRecord } from '../src/engine/sci/resource/sciProbes.js';
import { VERSION_GATES, versionsDecodeIdentically } from '../src/engine/sci/script/kernel.js';
import { selectorTableFor } from '../src/engine/sci/script/selectors.js';
import type { SciResources } from '../src/engine/sci/resource/SciResources.js';

describe('the Version axis, against ScummVM SciVersion', () => {
  it('has the thirteen Versions the enum declares, in its order', () => {
    expect(SCI_VERSIONS).toEqual([
      'sci0-early',
      'sci0-late',
      'sci01',
      'sci1-ega-only',
      'sci1-early',
      'sci1-middle',
      'sci1-late',
      'sci1-1',
      'sci2',
      'sci2-1-early',
      'sci2-1-middle',
      'sci2-1-late',
      'sci3',
    ]);
  });

  /**
   * `CONTEXT.md` is firm that a bare bucket names three Versions, so nothing
   * may be spelled as one — least of all a value a Target is tagged with.
   */
  it('never spells a catalogue bucket as though it were a Version', () => {
    for (const version of SCI_VERSIONS) {
      expect(version).not.toBe('sci1');
      expect(version).not.toBe('sci2-1');
    }
    expect(describeSciVersion('sci1-late')).toBe('SCI1 late');
    expect(describeSciVersion('sci1-1')).toBe('SCI1.1');
    expect(describeSciVersion('sci2-1-middle')).toBe('SCI2.1 middle');
  });

  it('orders comparably, which is what a probe narrowing to "or later" needs', () => {
    expect(atLeast('sci1-late', 'sci1-middle')).toBe(true);
    expect(atLeast('sci1-middle', 'sci1-late')).toBe(false);
    expect(before('sci1-1', 'sci2')).toBe(true);
    expect(before('sci2', 'sci2')).toBe(false);
  });

  /** ADR 0015's split, as a predicate rather than a stored flag. */
  it('puts the renderer boundary between SCI1.1 and SCI2', () => {
    const sci16: SciVersion[] = SCI_VERSIONS.filter(isSci16);
    expect(sci16).toContain('sci1-1');
    expect(sci16).not.toContain('sci2');
    expect(sci16.length).toBe(8);
  });
});

describe("ADR 0017's tripwire, as #214 left it", () => {
  it('records the assumption as confirmed rather than as still open', () => {
    expect(SCI3_ENCODING_EVIDENCE.lengthStillFromLowBit).toBe(true);
    expect(SCI3_ENCODING_EVIDENCE.operandsChangingKind).toBe(0);
    expect(SCI3_ENCODING_EVIDENCE.verdict).toMatch(/confirmed/);
  });

  /**
   * The tripwire has a number on it: SCI3's delta against the v6→v8 one. That
   * comparison is only meaningful while the v8 table is still what it was
   * measured against, so this reads it rather than restating it.
   */
  it('keeps SCI3s delta an order of magnitude under the v6-to-v8 one', async () => {
    const { readFileSync } = await import('node:fs');
    const v8 = readFileSync('src/engine/script/v8/ScriptEngine.ts', 'utf8');
    const renumbered = [...v8.matchAll(/^ {2}\[0x[0-9a-f]{2}, 0x[0-9a-f]{2}\],$/gm)].length;

    expect(renumbered).toBeGreaterThan(100);
    expect(SCI3_ENCODING_EVIDENCE.opcodesChangingMeaning).toBeLessThan(renumbered / 10);
  });
});

describe('the Kernel table, sized rather than written (#214)', () => {
  /**
   * The reason a SCI Target names a Version is that this table is not in the
   * game. So "how many tables are there" is the question that decides whether
   * thirteen Versions is affordable, and the answer is three.
   */
  it('is three tables across thirteen Versions, not thirteen', () => {
    expect(KERNEL_TABLE_SHAPE.sci16.slots).toBe(139);
    expect(KERNEL_TABLE_SHAPE.sci2.slots).toBe(160);
    expect(KERNEL_TABLE_SHAPE.sci21.slots).toBe(162);
    expect(KERNEL_TABLE_SHAPE.entriesAreRanged).toBe(true);
  });

  it("puts SCI3's whole Kernel delta at eleven slots inside SCI2.1's table", () => {
    expect(KERNEL_TABLE_SHAPE.sci21.sci3Delta).toBe(11);
  });
});

describe("SCI1's three Versions, and the probes that tell them apart (#223)", () => {
  /**
   * ADR 0016 is explicit that the catalogue's six names are buckets, and #223
   * is the hardest case: `RESOURCE.MAP`'s own structure separates SCI1 from
   * SCI1.1 and from SCI0 and **cannot** separate SCI1 early from middle from
   * late. Left there, most SCI1 games land on `guess` and are refused for
   * editing, which guts the point of supporting them.
   *
   * Checked against the demos rather than asserted: of thirteen SCI0 and SCI1
   * demos, eleven are now identified by probe rather than by guess —
   * Conquests of the Longbow as SCI1 middle, Police Quest 3 and Mixed Up Fairy
   * Tales as SCI1 late, the Christmas Card 1990 VGA card and Leisure Suit
   * Larry 1 as SCI1 early.
   */
  it('carries all four SCI1 Versions on the axis', () => {
    for (const version of ['sci1-ega-only', 'sci1-early', 'sci1-middle', 'sci1-late'] as const) {
      expect(SCI_VERSIONS).toContain(version);
    }
  });

  it('never writes a bare SCI1, which names three of them', () => {
    expect(describeSciVersion('sci1-early')).toBe('SCI1 early');
    expect(describeSciVersion('sci1-middle')).toBe('SCI1 middle');
    expect(describeSciVersion('sci1-late')).toBe('SCI1 late');
    expect(describeSciVersion('sci1-ega-only')).toBe('SCI1 EGA-only');
  });

  /**
   * ADR 0020 asks for the count of Versions that play but cannot be edited to
   * be published rather than discovered in the editor. It is a property of the
   * probes, so it is asserted where the probes are.
   */
  it('publishes which Versions a probe can reach on its own', async () => {
    const { VERSIONS_FOR_MAP } = await import('../src/engine/sci/resource/sciDetect.js');

    // The map alone decides these outright.
    expect(VERSIONS_FOR_MAP['sci1-middle']).toEqual(['sci1-middle']);
    expect(VERSIONS_FOR_MAP['sci1-late']).toEqual(['sci1-late']);
    expect(VERSIONS_FOR_MAP.sci11).toEqual(['sci1-1']);
    // And these are the buckets the probes have to narrow.
    expect(VERSIONS_FOR_MAP['sci0-sci1-early'].length).toBeGreaterThan(1);
    expect(VERSIONS_FOR_MAP.sci2.length).toBeGreaterThan(1);
  });
});

describe('the View cel record, which moves once inside SCI32 (#228)', () => {
  /** A V56 View header: the three fields `isV56` and this probe agree on. */
  function view(headerSize: number, celSize: number): Uint8Array {
    const bytes = new Uint8Array(64);
    bytes[0] = headerSize & 0xff;
    bytes[1] = headerSize >> 8;
    bytes[2] = 1; // one loop
    bytes[12] = 16; // loop record size
    bytes[13] = celSize;
    return bytes;
  }

  function resourcesWith(views: Uint8Array[]): SciResources {
    return {
      list: (type: string) => (type === 'view' ? views.map((_, index) => index) : []),
      read: async (_type: string, number: number) => views[number],
    } as unknown as SciResources;
  }

  it('takes one 52-byte record as proof, whatever else the game ships', async () => {
    // Lighthouse and RAMA ship both widths. A later engine loads older artwork
    // happily; an earlier one cannot load a shape that did not exist yet — so
    // the evidence is asymmetric and the probe has to be too.
    const probe = await probeViewRecord(resourcesWith([view(16, 36), view(16, 36), view(18, 52)]));

    expect(probe.narrowedTo).toEqual(['sci2-1-middle', 'sci2-1-late', 'sci3']);
    expect(probe.evidence).toContain('one is proof');
  });

  it('reads all-36 as predating SCI2.1 middle, where King\u2019s Quest VII sits', async () => {
    const probe = await probeViewRecord(resourcesWith([view(16, 36), view(16, 36)]));
    expect(probe.narrowedTo).toEqual(['sci1-1', 'sci2', 'sci2-1-early']);
  });

  it('says nothing about a game with no V56 Views at all', async () => {
    // A SCI0 View opens with a loop count, not a header size. Reading a cel
    // record size out of its loop table would answer confidently and wrongly.
    const ega = new Uint8Array(64);
    ega[0] = 4;
    const probe = await probeViewRecord(resourcesWith([ega]));
    expect(probe.narrowedTo).toEqual([]);
  });
});

describe('the gap between what plays and what may be edited (ADR 0020)', () => {
  it('publishes the number rather than leaving it to be discovered', () => {
    const gap = editableVersionGap([
      { id: 'kq6', version: 'sci1-1', identification: 'probe' },
      { id: 'torin', version: 'sci2-1-middle', identification: 'guess' },
      { id: 'lighthouse', version: 'sci3', identification: 'probe' },
    ]);

    expect(gap.playOnly).toEqual([{ id: 'torin', version: 'sci2-1-middle' }]);
    expect(gap.summary).toContain('2 of 3 games identified by probe');
    expect(gap.summary).toContain('refused for editing');
  });
});

describe("Sierra's own Selector numbering, which a game may not ship", () => {
  /**
   * **`play` is 42 in every SCI16 game that ships its own table.**
   *
   * Measured across the seven demos with a `vocab.997`, spanning SCI0 early,
   * SCI0 late, SCI01, SCI1 middle and SCI1 late: Space Quest III, Castle of Dr.
   * Brain, King's Quest I, Police Quest 3, Conquests of the Longbow, Leisure
   * Suit Larry 2 and the Christmas Card 1988. `doit` is 60 and `number` 43 in
   * all seven too.
   *
   * That matters because four demos ship **no** `vocab.997` at all — EcoQuest,
   * Quest for Glory III, Island of Dr. Brain and Torin's Passage — and boot
   * needs `play` by name. Their fallback numbering was a suspect for why they
   * find no `play` on the game object; this rules it out. The number is right
   * and the game object's class chain genuinely does not answer it.
   *
   * Pinned as a test because it is the kind of fact that gets re-derived by
   * whoever next wonders, and because a fallback table drifting away from it
   * would break exactly those four games and nothing else.
   */
  it('puts play at 42 and doit at 60, which the fallback must keep', () => {
    const { table, fromGame } = selectorTableFor(null);

    expect(fromGame).toBe(false);
    expect(table.numbers.get('play')).toBe(42);
    expect(table.numbers.get('doit')).toBe(60);
    expect(table.numbers.get('number')).toBe(43);
  });
});

describe('Versions that decode identically may be edited', () => {
  /**
   * ADR 0013 refuses an edit on a guessed Version because decoding with the
   * wrong Kernel table writes a misreading back byte for byte. Where the
   * Versions still standing decode *identically* there is no misreading to
   * write — and for the SCI2.1 middle/late seam the refusal would otherwise be
   * permanent, because `sciVersion.ts` says of it that nothing structural this
   * project reads moves there. A seam that is not in the data cannot be found
   * by a probe of the data.
   *
   * This pins the pairs that hold today. It is the tripwire: a Version delta
   * landing on any gate splits a pair, this fails, and somebody looks.
   */
  it('pins exactly which pairs are interchangeable', () => {
    const pairs: string[] = [];
    for (let i = 0; i < SCI_VERSIONS.length; i++) {
      for (let j = i + 1; j < SCI_VERSIONS.length; j++) {
        if (versionsDecodeIdentically([SCI_VERSIONS[i], SCI_VERSIONS[j]])) {
          pairs.push(`${SCI_VERSIONS[i]} == ${SCI_VERSIONS[j]}`);
        }
      }
    }
    expect(pairs).toEqual([
      // SCI1's three early tiers share a Kernel table outright.
      'sci1-ega-only == sci1-early',
      'sci1-ega-only == sci1-middle',
      'sci1-early == sci1-middle',
      // And SCI2.1's three, which is what lets King's Quest VII be edited.
      'sci2-1-early == sci2-1-middle',
      'sci2-1-early == sci2-1-late',
      'sci2-1-middle == sci2-1-late',
    ]);
  });

  /**
   * The half that is easy to lose. SCI0 late and SCI01 have the same *named*
   * Kernel calls and are **not** interchangeable, because `atLeast(version,
   * 'sci01')` gates a reader — the first draft of the fingerprint compared
   * three of the five gates and called them the same.
   */
  it('does not call two Versions the same when any reader can tell them apart', () => {
    expect(versionsDecodeIdentically(['sci0-late', 'sci01'])).toBe(false);
    expect(versionsDecodeIdentically(['sci1-1', 'sci2'])).toBe(false);
    expect(versionsDecodeIdentically(['sci2-1-late', 'sci3'])).toBe(false);
  });

  /** Every floor any reader gates on is in the fingerprint, or it is blind to it. */
  it('fingerprints every Version floor the readers actually gate on', () => {
    for (const floor of VERSION_GATES) expect(SCI_VERSIONS).toContain(floor);
    expect(new Set(VERSION_GATES).size).toBe(VERSION_GATES.length);
  });

  it('is trivially true for one Version and for none', () => {
    expect(versionsDecodeIdentically([])).toBe(true);
    expect(versionsDecodeIdentically(['sci2-1-middle'])).toBe(true);
  });
});
