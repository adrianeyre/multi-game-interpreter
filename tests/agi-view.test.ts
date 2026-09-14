import { describe, expect, it } from 'vitest';
import { drawCel, loopIsMirrored, readView, writeView } from '../src/engine/agi/gfx/AgiView.js';
import {
  EGO,
  SCREEN_OBJECT_COUNT,
  createScreenObject,
  drawOrder,
  effectivePriority,
} from '../src/engine/agi/ScreenObject.js';
import { priorityTable, PICTURE_WIDTH } from '../src/engine/agi/gfx/agiPalette.js';
import { buildView, sampleLoops, type CelSpec } from './fixtureAgi.js';

const TRANSPARENT = 0;

function cel(colour: number, width = 4, height = 3): CelSpec {
  return {
    width,
    height,
    transparent: TRANSPARENT,
    // Deliberately asymmetrical, so a mirror that did not flip is visible
    // rather than plausible.
    pixels: [colour, colour, 0, 0, colour, 0, 0, 0, colour, colour, colour, 0],
  };
}

describe('reading a View', () => {
  it('parses loops and cels with per-cel width, height and transparent colour', () => {
    const view = readView(new Uint8Array(buildView([{ cels: [cel(1), cel(2)] }])));

    expect(view.loops).toHaveLength(1);
    expect(view.loops[0].cels).toHaveLength(2);
    expect(view.loops[0].cels[0]).toMatchObject({
      width: 4,
      height: 3,
      transparent: TRANSPARENT,
    });
  });

  it('decodes the run-length rows back to the pixels they came from', () => {
    const source = cel(5);
    const view = readView(new Uint8Array(buildView([{ cels: [source] }])));
    expect([...view.loops[0].cels[0].pixels]).toEqual(source.pixels);
  });

  /**
   * A trailing run of the transparent colour is omitted by Sierra's own tools,
   * so a short row is normal rather than damaged.
   */
  it('reads a row whose trailing transparent run was omitted', () => {
    const trailing: CelSpec = {
      width: 5,
      height: 2,
      transparent: TRANSPARENT,
      pixels: [7, 7, 0, 0, 0, 7, 0, 0, 0, 0],
    };
    const view = readView(new Uint8Array(buildView([{ cels: [trailing] }])));
    expect([...view.loops[0].cels[0].pixels]).toEqual(trailing.pixels);
  });

  it('reads the description when a View carries one, and null when it does not', () => {
    const withNote = readView(new Uint8Array(buildView([{ cels: [cel(1)] }], 'the ego')));
    expect(withNote.description).toBe('the ego');
    expect(readView(new Uint8Array(buildView([{ cels: [cel(1)] }]))).description).toBeNull();
  });

  it('refuses a resource shorter than its own header', () => {
    expect(() => readView(new Uint8Array([2, 1]))).toThrow(/five-byte header/);
  });

  it('refuses a loop table that runs past the end of the resource', () => {
    expect(() => readView(new Uint8Array([2, 1, 40, 0, 0]))).toThrow(/offset table/);
  });

  /**
   * A truncated cel keeps the rows it had. The pixel buffer is pre-filled with
   * the transparent colour, so the missing rows are simply absent — and losing
   * one cel beats refusing every other cel in the View.
   */
  it('keeps the rows it decoded from a truncated cel rather than refusing the View', () => {
    const bytes = new Uint8Array(buildView([{ cels: [cel(9)] }]));
    const view = readView(bytes.subarray(0, bytes.length - 4));
    expect(view.loops[0].cels[0].pixels.some((pixel) => pixel === 9)).toBe(true);
  });
});

describe('mirrored loops', () => {
  /**
   * The trap #128 and #136 both name. A mirrored loop is stored **once** and
   * flipped at render time, so two entries in the offset table point at the
   * same bytes — and which of them is the original is written into every cel's
   * third byte, read from the resource rather than inferred.
   */
  it('reads the mirror source loop out of the resource', () => {
    const view = readView(new Uint8Array(buildView(sampleLoops())));

    // The fixture makes loop 3 a mirror of loop 1.
    expect(view.loops[3].mirrorOf).toBe(1);
    expect(view.loops[1].mirrorOf).toBeNull();
    expect(view.loops[1].cels[0].mirrorSourceLoop).toBe(1);
  });

  it('points a mirrored loop at the same bytes as its source', () => {
    const view = readView(new Uint8Array(buildView(sampleLoops())));
    expect(view.loops[3].offset).toBe(view.loops[1].offset);
    expect(view.loops[3].cels).toHaveLength(view.loops[1].cels.length);
  });

  /**
   * The same bytes render one way under their own loop number and the other way
   * under any loop that shares them. Reading the flag as "this cel is flipped"
   * renders the *source* loop backwards, which looks like art rather than a
   * bug.
   */
  it('flips only the loop that is not the source', () => {
    const view = readView(new Uint8Array(buildView(sampleLoops())));
    const shared = view.loops[1].cels[0];

    expect(loopIsMirrored(shared, 1)).toBe(false);
    expect(loopIsMirrored(shared, 3)).toBe(true);
  });

  it('never claims a cel with no mirror flag is mirrored', () => {
    const view = readView(new Uint8Array(buildView([{ cels: [cel(1)] }])));
    expect(view.loops[0].cels[0].mirrorSourceLoop).toBeNull();
    expect(loopIsMirrored(view.loops[0].cels[0], 0)).toBe(false);
    expect(loopIsMirrored(view.loops[0].cels[0], 5)).toBe(false);
  });

  it('draws a mirrored cel as the horizontal flip of its source', () => {
    const view = readView(new Uint8Array(buildView(sampleLoops())));
    const source = view.loops[1].cels[0];

    const plain = new Uint8Array(4 * 3);
    const flipped = new Uint8Array(4 * 3);
    drawCel(source, 0, 2, { target: plain, width: 4, height: 3 });
    drawCel(source, 0, 2, { target: flipped, width: 4, height: 3, mirrored: true });

    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 4; x++) {
        expect(flipped[y * 4 + x]).toBe(plain[y * 4 + (3 - x)]);
      }
    }
    // And the two genuinely differ, which the asymmetrical fixture guarantees.
    expect([...flipped]).not.toEqual([...plain]);
  });
});

describe('drawing a cel', () => {
  /**
   * AGI's own convention: `y` is the cel's **bottom** row, because an object's
   * position is where it stands. Treating it as the top draws every sprite a
   * cel-height too high, which reads as an art alignment problem.
   */
  it('treats y as the bottom row, not the top', () => {
    const target = new Uint8Array(10 * 10);
    drawCel(readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0], 0, 5, {
      target,
      width: 10,
      height: 10,
    });

    // A three-row cel whose bottom is row 5 occupies rows 3, 4 and 5.
    expect(target[3 * 10]).toBe(6);
    expect(target[5 * 10]).toBe(6);
    expect(target[6 * 10]).toBe(0);
  });

  it('leaves the transparent colour alone', () => {
    const target = new Uint8Array(10 * 10).fill(99);
    const source = readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0];
    drawCel(source, 0, 2, { target, width: 10, height: 10 });

    // The cel's top-right pixels are transparent, so the fill shows through.
    expect(target[0 * 10 + 2]).toBe(99);
    expect(target[0 * 10 + 0]).toBe(6);
  });

  it('clips against every edge of the screen', () => {
    const source = readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0];

    for (const [x, y] of [
      [-3, 1],
      [9, 1],
      [1, 1],
      [1, 20],
    ]) {
      const target = new Uint8Array(10 * 10);
      expect(() => drawCel(source, x, y, { target, width: 10, height: 10 })).not.toThrow();
      // Nothing written outside the buffer, which is what the length proves.
      expect(target).toHaveLength(100);
    }
  });
});

describe('occlusion by the priority buffer', () => {
  /**
   * The whole of AGI's occlusion: scenery drawn into a high band hides a sprite
   * in a lower one, and the sprite needs no per-pixel mask of its own.
   */
  it('hides a sprite where the buffer priority is higher than the object', () => {
    const width = 8;
    const height = 8;
    const priority = new Uint8Array(width * height).fill(4);
    // Row 5 is scenery in band 9 — a wall the sprite should go behind.
    priority.fill(9, 5 * width, 6 * width);

    const source = readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0];
    const target = new Uint8Array(width * height);
    drawCel(source, 0, 5, {
      target,
      width,
      height,
      priority,
      objectPriority: 6,
    });

    // Rows 3 and 4 draw; row 5, the named row, does not.
    expect(target[3 * width]).toBe(6);
    expect(target[4 * width]).toBe(6);
    expect(target[5 * width]).toBe(0);
  });

  it('draws where the object priority equals the buffer, not only above it', () => {
    const width = 8;
    const priority = new Uint8Array(width * 8).fill(7);
    const source = readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0];
    const target = new Uint8Array(width * 8);
    drawCel(source, 0, 5, { target, width, height: 8, priority, objectPriority: 7 });

    expect(target[5 * width]).toBe(6);
  });

  it('draws everywhere when no priority buffer is given', () => {
    const source = readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0];
    const target = new Uint8Array(8 * 8);
    drawCel(source, 0, 5, { target, width: 8, height: 8 });
    expect(target[5 * 8]).toBe(6);
  });
});

describe('the screen object table', () => {
  it('holds position, View, loop, cel and priority per object', () => {
    const object = createScreenObject(3);
    object.view = 7;
    object.loop = 2;
    object.cel = 1;
    object.x = 40;
    object.y = 120;
    object.priority = 9;

    expect(object).toMatchObject({
      number: 3,
      view: 7,
      loop: 2,
      cel: 1,
      x: 40,
      y: 120,
      priority: 9,
    });
  });

  it('makes object zero the player', () => {
    expect(EGO).toBe(0);
    expect(SCREEN_OBJECT_COUNT).toBe(16);
  });

  /**
   * Unfixed, an object's priority comes from its own row through the band
   * table — which is what makes walking behind scenery work with no per-object
   * setup at all.
   */
  it('reads an unfixed priority from the row the object stands on', () => {
    const bands = priorityTable();
    const object = createScreenObject(1);

    object.y = 20;
    expect(effectivePriority(object, bands)).toBe(4);
    object.y = 60;
    expect(effectivePriority(object, bands)).toBe(6);
    object.y = 167;
    expect(effectivePriority(object, bands)).toBe(14);
  });

  it('uses the fixed priority once a script has set one', () => {
    const bands = priorityTable();
    const object = createScreenObject(1);
    object.y = 20;
    object.priority = 12;
    object.fixedPriority = true;

    expect(effectivePriority(object, bands)).toBe(12);
    object.fixedPriority = false;
    expect(effectivePriority(object, bands)).toBe(4);
  });

  it('clamps a row outside the picture rather than reading past the table', () => {
    const bands = priorityTable();
    const object = createScreenObject(1);
    object.y = 5000;
    expect(effectivePriority(object, bands)).toBe(bands[bands.length - 1]);
    object.y = -20;
    expect(effectivePriority(object, bands)).toBe(bands[0]);
  });
});

describe('draw order', () => {
  function objectAt(number: number, priority: number) {
    const object = createScreenObject(number);
    object.drawn = true;
    object.animated = true;
    object.priority = priority;
    return object;
  }

  it('draws low priorities first, so the ones in front are laid down last', () => {
    const order = drawOrder([objectAt(1, 9), objectAt(2, 4), objectAt(3, 14)]);
    expect(order.map((object) => object.number)).toEqual([2, 1, 3]);
  });

  /**
   * #128 asks for a defined and documented tiebreak, and the reason is
   * flicker: two objects standing on the same row is common — a character and
   * the item they are about to pick up — and an undefined order there means the
   * pair swaps between frames as the array is rebuilt.
   */
  it('breaks equal priorities by object number, ascending', () => {
    const order = drawOrder([objectAt(7, 6), objectAt(2, 6), objectAt(5, 6)]);
    expect(order.map((object) => object.number)).toEqual([2, 5, 7]);
  });

  it('leaves out anything not both drawn and animated', () => {
    const undrawn = objectAt(1, 5);
    undrawn.drawn = false;
    const inert = objectAt(2, 5);
    inert.animated = false;

    expect(drawOrder([undrawn, inert, objectAt(3, 5)]).map((o) => o.number)).toEqual([3]);
  });
});

describe('a View round-trips', () => {
  it('re-emits an untouched View byte for byte', () => {
    for (const loops of [[{ cels: [cel(1), cel(2)] }], sampleLoops()]) {
      const original = new Uint8Array(buildView(loops));
      expect([...writeView(readView(original))]).toEqual([...original]);
    }
  });

  it('re-emits a View with a description byte for byte', () => {
    const original = new Uint8Array(buildView([{ cels: [cel(3)] }], 'ego walking'));
    expect([...writeView(readView(original))]).toEqual([...original]);
  });

  /**
   * A mirrored loop is emitted once and pointed at twice, because that is how
   * it arrived. Emitting it a second time would produce a working View that is
   * not the same bytes, which ADR 0013 counts as Unrecovered.
   */
  it('emits a mirrored loop once and points two entries at it', () => {
    const original = new Uint8Array(buildView(sampleLoops()));
    const written = writeView(readView(original));

    expect([...written]).toEqual([...original]);
    const view = readView(written);
    expect(view.loops[3].offset).toBe(view.loops[1].offset);
  });
});

describe('a cel is 160-space, doubled on output like the picture', () => {
  it('draws into a 160-wide buffer', () => {
    const target = new Uint8Array(PICTURE_WIDTH * 168);
    const source = readView(new Uint8Array(buildView([{ cels: [cel(6)] }]))).loops[0].cels[0];
    drawCel(source, 150, 10, { target, width: PICTURE_WIDTH, height: 168 });

    // Drawn at the right-hand edge and clipped there rather than wrapping to
    // the next row, which is what an unchecked width would do.
    expect(target[10 * PICTURE_WIDTH + 150]).toBe(6);
    expect(target[11 * PICTURE_WIDTH]).toBe(0);
  });
});
