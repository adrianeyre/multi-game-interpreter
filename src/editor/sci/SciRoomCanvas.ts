/**
 * A SCI room, drawn from the game's own art, with the things on it draggable.
 *
 * `docs/editor-parity.md` rows 5, 6 and 7 for the SCI column. What a SCUMM
 * room answers with one resource, SCI answers with two — a Picture for the
 * backdrop and a Script resource for what stands on it — and ADR 0037 records
 * why this surface is keyed by the Script and assembled as a view over both,
 * rather than being a third resource invented to look like SCUMM's.
 *
 * ## The three coordinate spaces, kept apart on purpose
 *
 * This is the part that is easy to get wrong, and the engine already got it
 * wrong twice on this branch (`Plane.ts`'s `celOrigin`, and the display-to-
 * script conversion in `SciInput`). There are three:
 *
 * - **the script's space**, 320x200 for every SCI game ever made, which is
 *   what an object's `x` and `y` property words are in and therefore what an
 *   author types and a drag writes;
 * - **the Picture's space**, whatever that Picture declares — 640x480 for
 *   King's Quest VII — which is what the backdrop's pixels are in;
 * - **the canvas's space**, the element's own pixels, which is what a pointer
 *   event arrives in.
 *
 * A position converts between the first two; a **cel's size does not**, which
 * is `ScreenItem`'s `size` field and the sixth fault fixed on this branch.
 * Every conversion here goes through `toPicture` and `toScript` so that there
 * is one place to be wrong, and the tests drive those two directly.
 *
 * ## What is drawn is what the file says, not what the game shows
 *
 * The positions here are the **authored** property words. A SCI room commonly
 * assigns its cast's positions in `init` rather than declaring them, and where
 * it does, this surface draws the shipped default and the panel says so. That
 * is the state an author can actually edit and an export can actually write
 * back, which is the only state an editor should claim.
 */

import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../../engine/gfx/Screen.js';
import { celOrigin } from '../../engine/sci/gfx/Plane.js';
import { readSciView, type SciCel } from '../../engine/sci/gfx/SciView.js';
import {
  drawSciPicture,
  SCI_PICTURE_HEIGHT,
  SCI_PICTURE_WIDTH,
} from '../../engine/sci/gfx/SciPicture.js';
import { fromBase64 } from '../../authoring/base64.js';
import type { SciProject } from '../../authoring/project.js';
import type { RenderedImage } from '../imageExport.js';
import type { SciRoom, SciRoomThing } from '../../authoring/sci/sciRooms.js';
import type { SciPolygon } from '../../authoring/sci/sciPolygons.js';
import {
  renderSciCel,
  renderSciCelPicture,
  renderSciVectorPicture,
  sciViewColours,
} from './sciImages.js';

/**
 * The Picture a room names, drawn, or a sentence saying why it is not.
 *
 * Both kinds of Picture are looked for, because which one a release uses is a
 * property of the release and not of the room: a vector Picture before SCI1.1
 * and a cel Picture after it, and a game part-way through the change has both
 * (ADR 0018).
 *
 * Two kinds of failure, and they are not the same kind of thing as each other. A vector Picture that stops part way through
 * its operations would draw a backdrop with a piece missing and nothing on it
 * saying so, which is worse than drawing nothing; a Picture that is not in the
 * release at all is ordinary, because a room may name a Picture it builds at
 * run time rather than one it ships.
 *
 * `null` means the room named no Picture, which is neither.
 *
 * This lives beside the canvas rather than inside `SciEditor` because
 * `bin/sci-sweep.ts` counts what this returns, and a sweep that resolved
 * backdrops by a second route would be counting something the panel does not
 * draw.
 */
export function sciRoomBackdrop(project: SciProject, room: SciRoom): RenderedImage | string | null {
  if (room.picture === null) return null;

  const cels = project.celPictures.find((one) => one.number === room.picture);
  // The game's palette under the Picture's, because a Picture's own palette
  // is a patch over the startup one and not a table of its own.
  if (cels) return renderSciCelPicture(cels, sciViewColours(project));

  const vector = project.vectorPictures.find((one) => one.number === room.picture);
  if (vector) {
    const vga = project.resources.some((resource) => resource.type === 'palette');
    const drawn = drawSciPicture(fromBase64(vector.bytes), {
      vga,
      width: SCI_PICTURE_WIDTH,
      height: SCI_PICTURE_HEIGHT,
    });
    if (drawn.unknown) {
      return (
        `Picture ${room.picture} stopped at byte ${drawn.unknown.at}, on operation ` +
        `0x${drawn.unknown.op.toString(16)}. Drawing what was reached would be a backdrop ` +
        `with a piece missing and nothing on it saying so.`
      );
    }
    return renderSciVectorPicture(drawn, vga);
  }

  return `This room names Picture ${room.picture}, which is not in this release. A room may name a Picture it builds rather than one it ships.`;
}

/**
 * Each thing with whatever art its own property words name.
 *
 * A View, a loop and a cel — three words, and all three have to resolve. Not
 * resolving is ordinary rather than a fault: an instance that never declared a
 * View ships with its class's default, and drawing View 0 for every one of
 * them would put art on the screen the game never puts there. The reason is
 * carried on the piece and shown in the table instead.
 */
export function sciRoomPieces(project: SciProject, room: SciRoom): SciRoomPiece[] {
  const colours = sciViewColours(project);
  return room.things.map((thing) => {
    if (thing.view === null) {
      return { thing, cel: null, image: null, why: 'declares no View', celResolution: null };
    }
    const resource = project.resources.find(
      (one) => one.type === 'view' && one.number === thing.view,
    );
    if (!resource) {
      return {
        thing,
        cel: null,
        image: null,
        why: `View ${thing.view} is not in this release`,
        celResolution: null,
      };
    }
    const view = readSciView(fromBase64(resource.bytes));
    const cel = view.loops[thing.loop]?.cels[thing.cel];
    if (!cel) {
      return {
        thing,
        cel: null,
        image: null,
        why: `View ${thing.view} has no loop ${thing.loop} cel ${thing.cel}`,
        celResolution: null,
      };
    }
    return {
      thing,
      cel,
      image: renderSciCel(cel, colours),
      why: null,
      celResolution: view.resolution,
    };
  });
}

/** How near a thing with no art still answers a click, in script pixels. */
const MARKER_RADIUS = 4;

/** One thing, with whatever art was resolved for it. */
export interface SciRoomPiece {
  thing: SciRoomThing;
  /** The cel its View, loop and cel property words name, where all three resolve. */
  cel: SciCel | null;
  /** That cel's pixels, already coloured. */
  image: RenderedImage | null;
  /** Why there is no art, when there is none — shown on the panel, not invented. */
  why: string | null;
  /**
   * The resolution that cel was drawn for, when the View declares one.
   *
   * **SCI32's one genuinely new idea about drawing, and the canvas has to know
   * it too.** A cel declares the space it was authored in, and the compositor
   * maps it onto the screen — King's Quest VII's cast is drawn at 320x200 and
   * its interface at 640x480, on the same Plane in the same frame. A canvas
   * that assumes every cel's pixels are in the Picture's space draws the cast
   * at half size and half an origin out of place, which is an editor whose
   * things do not line up with the room they stand in.
   *
   * Null means the View declares none, which is every SCI16 View and means the
   * script's own space.
   */
  celResolution: { width: number; height: number } | null;
}

export interface SciRoomCanvasOptions {
  /** The Picture this room names, drawn underneath everything. */
  backdrop: RenderedImage | null;
  pieces: readonly SciRoomPiece[];
  /** Which piece is selected, by index into `pieces`, or -1. */
  selected: number;
  /** A piece was picked, by click or by keyboard. */
  onSelect(index: number): void;
  /** A piece was dragged to a new position, in the script's own space. */
  onMove(index: number, x: number, y: number): void;
  /**
   * The walk polygons this room's own code builds, drawn under the cast.
   *
   * Optional because a SCI16 room has none to draw — its walkable area is a
   * colour in the Picture's control buffer, which is not a shape (11s).
   */
  polygons?: readonly SciPolygon[];
}

/**
 * A colour per polygon kind, because the kinds are opposites.
 *
 * A barred polygon is a hole in the floor and a total-access one is the floor;
 * drawing both in one colour would show an author a shape and hide what it
 * means.
 */
const POLYGON_COLOURS: Readonly<Record<number, string>> = {
  0: '#7ce08a',
  1: '#7ab7ff',
  2: '#ff7a7a',
  3: '#e3c46f',
};

/**
 * The rectangle a piece covers **in the script's space**.
 *
 * A cel's pixels are in the Picture's space and its position is in the
 * script's, so the size is converted down here rather than the position up —
 * which keeps the hit test, the outline and the drag all in the one space an
 * author's numbers are in.
 */
/**
 * The room as it is drawn, as one image — the backdrop with everything on it.
 *
 * **Row 16 answered Yes for five kinds of artwork and not for a room**, which
 * is the one an author most wants out: a View's cels come out one at a time and
 * a Picture comes out bare, so the thing on screen — the place, with its cast
 * standing in it — was the only view of the game that could be looked at and
 * not saved.
 *
 * Composited in the Picture's own pixels rather than the canvas's, so the file
 * is the artwork's size whatever the pane is zoomed to. The placement is
 * `pieceBounds`' — the same rule the canvas draws with, called rather than
 * copied, so an export cannot drift from what was on screen.
 *
 * No outlines and no selection: those are the editor's marks on the artwork,
 * not the artwork.
 */
export function sciRoomImage(
  backdrop: RenderedImage | null,
  pieces: readonly SciRoomPiece[],
  size?: { width: number; height: number },
): RenderedImage | null {
  const width = size?.width ?? backdrop?.width ?? 0;
  const height = size?.height ?? backdrop?.height ?? 0;
  if (width <= 0 || height <= 0) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  if (backdrop && backdrop.width === width && backdrop.height === height) {
    rgba.set(backdrop.rgba);
  }

  // The same two ratios the canvas uses: a script coordinate into the
  // Picture's pixels, and a cel's own origin back down out of its own space.
  const scale = { x: width / SCREEN_WIDTH, y: height / SCREEN_HEIGHT };

  for (const piece of pieces) {
    if (!piece.image) continue;
    const bounds = pieceBounds(piece, scale);
    const left = Math.round(bounds.x * scale.x);
    const top = Math.round(bounds.y * scale.y);

    for (let y = 0; y < piece.image.height; y++) {
      const intoY = top + y;
      if (intoY < 0 || intoY >= height) continue;
      for (let x = 0; x < piece.image.width; x++) {
        const intoX = left + x;
        if (intoX < 0 || intoX >= width) continue;
        const from = (y * piece.image.width + x) * 4;
        // Transparent pixels leave the backdrop alone, which is what a cel's
        // clear key means and what `drawImage` does on the canvas.
        if (piece.image.rgba[from + 3] === 0) continue;
        const into = (intoY * width + intoX) * 4;
        rgba[into] = piece.image.rgba[from];
        rgba[into + 1] = piece.image.rgba[from + 1];
        rgba[into + 2] = piece.image.rgba[from + 2];
        rgba[into + 3] = piece.image.rgba[from + 3];
      }
    }
  }
  return { width, height, rgba };
}

export function pieceBounds(
  piece: SciRoomPiece,
  /**
   * Kept in the signature and unused, because every caller has it and the next
   * reader will reach for it: a cel's size on this canvas comes from the cel's
   * **own** declared resolution, never from how big the Picture underneath is.
   */
  _scale: { x: number; y: number },
  /** Where the piece is right now, when a drag has it somewhere else. */
  at: { x: number; y: number } = piece.thing,
): { x: number; y: number; width: number; height: number } {
  const { cel } = piece;
  if (!cel) {
    return {
      x: at.x - MARKER_RADIUS,
      y: at.y - MARKER_RADIUS,
      width: MARKER_RADIUS * 2,
      height: MARKER_RADIUS * 2,
    };
  }
  // The origin is in the cel's own pixels and the position is in the script's,
  // so the origin converts down rather than the position up (`celOrigin`).
  //
  // **Divided by the cel's own resolution, not by the canvas's scale.** Those
  // are the same number only while a cel was drawn for the Picture it stands
  // on. King's Quest VII draws its cast at 320x200 and its rooms at 640x480,
  // so dividing a cast cel by the canvas scale halves it — and halves its
  // origin, which moves it as well as shrinking it.
  const origin = celOrigin(cel);
  const resolution = piece.celResolution;
  const perScriptX = resolution ? resolution.width / SCREEN_WIDTH : 1;
  const perScriptY = resolution ? resolution.height / SCREEN_HEIGHT : 1;
  return {
    x: at.x - origin.x / perScriptX,
    y: at.y - origin.y / perScriptY,
    width: cel.width / perScriptX,
    height: cel.height / perScriptY,
  };
}

export class SciRoomCanvas {
  readonly element = document.createElement('div');

  private readonly canvas = document.createElement('canvas');
  private options: SciRoomCanvasOptions;
  /**
   * The drag in progress: which piece, where the pointer took hold of it, and
   * where it is now.
   *
   * **The position lives here until the button comes up, and only then is it
   * written to the project.** Every write re-renders the whole editor from the
   * top (`renderAll` in `main.ts`), which replaces this element — so a drag
   * that wrote on each pointer move would delete the element it was being
   * dragged on, releasing pointer capture and ending the gesture after one
   * pixel. Committing once also makes a drag one entry in Undo rather than
   * forty, which is what `state.ts`'s `transient` flag exists to achieve for
   * the painting canvases; a discrete gesture does not need it.
   */
  private drag: { index: number; grabX: number; grabY: number; x: number; y: number } | null = null;

  constructor(options: SciRoomCanvasOptions) {
    this.options = options;
    this.element.className = 'sci-room-canvas';
    this.canvas.className = 'sci-room-surface';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.element.appendChild(this.canvas);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('keydown', this.onKeyDown);
    this.draw();
  }

  update(options: SciRoomCanvasOptions): void {
    this.options = options;
    this.draw();
  }

  destroy(): void {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
  }

  /**
   * The Picture's size, or the script's where there is no Picture.
   *
   * A room with no backdrop still has things on it, and a canvas sized to
   * nothing would list them and draw none.
   */
  private get size(): { width: number; height: number } {
    const backdrop = this.options.backdrop;
    if (backdrop) return { width: backdrop.width, height: backdrop.height };
    return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  }

  /** Picture pixels per script pixel, which is 2 and 2.4 on King's Quest VII. */
  private get scale(): { x: number; y: number } {
    const { width, height } = this.size;
    return { x: width / SCREEN_WIDTH, y: height / SCREEN_HEIGHT };
  }

  // ------------------------------------------------------ the three spaces --

  /** A script coordinate in the Picture's pixels. */
  private toPicture(x: number, y: number): { x: number; y: number } {
    const scale = this.scale;
    return { x: x * scale.x, y: y * scale.y };
  }

  /** A canvas event's point in the script's own space. */
  private toScript(event: PointerEvent): { x: number; y: number } {
    const box = this.canvas.getBoundingClientRect();
    // The element is laid out by CSS and the buffer is the Picture's size, so
    // the two are not the same number of pixels and a click read as buffer
    // pixels lands wherever the zoom happens to put it.
    const inBuffer = {
      x: box.width > 0 ? ((event.clientX - box.left) * this.canvas.width) / box.width : 0,
      y: box.height > 0 ? ((event.clientY - box.top) * this.canvas.height) / box.height : 0,
    };
    const scale = this.scale;
    return { x: inBuffer.x / scale.x, y: inBuffer.y / scale.y };
  }

  // ------------------------------------------------------------ hit-testing --

  /**
   * The topmost piece over a script-space point, or -1.
   *
   * Walked backwards because `sciRooms` already sorted the pieces into draw
   * order — ascending priority, ties broken by the order the script declared
   * them — so the last one drawn is the one the player would be pointing at.
   */
  hitTest(x: number, y: number): number {
    const scale = this.scale;
    for (let index = this.options.pieces.length - 1; index >= 0; index--) {
      const bounds = pieceBounds(this.options.pieces[index], scale, this.positionOf(index));
      if (
        x >= bounds.x &&
        x < bounds.x + bounds.width &&
        y >= bounds.y &&
        y < bounds.y + bounds.height
      ) {
        return index;
      }
    }
    return -1;
  }

  // ---------------------------------------------------------------- input --

  private readonly onPointerDown = (event: PointerEvent): void => {
    const point = this.toScript(event);
    const index = this.hitTest(point.x, point.y);
    this.canvas.focus();
    if (index < 0) {
      this.options.onSelect(-1);
      return;
    }
    this.options.onSelect(index);
    const thing = this.options.pieces[index].thing;
    // Refused rather than silently dropped at the end: a thing whose property
    // words have no recorded home can be pointed at and not moved.
    if (!thing.movable) return;
    this.drag = {
      index,
      grabX: point.x - thing.x,
      grabY: point.y - thing.y,
      x: thing.x,
      y: thing.y,
    };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.drag) return;
    const point = this.toScript(event);
    this.drag.x = Math.round(point.x - this.drag.grabX);
    this.drag.y = Math.round(point.y - this.drag.grabY);
    // Redrawn from the drag rather than from the project, so the thing follows
    // the pointer without the project being written forty times on the way.
    this.draw();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    if (!drag) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.drag = null;
    const thing = this.options.pieces[drag.index]?.thing;
    // A click that selected without moving is not an edit, and should not put
    // an entry in Undo.
    if (!thing || (drag.x === thing.x && drag.y === thing.y)) return;
    this.options.onMove(drag.index, drag.x, drag.y);
  };

  /**
   * Keyboard reach, which is row 32 and is not an afterthought here.
   *
   * Tab selects the next thing and the arrows move the selected one, so every
   * gesture the mouse has on this canvas has a key — a drag included. The step
   * is one script pixel, and Shift makes it ten, because a room is 320 wide
   * and moving across it one pixel at a time is not reach.
   */
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const pieces = this.options.pieces;
    if (pieces.length === 0) return;

    if (event.key === 'Tab' && !event.shiftKey) {
      const next = (this.options.selected + 1) % pieces.length;
      this.options.onSelect(next);
      event.preventDefault();
      return;
    }

    const index = this.options.selected;
    if (index < 0 || index >= pieces.length) return;
    const step = event.shiftKey ? 10 : 1;
    let dx = 0;
    let dy = 0;
    switch (event.key) {
      case 'ArrowLeft':
        dx = -step;
        break;
      case 'ArrowRight':
        dx = step;
        break;
      case 'ArrowUp':
        dy = -step;
        break;
      case 'ArrowDown':
        dy = step;
        break;
      default:
        return;
    }
    event.preventDefault();
    const thing = pieces[index].thing;
    if (!thing.movable) return;
    this.options.onMove(index, thing.x + dx, thing.y + dy);
  };

  // ---------------------------------------------------------------- drawing --

  /** Where a piece is right now: the drag's position while one is in progress. */
  private positionOf(index: number): { x: number; y: number } {
    const drag = this.drag;
    if (drag && drag.index === index) return { x: drag.x, y: drag.y };
    return this.options.pieces[index].thing;
  }

  /**
   * Whether this canvas holds the focus, asked before a re-render takes it.
   *
   * The editor rebuilds its detail pane from scratch on every change, so a
   * keyboard move would move the thing and then lose the element that was
   * being typed at — one arrow press per focus, which is not keyboard reach.
   * `SciEditor.render` asks this first and calls `focus` afterwards.
   */
  owns(node: Element | null): boolean {
    return node === this.canvas;
  }

  focus(): void {
    this.canvas.focus();
  }

  private draw(): void {
    const { width, height } = this.size;
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, width, height);
    const backdrop = this.options.backdrop;
    if (backdrop) {
      // Through the context rather than `new ImageData`, which wants a buffer
      // type that varies between DOM library versions (`imageExport.ts`).
      const image = context.createImageData(backdrop.width, backdrop.height);
      image.data.set(backdrop.rgba);
      context.putImageData(image, 0, 0);
    } else {
      // Not black: a room with no Picture is a room with no backdrop, and a
      // black rectangle is indistinguishable from a Picture that drew black.
      context.fillStyle = '#1b1b22';
      context.fillRect(0, 0, width, height);
    }

    const scale = this.scale;
    this.drawPolygons(context);
    for (const [index, piece] of this.options.pieces.entries()) {
      const position = this.positionOf(index);
      const bounds = pieceBounds(piece, scale, position);
      const at = this.toPicture(bounds.x, bounds.y);
      if (piece.image) {
        // The cel is drawn at its own pixel size, because a cel's size does
        // not scale with its position — the sixth fault fixed on this branch.
        const buffer = document.createElement('canvas');
        buffer.width = piece.image.width;
        buffer.height = piece.image.height;
        const into = buffer.getContext('2d');
        if (into) {
          const sprite = into.createImageData(piece.image.width, piece.image.height);
          sprite.data.set(piece.image.rgba);
          into.putImageData(sprite, 0, 0);
          context.drawImage(buffer, Math.round(at.x), Math.round(at.y));
        }
      }
      this.outline(context, piece, at, bounds, scale, position, index === this.options.selected);
    }

    this.canvas.setAttribute('aria-label', this.describe());
  }

  /**
   * The room's walk polygons, under the things standing on them.
   *
   * `docs/editor-parity.md` row 11. Drawn under the cast rather than over it,
   * because a walkable area is what the cast stands *on* — an overlay on top
   * would hide the artwork the area is about.
   *
   * **A polygon's points are in the script's own space**, the same 320x200 an
   * object's `x` and `y` are in, so they convert through `toPicture` exactly as
   * a thing's position does and there is one place to be wrong.
   *
   * Coloured by kind, because the four kinds are opposites: a barred polygon is
   * a hole in the floor an author must not confuse with the floor.
   */
  private drawPolygons(context: CanvasRenderingContext2D): void {
    const polygons = this.options.polygons ?? [];
    if (polygons.length === 0) return;
    context.save();
    for (const polygon of polygons) {
      if (polygon.points.length < 2) continue;
      context.lineWidth = 1;
      context.setLineDash(polygon.type === 2 ? [4, 3] : []);
      context.strokeStyle = POLYGON_COLOURS[polygon.type] ?? '#b9b9c6';
      context.beginPath();
      for (const [index, point] of polygon.points.entries()) {
        const at = this.toPicture(point.x, point.y);
        if (index === 0) context.moveTo(at.x + 0.5, at.y + 0.5);
        else context.lineTo(at.x + 0.5, at.y + 0.5);
      }
      context.closePath();
      context.stroke();
      // A node per point, so an author can see where the numbers are even at a
      // zoom where the edges are a single line.
      for (const point of polygon.points) {
        const at = this.toPicture(point.x, point.y);
        context.fillStyle = context.strokeStyle;
        context.fillRect(Math.round(at.x) - 1, Math.round(at.y) - 1, 3, 3);
      }
    }
    context.restore();
  }

  private outline(
    context: CanvasRenderingContext2D,
    piece: SciRoomPiece,
    at: { x: number; y: number },
    bounds: { width: number; height: number },
    scale: { x: number; y: number },
    position: { x: number; y: number },
    selected: boolean,
  ): void {
    context.save();
    context.lineWidth = selected ? 3 : 1;
    // A thing with no art is drawn as its own marker rather than as an empty
    // box the same shape as a real one.
    context.strokeStyle = selected ? '#ffd34d' : piece.cel ? '#6fe3ff' : '#ff8a5c';
    context.setLineDash(piece.cel ? [] : [3, 3]);
    context.strokeRect(
      Math.round(at.x) + 0.5,
      Math.round(at.y) + 0.5,
      Math.round(bounds.width * scale.x),
      Math.round(bounds.height * scale.y),
    );
    if (selected) {
      // The anchor is where the property words actually point, which for an
      // actor is their feet and not the middle of the box.
      const anchor = this.toPicture(position.x, position.y);
      context.beginPath();
      context.moveTo(anchor.x - 5, anchor.y);
      context.lineTo(anchor.x + 5, anchor.y);
      context.moveTo(anchor.x, anchor.y - 5);
      context.lineTo(anchor.x, anchor.y + 5);
      context.stroke();
    }

    // **The walk-to point, on the thing it belongs to** (row 8). Drawn for the
    // selected thing only: a room where every Feature showed one would be a
    // field of crosses over the artwork, and the point is a property of the
    // thing an author is working on rather than of the room.
    //
    // A ring rather than a cross, so it is not mistaken for the anchor above —
    // the two are different points and are often a long way apart: the anchor
    // is where the thing *is*, and this is where the ego is sent before acting
    // on it.
    const approach = piece.thing.approach;
    if (selected && approach) {
      const point = this.toPicture(approach.x, approach.y);
      context.beginPath();
      context.strokeStyle = '#c98cff';
      context.lineWidth = 2;
      context.setLineDash([]);
      context.arc(point.x, point.y, 4, 0, Math.PI * 2);
      context.stroke();
    }
    context.restore();
  }

  /** What a screen reader is told this canvas is, rather than "canvas". */
  private describe(): string {
    const pieces = this.options.pieces;
    const selected = pieces[this.options.selected];
    const polygons = this.options.polygons ?? [];
    const head =
      `Room canvas, ${pieces.length} thing${pieces.length === 1 ? '' : 's'} placed` +
      (polygons.length > 0
        ? `, ${polygons.length} walk ${polygons.length === 1 ? 'polygon' : 'polygons'} drawn.`
        : '.');
    if (!selected) return `${head} Nothing selected. Tab selects a thing, arrows move it.`;
    const approach = selected.thing.approach;
    return (
      `${head} ${selected.thing.name} selected, at ${selected.thing.x}, ${selected.thing.y}` +
      `${selected.thing.movable ? '' : ', which cannot be moved'}` +
      `${approach ? `, walk-to point at ${approach.x}, ${approach.y}` : ''}` +
      `. Arrows move it, Shift for ten.`
    );
  }
}
