/**
 * The edits a Broken Sword project supports, as functions on the document.
 *
 * One module rather than methods on the editor, for the reason the SCUMM side
 * learned: an edit that lives in a UI class cannot be tested without a DOM, and
 * these are the operations whose correctness matters most — a wrong operand
 * write is a game that plays until it does not.
 *
 * Every function here takes the `Project` and mutates the `sword1` section in
 * place, which is the contract `EditorState.update` expects (it snapshots for
 * undo around the call).
 */

import { fromBase64, toBase64 } from '../base64.js';
import type { Project } from '../project.js';
import type { Sword1ProjectCompact } from './project.js';
import type { Sword1Instruction } from './disassemble.js';
import type { SwordWalkBar, SwordWalkNode } from '../../engine/sword1/script/swordWalkGrid.js';
import { compressionOf } from '../../engine/sword1/gfx/swordDecode.js';
import { encodeSwordFrame, encodeSwordParallax } from '../../engine/sword1/gfx/swordEncode.js';
import { decomposeSwordMask, parseSwordGrid } from '../../engine/sword1/gfx/swordMask.js';
import {
  sword1SpriteFrames,
  SWORD1_FRAME_HEADER_SIZE,
  SWORD1_HEADER_SIZE,
  type SwordFrameHeader,
} from '../../engine/sword1/resource/swordDefs.js';

/** Raised when an edit is refused, with what was wrong. */
export class Sword1EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword1EditError';
  }
}

function sectionOf(project: Project): NonNullable<Project['sword1']> {
  if (!project.sword1) {
    throw new Sword1EditError(
      'This project has no Broken Sword section, so there is nothing to edit. A project carries ' +
        'exactly one family’s surface (ADR 0013).',
    );
  }
  return project.sword1;
}

/**
 * Writes one word of a compact.
 *
 * The word index rather than a named field, because the *bytecode* addresses a
 * compact by byte offset and the editor shows the same addressing — a named
 * setter would be a second vocabulary for one layout.
 */
export function editSword1CompactWord(
  project: Project,
  compactId: number,
  wordIndex: number,
  value: number,
): void {
  const sword1 = sectionOf(project);
  for (const section of sword1.sections) {
    const compact = section.compacts.find((candidate) => candidate.id === compactId);
    if (!compact) continue;
    const bytes = fromBase64(compact.wordsBase64);
    const at = wordIndex * 4;
    if (at < 0 || at + 4 > bytes.length) {
      throw new Sword1EditError(
        `Compact ${compactId} holds ${bytes.length / 4} words and word ${wordIndex} is outside ` +
          `it. A compact's size is fixed: growing one would move every compact after it in its ` +
          `section's resource.`,
      );
    }
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(at, value | 0, true);
    (compact as { wordsBase64: string }).wordsBase64 = toBase64(bytes);
    return;
  }
  throw new Sword1EditError(`This project holds no compact ${compactId}.`);
}

/**
 * Changes one operand of one instruction.
 *
 * Operands only, and deliberately: changing a *token* changes the instruction's
 * length, which moves every instruction after it and every jump across it. That
 * is what `insertSword1Instruction` is for, and it is a different operation with
 * different failure modes.
 */
export function editSword1Operand(
  project: Project,
  resource: number,
  at: number,
  operandIndex: number,
  value: number,
): void {
  const sword1 = sectionOf(project);
  const script = sword1.scripts.find((candidate) => candidate.resource === resource);
  if (!script) throw new Sword1EditError(`This project holds no script module ${resource}.`);
  const index = script.instructions.findIndex((instruction) => instruction.at === at);
  if (index < 0) {
    throw new Sword1EditError(`Script module ${resource} has no instruction at word ${at}.`);
  }
  const instruction = script.instructions[index];
  if (operandIndex < 0 || operandIndex >= instruction.operands.length) {
    throw new Sword1EditError(
      `That instruction has ${instruction.operands.length} operands and operand ` +
        `${operandIndex} is outside it.`,
    );
  }
  const operands = [...instruction.operands];
  operands[operandIndex] = value | 0;
  (script.instructions as Sword1Instruction[])[index] = { ...instruction, operands };
}

/** Changes one line of text. The plainest useful edit this family has. */
export function editSword1TextLine(
  project: Project,
  resource: number,
  line: number,
  text: string,
): void {
  const sword1 = sectionOf(project);
  const entry = sword1.text.find((candidate) => candidate.resource === resource);
  if (!entry) throw new Sword1EditError(`This project holds no text resource ${resource}.`);
  if (line < 0 || line >= entry.lines.length) {
    throw new Sword1EditError(
      `Text resource ${resource} holds ${entry.lines.length} lines and line ${line} is outside ` +
        `it. Adding a line would renumber the ones after it, which every script that names one ` +
        `would then have wrong.`,
    );
  }
  (entry.lines as string[])[line] = text;
}

/**
 * Changes one colour of one palette.
 *
 * The value is written as the six bits the DAC holds, which is what makes this
 * round-trip: an eight-bit value is shifted down and back, so 255 stays 252 and
 * the editor shows what the game will show rather than what was typed.
 */
export function editSword1PaletteColour(
  project: Project,
  resource: number,
  index: number,
  red: number,
  green: number,
  blue: number,
): void {
  const sword1 = sectionOf(project);
  const palette = sword1.palettes.find((candidate) => candidate.resource === resource);
  if (!palette) throw new Sword1EditError(`This project holds no palette ${resource}.`);
  const bytes = fromBase64(palette.bytesBase64);
  const at = index * 3;
  if (index < 0 || at + 2 >= bytes.length) {
    throw new Sword1EditError(
      `Palette ${resource} holds ${Math.floor(bytes.length / 3)} colours and colour ${index} is ` +
        `outside it.`,
    );
  }
  const six = (value: number): number => Math.max(0, Math.min(63, value >> 2));
  bytes[at] = six(red);
  bytes[at + 1] = six(green);
  bytes[at + 2] = six(blue);
  (palette as { bytesBase64: string }).bytesBase64 = toBase64(bytes);
}

/**
 * Changes a room definition.
 *
 * Written back into the install's own `SWORD.EXE` when the project was built
 * from a folder that ships one, and nowhere when it was not. "The room table
 * lived in Revolution's interpreter, so there is nowhere to write it" was the
 * standing reason for the second case and was half a fact: the interpreter is
 * in the box, and `src/authoring/sword1/executable.ts` finds the table in it.
 * `project.surfaces.rooms` says which case a given project is.
 */
export function editSword1Room(
  project: Project,
  screen: number,
  change: Partial<{
    width: number;
    height: number;
    totalLayers: number;
    gridWidth: number;
  }>,
): void {
  const sword1 = sectionOf(project);
  const index = sword1.rooms.findIndex((candidate) => candidate.screen === screen);
  if (index < 0)
    throw new Sword1EditError(`This project holds no room definition for screen ${screen}.`);
  const room = sword1.rooms[index];
  if (change.width !== undefined && change.width % 16 !== 0) {
    throw new Sword1EditError(
      `A screen's width must be a multiple of 16: the mask grid is indexed in 16-pixel blocks, ` +
        `and a width that is not would put every mask half a block out.`,
    );
  }
  if (change.height !== undefined && change.height % 8 !== 0) {
    throw new Sword1EditError(
      `A screen's height must be a multiple of 8: the mask grid's blocks are eight rows tall.`,
    );
  }
  (sword1.rooms as Array<typeof room>)[index] = { ...room, ...change };
}

/**
 * Moves where a character stands when a script sends them to a place.
 *
 * Addressed by the ordinal the executable's decode gave the placement, and
 * `place` comes back with it so the export can check the edit against the file
 * it is about to write rather than trust the ordinal — four `mov`s in the
 * wrong run would move a character the edit never mentioned.
 */
export function editSword1StartPosition(
  project: Project,
  index: number,
  change: Partial<{ x: number; y: number; direction: number }>,
): void {
  const sword1 = sectionOf(project);
  const positions = sword1.startPositions;
  if (!positions) {
    throw new Sword1EditError(
      `This project has no start positions: they live in the interpreter's own bytes and the ` +
        `folder it was opened from ships no executable holding them.`,
    );
  }
  const at = positions.findIndex((candidate) => candidate.index === index);
  if (at < 0) throw new Sword1EditError(`This project holds no start position ${index}.`);
  if (change.direction !== undefined && (change.direction < 0 || change.direction > 7)) {
    throw new Sword1EditError(
      `A direction is one of the eight compass points, 0 to 7: ${change.direction} is not one.`,
    );
  }
  const position = positions[at];
  (positions as Array<typeof position>)[at] = { ...position, ...change };
}

/**
 * Replaces the pixels of one picture, re-encoding in the format it came in.
 *
 * The edit item 3 of this branch exists for, and the one that needed an encoder
 * before it could be written at all. What makes it safe is measured rather than
 * asserted: `npm run sweep:sword` re-encodes every frame of an install and
 * reports 7113 of the demo's 7113 sprite frames and 2 of 2 parallax layers
 * coming back byte-identical, so the frames this edit does *not* touch are
 * still the bytes Revolution shipped.
 *
 * The four formats need four different rewrites:
 *
 * - A **background** is pixels already, so this is a copy into the resource
 *   with the size fixed — a background's size comes from the room table, and
 *   growing one would mean a room table this family cannot write back.
 * - A **parallax** is re-emitted whole, header and row table and all, because a
 *   row whose length changes moves every row after it.
 * - A **sprite** is rebuilt: the frame table is recomputed from the frames'
 *   new sizes, the replaced frame's header keeps its hotspot and takes its new
 *   compressed size, and every other frame's bytes are carried across
 *   untouched rather than decoded and written again.
 * - A **mask layer** is taken apart by its grid: each cell names a 16x8 block,
 *   and the pixels under that cell are written into it. Paint that no cell
 *   covers has nowhere to go and is dropped, and a block several cells share
 *   cannot hold two different things — that is refused by name rather than
 *   resolved, because writing one of them would repaint the others.
 *
 * `frameIndex` is ignored for everything that is not a sprite.
 */
export function replaceSword1Picture(
  project: Project,
  resource: number,
  frameIndex: number,
  pixels: Uint8Array,
  width: number,
  height: number,
): void {
  const sword1 = sectionOf(project);
  const picture = sword1.pictures.find((candidate) => candidate.resource === resource);
  if (!picture) throw new Sword1EditError(`This project holds no picture ${resource}.`);
  if (pixels.length !== width * height) {
    throw new Sword1EditError(
      `${width}x${height} is ${width * height} pixels and ${pixels.length} were given.`,
    );
  }
  const bytes = fromBase64(picture.bytesBase64);

  if (picture.kind === 'mask') {
    const grid = picture.grid;
    if (!grid) {
      throw new Sword1EditError(
        'A mask layer is a bag of 16x8 blocks, and the Grid resource that says where each block ' +
          'goes is not in this install, so there is nothing to write these pixels into.',
      );
    }
    if (width !== picture.width || height !== picture.height) {
      throw new Sword1EditError(
        `This mask layer covers screen ${picture.screens[0] ?? '?'}, which is ` +
          `${picture.width}x${picture.height}, and ${width}x${height} was given. A mask is laid ` +
          `out by its grid against the room's size, so it cannot be a different size.`,
      );
    }
    const cells = parseSwordGrid(fromBase64(grid.bytesBase64), grid.pitch);
    const taken = decomposeSwordMask(
      bytes.subarray(SWORD1_HEADER_SIZE),
      cells,
      pixels,
      width,
      height,
    );
    if (taken.conflicts.length > 0) {
      // Not a limitation of this editor: the mask genuinely stores one block
      // once and points several places at it, so two of those places cannot
      // hold different pixels. Naming the blocks is more use than a refusal.
      throw new Sword1EditError(
        `${taken.conflicts.length} of this mask's blocks are shared by more than one place on ` +
          `the screen, and the pixels given differ between those places: block ` +
          `${taken.conflicts.slice(0, 8).join(', ')}` +
          `${taken.conflicts.length > 8 ? ', …' : ''}. Broken Sword stores such a block once, ` +
          `so painting one of its places repaints all of them; edit them to match, or leave the ` +
          `shared ones alone.`,
      );
    }
    const written = new Uint8Array(bytes);
    written.set(taken.blocks, SWORD1_HEADER_SIZE);
    (picture as { bytesBase64: string }).bytesBase64 = toBase64(written);
    return;
  }

  if (picture.kind === 'background') {
    if (width !== picture.width || height !== picture.height) {
      throw new Sword1EditError(
        `Screen ${picture.screens[0] ?? '?'}'s background is ${picture.width}x${picture.height} ` +
          `and ${width}x${height} was given. A background's size comes from the room table, ` +
          `which lived in Revolution's interpreter rather than in the game's files, so it ` +
          `cannot be changed here.`,
      );
    }
    if (bytes.length < pixels.length) {
      throw new Sword1EditError(
        `${resource} holds ${bytes.length} bytes and ${pixels.length} were given to write.`,
      );
    }
    bytes.set(pixels, 0);
    (picture as { bytesBase64: string }).bytesBase64 = toBase64(bytes);
    return;
  }

  if (picture.kind === 'parallax') {
    if (width !== picture.width || height !== picture.height) {
      throw new Sword1EditError(
        `This parallax layer is ${picture.width}x${picture.height} and ${width}x${height} was ` +
          `given. The room table names its size, so it cannot change here.`,
      );
    }
    (picture as { bytesBase64: string }).bytesBase64 = toBase64(
      encodeSwordParallax(pixels, width, height, bytes.subarray(0, 16)),
    );
    return;
  }

  const frames = sword1SpriteFrames(bytes);
  const target = frames.find((candidate) => candidate.index === frameIndex);
  if (!target) throw new Sword1EditError(`Sprite ${resource} has no frame ${frameIndex}.`);
  if (width !== target.header.width || height !== target.header.height) {
    throw new Sword1EditError(
      `Frame ${frameIndex} is ${target.header.width}x${target.header.height} and ` +
        `${width}x${height} was given. A frame's size is in its own header, and changing it ` +
        `would change what every animation that plays this sprite expects.`,
    );
  }

  let written;
  try {
    written = encodeSwordFrame(pixels, compressionOf(target.header.runTimeComp));
  } catch (error) {
    throw new Sword1EditError(error instanceof Error ? error.message : String(error));
  }

  // The frame keeps the tag it shipped with unless the encoder actually
  // changed scheme. Two spellings mean uncompressed — `'NONE'`, which
  // `SWORD_COMPRESSION_TAGS` writes, and `'Nu  '`, which the original
  // interpreter writes for a text sprite (`text.cpp:114`) — and both decode
  // the same, so replacing one with the other would be a difference no reader
  // sees and every byte-comparison does.
  const tag = written.retagged === null ? target.header.runTimeComp : written.tag;
  const replacement = frames.map((frame) =>
    frame.index === frameIndex
      ? { header: frame.header, tag, data: written.bytes }
      : { header: frame.header, tag: frame.header.runTimeComp, data: frame.data },
  );
  (picture as { bytesBase64: string }).bytesBase64 = toBase64(
    rebuildSword1Sprite(bytes, replacement),
  );
}

/** One frame as a rebuild sees it: its header, its four-byte tag and its bytes. */
interface Sword1RebuiltFrame {
  readonly header: SwordFrameHeader;
  readonly tag: string;
  readonly data: Uint8Array;
}

/**
 * Writes a sprite resource's frame table and frames out again.
 *
 * Everything before the frame count — the 20-byte resource header — is carried
 * across byte for byte, because none of it describes the frames. The table is
 * `count` offsets from the resource's start, and a frame's length is in its own
 * header rather than implied by the next offset, so there is no terminator.
 *
 * Rebuilding an untouched sprite reproduces the original bytes, and that is a
 * test rather than a hope (`tests/sword1-graphics.test.ts`).
 */
export function rebuildSword1Sprite(
  original: Uint8Array,
  frames: readonly Sword1RebuiltFrame[],
): Uint8Array {
  const tableAt = SWORD1_HEADER_SIZE + 4;
  let at = tableAt + frames.length * 4;
  const offsets: number[] = [];
  for (const frame of frames) {
    offsets.push(at);
    at += SWORD1_FRAME_HEADER_SIZE + frame.data.length;
  }

  const out = new Uint8Array(at);
  out.set(original.subarray(0, Math.min(SWORD1_HEADER_SIZE, original.length)));
  const view = new DataView(out.buffer);
  view.setUint32(SWORD1_HEADER_SIZE, frames.length, true);
  offsets.forEach((offset, index) => view.setUint32(tableAt + index * 4, offset, true));

  frames.forEach((frame, index) => {
    const to = offsets[index];
    for (let byte = 0; byte < 4; byte++) {
      out[to + byte] = frame.tag.charCodeAt(byte) & 0xff;
    }
    view.setUint32(to + 4, frame.data.length, true);
    view.setUint16(to + 8, frame.header.width, true);
    view.setUint16(to + 10, frame.header.height, true);
    view.setInt16(to + 12, frame.header.offsetX, true);
    view.setInt16(to + 14, frame.header.offsetY, true);
    out.set(frame.data, to + SWORD1_FRAME_HEADER_SIZE);
  });
  return out;
}

/**
 * Moves one endpoint of one bar, or a whole bar, in a walk grid.
 *
 * The endpoint is what is stored and the only thing stored: a bar's bounding
 * box, its deltas and its line constant are derived when the grid is written
 * (`swordWalkGrid.ts`), so there is nothing here that can be left describing
 * where the bar used to be. `end` null moves both endpoints by the same delta,
 * which is sliding a wall rather than reshaping one.
 *
 * Coordinates are clamped to a signed 16-bit range rather than to the screen:
 * the demo's own grids run off the edge of a scrolling screen, and a clamp to
 * the picture would silently rewrite the game the first time a grid was opened.
 */
export function editSword1WalkBar(
  project: Project,
  resource: number,
  index: number,
  change: { end: 0 | 1 | null; x: number; y: number },
): void {
  const sword1 = sectionOf(project);
  const grid = (sword1.walkGrids ?? []).find((candidate) => candidate.resource === resource);
  if (!grid) throw new Sword1EditError(`This project holds no walk grid ${resource}.`);
  const bar = grid.bars[index];
  if (!bar) {
    throw new Sword1EditError(
      `Walk grid ${resource} holds ${grid.bars.length} bars and bar ${index} is outside it.`,
    );
  }
  (grid.bars as SwordWalkBar[])[index] = movedWalkBar(bar, change);
}

/** The bar a move produces, clamped to what a 16-bit field can hold. */
function movedWalkBar(
  bar: SwordWalkBar,
  change: { end: 0 | 1 | null; x: number; y: number },
): SwordWalkBar {
  const fit = (value: number): number => Math.max(-32768, Math.min(32767, Math.round(value)));
  if (change.end === 0) return { ...bar, x1: fit(change.x), y1: fit(change.y) };
  if (change.end === 1) return { ...bar, x2: fit(change.x), y2: fit(change.y) };
  // A whole bar moves by the delta between its midpoint and the new one, so a
  // drag puts the bar's middle where the pointer is and keeps its length.
  const dx = change.x - Math.round((bar.x1 + bar.x2) / 2);
  const dy = change.y - Math.round((bar.y1 + bar.y2) / 2);
  return {
    x1: fit(bar.x1 + dx),
    y1: fit(bar.y1 + dy),
    x2: fit(bar.x2 + dx),
    y2: fit(bar.y2 + dy),
  };
}

/**
 * Deletes a bar.
 *
 * Safe where deleting a *node* is not: nothing addresses a bar by its index.
 * Sword 1's router reads `nBars` bars in order and tests every one of them, so
 * a shorter list is a grid with one fewer wall and nothing else changed. A node
 * is addressed by index — the router reserves slot zero for the walking mega
 * and numbers the stored nodes from one — so there is no node delete here, and
 * `sceneCanvas.ts` says that rather than offering one that corrupts a route.
 */
export function deleteSword1WalkBar(project: Project, resource: number, index: number): void {
  const sword1 = sectionOf(project);
  const grid = (sword1.walkGrids ?? []).find((candidate) => candidate.resource === resource);
  if (!grid) throw new Sword1EditError(`This project holds no walk grid ${resource}.`);
  if (index < 0 || index >= grid.bars.length) {
    throw new Sword1EditError(
      `Walk grid ${resource} holds ${grid.bars.length} bars and bar ${index} is outside it.`,
    );
  }
  (grid.bars as SwordWalkBar[]).splice(index, 1);
}

/**
 * Moves one node.
 *
 * Moved and never added or removed, for the reason `deleteSword1WalkBar` gives:
 * a node's index is its name as far as the router is concerned.
 */
export function editSword1WalkNode(
  project: Project,
  resource: number,
  index: number,
  x: number,
  y: number,
): void {
  const sword1 = sectionOf(project);
  const grid = (sword1.walkGrids ?? []).find((candidate) => candidate.resource === resource);
  if (!grid) throw new Sword1EditError(`This project holds no walk grid ${resource}.`);
  if (index < 0 || index >= grid.nodes.length) {
    throw new Sword1EditError(
      `Walk grid ${resource} holds ${grid.nodes.length} nodes and node ${index} is outside it.`,
    );
  }
  const fit = (value: number): number => Math.max(-32768, Math.min(32767, Math.round(value)));
  (grid.nodes as SwordWalkNode[])[index] = { x: fit(x), y: fit(y) };
}

/*
 * ---------------------------------------------------------------------------
 * Appending and deleting a compact
 * ---------------------------------------------------------------------------
 *
 * `docs/editor-parity.md` §12a refused row 12 for both families on one
 * sentence: a section's own table gives a word offset per compact, so "a
 * compact that grew or a section that gained one would move every record after
 * it and leave every script that addresses them pointing at the wrong object".
 *
 * The first half of that is true and the second half is not, and the
 * difference is what these two functions are. A script names a compact by
 * `section * 0x10000 + index` — `SwordLogic.engine` builds exactly that id and
 * `SwordObjects.fetch` splits it again — and the index is a subscript into the
 * section's table, never a byte offset. So moving records *within* a section is
 * invisible to every script in the game as long as the table moves with them,
 * which is one loop.
 *
 * What is genuinely fixed is the numbering, and that is why this appends and
 * deletes from the end and never inserts. Measured on the demo:
 *
 * - all 96 sections pack their table tight against the first record (the first
 *   offset is `count + 1` words in every one of them), so a section that gains
 *   a record grows its table by one word and shifts every record by one word;
 * - all 96 sections put their **highest-indexed** compact at the **highest
 *   offset**, including the three whose tables are otherwise out of order, so
 *   a record removed from the end moves nothing that is still there;
 * - 13 of the 96 have a last compact whose id appears in no script operand and
 *   in no other compact's words. The other 83 are refused by name.
 */

/** `section * 0x10000 + index` — the id a script names a compact by. */
function sword1CompactId(section: number, index: number): number {
  return section * 0x10000 + index;
}

/**
 * Everywhere in the project a compact id is written down, as sentences.
 *
 * Two places, and both are searched because both would be left pointing at a
 * record that is not there. A script pushes the id as a literal operand —
 * `IT_PUSHNUMBER 0x00800000` is George — and a compact's own words hold ids
 * too: `o_place` names the floor a mega stands on and `o_target` the object a
 * get-to is heading for.
 *
 * Empty means nothing in this project mentions it, which is the only state in
 * which removing it is not a silent change to something else.
 */
export function sword1CompactReferences(project: Project, id: number): string[] {
  const sword1 = sectionOf(project);
  const found: string[] = [];
  const wanted = id >>> 0;

  for (const script of sword1.scripts) {
    let hits = 0;
    for (const instruction of script.instructions) {
      for (const operand of instruction.operands) if (operand >>> 0 === wanted) hits++;
    }
    if (hits > 0) {
      found.push(
        `script module 0x${script.resource.toString(16).toUpperCase()} pushes it ${hits} ` +
          `time${hits === 1 ? '' : 's'}`,
      );
    }
  }

  for (const section of sword1.sections) {
    for (const compact of section.compacts) {
      if (compact.id === id) continue;
      const record = fromBase64(compact.wordsBase64);
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      let hits = 0;
      for (let at = 0; at + 4 <= record.length; at += 4) {
        if (view.getUint32(at, true) === wanted) hits++;
      }
      if (hits > 0) {
        found.push(
          `compact 0x${compact.id.toString(16).toUpperCase()} holds it in ${hits} of its words`,
        );
      }
    }
  }
  return found;
}

/**
 * Copies a compact onto the end of its section and hands back the new index.
 *
 * A duplicate rather than a blank record, and that is a decision worth stating.
 * A compact is 3,085 words of fields the bytecode addresses by offset and the
 * logic engine runs every cycle; a record of zeroes has `o_type` 0, `o_logic`
 * 0 and a `o_tree` pointing at script 0, and what it does in the game is
 * undefined rather than nothing. A copy of a record the game itself ships is
 * the only starting point this project can say is legal, and every field of it
 * is then editable word by word on the object's own pane.
 *
 * The arithmetic is the whole of it. The table gains one entry, so every
 * record moves one word later and every offset already in the table goes up by
 * one; the new record lands one word past where the old payload ended; and the
 * payload grows by the table entry plus the record. `export.ts` writes the
 * section from `offsets`, `words` and `compacts` and needs no change at all —
 * and `rewriteResource` sets a compact section's two header lengths from the
 * resource's own total, which is what they already hold.
 */
export function appendSword1Compact(project: Project, section: number, source: number): number {
  const sword1 = sectionOf(project);
  const entry = sword1.sections.find((candidate) => candidate.section === section);
  if (!entry) throw new Sword1EditError(`This project holds no section ${section}.`);

  const template = entry.compacts.find((candidate) => candidate.index === source);
  if (!template) {
    throw new Sword1EditError(
      `Section ${section} has no object ${source} to copy. A new compact is a copy of one this ` +
        `game ships: a record of zeroes is not an empty object, it is an object whose o_type, ` +
        `o_logic and o_tree all mean something the logic engine would act on.`,
    );
  }

  const index = entry.offsets.length;
  if (index >= 0x10000) {
    throw new Sword1EditError(
      `Section ${section} already holds ${index} objects, which is every index a resource id's ` +
        `16-bit index field can name. There is no number left to give a new one.`,
    );
  }

  const record = fromBase64(template.wordsBase64);
  const at = entry.words + 1;
  (entry as { offsets: readonly number[] }).offsets = [
    ...entry.offsets.map((offset) => offset + 1),
    at,
  ];
  (entry as { words: number }).words = at + record.length / 4;
  (entry.compacts as Sword1ProjectCompact[]).push({
    id: sword1CompactId(section, index),
    section,
    index,
    wordsBase64: template.wordsBase64,
  });
  return index;
}

/**
 * Why the last compact of a section cannot be removed, or null when it can.
 *
 * Three questions, asked in the order that makes the answer readable: is it the
 * last one, is it also the last one in the resource, and does anything still
 * name it. The middle question sounds redundant and is not — three of the
 * demo's sections hold their offsets out of order, and a section whose highest
 * index sat in the middle of the payload would need every record after it moved
 * to close the hole.
 */
export function sword1CompactDeleteRefusal(
  project: Project,
  section: number,
  index: number,
): string | null {
  const sword1 = sectionOf(project);
  const entry = sword1.sections.find((candidate) => candidate.section === section);
  if (!entry) return `This project holds no section ${section}.`;

  const last = entry.offsets.length - 1;
  if (index !== last) {
    return (
      `Object ${index} is not the last of section ${section}'s ${entry.offsets.length}, and a ` +
      `compact's index is its name: removing this one would renumber objects ${index + 1} to ` +
      `${last} and every script that pushes one of those ids would then name its neighbour. ` +
      `Only the last record of a section can go.`
    );
  }

  const offset = entry.offsets[index];
  const highest = Math.max(...entry.offsets);
  if (offset !== highest) {
    return (
      `Object ${index} is section ${section}'s last by index and sits at word ${offset}, where ` +
      `another record sits at ${highest}. This section's table is out of order, so removing ` +
      `this one would leave a hole that closing would move a record something else still names.`
    );
  }

  const references = sword1CompactReferences(project, sword1CompactId(section, index));
  if (references.length > 0) {
    return (
      `Object ${index} of section ${section} is still named: ${references.join('; ')}. Removing ` +
      `it would leave those pointing at an index the section no longer declares.`
    );
  }
  return null;
}

/**
 * Removes the last compact of a section.
 *
 * The inverse of `appendSword1Compact` and it undoes the same three numbers:
 * the table loses its last entry so every record moves one word earlier, the
 * payload loses that word and the record's own words, and the compact goes
 * from the list. `sword1CompactDeleteRefusal` has already established that the
 * record being removed is the one the payload ends with, which is what makes
 * "the payload loses its words" a subtraction rather than a repack.
 */
export function deleteSword1Compact(project: Project, section: number, index: number): void {
  const refusal = sword1CompactDeleteRefusal(project, section, index);
  if (refusal) throw new Sword1EditError(refusal);

  const sword1 = sectionOf(project);
  const entry = sword1.sections.find((candidate) => candidate.section === section)!;
  const offset = entry.offsets[index];
  (entry as { offsets: readonly number[] }).offsets = entry.offsets
    .slice(0, index)
    .map((value) => value - 1);
  (entry as { words: number }).words = offset - 1;
  const at = entry.compacts.findIndex((candidate) => candidate.index === index);
  if (at >= 0) (entry.compacts as Sword1ProjectCompact[]).splice(at, 1);
}
