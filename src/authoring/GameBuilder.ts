import { Assembler } from './Assembler.js';
import type { IndexedImage } from './ImageEncoder.js';
import type { CostumeDefinition } from './CostumeBuilder.js';

export interface Point {
  x: number;
  y: number;
}

/**
 * A walk box: a convex quadrilateral the actors are allowed to stand in.
 *
 * Four independent corners, not a rectangle. That is what the format stores and
 * it is how the original games fit a floor — a receding corridor is a trapezoid,
 * a sloping path a slanted quad. Areas that are not convex are built from
 * several boxes side by side, which the router already walks between.
 *
 * Corner order matters: upper-left, upper-right, lower-right, lower-left. The
 * engine's containment test walks the edges in that order.
 */
export interface BoxDefinition {
  ul: Point;
  ur: Point;
  lr: Point;
  ll: Point;
  /** A fixed size, 1-255. Ignored when `perspective` is set. */
  scale?: number;
  /**
   * Scales with the room's perspective ramp rather than staying one size.
   *
   * Off by default, so a balcony or a boat deck can keep a fixed size while the
   * floor around it recedes.
   */
  perspective?: boolean;
  /** Which z-plane occludes actors standing here. 0 means none. */
  mask?: number;
  /** Excluded from routing when true. */
  blocked?: boolean;
}

/** Builds a box from a rectangle, for the common axis-aligned case. */
export function rectangleBox(
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Partial<Omit<BoxDefinition, 'ul' | 'ur' | 'lr' | 'll'>> = {},
): BoxDefinition {
  const right = x + width - 1;
  const bottom = y + height - 1;
  return {
    ul: { x, y },
    ur: { x: right, y },
    lr: { x: right, y: bottom },
    ll: { x, y: bottom },
    ...extra,
  };
}

/** Axis-aligned bounds of a box, for hit tests and the inspector. */
export function boxBounds(box: BoxDefinition): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const xs = [box.ul.x, box.ur.x, box.lr.x, box.ll.x];
  const ys = [box.ul.y, box.ur.y, box.lr.y, box.ll.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 };
}

/** Moves every corner by the same amount. */
export function translateBox(box: BoxDefinition, dx: number, dy: number): BoxDefinition {
  const move = (point: Point): Point => ({ x: point.x + dx, y: point.y + dy });
  return { ...box, ul: move(box.ul), ur: move(box.ur), lr: move(box.lr), ll: move(box.ll) };
}

/**
 * True if the four corners form a convex quadrilateral.
 *
 * The engine's containment test asks whether a point lies on the inner side of
 * every edge, which only answers correctly for convex shapes. A concave box
 * reports parts of itself as outside, and actors refuse to walk there — so it
 * is worth telling the author rather than letting them wonder.
 */
export function isConvexBox(box: BoxDefinition): boolean {
  const corners = [box.ul, box.ur, box.lr, box.ll];
  let positive = false;
  let negative = false;

  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const c = corners[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
  }

  // A zero cross product means collinear corners, which is fine: a box
  // flattened to a line is a legitimate narrow corridor.
  return !(positive && negative);
}

export interface ObjectDefinition {
  /** Globally unique, and stable across builds — saved games key off it. */
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the player stands to interact. Defaults to below the object. */
  walkTo?: { x: number; y: number };
  /** Which way the player faces on arrival. */
  facing?: 'north' | 'east' | 'south' | 'west';
  /** One image per state; state 1 draws `states[0]`. */
  states?: IndexedImage[];
  /** Starting state. 0 means "not drawn". */
  initialState?: number;
  /** Actor number carrying it at the start. The room owns it by default. */
  owner?: number;
  /** Class flags to set initially. */
  classes?: number[];
}

/** A verb handler attached to an object. */
interface VerbHandler {
  verbId: number;
  body: (script: Assembler) => void;
}

export class ObjectBuilder {
  readonly definition: ObjectDefinition;
  readonly handlers: VerbHandler[] = [];
  /** Runs for any verb with no specific handler. */
  defaultHandler: ((script: Assembler) => void) | null = null;

  constructor(definition: ObjectDefinition) {
    this.definition = definition;
  }

  /**
   * Attaches code to a verb.
   *
   * The body receives an assembler; whatever it emits becomes the object's
   * verb script, and the compiler appends the `stop` for you.
   */
  on(verbId: number, body: (script: Assembler) => void): this {
    this.handlers.push({ verbId, body });
    return this;
  }

  /** Runs when no `on` handler matches — the "that doesn't work" response. */
  otherwise(body: (script: Assembler) => void): this {
    this.defaultHandler = body;
    return this;
  }
}

/**
 * How an actor's size varies with depth.
 *
 * SCUMM interpolates between two screen rows: the far edge of the floor, where
 * the character is smallest, and the near edge, where it is largest. Without
 * one, a character is the same size wherever it stands and the room reads flat.
 */
export interface ScaleRamp {
  /** Screen row where the character is smallest. */
  farY: number;
  /** Size there, 1-255, where 255 is full size. */
  farScale: number;
  /** Screen row where the character is largest. */
  nearY: number;
  nearScale: number;
}

export interface RoomDefinition {
  id: number;
  name?: string;
  width?: number;
  height?: number;
  background: IndexedImage;
  /** 1-bit occlusion masks, `width * height` each. */
  zPlanes?: Uint8Array[];
  boxes?: BoxDefinition[];
  /** Perspective for boxes that opt in. */
  perspective?: ScaleRamp;
  /** Palette for the room; falls back to the game palette. */
  palette?: number[][];
}

export class RoomBuilder {
  readonly definition: RoomDefinition;
  readonly objects: ObjectBuilder[] = [];
  entryScript: ((script: Assembler) => void) | null = null;
  exitScript: ((script: Assembler) => void) | null = null;
  /** Scripts that belong to this room, addressed by id from anywhere in it. */
  readonly localScripts: Array<{ id: number; body: (script: Assembler) => void }> = [];

  constructor(definition: RoomDefinition) {
    this.definition = definition;
  }

  object(definition: ObjectDefinition): ObjectBuilder {
    const builder = new ObjectBuilder(definition);
    this.objects.push(builder);
    return builder;
  }

  /** Runs every time the player enters this room. */
  onEnter(body: (script: Assembler) => void): this {
    this.entryScript = body;
    return this;
  }

  /** Runs every time the player leaves. */
  onExit(body: (script: Assembler) => void): this {
    this.exitScript = body;
    return this;
  }

  /**
   * A script belonging to this room, started by id.
   *
   * SCUMM numbers these from 200 and keeps them inside the room resource, so
   * they load and unload with it. A room's own entry script routinely starts
   * one to set the scene up — placing the cast, opening a door somebody left
   * open — and a room brought across without them enters, starts a script that
   * is not there, and sets nothing up at all.
   */
  localScript(id: number, body: (script: Assembler) => void): this {
    this.localScripts.push({ id, body });
    return this;
  }
}

export interface ActorDefinition {
  /** 1 is conventionally the player character. */
  id: number;
  name: string;
  /**
   * Where this actor starts.
   *
   * Actors exist globally but are only drawn in the room they are placed in, so
   * anyone without a start is present in the game and visible nowhere.
   */
  start?: { room: number; x: number; y: number };
  costume?: CostumeDefinition;
  /**
   * The resource id to write this actor's costume under.
   *
   * Normally nobody cares: the compiler numbers costumes as it writes them and
   * the boot script tells each actor which one it wears. It matters for a game
   * imported from a published one, whose own scripts change costumes by number
   * — those numbers are the published game's, and a costume renumbered on the
   * way in leaves every such script dressing an actor in a costume that is not
   * there.
   */
  costumeId?: number;
  talkColor?: number;
  /** Pixels per frame. Defaults to a brisk walk. */
  walkSpeed?: { x: number; y: number };
}

export interface VerbDefinition {
  id: number;
  text: string;
  x: number;
  y: number;
  color?: number;
  hiColor?: number;
  /** Keyboard shortcut. */
  key?: string;
}

export interface GameOptions {
  name: string;
  /** 256 RGB triples, 0-255 per channel. A default is supplied. */
  palette?: number[][];
  /** Where the player starts. */
  start: { room: number; x: number; y: number };
  /** Screen split: text band height and the top of the verb panel. */
  screen?: { textHeight: number; verbTop: number };
  /** Shown when a verb has no handler. */
  defaultResponse?: string;
}

/**
 * The authoring surface.
 *
 * Rooms, objects, actors and verbs are declared here and compiled to a real
 * SCUMM v5 container. The engine that runs the result is the same one that runs
 * a commercial game — there is no separate "authored game" code path, which is
 * the whole point: if a game built here runs, the interpreter is correct.
 */
export class GameBuilder {
  readonly options: GameOptions;
  readonly rooms: RoomBuilder[] = [];
  readonly actors: ActorDefinition[] = [];
  /** Costumes copied through verbatim, keyed by the id they must keep. */
  readonly rawCostumes: Array<{ id: number; bytes: Uint8Array }> = [];
  readonly verbs: VerbDefinition[] = [];
  readonly scripts: Array<{ id: number; body: (script: Assembler) => void }> = [];

  constructor(options: GameOptions) {
    this.options = options;
  }

  room(definition: RoomDefinition): RoomBuilder {
    if (definition.id < 1) {
      throw new RangeError('Room 0 is reserved; room ids start at 1');
    }
    if (this.rooms.some((room) => room.definition.id === definition.id)) {
      throw new Error(`Room ${definition.id} is already defined`);
    }
    const builder = new RoomBuilder(definition);
    this.rooms.push(builder);
    return builder;
  }

  actor(definition: ActorDefinition): this {
    this.actors.push(definition);
    return this;
  }

  /**
   * A costume written out exactly as given, under a fixed id.
   *
   * For costumes that arrive already in the interpreter's own format — from a
   * published game — and belong to no actor the project can hold. Nothing here
   * inspects them; they are placed and numbered, and the game's scripts do the
   * rest.
   */
  rawCostume(id: number, bytes: Uint8Array): this {
    this.rawCostumes.push({ id, bytes });
    return this;
  }

  verb(definition: VerbDefinition): this {
    if (definition.id < 1) throw new RangeError('Verb 0 is the sentence line; ids start at 1');
    this.verbs.push(definition);
    return this;
  }

  /**
   * A named global script, callable with `startScript`.
   *
   * Ids below 10 are reserved for the generated boot, sentence and verb
   * scripts, so user scripts start at 10.
   */
  script(id: number, body: (script: Assembler) => void): this {
    if (id < 10) throw new RangeError('Global script ids 0-9 are reserved; use 10 or above');
    this.scripts.push({ id, body });
    return this;
  }

  /** Every object across every room, for building the global object table. */
  allObjects(): ObjectBuilder[] {
    return this.rooms.flatMap((room) => room.objects);
  }
}

export function defineGame(options: GameOptions): GameBuilder {
  return new GameBuilder(options);
}
