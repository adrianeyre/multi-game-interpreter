/**
 * The last Kernel calls, each against what ScummVM does.
 *
 * `sciKernelRemaining.ts` closed every missing column in the coverage table
 * and emptied the constant column of the surfaces SCI16 had answered with
 * nought. The coverage test proves each handler *reads* what it is passed;
 * this file proves each one does what ScummVM's does with it — the menu bar
 * answering `(menu << 8) | item`, the status line landing in the top ten rows,
 * the shake moving the framebuffer, the paint calls reaching all three
 * buffers, and SCI32's windows, dialogs and odd corners.
 *
 * Every world here is built by hand, so nothing needs SCI game data.
 */

import { describe, expect, it } from 'vitest';

import { Palette } from '../src/engine/gfx/Palette.js';
import { Screen } from '../src/engine/gfx/Screen.js';
import { Plane, SciCompositor } from '../src/engine/sci/gfx/Plane.js';
import type { SciFontResource } from '../src/engine/sci/gfx/SciFont.js';
import { SCI_MENU_ATTRIBUTE, SciMenuBar } from '../src/engine/sci/gfx/SciMenu.js';
import { SciPalette16 } from '../src/engine/sci/gfx/sciPalette16.js';
import {
  SCI_SCREEN_MASK,
  sciDrawCel,
  sciDrawLine,
  sciFillRect,
  sciOnControl,
  sciRestoreBox,
  sciSaveBox,
  type SciRoomSurface,
} from '../src/engine/sci/gfx/sciPaint16.js';
import { readSciPortrait } from '../src/engine/sci/gfx/SciPortrait.js';
import {
  SciScrollWindow,
  sciLineLength,
  stripSciTextCodes,
} from '../src/engine/sci/gfx/SciScrollWindow.js';
import { sciTextEditorKey } from '../src/engine/sci/gfx/sciTextEditor.js';
import { sci32CelLink } from '../src/engine/sci/gfx/sciCelLink.js';
import { SCI_EVENT, SciInput } from '../src/engine/sci/SciInput.js';
import { NULL_REG, reg, type Reg } from '../src/engine/sci/script/PMachine.js';
import { SCI_KERNEL, type SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import { SciPriorityBands } from '../src/engine/sci/script/sciKernelRemaining.js';
import { SciHeap } from '../src/engine/sci/script/segments.js';
import type { SciVersion } from '../src/engine/sci/sciVersion.js';

// ----------------------------------------------------------------- helpers ---

/** A font every glyph of which is a solid four-by-six block, eight rows apart. */
const FONT: SciFontResource = {
  lineHeight: 8,
  glyphs: Array.from({ length: 256 }, (_, code) => ({
    width: 4,
    height: 6,
    pixels: new Uint8Array(24).fill(code === 32 ? 0 : 1),
  })),
};

const SELECTORS = [
  'type',
  'message',
  'modifiers',
  'x',
  'y',
  'z',
  'claimed',
  'view',
  'loop',
  'cel',
  'priority',
  'signal',
];

interface FakeObject {
  id: Reg;
  variables: Reg[];
}

/** A world with a real heap and a real input queue, and objects by register. */
function makeWorld(version: SciVersion, extra: Partial<SciKernelWorld> = {}) {
  const heap = new SciHeap();
  const input = new SciInput();
  const objects = new Map<string, FakeObject>();
  const logged: string[] = [];
  let nextObject = 1;
  const world = {
    machine: {
      version,
      acc: NULL_REG,
      object: (value: Reg) => objects.get(`${value.segment}:${value.offset}`) ?? null,
      selectorNumbers: new Map(SELECTORS.map((name, index) => [name, index])),
      resolveProperty: (_object: unknown, selector: number) => selector,
      byteViewAt: () => null,
    },
    heap,
    input,
    log: (message: string) => logged.push(message),
    ticks: () => 0,
    ...extra,
  } as unknown as SciKernelWorld;

  const object = (values: Record<string, number>): Reg => {
    const id = reg(7, nextObject++);
    objects.set(`${id.segment}:${id.offset}`, {
      id,
      variables: SELECTORS.map((name) => ({ segment: 0, offset: (values[name] ?? 0) & 0xffff })),
    });
    return id;
  };
  const read = (id: Reg, name: string): number =>
    objects.get(`${id.segment}:${id.offset}`)?.variables[SELECTORS.indexOf(name)]?.offset ?? -1;
  const string = (text: string): Reg => {
    const ref = heap.allocate(text.length + 1);
    heap.bytes(ref)?.set([...text].map((c) => c.charCodeAt(0)));
    return ref;
  };
  return { world, heap, input, object, read, string, logged };
}

const int = (value: number): Reg => reg(0, value & 0xffff);

/** A menu bar with one menu of four items, one a separator, one disabled. */
function fileMenu() {
  const bar = new SciMenuBar({ font: () => FONT, white: 15 });
  const setup = makeWorld('sci0-late', { menuBar: bar, colourCount: () => 16 });
  SCI_KERNEL.AddMenu(setup.world, [
    setup.string('File'),
    setup.string('Save Game`#5:Restore`#7:--!:Quit`^q'),
  ]);
  SCI_KERNEL.AddMenu(setup.world, [setup.string('Edit'), setup.string('Undo:Redo')]);
  return { bar, ...setup };
}

// ------------------------------------------------------------------ menus ---

describe('the SCI16 menu bar', () => {
  it('reads AddMenu’s packed string the way GfxMenu::kernelAddEntry does', () => {
    const { bar } = fileMenu();
    const items = bar.items.filter((item) => item.menuId === 1);
    expect(items.map((item) => item.id)).toEqual([1, 2, 3, 4]);
    expect(items[0]).toMatchObject({ text: 'Save Game', rightText: 'F5', keyPress: 63 << 8 });
    expect(items[1]).toMatchObject({ text: 'Restore', keyPress: 65 << 8 });
    expect(items[2].separator).toBe(true);
    // `^q` is Ctrl+Q: the marker becomes the display's control glyph and the
    // key is matched lower-case.
    expect(items[3]).toMatchObject({
      text: 'Quit',
      rightText: '\x03Q',
      keyPress: 'q'.charCodeAt(0),
      keyModifier: 4,
    });
    // Each item's text reference points into the string the game passed.
    expect(items[1].textRef.offset - items[0].textRef.offset).toBe('Save Game`#5:'.length);
  });

  it('answers SetMenu and GetMenu per attribute, and ignores an item it never made', () => {
    const { world, string } = fileMenu();
    const id = int((1 << 8) | 2);
    expect(SCI_KERNEL.GetMenu(world, [id, int(SCI_MENU_ATTRIBUTE.enabled)]).offset).toBe(1);
    SCI_KERNEL.SetMenu(world, [id, int(SCI_MENU_ATTRIBUTE.enabled), NULL_REG]);
    expect(SCI_KERNEL.GetMenu(world, [id, int(SCI_MENU_ATTRIBUTE.enabled)]).offset).toBe(0);

    const label = string('Load');
    SCI_KERNEL.SetMenu(world, [
      id,
      int(SCI_MENU_ATTRIBUTE.text),
      label,
      int(SCI_MENU_ATTRIBUTE.tag),
      int(9),
    ]);
    expect(SCI_KERNEL.GetMenu(world, [id, int(SCI_MENU_ATTRIBUTE.text)])).toEqual(label);
    expect(SCI_KERNEL.GetMenu(world, [id, int(SCI_MENU_ATTRIBUTE.tag)]).offset).toBe(9);

    // PQ2's demo sets attributes on a menu it never built; Sierra ignored it.
    expect(() =>
      SCI_KERNEL.SetMenu(world, [int(0x0909), int(SCI_MENU_ATTRIBUTE.enabled), int(1)]),
    ).not.toThrow();
  });

  it('answers a hot key with (menu << 8) | item and claims the event', () => {
    const { world, object, read } = fileMenu();
    // Ctrl+Q arrives as the control character 17 with the Ctrl bit.
    const event = object({ type: SCI_EVENT.keyDown, message: 17, modifiers: 4 });
    expect(SCI_KERNEL.MenuSelect(world, [event]).offset).toBe((1 << 8) | 4);
    expect(read(event, 'claimed')).toBe(1);

    const other = object({ type: SCI_EVENT.keyDown, message: 'z'.charCodeAt(0) });
    expect(SCI_KERNEL.MenuSelect(world, [other])).toEqual(NULL_REG);
    expect(read(other, 'claimed')).toBe(0);
  });

  it('plays an ESC session over queued keys, skipping the separator', () => {
    const { world, input, object, bar } = fileMenu();
    for (const message of [0x5000, 0x5000, 13]) {
      input.post({ type: SCI_EVENT.keyDown, message, modifiers: 0, x: 0, y: 0 });
    }
    const event = object({ type: SCI_EVENT.keyDown, message: 27 });
    // Down to Restore, down past the separator to Quit, Enter.
    expect(SCI_KERNEL.MenuSelect(world, [event]).offset).toBe((1 << 8) | 4);
    expect(bar.open).toBe(false);
    expect(bar.overlay).toBeNull();
  });

  it('holds an open pull-down for the engine and answers on the next MenuSelect', () => {
    let held = 0;
    const { world, object, bar, read } = fileMenu();
    (world as { holdForMenu?: () => void }).holdForMenu = () => held++;
    const escape = object({ type: SCI_EVENT.keyDown, message: 27 });

    expect(SCI_KERNEL.MenuSelect(world, [escape])).toEqual(NULL_REG);
    expect(read(escape, 'claimed')).toBe(1);
    expect(bar.open).toBe(true);
    expect(held).toBe(1);
    // The bar is drawn in white with the open menu's title inverted and the
    // pull-down hanging from the bottom of the bar.
    expect(bar.overlay?.bar.pixels[3 * 320 + 2]).toBe(15);
    expect(bar.overlay?.dropdown).toMatchObject({ y: 9 });

    // Right to Edit, then Enter: Undo.
    expect(
      bar.feed({ type: SCI_EVENT.keyDown, message: 0x4d00, modifiers: 0, x: 0, y: 0 }),
    ).toEqual({ done: false });
    const result = bar.feed({ type: SCI_EVENT.keyDown, message: 13, modifiers: 0, x: 0, y: 0 });
    expect(result).toMatchObject({ done: true, item: { menuId: 2, id: 1 } });
    bar.pending = result.done ? result.item : null;

    const next = object({ type: SCI_EVENT.keyDown, message: 0 });
    expect(SCI_KERNEL.MenuSelect(world, [next]).offset).toBe((2 << 8) | 1);
    expect(read(next, 'claimed')).toBe(1);
  });

  it('follows the mouse from a title down to an item and chooses on release', () => {
    const { world, object, bar } = fileMenu();
    const press = object({ type: SCI_EVENT.mouseDown, x: 10, y: 3 });
    SCI_KERNEL.MenuSelect(world, [press]);
    expect(bar.open).toBe(true);
    // Row two of the pull-down is y 18 to 25: rows start at 10, eight apart.
    bar.feed({ type: 0, message: 0, modifiers: 0, x: 20, y: 20 });
    const chosen = bar.feed({ type: SCI_EVENT.mouseUp, message: 0, modifiers: 0, x: 20, y: 20 });
    expect(chosen).toMatchObject({ done: true, item: { menuId: 1, id: 2 } });
  });

  it('draws the status line into the top ten rows, with the tenth black', () => {
    const { world, bar, string } = fileMenu();
    SCI_KERNEL.DrawStatus(world, [string('Score: 0'), int(0), int(7)]);
    expect(bar.statusShown).toBe(true);
    // Text starts at (0, 1): row 0 is the back colour, row 1 is ink.
    expect(bar.status[0]).toBe(7);
    expect(bar.status[320 + 0]).toBe(0);
    expect(bar.status[9 * 320 + 100]).toBe(0);

    SCI_KERNEL.DrawMenuBar(world, [int(1)]);
    // White, with "File" from x 8.
    expect(bar.status[320 + 4]).toBe(15);
    expect(bar.status[320 + 8]).toBe(0);
    SCI_KERNEL.DrawMenuBar(world, [NULL_REG]);
    expect(bar.status[320 + 8]).toBe(0);
    expect(bar.status[320 + 4]).toBe(0);
  });
});

// ------------------------------------------------------------ ShakeScreen ---

describe('ShakeScreen', () => {
  it('moves the presented frame down for three frames and back for three', async () => {
    const { SciEngine } = await import('../src/engine/sci/SciEngine.js');
    const engine = Object.create(SciEngine.prototype) as Record<string, unknown> & {
      render(): void;
      world(): SciKernelWorld;
    };
    const compositor = new SciCompositor();
    const plane = new Plane({ x: 0, y: 0, width: 320, height: 200 });
    plane.background = new Uint8Array(320 * 200);
    plane.background[0] = 9;
    compositor.add(plane);
    const screen = new Screen(320, 200);
    Object.assign(engine, {
      compositor,
      screen,
      shakes: [],
      shaken: false,
      statusPlane: null,
      menuPlane: null,
      movies: { paint: () => undefined },
      resources: { isSci32: false },
      machine: { version: 'sci1-early', acc: NULL_REG },
      cachedWorld: null,
    });

    engine.render();
    expect(screen.pixels[0]).toBe(9);

    SCI_KERNEL.ShakeScreen(engine.world(), [int(1), int(1)]);
    engine.render();
    // Ten rows down, and black where the frame moved away from.
    expect(screen.pixels[0]).toBe(0);
    expect(screen.pixels[10 * 320]).toBe(9);
    engine.render();
    engine.render();
    engine.render();
    expect(screen.pixels[0]).toBe(9);
    expect(screen.pixels[10 * 320]).toBe(0);
  });
});

describe('the menu bar on the engine', () => {
  async function engineWithMenu() {
    const { SciEngine } = await import('../src/engine/sci/SciEngine.js');
    const engine = Object.create(SciEngine.prototype) as Record<string, unknown> & {
      render(): void;
      pumpMenu(): void;
    };
    const compositor = new SciCompositor();
    const menuBar = new SciMenuBar({ font: () => FONT, white: 15 });
    const input = new SciInput();
    let soundOn = true;
    Object.assign(engine, {
      compositor,
      screen: new Screen(320, 200),
      shakes: [],
      shaken: false,
      menuBar,
      input,
      menuHold: { soundWas: true, paused: true },
      sound: {
        get isEnabled() {
          return soundOn;
        },
        setEnabled: (on: boolean) => (soundOn = on),
      },
      statusPlane: compositor.add(new Plane({ x: 0, y: 0, width: 320, height: 10 }, 1)),
      menuPlane: compositor.add(new Plane({ x: 0, y: 0, width: 320, height: 200 }, 1000)),
      movies: { paint: () => undefined },
    });
    return {
      engine,
      menuBar,
      input,
      sound: () => soundOn,
      setSound: (on: boolean) => (soundOn = on),
    };
  }

  it('shows the status line in the framebuffer’s top ten rows', async () => {
    const { engine, menuBar } = await engineWithMenu();
    engine.render();
    menuBar.drawStatus('Hi', 4, 2);
    engine.render();
    const pixels = (engine.screen as Screen).pixels;
    expect(pixels[0]).toBe(2);
    expect(pixels[320 + 1]).toBe(4);
    expect(pixels[9 * 320]).toBe(0);
  });

  it('feeds a held pull-down between cycles and queues its answer for the game', async () => {
    const { engine, menuBar, input, sound, setSound } = await engineWithMenu();
    menuBar.add('File', 'Open:Close', NULL_REG);
    menuBar.begin('keyboard', { type: 4, message: 27, modifiers: 0, x: 0, y: 0 });
    setSound(false);
    engine.render();
    // The open pull-down is drawn over the room: its bar is white.
    expect((engine.screen as Screen).pixels[3 * 320 + 2]).toBe(15);

    input.post({ type: SCI_EVENT.keyDown, message: 0x5000, modifiers: 0, x: 0, y: 0 });
    input.post({ type: SCI_EVENT.keyDown, message: 13, modifiers: 0, x: 0, y: 0 });
    engine.pumpMenu();
    expect(menuBar.open).toBe(false);
    expect(menuBar.pending).toMatchObject({ menuId: 1, id: 2 });
    // The sound the pull-down paused is back, and an event is waiting so the
    // game's menu bar calls MenuSelect and hears the answer.
    expect(sound()).toBe(true);
    expect(input.next(SCI_EVENT.keyDown)).toMatchObject({ message: 0 });
  });
});

// ------------------------------------------------------- Graph and friends ---

function room(visual = true): SciRoomSurface & { items: unknown[] } {
  const items: unknown[] = [];
  return {
    width: 20,
    height: 10,
    visual: visual ? new Uint8Array(200).fill(15) : null,
    priority: new Uint8Array(200),
    control: new Uint8Array(200),
    items,
    addItem: (cel, x, y, priority) => items.push({ cel, x, y, priority }),
    itemCount: () => items.length,
    truncateItems: (count) => {
      items.length = count;
    },
  };
}

describe('SCI16 drawing onto the room', () => {
  it('fills each buffer the mask names, four-bit for priority and control', () => {
    const surface = room();
    sciFillRect(surface, { left: 2, top: 1, right: 4, bottom: 3 }, 7, 3, 0x1e, 0x2f);
    expect(surface.visual?.[1 * 20 + 2]).toBe(3);
    expect(surface.priority?.[2 * 20 + 3]).toBe(0x0e);
    expect(surface.control?.[2 * 20 + 3]).toBe(0x0f);
    expect(surface.visual?.[3 * 20 + 2]).toBe(15);
  });

  it('rules a line with both ends set, leaving a -1 buffer alone', () => {
    const surface = room();
    sciDrawLine(surface, { x: 0, y: 0 }, { x: 5, y: 2 }, 4, -1, 6);
    expect(surface.visual?.[0]).toBe(4);
    expect(surface.visual?.[2 * 20 + 5]).toBe(4);
    expect(surface.control?.[2 * 20 + 5]).toBe(6);
    expect(surface.priority?.every((value) => value === 0)).toBe(true);
  });

  it('saves a box and puts it back', () => {
    const surface = room();
    const saved = sciSaveBox(surface, { left: 0, top: 0, right: 5, bottom: 5 }, 7);
    sciFillRect(surface, { left: 0, top: 0, right: 5, bottom: 5 }, 7, 1, 2, 3);
    sciRestoreBox(surface, saved);
    expect(surface.visual?.[22]).toBe(15);
    expect(surface.control?.[22]).toBe(0);
  });

  it('draws a cel behind higher priority and over lower, and -1 over all', () => {
    const surface = room();
    surface.priority?.fill(5);
    const cel = {
      width: 2,
      height: 1,
      displaceX: 0,
      displaceY: 0,
      clearKey: 0,
      pixels: new Uint8Array([8, 0]),
    };
    sciDrawCel(surface, cel, 0, 0, 4);
    expect(surface.visual?.[0]).toBe(15);
    sciDrawCel(surface, cel, 0, 0, 6);
    expect(surface.visual?.[0]).toBe(8);
    expect(surface.priority?.[0]).toBe(6);
    // The clear key leaves what is underneath.
    expect(surface.visual?.[1]).toBe(15);
    sciDrawCel(surface, { ...cel, pixels: new Uint8Array([9, 0]) }, 0, 0, -1);
    expect(surface.visual?.[0]).toBe(9);
    expect(surface.priority?.[0]).toBe(6);
  });

  it('reports one bit per control value under a rectangle', () => {
    const surface = room();
    surface.control?.set([1, 3], 0);
    expect(
      sciOnControl(surface, SCI_SCREEN_MASK.control, { left: 0, top: 0, right: 2, bottom: 1 }),
    ).toBe((1 << 1) | (1 << 3));
    expect(
      sciOnControl(surface, SCI_SCREEN_MASK.priority, { left: 0, top: 0, right: 1, bottom: 1 }),
    ).toBe(1);
  });

  it('draws onto a cel Picture with screen items, and RestoreBox takes them off', () => {
    const surface = room(false);
    const saved = sciSaveBox(surface, { left: 0, top: 0, right: 20, bottom: 10 }, 7);
    sciFillRect(surface, { left: 0, top: 0, right: 3, bottom: 3 }, 1, 12, 0, 0);
    sciDrawLine(surface, { x: 0, y: 5 }, { x: 4, y: 5 }, 2, -1, -1);
    expect(surface.items).toHaveLength(2);
    sciRestoreBox(surface, saved);
    expect(surface.items).toHaveLength(0);
  });
});

describe('the Graph, OnControl, DrawCel and AddToPic Kernel calls', () => {
  function graphWorld() {
    const calls: Array<[string, ...unknown[]]> = [];
    const graph16 = {
      drawLine: (...a: unknown[]) => calls.push(['drawLine', ...a]),
      fillBox: (...a: unknown[]) => calls.push(['fillBox', ...a]),
      saveBox: (...a: unknown[]) => (calls.push(['saveBox', ...a]), 5),
      restoreBox: (...a: unknown[]) => calls.push(['restoreBox', ...a]),
      drawCel: (...a: unknown[]) => calls.push(['drawCel', ...a]),
      onControl: (...a: unknown[]) => (calls.push(['onControl', ...a]), 0x8002),
      portColours: () => ({ pen: 3, back: 11 }),
      invertRect: (...a: unknown[]) => calls.push(['invertRect', ...a]),
    };
    const setup = makeWorld('sci1-early', {
      graph16,
      colourCount: () => 16,
      celRect: () => ({ left: 10, top: 40, right: 30, bottom: 100 }),
    } as Partial<SciKernelWorld>);
    return { ...setup, calls };
  }

  it('reads Graph’s arguments in Sierra’s y-before-x order', () => {
    const { world, calls } = graphWorld();
    expect(SCI_KERNEL.Graph(world, [int(2)]).offset).toBe(16);
    SCI_KERNEL.Graph(world, [int(4), int(10), int(20), int(30), int(40), int(0x13)]);
    // EGA colours are four-bit, and a missing priority and control are -1.
    expect(calls.at(-1)).toEqual(['drawLine', { x: 20, y: 10 }, { x: 40, y: 30 }, 3, -1, -1]);
    expect(SCI_KERNEL.Graph(world, [int(7), int(50), int(60), int(5), int(6), int(3)]).offset).toBe(
      5,
    );
    // Put in order: left 6, top 5, right 60, bottom 50.
    expect(calls.at(-1)).toEqual(['saveBox', { left: 6, top: 5, right: 60, bottom: 50 }, 3]);
    SCI_KERNEL.Graph(world, [int(9), int(0), int(0), int(4), int(4)]);
    expect(calls.at(-1)?.[3]).toBe(11);
    SCI_KERNEL.Graph(world, [int(10), int(0), int(0), int(4), int(4)]);
    expect(calls.at(-1)?.[3]).toBe(3);
  });

  it('reads OnControl’s three forms', () => {
    const { world, calls } = graphWorld();
    expect(SCI_KERNEL.OnControl(world, [int(5), int(6)]).offset).toBe(0x8002);
    expect(calls.at(-1)).toEqual(['onControl', 4, { left: 5, top: 6, right: 6, bottom: 7 }]);
    SCI_KERNEL.OnControl(world, [int(2), int(5), int(6)]);
    expect(calls.at(-1)).toEqual(['onControl', 2, { left: 5, top: 6, right: 6, bottom: 7 }]);
    SCI_KERNEL.OnControl(world, [int(4), int(1), int(2), int(3), int(4)]);
    expect(calls.at(-1)).toEqual(['onControl', 4, { left: 1, top: 2, right: 3, bottom: 4 }]);
  });

  it('draws a cel with no priority as -1', () => {
    const { world, calls } = graphWorld();
    SCI_KERNEL.DrawCel(world, [int(100), int(1), int(2), int(30), int(40)]);
    expect(calls.at(-1)).toEqual(['drawCel', 100, 1, 2, 30, 40, -1]);
  });

  it('stamps AddToPic’s cel and blocks the floor from its band down', () => {
    const { world, calls } = graphWorld();
    SCI_KERNEL.AddToPic(world, [int(100), int(0), int(0), int(20), int(99), int(-1), int(15)]);
    // Priority from y 99 in the default bands is 6, whose band starts at y 95.
    expect(calls[0]).toEqual(['drawCel', 100, 0, 0, 10, 40, 6]);
    expect(calls[1]).toEqual([
      'fillBox',
      { left: 10, top: 94, right: 30, bottom: 100 },
      4,
      0,
      0,
      15,
    ]);
  });

  it('moves the priority bands with Graph(AdjustPriority), which CoordPri then reads', () => {
    const { world } = graphWorld();
    expect(SCI_KERNEL.CoordPri(world, [int(100)]).offset).toBe(6);
    SCI_KERNEL.Graph(world, [int(14), int(0), int(140)]);
    // Fourteen bands over 0..140 are ten rows each, so y 100 is in band 11.
    expect(SCI_KERNEL.CoordPri(world, [int(100)]).offset).toBe(11);
  });

  it('keeps the old CoordPri formula exactly by default', () => {
    const bands = new SciPriorityBands();
    for (let y = -5; y < 200; y++) {
      const old = Math.max(0, Math.min(14, Math.floor(((y - 42) * 14) / 148) + 1));
      expect(bands.coordinateToPriority(y)).toBe(old);
    }
    expect(bands.priorityToCoordinate(1)).toBe(42);
  });
});

// ---------------------------------------------------------------- Palette ---

describe('Palette', () => {
  function paletteWorld(version: SciVersion) {
    const palette = new Palette();
    for (let i = 0; i < 256; i++) palette.setColor(i, i, 0, 0);
    const palette16 = new SciPalette16(palette);
    const setup = makeWorld(version, {
      palette16,
      colourCount: () => 256,
    } as Partial<SciKernelWorld>);
    return { ...setup, palette, palette16 };
  }

  it('finds the nearest colour among the entries in use', () => {
    const { world } = paletteWorld('sci1-early');
    expect(SCI_KERNEL.Palette(world, [int(5), int(40), int(0), int(0)]).offset).toBe(40);
    SCI_KERNEL.Palette(world, [int(3), int(40), int(41), int(1)]);
    expect(SCI_KERNEL.Palette(world, [int(5), int(40), int(0), int(0)]).offset).toBe(41);
  });

  it('dims a range by percentage and back', () => {
    const { world, palette, palette16 } = paletteWorld('sci1-early');
    SCI_KERNEL.Palette(world, [int(4), int(1), int(200), int(50)]);
    expect(palette16.intensity[100]).toBe(50);
    palette.flush();
    expect(palette.rgba[100 * 4]).toBe(50);
  });

  it('rotates a range on its own timer, and saves and restores the lot', () => {
    let now = 0;
    const setup = paletteWorld('sci1-early');
    (setup.world as { ticks: () => number }).ticks = () => now;
    const saved = SCI_KERNEL.Palette(setup.world, [int(7)]);
    expect(setup.heap.bytes(saved)?.length).toBe(1024);

    SCI_KERNEL.Palette(setup.world, [int(6), int(10), int(13), int(2)]);
    expect(setup.palette.getColor(10)[0]).toBe(10);
    now = 2;
    SCI_KERNEL.Palette(setup.world, [int(6), int(10), int(13), int(2)]);
    expect([10, 11, 12].map((i) => setup.palette.getColor(i)[0])).toEqual([11, 12, 10]);

    expect(SCI_KERNEL.Palette(setup.world, [int(8), saved])).toEqual(saved);
    expect(setup.palette.getColor(10)[0]).toBe(10);
  });

  it('dispatches SCI32’s four sub-functions instead', () => {
    let fade: number[] = [];
    const { world } = paletteWorld('sci2');
    (world as { paletteFade?: unknown }).paletteFade = (...a: number[]) => (fade = a);
    expect(SCI_KERNEL.Palette(world, [int(3), int(99), int(0), int(0)]).offset).toBe(99);
    SCI_KERNEL.Palette(world, [int(2), int(0), int(255), int(30)]);
    expect(fade).toEqual([0, 255, 30]);
  });
});

// --------------------------------------------------------------- Portrait ---

/** A one-bitmap portrait file: two colours, a two-by-two face, no lip-sync. */
function portraitFile(): Uint8Array {
  const bytes: number[] = [];
  const u16 = (value: number) => bytes.push(value & 0xff, value >> 8);
  const u32 = (value: number) => (u16(value & 0xffff), u16(value >>> 16));
  bytes.push(...'WIN'.split('').map((c) => c.charCodeAt(0)));
  u16(2); // width
  u16(2); // height
  u16(1); // bitmaps
  u16(0);
  u16(0); // lip-sync IDs
  u16(6); // palette size
  u16(0);
  bytes.push(0, 0, 255, 0, 255, 0); // BGR: red, green
  u16(0);
  u16(2);
  u16(2);
  u16(2); // stride
  bytes.push(0, 0, 0, 0, 0, 0);
  bytes.push(0, 1, 1, 0);
  u32(28);
  for (let i = 0; i < 14; i++) bytes.push(0);
  u16(4);
  u16(6);
  for (let i = 0; i < 10; i++) bytes.push(0);
  u32(0);
  u32(0x220);
  return new Uint8Array(bytes);
}

describe('Portrait', () => {
  it('reads a .BIN portrait: palette, face and displacement', () => {
    const portrait = readSciPortrait(portraitFile());
    expect(portrait).not.toBeNull();
    expect(portrait?.palette).toEqual([
      [255, 0, 0],
      [0, 255, 0],
    ]);
    expect(portrait?.bitmaps[0]).toMatchObject({ width: 2, height: 2, displaceX: 4, displaceY: 6 });
    expect([...(portrait?.bitmaps[0].pixels ?? [])]).toEqual([0, 1, 1, 0]);
    expect(readSciPortrait(new Uint8Array(20))).toBeNull();
  });

  it('loads by name, shows with SIGNAL_REG, and answers nought for a missing file', () => {
    const loaded: string[] = [];
    let shown: unknown = null;
    const { world, string } = makeWorld('sci1-1', {
      portraitLoad: (name: string) => loaded.push(name),
      portraitShow: (request: { name: string }) => ((shown = request), request.name !== 'nobody'),
    } as Partial<SciKernelWorld>);
    expect(SCI_KERNEL.Portrait(world, [int(0), string('alex')])).toEqual(NULL_REG);
    expect(loaded).toEqual(['alex']);
    const show = (name: string) =>
      SCI_KERNEL.Portrait(world, [
        int(1),
        string(name),
        int(10),
        int(20),
        int(899),
        int(0x101),
        int(2),
        int(3),
        int(4),
        int(0),
      ]);
    expect(show('alex').offset).toBe(0xffff);
    expect(shown).toMatchObject({ name: 'alex', x: 10, y: 20, resource: 899, noun: 1, seq: 4 });
    expect(show('nobody')).toEqual(NULL_REG);
  });

  it('merges a portrait’s colours into entries the palette has free', () => {
    const palette = new Palette();
    const palette16 = new SciPalette16(palette);
    palette16.unsetFlag(200, 256, 1);
    palette.setColor(5, 0, 255, 0);
    const mapping = palette16.merge([
      [255, 0, 0],
      [0, 255, 0],
    ]);
    // Red has no exact match and takes the first free entry; green matches 5.
    expect(mapping[0]).toBe(200);
    expect(palette.getColor(200)).toEqual([255, 0, 0]);
    expect(mapping[1]).toBe(5);
  });
});

// ------------------------------------------------------------ SCI32 calls ---

describe('ScrollWindow', () => {
  const window = (maxEntries = 10) =>
    new SciScrollWindow({
      width: 40,
      height: 16,
      maxEntries,
      lineLength: (text, start, width) => sciLineLength(text, start, width, () => 4),
      pageLength: (text, width) => {
        let at = 0;
        for (let line = 0; line < 2 && at < text.length; line++) {
          at += sciLineLength(text, at, width, () => 4);
        }
        return at;
      },
    });

  it('breaks lines at the last space that fits and skips control codes', () => {
    expect(sciLineLength('hello world again', 0, 40, () => 4)).toBe(6);
    expect(sciLineLength('|c3|hello', 0, 40, () => 4)).toBe(9);
    expect(stripSciTextCodes('|f2||c3|hi|x')).toBe('hi|x');
  });

  it('keeps Sierra’s line model through add, page and go', () => {
    const scroll = window();
    for (const line of ['one\n', 'two\n', 'three\n', 'four\n']) scroll.add(line, -1, -1, -1, false);
    expect(scroll.lineCount).toBe(4);
    expect(scroll.visibleLines()).toEqual(['one', 'two']);
    scroll.pageDown();
    expect(scroll.visibleLines()).toEqual(['three', 'four']);
    expect(scroll.where).toEqual({ top: 2, lines: 4 });
    scroll.upArrow();
    expect(scroll.topLine).toBe(1);
    scroll.home();
    expect(scroll.topLine).toBe(0);
    scroll.go(1, 2);
    expect(scroll.topLine).toBe(2);
  });

  it('drops the oldest entry at the limit and modifies by ID', () => {
    const scroll = window(2);
    const first = scroll.add('a\n', 3, -1, -1, true);
    scroll.add('b\n', -1, -1, -1, true);
    scroll.add('c\n', -1, -1, -1, true);
    expect(scroll.lineCount).toBe(2);
    expect(scroll.modify(first, 'x', -1, -1, -1, true)).toBe(first);
    expect(scroll.modify(99, 'x', -1, -1, -1, true)).toBe(0);
  });

  it('dispatches the Kernel sub-functions onto the host', () => {
    const scroll = window();
    const changed: number[] = [];
    let created: unknown = null;
    const { world, string, object } = makeWorld('sci2', {
      scrollWindows: {
        create: (request: unknown) => ((created = request), 10000),
        window: (id: number) => (id === 10000 ? scroll : null),
        changed: (id: number) => changed.push(id),
        show: () => undefined,
        hide: () => undefined,
        destroy: () => undefined,
      },
    } as Partial<SciKernelWorld>);
    expect(SCI_KERNEL.ScrollWindow(world, [int(0), object({}), int(5)]).offset).toBe(10000);
    expect(created).toMatchObject({ maxEntries: 5 });
    expect(
      SCI_KERNEL.ScrollWindow(world, [
        int(1),
        int(10000),
        string('hi\n'),
        int(-1),
        int(-1),
        int(-1),
      ]).offset,
    ).toBe(1);
    expect(changed).toEqual([10000]);
    expect(SCI_KERNEL.ScrollWindow(world, [int(10), int(10000), int(100)]).offset).toBe(0);
  });
});

describe('InputText and MessageBox', () => {
  it('edits the way processEditTextEvent does', () => {
    const state = {
      text: 'old',
      cursor: 0,
      maxLength: 5,
      clearOnInput: true,
      overwrite: false,
      boxWidth: 100,
      measure: (text: string) => text.length * 4,
    };
    // The first printable key replaces the default text.
    sciTextEditorKey(state, 'a'.charCodeAt(0));
    expect(state.text).toBe('a');
    for (const c of 'bcdef') sciTextEditorKey(state, c.charCodeAt(0));
    expect(state.text).toBe('abcde');
    sciTextEditorKey(state, 75 << 8);
    sciTextEditorKey(state, 8);
    expect(state.text).toBe('abce');
  });

  it('plays queued keys, writes the text back and answers whether Enter ended it', () => {
    const { world, input, string, heap } = makeWorld('sci2', {
      measureText: (text: string) => ({ width: text.length * 4, height: 8 }),
    } as Partial<SciKernelWorld>);
    const target = heap.newArray(3, 8);
    for (const message of ['h', 'i'].map((c) => c.charCodeAt(0)).concat(13)) {
      input.post({ type: SCI_EVENT.keyDown, message, modifiers: 0, x: 0, y: 0 });
    }
    expect(SCI_KERNEL.InputText(world, [target, string('Name?'), int(10)]).offset).toBe(1);
    expect([0, 1, 2].map((i) => heap.arrayAt(target, i))).toEqual([104, 105, 0]);
  });

  it('answers MessageBox as Windows does', () => {
    let reply: boolean | undefined = false;
    const { world, string } = makeWorld('sci2', {
      messageBox: () => reply,
    } as Partial<SciKernelWorld>);
    expect(SCI_KERNEL.MessageBox(world, [string('Quit?'), string('KQ7'), int(4)]).offset).toBe(7);
    reply = true;
    expect(SCI_KERNEL.MessageBox(world, [string('Quit?'), string('KQ7'), int(4)]).offset).toBe(6);
    expect(SCI_KERNEL.MessageBox(world, [string('Saved'), string('KQ7'), int(0)]).offset).toBe(1);
  });
});

describe('MovePlaneItems, SetHotRectangles, CelLink and the rest', () => {
  it('moves the objects behind the items a Plane moved', () => {
    const setup = makeWorld('sci2-1-middle');
    const actor = setup.object({ x: 10, y: 20 });
    (setup.world as { movePlaneItems?: unknown }).movePlaneItems = () => [
      `${actor.segment}:${actor.offset}`,
    ];
    SCI_KERNEL.MovePlaneItems(setup.world, [reg(7, 99), int(-5), int(3)]);
    expect(setup.read(actor, 'x')).toBe(5);
    expect(setup.read(actor, 'y')).toBe(23);
  });

  it('reports the pointer entering, crossing and leaving hot rectangles', () => {
    const { world, heap, input } = makeWorld('sci2-1-middle');
    const rects = heap.newArray(0, 8);
    [0, 0, 9, 9, 20, 0, 29, 9].forEach((value, index) => heap.arrayPut(rects, index, value));
    SCI_KERNEL.SetHotRectangles(world, [int(2), rects]);

    const hot = () => {
      const seen: number[] = [];
      for (let e = input.next(SCI_EVENT.hotRectangle); e; e = input.next(SCI_EVENT.hotRectangle)) {
        seen.push(e.message);
      }
      return seen;
    };
    input.moveTo(5, 5);
    expect(hot()).toEqual([0]);
    input.moveTo(25, 5);
    // Straight from one into another: -1 first, then the new one.
    expect(hot()).toEqual([-1, 1]);
    input.moveTo(15, 5);
    expect(hot()).toEqual([-1]);
    SCI_KERNEL.SetHotRectangles(world, [int(0)]);
    input.moveTo(5, 5);
    expect(hot()).toEqual([]);
  });

  it('reads a cel’s link point from a version 0x84 View', () => {
    const view = new Uint8Array(200);
    const put16 = (at: number, value: number) => view.set([value & 0xff, (value >> 8) & 0xff], at);
    put16(0, 16); // header size: loops start at 18
    view[2] = 1; // loops
    view[12] = 16; // loop header size
    view[13] = 52; // cel header size
    view[18] = 0x84;
    view[18 + 0] = 0xff; // not a mirror
    view[18 + 2] = 1; // cels
    put16(18 + 12, 60); // cel headers at 60
    put16(60, 20); // width
    put16(60 + 36, 150); // link table
    put16(60 + 40, 1); // one link
    put16(150, 7);
    put16(152, 9);
    view[154] = 3;
    expect(sci32CelLink(view, 0, 0, 3)).toEqual({ x: 7, y: 9 });
    expect(sci32CelLink(view, 0, 0, 4)).toEqual({ x: -1, y: -1 });

    const { world } = makeWorld('sci2-1-middle', {
      celLink: (_view: number, l: number, c: number, link: number) =>
        sci32CelLink(view, l, c, link),
    } as Partial<SciKernelWorld>);
    expect(SCI_KERNEL.CelLink(world, [int(2), int(1), int(0), int(0), int(3)]).offset).toBe(7);
    expect(SCI_KERNEL.CelLink(world, [int(3), int(1), int(0), int(0), int(3)]).offset).toBe(9);
  });

  it('answers WinDLL’s load and free, and WebConnect through the host', () => {
    let opened = '';
    const { world, string } = makeWorld('sci3', {
      openUrl: (url: string) => ((opened = url), true),
      morphOn: () => (opened = 'morph'),
    } as Partial<SciKernelWorld>);
    expect(SCI_KERNEL.WinDLL(world, [int(0), string('PENGIN16.DLL')]).offset).toBe(1000);
    expect(SCI_KERNEL.WinDLL(world, [int(1), string('PENGIN16.DLL')]).offset).toBe(1);
    expect(SCI_KERNEL.WebConnect(world, []).offset).toBe(1);
    expect(opened).toBe('https://web.archive.org/web/1996/http://www.sierra.com');
    SCI_KERNEL.MorphOn(world, []);
    expect(opened).toBe('morph');
  });
});
