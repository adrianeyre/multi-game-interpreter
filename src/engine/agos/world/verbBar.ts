/**
 * The verb bar: choosing a verb, and pointing it at things.
 *
 * The last of the three AGOS interfaces to have nothing in it, and the reason
 * a complete opcode table still did not make Simon 1 playable — with no way to
 * choose a verb there was no way for a player to issue a command at all.
 *
 * ## What was already here, and what was not
 *
 * The plumbing: `AgosInput` turns a click into a hit area and a hit area
 * carries the verb it means, and `AgosInterpreter.runVerb` matches a verb and
 * two nouns against the guards on the verb table's lines. So a click on a box
 * that already names a verb has always worked.
 *
 * What was missing is everything a *player* does: which verbs exist, which one
 * is currently chosen, and how a verb that needs two things collects the
 * second. That is this file.
 *
 * ## The set is what the table dispatches on, which is not the same as a bar
 *
 * A hard-coded list of Simon 1's verbs would be wrong three ways. It would be
 * English, and this family admits German, French, Italian, Spanish, Polish,
 * Russian and Hebrew releases — the last of which lays out right to left. It
 * would be Simon 1's, and the seven Versions do not share an interface. And it
 * would be a second copy of something the game already states.
 *
 * So the set comes out of **subroutine 0's own guards**. The verb table is a
 * list of lines each guarded by a verb and two nouns (`AgosSubroutineLine`), so
 * the distinct verbs appearing in those guards are exactly the verbs the game
 * responds to — and a verb whose guards ever name a second noun is exactly a
 * verb that takes two things. Both facts are read rather than assumed, which
 * is the same discipline the opcode tables are generated under.
 *
 * **And measuring it against a real game showed it is not the bar's list.**
 * Simon 1's DOS floppy demo yields 33 verbs numbered 200 to 304, where the
 * game's on-screen bar has about nine. So what this reads is the set of verbs
 * the verb table *dispatches on* — which includes verbs scripts raise
 * themselves — and the player-facing subset is a strictly smaller thing that
 * is **not established here**. The function is named for what it returns
 * rather than for what was wanted from it.
 *
 * That is still the right set for {@link VerbBar} to hold, because the bar uses
 * it only to refuse a verb no guard could match: a superset refuses nothing
 * legitimate. What it must not be used for is *drawing* a bar, and this file
 * draws nothing.
 *
 * Getting here found a real bug rather than only a wrong number. The first
 * version tested a second noun against `-1` and marked all 34 verbs as
 * two-noun, which is implausible enough to check — and the sentinel turned out
 * to be `0xFFFF`, which `runVerb` had been comparing against `-1` all along.
 * See `GUARD_ANY` in `../script/subroutines.ts`.
 */

import { isGuardWildcard, type AgosSubroutineBlock } from '../script/subroutines.js';

/** One verb a player can choose. */
export interface Verb {
  /** The number its guards use, which is the only durable identity it has. */
  readonly id: number;
  /**
   * Whether this verb collects a second thing before it acts.
   *
   * True when some guard for it names a second noun. "Give" and "Use" are the
   * shape: a player picks the verb, points at one thing, then at another.
   */
  readonly takesTwoNouns: boolean;
  /**
   * How many lines of the verb table are guarded by it.
   *
   * Not used to decide anything — it is here so a surface can show which verbs
   * a game actually leans on, and so a derivation that produced something
   * implausible is visible rather than silent.
   */
  readonly lines: number;
}

export interface VerbSet {
  readonly verbs: readonly Verb[];
  /** Always true here, and recorded so a caller can say where the set came from. */
  readonly derived: 'verb-table-guards';
}

/**
 * Reads the verbs a game responds to out of its verb table.
 *
 * Subroutine 0 is the verb table; every other Subroutine is called by number
 * and has no guard, so those are skipped rather than searched.
 */
export function dispatchableVerbsFrom(block: AgosSubroutineBlock): VerbSet {
  const table = block.subroutines.find((each) => each.id === 0);
  const counts = new Map<number, { lines: number; twoNouns: boolean }>();

  for (const line of table?.lines ?? []) {
    const guard = line.guard;
    if (!guard) continue;
    // A guard whose *verb* is the wildcard guards no particular verb, so it is
    // not one a player can choose. Simon 1's demo has two such lines and they
    // would otherwise appear as a verb numbered 65535.
    if (isGuardWildcard(guard.verb)) continue;
    const existing = counts.get(guard.verb) ?? { lines: 0, twoNouns: false };
    counts.set(guard.verb, {
      lines: existing.lines + 1,
      // A *named* second noun is what marks a verb as taking two things, and
      // the wildcard is `0xFFFF` rather than `-1`. Testing against `-1` here
      // was the first version of this and it marked every verb in Simon 1's
      // demo as two-noun — 34 of them, which is what sent this looking for the
      // sentinel and found the `runVerb` bug.
      twoNouns: existing.twoNouns || !isGuardWildcard(guard.noun2),
    });
  }

  const verbs = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, { lines, twoNouns }]) => ({ id, takesTwoNouns: twoNouns, lines }));

  return { verbs, derived: 'verb-table-guards' };
}

/** What pointing the bar at something produced. */
export type VerbAction =
  /** Nothing to do: no verb is chosen. */
  | { readonly kind: 'idle' }
  /** The verb needs a second thing, and this was the first. */
  | { readonly kind: 'awaiting-second'; readonly verb: number; readonly noun1: number }
  /** Ready to run: these are the words to hand to `runVerb`. */
  | {
      readonly kind: 'run';
      readonly verb: number;
      readonly noun1: number;
      readonly noun2: number;
    };

/**
 * The chosen verb, and the nouns being collected for it.
 *
 * Deliberately holds no strings and draws nothing. A verb's *label* is a string
 * in the game's own pool and its position on screen is a hit area the game's
 * scripts define, so both belong to the surface that draws them; what belongs
 * here is which verb is chosen and how far through a two-noun command a player
 * is. That split is why this is testable without a canvas.
 */
export class VerbBar {
  private selected: number | null = null;
  private pendingNoun: number | null = null;

  constructor(private readonly set: VerbSet) {}

  get verbs(): readonly Verb[] {
    return this.set.verbs;
  }

  /** The chosen verb, or null before a player has chosen one. */
  get verb(): number | null {
    return this.selected;
  }

  /** The first thing a two-noun command was pointed at, while it waits for the second. */
  get pending(): number | null {
    return this.pendingNoun;
  }

  /**
   * Chooses a verb, and abandons any half-built command.
   *
   * Abandoning is the point: a player who has picked "Give", pointed at a
   * coin, and then changed their mind to "Look at" means to look at something,
   * not to give the coin to whatever they click next. Carrying the noun over
   * would produce a command the player never issued.
   *
   * Returns whether the verb is one this game has. An unknown verb is refused
   * rather than selected, because a selected verb no guard matches makes every
   * subsequent click do nothing with no way to see why.
   */
  choose(verb: number): boolean {
    if (!this.set.verbs.some((each) => each.id === verb)) return false;
    this.selected = verb;
    this.pendingNoun = null;
    return true;
  }

  /** Forgets the verb and any pending noun. */
  clear(): void {
    this.selected = null;
    this.pendingNoun = null;
  }

  /**
   * Points the chosen verb at a thing.
   *
   * For a one-noun verb this is the whole command. For a two-noun verb the
   * first call collects the noun and the second completes it — and the *order*
   * is the one the player performed, first thing then second, which is what
   * `runVerb`'s guards are written against.
   */
  point(noun: number): VerbAction {
    const verb = this.selected;
    if (verb === null) return { kind: 'idle' };

    const entry = this.set.verbs.find((each) => each.id === verb);
    if (!entry?.takesTwoNouns) {
      // A one-noun command runs and leaves the verb chosen, which is how the
      // originals behave: a player who picked "Look at" usually looks at
      // several things.
      return { kind: 'run', verb, noun1: noun, noun2: -1 };
    }

    if (this.pendingNoun === null) {
      this.pendingNoun = noun;
      return { kind: 'awaiting-second', verb, noun1: noun };
    }

    const noun1 = this.pendingNoun;
    // Cleared before returning, so a completed two-noun command does not leave
    // a stale first noun to be picked up by the next click.
    this.pendingNoun = null;
    return { kind: 'run', verb, noun1, noun2: noun };
  }
}

/** A verb a click can currently issue, and what makes it reachable. */
export interface ReachableVerb {
  readonly id: number;
  /** How many live hit areas offer it. */
  readonly boxes: number;
  /**
   * Whether the verb table has a guard for it.
   *
   * False is the interesting case: a box offering a verb no guard matches is a
   * click that will do nothing, which is either a game we are reading wrongly
   * or a verb raised for something other than dispatch.
   */
  readonly dispatchable: boolean;
}

/**
 * The verbs a player can actually issue right now.
 *
 * **This is the answer to the question `dispatchableVerbsFrom` could not
 * answer.** That function reads the verbs the verb table *dispatches* on — 33
 * of them in Simon 1's demo, where the on-screen bar has about nine — and the
 * gap between the two has been recorded as "not established" because it is not
 * in the data: which verbs a player is offered is decided at run time by the
 * hit areas a game's own Subroutines create with `o_addBox`, each carrying the
 * verb it means.
 *
 * So it is not unknowable, it is *observable*, and this observes it. Given the
 * live hit areas it reports which verbs a click can issue, how many boxes offer
 * each, and whether the verb table has a guard for it.
 *
 * Disabled boxes are excluded, because a box that is not live cannot be
 * clicked — `HitAreaTable.at` skips them for the same reason, and counting them
 * here would report an interface the player cannot reach.
 *
 * A snapshot rather than a fact about the game: the answer changes as scripts
 * add, enable and disable boxes, which is exactly why it could not be read out
 * of `GAMEPC`.
 */
export function reachableVerbs(
  areas: readonly { readonly verb: number; readonly enabled: boolean }[],
  dispatchable: VerbSet,
): readonly ReachableVerb[] {
  const dispatchableIds = new Set(dispatchable.verbs.map((each) => each.id));
  const counts = new Map<number, number>();

  for (const area of areas) {
    if (!area.enabled) continue;
    // A box carrying the wildcard names no particular verb, so it offers none.
    if (isGuardWildcard(area.verb)) continue;
    counts.set(area.verb, (counts.get(area.verb) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([id, boxes]) => ({ id, boxes, dispatchable: dispatchableIds.has(id) }));
}
