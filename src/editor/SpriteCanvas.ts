import { createImage, type IndexedImage } from '../authoring/ImageEncoder.js';
import { loadImage, storeImage } from '../authoring/imageCodec.js';
import { getPixel } from '../authoring/draw.js';
import { defaultPalette } from '../authoring/palette.js';
import {
  definedFacings,
  poseCels,
  type PoseFacing,
  type ProjectActor,
  type SpriteCel,
} from '../authoring/project.js';
import type { EditorState } from './state.js';
import {
  KeyboardCursor,
  describeCanvas,
  drawCursor,
  isActivation,
  isErase,
} from './canvasKeyboard.js';

/**
 * The frames a costume needs, and what each is for.
 *
 * SCUMM indexes animations by frame number, and the engine's defaults are
 * fixed: 1 init, 2 walk, 3 stand, 4 talk-start, 5 talk-stop. Authors do not
 * think in those terms, so the editor names them and hides the ones that are
 * almost always duplicates.
 */
export const SPRITE_FRAMES: Array<{ index: number; label: string; hint: string }> = [
  {
    index: 3,
    label: 'Standing',
    hint: 'Shown when the character is still. One cel, unless you want an idle animation',
  },
  {
    index: 2,
    label: 'Walking',
    hint: 'Shown while the character moves — this is the pose that wants several cels',
  },
  { index: 4, label: 'Talking', hint: 'Shown while speaking' },
];

/**
 * Costume colour 0 is always transparent; 1-31 map onto the game palette.
 *
 * 31 rather than 15 because the costume format has a 32 colour variant. It
 * costs a little size — the run-length field loses a bit — and buys twice the
 * palette, which matters far more when the character is the thing on screen the
 * player looks at most.
 */
export const COSTUME_COLORS = 31;

/** A cel copied rather than shared, so editing one facing cannot alter another. */
function copyCel(cel: SpriteCel): SpriteCel {
  return { image: { ...cel.image }, hold: cel.hold };
}

/** Default ticks per cel, matching the costume builder's own default. */
export const DEFAULT_HOLD = 6;

/**
 * A zoomed pixel editor for one costume frame.
 *
 * Kept separate from `RoomCanvas` because the two differ in what a pixel *is*:
 * a room stores game palette indices, a costume stores its own 0-15 indices
 * that are mapped through the actor's palette at draw time. Sharing one canvas
 * would mean threading that distinction through every operation.
 */
export class SpriteCanvas {
  readonly element: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly state: EditorState;
  private readonly defaultColors = defaultPalette();

  /**
   * Colours the actor's palette indexes.
   *
   * An actor's palette holds game palette indices, so it means whatever the
   * open room's colours mean. A sprite imported from a published game is
   * indexing that game's table, not the editor's defaults.
   */
  private get gamePalette(): number[][] {
    return this.state.currentRoom?.palette ?? this.defaultColors;
  }

  /** Costume colour index being painted, 0 for the eraser. */
  color = 1;
  zoom = 10;
  /** Which cel within that pose. */
  celIndex = 0;
  /**
   * Which facing is being edited.
   *
   * `all` is one drawing used whichever way the character turns, which is what
   * a hand-drawn sprite normally wants. A costume out of a published game has
   * four genuinely different views — a character walking away is drawn from
   * behind — so those are editable one direction at a time.
   */
  facing: PoseFacing = 'all';

  private currentPose = 3;
  /**
   * Zero, so that the first selection counts as a change.
   *
   * The editor opens straight onto actor 1, so starting at 1 would leave the
   * very case `showADrawnFacing` exists for — opening an imported project and
   * looking at its first character — on a facing nothing is drawn under.
   */
  private currentActor = 0;

  /** Which pose (SCUMM frame number) is being edited. */
  get frameIndex(): number {
    return this.currentPose;
  }

  set frameIndex(index: number) {
    if (index === this.currentPose) return;
    this.currentPose = index;
    this.showADrawnFacing();
  }

  /** The actor being edited. */
  get actorId(): number {
    return this.currentActor;
  }

  set actorId(id: number) {
    if (id === this.currentActor) return;
    this.currentActor = id;
    this.showADrawnFacing();
  }

  showGrid = true;
  /** Cycles the pose instead of showing one cel, for checking the timing. */
  previewing = false;

  private previewTick = 0;

  /** Fired when the eyedropper picks a colour, so the palette can follow. */
  onColorPicked: ((color: number) => void) | null = null;

  private painting = false;
  private erasing = false;

  constructor(state: EditorState) {
    this.state = state;
    this.element = document.createElement('canvas');
    this.element.className = 'sprite-canvas';

    const context = this.element.getContext('2d');
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;

    this.attachPointerHandlers();
    this.attachKeyboardHandlers();
  }

  /**
   * The cursor the arrow keys move, and the description the canvas is given.
   *
   * Painting was pointer-only, which is 2.1.1 failed for the whole of costume
   * editing: there was no key that put a pixel anywhere. The help element is
   * appended by the editor next to the canvas, so the key map is readable
   * rather than crammed into the accessible name.
   */
  readonly cursor = new KeyboardCursor();

  /** Called after a key changes the cursor or the art, so the editor can say so. */
  onKeyboardChange: ((message: string) => void) | null = null;

  /**
   * The description element for this canvas, to be placed beside it.
   *
   * Built in `attachKeyboardHandlers` rather than as a field initialiser: field
   * initialisers run before the constructor body, and `this.element` does not
   * exist yet at that point.
   */
  help!: HTMLElement;

  private attachKeyboardHandlers(): void {
    this.help = describeCanvas(this.element, {
      id: 'sprite-canvas-help',
      label: 'Costume cel',
      help:
        'Draw the selected costume cel. Arrow keys move the drawing cursor one pixel, ' +
        'with Shift for eight. Enter or Space paints the selected colour, Delete erases, ' +
        'and P picks up the colour under the cursor. Home, End, Page Up and Page Down go ' +
        'to the edges.',
    });

    this.element.addEventListener('focus', () => {
      this.cursor.visible = true;
      this.render();
    });
    this.element.addEventListener('blur', () => {
      this.cursor.visible = false;
      this.render();
    });

    this.element.addEventListener('keydown', (event) => {
      const image = this.currentFrame();
      const bounds = { width: image.width, height: image.height };

      if (this.cursor.handle(event, bounds)) {
        event.preventDefault();
        this.render();
        this.announceCursor();
        return;
      }

      if (isActivation(event) || isErase(event)) {
        event.preventDefault();
        // One transaction per press: a key that paints is one undo step, where
        // a drag is one step for the whole stroke.
        this.state.beginTransaction();
        this.paintPixel(this.cursor.x, this.cursor.y, isErase(event));
        this.render();
        this.onKeyboardChange?.(
          isErase(event)
            ? `Erased ${this.cursor.x}, ${this.cursor.y}.`
            : `Painted colour ${this.color} at ${this.cursor.x}, ${this.cursor.y}.`,
        );
        return;
      }

      // The eyedropper. Alt-click and right-click already do this with a
      // pointer; a key is the only route without one.
      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        this.color = getPixel(image, this.cursor.x, this.cursor.y);
        this.onColorPicked?.(this.color);
        this.onKeyboardChange?.(`Picked up colour ${this.color}.`);
      }
    });
  }

  private announceCursor(): void {
    const image = this.currentFrame();
    const value = getPixel(image, this.cursor.x, this.cursor.y);
    this.onKeyboardChange?.(
      `${this.cursor.x}, ${this.cursor.y} — ${value === 0 ? 'transparent' : `colour ${value}`}`,
    );
  }

  /** One pixel, from a key rather than a pointer. */
  private paintPixel(x: number, y: number, erase: boolean): void {
    const image = this.currentFrame();
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
    const value = erase ? 0 : this.color;
    if (image.pixels[y * image.width + x] === value) return;
    image.pixels[y * image.width + x] = value;
    this.writeFrame(image, true);
  }

  private get actor(): ProjectActor | null {
    return this.state.current.actors.find((actor) => actor.id === this.actorId) ?? null;
  }

  /** The cels of the pose and facing being edited. */
  get cels(): SpriteCel[] {
    return poseCels(this.actor?.poses[this.frameIndex], this.facing);
  }

  /** The facings this actor has drawn separately, for the editor's selector. */
  get facings(): PoseFacing[] {
    return definedFacings(this.actor?.poses[this.frameIndex]);
  }

  /**
   * Moves off a facing the pose has nothing under, onto one it is drawn for.
   *
   * A costume imported from a published game has no shared drawing — its four
   * views genuinely differ, so every direction is filled and `all` is empty.
   * The selector opens on `all`, so such a character showed a blank canvas
   * while plainly having artwork, and the only clue was a `(none)` in a
   * dropdown the author had no reason to open. Worse, drawing on that blank
   * canvas would have created shared artwork that overrides all four
   * directions at once.
   *
   * Only a facing with nothing under it moves. A direction the author picked
   * deliberately is kept wherever the new pose has something to show there,
   * because `poseCels` already falls back to the shared drawing — so switching
   * pose on a hand-drawn sprite changes nothing.
   */
  private showADrawnFacing(): void {
    if (poseCels(this.actor?.poses[this.currentPose], this.facing).length > 0) return;

    // `definedFacings` lists `all` first, so shared artwork stays preferred.
    this.facing = definedFacings(this.actor?.poses[this.currentPose])[0] ?? 'all';
    this.celIndex = 0;
  }

  /** The cel being edited, created on demand at a sensible default size. */
  private currentFrame(): IndexedImage {
    const cel = this.cels[this.celIndex];
    if (cel) return loadImage(cel.image);

    // Fall back to the standing pose, so a new one starts from the existing
    // artwork rather than from nothing.
    const standing = poseCels(this.actor?.poses[3], this.facing)[0];
    if (standing) return loadImage(standing.image);

    return createImage(16, 24, 0);
  }

  /**
   * Mutates the pose and facing being edited, creating them if needed.
   *
   * Editing one direction of a pose that only has shared artwork starts that
   * direction from a copy of the shared drawing rather than from a blank
   * canvas: the author is nearly always making a variation of what is there,
   * and an empty canvas would silently lose the sprite for that direction.
   */
  private editPose(mutate: (cels: SpriteCel[]) => void, transient = false): void {
    const actorId = this.actorId;
    const frameIndex = this.frameIndex;
    const facing = this.facing;

    this.state.update(
      (project) => {
        const actor = project.actors.find((candidate) => candidate.id === actorId);
        if (!actor) return;
        while (actor.poses.length <= frameIndex) actor.poses.push({});
        actor.poses[frameIndex] ??= {};

        const pose = actor.poses[frameIndex];
        pose[facing] ??= facing === 'all' ? [] : poseCels(pose, 'all').map(copyCel);
        mutate(pose[facing]!);
      },
      { transient },
    );
  }

  /**
   * Drops a facing's own artwork, so it falls back to the shared drawing.
   *
   * The way to undo "give this direction its own look" without deleting cels
   * one at a time.
   */
  clearFacing(): void {
    const actorId = this.actorId;
    const frameIndex = this.frameIndex;
    const facing = this.facing;
    if (facing === 'all') return;

    this.state.update((project) => {
      const pose = project.actors.find((a) => a.id === actorId)?.poses[frameIndex];
      if (pose) delete pose[facing];
    });
    this.celIndex = 0;
  }

  private writeFrame(image: IndexedImage, transient: boolean): void {
    const celIndex = this.celIndex;
    this.editPose((pose) => {
      const stored = storeImage(image);
      if (pose[celIndex]) pose[celIndex].image = stored;
      else pose[celIndex] = { image: stored, hold: DEFAULT_HOLD };
    }, transient);
  }

  // ------------------------------------------------------------------ cels --

  /** Adds a cel after the current one, copied from it so drawing continues. */
  addCel(): void {
    const source = this.currentFrame();
    const at = this.celIndex + 1;
    this.editPose((pose) => {
      pose.splice(at, 0, { image: storeImage(source), hold: DEFAULT_HOLD });
    });
    this.celIndex = at;
  }

  removeCel(): void {
    // A pose with no cels draws nothing, so the last one is not removable.
    if (this.cels.length <= 1) return;
    const at = this.celIndex;
    this.editPose((pose) => pose.splice(at, 1));
    this.celIndex = Math.max(0, at - 1);
  }

  moveCel(delta: number): void {
    const from = this.celIndex;
    const to = from + delta;
    if (to < 0 || to >= this.cels.length) return;
    this.editPose((pose) => {
      const [cel] = pose.splice(from, 1);
      pose.splice(to, 0, cel);
    });
    this.celIndex = to;
  }

  setHold(hold: number): void {
    const at = this.celIndex;
    const value = Math.max(1, Math.min(127, hold));
    this.editPose((pose) => {
      if (pose[at]) pose[at].hold = value;
    });
  }

  selectCel(index: number): void {
    this.celIndex = Math.max(0, Math.min(index, Math.max(0, this.cels.length - 1)));
  }

  /**
   * Advances the preview.
   *
   * Driven by the caller's animation loop rather than a timer of its own, so it
   * stops when the tab is hidden and cannot outlive the editor.
   */
  tickPreview(): boolean {
    if (!this.previewing) return false;
    const cels = this.cels;
    if (cels.length <= 1) return false;

    this.previewTick++;
    const total = cels.reduce((sum, cel) => sum + Math.max(1, cel.hold), 0);
    const position = this.previewTick % total;

    let running = 0;
    for (let i = 0; i < cels.length; i++) {
      running += Math.max(1, cels[i].hold);
      if (position < running) {
        if (this.celIndex !== i) {
          this.celIndex = i;
          return true;
        }
        return false;
      }
    }
    return false;
  }

  private pointerPixel(event: PointerEvent): { x: number; y: number } {
    const bounds = this.element.getBoundingClientRect();
    return {
      x: Math.floor(
        (((event.clientX - bounds.left) / bounds.width) * this.element.width) / this.zoom,
      ),
      y: Math.floor(
        (((event.clientY - bounds.top) / bounds.height) * this.element.height) / this.zoom,
      ),
    };
  }

  private attachPointerHandlers(): void {
    this.element.addEventListener('contextmenu', (event) => event.preventDefault());

    this.element.addEventListener('pointerdown', (event) => {
      this.element.setPointerCapture(event.pointerId);

      // Right-click already erases here, so the eyedropper takes alt-click.
      if (event.altKey) {
        const { x, y } = this.pointerPixel(event);
        const image = this.currentFrame();
        if (x >= 0 && y >= 0 && x < image.width && y < image.height) {
          this.color = getPixel(image, x, y);
          this.onColorPicked?.(this.color);
        }
        return;
      }

      this.painting = true;
      // Right button erases, which is the convention every pixel editor uses.
      this.erasing = event.button === 2;
      this.state.beginTransaction();
      this.paint(event);
    });

    this.element.addEventListener('pointermove', (event) => {
      if (!this.painting) return;
      this.paint(event);
    });

    const stop = (): void => {
      this.painting = false;
      this.erasing = false;
    };
    this.element.addEventListener('pointerup', stop);
    this.element.addEventListener('pointercancel', stop);
  }

  private paint(event: PointerEvent): void {
    const { x, y } = this.pointerPixel(event);
    const image = this.currentFrame();
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;

    const value = this.erasing ? 0 : this.color;
    if (image.pixels[y * image.width + x] === value) return;

    image.pixels[y * image.width + x] = value;
    this.writeFrame(image, true);
  }

  /** Resizes the frame, keeping the existing pixels anchored top-left. */
  resize(width: number, height: number): void {
    const source = this.currentFrame();
    const target = createImage(
      Math.max(1, Math.min(64, width)),
      Math.max(1, Math.min(64, height)),
      0,
    );
    for (let y = 0; y < Math.min(source.height, target.height); y++) {
      for (let x = 0; x < Math.min(source.width, target.width); x++) {
        target.pixels[y * target.width + x] = source.pixels[y * source.width + x];
      }
    }
    this.writeFrame(target, false);
  }

  clear(): void {
    const image = this.currentFrame();
    image.pixels.fill(0);
    this.writeFrame(image, false);
  }

  /**
   * Replaces the current cel, optionally adopting a palette with it.
   *
   * An imported picture brings its own colours, so the actor's palette is
   * rewritten to match — otherwise the pixels would index colours chosen for
   * something else entirely.
   */
  replaceCel(image: IndexedImage, palette?: number[]): void {
    const actorId = this.actorId;
    if (palette) {
      this.state.update((project) => {
        const actor = project.actors.find((candidate) => candidate.id === actorId);
        if (!actor) return;
        for (let i = 0; i < palette.length; i++) actor.palette[i] = palette[i];
      });
    }
    this.writeFrame(image, false);
  }

  /** Copies the standing pose's first cel over this one, as a starting point. */
  copyFromStanding(): void {
    const standing = poseCels(this.actor?.poses[3], this.facing)[0];
    if (!standing) return;
    this.writeFrame(loadImage(standing.image), false);
  }

  /** A thumbnail data URL for a cel, for the frame strip. */
  thumbnail(cel: SpriteCel, size = 40): string {
    const image = loadImage(cel.image);
    const scale = Math.max(1, Math.floor(size / Math.max(image.width, image.height)));

    const canvas = document.createElement('canvas');
    canvas.width = image.width * scale;
    canvas.height = image.height * scale;
    const context = canvas.getContext('2d');
    if (!context) return '';

    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const costumeColor = image.pixels[y * image.width + x];
        if (costumeColor === 0) continue;
        const paletteIndex = this.actor?.palette[costumeColor - 1] ?? 15;
        const entry = this.gamePalette[paletteIndex] ?? [255, 255, 255];
        context.fillStyle = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
        context.fillRect(x * scale, y * scale, scale, scale);
      }
    }
    return canvas.toDataURL();
  }

  get frameSize(): { width: number; height: number } {
    const image = this.currentFrame();
    return { width: image.width, height: image.height };
  }

  render(): void {
    const image = this.currentFrame();
    const actor = this.actor;

    const width = image.width * this.zoom;
    const height = image.height * this.zoom;
    if (this.element.width !== width || this.element.height !== height) {
      this.element.width = width;
      this.element.height = height;
    }

    const context = this.context;
    context.clearRect(0, 0, width, height);

    // A chequerboard behind the art, so transparent pixels read as transparent
    // rather than as black — which is a real colour in the palette.
    const cell = Math.max(4, Math.floor(this.zoom / 2));
    for (let y = 0; y < height; y += cell) {
      for (let x = 0; x < width; x += cell) {
        const dark = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2;
        context.fillStyle = dark ? '#1b1b22' : '#23232c';
        context.fillRect(x, y, cell, cell);
      }
    }

    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const costumeColor = image.pixels[y * image.width + x];
        if (costumeColor === 0) continue;
        const paletteIndex = actor?.palette[costumeColor - 1] ?? 15;
        const entry = this.gamePalette[paletteIndex] ?? [255, 255, 255];
        context.fillStyle = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
        context.fillRect(x * this.zoom, y * this.zoom, this.zoom, this.zoom);
      }
    }

    if (this.showGrid && this.zoom >= 6) {
      context.strokeStyle = 'rgba(255, 255, 255, 0.07)';
      context.lineWidth = 1;
      for (let x = 0; x <= image.width; x++) {
        context.beginPath();
        context.moveTo(x * this.zoom + 0.5, 0);
        context.lineTo(x * this.zoom + 0.5, height);
        context.stroke();
      }
      for (let y = 0; y <= image.height; y++) {
        context.beginPath();
        context.moveTo(0, y * this.zoom + 0.5);
        context.lineTo(width, y * this.zoom + 0.5);
        context.stroke();
      }
    }

    // The baseline: a costume is drawn with its bottom row at the actor's feet,
    // so art floating above it appears to hover in game.
    context.strokeStyle = 'rgba(255, 209, 102, 0.5)';
    context.beginPath();
    context.moveTo(0, height - 0.5);
    context.lineTo(width, height - 0.5);
    context.stroke();

    // Last, so nothing is drawn over it: 2.4.7 wants the focused thing visibly
    // marked, and on a canvas the marker has to be part of the picture.
    if (this.cursor.visible) {
      this.cursor.clamp({ width: image.width, height: image.height });
      drawCursor(context, this.cursor.x, this.cursor.y, this.zoom, this.zoom);
    }
  }
}

/**
 * A simple humanoid, so a new project has a character rather than a block.
 *
 * Costume colour indices: 1 hair, 2 skin, 3 top, 4 legs, 5 shoes. The walk is
 * four cels — stride, pass, opposite stride, pass — which is the smallest
 * sequence that reads as walking rather than twitching.
 */
export function defaultSpriteFrames(): Array<IndexedImage[]> {
  const key: Record<string, number> = { '.': 0, h: 1, f: 2, c: 3, l: 4, s: 5 };

  const build = (art: string): IndexedImage => {
    const lines = art
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const width = Math.max(...lines.map((line) => line.length));
    const image = createImage(width, lines.length, 0);
    lines.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) image.pixels[y * width + x] = key[line[x]] ?? 0;
    });
    return image;
  };

  const standing = build(`
    ..hhhh..
    .hffffh.
    .ffffff.
    ..ffff..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    ..l..l..
    ..l..l..
    ..l..l..
    .ss..ss.
  `);

  const walking = build(`
    ..hhhh..
    .hffffh.
    .ffffff.
    ..ffff..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    .l....l.
    .l....l.
    .l....l.
    ss....ss
  `);

  const talking = build(`
    ..hhhh..
    .hffffh.
    .ffffff.
    ..f..f..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    ..l..l..
    ..l..l..
    ..l..l..
    .ss..ss.
  `);

  const walkingMirror = build(`
    ..hhhh..
    .hffffh.
    .ffffff.
    ..ffff..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    ..l..l..
    ..l..l..
    ..ll.ll.
    .ss...ss
  `);

  // Index by SCUMM frame number: 0 unused, 1 init, 2 walk, 3 stand, 4 talk,
  // 5 talk-stop. The walk passes through the standing pose between strides.
  return [
    [],
    [standing],
    [walking, standing, walkingMirror, standing],
    [standing],
    [talking, standing],
    [standing],
  ];
}
