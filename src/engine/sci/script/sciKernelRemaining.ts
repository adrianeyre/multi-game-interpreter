/**
 * The Kernel calls that were left: SCI16's menu bar, status line, screen shake,
 * `Graph`, `Palette`, `AddToPic`, `DrawCel`, `OnControl` and King's Quest VI's
 * `Portrait`; and SCI32's `InputText`, `MessageBox`, `ScrollWindow`,
 * `MovePlaneItems`, `SetHotRectangles`, `CelLink`, `MorphOn`, `WinDLL` and
 * `WebConnect`.
 *
 * **Why these were last, and why they are one file.** Every one of them is a
 * surface rather than a computation — a bar the interpreter draws, a buffer a
 * script paints into, a window of text, a file on disc — so each needed
 * something on the engine's side before a handler could be anything but a
 * constant, and a constant is what they all were. Kept apart from
 * `SciKernel.ts` because that file is the Kernel's core and is already the
 * longest in the family; these are its edges.
 *
 * Every handler cites the ScummVM function it follows (`engines/sci/engine/
 * kgraphics.cpp`, `kgraphics32.cpp`, `kmenu.cpp`, `kmisc.cpp`, `kevent.cpp`,
 * fetched 2026-09-27) and answers what that function answers. The engine-side
 * halves are in `gfx/`, each with its own reference.
 *
 * Written as a factory over the helpers `SciKernel.ts` already has, rather
 * than importing them, so that neither module needs the other to have finished
 * loading first.
 */

import {
  isNull,
  KERNEL_RETRY,
  NULL_REG,
  reg,
  type Reg,
  type SciByteView,
  type SciObject,
} from './PMachine.js';
import type { SciKernelWorld } from './SciKernel.js';
import { before } from '../sciVersion.js';
import { SCI_SCREEN_MASK } from '../gfx/sciPaint16.js';
import { sciTextEditorKey, type SciTextEditorState } from '../gfx/sciTextEditor.js';
import { sciHoyle5Poker } from './sciHoyle5Poker.js';

type Handler = (world: SciKernelWorld, args: Reg[]) => Reg;

export interface SciKernelHelpers {
  readString(world: SciKernelWorld, value: Reg, wide?: boolean): string;
  putString(world: SciKernelWorld, target: Reg, text: string): void;
  bytesAt(world: SciKernelWorld, value: Reg): SciByteView | null;
  readProperty(world: SciKernelWorld, object: SciObject, name: string): number;
  readPropertyReg(world: SciKernelWorld, object: SciObject, name: string): Reg;
  hasProperty(world: SciKernelWorld, object: SciObject, name: string): boolean;
  setProperty(world: SciKernelWorld, object: SciObject | null, name: string, value: number): void;
  reportOnce(world: SciKernelWorld, key: string, message: string): void;
  /** Whether a said spec matches the sentence last parsed, which is `Said`. */
  said(world: SciKernelWorld, spec: Reg): boolean;
  /** Another Kernel handler by name, for a call that is written in terms of one. */
  kernel(name: string): Handler;
}

const int = (value: number): Reg => reg(0, value & 0xffff);
const signed = (value: Reg | undefined): number => {
  const word = (value?.offset ?? 0) & 0xffff;
  return word >= 0x8000 ? word - 0x10000 : word;
};

/** An actor's `signal` bit that keeps `AddToPic` from blocking the floor under it. */
const SIGNAL_IGNORE_ACTOR = 0x4000;
/** `SIGNAL_REG`, which `kPortrait`'s show answers: offset 0xFFFF. */
const SIGNAL_OFFSET = 0xffff;
/** SCI's "every event" mask, without the peek bit. */
const ANY_EVENT = 0x7fff;
/** SCI32's system font, which `InputText` asks for as font -1. */
const SCI32_SYSTEM_FONT = 999;

// ------------------------------------------------------- priority bands ---

/**
 * SCI16's priority bands: which priority a y coordinate gets, and back.
 *
 * `GfxPorts::priorityBandsInit`, `kernelCoordinateToPriority` and
 * `kernelPriorityToCoordinate` (`graphics/ports.cpp`). The integer arithmetic
 * is Sierra's to the letter — ScummVM's comment warns that rounding any other
 * way destroys the result — and fourteen bands from 42 to 190, the default,
 * reproduce the formula `CoordPri` has always used exactly, for every y from 0
 * to 199.
 */
export class SciPriorityBands {
  private readonly bands = new Uint8Array(201);
  private count = 14;
  private top = 42;
  private bottom = 190;

  constructor() {
    this.init(14, 42, 190);
  }

  init(count: number, top: number, bottom: number): void {
    if (count !== -1) this.count = count;
    this.top = Math.max(0, Math.min(200, top));
    this.bottom = Math.max(this.top + 1, Math.min(200, bottom));
    const size = Math.trunc(((this.bottom - this.top) * 2000) / this.count);
    this.bands.fill(0, 0, this.top);
    for (let y = this.top; y < this.bottom; y++) {
      this.bands[y] = 1 + Math.trunc(((y - this.top) * 2000) / size);
    }
    if (this.count === 15) {
      // Fifteen bands replace band 15 with 14, as Sierra's interpreter did.
      for (let y = this.bottom - 1; y >= 0 && this.bands[y] === this.count; y--) this.bands[y]--;
    }
    for (let y = this.bottom; y <= 200; y++) this.bands[y] = this.count;
  }

  coordinateToPriority(y: number): number {
    if (y < 0) return this.bands[0];
    if (y > this.bottom) return this.bands[this.bottom];
    return this.bands[y];
  }

  priorityToCoordinate(priority: number): number {
    if (priority <= this.count) {
      for (let y = 0; y <= this.bottom; y++) if (this.bands[y] === priority) return y;
    }
    return this.bottom;
  }
}

const priorityBands = new WeakMap<SciKernelWorld, SciPriorityBands>();

/** The bands a world is using, which `CoordPri` and `AddToPic` share. */
export function sciPriorityBands(world: SciKernelWorld): SciPriorityBands {
  let bands = priorityBands.get(world);
  if (!bands) {
    bands = new SciPriorityBands();
    priorityBands.set(world, bands);
  }
  return bands;
}

// ------------------------------------------------------ held Kernel calls ---

/** An `InputText` box still open, by the string it edits. */
const textInputs = new WeakMap<
  SciKernelWorld,
  {
    key: string;
    title: string;
    rect: { x: number; y: number; width: number; height: number };
    state: SciTextEditorState;
  }
>();

/** A portrait mid-line: its mouth schedule and the audio it follows. */
const portraitLines = new WeakMap<
  SciKernelWorld,
  { key: string; schedule: Array<{ at: number; bitmap: number }>; next: number; audio: string }
>();

type PortraitRequest = Parameters<NonNullable<SciKernelWorld['portraitShow']>>[0];

/**
 * One cycle of `Portrait::doit`.
 *
 * The first cycle draws the face, starts the audio (`resource` is the audio
 * module and the tuple its entry, as `startAudio(resourceId, audioNumber)`
 * takes them) and builds the mouth schedule from the `rave` data. Every cycle
 * after shows each mouth frame whose time the audio has reached; the line
 * ends when the schedule is spent, the audio is not playing (-1), or the
 * player clicks or presses ESC — which also stops the audio, as `userAbort`
 * does.
 */
function showPortrait(world: SciKernelWorld, request: PortraitRequest): Reg {
  const key = `${request.name}:${request.resource}:${request.noun}:${request.verb}:${request.cond}:${request.seq}`;
  let line = portraitLines.get(world);
  if (!line || line.key !== key) {
    const shown = world.portraitShow?.(request);
    if (shown === undefined) return NULL_REG;
    if (shown === 'loading') return world.portraitSchedule ? KERNEL_RETRY : int(SIGNAL_OFFSET);
    if (!shown) return NULL_REG;
    const schedule = world.portraitSchedule ? world.portraitSchedule(request) : null;
    if (schedule === undefined) return KERNEL_RETRY;
    const audio = `${request.resource}:${request.noun}:${request.verb}:${request.cond}:${request.seq}`;
    world.audio?.stop();
    const clip = world.audioClip?.(audio);
    if (clip === undefined && world.audioClip) return KERNEL_RETRY;
    if (clip && world.audio) {
      world.audio.play(audio, clip, { autoPlay: true, loop: false, volume: 127, monitor: false });
    }
    // No `rave` data at all: ScummVM warns and returns with only the face.
    if (!schedule) return int(SIGNAL_OFFSET);
    line = { key, schedule, next: 0, audio };
    portraitLines.set(world, line);
  }

  let abort = false;
  for (let event = world.input.next(ANY_EVENT); event; event = world.input.next(ANY_EVENT)) {
    if (event.type === 1 || (event.type === 4 && event.message === 27) || event.type === 0x800) {
      abort = true;
    }
  }
  const position = world.audio?.position(line.audio) ?? -1;
  while (
    line.next < line.schedule.length &&
    (position === -1 || line.schedule[line.next].at <= position)
  ) {
    world.portraitFrame?.(request.name, line.schedule[line.next].bitmap);
    line.next++;
  }
  if (!abort && line.next < line.schedule.length && position !== -1) return KERNEL_RETRY;

  // "Reset the portrait bitmap to closed mouth state".
  world.portraitFrame?.(request.name, null);
  if (abort) world.audio?.stop(line.audio);
  portraitLines.delete(world);
  return int(SIGNAL_OFFSET);
}

// -------------------------------------------------------------- handlers ---

export function createRemainingKernel(helpers: SciKernelHelpers): Record<string, Handler> {
  const { readString, readProperty, setProperty, reportOnce } = helpers;

  /** White in the display's palette: `GfxScreen::getColorWhite`. */
  const white = (world: SciKernelWorld): number =>
    (world.colourCount?.() ?? 256) >= 256 ? 255 : 15;

  /** Reads an Event object into the shape the menu bar matches on. */
  const eventOf = (world: SciKernelWorld, object: SciObject) => ({
    type: readProperty(world, object, 'type'),
    message: readProperty(world, object, 'message'),
    modifiers: readProperty(world, object, 'modifiers'),
    x: signed(int(readProperty(world, object, 'x'))),
    y: signed(int(readProperty(world, object, 'y'))),
  });

  /** The next queued event of any kind, for an interaction playing out inside one call. */
  const drain = (world: SciKernelWorld) => () => {
    const event = world.input.next(ANY_EVENT);
    return event
      ? {
          type: event.type,
          message: event.message,
          modifiers: event.modifiers,
          x: event.x,
          y: event.y,
        }
      : null;
  };

  /** `getGraphRect`: top, left, bottom, right, put in order. */
  const graphRect = (args: Reg[], at: number) => {
    let x = signed(args[at + 1]);
    let y = signed(args[at]);
    let x1 = signed(args[at + 3]);
    let y1 = signed(args[at + 2]);
    if (x > x1) [x, x1] = [x1, x];
    if (y > y1) [y, y1] = [y1, y];
    return { left: x, top: y, right: x1, bottom: y1 };
  };

  /** `adjustGraphColor`: an EGA game's colours are four-bit. */
  const graphColour = (world: SciKernelWorld, value: number): number =>
    (world.colourCount?.() ?? 256) < 256 ? value & 0x0f : value & 0xff;

  /**
   * One cel stamped into the room for `AddToPic`, with the floor under its
   * base blocked unless the actor says it is ignored — `addToPicDrawCels`.
   */
  const addToPic = (
    world: SciKernelWorld,
    view: number,
    loop: number,
    cel: number,
    x: number,
    y: number,
    z: number,
    priority: number,
    control: number | null,
  ): void => {
    const bands = sciPriorityBands(world);
    const resolved = priority === -1 ? bands.coordinateToPriority(y) : priority;
    const rect = world.celRect?.(view, loop, cel, x, y, z);
    if (!rect) return;
    world.graph16?.drawCel(view, loop, cel, rect.left, rect.top, resolved);
    if (control === null) return;
    const top = Math.min(
      Math.max(bands.priorityToCoordinate(resolved) - 1, rect.top),
      rect.bottom - 1,
    );
    world.graph16?.fillBox({ ...rect, top }, SCI_SCREEN_MASK.control, 0, 0, control);
  };

  return {
    // -------------------------------------------------- menu and status ---
    /** `kAddMenu(title, content)`. */
    AddMenu: (world, args) => {
      const title = readString(world, args[0] ?? NULL_REG, true);
      const content = readString(world, args[1] ?? NULL_REG, true);
      world.menuBar?.add(title, content, args[1] ?? NULL_REG);
      return world.machine.acc;
    },
    /** `kSetMenu(menu << 8 | item, attribute, value, ...)`: as many pairs as are passed. */
    SetMenu: (world, args) => {
      const id = args[0]?.offset ?? 0;
      for (let at = 1; at < args.length; at += 2) {
        const attribute = args[at]?.offset ?? 0;
        // Cascade Quest passes an attribute with no value, and Sierra read nought.
        const value = args[at + 1] ?? NULL_REG;
        const text = attribute === 0x6e ? readString(world, value, true) : '';
        world.menuBar?.setAttribute(id >> 8, id & 0xff, attribute, value, text);
      }
      return world.machine.acc;
    },
    /** `kGetMenu(menu << 8 | item, attribute)`. */
    GetMenu: (world, args) => {
      const id = args[0]?.offset ?? 0;
      const answer = world.menuBar?.getAttribute(id >> 8, id & 0xff, args[1]?.offset ?? 0);
      if (!answer) {
        reportOnce(
          world,
          `GetMenu.${id}`,
          `GetMenu asked about menu ${id >> 8} item ${id & 0xff}, which was never added; ` +
            `Sierra's interpreter treats that as an error, and this answered nought.`,
        );
      }
      return answer ?? NULL_REG;
    },
    /**
     * `kDrawStatus(text, pen, back)`. No text draws nothing — a game calls it
     * that way — and the Cascade Quest fan game's "Replaying sound" is skipped
     * as ScummVM skips it.
     */
    DrawStatus: (world, args) => {
      const text = args[0] ?? NULL_REG;
      if (isNull(text)) return world.machine.acc;
      const line = readString(world, text, true);
      if (line === 'Replaying sound') return world.machine.acc;
      const pen = args.length > 1 ? signed(args[1]) : 0;
      const back = args.length > 2 ? signed(args[2]) : white(world);
      world.menuBar?.drawStatus(line, pen, back);
      return world.machine.acc;
    },
    /** `kDrawMenuBar(show)`: the titles, or with null a blank bar. */
    DrawMenuBar: (world, args) => {
      world.menuBar?.drawMenuBar(!isNull(args[0] ?? NULL_REG));
      return world.machine.acc;
    },
    /**
     * `kMenuSelect(event, pauseSound)` — `(menu << 8) | item`, or nought.
     *
     * The interaction plays over what is already queued; a pull-down still
     * open when the queue runs dry is handed to the engine, which holds the
     * scripts and feeds it the player's input between cycles, as Sierra's
     * interpreter held them inside this call. Its answer then comes back on the
     * next `MenuSelect`.
     */
    MenuSelect: (world, args) => {
      const menu = world.menuBar;
      const object = world.machine.object(args[0] ?? NULL_REG);
      if (!menu || !object) return NULL_REG;
      const pauseSound = args.length <= 1 || !isNull(args[1] ?? NULL_REG);
      const result = menu.select(eventOf(world, object), drain(world), (spec) =>
        helpers.said(world, spec),
      );
      if (menu.open) world.holdForMenu?.(pauseSound);
      if (result.claimed) setProperty(world, object, 'claimed', 1);
      return result.item ? int((result.item.menuId << 8) | result.item.id) : NULL_REG;
    },

    // ------------------------------------------------------ screen shake ---
    /**
     * `kShakeScreen(times, directions)` — bit 0 down, bit 1 right. SCI16
     * defaults both arguments (one shake, down); SCI32 requires the count and
     * defaults the direction the same way, which ScummVM's `kShakeScreen32`
     * does because GK1 and QFG4 leave it off.
     */
    ShakeScreen: (world, args) => {
      const sci32 = !before(world.machine.version, 'sci2');
      const times = args.length > 0 ? (args[0]?.offset ?? 0) : sci32 ? 0 : 1;
      const directions = args.length > 1 ? (args[1]?.offset ?? 0) : 1;
      if (times > 0) world.shakeScreen?.(times, directions);
      return world.machine.acc;
    },

    // ------------------------------------------------------------- Graph ---
    /** `kGraph(sub, ...)`, SCI16 only: the `kGraph_subops` table. */
    Graph: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      const graph = world.graph16;
      if (!before(world.machine.version, 'sci2')) {
        // ScummVM maps `Graph` for SCI16 only: SCI2's table still names the
        // slot, and early SCI2.1 games reuse it for `Robot`.
        reportOnce(
          world,
          'Graph.sci32',
          'Graph was called by a SCI32 game, whose interpreter has no Graph; nothing was drawn.',
        );
        return world.machine.acc;
      }
      switch (sub) {
        case 2: // GetColorCount
          return int(world.colourCount?.() ?? 256);
        case 4: {
          // DrawLine(y0, x0, y1, x1, colour[, priority[, control]])
          graph?.drawLine(
            { x: signed(args[2]), y: signed(args[1]) },
            { x: signed(args[4]), y: signed(args[3]) },
            graphColour(world, signed(args[5])),
            args.length > 6 ? signed(args[6]) : -1,
            args.length > 7 ? signed(args[7]) : -1,
          );
          return world.machine.acc;
        }
        case 7: {
          // SaveBox(rect, mask) — a handle for RestoreBox.
          const handle = graph?.saveBox(graphRect(args, 1), (args[5]?.offset ?? 0) & 7) ?? 0;
          return int(handle);
        }
        case 8: // RestoreBox(handle)
          graph?.restoreBox(args[1]?.offset ?? 0);
          return world.machine.acc;
        case 9: // FillBoxBackground(rect): the port's back colour
        case 10: {
          // FillBoxForeground(rect): the port's pen colour
          const colours = graph?.portColours() ?? { pen: 0, back: white(world) };
          graph?.fillBox(
            graphRect(args, 1),
            SCI_SCREEN_MASK.visual,
            sub === 9 ? colours.back : colours.pen,
            0,
            0,
          );
          return world.machine.acc;
        }
        case 11: // FillBoxAny(rect, mask, colour, priority, control)
          graph?.fillBox(
            graphRect(args, 1),
            args[5]?.offset ?? 0,
            graphColour(world, signed(args[6])),
            signed(args[7]),
            signed(args[8]),
          );
          return world.machine.acc;
        case 12: // UpdateBox
        case 13: // RedrawBox
          // Both put what the buffers hold on screen now. The compositor
          // repaints the room from its buffers every frame, so the box is
          // already shown by the time a player could see it; there is no
          // separate display buffer here for these to copy into.
          return world.machine.acc;
        case 14: // AdjustPriority(top, bottom)
          sciPriorityBands(world).init(
            before(world.machine.version, 'sci01') ? 15 : 14,
            signed(args[1]),
            signed(args[2]),
          );
          return world.machine.acc;
        case 15:
          // SaveUpscaledHiresBox answers null unless the display driver draws
          // hi-res, and this display is the game's own 320x200.
          return NULL_REG;
        default:
          reportOnce(
            world,
            `Graph.${sub}`,
            `Graph sub-function ${sub} is not in ScummVM's table (1, 3, 5 and 6 are unused ` +
              `slots), so nothing was drawn.`,
          );
          return world.machine.acc;
      }
    },

    // ----------------------------------------------------------- Palette ---
    /** `kPalette(sub, ...)`: SCI16's eight sub-functions, or SCI32's four. */
    Palette: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      const palette = world.palette16;
      if (!before(world.machine.version, 'sci2')) {
        switch (sub) {
          case 1: // SetFromResource32
            world.assertPalette?.(args[1]?.offset ?? 0);
            return world.machine.acc;
          case 2: // SetFade(from, to, percent)
            world.paletteFade?.(args[1]?.offset ?? 0, args[2]?.offset ?? 0, args[3]?.offset ?? 0);
            return world.machine.acc;
          case 3: // FindColor32
            return int(
              palette?.findColor32(
                args[1]?.offset ?? 0,
                args[2]?.offset ?? 0,
                args[3]?.offset ?? 0,
              ) ?? 0,
            );
          case 4: // SetGamma(level)
            world.setGamma?.(signed(args[1]));
            return world.machine.acc;
        }
      } else {
        const from = args[1]?.offset ?? 0;
        const to = args[2]?.offset ?? 0;
        switch (sub) {
          case 1:
            // SetFromResource: ignored below 64 colours, because an EGA game
            // has no palette resources to take one from.
            if ((world.colourCount?.() ?? 256) >= 64) world.assertPalette?.(from);
            return world.machine.acc;
          case 2:
            palette?.setFlag(from, to, args[3]?.offset ?? 0);
            return world.machine.acc;
          case 3:
            palette?.unsetFlag(from, to, args[3]?.offset ?? 0);
            return world.machine.acc;
          case 4:
            // SetIntensity: palette intensity went with SCI1's EGA drivers.
            if ((world.colourCount?.() ?? 256) >= 256) {
              palette?.setIntensity(from, to, args[3]?.offset ?? 0);
            }
            return world.machine.acc;
          case 5:
            return int(
              palette?.findColor(
                from,
                to,
                args[3]?.offset ?? 0,
                !before(world.machine.version, 'sci1-1'),
              ) ?? 0,
            );
          case 6: {
            // Animate(from, to, speed, ...): triples, each on its own timer.
            if ((world.colourCount?.() ?? 256) < 256 || !palette) return world.machine.acc;
            const now = world.ticks();
            for (let at = 1; at + 2 < args.length; at += 3) {
              palette.animate(
                args[at]?.offset ?? 0,
                args[at + 1]?.offset ?? 0,
                signed(args[at + 2]),
                now,
              );
            }
            return world.machine.acc;
          }
          case 7: {
            // Save: 1024 bytes on the heap, a handle the game hands back.
            if (!palette) return NULL_REG;
            const handle = world.heap.allocate(1024);
            world.heap.bytes(handle)?.set(palette.save());
            return handle;
          }
          case 8: {
            // Restore(handle), answering the handle, as `kPaletteRestore` does.
            const handle = args[1] ?? NULL_REG;
            const bytes = isNull(handle) ? null : world.heap.bytes(handle);
            if (bytes && palette) palette.restore(bytes);
            return handle;
          }
        }
      }
      reportOnce(
        world,
        `Palette.${sub}`,
        `Palette sub-function ${sub} is not in ScummVM's table for this Version, so the ` +
          `colours were left alone.`,
      );
      return world.machine.acc;
    },

    // ------------------------------------------- AddToPic, DrawCel, OnControl ---
    /**
     * `kAddToPic(list)` or `kAddToPic(view, loop, cel, x, y, priority, control)`.
     *
     * Scenery that is drawn once and never again: into the visual and priority
     * buffers, and into the control buffer as a box across the cel's base so
     * an actor cannot walk through it. The list form sorts the way `Animate`
     * does, by `y` and then by the order given.
     */
    AddToPic: (world, args) => {
      if (args.length === 7) {
        addToPic(
          world,
          args[0]?.offset ?? 0,
          signed(args[1]),
          signed(args[2]),
          signed(args[3]),
          signed(args[4]),
          0,
          signed(args[5]),
          signed(args[6]) === -1 ? null : signed(args[6]),
        );
        return world.machine.acc;
      }
      const list = world.heap.list(args[0] ?? NULL_REG);
      if (!list) return world.machine.acc;
      const cast: SciObject[] = [];
      for (let at = list.first, guard = 0; !isNull(at) && guard < 256; guard++) {
        const node = world.heap.node(at);
        if (!node) break;
        const object = world.machine.object(node.value);
        if (object) cast.push(object);
        at = node.next;
      }
      const read = (object: SciObject, name: string) =>
        signed(int(readProperty(world, object, name)));
      cast
        .map((object, order) => ({ object, order, y: read(object, 'y') }))
        .sort((a, b) => a.y - b.y || a.order - b.order)
        .forEach(({ object }) => {
          const ignored = (readProperty(world, object, 'signal') & SIGNAL_IGNORE_ACTOR) !== 0;
          addToPic(
            world,
            readProperty(world, object, 'view'),
            read(object, 'loop'),
            read(object, 'cel'),
            read(object, 'x'),
            read(object, 'y'),
            read(object, 'z'),
            read(object, 'priority'),
            ignored ? null : 15,
          );
        });
      return world.machine.acc;
    },
    /**
     * `kDrawCel(view, loop, cel, left, top[, priority[, palette]])` — one cel
     * by its top left. With no priority it draws over everything and changes
     * no priority, which is Sierra's -1 read as a byte. Scaling (a palette
     * number *and* two more arguments) is reported and drawn unscaled.
     */
    DrawCel: (world, args) => {
      if (args.length > 7 && (args[6]?.offset ?? 0) > 0) {
        reportOnce(
          world,
          'DrawCel.scaled',
          'DrawCel was asked to scale a cel, which is drawn here at its own size.',
        );
      }
      world.graph16?.drawCel(
        args[0]?.offset ?? 0,
        signed(args[1]),
        signed(args[2]),
        signed(args[3]),
        signed(args[4]),
        args.length > 5 ? signed(args[5]) : -1,
      );
      return world.machine.acc;
    },
    /**
     * `kOnControl([mask,] x, y[, right, bottom])` — which control (or with
     * the priority bit, priority) values lie under a point or a box, one bit
     * each. Two or four arguments mean the control buffer.
     */
    OnControl: (world, args) => {
      const hasMask = args.length !== 2 && args.length !== 4;
      const base = hasMask ? 1 : 0;
      const mask = hasMask ? (args[0]?.offset ?? 0) : SCI_SCREEN_MASK.control;
      const left = signed(args[base]);
      const top = signed(args[base + 1]);
      const rect =
        args.length > 3
          ? { left, top, right: signed(args[base + 2]), bottom: signed(args[base + 3]) }
          : { left, top, right: left + 1, bottom: top + 1 };
      return int(world.graph16?.onControl(mask, rect) ?? 0);
    },

    // ---------------------------------------------------------- Portrait ---
    /**
     * `kPortrait(sub, ...)` — King's Quest VI's hi-res talking heads.
     *
     * Load answers null, as ScummVM's does, and is used here to start reading
     * the file. Show is `Portrait::doit`: the face drawn, the line's audio
     * started through `DoAudio`'s channels, and the mouth moved to the line's
     * `rave` lip-sync script against the audio's own clock, until the script
     * runs out, the audio ends, or the player clicks or presses ESC; then the
     * closed-mouthed face again, and `SIGNAL_REG`. Sierra's interpreter held
     * the game inside the call for all of it, and so does this — by answering
     * `KERNEL_RETRY` each cycle until it is over. A file that is not there
     * answers nought rather than stopping the game, which ScummVM does.
     * Unload does nothing, in ScummVM too.
     */
    Portrait: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      switch (sub) {
        case 0:
          if (args.length === 2) world.portraitLoad?.(readString(world, args[1] ?? NULL_REG, true));
          return NULL_REG;
        case 1: {
          if (args.length !== 10) break;
          const request = {
            name: readString(world, args[1] ?? NULL_REG, true),
            x: args[2]?.offset ?? 0,
            y: args[3]?.offset ?? 0,
            resource: args[4]?.offset ?? 0,
            noun: (args[5]?.offset ?? 0) & 0xff,
            verb: (args[6]?.offset ?? 0) & 0xff,
            cond: (args[7]?.offset ?? 0) & 0xff,
            seq: (args[8]?.offset ?? 0) & 0xff,
          };
          return showPortrait(world, request);
        }
        case 2:
          if (args.length === 2) world.portraitUnload?.(args[1]?.offset ?? 0);
          return world.machine.acc;
      }
      reportOnce(
        world,
        `Portrait.${sub}.${args.length}`,
        `Portrait sub-function ${sub} with ${args.length} arguments is not a form ScummVM ` +
          `accepts, so no portrait was touched.`,
      );
      return world.machine.acc;
    },

    // --------------------------------------------------------- InputText ---
    /**
     * `kInputText(text, title, maxLength)` — a modal one-line editor, used by
     * Phantasmagoria 2's easter eggs: a titled box, centred on the left half
     * of the screen as SSCI centred it, edited through `sciTextEditorKey`
     * until Enter or ESC. The text is written back trimmed either way, and the
     * answer is whether Enter ended it.
     *
     * Sierra's loop held the game until then; this answers `KERNEL_RETRY` each
     * cycle the box is still open, taking whatever keys the player has pressed
     * since, so the same call finishes on the cycle Enter arrives.
     */
    InputText: (world, args) => {
      const target = args[0] ?? NULL_REG;
      const key = `${target.segment}:${target.offset}`;
      let session = textInputs.get(world);
      if (!session || session.key !== key) {
        const title = readString(world, args[1] ?? NULL_REG, true);
        const maxLength = signed(args[2]);
        const measure = (text: string): number =>
          world.measureText?.(text, SCI32_SYSTEM_FONT, 0)?.width ?? text.length * 8;
        const lineHeight = world.measureText?.('M', SCI32_SYSTEM_FONT, 0)?.height ?? 8;
        const width = Math.max(measure('M') * maxLength, measure(title)) + 4;
        const height = lineHeight * 2 + 7;
        session = {
          key,
          title,
          rect: {
            x: Math.trunc((320 - width) / 2),
            y: Math.trunc((200 - height) / 2),
            width,
            height,
          },
          state: {
            text: readString(world, target, true),
            cursor: 0,
            maxLength,
            clearOnInput: true,
            overwrite: false,
            boxWidth: width - 2,
            measure,
          },
        };
        textInputs.set(world, session);
      }

      let ended: 'enter' | 'escape' | null = null;
      for (let event = world.input.next(ANY_EVENT); event; event = world.input.next(ANY_EVENT)) {
        if (event.type === 0x800) {
          ended = 'escape';
          break;
        }
        if (event.type !== 4) continue;
        if (event.message === 27) {
          ended = 'escape';
          break;
        }
        if (event.message === 13) {
          ended = 'enter';
          break;
        }
        sciTextEditorKey(session.state, event.message);
      }

      if (!ended && world.showTextEditor) {
        world.showTextEditor({
          title: session.title,
          text: session.state.text,
          cursor: session.state.cursor,
          rect: session.rect,
        });
        return KERNEL_RETRY;
      }
      if (!ended) {
        reportOnce(
          world,
          'InputText.queue',
          `InputText "${session.title}" ran out of queued keys before Enter or ESC and there is ` +
            `no screen to hold it open on; it was closed as ESC closes it.`,
        );
      }
      world.showTextEditor?.(null);
      textInputs.delete(world);
      helpers.putString(world, target, session.state.text.trim());
      return int(ended === 'enter' ? 1 : 0);
    },

    // -------------------------------------------------------- MessageBox ---
    /**
     * `kMessageBox(message, title, style)` — Windows' own dialog, which only
     * King's Quest VII 1.51 calls. `kMessageBoxOK` answers 1 and
     * `kMessageBoxYesNo` 6 for Yes and 7 for No, as Windows does; any other
     * style is refused by ScummVM and reported here.
     */
    MessageBox: (world, args) => {
      const message = readString(world, args[0] ?? NULL_REG, true);
      const title = readString(world, args[1] ?? NULL_REG, true);
      const style = (args[2]?.offset ?? 0) & 0x0f;
      if (style !== 0 && style !== 4) {
        reportOnce(
          world,
          `MessageBox.${style}`,
          `MessageBox style ${style} is not one ScummVM supports.`,
        );
        return NULL_REG;
      }
      const yesNo = style === 4;
      const confirmed = world.messageBox?.(message, title, yesNo);
      if (confirmed === undefined) {
        world.log(`Message box "${title}": ${message} — answered ${yesNo ? 'Yes' : 'OK'}.`);
      }
      return int(yesNo ? (confirmed === false ? 7 : 6) : 1);
    },

    // ------------------------------------------------------ ScrollWindow ---
    /** `kScrollWindow(sub, ...)`: the `kScrollWindow_subops` table. */
    ScrollWindow: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      const host = world.scrollWindows;
      const id = args[1]?.offset ?? 0;
      if (sub === 0) {
        // Create(object, maxEntries): read off the object, as `kScrollWindowCreate`.
        const object = world.machine.object(args[1] ?? NULL_REG);
        if (!object || !host) return NULL_REG;
        // Phantasmagoria 2 names the rectangle `left`..`bottom` where every other
        // game says `nsLeft`..`nsBottom`; asked of the object, as `planeRect` asks.
        const alternate = !helpers.hasProperty(world, object, 'nsLeft');
        const side = (name: string) => signed(int(readProperty(world, object, name)));
        const left = side(alternate ? 'left' : 'nsLeft');
        const top = side(alternate ? 'top' : 'nsTop');
        const right = side(alternate ? 'right' : 'nsRight') + 1;
        const bottom = side(alternate ? 'bottom' : 'nsBottom') + 1;
        return int(
          host.create({
            rect: {
              x: left,
              y: top,
              width: Math.max(1, right - left),
              height: Math.max(1, bottom - top),
            },
            plane: helpers.readPropertyReg(world, object, 'plane'),
            fore: readProperty(world, object, 'fore'),
            back: readProperty(world, object, 'back'),
            font: readProperty(world, object, 'font'),
            alignment: readProperty(world, object, 'mode'),
            border: signed(int(readProperty(world, object, 'borderColor'))),
            maxEntries: args[2]?.offset ?? 0,
          }),
        );
      }
      const window = host?.window(id);
      if (!host || !window) {
        reportOnce(world, `ScrollWindow.${id}`, `ScrollWindow ${id} is not one this game created.`);
        return world.machine.acc;
      }
      let answer: Reg = world.machine.acc;
      switch (sub) {
        case 1: // Add(id, text, font, colour, alignment[, scrollTo])
          answer = int(
            window.add(
              readString(world, args[2] ?? NULL_REG, true),
              signed(args[3]),
              signed(args[4]),
              signed(args[5]),
              args.length > 6 ? (args[6]?.offset ?? 0) !== 0 : true,
            ),
          );
          break;
        case 3:
          window.pageUp();
          break;
        case 4:
          window.pageDown();
          break;
        case 5:
          window.upArrow();
          break;
        case 6:
          window.downArrow();
          break;
        case 7:
          window.home();
          break;
        case 8:
          window.end();
          break;
        case 10: {
          // Where(id, range): the top line as a share of `range`.
          const { top, lines } = window.where;
          return int(Math.trunc(((args[2]?.offset ?? 0) * top) / lines));
        }
        case 11: // Go(id, numerator, denominator)
          if (!window.go(signed(args[2]), signed(args[3]))) {
            reportOnce(world, 'ScrollWindow.go', 'ScrollWindow was sent past its own end.');
          }
          break;
        case 14: // Modify(id, entry, text, font, colour, alignment[, scrollTo])
          answer = int(
            window.modify(
              args[2]?.offset ?? 0,
              readString(world, args[3] ?? NULL_REG, true),
              signed(args[4]),
              signed(args[5]),
              signed(args[6]),
              args.length > 7 ? (args[7]?.offset ?? 0) !== 0 : true,
            ),
          );
          break;
        case 15:
          host.hide(id);
          return world.machine.acc;
        case 16:
          host.show(id);
          return world.machine.acc;
        case 17:
          host.destroy(id);
          return world.machine.acc;
        case 18: // Text
        case 19: // Reconstruct
          // `MAP_EMPTY` in ScummVM's table: LSL6 hi-res calls both to keep the
          // window across a save, and ScummVM keeps its windows in the save
          // itself. This engine's windows live for the session, so there is
          // nothing to write or rebuild.
          return world.machine.acc;
        default:
          // 2 (Clear), 9 (Resize), 12 (Insert) and 13 (Delete) are `MAP_DUMMY`
          // in ScummVM's table: no game is known to call them.
          reportOnce(
            world,
            `ScrollWindow.sub${sub}`,
            `ScrollWindow sub-function ${sub} is one ScummVM's table maps to a dummy — no ` +
              `game is known to call it — so the window was left as it was.`,
          );
          return world.machine.acc;
      }
      host.changed(id);
      return answer;
    },

    // ---------------------------------------------------- MovePlaneItems ---
    /**
     * `kMovePlaneItems(plane, dx, dy[, scrollPics])` — SQ6's inventory
     * scrolling. Every screen item on the Plane moves, its Picture's cels only
     * when asked; and each script object behind an item has its own `x` and
     * `y` moved to match, so the next `UpdateScreenItem` agrees.
     */
    MovePlaneItems: (world, args) => {
      const plane = args[0] ?? NULL_REG;
      const dx = signed(args[1]);
      const dy = signed(args[2]);
      const scrollPics = args.length > 3 && (args[3]?.offset ?? 0) !== 0;
      const moved =
        world.movePlaneItems?.(`${plane.segment}:${plane.offset}`, dx, dy, scrollPics) ?? [];
      for (const id of moved) {
        const [segment, offset] = id.split(':').map(Number);
        const object = world.machine.object(reg(segment ?? 0, offset ?? 0));
        if (!object) continue;
        if (dx !== 0) setProperty(world, object, 'x', readProperty(world, object, 'x') + dx);
        if (dy !== 0) setProperty(world, object, 'y', readProperty(world, object, 'y') + dy);
      }
      return world.machine.acc;
    },

    // -------------------------------------------------- SetHotRectangles ---
    /**
     * `kSetHotRectangles(active)` or `kSetHotRectangles(count, rects)`.
     *
     * Phantasmagoria's chase scene: regions of the screen that report the
     * pointer entering and leaving them as events of their own, with the
     * region's index — or -1 for none — in the event's `message`. The array
     * holds left, top, right, bottom per region, inclusive.
     */
    SetHotRectangles: (world, args) => {
      if (args.length === 1) {
        world.input.setHotRectanglesActive?.((args[0]?.offset ?? 0) !== 0);
        return world.machine.acc;
      }
      const count = Math.max(0, signed(args[0]));
      const array = args[1] ?? NULL_REG;
      const at = (index: number): number => signed(int(world.heap.arrayAt(array, index)));
      const rects = Array.from({ length: count }, (_, index) => ({
        left: at(index * 4),
        top: at(index * 4 + 1),
        right: at(index * 4 + 2) + 1,
        bottom: at(index * 4 + 3) + 1,
      }));
      world.input.setHotRectanglesActive?.(true);
      world.input.setHotRectangles?.(rects);
      return world.machine.acc;
    },

    // ----------------------------------------------------------- CelLink ---
    /**
     * `kCelLink(sub, view, loop, cel, link)` — 2 answers a link point's x and
     * 3 its y. 0, 1 and 4 are `MAP_DUMMY` in ScummVM's table.
     */
    CelLink: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      if (sub !== 2 && sub !== 3) {
        reportOnce(
          world,
          `CelLink.${sub}`,
          `CelLink sub-function ${sub} is a dummy in ScummVM's table; no game is known to call it.`,
        );
        return world.machine.acc;
      }
      const point = world.celLink?.(
        args[1]?.offset ?? 0,
        signed(args[2]),
        signed(args[3]),
        signed(args[4]),
      );
      if (!point) return int(-1);
      return int(sub === 2 ? point.x : point.y);
    },

    // ----------------------------------------------------------- MorphOn ---
    /**
     * `kMorphOn` — the next `FrameOut` is a palette morph rather than a
     * frame: SQ6's datacorder puzzle. It reads nothing and answers the
     * accumulator; what it changes is the engine's next frame.
     */
    MorphOn: (world) => {
      world.morphOn?.();
      return world.machine.acc;
    },

    // ------------------------------------------------ WinDLL, WebConnect ---
    /**
     * `kWinDLL(op, name[, data])` — Windows DLLs, which Hoyle 5 uses for its
     * poker opponents. Load answers ScummVM's fake handle 1000 and free
     * answers true, as Windows' `LoadLibrary` and `FreeLibrary` would have.
     * Calling into a DLL needs that DLL's logic written out, and ScummVM has
     * written exactly one, Hoyle 5's `PENGIN16.DLL` — which `sciHoyle5Poker`
     * follows — answering true as `hoyle5PokerEngine` does.
     */
    WinDLL: (world, args) => {
      const op = args[0]?.offset ?? 0;
      const name = readString(world, args[1] ?? NULL_REG, true);
      switch (op) {
        case 0:
          return int(1000);
        case 1:
          return int(1);
        case 2: {
          // `hoyle5PokerEngine`: the one DLL ScummVM has written out.
          if (name.toUpperCase() !== 'PENGIN16.DLL') {
            reportOnce(
              world,
              `WinDLL.${name}`,
              `WinDLL was asked to call into ${name || 'a DLL'}. ScummVM knows only ` +
                `PENGIN16.DLL, and refuses any other, so the call answered nought.`,
            );
            return NULL_REG;
          }
          const data = args[2] ?? NULL_REG;
          const table = {
            get: (index: number) => signed(int(world.heap.arrayAt(data, index))),
            set: (index: number, value: number) => {
              if (index >= world.heap.arrayLength(data)) world.heap.arrayResize(data, index + 1);
              world.heap.arrayPut(data, index, value & 0xffff);
            },
          };
          if (!sciHoyle5Poker(table, (below) => Math.floor(world.random() * below))) {
            reportOnce(
              world,
              'WinDLL.poker',
              `PENGIN16.DLL was sent operation ${table.get(0)}, which it has not got.`,
            );
          }
          return int(1);
        }
        default:
          return NULL_REG;
      }
    },
    /**
     * `kWebConnect([url])` — SCI3's "visit Sierra on the web", sent to the
     * Wayback Machine's 1996 copy as ScummVM sends it. Answers whether the
     * host opened anything.
     */
    WebConnect: (world, args) => {
      const target =
        args.length > 0 ? readString(world, args[0] ?? NULL_REG, true) : 'http://www.sierra.com';
      const opened = world.openUrl?.(`https://web.archive.org/web/1996/${target}`) ?? false;
      return int(opened ? 1 : 0);
    },
  };
}
