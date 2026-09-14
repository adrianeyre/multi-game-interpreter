/**
 * A SCI game's cast, which is derived from the class graph and not read.
 *
 * `docs/editor-parity.md` row 13 is the only one of the four families' casts
 * that cannot come from a table: SCUMM has actors, a Sword 1 compact declares
 * `o_type` MEGA, a Sword II object calls a mega opcode, and a SCI game declares
 * nothing at all. What plays an actor is class membership, so the cast is a
 * question put to `-super-`.
 *
 * These pin the three answers that are easy to get wrong: a subclass several
 * hops down is cast, a class definition is not a cast member, and a release
 * that names no classes yields **no cast and says why** rather than yielding a
 * wrong one.
 */

import { describe, expect, it } from 'vitest';

import { describeSciCast, sciCast } from '../src/authoring/sci/sciCast.js';
import type { SciProjectObject, SciProjectScript } from '../src/authoring/project.js';

function object(over: Partial<SciProjectObject> & { name: string }): SciProjectObject {
  return {
    isClass: false,
    species: 0,
    superClass: 0,
    variables: [],
    variableSelectors: [],
    variableOffsets: [],
    methods: [],
    ...over,
  } as SciProjectObject;
}

function script(number: number, objects: SciProjectObject[]): SciProjectScript {
  return { number, objects } as SciProjectScript;
}

describe('a SCI cast is derived from the class chain', () => {
  /**
   * Sierra's own graph shape: `Actor` is a class, `KQEgo` subclasses it, and
   * the instance the player moves is an instance of that. Two hops, and the
   * naive one-hop reading misses it.
   */
  it('counts an instance several hops below Actor', () => {
    const scripts = [
      script(0, [
        object({ name: 'Actor', isClass: true, species: 2, superClass: 1 }),
        object({ name: 'KQEgo', isClass: true, species: 30, superClass: 2 }),
      ]),
      script(100, [object({ name: 'rosella', species: 30, superClass: 30 })]),
    ];

    const cast = sciCast(scripts);
    expect(cast.map((member) => member.name)).toEqual(['rosella']);
    expect(cast[0]).toMatchObject({ script: 100, through: 'Actor', depth: 1 });
  });

  it('leaves out everything whose chain never reaches a cast class', () => {
    const scripts = [
      script(0, [
        object({ name: 'Actor', isClass: true, species: 2, superClass: 1 }),
        object({ name: 'Prop', isClass: true, species: 5, superClass: 1 }),
      ]),
      script(100, [
        object({ name: 'rosella', species: 2, superClass: 2 }),
        object({ name: 'aDoor', species: 5, superClass: 5 }),
      ]),
    ];
    expect(sciCast(scripts).map((member) => member.name)).toEqual(['rosella']);
  });

  /** A class is what makes a cast member, not one itself. */
  it('never lists a class definition as a member of the cast', () => {
    const scripts = [
      script(0, [
        object({ name: 'Actor', isClass: true, species: 2, superClass: 1 }),
        object({ name: 'KQEgo', isClass: true, species: 30, superClass: 2 }),
      ]),
    ];
    expect(sciCast(scripts)).toEqual([]);
  });

  /** A `-super-` that points back at itself must not spin. */
  it('stops on a chain that loops rather than walking forever', () => {
    const scripts = [
      script(0, [
        object({ name: 'Loop', isClass: true, species: 7, superClass: 8 }),
        object({ name: 'Back', isClass: true, species: 8, superClass: 7 }),
      ]),
      script(1, [object({ name: 'thing', species: 7, superClass: 7 })]),
    ];
    expect(sciCast(scripts)).toEqual([]);
  });

  it('orders by script, then by name', () => {
    const scripts = [
      script(0, [object({ name: 'Actor', isClass: true, species: 2, superClass: 1 })]),
      script(200, [object({ name: 'zoe', species: 2, superClass: 2 })]),
      script(100, [
        object({ name: 'valenice', species: 2, superClass: 2 }),
        object({ name: 'rosella', species: 2, superClass: 2 }),
      ]),
    ];
    expect(sciCast(scripts).map((member) => `${member.script}:${member.name}`)).toEqual([
      '100:rosella',
      '100:valenice',
      '200:zoe',
    ]);
  });
});

describe('the header says which kind of empty an empty cast is', () => {
  it('names the classes the answer came through', () => {
    const scripts = [
      script(0, [object({ name: 'Actor', isClass: true, species: 2, superClass: 1 })]),
      script(100, [object({ name: 'rosella', species: 2, superClass: 2 })]),
    ];
    expect(describeSciCast(scripts, sciCast(scripts))).toBe('1 derived by class chain from Actor');
  });

  /**
   * The distinction that matters to a reader looking at an empty section: a
   * game with no actors is not the same fact as a game this project cannot
   * derive a cast from.
   */
  it('tells a game with no actors from a release that names no classes', () => {
    const named = [
      script(0, [object({ name: 'Prop', isClass: true, species: 5, superClass: 1 })]),
      script(100, [object({ name: 'aDoor', species: 5, superClass: 5 })]),
    ];
    expect(describeSciCast(named, sciCast(named))).toContain('no object in this game');

    const unnamed = [
      script(0, [object({ name: '', isClass: true, species: 5, superClass: 1 })]),
      script(100, [object({ name: '', species: 5, superClass: 5 })]),
    ];
    expect(describeSciCast(unnamed, sciCast(unnamed))).toContain('names no classes');
  });
});
