/**
 * The picture half of a room editor, in the terms every family can meet.
 *
 * `RoomCanvas` had all of this welded to SCUMM: it reads `EditorState`, it
 * mutates `ProjectRoom`, and its tools are SCUMM's tools — paint a pixel,
 * draw a walk box, place an object. None of that transfers as it stands. A
 * Broken Sword screen has no walk *boxes* — Sword 1 routes over bars and nodes
 * in a walk-grid resource a floor object names, and Sword 2 over the grids
 * `fnAddWalkGrid` registers for a session — and no object table to add to: a
 * compact's word count is fixed by the section table that addresses it.
 *
 * The walkable half of that is now a *shared* overlay rather than a SCUMM one:
 * `SceneWalk` is bars and nodes, which is what both Sword families store, and
 * the canvas draws them, hit-tests them, moves them and deletes a bar. SCUMM's
 * boxes are still SCUMM's, because a box is a polygon and a bar is a segment —
 * that is a genuine difference in the data and not a missing adapter.
 *
 * Pixels are the one of the three that is a missing *tool* rather than a
 * missing possibility, and `docs/editor-parity.md` says so on its own row. A
 * Sword picture is replaced whole, by importing a PNG over a frame; every
 * compression both families use re-encodes to the bytes the games shipped, and
 * `npm run reexport:sword` paints a pixel of a background and reads it back out
 * of the rebuilt cluster. Nothing in the format stops a brush; nobody has
 * written one.
 *
 * What *does* transfer is the part underneath the tools: expand an indexed
 * picture through a palette, overlay a grid, outline the things that sit on the
 * screen, hit-test them topmost-first, drag one, and let a keyboard do all of
 * it. That is the seam, and it is deliberately the smallest one both sides
 * satisfy — a SCUMM `ProjectObject` is a `SceneItem` with no adapter at all,
 * and a Broken Sword compact becomes one by reading four words.
 *
 * So this is a widening rather than a fork: `RoomCanvas` paints and hit-tests
 * through the functions below, and the Sword screens get a canvas that shares
 * them. A family that can move nothing says so in `immovable`, which the
 * surface shows — an editor that silently refuses a drag teaches nothing.
 */

import {
  KeyboardCursor,
  describeCanvas,
  drawCursor,
  isActivation,
  isErase,
} from './canvasKeyboard.js';

/** An indexed picture and the colours its indices name. */
export interface ScenePicture {
  readonly width: number;
  readonly height: number;
  /** `width * height` palette indices. */
  readonly pixels: Uint8Array;
  /** 256 `[r, g, b]` triples, already widened to eight bits per channel. */
  readonly palette: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * Something that sits on the screen at a place.
 *
 * `anchor` is the second point an item can carry — SCUMM's walk-to, Broken
 * Sword 1's `o_xcoord`/`o_ycoord`, Broken Sword II's `fnSetStandbyCoords`.
 * Whether it moves with the item is the family's answer and not this file's:
 * where the two are fields of one record it follows the drag, and where they
 * are two records that merely sit near each other it does not. A family that
 * says it does not offers `SceneModel.moveAnchor` instead, and the canvas gives
 * the anchor a handle of its own.
 */
export interface SceneItem {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchor?: { readonly x: number; readonly y: number } | null;
}

/** A regular overlay, drawn over the picture. */
export interface SceneGrid {
  readonly cellWidth: number;
  readonly cellHeight: number;
  /** What the grid *is*, said on the surface and to a screen reader. */
  readonly label: string;
}

/**
 * One bar: a segment a walking character may not cross.
 *
 * Two endpoints and nothing else, which is what `swordWalkGrid.ts` carries and
 * for the reason it gives — a bar's bounding box, deltas and line constant are
 * all derivable, and an editor holding eleven numbers where four will do is an
 * editor that can make ten of them disagree.
 */
export interface SceneWalkBar {
  readonly index: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** One node: a point the router may route *through*. */
export interface SceneWalkNode {
  readonly index: number;
  readonly x: number;
  readonly y: number;
}

/**
 * What is picked in the walk overlay.
 *
 * A bar can be picked by one end or as a whole, and the difference is the
 * difference between reshaping a wall and sliding it: `end` null means both
 * endpoints move together.
 */
export type SceneWalkSelection =
  | { readonly kind: 'node'; readonly index: number }
  | { readonly kind: 'bar'; readonly index: number; readonly end: 0 | 1 | null };

/** The walkable overlay: the bars and nodes a family routes over. */
export interface SceneWalk {
  /** What it is, on the surface and to a screen reader. */
  readonly label: string;
  readonly bars: readonly SceneWalkBar[];
  readonly nodes: readonly SceneWalkNode[];
  readonly selected: SceneWalkSelection | null;
}

/** How near a pointer or cursor has to be, in picture pixels, to pick one. */
export const SCENE_WALK_RADIUS = 4;

/** Whether two selections name the same thing. */
export function sameSceneWalkSelection(
  left: SceneWalkSelection | null,
  right: SceneWalkSelection | null,
): boolean {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind || left.index !== right.index) return false;
  return left.kind !== 'bar' || right.kind !== 'bar' || left.end === right.end;
}

/** Square of the distance from a point to a segment. */
function distanceToSegment(
  x: number,
  y: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/**
 * What a point picks out of the overlay.
 *
 * Ordered rather than nearest-wins, and the order is what makes the overlay
 * usable: a node first, then a bar's *end*, then the bar's body. An author
 * aiming at the corner where two bars meet wants the corner, and a nearest-wins
 * search would hand them whichever bar's middle happened to be a tenth of a
 * pixel closer.
 */
export function sceneWalkAt(
  walk: SceneWalk,
  x: number,
  y: number,
  radius = SCENE_WALK_RADIUS,
): SceneWalkSelection | null {
  const nearest = (
    candidates: ReadonlyArray<{ selection: SceneWalkSelection; distance: number }>,
  ): SceneWalkSelection | null => {
    let best: { selection: SceneWalkSelection; distance: number } | null = null;
    for (const candidate of candidates) {
      if (candidate.distance > radius) continue;
      if (!best || candidate.distance < best.distance) best = candidate;
    }
    return best?.selection ?? null;
  };

  return (
    nearest(
      walk.nodes.map((node) => ({
        selection: { kind: 'node' as const, index: node.index },
        distance: Math.hypot(x - node.x, y - node.y),
      })),
    ) ??
    nearest(
      walk.bars.flatMap((bar) => [
        {
          selection: { kind: 'bar' as const, index: bar.index, end: 0 as const },
          distance: Math.hypot(x - bar.x1, y - bar.y1),
        },
        {
          selection: { kind: 'bar' as const, index: bar.index, end: 1 as const },
          distance: Math.hypot(x - bar.x2, y - bar.y2),
        },
      ]),
    ) ??
    nearest(
      walk.bars.map((bar) => ({
        selection: { kind: 'bar' as const, index: bar.index, end: null },
        distance: distanceToSegment(x, y, bar.x1, bar.y1, bar.x2, bar.y2),
      })),
    )
  );
}

/**
 * Where a selection *is*, which is what a move is measured against.
 *
 * A whole bar's point is its midpoint, so "move it to here" means the same
 * thing for a bar as it does for a node rather than meaning "put one end here".
 */
export function sceneWalkPoint(
  walk: SceneWalk,
  selection: SceneWalkSelection,
): { x: number; y: number } | null {
  if (selection.kind === 'node') {
    const node = walk.nodes.find((candidate) => candidate.index === selection.index);
    return node ? { x: node.x, y: node.y } : null;
  }
  const bar = walk.bars.find((candidate) => candidate.index === selection.index);
  if (!bar) return null;
  if (selection.end === 0) return { x: bar.x1, y: bar.y1 };
  if (selection.end === 1) return { x: bar.x2, y: bar.y2 };
  return { x: Math.round((bar.x1 + bar.x2) / 2), y: Math.round((bar.y1 + bar.y2) / 2) };
}

/** "Bar 12, 40, 300 to 120, 300", for the live region and the status line. */
export function describeSceneWalk(walk: SceneWalk, selection: SceneWalkSelection): string {
  if (selection.kind === 'node') {
    const node = walk.nodes.find((candidate) => candidate.index === selection.index);
    return node ? `Node ${node.index} at ${node.x}, ${node.y}` : `Node ${selection.index}`;
  }
  const bar = walk.bars.find((candidate) => candidate.index === selection.index);
  if (!bar) return `Bar ${selection.index}`;
  const where = `${bar.x1}, ${bar.y1} to ${bar.x2}, ${bar.y2}`;
  if (selection.end === null) return `Bar ${bar.index}, ${where}`;
  return `Bar ${bar.index} end ${selection.end + 1}, ${where}`;
}

/** What the cursor is over in the overlay, for the live region. */
export function describeSceneWalkUnder(walk: SceneWalk, x: number, y: number): string {
  const under = sceneWalkAt(walk, x, y);
  return under ? `${x}, ${y} — ${describeSceneWalk(walk, under)}` : `${x}, ${y}`;
}

/**
 * What a key aimed at the walk overlay should do, decided and not yet done.
 *
 * A refusal is a result and not a silence: a grid this surface cannot write, a
 * node asked to be deleted, nothing selected at all — each one has a sentence,
 * and `SceneCanvas` says it into the live region.
 */
export type SceneWalkAction =
  | {
      readonly kind: 'move';
      readonly selection: SceneWalkSelection;
      readonly x: number;
      readonly y: number;
    }
  | { readonly kind: 'delete'; readonly index: number }
  | { readonly kind: 'refuse'; readonly message: string };

/** Where an arrow, held with Alt, would put what is selected. */
export function sceneWalkNudge(
  model: SceneModel,
  walk: SceneWalk,
  key: string,
  step: number,
): SceneWalkAction {
  const selection = walk.selected;
  if (!selection)
    return { kind: 'refuse', message: 'Nothing in the walk grid is selected to move.' };
  if (!model.moveWalk) {
    return { kind: 'refuse', message: model.walkImmutable ?? 'This walk grid cannot be changed.' };
  }
  const picture = model.picture();
  const at = sceneWalkPoint(walk, selection);
  if (!picture || !at) {
    return { kind: 'refuse', message: 'This screen has no picture to move over.' };
  }
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  // Clamped to the picture, the same way a dragged corner is: a bar off the
  // screen is a bar nobody can get back to.
  const next = dragScenePoint(picture, at.x + dx, at.y + dy);
  return { kind: 'move', selection, x: next.x, y: next.y };
}

/** What Delete would do to what is selected, including when it would not. */
export function sceneWalkDeletion(model: SceneModel, walk: SceneWalk): SceneWalkAction {
  const selection = walk.selected;
  if (!selection) {
    return { kind: 'refuse', message: 'Nothing in the walk grid is selected to delete.' };
  }
  if (selection.kind === 'node') {
    // Said rather than done: see `SceneModel.deleteWalkBar`.
    return {
      kind: 'refuse',
      message:
        'A node cannot be deleted: the scripts address nodes by index, so removing one ' +
        'renumbers every node after it.',
    };
  }
  if (!model.deleteWalkBar) {
    return { kind: 'refuse', message: model.walkImmutable ?? 'This walk grid cannot be changed.' };
  }
  return { kind: 'delete', index: selection.index };
}

/**
 * What a canvas asks its family for.
 *
 * Read through functions rather than held as data, because every one of these
 * surfaces rebuilds its view from the project document on each render and a
 * snapshot taken at construction would be stale by the first edit.
 */
export interface SceneModel {
  /** The canvas's accessible name. */
  readonly label: string;
  /** The key map, read at leisure rather than announced in one breath. */
  readonly help: string;
  picture(): ScenePicture | null;
  items(): readonly SceneItem[];
  grid(): SceneGrid | null;
  selected(): number | null;
  select(id: number | null): void;
  /**
   * Moves an item's top-left corner, or is absent when nothing can move.
   *
   * Absent rather than a no-op: the canvas turns its presence into whether a
   * drag starts at all, and its absence into the sentence in `immovable`.
   */
  move?(id: number, x: number, y: number): void;
  /** Why `move` is absent, in the author's terms. */
  readonly immovable?: string;
  /**
   * Moves an item's anchor on its own, or is absent where it has no handle.
   *
   * Present means two things at once: that this family's anchor is a record an
   * author can write, and that it does **not** follow `move`. SCUMM's walk-to
   * and Sword 1's `o_xcoord`/`o_ycoord` are fields of the same record as the
   * box, so they move with it and leave this absent; Sword II's standby point
   * is a router global its script happens to set beside the box, so it gets its
   * own handle and this is how it is written.
   */
  moveAnchor?(id: number, x: number, y: number): void;
  /**
   * What this family calls that second point, for what is said aloud.
   *
   * ADR 0013's standard is the same capability in the family's own terms, and a
   * Sword II author reading "walk-to point" would go looking for a field the
   * format does not have. Defaults to `walk-to point`, which is what the two
   * families that leave it unset call theirs.
   */
  readonly anchorLabel?: string;
  /**
   * The walkable overlay, or absent where the family has none to show.
   *
   * Absent rather than empty, so the canvas can leave the `w` key alone on a
   * surface with no walk data rather than offering a mode that shows nothing.
   */
  walk?(): SceneWalk | null;
  selectWalk?(selection: SceneWalkSelection | null): void;
  /** Moves what is selected so its point (see `sceneWalkPoint`) lands here. */
  moveWalk?(selection: SceneWalkSelection, x: number, y: number): void;
  /**
   * Deletes a bar. Bars only, and that is the format's doing rather than a
   * missing case: a Sword node is addressed by its index — Sword 1's router
   * numbers from one and reserves slot zero for the mega — so removing one
   * renumbers every node after it, and this project will not do that silently.
   */
  deleteWalkBar?(index: number): void;
  /** Why the walk overlay cannot be changed, where it cannot. */
  readonly walkImmutable?: string;
}

/**
 * Expands indexed pixels into an `ImageData` buffer.
 *
 * A missing palette entry draws black rather than throwing: a picture imported
 * from a published game can name a colour its room's two palettes do not cover,
 * and a screen that fails to draw teaches less than one drawn with a hole.
 */
export function paintScene(out: Uint8ClampedArray, picture: ScenePicture): void {
  const count = Math.min(picture.pixels.length, Math.floor(out.length / 4));
  for (let i = 0, j = 0; i < count; i++, j += 4) {
    const entry = picture.palette[picture.pixels[i]] ?? [0, 0, 0];
    out[j] = entry[0] ?? 0;
    out[j + 1] = entry[1] ?? 0;
    out[j + 2] = entry[2] ?? 0;
    out[j + 3] = 255;
  }
}

/**
 * The topmost item covering a point.
 *
 * Last-drawn wins, which is what the author sees: the search runs backwards
 * through the list for exactly that reason.
 */
export function sceneItemAt(items: readonly SceneItem[], x: number, y: number): SceneItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height) {
      return item;
    }
  }
  return null;
}

/**
 * Where a drag puts an item, given where it was grabbed.
 *
 * Clamped so the corner stays on the picture. Not clamped to keep the whole
 * item on it: Broken Sword's mouse boxes routinely hang off the edge of a
 * scrolling room, and a clamp that "fixed" them would silently rewrite the
 * game.
 */
export function dragScenePoint(
  picture: ScenePicture,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(picture.width - 1, Math.round(x))),
    y: Math.max(0, Math.min(picture.height - 1, Math.round(y))),
  };
}

/** How near a pointer or cursor has to be, in picture pixels, to grab an anchor. */
export const SCENE_ANCHOR_RADIUS = 4;

/** What this family calls an item's second point. */
export function sceneAnchorLabel(model: SceneModel): string {
  return model.anchorLabel ?? 'walk-to point';
}

/**
 * The item whose anchor handle a point grabs, or null.
 *
 * Only the selected item, and only where the family gave the anchor a handle at
 * all. Both halves matter: the anchor is drawn for the picked item alone, and a
 * handle that could be grabbed where nothing is drawn is a canvas that moves
 * something invisible. It is tested *before* the item's own body, the way
 * `RoomCanvas` tests a box's resize handles first, so an anchor that sits
 * inside its own rectangle can still be reached.
 */
export function sceneAnchorAt(
  model: SceneModel,
  x: number,
  y: number,
  radius = SCENE_ANCHOR_RADIUS,
): SceneItem | null {
  if (!model.moveAnchor) return null;
  const id = model.selected();
  if (id === null) return null;
  const item = model.items().find((candidate) => candidate.id === id);
  if (!item?.anchor) return null;
  return Math.hypot(x - item.anchor.x, y - item.anchor.y) <= radius ? item : null;
}

/** What a key aimed at an anchor should do, decided and not yet done. */
export type SceneAnchorAction =
  | { readonly kind: 'move'; readonly id: number; readonly x: number; readonly y: number }
  | { readonly kind: 'refuse'; readonly message: string };

/**
 * Where an arrow, held with Alt, would put a picked anchor.
 *
 * The keyboard equivalent of dragging its handle, and pure for the reason
 * `sceneWalkNudge` is pure: jsdom has no 2D context, so a decision made inside
 * `SceneCanvas` is a decision no test can reach.
 */
export function sceneAnchorNudge(
  model: SceneModel,
  id: number,
  key: string,
  step: number,
): SceneAnchorAction {
  const label = sceneAnchorLabel(model);
  if (!model.moveAnchor) {
    return { kind: 'refuse', message: `This ${label} cannot be moved.` };
  }
  const item = model.items().find((candidate) => candidate.id === id);
  const picture = model.picture();
  if (!item?.anchor || !picture) {
    return { kind: 'refuse', message: `There is no ${label} selected to move.` };
  }
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
  // Clamped to the picture for `dragScenePoint`'s reason: a point off the
  // screen is a point nobody can get back to.
  const next = dragScenePoint(picture, item.anchor.x + dx, item.anchor.y + dy);
  return { kind: 'move', id, x: next.x, y: next.y };
}

/** "48, 96 — object 0x0100000A", for the announcement after a keyboard move. */
export function describeScenePoint(model: SceneModel, x: number, y: number): string {
  const parts = [`${x}, ${y}`];
  // The anchor handle first, because it is the smaller thing and it is the one
  // a keyboard author has no other way of discovering: it is drawn as a dot
  // four pixels across, and nothing else says it is under the cursor.
  const anchored = sceneAnchorAt(model, x, y);
  if (anchored) parts.push(`${anchored.name}’s ${sceneAnchorLabel(model)}`);
  const item = sceneItemAt(model.items(), x, y);
  if (item) parts.push(item.name);
  const grid = model.grid();
  if (grid) {
    parts.push(
      `${grid.label} ${Math.floor(x / grid.cellWidth)}, ${Math.floor(y / grid.cellHeight)}`,
    );
  }
  return parts.join(' — ');
}

export interface SceneCanvasOptions {
  /** Unique on the page: the description element's id. */
  id: string;
  /** Screen pixels per picture pixel. */
  scale?: number;
  /** Said after a key does something, for the surface's live region. */
  onChange?: (message: string) => void;
}

/**
 * The canvas itself: a thin shell over the functions above.
 *
 * Thin deliberately. Everything worth testing is pure and tested; jsdom has no
 * 2D context, so a class that held the decisions would be a class no test could
 * construct. This is the same bargain `RoomCanvas` already makes.
 */
export class SceneCanvas {
  readonly element: HTMLCanvasElement;
  /** The description element, placed beside the canvas by the surface. */
  readonly help: HTMLElement;

  private readonly context: CanvasRenderingContext2D;
  private readonly model: SceneModel;
  private readonly onChange: ((message: string) => void) | null;
  private readonly cursor = new KeyboardCursor();
  private imageData: ImageData | null = null;
  private drag: { id: number; grabX: number; grabY: number } | null = null;
  /**
   * Whether the pointer and the arrows are aimed at the walk overlay.
   *
   * A mode rather than a modifier, because the two things a click could mean
   * are both wanted often: an author lines a bar up against the scenery, then
   * checks which object the scenery belongs to. `w` says which, and the canvas
   * announces it — an unannounced mode is a canvas that has stopped answering.
   */
  private walkMode = false;
  private walkDrag: SceneWalkSelection | null = null;
  /**
   * The item whose anchor handle the arrows are aimed at, or null.
   *
   * A pick and not a mode: the handle is a thing on the canvas, so it is picked
   * the way everything else on the canvas is picked — by pressing Enter over it
   * — and picking anything else lets it go.
   */
  private anchorPicked: number | null = null;
  private anchorDrag: number | null = null;

  scale: number;

  constructor(model: SceneModel, options: SceneCanvasOptions, element: HTMLCanvasElement) {
    this.model = model;
    this.onChange = options.onChange ?? null;
    this.scale = options.scale ?? 1;
    this.element = element;
    this.element.className = 'scene-canvas';

    const context = element.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;

    this.help = describeCanvas(this.element, {
      id: options.id,
      label: model.label,
      help: model.help,
    });

    this.element.addEventListener('focus', () => {
      this.cursor.visible = true;
      this.render();
    });
    this.element.addEventListener('blur', () => {
      this.cursor.visible = false;
      this.render();
    });
    this.element.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.attachPointerHandlers();
    this.render();
  }

  /**
   * The anchor handle the arrows are aimed at, if it is still the picked one.
   *
   * Checked against the selection rather than trusted, because the selection is
   * the surface's and can change without the canvas being touched — a list row
   * clicked in the sidebar is the ordinary case. A stale pick would move the
   * anchor of an object the author is no longer looking at.
   */
  private get pickedAnchor(): number | null {
    if (this.anchorPicked === null) return null;
    return this.anchorPicked === this.model.selected() ? this.anchorPicked : null;
  }

  /** The picture's size, which is what the cursor is clamped to. */
  private get bounds(): { width: number; height: number } {
    const picture = this.model.picture();
    return {
      width: picture?.width ?? this.element.width,
      height: picture?.height ?? this.element.height,
    };
  }

  private onKeyDown(event: KeyboardEvent): void {
    const walk = this.model.walk?.() ?? null;

    // `w` turns the walk overlay's own editing on and off. Only where there is
    // an overlay: a family with none keeps the key for whatever it wants.
    if (walk && (event.key === 'w' || event.key === 'W') && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      this.walkMode = !this.walkMode;
      this.render();
      this.onChange?.(
        this.walkMode
          ? `Editing ${walk.label}. Enter picks the bar or node under the cursor, ` +
              `Alt with an arrow moves it, Delete removes a bar.`
          : 'Back to selecting objects.',
      );
      return;
    }

    // Alt with an arrow moves what is selected, which is the keyboard's version
    // of dragging it. Checked before plain movement, or the cursor would move
    // instead of the item.
    if (event.altKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      const step = event.shiftKey ? 8 : 1;
      if (this.walkMode && walk) {
        this.applyWalk(walk, sceneWalkNudge(this.model, walk, event.key, step));
      } else if (this.pickedAnchor !== null) {
        this.applyAnchor(sceneAnchorNudge(this.model, this.pickedAnchor, event.key, step));
      } else this.nudge(event.key, step);
      return;
    }

    if (this.walkMode && walk && isErase(event)) {
      event.preventDefault();
      this.applyWalk(walk, sceneWalkDeletion(this.model, walk));
      return;
    }

    if (this.cursor.handle(event, this.bounds)) {
      event.preventDefault();
      this.render();
      this.onChange?.(
        this.walkMode && walk
          ? describeSceneWalkUnder(walk, this.cursor.x, this.cursor.y)
          : describeScenePoint(this.model, this.cursor.x, this.cursor.y),
      );
      return;
    }

    if (isActivation(event)) {
      event.preventDefault();
      if (this.walkMode && walk) {
        const picked = sceneWalkAt(walk, this.cursor.x, this.cursor.y);
        this.model.selectWalk?.(picked);
        this.render();
        this.onChange?.(
          picked ? `Selected ${describeSceneWalk(walk, picked)}.` : `No bar or node here.`,
        );
        return;
      }
      // The anchor handle first, for `sceneAnchorAt`'s reason: it is drawn on
      // top of its own rectangle and often inside it, so an item-first search
      // would make it unreachable from the keyboard.
      const anchored = sceneAnchorAt(this.model, this.cursor.x, this.cursor.y);
      if (anchored) {
        this.anchorPicked = anchored.id;
        this.render();
        this.onChange?.(
          `Selected ${anchored.name}’s ${sceneAnchorLabel(this.model)}, at ` +
            `${anchored.anchor!.x}, ${anchored.anchor!.y}. Alt with an arrow moves it.`,
        );
        return;
      }
      const item = sceneItemAt(this.model.items(), this.cursor.x, this.cursor.y);
      this.anchorPicked = null;
      this.model.select(item?.id ?? null);
      this.render();
      this.onChange?.(item ? `Selected ${item.name}.` : 'Nothing selected.');
    }
  }

  /**
   * Carries out what `sceneAnchorNudge` decided, and says what happened.
   *
   * The same shape as `applyWalk`, and for the same reason: the deciding is out
   * there and pure so a test can reach it, and what is left here is the
   * mutation and the sentence afterwards.
   */
  private applyAnchor(action: SceneAnchorAction): void {
    if (action.kind === 'refuse') {
      this.onChange?.(action.message);
      return;
    }
    const item = this.model.items().find((candidate) => candidate.id === action.id);
    this.model.moveAnchor?.(action.id, action.x, action.y);
    this.render();
    this.onChange?.(
      `Moved ${item?.name ?? `item ${action.id}`}’s ${sceneAnchorLabel(this.model)} to ` +
        `${action.x}, ${action.y}.`,
    );
  }

  /**
   * Carries out what `sceneWalkNudge` or `sceneWalkDeletion` decided.
   *
   * The deciding is out there and pure so that it can be tested — jsdom has no
   * 2D context, so nothing reachable only through this class is — and what is
   * left here is the mutation and the sentence said afterwards.
   */
  private applyWalk(walk: SceneWalk, action: SceneWalkAction): void {
    if (action.kind === 'refuse') {
      this.onChange?.(action.message);
      return;
    }
    if (action.kind === 'move') {
      this.model.moveWalk?.(action.selection, action.x, action.y);
      this.render();
      const after = this.model.walk?.() ?? walk;
      this.onChange?.(`Moved ${describeSceneWalk(after, action.selection)}.`);
      return;
    }
    const described = describeSceneWalk(walk, { kind: 'bar', index: action.index, end: null });
    this.model.deleteWalkBar?.(action.index);
    this.model.selectWalk?.(null);
    this.render();
    this.onChange?.(`Deleted ${described}.`);
  }

  private nudge(key: string, step: number): void {
    const id = this.model.selected();
    const move = this.model.move;
    if (id === null) {
      this.onChange?.('Nothing is selected to move.');
      return;
    }
    if (!move) {
      this.onChange?.(this.model.immovable ?? 'Nothing on this screen can be moved.');
      return;
    }

    const item = this.model.items().find((candidate) => candidate.id === id);
    const picture = this.model.picture();
    if (!item || !picture) return;

    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    const next = dragScenePoint(picture, item.x + dx, item.y + dy);
    move.call(this.model, id, next.x, next.y);
    this.render();
    this.onChange?.(`Moved ${item.name} to ${next.x}, ${next.y}.`);
  }

  /** Canvas pixel under a pointer event, in picture coordinates. */
  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect();
    const width = bounds.width || this.element.width;
    const height = bounds.height || this.element.height;
    return {
      x: Math.floor(((event.clientX - bounds.left) / width) * this.element.width),
      y: Math.floor(((event.clientY - bounds.top) / height) * this.element.height),
    };
  }

  private attachPointerHandlers(): void {
    this.element.addEventListener('pointerdown', (event) => {
      const { x, y } = this.pointerPosition(event);
      this.element.setPointerCapture(event.pointerId);
      this.cursor.x = x;
      this.cursor.y = y;
      const walk = this.walkMode ? (this.model.walk?.() ?? null) : null;
      if (walk) {
        const picked = sceneWalkAt(walk, x, y);
        this.model.selectWalk?.(picked);
        this.walkDrag = picked && this.model.moveWalk ? picked : null;
        this.render();
        this.onChange?.(
          picked ? `Selected ${describeSceneWalk(walk, picked)}.` : 'No bar or node here.',
        );
        return;
      }
      const anchored = sceneAnchorAt(this.model, x, y);
      if (anchored) {
        this.anchorPicked = anchored.id;
        this.anchorDrag = anchored.id;
        this.render();
        this.onChange?.(
          `Selected ${anchored.name}’s ${sceneAnchorLabel(this.model)}, at ` +
            `${anchored.anchor!.x}, ${anchored.anchor!.y}.`,
        );
        return;
      }
      const item = sceneItemAt(this.model.items(), x, y);
      this.anchorPicked = null;
      this.model.select(item?.id ?? null);
      this.cursor.x = x;
      this.cursor.y = y;
      if (item && this.model.move) {
        this.drag = { id: item.id, grabX: x - item.x, grabY: y - item.y };
      }
      this.render();
      this.onChange?.(item ? `Selected ${item.name}.` : 'Nothing selected.');
    });

    this.element.addEventListener('pointermove', (event) => {
      const anchorDrag = this.anchorDrag;
      if (anchorDrag !== null) {
        const picture = this.model.picture();
        if (!picture) return;
        const { x, y } = this.pointerPosition(event);
        // Straight to the pointer rather than by a grab offset: the handle is
        // five pixels across and the thing being placed *is* the point, so
        // "where I let go" is the whole of what an author means.
        const next = dragScenePoint(picture, x, y);
        this.model.moveAnchor?.(anchorDrag, next.x, next.y);
        this.render();
        return;
      }
      const walkDrag = this.walkDrag;
      if (walkDrag) {
        const picture = this.model.picture();
        if (!picture) return;
        const { x, y } = this.pointerPosition(event);
        const next = dragScenePoint(picture, x, y);
        this.model.moveWalk?.(walkDrag, next.x, next.y);
        this.render();
        return;
      }
      const drag = this.drag;
      const picture = this.model.picture();
      if (!drag || !picture) return;
      const { x, y } = this.pointerPosition(event);
      const next = dragScenePoint(picture, x - drag.grabX, y - drag.grabY);
      this.model.move?.(drag.id, next.x, next.y);
      this.render();
    });

    const finish = (): void => {
      this.drag = null;
      this.walkDrag = null;
      this.anchorDrag = null;
      this.render();
    };
    this.element.addEventListener('pointerup', finish);
    this.element.addEventListener('pointercancel', finish);
  }

  applyScale(): void {
    this.element.style.width = `${this.element.width * this.scale}px`;
    this.element.style.height = `${this.element.height * this.scale}px`;
  }

  render(): void {
    const picture = this.model.picture();
    if (!picture) {
      this.context.clearRect(0, 0, this.element.width, this.element.height);
      return;
    }

    if (this.element.width !== picture.width || this.element.height !== picture.height) {
      this.element.width = picture.width;
      this.element.height = picture.height;
      this.imageData = null;
    }
    this.applyScale();

    if (!this.imageData) {
      this.imageData = this.context.createImageData(picture.width, picture.height);
    }
    paintScene(this.imageData.data, picture);
    this.context.putImageData(this.imageData, 0, 0);

    this.drawGrid(this.model.grid());
    this.drawItems();
    this.drawWalk(this.model.walk?.() ?? null);

    // Last, over everything: on a canvas the focus indicator has to be drawn
    // into the picture, and one hidden behind an item is not an indicator.
    if (this.cursor.visible) {
      this.cursor.clamp(this.bounds);
      drawCursor(this.context, this.cursor.x, this.cursor.y, 1, 1);
    }
  }

  /**
   * The overlay grid.
   *
   * Drawn in a colour that survives artwork of any hue by being drawn twice —
   * the same trick the keyboard cursor uses, and for the same reason.
   */
  private drawGrid(grid: SceneGrid | null): void {
    if (!grid) return;
    const context = this.context;
    context.save();
    context.lineWidth = 1;
    context.strokeStyle = 'rgba(120, 180, 255, 0.35)';
    context.beginPath();
    for (let x = grid.cellWidth; x < this.element.width; x += grid.cellWidth) {
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, this.element.height);
    }
    for (let y = grid.cellHeight; y < this.element.height; y += grid.cellHeight) {
      context.moveTo(0, y + 0.5);
      context.lineTo(this.element.width, y + 0.5);
    }
    context.stroke();
    context.restore();
  }

  /**
   * The walk overlay: bars as lines, nodes as diamonds.
   *
   * Two passes over every bar rather than one, for the reason `drawCursor` uses
   * two rectangles: a single stroke disappears into artwork of its own colour,
   * and a walk grid drawn over a painted background is exactly that case. The
   * dark pass goes down first and the bright one over it, so whichever the
   * scenery matches, the other one shows.
   *
   * Nodes are diamonds and not dots so that a node sitting on a bar's end — the
   * common case, since the nodes are the corners the router turns at — is still
   * tellable from the end itself.
   */
  private drawWalk(walk: SceneWalk | null): void {
    if (!walk) return;
    const context = this.context;
    const selected = walk.selected;
    context.save();

    for (const pass of [
      { colour: 'rgba(0, 0, 0, 0.6)', width: 3 },
      { colour: 'rgba(120, 255, 180, 0.9)', width: 1 },
    ]) {
      context.lineWidth = pass.width;
      for (const bar of walk.bars) {
        const isSelected =
          selected?.kind === 'bar' && selected.index === bar.index && pass.width === 1;
        context.strokeStyle = isSelected ? '#ffd166' : pass.colour;
        context.beginPath();
        context.moveTo(bar.x1 + 0.5, bar.y1 + 0.5);
        context.lineTo(bar.x2 + 0.5, bar.y2 + 0.5);
        context.stroke();
        if (!isSelected) continue;
        // The picked end, marked: an author moving one end of a bar needs to
        // see which end the next arrow key will take.
        for (const [end, x, y] of [
          [0, bar.x1, bar.y1],
          [1, bar.x2, bar.y2],
        ] as const) {
          if (selected.end !== end) continue;
          context.fillStyle = '#ffd166';
          context.fillRect(x - 2, y - 2, 5, 5);
        }
      }
    }

    for (const node of walk.nodes) {
      const isSelected = selected?.kind === 'node' && selected.index === node.index;
      context.beginPath();
      context.moveTo(node.x + 0.5, node.y - 3.5);
      context.lineTo(node.x + 4.5, node.y + 0.5);
      context.lineTo(node.x + 0.5, node.y + 4.5);
      context.lineTo(node.x - 3.5, node.y + 0.5);
      context.closePath();
      context.lineWidth = 2;
      context.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      context.stroke();
      context.fillStyle = isSelected ? '#ffd166' : 'rgba(120, 200, 255, 0.9)';
      context.fill();
    }

    context.restore();
  }

  private drawItems(): void {
    const context = this.context;
    const selected = this.model.selected();

    for (const item of this.model.items()) {
      const isSelected = item.id === selected;
      context.lineWidth = 1;
      context.strokeStyle = isSelected ? '#ffd166' : 'rgba(255, 209, 102, 0.55)';
      context.strokeRect(item.x + 0.5, item.y + 0.5, item.width - 1, item.height - 1);

      if (!isSelected || !item.anchor) continue;
      // The anchor, and a line back to the box it belongs to — the same drawing
      // the room canvas gives a walk-to point, because it means the same thing.
      context.strokeStyle = 'rgba(255, 209, 102, 0.7)';
      context.beginPath();
      context.moveTo(item.x + item.width / 2, item.y + item.height);
      context.lineTo(item.anchor.x, item.anchor.y);
      context.stroke();
      context.fillStyle = '#ffd166';
      context.beginPath();
      context.arc(item.anchor.x, item.anchor.y, 2.5, 0, Math.PI * 2);
      context.fill();

      // A ring around the handle the arrows are aimed at, for the reason the
      // walk overlay marks a picked bar end: an author about to press Alt and
      // an arrow needs to see which of the two handles will take it.
      if (this.pickedAnchor !== item.id) continue;
      context.lineWidth = 1;
      context.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      context.beginPath();
      context.arc(item.anchor.x, item.anchor.y, 5.5, 0, Math.PI * 2);
      context.stroke();
      context.strokeStyle = '#ffd166';
      context.beginPath();
      context.arc(item.anchor.x, item.anchor.y, 4.5, 0, Math.PI * 2);
      context.stroke();
    }
  }
}

/**
 * Builds a canvas, or nothing where there is no 2D context to build it on.
 *
 * Null rather than a throw, because a surface that cannot draw should still
 * show its facts: the screen views fall back to their tables, which is a worse
 * editor and not a broken one.
 */
let contextAvailable: boolean | null = null;

export function createSceneCanvas(
  model: SceneModel,
  options: SceneCanvasOptions,
): SceneCanvas | null {
  const element = document.createElement('canvas');
  element.width = 1;
  element.height = 1;
  // Probed once per page: whether a browser has a 2D context does not change
  // between screens, and jsdom answers the question by logging a paragraph.
  if (contextAvailable === null) contextAvailable = element.getContext('2d') !== null;
  if (!contextAvailable) return null;
  return new SceneCanvas(model, options, element);
}
