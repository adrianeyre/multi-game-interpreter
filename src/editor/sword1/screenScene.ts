/**
 * A Broken Sword screen as a picture, in the terms `sceneCanvas.ts` reads.
 *
 * Its own file, and nothing here is shared with Broken Sword II: ADR 0036 says
 * the two families share no resource layout, and they do not. Sword 1 keeps a
 * screen's background in a resource of its own whose bytes *are* the pixels,
 * its colours in two palette resources covering 0..183 and 184..255, and every
 * object's position in a compact. Sword II keeps all nine of those things in
 * one resource and a compressed one at that. The *widget* is shared; the
 * records are not.
 */

import { fromBase64 } from '../../authoring/base64.js';
import type { Project } from '../../authoring/project.js';
import type {
  Sword1Project,
  Sword1ProjectCompact,
  Sword1ProjectRoom,
} from '../../authoring/sword1/project.js';
import {
  deleteSword1WalkBar,
  editSword1CompactWord,
  editSword1WalkBar,
  editSword1WalkNode,
} from '../../authoring/sword1/edits.js';
import { CPT } from '../../engine/sword1/resource/swordCompact.js';
import { formatResourceId } from '../../engine/sword1/resource/rif.js';
import type {
  SceneGrid,
  SceneItem,
  SceneModel,
  ScenePicture,
  SceneWalk,
  SceneWalkSelection,
} from '../sceneCanvas.js';
import { sword1AbsentPictureReason } from './absence.js';

/**
 * The mask grid, `SCRNGRID_X` by `SCRNGRID_Y`.
 *
 * Overlaid because it is the unit everything about a Sword 1 screen is measured
 * in: a mask block, a priority test and a room's `gridWidth` all count in these
 * cells, and the numbers in the table below the canvas mean nothing without
 * them drawn.
 */
export const SWORD1_SCENE_GRID: SceneGrid = {
  cellWidth: 16,
  cellHeight: 8,
  label: 'mask block',
};

/** A compact's words, as the Int32 array the bytecode addresses. */
export function sword1CompactWords(compact: Sword1ProjectCompact): Int32Array {
  const bytes = fromBase64(compact.wordsBase64);
  return new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length >> 2);
}

/**
 * A screen's 256 colours.
 *
 * Both halves, widened the way the interpreter widens them — six bits shifted
 * up by two rather than scaled by 255/63, because the original's DAC does
 * exactly that and the "more correct" scaling makes every bright area visibly
 * lighter than the game. Colour 0 is black, as it is on screen.
 */
export function sword1ScreenPalette(sword1: Sword1Project, room: Sword1ProjectRoom): number[][] {
  const colours: number[][] = Array.from({ length: 256 }, () => [0, 0, 0]);

  room.palettes.forEach((resource, half) => {
    if (!resource) return;
    const palette = sword1.palettes.find((candidate) => candidate.resource === resource);
    if (!palette) return;
    const bytes = fromBase64(palette.bytesBase64);
    const start = half === 0 ? 0 : 184;
    const length = half === 0 ? 184 : 72;
    for (let at = 0; at < length; at++) {
      const index = start + at;
      if (index > 255) break;
      const from = at * 3;
      if (from + 2 >= bytes.length) break;
      if (start === 0 && at === 0) continue;
      colours[index] = [bytes[from] << 2, bytes[from + 1] << 2, bytes[from + 2] << 2];
    }
  });

  return colours;
}

/**
 * The background, or null when this project does not hold it.
 *
 * Layer 0's bytes are the pixels with no header skip — the asymmetry the
 * interpreter carries, where only the mask layers start past their header.
 */
export function sword1ScreenPicture(sword1: Sword1Project, screen: number): ScenePicture | null {
  const room = sword1.rooms.find((candidate) => candidate.screen === screen);
  if (!room || room.width === 0 || room.height === 0) return null;

  const resource = room.layers[0];
  const picture = resource
    ? sword1.pictures.find((candidate) => candidate.resource === resource)
    : undefined;
  if (!picture) return null;

  const bytes = fromBase64(picture.bytesBase64);
  const pixels = new Uint8Array(room.width * room.height);
  pixels.set(bytes.subarray(0, Math.min(bytes.length, pixels.length)));

  return {
    width: room.width,
    height: room.height,
    pixels,
    palette: sword1ScreenPalette(sword1, room),
  };
}

/**
 * Why there is no picture to draw, in the author's terms.
 *
 * Said rather than left blank: a project's pictures are budgeted, so a screen
 * whose background was over the budget is not a broken screen and the surface
 * should not look as though it were.
 */
export function sword1ScreenTrouble(sword1: Sword1Project, screen: number): string | null {
  const room = sword1.rooms.find((candidate) => candidate.screen === screen);
  if (!room) return `This project holds no screen ${screen}.`;
  if (room.width === 0 || room.height === 0) {
    return `Screen ${screen} has no size in the room table, so there is nothing to draw.`;
  }
  if (!room.layers[0]) return `Screen ${screen} names no background layer.`;
  if (!sword1.pictures.some((candidate) => candidate.resource === room.layers[0])) {
    // Which of the two absences it is, by cluster, rather than both hedged
    // together: an author reading "budget" about a cluster this release never
    // shipped goes looking for a setting to raise, and there is none.
    return (
      `${sword1AbsentPictureReason(sword1, room.layers[0])} ` +
      `The screen’s facts are below either way.`
    );
  }
  return null;
}

/**
 * Every compact standing on this screen.
 *
 * The box is the mouse area, because that is the rectangle the game itself
 * tests a click against — outlining the sprite instead would draw something
 * the engine does not use. A compact with no mouse area but a position is still
 * shown, as an eight-pixel marker on its own coordinates: megas are placed that
 * way and a screen that hid them would be missing its people.
 */
export function sword1ScreenItems(sword1: Sword1Project, screen: number): SceneItem[] {
  const items: SceneItem[] = [];
  const last = Math.max(CPT.MOUSE_Y2, CPT.SCREEN, CPT.YCOORD) >> 2;

  for (const section of sword1.sections) {
    for (const compact of section.compacts) {
      const words = sword1CompactWords(compact);
      if (words.length <= last) continue;
      if (words[CPT.SCREEN >> 2] !== screen) continue;

      const x1 = words[CPT.MOUSE_X1 >> 2];
      const y1 = words[CPT.MOUSE_Y1 >> 2];
      const x2 = words[CPT.MOUSE_X2 >> 2];
      const y2 = words[CPT.MOUSE_Y2 >> 2];
      const x = words[CPT.XCOORD >> 2];
      const y = words[CPT.YCOORD >> 2];
      const boxed = x2 > x1 && y2 > y1;
      if (!boxed && x === 0 && y === 0) continue;

      items.push({
        id: compact.id,
        name: `object ${formatResourceId(compact.id)}`,
        x: boxed ? x1 : x - 4,
        y: boxed ? y1 : y - 4,
        width: boxed ? x2 - x1 : 8,
        height: boxed ? y2 - y1 : 8,
        anchor: { x, y },
      });
    }
  }

  return items;
}

/**
 * Moves a compact, writing the words the move actually means.
 *
 * The mouse box and the position move together by the same delta, which is the
 * bargain the room canvas already makes with a walk-to point: dragging a thing
 * that left its own click target behind would be a drag that broke the game.
 * Only the fields that were meaningful are written — a compact with no mouse
 * area does not acquire one by being dragged.
 */
export function moveSword1Compact(
  project: Project,
  items: readonly SceneItem[],
  id: number,
  x: number,
  y: number,
): void {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return;
  const dx = x - item.x;
  const dy = y - item.y;
  if (dx === 0 && dy === 0) return;

  const sword1 = project.sword1;
  const compact = sword1?.sections
    .flatMap((section) => section.compacts)
    .find((candidate) => candidate.id === id);
  if (!compact) return;

  const words = sword1CompactWords(compact);
  const shift = (offset: number, delta: number): void => {
    editSword1CompactWord(project, id, offset >> 2, words[offset >> 2] + delta);
  };

  if (words[CPT.MOUSE_X2 >> 2] > words[CPT.MOUSE_X1 >> 2]) {
    shift(CPT.MOUSE_X1, dx);
    shift(CPT.MOUSE_X2, dx);
  }
  if (words[CPT.MOUSE_Y2 >> 2] > words[CPT.MOUSE_Y1 >> 2]) {
    shift(CPT.MOUSE_Y1, dy);
    shift(CPT.MOUSE_Y2, dy);
  }
  shift(CPT.XCOORD, dx);
  shift(CPT.YCOORD, dy);
}

/**
 * The walk grid a screen routes over, or null where none reaches it.
 *
 * A screen names its grid through a FLOOR compact's `o_resource`, and the
 * import carries the screens each grid is named by — so this is a lookup rather
 * than a search through the compacts a second time.
 *
 * Null is a real answer and not a failure: 91 of the demo's 100 screens are in
 * clusters this install does not ship, and their floors name grids that are not
 * here either.
 */
export function sword1ScreenWalkGrid(sword1: Sword1Project, screen: number) {
  return (sword1.walkGrids ?? []).find((grid) => grid.screens.includes(screen)) ?? null;
}

/** That grid as the overlay `sceneCanvas.ts` draws. */
export function sword1ScreenWalk(
  sword1: Sword1Project,
  screen: number,
  selected: SceneWalkSelection | null,
): SceneWalk | null {
  const grid = sword1ScreenWalkGrid(sword1, screen);
  if (!grid) return null;
  return {
    label: `walk grid ${formatResourceId(grid.resource)}`,
    bars: grid.bars.map((bar, index) => ({ index, ...bar })),
    nodes: grid.nodes.map((node, index) => ({ index, ...node })),
    selected,
  };
}

export interface Sword1SceneOptions {
  project: () => Project;
  update: (mutate: (project: Project) => void) => void;
  selected: () => number | null;
  select: (id: number | null) => void;
  /**
   * What is picked in the walk overlay, held by the surface rather than here.
   *
   * The surface owns it for the reason it owns the object selection: the canvas
   * is rebuilt from the document on every render, so a selection kept inside it
   * would be lost the first time a bar moved.
   */
  walkSelected?: () => SceneWalkSelection | null;
  selectWalk?: (selection: SceneWalkSelection | null) => void;
}

/** The model a `SceneCanvas` reads for one Broken Sword screen. */
export function sword1ScreenModel(screen: number, options: Sword1SceneOptions): SceneModel {
  const sword1 = (): Sword1Project | undefined => options.project().sword1;

  return {
    label: `Screen ${screen}`,
    help:
      'The screen’s background, with the mask grid over it and every object on it outlined. ' +
      'Arrow keys move the editing cursor one pixel, with Shift for eight. Enter or Space ' +
      'selects whatever is under the cursor. Alt with an arrow key moves the selected object, ' +
      'which moves its mouse area and its position together. Exact coordinates can also be ' +
      'typed into the object’s own fields. W switches to the walk grid, where Enter picks the ' +
      'bar or node under the cursor, Alt with an arrow moves it and Delete removes a bar — a ' +
      'node cannot be removed, because the router addresses nodes by index.',
    picture: () => {
      const project = sword1();
      return project ? sword1ScreenPicture(project, screen) : null;
    },
    items: () => {
      const project = sword1();
      return project ? sword1ScreenItems(project, screen) : [];
    },
    grid: () => SWORD1_SCENE_GRID,
    selected: options.selected,
    select: options.select,
    move: (id, x, y) => {
      const project = sword1();
      if (!project) return;
      const items = sword1ScreenItems(project, screen);
      options.update((draft) => moveSword1Compact(draft, items, id, x, y));
    },
    walk: () => {
      const project = sword1();
      return project ? sword1ScreenWalk(project, screen, options.walkSelected?.() ?? null) : null;
    },
    selectWalk: (selection) => options.selectWalk?.(selection),
    moveWalk: (selection, x, y) => {
      const project = sword1();
      const grid = project ? sword1ScreenWalkGrid(project, screen) : null;
      if (!grid) return;
      options.update((draft) => {
        if (selection.kind === 'node')
          editSword1WalkNode(draft, grid.resource, selection.index, x, y);
        else editSword1WalkBar(draft, grid.resource, selection.index, { end: selection.end, x, y });
      });
    },
    deleteWalkBar: (index) => {
      const project = sword1();
      const grid = project ? sword1ScreenWalkGrid(project, screen) : null;
      if (!grid) return;
      options.update((draft) => deleteSword1WalkBar(draft, grid.resource, index));
    },
  };
}
