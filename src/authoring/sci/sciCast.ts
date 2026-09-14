/**
 * A SCI game's cast, which is a question about the class graph.
 *
 * **SCI is the one family here with no cast table**, and `docs/editor-parity.md`
 * row 13 is where that shows. SCUMM has actors; a Sword 1 compact declares
 * `o_type` `MEGA`; a Sword II object calls a mega opcode. A SCI game declares
 * nothing — what plays an actor is **class membership**, an object whose
 * superclass chain reaches `Actor`, and King's Quest VII's 2,821 objects
 * include every prop, door, sound and inventory item alongside its people.
 *
 * So the cast is derived rather than read, and derived from the graph this
 * project already walks: `nameInstanceProperties` climbs exactly these
 * `-super-` links to name 96,384 property words. This groups the same walk's
 * result instead of re-deriving it.
 *
 * **Named classes rather than a species number, because the number is the
 * game's and not the family's.** `Actor` is species 2 in one release and
 * something else in the next, so a number here would be a per-title table —
 * which is the thing `CONTEXT.md` says a SCI Target should not need, since the
 * game ships `vocab.996` and its own names. A release whose classes are
 * unnamed yields no cast, and says so, rather than yielding a wrong one.
 */

import type { SciProjectObject, SciProjectScript } from '../project.js';

/**
 * The class names whose descendants are cast.
 *
 * `Actor` is the one that matters and the other two are what Sierra's own
 * scripts put above and beside it: `Ego` is the player's own Actor in every
 * SCI game, and SCI32 renamed the base to `Prop`-and-`Actor` with `View` under
 * them. Matching by name at any depth means a game that subclasses three deep
 * — which King's Quest VII does — is still counted.
 */
const CAST_CLASSES = new Set(['Actor', 'Ego']);

/** One member of the cast, and where the editor can find it again. */
export interface SciCastMember {
  /** The Script resource the instance is defined in. */
  script: number;
  name: string;
  species: number;
  /** The named class its chain reached, so a reader can see why it is here. */
  through: string;
  /** How many `-super-` hops away that class was; 0 is the class itself. */
  depth: number;
  /** The object, for the pane that opens it. */
  object: SciProjectObject;
}

/**
 * Every instance whose class chain reaches a cast class.
 *
 * Instances only: a class definition is not a member of the cast, it is what
 * makes one. The chain is walked with a hop limit for the same reason
 * `nameInstanceProperties` uses one — a corrupt `-super-` must not spin.
 */
export function sciCast(scripts: readonly SciProjectScript[]): SciCastMember[] {
  const classes = new Map<number, SciProjectObject>();
  const scriptOf = new Map<number, number>();
  for (const script of scripts) {
    for (const object of script.objects) {
      if (!object.isClass) continue;
      classes.set(object.species, object);
      scriptOf.set(object.species, script.number);
    }
  }

  /** The named cast class this chain reaches, and how far up it was. */
  const reaches = (from: number): { through: string; depth: number } | null => {
    let at: number | undefined = from;
    for (let hops = 0; at !== undefined && hops < 32; hops++) {
      const held = classes.get(at);
      if (!held) return null;
      if (CAST_CLASSES.has(held.name)) return { through: held.name, depth: hops };
      at = held.superClass;
    }
    return null;
  };

  const cast: SciCastMember[] = [];
  for (const script of scripts) {
    for (const object of script.objects) {
      if (object.isClass) continue;
      const found = reaches(object.superClass);
      if (!found) continue;
      cast.push({
        script: script.number,
        name: object.name,
        species: object.species,
        through: found.through,
        depth: found.depth,
        object,
      });
    }
  }

  // By script, then by name, which is the order the sections beside this one
  // list their records in.
  cast.sort((a, b) => a.script - b.script || a.name.localeCompare(b.name));
  return cast;
}

/**
 * What the section header says, including when the answer is none.
 *
 * A game with no named classes cannot have a cast derived from it, and that is
 * a different fact from a game with no actors in it — the header says which,
 * because a reader looking at an empty section otherwise cannot tell.
 */
export function describeSciCast(
  scripts: readonly SciProjectScript[],
  cast: readonly SciCastMember[],
): string {
  if (cast.length > 0) {
    const classes = [...new Set(cast.map((member) => member.through))].sort().join(' and ');
    return `${cast.length} derived by class chain from ${classes}`;
  }

  const named = scripts.some((script) =>
    script.objects.some((object) => object.isClass && object.name !== ''),
  );
  return named
    ? 'none — no object in this game has a class chain reaching Actor or Ego'
    : 'none — this release names no classes, so a cast cannot be derived from it';
}
