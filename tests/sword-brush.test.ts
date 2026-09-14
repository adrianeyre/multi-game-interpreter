/**
 * @vitest-environment jsdom
 *
 * The brush on both Broken Sword picture surfaces.
 *
 * `docs/editor-parity.md` had this as a missing *tool* rather than a missing
 * format: both encoders already round-trip every frame of both demos, and the
 * only way to change one was to replace the whole thing with a PNG. SCUMM's
 * surface has had `SpriteCanvas` and `ObjectArtCanvas` for as long as it has
 * had art.
 *
 * Two halves are checked here. The decisions — which colours a frame offers,
 * what one pixel down does, what a cursor is standing on — are pure functions,
 * because jsdom has no 2D context and anything reachable only through a canvas
 * class is unreachable from a test. The wiring is checked through the panels
 * themselves with a recording context stubbed in, because "the keystroke
 * reached the encoder" is the part that breaks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeSwordPixel,
  paintSwordPixel,
  swordBrushSwatches,
} from '../src/editor/swordPictureView.js';
import { Sword1Editor } from '../src/editor/sword1/Sword1Editor.js';
import { Sword2Editor } from '../src/editor/sword2/Sword2Editor.js';
import { SWORD1_SURFACES } from '../src/authoring/sword1/project.js';
import { SWORD2_SURFACES } from '../src/authoring/sword2/project.js';
import type { Project } from '../src/authoring/project.js';
import { toBase64 } from '../src/authoring/base64.js';
import { sword1PicturePixels } from '../src/editor/sword1/pictureFiles.js';
import { sword2PicturePixels, sword2ScreenLayerPixels } from '../src/editor/sword2/pictureFiles.js';
import { buildSpriteResource, buildSword2Anim, buildSword2Screen } from './fixtureSword.js';

/** A palette whose entries are distinguishable by eye and by assertion. */
const PALETTE = [
  [0, 0, 0],
  [10, 20, 30],
  [40, 50, 60],
  [70, 80, 90],
];

describe('the colours a Broken Sword frame offers a brush', () => {
  it('offers the whole palette by default, with colour 0 named as the eraser', () => {
    const swatches = swordBrushSwatches(PALETTE);
    expect(swatches.length).toBe(256);
    expect(swatches[0].label).toMatch(/transparent, the eraser/);
    expect(swatches[2].rgb).toEqual([40, 50, 60]);
    expect(swatches[2].label).toBe('colour 2 — red 40, green 50, blue 60');
  });

  it('offers an RLE16 frame only the sixteen its own resource carries', () => {
    // A colour outside the frame's table cannot be written at all, so putting
    // it on the strip would be offering a brush that paints nothing.
    const swatches = swordBrushSwatches(PALETTE, { allowed: [0, 2, 3] });
    expect(swatches.map((swatch) => swatch.index)).toEqual([0, 2, 3]);
  });

  it('offers no eraser where colour 0 is a colour rather than a hole', () => {
    // A Sword II background covers the screen and has no transparent pixel.
    const swatches = swordBrushSwatches(PALETTE, { allowed: [0, 1], transparentZero: false });
    expect(swatches.map((swatch) => swatch.index)).toEqual([1]);
  });
});

describe('putting one pixel down', () => {
  it('writes the pixel and says that something changed', () => {
    const pixels = Uint8Array.from([1, 2, 3, 4]);
    expect(paintSwordPixel(pixels, 2, 2, 1, 1, 9)).toBe(true);
    expect([...pixels]).toEqual([1, 2, 3, 9]);
  });

  it('says nothing changed when the pixel is already that colour', () => {
    // This false is what keeps a drag across unchanged pixels from re-encoding
    // a frame that is already what it should be.
    const pixels = Uint8Array.from([1, 2, 3, 4]);
    expect(paintSwordPixel(pixels, 2, 2, 0, 0, 1)).toBe(false);
    expect([...pixels]).toEqual([1, 2, 3, 4]);
  });

  it('refuses a pixel outside the frame rather than wrapping to the next row', () => {
    const pixels = Uint8Array.from([1, 2, 3, 4]);
    expect(paintSwordPixel(pixels, 2, 2, 2, 0, 9)).toBe(false);
    expect(paintSwordPixel(pixels, 2, 2, -1, 0, 9)).toBe(false);
    expect(paintSwordPixel(pixels, 2, 2, 0, 2, 9)).toBe(false);
    expect([...pixels]).toEqual([1, 2, 3, 4]);
  });
});

describe('what the drawing cursor is standing on', () => {
  it('names the colour and the place', () => {
    const pixels = Uint8Array.from([1, 2, 3, 4]);
    expect(describeSwordPixel(pixels, 2, 2, 1, 0)).toBe('1, 0 — colour 2');
  });

  it('says transparent rather than colour 0 where 0 is a hole', () => {
    const pixels = Uint8Array.from([0, 2]);
    expect(describeSwordPixel(pixels, 2, 1, 0, 0)).toMatch(/transparent/);
    expect(describeSwordPixel(pixels, 2, 1, 0, 0, false)).toBe('0, 0 — colour 0');
  });

  it('says so outside the frame instead of naming a colour that is not there', () => {
    expect(describeSwordPixel(Uint8Array.from([1]), 1, 1, 5, 0)).toMatch(/outside/);
  });
});

/**
 * A canvas that records instead of drawing.
 *
 * The same stub `tests/agos-image-files.test.ts` uses, for the same reason:
 * jsdom has no 2D context, and without one the panel correctly decides there
 * is nothing to paint on. What is asserted through it is ours — which pixels
 * the brush wrote and what it then handed the encoder.
 */
function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      save: () => {},
      restore: () => {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
    } as unknown as CanvasRenderingContext2D;
  } as never);
}

function baseProject(): Project {
  return {
    version: 6,
    target: { engine: 'sword1', release: 'cd', platform: 'dos' },
    name: 'test',
    start: { room: 1, x: 0, y: 0 },
    defaultResponse: '',
    screen: { textHeight: 40, verbTop: 0 },
    verbs: [],
    actors: [],
    rooms: [],
    scripts: [],
    audio: [],
  };
}

/** Sword 1, holding one two-frame sprite and one mask that cannot be written. */
function sword1Project(): Project {
  const sprite = buildSpriteResource([
    { width: 2, height: 2, pixels: Uint8Array.from([1, 2, 3, 1]) },
    { width: 3, height: 1, pixels: Uint8Array.from([2, 0, 2]) },
  ]);
  return {
    ...baseProject(),
    sword1: {
      identification: { release: 'cd', how: 'shipped-files', evidence: 'paris2.clu' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD1_SURFACES,
      sections: [],
      scripts: [],
      text: [],
      palettes: [
        { resource: 0x06010000, bytesBase64: toBase64(new Uint8Array(768)), screens: [1] },
      ],
      pictures: [
        {
          resource: 0x01010001,
          kind: 'sprite',
          width: 3,
          height: 2,
          frames: 2,
          bytesBase64: toBase64(sprite),
          screens: [1],
        },
        {
          resource: 0x01010002,
          kind: 'mask',
          width: 16,
          height: 8,
          frames: 1,
          bytesBase64: toBase64(new Uint8Array(128)),
          screens: [1],
        },
      ],
      rooms: [
        {
          screen: 1,
          width: 784,
          height: 400,
          totalLayers: 3,
          gridWidth: 65,
          layers: [1, 2, 3, 0],
          grids: [4, 5, 0],
          palettes: [6, 7],
          parallax: [8, 0],
        },
      ],
      effects: [],
      clusters: { present: [], absent: [], labels: {} },
      walkGrids: [],
    },
  };
}

/** Sword II, holding one animation and one screen with a background layer. */
function sword2Project(): Project {
  const animation = buildSword2Anim('walk', [
    { x: 1, y: 2, width: 2, height: 2, colour: 7 },
    { x: 3, y: 4, width: 2, height: 1, colour: 8 },
  ]);
  const screen = buildSword2Screen('lobby', 8, 4, 3, undefined, {
    x: 0,
    y: 0,
    width: 4,
    height: 2,
    colour: 5,
  });
  return {
    ...baseProject(),
    target: { engine: 'sword2', release: 'cd', platform: 'dos' },
    sword2: {
      identification: { release: 'cd', how: 'shipped-files', evidence: 'speech2.clu' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD2_SURFACES,
      objects: [],
      globals: { count: 0, bytesBase64: '' },
      text: [],
      screens: [
        {
          resource: 20,
          width: 8,
          height: 4,
          layers: 1,
          hasPalette: true,
          parallax: [false, false, false, false],
          bytesBase64: toBase64(screen),
        },
      ],
      palettes: [{ screen: 20, bytesBase64: toBase64(new Uint8Array(1024)) }],
      animations: [
        { resource: 30, name: 'walk', frames: 2, compression: 0, bytesBase64: toBase64(animation) },
      ],
      runLists: [],
      clusters: { present: [], absent: [] },
      walkGrids: [],
    },
  };
}

function openSection(root: HTMLElement, title: string): void {
  const head = [...root.querySelectorAll<HTMLButtonElement>('.accordion-head')].find(
    (button) => button.querySelector('.accordion-title')?.textContent === title,
  );
  if (head?.getAttribute('aria-expanded') === 'false') head.click();
}

function clickRow(root: HTMLElement, text: string): void {
  [...root.querySelectorAll('button')]
    .find((button) => button.textContent?.includes(text))
    ?.click();
}

/**
 * The paintable canvas — the one inside the picture panel.
 *
 * Selected by its panel and not by `role="application"` alone, because a
 * Sword II screen draws its scene canvas above this one and that is an
 * application too.
 */
function brushCanvas(root: HTMLElement): HTMLCanvasElement {
  const canvas = root.querySelector<HTMLCanvasElement>(
    '.sword-picture-canvas canvas[role="application"]',
  );
  expect(canvas).not.toBeNull();
  return canvas!;
}

/** The brush's colours, scoped to the picture panel: a screen's own palette
 * editor draws swatches of its own further down the page. */
function swatches(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.sword-picture .sword-swatch')];
}

function press(canvas: HTMLCanvasElement, key: string, shiftKey = false): void {
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
}

/** A pointer event jsdom will build, with the geometry the brush reads. */
function pointer(canvas: HTMLCanvasElement, type: string, init: Record<string, unknown>): void {
  const event = new Event(type, { bubbles: true }) as Event & Record<string, unknown>;
  Object.assign(event, { clientX: 0, clientY: 0, button: 0, buttons: 1, altKey: false }, init);
  canvas.dispatchEvent(event);
}

describe('painting a Broken Sword 1 sprite frame', () => {
  afterEach(() => vi.restoreAllMocks());

  function opened(): { project: Project; editor: Sword1Editor; writes: () => number } {
    stubCanvas();
    const project = sword1Project();
    let writes = 0;
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => {
        writes++;
        mutate(project);
      },
    });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Pictures');
    clickRow(editor.element, 'sprite 0x1010001');
    return { project, editor, writes: () => writes };
  }

  it('is an operable, described canvas rather than a picture', () => {
    const { editor } = opened();
    const canvas = brushCanvas(editor.element);
    expect(canvas.tabIndex).toBe(0);
    const help = editor.element.querySelector(`#${canvas.getAttribute('aria-describedby')}`);
    expect(help?.textContent).toMatch(/Arrow keys move the drawing cursor/);
    expect(help?.textContent).toMatch(/Enter or Space paints/);
  });

  it('offers the frame’s own colours as a radio group', () => {
    const { editor } = opened();
    const strip = editor.element.querySelector('.sword-picture .sword-palette');
    expect(strip?.getAttribute('role')).toBe('radiogroup');
    expect(strip).toBeTruthy();
    expect(strip!.querySelectorAll('[role="radio"]').length).toBe(256);
  });

  it('paints the chosen colour where the keyboard cursor is, through the encoder', () => {
    const { project, editor } = opened();
    const canvas = brushCanvas(editor.element);
    swatches(editor.element)[3].click();
    press(canvas, 'ArrowRight');
    press(canvas, 'Enter');

    const frame = sword1PicturePixels(project.sword1!.pictures[0], 0)!;
    expect([...frame.pixels]).toEqual([1, 3, 3, 1]);
  });

  it('erases to transparent on Delete, because this family’s hole is colour 0', () => {
    const { project, editor } = opened();
    press(brushCanvas(editor.element), 'Delete');
    expect([...sword1PicturePixels(project.sword1!.pictures[0], 0)!.pixels]).toEqual([0, 2, 3, 1]);
  });

  it('picks the colour under the cursor up on P, and moves the strip’s choice with it', () => {
    const { editor } = opened();
    const canvas = brushCanvas(editor.element);
    press(canvas, 'ArrowDown');
    press(canvas, 'p');
    expect(swatches(editor.element)[3].getAttribute('aria-checked')).toBe('true');
    expect(swatches(editor.element)[1].getAttribute('aria-checked')).toBe('false');
    // And it paints that colour, rather than reporting one and painting another.
    press(canvas, 'ArrowRight');
    press(canvas, 'Enter');
    expect(editor.element.textContent).toMatch(/Painted colour 3 at 1, 1/);
  });

  it('keeps the focus it was painting with, which a re-render would take', () => {
    // The whole reason `onPaint` is not `onReplace`: a surface that re-renders
    // after a keystroke rebuilds this canvas, and the second arrow key goes to
    // the document instead.
    const { editor } = opened();
    const canvas = brushCanvas(editor.element);
    canvas.focus();
    press(canvas, 'Enter');
    expect(document.activeElement).toBe(canvas);
    expect(brushCanvas(editor.element)).toBe(canvas);
  });

  it('writes the frame back once for a drag, not once a pixel', () => {
    const { project, editor, writes } = opened();
    const canvas = brushCanvas(editor.element);
    swatches(editor.element)[3].click();
    const before = writes();
    pointer(canvas, 'pointerdown', { clientX: 0, clientY: 0 });
    pointer(canvas, 'pointermove', { clientX: 1, clientY: 0 });
    pointer(canvas, 'pointermove', { clientX: 1, clientY: 1 });
    pointer(canvas, 'pointerup', { clientX: 1, clientY: 1 });
    expect(writes() - before).toBe(1);
    expect([...sword1PicturePixels(project.sword1!.pictures[0], 0)!.pixels]).toEqual([3, 3, 3, 3]);
  });

  it('picks a colour up with Alt held instead of putting one down', () => {
    const { project, editor } = opened();
    const canvas = brushCanvas(editor.element);
    pointer(canvas, 'pointerdown', { clientX: 1, clientY: 0, altKey: true });
    expect(swatches(editor.element)[2].getAttribute('aria-checked')).toBe('true');
    expect([...sword1PicturePixels(project.sword1!.pictures[0], 0)!.pixels]).toEqual([1, 2, 3, 1]);
  });

  it('leaves a frame unchanged when a stroke painted nothing new', () => {
    const { project, writes, editor } = opened();
    const before = project.sword1!.pictures[0].bytesBase64;
    const canvas = brushCanvas(editor.element);
    swatches(editor.element)[1].click();
    const writesBefore = writes();
    pointer(canvas, 'pointerdown', { clientX: 0, clientY: 0 });
    pointer(canvas, 'pointerup', { clientX: 0, clientY: 0 });
    expect(writes()).toBe(writesBefore);
    expect(project.sword1!.pictures[0].bytesBase64).toBe(before);
  });

  it('gives no brush to a frame this project cannot write', () => {
    stubCanvas();
    const project = sword1Project();
    const editor = new Sword1Editor({ project: () => project, update: (m) => m(project) });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Pictures');
    clickRow(editor.element, 'mask 0x1010002');
    expect(
      editor.element.querySelector('.sword-picture-canvas canvas[role="application"]'),
    ).toBeNull();
    expect(editor.element.querySelector('.sword-picture .sword-swatch')).toBeNull();
  });
});

describe('painting Broken Sword II', () => {
  afterEach(() => vi.restoreAllMocks());

  it('paints an animation frame and writes it back through the animation encoder', () => {
    stubCanvas();
    const project = sword2Project();
    const editor = new Sword2Editor({ project: () => project, update: (m) => m(project) });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Animations');
    clickRow(editor.element, 'walk');

    const canvas = brushCanvas(editor.element);
    swatches(editor.element)[2].click();
    press(canvas, 'Enter');
    const frame = sword2PicturePixels(project.sword2!.animations[0], 0)!;
    expect(frame.pixels[0]).toBe(2);
    expect(frame.pixels[1]).toBe(7);
  });

  it('paints a screen layer, which is where a background is actually stored', () => {
    stubCanvas();
    const project = sword2Project();
    const editor = new Sword2Editor({ project: () => project, update: (m) => m(project) });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Screens');
    clickRow(editor.element, '20');

    const canvas = brushCanvas(editor.element);
    swatches(editor.element)[2].click();
    press(canvas, 'ArrowRight');
    press(canvas, 'Enter');
    const layer = sword2ScreenLayerPixels(project.sword2!, 20, 2)!;
    expect(layer.pixels[1]).toBe(2);
  });

  it('carries the chosen colour from one frame to the next', () => {
    // The colour lives on the surface rather than in the panel, because
    // changing frame rebuilds the panel and an author picking a colour per
    // frame is a tool nobody would use twice.
    stubCanvas();
    const project = sword2Project();
    const editor = new Sword2Editor({ project: () => project, update: (m) => m(project) });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Animations');
    clickRow(editor.element, 'walk');
    swatches(editor.element)[2].click();

    const frames = [...editor.element.querySelectorAll<HTMLButtonElement>('.sword-frame')];
    frames[1].click();
    press(brushCanvas(editor.element), 'Enter');
    expect(sword2PicturePixels(project.sword2!.animations[0], 1)!.pixels[0]).toBe(2);
  });
});
