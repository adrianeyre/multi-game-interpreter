/**
 * A SCI room, derived from the game rather than typed in.
 *
 * ## What a SCI room is, and why this file exists
 *
 * A SCUMM room is a resource: open it and the objects in it are *in* it, with
 * their positions, their names and their scripts. That is the shape
 * `docs/editor-parity.md` rows 5 to 8 were written against, and SCI has
 * nothing of the kind. A SCI room is three things that no single resource
 * holds together:
 *
 * - a **Script resource**, which defines a subclass of `Room` and the
 *   instances the room puts on screen;
 * - a **Picture**, named by a property on that room instance and living in its
 *   own resource, shared with whatever other room cares to name it;
 * - a **cast assembled at run time**, by `init` calling `addToPic` and friends
 *   on instances the script may or may not have declared statically.
 *
 * ADR 0013's standard is the same capability in the family's own terms and
 * never a pretend SCUMM room, so this file does **not** invent a room record.
 * It derives a *view* over the two resources that hold the authored state, and
 * it is keyed by the **Script number** — which is what SCI itself keys a room
 * by, since `newRoom` takes a script number and the interpreter loads the
 * Script resource to find out what the room is. ADR 0037 records that decision
 * and the two alternatives rejected.
 *
 * ## What this can and cannot see
 *
 * It reads the **authored** state: the property words as the resource ships
 * them. That is exactly the state an author can edit and an export can write
 * back, and it is the reason this is a useful surface at all.
 *
 * It cannot see the run-time cast, because that is the result of running the
 * game. An instance whose `x` is assigned by `init` rather than declared in
 * its property words ships as whatever the class default was, and this surface
 * shows that default — which is the truth about the file, and is not where the
 * thing appears on screen when the game runs. `note` on each room says so
 * where it applies, rather than letting a drawn position imply a promise the
 * file does not make.
 *
 * ## Every Version, one derivation
 *
 * Nothing below reads a resource layout. It reads `SciProject`, which the
 * importer has already normalised across SCI0's block chain, SCI1.1's
 * code-and-heap pair and SCI3's markered objects — so a room derives wherever
 * objects and their property words do. That includes SCI3, where method bodies
 * are not disassembled at all (`importSciGame.ts`'s `methods: []`): a room is
 * made of properties, not of code, so rows 5 to 7 survive a Version where row
 * 21 does not.
 */

import type { SciProject, SciProjectObject, SciProjectScript } from '../project.js';
import { selectorIdCarriesReadWriteBit } from '../../engine/sci/sciVersion.js';

/** The class names SCI's own room base class ships under, across the family. */
const ROOM_CLASS_NAMES = new Set(['Room', 'Rm']);

/** How deep a class chain is walked before it is called a cycle. */
const CHAIN_LIMIT = 32;

/** One thing the room places, with the properties an author moves. */
export interface SciRoomThing {
  /** Index into the script's own `objects`, which is what an edit writes to. */
  objectIndex: number;
  name: string;
  /** Position in the script's own coordinate space, signed. */
  x: number;
  y: number;
  /** Which property word `x` and `y` are, so a drag knows what to write. */
  xProperty: number;
  yProperty: number;
  /** The View, loop and cel it wears, where its property words declare them. */
  view: number | null;
  loop: number;
  cel: number;
  /** Drawing order: higher draws later, and so hit-tests first. */
  priority: number | null;
  /**
   * Whether this thing's position can be written back.
   *
   * False for an object whose graph was read without recording where its
   * property words came from — it is drawn and hit-tested, and refused on the
   * drag, rather than being left off the room entirely.
   */
  movable: boolean;
  /**
   * Where a script sends the ego before acting on this thing, or null.
   *
   * `docs/editor-parity.md` row 8. SCI32's `Feature` carries `approachX` and
   * `approachY` as property words, and `approachVerbs` says which verbs use
   * them — so a thing's walk-to point is not in a `Polygon` and is not
   * computed: it is two words, in the same place and of the same kind as the
   * `x` and `y` a drag already writes.
   *
   * Null where the object declares neither, which is every SCI16 instance and
   * a great many SCI32 ones. Null and "the point is 0, 0" are different facts
   * and the surface keeps them apart.
   */
  approach: { x: number; y: number; xProperty: number; yProperty: number } | null;
}

/** One room: a Script, the Picture it names, and what it places. */
export interface SciRoom {
  /** The Script resource number, which is what SCI calls this room. */
  script: number;
  /** The room instance's own name, as the game recorded it. */
  name: string;
  /**
   * The Picture this room's own `picture` property names, or null.
   *
   * Null is ordinary rather than a fault: a room that composes its screen in
   * `init`, or one that is a menu over whatever was already there, declares no
   * picture. `note` says which.
   */
  picture: number | null;
  things: SciRoomThing[];
  /** What this room does not show, in words, or null when nothing is missing. */
  note: string | null;
}

/**
 * What a property word is called, the one place it is decided.
 *
 * An instance carries no Selector table of its own from SCI1.1 on — only a
 * class does — and the importer copies its class's down onto it, so most
 * objects have names. Where nothing named one, the number is given as a number
 * and labelled as such rather than dressed up as a Selector it is not.
 *
 * **SCI0 early spent the low bit of a Selector ID on a read/write toggle**, so
 * the ID in a class's property table is twice the index into the shipped
 * `vocab.997`. Reading it raw there names every property two slots along —
 * `x` comes out as whatever Selector 2 happens to be. That shift is applied
 * here, in the one function that turns a number into a name, so that the
 * properties table, the room surface and anything else added later cannot
 * disagree about it.
 */
export function sciPropertyName(
  object: SciProjectObject,
  index: number,
  project: SciProject,
): string {
  const selector = object.variableSelectors[index];
  if (selector === undefined) return `property ${index}`;
  const at =
    project.version && selectorIdCarriesReadWriteBit(project.version) ? selector >> 1 : selector;
  return project.selectors[at] ?? `selector ${selector}`;
}

/** A property word as a signed 16-bit number, which is how SCI reads a coordinate. */
export function sciSignedWord(value: number): number {
  return value >= 0x8000 ? value - 0x10000 : value;
}

/** Every room this game declares, in Script order. */
export function sciRooms(project: SciProject): SciRoom[] {
  const classes = new Map<number, SciProjectObject>();
  for (const script of project.scripts) {
    for (const object of script.objects) {
      if (object.isClass) classes.set(object.species, object);
    }
  }

  const rooms: SciRoom[] = [];
  for (const script of project.scripts) {
    const room = script.objects.find(
      (object) => !object.isClass && descendsFromRoom(object, classes),
    );
    if (!room) continue;
    rooms.push(readRoom(script, room, project));
  }
  return rooms;
}

/** True when this object's class chain reaches SCI's own `Room`. */
function descendsFromRoom(
  object: SciProjectObject,
  classes: Map<number, SciProjectObject>,
): boolean {
  let at: number | undefined = object.superClass;
  for (let hops = 0; at !== undefined && hops < CHAIN_LIMIT; hops++) {
    const held = classes.get(at);
    if (!held) return false;
    if (ROOM_CLASS_NAMES.has(held.name)) return true;
    if (held.superClass === at) return false;
    at = held.superClass;
  }
  return false;
}

function readRoom(script: SciProjectScript, room: SciProjectObject, project: SciProject): SciRoom {
  const picture = propertyValue(room, 'picture', project);
  const things: SciRoomThing[] = [];
  let unmovable = 0;

  for (const [objectIndex, object] of script.objects.entries()) {
    if (object.isClass || object === room) continue;
    const xProperty = propertyIndex(object, 'x', project);
    const yProperty = propertyIndex(object, 'y', project);
    // Both, because a thing with one coordinate has no position — and the
    // pair is what a drag writes.
    if (xProperty < 0 || yProperty < 0) continue;

    const movable = object.variablesAt !== undefined;
    if (!movable) unmovable++;
    things.push({
      objectIndex,
      name: object.name,
      x: sciSignedWord(object.variables[xProperty] ?? 0),
      y: sciSignedWord(object.variables[yProperty] ?? 0),
      xProperty,
      yProperty,
      view: viewNumber(propertyValue(object, 'view', project)),
      loop: propertyValue(object, 'loop', project) ?? 0,
      cel: propertyValue(object, 'cel', project) ?? 0,
      priority: propertyValue(object, 'priority', project),
      movable,
      approach: approachPoint(object, project),
    });
  }

  // Later draws over earlier, which is how a Plane occludes (ADR 0015), so a
  // thing with no priority of its own keeps the order its script declared it
  // in rather than being sorted to the front.
  things.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.objectIndex - b.objectIndex);

  return {
    script: script.number,
    name: room.name,
    picture: picture === null || picture === 0xffff || picture === 0 ? null : picture,
    things,
    note: roomNote(picture, things.length, unmovable),
  };
}

/**
 * A View number, or null where the word is a placeholder rather than a View.
 *
 * `0xffff` is SCI's own "none" and `0` is the class default an instance that
 * never declared one ships with. Neither is a resource, and drawing the game's
 * View 0 for every undeclared prop would put art on the screen that the game
 * never puts there.
 */
function viewNumber(value: number | null): number | null {
  if (value === null || value === 0 || value === 0xffff) return null;
  return value;
}

function roomNote(picture: number | null, things: number, unmovable: number): string | null {
  const parts: string[] = [];
  if (picture === null || picture === 0xffff || picture === 0) {
    parts.push(
      'This room declares no Picture of its own, so there is no backdrop to draw. Rooms ' +
        'that compose their screen as they run, and rooms drawn over whatever was already ' +
        'there, are both ordinary in SCI.',
    );
  }
  if (things === 0) {
    parts.push(
      'No object in this script declares both an x and a y, so there is nothing placed to ' +
        'draw. A room whose cast is built by its own init has its positions in code rather ' +
        'than in property words.',
    );
  }
  if (unmovable > 0) {
    parts.push(
      `${unmovable} of these were read without recording where their property words came ` +
        'from, so they are drawn and hit-tested but cannot be moved.',
    );
  }
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The index of a named property on an object, or -1. */
function propertyIndex(object: SciProjectObject, name: string, project: SciProject): number {
  for (let index = 0; index < object.variables.length; index++) {
    if (sciPropertyName(object, index, project) === name) return index;
  }
  return -1;
}

/**
 * A thing's walk-to point, or null where it declares none.
 *
 * Both words or neither, for the reason a position needs both: a thing with one
 * coordinate has no point, and offering to edit half of one would write a
 * number the game never reads.
 */
function approachPoint(
  object: SciProjectObject,
  project: SciProject,
): { x: number; y: number; xProperty: number; yProperty: number } | null {
  const xProperty = propertyIndex(object, 'approachX', project);
  const yProperty = propertyIndex(object, 'approachY', project);
  if (xProperty < 0 || yProperty < 0) return null;
  return {
    x: sciSignedWord(object.variables[xProperty] ?? 0),
    y: sciSignedWord(object.variables[yProperty] ?? 0),
    xProperty,
    yProperty,
  };
}

/** The value of a named property, or null where the object declares none. */
export function sciPropertyValue(
  object: SciProjectObject,
  name: string,
  project: SciProject,
): number | null {
  return propertyValue(object, name, project);
}

function propertyValue(object: SciProjectObject, name: string, project: SciProject): number | null {
  const index = propertyIndex(object, name, project);
  return index < 0 ? null : (object.variables[index] ?? null);
}
