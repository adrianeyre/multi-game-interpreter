/**
 * Plays a Broken Sword demo from its first screen to its ending, and says what
 * it did on the way.
 *
 *   npm run play:sword -- <game> [--out=<dir>] [--shot=<name>]
 *
 * ## What this is for
 *
 * `CONTEXT.md` gives **Completable** one meaning: "it can be played from its
 * first screen to its last, saving and resuming along the way." Every other
 * family here has to borrow a person's word for that, because their games are
 * not on this machine. These two are, so — like `bin/vt-playthrough.ts`, which
 * this is modelled on — this is a harness that can answer the question with a
 * measurement instead of a claim.
 *
 * The claim it supports is deliberately small. **Both installs here are the DOS
 * demos**, and a demo's last screen is its own: Broken Sword 1's is the film in
 * `SMACKSHI/ENDDEMO.SMK`, reached from the Ireland-teaser screen, and Broken
 * Sword II's is `Enddemo.smk` and the credits, reached by climbing the fence
 * once the dog is gone. Reaching those is Completable **for the demo Release**
 * and says nothing about the retail game, whose remaining screens live in
 * clusters neither install ships. `docs/released-games.md` records the tier
 * with that distinction spelled out.
 *
 * ## The two routes, and why they are written out
 *
 * Neither route is discovered at run time. Each is the sequence of clicks the
 * game's own scripts require, read out of the compiled scripts and then checked
 * by running them: every line below is a thing a player does, and the comment
 * beside it names the script variable that moves when they do. Writing them out
 * is what makes a failure legible — when a step stops working, the run stops at
 * a named step with the game's own state beside it, rather than ending in a
 * screen nobody expected.
 *
 * ## Three rules a driver here has to keep
 *
 * They are the same three `bin/play-probe.ts` documents, and each was learned
 * by getting a wrong answer first:
 *
 *  - **Hover, then press.** These games keep "what the pointer is over" in
 *    script variables updated across frames. Setting the position and pressing
 *    in one frame is a click on nothing.
 *  - **Render every frame.** Menu and target rectangles are populated by
 *    `render()`, so a loop that only steps is hit-testing an empty screen.
 *  - **Yield every frame.** Both engines load clusters asynchronously from
 *    inside a synchronous `step()`, so a synchronous frame loop never lets the
 *    bytes arrive.
 *
 * And one this file adds: **wait for a condition, never for a frame count.**
 * Speech length, walk length and load time all vary, so `settle` waits until
 * the engine says the player is in control again. The one exception is marked
 * where it occurs — Broken Sword II's chimney has a 120-cycle window that a
 * player is meant to act inside, and waiting for quiet there misses it.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { SwordEngine } from '../src/engine/sword1/SwordEngine.js';
import { Sword2Engine } from '../src/engine/sword2/Sword2Engine.js';
import { looksLikeSword1 } from '../src/engine/sword1/resource/swordDetect.js';
import { looksLikeSword2 } from '../src/engine/sword2/resource/sword2Detect.js';
import {
  SWORD2_BOTTOM_MENU_TOP,
  SWORD2_ICON_DEPTH,
  SWORD2_ICON_SPACING,
  SWORD2_ICON_START,
  SWORD2_ICON_WIDTH,
} from '../src/engine/sword2/Sword2Menu.js';
import { SV2 } from '../src/engine/sword2/script/sword2Vars.js';

/** Broken Sword II's display, which is not the size of its rooms. */
const SWORD2_DISPLAY_WIDTH = 640;
const SWORD2_DISPLAY_HEIGHT = 480;

/**
 * The three things the demo's one puzzle is played with, by icon resource.
 *
 * Named here rather than inline because the same icon is picked up more than
 * once and a bare 125 in the middle of a route reads like a coordinate.
 */
const SWORD2_HOOK_ICON = 51;
const SWORD2_BOTTLE_ICON = 125;
const SWORD2_BISCUIT_ICON = 48;

/**
 * The two globals the dog's own scripts keep it in.
 *
 * 158 is what the dog is doing — 2 once it has eaten the biscuits, 3 once the
 * platform is hooked out of its reach — and 156 is where it is, which reaches 2
 * when it gives up and leaves the yard. `dog_14`, `dog_12` and `platform_14`
 * are the three scripts that write them.
 */
const SWORD2_DOG_STATE = 158;
const SWORD2_DOG_PLACE = 156;

// ------------------------------------------------------------- arguments --

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  argv.find((each) => each.startsWith(`--${name}=`))?.slice(name.length + 3);
const path = argv.find((each) => !each.startsWith('--'));

if (!path) {
  console.error('Usage: npm run play:sword -- <game> [--out=<dir>]');
  process.exit(1);
}

const outDir = resolve(flag('out') ?? 'shots');

const source = await openGame(resolve(path));
const names = source.list();
const family = looksLikeSword1(names) ? 1 : looksLikeSword2(names) ? 2 : 0;
if (family === 0) {
  console.error(`${source.label} holds neither Broken Sword's clusters.`);
  process.exit(1);
}

// ----------------------------------------------------------- the journal --

/** One thing a player did, and what the game did about it. */
interface Move {
  /** What a person would say they did. */
  did: string;
  /** Where they were when it worked, or why it did not. */
  became: string;
  /** False when the step did not do what the route says it does. */
  ok: boolean;
}

const moves: Move[] = [];
/** Every screen the run stood on, in order, without repeats side by side. */
const screens: number[] = [];

function record(did: string, became: string, ok = true): void {
  moves.push({ did, became, ok });
  console.log(`${ok ? ' ' : '!'} ${did} — ${became}`);
}

function visited(room: number): void {
  if (screens[screens.length - 1] !== room) screens.push(room);
}

/** The framebuffer as RGB, through whatever palette the engine is on. */
function pixels(game: unknown): { width: number; height: number; rgb: Uint8Array } {
  const screen = (game as { screen: { width: number; height: number; pixels: Uint8Array } }).screen;
  const palette = (game as { palette: { flush(): void; rgba: Uint8ClampedArray } }).palette;
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

/** A frame, kept so the *last* one of a film can be written after it ends. */
interface Shot {
  width: number;
  height: number;
  rgb: Uint8Array;
}

async function write(shot: Shot, name: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, `${name}.png`);
  await writeFile(file, writePng(shot.width, shot.height, shot.rgb));
  return file;
}

async function shoot(game: unknown, name: string): Promise<string> {
  return write(pixels(game), name);
}

/**
 * The last frame of the last film the run has seen, and every film's name.
 *
 * Kept here rather than inside the ending loop because a film does not play in
 * the step that asks for it. Both engines load a Smacker asynchronously and
 * then own the screen for as long as it runs, so the frames of `enddemo` land
 * in whichever loop happens to be stepping when the load finishes — the click
 * that triggered it, the settle after it, or {@link watchEnding}. Recording
 * from the one place every frame in this file goes through is what makes the
 * final screenshot the film's last frame instead of the black screen after it.
 */
let lastFilm: Shot | null = null;
const films: string[] = [];

/**
 * Whether Escape is pressed at a film the game says may be skipped.
 *
 * True for the whole route, because a run that watches every cutscene it meets
 * takes minutes to reach the end and none of those films is the thing being
 * measured. False from the last click onwards: the closing film *is* the
 * ending, and a driver that skips it has nothing to photograph. Broken Sword II
 * is where this shows — the click on the fence starts `Enddemo.smk` inside its
 * own settle, so leaving the skip armed until {@link watchEnding} is reached
 * skips the film one frame into it.
 */
let skipFilms = true;

/**
 * Whether a frame has a picture on it, sampled rather than counted in full.
 *
 * Both closing films fade to black before their last frame, so "the last frame
 * of the film" and "the last frame of the film with anything on it" are two
 * different pictures and only the second is worth keeping: an all-black PNG
 * says nothing about where the demo ended. Every 16th pixel is enough to tell
 * them apart — a lit frame is lit all over — and a whole 640x480 frame per
 * step is not.
 */
function hasPicture(shot: Shot): boolean {
  let lit = 0;
  let seen = 0;
  for (let index = 0; index < shot.rgb.length; index += 48) {
    seen += 1;
    if (shot.rgb[index]! + shot.rgb[index + 1]! + shot.rgb[index + 2]! > 24) lit += 1;
  }
  return seen > 0 && lit / seen >= 0.02;
}

/** Called on every frame of the run: remembers the screen while a film is up. */
function noteFilm(game: { describeNotInteractive(): string | null }): void {
  const playing = /^the cutscene "(.*)" is playing$/.exec(game.describeNotInteractive() ?? '');
  if (!playing) return;
  const shot = pixels(game);
  if (hasPicture(shot) || !lastFilm) lastFilm = shot;
  if (films[films.length - 1] !== playing[1]!) films.push(playing[1]!);
}

/**
 * Runs frames until the game says it has ended.
 *
 * Both demos end the same way: the scripts play a closing sequence and then
 * quit, and by the time the engine reports the quit the film has been taken
 * off the screen — so the frame worth keeping is the film's last one, which
 * {@link noteFilm} already has.
 *
 * Nothing is pressed in this loop — not even a skip. The film is the answer.
 */
async function watchEnding(
  game: { hasQuit: boolean },
  frame: (skip: boolean) => Promise<void>,
  max: number,
): Promise<{ frames: number }> {
  let count = 0;
  for (; count < max && !game.hasQuit; count += 1) await frame(false);
  return { frames: count };
}

// ------------------------------------------------------- Broken Sword 1 --

/**
 * The pointer driver for Broken Sword 1: hover, press, release, settle.
 *
 * Every click goes through {@link Sword1Player.clickId}, which aims at a
 * compact by id rather than at a coordinate, because a coordinate is only
 * right until a walk moves the character and the boxes move with them.
 */
class Sword1Player {
  constructor(readonly engine: SwordEngine) {}

  async frame(skip = true): Promise<void> {
    this.engine.step();
    this.engine.render();
    noteFilm(this.engine);
    if (skip && skipFilms && this.engine.cutsceneSkippable) this.engine.input.pressSkip();
    await new Promise((done) => setImmediate(done));
  }

  /** Steps until the player is in control, and answers what stopped it. */
  async waitInteractive(max = 4000): Promise<string | null> {
    let why: string | null = null;
    for (let i = 0; i < max; i += 1) {
      why = this.engine.describeNotInteractive();
      if (why === null) return null;
      await this.frame();
    }
    return why;
  }

  /** Steps until nothing moves: same screen, same place, control back. */
  async settle(quiet = 90, max = 4000): Promise<void> {
    let still = 0;
    let last = '';
    for (let i = 0; i < max; i += 1) {
      await this.frame();
      const now = `${this.engine.currentRoom}:${JSON.stringify(this.engine.playerAt())}`;
      still = now === last && this.engine.describeNotInteractive() === null ? still + 1 : 0;
      last = now;
      if (still >= quiet) return;
    }
  }

  /**
   * A point inside this compact's box that no other clickable box covers.
   *
   * Boxes overlap — a door sits inside the room's floor — and the pointer takes
   * the topmost, so aiming at a centre can click the thing in front of it.
   */
  pointFor(id: number): { x: number; y: number } | null {
    const targets = this.engine.pointerTargets();
    const me = targets.find((target) => target.id === id);
    if (!me) return null;
    const others = targets.filter((target) => target.id !== id && target.type !== 1);
    let best: { x: number; y: number } | null = null;
    for (let y = Math.max(me.top, 41); y <= Math.min(me.bottom, 399); y += 2) {
      for (let x = Math.max(me.left, 0); x <= Math.min(me.right, 639); x += 2) {
        if (others.some((t) => x >= t.left && x <= t.right && y >= t.top && y <= t.bottom))
          continue;
        const nearer =
          !best ||
          Math.abs(x - me.x) + Math.abs(y - me.y) <
            Math.abs(best.x - me.x) + Math.abs(best.y - me.y);
        if (nearer) best = { x, y };
      }
    }
    return best;
  }

  /**
   * Hover, press, release, settle — and the release is not decoration.
   *
   * Broken Sword 1's input keeps the button as a *level* the scripts read, so a
   * press that is never released leaves the pointer held down for the rest of
   * the run: the next click is not a new press, and the conversation that
   * follows one never starts. (Broken Sword II is the opposite and has no
   * release at all — see {@link Sword2Player}.)
   */
  async clickAt(x: number, y: number): Promise<void> {
    for (let held = 0; held < 20; held += 1) {
      this.engine.input.x = x;
      this.engine.input.y = y;
      await this.frame();
    }
    this.engine.input.pressButton('left');
    for (let held = 0; held < 8; held += 1) await this.frame();
    this.engine.input.releaseButton('left');

    for (let after = 0; after < 60; after += 1) await this.frame();
    await this.waitInteractive(1200);
  }

  /** Waits for a compact to be clickable, clicks it, and settles. */
  async clickId(id: number, tries = 2500): Promise<boolean> {
    for (let i = 0; i < tries; i += 1) {
      if (this.engine.describeNotInteractive() === null) {
        const point = this.pointFor(id);
        if (point) {
          await this.clickAt(point.x, point.y);
          await this.settle();
          return true;
        }
      }
      await this.frame();
    }
    return false;
  }

  /** Opens the inventory bar (it drops from the top edge) and takes an item. */
  async take(value: number): Promise<boolean> {
    for (let i = 0; i < 400; i += 1) {
      this.engine.input.x = 320;
      this.engine.input.y = 10;
      await this.frame();
      if (this.engine.pointerInventory().length > 0) break;
    }
    const item = this.engine.pointerInventory().find((icon) => icon.value === value);
    if (!item) return false;
    this.engine.input.x = item.x;
    this.engine.input.y = item.y;
    for (let i = 0; i < 5; i += 1) await this.frame();
    this.engine.input.pressButton('left');
    for (let i = 0; i < 4; i += 1) await this.frame();
    this.engine.input.releaseButton('left');
    for (let i = 0; i < 10; i += 1) await this.frame();

    // Off the bar and back into the room, which is where it gets used.
    this.engine.input.x = 320;
    this.engine.input.y = 200;
    for (let i = 0; i < 40; i += 1) await this.frame();
    return this.engine.heldIcon === value;
  }

  /** Picks the first topic the conversation offers, until it offers none. */
  async talk(rounds = 8): Promise<number> {
    let spoken = 0;
    for (let round = 0; round < rounds; round += 1) {
      let subjects = this.engine.pointerSubjects();
      for (let i = 0; i < 600 && subjects.length === 0; i += 1) {
        await this.frame();
        subjects = this.engine.pointerSubjects();
      }
      if (subjects.length === 0) return spoken;
      const first = subjects[0]!;
      this.engine.input.x = first.x;
      this.engine.input.y = first.y;
      for (let i = 0; i < 5; i += 1) await this.frame();
      this.engine.input.pressButton('left');
      for (let i = 0; i < 4; i += 1) await this.frame();
      this.engine.input.releaseButton('left');
      // Off the bar before the line starts, so the next topic is hit-tested
      // against the room and not against the row of subjects that was there.
      this.engine.input.x = 320;
      this.engine.input.y = 200;
      for (let i = 0; i < 60; i += 1) await this.frame();
      await this.settle();
      spoken += 1;
    }
    return spoken;
  }

  /** What a player would see: room, position, what is in the rucksack. */
  where(): string {
    const at = this.engine.playerAt();
    const carried = [...this.engine.inventoryIcons];
    return (
      `screen ${this.engine.currentRoom}` +
      (at ? ` at ${at.x},${at.y}` : '') +
      `, carrying ${carried.length === 0 ? 'nothing' : carried.join(', ')}`
    );
  }
}

/**
 * Broken Sword 1's demo, from the café to the film that ends it.
 *
 * The route is the demo's own: George starts outside the bombed café on screen
 * 1, talks his way past the flics, takes the newspaper the barman leaves, uses
 * it on the workman's toolbox to get the towel, and from the alley climbs down
 * into the sewer, which is where the demo's closing film plays. Every `clickId`
 * below is one thing a player clicks, and the compact id is the game's own.
 */
async function playSword1(engine: SwordEngine): Promise<{ ended: boolean; shot: string }> {
  const player = new Sword1Player(engine);
  engine.boot();

  const opening = await player.waitInteractive(6000);
  visited(engine.currentRoom);
  record(
    'watched the opening and took control',
    opening === null ? player.where() : `still not in control: ${opening}`,
    opening === null,
  );
  if (opening !== null) return { ended: false, shot: await shoot(engine, 'sword1-stopped') };

  /** One route step: click a compact, say where it left us. */
  const step = async (did: string, id: number): Promise<boolean> => {
    const ok = await player.clickId(id);
    visited(engine.currentRoom);
    record(
      did,
      ok ? player.where() : `nothing on screen answers to compact 0x${id.toString(16)}`,
      ok,
    );
    return ok;
  };

  if (!(await step('walked into the café', 0x10003)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };

  const spoken = await player.talk();
  visited(engine.currentRoom);
  record(`talked the conversation out (${spoken} topics)`, player.where(), spoken > 0);

  if (!(await step('took the newspaper the barman left', 0x1000b)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };
  if (!(await step('went back out through the café door', 0x10003)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };

  const tookPaper = await player.take(1);
  record(
    'took the newspaper out of the rucksack',
    tookPaper ? `carrying it on the pointer` : 'the bar would not give it up',
    tookPaper,
  );

  if (!(await step('showed the workman the newspaper', 0x40003)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };
  if (!(await step('opened his toolbox while he read it', 0x40006)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };

  // ------ the save, the walk away and the resume, which are part of the bar --

  const saved = engine.saveState('halfway');
  const savedWhere = player.where();
  record('saved the game here', `${savedWhere}, ${JSON.stringify(saved).length} bytes of world`);

  const george = engine.playerOnScreen();
  if (george) {
    await player.clickAt(Math.max(20, george.x - 140), george.y);
    await player.settle();
  }
  record('walked away from the save, so a restore has something to undo', player.where(), true);

  engine.loadState(saved);
  await player.settle(20, 2000);
  const restored = player.where();
  visited(engine.currentRoom);
  record(
    'restored the save and carried on from it',
    restored === savedWhere
      ? `${restored} — the same place, the same rucksack`
      : `${restored}, and the save said ${savedWhere}`,
    restored === savedWhere,
  );

  // ------------------------------------- the rest of it, from the restore --

  if (!(await step('left the workman and his toolbox', 0x40001)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };
  if (!(await step('went back down the street', 0x10002)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };

  const tookTowel = await player.take(18);
  record(
    'took the towel out of the rucksack',
    tookTowel ? 'carrying it on the pointer' : 'the bar would not give it up',
    tookTowel,
  );

  if (!(await step('put the towel on the drainpipe', 0x20008)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };
  if (!(await step('climbed down into the alley', 0x20002)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };
  if (!(await step('opened the manhole and went underground', 0x60002)))
    return { ended: false, shot: await shoot(engine, 'sword1-stopped') };

  skipFilms = false;
  const last = await player.clickId(0x70001);
  visited(engine.currentRoom);
  record(
    'walked into the sewer chamber the demo ends in',
    last ? player.where() : 'the chamber would not take the click',
    last,
  );

  // The ending is the game's: `fnPlaySequence(18)` is SMACKSHI/ENDDEMO.SMK and
  // the script that follows it quits. Nothing here presses anything; the run
  // just keeps stepping until the engine says the game ended, or gives up
  // saying so.
  const ending = await watchEnding(engine, (skip) => player.frame(skip), 12000);
  const shot = lastFilm
    ? await write(lastFilm, 'sword1-ending')
    : await shoot(engine, 'sword1-ending');
  record(
    `let the closing film play out (${films.join(' → ') || 'no film played'})`,
    engine.hasQuit
      ? `the game ended after ${ending.frames} frames: ${engine.describeStatus()}`
      : `still running after ${ending.frames} frames: ${engine.describeStatus()}`,
    engine.hasQuit,
  );
  return { ended: engine.hasQuit, shot };
}

// -------------------------------------------------------- Broken Sword 2 --

/**
 * The pointer driver for Broken Sword II.
 *
 * The shape is {@link Sword1Player}'s and the gestures are not, because the
 * interfaces are not the same one: this game has no verb bar, it opens the
 * inventory when the pointer is *reached* to the bottom of the screen rather
 * than clicked, and a thing is used on another thing by carrying it there.
 */
class Sword2Player {
  constructor(readonly engine: Sword2Engine) {}

  async frame(skip = true): Promise<void> {
    this.engine.step();
    this.engine.render();
    noteFilm(this.engine);
    if (skip && skipFilms && this.engine.cutsceneSkippable) this.engine.input.pressSkip();
    await new Promise((done) => setImmediate(done));
  }

  async waitInteractive(max = 6000): Promise<string | null> {
    for (let i = 0; i < max; i += 1) {
      if (this.engine.describeNotInteractive() === null) return null;
      await this.frame();
    }
    return this.engine.describeNotInteractive();
  }

  /** Run frames until the game hands control back, or give up saying why. */
  async settle(quiet = 60, max = 6000): Promise<void> {
    for (let i = 0; i < quiet; i += 1) await this.frame();
    for (let i = 0; i < max; i += 1) {
      if (this.engine.describeNotInteractive() === null) return;
      await this.frame();
    }
  }

  /**
   * A point inside an object's box that no *higher-priority* box covers.
   *
   * `pointerTargets` reports the list in the order the game's own hit test
   * walks it (`checkMouseList` scans priority 0 upwards), so "what a click at
   * this point reaches" is decidable here without guessing: the first box in
   * the list containing the point wins. Aiming at a midpoint instead is how a
   * click meant for the platform lands on the screen-scroll strip beside it,
   * which is a walk and not an interaction.
   */
  pointFor(id: number): { x: number; y: number } | null {
    const list = this.engine.pointerTargets();
    const at = list.findIndex((target) => target.id === id);
    if (at < 0) return null;
    const box = list[at]!;
    const covered = (x: number, y: number): boolean =>
      list
        .slice(0, at)
        .some(
          (other) => x >= other.left && x <= other.right && y >= other.top && y <= other.bottom,
        );

    let best: { x: number; y: number } | null = null;
    let bestDistance = Infinity;
    for (let fx = 0; fx <= 16; fx += 1) {
      for (let fy = 0; fy <= 16; fy += 1) {
        const x = Math.round(box.left + ((box.right - box.left) * fx) / 16);
        const y = Math.round(box.top + ((box.bottom - box.top) * fy) / 16);
        // Inside the room: off the edges, below the system panel, above the bar.
        if (x < 2 || x >= SWORD2_DISPLAY_WIDTH - 2 || y < 46 || y >= 440) continue;
        if (covered(x, y)) continue;
        const distance = Math.hypot(x - box.x, y - box.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { x, y };
        }
      }
    }
    return best;
  }

  /** Hover, press, release, and check the game agrees it was clicked. */
  async clickId(id: number, tries = 2500): Promise<boolean> {
    for (let round = 0; round < 6; round += 1) {
      for (let i = 0; i < tries; i += 1) {
        if (this.engine.describeNotInteractive() === null && this.pointFor(id)) break;
        await this.frame();
      }
      const point = this.pointFor(id);
      if (!point) continue;

      this.engine.input.x = point.x;
      this.engine.input.y = point.y;
      for (let i = 0; i < 20; i += 1) await this.frame();
      this.engine.input.pressButton('left');
      for (let i = 0; i < 8; i += 1) await this.frame();

      let clicked = 0;
      for (let i = 0; i < 60 && clicked === 0; i += 1) {
        await this.frame();
        clicked = this.clickedId;
      }
      if (clicked === id) {
        for (let i = 0; i < 120; i += 1) await this.frame();
        return true;
      }
      for (let i = 0; i < 300; i += 1) await this.frame();
    }
    return false;
  }

  /** `CLICKED_ID`, which is where the game itself records what was clicked. */
  private get clickedId(): number {
    return this.engine.scriptVariable(SV2.CLICKED_ID);
  }

  /** Reach the pointer to the bottom of the screen, which opens the bar. */
  private async openBar(): Promise<boolean> {
    this.engine.input.x = SWORD2_DISPLAY_WIDTH / 2;
    this.engine.input.y = SWORD2_DISPLAY_HEIGHT - 10;
    for (let i = 0; i < 20; i += 1) await this.frame();
    return this.engine.inventoryOpen;
  }

  /** The point that picks the pocket at this slot. */
  private pocketPoint(slot: number): { x: number; y: number } {
    return {
      x:
        SWORD2_ICON_START +
        slot * (SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING) +
        (SWORD2_ICON_WIDTH >> 1),
      y: SWORD2_BOTTOM_MENU_TOP + (SWORD2_ICON_DEPTH >> 1),
    };
  }

  /** Pick an inventory icon up, so the pointer carries it into the room. */
  async take(icon: number): Promise<boolean> {
    if (!(await this.openBar())) return false;
    const slot = this.engine.inventoryIcons.indexOf(icon);
    if (slot < 0) return false;

    const point = this.pocketPoint(slot);
    this.engine.input.x = point.x;
    this.engine.input.y = point.y;
    for (let i = 0; i < 10; i += 1) await this.frame();
    this.engine.input.pressButton('left');
    for (let i = 0; i < 600 && this.engine.draggedIcon === 0; i += 1) await this.frame();

    // Off the bar and back into the room, which is where it gets used.
    this.engine.input.x = SWORD2_DISPLAY_WIDTH / 2;
    this.engine.input.y = 200;
    for (let i = 0; i < 10; i += 1) await this.frame();
    return this.engine.draggedIcon === icon;
  }

  /** Put down whatever is held: the game's cancel is clicking the same pocket. */
  async putDown(): Promise<boolean> {
    const held = this.engine.draggedIcon;
    if (held === 0) return true;
    if (!(await this.openBar())) return false;
    const slot = this.engine.inventoryIcons.indexOf(held);
    if (slot < 0) return false;
    const point = this.pocketPoint(slot);
    this.engine.input.x = point.x;
    this.engine.input.y = point.y;
    for (let i = 0; i < 6; i += 1) await this.frame();
    this.engine.input.pressButton('left');
    for (let i = 0; i < 60; i += 1) await this.frame();

    this.engine.input.x = SWORD2_DISPLAY_WIDTH / 2;
    this.engine.input.y = 200;
    for (let i = 0; i < 20; i += 1) await this.frame();
    return this.engine.draggedIcon === 0;
  }

  /**
   * Ask a person about everything they will answer.
   *
   * A conversation does not begin at the chooser: it begins at a click on the
   * *object* — here the window George shouts up at — whose script calls
   * `fnAddSubject` for each topic and then `fnChoose`, and only then does the
   * bottom bar carry icons to pick. `pointerSubjects` reports that bar and
   * nothing else, so before the click it is empty for the same reason it is
   * empty after the last topic, and a driver that waits for topics without
   * asking first waits forever. Hence the click is part of this method.
   */
  async talk(id: number, rounds = 8): Promise<number> {
    if (!(await this.clickId(id))) return 0;
    let spoken = 0;
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < 900 && this.engine.pointerSubjects().length === 0; i += 1) {
        await this.frame();
      }
      const [first] = this.engine.pointerSubjects();
      if (!first) break;
      this.engine.input.x = first.x;
      this.engine.input.y = first.y;
      for (let i = 0; i < 6; i += 1) await this.frame();
      this.engine.input.pressButton('left');
      for (let i = 0; i < 800; i += 1) await this.frame();
      spoken += 1;
      await this.settle();
    }
    await this.settle();
    return spoken;
  }

  /**
   * Walks somewhere else, so a restore has something to undo.
   *
   * The floor is the last target in the list: `pointerTargets` is ordered the
   * way the game's own hit test walks it, lowest priority first, and the floor
   * a room registers for walking is the highest-numbered of them. Clicking it
   * is a walk and nothing else, which is what this step wants — a change to the
   * world that the save does not have.
   */
  async walkAway(): Promise<{ from: string; to: string; moved: number }> {
    const before = this.engine.playerAt();
    const list = this.engine.pointerTargets();
    const floor = list[list.length - 1];
    const here = this.engine.playerOnScreen();

    // Somewhere *else* on the floor, which is not the same as somewhere on the
    // floor: aiming at the box's own centre is aiming at roughly where the
    // player already stands, and a walk of nothing leaves the restore below
    // with nothing to undo. So this steps out sideways, takes the first offset
    // whose point the floor actually owns — the hit list is in the game's own
    // priority order, so "owns" is decidable — and stops at the first one that
    // moved him.
    for (const dx of [-220, 220, -140, 140, -300, 300, -80, 80]) {
      if (!floor || !here) break;
      const x = here.x + dx;
      const y = here.y;
      if (x < 4 || x >= SWORD2_DISPLAY_WIDTH - 4 || y < 46 || y >= 440) continue;
      const owner = list.find(
        (box) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom,
      );
      if (!owner || owner.id !== floor.id) continue;

      this.engine.input.x = x;
      this.engine.input.y = y;
      for (let i = 0; i < 20; i += 1) await this.frame();
      this.engine.input.pressButton('left');
      await this.settle();
      const moved = this.engine.playerAt();
      if (before && moved && Math.hypot(moved.x - before.x, moved.y - before.y) >= 1) break;
    }

    const after = this.engine.playerAt();
    const moved =
      before && after ? Math.round(Math.hypot(after.x - before.x, after.y - before.y)) : 0;
    return {
      from: before ? `${before.x},${before.y}` : '?',
      to: after ? `${after.x},${after.y}` : '?',
      moved,
    };
  }

  /** Run frames until a script global reaches a value; -1 when it never does. */
  async until(variable: number, value: number, max = 8000): Promise<number> {
    for (let i = 0; i < max; i += 1) {
      if (this.engine.scriptVariable(variable) === value) return i;
      await this.frame();
    }
    return -1;
  }

  where(): string {
    const at = this.engine.playerAt();
    const room = this.engine.roomName() ?? `run list ${this.engine.currentRoom}`;
    return `${room}, Nico's partner at ${at ? `${at.x},${at.y}` : 'nowhere the mega table knows'}`;
  }
}

/**
 * Broken Sword II's demo, from the quay to the credits.
 *
 * The demo is one puzzle with four halves. George starts on the quay (run list
 * 11), climbs to the yard, and has to get past a dog that is chained to a
 * platform: he needs the biscuits from the cellar to distract it, the hook and
 * the bottle from the yard to reach them, and the chimney gives up a cloth on a
 * 120-cycle window that is the one place in either route a wait is counted in
 * cycles rather than in quiet. With the dog gone the fence into the next screen
 * opens, and climbing it plays `Enddemo.smk` and the credits.
 *
 * Object ids are the demo's own and the names beside them are the names in its
 * compiled scripts, so any of them can be looked up in a disassembly.
 */
async function playSword2(engine: Sword2Engine): Promise<{ ended: boolean; shot: string }> {
  const player = new Sword2Player(engine);
  engine.boot();

  const opening = await player.waitInteractive(8000);
  visited(engine.currentRoom);
  record(
    'watched the opening and took control',
    opening === null ? player.where() : `still not in control: ${opening}`,
    opening === null,
  );
  if (opening !== null) return { ended: false, shot: await shoot(engine, 'sword2-stopped') };

  const stop = async (): Promise<{ ended: boolean; shot: string }> => ({
    ended: false,
    shot: await shoot(engine, 'sword2-stopped'),
  });

  const step = async (did: string, id: number): Promise<boolean> => {
    const ok = await player.clickId(id);
    await player.settle();
    visited(engine.currentRoom);
    record(did, ok ? player.where() : `nothing on screen answers to object ${id}`, ok);
    return ok;
  };

  if (!(await step('climbed the fence off the quay (578 "fence")', 578))) return stop();

  const spoken = await player.talk(708);
  visited(engine.currentRoom);
  record(`asked at the window (708 "window_12"), ${spoken} topic(s)`, player.where(), spoken > 0);
  await player.putDown();

  if (!(await step('went up the steps into the yard (596 "steps_12")', 596))) return stop();
  if (!(await step('pulled the hook off the wall (308 "hook_14")', 308))) return stop();

  const tookHook = await player.take(SWORD2_HOOK_ICON);
  record(
    'picked the hook up off the bar',
    tookHook ? 'on the pointer' : 'the bar would not give it up',
    tookHook,
  );
  if (!(await step('used the hook on the bottle (309 "bottle_14")', 309))) return stop();

  if (!(await step('went back down to the alley (320 "steps_14")', 320))) return stop();
  if (!(await step('looked up the chimney (611 "chimney_12")', 611))) return stop();

  // The one wait in either route that is counted in cycles: the chimney gives
  // the cloth back on a window the scripts open for 120 cycles (global 532) and
  // a driver that waits for quiet first has already missed it. So the two
  // clicks below deliberately do not settle between them.
  const tookBottle = await player.take(SWORD2_BOTTLE_ICON);
  record(
    'picked the bottle up off the bar',
    tookBottle ? 'on the pointer' : 'the bar would not give it up',
    tookBottle,
  );
  await player.clickId(611);
  await player.clickId(611);
  await player.settle();
  record('put the bottle up the chimney twice, inside its own window', player.where());

  const tookAgain = await player.take(SWORD2_BOTTLE_ICON);
  record(
    'picked the bottle up again',
    tookAgain ? 'on the pointer' : 'the bar would not give it up',
    tookAgain,
  );
  if (!(await step('used it on the chimney a last time, for the cloth (611)', 611))) return stop();

  if (!(await step('climbed back to the yard (596 "steps_12")', 596))) return stop();
  if (!(await step('opened the trapdoor into the cellar (321 "trapdoor_14")', 321))) return stop();
  if (!(await step('took the dog biscuits (729 "biscuits_13")', 729))) return stop();
  if (!(await step('climbed out of the cellar (734 "trapdoor_13")', 734))) return stop();
  if (!(await step('down to the alley and back up, to reach the platform (320)', 320)))
    return stop();
  if (!(await step('up into the yard again (596 "steps_12")', 596))) return stop();

  const tookBiscuits = await player.take(SWORD2_BISCUIT_ICON);
  record(
    'picked the biscuits up off the bar',
    tookBiscuits ? 'on the pointer' : 'the bar would not give it up',
    tookBiscuits,
  );
  if (!(await step('put the biscuits on the platform (759 "platform_14")', 759))) return stop();

  const ate = await player.until(SWORD2_DOG_STATE, 2);
  record(
    'waited while the dog came down and ate them',
    ate >= 0 ? `${ate} cycles` : 'the dog never came',
    ate >= 0,
  );

  const tookHookAgain = await player.take(SWORD2_HOOK_ICON);
  record(
    'picked the hook up again',
    tookHookAgain ? 'on the pointer' : 'the bar would not give it up',
    tookHookAgain,
  );
  if (!(await step('hooked the platform up out of the dog’s reach (759)', 759))) return stop();

  const hooked = await player.until(SWORD2_DOG_STATE, 3);
  record(
    'waited for the dog to give up',
    hooked >= 0 ? `${hooked} cycles` : 'the dog stayed',
    hooked >= 0,
  );
  const gone = await player.until(SWORD2_DOG_PLACE, 2);
  record(
    'the dog left the yard',
    gone >= 0 ? `${gone} cycles` : 'it is still in the yard',
    gone >= 0,
  );
  if (gone < 0) return stop();

  // ------ the save, the walk away and the resume, which are part of the bar --

  const saved = engine.saveState('the dog is gone');
  const savedWhere = player.where();
  record(
    'saved the game with the yard clear',
    `${savedWhere}, ${JSON.stringify(saved).length} bytes of world`,
  );

  const walk = await player.walkAway();
  record(
    'walked away from the save, so a restore has something to undo',
    `${walk.from} → ${walk.to} (${walk.moved}px)`,
    walk.moved > 0,
  );

  engine.loadState(saved);
  await player.settle();
  visited(engine.currentRoom);
  const restored = player.where();
  record(
    'restored the save and finished the demo from it',
    restored === savedWhere
      ? `${restored} — the same place`
      : `${restored}, and the save said ${savedWhere}`,
    restored === savedWhere,
  );
  // The bar is rebuilt by the scripts rather than by the save, so the icons
  // read empty until the pointer reaches the bottom of the screen once. Doing
  // that here means the report shows the rucksack the restore really has.
  await player.take(SWORD2_HOOK_ICON);
  await player.putDown();
  record(
    'checked the rucksack survived the restore',
    `carrying ${engine.inventoryIcons.join(', ') || 'nothing'}`,
    engine.inventoryIcons.includes(SWORD2_BISCUIT_ICON),
  );

  // ------------------------------------- the rest of it, from the restore --

  if (!(await step('went back down to the alley (320 "steps_14")', 320))) return stop();
  skipFilms = false;
  if (!(await step('climbed the fence the dog was guarding (712 "fence12_2")', 712))) return stop();

  // The ending is the game's own: `fence12_2` reads global 156, finds the yard
  // clear, and hands over to `ScreenManager21` script 3, which plays
  // `Enddemo.smk` and calls `fnPlayCredits` — and in the demo that opcode is
  // where the game stops. Nothing here presses anything.
  const ending = await watchEnding(engine, (skip) => player.frame(skip), 12000);
  const shot = lastFilm
    ? await write(lastFilm, 'sword2-ending')
    : await shoot(engine, 'sword2-ending');
  record(
    `let the closing film play out (${films.join(' → ') || 'no film played'})`,
    engine.hasQuit
      ? `the game ended after ${ending.frames} frames: ${engine.describeStatus()}`
      : `still running after ${ending.frames} frames: ${engine.describeStatus()}`,
    engine.hasQuit,
  );
  return { ended: engine.hasQuit, shot };
}

// -------------------------------------------------------------- the run --

/**
 * Plays the demo this folder holds and prints what happened.
 *
 * The exit status is the answer: 0 when the game reached its ending, 1 when it
 * stopped somewhere before it. A run that stops is not a failure of the harness
 * — the last line of the journal says which step stopped and what the game's
 * own state was when it did, which is the measurement this is for.
 */
const engine =
  family === 1
    ? await SwordEngine.create(source, { onLog: (message) => console.log(`   · ${message}`) })
    : await Sword2Engine.create(source, { onLog: (message) => console.log(`   · ${message}`) });

console.log(`Playing ${source.label}`);
console.log(
  `  ${family === 1 ? 'Broken Sword' : 'Broken Sword II'}, which in this folder is the DOS demo`,
);
console.log('');

const played =
  engine instanceof SwordEngine
    ? await playSword1(engine)
    : await playSword2(engine as Sword2Engine);

console.log('');
console.log(
  `Steps: ${moves.length}, of which ${moves.filter((move) => !move.ok).length} did not do what the route says.`,
);
console.log(`Screens, in order: ${screens.join(' → ')}`);
console.log(`Final state: ${played.shot}`);
console.log(
  played.ended
    ? 'The demo reached its ending.'
    : 'The demo did not reach its ending — the last step above is where it stopped.',
);
process.exit(played.ended ? 0 : 1);
