/**
 * Version probes: structural tests on a game's own bytes (ADR 0020).
 *
 * SCI stamps its version nowhere. The map's structure narrows a game to one of
 * five buckets and no further, and a bucket is not a Version — so without
 * something else, most SCI games would land on `guess`, and ADR 0013 refuses to
 * edit on a guess. That would gut the point of supporting them.
 *
 * **A hash table of known releases is explicitly not the mechanism.** It cannot
 * cover fan-made games, which for SCI0 and SCI1.1 are the only free data that
 * is a whole game rather than a demo slice. A hash stays available as a
 * tiebreaker and is not what any of this rests on.
 *
 * Each probe below says what it reads and what it distinguishes. Every one of
 * them was checked against the seventeen freely distributed Sierra demos, which
 * between them cover the whole axis — the counts in each comment are from that
 * run, not from a fixture.
 */

import {
  atLeast,
  before,
  describeSciVersion,
  SCI_VERSIONS,
  type SciVersion,
} from '../sciVersion.js';
import { compressionFor, decompressSci } from './sciCompression.js';
import { decodeSciInstruction } from '../script/opcodes.js';
import { versionsDecodeIdentically } from '../script/kernel.js';
import { readSci0Blocks, sci0ScriptBias } from '../script/scriptResource.js';
import type { SciResources } from './SciResources.js';
import { readSciResourceHeader } from './SciResources.js';

/** What one probe concluded, and on what evidence. */
export interface SciProbeResult {
  /** The probe's name, for the log and for the editor's refusal message. */
  name: string;
  /** The Versions this probe leaves possible. Empty means it could not tell. */
  narrowedTo: readonly SciVersion[];
  /** What it read, in words a person can check against their own copy. */
  evidence: string;
}

/**
 * Whether a game's Script resources have a heap resource beside them.
 *
 * **Distinguishes SCI1.1 and later from everything earlier, and SCI3 from
 * SCI2.1.** SCI0 and SCI1 carry object data inline in the Script resource with
 * a relocation list; SCI1.1 through SCI2.1 split it into a code and heap pair,
 * shipping a `heap` resource per script; SCI3 folds it back in and ships none
 * again (`engines/sci/engine/script.cpp`: "In SCI1.1 - SCI2.1, the heap was in
 * a separate space from the script").
 *
 * So the test is three-way rather than two-way, and the third arm is the good
 * one: a game with a hundred scripts and no heaps is either pre-SCI1.1 or
 * SCI3, and the map structure has already told you which. Checked against the
 * demos: King's Quest VI has 44 scripts and 44 heaps, RAMA has 90 and 90, and
 * Lighthouse has 100 scripts and **no** heaps at all — which is SCI3, from the
 * data alone, with no title anywhere in the reasoning.
 */
export function probeHeapSplit(resources: SciResources): SciProbeResult {
  const scripts = resources.count('script');
  const heaps = resources.count('heap');

  if (scripts === 0) {
    return {
      name: 'heap split',
      narrowedTo: [],
      evidence: 'this game ships no Script resources, so there is nothing to pair a heap with',
    };
  }

  const evidence = `${scripts} script resources, ${heaps} heap resources`;
  if (heaps === 0) {
    return {
      name: 'heap split',
      narrowedTo: [
        'sci0-early',
        'sci0-late',
        'sci01',
        'sci1-ega-only',
        'sci1-early',
        'sci1-middle',
        'sci1-late',
        'sci3',
      ],
      evidence: `${evidence} — object data is inline, which is pre-SCI1.1 or SCI3`,
    };
  }
  return {
    name: 'heap split',
    narrowedTo: ['sci1-1', 'sci2', 'sci2-1-early', 'sci2-1-middle', 'sci2-1-late'],
    evidence: `${evidence} — the Script resource is a code and heap pair, so SCI1.1 through SCI2.1`,
  };
}

/**
 * Whether the game carries `vocab.999`, which names the Kernel calls.
 *
 * **This distinguishes nothing, and finding that out is the point.** ADR 0016
 * and `CONTEXT.md` both state that `vocab.999` names the Kernel entries "only
 * in SCI0 and SCI01" and that "from SCI1 on it is gone", and the freely
 * distributed demos contradict it in both directions: the Christmas Card 1990
 * VGA demo is SCI1 early and ships `vocab.999`, and the King's Quest I SCI demo
 * is SCI01 and does not. Used as a Version probe it put both games on the wrong
 * Version, and one of them then failed to decode 62 of its 99 resources.
 *
 * So it stays, and returns nothing to narrow with. What it is still good for is
 * the question it actually answers — whether this game can name its own Kernel
 * calls, which #217 wants for reporting an unknown Kernel number by name rather
 * than only by number.
 *
 * This is `docs/processes/verifying-version-support.md`'s warning arriving
 * exactly as advertised: the claim was plausible, it was written into an ADR,
 * and only real data disagreed with it.
 */
export function probeKernelVocab(resources: SciResources): SciProbeResult {
  const present = resources.has('vocab', 999);
  return {
    name: 'kernel vocabulary',
    narrowedTo: [],
    evidence: present
      ? 'vocab.999 is present, so an unknown Kernel number can be reported by name'
      : 'vocab.999 is absent, so Kernel calls can only be reported by number',
  };
}

/**
 * Whether any resource is stored with compression method 3 or 4.
 *
 * **Distinguishes SCI1 and later from SCI0 and SCI01**, and it replaced the
 * `vocab.999` probe above after that one was found to be wrong. Methods 3 and 4
 * are `kCompLZW1View` and `kCompLZW1Pic` — LZW followed by a pass that rebuilds
 * a View or a Picture out of the result — and they exist only in the SCI01/SCI1
 * generation of the format. A SCI0 game has no method above 2.
 *
 * Asymmetric on purpose: seeing one is proof, and not seeing one is not. An EGA
 * SCI1 game has no VGA Views to store that way, and Quest for Glory II — SCI1
 * EGA-only — indeed has none. So a negative answer narrows nothing and leaves
 * the compression-era probe to decide.
 *
 * Checked against the demos: Christmas Card 1990 has twelve of each and Leisure
 * Suit Larry 1 has seven and six, while none of the four SCI0 demos has any.
 */
export async function probeCompressionVariants(resources: SciResources): Promise<SciProbeResult> {
  let found = 0;
  for (const type of ['view', 'pic'] as const) {
    for (const number of resources.list(type).slice(0, 8)) {
      const raw = await resources.readRaw(type, number);
      if (raw && (raw.header.method === 3 || raw.header.method === 4)) found++;
    }
  }

  if (found === 0) {
    return {
      name: 'compression variants',
      narrowedTo: [],
      evidence: 'no resource uses method 3 or 4, which an EGA SCI1 game also does not',
    };
  }
  return {
    name: 'compression variants',
    narrowedTo: [
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
    ],
    evidence: `${found} resources use the View or Picture LZW variant, which SCI0 does not have`,
  };
}

/**
 * Which reading of compression methods 1 and 2 the Volumes actually decode
 * under.
 *
 * **Distinguishes SCI0 and SCI01 from SCI1 and later**, and it is the sharpest
 * probe here because it is not a proxy for anything — it tests the exact fact
 * the answer is needed for. Method number 1 means LZW at SCI0 and SCI01 and
 * Huffman from SCI1 on, and 2 the other way round
 * (`Resource::readResourceInfo`). So: take a resource stored with method 1 or
 * 2, decode it both ways, and see which one reaches its own declared unpacked
 * length.
 *
 * It works because the two codecs disagree immediately rather than gradually.
 * Huffman walks a node table the resource carries in its own first bytes, and
 * LZW data read as a node table walks outside it within a few symbols; LZW read
 * over Huffman data hits a code past the end of its dictionary. Both fail
 * loudly, which is unusual enough to be worth relying on — checked against
 * Quest for Glory II, where the wrong reading fails on 104 of 150 resources and
 * the right one on none.
 *
 * The one caveat: a game every one of whose resources is stored uncompressed
 * cannot be probed this way, and Conquests of the Longbow's demo is exactly
 * that — 97 resources, all method 0. Such a game falls through to the other
 * probes rather than being decided on a coin toss.
 */
export async function probeCompressionEra(resources: SciResources): Promise<SciProbeResult> {
  const early: readonly SciVersion[] = ['sci0-early', 'sci0-late', 'sci01'];
  const late: readonly SciVersion[] = [
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
  ];

  let tested = 0;
  let earlyWins = 0;
  let lateWins = 0;

  // Scripts first: every game has several, they are large enough to be
  // compressed, and they are the resource whose failure would matter most.
  for (const type of ['script', 'view', 'pic', 'sound'] as const) {
    for (const number of resources.list(type).slice(0, 4)) {
      const raw = await resources.readRaw(type, number);
      if (!raw) continue;
      const { header, body } = raw;
      if (header.method !== 1 && header.method !== 2) continue;
      tested++;

      for (const [candidate, win] of [
        ['sci0-early', (): number => earlyWins++],
        ['sci1-early', (): number => lateWins++],
      ] as const) {
        const method = compressionFor(header.method, candidate);
        if (!method) continue;
        try {
          decompressSci(method, body, header.unpacked);
          win();
        } catch {
          // A failure is the signal, so it is the expected outcome for one of
          // the two candidates and is not logged.
        }
      }
      if (tested >= 12) break;
    }
    if (tested >= 12) break;
  }

  if (tested === 0) {
    return {
      name: 'compression era',
      narrowedTo: [],
      evidence: 'no resource is stored with method 1 or 2, so there is nothing to decide on',
    };
  }
  // A margin rather than exclusivity. The wrong codec usually fails loudly and
  // occasionally does not — Huffman read over LZW data walked its node table
  // successfully for six of the Christmas Card 1990 demo's sixty-eight
  // resources — so "one success for the wrong reading" is not evidence, and
  // demanding zero of them made the probe give up on a game it could decide.
  // Twice as many is the threshold, which the demos clear by an order of
  // magnitude in every direction.
  const decisive = 2;
  if (earlyWins >= lateWins * decisive && earlyWins > 0) {
    return {
      name: 'compression era',
      narrowedTo: early,
      evidence: `${earlyWins} of ${tested} resources decode under SCI0's reading of methods 1 and 2, against ${lateWins} under SCI1's`,
    };
  }
  if (lateWins >= earlyWins * decisive && lateWins > 0) {
    return {
      name: 'compression era',
      narrowedTo: late,
      evidence: `${lateWins} of ${tested} resources decode under SCI1's reading of methods 1 and 2, against ${earlyWins} under SCI0's`,
    };
  }
  return {
    name: 'compression era',
    narrowedTo: [],
    evidence: `${tested} resources decode ${earlyWins} to ${lateWins} between the two readings, which is too close to decide on`,
  };
}

/**
 * Whether the game ships resource types that only exist from SCI1.1.
 *
 * **Distinguishes SCI1.1 and later from SCI1 and earlier**, and confirms the
 * heap probe from a different direction. `message` and `audio36`/`sync36` are
 * SCI1.1's move of displayable text out of the Script resource and into its own
 * resource keyed by a tuple — the same move SCUMM v7 made, which ADR 0009 ruled
 * on. A SCI0 game has none of them because its text is inline.
 *
 * Weaker than the heap probe on its own: a SCI1.1 game with no dialogue ships
 * no `message` resources either. So a positive answer narrows and a negative
 * one does not, which is why it returns the wide set rather than the early one.
 */
export function probeMessageResources(resources: SciResources): SciProbeResult {
  const messages = resources.count('message');
  const audio36 = resources.count('audio36');

  if (messages === 0 && audio36 === 0) {
    return {
      name: 'message resources',
      narrowedTo: [],
      evidence: 'no MESSAGE or audio36 resources, which a SCI1.1 game without dialogue also has',
    };
  }
  return {
    name: 'message resources',
    narrowedTo: ['sci1-1', 'sci2', 'sci2-1-early', 'sci2-1-middle', 'sci2-1-late', 'sci3'],
    evidence: `${messages} MESSAGE and ${audio36} audio36 resources, so text has left the Script resource`,
  };
}

/**
 * Whether the game's Script resources open with a two-byte header.
 *
 * **Distinguishes SCI0 early from everything later**, and it is the probe with
 * the cleanest evidence in the family: a SCI0 early script's block chain starts
 * two bytes in, and read from zero it produces *no blocks at all*. There is no
 * false positive — a script with no header read without one yields nothing
 * rather than something wrong — which is unusual enough to be worth saying.
 *
 * ScummVM refers to this as "the old script header" in `op_callk`'s
 * `SCI_VERSION_0_EARLY` branch without describing it. The Christmas Card 1988
 * demo is why this project knows it exists: it produced no code blocks while
 * every other SCI0 demo produced eighty to a hundred and fifty (#217).
 */
export async function probeScriptHeader(resources: SciResources): Promise<SciProbeResult> {
  let biased = 0;
  let plain = 0;

  for (const number of resources.list('script').slice(0, 6)) {
    const bytes = await resources.read('script', number);
    if (!bytes) continue;
    const bias = sci0ScriptBias(bytes);
    if (bias === 2) biased++;
    else if (readSci0Blocks(bytes, 0).length > 0) plain++;
  }

  if (biased === 0 && plain === 0) {
    return {
      name: 'script header',
      narrowedTo: [],
      evidence: 'no Script resource parsed as a block chain, so this is a heap or SCI3 layout',
    };
  }
  if (biased > plain) {
    return {
      name: 'script header',
      narrowedTo: ['sci0-early'],
      evidence: `${biased} of ${biased + plain} scripts open with the two-byte header SCI0 early uses`,
    };
  }
  // Everything except SCI0 early, which is the whole of what this proves. It is
  // tempting to stop the list at SCI1 late, because a SCI1.1 script has no
  // block chain to parse — but "a script that parses as a block chain" rules
  // out one Version and no more, and listing fewer made this probe contradict
  // the heap-split one on any game where both had something to say.
  return {
    name: 'script header',
    narrowedTo: SCI_VERSIONS.filter((version) => version !== 'sci0-early'),
    evidence: `${plain} scripts start their block chain at zero, so this is not SCI0 early`,
  };
}

/**
 * Whether any script calls a Kernel number above SCI0's own table.
 *
 * **Distinguishes SCI01 and later from SCI0.** SCI0's table ends at `0x6d`
 * (`Joystick`) — ScummVM marks the line "End of kernel function table for
 * SCI0" — so a `callk` above it is a call SCI0 has no entry for. The static
 * sweep found this on the first game it was pointed at: the King's Quest I SCI
 * demo, which is SCI01, makes two calls to `0x74`.
 *
 * Asymmetric, as several of these are: seeing one is proof, and not seeing one
 * is not, because a small game may simply never call that far up the table.
 */
export async function probeKernelRange(resources: SciResources): Promise<SciProbeResult> {
  let highest = -1;

  // **Every script, not a sample.** This probe is looking for the *highest*
  // Kernel number a game calls, and a maximum is not a thing a sample finds:
  // King's Quest I's SCI demo calls `FileIO` at 0x74 exactly twice, in scripts
  // past the first twelve, and reading only twelve put an SCI01 game on SCI0
  // late — where those two calls then reported themselves as unknown Kernel
  // numbers, which is how this was found. The full pass costs milliseconds; the
  // static sweep decodes a million instructions across 25 games in about a
  // minute.
  for (const number of resources.list('script')) {
    const bytes = await resources.read('script', number);
    if (!bytes) continue;
    const bias = sci0ScriptBias(bytes);
    for (const block of readSci0Blocks(bytes, bias)) {
      if (block.type !== 'code') continue;
      let at = block.offset;
      const end = block.offset + block.size;
      while (at < end) {
        const instruction = decodeSciInstruction(bytes, at);
        if (!instruction || at + instruction.length > end) break;
        if (instruction.name === 'callk') highest = Math.max(highest, instruction.operands[0]);
        at += instruction.length;
      }
    }
  }

  if (highest <= SCI0_LAST_KERNEL) {
    return {
      name: 'kernel range',
      narrowedTo: [],
      evidence:
        highest < 0
          ? 'no Kernel call was found to read a number from'
          : `the highest Kernel number called is 0x${highest.toString(16)}, which SCI0 has`,
    };
  }
  return {
    name: 'kernel range',
    narrowedTo: [
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
    ],
    evidence: `a script calls Kernel 0x${highest.toString(16)}, past SCI0's table, which ends at 0x6d`,
  };
}

/** The last entry in SCI0's own Kernel table. */
const SCI0_LAST_KERNEL = 0x6d;

/**
 * Whether the game draws in sixteen colours or two hundred and fifty-six.
 *
 * **Distinguishes SCI1 EGA-only from SCI1 early and later**, which is the seam
 * ADR 0016 says exists for Quest for Glory II and nothing else. A VGA game
 * ships `palette` resources; an EGA one has none, because sixteen colours are
 * the hardware's and there is nothing to ship.
 *
 * Asymmetric again: a palette is proof of VGA, and its absence is proof of
 * nothing on its own — which is why this narrows *away* from EGA-only rather
 * than towards it, and why Quest for Glory II is identified by this probe
 * combining with the compression-era one rather than by this alone.
 */
export function probeColourDepth(resources: SciResources): SciProbeResult {
  const palettes = resources.count('palette');
  if (palettes === 0) {
    return {
      name: 'colour depth',
      narrowedTo: [],
      evidence: 'no palette resources, which an EGA game and a small VGA one both have',
    };
  }
  return {
    name: 'colour depth',
    narrowedTo: [
      'sci1-early',
      'sci1-middle',
      'sci1-late',
      'sci1-1',
      'sci2',
      'sci2-1-early',
      'sci2-1-middle',
      'sci2-1-late',
      'sci3',
    ],
    evidence: `${palettes} palette resources, so this game draws in 256 colours rather than EGA's 16`,
  };
}

/**
 * How wide a View's cel record is, which moves once inside SCI32.
 *
 * **Distinguishes SCI2.1 middle and later from everything earlier**, and it is
 * the probe that stopped six SCI32 demos landing on a bare `sci2` guess.
 *
 * A V56 View holds its cel records end to end at a size the header declares.
 * That size is 36 bytes from SCI1.1 through SCI2.1 early, and 52 from SCI2.1
 * middle on — the later record carries the scaling fields, and the header grows
 * from 16 bytes to 18 at the same seam to make room for the declared
 * resolution. Read off the game's own Views rather than from a list of titles,
 * which is ADR 0020's whole rule.
 *
 * **Any 52 decides it, and the asymmetry is deliberate.** Lighthouse and RAMA
 * ship both widths — seven Views at 52 and three at 36 — because a later engine
 * happily loads artwork in the older shape, while an earlier one cannot load a
 * shape that did not exist when it was built. So one wide record is proof and a
 * hundred narrow ones are not.
 *
 * Checked against every SCI32 demo this project has: Torin's Passage at 52
 * throughout, Lighthouse, RAMA and Leisure Suit Larry 7 mixed, and King's Quest
 * VII and Space Quest 6 at 36 throughout — which is exactly the SCI2.1
 * early/middle line ADR 0016 draws.
 */
export async function probeViewRecord(resources: SciResources): Promise<SciProbeResult> {
  const WIDE_CEL_RECORD = 52;
  const NARROW_CEL_RECORD = 36;
  let wide = 0;
  let narrow = 0;

  for (const number of resources.list('view').slice(0, 16)) {
    const bytes = await resources.read('view', number);
    if (!bytes || bytes.length < 16) continue;
    // The same three fields `isV56` agrees on, because a View in an older shape
    // has no cel-record size to read and guessing one out of its loop table is
    // how this probe would answer confidently about a SCI0 game.
    const headerSize = bytes[0] | (bytes[1] << 8);
    if ((headerSize !== 16 && headerSize !== 18) || bytes[12] !== 16) continue;
    if (bytes[13] === WIDE_CEL_RECORD) wide++;
    else if (bytes[13] === NARROW_CEL_RECORD) narrow++;
  }

  if (wide > 0) {
    return {
      name: 'view cel record',
      narrowedTo: ['sci2-1-middle', 'sci2-1-late', 'sci3'],
      evidence:
        `${wide} of ${wide + narrow} V56 Views carry the 52-byte cel record, which arrived at ` +
        `SCI2.1 middle — one is proof, because an earlier engine cannot load a shape that did ` +
        `not exist yet`,
    };
  }
  if (narrow > 0) {
    return {
      name: 'view cel record',
      narrowedTo: ['sci1-1', 'sci2', 'sci2-1-early'],
      evidence: `${narrow} V56 Views, all with the 36-byte cel record, so this predates SCI2.1 middle`,
    };
  }
  return {
    name: 'view cel record',
    narrowedTo: [],
    evidence: 'no V56 Views, so this game predates SCI1.1 and the record has nothing to say',
  };
}

/**
 * Which Kernel table a SCI32 game's scripts are written against.
 *
 * **Distinguishes SCI2 from SCI2.1 early, and SCI2.1 early from the rest**,
 * which is the whole of what separates those Versions — ADR 0016's axis splits
 * them because the Kernel table moves there and for no other reason.
 *
 * ScummVM's `autoDetectSci21KernelType` reads the ordinal `Sound::play` uses
 * for `kDoSound`: `0x40` is SCI2's shuffled table, which the early SCI2.1
 * titles kept, and `0x75` is the standard SCI2.1 one. This reads the same fact
 * from the same place, and from the game's own bytes rather than from a list of
 * titles — which matters more here than anywhere, because the late SCI2.1 tier
 * is separated by *which build* a release is and not by anything in the data
 * (#214), so a title list would be the only alternative and it would be wrong
 * for exactly the demos this project can test against.
 *
 * Both ordinals appearing is not a tie to be broken: it means the scan found
 * two different games' worth of scripts, or that `0x40` and `0x75` are being
 * read out of something that is not a `callk`. Reported as undecided.
 */
export async function probeSci32KernelTable(resources: SciResources): Promise<SciProbeResult> {
  const SCI2_DOSOUND = 0x40;
  const SCI21_DOSOUND = 0x75;
  /**
   * `Array` at SCI2 and a **`Dummy`** at SCI2.1, which is the strongest single
   * fact in either table: a game does not call a placeholder. So one call to it
   * settles SCI2, where the `DoSound` ordinals need six and a margin.
   *
   * It is one-directional on purpose. Its absence says nothing — a SCI2 game
   * that never builds an array never calls it — so it decides only the case it
   * can, which is the shape a probe should have (ADR 0020).
   */
  const SCI2_ARRAY = 0x82;
  /** `String` at SCI2.1, `ListAllTrue` at SCI2, and every SCI32 game uses strings. */
  const SCI21_STRING = 0x5c;
  /** `String` at SCI2. A SCI32 game that never calls its String kernel is not one. */
  const SCI2_STRING = 0x83;
  let sci2 = 0;
  let sci21 = 0;
  let sci2Array = 0;
  let sci2String = 0;
  let sci21String = 0;

  for (const number of resources.list('script').slice(0, 40)) {
    const bytes = await resources.read('script', number);
    if (!bytes) continue;
    // **Decoded from the script's own export offsets, never by scanning.**
    // A SCI32 script has no block chain, so there is nothing that says where
    // its code ends and its data begins — and byte-scanning a resource for
    // `callk` finds ordinals in strings and in property tables. The exports are
    // the one set of offsets the script itself certifies as instruction
    // boundaries, so a decode that starts there and stops at the first byte it
    // cannot read is the only reading with evidence behind it.
    for (const entry of exportOffsets(bytes)) {
      let at = entry;
      let steps = 0;
      while (at < bytes.length && steps < 4096) {
        const instruction = decodeSciInstruction(bytes, at);
        if (!instruction) break;
        if (instruction.name === 'callk') {
          const number = instruction.operands[0];
          if (number === SCI2_DOSOUND) sci2++;
          else if (number === SCI21_DOSOUND) sci21++;
          if (number === SCI2_ARRAY) sci2Array++;
          if (number === SCI2_STRING) sci2String++;
          if (number === SCI21_STRING) sci21String++;
        }
        if (instruction.name === 'ret') break;
        at += instruction.length;
        steps++;
      }
    }
  }

  const sci21Versions: readonly SciVersion[] = ['sci2-1-middle', 'sci2-1-late', 'sci3'];
  const sci2Versions: readonly SciVersion[] = ['sci2', 'sci2-1-early'];

  // A margin *and* a floor. The margin is for the same reason the
  // compression-era probe needs one; the floor is because this probe reads a
  // single number out of a handful of instructions, and three hits from a
  // hundred scripts is a coincidence rather than a table. A game below the
  // floor stays on `guess`, which is the right answer: it plays, and it is
  // refused for editing with the reason on screen (ADR 0013).
  const floor = 6;

  // **A call to SCI2's `Array` settles it on its own.** That ordinal is a
  // `Dummy` at SCI2.1 and nothing calls a placeholder, so this needs no margin
  // and no floor — which is what makes it worth having, because the `DoSound`
  // counts find only two sites between King's Quest VII and Space Quest 6 and
  // leave both on `guess`.
  if (sci2Array > 0) {
    return {
      name: 'SCI32 kernel table',
      // **`sci2` alone, not `sci2Versions`.** ScummVM switches to the SCI2.1
      // table at `SCI_VERSION_2_1_EARLY`, so the table seam and the `DoSound`
      // seam are in different places — the ordinals below split
      // early-from-middle and this splits SCI2 from everything after it.
      // Narrowing to both would have been the wider claim and the wrong one.
      narrowedTo: ['sci2'],
      evidence:
        `${sci2Array} calls to Kernel 0x82, which is Array at SCI2 and a placeholder at ` +
        `SCI2.1 — a game does not call a placeholder`,
    };
  }

  // And the other way, from the one call every SCI32 game makes. A game that
  // uses its String kernel at 0x5c and never at 0x83 is reading SCI2.1's
  // numbering; a SCI32 game with no string handling at all does not exist, so
  // the *absence* is evidence here in a way an absence usually is not.
  if (sci21String > 0 && sci2String === 0) {
    return {
      name: 'SCI32 kernel table',
      narrowedTo: ['sci2-1-early', 'sci2-1-middle', 'sci2-1-late', 'sci3'],
      evidence:
        `${sci21String} calls to Kernel 0x5c and none to 0x83 — this game reaches String at ` +
        `SCI2.1's ordinal and never at SCI2's`,
    };
  }

  if (sci2 >= floor && sci2 >= sci21 * 3) {
    return {
      name: 'SCI32 kernel table',
      narrowedTo: sci2Versions,
      evidence: `${sci2} calls to Kernel 0x40 against ${sci21} to 0x75, which is SCI2's table`,
    };
  }
  if (sci21 >= floor && sci21 >= sci2 * 3) {
    return {
      name: 'SCI32 kernel table',
      narrowedTo: sci21Versions,
      evidence: `${sci21} calls to Kernel 0x75 against ${sci2} to 0x40, which is SCI2.1's table`,
    };
  }
  return {
    name: 'SCI32 kernel table',
    narrowedTo: [],
    evidence:
      `${sci2} calls to 0x40 and ${sci21} to 0x75 from this game's own export offsets, ` +
      `which is not enough to decide on`,
  };
}

/**
 * A SCI32 script's export offsets, which are the boundaries it certifies.
 *
 * A count at 6 and the table at 8 — SCI1.1's fixed positions, which SCI2 and
 * SCI2.1 keep. Bounded hard, because a resource that is not a script at all
 * will read a plausible count from whatever is at byte 6.
 */
function exportOffsets(bytes: Uint8Array): number[] {
  if (bytes.length < 10) return [];
  const count = bytes[6] | (bytes[7] << 8);
  if (count === 0 || count > 256) return [];

  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = 8 + i * 2;
    if (at + 1 >= bytes.length) break;
    const offset = bytes[at] | (bytes[at + 1] << 8);
    if (offset > 0 && offset < bytes.length) offsets.push(offset);
  }
  return offsets;
}

/** Every probe, in the order they are cheapest to run. */
export async function runSciProbes(resources: SciResources): Promise<SciProbeResult[]> {
  return [
    probeHeapSplit(resources),
    probeKernelVocab(resources),
    probeMessageResources(resources),
    probeColourDepth(resources),
    await probeViewRecord(resources),
    await probeCompressionVariants(resources),
    await probeCompressionEra(resources),
    await probeScriptHeader(resources),
    await probeKernelRange(resources),
    // Only for a SCI32 map: on a SCI16 game the two ordinals mean something
    // else entirely, and counting them would be reading noise.
    ...(atLeast(resources.version, 'sci2') ? [await probeSci32KernelTable(resources)] : []),
  ];
}

/**
 * Narrows a map's bucket with the probes, and says how sure the answer is.
 *
 * Intersection rather than a vote: a probe that cannot tell returns nothing to
 * intersect and drops out, and a probe that contradicts the rest empties the
 * set — which is reported rather than resolved, because two structural probes
 * disagreeing about a game's own bytes means one of them is wrong and picking a
 * winner would hide that.
 */
export function narrow(
  candidates: readonly SciVersion[],
  probes: readonly SciProbeResult[],
): { versions: SciVersion[]; contradicted: boolean } {
  let remaining = [...candidates];
  for (const probe of probes) {
    if (probe.narrowedTo.length === 0) continue;
    const next = remaining.filter((version) => probe.narrowedTo.includes(version));
    // The candidates this started with, not what the probes had narrowed to
    // before the disagreement. Half-applying a contradicted narrowing is how
    // the `vocab.999` probe put King's Quest I on SCI1 EGA-only: it emptied the
    // set against the compression probe and the earlier narrowing survived.
    if (next.length === 0) return { versions: [...candidates], contradicted: true };
    remaining = next;
  }
  return { versions: remaining, contradicted: false };
}

/**
 * The Version to run on, and how it was arrived at.
 *
 * When the probes leave one Version, that is the answer and it is `probe`. When
 * they leave several, the **earliest** is chosen and the identification is
 * `guess` — earliest because a later Version's reading applied to an earlier
 * game misreads more than the other way round, and `guess` because ADR 0013's
 * rule is what has to fire: the game plays and is refused for editing, with the
 * reason on screen.
 */
export function decideVersion(
  candidates: readonly SciVersion[],
  probes: readonly SciProbeResult[],
): { version: SciVersion; identification: 'probe' | 'guess'; why: string } {
  const { versions, contradicted } = narrow(candidates, probes);

  if (contradicted) {
    return {
      version: versions[0],
      identification: 'guess',
      why:
        `Two structural probes disagreed about this game's own bytes, so its Version ` +
        `could not be established. Running as ${describeSciVersion(versions[0])}.`,
    };
  }
  if (versions.length === 1) {
    return {
      version: versions[0],
      identification: 'probe',
      why: `Identified as ${describeSciVersion(versions[0])} from the game's own resources.`,
    };
  }
  // **Several Versions left is not the same thing as a guess.**
  //
  // ADR 0013 refuses an edit on a guessed Version because decoding with the
  // wrong Kernel table writes a misreading back byte for byte. Where the
  // Versions still standing decode identically there is no misreading to write,
  // so the refusal would be over a difference that does not exist — and for the
  // SCI2.1 middle/late seam it would be permanent, because `sciVersion.ts` says
  // outright that nothing structural this project reads moves there. A seam
  // that is not in the data cannot be found by a probe of the data.
  //
  // King's Quest VII is the game that was waiting on evidence that cannot
  // exist. It plays as SCI2.1 middle, and it may now be edited as SCI2.1
  // middle, because SCI2.1 late reads every byte of it the same way.
  if (versionsDecodeIdentically(versions)) {
    return {
      version: versions[0],
      identification: 'probe',
      why:
        `This game's Version narrowed to ${versions.map(describeSciVersion).join(' and ')}, ` +
        `which decode identically — same Kernel table, same Selector rule, same Script ` +
        `layout — so which of them it is cannot change a byte this project reads or writes. ` +
        `Running and editing as ${describeSciVersion(versions[0])}.`,
    };
  }

  return {
    version: versions[0],
    identification: 'guess',
    why:
      `This game's Version narrowed to ${versions.map(describeSciVersion).join(', ')} and no ` +
      `further. Running as ${describeSciVersion(versions[0])}.`,
  };
}

/** True when a Version pair spans the SCI16/SCI32 renderer boundary. */
export function spansRenderers(versions: readonly SciVersion[]): boolean {
  return versions.some((v) => before(v, 'sci2')) && versions.some((v) => atLeast(v, 'sci2'));
}

export { readSciResourceHeader };
