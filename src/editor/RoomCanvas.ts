import { defaultPalette } from '../authoring/palette.js';
import { loadImage, storeImage } from '../authoring/imageCodec.js';
import { getPixel, rect } from '../authoring/draw.js';
import { isConvexBox, rectangleBox, translateBox } from '../authoring/GameBuilder.js';
import type { BoxDefinition, Point, ScaleRamp } from '../authoring/GameBuilder.js';
import type { IndexedImage } from '../authoring/ImageEncoder.js';
import type { EditorState } from './state.js';
import { KeyboardCursor, describeCanvas, drawCursor, isActivation } from './canvasKeyboard.js';
import { paintScene, sceneItemAt } from './sceneCanvas.js';

export type Tool = 'select' | 'paint' | 'rectangle' | 'object' | 'walkbox' | 'walkto';

/** The eight drag points around a selected box. */
type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

const SCREEN_WIDTH = 320;

/** Handle hit radius, in screen pixels; converted to room pixels by the zoom. */
const HANDLE_SCREEN_RADIUS = 5;

const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
};

/** Corner handles map to one corner; side handles move the two they join. */
const HANDLE_CORNERS: Record<HandleId, Array<'ul' | 'ur' | 'lr' | 'll'>> = {
  nw: ['ul'],
  ne: ['ur'],
  se: ['lr'],
  sw: ['ll'],
  n: ['ul', 'ur'],
  e: ['ur', 'lr'],
  s: ['lr', 'll'],
  w: ['ll', 'ul'],
};

function midpoint(a: Point, b: Point): Point {
  return { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) };
}

/**
 * Where each handle sits.
 *
 * Corners sit on the corners; side handles sit at the midpoint of the edge they
 * move, which is where a person expects to grab an edge even when that edge is
 * slanted.
 */
function handlePoints(box: BoxDefinition): Array<{ id: HandleId; x: number; y: number }> {
  return [
    { id: 'nw', ...box.ul },
    { id: 'n', ...midpoint(box.ul, box.ur) },
    { id: 'ne', ...box.ur },
    { id: 'e', ...midpoint(box.ur, box.lr) },
    { id: 'se', ...box.lr },
    { id: 's', ...midpoint(box.lr, box.ll) },
    { id: 'sw', ...box.ll },
    { id: 'w', ...midpoint(box.ll, box.ul) },
  ];
}

/**
 * Applies a handle drag.
 *
 * Corners move alone, so a floor can be shaped into any convex quadrilateral —
 * a trapezoid for a receding corridor, a slanted quad for a sloping path. Side
 * handles move both of their corners, which keeps the familiar resize feel.
 */
export function dragBoxHandle(
  origin: BoxDefinition,
  handle: HandleId,
  deltaX: number,
  deltaY: number,
): BoxDefinition {
  const next: BoxDefinition = {
    ...origin,
    ul: { ...origin.ul },
    ur: { ...origin.ur },
    lr: { ...origin.lr },
    ll: { ...origin.ll },
  };

  for (const corner of HANDLE_CORNERS[handle]) {
    next[corner] = {
      x: Math.max(0, origin[corner].x + deltaX),
      y: Math.max(0, origin[corner].y + deltaY),
    };
  }
  return next;
}

/**
 * Point-in-quadrilateral, matching the engine's own test.
 *
 * The editor must agree with the interpreter about what is inside a box, or
 * clicking a box the engine considers walkable would select nothing.
 */
export function boxContains(box: BoxDefinition, x: number, y: number): boolean {
  const corners = [box.ul, box.ur, box.lr, box.ll];
  let positive = false;
  let negative = false;

  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross > 0) positive = true;
    if (cross < 0) negative = true;
  }
  return !(positive && negative);
}

/**
 * The room view: paints the background, draws the editing overlays, and turns
 * pointer input into project mutations.
 *
 * Rendering is immediate-mode — the whole canvas is redrawn on any change.
 * A room is 320x144, so a full repaint is trivial, and it removes every class
 * of stale-overlay bug that partial redrawing invites.
 */
export class RoomCanvas {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly defaultColors = defaultPalette();

  /**
   * Colours the current room's pixels index.
   *
   * A room imported from a published game carries its own table; an authored
   * one uses the editor's. Reading it per render rather than caching it means
   * switching rooms cannot leave the previous room's colours on screen.
   */
  private get palette(): number[][] {
    return this.state.currentRoom?.palette ?? this.defaultColors;
  }

  private currentTool: Tool = 'select';

  /**
   * The tool the next press applies.
   *
   * An accessor rather than a field because changing tools has to drop a
   * half-finished shape: the two-press rectangle below leaves a point anchored
   * between presses, and an anchor that survived a switch to the Walk box tool
   * would draw a box from wherever the last rectangle started.
   */
  get tool(): Tool {
    return this.currentTool;
  }

  set tool(next: Tool) {
    if (next !== this.currentTool) this.anchor = null;
    this.currentTool = next;
  }

  color = 15;
  brushSize = 1;
  scale = 2;
  showBoxes = true;
  showObjects = true;
  /** The dashed rows the perspective ramp interpolates between. */
  showGuides = true;
  /** The walk-to point of the selected object, and the line back to it. */
  showWalkTo = true;

  /**
   * The cursor the arrow keys move, in room pixels.
   *
   * The room canvas was pointer-only — paint by dragging, place an object by
   * clicking, shape a walk box by dragging a rectangle — so none of it could be
   * done from a keyboard (2.1.1). This is the cursor those keys drive.
   */
  readonly cursor = new KeyboardCursor();

  /**
   * The first corner of a two-press shape, once it has been placed.
   *
   * It serves two rules at once. For 2.1.1 it is how a keyboard draws a
   * rectangle or a walk box at all: press once here, move, press again there.
   * For 2.5.7 it is how a *pointer* does it without dragging — a click that
   * does not move anchors instead of committing a one-pixel shape, and the next
   * click completes it. Both routes end in the same `commit` call.
   */
  private anchor: { x: number; y: number } | null = null;

  /** Says what a key just did, so the editor can announce it. */
  onKeyboardChange: ((message: string) => void) | null = null;

  /** The description element for this canvas, placed beside it by the editor. */
  help!: HTMLElement;

  /** Reused so a repaint does not allocate a 46 KB buffer every frame. */
  private imageData: ImageData | null = null;

  /** Handle under the cursor, for the resize cursor shape. */
  private hoverHandle: HandleId | null = null;

  /**
   * Reports the room coordinate under the pointer, or null when it leaves.
   *
   * Placing walk-to points and box corners by eye means constantly wanting to
   * know where the cursor actually is, and the canvas is zoomed so screen
   * pixels are not room pixels.
   */
  onHover: ((position: { x: number; y: number } | null) => void) | null = null;

  /** Fired when the eyedropper picks a colour, so the palette can follow. */
  onColorPicked: ((color: number) => void) | null = null;

  private drag:
    | { kind: 'none' }
    | { kind: 'paint' }
    | { kind: 'rect'; startX: number; startY: number; currentX: number; currentY: number }
    | { kind: 'object'; id: number; grabX: number; grabY: number }
    | { kind: 'box'; index: number; origin: BoxDefinition; startX: number; startY: number }
    | {
        kind: 'resize';
        index: number;
        handle: HandleId;
        origin: BoxDefinition;
        startX: number;
        startY: number;
      }
    | { kind: 'newbox'; startX: number; startY: number; currentX: number; currentY: number } = {
    kind: 'none',
  };

  constructor(state: EditorState) {
    this.state = state;
    this.element = document.createElement('canvas');
    this.element.width = SCREEN_WIDTH;
    this.element.height = 144;
    this.element.className = 'room-canvas';

    const context = this.element.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;

    this.attachPointerHandlers();
    this.attachKeyboardHandlers();
    this.applyScale();
  }

  private attachKeyboardHandlers(): void {
    this.help = describeCanvas(this.element, {
      id: 'room-canvas-help',
      label: 'Room',
      help:
        'Edit the selected room. Arrow keys move the editing cursor one pixel, with Shift ' +
        'for eight. Enter or Space applies the current tool at the cursor: Paint puts down ' +
        'a brush, Object places an object, Walk-to sets the walk-to point, and Rectangle ' +
        'and Walk box take two presses — one for each corner. Escape cancels a half-drawn ' +
        'shape. With the Select tool, Enter picks whatever is under the cursor and Alt with ' +
        'an arrow key moves what is selected. P picks up the colour under the cursor. Exact ' +
        'positions and sizes can also be typed into the fields in the panel on the right.',
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
  }

  /** The room's own size, which is what the cursor is clamped to. */
  private get roomBounds(): { width: number; height: number } {
    const room = this.state.currentRoom;
    return {
      width: room?.width ?? this.element.width,
      height: room?.height ?? this.element.height,
    };
  }

  private onKeyDown(event: KeyboardEvent): void {
    const bounds = this.roomBounds;

    // Alt with an arrow moves what is selected, which is the keyboard's version
    // of dragging it. Checked before plain movement, or the cursor would move
    // instead of the object.
    if (event.altKey && event.key.startsWith('Arrow')) {
      event.preventDefault();
      this.nudgeSelection(event.key, event.shiftKey ? 8 : 1);
      return;
    }

    if (this.cursor.handle(event, bounds)) {
      event.preventDefault();
      this.render();
      this.onHover?.({ x: this.cursor.x, y: this.cursor.y });
      this.onKeyboardChange?.(this.describeCursor());
      return;
    }

    if (event.key === 'Escape' && this.anchor) {
      event.preventDefault();
      // Stopped, or the editor's own Escape handling would also see it.
      event.stopPropagation();
      this.anchor = null;
      this.render();
      this.onKeyboardChange?.('Cancelled.');
      return;
    }

    if (isActivation(event)) {
      event.preventDefault();
      this.pressAt(this.cursor.x, this.cursor.y);
      return;
    }

    if (event.key === 'p' || event.key === 'P') {
      event.preventDefault();
      this.pickColor(this.cursor.x, this.cursor.y);
      this.onKeyboardChange?.(`Picked up colour ${this.color}.`);
    }
  }

  /** "48, 96 — inside walk box 2", for the announcement after a move. */
  private describeCursor(): string {
    const parts = [`${this.cursor.x}, ${this.cursor.y}`];
    const room = this.state.currentRoom;
    if (room) {
      // A `ProjectObject` is a `SceneItem` already, so the topmost-first search
      // is the shared one rather than a fourth copy of the same loop.
      const object = sceneItemAt(room.objects, this.cursor.x, this.cursor.y);
      if (object) parts.push(`object ${object.id} ${object.name}`);

      const boxIndex = room.boxes.findIndex((box) =>
        boxContains(box, this.cursor.x, this.cursor.y),
      );
      if (boxIndex >= 0) parts.push(`walk box ${boxIndex}`);
    }
    if (this.anchor) parts.push(`anchored at ${this.anchor.x}, ${this.anchor.y}`);
    return parts.join(' — ');
  }

  /**
   * Applies the current tool at a point, from a key.
   *
   * The same set of outcomes the pointer produces, minus the drag: the two
   * tools that were a drag are two presses here, and the rest were already a
   * single press.
   */
  private pressAt(x: number, y: number): void {
    switch (this.tool) {
      case 'paint':
        this.state.beginTransaction();
        this.paintAt(x, y);
        this.onKeyboardChange?.(`Painted colour ${this.color} at ${x}, ${y}.`);
        break;

      case 'rectangle':
        if (this.anchor) {
          this.commitRectangle(this.anchor.x, this.anchor.y, x, y);
          this.anchor = null;
          this.onKeyboardChange?.('Rectangle drawn.');
        } else {
          this.anchor = { x, y };
          this.onKeyboardChange?.(
            `First corner at ${x}, ${y}. Move to the other corner and press Enter again.`,
          );
        }
        break;

      case 'walkbox':
        if (this.anchor) {
          this.commitWalkBox(this.anchor.x, this.anchor.y, x, y);
          this.anchor = null;
          this.onKeyboardChange?.('Walk box added.');
        } else {
          this.anchor = { x, y };
          this.onKeyboardChange?.(
            `First corner at ${x}, ${y}. Move to the other corner and press Enter again.`,
          );
        }
        break;

      case 'object':
        this.state.addObject(x, y);
        this.tool = 'select';
        this.onKeyboardChange?.(`Object placed at ${x}, ${y}.`);
        break;

      case 'walkto':
        this.setWalkTo(x, y);
        this.tool = 'select';
        this.onKeyboardChange?.(`Walk-to point set to ${x}, ${y}.`);
        break;

      case 'select':
        this.selectAt(x, y);
        break;
    }
    this.render();
  }

  /** Selects whatever is at a point, without starting a drag. */
  private selectAt(x: number, y: number): void {
    const room = this.state.currentRoom;
    if (!room) return;

    const hit = sceneItemAt(room.objects, x, y);
    if (hit) {
      this.state.select({ objectId: hit.id, boxIndex: null });
      this.onKeyboardChange?.(`Selected object ${hit.id} ${hit.name}.`);
      return;
    }

    for (let i = room.boxes.length - 1; i >= 0; i--) {
      if (boxContains(room.boxes[i], x, y)) {
        this.state.select({ boxIndex: i, objectId: null });
        this.onKeyboardChange?.(`Selected walk box ${i}.`);
        return;
      }
    }

    this.state.select({ objectId: null, boxIndex: null });
    this.onKeyboardChange?.('Nothing selected.');
  }

  /**
   * Moves the selected object or walk box, which is what a drag would have done.
   *
   * Whole steps rather than a continuous drag, so one press is one undo step —
   * the same bargain the pointer makes when it wraps a whole drag in one.
   */
  private nudgeSelection(key: string, step: number): void {
    const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
    const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
    if (dx === 0 && dy === 0) return;

    const room = this.state.currentRoom;
    if (!room) return;

    const objectId = this.state.selected.objectId;
    if (objectId !== null) {
      this.state.update((project) => {
        for (const candidate of project.rooms) {
          const object = candidate.objects.find((entry) => entry.id === objectId);
          if (!object) continue;
          object.x = Math.max(0, object.x + dx);
          object.y = Math.max(0, object.y + dy);
          object.walkTo = { x: object.walkTo.x + dx, y: object.walkTo.y + dy };
        }
      });
      this.onKeyboardChange?.(`Moved object ${objectId}.`);
      return;
    }

    const boxIndex = this.state.selected.boxIndex;
    if (boxIndex !== null) {
      const roomId = room.id;
      this.state.update((project) => {
        const target = project.rooms.find((entry) => entry.id === roomId);
        const box = target?.boxes[boxIndex];
        if (!target || !box) return;
        target.boxes[boxIndex] = translateBox(box, dx, dy);
      });
      this.onKeyboardChange?.(`Moved walk box ${boxIndex}.`);
      return;
    }

    this.onKeyboardChange?.('Nothing is selected to move.');
  }

  /** Sets the selected object's walk-to point, from either input route. */
  private setWalkTo(x: number, y: number): void {
    const object = this.state.currentObject;
    if (!object) return;
    this.state.update((project) => {
      for (const room of project.rooms) {
        const target = room.objects.find((candidate) => candidate.id === object.id);
        if (target) target.walkTo = { x, y };
      }
    });
  }

  applyScale(): void {
    this.element.style.width = `${this.element.width * this.scale}px`;
    this.element.style.height = `${this.element.height * this.scale}px`;
  }

  /** Canvas pixel under a pointer event, in room coordinates. */
  private pointerPosition(event: PointerEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect();
    return {
      x: Math.floor(((event.clientX - bounds.left) / bounds.width) * this.element.width),
      y: Math.floor(((event.clientY - bounds.top) / bounds.height) * this.element.height),
    };
  }

  private attachPointerHandlers(): void {
    // The browser menu would otherwise swallow the right-click.
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());

    this.element.addEventListener('pointerdown', (event) => {
      const room = this.state.currentRoom;
      if (!room) return;
      this.element.setPointerCapture(event.pointerId);
      const { x, y } = this.pointerPosition(event);

      // Eyedropper: right-click, or alt-click for trackpads and for parity with
      // the sprite and object canvases, where right-click already erases.
      if (event.button === 2 || event.altKey) {
        this.pickColor(x, y);
        return;
      }

      switch (this.tool) {
        case 'paint':
          this.state.beginTransaction();
          this.drag = { kind: 'paint' };
          this.paintAt(x, y);
          break;

        /*
         * 2.5.7, Dragging Movements: a rectangle and a walk box were shapes you
         * could only make by dragging. They still can be — a drag is the
         * quickest way and nothing is taken away — but a click that does not
         * move now anchors the first corner instead of committing a one-pixel
         * shape, and the next click completes it. Two clicks, no drag.
         */
        case 'rectangle':
          if (this.anchor) {
            this.commitRectangle(this.anchor.x, this.anchor.y, x, y);
            this.anchor = null;
            this.render();
            break;
          }
          this.drag = { kind: 'rect', startX: x, startY: y, currentX: x, currentY: y };
          this.render();
          break;

        case 'object':
          this.state.addObject(x, y);
          this.tool = 'select';
          break;

        case 'walkbox':
          if (this.anchor) {
            this.commitWalkBox(this.anchor.x, this.anchor.y, x, y);
            this.anchor = null;
            this.render();
            break;
          }
          this.drag = { kind: 'newbox', startX: x, startY: y, currentX: x, currentY: y };
          this.render();
          break;

        case 'walkto': {
          this.setWalkTo(x, y);
          this.tool = 'select';
          break;
        }

        case 'select':
          this.beginSelectDrag(x, y);
          break;
      }
    });

    this.element.addEventListener('pointerleave', () => {
      this.onHover?.(null);
    });

    this.element.addEventListener('pointermove', (event) => {
      const position = this.pointerPosition(event);
      this.onHover?.(position);

      if (this.drag.kind === 'none') {
        // Handles are small, so the cursor is the only affordance telling the
        // author they are there at all.
        const hovered = this.tool === 'select' ? this.handleAt(position.x, position.y) : null;
        const handle = hovered?.handle ?? null;
        if (handle !== this.hoverHandle) {
          this.hoverHandle = handle;
          this.element.style.cursor = handle ? HANDLE_CURSORS[handle] : '';
        }
        return;
      }

      const { x, y } = position;

      switch (this.drag.kind) {
        case 'paint':
          this.paintAt(x, y);
          break;

        case 'rect':
        case 'newbox':
          this.drag.currentX = x;
          this.drag.currentY = y;
          this.render();
          break;

        case 'object': {
          const id = this.drag.id;
          const grabX = this.drag.grabX;
          const grabY = this.drag.grabY;
          // Transient: one undo step covers the whole drag, not every pixel.
          this.state.update(
            (project) => {
              for (const room of project.rooms) {
                const object = room.objects.find((o) => o.id === id);
                if (!object) continue;
                const dx = x - grabX - object.x;
                const dy = y - grabY - object.y;
                object.x = Math.max(0, x - grabX);
                object.y = Math.max(0, y - grabY);
                object.walkTo = { x: object.walkTo.x + dx, y: object.walkTo.y + dy };
              }
            },
            { transient: true },
          );
          break;
        }

        case 'resize': {
          const { index, handle, origin, startX, startY } = this.drag;
          const roomId = this.state.selected.roomId;
          const next = dragBoxHandle(origin, handle, x - startX, y - startY);
          this.state.update(
            (project) => {
              const room = project.rooms.find((r) => r.id === roomId);
              if (!room?.boxes[index]) return;
              room.boxes[index] = next;
            },
            { transient: true },
          );
          break;
        }

        case 'box': {
          // Destructured before the closure, because `this.drag` is a union and
          // the narrowing does not survive into the callback.
          const { index, origin, startX, startY } = this.drag;
          const roomId = this.state.selected.roomId;
          this.state.update(
            (project) => {
              const room = project.rooms.find((r) => r.id === roomId);
              if (!room?.boxes[index]) return;
              room.boxes[index] = translateBox(origin, x - startX, y - startY);
            },
            { transient: true },
          );
          break;
        }
      }
    });

    const finish = (): void => {
      if (this.drag.kind === 'rect' || this.drag.kind === 'newbox') {
        const { kind, startX, startY, currentX, currentY } = this.drag;
        // A press that went nowhere is a click, and a click anchors the first
        // corner rather than committing a shape one pixel across (2.5.7).
        if (startX === currentX && startY === currentY) {
          this.anchor = { x: startX, y: startY };
          this.onKeyboardChange?.(
            `First corner at ${startX}, ${startY}. Click the other corner to finish, or press Escape to cancel.`,
          );
        } else if (kind === 'rect') {
          this.commitRectangle(startX, startY, currentX, currentY);
        } else {
          this.commitWalkBox(startX, startY, currentX, currentY);
        }
      }
      this.drag = { kind: 'none' };
      this.render();
    };

    this.element.addEventListener('pointerup', finish);
    this.element.addEventListener('pointercancel', finish);
  }

  /** Radius of a handle in room pixels, so it stays grabbable at any zoom. */
  private get handleRadius(): number {
    return Math.max(2, Math.round(HANDLE_SCREEN_RADIUS / this.scale));
  }

  /** The handle of the selected box under a point, if any. */
  private handleAt(x: number, y: number): { index: number; handle: HandleId } | null {
    if (!this.showBoxes) return null;
    const index = this.state.selected.boxIndex;
    if (index === null) return null;

    const box = this.state.currentRoom?.boxes[index];
    if (!box) return null;

    const radius = this.handleRadius;
    for (const point of handlePoints(box)) {
      if (Math.abs(x - point.x) <= radius && Math.abs(y - point.y) <= radius) {
        return { index, handle: point.id };
      }
    }
    return null;
  }

  private beginSelectDrag(x: number, y: number): void {
    // Handles win over everything, including objects drawn on top: they are
    // only present on the already-selected box, so the author has aimed at one
    // deliberately.
    const grabbed = this.handleAt(x, y);
    if (grabbed) {
      const box = this.state.currentRoom!.boxes[grabbed.index];
      this.state.beginTransaction();
      this.drag = {
        kind: 'resize',
        index: grabbed.index,
        handle: grabbed.handle,
        origin: box,
        startX: x,
        startY: y,
      };
      return;
    }

    const room = this.state.currentRoom;
    if (!room) return;

    // Topmost object first, matching what the author sees.
    const hit = sceneItemAt(room.objects, x, y);
    if (hit) {
      this.state.select({ objectId: hit.id, boxIndex: null });
      this.state.beginTransaction();
      this.drag = { kind: 'object', id: hit.id, grabX: x - hit.x, grabY: y - hit.y };
      return;
    }

    for (let i = room.boxes.length - 1; i >= 0; i--) {
      const box = room.boxes[i];
      if (boxContains(box, x, y)) {
        this.state.select({ boxIndex: i, objectId: null });
        this.state.beginTransaction();
        this.drag = { kind: 'box', index: i, origin: box, startX: x, startY: y };
        return;
      }
    }

    this.state.select({ objectId: null, boxIndex: null });
  }

  /**
   * Samples the background and makes it the paint colour.
   *
   * Reads the room's own pixels rather than the rendered canvas, so the
   * overlays — walk boxes, object outlines, perspective guides — cannot
   * contaminate the pick.
   */
  private pickColor(x: number, y: number): void {
    const room = this.state.currentRoom;
    if (!room) return;
    if (x < 0 || y < 0 || x >= room.width || y >= room.height) return;

    this.color = getPixel(loadImage(room.background), x, y);
    this.onColorPicked?.(this.color);
  }

  private editBackground(mutate: (image: IndexedImage) => void, transient: boolean): void {
    const room = this.state.currentRoom;
    if (!room) return;
    const image = loadImage(room.background);
    mutate(image);
    this.state.update(
      (project) => {
        const target = project.rooms.find((r) => r.id === room.id);
        if (target) target.background = storeImage(image);
      },
      { transient },
    );
  }

  private paintAt(x: number, y: number): void {
    const size = this.brushSize;
    const offset = Math.floor(size / 2);
    this.editBackground(
      (image) => rect(image, x - offset, y - offset, size, size, this.color),
      true,
    );
  }

  private commitRectangle(x0: number, y0: number, x1: number, y1: number): void {
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0) + 1;
    const height = Math.abs(y1 - y0) + 1;
    if (width < 1 || height < 1) return;
    this.editBackground((image) => rect(image, left, top, width, height, this.color), false);
  }

  private commitWalkBox(x0: number, y0: number, x1: number, y1: number): void {
    const room = this.state.currentRoom;
    if (!room) return;

    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0) + 1;
    const height = Math.abs(y1 - y0) + 1;
    // Ignore an accidental click rather than creating an unusable sliver.
    if (width < 4 || height < 4) return;

    this.state.update((project) => {
      const target = project.rooms.find((r) => r.id === room.id);
      // Starts as a rectangle; the corner handles reshape it from there.
      target?.boxes.push(rectangleBox(left, top, width, height, { perspective: true }));
    });
    this.tool = 'select';
  }

  // ------------------------------------------------------------ rendering --

  render(): void {
    const room = this.state.currentRoom;
    if (!room) {
      this.context.clearRect(0, 0, this.element.width, this.element.height);
      return;
    }

    if (this.element.width !== room.width || this.element.height !== room.height) {
      this.element.width = room.width;
      this.element.height = room.height;
      this.imageData = null;
      this.applyScale();
    }

    const image = loadImage(room.background);
    if (!this.imageData) {
      this.imageData = this.context.createImageData(room.width, room.height);
    }

    paintScene(this.imageData.data, { ...image, palette: this.palette });
    this.context.putImageData(this.imageData, 0, 0);

    if (this.showGuides) this.drawPerspectiveGuides(room);
    if (this.showBoxes) this.drawWalkBoxes(room.boxes);
    if (this.showObjects) this.drawObjects(room.objects);
    this.drawDragPreview();
    this.drawAnchor();

    // Last, over everything: on a canvas the focus indicator has to be drawn
    // into the picture, and one hidden behind an object is not an indicator.
    if (this.cursor.visible) {
      this.cursor.clamp(this.roomBounds);
      drawCursor(this.context, this.cursor.x, this.cursor.y, 1, 1);
    }
  }

  /**
   * The corner a two-press shape is anchored at, and the shape it would make.
   *
   * Drawn for both input routes: a keyboard user has no rubber band under a
   * pointer to tell them where the first corner went, and a pointer user who
   * clicked without dragging has no idea a corner was placed at all unless
   * something says so.
   */
  private drawAnchor(): void {
    const start = this.anchor;
    if (!start) return;

    const context = this.context;
    context.save();
    context.setLineDash([3, 2]);
    context.lineWidth = 1;
    context.strokeStyle = '#ffffff';

    const left = Math.min(start.x, this.cursor.x);
    const top = Math.min(start.y, this.cursor.y);
    const width = Math.abs(this.cursor.x - start.x) + 1;
    const height = Math.abs(this.cursor.y - start.y) + 1;
    context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);

    context.setLineDash([]);
    context.fillStyle = '#ffffff';
    context.fillRect(start.x - 1, start.y - 1, 3, 3);
    context.fillStyle = '#000000';
    context.fillRect(start.x, start.y, 1, 1);
    context.restore();
  }

  /**
   * Draws the two rows the perspective ramp interpolates between.
   *
   * Without them the numbers in the inspector are abstract; on the canvas it is
   * obvious that "far" means the back of the floor.
   */
  private drawPerspectiveGuides(room: { perspective?: ScaleRamp; width: number }): void {
    const ramp = room.perspective;
    if (!ramp) return;

    const context = this.context;
    context.save();
    context.lineWidth = 1;

    for (const [y, label] of [
      [ramp.farY, `far · ${ramp.farScale}`],
      [ramp.nearY, `near · ${ramp.nearScale}`],
    ] as Array<[number, string]>) {
      context.setLineDash([4, 3]);
      context.strokeStyle = 'rgba(216, 166, 87, 0.85)';
      context.beginPath();
      context.moveTo(0, y + 0.5);
      context.lineTo(room.width, y + 0.5);
      context.stroke();

      context.setLineDash([]);
      context.font = '7px sans-serif';
      context.fillStyle = 'rgba(0, 0, 0, 0.7)';
      context.fillRect(2, y - 8, context.measureText(label).width + 4, 8);
      context.fillStyle = '#d8a657';
      context.fillText(label, 4, y - 2);
    }

    context.restore();
  }

  private drawWalkBoxes(boxes: BoxDefinition[]): void {
    const context = this.context;

    boxes.forEach((box, index) => {
      const selected = this.state.selected.boxIndex === index;
      // A concave box is drawn in a warning colour: the engine treats part of
      // it as unwalkable, and nothing else on screen would show that.
      const convex = isConvexBox(box);

      context.beginPath();
      context.moveTo(box.ul.x + 0.5, box.ul.y + 0.5);
      context.lineTo(box.ur.x + 0.5, box.ur.y + 0.5);
      context.lineTo(box.lr.x + 0.5, box.lr.y + 0.5);
      context.lineTo(box.ll.x + 0.5, box.ll.y + 0.5);
      context.closePath();

      if (convex) {
        context.fillStyle = selected ? 'rgba(80, 220, 140, 0.30)' : 'rgba(80, 220, 140, 0.14)';
        context.strokeStyle = selected ? '#6bffb0' : 'rgba(107, 255, 176, 0.5)';
      } else {
        context.fillStyle = selected ? 'rgba(255, 96, 96, 0.35)' : 'rgba(255, 96, 96, 0.18)';
        context.strokeStyle = '#ff6060';
      }

      context.fill();
      context.lineWidth = 1;
      context.stroke();

      if (selected) this.drawHandles(box);
    });
  }

  /**
   * Draws the eight grips.
   *
   * Sized in room pixels from the zoom so they stay constant on screen: a fixed
   * room-pixel handle would be invisible at 1x and enormous at 4x.
   */
  private drawHandles(box: BoxDefinition): void {
    const context = this.context;
    const size = Math.max(2, Math.round(6 / this.scale));
    const half = size / 2;

    for (const point of handlePoints(box)) {
      const x = point.x - half + 0.5;
      const y = point.y - half + 0.5;
      const corner = HANDLE_CORNERS[point.id].length === 1;

      // Corners are the interesting handles now that a box need not be a
      // rectangle, so they are drawn solid and the edge grips hollow.
      context.fillStyle = this.hoverHandle === point.id ? '#ffffff' : '#6bffb0';
      if (corner) {
        context.fillRect(x, y, size, size);
      } else {
        context.fillStyle = 'rgba(20, 20, 26, 0.9)';
        context.fillRect(x, y, size, size);
        context.strokeStyle = this.hoverHandle === point.id ? '#ffffff' : '#6bffb0';
        context.lineWidth = 1;
        context.strokeRect(x, y, size, size);
        continue;
      }
      context.strokeStyle = 'rgba(0, 0, 0, 0.75)';
      context.lineWidth = 1;
      context.strokeRect(x, y, size, size);
    }
  }

  private drawObjects(
    objects: Array<{
      id: number;
      x: number;
      y: number;
      width: number;
      height: number;
      walkTo: { x: number; y: number };
    }>,
  ): void {
    const context = this.context;
    for (const object of objects) {
      const selected = this.state.selected.objectId === object.id;
      context.strokeStyle = selected ? '#ffd166' : 'rgba(255, 209, 102, 0.55)';
      context.lineWidth = 1;
      context.strokeRect(object.x + 0.5, object.y + 0.5, object.width - 1, object.height - 1);

      if (selected && this.showWalkTo) {
        // The walk-to point, and a line back to the object it belongs to.
        context.strokeStyle = 'rgba(255, 209, 102, 0.7)';
        context.beginPath();
        context.moveTo(object.x + object.width / 2, object.y + object.height);
        context.lineTo(object.walkTo.x, object.walkTo.y);
        context.stroke();

        context.fillStyle = '#ffd166';
        context.beginPath();
        context.arc(object.walkTo.x, object.walkTo.y, 2.5, 0, Math.PI * 2);
        context.fill();
      }
    }
  }

  private drawDragPreview(): void {
    if (this.drag.kind !== 'rect' && this.drag.kind !== 'newbox') return;
    const { startX, startY, currentX, currentY } = this.drag;

    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX) + 1;
    const height = Math.abs(currentY - startY) + 1;

    const context = this.context;
    if (this.drag.kind === 'rect') {
      const entry = this.palette[this.color] ?? [255, 255, 255];
      context.fillStyle = `rgba(${entry[0]}, ${entry[1]}, ${entry[2]}, 0.7)`;
      context.fillRect(left, top, width, height);
    } else {
      context.fillStyle = 'rgba(80, 220, 140, 0.25)';
      context.fillRect(left, top, width, height);
      context.strokeStyle = '#6bffb0';
      context.strokeRect(left + 0.5, top + 0.5, width - 1, height - 1);
    }
  }
}
