/**
 * SCI16 graphics: Pictures, Views and the priority buffer on a Plane.
 *
 * The Plane half is tested here properly, because it is a decision rather than
 * a format: ADR 0015 puts the priority buffer on a Plane as *optional data*,
 * and both paths — a Plane with a mask and one without — are exercised.
 *
 * The format half is checked against real data, which CI cannot have: the
 * freely distributed Sierra demos decode 12,105 View cels across nine games,
 * and `npm run shot:sci` renders Space Quest III's room 2 and King's Quest IV's
 * title from their own Picture resources.
 */

import { describe, expect, it } from 'vitest';

import { drawSciPicture, sci16PictureTop } from '../src/engine/sci/gfx/SciPicture.js';
import {
  describeUnwritableSciView,
  readSci11Cel,
  readSciCel,
  readSciView,
  writeSciView,
} from '../src/engine/sci/gfx/SciView.js';
import { readSciCelPicture } from '../src/engine/sci/gfx/SciCelPicture.js';
import { Plane, SciCompositor } from '../src/engine/sci/gfx/Plane.js';
import { SCI_EGA_PALETTE, readSciPalette } from '../src/engine/sci/gfx/sciPalette.js';

function cel(
  width: number,
  height: number,
  fill: number,
  clearKey = 0,
): {
  width: number;
  height: number;
  displaceX: number;
  displaceY: number;
  clearKey: number;
  pixels: Uint8Array;
} {
  return {
    width,
    height,
    displaceX: 0,
    displaceY: 0,
    clearKey,
    pixels: new Uint8Array(width * height).fill(fill),
  };
}

describe('a Picture', () => {
  it('paints into three buffers and records what it drew', () => {
    const picture = drawSciPicture(
      new Uint8Array([
        0xf0,
        0x04, // set colour 4, which enables the visual buffer
        0xf2,
        0x0a, // set priority 10, which enables the priority buffer
        0xf6,
        0x00,
        0x0a,
        0x0a,
        0x00,
        0x14,
        0x0a, // a long line from 10,10 to 20,10
        0xff,
      ]),
      { width: 40, height: 20 },
    );

    expect(picture.unknown).toBeUndefined();
    expect(picture.visual[10 * 40 + 15]).toBe(4);
    expect(picture.priority[10 * 40 + 15]).toBe(10);
    // Control was never enabled, so it stays clear — the three buffers are
    // painted independently and a command enables only what it names.
    expect(picture.control[10 * 40 + 15]).toBe(0);
    expect(picture.commands.map((command) => command.op)).toEqual([
      'setColour',
      'setPriority',
      'longLines',
      'terminate',
    ]);
  });

  /**
   * A fill with the clear colour writes a pixel that is still open, so a fill
   * bounded by the buffer alone never terminates. Quest for Glory II's Pictures
   * do exactly that, and the symptom was "Invalid array length" from a stack of
   * a hundred million entries rather than anything about a Picture.
   */
  /**
   * The embedded cel is not a detail of a SCI1 VGA Picture, it is the room.
   *
   * All 85 vector Pictures across the nine SCI1 VGA demos carry one and 81 are
   * full screen; SCI0, SCI01 and SCI1 EGA-only carry none. Collected and not
   * painted, every VGA room renders as black with its actors floating on it —
   * and nothing reports a problem, because nothing went wrong.
   */
  it('paints an embedded cel into its visual buffer, because that is the room', () => {
    // `fe 01`, three bytes this format has only ever been seen to hold zero, a
    // size word, then an 8-byte cel header and one RLE run.
    const cel = [
      0x02,
      0x00, // width 2
      0x02,
      0x00, // height 2
      0x00,
      0x00, // displacement
      0xff, // clear key
      0x00,
      0x84,
      0x09, // fill four pixels with colour 9
    ];
    const picture = drawSciPicture(
      new Uint8Array([0xfe, 0x01, 0, 0, 0, cel.length & 0xff, cel.length >> 8, ...cel, 0xff]),
      { vga: true, width: 4, height: 4 },
    );

    expect(picture.cels).toHaveLength(1);
    expect([...picture.visual.slice(0, 2)]).toEqual([9, 9]);
    expect([...picture.visual.slice(4, 6)]).toEqual([9, 9]);
    // Visual only. A background that also stamped a priority would occlude
    // every actor standing in front of it.
    expect([...new Set(picture.priority)]).toHaveLength(1);
  });

  it('leaves the ten rows a SCI16 status bar occupies above the artwork', () => {
    expect(sci16PictureTop(190, 200)).toBe(10);
    // SCI32's Planes are the size of their display, and the same arithmetic
    // lands them at zero without a Version being consulted.
    expect(sci16PictureTop(480, 480)).toBe(0);
    expect(sci16PictureTop(600, 480)).toBe(0);
  });

  it('terminates a fill whose colour is the colour it is filling over', () => {
    const picture = drawSciPicture(new Uint8Array([0xf0, 0x0f, 0xf8, 0x00, 0x05, 0x05, 0xff]), {
      width: 32,
      height: 16,
    });
    expect(picture.unknown).toBeUndefined();
  });

  /**
   * A SCI1.1 Picture is a bitmap with vector operations after it. Walking it as
   * vectors produces *a* picture, and a picture that is wrong for reasons
   * nothing on screen explains is the fault class this renderer exists to
   * avoid — so it reports instead (#221).
   */
  it('refuses a SCI1.1 Picture rather than drawing its bitmap as vectors', () => {
    const picture = drawSciPicture(new Uint8Array([0x26, 0x00, 0x10, 0x0e]));
    expect(picture.unknown).toEqual({ at: 0, op: 0x26 });
    expect(picture.commands).toEqual([]);
  });

  it('reports an operation it does not know rather than skipping it', () => {
    const picture = drawSciPicture(new Uint8Array([0xf0, 0x02, 0x42]), { width: 8, height: 8 });
    expect(picture.unknown).toEqual({ at: 2, op: 0x42 });
  });
});

describe('a View', () => {
  /**
   * **This fixture had the nibbles the wrong way round, and so did the
   * decoder.** They agreed with each other and disagreed with every SCI0 game
   * — which is the trap `verifying-version-support.md` opens with, caught in
   * the act: "a fixture encodes our reading of the format. If that reading is
   * wrong, the fixture and the engine agree with each other and disagree with
   * the game."
   *
   * King's Quest IV's View 879 is what settled it. Its first cel is 46 pixels
   * wide and opens `f0 f0 f0 10` — three runs of fifteen and one of one, which
   * is exactly 46. Read the other way, `f0` is colour fifteen for a run of
   * *nought*: every byte wrote nothing, and every actor in every SCI0 game
   * came out as a column of stripes. ScummVM's `unpackCelData` agrees in two
   * lines: `runLength = curByte >> 4`, colour `curByte & 0x0F`.
   */
  it('decodes an EGA cel, whose runs are a length nibble and a colour nibble', () => {
    // Four pixels of colour 3, then four of colour 5, in a 4x2 cel: a run of
    // four in the high nibble, the colour in the low one.
    const decoded = readSciCel(new Uint8Array([4, 0, 2, 0, 0, 0, 0, 0, 0x43, 0x45]), 0, false);

    expect(decoded).not.toBeNull();
    expect([...decoded!.pixels]).toEqual([3, 3, 3, 3, 5, 5, 5, 5]);
  });

  it('decodes a VGA cel, whose runs are an operation and a length', () => {
    // 0x84 is a fill of four with the next byte; 0x44 is a literal run of four.
    const decoded = readSciCel(
      new Uint8Array([4, 0, 2, 0, 0, 0, 0, 0, 0x84, 0x07, 0x04, 1, 2, 3, 4]),
      0,
      true,
    );
    expect([...decoded!.pixels]).toEqual([7, 7, 7, 7, 1, 2, 3, 4]);
  });

  /**
   * A cel larger than any screen is a header read at the wrong offset, and
   * allocating for it turns a bad offset into an allocation failure rather than
   * a message.
   */
  it('refuses an implausible cel rather than allocating for it', () => {
    expect(readSciCel(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]), 0, false)).toBeNull();
  });

  it('mirrors a loop from the one before it, displacement and all', () => {
    // Two loops, the second mirrored. One 2x1 cel each.
    const resource = new Uint8Array(64);
    resource[0] = 2; // loop count
    resource[1] = 0; // EGA
    resource[2] = 0x02; // mirror mask: loop 1
    resource[8] = 12;
    resource[10] = 12; // both loops point at the same header; loop 1 is replaced
    resource[12] = 1; // one cel
    resource[16] = 20; // cel offset
    resource.set([2, 0, 1, 0, 3, 0, 0, 0, 0x17, 0x24], 20);

    const view = readSciView(resource);
    expect(view.loops).toHaveLength(2);
    expect(view.loops[1].mirrored).toBe(true);
    expect(view.loops[1].mirrorOf).toBe(0);
    expect([...view.loops[1].cels[0].pixels]).toEqual([...view.loops[0].cels[0].pixels].reverse());
    expect(view.loops[1].cels[0].displaceX).toBe(-view.loops[0].cels[0].displaceX);
  });
});

describe('a Plane, which carries the priority buffer as data (ADR 0015)', () => {
  /**
   * The claim: a Plane with a mask occludes per pixel, and one without occludes
   * by ordering alone, through the *same* compositor. Both paths exercised,
   * because #225 generalises this rather than replacing it — and if the second
   * path were untested, the generalisation would be a rewrite discovering its
   * requirements.
   */
  it('occludes per pixel where it has a mask', () => {
    const mask = new Uint8Array(4 * 2);
    // The right half of the top row is scenery at priority 10.
    mask[2] = 10;
    mask[3] = 10;

    const plane = new Plane({ x: 0, y: 0, width: 4, height: 2 }, 0, mask);
    plane.add({ cel: cel(4, 2, 7), x: 0, y: 0, priority: 5, visible: true });

    const target = new Uint8Array(4 * 2);
    const compositor = new SciCompositor();
    compositor.add(plane);
    compositor.composite(target, 4, 2);

    // Drawn where its priority wins, hidden where the scenery's does — which is
    // an actor's head above a wall and its legs behind one.
    expect([...target]).toEqual([7, 7, 0, 0, 7, 7, 7, 7]);
  });

  it('occludes by ordering alone where it has none, which is every SCI32 Plane', () => {
    const plane = new Plane({ x: 0, y: 0, width: 4, height: 2 }, 0, null);
    plane.add({ cel: cel(4, 2, 7), x: 0, y: 0, priority: 5, visible: true });
    plane.add({ cel: cel(2, 1, 9), x: 0, y: 0, priority: 6, visible: true });

    const target = new Uint8Array(4 * 2);
    const compositor = new SciCompositor();
    compositor.add(plane);
    compositor.composite(target, 4, 2);

    expect([...target]).toEqual([9, 9, 7, 7, 7, 7, 7, 7]);
  });

  it('sorts by plane, then item priority, then insertion', () => {
    const back = new Plane({ x: 0, y: 0, width: 2, height: 1 }, 0, null);
    const front = new Plane({ x: 0, y: 0, width: 2, height: 1 }, 5, null);
    back.add({ cel: cel(2, 1, 1), x: 0, y: 0, priority: 9, visible: true });
    front.add({ cel: cel(2, 1, 2), x: 0, y: 0, priority: 0, visible: true });

    const target = new Uint8Array(2);
    const compositor = new SciCompositor();
    compositor.add(front);
    compositor.add(back);
    compositor.composite(target, 2, 1);

    // The front Plane wins despite its item having the lower priority: plane
    // first, then item. Getting the keys the other way round puts a dialogue
    // box behind the actor talking.
    expect([...target]).toEqual([2, 2]);
  });

  it('leaves what is underneath where a cel says it is clear', () => {
    const plane = new Plane({ x: 0, y: 0, width: 2, height: 1 }, 0, null);
    plane.background = new Uint8Array([4, 4]);
    const transparent = cel(2, 1, 0, 0);
    transparent.pixels[1] = 6;
    plane.add({ cel: transparent, x: 0, y: 0, priority: 1, visible: true });

    const target = new Uint8Array(2);
    const compositor = new SciCompositor();
    compositor.add(plane);
    compositor.composite(target, 2, 1);
    expect([...target]).toEqual([4, 6]);
  });

  it('reports the rectangles it touched, for a dirty-rect redraw to use', () => {
    const plane = new Plane({ x: 3, y: 2, width: 8, height: 8 }, 0, null);
    plane.add({ cel: cel(2, 2, 1), x: 1, y: 1, priority: 0, visible: true });

    const compositor = new SciCompositor();
    compositor.add(plane);
    const dirty = compositor.composite(new Uint8Array(16 * 16), 16, 16);
    expect(dirty).toEqual([{ x: 4, y: 3, width: 2, height: 2 }]);
  });
});

describe('palettes', () => {
  it('has the sixteen EGA colours the hardware had', () => {
    expect(SCI_EGA_PALETTE).toHaveLength(16);
    expect(SCI_EGA_PALETTE[0]).toEqual([0, 0, 0]);
    expect(SCI_EGA_PALETTE[15]).toEqual([0xff, 0xff, 0xff]);
  });

  /**
   * Two formats behind one resource type, and reading three-byte entries as
   * four-byte ones shifts every colour after the first by one channel — which
   * looks like a palette from a different game rather than like a fault.
   */
  it('reads both palette resource forms', () => {
    const resource = new Uint8Array(37 + 8);
    resource[25] = 2; // start index
    resource[29] = 2; // two colours
    resource[32] = 0; // with a "used" byte in front of each
    resource.set([1, 10, 20, 30, 1, 40, 50, 60], 37);

    expect(readSciPalette(resource)).toEqual([
      { index: 2, r: 10, g: 20, b: 30, used: true },
      { index: 3, r: 40, g: 50, b: 60, used: true },
    ]);

    // The same bytes with the first entry's flag cleared. `used` is what
    // Sierra's merge tests, and a reader that dropped it submitted 162 zero
    // entries over King's Quest VII's scenery.
    resource[37] = 0;
    expect(readSciPalette(resource)[0].used).toBe(false);
    expect(readSciPalette(resource)[1].used).toBe(true);
    resource[37] = 1;

    resource[32] = 1; // no "used" byte: three bytes an entry, all used
    resource.set([10, 20, 30, 40, 50, 60], 37);
    expect(readSciPalette(resource)).toEqual([
      { index: 2, r: 10, g: 20, b: 30, used: true },
      { index: 3, r: 40, g: 50, b: 60, used: true },
    ]);
  });
});

describe('cursors, which are resources (#218)', () => {
  /**
   * Neither sibling has this: SCUMM draws its cursor from a costume and AGI has
   * one shape, and SCI ships a `cursor` resource per pointer with a script
   * calling `kSetCursor` by number. Read against real games — Quest for Glory
   * II's and Longbow's arrow cursors both have a hotspot of 8,7 and around 200
   * of 256 pixels painted.
   */
  it('reads a SCI0 cursor as its hotspot and two colours over transparency', async () => {
    const { readSciCursor, CURSOR_TRANSPARENT } =
      await import('../src/engine/sci/gfx/SciCursor.js');

    const resource = new Uint8Array(4 + 64);
    resource[0] = 7; // hotspot y
    resource[2] = 8; // hotspot x
    // Row 0: colour bits set for the left two pixels, mask clear for them.
    resource[4] = 0xc0;
    resource[36] = 0x3f;
    resource[37] = 0xff;

    const cursor = readSciCursor(resource)!;
    expect(cursor).toMatchObject({ width: 16, height: 16, hotspotX: 8, hotspotY: 7 });
    // White where the colour bit is set, and transparent where the mask is.
    expect(cursor.pixels[0]).toBe(1);
    expect(cursor.pixels[1]).toBe(1);
    expect(cursor.pixels[2]).toBe(CURSOR_TRANSPARENT);
  });

  /**
   * A hotspot read at the wrong offset is tens of thousands, and a pointer that
   * clicks off the screen is harder to diagnose than one in the wrong place.
   */
  it('clamps a hotspot rather than trusting it', async () => {
    const { readSciCursor } = await import('../src/engine/sci/gfx/SciCursor.js');
    const resource = new Uint8Array(4 + 64);
    resource[0] = 0xff;
    resource[1] = 0xff;
    expect(readSciCursor(resource)!.hotspotY).toBe(15);
  });

  it('refuses a resource too short to be a cursor', async () => {
    const { readSciCursor } = await import('../src/engine/sci/gfx/SciCursor.js');
    expect(readSciCursor(new Uint8Array(16))).toBeNull();
  });

  /**
   * CSS rather than pixels in the framebuffer: a cursor drawn into the
   * framebuffer moves at the *game's* frame rate rather than the pointer's, and
   * on a game running at ten cycles a second that is a pointer visibly lagging
   * the mouse.
   */
  it('hands the browser an image and a hotspot, so the pointer does not lag the mouse', async () => {
    const { cursorToDataUri } = await import('../src/engine/sci/gfx/SciCursor.js');
    const style = cursorToDataUri(
      { width: 2, height: 1, hotspotX: 1, hotspotY: 0, pixels: new Uint8Array([1, 0xff]) },
      () => [255, 255, 255],
    );
    expect(style).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(style).toMatch(/\) 1 0, auto$/);
  });
});

/**
 * The second kind of Picture (ADR 0018), and the cel record shared with V56.
 *
 * Built here rather than read from a game, for the reason
 * `docs/processes/verifying-version-support.md` gives and then immediately
 * warns about: a fixture encodes this project's reading of the format, so if
 * the reading is wrong the fixture and the reader agree with each other. The
 * escape is that the same reader was pointed at Sierra's own demos — 314 cel
 * Pictures across King's Quest VI, Gabriel Knight, Freddy Pharkas, Torin's
 * Passage, Space Quest 6, King's Quest VII, Lighthouse, RAMA and Leisure Suit
 * Larry 7, decoding with no failures — and `npm run shot:sci` renders King's
 * Quest VI's title screen, Space Quest 6's bridge and Lighthouse's mill room
 * from their own resources, which a person looked at.
 */
describe('a cel Picture, which is the other kind', () => {
  /** A 42-byte cel record: the one a V56 View and both Picture containers use. */
  function celRecord(options: {
    width: number;
    height: number;
    clearKey: number;
    compression: number;
    rleAt: number;
    literalAt: number;
    priority?: number;
    x?: number;
    y?: number;
  }): Uint8Array {
    const record = new Uint8Array(42);
    const view = new DataView(record.buffer);
    view.setUint16(0, options.width, true);
    view.setUint16(2, options.height, true);
    record[8] = options.clearKey;
    record[9] = options.compression;
    view.setUint32(24, options.rleAt, true);
    view.setUint32(28, options.literalAt, true);
    view.setInt16(36, options.priority ?? 0, true);
    view.setInt16(38, options.x ?? 0, true);
    view.setInt16(40, options.y ?? 0, true);
    return record;
  }

  it('reads a SCI32 container as items that carry their own place', () => {
    const resource = new Uint8Array(14 + 42 * 2 + 8);
    const view = new DataView(resource.buffer);
    view.setUint16(0, 0x0e, true); // header size
    resource[2] = 2; // cel count
    view.setUint16(4, 42, true); // cel header size
    view.setUint16(10, 640, true);
    view.setUint16(12, 480, true);
    resource.set(
      celRecord({
        width: 2,
        height: 2,
        clearKey: 0xff,
        compression: 0,
        rleAt: 14 + 84,
        literalAt: 0,
      }),
      14,
    );
    resource.set(
      celRecord({
        width: 2,
        height: 2,
        clearKey: 0xff,
        compression: 0,
        rleAt: 14 + 88,
        literalAt: 0,
        priority: 7,
        x: 40,
        y: 12,
      }),
      14 + 42,
    );
    resource.set([1, 2, 3, 4, 5, 6, 7, 8], 14 + 84);

    const picture = readSciCelPicture(resource);

    expect(picture.container).toBe('sci32');
    expect(picture.unknown).toBeNull();
    expect(picture.resolution).toEqual({ width: 640, height: 480 });
    expect(picture.cels).toHaveLength(2);
    expect([...picture.cels[0].cel.pixels]).toEqual([1, 2, 3, 4]);
    // The second item is where the Picture says it is, at the priority the
    // Picture says — a screen item written down rather than inferred from the
    // order it happened to be read in (#227).
    expect(picture.cels[1]).toMatchObject({ x: 40, y: 12, priority: 7 });
  });

  it('keeps the vector operations a SCI1.1 Picture carries after its bitmap', () => {
    const resource = new Uint8Array(120);
    const view = new DataView(resource.buffer);
    view.setUint16(0, 0x26, true);
    view.setUint16(4, 1, true); // has a cel
    view.setUint32(16, 116, true); // where the vectors start
    view.setUint32(28, 0, true); // no palette
    view.setUint32(32, 40, true); // where the cel header sits
    resource.set(
      celRecord({ width: 2, height: 2, clearKey: 3, compression: 0, rleAt: 110, literalAt: 0 }),
      40,
    );
    resource.set([9, 9, 9, 9], 110);
    resource.set([0xf0, 0x04, 0xff, 0x00], 116);

    const picture = readSciCelPicture(resource);

    expect(picture.container).toBe('sci11');
    expect(picture.cels).toHaveLength(1);
    // The bitmap and the drawing operations are both there. SCI1.1 is the
    // Version where a Picture is both, and dropping either half loses the
    // background or the priority buffer that occludes over it.
    expect(picture.vectorData?.[0]).toBe(0xf0);
  });

  /**
   * A SCI1.1 Picture's cel has no compression byte, and reading one refuses it.
   *
   * King's Quest VI's Pictures carry `0x0a` at offset 9, which is neither of
   * Sierra's two methods. Folding this cel into the shared reader without
   * saying so made every SCI1.1 background refuse itself — and the fixtures did
   * not catch it, because a fixture writes a zero there. `npm run shot:sci`
   * caught it, which is why #218 makes that a criterion and not a nicety.
   */
  it('does not read a compression method out of a SCI1.1 Picture, which has none', () => {
    const resource = new Uint8Array(160);
    const view = new DataView(resource.buffer);
    view.setUint16(0, 0x26, true);
    view.setUint16(4, 1, true);
    view.setUint32(16, 156, true);
    view.setUint32(32, 40, true);
    view.setUint16(40, 2, true);
    view.setUint16(42, 2, true);
    resource[48] = 0; // transparent index
    resource[49] = 0x0a; // King's Quest VI's byte, and not a method
    view.setUint32(64, 120, true); // control stream
    view.setUint32(68, 0, true); // no second stream: pixels follow inline
    resource[120] = 0x84; // fill, run of four
    resource[121] = 6;

    const picture = readSciCelPicture(resource);

    expect(picture.unknown).toBeNull();
    expect([...(picture.cels[0]?.cel.pixels ?? [])]).toEqual([6, 6, 6, 6]);
  });

  it('reports a compression method it does not read rather than drawing noise', () => {
    const resource = new Uint8Array(14 + 42);
    const view = new DataView(resource.buffer);
    view.setUint16(0, 0x0e, true);
    resource[2] = 1;
    view.setUint16(4, 42, true);
    resource.set(
      celRecord({ width: 2, height: 2, clearKey: 0, compression: 77, rleAt: 0, literalAt: 0 }),
      14,
    );

    const picture = readSciCelPicture(resource);

    expect(picture.cels).toHaveLength(0);
    expect(picture.unknown?.why).toContain('cel header');
  });

  it('unpacks a two-stream run, and an inline one where there is no second stream', () => {
    // Control bytes and pixels apart: 0x82 repeats one literal four times over.
    const split = new Uint8Array(60);
    new DataView(split.buffer).setUint16(0, 2, true);
    new DataView(split.buffer).setUint16(2, 2, true);
    split[8] = 0;
    split[9] = 138;
    new DataView(split.buffer).setUint32(24, 50, true);
    new DataView(split.buffer).setUint32(28, 55, true);
    split[50] = 0x84; // fill, run of four
    split[55] = 6;
    expect([...(readSci11Cel(split, 0) as { pixels: Uint8Array }).pixels]).toEqual([6, 6, 6, 6]);

    // A literal offset of zero means the pixels follow the control bytes.
    const inline = new Uint8Array(60);
    new DataView(inline.buffer).setUint16(0, 2, true);
    new DataView(inline.buffer).setUint16(2, 2, true);
    inline[8] = 0;
    inline[9] = 138;
    new DataView(inline.buffer).setUint32(24, 50, true);
    new DataView(inline.buffer).setUint32(28, 0, true);
    inline[50] = 0x84;
    inline[51] = 5;
    expect([...(readSci11Cel(inline, 0) as { pixels: Uint8Array }).pixels]).toEqual([5, 5, 5, 5]);
  });
});

describe('a V56 View, which is SCI1.1 and everything after it', () => {
  function v56(options: { headerSize: number; celSize: number; loops: number }): Uint8Array {
    const resource = new Uint8Array(400);
    const view = new DataView(resource.buffer);
    // The stored header size is two short of where the loop table starts.
    view.setUint16(0, options.headerSize, true);
    resource[2] = options.loops;
    resource[12] = 16; // loop record size
    resource[13] = options.celSize;
    view.setUint16(14, 640, true);
    view.setUint16(16, 480, true);
    return resource;
  }

  it('starts its loop table two bytes past the size it declares', () => {
    const resource = v56({ headerSize: 16, celSize: 36, loops: 1 });
    const view = new DataView(resource.buffer);
    const loopAt = 18;
    resource[loopAt] = 0xff; // not a mirror of anything
    resource[loopAt + 2] = 1; // one cel
    view.setUint32(loopAt + 12, 200, true);
    view.setUint16(200, 2, true);
    view.setUint16(202, 2, true);
    resource[208] = 0xff; // transparent index
    resource[209] = 0; // uncompressed
    view.setUint32(224, 300, true);
    resource.set([1, 2, 3, 4], 300);

    const decoded = readSciView(resource);

    expect(decoded.encoding).toBe('v56');
    expect(decoded.resolution).toEqual({ width: 640, height: 480 });
    // Reading the declared 16 rather than 18 lands on the resolution's low
    // byte, takes 0xe0 for a mirror index, and returns a View with no cels —
    // which is what a Space Quest 6 actor looked like before this was found.
    expect(decoded.loops[0].cels).toHaveLength(1);
    expect([...decoded.loops[0].cels[0].pixels]).toEqual([1, 2, 3, 4]);
  });

  it('follows a mirrored loop to the loop it names, and flips it', () => {
    const resource = v56({ headerSize: 16, celSize: 36, loops: 2 });
    const view = new DataView(resource.buffer);
    resource[18] = 0xff;
    resource[20] = 1;
    view.setUint32(30, 200, true);
    resource[34] = 0; // loop 1 mirrors loop 0
    view.setUint16(200, 2, true);
    view.setUint16(202, 1, true);
    resource[208] = 0xff;
    resource[209] = 0;
    view.setUint32(224, 300, true);
    resource.set([1, 2], 300);

    const decoded = readSciView(resource);

    expect([...decoded.loops[0].cels[0].pixels]).toEqual([1, 2]);
    expect(decoded.loops[1].mirrored).toBe(true);
    expect([...decoded.loops[1].cels[0].pixels]).toEqual([2, 1]);
  });

  /**
   * **A V56 View used to be readable and not writable at all, and that was a
   * whole family's artwork.** Every SCI1.1, SCI2, SCI2.1 and SCI3 release is in
   * this form — 1,527 of King's Quest VII's resources — so "writing one back is
   * not built" meant no cel origin on any of them could be moved.
   *
   * It is written in place rather than rebuilt, which is ADR 0018's rule for a
   * Script applied to artwork: the record carries scaling fields and stream
   * offsets this reader does not model, and patching four bytes inside it
   * invents none of them.
   */
  it('writes a V56 cel origin back into the record it was read from', () => {
    const resource = v56({ headerSize: 16, celSize: 36, loops: 1 });
    const view = new DataView(resource.buffer);
    resource[18] = 0xff;
    resource[20] = 1;
    view.setUint32(30, 200, true);
    view.setUint16(200, 2, true);
    view.setUint16(202, 2, true);
    resource[208] = 0xff;
    resource[209] = 0;
    view.setUint32(224, 300, true);
    resource.set([1, 2, 3, 4], 300);

    const decoded = readSciView(resource);
    expect(describeUnwritableSciView(decoded)).toBeNull();
    // Untouched, it is the bytes it came from — a patch writes nothing it was
    // not asked to.
    expect([...writeSciView(decoded)]).toEqual([...resource]);

    decoded.loops[0].cels[0].displaceX = -7;
    decoded.loops[0].cels[0].displaceY = 11;
    const written = writeSciView(decoded);

    expect(written).toHaveLength(resource.length);
    const back = readSciView(written);
    expect(back.loops[0].cels[0].displaceX).toBe(-7);
    expect(back.loops[0].cels[0].displaceY).toBe(11);
    // The pixels are the same bytes, untouched: this writer moves an origin
    // and does not re-encode artwork.
    expect([...back.loops[0].cels[0].pixels]).toEqual([1, 2, 3, 4]);
  });

  /**
   * A mirrored loop's cel is another loop's pixels flipped, so it has no record
   * of its own — and an edit written "back" through it would move the loop it
   * mirrors instead, in the opposite direction.
   */
  it('does not write a mirrored loop through the record it borrows', () => {
    const resource = v56({ headerSize: 16, celSize: 36, loops: 2 });
    const view = new DataView(resource.buffer);
    resource[18] = 0xff;
    resource[20] = 1;
    view.setUint32(30, 200, true);
    resource[34] = 0;
    view.setUint16(200, 2, true);
    view.setUint16(202, 1, true);
    resource[208] = 0xff;
    resource[209] = 0;
    view.setUint32(224, 300, true);
    resource.set([1, 2], 300);

    const decoded = readSciView(resource);
    expect(decoded.loops[0].cels[0].recordAt).toBe(200);
    expect(decoded.loops[1].cels[0].recordAt).toBeUndefined();

    decoded.loops[1].cels[0].displaceX = 99;

    expect([...writeSciView(decoded)]).toEqual([...resource]);
  });

  it('leaves an EGA View alone rather than claiming it', () => {
    // Sixteen loops opens with the same two bytes a V56 header does, which is
    // why the test is three fields and not one.
    const ega = new Uint8Array(64);
    ega[0] = 16;
    expect(readSciView(ega).encoding).toBe('ega');
  });
});

/**
 * Dirty-rect redraw (#225), and the tripwire it would fire.
 *
 * ADR 0015 warns that if the priority buffer's presence starts being asked
 * about *outside* the visibility test — "in dirty-rect tracking, in cel
 * clipping, in hit-testing" — it is not optional data, it is a second renderer.
 * Dirty tracking is the first of those three to exist, so this is where the
 * claim is tested rather than restated.
 */
describe('a dirty-rect redraw, which is where ADR 0015 would break', () => {
  it('repairs where a thing was as well as where it is', () => {
    const plane = new Plane({ x: 0, y: 0, width: 10, height: 10 }, 0, null);
    const item = plane.add({ cel: cel(2, 2, 5), x: 0, y: 0, priority: 1, visible: true });
    const compositor = new SciCompositor();
    compositor.add(plane);

    const framebuffer = new Uint8Array(100);
    compositor.compositeDirty(framebuffer, 10, 10);
    expect(framebuffer[0]).toBe(5);

    item.x = 6;
    compositor.compositeDirty(framebuffer, 10, 10);

    // Redrawing only where it is now would leave the trail it walked out of,
    // which reads as a smear rather than as a fault.
    expect(framebuffer[0]).toBe(0);
    expect(framebuffer[6]).toBe(5);
  });

  it('leaves what it did not repair exactly as it was', () => {
    const plane = new Plane({ x: 0, y: 0, width: 10, height: 10 }, 0, null);
    plane.add({ cel: cel(2, 2, 5), x: 0, y: 0, priority: 1, visible: true });
    const compositor = new SciCompositor();
    compositor.add(plane);

    const framebuffer = new Uint8Array(100).fill(7);
    compositor.compositeDirty(framebuffer, 10, 10);

    // A pixel outside every dirty region keeps whatever was under it — which is
    // the whole point, and what makes this cheaper than a full redraw.
    expect(framebuffer[99]).toBe(7);
    expect(framebuffer[0]).toBe(5);
  });

  /**
   * **The tripwire, checked rather than asserted.** The same sequence on a
   * Plane that carries a mask and one that does not must repair the same
   * rectangles: a rectangle is a rectangle whatever occludes inside it. If
   * dirty tracking ever needs to know about the mask, these diverge.
   */
  it('tracks the same regions with a mask and without one', () => {
    function run(mask: Uint8Array | null): string {
      const plane = new Plane({ x: 0, y: 0, width: 10, height: 10 }, 0, mask);
      const item = plane.add({ cel: cel(2, 2, 5), x: 0, y: 0, priority: 1, visible: true });
      const compositor = new SciCompositor();
      compositor.add(plane);
      const framebuffer = new Uint8Array(100);
      compositor.compositeDirty(framebuffer, 10, 10);
      item.x = 6;
      return JSON.stringify(compositor.compositeDirty(framebuffer, 10, 10));
    }

    // A mask that hides everything: the pixels differ, the regions do not.
    expect(run(new Uint8Array(100).fill(255))).toBe(run(null));
  });
});
