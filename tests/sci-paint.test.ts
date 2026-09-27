/**
 * @vitest-environment jsdom
 *
 * Painting SCI artwork pixel by pixel (`docs/editor-parity.md` rows 10 and 19).
 *
 * Two halves, as `tests/sword-brush.test.ts` has them. The writer — a cel
 * Picture's item patched in place, refused by name when the re-encoded body
 * does not fit — is checked directly against the record as `SciCelPicture.ts`
 * and ScummVM's `celobj32.cpp` read it. The wiring — a key on the canvas
 * reaching that writer, a refusal taking the stroke back, a pre-V56 View
 * rebuilt, the zoom — is checked through `SciEditor` with a recording 2D
 * context stubbed in, because jsdom has none.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { patchSciCelPicturePixels } from '../src/authoring/sci/sciViewCel.js';
import { fromBase64, toBase64 } from '../src/authoring/base64.js';
import { createProject, type Project, type SciProject } from '../src/authoring/project.js';
import { readSciCelPicture } from '../src/engine/sci/gfx/SciCelPicture.js';
import { readSciView, writeSciView } from '../src/engine/sci/gfx/SciView.js';
import { SciEditor } from '../src/editor/sci/SciEditor.js';
import { swordDefaultZoom } from '../src/editor/swordPictureView.js';
import { sciCelPictureColours, sciViewColours } from '../src/editor/sci/sciImages.js';
import { announce } from '../src/ui/a11y.js';
import { decodeImageFile, pickImageFile } from '../src/editor/importImage.js';

// Row 17's import: the picker and the decoder need a browser, so they are
// stood in for; the quantiser and the in-place patch are the real ones.
vi.mock('../src/editor/importImage.js', async (actual) => ({
  ...(await actual<typeof import('../src/editor/importImage.js')>()),
  pickImageFile: vi.fn(),
  decodeImageFile: vi.fn(),
}));
vi.mock('../src/ui/a11y.js', async (actual) => ({
  ...(await actual<typeof import('../src/ui/a11y.js')>()),
  announce: vi.fn(),
}));

function put16(bytes: number[], at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
}

function put32(bytes: number[], at: number, value: number): void {
  put16(bytes, at, value & 0xffff);
  put16(bytes, at + 2, value >>> 16);
}

const WIDTH = 8;
const HEIGHT = 4;
const CLEAR = 255;

/**
 * A SCI2 cel Picture: the 14-byte header, one 42-byte cel header, then the
 * body. `uncompressed` stores the pixels as they are (method 0, no literal
 * stream) — every SCI2 full-screen background is one of those. Otherwise each
 * row is one repeat run of `colour`, the control stream and literal stream
 * separate, which is as small as a V56 body gets.
 */
function sci32CelPicture({ uncompressed = false, colour = 7 } = {}): Uint8Array {
  const bytes: number[] = new Array(14 + 42).fill(0);
  put16(bytes, 0, 0x0e);
  bytes[2] = 1;
  put16(bytes, 4, 42);
  put16(bytes, 10, 320);
  put16(bytes, 12, 200);
  const at = 14;
  put16(bytes, at, WIDTH);
  put16(bytes, at + 2, HEIGHT);
  bytes[at + 8] = CLEAR;
  bytes[at + 9] = uncompressed ? 0 : 0x8a;
  put16(bytes, at + 36, 5); // priority
  put16(bytes, at + 38, 30); // x
  put16(bytes, at + 40, 40); // y
  if (uncompressed) {
    put32(bytes, at + 24, bytes.length);
    bytes.push(...new Array(WIDTH * HEIGHT).fill(colour));
  } else {
    put32(bytes, at + 24, bytes.length);
    for (let y = 0; y < HEIGHT; y++) bytes.push(0x80 | WIDTH);
    put32(bytes, at + 28, bytes.length);
    for (let y = 0; y < HEIGHT; y++) bytes.push(colour);
  }
  return new Uint8Array(bytes);
}

const ITEM = { headerAt: 14, width: WIDTH, height: HEIGHT };

function pixelsOf(bytes: Uint8Array): Uint8Array {
  return readSciCelPicture(bytes).cels[0].cel.pixels;
}

describe('a cel Picture item, painted and written in place', () => {
  it('writes an uncompressed SCI2 background, and leaves its position alone', () => {
    const original = sci32CelPicture({ uncompressed: true });
    const painted = Uint8Array.from(pixelsOf(original));
    painted[3] = 12;
    painted[WIDTH * HEIGHT - 1] = CLEAR;
    const patched = patchSciCelPicturePixels(original, 'sci32', ITEM, [14], painted, 'item 0');
    if (typeof patched === 'string') throw new Error(patched);
    expect([...pixelsOf(patched)]).toEqual([...painted]);
    const placed = readSciCelPicture(patched).cels[0];
    expect([placed.priority, placed.x, placed.y]).toEqual([5, 30, 40]);
  });

  it('writes a run-length item whose new body fits the old one', () => {
    const original = sci32CelPicture();
    // One row repainted in another single colour is still one run a row.
    const painted = Uint8Array.from(pixelsOf(original));
    painted.fill(9, WIDTH, WIDTH * 2);
    const patched = patchSciCelPicturePixels(original, 'sci32', ITEM, [14], painted, 'item 0');
    if (typeof patched === 'string') throw new Error(patched);
    expect([...pixelsOf(patched)]).toEqual([...painted]);
  });

  it('refuses by name, with both sizes, a stroke that would not fit', () => {
    const original = sci32CelPicture();
    const painted = Uint8Array.from(pixelsOf(original));
    painted[2] = 1;
    const refused = patchSciCelPicturePixels(original, 'sci32', ITEM, [14], painted, 'item 0');
    expect(refused).toMatch(/^item 0 re-encodes to \d+ control and \d+ literal bytes/);
    expect(refused).toMatch(/original occupied 4 and 4/);
  });

  it('reads SCI1.1’s container, which has no compression byte, and patches it', () => {
    // SCI1.1: a 0x26 header whose cel header sits where offset 32 says, with
    // something other than a method at the cel's offset 9.
    const bytes: number[] = new Array(38 + 42).fill(0);
    put16(bytes, 0, 0x26);
    put16(bytes, 4, 1);
    put32(bytes, 32, 38);
    put16(bytes, 38, WIDTH);
    put16(bytes, 40, HEIGHT);
    bytes[38 + 8] = CLEAR;
    bytes[38 + 9] = 0x0a;
    put32(bytes, 38 + 24, bytes.length);
    for (let y = 0; y < HEIGHT; y++) bytes.push(0x80 | WIDTH);
    put32(bytes, 38 + 28, bytes.length);
    for (let y = 0; y < HEIGHT; y++) bytes.push(4);
    const original = new Uint8Array(bytes);

    const painted = new Uint8Array(WIDTH * HEIGHT).fill(6);
    const patched = patchSciCelPicturePixels(
      original,
      'sci11',
      { headerAt: 38, width: WIDTH, height: HEIGHT },
      [38],
      painted,
      'item 0',
    );
    if (typeof patched === 'string') throw new Error(patched);
    expect([...pixelsOf(patched)]).toEqual([...painted]);
  });
});

describe('the zoom a picture opens at', () => {
  it('makes a small cel big enough to aim at and leaves a background at its size', () => {
    expect(swordDefaultZoom(8)).toBe(16);
    expect(swordDefaultZoom(40)).toBe(16);
    expect(swordDefaultZoom(100)).toBe(6);
    expect(swordDefaultZoom(640)).toBe(1);
  });
});

// ------------------------------------------------------------ the wiring --

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
      drawImage: () => {},
      clearRect: () => {},
      save: () => {},
      restore: () => {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
      set imageSmoothingEnabled(_value: boolean) {},
    } as unknown as CanvasRenderingContext2D;
  } as never);
}

/** A two-cel EGA View, which `writeSciView` rebuilds from its pixels. */
function egaView(): string {
  const cel = (colour: number) => ({
    width: 3,
    height: 2,
    displaceX: 0,
    displaceY: 0,
    clearKey: 0,
    pixels: new Uint8Array(6).fill(colour),
  });
  return toBase64(
    writeSciView({
      loops: [{ cels: [cel(3), cel(5)], mirrored: false, mirrorOf: 0 }],
      paletteOffset: 0,
      vga: false,
      encoding: 'ega',
      resolution: null,
    }),
  );
}

function project(picture: Uint8Array): Project {
  const made = createProject('paint');
  made.target = { engine: 'sci', version: 'sci1-1' } as Project['target'];
  const composition = readSciCelPicture(picture);
  made.sci = {
    identification: { how: 'probe', evidence: ['RESOURCE.MAP is a sci11 map'] },
    selectors: ['-objID-'],
    classes: [],
    scripts: [],
    resources: [{ type: 'view', number: 0, bytes: egaView() }],
    messages: [],
    vectorPictures: [],
    celPictures: [
      {
        type: 'pic',
        number: 100,
        bytes: toBase64(picture),
        container: 'sci32',
        resolution: composition.resolution,
        hasVectors: false,
        items: composition.cels.map((placed) => ({
          headerAt: 14,
          width: placed.cel.width,
          height: placed.cel.height,
          x: placed.x,
          y: placed.y,
          priority: placed.priority,
        })),
      },
    ],
    languages: [],
    unrecoveredCount: 0,
  } as unknown as SciProject;
  return made;
}

function mount(made: Project): { editor: SciEditor; writes: () => number } {
  let writes = 0;
  // The editor re-renders from the project after every write, which is what
  // the real mount does through `state.subscribe`.
  const editor: SciEditor = new SciEditor({
    project: () => made,
    update: (mutate) => {
      writes++;
      mutate(made);
      editor.render();
    },
  });
  document.body.appendChild(editor.element);
  for (const head of editor.element.querySelectorAll<HTMLButtonElement>('.accordion-head')) {
    if (head.getAttribute('aria-expanded') === 'false') head.click();
  }
  return { editor, writes: () => writes };
}

function openRow(editor: SciEditor, label: string): void {
  [...editor.element.querySelectorAll('button')]
    .find((button) => (button.getAttribute('aria-label') ?? '').startsWith(label))!
    .click();
}

function paintCanvas(editor: SciEditor): HTMLCanvasElement {
  const canvas = editor.element.querySelector<HTMLCanvasElement>(
    '.sci-paint canvas[role="application"]',
  );
  expect(canvas).not.toBeNull();
  return canvas!;
}

function press(canvas: HTMLCanvasElement, key: string): void {
  canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function pickColour(editor: SciEditor, index: number): void {
  [...editor.element.querySelectorAll<HTMLButtonElement>('.sci-paint .sword-swatch')]
    .find((button) => (button.getAttribute('aria-label') ?? '').startsWith(`colour ${index} `))!
    .click();
}

describe('painting on the SCI surface', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('paints a cel Picture item from the keyboard and keeps the focus', () => {
    stubCanvas();
    const made = project(sci32CelPicture({ uncompressed: true }));
    const { editor, writes } = mount(made);
    openRow(editor, 'cel picture 100');

    const canvas = paintCanvas(editor);
    expect(canvas.tabIndex).toBe(0);
    canvas.focus();
    pickColour(editor, 12);
    // The pick moved the focus to the swatch; back to the canvas to paint.
    paintCanvas(editor).focus();
    press(paintCanvas(editor), 'ArrowRight');
    press(paintCanvas(editor), 'Enter');

    expect(writes()).toBe(1);
    const painted = pixelsOf(fromBase64(made.sci!.celPictures[0].bytes));
    expect(painted[1]).toBe(12);
    expect(painted[0]).toBe(7);
    // The rebuild put the focus back on the new canvas, so the next key lands.
    expect(document.activeElement).toBe(paintCanvas(editor));
    press(paintCanvas(editor), 'ArrowRight');
    press(paintCanvas(editor), 'Enter');
    expect(pixelsOf(fromBase64(made.sci!.celPictures[0].bytes))[2]).toBe(12);
  });

  it('takes a refused stroke back and says why, writing nothing', () => {
    stubCanvas();
    const made = project(sci32CelPicture());
    const before = made.sci!.celPictures[0].bytes;
    const { editor, writes } = mount(made);
    openRow(editor, 'cel picture 100');

    pickColour(editor, 12);
    const canvas = paintCanvas(editor);
    canvas.focus();
    press(canvas, 'ArrowRight');
    press(canvas, 'ArrowRight');
    press(canvas, 'Enter');

    expect(writes()).toBe(0);
    expect(made.sci!.celPictures[0].bytes).toBe(before);
    const status = editor.element.querySelector('.sci-paint [role="status"]');
    expect(status?.textContent).toMatch(/re-encodes to .* and the original occupied/);
  });

  it('erases to the cel’s own clear key rather than to index 0', () => {
    stubCanvas();
    const made = project(sci32CelPicture({ uncompressed: true }));
    const { editor } = mount(made);
    openRow(editor, 'cel picture 100');
    const canvas = paintCanvas(editor);
    canvas.focus();
    press(canvas, 'Delete');
    expect(pixelsOf(fromBase64(made.sci!.celPictures[0].bytes))[0]).toBe(CLEAR);
  });

  it('paints a pre-V56 View cel, rebuilt by writeSciView', () => {
    stubCanvas();
    const made = project(sci32CelPicture({ uncompressed: true }));
    const { editor, writes } = mount(made);
    openRow(editor, 'view 0');
    pickColour(editor, 9);
    const canvas = paintCanvas(editor);
    canvas.focus();
    press(canvas, 'Enter');
    expect(writes()).toBe(1);
    const view = readSciView(fromBase64(made.sci!.resources[0].bytes));
    expect(view.loops[0].cels[0].pixels[0]).toBe(9);
    expect(view.loops[0].cels[1].pixels[0]).toBe(5);
    // An EGA View offers its sixteen colours, not 256.
    expect(editor.element.querySelectorAll('.sci-paint .sword-swatch').length).toBe(16);
  });

  it('zooms by button and by key, scaling the canvas rather than redrawing it', () => {
    stubCanvas();
    const made = project(sci32CelPicture({ uncompressed: true }));
    const { editor } = mount(made);
    openRow(editor, 'cel picture 100');
    const canvas = paintCanvas(editor);
    expect(canvas.width).toBe(WIDTH);
    expect(canvas.style.width).toBe(`${WIDTH * 16}px`);
    const zoomOut = [
      ...editor.element.querySelectorAll<HTMLButtonElement>('.sci-paint button'),
    ].find((button) => button.textContent === 'Zoom out')!;
    zoomOut.click();
    expect(canvas.style.width).toBe(`${WIDTH * 12}px`);
    canvas.focus();
    press(canvas, '+');
    expect(canvas.style.width).toBe(`${WIDTH * 16}px`);
  });

  it('says a vector Picture is edited as its list and not painted', () => {
    const made = project(sci32CelPicture({ uncompressed: true }));
    made.sci!.vectorPictures = [
      { type: 'pic', number: 95, bytes: toBase64(new Uint8Array([0xf0, 4, 0xff])) },
    ];
    const { editor } = mount(made);
    openRow(editor, 'vector picture 95');
    expect(editor.element.textContent).toMatch(/holds no pixels, so it is edited as that list/);
    expect(editor.element.querySelector('.sci-paint')).toBeNull();
  });
});

describe('a PNG imported over a cel Picture item', () => {
  afterEach(() => {
    vi.mocked(announce).mockClear();
    document.body.replaceChildren();
  });

  /** A decoded image of one colour from the Picture's own palette, the last pixel clear. */
  function solid(
    made: Project,
    index: number,
  ): { width: number; height: number; data: Uint8ClampedArray } {
    const bytes = fromBase64(made.sci!.celPictures[0].bytes);
    const colours = sciCelPictureColours(
      bytes,
      readSciCelPicture(bytes).paletteOffset,
      sciViewColours(made.sci!),
    );
    const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let at = 0; at < WIDTH * HEIGHT; at++) {
      data.set([...colours[index], at === WIDTH * HEIGHT - 1 ? 0 : 255], at * 4);
    }
    return { width: WIDTH, height: HEIGHT, data };
  }

  function importButton(editor: SciEditor): HTMLButtonElement {
    const button = [...editor.element.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
      (one.textContent ?? '').startsWith('Import a PNG over cel Picture 100 item 0'),
    );
    expect(button).toBeDefined();
    return button!;
  }

  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('is a keyboard-reachable button that writes through the in-place patch', async () => {
    stubCanvas();
    const made = project(sci32CelPicture({ uncompressed: true }));
    const { editor, writes } = mount(made);
    openRow(editor, 'cel picture 100');
    const button = importButton(editor);
    expect(button.type).toBe('button');
    expect(button.tabIndex).toBe(0);

    vi.mocked(pickImageFile).mockResolvedValue(new File([], 'art.png'));
    vi.mocked(decodeImageFile).mockResolvedValue(solid(made, 12));
    button.click();
    await settle();

    expect(writes()).toBe(1);
    const pixels = pixelsOf(fromBase64(made.sci!.celPictures[0].bytes));
    expect(pixels[0]).toBe(12);
    // Transparency comes from the source's alpha, as the item's own clear key.
    expect(pixels[WIDTH * HEIGHT - 1]).toBe(CLEAR);
    const placed = readSciCelPicture(fromBase64(made.sci!.celPictures[0].bytes)).cels[0];
    expect([placed.priority, placed.x, placed.y]).toEqual([5, 30, 40]);
    expect(vi.mocked(announce)).toHaveBeenCalledWith(
      'cel Picture 100 item 0 replaced from art.png.',
    );
  });

  it('refuses by name, with both sizes, an import that does not fit, changing nothing', async () => {
    stubCanvas();
    const made = project(sci32CelPicture());
    const before = made.sci!.celPictures[0].bytes;
    const { editor, writes } = mount(made);
    openRow(editor, 'cel picture 100');

    // Every other pixel a different colour: no longer one run a row.
    const image = solid(made, 12);
    const other = solid(made, 1);
    for (let at = 0; at < WIDTH * HEIGHT; at += 2) {
      image.data.set(other.data.subarray(at * 4, at * 4 + 4), at * 4);
    }
    vi.mocked(pickImageFile).mockResolvedValue(new File([], 'busy.png'));
    vi.mocked(decodeImageFile).mockResolvedValue(image);
    importButton(editor).click();
    await settle();

    expect(writes()).toBe(0);
    expect(made.sci!.celPictures[0].bytes).toBe(before);
    const said = vi
      .mocked(announce)
      .mock.calls.map((call) => call[0])
      .join('\n');
    expect(said).toMatch(
      /cel Picture 100 item 0 could not be replaced: cel Picture 100 item 0 re-encodes to \d+ control and \d+ literal bytes, and the original occupied 4 and 4/,
    );
  });
});
