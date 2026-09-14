/**
 * Boots an AGOS game, runs it for a while, and writes what it drew as a PNG.
 *
 *   npm run shot:agos -- <game> [frames] [--out=<dir>] [--every=<n>]
 *                        [--escape=<frame>] [--click=<frame>:<x>:<y>]
 *
 * `--escape` presses Escape at a frame, which is how a player skips Simon 2's
 * long opening — without it every shot is a cutscene rather than the room a
 * player can act in. `--click` issues a click at a frame, so the route a click
 * is meant to walk can be photographed rather than only described. Both may be
 * given more than once.
 *
 * A sibling of `npm run shot`, `shot:agi`, `shot:sci` and `shot:sky`, and for
 * this family the piece of evidence that matters most.
 * `docs/processes/verifying-version-support.md` asks for screenshots "judged by
 * eye against the original", and AGOS is the family where that is worth the
 * most: six separate faults in this engine each produced a *plausible nothing*
 * — no unimplemented opcode, no exception, no short read — and every one of
 * them was found by looking at a picture rather than at a count.
 *
 * What a right picture proves here is unusually broad. Simon 1's title screen
 * drawn correctly means the archive's offset table was read, the graphics
 * header was found through its own indirection, both of a zone's tables were
 * distinguished, the game bytecode reached `o_picture` and `o_animate` with the
 * right operands, the drawing bytecode scheduled its sprites, three different
 * coordinate units were converted, and two quite different pixel encodings and
 * a palette bank were decoded. Any one of those wrong gives stripes, noise, or
 * black.
 */

import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';

import { openGame } from '../src/hosting/openGame.js';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import { writePng } from './png.js';

const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'));
const args = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const flag = (name: string): string | undefined =>
  flags.find((each) => each.startsWith(`--${name}=`))?.slice(name.length + 3);
const multiFlag = (name: string): string[] =>
  flags.filter((each) => each.startsWith(`--${name}=`)).map((each) => each.slice(name.length + 3));

/** Frames at which to press Escape (skip the intro / a cutscene). */
const escapes = new Set(multiFlag('escape').map(Number));
/** `frame:x:y` clicks to issue, so a route a click walks can be photographed. */
const clicks = new Map<number, [number, number]>();
for (const spec of multiFlag('click')) {
  const [f, x, y] = spec.split(':').map(Number);
  if (f !== undefined && x !== undefined && y !== undefined) clicks.set(f, [x, y]);
}

const [path, framesText] = args;
if (!path) {
  console.error('Usage: npm run shot:agos -- <game> [frames] [--out=<dir>] [--every=<n>]');
  process.exit(1);
}

const frames = Number(framesText ?? '400');
const every = Number(flag('every') ?? '0');
const outDir = resolve(flag('out') ?? '.');

const source = await openGame(path);
const engine = await AgosEngine.create(source, { onLog: (message) => console.log(`  ${message}`) });

/** The framebuffer through the palette, which is the only form a person can judge. */
async function shot(name: string): Promise<void> {
  const { width, height, pixels } = engine.screen;
  const rgb = new Uint8Array(width * height * 3);
  for (let index = 0; index < pixels.length; index += 1) {
    const [red, green, blue] = engine.palette.getColor(pixels[index]!);
    rgb[index * 3] = red;
    rgb[index * 3 + 1] = green;
    rgb[index * 3 + 2] = blue;
  }
  await mkdir(outDir, { recursive: true });
  const file = resolve(outDir, `${name}.png`);
  await writeFile(file, writePng(width, height, rgb));
  console.log(`  wrote ${file}`);
}

engine.boot();
for (let frame = 1; frame <= frames; frame += 1) {
  if (escapes.has(frame)) engine.key('Escape');
  const click = clicks.get(frame);
  if (click) engine.click(click[0], click[1]);
  engine.step();
  engine.render();
  if (every > 0 && frame % every === 0) await shot(`agos-${frame}`);
}
if (every === 0) await shot(`agos-${frames}`);

// The counts beside the picture, because a picture that looks right and a
// report that says nothing ran is the pair worth noticing.
const ink = engine.screen.pixels.reduce((total, pixel) => total + (pixel === 0 ? 0 : 1), 0);
console.log(`  ${ink}/${engine.screen.pixels.length} pixels drawn`);
for (const line of engine.describeStall()) console.log(`  ${line}`);
if (engine.vgaUnsupported.size > 0) {
  console.log(
    `  drawing opcodes with nothing behind them: ${[...engine.vgaUnsupported].join(', ')}`,
  );
}
