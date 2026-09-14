/**
 * The edits a Broken Sword II project supports.
 *
 * The same discipline as `sword1/edits.ts` against a different document shape,
 * and kept separate for ADR 0026's reason — a shared edit function would be the
 * second place the two families' records get confused for one, after a shared
 * record type.
 *
 * The differences that show up here are real ones:
 *
 * - An object's **bytes are one blob**, not a per-record array, because a
 *   Sword2 object *is* one resource: header, hub, locals, offset table and
 *   code. So `editSword2ObjectWord` takes a byte offset into the resource, and
 *   the layout the project carries is what tells an editor which part a given
 *   offset is in.
 * - The **globals are the game's own variable block**, so editing one is
 *   writing a word into that block rather than into a table this project
 *   carries.
 */

import { fromBase64, toBase64 } from '../base64.js';
import type { Project } from '../project.js';
import type { Sword2Instruction } from './disassemble.js';
import type { Sword2ProjectObject } from './project.js';
import {
  SWORD2_SIZE,
  sword2ObjectOf,
  sword2ScriptOf,
} from '../../engine/sword2/script/sword2Vars.js';
import type { SwordWalkBar, SwordWalkNode } from '../../engine/sword1/script/swordWalkGrid.js';
import { parseSword2Parallax } from '../../engine/sword2/gfx/sword2Decode.js';
import { encodeSword2Frame, encodeSword2Parallax } from '../../engine/sword2/gfx/sword2Encode.js';
import {
  ANIM_HEADER_SIZE,
  CDT_ENTRY_SIZE,
  FRAME_HEADER_SIZE,
  LAYER_HEADER_SIZE,
  MULTI_SCREEN_HEADER_SIZE,
  OBJECT_HUB_SIZE,
  RES_HEADER_SIZE,
  RES_NAME_LEN,
  readSword2LayerHeader,
  Sword2ObjectHub,
  readSword2MultiScreenHeader,
  readSword2ScreenHeader,
  sword2Animation,
  sword2ScreenLayerOffsets,
  type Sword2Animation,
  type Sword2FrameHeader,
} from '../../engine/sword2/resource/sword2Headers.js';

export class Sword2EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2EditError';
  }
}

function sectionOf(project: Project): NonNullable<Project['sword2']> {
  if (!project.sword2) {
    throw new Sword2EditError(
      'This project has no Broken Sword II section, so there is nothing to edit. A project ' +
        'carries exactly one family’s surface (ADR 0013).',
    );
  }
  return project.sword2;
}

/**
 * Writes one 32-bit word of an object's resource.
 *
 * A byte offset, because that is how the object's own scripts address it: a
 * dereferenced structure is a byte offset from the structures' base. The offset
 * is checked against the resource's length and required to be word-aligned,
 * since every field in every structure is a 32-bit word.
 */
export function editSword2ObjectWord(
  project: Project,
  objectId: number,
  byteOffset: number,
  value: number,
): void {
  const sword2 = sectionOf(project);
  const object = sword2.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Sword2EditError(`This project holds no object ${objectId}.`);
  if (byteOffset % 4 !== 0) {
    throw new Sword2EditError(
      `Offset ${byteOffset} is not word-aligned. Every field of every Broken Sword II structure ` +
        `is a 32-bit word, so an unaligned write would straddle two of them.`,
    );
  }
  const bytes = fromBase64(object.bytesBase64);
  if (byteOffset < 0 || byteOffset + 4 > bytes.length) {
    throw new Sword2EditError(
      `Object ${objectId} is ${bytes.length} bytes and offset ${byteOffset} is outside it.`,
    );
  }
  if (byteOffset >= object.layout.codeAt) {
    throw new Sword2EditError(
      `Offset ${byteOffset} is inside object ${objectId}'s code block, which starts at ` +
        `${object.layout.codeAt}. Editing code through this path would break its checksum and ` +
        `its jumps; use the instruction editor instead.`,
    );
  }
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(
    byteOffset,
    value | 0,
    true,
  );
  (object as { bytesBase64: string }).bytesBase64 = toBase64(bytes);
}

/** Changes one operand of one instruction, the way Sword1's edit does. */
export function editSword2Operand(
  project: Project,
  objectId: number,
  at: number,
  operandIndex: number,
  value: number,
): void {
  const sword2 = sectionOf(project);
  const object = sword2.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Sword2EditError(`This project holds no object ${objectId}.`);
  const index = object.instructions.findIndex((instruction) => instruction.at === at);
  if (index < 0) {
    throw new Sword2EditError(`Object ${objectId} has no instruction at byte ${at}.`);
  }
  const instruction = object.instructions[index];
  if (operandIndex < 0 || operandIndex >= instruction.operands.length) {
    throw new Sword2EditError(
      `That instruction has ${instruction.operands.length} operands and operand ` +
        `${operandIndex} is outside it.`,
    );
  }
  const operands = [...instruction.operands];
  operands[operandIndex] = value | 0;
  (object.instructions as Sword2Instruction[])[index] = { ...instruction, operands };
}

/**
 * Changes a pushed string.
 *
 * The length byte comes with it, and a longer string is refused: the length is
 * a single byte *and* the instruction's own size, so growing one moves every
 * instruction after it. Reassembly could handle that, and refusing it here is
 * the conservative choice until an editor asks for the operation by name.
 */
export function editSword2String(
  project: Project,
  objectId: number,
  at: number,
  text: string,
): void {
  const sword2 = sectionOf(project);
  const object = sword2.objects.find((candidate) => candidate.id === objectId);
  if (!object) throw new Sword2EditError(`This project holds no object ${objectId}.`);
  const index = object.instructions.findIndex((instruction) => instruction.at === at);
  if (index < 0) throw new Sword2EditError(`Object ${objectId} has no instruction at byte ${at}.`);
  const instruction = object.instructions[index];
  if (instruction.text === undefined) {
    throw new Sword2EditError(`The instruction at ${at} is not a pushed string.`);
  }
  if (text.length > instruction.operands[0]) {
    throw new Sword2EditError(
      `That string holds ${instruction.operands[0]} characters and "${text}" is ` +
        `${text.length}. A longer string would change the instruction's length and move every ` +
        `instruction after it, so it is refused rather than silently truncated.`,
    );
  }
  (object.instructions as Sword2Instruction[])[index] = { ...instruction, text };
}

/** Changes one global. The count is the game's, so the bound is too. */
export function editSword2Global(project: Project, number: number, value: number): void {
  const sword2 = sectionOf(project);
  const bytes = fromBase64(sword2.globals.bytesBase64);
  if (number < 0 || number * 4 + 4 > bytes.length) {
    throw new Sword2EditError(
      `This game has ${sword2.globals.count} script variables and ${number} is outside them. ` +
        `The count comes from the game's own global variable file, so it cannot be widened.`,
    );
  }
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(
    number * 4,
    value | 0,
    true,
  );
  (sword2.globals as { bytesBase64: string }).bytesBase64 = toBase64(bytes);
}

/** Changes one line of text. */
export function editSword2TextLine(
  project: Project,
  resource: number,
  line: number,
  text: string,
): void {
  const sword2 = sectionOf(project);
  const entry = sword2.text.find((candidate) => candidate.resource === resource);
  if (!entry) throw new Sword2EditError(`This project holds no text module ${resource}.`);
  if (line < 0 || line >= entry.lines.length) {
    throw new Sword2EditError(
      `Text module ${resource} holds ${entry.lines.length} lines and line ${line} is outside it.`,
    );
  }
  (entry.lines as string[])[line] = text;
}

/**
 * Changes one colour of one screen's palette.
 *
 * Four bytes an entry, not three, and the fourth is left alone: it is unused by
 * the renderer and overwriting it would be a change nothing asked for.
 */
export function editSword2PaletteColour(
  project: Project,
  screen: number,
  index: number,
  red: number,
  green: number,
  blue: number,
): void {
  const sword2 = sectionOf(project);
  const palette = sword2.palettes.find((candidate) => candidate.screen === screen);
  if (!palette) throw new Sword2EditError(`This project holds no palette for screen ${screen}.`);
  const bytes = fromBase64(palette.bytesBase64);
  const at = index * 4;
  if (index < 0 || at + 2 >= bytes.length) {
    throw new Sword2EditError(
      `That palette holds ${Math.floor(bytes.length / 4)} colours and colour ${index} is ` +
        `outside it.`,
    );
  }
  const clamp = (value: number): number => Math.max(0, Math.min(255, value));
  bytes[at] = clamp(red);
  bytes[at + 1] = clamp(green);
  bytes[at + 2] = clamp(blue);
  (palette as { bytesBase64: string }).bytesBase64 = toBase64(bytes);
}

/** Adds or removes an object from a run list — which is to say, from a session. */
export function editSword2RunList(
  project: Project,
  resource: number,
  objects: readonly number[],
): void {
  const sword2 = sectionOf(project);
  const index = sword2.runLists.findIndex((candidate) => candidate.resource === resource);
  if (index < 0) throw new Sword2EditError(`This project holds no run list ${resource}.`);
  if (objects.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new Sword2EditError(
      'A run list holds object resource ids, and a zero ends the list — so zero is not a value ' +
        'an entry may take.',
    );
  }
  (sword2.runLists as Array<{ resource: number; objects: readonly number[] }>)[index] = {
    resource,
    objects: [...objects],
  };
}

/**
 * Replaces one animation frame's pixels, re-encoding in its own scheme.
 *
 * Which scheme that is, is per *frame* rather than per animation: the CDT
 * entry's `FAST_256` bit overrides the animation header's `runTimeComp`, and
 * the two writers produce different bytes for the same pixels.
 *
 * Frames are reflowed rather than patched in place, because a re-encode can
 * come out a different length and every frame after it would move. What is
 * carried across untouched is everything *before* the first frame — the
 * resource header, the animation header, the CDT table and RLE16's colour table
 * — with only the CDT offsets rewritten, and frames that several CDT entries
 * share stay shared.
 *
 * One consequence worth stating rather than discovering: replacing a frame that
 * two CDT entries point at changes both, because they are the same frame.
 */
export function replaceSword2AnimationFrame(
  project: Project,
  resource: number,
  frameIndex: number,
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const sword2 = sectionOf(project);
  const animation = sword2.animations.find((candidate) => candidate.resource === resource);
  if (!animation) throw new Sword2EditError(`This project holds no animation ${resource}.`);
  if (pixels.length !== width * height) {
    throw new Sword2EditError(
      `${width}x${height} is ${width * height} pixels and ${pixels.length} were given.`,
    );
  }

  const bytes = fromBase64(animation.bytesBase64);
  const walked = sword2Animation(bytes);
  const target = walked?.frames.find((candidate) => candidate.index === frameIndex);
  if (!walked || !target) {
    throw new Sword2EditError(`Animation ${resource} has no frame ${frameIndex}.`);
  }
  if (width !== target.header.width || height !== target.header.height) {
    throw new Sword2EditError(
      `Frame ${frameIndex} is ${target.header.width}x${target.header.height} and ` +
        `${width}x${height} was given. A frame's size is in its own header, and every CDT ` +
        `placement that names it assumes that size.`,
    );
  }

  let written;
  try {
    written = encodeSword2Frame(
      pixels,
      width,
      height,
      walked.header.runTimeComp,
      target.cdt.frameType,
      walked.colourTable ?? undefined,
    );
  } catch (error) {
    throw new Sword2EditError(error instanceof Error ? error.message : String(error));
  }

  (animation as { bytesBase64: string }).bytesBase64 = toBase64(
    rebuildSword2Animation(bytes, walked, target.cdt.frameOffset, written),
  );
}

/**
 * Writes an animation's frames out again, with one frame's bytes replaced.
 *
 * `replaceAt` is the *CDT offset* rather than a frame index, which is what makes
 * shared frames stay shared: every entry pointing at that offset gets the one
 * new body. Rebuilding with `replacement` left null reproduces the original
 * bytes, and that is a test rather than a hope.
 */
export function rebuildSword2Animation(
  original: Uint8Array,
  walked: Sword2Animation,
  replaceAt: number,
  replacement: Uint8Array | null,
): Uint8Array {
  const animAt = RES_HEADER_SIZE;
  // Distinct frame bodies in the order the resource holds them, so an untouched
  // rebuild lays them out exactly where they were.
  const bodies = new Map<number, { header: Sword2FrameHeader; data: Uint8Array }>();
  for (const frame of walked.frames) {
    if (bodies.has(frame.cdt.frameOffset)) continue;
    bodies.set(frame.cdt.frameOffset, { header: frame.header, data: frame.data });
  }
  const order = [...bodies.keys()].sort((left, right) => left - right);
  if (order.length === 0) return original;

  const prefixEnd = animAt + order[0];
  const parts: Uint8Array[] = [];
  const moved = new Map<number, number>();
  let at = prefixEnd - animAt;
  for (const offset of order) {
    const body = bodies.get(offset) as { header: Sword2FrameHeader; data: Uint8Array };
    const data = offset === replaceAt && replacement ? replacement : body.data;
    const block = new Uint8Array(FRAME_HEADER_SIZE + data.length);
    const view = new DataView(block.buffer);
    view.setUint32(0, data.length, true);
    view.setUint16(4, body.header.width, true);
    view.setUint16(6, body.header.height, true);
    block.set(data, FRAME_HEADER_SIZE);
    parts.push(block);
    moved.set(offset, at);
    at += block.length;
  }

  const out = new Uint8Array(prefixEnd + parts.reduce((sum, part) => sum + part.length, 0));
  out.set(original.subarray(0, prefixEnd));
  let to = prefixEnd;
  for (const part of parts) {
    out.set(part, to);
    to += part.length;
  }

  const view = new DataView(out.buffer);
  walked.frames.forEach((frame) => {
    const entry = animAt + ANIM_HEADER_SIZE + frame.index * CDT_ENTRY_SIZE;
    view.setUint32(entry + 4, moved.get(frame.cdt.frameOffset) ?? frame.cdt.frameOffset, true);
  });
  return out;
}

/**
 * Replaces one of a screen's five parallax layers.
 *
 * The expensive edit of the family, and the reason is the layout: a screen file
 * is nine blocks in one resource, located by a 36-byte header of offsets, and a
 * layer whose re-encoded length changes moves every block after it. So this
 * rewrites the multi-screen header's nine offsets *and* the mask table's
 * per-layer offsets, each shifted by the difference where it points past the
 * edit and left alone where it points before it.
 *
 * Both kinds of offset are measured from the same place, and it is not the
 * file's start: `file + ResHeader::size() + offset`, for the multi-screen
 * header's nine and for a `LayerHeader`'s alike (`screen.cpp:528`). Reading a
 * mask's as absolute puts its block boundary 44 bytes early, which on the
 * demo's screen 303 grew an untouched layer by 28 bytes on rebuild.
 */
export function replaceSword2ScreenLayer(
  project: Project,
  resource: number,
  slot: number,
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const sword2 = sectionOf(project);
  const screen = sword2.screens.find((candidate) => candidate.resource === resource);
  if (!screen) throw new Sword2EditError(`This project holds no screen ${resource}.`);
  if (pixels.length !== width * height) {
    throw new Sword2EditError(
      `${width}x${height} is ${width * height} pixels and ${pixels.length} were given.`,
    );
  }
  const bytes = fromBase64(screen.bytesBase64);
  if (bytes.length < RES_HEADER_SIZE + MULTI_SCREEN_HEADER_SIZE) {
    throw new Sword2EditError(
      `Screen ${resource}'s bytes are not in this project, so there is nothing to replace.`,
    );
  }
  const layerAt = sword2ScreenLayerOffsets(bytes)[slot];
  if (layerAt === null || layerAt === undefined) {
    throw new Sword2EditError(`Screen ${resource} has nothing in layer slot ${slot}.`);
  }
  const existing = parseSword2Parallax(bytes, layerAt);
  if (!existing) throw new Sword2EditError(`Screen ${resource}'s layer ${slot} will not decode.`);
  if (width !== existing.width || height !== existing.height) {
    throw new Sword2EditError(
      `That layer is ${existing.width}x${existing.height} and ${width}x${height} was given. A ` +
        `layer's size is read from its own two-word header by the renderer and by the scroll ` +
        `limits both, so it cannot change here.`,
    );
  }

  const multi = readSword2MultiScreenHeader(bytes, RES_HEADER_SIZE);
  const layerCount = readSword2ScreenHeader(bytes, RES_HEADER_SIZE + multi.screen).noLayers;
  // Where the edited block ends: the next thing anything points at. Blocks this
  // project does not parse — the palette match table, the mask data — are moved
  // rather than understood, which is all that relocating them needs.
  const marks = [
    ...[
      multi.palette,
      multi.bgParallax[0],
      multi.bgParallax[1],
      multi.screen,
      multi.fgParallax[0],
      multi.fgParallax[1],
      multi.layers,
      multi.paletteTable,
      multi.maskOffset,
    ]
      .filter((offset) => offset !== 0)
      .map((offset) => RES_HEADER_SIZE + offset),
    ...Array.from({ length: layerCount }, (_, layer) =>
      readSword2LayerHeader(bytes, RES_HEADER_SIZE + multi.layers + layer * LAYER_HEADER_SIZE),
    ).map((header) => RES_HEADER_SIZE + header.offset),
    bytes.length,
  ];
  const end = Math.min(...marks.filter((mark) => mark > layerAt));

  const encoded = encodeSword2Parallax(pixels, width, height);
  const delta = encoded.length - (end - layerAt);
  const out = new Uint8Array(bytes.length + delta);
  out.set(bytes.subarray(0, layerAt));
  out.set(encoded, layerAt);
  out.set(bytes.subarray(end), layerAt + encoded.length);

  const view = new DataView(out.buffer);
  const shiftHeader = (field: number): void => {
    const offset = view.getUint32(RES_HEADER_SIZE + field, true);
    if (offset === 0 || RES_HEADER_SIZE + offset <= layerAt) return;
    view.setUint32(RES_HEADER_SIZE + field, offset + delta, true);
  };
  for (let field = 0; field < MULTI_SCREEN_HEADER_SIZE; field += 4) shiftHeader(field);

  const layersAt = RES_HEADER_SIZE + view.getUint32(RES_HEADER_SIZE + 24, true);
  for (let layer = 0; layer < layerCount; layer++) {
    const field = layersAt + layer * LAYER_HEADER_SIZE + 12;
    if (field + 4 > out.length) break;
    const offset = view.getUint32(field, true);
    if (RES_HEADER_SIZE + offset > layerAt) view.setUint32(field, offset + delta, true);
  }

  (screen as { bytesBase64: string }).bytesBase64 = toBase64(out);
}

/**
 * Moves one endpoint of one bar, or a whole bar, in a walk grid.
 *
 * Deliberately a separate function from `editSword1WalkBar` and not a wrapper
 * round it, which is ADR 0036's line in practice: the *codec* crosses — these
 * bars are Broken Sword's bars byte for byte, and `swordWalkGrid.ts` reads and
 * writes both families' — and the *record* does not. A `Sword2ProjectWalkGrid`
 * is found in a different document, carries a 44-byte header rather than a
 * 20-byte one, and has no scale ramp.
 */
export function editSword2WalkBar(
  project: Project,
  resource: number,
  index: number,
  change: { end: 0 | 1 | null; x: number; y: number },
): void {
  const sword2 = sectionOf(project);
  const grid = (sword2.walkGrids ?? []).find((candidate) => candidate.resource === resource);
  if (!grid) throw new Sword2EditError(`This project holds no walk grid ${resource}.`);
  const bar = grid.bars[index];
  if (!bar) {
    throw new Sword2EditError(
      `Walk grid ${resource} holds ${grid.bars.length} bars and bar ${index} is outside it.`,
    );
  }
  const fit = (value: number): number => Math.max(-32768, Math.min(32767, Math.round(value)));
  const next =
    change.end === 0
      ? { ...bar, x1: fit(change.x), y1: fit(change.y) }
      : change.end === 1
        ? { ...bar, x2: fit(change.x), y2: fit(change.y) }
        : (() => {
            const dx = change.x - Math.round((bar.x1 + bar.x2) / 2);
            const dy = change.y - Math.round((bar.y1 + bar.y2) / 2);
            return {
              x1: fit(bar.x1 + dx),
              y1: fit(bar.y1 + dy),
              x2: fit(bar.x2 + dx),
              y2: fit(bar.y2 + dy),
            };
          })();
  (grid.bars as SwordWalkBar[])[index] = next;
}

/**
 * Deletes a bar.
 *
 * Nothing addresses a bar by index here either — `Sword2Router.loadWalkGrid`
 * reads `numBars` of them and concatenates the session's grids — so a shorter
 * list is a grid with one fewer wall. Nodes are still index-addressed and still
 * have no delete: the router's node array is built the same way.
 */
export function deleteSword2WalkBar(project: Project, resource: number, index: number): void {
  const sword2 = sectionOf(project);
  const grid = (sword2.walkGrids ?? []).find((candidate) => candidate.resource === resource);
  if (!grid) throw new Sword2EditError(`This project holds no walk grid ${resource}.`);
  if (index < 0 || index >= grid.bars.length) {
    throw new Sword2EditError(
      `Walk grid ${resource} holds ${grid.bars.length} bars and bar ${index} is outside it.`,
    );
  }
  (grid.bars as SwordWalkBar[]).splice(index, 1);
}

/** Moves one node. Moved and never added or removed: see `deleteSword2WalkBar`. */
export function editSword2WalkNode(
  project: Project,
  resource: number,
  index: number,
  x: number,
  y: number,
): void {
  const sword2 = sectionOf(project);
  const grid = (sword2.walkGrids ?? []).find((candidate) => candidate.resource === resource);
  if (!grid) throw new Sword2EditError(`This project holds no walk grid ${resource}.`);
  if (index < 0 || index >= grid.nodes.length) {
    throw new Sword2EditError(
      `Walk grid ${resource} holds ${grid.nodes.length} nodes and node ${index} is outside it.`,
    );
  }
  const fit = (value: number): number => Math.max(-32768, Math.min(32767, Math.round(value)));
  (grid.nodes as SwordWalkNode[])[index] = { x: fit(x), y: fit(y) };
}

/*
 * ---------------------------------------------------------------------------
 * Appending and deleting an object
 * ---------------------------------------------------------------------------
 *
 * Sword2 addresses a resource by a flat id and `resource.tab` is a flat array
 * indexed by that id — four bytes an entry, `(cluster line, index within that
 * cluster)`, `0xffff` for an id that holds nothing. So the next free id is the
 * table's length and an object appended at it displaces nothing, which is the
 * whole difference between this and inserting.
 *
 * Measured on the demo, and each number is a constraint rather than a
 * curiosity:
 *
 * - `resource.tab` declares 4,147 ids, 20 of which are `0xffff`. The next free
 *   id is 4,147, not "one past the highest object" — those 20 holes are inside
 *   the range and taking one would put a resource where the game has already
 *   decided there is none.
 * - every present cluster's tail table holds exactly as many entries as there
 *   are ids pointing into it, with indices dense from 0, so there is no spare
 *   slot anywhere and a new resource needs a new tail entry as well as a new
 *   tab entry. Both go on the end.
 * - the new bytes go between the last resource and the tail table, which the
 *   exporter's existing layout pass already walks. Nothing before it moves.
 *
 * Deleting is the other way round and the demo does not allow it: of 973
 * objects, exactly one is the highest index in its cluster, and that one is
 * named by a run list. So `deleteSword2Object` removes objects **this editor
 * appended** and refuses the shipped ones by name, which is what the data says
 * rather than what would be convenient.
 */

/**
 * Everywhere a project writes an object id down, as sentences.
 *
 * Three places, and all three would be left pointing at nothing. A run list
 * holds ids directly — that is what a run list is. A script pushes one as a
 * literal to call `fnSendEvent` or to set a target. And an object's own hub
 * holds `scriptId` per logic level, which is `id * 0x10000 + script`, so an
 * object can name another object's code.
 *
 * The literal search is deliberately not run over the game's own scripts when
 * the id being asked about is one **this editor appended**, and the reason is
 * arithmetic rather than charity: a bare integer operand is indistinguishable
 * from a resource id, 4,147 is a perfectly ordinary number to push, and no
 * script Revolution shipped can be pushing an id that did not exist until an
 * author made it. Counting those would make every appended object permanently
 * undeletable on the strength of a coincidence.
 */
export function sword2ObjectReferences(project: Project, id: number): string[] {
  const sword2 = sectionOf(project);
  const found: string[] = [];
  const appended = sword2.objects.find((candidate) => candidate.id === id)?.appendedFrom;

  for (const list of sword2.runLists) {
    const hits = list.objects.filter((each) => each === id).length;
    if (hits > 0) found.push(`run list ${list.resource} holds it`);
  }

  for (const object of sword2.objects) {
    if (object.id === id) continue;
    let operands = 0;
    if (appended === undefined || object.appendedFrom !== undefined) {
      for (const instruction of object.instructions) {
        for (const operand of instruction.operands) {
          if (operand === id || sword2ObjectOf(operand) === id) operands++;
        }
      }
    }
    if (operands > 0) {
      found.push(`object ${object.id} (${object.name}) pushes it ${operands} times`);
    }
    const bytes = fromBase64(object.bytesBase64);
    if (bytes.length >= RES_HEADER_SIZE + OBJECT_HUB_SIZE) {
      const hub = new Sword2ObjectHub(bytes, RES_HEADER_SIZE);
      for (let level = 0; level < 3; level++) {
        if (sword2ObjectOf(hub.scriptId(level)) === id) {
          found.push(`object ${object.id} (${object.name}) runs its code at logic level ${level}`);
        }
      }
    }
  }
  return found;
}

/** Writes a name into a resource header's 34-byte name field, NUL-padded. */
function renameResource(bytes: Uint8Array, name: string): void {
  bytes.fill(0, 10, 10 + RES_NAME_LEN);
  for (let at = 0; at < Math.min(name.length, RES_NAME_LEN - 1); at++) {
    bytes[10 + at] = name.charCodeAt(at) & 0xff;
  }
}

/**
 * Copies an object onto the end of the resource table and hands back its id.
 *
 * The copy's **hub script ids are rewritten** and that is the part worth
 * reading twice. A hub holds `scriptId * 0x10000 + script` per logic level, and
 * `Sword2Logic.runObject` compares the object half against the id it is running
 * for: a copy that kept its source's hub would, every cycle, run the original's
 * code against the original's structures and be a second name for one object
 * rather than a second object. Rewritten, the copy runs its own code — which is
 * a byte-identical copy of the original's, and then editable.
 *
 * The copy is refused when the project does not know how many ids the index
 * declares. That is not fussiness: guessing the next id from the objects this
 * project holds would land inside the twenty `0xffff` holes or past the end of
 * a table the game reads by offset, and neither is a resource the game can find.
 */
export function appendSword2Object(project: Project, source: number): number {
  const sword2 = sectionOf(project);
  const template = sword2.objects.find((candidate) => candidate.id === source);
  if (!template) throw new Sword2EditError(`This project holds no object ${source} to copy.`);
  if (!template.roundTrips) {
    throw new Sword2EditError(
      `Object ${source} (${template.name}) did not round-trip on import, so its code is not ` +
        `known well enough to copy. Copy an object the sweep re-emits byte-identically.`,
    );
  }
  if (sword2.resourceCount === undefined) {
    throw new Sword2EditError(
      'This project does not record how many resource ids the index declares, so there is no ' +
        'id a new object could take. It was saved before objects could be appended: reimport ' +
        'the game and the id will be there.',
    );
  }

  const id = sword2.resourceCount;
  if (id > 0xffff) {
    throw new Sword2EditError(
      `The index already declares ${id} ids and a cluster entry is a 16-bit number, so there is ` +
        `no id left to give a new object.`,
    );
  }

  const bytes = fromBase64(template.bytesBase64).slice();
  const hub = new Sword2ObjectHub(bytes, RES_HEADER_SIZE);
  for (let level = 0; level < 3; level++) {
    const scriptId = hub.scriptId(level);
    if (sword2ObjectOf(scriptId) === source) {
      hub.setScriptId(level, id * SWORD2_SIZE + sword2ScriptOf(scriptId));
    }
  }
  const name = `${template.name}_COPY`.slice(0, RES_NAME_LEN - 1);
  renameResource(bytes, name);

  (sword2.objects as Sword2ProjectObject[]).push({
    ...template,
    id,
    name,
    bytesBase64: toBase64(bytes),
    appendedFrom: source,
  });
  (sword2 as { resourceCount?: number }).resourceCount = id + 1;
  return id;
}

/**
 * Why an object cannot be removed, or null when it can.
 *
 * A shipped object is refused for the reason the measurement gives: its index
 * within its cluster is in the middle of that cluster's tail table, and the
 * table is addressed by index, so removing the entry would renumber every
 * resource after it in the same cluster and `resource.tab` would then point
 * each of them at its neighbour. Only the last id can go, and the last id is
 * one this editor put there.
 */
export function sword2ObjectDeleteRefusal(project: Project, id: number): string | null {
  const sword2 = sectionOf(project);
  const object = sword2.objects.find((candidate) => candidate.id === id);
  if (!object) return `This project holds no object ${id}.`;

  if (object.appendedFrom === undefined) {
    return (
      `Object ${id} (${object.name}) is one the game ships. Its cluster's tail table is ` +
      `addressed by index and this object's index is not the last one, so removing it would ` +
      `renumber every resource after it in the same cluster and leave resource.tab pointing ` +
      `each of them at its neighbour. Of the 973 objects this game ships, one is the last of ` +
      `its cluster and a run list names it, so none of them can go. An object appended here ` +
      `can: it is the last entry of both tables by construction.`
    );
  }

  const appended = sword2.objects
    .filter((candidate) => candidate.appendedFrom !== undefined)
    .map((candidate) => candidate.id);
  const highest = Math.max(...appended);
  if (id !== highest) {
    return (
      `Object ${id} was appended here, but object ${highest} was appended after it and would be ` +
      `renumbered. Remove them newest first.`
    );
  }

  const references = sword2ObjectReferences(project, id);
  if (references.length > 0) {
    return (
      `Object ${id} (${object.name}) is still named: ${references.join('; ')}. Remove it from ` +
      `those first, or they will name an id the index no longer declares.`
    );
  }
  return null;
}

/**
 * Removes an appended object, and the id with it.
 *
 * The id goes back to `resourceCount` rather than being left as a hole, which
 * is the difference between undoing an append and creating a twenty-first
 * `0xffff`. `sword2ObjectDeleteRefusal` has already established that this is
 * the newest appended object, which is what makes the id the last one.
 */
export function deleteSword2Object(project: Project, id: number): void {
  const refusal = sword2ObjectDeleteRefusal(project, id);
  if (refusal) throw new Sword2EditError(refusal);
  const sword2 = sectionOf(project);
  const at = sword2.objects.findIndex((candidate) => candidate.id === id);
  (sword2.objects as Sword2ProjectObject[]).splice(at, 1);
  (sword2 as { resourceCount?: number }).resourceCount = id;
}
