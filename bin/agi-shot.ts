/**
 * Boots a real AGI game headlessly and writes what is on the screen as a PNG.
 *
 *   npm run shot:agi -- games/kq3 out/ --at=2,10 --keys=13@1,13@3
 *   npm run shot:agi -- games/kq3 out/ --interpreter=2089 --keys=13@3
 *   npm run shot:agi -- games/kq3 out/ --keys=13@1 --walk=1@2 --say="look"@6
 *
 * ## Why this exists, next to `render:agi`
 *
 * `npm run render:agi` draws a Picture or a View **standalone**, which answers
 * whether the decoder works. It cannot answer whether the *game* drew a room:
 * the priority bands, the objects the Logic placed, the status line, the input
 * line and the menu are all things only the running interpreter assembles.
 *
 * That gap is the same one `shot:sci` exists to close, and it is where AGI's
 * characteristic faults live — a flood fill that leaks, a priority band off by
 * one row, an actor drawn behind the scenery. Every one of those produces
 * output that is plausible and wrong, and `docs/processes/verifying-version-
 * support.md` says so: correctness here is judged by eye, and this makes the
 * judgement repeatable rather than a one-off.
 *
 * `--keys` matters more for AGI than for the siblings. A Sierra title screen
 * waits for a keypress and nothing else will move it on: King's Quest III sits
 * in room 45 for as long as you like, and one Enter takes it to room 7 with the
 * player in control. Without a way to press a key, a screenshot tool can only
 * ever photograph the title.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';
import { AGI_PLATFORMS, type AgiPlatform } from '../src/authoring/target.js';
import { SCREEN_WIDTH } from '../src/engine/gfx/Screen.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

const path = resolve(positional[0] ?? '.');
const outDir = resolve(positional[1] ?? 'out');

/** `--at=0,4,20` writes a frame at each of those numbers of seconds. */
const at = (flags.find((flag) => flag.startsWith('--at='))?.slice('--at='.length) ?? '4')
  .split(',')
  .map((part) => Number(part.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)
  .sort((a, b) => a - b);

/**
 * `--keys=13@1,27@5` presses a key at a time, the way a player would.
 *
 * The code is what `pressKey` takes: an ASCII code in the low byte and a scan
 * code in the high one, so `13@1` is Enter after a second and `--keys=$1b00@2`
 * would be a scan code. Written as decimal unless prefixed with `0x`.
 */
const keys = flags
  .filter((flag) => flag.startsWith('--keys='))
  .flatMap((flag) => flag.slice('--keys='.length).split(','))
  .map((entry) => {
    const [code, when] = entry.split('@');
    return { code: Number(code), at: Number(when ?? 0) };
  })
  .filter((entry) => Number.isFinite(entry.code) && Number.isFinite(entry.at))
  .sort((a, b) => a.at - b.at);

/**
 * `--walk=3@2,0@6` holds a direction, the way the arrow keys do in the browser.
 *
 * The number is AGI's own direction, 1 to 8 clockwise from up, and 0 to stop —
 * `setEgoDirection`, not `pressKey`. The two are different paths on purpose: in
 * the running app the arrow keys reach `setDirection` and everything else
 * reaches `pressKey` (`AgiInput`), and a scan code sent through `pressKey` sets
 * `V.KEY` and fires `set.key` bindings but never moves ego. Without this flag a
 * headless shot could not walk the character at all, so ego motion — the one
 * part of the renderer that only shows once something moves — went unchecked.
 */
const walks = flags
  .filter((flag) => flag.startsWith('--walk='))
  .flatMap((flag) => flag.slice('--walk='.length).split(','))
  .map((entry) => {
    const [direction, when] = entry.split('@');
    return { direction: Number(direction), at: Number(when ?? 0) };
  })
  .filter(
    (entry) =>
      Number.isFinite(entry.direction) &&
      entry.direction >= 0 &&
      entry.direction <= 8 &&
      Number.isFinite(entry.at),
  )
  .sort((a, b) => a.at - b.at);

/**
 * `--say=look@3` types a whole parser line, the way the input line does.
 *
 * `pressKey` and `--walk` reach the keyboard and the arrow keys; neither reaches
 * the parser, which is AGI's whole means of acting on the world. `submitLine` is
 * already public for exactly this — `AgiInput` is not the only host — but no
 * diagnostic called it, so a headless run could walk the character and never
 * make it *do* anything. A command may contain spaces, so unlike `--keys` and
 * `--walk` each `--say` is one entry split on its last `@`, not comma-separated.
 */
const says = flags
  .filter((flag) => flag.startsWith('--say='))
  .map((flag) => flag.slice('--say='.length))
  .map((entry) => {
    const at = entry.lastIndexOf('@');
    return {
      text: at >= 0 ? entry.slice(0, at) : entry,
      at: at >= 0 ? Number(entry.slice(at + 1)) : 0,
    };
  })
  .filter((entry) => entry.text.length > 0 && Number.isFinite(entry.at))
  .sort((a, b) => a.at - b.at);

/** `--scale=3` replicates each pixel, for looking at small detail. */
const scale =
  Number(flags.find((flag) => flag.startsWith('--scale='))?.slice('--scale='.length) ?? 1) || 1;

/**
 * `--interpreter=2917` boots under a named arity table rather than the game's.
 *
 * AGI's axis *is* the arity table — a major fixes packaging and nothing about
 * decoding (ADR 0012) — so "does this build play the game" is a question about
 * a table, and without this flag it could only be asked of whichever table the
 * probe settled on. A matrix over `DECLARABLE_INTERPRETERS` had a decompile
 * number and an export number per build, and one boot shared between them.
 *
 * Playing on a table that is not the game's is allowed and is the point: ADR
 * 0013's rule is that a guessed build **plays** and is refused for *editing*,
 * because a wrong argument count costs nothing on an opcode no script reaches
 * and costs an author's work the moment it is written back. So a boot under a
 * ruled-out table is expected to run, and what is worth watching is where it
 * stops.
 *
 * The major has to match the packaging in front of it — `detectAgiGame`
 * refuses `2.917` over a v3 install by name rather than failing later as a
 * corrupt resource.
 */
const declaredDigits = flags
  .find((flag) => flag.startsWith('--interpreter='))
  ?.slice('--interpreter='.length);
const declaredPlatform = flags
  .find((flag) => flag.startsWith('--platform='))
  ?.slice('--platform='.length) as AgiPlatform | undefined;

if (declaredPlatform && !AGI_PLATFORMS.includes(declaredPlatform)) {
  console.error(`--platform must be one of ${AGI_PLATFORMS.join(', ')}.`);
  process.exit(1);
}

const declaredInterpreter = declaredDigits
  ? {
      interpreter: Number.parseInt(declaredDigits, 16),
      platform: declaredPlatform ?? ('dos' as AgiPlatform),
    }
  : undefined;

const engine = await AgiEngine.create(await openGame(path), {
  onLog: (message) => console.log(`[log] ${message}`),
  ...(declaredInterpreter ? { declaredInterpreter } : {}),
});
engine.boot();
await mkdir(outDir, { recursive: true });

const shoot = async (seconds: number): Promise<void> => {
  engine.render();
  // **`flush` or the PNG is black.** The palette materialises its RGBA on
  // demand, so a writer that reads `rgba` without asking for it first gets
  // zeros — which looks exactly like a renderer that drew nothing, and cost
  // `shot:sci` a round of chasing the wrong thing.
  engine.palette.flush();
  const { pixels } = engine.screen;
  const { rgba } = engine.palette;
  const width = SCREEN_WIDTH * scale;
  const height = (pixels.length / SCREEN_WIDTH) * scale;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixels[Math.floor(y / scale) * SCREEN_WIDTH + Math.floor(x / scale)] << 2;
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

let elapsed = 0;
const pending = [...keys];
const pendingWalks = [...walks];
const pendingSays = [...says];

for (const target of at) {
  while (elapsed < target * 60) {
    while (pending.length > 0 && pending[0].at * 60 <= elapsed) {
      const key = pending.shift()!;
      engine.pressKey(key.code);
      console.log(`[key] ${key.code} at ${key.at}s`);
    }
    while (pendingWalks.length > 0 && pendingWalks[0].at * 60 <= elapsed) {
      const walk = pendingWalks.shift()!;
      engine.setEgoDirection(walk.direction);
      console.log(`[walk] direction ${walk.direction} at ${walk.at}s`);
    }
    while (pendingSays.length > 0 && pendingSays[0].at * 60 <= elapsed) {
      const say = pendingSays.shift()!;
      engine.submitLine(say.text);
      console.log(`[say] "${say.text}" at ${say.at}s`);
    }
    elapsed += engine.ticksPerStep;
    engine.step();
  }
  await shoot(target);
}

console.log(`\nAGI "${engine.gameId}" — room ${engine.currentRoom} after ${at.at(-1)}s`);
for (const line of engine.describeStall()) console.log(`  ${line}`);
