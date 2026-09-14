/**
 * The picture panel both Broken Sword surfaces use: a frame picker, the frame
 * drawn, and Import and Export beneath it.
 *
 * One widget, two families. ADR 0036 forbids these two sharing a *record* — a
 * Sword 1 sprite and a Sword II animation frame have nothing in common but the
 * word "frame" — and says nothing against sharing a control, which is what this
 * is: it is handed pixels, a palette and a callback, and it has never heard of
 * either family's document.
 *
 * ## Importing is not `importImage`, and the difference is one index
 *
 * `importImage.ts` quantises against a 256-entry palette and writes
 * `TRANSPARENT_INDEX` — 255 — for a pixel the source left transparent. That is
 * SCUMM's convention. Broken Sword's transparent index is **0**, in both
 * families and in every one of their formats, so quantising a sprite the SCUMM
 * way would paint colour 255 everywhere the artist meant to leave a hole and
 * make index 0 — a colour the game never draws — the commonest pixel in the
 * frame.
 *
 * So the palette handed to `quantise` here is the game's colours 1 to 255 with
 * the first one dropped. A returned index `i` is game colour `i + 1`, 255 comes
 * back only where the alpha threshold fired, and that becomes 0. Colour 0 is
 * therefore unreachable by accident and reachable exactly on purpose, which is
 * the property an artist replacing a sprite needs.
 *
 * ## The brush
 *
 * SCUMM's surface has `SpriteCanvas` and `ObjectArtCanvas`: pick a colour, put
 * a pixel down. Both Sword families could replace a frame whole through Import
 * and could not touch a single pixel of one, which was a missing *tool* and not
 * a missing format — the encoders round-trip every frame in both demos.
 *
 * So the panel grows one, here rather than in a fourth canvas class, because
 * both families already share this widget and neither wants its own copy of the
 * same twenty lines. A stroke is kept locally and drawn as it is made, and the
 * frame is written back once when the pointer lifts or a key is pressed: one
 * re-encode per stroke rather than per pixel, and one undo step per stroke.
 * The colours are the frame's own — an RLE16 frame offers the sixteen its
 * resource carries and no others — and colour 0 is the eraser, because this
 * family's transparency is index 0.
 */

import { announce } from '../ui/a11y.js';
import {
  KeyboardCursor,
  describeCanvas,
  drawCursor,
  isActivation,
  isErase,
} from './canvasKeyboard.js';
import { alert as showAlert } from './dialog.js';
import { groupItem, rovingGroup } from './a11yWidgets.js';
import { decodeImageFile, pickImageFile, quantise, type RgbaImage } from './importImage.js';
import { writePng, type RenderedImage } from './imageExport.js';
import { TRANSPARENT_INDEX } from '../authoring/ImageEncoder.js';

/** Alpha at or below which an imported pixel becomes Broken Sword's colour 0. */
const ALPHA_THRESHOLD = 127;

/**
 * True-colour pixels as Broken Sword palette indices, 0 meaning transparent.
 *
 * Pure, and exported for that reason: jsdom has no 2D context, so the half of
 * an import worth testing is the half that decides which index each pixel gets.
 */
export function swordImportPixels(
  source: RgbaImage,
  palette: readonly number[][],
  options: {
    dither?: boolean;
    transparentZero?: boolean;
    /** Which palette indices may be used. Defaults to 1..255. */
    allowed?: readonly number[];
  } = {},
): Uint8Array {
  const transparent = options.transparentZero ?? true;
  // Colours 1..255 by default. Dropping entry 0 is what keeps a quantised pixel
  // off the transparent index; mapping back through `allowed` is its other
  // half, and is also what lets an RLE16 frame be quantised against the sixteen
  // colours its own resource carries rather than against the whole screen.
  const allowed = (options.allowed ?? Array.from({ length: 255 }, (_, at) => at + 1)).filter(
    (index) => index !== 0,
  );
  const indexed = quantise(source, {
    palette: allowed.map((index) => [...(palette[index] ?? [0, 0, 0])]),
    dither: options.dither ?? true,
    alphaThreshold: transparent ? ALPHA_THRESHOLD : 0,
  });
  const out = new Uint8Array(source.width * source.height);
  for (let at = 0; at < out.length; at++) {
    const index = indexed.pixels[at] ?? 0;
    out[at] = index === TRANSPARENT_INDEX ? 0 : (allowed[index] ?? 0);
  }
  return out;
}

/** One colour the brush may hold, as the swatch strip shows it. */
export interface SwordBrushSwatch {
  readonly index: number;
  readonly rgb: readonly [number, number, number];
  readonly label: string;
}

/**
 * The colours this frame may actually be painted in.
 *
 * The frame's own palette and not a fixed 256: an RLE16 frame carries sixteen
 * colours in its own resource and painting a seventeenth would be a pixel the
 * encoder could not write back. Colour 0 leads, labelled for what it does here
 * — this family's transparency — and is dropped where a frame has no
 * transparent index to spend.
 */
export function swordBrushSwatches(
  palette: readonly number[][],
  options: { allowed?: readonly number[]; transparentZero?: boolean } = {},
): SwordBrushSwatch[] {
  const transparent = options.transparentZero ?? true;
  const indices = options.allowed
    ? [...options.allowed]
    : Array.from({ length: 256 }, (_, at) => at);
  const swatches: SwordBrushSwatch[] = [];
  for (const index of indices) {
    if (index === 0 && !transparent) continue;
    const entry = palette[index] ?? [0, 0, 0];
    const rgb: readonly [number, number, number] = [entry[0] ?? 0, entry[1] ?? 0, entry[2] ?? 0];
    swatches.push({
      index,
      rgb,
      label:
        index === 0
          ? 'colour 0 — transparent, the eraser'
          : `colour ${index} — red ${rgb[0]}, green ${rgb[1]}, blue ${rgb[2]}`,
    });
  }
  return swatches;
}

/**
 * Puts one pixel down, and says whether anything changed.
 *
 * Pure and exported for the reason `swordImportPixels` is: jsdom has no 2D
 * context, so what a brush *decides* has to live somewhere a test can reach.
 * The false return is what keeps a drag over unchanged pixels from re-encoding
 * a frame that is already what it should be.
 */
export function paintSwordPixel(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  colour: number,
): boolean {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const at = y * width + x;
  if (pixels[at] === colour) return false;
  pixels[at] = colour;
  return true;
}

/** What is under the cursor, for the live region. */
export function describeSwordPixel(
  pixels: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  transparentZero = true,
): string {
  if (x < 0 || y < 0 || x >= width || y >= height) return `${x}, ${y} — outside the frame`;
  const value = pixels[y * width + x] ?? 0;
  if (value === 0 && transparentZero) return `${x}, ${y} — transparent`;
  return `${x}, ${y} — colour ${value}`;
}

/** One entry in the frame strip. */
export interface SwordPictureFrameChoice {
  readonly index: number;
  readonly label: string;
}

export interface SwordPictureViewOptions {
  /** Unique per selection, so two panels' ids never collide. */
  readonly id: string;
  /** What the picture as a whole is, said to a screen reader. */
  readonly title: string;
  readonly frames: readonly SwordPictureFrameChoice[];
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  /**
   * The chosen frame's pixels, or null when this project cannot decode it.
   *
   * `pixels` itself is what the brush paints into; a caller that has only the
   * size can leave it out and gets the panel without one.
   */
  readonly pixels: {
    readonly width: number;
    readonly height: number;
    readonly pixels?: Uint8Array;
  } | null;
  /** Those pixels expanded through a palette, ready to draw and to save. */
  readonly image: RenderedImage | null;
  /** The colours an import quantises against — the same ones `image` used. */
  readonly palette: readonly number[][];
  /** Which of those an import may choose. Defaults to 1..255. */
  readonly allowed?: readonly number[];
  /** False for a background, which has no transparent pixel to preserve. */
  readonly transparentZero?: boolean;
  /** Why replacing is impossible, in a sentence naming the format. Null if it is. */
  readonly refusal: string | null;
  /** What a saved file is called. */
  readonly filename: string;
  /** Hands back indices at exactly the frame's size. */
  readonly onReplace: (pixels: Uint8Array, width: number, height: number) => void;
  /**
   * Writes a painted frame back. Absent means this panel has no brush.
   *
   * Separate from `onReplace` because a caller must *not* re-render the surface
   * from it: a re-render rebuilds this canvas, and a canvas rebuilt after every
   * keystroke is a canvas a keyboard loses focus in on the first one.
   */
  readonly onPaint?: (pixels: Uint8Array, width: number, height: number) => void;
  /** The colour the brush is holding, and where to put the author's choice. */
  readonly colour?: number;
  readonly onColour?: (index: number) => void;
  /** Sentences about the format that stand whether or not it can be written. */
  readonly notes?: readonly string[];
  /**
   * The ways a script in this project plays these frames. Empty means none do.
   *
   * A caller either finds a player and passes the rate that player implies, or
   * passes none and a `playbackRefusal` saying so. There is deliberately no
   * default rate to fall back on: a preview at an invented speed teaches an
   * author something false about their own game.
   */
  readonly playbacks?: readonly SwordPlayback[];
  /** Why there is no Play button, said where the button would have been. */
  readonly playbackRefusal?: string | null;
  /**
   * One frame's pixels, for the play loop to draw straight onto the canvas.
   *
   * Not `onSelect`: selecting re-renders the surface, which rebuilds this
   * canvas and loses both the timer and the focus — the same hazard `onPaint`
   * is separate from `onReplace` for.
   */
  readonly frameImage?: (index: number) => RenderedImage | null;
}

/**
 * One playable run of frames, and the evidence for its speed.
 *
 * `frameMs` is read out of the engine the frames belong to — a game cycle,
 * which is `TICKS_PER_STEP` sixtieths of a second in both Sword families — and
 * `why` names the script that plays them, so an author can check the claim
 * rather than take it.
 */
export interface SwordPlayback {
  /** What this run is, e.g. "forwards" or "facing north-east". */
  readonly label: string;
  /** Frame indices in the order the driver walks them. */
  readonly frames: readonly number[];
  /** Milliseconds a frame is held for. */
  readonly frameMs: number;
  /** The script that plays them, and the rate it implies. */
  readonly why: string;
}

/**
 * Builds the panel and returns it, so a caller appends it where it belongs.
 *
 * Everything that can go wrong is said on the surface: no 2D context, an
 * undecodable frame, a format with no encoder. A disabled button with no
 * sentence next to it is the thing this is written to avoid.
 */
export function swordPictureView(options: SwordPictureViewOptions): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'sword-picture';

  const status = document.createElement('p');
  status.className = 'sword-note';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  if (options.frames.length > 1) {
    panel.appendChild(frameStrip(options));
  }

  const figure = document.createElement('div');
  figure.className = 'sword-picture-canvas';
  const brush = brushOf(options, status);
  const surface: PictureSurface = {};
  figure.appendChild(pictureCanvas(options, brush, surface));
  panel.appendChild(figure);

  // `redraw` is set only once a canvas accepted the brush, so a browser with
  // no 2D context gets the note and no colours to pick with nothing to paint.
  if (brush?.redraw) {
    panel.appendChild(brush.help);
    panel.appendChild(swatchStrip(options, brush));
  }

  panel.appendChild(buttons(options, status));
  const playback = playbackControls(options, surface, status);
  if (playback) panel.appendChild(playback);

  for (const note of options.notes ?? []) {
    const paragraph = document.createElement('p');
    paragraph.className = 'sword-note';
    paragraph.textContent = note;
    panel.appendChild(paragraph);
  }

  if (options.refusal) {
    const refusal = document.createElement('p');
    refusal.className = 'sword-note sword-summary-warning';
    refusal.id = `${options.id}-refusal`;
    refusal.textContent = options.refusal;
    panel.appendChild(refusal);
  }

  panel.appendChild(status);
  return panel;
}

function frameStrip(options: SwordPictureViewOptions): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'sword-frame-strip';
  for (const frame of options.frames) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sword-frame';
    button.textContent = String(frame.index);
    button.title = frame.label;
    groupItem(button, {
      role: 'radio',
      selected: frame.index === options.selected,
      label: frame.label,
    });
    button.addEventListener('click', () => options.onSelect(frame.index));
    strip.appendChild(button);
  }
  rovingGroup(strip, { role: 'radiogroup', label: `frames of ${options.title}` });
  return strip;
}

/**
 * What one panel's brush knows: the working pixels and how to draw them.
 *
 * Null where there is nothing to paint — an undecodable frame, a format with no
 * encoder, or a caller that handed over a size and no pixels. The strip and the
 * canvas both ask for it, so a panel with no brush grows no controls that
 * cannot do anything.
 */
interface SwordBrush {
  readonly width: number;
  readonly height: number;
  /** The stroke in progress: the frame's own pixels, copied. */
  readonly pixels: Uint8Array;
  readonly swatches: readonly SwordBrushSwatch[];
  colour: number;
  readonly help: HTMLElement;
  /** Set by `pictureCanvas` once there is a canvas to repaint. */
  redraw: (() => void) | null;
  /** Set by `swatchStrip`, so the eyedropper can move the strip's selection. */
  showColour: ((index: number) => void) | null;
  readonly say: (message: string) => void;
  readonly commit: () => void;
}

function brushOf(options: SwordPictureViewOptions, status: HTMLElement): SwordBrush | null {
  const source = options.pixels?.pixels;
  if (!source || !options.onPaint || options.refusal) return null;
  const { width, height } = options.pixels!;
  const swatches = swordBrushSwatches(options.palette, {
    allowed: options.allowed,
    transparentZero: options.transparentZero,
  });
  const pixels = Uint8Array.from(source);
  const chosen = options.colour ?? swatches.find((swatch) => swatch.index !== 0)?.index ?? 0;
  const say = (message: string): void => {
    status.textContent = message;
  };
  return {
    width,
    height,
    pixels,
    swatches,
    colour: swatches.some((swatch) => swatch.index === chosen) ? chosen : (swatches[0]?.index ?? 0),
    help: document.createElement('div'),
    redraw: null,
    showColour: null,
    say,
    // One write per stroke: `onPaint` re-encodes the frame, and a re-encode per
    // pixel of a drag across a 784-pixel background is a surface nobody can
    // draw on.
    commit: () => options.onPaint?.(Uint8Array.from(pixels), width, height),
  };
}

/** The frame's own colours, as a radio group the arrow keys move through. */
function swatchStrip(options: SwordPictureViewOptions, brush: SwordBrush): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'sword-palette';
  const buttons = new Map<number, HTMLButtonElement>();
  for (const swatch of brush.swatches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sword-swatch';
    button.style.background =
      swatch.index === 0
        ? 'transparent'
        : `rgb(${swatch.rgb[0]},${swatch.rgb[1]},${swatch.rgb[2]})`;
    if (swatch.index === 0) button.textContent = '0';
    groupItem(button, {
      role: 'radio',
      selected: swatch.index === brush.colour,
      label: swatch.label,
    });
    button.addEventListener('click', () => {
      brush.colour = swatch.index;
      brush.showColour?.(swatch.index);
      options.onColour?.(swatch.index);
      brush.say(`Brush holding ${swatch.label}.`);
    });
    buttons.set(swatch.index, button);
    strip.appendChild(button);
  }
  rovingGroup(strip, { role: 'radiogroup', label: `colours of ${options.title}` });
  brush.showColour = (index) => {
    for (const [at, button] of buttons) {
      button.setAttribute('aria-checked', String(at === index));
    }
  };
  return strip;
}

/** Where the play loop finds the canvas the frame was drawn on, if there is one. */
interface PictureSurface {
  draw?: (image: RenderedImage) => void;
}

function pictureCanvas(
  options: SwordPictureViewOptions,
  brush: SwordBrush | null,
  surface: PictureSurface,
): HTMLElement {
  if (!options.pixels || !options.image) {
    const note = document.createElement('p');
    note.className = 'sword-note';
    note.textContent =
      'This frame does not decode in this project, so there is nothing to draw. Its facts are ' +
      'below and its bytes are preserved exactly.';
    return note;
  }

  const canvas = document.createElement('canvas');
  canvas.width = options.image.width;
  canvas.height = options.image.height;
  canvas.className = 'scene-canvas';
  // role="img" without a brush: a viewer, not a control — there is nothing to
  // operate, so it is named rather than made a focus stop that does nothing.
  // With one, `describeCanvas` makes it an operable, described application.
  canvas.setAttribute('role', 'img');
  canvas.setAttribute(
    'aria-label',
    `${options.title}, ${options.image.width} by ${options.image.height} pixels`,
  );

  const context = canvas.getContext('2d');
  if (!context) {
    const note = document.createElement('p');
    note.className = 'sword-note';
    note.textContent =
      'This browser has no 2D canvas, so the picture cannot be drawn here. Import and Export ' +
      'both need one, so they are unavailable too.';
    return note;
  }
  const put = (image: RenderedImage): void => {
    const frame = context.createImageData(image.width, image.height);
    frame.data.set(image.rgba);
    context.putImageData(frame, 0, 0);
  };
  put(options.image);
  // Frames of one animation are not all the same size — both families store a
  // frame at whatever width its artwork needs — so the canvas takes each
  // frame's own size rather than scaling it to the first one's. Stopping puts
  // the selected frame back, which puts the size back with it.
  surface.draw = (image) => {
    if (image.width !== canvas.width || image.height !== canvas.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    put(image);
  };
  if (brush) attachBrush(canvas, context, options, brush);
  return canvas;
}

/**
 * Play and Stop for each run a script in this project actually performs.
 *
 * Buttons, so they are keyboard-operable by being what they are rather than by
 * a handler that remembers to be — the rule `canvasKeyboard.ts` exists to keep
 * and `docs/accessibility.md` states. Where nothing plays these frames the
 * panel says so in the same place, because the alternative — a Play button at a
 * rate this editor picked — would be a claim about the game that is not true.
 */
function playbackControls(
  options: SwordPictureViewOptions,
  surface: PictureSurface,
  status: HTMLElement,
): HTMLElement | null {
  const playbacks = options.playbacks ?? [];
  if (playbacks.length === 0) {
    if (!options.playbackRefusal) return null;
    const note = document.createElement('p');
    note.className = 'sword-note sword-summary-warning';
    note.textContent = options.playbackRefusal;
    return note;
  }

  const row = document.createElement('div');
  row.className = 'sword-picture-buttons';
  const frameImage = options.frameImage;
  // A browser with no 2D context has no `draw`, and a caller that passed no
  // `frameImage` has no frames to hand over. Either way there is nothing to
  // animate, so the runs are described and not offered.
  const playable = Boolean(surface.draw && frameImage);

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopAll: (() => void) | null = null;

  for (const playback of playbacks) {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${options.id}-play-${playbacks.indexOf(playback)}`;
    const name = `Play ${playback.label}`;
    button.textContent = name;
    button.title = playback.why;
    button.setAttribute('aria-label', `${name}. ${playback.why}`);
    if (!playable) {
      button.disabled = true;
      row.appendChild(button);
      continue;
    }

    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      stopAll = null;
      button.textContent = name;
      button.setAttribute('aria-label', `${name}. ${playback.why}`);
      if (options.image) surface.draw?.(options.image);
    };

    button.addEventListener('click', () => {
      if (timer !== null) {
        const wasMine = stopAll === stop;
        stopAll?.();
        if (wasMine) {
          status.textContent = `Stopped ${playback.label}.`;
          return;
        }
      }
      let at = 0;
      stopAll = stop;
      button.textContent = `Stop ${playback.label}`;
      button.setAttribute('aria-label', `Stop ${playback.label}`);
      status.textContent =
        `Playing ${playback.frames.length} frames ${playback.label} at ` +
        `${Math.round(1000 / playback.frameMs)} a second. ${playback.why}`;
      timer = setInterval(() => {
        // The panel is rebuilt whenever the surface re-renders; a timer left
        // running against a detached canvas would draw nowhere forever.
        if (!button.isConnected) {
          stop();
          return;
        }
        const index = playback.frames[at % playback.frames.length] ?? 0;
        at += 1;
        const image = frameImage?.(index);
        if (image) surface.draw?.(image);
      }, playback.frameMs);
    });
    row.appendChild(button);
  }

  const why = document.createElement('p');
  why.className = 'sword-note';
  why.textContent = playable
    ? playbacks.map((playback) => `${playback.label}: ${playback.why}`).join(' ')
    : 'This browser has no 2D canvas, so these frames cannot be played here. ' +
      playbacks.map((playback) => `${playback.label}: ${playback.why}`).join(' ');

  const wrapper = document.createElement('div');
  wrapper.appendChild(row);
  wrapper.appendChild(why);
  return wrapper;
}

/**
 * Makes the canvas paintable, by pointer and by key both.
 *
 * The keys are the ones every other canvas here uses, which is the point of
 * `canvasKeyboard.ts`: arrows move a cursor, Shift moves it eight, Enter or
 * Space paints, Delete erases, P picks up the colour underneath. A tool with a
 * pointer-only gesture is 2.1.1 failed, and this project has a file whose whole
 * job is that it is never failed again.
 */
function attachBrush(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  options: SwordPictureViewOptions,
  brush: SwordBrush,
): void {
  const transparent = options.transparentZero ?? true;
  const cursor = new KeyboardCursor();
  const help = describeCanvas(canvas, {
    id: `${options.id}-brush-help`,
    label: `${options.title}, ${brush.width} by ${brush.height} pixels, paintable`,
    help:
      'Paint this frame. Arrow keys move the drawing cursor one pixel, with Shift for eight. ' +
      'Enter or Space paints the selected colour, Delete erases to transparent, and P picks up ' +
      'the colour under the cursor. Home, End, Page Up and Page Down go to the edges. The ' +
      'colours below are the ones this frame can hold.',
  });
  // `brush.help` is a wrapper the panel has already placed; `describeCanvas`
  // points the canvas's aria-describedby at what goes inside it.
  brush.help.appendChild(help);

  const rgba = (index: number): readonly [number, number, number, number] => {
    if (index === 0 && transparent) return [0, 0, 0, 0];
    const entry = options.palette[index] ?? [0, 0, 0];
    return [entry[0] ?? 0, entry[1] ?? 0, entry[2] ?? 0, 255];
  };

  const paintOne = (x: number, y: number, colour: number): boolean => {
    if (!paintSwordPixel(brush.pixels, brush.width, brush.height, x, y, colour)) return false;
    // Drawn one pixel at a time rather than by rebuilding the frame: a stroke
    // across a background is thousands of pixels and the rest of the picture
    // has not moved.
    const [r, g, b, a] = rgba(colour);
    const spot = context.createImageData(1, 1);
    spot.data.set([r, g, b, a]);
    context.putImageData(spot, x, y);
    return true;
  };

  const redraw = (): void => {
    const frame = context.createImageData(brush.width, brush.height);
    for (let at = 0; at < brush.width * brush.height; at++) {
      const [r, g, b, a] = rgba(brush.pixels[at] ?? 0);
      frame.data.set([r, g, b, a], at * 4);
    }
    context.putImageData(frame, 0, 0);
    if (cursor.visible) drawCursor(context, cursor.x, cursor.y, 1, 1);
  };
  brush.redraw = redraw;

  const pointerPixel = (event: PointerEvent): { x: number; y: number } => {
    const box = canvas.getBoundingClientRect();
    // The canvas is drawn at its true size and may still be scaled by CSS on a
    // narrow window, so the ratio is measured rather than assumed.
    const scaleX = box.width === 0 ? 1 : canvas.width / box.width;
    const scaleY = box.height === 0 ? 1 : canvas.height / box.height;
    return {
      x: Math.floor((event.clientX - box.left) * scaleX),
      y: Math.floor((event.clientY - box.top) * scaleY),
    };
  };

  let painting = false;
  let touched = false;
  canvas.addEventListener('pointerdown', (event) => {
    const { x, y } = pointerPixel(event);
    // Alt picks up instead of putting down, which is the gesture every pixel
    // editor has and the one SCUMM's canvases already answer to.
    if (event.altKey) {
      brush.colour = brush.pixels[y * brush.width + x] ?? 0;
      brush.showColour?.(brush.colour);
      options.onColour?.(brush.colour);
      brush.say(`Picked up colour ${brush.colour}.`);
      return;
    }
    event.preventDefault();
    painting = true;
    // The right button erases, which is that same convention.
    const colour = event.button === 2 ? 0 : brush.colour;
    touched = paintOne(x, y, colour);
    cursor.x = x;
    cursor.y = y;
    cursor.clamp({ width: brush.width, height: brush.height });
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!painting) return;
    const { x, y } = pointerPixel(event);
    if (paintOne(x, y, event.buttons === 2 ? 0 : brush.colour)) touched = true;
  });

  const stop = (): void => {
    if (!painting) return;
    painting = false;
    if (!touched) return;
    touched = false;
    brush.commit();
    brush.say(`Painted ${options.title}.`);
    announce('Painted.');
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('pointerleave', stop);
  // Without this the right-button eraser opens the browser's menu instead.
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  canvas.addEventListener('focus', () => {
    cursor.visible = true;
    redraw();
  });
  canvas.addEventListener('blur', () => {
    cursor.visible = false;
    redraw();
  });

  canvas.addEventListener('keydown', (event) => {
    const bounds = { width: brush.width, height: brush.height };
    if (cursor.handle(event, bounds)) {
      event.preventDefault();
      redraw();
      brush.say(
        describeSwordPixel(
          brush.pixels,
          brush.width,
          brush.height,
          cursor.x,
          cursor.y,
          transparent,
        ),
      );
      return;
    }

    if (isActivation(event) || isErase(event)) {
      event.preventDefault();
      const colour = isErase(event) ? 0 : brush.colour;
      if (colour === 0 && !transparent) {
        brush.say('This frame has no transparent colour to erase to: its palette has no index 0.');
        return;
      }
      // One write per press, which is also one undo step per press.
      if (paintOne(cursor.x, cursor.y, colour)) brush.commit();
      redraw();
      brush.say(
        isErase(event)
          ? `Erased ${cursor.x}, ${cursor.y}.`
          : `Painted colour ${colour} at ${cursor.x}, ${cursor.y}.`,
      );
      return;
    }

    if (event.key === 'p' || event.key === 'P') {
      event.preventDefault();
      brush.colour = brush.pixels[cursor.y * brush.width + cursor.x] ?? 0;
      brush.showColour?.(brush.colour);
      options.onColour?.(brush.colour);
      brush.say(`Picked up colour ${brush.colour}.`);
    }
  });
}

function buttons(options: SwordPictureViewOptions, status: HTMLElement): HTMLElement {
  const row = document.createElement('div');
  row.className = 'sword-picture-buttons';

  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Export PNG';
  save.disabled = options.image === null;
  save.id = `${options.id}-export`;
  save.addEventListener('click', () => {
    void doExport(options, status);
  });

  const load = document.createElement('button');
  load.type = 'button';
  load.textContent = 'Import PNG';
  load.disabled = options.refusal !== null || options.pixels === null;
  load.id = `${options.id}-import`;
  if (options.refusal) {
    // The sentence is in the panel already; pointing at it is what turns a dead
    // button into an explained one for somebody who cannot see the layout.
    load.setAttribute('aria-describedby', `${options.id}-refusal`);
  }
  load.addEventListener('click', () => {
    void doImport(options, status);
  });

  row.append(save, load);
  return row;
}

async function doExport(options: SwordPictureViewOptions, status: HTMLElement): Promise<void> {
  if (!options.image) return;
  try {
    await writePng(options.image, options.filename);
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: 'Could not save that picture',
    });
    return;
  }
  status.textContent = `Saved ${options.filename}.`;
  announce(`Saved ${options.filename}.`);
}

async function doImport(options: SwordPictureViewOptions, status: HTMLElement): Promise<void> {
  if (!options.pixels) return;
  const { width, height } = options.pixels;
  const file = await pickImageFile();
  if (!file) return;
  try {
    // `stretch`, not `contain`: a frame's size is written in its own header and
    // read by the renderer and by the placement both, so the import fits the
    // artwork to the frame rather than padding it and moving the picture.
    const source = await decodeImageFile(file, { width, height, fit: 'stretch' });
    const pixels = swordImportPixels(source, options.palette, {
      transparentZero: options.transparentZero ?? true,
      allowed: options.allowed,
    });
    options.onReplace(pixels, width, height);
    status.textContent = `Imported ${file.name} at ${width} by ${height}.`;
    announce(`Imported ${file.name}.`);
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: 'Could not import that picture',
    });
  }
}
