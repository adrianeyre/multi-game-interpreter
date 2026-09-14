/**
 * Boots a real game headlessly and writes what is on the screen as a PNG.
 *
 *   npm run shot -- games/tentacle out/ --at=0,4,20
 *
 * ## Why this exists
 *
 * `npm run diagnose` answers "what is the game doing" and cannot answer "does
 * it look right". Half the faults a player reports are the second kind — an
 * object stamped ten pixels left of where it belongs, a verb panel over the
 * picture, an actor drawn behind the scenery — and every one of them is
 * invisible to a description of engine state. This renders the same
 * framebuffer the browser paints, so the judgement can be made by eye without
 * playing to the point of the fault.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument — the same rule `npm run diagnose` follows.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const path = resolve(positional[0] ?? '.');
const outDir = resolve(positional[1] ?? 'out');

/** `--at=0,4,20` writes a frame at each of those numbers of seconds. */
const at = (flags.find((a) => a.startsWith('--at='))?.slice('--at='.length) ?? '4')
  .split(',')
  .map((part) => Number(part.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)
  .sort((a, b) => a - b);

/** `--play` presses escape at a skippable scene, as a player who has seen it would. */
const play = flags.includes('--play');

/**
 * `--click=160,95@12` clicks once, at that point, at that many seconds.
 *
 * Some games open on something a keypress cannot get past. Loom CD asks for a
 * skill level and waits; Monkey Island's copy protection waits too. Without a
 * click there is one screenshot to be had of those games and it is the menu,
 * which is exactly the frame that says least about whether the renderer works.
 * Repeatable, so a sequence of choices can be walked through.
 */
const clicks = flags
  .filter((argument) => argument.startsWith('--click='))
  .map((argument) => {
    const [point, when] = argument.slice('--click='.length).split('@');
    const [x, y] = point.split(',').map((part) => Number(part.trim()));
    return { x, y, at: Number(when ?? 0) };
  })
  .filter((click) => Number.isFinite(click.x) && Number.isFinite(click.y));
/** `--scale=3` replicates each pixel, for looking at small detail. */
const scale =
  Number(flags.find((a) => a.startsWith('--scale='))?.slice('--scale='.length) ?? 1) || 1;

const engine = await loadAdventureEngine(await openGame(path), {
  onLog: (message) => console.log(`[log] ${message}`),
});
engine.boot();
await mkdir(outDir, { recursive: true });

const shoot = async (seconds: number): Promise<void> => {
  engine.render();
  const scumm = engine instanceof ScummEngine ? engine : null;
  if (!scumm) return;
  scumm.palette.flush();
  const { pixels } = scumm.screen;
  const { rgba } = scumm.palette;
  const width = 320 * scale;
  const height = (pixels.length / 320) * scale;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixels[Math.floor(y / scale) * 320 + Math.floor(x / scale)] << 2;
      const at = (y * width + x) * 3;
      rgb[at] = rgba[index];
      rgb[at + 1] = rgba[index + 1];
      rgb[at + 2] = rgba[index + 2];
    }
  }
  const name = `${engine.gameId}-${String(seconds).replace('.', '_')}s-room${engine.currentRoom}.png`;
  await writeFile(join(outDir, name), writePng(width, height, rgb));
  console.log(`[shot] ${name}`);
};

/**
 * Frames the pointer sits over a target before the button goes down.
 *
 * A click is not a coordinate, it is a gesture, and the second half of the
 * gesture is the only half some games read. SCUMM's own hover script runs
 * every frame off `VAR_VIRT_MOUSE_X`/`_Y`, and a verb only knows it is under
 * the pointer because that script told it so. Setting the position and
 * pressing in the same frame is a click on whatever the pointer was over
 * *last* frame — which, on the first click of a run, is nothing at all.
 */
const HOVER_FRAMES = 20;
/** Frames the world runs with the button held, before it is released. */
const PRESS_FRAMES = 8;
/** Frames the world runs after the release, so what the click started can act. */
const SETTLE_FRAMES = 8;

let elapsed = 0;
const pending = [...clicks].sort((a, b) => a.at - b.at);

/**
 * One frame: step the world, then draw it. Never one without the other.
 *
 * `Verb.bounds` is written by `render()` — `drawVerbs()` measures each verb as
 * it stamps it — so a loop that only steps leaves every verb with no extent,
 * `verbs.hitTest` returns 0 for every point on the panel, and `--click` on a
 * verb cannot hit one however well aimed it is. The frames are also what the
 * screenshot is of, so stepping without drawing photographs a world that was
 * never composed.
 */
const tick = (): void => {
  engine.step();
  engine.render();
  elapsed += engine.ticksPerStep;
};

/** Hover, press, release, settle — the whole gesture, through the input path. */
const clickAt = (x: number, y: number): void => {
  if (!(engine instanceof ScummEngine)) return;
  for (let frame = 0; frame < HOVER_FRAMES; frame += 1) {
    engine.setMousePosition(x, y);
    tick();
  }
  engine.pressButton(1, x, y);
  for (let frame = 0; frame < PRESS_FRAMES; frame += 1) tick();
  engine.releaseButton();
  for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) tick();
};

for (const target of at) {
  while (elapsed < target * 60) {
    if (play && engine instanceof ScummEngine) {
      if (!engine.userPut && engine.scriptState.currentOverride.pointer >= 0) {
        engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY] || 27);
        engine.releaseKey();
      }
    }

    while (pending.length > 0 && pending[0].at * 60 <= elapsed) {
      const click = pending.shift()!;
      clickAt(click.x, click.y);
      console.log(`[click] ${click.x},${click.y} at ${click.at}s`);
    }

    tick();
  }
  await shoot(target);
}
