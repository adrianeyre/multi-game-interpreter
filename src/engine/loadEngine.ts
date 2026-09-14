/**
 * Picks the Engine family a set of game files belongs to, and loads it.
 *
 * The shell's one remaining piece of family knowledge, kept in one function so
 * it is not spread through `src/main.ts` as a branch per feature. Adding a
 * family is an entry in `FAMILIES`; nothing above this asks which one answered.
 */

import type { AdventureEngine } from './AdventureEngine.js';
import type { DataSource } from './resource/DataSource.js';
import { LoadProgressTracker } from './resource/progress.js';
import { ScummEngine } from './ScummEngine.js';
import { AgiEngine } from './agi/AgiEngine.js';
import { looksLikeAgi, type DeclaredInterpreter } from './agi/resource/agiDetect.js';
import { SciEngine } from './sci/SciEngine.js';
import { looksLikeSci } from './sci/resource/sciDetect.js';
import { looksLikeSky } from './sky/resource/skyDetect.js';
import { SkyEngine } from './sky/SkyEngine.js';
import { looksLikeLure } from './lure/resource/lureDetect.js';
import { LureEngine } from './lure/LureEngine.js';
import { AgosEngine } from './agos/AgosEngine.js';
import { looksLikeAgos } from './agos/resource/agosDetect.js';
import { looksLikeSword1 } from './sword1/resource/swordDetect.js';
import { SwordEngine } from './sword1/SwordEngine.js';
import { looksLikeSword2 } from './sword2/resource/sword2Detect.js';
import { Sword2Engine } from './sword2/Sword2Engine.js';

export interface EngineLoadOptions {
  onLog?: (message: string) => void;
  progress?: LoadProgressTracker;
  onActivity?: (activity: string) => void;
  /**
   * An AGI interpreter version stated by the person editing.
   *
   * Ignored by every family that does not need one. It reaches the loader
   * rather than the engine after the fact because the arity table it selects
   * decides how every Logic decodes, so it has to be in hand before the first
   * resource is read (ADR 0013).
   */
  declaredInterpreter?: DeclaredInterpreter;
}

/**
 * One Engine family: how to tell its data apart, and how to load it.
 *
 * `claims` is asked before any file is read past its name, so a family that is
 * not present costs a set lookup rather than a parse. It answers on positive
 * evidence — a marker file this family owns — never on the absence of another
 * family's, because "not SCUMM" is not evidence of anything (`GameDetector`
 * learned this from a King's Quest IV dump named `KQ4SG.000`).
 */
interface EngineFamily {
  readonly name: string;
  claims(fileNames: string[]): boolean;
  load(source: DataSource, options: EngineLoadOptions): Promise<AdventureEngine>;
}

const FAMILIES: EngineFamily[] = [
  {
    name: 'AGI',
    claims: looksLikeAgi,
    load: (source, options) => AgiEngine.create(source, options),
  },
  {
    // A resource map beside at least one numbered volume. Both halves, for the
    // same reason AGI wants a `*DIR` *and* a `VOL`: a lone `RESOURCE.MAP` from
    // half an extracted archive is not evidence of a game, and claiming it here
    // takes SCUMM's good failure message away from a dump that has one.
    name: 'SCI',
    claims: looksLikeSci,
    load: (source, options) => SciEngine.create(source, options),
  },
  {
    // A base file this family owns beside its archive, or one of the archives.
    // Asked before SCUMM for the same reason AGI is: the evidence is exact —
    // no SCUMM release ships a `gamepc` or a `simon.gme` — and SCUMM's detector
    // is the one with the good failure messages, so it should be left holding
    // whatever nobody claimed.
    name: 'AGOS',
    claims: looksLikeAgos,
    load: (source, options) => AgosEngine.create(source, options),
  },
  {
    // Sky's two data files, both halves, the way `skyDetect.ts` argues for.
    // Asked before SCUMM for the reason every family here is: the evidence is
    // exact — no SCUMM release ships a `sky.dsk` — and SCUMM's detector has the
    // good failure messages, so it should be left holding whatever nobody
    // claimed.
    //
    // What this engine can do is narrower than the others and it says so
    // itself: it reads, boots and runs scripts, and stops where they call an
    // mcode nothing implements (#255). A player is told that by the status line
    // rather than by a dead end, which is why claiming the game is better than
    // leaving it to the foreign-engine table.
    name: 'Sky',
    claims: looksLikeSky,
    load: (source, options) => SkyEngine.create(source, options),
  },
  {
    // Lure's `disk1.vga` plus a second numbered disk, both halves, the way
    // `lureDetect.ts` argues for. Asked before SCUMM for the reason every family
    // here is: the evidence is exact — no SCUMM release ships a `disk1.vga`
    // beside a `disk2.vga` — and SCUMM's detector has the good failure messages.
    //
    // What this engine does is narrower than the others and it says so itself:
    // it reads the game and its initial world state and stops there, because
    // Lure's bytecode is a separate system this project does not read yet
    // (ADR 0026). A player is told that by the status line rather than by a dead
    // end, which is why claiming the game is better than leaving it to the
    // foreign-engine table.
    name: 'Lure',
    claims: looksLikeLure,
    load: (source, options) => LureEngine.create(source, options),
  },
  {
    // Broken Sword's cluster index plus at least one cluster it names, the way
    // `swordDetect.ts` argues for. Asked before SCUMM for the reason every
    // family here is: the evidence is exact — no SCUMM release ships a
    // `swordres.rif` — and SCUMM's detector has the good failure messages.
    //
    // This family needs no support file at all, which is the reason
    // `docs/scummvm-parity-roadmap.md` recommended it first: its index is
    // self-describing, so nothing here is derived from a table ScummVM
    // generates (ADR 0033's other side).
    name: 'Sword1',
    claims: looksLikeSword1,
    load: (source, options) => SwordEngine.create(source, options),
  },
  {
    // Broken Sword II's *two index files*, both halves. And pointedly not
    // `general.clu`, which is what `engineSignatures.ts` matched this game on
    // for years: both Broken Swords ship a file with that name, so a folder
    // holding both games' clusters was identified as whichever signature came
    // first. The index is the evidence that tells them apart.
    name: 'Sword2',
    claims: looksLikeSword2,
    load: (source, options) => Sword2Engine.create(source, options),
  },
  {
    // SCUMM is last and claims anything, because its own detector already
    // reports what it found and why in terms a player can act on — including
    // naming another ScummVM engine when the files belong to one. Putting a
    // catch-all first would take that message away from every failure.
    name: 'SCUMM',
    claims: () => true,
    load: (source, options) => ScummEngine.create(source, options),
  },
];

/**
 * Loads whichever Engine family these files belong to.
 *
 * AGI is asked first because its evidence is unambiguous — a `LOGDIR` or a
 * `<GAMEID>DIR` beside its volumes is not something a SCUMM release ships — and
 * because SCUMM's detector is the one with the good failure messages, so it
 * should be the one left holding an unrecognised dump.
 */
export async function loadAdventureEngine(
  source: DataSource,
  options: EngineLoadOptions = {},
): Promise<AdventureEngine> {
  const names = source.list();
  for (const family of FAMILIES) {
    if (family.claims(names)) return family.load(source, options);
  }
  // Unreachable while SCUMM claims everything, and an explicit throw rather
  // than a non-null assertion so that stops being true loudly if it changes.
  throw new Error(`No engine recognised the files in ${source.label}.`);
}
