/**
 * Broken Sword's object manager: which sections are alive, and their compacts.
 *
 * ## What a "section" is, and why the live list matters
 *
 * A section is a resource group (`rif.ts`) and also a *room's worth of objects*.
 * Sections 1-99 are screens, 128-134 are the megas — George, Nico, Sam and the
 * rest — and 149 holds the two text compacts. The logic engine walks every
 * section every cycle and skips the dead ones, so the live list is not a cache:
 * it is the difference between running seven sections' scripts and running a
 * hundred and fifty.
 *
 * A section is alive when a mega is standing in it (`megaEntering`) or when it
 * is one of the permanently-live ones. That is why George's section stays open
 * behind him when he walks out of a room: `megaLeaving` keeps the player's
 * section resident because the screen still needs its graphics for the frame
 * being drawn.
 *
 * ## Compacts are mutated in place and that is the design
 *
 * A compact is the game's state. `fnStandAt` writes a coordinate, a script
 * reads it next instruction, the renderer reads it this frame, and a save
 * writes the section's bytes out whole. So `fetch` hands back a window onto the
 * section buffer rather than a copy, and there is exactly one buffer per
 * section — which is what makes `saveState` a `subarray` rather than a walk
 * over three thousand named fields.
 */

import {
  compactIn,
  readCompactSection,
  SwordCompactError,
  type SwordCompact,
  type SwordCompactSection,
} from './swordCompact.js';
import { SWORD1_ITM_PER_SEC, SWORD1_PLAYER, SWORD1_TEXT_SECT } from './swordDefs.js';
import { SWORD1_SECTION_COMPACTS, SWORD1_SECTIONS } from './swordSections.js';
import type { SwordResources } from './SwordResources.js';
import { formatResourceId } from './rif.js';

/**
 * The sections that are alive from the moment the game starts.
 *
 * ScummVM's `ObjectMan::initialize` sets exactly these: the seven mega sections
 * that exist, plus 145, 146 and the text section. They are the sections whose
 * objects have to be running before anybody is standing anywhere — George
 * himself is in 128, and a game with 128 dead has no player.
 */
export const SWORD1_ALWAYS_LIVE_SECTIONS = [
  128,
  129,
  130,
  131,
  133,
  134,
  145,
  146,
  SWORD1_TEXT_SECT,
] as const;

export class SwordObjects {
  /** How many megas are standing in each section. Zero means dead. */
  private readonly liveList = new Int32Array(SWORD1_SECTIONS);
  private readonly sections = new Map<number, SwordCompactSection>();
  private readonly notes: string[] = [];

  constructor(private readonly resources: SwordResources) {}

  /**
   * Opens the always-live sections. Called once, before the first cycle.
   *
   * A section whose compact resource is not in this folder is noted and left
   * dead rather than fatal: a CD1-only install has no `SYRIA.CLU`, so section
   * 45's compacts are genuinely absent, and the honest answer is a game that
   * runs the sections it has.
   */
  initialise(): void {
    this.liveList.fill(0);
    for (const section of SWORD1_ALWAYS_LIVE_SECTIONS) this.liveList[section] = 1;
    for (let section = 0; section < SWORD1_SECTIONS; section++) {
      if (this.liveList[section]) this.open(section);
    }
  }

  /** What could not be opened, for the log and the stall report. */
  get warnings(): readonly string[] {
    return this.notes;
  }

  /** True when the section's scripts should run this cycle. */
  isAlive(section: number): boolean {
    return (this.liveList[section] ?? 0) > 0;
  }

  /** Sections currently alive, ascending. For the stall report. */
  liveSections(): number[] {
    const live: number[] = [];
    for (let section = 0; section < SWORD1_SECTIONS; section++) {
      if (this.liveList[section] > 0) live.push(section);
    }
    return live;
  }

  /** How many objects a section declares, or 0 when it is not open. */
  objectCount(section: number): number {
    return this.sections.get(section)?.count ?? 0;
  }

  /**
   * A mega has walked into this section: bring it to life and open its compacts.
   */
  megaEntering(section: number): void {
    this.liveList[section] = (this.liveList[section] ?? 0) + 1;
    if (this.liveList[section] === 1) this.open(section);
  }

  /**
   * A mega has left. The section dies when the last one goes — unless it is the
   * player's, whose graphics the frame being drawn still needs.
   */
  megaLeaving(section: number, id: number): void {
    const live = this.liveList[section] ?? 0;
    if (live === 0) {
      this.notes.push(`mega ${id} left section ${section}, which was already empty`);
      return;
    }
    this.liveList[section] = live - 1;
    if (this.liveList[section] === 0 && id !== SWORD1_PLAYER) this.sections.delete(section);
  }

  /** Drops a section left open for the player's sake, after the screen changed. */
  closeSection(section: number): void {
    if ((this.liveList[section] ?? 0) === 0) this.sections.delete(section);
  }

  /**
   * One object, or null when its section is not open.
   *
   * Null rather than throwing, for the reason `compactIn` gives: a localised
   * build may not ship a section a script names, and a game that skips the
   * object is better than a game that stops.
   */
  fetch(id: number): SwordCompact | null {
    const section = Math.floor(id / SWORD1_ITM_PER_SEC);
    const open = this.sections.get(section) ?? this.open(section);
    if (!open) return null;
    return compactIn(open, id % SWORD1_ITM_PER_SEC);
  }

  /** The raw section buffers, for a save. Keyed by section number. */
  snapshot(): Map<number, Int32Array> {
    const out = new Map<number, Int32Array>();
    for (const [section, open] of this.sections) out.set(section, open.words.slice());
    return out;
  }

  /**
   * Restores section buffers from a save, and the live list with them.
   *
   * Every check runs before a word is written, which is `AdventureEngine`'s
   * rule: the compacts *are* the world, so a half-applied restore is two games'
   * objects at once.
   */
  restore(sections: ReadonlyMap<number, Int32Array>, liveList: readonly number[]): void {
    for (const [section, words] of sections) {
      const open = this.sections.get(section) ?? this.open(section);
      if (!open) {
        throw new SwordCompactError(
          `This save holds section ${section}'s objects and this install cannot open that ` +
            `section — its compact resource ` +
            `(${formatResourceId(SWORD1_SECTION_COMPACTS[section] ?? 0)}) is not in this folder. ` +
            `The save is refused rather than half-applied.`,
        );
      }
      if (open.words.length !== words.length) {
        throw new SwordCompactError(
          `This save holds ${words.length} words for section ${section} and this install's ` +
            `resource holds ${open.words.length}. The save was written against different game ` +
            `data, so it is refused rather than half-applied.`,
        );
      }
    }
    for (const [section, words] of sections) {
      const open = this.sections.get(section);
      if (open) open.words.set(words);
    }
    this.liveList.fill(0);
    liveList.forEach((count, section) => {
      if (section < SWORD1_SECTIONS) this.liveList[section] = count;
    });
    // A section the save says is live but that is not open has to be opened, or
    // its scripts run against nothing.
    for (let section = 0; section < SWORD1_SECTIONS; section++) {
      if (this.liveList[section] > 0 && !this.sections.has(section)) this.open(section);
    }
  }

  /** The live list as a plain array, for a save. */
  liveListSnapshot(): number[] {
    return Array.from(this.liveList);
  }

  /**
   * Opens a section's compacts, or null.
   *
   * Synchronous, and it can only succeed while `COMPACTS.CLU` is resident —
   * which it always is, because `SWORD1_RESIDENT_CLUSTERS` pins it. That is the
   * whole reason the logic path never has to await.
   */
  private open(section: number): SwordCompactSection | null {
    const id = SWORD1_SECTION_COMPACTS[section] ?? 0;
    if (id === 0) return null;
    const resource = this.resources.fetch(id);
    if (!resource) {
      this.notes.push(
        `section ${section}: ${this.resources.describeMissingResource(id)} (its objects cannot ` +
          `run)`,
      );
      return null;
    }
    try {
      const open = readCompactSection(resource.bytes, section, this.resources.bigEndian);
      this.sections.set(section, open);
      return open;
    } catch (error) {
      this.notes.push(
        `section ${section}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
