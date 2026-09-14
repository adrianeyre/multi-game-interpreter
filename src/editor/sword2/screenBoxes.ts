/**
 * Where a Broken Sword II object *is*, read out of the object's own bytecode.
 *
 * ## Why this file exists, and what it replaces
 *
 * `docs/editor-parity.md` §7a used to say that a drag on a Sword II screen
 * "would have to guess an offset per object". Measured across the demo's 973
 * objects, that is not what the bytecode does. The offset is never guessed and
 * never has to be: the object pushes it itself.
 *
 * ```
 * CP_PUSH_INT32 340 ; CP_POP_LOCAL_VAR32 96    ; mouse.x1 = 340
 * CP_PUSH_INT32 275 ; CP_POP_LOCAL_VAR32 100   ; mouse.y1 = 275
 * CP_PUSH_INT32 475 ; CP_POP_LOCAL_VAR32 104   ; mouse.x2 = 475
 * CP_PUSH_INT32 405 ; CP_POP_LOCAL_VAR32 108   ; mouse.y2 = 405
 * CP_PUSH_LOCAL_ADDR 96 ; CP_CALL_MCODE fnRegisterMouse 1
 * ```
 *
 * The `CP_PUSH_LOCAL_ADDR` operand of the object's own `fnRegisterMouse` (or
 * `fnInitFloorMouse`) call *is* the `ObjectMouse` offset, as a literal in the
 * instruction stream, and the four `CP_PUSH_INT32` values written to `M+0`,
 * `M+4`, `M+8` and `M+12` are the rectangle. So the position is not in a table
 * because it is **in the code** — and the code is exactly what this project
 * already decompiles and re-emits byte-identically.
 *
 * §7a's *conclusion* was right for a sharper reason than the one it gave: all
 * 973 of the demo's variable blocks ship as zero bytes, so there is no position
 * in the shipped resource to read. Reading the script is not a workaround for
 * that; it is where the game itself keeps the answer.
 *
 * ## What is deliberately not followed
 *
 * Commit `0600015` set the rule and it holds here: **never follow an address or
 * a resource pushed from a variable**, because that number is decided at run
 * time and acting on it would move the wrong object. So:
 *
 * - a mouse pointer that arrives as `CP_PUSH_LOCAL_VAR32` is refused by name;
 * - a `CP_PUSH_DEREFERENCED_STRUCTURE` is never read as this object's offset —
 *   that token addresses the *running* object (`Sword2Interpreter`), which is
 *   usually George and not the object whose script it is;
 * - an object handing more than one `ObjectMouse` to its own registrations is
 *   refused rather than having one of them picked.
 *
 * `fnRegisterFrame` is excluded for a different reason worth naming: its mouse
 * pointer means "write the *sprite shape* to the mouse list", so the rectangle
 * is overwritten from the drawn frame's bounds every cycle
 * (`Sword2Engine.registerFrame`). Dragging those four words would change
 * nothing an author could see, so the four objects that do it are refused by
 * name instead.
 *
 * ## The standby point, which is a second thing and not a field of the first
 *
 * `fnSetStandbyCoords(x, y, dir)` is where Sword II says "stand here". It is
 * read the same way and written the same way — two `CP_PUSH_INT32` operands in
 * the object's own code — and it is **moved on its own**, by
 * `moveSword2Standby`, never by `moveSword2Box`. The two are separate because
 * the data says they are separate: measured over the demo, of the 57 movable
 * objects that set one literal point, 49 put it within 100px of their rectangle
 * on both axes and 8 put it as far as 636px away. See `Sword2ObjectBox.anchor`
 * and `docs/editor-parity.md` §8a.
 */

import { CP } from '../../engine/sword2/script/sword2Tokens.js';
import { sword2Calls, type Sword2Call } from '../../authoring/sword2/calls.js';
import { editSword2Operand } from '../../authoring/sword2/edits.js';
import type { Project } from '../../authoring/project.js';
import type { Sword2Project, Sword2ProjectObject } from '../../authoring/sword2/project.js';

/** How Revolution's own `// params:` blocks spell an `ObjectMouse` pointer. */
const MOUSE_POINTER = /mouse structure|ObjectMouse/i;

/** The opcodes whose mouse pointer means "this rectangle is my hit area". */
const REGISTERS_MOUSE: readonly string[] = ['fnRegisterMouse', 'fnInitFloorMouse'];

/** The opcode whose mouse pointer means "use my sprite's bounds instead". */
const REGISTERS_SPRITE_SHAPE = 'fnRegisterFrame';

/** The opcode that says where the player stands: `fnSetStandbyCoords(x, y, dir)`. */
const SETS_STANDBY = 'fnSetStandbyCoords';

/** `ObjectMouse`'s four coordinate words, in the order the structure holds them. */
const MOUSE_FIELDS = [
  { key: 'x1', at: 0 },
  { key: 'y1', at: 4 },
  { key: 'x2', at: 8 },
  { key: 'y2', at: 12 },
] as const;

/** One coordinate: its value, and every instruction that writes it. */
export interface Sword2BoxField {
  readonly value: number;
  /** Byte offsets of the `CP_PUSH_INT32`s that write it. All are rewritten. */
  readonly at: readonly number[];
}

/** An object whose rectangle this editor can read, and therefore move. */
export interface Sword2ObjectBox {
  readonly id: number;
  readonly name: string;
  /** The `ObjectMouse` offset the object's own registration pushes. */
  readonly offset: number;
  readonly x1: Sword2BoxField;
  readonly y1: Sword2BoxField;
  readonly x2: Sword2BoxField;
  readonly y2: Sword2BoxField;
  /**
   * The one literal `fnSetStandbyCoords` point this object sets, or null.
   *
   * Drawn, editable **on its own**, and deliberately not moved by a drag of the
   * rectangle. `fnSetStandbyCoords` is not a field of this rectangle: it writes
   * the router's three global standby words (`walker.cpp`'s
   * `_standbyX`/`_standbyY`/`_standbyDir`), which the walk and stand opcodes use
   * as their target only when the animation being played has a
   * `feetStartX`/`feetStartY` of (0,0). Every object that sets one sets it
   * immediately before its own such call, which is why it reads as "stand here
   * to use me".
   *
   * That it is not a *field* of the rectangle is a measurement and not a taste:
   * of the demo's 57 movable objects that set one literal point, 49 put it
   * within 100px of their rectangle on both axes and 8 put it as far as 636px
   * away (`exit_34`'s rectangle is at (0,190)-(90,399) and its point at
   * (726,192)). So the box drag leaves it alone — but "does not follow the box"
   * was never a reason for "cannot be moved", and `moveSword2Standby` writes
   * these two operands the same way `moveSword2Box` writes the other four.
   * `docs/editor-parity.md` §8a carries the same numbers.
   */
  readonly anchor: Sword2StandbyPoint | null;
  /**
   * Why this object's standby point cannot be moved, where it sets one anyway.
   *
   * Null both here and in `anchor` means the object sets no standby point at
   * all, which is not a refusal — 183 of the demo's 268 movable objects never
   * call the opcode. Set here means it does call it and this editor will not
   * follow the call: see `SWORD2_STANDBY_REFUSALS`.
   */
  readonly anchorWhy: string | null;
}

/** One `fnSetStandbyCoords` point, and where each operand is written. */
export interface Sword2StandbyPoint {
  readonly x: Sword2BoxField;
  readonly y: Sword2BoxField;
}

/** An object whose rectangle this editor will not move, and why. */
export interface Sword2BoxRefusal {
  readonly id: number;
  readonly name: string;
  /** A sentence, not a code: it is shown to the author as written. */
  readonly why: string;
}

/** The refusals, spelled once so the surface and the tests read the same words. */
export const SWORD2_BOX_REFUSALS = {
  noMouse:
    'registers no mouse area, so it has no rectangle on this screen — scenery drawn by ' +
    'fnRegisterFrame alone is placed by its animation’s own coordinates',
  fromVariable:
    'hands its mouse structure to fnRegisterMouse from a variable, so which structure it means ' +
    'is decided at run time and moving one would move the wrong thing',
  manyStructures:
    'registers more than one mouse structure, so there is no single rectangle to drag',
  spriteShape:
    'registers that rectangle through fnRegisterFrame, which overwrites it from the drawn ' +
    'sprite’s bounds every cycle, so moving it would change nothing',
  notLiteral:
    'computes at least one of its mouse coordinates rather than writing it as a constant, so ' +
    'there is no number in the script to change',
  manyValues:
    'writes its mouse coordinates more than one way, so the rectangle on screen depends on which ' +
    'branch ran and a drag would silently pick one',
} as const;

/**
 * The standby refusals, spelled once, in the same voice as the box's.
 *
 * `fromVariable` is commit `0600015`'s rule applied to a coordinate rather than
 * to a pointer, and it is written because the rule is the rule and not because
 * the demo needed it: one object trips it (`passing_train_72`, whose x and y
 * come from globals 141 and 142), and that object registers no mouse area, so
 * it never reaches a canvas at all. A rule only written when it fires is a rule
 * that fails the first time it matters.
 */
export const SWORD2_STANDBY_REFUSALS = {
  fromVariable:
    'pushes a standby coordinate from a variable, so where the player stands is decided at run ' +
    'time and there is no number in the script to change',
  notLiteral:
    'computes a standby coordinate rather than pushing it as a constant, so there is no number ' +
    'in the script to change',
  manyPoints:
    'sets more than one standby point, so where the player stands depends on which branch ran ' +
    'and moving one would silently pick it',
} as const;

/** The pushes that name a value decided at run time rather than a constant. */
const VARIABLE_PUSHES: ReadonlySet<string> = new Set(['localVar', 'globalVar', 'structure']);

/** Every `CP_PUSH_INT32 v; CP_POP_LOCAL_VAR32 off` pair in an object's code. */
function literalWrites(
  object: Sword2ProjectObject,
): Map<number, { values: Set<number>; at: number[] }> {
  const writes = new Map<number, { values: Set<number>; at: number[] }>();
  for (let index = 0; index < object.instructions.length; index++) {
    const instruction = object.instructions[index];
    if (instruction.token !== CP.POP_LOCAL_VAR32) continue;
    const before = object.instructions[index - 1];
    if (!before || before.token !== CP.PUSH_INT32) continue;
    const offset = instruction.operands[0];
    const write = writes.get(offset) ?? { values: new Set<number>(), at: [] };
    write.values.add(before.operands[0]);
    write.at.push(before.at);
    writes.set(offset, write);
  }
  return writes;
}

/**
 * The one literal standby point this object sets, or the reason there is none.
 *
 * Every `fnSetStandbyCoords` in the object is read, not the first: an object
 * that sets the same point in two branches is one point and moves as one, and
 * an object that sets two *different* points is refused rather than having one
 * of them picked. Taking the first and passing over the rest would have drawn a
 * handle that moved one of an object's two answers and left the other, which is
 * the failure this whole file is written against.
 */
function standbyPoint(calls: readonly Sword2Call[]): {
  point: Sword2StandbyPoint | null;
  why: string | null;
} {
  const points: Array<{ x: number; y: number; atX: number; atY: number }> = [];
  let fromVariable = false;
  let computed = false;

  for (const call of calls) {
    if (call.name !== SETS_STANDBY) continue;
    // A call the grouper could not resolve has no arguments to read, and
    // "could not read it" is a refusal and not an absence.
    if (call.trouble) {
      computed = true;
      continue;
    }
    const [x, y] = call.arguments;
    if (!x || !y) {
      computed = true;
      continue;
    }
    if (x.push !== 'int' || y.push !== 'int') {
      if (VARIABLE_PUSHES.has(x.push) || VARIABLE_PUSHES.has(y.push)) fromVariable = true;
      else computed = true;
      continue;
    }
    points.push({ x: x.value, y: y.value, atX: x.at, atY: y.at });
  }

  if (fromVariable) return { point: null, why: SWORD2_STANDBY_REFUSALS.fromVariable };
  if (computed) return { point: null, why: SWORD2_STANDBY_REFUSALS.notLiteral };
  if (points.length === 0) return { point: null, why: null };

  const first = points[0];
  if (points.some((point) => point.x !== first.x || point.y !== first.y)) {
    return { point: null, why: SWORD2_STANDBY_REFUSALS.manyPoints };
  }
  return {
    point: {
      x: { value: first.x, at: points.map((point) => point.atX) },
      y: { value: first.y, at: points.map((point) => point.atY) },
    },
    why: null,
  };
}

/**
 * One object's rectangle, or the sentence saying why it has none.
 *
 * Exactly one of the two fields is set, which is what lets the surface show
 * every object on a screen: the ones it can move, outlined, and the ones it
 * cannot, named underneath with the reason.
 */
export function sword2ObjectBox(object: Sword2ProjectObject): {
  box: Sword2ObjectBox | null;
  why: string | null;
} {
  const calls = sword2Calls(object.instructions, object.entries);
  const offsets = new Set<number>();
  const spriteShaped = new Set<number>();
  let named = false;
  let fromVariable = false;

  for (const call of calls) {
    const registers = REGISTERS_MOUSE.includes(call.name);
    const shapes = call.name === REGISTERS_SPRITE_SHAPE;
    if (!registers && !shapes) continue;
    for (const argument of call.arguments) {
      if (!argument.name || !MOUSE_POINTER.test(argument.name)) continue;
      if (shapes) {
        if (argument.push === 'localAddr') spriteShaped.add(argument.value);
        continue;
      }
      named = true;
      if (argument.push === 'localAddr') offsets.add(argument.value);
      // A literal 0 is Revolution's own "no write to mouse list", not a refusal.
      else if (argument.push !== 'int' || argument.value !== 0) fromVariable = true;
    }
  }

  if (offsets.size === 0) {
    if (!named || !fromVariable) return { box: null, why: SWORD2_BOX_REFUSALS.noMouse };
    return { box: null, why: SWORD2_BOX_REFUSALS.fromVariable };
  }
  if (offsets.size > 1) return { box: null, why: SWORD2_BOX_REFUSALS.manyStructures };

  const offset = [...offsets][0];
  if (spriteShaped.has(offset)) return { box: null, why: SWORD2_BOX_REFUSALS.spriteShape };

  const writes = literalWrites(object);
  const fields = MOUSE_FIELDS.map((field) => writes.get(offset + field.at));
  if (fields.some((write) => write === undefined)) {
    return { box: null, why: SWORD2_BOX_REFUSALS.notLiteral };
  }
  if (fields.some((write) => write!.values.size !== 1)) {
    return { box: null, why: SWORD2_BOX_REFUSALS.manyValues };
  }

  const [x1, y1, x2, y2] = fields.map((write) => ({
    value: [...write!.values][0],
    at: write!.at,
  }));
  const standby = standbyPoint(calls);
  return {
    box: {
      id: object.id,
      name: object.name,
      offset,
      x1,
      y1,
      x2,
      y2,
      anchor: standby.point,
      anchorWhy: standby.why,
    },
    why: null,
  };
}

/** The object ids a screen's session brings to life, or null where none joins. */
export function sword2ScreenObjects(sword2: Sword2Project, screen: number): number[] | null {
  const runList = sword2.runLists.find((candidate) => candidate.screen === screen);
  return runList ? [...runList.objects] : null;
}

/** Every object on one screen, sorted into the movable and the refused. */
export function sword2ScreenBoxes(
  sword2: Sword2Project,
  screen: number,
): { boxes: Sword2ObjectBox[]; refused: Sword2BoxRefusal[] } {
  const ids = sword2ScreenObjects(sword2, screen);
  const boxes: Sword2ObjectBox[] = [];
  const refused: Sword2BoxRefusal[] = [];
  if (!ids) return { boxes, refused };

  const byId = new Map(sword2.objects.map((object) => [object.id, object]));
  for (const id of ids) {
    const object = byId.get(id);
    if (!object) continue;
    const { box, why } = sword2ObjectBox(object);
    if (box) boxes.push(box);
    else refused.push({ id, name: object.name, why: why! });
  }
  return { boxes, refused };
}

/**
 * Moves one object's rectangle — and nothing else.
 *
 * Where `moveSword1Compact` moves a compact's mouse box and its
 * `o_xcoord`/`o_ycoord` together, because those two *are* one record's idea of
 * where the thing is, this moves the four `ObjectMouse` words and leaves the
 * standby point where the script put it — `moveSword2Standby` is the handle
 * that moves *that*, and it is a separate drag on purpose.
 * `Sword2ObjectBox.anchor` carries the measurement: the standby point is a
 * router global set beside the rectangle, not a field of it, and 8 of the
 * demo's 57 are hundreds of pixels from the box they sit beside.
 *
 * Every instruction that writes a coordinate is rewritten, not only the first —
 * an object that sets the same rectangle in two branches keeps both in step,
 * which is exactly the case `manyValues` refuses when they differ.
 *
 * The write goes through `editSword2Operand`, so it is one ordinary script edit
 * per word: undoable, visible in the object's own instruction listing, and
 * carried out by the exporter that already re-emits 973 of 973 objects
 * byte-identically.
 */
export function moveSword2Box(project: Project, box: Sword2ObjectBox, x: number, y: number): void {
  const dx = x - box.x1.value;
  const dy = y - box.y1.value;
  if (dx === 0 && dy === 0) return;

  const shift = (field: Sword2BoxField, delta: number): void => {
    for (const at of field.at) editSword2Operand(project, box.id, at, 0, field.value + delta);
  };
  shift(box.x1, dx);
  shift(box.x2, dx);
  shift(box.y1, dy);
  shift(box.y2, dy);
}

/**
 * Moves one object's standby point — and nothing else.
 *
 * The other half of the pair, and the reason row 8 of `docs/editor-parity.md`
 * is a Yes. SCUMM's capability is "say where the player stands to use this
 * thing, on the canvas"; Sword II's own term for that is
 * `fnSetStandbyCoords(x, y, dir)`, and its two `CP_PUSH_INT32` operands are
 * where an author has always had to make the edit by hand. This writes them,
 * through the same `editSword2Operand` route `moveSword2Box` uses.
 *
 * Absolute rather than a delta, because a point is a place: the author put the
 * handle *here*. The direction operand is not touched — it is the third
 * parameter and it is an angle, not a coordinate, and a handle dragged across a
 * screen says nothing about which way a character should face when they get
 * there.
 *
 * Every call that sets the point is rewritten, not only the first, for
 * `moveSword2Box`'s reason: an object that sets the same point in two branches
 * keeps both in step, and one that sets two different points never reaches here
 * because `standbyPoint` refuses it by name.
 */
export function moveSword2Standby(
  project: Project,
  box: Sword2ObjectBox,
  x: number,
  y: number,
): void {
  const point = box.anchor;
  if (!point) return;
  if (point.x.value === x && point.y.value === y) return;
  for (const at of point.x.at) editSword2Operand(project, box.id, at, 0, x);
  for (const at of point.y.at) editSword2Operand(project, box.id, at, 0, y);
}
