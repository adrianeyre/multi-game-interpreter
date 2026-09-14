/**
 * The verb bar.
 *
 * The last of AGOS's three interfaces to have anything in it, and the reason a
 * complete opcode table still left Simon 1 unplayable — with no way to choose a
 * verb there was no way to issue a command at all.
 *
 * What these tests are mostly about is the **derivation**: the verb set is read
 * out of the game's own verb table rather than written down, because a
 * hard-coded list would be English, would be Simon 1's, and would be a second
 * copy of something the data already states. So the first block builds verb
 * tables and checks what is read out of them.
 */
import { describe, expect, it } from 'vitest';
import {
  VerbBar,
  dispatchableVerbsFrom,
  reachableVerbs,
} from '../src/engine/agos/world/verbBar.js';
import type { AgosSubroutineBlock } from '../src/engine/agos/script/subroutines.js';

/**
 * A verb table from a list of guards.
 *
 * Only subroutine 0 carries guards — every other Subroutine is called by
 * number — so a fixture that put them elsewhere would not exercise the read.
 */
function tableOf(
  guards: readonly { verb: number; noun1: number; noun2: number }[],
): AgosSubroutineBlock {
  return {
    endMarker: 0xffff,
    subroutines: [
      {
        id: 0,
        endMarker: 0xffff,
        lines: guards.map((guard) => ({ guard, instructions: [] })),
      },
      // A called-by-number Subroutine, which has no guard and must be ignored.
      { id: 42, endMarker: 0xffff, lines: [{ instructions: [] }] },
    ],
  };
}

describe('reading the verbs out of a verb table', () => {
  it('finds the distinct verbs its guards name, in order', () => {
    const set = dispatchableVerbsFrom(
      tableOf([
        { verb: 5, noun1: -1, noun2: -1 },
        { verb: 2, noun1: 10, noun2: -1 },
        { verb: 5, noun1: 11, noun2: -1 },
      ]),
    );

    expect(set.verbs.map((each) => each.id)).toEqual([2, 5]);
    expect(set.derived).toBe('verb-table-guards');
  });

  it('counts the lines each verb guards, so an implausible read is visible', () => {
    const set = dispatchableVerbsFrom(
      tableOf([
        { verb: 5, noun1: -1, noun2: -1 },
        { verb: 5, noun1: 11, noun2: -1 },
      ]),
    );

    expect(set.verbs[0]).toMatchObject({ id: 5, lines: 2 });
  });

  it('treats 0xFFFF as the wildcard, which is what real data stores', () => {
    // The bug this exists for: the stored sentinel is `0xFFFF`, and testing
    // against `-1` marked every verb in Simon 1's demo as two-noun.
    const set = dispatchableVerbsFrom(
      tableOf([
        { verb: 2, noun1: 0xffff, noun2: 0xffff },
        { verb: 7, noun1: 10, noun2: 20 },
      ]),
    );

    expect(set.verbs.find((each) => each.id === 2)?.takesTwoNouns).toBe(false);
    expect(set.verbs.find((each) => each.id === 7)?.takesTwoNouns).toBe(true);
  });

  it('skips a line whose verb is itself the wildcard, not a choosable verb', () => {
    const set = dispatchableVerbsFrom(
      tableOf([
        { verb: 0xffff, noun1: 0xffff, noun2: 0xffff },
        { verb: 3, noun1: 0xffff, noun2: 0xffff },
      ]),
    );

    expect(set.verbs.map((each) => each.id)).toEqual([3]);
  });

  it('marks a verb as taking two nouns when a guard names a second one', () => {
    // A *named* second noun is what distinguishes "Give X to Y" from
    // "Look at X".
    const set = dispatchableVerbsFrom(
      tableOf([
        { verb: 2, noun1: 10, noun2: -1 },
        { verb: 7, noun1: 10, noun2: 20 },
      ]),
    );

    expect(set.verbs.find((each) => each.id === 2)?.takesTwoNouns).toBe(false);
    expect(set.verbs.find((each) => each.id === 7)?.takesTwoNouns).toBe(true);
  });

  it('reads nothing out of a game with no verb table rather than throwing', () => {
    const set = dispatchableVerbsFrom({ endMarker: 0xffff, subroutines: [] });

    expect(set.verbs).toEqual([]);
  });
});

describe('choosing a verb', () => {
  const set = dispatchableVerbsFrom(
    tableOf([
      { verb: 2, noun1: -1, noun2: -1 },
      { verb: 7, noun1: 10, noun2: 20 },
    ]),
  );

  it('refuses a verb the game does not have', () => {
    // A selected verb no guard matches makes every later click do nothing,
    // with nothing on screen to say why.
    const bar = new VerbBar(set);

    expect(bar.choose(99)).toBe(false);
    expect(bar.verb).toBeNull();
  });

  it('abandons a half-built command when the verb changes', () => {
    // A player who picked a two-noun verb, pointed at something, then changed
    // their mind means to use the new verb — carrying the noun over would
    // issue a command they never made.
    const bar = new VerbBar(set);
    bar.choose(7);
    bar.point(10);
    expect(bar.pending).toBe(10);

    bar.choose(2);

    expect(bar.pending).toBeNull();
  });
});

describe('pointing a verb at something', () => {
  const set = dispatchableVerbsFrom(
    tableOf([
      { verb: 2, noun1: -1, noun2: -1 },
      { verb: 7, noun1: 10, noun2: 20 },
    ]),
  );

  it('does nothing at all before a verb is chosen', () => {
    const bar = new VerbBar(set);

    expect(bar.point(10)).toEqual({ kind: 'idle' });
  });

  it('runs a one-noun verb immediately, with -1 for the second', () => {
    const bar = new VerbBar(set);
    bar.choose(2);

    expect(bar.point(10)).toEqual({ kind: 'run', verb: 2, noun1: 10, noun2: -1 });
  });

  it('leaves a one-noun verb chosen, because a player looks at several things', () => {
    const bar = new VerbBar(set);
    bar.choose(2);
    bar.point(10);

    expect(bar.verb).toBe(2);
    expect(bar.point(11)).toMatchObject({ noun1: 11 });
  });

  it('collects the first noun of a two-noun verb and says it is waiting', () => {
    const bar = new VerbBar(set);
    bar.choose(7);

    expect(bar.point(10)).toEqual({ kind: 'awaiting-second', verb: 7, noun1: 10 });
  });

  it('completes a two-noun verb in the order the player performed it', () => {
    // The order matters: the guards are written against first-thing then
    // second-thing, so swapping them would match the wrong line.
    const bar = new VerbBar(set);
    bar.choose(7);
    bar.point(10);

    expect(bar.point(20)).toEqual({ kind: 'run', verb: 7, noun1: 10, noun2: 20 });
  });

  it('does not leave a stale first noun after a two-noun command completes', () => {
    const bar = new VerbBar(set);
    bar.choose(7);
    bar.point(10);
    bar.point(20);

    // The next click starts a fresh command rather than completing the old one.
    expect(bar.pending).toBeNull();
    expect(bar.point(30)).toEqual({ kind: 'awaiting-second', verb: 7, noun1: 30 });
  });
});

/**
 * Which verbs a player can actually issue.
 *
 * The question `dispatchableVerbsFrom` could not answer, and was recorded as
 * "not established" for several rounds. It is not in the data: which verbs a
 * player is offered is decided at run time by the hit areas a game's own
 * Subroutines create, each carrying the verb it means. So it is observable
 * rather than unknowable, and this is the observation.
 */
describe('the verbs a player can actually issue', () => {
  const dispatchable = dispatchableVerbsFrom(
    tableOf([
      { verb: 2, noun1: 0xffff, noun2: 0xffff },
      { verb: 7, noun1: 0xffff, noun2: 0xffff },
    ]),
  );

  it('reports only the verbs live boxes offer, not everything the table dispatches', () => {
    // The whole point: the table dispatches on 2 and 7, and the player is
    // being offered only 2. That gap is the thing that could not be read
    // statically.
    const reachable = reachableVerbs([{ verb: 2, enabled: true }], dispatchable);

    expect(reachable.map((each) => each.id)).toEqual([2]);
  });

  it('excludes a disabled box, because it cannot be clicked', () => {
    // `HitAreaTable.at` skips disabled boxes for the same reason; counting
    // them here would report an interface the player cannot reach.
    const reachable = reachableVerbs(
      [
        { verb: 2, enabled: false },
        { verb: 7, enabled: true },
      ],
      dispatchable,
    );

    expect(reachable.map((each) => each.id)).toEqual([7]);
  });

  it('counts how many boxes offer a verb', () => {
    const reachable = reachableVerbs(
      [
        { verb: 2, enabled: true },
        { verb: 2, enabled: true },
      ],
      dispatchable,
    );

    expect(reachable[0]).toEqual({ id: 2, boxes: 2, dispatchable: true });
  });

  it('flags a box offering a verb no guard matches, which is a click that does nothing', () => {
    // Either a game we are reading wrongly or a verb raised for something
    // other than dispatch. Both are worth seeing rather than silently listing.
    const reachable = reachableVerbs([{ verb: 99, enabled: true }], dispatchable);

    expect(reachable[0]).toMatchObject({ id: 99, dispatchable: false });
  });

  it('ignores a box carrying the wildcard, which names no particular verb', () => {
    const reachable = reachableVerbs([{ verb: 0xffff, enabled: true }], dispatchable);

    expect(reachable).toEqual([]);
  });

  it('reports nothing when no box is live, rather than falling back to the table', () => {
    // A game mid-cutscene offers no verbs, and saying "all 33" there would be
    // the static answer wearing the runtime one's clothes.
    expect(reachableVerbs([], dispatchable)).toEqual([]);
  });
});
