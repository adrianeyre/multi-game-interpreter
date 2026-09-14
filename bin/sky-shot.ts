/**
 * Writes a picture out of Beneath a Steel Sky as a PNG.
 *
 *   npm run shot:sky -- <game>              # list what is drawable
 *   npm run shot:sky -- <game> <id> [frame] [--palette=<id>] [--out=<dir>]
 *   npm run shot:sky -- <game> --run [--at=<s>,…] [--click=<x>,<y>@<s>] [--out=<dir>]
 *
 * Two tools in one file, and the second is the one a playability claim needs.
 * Without `--run` this reads a resource out of the file and draws it, which
 * says the decoders are right and nothing at all about the game. With `--run`
 * it boots the game through `loadAdventureEngine`, runs its own scripts, and
 * photographs the framebuffer the browser would paint — the same thing
 * `npm run shot` has always done for SCUMM, and what this family had no way to
 * do until now.
 *
 * A sibling of `npm run shot` and `npm run shot:sci`, and the one piece of
 * evidence for this family that a person judges by eye rather than by a count.
 * `docs/processes/verifying-version-support.md` asks for screenshots "judged by
 * eye against the original", and for the two Virtual Theatre games that is
 * something a build machine can produce: they are the only games here whose
 * data it may fetch.
 *
 * ## What a picture being right proves
 *
 * More than it looks. A screen drawn correctly means the index reading found
 * the right bytes, the RNC decompressor produced the right bytes, the geometry
 * words mean what they were measured to mean, and the palette is six-bit VGA
 * widened the right way. Any one of those wrong gives noise, stripes or the
 * wrong colours — which is why one recognisable screen is worth a page of
 * assertions.
 */

import { join, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { openGame } from '../src/hosting/openGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { SkyEngine } from '../src/engine/sky/SkyEngine.js';
import { SkyResources } from '../src/engine/sky/resource/SkyResources.js';
import {
  readSkyGraphic,
  readSkyFrame,
  isSkyPalette,
  isSkyScreen,
  parseSkyPalette,
  skyPixelsToRgb,
  SKY_SCREEN_WIDTH,
  SKY_SCREEN_HEIGHT,
} from '../src/engine/sky/gfx/skyGraphic.js';
import { writePng } from './png.js';

const args = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
/** The value of `--name=value`, or undefined when it was not passed. */
const flag = (name: string): string | undefined =>
  flags.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const paletteArgument = process.argv.slice(2).find((a) => a.startsWith('--palette='));
/**
 * Where the PNG goes, defaulting to the working directory.
 *
 * A flag rather than a positional, unlike `npm run shot`'s second argument: the
 * positionals here are `<game> [id] [frame]` and a fourth would be ambiguous
 * with the third. It matters because `npm run` sets the working directory to
 * the package root whatever the caller's was — `cd` somewhere and
 * `npm --prefix` back is not a way to redirect this, which two Sandcastle runs
 * discovered by writing PNGs into a tracked tree and moving them afterwards.
 */
const outArgument = process.argv.slice(2).find((a) => a.startsWith('--out='));
const outDir = resolve(outArgument?.slice('--out='.length) ?? '.');
const [path, idText, frameText] = args;
if (!path) {
  console.error(
    'Usage: npm run shot:sky -- <game> [id] [frame] [--palette=<id>] [--out=<dir>]\n' +
      '       npm run shot:sky -- <game> --run [--at=<s>,…] [--click=<x>,<y>@<s>] [--out=<dir>]',
  );
  process.exit(1);
}

/** Frames the pointer sits over a target before the click is delivered. */
const HOVER_FRAMES = 20;
/** Frames the world runs with the click delivered, before anything else. */
const PRESS_FRAMES = 8;

/**
 * Boots the game and photographs it running.
 *
 * ## The two rules a synthetic click has to obey
 *
 * **Hover before pressing.** `SkyEngine.runMouse` only notices a click on
 * whatever the pointer is *already* over: it compares the touched Compact
 * against `specialItem`, runs the `mouseOn` script when that changes, and only
 * then looks at the click count. A harness that sets the position and the click
 * in the same frame has clicked on nothing, and the report it writes says the
 * game ignores clicks. So the pointer is moved first and held there for
 * {@link HOVER_FRAMES} rendered frames.
 *
 * **Render every frame.** The world is stepped and drawn together, never one
 * without the other, because a frame loop that only steps is measuring a
 * different program from the one the browser runs — `bin/play-probe.ts`'s
 * header records what that cost on SCUMM.
 *
 * There is no release to deliver: `SkyInput` records a click as a count rather
 * than a held button, so the press *is* the edge and what follows it is the
 * settle. That is the family's own shape, not a shortcut.
 */
async function photographRunningGame(gamePath: string): Promise<void> {
  const engine = await loadAdventureEngine(await openGame(gamePath), {
    onLog: (message) => console.log(`[log] ${message}`),
  });
  if (!(engine instanceof SkyEngine)) {
    console.error(`${gamePath} opened as ${engine.constructor.name}, which is not Sky.`);
    process.exit(1);
  }
  engine.boot();
  await mkdir(outDir, { recursive: true });

  /** `--scale=3` replicates each pixel, for looking at small detail. */
  const scale = Number(flag('scale') ?? 1) || 1;
  /** `--at=0,4,20` writes a frame at each of those numbers of seconds. */
  const marks = (flag('at') ?? '4')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const hoverFrames = Number(flag('hover') ?? HOVER_FRAMES);
  /** `--click=24,72@6` hovers over that point at that second, then clicks it. */
  const pending = flags
    .filter((argument) => argument.startsWith('--click='))
    .map((argument) => {
      const [where, when] = argument.slice('--click='.length).split('@');
      const [x, y] = where.split(',').map((part) => Number(part.trim()));
      return { x, y, at: Number(when ?? 0) };
    })
    .filter((click) => Number.isFinite(click.x) && Number.isFinite(click.y))
    .sort((first, second) => first.at - second.at);

  /** Sky runs five ticks a second; `--at` and `--click` are in seconds. */
  const framesPerSecond = 60 / engine.ticksPerStep;

  /** One frame: step the world, then draw it. Never one without the other. */
  const tick = (): void => {
    engine.step();
    engine.render();
  };

  const shoot = async (seconds: number): Promise<void> => {
    engine.render();
    engine.palette.flush();
    const { pixels: indexed, width: screenWidth, height: screenHeight } = engine.screen;
    const { rgba } = engine.palette;
    const width = screenWidth * scale;
    const height = screenHeight * scale;
    const rgb = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const entry = indexed[Math.floor(y / scale) * screenWidth + Math.floor(x / scale)]! << 2;
        const at = (y * width + x) * 3;
        rgb[at] = rgba[entry]!;
        rgb[at + 1] = rgba[entry + 1]!;
        rgb[at + 2] = rgba[entry + 2]!;
      }
    }
    const name = `sky-run-${String(seconds).replace('.', '_')}s-screen${engine.currentRoom}.png`;
    await writeFile(join(outDir, name), writePng(width, height, rgb));
    console.log(`[shot] ${name}`);
    // The two lines a picture cannot carry: where the game thinks it is, and
    // whether the tick that drew it stopped on something unimplemented.
    console.log(`       ${engine.describeRoom() ?? 'no room with the pointer live on it'}`);
    const foster = engine.playerAt();
    console.log(
      `       ${foster ? `foster at ${foster.x},${foster.y}; ` : ''}` +
        `${engine.lastStop ? `stopped on ${engine.lastStop}` : 'nothing stopped'}`,
    );
    // Where a click could go, in the coordinates `--click` takes, because the
    // hotspots are the game's own answer to "what is there to click".
    const spots = engine
      .hotspots()
      .map((spot) => `${spot.name}@${spot.x},${spot.y}`)
      .slice(0, 8);
    if (spots.length > 0) console.log(`       clickable: ${spots.join(' ')}`);
  };

  let elapsed = 0;
  for (const mark of marks) {
    const until = Math.round(mark * framesPerSecond);
    while (elapsed < until) {
      while (pending.length > 0 && pending[0]!.at * framesPerSecond <= elapsed) {
        const click = pending.shift()!;
        for (let held = 0; held < hoverFrames; held += 1) {
          engine.input.x = click.x;
          engine.input.y = click.y;
          tick();
          elapsed += 1;
        }
        engine.input.x = click.x;
        engine.input.y = click.y;
        engine.input.clicks += 1;
        for (let held = 0; held < PRESS_FRAMES; held += 1) {
          tick();
          elapsed += 1;
        }
        console.log(`[click] ${click.x},${click.y} at ${click.at}s`);
      }
      tick();
      elapsed += 1;
    }
    await shoot(mark);
  }
}

if (flags.includes('--run')) {
  await photographRunningGame(resolve(path));
  process.exit(0);
}

const source = await openGame(resolve(path));
const names = source.list();
const find = (base: string): string | null =>
  names.find((name) => name.toLowerCase().endsWith(base)) ?? null;

const indexName = find('sky.dnr');
const dataName = find('sky.dsk');
if (!indexName || !dataName) {
  console.error('Both sky.dnr and sky.dsk are needed.');
  process.exit(1);
}

const read = async (name: string): Promise<Uint8Array> => {
  const bytes = await source.read(name);
  if (!bytes) throw new Error(`${name} could not be read from ${source.label}.`);
  return bytes;
};

const resources = SkyResources.open(await read(indexName), await read(dataName));

/** Palettes, in index order, so a picture can be paired with the nearest one. */
const palettes = resources.ids().filter((id) => {
  try {
    return isSkyPalette(resources.read(id));
  } catch {
    return false;
  }
});

/**
 * The palette a picture is probably drawn with.
 *
 * The nearest palette by resource number, either side. That is a **heuristic
 * about this game's numbering** rather than a reading of anything, and it is
 * labelled as one because a script is what really chooses a palette and the
 * script engine is not wired to a screen yet.
 *
 * It is right often enough to be useful and wrong often enough to matter: the
 * intro panels each sit directly *above* their palette, and the Revolution
 * logo sits directly *below* its own. Nearest-either-side gets both; nothing
 * gets a room's palette right, because a room's is chosen by a script. Pass
 * `--palette=` when the colours look wrong, and expect to.
 */
function paletteFor(id: number): number {
  let best = palettes[0];
  for (const candidate of palettes) {
    // `<=` rather than `<`: the Revolution logo sits between two palettes at
    // the same distance and wants the higher one, and nothing yet wants the
    // lower in that situation.
    if (Math.abs(candidate - id) <= Math.abs(best - id)) best = candidate;
  }
  return best;
}

if (!idText) {
  const screens: number[] = [];
  const pictures: string[] = [];
  for (const id of resources.ids()) {
    let bytes: Uint8Array;
    try {
      bytes = resources.read(id);
    } catch {
      continue;
    }
    if (isSkyScreen(bytes)) {
      screens.push(id);
      continue;
    }
    const graphic = readSkyGraphic(bytes);
    if (graphic) pictures.push(`${id} (${graphic.width}x${graphic.height}, ${graphic.frames})`);
  }
  console.log(`${resources.releaseInfo.description}, v0.0${resources.releaseInfo.build}`);
  console.log('');
  console.log(`Full screens, 320x200 — ${screens.length}:`);
  console.log(`  ${screens.join(', ')}`);
  console.log('');
  console.log(`Palettes — ${palettes.length}:`);
  console.log(`  ${palettes.join(', ')}`);
  console.log('');
  console.log(`Pictures with their own geometry — ${pictures.length}:`);
  console.log(`  ${pictures.slice(0, 24).join(', ')}${pictures.length > 24 ? ', …' : ''}`);
  console.log('');
  console.log('Then: npm run shot:sky -- <game> <id> [frame]');
  process.exit(0);
}

const id = Number(idText);
const frame = frameText ? Number(frameText) : 0;
const bytes = resources.read(id);
const paletteId = paletteArgument ? Number(paletteArgument.split('=')[1]) : paletteFor(id);
const palette = parseSkyPalette(resources.read(paletteId));

let width: number;
let height: number;
let pixels: Uint8Array;

if (isSkyScreen(bytes)) {
  width = SKY_SCREEN_WIDTH;
  height = SKY_SCREEN_HEIGHT;
  pixels = bytes;
} else {
  const graphic = readSkyGraphic(bytes);
  if (!graphic) {
    console.error(
      `Resource ${id} is ${bytes.length} bytes and its geometry does not describe it, so it is ` +
        `not a picture. Run without an id to see what is drawable.`,
    );
    process.exit(1);
  }
  width = graphic.width;
  height = graphic.height;
  pixels = readSkyFrame(bytes, graphic, frame);
}

const name = `sky-${id}${frame ? `-${frame}` : ''}.png`;
await mkdir(outDir, { recursive: true });
const out = join(outDir, name);
await writeFile(out, writePng(width, height, skyPixelsToRgb(pixels, palette)));
console.log(`${width}x${height} written to ${out}, palette ${paletteId}`);
