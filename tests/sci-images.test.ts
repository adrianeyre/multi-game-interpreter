/**
 * SCI artwork rendered to pixels, for export.
 *
 * Tier 1 over structures built here, and deliberately no DOM: the encode and
 * the download are `writePng`, which every other family already uses and which
 * a jsdom canvas cannot exercise anyway. What is worth testing is the part
 * that can be wrong quietly — which palette a kind of resource is read through,
 * and what "transparent" means for each of them, since a wrong answer to either
 * produces a picture rather than an error.
 */

import { describe, expect, it } from 'vitest';

import {
  renderSciCel,
  renderSciCelPicture,
  renderSciCursorImage,
  renderSciFontSheet,
  renderSciVectorPicture,
  sciImageFilename,
  sciViewColours,
} from '../src/editor/sci/sciImages.js';
import { SCI_EGA_PALETTE } from '../src/engine/sci/gfx/sciPalette.js';
import { CURSOR_TRANSPARENT } from '../src/engine/sci/gfx/SciCursor.js';
import { drawSciPicture } from '../src/engine/sci/gfx/SciPicture.js';
import { toBase64 } from '../src/authoring/base64.js';
import type { SciCel } from '../src/engine/sci/gfx/SciView.js';
import type { SciProject, SciProjectCelPicture } from '../src/authoring/project.js';

function emptyProject(resources: SciProject['resources']): SciProject {
  return {
    identification: { how: 'probe', evidence: [] },
    selectors: [],
    classes: [],
    scripts: [],
    resources,
    messages: [],
    vectorPictures: [],
    celPictures: [],
    languages: [],
    unrecoveredCount: 0,
  };
}

/** A `palette` resource in SCI1's form: one entry, at the index asked for. */
function paletteResource(index: number, rgb: [number, number, number]): Uint8Array {
  const bytes = new Uint8Array(37 + 4);
  bytes[25] = index;
  bytes[29] = 1; // one colour
  bytes[32] = 0; // zero: the SCI1.1 form, each entry preceded by a "used" byte
  bytes.set([1, ...rgb], 37);
  return bytes;
}

function cel(overrides: Partial<SciCel> & Pick<SciCel, 'width' | 'height' | 'pixels'>): SciCel {
  return { displaceX: 0, displaceY: 0, clearKey: 0xff, ...overrides };
}

describe('the palette a View is exported through', () => {
  /**
   * A View carries no colours, so this is a choice — and the whole point of
   * the two branches is that they read the same byte differently. A cel's
   * pixel is one four-bit colour; a Picture's visual byte is a dithered pair.
   * Colouring a cel through the pair table halves every colour's brightness,
   * which looks deliberate and is not.
   */
  it('is the hardware sixteen, undithered, when the game ships no palette', () => {
    const chosen = sciViewColours(emptyProject([]));
    expect(chosen.how).toContain('sixteen');
    expect(chosen.colours[12]).toEqual(SCI_EGA_PALETTE[12]);
    // Index 0x1c is colour 12 again, because a cel's pixel is four bits.
    expect(chosen.colours[0x1c]).toEqual(SCI_EGA_PALETTE[12]);
  });

  it('is palette 999 when the game has one, and says so', () => {
    const chosen = sciViewColours(
      emptyProject([
        { type: 'palette', number: 50, bytes: toBase64(paletteResource(7, [1, 2, 3])) },
        { type: 'palette', number: 999, bytes: toBase64(paletteResource(7, [10, 20, 30])) },
      ]),
    );
    expect(chosen.how).toContain('palette 999');
    expect(chosen.colours[7]).toEqual([10, 20, 30]);
  });

  it('falls back to the lowest-numbered one, and says that is what happened', () => {
    const chosen = sciViewColours(
      emptyProject([
        { type: 'palette', number: 80, bytes: toBase64(paletteResource(7, [4, 5, 6])) },
        { type: 'palette', number: 50, bytes: toBase64(paletteResource(7, [1, 2, 3])) },
      ]),
    );
    expect(chosen.how).toContain('palette 50');
    expect(chosen.how).toContain('no palette 999');
    expect(chosen.colours[7]).toEqual([1, 2, 3]);
  });
});

describe('a cel', () => {
  it('leaves its clear key transparent rather than painting index 255', () => {
    const colours = sciViewColours(emptyProject([]));
    const image = renderSciCel(
      cel({ width: 2, height: 1, clearKey: 0xff, pixels: Uint8Array.of(12, 0xff) }),
      colours,
    );

    expect([...image.rgba.slice(0, 4)]).toEqual([...SCI_EGA_PALETTE[12], 255]);
    // Not black-and-opaque: an exported actor with an opaque background is one
    // that cannot be put on anything.
    expect([...image.rgba.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });
});

describe('a vector Picture', () => {
  it('renders the visual buffer at the size the walk drew into', () => {
    // setColour 4, fill at 50,40, terminate.
    const drawn = drawSciPicture(Uint8Array.of(0xf0, 4, 0xf8, 0x02, 0x32, 0x28, 0xff), {
      vga: false,
      width: 320,
      height: 190,
    });
    const image = renderSciVectorPicture(drawn, false);

    expect(image.width).toBe(320);
    expect(image.height).toBe(190);
    expect(image.rgba).toHaveLength(320 * 190 * 4);
    // Every pixel opaque: priority and control are the other two buffers and
    // neither is artwork, so nothing here is see-through.
    expect(image.rgba[3]).toBe(255);
  });
});

describe('a cel Picture', () => {
  function celRecord(options: {
    width: number;
    height: number;
    clearKey: number;
    rleAt: number;
    priority?: number;
    x?: number;
    y?: number;
  }): Uint8Array {
    const record = new Uint8Array(42);
    const view = new DataView(record.buffer);
    view.setUint16(0, options.width, true);
    view.setUint16(2, options.height, true);
    record[8] = options.clearKey;
    view.setUint32(24, options.rleAt, true);
    view.setInt16(36, options.priority ?? 0, true);
    view.setInt16(38, options.x ?? 0, true);
    view.setInt16(40, options.y ?? 0, true);
    return record;
  }

  /** Two overlapping items, the higher priority one drawn second. */
  function twoItemPicture(): SciProjectCelPicture {
    const resource = new Uint8Array(14 + 42 * 2 + 8);
    const view = new DataView(resource.buffer);
    view.setUint16(0, 0x0e, true);
    resource[2] = 2;
    view.setUint16(4, 42, true);
    view.setUint16(10, 2, true); // 2x1 display
    view.setUint16(12, 1, true);
    resource.set(celRecord({ width: 2, height: 1, clearKey: 0xff, rleAt: 14 + 84 }), 14);
    resource.set(
      celRecord({ width: 1, height: 1, clearKey: 0xff, rleAt: 14 + 86, priority: 9, x: 1 }),
      14 + 42,
    );
    resource.set([1, 2], 14 + 84);
    resource.set([3], 14 + 86);

    return {
      type: 'pic',
      number: 100,
      bytes: toBase64(resource),
      container: 'sci32',
      resolution: { width: 2, height: 1 },
      items: [],
      hasVectors: false,
    };
  }

  /**
   * A SCI32 Plane occludes by ordering alone (ADR 0015), so the composition is
   * the drawing order — and an exporter that walked the items in the order
   * they happened to be read would put the background over the foreground for
   * any Picture whose items are not already sorted.
   */
  it('draws its items in priority order, so the near one covers the far one', () => {
    const image = renderSciCelPicture(twoItemPicture());
    expect(typeof image).not.toBe('string');
    if (typeof image === 'string') return;

    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    // The second item is one pixel wide at x=1 and priority 9, so it wins.
    expect(image.rgba[7]).toBe(255);
  });

  it('refuses a Picture the reader could not finish, rather than exporting half', () => {
    const broken: SciProjectCelPicture = {
      ...twoItemPicture(),
      bytes: toBase64(Uint8Array.of(0x0e, 0x00, 9, 0, 42, 0)),
    };
    const result = renderSciCelPicture(broken);
    expect(typeof result).toBe('string');
    expect(String(result)).toMatch(/stopped at byte|no cels/);
  });
});

describe('a font sheet', () => {
  it('inks its glyphs opaque and leaves the rest transparent', () => {
    const sheet = renderSciFontSheet({
      lineHeight: 2,
      glyphs: [
        { width: 2, height: 1, pixels: Uint8Array.of(1, 0) },
        { width: 2, height: 1, pixels: Uint8Array.of(0, 1) },
      ],
    });
    expect(typeof sheet).not.toBe('string');
    if (typeof sheet === 'string') return;

    // Two glyphs, so a 2x1 grid of 3x2 cells: a glyph's width plus the gap
    // that keeps two neighbours from reading as one.
    expect(sheet.width).toBe(6);
    expect(sheet.rgba[3]).toBe(255);
    expect(sheet.rgba[7]).toBe(0);
  });

  it('says so rather than writing an empty image when there are no glyphs', () => {
    expect(renderSciFontSheet({ lineHeight: 8, glyphs: [] })).toBe('This font holds no glyphs.');
  });
});

describe('a cursor', () => {
  /**
   * Black *and* white, which is the whole reason a SCI cursor has two planes:
   * a white arrow with a black outline reads on a dark room and a light one,
   * and exporting it in one colour loses half of every pointer.
   */
  it('keeps its three states three', () => {
    const image = renderSciCursorImage({
      width: 3,
      height: 1,
      hotspotX: 0,
      hotspotY: 0,
      pixels: Uint8Array.of(0, 1, CURSOR_TRANSPARENT),
    });

    expect([...image.rgba.slice(0, 4)]).toEqual([0, 0, 0, 255]);
    expect([...image.rgba.slice(4, 8)]).toEqual([255, 255, 255, 255]);
    expect([...image.rgba.slice(8, 12)]).toEqual([0, 0, 0, 0]);
  });
});

describe('what the file is called', () => {
  it('says which game and which frame, so a folder of them stays readable', () => {
    expect(sciImageFilename("King's Quest IV", 'view-12-loop-0-cel-3')).toBe(
      'king-s-quest-iv-view-12-loop-0-cel-3.png',
    );
    expect(sciImageFilename('', 'font-4')).toBe('game-font-4.png');
  });
});
