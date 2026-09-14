/**
 * SCI32's list keys, its display list and its two resolutions.
 *
 * **Every fault here was found by a retail King's Quest VII and by nothing
 * else.** The 4,882 tests around this file, the 25 freely distributed demos and
 * the four fixture layouts all passed through them, because each one is a
 * bookkeeping error that a game only pays for once it is doing several things
 * at once — deleting an element it is about to walk, updating a screen item it
 * added a thousand frames ago, drawing artwork at one resolution over a script
 * written at another.
 *
 * So these are the standing versions of four specific measurements, written so
 * they fail without a game on the machine.
 */

import { describe, expect, it } from 'vitest';

import {
  celOrigin,
  isPlanePicture,
  Plane,
  planeKind,
  PLANE_PIC_COLOURED,
  PLANE_PIC_MAX,
  PLANE_PIC_OPAQUE,
  PLANE_PIC_TRANSPARENT,
  PLANE_PIC_TRANSPARENT_PICTURE,
  SciCompositor,
  screenItemSize,
} from '../src/engine/sci/gfx/Plane.js';
import { NULL_REG, reg } from '../src/engine/sci/script/PMachine.js';
import { SciHeap } from '../src/engine/sci/script/segments.js';

/** A cel of one flat colour, which is all the compositor needs to be asked about. */
function cel(width: number, height: number, colour = 1) {
  return {
    width,
    height,
    displaceX: 0,
    displaceY: 0,
    clearKey: 0xff,
    pixels: new Uint8Array(width * height).fill(colour),
  };
}

describe("a list's nodes carry keys", () => {
  /**
   * Sierra's `kNewNode` keys a node by its value when it is called with one
   * argument, and SCI2.1 calls it both ways. Keyed with nought instead, the
   * list still walks and nothing can ever be taken off it — which is the exact
   * shape of King's Quest VII's boot hang.
   */
  it('keys a one-argument node by its own value, so it can be deleted', () => {
    const heap = new SciHeap();
    const list = heap.newList();
    const value = reg(9, 1088);

    // One argument: the key defaults to the value.
    const node = heap.newNode(value, value);
    heap.addToFront(list, node);

    expect(heap.findKey(list, value)).toEqual(node);
    expect(heap.deleteKey(list, value)).toBe(true);
    expect(heap.list(list)?.first).toEqual(NULL_REG);
    expect(heap.list(list)?.last).toEqual(NULL_REG);
  });

  it('takes a key from the third argument of an add, as Sierra does', () => {
    const heap = new SciHeap();
    const list = heap.newList();
    const node = heap.newNode(reg(9, 10), NULL_REG);
    heap.addToEnd(list, node);
    expect(heap.findKey(list, reg(9, 77))).toEqual(NULL_REG);

    heap.setNodeKey(node, reg(9, 77));
    expect(heap.findKey(list, reg(9, 77))).toEqual(node);
  });

  it('inserts after the node named rather than appending', () => {
    const heap = new SciHeap();
    const list = heap.newList();
    const first = heap.newNode(reg(9, 1), reg(9, 1));
    const last = heap.newNode(reg(9, 3), reg(9, 3));
    heap.addToEnd(list, first);
    heap.addToEnd(list, last);

    const middle = heap.newNode(reg(9, 2), reg(9, 2));
    heap.addAfter(list, first, middle);

    const walked: number[] = [];
    for (let at = heap.list(list)?.first ?? NULL_REG; at.segment !== 0;) {
      const node = heap.node(at);
      if (!node) break;
      walked.push(node.value.offset);
      at = node.next;
    }
    expect(walked).toEqual([1, 2, 3]);
    expect(heap.node(heap.list(list)?.last ?? NULL_REG)?.value.offset).toBe(3);
  });

  it('moves a node to either end without losing the other end', () => {
    const heap = new SciHeap();
    const list = heap.newList();
    const a = heap.newNode(reg(9, 1), reg(9, 1));
    const b = heap.newNode(reg(9, 2), reg(9, 2));
    const c = heap.newNode(reg(9, 3), reg(9, 3));
    for (const node of [a, b, c]) heap.addToEnd(list, node);

    heap.moveToFront(list, c);
    expect(heap.list(list)?.first).toEqual(c);
    expect(heap.list(list)?.last).toEqual(b);

    heap.moveToEnd(list, c);
    expect(heap.list(list)?.first).toEqual(a);
    expect(heap.list(list)?.last).toEqual(c);
  });
});

describe("a cel's origin is not the pair in its header", () => {
  /**
   * `celobj32.cpp:1074`. The header holds a displacement from the bottom
   * centre, because that is where SCI puts an actor: at their feet.
   */
  it('puts a cel with no displacement at the middle of its bottom row', () => {
    expect(celOrigin({ width: 40, height: 20, displaceX: 0, displaceY: 0 })).toEqual({
      x: 20,
      y: 19,
    });
  });

  /**
   * The measurement this exists for. King's Quest VII's three menu buttons and
   * its name-entry panel are all authored to hang from their top left, which an
   * artist writes as `width/2` and `height-1` so the displacement cancels. Read
   * as an origin instead, each was pushed left by half its width and up by its
   * whole height: the panel, 473x332 placed at script (39,26), landed at
   * (-158,-245) with three quarters of itself off the screen.
   */
  it('cancels to nothing for an interface cel authored from its top left', () => {
    const buttons = [
      { width: 159, height: 63, displaceX: 79, displaceY: 62 },
      { width: 226, height: 62, displaceX: 113, displaceY: 61 },
      { width: 108, height: 65, displaceX: 54, displaceY: 64 },
      { width: 473, height: 332, displaceX: 236, displaceY: 331 },
    ];
    for (const button of buttons) expect(celOrigin(button)).toEqual({ x: 0, y: 0 });
  });

  /** A displacement is signed, and moves the origin either way. */
  it('takes a signed displacement in both directions', () => {
    expect(celOrigin({ width: 10, height: 10, displaceX: -3, displaceY: 4 })).toEqual({
      x: 8,
      y: 5,
    });
  });

  /**
   * A bitmap is the exception and is not one: SCI32 builds bitmaps with a real
   * origin of their own (`celobj32.cpp:1330`), so the caller puts that origin
   * in these fields and it is used as it stands.
   */
  it('takes a bitmap origin as it stands', () => {
    const bitmap = { width: 100, height: 40, displaceX: 7, displaceY: 9 };
    expect(celOrigin(bitmap, true)).toEqual({ x: 7, y: 9 });
    expect(celOrigin(bitmap)).toEqual({ x: 43, y: 30 });
  });

  /**
   * SCI16's `getCelRect` (`view.cpp`) arranges the same three terms
   * differently, and this is the assertion that the two families agree — the
   * reason one function can serve both.
   */
  it('agrees with the rectangle SCI16 computes for the same cel', () => {
    const cel = { width: 30, height: 24, displaceX: 5, displaceY: -2 };
    const [x, y] = [200, 150];
    const origin = celOrigin(cel);
    // SCI16: left = x + displaceX - (width >> 1); bottom = y + displaceY + 1.
    expect(x - origin.x).toBe(x + cel.displaceX - (cel.width >> 1));
    expect(y - origin.y + cel.height).toBe(y + cel.displaceY + 1);
  });
});

describe("a Plane's picture number", () => {
  /**
   * At or below 65531 it is a resource; above it, it says what kind of Plane
   * this is. Every SCI32 Plane King's Quest VII made asked this project for
   * "Picture 65535", and was told truly and uselessly that the game has not
   * got one.
   */
  it('tells a resource number from one of SCI32 own codes', () => {
    expect(isPlanePicture(10005)).toBe(true);
    expect(isPlanePicture(PLANE_PIC_MAX)).toBe(true);
    expect(isPlanePicture(0)).toBe(false);
    for (const code of [65532, 65533, 65534, 65535]) expect(isPlanePicture(code)).toBe(false);
  });
});

describe('a screen item is drawn at the size the display list says', () => {
  it('covers its cel exactly when it has no size of its own', () => {
    const plane = new Plane({ x: 0, y: 0, width: 64, height: 64 }, 0, null);
    const item = plane.add({ cel: cel(8, 8), x: 0, y: 0, priority: 0, visible: true });
    expect(screenItemSize(item)).toEqual({ width: 8, height: 8 });
  });

  /**
   * The SCI32 case: 320x200 artwork on a 640x480 screen. Doubled, the cel
   * covers four times the pixels and every one of them is the cel's colour —
   * a scaled blit that left gaps would show the background through an actor.
   */
  it('fills every pixel of a doubled cel, with no gaps', () => {
    const plane = new Plane({ x: 0, y: 0, width: 64, height: 64 }, 0, null);
    plane.add({
      cel: cel(8, 8, 5),
      x: 0,
      y: 0,
      size: { width: 16, height: 16 },
      priority: 0,
      visible: true,
    });

    const target = new Uint8Array(64 * 64);
    const compositor = new SciCompositor();
    compositor.add(plane);
    compositor.composite(target, 64, 64);

    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        expect(target[y * 64 + x], `pixel ${x},${y} of a doubled cel`).toBe(5);
      }
    }
    // And nothing outside it.
    expect(target[16 * 64 + 0]).toBe(0);
    expect(target[0 * 64 + 16]).toBe(0);
  });
});

describe('what a Plane draws when its picture number changes', () => {
  /**
   * `Plane::setType` (`plane32.cpp`), whose four cases were one apart from the
   * four constants this project had. The *range* was right either way — 65531
   * and below is a resource — so nothing showed it until a Plane's kind began
   * deciding what it paints.
   */
  it('maps each of SCI32 own codes to the kind Sierra maps it to', () => {
    expect(planeKind(PLANE_PIC_TRANSPARENT_PICTURE)).toBe('transparent-picture');
    expect(planeKind(PLANE_PIC_OPAQUE)).toBe('opaque');
    expect(planeKind(PLANE_PIC_TRANSPARENT)).toBe('transparent');
    expect(planeKind(PLANE_PIC_COLOURED)).toBe('coloured');
    expect(planeKind(PLANE_PIC_MAX)).toBe('picture');
    expect(planeKind(1251)).toBe('picture');
  });

  it('numbers those codes the way plane32.h numbers them', () => {
    expect(PLANE_PIC_TRANSPARENT_PICTURE).toBe(65532);
    expect(PLANE_PIC_OPAQUE).toBe(65533);
    expect(PLANE_PIC_TRANSPARENT).toBe(65534);
    expect(PLANE_PIC_COLOURED).toBe(65535);
  });

  /**
   * **The King's Quest VII fault, at the size it can be asserted.** One Plane
   * carries the title screen's Picture and then every chapter screen after it,
   * and a chapter screen's `picture` is `kPlanePicColored`. Without the delete
   * the title art stayed on that Plane for the rest of the game, lit by
   * whatever palette the new screen had loaded.
   */
  it('takes the old Picture off when the number becomes a colour, and leaves the cast', () => {
    const plane = new Plane({ x: 0, y: 0, width: 64, height: 64 }, 0, null);
    expect(plane.setPicture(10007, 0)).toBe(true);
    plane.add({ cel: cel(8, 8), x: 0, y: 0, priority: 0, visible: true, pictureId: 10007 });
    plane.add({ cel: cel(4, 4), x: 0, y: 0, priority: 1, visible: true });
    expect(plane.items).toHaveLength(2);

    expect(plane.setPicture(PLANE_PIC_COLOURED, 7)).toBe(false);
    expect(plane.items.map((item) => item.pictureId)).toEqual([undefined]);
    expect(plane.fill).toBe(7);
  });

  it('asks for a Picture once, however many times the same number arrives', () => {
    const plane = new Plane({ x: 0, y: 0, width: 64, height: 64 }, 0, null);
    expect(plane.setPicture(1251, -1)).toBe(true);
    expect(plane.setPicture(1251, -1)).toBe(false);
    expect(plane.fill).toBeNull();
  });

  /**
   * **A coloured Plane records its colour and paints nothing**, which is the
   * second time this has been decided and the first time it was decided by
   * looking at the screen.
   *
   * Sierra's `drawEraseList` paints only a `kPlaneTypeColored` Plane, so
   * "fill exactly those" reads as the faithful rule. King's Quest VII is why
   * it is not: its **interface** Plane is `kPlanePicColored` with a `back` of
   * nought, sits at priority 65535 over everything and covers the bottom third
   * of the screen. Filled, it puts a flat block across every screen in the
   * game — the main menu's "Quit" button is cut in half — which is exactly
   * what an owner playing it in a browser reported.
   *
   * And the artwork it hides was already being drawn: with the fill gone, the
   * bottom third of the first room is the game's inventory bar — monogram,
   * carried item, eye, crystal ball. The fill was painting over something that
   * worked, not standing in for something missing.
   */
  it('records a coloured Planes colour and paints nothing anywhere', () => {
    for (const code of [
      PLANE_PIC_COLOURED,
      PLANE_PIC_OPAQUE,
      PLANE_PIC_TRANSPARENT,
      PLANE_PIC_TRANSPARENT_PICTURE,
    ]) {
      const plane = new Plane({ x: 2, y: 2, width: 4, height: 4 }, 0, null);
      plane.setPicture(code, 9);
      // The colour is carried for a caller that learns to draw the interface.
      expect(plane.fill, `the colour a ${planeKind(code)} Plane declares`).toBe(
        code === PLANE_PIC_COLOURED ? 9 : null,
      );

      const target = new Uint8Array(8 * 8);
      const compositor = new SciCompositor();
      compositor.add(plane);
      compositor.composite(target, 8, 8);

      expect(
        [...target].some((pixel) => pixel !== 0),
        `a ${planeKind(code)} Plane painted`,
      ).toBe(false);
    }
  });

  /**
   * `AddPicAt` layers Pictures on one Plane, and `deleteDuplicate` — which
   * defaults to true — replaces one of them by number. King's Quest VII's
   * first gameplay room draws its whole background this way.
   */
  it('deletes one layered Picture by number and leaves the others', () => {
    const plane = new Plane({ x: 0, y: 0, width: 64, height: 64 }, 0, null);
    plane.add({ cel: cel(8, 8), x: 0, y: 0, priority: 0, visible: true, pictureId: 1251 });
    plane.add({ cel: cel(8, 8), x: 0, y: 0, priority: 0, visible: true, pictureId: 1252 });
    plane.add({ cel: cel(8, 8), x: 0, y: 0, priority: 0, visible: true });

    plane.deletePic(1251);
    expect(plane.items.map((item) => item.pictureId)).toEqual([1252, undefined]);

    plane.deleteAllPics();
    expect(plane.items.map((item) => item.pictureId)).toEqual([undefined]);
  });
});
