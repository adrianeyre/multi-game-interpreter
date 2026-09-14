/**
 * Asks one question of a game, in the one way that gets a truthful answer:
 * **can a player do anything?**
 *
 *   npm run probe -- <game> [--out=<dir>] [--frames=<n>] [--escape=<n>,…]
 *                    [--click=<n>:<x>,<y>] [--floor=<x>,<y>] [--verb=<text>]
 *                    [--object=<x>,<y>] [--hover=<n>] [--settle=<n>]
 *
 * Three measurements, per game, each with a picture beside it:
 *
 *  1. **Does it reach an interactive state?** — the game runs its own opening
 *     with nothing driving it but the one key a player who has seen the intro
 *     presses: Escape, and only at a scene the game itself marks skippable.
 *     The count of those presses is reported, because "played its opening
 *     untouched" and "needed eleven presses to get through it" are different
 *     answers and a single yes hides which one it is.
 *  2. **Does a click on the floor move the player character?** — measured as a
 *     position, before and after, rather than as "something happened".
 *  3. **Does a verb pointed at a thing produce a response?** — a verb is
 *     chosen, a named object is clicked, and what changed is reported.
 *
 * ## Why this exists rather than a script per game
 *
 * Because four throwaway scripts disagreed with each other, and the reason they
 * disagreed is the two rules below. A probe that gets either wrong reports a
 * working game as broken, which is the most expensive wrong answer available:
 * it sends somebody to fix an engine that does not need fixing.
 *
 * **A click must be preceded by pointer-hover frames.** These games keep "what
 * the pointer is over" in their own script variables, updated across frames. A
 * synthetic click that sets the pointer position and presses the button in the
 * same frame is a click on nothing, and it is indistinguishable from an
 * interaction system that does not work. On the host this produced a false
 * positive that survived four probes: Day of the Tentacle appeared to ignore
 * every object click, with `doSentence` never reached. With hover frames before
 * the press, the same click composes its sentence and Bernard walks over. So:
 * **hover, then press, then release, then settle** — {@link HOVER_FRAMES} of
 * each by default, and every one of them rendered.
 *
 * **Every frame is rendered.** `Verb.bounds` is populated by `render()`, not by
 * `step()`, so a frame loop that only steps leaves every verb's rectangle at
 * zero and `verbs.hitTest` answers 0 for the whole screen. The browser renders
 * every frame; a harness that does not is measuring a different program.
 *
 * **Every frame yields to the event loop.** Both Broken Swords load their
 * clusters asynchronously and start the load from inside a synchronous
 * `step()`: the promise is fired and the cycle returns, and the bytes arrive on
 * a later turn of the loop. A `for` loop of ten thousand synchronous frames
 * never lets that turn happen, so the engine sits on `loading` forever and the
 * probe photographs a black screen — which reads exactly like a renderer that
 * does not work. Hence {@link frame} is `async` and every caller awaits it. The
 * other three families are unaffected: measured on the host, adding the yield
 * changed none of their numbers.
 *
 * ## What it deliberately does not do
 *
 * Decide that a game is playable. It reports positions, pixel counts and what
 * the engine says stopped it; the word **playable** is a person's to write, and
 * `CONTEXT.md` reserves **Completable** for a playthrough to a last screen,
 * which nothing here can establish.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import type { AdventureEngine, SavedGameEnvelope } from '../src/engine/AdventureEngine.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import { SkyEngine } from '../src/engine/sky/SkyEngine.js';
import { SwordEngine } from '../src/engine/sword1/SwordEngine.js';
import { Sword2Engine } from '../src/engine/sword2/Sword2Engine.js';
import {
  SWORD2_BOTTOM_MENU_TOP,
  SWORD2_ICON_DEPTH,
  SWORD2_ICON_START,
  SWORD2_ICON_WIDTH,
} from '../src/engine/sword2/Sword2Menu.js';
import { SwordType, SWORD1_SCREEN_WIDTH } from '../src/engine/sword1/resource/swordDefs.js';

/** Frames the pointer sits over a target before the button goes down. */
const HOVER_FRAMES = 20;
/** Frames the button is held, so a press-and-hold interface sees both edges. */
const PRESS_FRAMES = 8;
/** Frames after the release, for a walk to get going and a script to answer. */
const SETTLE_FRAMES = 240;

/**
 * How wide Broken Sword 1's display is, so a click can be kept inside it.
 *
 * The display-to-room conversion used to live here as three more constants and
 * a subtraction, which is how the scroll came to be left out of it. It is
 * `SwordEngine.playerOnScreen` now; this is the one number left that is about
 * the probe's aim rather than about the engine's arithmetic.
 */
const SWORD1_DISPLAY_WIDTH = SWORD1_SCREEN_WIDTH;

/** Broken Sword II's display, which is not its room. */
const SWORD2_DISPLAY_WIDTH = 640;
const SWORD2_DISPLAY_HEIGHT = 480;
/** The floor's mouse priority: the lowest the family has, and its alone. */
const SWORD2_FLOOR_PRIORITY = 9;
/** The two scroll arrows, which are not things in the room. */
const SWORD2_SCROLL_LEFT_POINTER = 1440;
const SWORD2_SCROLL_RIGHT_POINTER = 1441;

// ------------------------------------------------------------- arguments --

const argv = process.argv.slice(2);
const flags = argv.filter((each) => each.startsWith('--'));
const positional = argv.filter((each) => !each.startsWith('--'));
const flag = (name: string): string | undefined =>
  flags.find((each) => each.startsWith(`--${name}=`))?.slice(name.length + 3);
const numbers = (text: string | undefined): number[] =>
  (text ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value));
const point = (text: string | undefined): { x: number; y: number } | null => {
  const [x, y] = numbers(text);
  return x === undefined || y === undefined ? null : { x, y };
};

const path = positional[0];
if (!path) {
  console.error('Usage: npm run probe -- <game> [--out=<dir>] [--frames=<n>] [--escape=<n>,…]');
  process.exit(1);
}

const outDir = resolve(flag('out') ?? 'out');
/**
 * How long the game is left to reach an interactive state on its own.
 *
 * Always run in full, rather than stopped at the first interactive frame. An
 * opening hands control back and takes it away again — Simon 1 is interactive
 * within a frame and spends the next several thousand on a dream sequence — so
 * stopping early measures a gap between two cutscenes and calls it the game.
 */
const frames = Number(flag('frames') ?? 3000);
/** Frames at which Escape is pressed, as a player who has seen the intro would. */
const escapes = new Set(numbers(flag('escape')));
/** `--click=<frame>:<x>,<y>`, for an opening that waits on a menu choice. */
const openingClicks = new Map<number, { x: number; y: number }>();
for (const spec of flags.filter((each) => each.startsWith('--click='))) {
  const [when, where] = spec.slice('--click='.length).split(':');
  const at = point(where);
  if (at && Number.isFinite(Number(when))) openingClicks.set(Number(when), at);
}
/** `--no-skip` leaves skippable scenes to play out, for photographing one. */
const skipCutscenes = !flags.includes('--no-skip');
const floorOverride = point(flag('floor'));
const objectOverride = point(flag('object'));
const verbWanted = flag('verb');
const hoverFrames = Number(flag('hover') ?? HOVER_FRAMES);
const settleFrames = Number(flag('settle') ?? SETTLE_FRAMES);

// ------------------------------------------------------- the family seam --

/**
 * What the probe needs from a game, which is not what a shell needs.
 *
 * ADR 0011 caps `AdventureEngine` and five families have left it alone; asking
 * "where is the player standing" and "what is clickable" through it would widen
 * a seam this tool is not worth widening. So the probe carries one small
 * adapter per family instead, in the same spirit as `bin/vt-playthrough.ts`
 * narrowing to `SkyEngine` to ask whether a room was reached.
 */
interface FamilyProbe {
  /** The family's name, for the report. */
  readonly family: string;
  /** Why the player is not in control yet, or null when they are. */
  notInteractive(): string | null;
  /** Where the player character is, or null when the family cannot say. */
  playerAt(): { x: number; y: number } | null;
  /** A point on the floor worth clicking, or null when none was found. */
  floorTarget(): { x: number; y: number; what: string } | null;
  /** A named thing worth pointing a verb at, or null when none was found. */
  objectTarget(): { x: number; y: number; what: string } | null;
  /**
   * Chooses a verb, returning what it chose, or null when there is none.
   *
   * Asynchronous because choosing one is itself clicked, and a click is frames.
   */
  chooseVerb(): Promise<string | null>;
  /** Puts the pointer somewhere without pressing anything. */
  hover(x: number, y: number): void;
  /** Presses the button at a point the pointer is already over. */
  press(x: number, y: number): void;
  release(): void;
  /** Anything the family can add about what the last action did. */
  note(): string[];
  /**
   * Asks the family to open its inventory, and says what happened.
   *
   * Optional, because not every family has one and a family that does may open
   * it by a gesture rather than a click — Broken Sword II's is reached by
   * pushing the pointer to the bottom of the screen, which is a *hover* and not
   * a press. Returning a sentence rather than a boolean keeps the reason on the
   * page when the answer is no.
   */
  openInventory?(): Promise<string>;
  /**
   * What the player is carrying, asked of the world rather than of the screen.
   *
   * Optional for `openInventory`'s reason, and separate from it because the two
   * answer different questions: one is "can a player reach the bar", the other
   * is "what is in it right now". The save-and-restore check needs the second
   * on both sides of a restore, and a bar that happens to be open is not a
   * world — Broken Sword reads its 52 pocket globals and Broken Sword II reads
   * the list `menu_master`'s own script last built.
   */
  inventory?(): readonly number[];
  /**
   * Picks an inventory object up and says what the pointer is now carrying.
   *
   * Optional because only one family has the gesture: Broken Sword II drags a
   * "luggage" sprite off the cursor, and whether it is *drawn* is a question
   * about pixels that only the screen can answer, so the sentence this returns
   * names the resource and the framebuffer is the evidence beside it.
   */
  dragInventoryItem?(): Promise<string>;
}

// ------------------------------------------------------------ the driver --

const source = await openGame(resolve(path));
const engine = await loadAdventureEngine(source, { onLog: () => {} });
engine.boot();

/**
 * One frame: step the world, draw it, then let the event loop turn.
 *
 * All three, never two of them — see the note at the top of this file for why
 * the third matters as much as the second.
 */
async function frame(): Promise<void> {
  engine.step();
  engine.render();
  await new Promise((done) => setImmediate(done));
}

/** The framebuffer as RGB, through whatever palette the family is on. */
function pixels(game: AdventureEngine): { width: number; height: number; rgb: Uint8Array } {
  const screen = (
    game as unknown as { screen: { width: number; height: number; pixels: Uint8Array } }
  ).screen;
  const palette = (game as unknown as { palette: { flush(): void; rgba: Uint8ClampedArray } })
    .palette;
  palette.flush();
  const rgb = new Uint8Array(screen.width * screen.height * 3);
  for (let index = 0; index < screen.pixels.length; index += 1) {
    const entry = screen.pixels[index]! << 2;
    rgb[index * 3] = palette.rgba[entry]!;
    rgb[index * 3 + 1] = palette.rgba[entry + 1]!;
    rgb[index * 3 + 2] = palette.rgba[entry + 2]!;
  }
  return { width: screen.width, height: screen.height, rgb };
}

async function shoot(name: string): Promise<string> {
  const { width, height, rgb } = pixels(engine);
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${name}.png`);
  await writeFile(file, writePng(width, height, rgb));
  return file;
}

/** How many pixels of the framebuffer differ between two snapshots. */
function changed(before: Uint8Array, after: Uint8Array): number {
  let count = 0;
  for (let index = 0; index < before.length; index += 3) {
    if (
      before[index] !== after[index] ||
      before[index + 1] !== after[index + 1] ||
      before[index + 2] !== after[index + 2]
    ) {
      count += 1;
    }
  }
  return count;
}

/**
 * Hover, press, release, settle — the sequence the note at the top of this file
 * exists for, and the only one any measurement below is allowed to use.
 *
 * Returns how many pixels changed between the frame before the press and the
 * last frame of the settle, which is the family-independent half of "something
 * happened".
 */
async function clickAt(
  probe: FamilyProbe,
  x: number,
  y: number,
  settle = settleFrames,
): Promise<number> {
  for (let held = 0; held < hoverFrames; held += 1) {
    probe.hover(x, y);
    await frame();
  }
  const before = pixels(engine).rgb;
  probe.press(x, y);
  for (let held = 0; held < PRESS_FRAMES; held += 1) await frame();
  probe.release();
  for (let after = 0; after < settle; after += 1) await frame();
  return changed(before, pixels(engine).rgb);
}

/**
 * Runs frames until the player character stops moving, or gives up saying so.
 *
 * A walk is frames, and a save taken in the middle of one carries the walk: the
 * player structure holds the route as well as the position, so a restore
 * resumes it and the player is *still walking* when the comparison is made —
 * which reports a defect about a save that was exact. So the save is taken at
 * rest, the divergence is let finish, and the restored world is given the same
 * chance to settle before it is read.
 */
async function walkOut(probe: FamilyProbe, cap = 240): Promise<boolean> {
  const at = (): string => {
    const spot = probe.playerAt();
    return spot ? `${spot.x},${spot.y}` : 'unknown';
  };
  let still = 0;
  let last = at();
  for (let ran = 0; ran < cap; ran += 1) {
    await frame();
    const now = at();
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= 8) return true;
  }
  return false;
}

// ------------------------------------------------------ family adapters ---

function scummProbe(game: ScummEngine): FamilyProbe {
  /** The room point under a screen point, which is what the hit test wants. */
  const inRoom = (x: number, y: number): { x: number; y: number } => {
    // Through `setMousePosition` rather than through a copy of its arithmetic:
    // the camera offset and the room band's top are the engine's to apply, and
    // a harness that recomputes them measures its own version of the screen.
    game.setMousePosition(x, y);
    return {
      x: game.variables[game.vars.VIRT_MOUSE_X],
      y: game.variables[game.vars.VIRT_MOUSE_Y],
    };
  };

  return {
    family: `SCUMM (${game.targetName})`,
    notInteractive: () => {
      if (!game.userPut) return 'the game has not handed control back (userPut is off)';
      /*
       * **And the player character is in the room being shown**, which
       * `userPut` alone does not say. Loom opens on a difficulty menu — its own
       * room 69, three buttons, no ego anywhere — and hands control straight to
       * the player, so `userPut` is on at frame 1 and stays on. Taking that as
       * the answer reported Loom interactive at frame 1 and then measured a
       * floor click that could not move a character who was not there, which
       * reads exactly like a broken walk and is a game waiting to be started.
       * A click on STANDARD starts it, and everything below then works.
       */
      const ego = game.getActor(game.variables[game.vars.EGO]);
      if (!ego || ego.room !== game.currentRoom) {
        return `the player character is not in room ${game.currentRoom} yet`;
      }
      return null;
    },
    playerAt: () => {
      const ego = game.getActor(game.variables[game.vars.EGO]);
      return ego ? { x: ego.x, y: ego.y } : null;
    },
    floorTarget: () => {
      if (floorOverride) return { ...floorOverride, what: 'the point asked for' };
      const ego = game.getActor(game.variables[game.vars.EGO]);
      if (!ego) return null;
      // Somewhere on the floor the player is not already standing, and not on
      // top of an object: a click where the player already is walks nowhere,
      // and a click on an object composes a sentence instead of a walk. Both
      // read as "the walk does not work" in a report, and neither is that.
      const band = game.screen.main;
      for (const fraction of [0.2, 0.8, 0.35, 0.65, 0.5]) {
        for (const depth of [0.85, 0.7, 0.95]) {
          const x = Math.round(game.screen.width * fraction);
          const y = Math.round(band.top + band.height * depth);
          const room = inRoom(x, y);
          if (game.findObjectAt(room.x, room.y) !== 0) continue;
          if (game.actorFromPos(room.x, room.y) !== 0) continue;
          if (Math.hypot(room.x - ego.x, room.y - ego.y) < 24) continue;
          return {
            x,
            y,
            what: `bare floor (room ${room.x},${room.y}), ${Math.round(
              Math.hypot(room.x - ego.x, room.y - ego.y),
            )}px from the player, screen`,
          };
        }
      }
      return null;
    },
    objectTarget: () => {
      if (objectOverride) return { ...objectOverride, what: 'the point asked for' };
      const band = game.screen.main;
      for (let y = band.top; y < band.top + band.height; y += 4) {
        for (let x = 0; x < game.screen.width; x += 4) {
          const room = inRoom(x, y);
          const id = game.findObjectAt(room.x, room.y);
          if (id === 0) continue;
          const name = game.getObjectName(id);
          if (!name) continue;
          return { x, y, what: `${JSON.stringify(name)} (object ${id})` };
        }
      }
      return null;
    },
    chooseVerb: async () => {
      // `bounds` is filled in by `render`, never by `step`, so a verb only has
      // a rectangle here because this probe renders every frame. A harness that
      // stepped without rendering would find every verb at 0,0,0,0 and conclude
      // the game has no interface.
      const wanted = (verbWanted ?? '').toLowerCase();
      const candidates = game.verbs.all.filter(
        (verb) => verb.enabled && verb.id !== 0 && verb.bounds.right > verb.bounds.left,
      );
      /**
       * A verb with a **name** is preferred over one without, and that is not
       * cosmetic. Day of the Tentacle's inventory slots are verbs too — image
       * verbs, drawn from the item's own artwork — and taking the first
       * enabled verb picked slot 1 of the inventory, which chooses nothing and
       * made this step report a response that no verb had asked for.
       *
       * The `look` preference is a preference and not a requirement for the
       * same game's sake: its verb strip is hand-lettered and its font carries
       * ligatures, so "Look at" is stored as `L`, one glyph meaning `oo`, `k`
       * — which no regular expression over the text will match. Falling
       * through to the first *named* verb gets "Give" rather than an icon,
       * which is a verb a player could have chosen.
       */
      const verb =
        // Guarded, because with no `--verb` the wanted text is empty and an
        // image verb's text is empty too — which matched, and was how this
        // came to click Day of the Tentacle's first inventory slot.
        (wanted === ''
          ? undefined
          : candidates.find((each) => each.text.toLowerCase() === wanted)) ??
        candidates.find((each) => /look/i.test(each.text)) ??
        candidates.find((each) => each.text.trim() !== '') ??
        candidates[0];
      if (!verb) return null;
      const offered = candidates.map((each) => each.text).join(', ');
      const x = (verb.bounds.left + verb.bounds.right) >> 1;
      const y = (verb.bounds.top + verb.bounds.bottom) >> 1;
      // Through the pointer rather than through `handleVerbClick`, because the
      // verb hit test is half of what is being measured.
      for (let held = 0; held < hoverFrames; held += 1) {
        game.setMousePosition(x, y);
        await frame();
      }
      game.pressButton(1, x, y);
      for (let held = 0; held < PRESS_FRAMES; held += 1) await frame();
      game.releaseButton();
      await frame();
      const outcome =
        game.currentVerb === verb.id
          ? `${JSON.stringify(verb.text)} (verb ${verb.id}) at ${x},${y}`
          : `${JSON.stringify(verb.text)} at ${x},${y} — but currentVerb is ${game.currentVerb}`;
      return `${outcome}; on offer: ${offered}`;
    },
    hover: (x, y) => game.setMousePosition(x, y),
    press: (x, y) => game.pressButton(1, x, y),
    release: () => game.releaseButton(),
    note: () => {
      const ego = game.getActor(game.variables[game.vars.EGO]);
      const verbs = game.verbs.all.filter((verb) => verb.enabled);
      return [
        `room ${game.currentRoom}, userPut ${game.userPut}, currentVerb ${game.currentVerb}, ` +
          `${verbs.length} verbs enabled of ${game.verbs.all.length}`,
        ego
          ? `ego ${ego.number} at ${ego.x},${ego.y}, moving ${ego.moving}`
          : 'no ego actor in this room',
      ];
    },
  };
}

function agosProbe(game: AgosEngine): FamilyProbe {
  const positions = (): Map<string, { x: number; y: number }> => {
    const found = new Map<string, { x: number; y: number }>();
    for (const sprite of game.sprites()) {
      found.set(`${sprite.zone}:${sprite.id}`, { x: sprite.x, y: sprite.y });
    }
    return found;
  };
  let before = positions();
  /** The play area, above the panel the verb strip and inventory sit in. */
  const PANEL_TOP = 135;

  return {
    family: `AGOS (${game.targetName})`,
    notInteractive: () => {
      /*
       * Two halves, because either alone is reached during the opening and
       * neither alone is a game a player can act in. Simon 1 has an enabled box
       * within one frame of booting and then runs several thousand frames of
       * dream sequence; taking that first box as the answer measures the
       * cutscene and reports it as the game.
       */
      const boxes = game.boxes().filter((box) => box.enabled);
      const room = boxes.filter((box) => box.y + box.height <= PANEL_TOP);
      const strip = boxes.filter((box) => box.id >= 101 && box.id <= 112);
      if (room.length === 0) return 'no enabled hit area over the play area yet';
      if (strip.length === 0) return 'the verb strip (boxes 101-112) is not up yet';
      /*
       * **And no script is running**, which is the half the boxes cannot give.
       * Both halves above are true on Simon 1's *first frame* and stay true
       * through the whole dream sequence, so the probe reported frame 1 and
       * photographed a cutscene. The game refuses input while a Subroutine is
       * mid-flight (`AgosEngine.scriptRunning`), and Simon 1's opening is one
       * unbroken task from frame 61 to frame 14,478 — measured, by watching
       * the task change — so this is what separates the two.
       */
      if (game.scriptRunning) return 'a script is still running, so input is refused';
      return null;
    },
    /*
     * Simon's two games hold the walking character's position in variables 15
     * and 16 and the rest of the family holds it nowhere — the player is a
     * sprite the drawing bytecode places. So this answers for the two and null
     * for the others, and `note` reports which sprites moved either way.
     */
    playerAt: () => game.walkerAt(),
    floorTarget: () => {
      if (floorOverride) return { ...floorOverride, what: 'the point asked for' };
      // The floor is whichever box covers most of the play area, found by
      // asking the box table rather than by assuming a rectangle — the game's
      // scripts lay the interface out, and `AgosEngine.click` asks the same.
      const floor = game
        .boxes()
        .filter((box) => box.enabled && box.y + box.height <= PANEL_TOP && box.width > 120)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!floor) return null;
      return {
        x: floor.x + Math.floor(floor.width / 4),
        y: floor.y + Math.floor((floor.height * 3) / 4),
        what: `box ${floor.id} (verb ${floor.verb}, item ${floor.item})`,
      };
    },
    objectTarget: () => {
      if (objectOverride) return { ...objectOverride, what: 'the point asked for' };
      /*
       * A box in the play area small enough not to be the floor, carrying
       * either an item or a verb of its own.
       *
       * **Either, not an item only**, which is the shape Simon 2's first
       * screen is: the tournament poster is box 10, verb 208, item −1. A box
       * with no item is not an unnamed box — the reference reads `ha->verb`
       * whether or not `ha->item_ptr` is set, and this one answers a click
       * with Simon walking over and reading the poster out. Asking for an item
       * left the probe reporting that a screen with a readable poster on it
       * had nothing on it to point a verb at.
       */
      const thing = game
        .boxes()
        .filter(
          (box) =>
            box.enabled &&
            (box.item > 0 || box.verb > 0) &&
            (box.id < 101 || box.id > 112) &&
            box.y + box.height <= PANEL_TOP &&
            box.width > 0 &&
            box.width < 160,
        )
        .sort((a, b) => a.width * a.height - b.width * b.height)[0];
      if (!thing) return null;
      return {
        x: thing.x + (thing.width >> 1),
        y: thing.y + (thing.height >> 1),
        what: `box ${thing.id}, item ${thing.item} (verb ${thing.verb})`,
      };
    },
    chooseVerb: async () => {
      // Boxes 101 to 112 are the verb strip, which the reference recognises by
      // exactly that range because the game's own scripts define them there.
      // The strip carries verb numbers and no text this side can read, so the
      // report gives the number rather than inventing a word for it.
      const strip = game.boxes().filter((box) => box.enabled && box.id >= 101 && box.id <= 112);
      if (strip.length === 0) return null;
      const wanted = Number(verbWanted);
      const chosen =
        strip.find((box) => box.verb === wanted) ??
        strip.sort((a, b) => a.id - b.id)[1] ??
        strip[0]!;
      const x = chosen.x + (chosen.width >> 1);
      const y = chosen.y + (chosen.height >> 1);
      game.click(x, y);
      await frame();
      return `verb ${chosen.verb} (box ${chosen.id}) at ${x},${y}`;
    },
    /*
     * AGOS is told about clicks and not about pointer movement — `AgosInput`
     * listens for `pointerdown` alone, and `AgosEngine.click` resolves a click
     * against the box table with no pointer history behind it. So the hover
     * frames here move nothing and are not faked into doing so; they still run,
     * because a script mid-wait needs the frames either way.
     */
    hover: () => {},
    press: (x, y) => {
      game.click(x, y);
    },
    release: () => {},
    note: () => {
      const after = positions();
      const moved: string[] = [];
      for (const [key, at] of after) {
        const was = before.get(key);
        if (was && (was.x !== at.x || was.y !== at.y)) {
          moved.push(`${key} ${was.x},${was.y}→${at.x},${at.y}`);
        }
      }
      before = after;
      return [
        `${after.size} sprites drawing; ${moved.length} moved since the last look`,
        moved.length === 0 ? 'no sprite changed position' : moved.slice(0, 6).join('; '),
      ];
    },
  };
}

function skyProbe(game: SkyEngine): FamilyProbe {
  return {
    family: 'Sky',
    notInteractive: () =>
      game.describeRoom() === null ? 'no room with the pointer live and hotspots on it' : null,
    playerAt: () => game.playerAt(),
    floorTarget: () => {
      if (floorOverride) return { ...floorOverride, what: 'the point asked for' };
      const floor = game.hotspots().find((spot) => /floor/i.test(spot.name));
      return floor ? { x: floor.x, y: floor.y, what: `hotspot ${floor.name}` } : null;
    },
    objectTarget: () => {
      if (objectOverride) return { ...objectOverride, what: 'the point asked for' };
      const thing = game.hotspots().find((spot) => !/floor|menu/i.test(spot.name));
      return thing ? { x: thing.x, y: thing.y, what: `hotspot ${thing.name}` } : null;
    },
    /*
     * Sky has no verb strip to click: the verb is chosen by right-clicking
     * through a cycle of cursors, and a left click on a thing runs that thing's
     * own `mouseClick` script. So the third measurement here is the click, and
     * this reports honestly that there was no verb to choose first.
     */
    chooseVerb: async () => null,
    hover: (x, y) => {
      game.input.x = x;
      game.input.y = y;
    },
    press: (x, y) => {
      game.input.x = x;
      game.input.y = y;
      game.input.clicks += 1;
    },
    release: () => {},
    note: () => {
      const stop = game.lastStop;
      const at = game.playerAt();
      return [
        game.describeRoom() ?? 'no room the pointer is live in',
        `${at ? `foster at ${at.x},${at.y}; ` : ''}${stop ? `stopped on ${stop}` : 'nothing stopped'}`,
      ];
    },
  };
}

/**
 * Broken Sword 1.
 *
 * Two details this family gets wrong if a harness guesses at them. The pointer
 * is in **display** pixels and the hit list is in room coordinates 128 further
 * out and 40 lower, so the targets come back from `pointerTargets` already
 * converted by the engine that does the converting. And the buttons are
 * Revolution's bitfield with a deliberate one-cycle delay in `SwordUi.engine`,
 * so a press and a release in the same cycle are resorted rather than merged —
 * which is exactly what the hover/press/release/settle sequence feeds it.
 */
function swordProbe(game: SwordEngine): FamilyProbe {
  /** A hit target is the floor when its compact says so, not when it is big. */
  const isFloor = (target: { type: number }): boolean => target.type === SwordType.FLOOR;

  return {
    family: `Broken Sword (${game.targetName})`,
    notInteractive: () => game.describeNotInteractive(),
    playerAt: () => game.playerAt(),
    floorTarget: () => {
      if (floorOverride) return { ...floorOverride, what: 'the point asked for' };
      /*
       * Where a walk should be clicked, and the three ways this probe used to
       * get it wrong — each of which produced a report that read like an engine
       * defect and was not one.
       *
       * The floor compact's *centre* is not the answer: a floor spans the whole
       * walkable area, and on the demo's first screen its midpoint is 85 pixels
       * above the band George can actually stand in, so the router refused with
       * "no line through the walk grid reaches (380, 328)" — correctly. So the
       * y is George's own: the band he is standing in is walkable by
       * construction. The x steps out from his feet far enough that the walk is
       * not a no-op, staying inside the floor's rectangle and out of every
       * other target's, because a click that lands on a thing runs the thing's
       * script instead of a walk. And his feet come from `playerOnScreen`,
       * which takes the scroll off — 33 pixels on that screen — rather than
       * from a subtraction written here, which is what dropped it before.
       */
      const targets = game.pointerTargets();
      const floor = targets.find(isFloor);
      if (!floor) return null;
      const feet = game.playerOnScreen();
      if (!feet) return { x: floor.x, y: floor.y, what: `floor compact ${floor.id} (centre)` };

      const y = Math.min(Math.max(feet.y, floor.top + 2), floor.bottom - 2);
      const covered = (x: number): boolean =>
        targets.some(
          (target) =>
            !isFloor(target) &&
            x >= target.left &&
            x <= target.right &&
            y >= target.top &&
            y <= target.bottom,
        );
      for (const shift of [-120, 120, -180, 180, -60, 60]) {
        const x = feet.x + shift;
        if (x < Math.max(8, floor.left + 2)) continue;
        if (x > Math.min(SWORD1_DISPLAY_WIDTH - 8, floor.right - 2)) continue;
        if (covered(x)) continue;
        return {
          x,
          y,
          what: `floor compact ${floor.id}, ${Math.abs(shift)}px ${shift < 0 ? 'left' : 'right'} of George`,
        };
      }
      // Nothing clear: say so rather than click a point already known to be
      // unreachable and then report the walk that did not happen as a defect.
      return null;
    },
    objectTarget: () => {
      if (objectOverride) return { ...objectOverride, what: 'the point asked for' };
      // Anything that is not the floor and has a click script: a target with no
      // `mouseClick` answers a click with silence by design, and reporting that
      // as "the game did not respond" would be this probe's own fault.
      const thing = game
        .pointerTargets()
        .find((target) => !isFloor(target) && target.clickScript !== 0);
      if (!thing) return null;
      return {
        x: thing.x,
        y: thing.y,
        what: `compact ${thing.id} (type ${thing.type}, click script ${thing.clickScript})`,
      };
    },
    /*
     * There is no verb strip. Broken Sword's verb is the button: left acts,
     * right examines, and the top bar is the inventory rather than a verb menu.
     * So this reports honestly that there was nothing to choose, the way the
     * Sky adapter does for the same reason.
     */
    chooseVerb: async () => null,
    hover: (x, y) => {
      game.input.x = x;
      game.input.y = y;
    },
    press: (x, y) => {
      game.input.x = x;
      game.input.y = y;
      game.input.pressButton('left');
    },
    release: () => game.input.releaseButton('left'),
    inventory: () => game.inventoryIcons,
    note: () => {
      const targets = game.pointerTargets();
      const at = game.playerAt();
      return [
        `screen ${game.currentRoom}; ${targets.length} pointer target(s), ` +
          `${targets.filter(isFloor).length} of them floor`,
        at ? `George at ${at.x},${at.y}` : 'George has no open compact',
      ];
    },
  };
}

/**
 * Broken Sword 2.
 *
 * Simpler than Sword1's on both counts and for real reasons rather than by
 * accident: the pointer is in room coordinates less the scroll, and a button is
 * a global the scripts read on the cycle it goes down. There is no release edge
 * to send, so `release` does nothing — and it is left empty rather than faked
 * into a second press, which would be two clicks reported as one.
 */
function sword2Probe(game: Sword2Engine): FamilyProbe {
  return {
    family: `Broken Sword II (${game.targetName})`,
    notInteractive: () => game.describeNotInteractive(),
    playerAt: () => game.playerAt(),
    floorTarget: () => {
      if (floorOverride) return { ...floorOverride, what: 'the point asked for' };
      /*
       * Sword2 has no floor *compact*: `fnInitFloorMouse` writes one mouse
       * structure covering the whole room at priority 9, and a click on it is
       * the walk. So the floor is asked for by its priority — 9 is the lowest
       * the family has and the floor is the only thing that takes it
       * (`function.cpp:511`) — rather than by being last in the list, which was
       * only true while the list happened to be sorted that way.
       */
      const targets = game.pointerTargets();
      const floor = targets.find((target) => target.priority === SWORD2_FLOOR_PRIORITY);
      if (!floor) return null;
      /*
       * Where on the floor to click, and why not simply George's own y band.
       *
       * Sword1's probe steps out sideways from George because its floor is a
       * compact whose centre is above the walkable strip. Sword2's floor is the
       * whole room, so its centre is in the middle of the walk grid and is the
       * point most likely to be routable — measured: the centre walks, and a
       * point 120 pixels to the side of George's start does not, because the
       * demo's quay is fenced off that way and the router says so. So the
       * centre is tried first and George's band is the fallback, which is the
       * opposite order to Sword1's for a reason that is about the data.
       *
       * Every candidate is clamped into the *display*: the floor's rectangle is
       * the room's and the room is taller and wider than what is on screen, so
       * an unclamped point can be somewhere the pointer cannot go.
       */
      const feet = game.playerOnScreen();
      const onDisplay = (x: number, y: number): boolean =>
        x >= 0 && x < SWORD2_DISPLAY_WIDTH && y >= 0 && y < SWORD2_DISPLAY_HEIGHT;
      const covered = (x: number, y: number): boolean =>
        targets.some(
          (target) =>
            target.priority !== SWORD2_FLOOR_PRIORITY &&
            x >= target.left &&
            x <= target.right &&
            y >= target.top &&
            y <= target.bottom,
        );

      const candidates: Array<{ x: number; y: number; what: string }> = [
        { x: floor.x, y: floor.y, what: `mouse target ${floor.id} (the floor, centre)` },
      ];
      if (feet) {
        for (const shift of [-120, 120, -180, 180, -60, 60]) {
          candidates.push({
            x: feet.x + shift,
            y: feet.y,
            what:
              `mouse target ${floor.id} (the floor), ` +
              `${Math.abs(shift)}px ${shift < 0 ? 'left' : 'right'} of George`,
          });
        }
      }
      /*
       * A point the player is already standing on is not a floor target: the
       * click is legal, the walk is zero pixels long, and the step above then
       * reports "the player stayed at" about a game that had nowhere to go.
       * The centre is the first candidate and the demo's first walk ends near
       * it, so the second caller gets one of the feet-relative points instead.
       */
      const arrived = (x: number, y: number): boolean =>
        feet !== null && Math.hypot(x - feet.x, y - feet.y) < 24;
      for (const candidate of candidates) {
        if (!onDisplay(candidate.x, candidate.y)) continue;
        if (covered(candidate.x, candidate.y)) continue;
        if (arrived(candidate.x, candidate.y)) continue;
        return candidate;
      }
      // Nothing clear: say so rather than click a point already known to be
      // unreachable and then report the walk that did not happen as a defect.
      return null;
    },
    objectTarget: () => {
      if (objectOverride) return { ...objectOverride, what: 'the point asked for' };
      /*
       * A *named thing*, and three ways of not getting one.
       *
       * The scroll strips down the edges of a wide room are priority 0, so they
       * sort first and "the first target with a pointer" is one of them — and
       * clicking one scrolls the view rather than touching anything, which the
       * report then calls a response. They are told by their pointer: 1440 and
       * 1441 are the two scroll arrows (`defs.h:170-171`).
       *
       * A target's rectangle is in room coordinates less the scroll, so half of
       * one may be off the left of the display. Its midpoint can be negative —
       * the probe clicked -70,298 before this — and a click there is not a
       * click on anything.
       *
       * And the floor is not a thing: clicking it is check 2's job.
       */
      const targets = game.pointerTargets();
      const thing = targets.find(
        (target) =>
          target.pointer !== 0 &&
          target.pointer !== SWORD2_SCROLL_LEFT_POINTER &&
          target.pointer !== SWORD2_SCROLL_RIGHT_POINTER &&
          target.priority !== SWORD2_FLOOR_PRIORITY &&
          target.x >= 0 &&
          target.x < SWORD2_DISPLAY_WIDTH &&
          target.y >= 0 &&
          target.y < SWORD2_DISPLAY_HEIGHT,
      );
      if (!thing) return null;
      return { x: thing.x, y: thing.y, what: `object ${thing.id} (pointer ${thing.pointer})` };
    },
    /* The same interface as Sword1: the button is the verb. */
    chooseVerb: async () => null,
    hover: (x, y) => {
      game.input.x = x;
      game.input.y = y;
    },
    press: (x, y) => {
      game.input.x = x;
      game.input.y = y;
      game.input.pressButton('left');
    },
    release: () => {},
    inventory: () => game.inventoryIcons,
    note: () => {
      const at = game.playerAt();
      return [
        `session ${game.currentRoom}; ${game.pointerTargets().length} pointer target(s), ` +
          `MOUSE_AVAILABLE ${game.mouseAvailable ? 1 : 0}`,
        at ? `the player character at ${at.x},${at.y}` : 'no player position yet',
      ];
    },
    /*
     * The inventory opens by being *reached*, not by being clicked: the pointer
     * goes to the bottom of the display and `Mouse::normalMouse` notices on the
     * next cycle. So this hovers and lets frames pass — pressing here would
     * measure a click on whatever is behind the bar and report the one gesture
     * the interface is built on as absent.
     */
    openInventory: async () => {
      game.input.x = SWORD2_DISPLAY_WIDTH / 2;
      game.input.y = SWORD2_DISPLAY_HEIGHT - 10;
      for (let held = 0; held < HOVER_FRAMES; held++) await frame();
      const open = game.inventoryOpen;
      const carried = game.inventoryIcons;
      if (!open) {
        // Two different noes, and they were indistinguishable until this said
        // which: a mouse engine that did not notice the pointer, and a game
        // that has taken the pointer away and runs no mouse engine at all.
        return game.mouseAvailable
          ? 'the bar did not open'
          : 'the bar did not open — the game has the pointer (MOUSE_AVAILABLE 0), ' +
              'so no mouse mode runs';
      }
      return carried.length === 0
        ? 'the bar opened, and the player is carrying nothing at this point in the demo'
        : `the bar opened with ${carried.length} object(s): ${carried.join(', ')}`;
    },
    /*
     * Clicking a pocket is `Mouse::menuMouse`'s left-button arm: it takes the
     * object out of the bar and into `MOUSE_drag`, and the luggage is the
     * sprite the pointer then carries. The pointer is moved off the bar
     * afterwards and up into the room, because the whole point of the luggage
     * is that it is visible over the *picture* — and it is left there rather
     * than clicked, so nothing is used on anything.
     */
    dragInventoryItem: async () => {
      if (!game.inventoryOpen) return 'the bar is not open, so there is nothing to pick up';
      const carried = game.inventoryIcons;
      if (carried.length === 0) return 'the bar is empty at this point in the demo';
      const x = SWORD2_ICON_START + (SWORD2_ICON_WIDTH >> 1);
      const y = SWORD2_BOTTOM_MENU_TOP + (SWORD2_ICON_DEPTH >> 1);
      game.input.x = x;
      game.input.y = y;
      /*
       * Let whatever the last step set going finish before the pick-up. A
       * script that reaches `fnAddHuman` hands the pointer back and drops what
       * is held (`mouse.cpp:1390-1399`), so picking an icon up while the
       * player's own logic is still running its last action measures the drop
       * rather than the carry. The pointer rests on the bar throughout, which
       * is what keeps the bar open.
       */
      for (let quiet = 0; quiet < SETTLE_FRAMES; quiet++) await frame();
      game.input.pressButton('left');
      /*
       * The press is read on the *next* cycle the mouse engine spends in menu
       * mode, not necessarily this one: a click is an event in a one-slot queue
       * and a cycle that only changes mode does not read it
       * (`Sword2Pointer.tookEvent`). So this waits for the pick-up rather than
       * assuming a fixed number of frames, and gives up rather than hanging.
       */
      let picked = false;
      for (let held = 0; held < PRESS_FRAMES && !picked; held++) {
        await frame();
        picked = game.draggedIcon !== 0;
      }
      if (!picked) return 'the pocket was clicked and nothing was picked up';
      const onBar =
        game.describeStall().find((line) => line.startsWith('mouse:')) ?? 'nothing about it';
      game.input.x = SWORD2_DISPLAY_WIDTH / 2;
      game.input.y = SWORD2_DISPLAY_HEIGHT / 2;
      /*
       * A short settle on purpose, where every other step here uses the long
       * one — and one that stops the moment the game puts the object down.
       * Holding something is a state the game is entitled to end: any script
       * that reaches `fnAddHuman` drops what is held (`mouse.cpp:1390-1399`),
       * and over the 240 frames the other steps wait, one does. What this step
       * measures is the luggage on the display, so it stops while it is there.
       */
      for (let settled = 0; settled < 12 && game.draggedIcon !== 0; settled++) await frame();
      // The engine's own status line, which names the luggage and says whether
      // it is on screen. Read out of `describeStall` rather than through a new
      // accessor: the sentence is already published there.
      const inRoom =
        game.describeStall().find((line) => line.startsWith('mouse:')) ?? 'nothing about it';
      return `on the bar: ${onBar}\n   in the room: ${inRoom}`;
    },
  };
}

const probe: FamilyProbe =
  engine instanceof ScummEngine
    ? scummProbe(engine)
    : engine instanceof AgosEngine
      ? agosProbe(engine)
      : engine instanceof SkyEngine
        ? skyProbe(engine)
        : engine instanceof SwordEngine
          ? swordProbe(engine)
          : engine instanceof Sword2Engine
            ? sword2Probe(engine)
            : null!;

if (!probe) {
  console.error(`${engine.constructor.name} has no probe adapter yet.`);
  process.exit(1);
}

// ------------------------------------------------------------- the report --

const lines: string[] = [];
const say = (text: string): void => {
  console.log(text);
  lines.push(text);
};

say(`Playability probe: ${source.label}`);
say(`  ${probe.family}`);
say('');

// 1 — does it reach an interactive state unaided?
let reachedAt: number | null = null;
let skips = 0;
for (let at = 1; at <= frames; at += 1) {
  /*
   * Escape at a scene the game has marked skippable, which is what a player who
   * has seen the opening does. The gate is the game's own: a cutscene override
   * exists only while a scene may be skipped, so this never presses past
   * something the game meant a player to sit through. Day of the Tentacle needs
   * it — left alone its opening is still running five game-minutes in.
   */
  if (
    skipCutscenes &&
    engine instanceof ScummEngine &&
    !engine.userPut &&
    engine.scriptState.currentOverride.pointer >= 0
  ) {
    engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY] || 27);
    engine.releaseKey();
    skips += 1;
  }
  /*
   * The same rule for AGOS, asked of the same authority: bit 9 is the game
   * saying this sequence may be abandoned, and `AgosEngine.cutsceneSkippable`
   * reports it. Simon 2 needs it — its opening is thirty thousand frames long
   * and every one of them refuses input; with the bit honoured the sequence
   * ends at frame 64 through the reference's own `endCutscene`. Simon 1 is
   * untouched, because its opening never sets the bit and this never presses.
   */
  if (skipCutscenes && engine instanceof AgosEngine && engine.cutsceneSkippable) {
    engine.key('Escape');
    skips += 1;
  }
  /*
   * And the same rule for both Broken Swords, asked of the same authority.
   *
   * Every film in this family is skippable — Revolution's player checks for
   * Escape on each frame of every one — so `cutsceneSkippable` is simply "a
   * film is running". Broken Sword 1 needs it badly: its intro is 1,908 frames
   * and the probe sat through all of them, reporting a game that took 2,343
   * frames to hand over control. One press, at the first frame of the film,
   * and it is 432.
   *
   * This said "Broken Sword II's demo plays no film, so this never presses
   * there". It plays one — a sixty-frame title card in `demo.smdk`, which this
   * project skipped over on the extension until the lookup started asking the
   * bytes. One press there too, and interactive moves from frame 63 to 81.
   */
  if (
    skipCutscenes &&
    (engine instanceof SwordEngine || engine instanceof Sword2Engine) &&
    engine.cutsceneSkippable
  ) {
    engine.input.pressSkip();
    skips += 1;
  }
  if (escapes.has(at)) {
    if (engine instanceof ScummEngine) {
      engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY] || 27);
      engine.releaseKey();
    } else if (engine instanceof AgosEngine) engine.key('Escape');
    else if (engine instanceof SwordEngine || engine instanceof Sword2Engine) {
      engine.input.pressSkip();
    }
    skips += 1;
  }
  const opening = openingClicks.get(at);
  if (opening) probe.press(opening.x, opening.y);
  await frame();
  if (opening) probe.release();
  /*
   * The frame it last *became* interactive, not the first frame it looked it.
   * A booting SCUMM game has `userPut` on for a moment before its boot script
   * takes control away, so "first interactive frame" answers 1 for a game that
   * then plays four minutes of intro — a true-looking number that describes
   * nothing. Losing control resets this, so what is reported is the transition
   * the player is actually on the other side of.
   */
  if (probe.notInteractive() === null) reachedAt ??= at;
  else reachedAt = null;
}

const blocked = probe.notInteractive();
say('1. Reaches an interactive state');
say(
  blocked === null
    ? `   YES — at frame ${reachedAt} of ${frames}`
    : `   NO — after ${frames} frames, ${blocked}`,
);
say(
  skips === 0
    ? '   with nothing pressed at all'
    : `   after ${skips} Escape press(es), each at a scene the game marked skippable`,
);
for (const note of probe.note()) say(`   ${note}`);
say(`   picture: ${await shoot('probe-1-interactive')}`);
say('');

// 2 — does a click on the floor move the player character?
say('2. A hover-then-click on the floor moves the player character');
const floor = probe.floorTarget();
if (!floor) {
  say('   NOT TESTED — nothing on screen answers as floor');
} else {
  const was = probe.playerAt();
  const delta = await clickAt(probe, floor.x, floor.y);
  const now = probe.playerAt();
  const moved = was && now ? Math.hypot(now.x - was.x, now.y - was.y) : null;
  say(`   clicked ${floor.what} at ${floor.x},${floor.y}`);
  if (was && now) {
    say(
      moved! >= 2
        ? `   YES — the player went ${was.x},${was.y} → ${now.x},${now.y} (${moved!.toFixed(0)}px)`
        : `   NO — the player stayed at ${was.x},${was.y}`,
    );
  } else {
    say(`   position unavailable for this family; ${delta} pixels of the screen changed`);
  }
  for (const note of probe.note()) say(`   ${note}`);
  say(`   picture: ${await shoot('probe-2-floor-click')}`);
}
say('');

// 3 — does a verb pointed at a thing produce a response?
/*
 * The inventory is asked for here, before the object click, and the order is
 * the measurement rather than a tidiness.
 *
 * Step 3 clicks a named thing, and on Broken Sword II's demo the only named
 * thing reachable ends in a session change that switches the human off. The
 * mouse engine does not run at all with the human off — `Mouse::mouseEngine`
 * returns immediately (`mouse.cpp:240-243`) — so an inventory asked for after
 * that click reports "did not open" about a game that has taken the pointer
 * away, which is a true sentence about the wrong moment. Measured in that
 * order it said exactly that.
 */
let stepNumber = 3;
if (probe.openInventory) {
  say(`${stepNumber}. The player can open their inventory`);
  const answer = await probe.openInventory();
  say(`   ${answer}`);
  say(`   picture: ${await shoot('probe-inventory')}`);
  say('');
  stepNumber++;

  if (probe.dragInventoryItem) {
    say(`${stepNumber}. An object picked up is carried on the pointer`);
    const before = pixels(engine).rgb;
    say(`   ${await probe.dragInventoryItem()}`);
    const after = pixels(engine).rgb;
    say(`   ${changed(before, after)} pixels of the screen differ from before the pick-up`);
    say(`   picture: ${await shoot('probe-luggage')}`);
    say('');
    stepNumber++;
  }
}

/*
 * Save, walk away, restore — and then say whether the world came back.
 *
 * Three things are compared because a save that carried only one of them would
 * pass a weaker check and still be useless: the room, where the player is
 * standing, and what they are carrying. The walk in between is the point of it.
 * Without a divergence a restore that did nothing at all would report a perfect
 * match, so the step fails itself out loud when the player did not move: an
 * unmoved player makes the comparison afterwards meaningless rather than true.
 *
 * Gated on `inventory` because that is the member the third comparison needs;
 * a family that cannot say what is carried would be measured on two thirds of
 * the question and reported as if it were the whole one.
 */
if (probe.inventory) {
  const where = (at: { x: number; y: number } | null): string =>
    at ? `${at.x},${at.y}` : 'unknown';
  const same = (a: readonly number[], b: readonly number[]): boolean =>
    a.length === b.length && a.every((item, index) => item === b[index]);

  say(`${stepNumber}. A game saved, walked away from and restored is the game that was saved`);
  let saved: SavedGameEnvelope | null = null;
  const settled = await walkOut(probe);
  if (!settled) say('   the player was still moving after 240 frames; saved mid-walk');
  const room = engine.currentRoom;
  const at = probe.playerAt();
  const carried = [...probe.inventory()];
  try {
    saved = engine.saveState('probe');
  } catch (error) {
    say(`   NOT SAVED — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (saved) {
    const bytes = JSON.stringify(saved).length;
    say(
      `   saved ${bytes} bytes at room ${room}, player ${where(at)}, ` +
        `inventory [${carried.join(', ')}] (${carried.length} object(s))`,
    );
    const away = probe.floorTarget();
    if (away) {
      await clickAt(probe, away.x, away.y);
      await walkOut(probe);
    }
    const walked = probe.playerAt();
    const distance = at && walked ? Math.hypot(walked.x - at.x, walked.y - at.y) : 0;
    say(
      away === null
        ? '   NOT DIVERGED — nothing on screen answers as floor, so there was nowhere to walk'
        : distance >= 2
          ? `   walked away to ${where(walked)} (${distance.toFixed(0)}px), so the restore has something to undo`
          : `   NOT DIVERGED — the walk did not move the player (still ${where(walked)})`,
    );
    engine.loadState(saved);
    await walkOut(probe);
    const nowRoom = engine.currentRoom;
    const nowAt = probe.playerAt();
    const nowCarried = [...probe.inventory()];
    const matched =
      nowRoom === room && where(nowAt) === where(at) && same(carried, nowCarried) && distance >= 2;
    say(
      matched
        ? `   YES — restored to room ${nowRoom}, player ${where(nowAt)}, ` +
            `inventory [${nowCarried.join(', ')}] (${nowCarried.length} object(s))`
        : `   NO — restored to room ${nowRoom}, player ${where(nowAt)}, ` +
            `inventory [${nowCarried.join(', ')}]; wanted room ${room}, player ${where(at)}, ` +
            `inventory [${carried.join(', ')}]`,
    );
    for (const note of probe.note()) say(`   ${note}`);
    say(`   picture: ${await shoot('probe-save-restore')}`);
  }
  say('');
  stepNumber++;
}

say(`${stepNumber}. A verb chosen, then a hover-then-click on a named thing, answers`);
const verb = await probe.chooseVerb();
say(verb === null ? '   no verb interface to choose from' : `   chose ${verb}`);
const object = probe.objectTarget();
if (!object) {
  say('   NOT TESTED — nothing on screen answers as a named thing');
} else {
  const was = probe.playerAt();
  const delta = await clickAt(probe, object.x, object.y);
  const now = probe.playerAt();
  say(`   clicked ${object.what} at ${object.x},${object.y}`);
  say(
    delta > 0
      ? `   RESPONSE — ${delta} pixels of the screen changed after the click`
      : '   NOTHING — the framebuffer was byte-identical after the click',
  );
  // Pixels alone cannot tell a reply apart from an animation that was running
  // anyway, so say whether the player went to the thing as well. Neither on its
  // own is the answer; both on the page is.
  if (was && now) {
    const went = Math.hypot(now.x - was.x, now.y - was.y);
    say(
      went >= 2
        ? `   and the player walked ${was.x},${was.y} → ${now.x},${now.y} to reach it`
        : `   the player did not move (still ${was.x},${was.y})`,
    );
  }
  for (const note of probe.note()) say(`   ${note}`);
  say(`   picture: ${await shoot('probe-3-verb-object')}`);
}
say('');

say('What the engine says it is doing:');
for (const line of engine.describeStall()) say(`   ${line}`);
say('');
say('Neither "playable" nor "Completable" is claimed by this tool: it reports');
say('positions and pixel counts, and the words are a person’s to write.');

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'probe.txt'), `${lines.join('\n')}\n`);
