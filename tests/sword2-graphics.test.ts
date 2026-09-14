import { describe, expect, it } from 'vitest';
import {
  decodeSword2Frame,
  decompressRLE16,
  decompressRLE256,
  parseSword2Parallax,
} from '../src/engine/sword2/gfx/sword2Decode.js';
import {
  compressSword2ParallaxRow,
  compressSword2Rows,
  encodeSword2Frame,
  encodeSword2Parallax,
  invertSword2ColourTable,
  Sword2EncodeError,
} from '../src/engine/sword2/gfx/sword2Encode.js';
import {
  decodeSword2MouseFrame,
  parseSword2MouseAnim,
  SWORD2_MOUSE_ANIM_HEADER_SIZE,
} from '../src/engine/sword2/gfx/sword2Mouse.js';
import {
  RES_HEADER_SIZE,
  sword2Animation,
  Sword2FrameType,
} from '../src/engine/sword2/resource/sword2Headers.js';
import { Sword2Screen, type Sword2MouseTarget } from '../src/engine/sword2/gfx/Sword2Screen.js';
import {
  buildSword2Anim,
  buildSword2Icon,
  buildSword2Screen,
  sword2Header,
} from './fixtureSword.js';
import {
  SWORD2_BOTTOM_MENU_TOP,
  SWORD2_ICON_DEPTH,
  SWORD2_ICON_SPACING,
  SWORD2_ICON_START,
  SWORD2_ICON_WIDTH,
  SWORD2_TOP_MENU_TOP,
} from '../src/engine/sword2/Sword2Menu.js';

/** A sixteen-entry table whose colours are their index plus a hundred. */
const TABLE = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);

/** Decoding what an encoder wrote, which is the only check that means anything. */
function roundTrip(
  pixels: Uint8Array,
  width: number,
  height: number,
  compression: number,
  frameType = 0,
  table?: Uint8Array,
): number[] {
  const bytes = encodeSword2Frame(pixels, width, height, compression, frameType, table);
  const decoded = decodeSword2Frame(bytes, compression, width, height, table);
  expect(decoded.ok).toBe(true);
  return Array.from(decoded.pixels);
}

describe('writing a FAST_256 frame back', () => {
  it('clips every block to the row, and ends each row with a literal header', () => {
    // Eight pixels of one colour are one run and four blocks: two rows, each a
    // flat four and an empty literal. A writer that ignored rows would emit a
    // single flat eight, which decodes to the same picture and is not what the
    // game shipped.
    const pixels = new Uint8Array(8).fill(5);
    expect(Array.from(compressSword2Rows(pixels, 4, 2))).toEqual([4, 5, 0, 4, 5, 0]);
  });

  it('detects a run across the row boundary while emitting a block that does not', () => {
    // The row's last pixel is a flat block of one *because the next row starts
    // with the same colour*. That reads like a rule about row-final pixels and
    // is really one unclipped run feeding one clipped length.
    const pixels = Uint8Array.from([1, 2, 3, 3, 4, 5]);
    const bytes = compressSword2Rows(pixels, 3, 2);
    expect(Array.from(bytes.subarray(0, 7))).toEqual([0, 2, 1, 2, 1, 3, 0]);
  });

  it('writes colour zero flat however short its run is', () => {
    // A lone zero costs two bytes either way, and the original spent them on
    // the flat block.
    expect(Array.from(compressSword2Rows(Uint8Array.from([0, 1, 2, 3]), 4, 1))).toEqual([
      1, 0, 3, 1, 2, 3,
    ]);
  });

  it('round-trips through the decoder', () => {
    const pixels = Uint8Array.from([0, 0, 7, 7, 7, 1, 2, 0, 9, 9, 3, 4]);
    expect(roundTrip(pixels, 4, 3, 1, Sword2FrameType.FAST_256)).toEqual(Array.from(pixels));
  });
});

describe('writing an RLE256 frame back', () => {
  it('ignores rows entirely without the FAST_256 bit, and waits for a run of four', () => {
    // This is Broken Sword's "JIM " scheme, not a variation on the one above:
    // one flat block, then literals until a run pays for its header.
    const pixels = Uint8Array.from([9, 9, 1, 2, 5, 5, 5, 5]);
    expect(Array.from(encodeSword2Frame(pixels, 4, 2, 1))).toEqual([2, 9, 2, 1, 2, 4, 5]);
  });

  it('round-trips a frame whose blocks straddle its rows', () => {
    const pixels = Uint8Array.from([3, 3, 3, 3, 3, 1, 2, 0, 0, 0, 0, 8]);
    expect(roundTrip(pixels, 4, 3, 1)).toEqual(Array.from(pixels));
  });
});

describe('writing an RLE16 frame back', () => {
  it('packs two literals into a byte, high nibble first', () => {
    const pixels = Uint8Array.from([100, 102, 105]);
    // A flat block of one 100, then two literals sharing a byte: 2 then 5.
    expect(Array.from(encodeSword2Frame(pixels, 3, 1, 2, 0, TABLE))).toEqual([1, 100, 2, 0x25]);
  });

  it('waits for a run of seven, because a literal here costs half a byte', () => {
    const pixels = Uint8Array.from([100, 101, 101, 101, 101, 101]);
    // Five 101s are cheaper as literals than as a run, so only the leading
    // flat block is one. RLE256's threshold of four would have split them.
    const bytes = encodeSword2Frame(pixels, 6, 1, 2, 0, TABLE);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([1, 100, 5]);
    expect(roundTrip(pixels, 6, 1, 2, 0, TABLE)).toEqual(Array.from(pixels));
  });

  it('gives a repeated colour its lowest index, which is what the original wrote', () => {
    const repeated = Uint8Array.from(TABLE);
    repeated[9] = repeated[3];
    expect(invertSword2ColourTable(repeated).get(103)).toBe(3);
  });

  it('refuses a colour the table does not hold, rather than writing a wrong pixel', () => {
    expect(() => encodeSword2Frame(Uint8Array.from([200]), 1, 1, 2, 0, TABLE)).toThrow(
      Sword2EncodeError,
    );
    expect(() => encodeSword2Frame(Uint8Array.from([100]), 1, 1, 2)).toThrow(Sword2EncodeError);
  });
});

describe('an uncompressed frame', () => {
  it('is its own encoding', () => {
    const pixels = Uint8Array.from([1, 2, 3, 4]);
    expect(Array.from(encodeSword2Frame(pixels, 2, 2, 0))).toEqual([1, 2, 3, 4]);
  });
});

describe('walking an animation resource', () => {
  it('finds each frame at its offset from the anim header, with its own bytes', () => {
    const resource = buildSword2Anim('anim', [
      { x: 1, y: 2, width: 2, height: 1, colour: 7 },
      { x: 3, y: 4, width: 1, height: 2, colour: 8, frameType: Sword2FrameType.FLIPPED },
    ]);
    const animation = sword2Animation(resource);
    expect(animation?.header.noAnimFrames).toBe(2);
    expect(animation?.frames.map((frame) => frame.cdt.x)).toEqual([1, 3]);
    expect(Array.from(animation?.frames[1].data ?? [])).toEqual([8, 8]);
  });

  it('reads FAST_256 on the frame as overriding the compression on the animation', () => {
    // The field is per animation and the bit is per frame, and the bit wins.
    const resource = buildSword2Anim('anim', [
      { x: 0, y: 0, width: 1, height: 1, frameType: Sword2FrameType.FAST_256 },
    ]);
    expect(sword2Animation(resource)?.frames[0].compression).toBe(1);
  });

  it('has no colour table unless the animation is RLE16', () => {
    const resource = buildSword2Anim('anim', [{ x: 0, y: 0, width: 1, height: 1 }]);
    expect(sword2Animation(resource)?.colourTable).toBeNull();
  });
});

describe('the decoders the encoders answer to', () => {
  it('reads RLE256 as alternating flat and raw blocks', () => {
    const out = new Uint8Array(6);
    expect(decompressRLE256(Uint8Array.from([2, 9, 3, 1, 2, 3, 1, 4, 0]), out, 6).ok).toBe(true);
    expect(Array.from(out)).toEqual([9, 9, 1, 2, 3, 4]);
  });

  it('reads an RLE16 raw block two pixels to a byte', () => {
    const out = new Uint8Array(3);
    expect(decompressRLE16(Uint8Array.from([1, 100, 2, 0x25]), out, TABLE, 3, true).ok).toBe(true);
    expect(Array.from(out)).toEqual([100, 102, 105]);
  });
});

describe('writing a parallax back', () => {
  /** The packet list a row encodes to, as `L`iterals and `S`kips. */
  function packets(row: Uint8Array): string[] {
    const view = new DataView(row.buffer, row.byteOffset, row.byteLength);
    const parts: string[] = [];
    let at = 4;
    let literal = true;
    for (let packet = 0; packet < view.getUint16(0, true); packet++) {
      const count = row[at++];
      parts.push(`${literal ? 'L' : 'S'}${count}`);
      if (literal) at += count;
      literal = !literal;
    }
    return parts;
  }

  it('writes a row with nothing to skip flat, with no packets at all', () => {
    const row = compressSword2ParallaxRow(Uint8Array.from([4, 5, 6])) as Uint8Array;
    expect(Array.from(row)).toEqual([0, 0, 0, 0, 4, 5, 6]);
  });

  it('starts a row that begins with a gap on the column, not on a skip', () => {
    const row = compressSword2ParallaxRow(Uint8Array.from([0, 0, 7, 0, 0, 0, 8])) as Uint8Array;
    expect(new DataView(row.buffer).getUint16(2, true)).toBe(2);
    expect(packets(row)).toEqual(['L1', 'S3', 'L1']);
  });

  it('breaks a literal at two transparent pixels, which is the tie', () => {
    // Two zeros cost the same either way — a skip byte plus the literal length
    // that restarts after it — and the original breaks the tie towards the skip.
    const row = compressSword2ParallaxRow(Uint8Array.from([1, 0, 0, 2])) as Uint8Array;
    expect(packets(row)).toEqual(['L1', 'S2', 'L1']);
  });

  it('leaves a lone transparent pixel inside the literal', () => {
    const row = compressSword2ParallaxRow(Uint8Array.from([1, 0, 2])) as Uint8Array;
    expect(packets(row)).toEqual(['L3']);
  });

  it('caps a literal at 252 and splits it with an empty skip', () => {
    const pixels = new Array<number>(300).fill(3);
    pixels[299] = 0;
    const row = compressSword2ParallaxRow(Uint8Array.from(pixels)) as Uint8Array;
    expect(packets(row)).toEqual(['L252', 'S0', 'L47']);
  });

  it('caps a skip at 252 and splits it with an empty literal', () => {
    const pixels = new Array<number>(300).fill(0);
    pixels[0] = 3;
    pixels[299] = 4;
    const row = compressSword2ParallaxRow(Uint8Array.from(pixels)) as Uint8Array;
    expect(packets(row)).toEqual(['L1', 'S252', 'L0', 'S46', 'L1']);
  });

  it('round-trips a whole layer through the reader, row table and all', () => {
    const width = 8;
    const height = 4;
    const pixels = Uint8Array.from([
      1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 3, 0, 4, 0, 5, 0, 0, 0, 0,
      6,
    ]);
    const bytes = encodeSword2Parallax(pixels, width, height);
    const parsed = parseSword2Parallax(bytes);
    expect(parsed?.width).toBe(width);
    expect(Array.from(parsed?.pixels ?? [])).toEqual(Array.from(pixels));
    // The wholly transparent row is offset zero, not a zero-length body.
    expect(new DataView(bytes.buffer).getUint32(4 + 4, true)).toBe(0);
  });
});

describe('the cycle’s mouse list', () => {
  /** A target, named only by what the assertions below need to tell apart. */
  const target = (objectId: number, priority: number): Sword2MouseTarget => ({
    objectId,
    x1: 0,
    y1: 0,
    x2: 639,
    y2: 479,
    priority,
    pointer: 0,
    pointerText: 0,
  });

  /**
   * Broken Sword II counts priority the way a race counts places: 0 is first.
   *
   * `fnInitFloorMouse` writes `priority = 9` under the comment "floor is always
   * lowest priority" (`function.cpp:504-512`), and `Mouse::checkMouseList`
   * scans `for (priority = 0; priority < 10; priority++)` and takes the first
   * rectangle that contains the pointer (`mouse.cpp:1146-1157`). So a smaller
   * number wins, and the floor — which covers the whole room — has to come
   * last or it answers every click before anything on top of it is reached.
   */
  it('puts the lowest priority number first, so the floor is asked last', () => {
    const screen = new Sword2Screen(null as never);
    // Registered floor-first, which is the order the scripts actually use: the
    // floor's service script runs before the objects standing on it.
    screen.addMouseTarget(target(21, 9));
    screen.addMouseTarget(target(652, 6));
    screen.addMouseTarget(target(593, 4));

    expect(screen.hitTargets().map((each) => each.objectId)).toEqual([593, 652, 21]);
  });

  it('keeps registration order among targets of equal priority', () => {
    const screen = new Sword2Screen(null as never);
    screen.addMouseTarget(target(655, 8));
    screen.addMouseTarget(target(659, 8));
    screen.addMouseTarget(target(660, 8));

    // `checkMouseList`'s inner loop is registration order, so an equal-priority
    // tie is broken by who asked for the mouse first and never by the sort.
    expect(screen.hitTargets().map((each) => each.objectId)).toEqual([655, 659, 660]);
  });
});

/**
 * The camera, which this project did not have.
 *
 * Sword2 scrolls a room wider than the display by chasing the player: each
 * cycle `Screen::setScrolling` works out the offset that would put the
 * player's feet at `feet_x, feet_y` on the display and moves a fraction of the
 * way there, capped at eight pixels (`scroll.cpp:53-155`). Nothing called it
 * here, so the view sat at 0,0 in every room and the player walked off the
 * right-hand side of the demo's 864-pixel-wide first screen and stayed there.
 */
describe('the camera', () => {
  /** A screen that reports a room of the given size without a resource. */
  function room(width: number, height: number): Sword2Screen {
    const screen = new Sword2Screen({
      fetch: () => ({ bytes: buildSword2Screen('room', width, height) }),
      describeMissingResource: () => 'absent',
    } as never);
    screen.initBackground(1, false);
    return screen;
  }

  it('does not move at all in a room that fits the display', () => {
    const screen = room(640, 480);
    screen.setPlayerFeet(600, 470);
    screen.updateScroll();
    expect({ x: screen.scrollX, y: screen.scrollY }).toEqual({ x: 0, y: 0 });
  });

  it('jumps the first cycle on a wide screen, then glides', () => {
    const screen = room(1600, 480);
    // 320 is where the system keeps the player's feet across, so a player at
    // 700 wants the view at 380 — and gets it at once, because "2 means first
    // time on screen" (`layers.cpp:124`).
    screen.setPlayerFeet(700, 400);
    screen.updateScroll();
    expect(screen.scrollX).toBe(380);

    // Walking on: 8 pixels a cycle at most, whatever the distance.
    screen.setPlayerFeet(900, 400);
    screen.updateScroll();
    expect(screen.scrollX).toBe(388);
  });

  it('stops at the edges of the room rather than showing past them', () => {
    const screen = room(960, 480);
    screen.setPlayerFeet(959, 400);
    screen.updateScroll();
    expect(screen.scrollX).toBe(screen.maxScrollX);
    expect(screen.maxScrollX).toBe(320);

    screen.setPlayerFeet(0, 400);
    for (let cycle = 0; cycle < 100; cycle++) screen.updateScroll();
    expect(screen.scrollX).toBe(0);
  });

  it('moves one pixel a cycle when it is already nearly there', () => {
    const screen = room(960, 480);
    screen.setPlayerFeet(400, 400);
    screen.updateScroll(); // jumps to 80
    screen.setPlayerFeet(404, 400);
    screen.updateScroll();
    // Four pixels out and a fraction of 16: "it would otherwise not scroll at
    // all when dx < SCROLL_FRACTION" (`scroll.cpp:110-113`).
    expect(screen.scrollX).toBe(81);
  });

  it('lets a script take the wheel through SCROLL_X and SCROLL_Y', () => {
    const screen = room(960, 600);
    screen.setPlayerFeet(900, 500);
    screen.updateScroll(100, 40);
    expect({ x: screen.scrollX, y: screen.scrollY }).toEqual({ x: 100, y: 40 });
  });

  it('keeps the player’s feet where fnSetScrollCoordinate put them', () => {
    const screen = room(1600, 480);
    screen.setScrollTarget(100, 340);
    screen.setPlayerFeet(700, 400);
    screen.updateScroll();
    // 100 across rather than the default 320, so the same player wants a view
    // 220 pixels further right.
    expect(screen.scrollX).toBe(600);
  });

  it('slows to half speed for fnSetScrollSpeedSlow', () => {
    const screen = room(1600, 480);
    screen.setPlayerFeet(400, 400);
    screen.updateScroll(); // jumps to 80
    screen.setScrollFraction(32);
    screen.setPlayerFeet(500, 400);
    screen.updateScroll();
    // 100 out: 1 + 100/32 = 4, where a fraction of 16 would have given 7.
    expect(screen.scrollX).toBe(84);
  });
});

describe('the menu bars on screen', () => {
  /**
   * A screen over a flat room, with the four icon resources the demo ships.
   *
   * The icons are 65, 70, 71 and 72 — EXIT, GRUB, LABEL and NEWSCUT — and each
   * is 2,144 bytes: a 44-byte header and two 35x30 images, greyed then
   * coloured (`icons.cpp:176-183`).
   */
  function menuScreen(): Sword2Screen {
    const icons = new Map<number, Uint8Array>([
      [65, buildSword2Icon('exit', 10, 11)],
      [70, buildSword2Icon('grub', 20, 21)],
    ]);
    const screen = new Sword2Screen({
      fetch: (id: number) =>
        icons.has(id) ? { bytes: icons.get(id) } : { bytes: buildSword2Screen('room', 640, 480) },
      describeMissingResource: () => 'absent',
    } as never);
    screen.initBackground(1, false);
    return screen;
  }

  /** The colour at a display pixel. */
  function at(out: Uint8Array, x: number, y: number): number {
    return out[y * 640 + x];
  }

  it('draws nothing at all while both bars are down', () => {
    const screen = menuScreen();
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: false, pockets: [{ icon: 65, coloured: true }] },
      { shown: false, pockets: [{ icon: 70, coloured: true }] },
    ]);
    screen.present(out);
    expect(at(out, SWORD2_ICON_START, SWORD2_TOP_MENU_TOP)).toBe(0);
    expect(at(out, SWORD2_ICON_START, SWORD2_BOTTOM_MENU_TOP)).toBe(0);
  });

  it('puts the first pocket at the icon start and spaces the rest by five', () => {
    const screen = menuScreen();
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: false, pockets: [] },
      {
        shown: true,
        pockets: [{ icon: 65, coloured: true }, null, { icon: 70, coloured: true }],
      },
    ]);
    screen.present(out);

    const pitch = SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING;
    const y = SWORD2_BOTTOM_MENU_TOP;
    expect(at(out, SWORD2_ICON_START, y)).toBe(11);
    expect(at(out, SWORD2_ICON_START + SWORD2_ICON_WIDTH - 1, y)).toBe(11);
    // The gap between pockets is five pixels of whatever was behind the bar,
    // which is the room: `RDMENU_ICONSPACING`.
    expect(at(out, SWORD2_ICON_START + SWORD2_ICON_WIDTH, y)).not.toBe(11);
    // An empty pocket is a hole, not a shift: the third icon sits at the third
    // slot's x however many of the ones before it are filled.
    expect(at(out, SWORD2_ICON_START + pitch, y)).not.toBe(21);
    expect(at(out, SWORD2_ICON_START + 2 * pitch, y)).toBe(21);
  });

  it('is thirty rows deep and stops there', () => {
    const screen = menuScreen();
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: false, pockets: [] },
      { shown: true, pockets: [{ icon: 65, coloured: true }] },
    ]);
    screen.present(out);
    expect(at(out, SWORD2_ICON_START, SWORD2_BOTTOM_MENU_TOP + SWORD2_ICON_DEPTH - 1)).toBe(11);
    expect(at(out, SWORD2_ICON_START, SWORD2_BOTTOM_MENU_TOP - 1)).not.toBe(11);
    expect(at(out, SWORD2_ICON_START, SWORD2_BOTTOM_MENU_TOP + SWORD2_ICON_DEPTH)).not.toBe(11);
  });

  it('reads the greyed half of the resource for a pocket that is not chosen', () => {
    const screen = menuScreen();
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: false, pockets: [] },
      {
        shown: true,
        pockets: [
          { icon: 65, coloured: false },
          { icon: 70, coloured: true },
        ],
      },
    ]);
    screen.present(out);
    const pitch = SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING;
    // Greying is a different *image*, not a different palette: the coloured one
    // lives a whole 35x30 further into the same resource.
    expect(at(out, SWORD2_ICON_START, SWORD2_BOTTOM_MENU_TOP)).toBe(10);
    expect(at(out, SWORD2_ICON_START + pitch, SWORD2_BOTTOM_MENU_TOP)).toBe(21);
  });

  it('draws the top bar at five, where the inventory lives', () => {
    const screen = menuScreen();
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: true, pockets: [{ icon: 70, coloured: false }] },
      { shown: false, pockets: [] },
    ]);
    screen.present(out);
    // (MENUDEEP - RDMENU_ICONDEEP) / 2 from the top of the bar, and the top
    // bar starts at row 0.
    expect(at(out, SWORD2_ICON_START, SWORD2_TOP_MENU_TOP)).toBe(20);
    expect(at(out, SWORD2_ICON_START, SWORD2_TOP_MENU_TOP - 1)).not.toBe(20);
  });

  it('draws over the room rather than beside it', () => {
    const screen = menuScreen();
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: false, pockets: [] },
      { shown: true, pockets: [{ icon: 65, coloured: true }] },
    ]);
    screen.present(out);
    // A pixel just left of the first pocket is still the room, and the pocket
    // itself is the icon: an icon is opaque, and zero in it is black rather
    // than see-through.
    expect(at(out, SWORD2_ICON_START - 1, SWORD2_BOTTOM_MENU_TOP)).not.toBe(11);
    expect(at(out, SWORD2_ICON_START + 1, SWORD2_BOTTOM_MENU_TOP)).toBe(11);
  });

  it('says so and carries on when an icon is the wrong size', () => {
    const screen = new Sword2Screen({
      fetch: (id: number) => ({
        bytes: id === 9 ? new Uint8Array(200) : buildSword2Screen('room', 640, 480),
      }),
      describeMissingResource: () => 'absent',
    } as never);
    screen.initBackground(1, false);
    const out = new Uint8Array(640 * 480);
    screen.setMenu([
      { shown: false, pockets: [] },
      { shown: true, pockets: [{ icon: 9, coloured: false }] },
    ]);
    screen.present(out);
    // A room resource is not an icon, and the bar is drawn without it rather
    // than with 1,050 bytes of somebody else's picture.
    expect(screen.warnings.join('\n')).toContain('menu icon 9');
  });
});

/**
 * The luggage: the sprite the pointer carries while something is being dragged.
 *
 * A `MOUSE_FILE` is neither of the two compressions the rest of the game's
 * graphics use, which is why it needed a decoder of its own. The format is a
 * six-byte header, an offset per frame, and frames coded against a threshold
 * rather than a flag byte: above 183 is a pixel, 183 or below is that many
 * transparent ones (`Mouse::decompressMouse`).
 */
describe('the dragged luggage', () => {
  /** A `MOUSE_FILE` resource: the standard header, then the animation. */
  function mouseFile(
    frames: readonly (readonly number[])[],
    width: number,
    height: number,
    hotspotX = -8,
    hotspotY = -8,
  ): Uint8Array {
    const table = new Uint8Array(frames.length * 4);
    const view = new DataView(table.buffer);
    let offset = SWORD2_MOUSE_ANIM_HEADER_SIZE + frames.length * 4;
    const body: number[] = [];
    frames.forEach((frame, index) => {
      view.setUint32(index * 4, offset, true);
      body.push(...frame);
      offset += frame.length;
    });
    const anim = Uint8Array.from([
      4,
      frames.length,
      hotspotX & 0xff,
      hotspotY & 0xff,
      width,
      height,
      ...table,
      ...body,
    ]);
    const out = new Uint8Array(RES_HEADER_SIZE + anim.length);
    out.set(sword2Header(6, 'luggage', anim.length));
    out.set(anim, RES_HEADER_SIZE);
    return out;
  }

  it('reads the header, and reads the hotspot as signed', () => {
    const anim = parseSword2MouseAnim(mouseFile([[184]], 1, 1));

    expect(anim).not.toBeNull();
    expect({
      compression: anim!.compression,
      frames: anim!.frames,
      width: anim!.width,
      height: anim!.height,
      hotspotX: anim!.hotspotX,
      hotspotY: anim!.hotspotY,
    }).toEqual({ compression: 4, frames: 1, width: 1, height: 1, hotspotX: -8, hotspotY: -8 });
  });

  it('draws a byte over 183 and skips the rest, across the row boundary', () => {
    // Two transparent, two pixels, three transparent, one pixel: eight pixels
    // of a four-by-two frame, with a run that crosses from one row to the next.
    const anim = parseSword2MouseAnim(mouseFile([[2, 200, 201, 3, 202]], 4, 2))!;
    const frame = decodeSword2MouseFrame(anim, 0)!;

    expect(frame.ok).toBe(true);
    expect(Array.from(frame.pixels)).toEqual([0, 0, 200, 201, 0, 0, 0, 202]);
    // Carried through, because the frame is drawn *by* its hotspot.
    expect({ x: frame.hotspotX, y: frame.hotspotY }).toEqual({ x: -8, y: -8 });
  });

  it('says so rather than throwing when a frame runs out part way through', () => {
    const anim = parseSword2MouseAnim(mouseFile([[2, 200]], 4, 2))!;
    const frame = decodeSword2MouseFrame(anim, 0)!;

    expect(frame.ok).toBe(false);
    expect(Array.from(frame.pixels)).toEqual([0, 0, 200, 0, 0, 0, 0, 0]);
  });

  it('refuses a frame number the animation does not have', () => {
    const anim = parseSword2MouseAnim(mouseFile([[184]], 1, 1))!;
    expect(decodeSword2MouseFrame(anim, 1)).toBeNull();
  });

  it('refuses a resource whose offset table does not fit inside it', () => {
    // Four frames claimed, and nowhere near four offsets to read: the parse
    // has to answer null, because reading on would decode somebody else's
    // bytes as a picture rather than producing a short frame.
    const bytes = mouseFile([[184]], 1, 1);
    bytes[RES_HEADER_SIZE + 1] = 4;
    expect(parseSword2MouseAnim(bytes)).toBeNull();
  });

  it('stamps the frame onto the display by its hotspot, zero transparent', () => {
    const anim = parseSword2MouseAnim(mouseFile([[2, 200, 201, 3, 202]], 4, 2))!;
    const frame = decodeSword2MouseFrame(anim, 0)!;
    const screen = new Sword2Screen(null as never);
    const out = new Uint8Array(640 * 480);

    screen.setLuggage(frame, 100, 50);
    screen.present(out);

    // Hotspot -8,-8 subtracted: the image starts eight pixels *past* the
    // pointer, so what is being pointed at is not covered by what is carried.
    expect(out[58 * 640 + 110]).toBe(200);
    expect(out[58 * 640 + 111]).toBe(201);
    expect(out[59 * 640 + 111]).toBe(202);
    // The transparent pixels left the background alone.
    expect(out[58 * 640 + 108]).toBe(0);
    expect(out.reduce((count, pixel) => count + (pixel === 0 ? 0 : 1), 0)).toBe(3);
  });

  it('clips a frame the pointer has carried off the edge of the display', () => {
    const anim = parseSword2MouseAnim(mouseFile([[200, 201, 202, 203]], 2, 2, 0, 0))!;
    const frame = decodeSword2MouseFrame(anim, 0)!;
    const screen = new Sword2Screen(null as never);
    const out = new Uint8Array(640 * 480);

    screen.setLuggage(frame, 639, 479);
    screen.present(out);

    // One of the four pixels is on the display and the other three are not;
    // a blit without the clip would wrap them onto the next row.
    expect(out[479 * 640 + 639]).toBe(200);
    expect(out.reduce((count, pixel) => count + (pixel === 0 ? 0 : 1), 0)).toBe(1);
  });

  it('draws nothing at all once the luggage is put down', () => {
    const anim = parseSword2MouseAnim(mouseFile([[184]], 1, 1, 0, 0))!;
    const screen = new Sword2Screen(null as never);
    const out = new Uint8Array(640 * 480);

    screen.setLuggage(decodeSword2MouseFrame(anim, 0), 10, 10);
    screen.setLuggage(null, 10, 10);
    screen.present(out);

    expect(out.reduce((count, pixel) => count + (pixel === 0 ? 0 : 1), 0)).toBe(0);
  });
});
