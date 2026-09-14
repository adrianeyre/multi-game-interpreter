/**
 * A SCI room's walkable area, which is not a resource and is in its own code.
 *
 * `docs/editor-parity.md` row 11, whose No said the true half and stopped one
 * step short of the consequence. SCI keeps routing in two places and neither is
 * a record this project could list:
 *
 * - **before SCI2** the walkable area is a *colour* — the control buffer's
 *   index at a pixel is what `kCanBeHere` tests — and that is still not
 *   listable, because it is a property of the pixels;
 * - **from SCI2** rooms add `Polygon` objects, and a polygon is built by the
 *   room's own code as it runs.
 *
 * The second half is the one this file is about, and "built as it runs" was
 * read as "cannot be read". It is the same shape as Broken Sword II's mouse
 * boxes (`docs/editor-parity.md` 7a): the object pushes the answer itself, as
 * literals, in the instruction stream this project already decodes.
 *
 * ## The shape, from King's Quest VII's `pyramidDoor`
 *
 * ```
 * pushi setPolygon  push1
 *   pushi type      push1  push0            ; type: 0
 *   pushi init      pushi 8                 ; init: with eight arguments
 *     pushi 876  pushi 79
 *     pushi 875  pushi 29
 *     pushi 920  pushi 27
 *     pushi 919  pushi 82                   ; four points
 *   pushi yourself  push0
 *   pushi new       push0
 *   class 34                                ; the Polygon class
 *   send 4                                  ; (Polygon new:)
 *   send 30                                 ; type:, init:, yourself:
 * ```
 *
 * So the derivation is: find a `class` naming `Polygon`, walk **back** over the
 * argument block that was pushed for it, and read the run between `init` and
 * `yourself` as x and y pairs. Nothing is guessed and nothing is executed.
 *
 * ## What is refused, and why by name
 *
 * A coordinate that is not a literal `pushi` is refused, with the object named,
 * for the reason 7a gives: there is no number in the script to change, so an
 * editor offering to move the point would be offering to move nothing. A
 * polygon assembled through a variable, a loop or a second method is the same
 * case. An empty list and "this room computes its polygons" are different
 * facts.
 *
 * **Matched by class name, never by species number** — the rule `sciCast`
 * states and for the same reason: `Polygon` is one number in one release and
 * another in the next, and the game ships `vocab.996` and its own names.
 */

import type { SciProject, SciProjectObject } from '../project.js';
import { sciSignedWord } from './sciRooms.js';

/** The class whose instances are walk polygons, by the name Sierra gives it. */
const POLYGON_CLASS = 'Polygon';

/** How far up a `-super-` chain to look before calling it corrupt. */
const CHAIN_LIMIT = 16;

/**
 * SCI's own polygon kinds (`polygon.sc`), by the number in `type`.
 *
 * Named rather than numbered on the surface, because "type 1" tells an author
 * nothing and "the ego may not enter this" tells them what the shape does.
 */
const POLYGON_TYPES: Readonly<Record<number, string>> = {
  0: 'total access — the ego may walk anywhere inside it',
  1: 'nearest access — the ego walks to the edge and stops',
  2: 'barred access — the ego may not enter it',
  3: 'contained access — the ego may not leave it',
};

/** One point of a polygon, and where in the script each of its two words is. */
export interface SciPolygonPoint {
  x: number;
  y: number;
  /** The instruction that pushes x, by index in the method, so an edit lands. */
  xInstruction: number;
  yInstruction: number;
}

/** One polygon a room's own code builds. */
export interface SciPolygon {
  /** The Script resource the room is in. */
  script: number;
  /** The object whose method builds it, which is what an author recognises. */
  owner: string;
  /** Which object in that script, by index, for the pane that opens it. */
  objectIndex: number;
  /** Which method of it, by index. */
  methodIndex: number;
  type: number;
  typeName: string;
  points: SciPolygonPoint[];
}

/** A polygon this project found and will not offer to edit, and why. */
export interface SciPolygonRefusal {
  script: number;
  owner: string;
  why: string;
}

export interface SciPolygonsResult {
  polygons: SciPolygon[];
  refused: SciPolygonRefusal[];
}

/**
 * Every walk polygon this game's own code states as literals.
 *
 * Scripts are walked once, so this is linear in instructions rather than in
 * rooms times instructions.
 */
export function sciPolygons(project: SciProject): SciPolygonsResult {
  const polygonSpecies = polygonClassNumbers(project);
  const polygons: SciPolygon[] = [];
  const refused: SciPolygonRefusal[] = [];
  if (polygonSpecies.size === 0) return { polygons, refused };

  const selectorOf = new Map<string, number>();
  for (const [number, name] of project.selectors.entries()) {
    if (!selectorOf.has(name)) selectorOf.set(name, number);
  }
  const initSelector = selectorOf.get('init');
  const typeSelector = selectorOf.get('type');
  if (initSelector === undefined || typeSelector === undefined) return { polygons, refused };

  for (const script of project.scripts) {
    for (const [objectIndex, object] of script.objects.entries()) {
      for (const [methodIndex, method] of (object.methods ?? []).entries()) {
        const found = polygonsInMethod(
          method.instructions ?? [],
          polygonSpecies,
          initSelector,
          typeSelector,
        );
        for (const one of found.polygons) {
          polygons.push({
            script: script.number,
            owner: object.name,
            objectIndex,
            methodIndex,
            type: one.type,
            typeName: POLYGON_TYPES[one.type] ?? `type ${one.type}, which SCI does not name`,
            points: one.points,
          });
        }
        for (const why of found.refused) {
          refused.push({ script: script.number, owner: object.name, why });
        }
      }
    }
  }
  return { polygons, refused };
}

/** Every class number whose chain reaches a class named `Polygon`. */
function polygonClassNumbers(project: SciProject): Set<number> {
  const classes = new Map<number, SciProjectObject>();
  for (const script of project.scripts) {
    for (const object of script.objects) {
      if (object.isClass) classes.set(object.species, object);
    }
  }
  const numbers = new Set<number>();
  for (const [number, held] of classes) {
    if (held.name === POLYGON_CLASS) {
      numbers.add(number);
      continue;
    }
    let at: number | undefined = held.superClass;
    for (let hops = 0; at !== undefined && hops < CHAIN_LIMIT; hops++) {
      const above = classes.get(at);
      if (!above) break;
      if (above.name === POLYGON_CLASS) {
        numbers.add(number);
        break;
      }
      if (above.superClass === at) break;
      at = above.superClass;
    }
  }
  return numbers;
}

interface Instruction {
  name: string;
  operands: number[];
}

/**
 * The polygons one method builds, read out of its instruction stream.
 *
 * Anchored on `class`, because that is the one instruction that names the
 * Polygon class by number — the pushes before it are an argument block whose
 * meaning is only settled by what it is sent to.
 *
 * **Read backwards from the `class`, never found by searching for a selector.**
 * A selector number and a coordinate are the same kind of word, so a search for
 * `pushi <init>` finds the *point* whose x happens to equal `init`'s number
 * before it finds the send — which on a polygon whose first coordinate is 1 and
 * whose `init` is selector 1 silently reads a three-point shape as a one-point
 * one. Walking back over a block whose shape is fixed cannot make that mistake:
 *
 * ```
 *   pushi type   push1   <type>
 *   pushi init   pushi <2n>   <2n coordinate pushes>
 *   pushi yourself push0
 *   pushi new      push0
 *   class <Polygon>
 * ```
 *
 * so the four instructions before the `class` are known, the coordinates are
 * the run before those, and the `pushi <2n>` that closes the run is confirmed
 * by the count it states matching the run's own length and by the `pushi init`
 * in front of it.
 */
function polygonsInMethod(
  instructions: readonly Instruction[],
  species: ReadonlySet<number>,
  initSelector: number,
  typeSelector: number,
): { polygons: Array<{ type: number; points: SciPolygonPoint[] }>; refused: string[] } {
  const polygons: Array<{ type: number; points: SciPolygonPoint[] }> = [];
  const refused: string[] = [];

  for (const [index, instruction] of instructions.entries()) {
    if (instruction.name !== 'class') continue;
    if (!species.has(instruction.operands[0])) continue;

    // `pushi yourself push0 pushi new push0` — the tail every one of these
    // blocks ends with. Anything else is a Polygon made some other way.
    const afterPoints = index - 4;
    if (afterPoints < 0 || !isLiteralPush(instructions[afterPoints])) {
      refused.push(
        'builds a Polygon some way other than the type-init-yourself block this reader ' +
          'knows, so its points are not a fixed list here.',
      );
      continue;
    }

    // Back over the coordinate pushes to the `pushi <count>` that opened them.
    let initAt = -1;
    let coordinates = 0;
    for (let at = afterPoints - 1; at >= 1; at--) {
      const stated = literalAt(instructions, at);
      if (stated === coordinates && coordinates > 0 && coordinates % 2 === 0) {
        const before = instructions[at - 1];
        if (isLiteralPush(before) && before.operands[0] === initSelector) {
          initAt = at - 1;
          break;
        }
      }
      if (literalAt(instructions, at) === null) break;
      coordinates++;
    }

    if (initAt < 0) {
      refused.push(
        'computes at least one of its polygon coordinates rather than writing it as a ' +
          'literal, so there is no number in the script to change.',
      );
      continue;
    }

    const points: SciPolygonPoint[] = [];
    for (let pair = 0; pair < coordinates / 2; pair++) {
      const xAt = initAt + 2 + pair * 2;
      const yAt = xAt + 1;
      points.push({
        x: sciSignedWord(literalAt(instructions, xAt) ?? 0),
        y: sciSignedWord(literalAt(instructions, yAt) ?? 0),
        xInstruction: xAt,
        yInstruction: yAt,
      });
    }

    // `pushi type push1 <value>` sits immediately in front of the init, where
    // the script wrote one. A polygon that states no type is SCI's own default
    // of total access.
    const typeAt = initAt - 3;
    const type =
      typeAt >= 0 &&
      isLiteralPush(instructions[typeAt]) &&
      instructions[typeAt].operands[0] === typeSelector
        ? (literalAt(instructions, initAt - 1) ?? 0)
        : 0;
    polygons.push({ type, points });
  }

  return { polygons, refused };
}

/**
 * The number an instruction pushes, or null when it does not push a literal.
 *
 * `push0`, `push1` and `push2` are SCI's own short forms and are literals as
 * much as `pushi` is — a polygon with a `type` of 0 is written `push0`, and a
 * reader that only knew `pushi` would refuse every total-access polygon in the
 * game.
 */
function literalAt(instructions: readonly Instruction[], at: number): number | null {
  const one = instructions[at];
  if (!one) return null;
  if (one.name === 'push0') return 0;
  if (one.name === 'push1') return 1;
  if (one.name === 'push2') return 2;
  if (isLiteralPush(one)) return one.operands[0];
  return null;
}

/** `pushi`, in either operand width. */
function isLiteralPush(one: Instruction | undefined): one is Instruction {
  return one !== undefined && one.name === 'pushi' && one.operands.length > 0;
}

/** What the surface says about a room's polygons, counted rather than asserted. */
export function describeSciPolygons(result: SciPolygonsResult, script?: number): string {
  const mine =
    script === undefined ? result.polygons : result.polygons.filter((one) => one.script === script);
  const refusedHere =
    script === undefined ? result.refused : result.refused.filter((one) => one.script === script);

  if (mine.length === 0 && refusedHere.length === 0) {
    return (
      'This room states no walk polygon its own code writes as literal coordinates. Before ' +
      'SCI2 a walkable area is a colour in the Picture’s control buffer and not a shape at ' +
      'all; from SCI2 a room may still build its polygons from computed numbers, or have none.'
    );
  }

  const points = mine.reduce((sum, one) => sum + one.points.length, 0);
  const parts = [
    `${mine.length} walk ${mine.length === 1 ? 'polygon' : 'polygons'}, ${points} ` +
      `${points === 1 ? 'point' : 'points'}, read from the coordinates this room’s own code ` +
      `pushes as literals.`,
  ];
  if (refusedHere.length > 0) {
    parts.push(
      `${refusedHere.length} more could not be read: ${[...new Set(refusedHere.map((one) => one.owner))].join(', ')}.`,
    );
  }
  return parts.join(' ');
}
