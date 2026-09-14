/**
 * A Broken Sword II screen as a picture, in the terms `sceneCanvas.ts` reads.
 *
 * Its own file, sharing nothing with Sword 1 but the widget: ADR 0036. Where
 * Sword 1 keeps a background in a resource whose bytes are the pixels, Sword II
 * keeps nine things in one resource — two background parallax layers, the
 * background, two foreground ones, the mask table, the palette, the palette
 * match table and the mask data — and the background is a parallax layer like
 * the others, row offsets and run-length packets and all.
 */

import { fromBase64 } from '../../authoring/base64.js';
import type { Sword2Project } from '../../authoring/sword2/project.js';
import { parseSword2Parallax } from '../../engine/sword2/gfx/sword2Decode.js';
import {
  RES_HEADER_SIZE,
  SCREEN_HEADER_SIZE,
  readSword2MultiScreenHeader,
} from '../../engine/sword2/resource/sword2Headers.js';
import type { SceneModel, ScenePicture, SceneWalk, SceneWalkSelection } from '../sceneCanvas.js';
import type { Project } from '../../authoring/project.js';
import {
  deleteSword2WalkBar,
  editSword2WalkBar,
  editSword2WalkNode,
} from '../../authoring/sword2/edits.js';
import type { SceneItem } from '../sceneCanvas.js';
import {
  moveSword2Box,
  moveSword2Standby,
  sword2ScreenBoxes,
  sword2ScreenObjects,
  type Sword2BoxRefusal,
  type Sword2ObjectBox,
} from './screenBoxes.js';

/**
 * Why a read-only view of a Sword II screen moves nothing.
 *
 * This used to say that *nothing* on a Sword II screen could be dragged, on the
 * grounds that an object's position lives in an `ObjectMega` at an offset only
 * its own code knows. Measured, that turned out to be an argument for reading
 * the code rather than against dragging: see `screenBoxes.ts`, which reads the
 * offset out of the object's own `fnRegisterMouse` call, and
 * `docs/editor-parity.md` §7a. What is left here is the ordinary case a canvas
 * with no write path shows — the same sentence Sword 1's read-only views give.
 */
export const SWORD2_IMMOVABLE =
  'This view of the screen does not write, so nothing on it can be moved. Open the screen from ' +
  'the editor’s own Screens section to drag an object’s mouse area.';

/**
 * The note under the canvas: how many of this screen's objects can be dragged.
 *
 * A count and not a claim, and it is the panel's own answer rather than a
 * number copied from a document: it is computed from the same function the
 * canvas outlines with. A screen whose run list this release does not ship gets
 * the sentence saying so, which is a different thing from a screen with nothing
 * on it.
 */
export function sword2ScreenDragNote(sword2: Sword2Project, resource: number): string {
  const ids = sword2ScreenObjects(sword2, resource);
  if (!ids) {
    return (
      `No run list in this project names screen ${resource}’s session, so there is nothing to ` +
      `outline: a Broken Sword II screen has no table of the objects standing on it, and the ` +
      `only join is the two resources sharing a name ("Run list for 11", "Screen 11").`
    );
  }
  const { boxes, refused } = sword2ScreenBoxes(sword2, resource);
  const total = boxes.length + refused.length;
  const anchored = boxes.filter((box) => box.anchor !== null).length;
  const anchorRefused = boxes.filter((box) => box.anchorWhy !== null).length;
  return (
    `${boxes.length} of the ${total} ${total === 1 ? 'object' : 'objects'} in this screen’s ` +
    `session can be dragged. Each one’s mouse area is read out of its own script — the ` +
    `ObjectMouse offset from its fnRegisterMouse call, the four coordinates from the ` +
    `CP_PUSH_INT32s that write them — and a drag rewrites those operands. ` +
    (anchored === 0
      ? ''
      : `${anchored} of them also set a standby point — the router’s global stand-here target, ` +
        `which this object’s script sets before its own walk or stand call. It is drawn when ` +
        `the object is picked and it has a handle of its own: dragging the handle writes the ` +
        `two CP_PUSH_INT32s of that object’s fnSetStandbyCoords, and dragging the rectangle ` +
        `leaves it alone, because nothing in the data ties the two together. `) +
    (anchorRefused === 0
      ? ''
      : `${anchorRefused} ` +
        `${anchorRefused === 1 ? 'other sets a standby point' : 'others set standby points'} ` +
        `this editor will not move, named below with the reason. `) +
    (refused.length === 0 ? 'Nothing here is refused.' : 'The rest are named below.')
  );
}

/**
 * The objects on one screen whose standby point this editor will not move.
 *
 * A second list and not a second column in the first, because an object can be
 * in both states at once and they mean different things: its rectangle drags
 * fine and its stand-here point does not. Row 7's refusals say "this thing has
 * no place on the screen"; these say "this thing has a place and more than one
 * answer for where you stand to use it".
 */
export function sword2ScreenStandbyRefusals(
  sword2: Sword2Project,
  resource: number,
): readonly Sword2BoxRefusal[] {
  return sword2ScreenBoxes(sword2, resource)
    .boxes.filter((box) => box.anchorWhy !== null)
    .map((box) => ({ id: box.id, name: box.name, why: box.anchorWhy! }));
}

/** The refusals for one screen, each an object named with its reason. */
export function sword2ScreenRefusals(
  sword2: Sword2Project,
  resource: number,
): readonly Sword2BoxRefusal[] {
  return sword2ScreenBoxes(sword2, resource).refused;
}

/**
 * Every object on this screen whose rectangle its own code states.
 *
 * The box is the mouse area, for the reason Sword 1's items give: it is the
 * rectangle the game itself tests a click against. The anchor is the object's
 * `fnSetStandbyCoords` point where it sets exactly one — shown, because it is
 * where a character ends up when this object's own animation runs, and dragged
 * on its own handle, because it is a router global rather than a field of this
 * rectangle. An object whose standby point is refused has none here at all,
 * rather than one of its several drawn: `sword2ScreenStandbyRefusals` names it
 * instead. `Sword2ObjectBox.anchor` carries the measurement behind both.
 */
export function sword2ScreenItems(sword2: Sword2Project, resource: number): SceneItem[] {
  return sword2ScreenBoxes(sword2, resource).boxes.map((box) => ({
    id: box.id,
    name: box.name || `object ${box.id}`,
    x: box.x1.value,
    y: box.y1.value,
    width: box.x2.value - box.x1.value,
    height: box.y2.value - box.y1.value,
    anchor: box.anchor ? { x: box.anchor.x.value, y: box.anchor.y.value } : null,
  }));
}

/** The box record behind one item, which is what an edit is written through. */
export function sword2ScreenBox(
  sword2: Sword2Project,
  resource: number,
  id: number,
): Sword2ObjectBox | null {
  return sword2ScreenBoxes(sword2, resource).boxes.find((box) => box.id === id) ?? null;
}

/**
 * A screen's 256 colours.
 *
 * Four bytes an entry, not three: a screen palette carries an unused fourth
 * byte per colour, and reading it as triples shifts every colour after the
 * first into a picture that is recognisable and wrong. Colour 0 is black.
 */
export function sword2ScreenPalette(sword2: Sword2Project, resource: number): number[][] {
  const colours: number[][] = Array.from({ length: 256 }, () => [0, 0, 0]);
  const palette = sword2.palettes.find((candidate) => candidate.screen === resource);
  if (!palette) return colours;

  const bytes = fromBase64(palette.bytesBase64);
  for (let index = 1; index < 256; index++) {
    const from = index * 4;
    if (from + 2 >= bytes.length) break;
    colours[index] = [bytes[from], bytes[from + 1], bytes[from + 2]];
  }
  return colours;
}

/** The background layer, decoded, or null when this project does not hold it. */
export function sword2ScreenPicture(sword2: Sword2Project, resource: number): ScenePicture | null {
  const screen = sword2.screens.find((candidate) => candidate.resource === resource);
  if (!screen?.bytesBase64) return null;

  const bytes = fromBase64(screen.bytesBase64);
  if (bytes.length < RES_HEADER_SIZE + 36) return null;
  // Every offset in the multi-screen header is from the header's own start,
  // which is immediately after the resource header.
  const multi = readSword2MultiScreenHeader(bytes, RES_HEADER_SIZE);
  const background = parseSword2Parallax(
    bytes,
    RES_HEADER_SIZE + multi.screen + SCREEN_HEADER_SIZE,
  );
  if (!background) return null;

  return {
    width: background.width,
    height: background.height,
    pixels: background.pixels,
    palette: sword2ScreenPalette(sword2, resource),
  };
}

/** Why there is no picture to draw, in the author's terms. */
export function sword2ScreenTrouble(sword2: Sword2Project, resource: number): string | null {
  const screen = sword2.screens.find((candidate) => candidate.resource === resource);
  if (!screen) return `This project holds no screen ${resource}.`;
  if (!screen.bytesBase64) {
    return (
      `Screen ${resource}’s bytes are not in this project, so there is nothing to draw: ` +
      `importing takes screens until a budget runs out, and this one was past it. The screen’s ` +
      `facts are below; its pixels are still in the game’s cluster.`
    );
  }
  if (!sword2ScreenPicture(sword2, resource)) {
    return `Screen ${resource}’s background layer would not decode, so there is nothing to draw.`;
  }
  return null;
}

/**
 * The walk grid registered for this screen's session, or null where none is.
 *
 * "Registered for the session" rather than "belonging to the screen", because
 * that is what the data says: the import follows a run list to the objects in
 * it and their `fnAddWalkGrid` calls to a resource. A screen whose floor
 * computes the id, or whose run list is in a cluster this install does not
 * ship, has no grid here and the surface says so rather than drawing nothing.
 */
export function sword2ScreenWalkGrid(sword2: Sword2Project, resource: number) {
  return (sword2.walkGrids ?? []).find((grid) => grid.screens.includes(resource)) ?? null;
}

/** That grid as the overlay `sceneCanvas.ts` draws. */
export function sword2ScreenWalk(
  sword2: Sword2Project,
  resource: number,
  selected: SceneWalkSelection | null,
): SceneWalk | null {
  const grid = sword2ScreenWalkGrid(sword2, resource);
  if (!grid) return null;
  return {
    label: grid.name ? `walk grid ${grid.name}` : `walk grid ${grid.resource}`,
    bars: grid.bars.map((bar, index) => ({ index, ...bar })),
    nodes: grid.nodes.map((node, index) => ({ index, ...node })),
    selected,
  };
}

export interface Sword2SceneOptions {
  project: () => Sword2Project | undefined;
  selected: () => number | null;
  select: (id: number | null) => void;
  /**
   * How an edit is written, or absent on a surface that only shows.
   *
   * Absent rather than a no-op, so a read-only view of a screen leaves the
   * canvas without `moveWalk` and the canvas says the grid cannot be changed
   * instead of appearing to change one.
   */
  update?: (mutate: (project: Project) => void) => void;
  walkSelected?: () => SceneWalkSelection | null;
  selectWalk?: (selection: SceneWalkSelection | null) => void;
}

/**
 * The model a `SceneCanvas` reads for one Broken Sword II screen.
 *
 * `items` are the objects in this screen's run list whose own code states their
 * mouse area, and `move` rewrites the operands that state it — see
 * `screenBoxes.ts` for why that is a reading of the game's data and not a
 * guess. `move` is present only where the surface has somewhere to write, so a
 * read-only view still falls back to `immovable` rather than appearing to move
 * something.
 */
export function sword2ScreenModel(resource: number, options: Sword2SceneOptions): SceneModel {
  const items = (): SceneItem[] => {
    const project = options.project();
    return project ? sword2ScreenItems(project, resource) : [];
  };
  return {
    label: `Screen ${resource}`,
    help:
      'The screen’s background layer, decoded from the parallax format it is stored in. Arrow ' +
      'keys move the editing cursor one pixel, with Shift for eight. Enter picks the object ' +
      'under the cursor and Alt with an arrow moves it: what moves is the object’s mouse area — ' +
      'the rectangle the game tests a click against — written back into its own script. A ' +
      'picked object that sets a standby point shows it as a second handle, where the player ' +
      'stands to use the thing: move the cursor onto that handle, press Enter to pick it and ' +
      'Alt with an arrow to move it, and what is written is the object’s own ' +
      'fnSetStandbyCoords. The two move separately on purpose — the game ties them together ' +
      'nowhere. Objects whose script does not state a rectangle are ' +
      'named underneath with the reason rather than drawn at a guessed place. ' +
      'The walk grid its session registers can be edited too: W switches to it, Enter picks the ' +
      'bar or node under the cursor, Alt with an arrow moves it and Delete removes a bar — a ' +
      'node cannot be removed, because the router addresses nodes by index.',
    picture: () => {
      const project = options.project();
      return project ? sword2ScreenPicture(project, resource) : null;
    },
    items,
    grid: () => null,
    selected: options.selected,
    select: options.select,
    immovable: SWORD2_IMMOVABLE,
    anchorLabel: 'standby point',
    ...(options.update
      ? {
          move: (id: number, x: number, y: number) => {
            const project = options.project();
            const box = project ? sword2ScreenBox(project, resource, id) : null;
            if (!box) return;
            options.update?.((draft) => moveSword2Box(draft, box, x, y));
          },
          // Its own handle, not a second effect of `move`: §8a's measurement is
          // that the standby point is not a field of the rectangle, and 8 of
          // the demo's 57 sit hundreds of pixels from the box they belong to.
          moveAnchor: (id: number, x: number, y: number) => {
            const project = options.project();
            const box = project ? sword2ScreenBox(project, resource, id) : null;
            if (!box?.anchor) return;
            options.update?.((draft) => moveSword2Standby(draft, box, x, y));
          },
        }
      : {}),
    walk: () => {
      const project = options.project();
      return project ? sword2ScreenWalk(project, resource, options.walkSelected?.() ?? null) : null;
    },
    selectWalk: (selection) => options.selectWalk?.(selection),
    ...(options.update
      ? {
          moveWalk: (selection: SceneWalkSelection, x: number, y: number) => {
            const project = options.project();
            const grid = project ? sword2ScreenWalkGrid(project, resource) : null;
            if (!grid) return;
            options.update?.((draft) => {
              if (selection.kind === 'node') {
                editSword2WalkNode(draft, grid.resource, selection.index, x, y);
              } else {
                editSword2WalkBar(draft, grid.resource, selection.index, {
                  end: selection.end,
                  x,
                  y,
                });
              }
            });
          },
          deleteWalkBar: (index: number) => {
            const project = options.project();
            const grid = project ? sword2ScreenWalkGrid(project, resource) : null;
            if (!grid) return;
            options.update?.((draft) => deleteSword2WalkBar(draft, grid.resource, index));
          },
        }
      : {}),
  };
}
