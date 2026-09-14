/**
 * Renders a SCI Picture, with a View cel composited onto it, to a PNG.
 *
 *   npm run shot:sci -- <game> [--pic=N] [--view=N] [--out=DIR]
 *
 * #218's acceptance criterion is that `shot` "produces a PNG of a fixture room
 * that a reviewer can look at", and the reason it is a criterion rather than a
 * test is in `docs/processes/verifying-version-support.md`: this renderer's
 * fault class is that the game does the right thing and the picture is wrong,
 * and every report about engine state looks correct. It is judged by eye.
 *
 * What it draws is a Plane (ADR 0015): the Picture's visual buffer as the
 * Plane's background, its priority buffer as the Plane's optional mask, and one
 * View cel as a screen item at a priority. So the picture also *shows* whether
 * per-pixel occlusion works — a cel placed behind scenery should be cut by it.
 *
 * **Both kinds of Picture, through the same Plane.** A vector Picture paints a
 * background and a mask; a cel Picture contributes screen items, and from SCI2
 * they carry their own priorities and positions. The second kind goes onto a
 * Plane with **no mask**, which is every SCI32 Plane — so this tool is also
 * where ADR 0015's claim is looked at rather than asserted: the same compositor
 * call renders both, and the difference is data on the Plane (#225).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { drawSciPicture } from '../src/engine/sci/gfx/SciPicture.js';
import { readSciCelPicture } from '../src/engine/sci/gfx/SciCelPicture.js';
import { sciPictureKind } from '../src/engine/sci/gfx/pictureKind.js';
import { readSciView } from '../src/engine/sci/gfx/SciView.js';
import { Plane, SciCompositor } from '../src/engine/sci/gfx/Plane.js';
import { SCI_EGA_PALETTE, readSciPalette } from '../src/engine/sci/gfx/sciPalette.js';

const args = process.argv.slice(2);
const gamePath = args.find((argument) => !argument.startsWith('--'));
if (!gamePath) {
  console.error('Usage: npm run shot:sci -- <game> [--pic=N] [--view=N] [--out=DIR]');
  process.exit(1);
}

function flag(name: string): string | undefined {
  return args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const outDir = resolve(flag('out') ?? 'out');
const source = await openGame(gamePath);
const { game, resources } = await detectSciGame(source, {
  onLog: (m) => console.log(`[log] ${m}`),
});

// A game with a `palette` resource is drawing in 256 colours, whatever its
// Version bucket says — the Version narrows what a compression number means,
// and this is a question about what the artwork is (#218).
const vga = resources.count('palette') > 0;

const pictures = resources.list('pic');
const views = resources.list('view');
const picNumber = Number(flag('pic') ?? pictures[0]);
const viewNumber = Number(flag('view') ?? views[0]);

const pictureBytes = await resources.read('pic', picNumber);
if (!pictureBytes)
  throw new Error(`This game has no Picture ${picNumber}. It has: ${pictures.join(', ')}`);

const kind = sciPictureKind(pictureBytes);

// One Plane, filled in differently by kind, composited once. The alternative —
// two tools, or one with a `if (sci32)` around the drawing — is the branch ADR
// 0015 exists to keep out of the renderer.
let plane: Plane;
let width: number;
let height: number;
let operations = 0;
let colours: ReadonlyArray<readonly [number, number, number]> = SCI_EGA_PALETTE;
let clearIndex = 0x0f;

if (kind === 'cel') {
  const composition = readSciCelPicture(pictureBytes);
  if (composition.unknown) {
    console.log(
      `[log] Picture ${picNumber} stopped at byte ${composition.unknown.at}: ` +
        `${composition.unknown.why} — what is drawn below is what was reached.`,
    );
  }

  // The Picture's own declared display size where it has one, and the biggest
  // cel where it does not. A SCI1.1 cel Picture never declares one and a SCI32
  // one composed for a different game's resolution declares zero, which is not
  // the same as declaring nothing.
  width =
    composition.resolution?.width ??
    Math.max(320, ...composition.cels.map((c) => c.x + c.cel.width));
  height =
    composition.resolution?.height ??
    Math.max(200, ...composition.cels.map((c) => c.y + c.cel.height));

  // No mask. This is the SCI32 path and it is the point of the exercise: these
  // items occlude by ordering alone, and the compositor below is the one that
  // just drew a mask-carrying Plane for a SCI0 game.
  plane = new Plane({ x: 0, y: 0, width, height }, 0, null);

  for (const placed of composition.cels) {
    plane.add({
      cel: placed.cel,
      x: placed.x,
      y: placed.y,
      priority: placed.priority,
      visible: true,
    });
  }

  // A SCI1.1 cel Picture keeps its vector operations after the bitmap, and they
  // are what still paints the priority and control buffers. Drawn through the
  // vector reader rather than reimplemented here.
  if (composition.vectorData && composition.vectorData.length > 1) {
    const vectors = drawSciPicture(composition.vectorData, { vga: true });
    operations = vectors.commands.length;
    plane.mask = vectors.priority;
  }

  const entries = readSciPalette(pictureBytes, composition.paletteOffset);
  if (entries.length > 0) {
    const table: Array<readonly [number, number, number]> = Array.from(
      { length: 256 },
      () => [0, 0, 0] as const,
    );
    for (const entry of entries) table[entry.index] = [entry.r, entry.g, entry.b];
    colours = table;
    clearIndex = composition.cels[0]?.cel.clearKey ?? 0;
  }
} else {
  const picture = drawSciPicture(pictureBytes, { vga });
  if (picture.unknown) {
    console.log(
      `[log] Picture ${picNumber} stopped at byte ${picture.unknown.at} on operation ` +
        `0x${picture.unknown.op.toString(16)} — what is drawn below is what was reached, not the ` +
        `whole picture.`,
    );
  }

  width = picture.width;
  height = picture.height;
  operations = picture.commands.length;

  // The Plane carries the priority buffer as data (ADR 0015). A SCI32 Plane
  // passes null above and occludes by ordering alone, through this compositor.
  plane = new Plane({ x: 0, y: 0, width, height }, 0, picture.priority);
  plane.background = picture.visual;

  if (vga) {
    const paletteBytes = await resources.read('palette', resources.list('palette')[0]);
    const entries = paletteBytes ? readSciPalette(paletteBytes) : [];
    if (entries.length > 0) {
      const table: Array<readonly [number, number, number]> = Array.from(
        { length: 256 },
        () => [0, 0, 0] as const,
      );
      for (const entry of entries) table[entry.index] = [entry.r, entry.g, entry.b];
      colours = table;
    }
  }
}

const viewBytes = await resources.read('view', viewNumber);
const cel = viewBytes ? readSciView(viewBytes).loops[0]?.cels[0] : undefined;
if (cel) {
  plane.add({
    cel,
    x: Math.max(0, (width - cel.width) >> 1),
    y: Math.max(0, height - cel.height - 20),
    priority: 8,
    visible: true,
  });
}

const compositor = new SciCompositor();
compositor.add(plane);
const framebuffer = new Uint8Array(width * height).fill(clearIndex);
const dirty = compositor.composite(framebuffer, width, height);

const rgb = new Uint8Array(width * height * 3);
for (let i = 0; i < framebuffer.length; i++) {
  const colour = colours.length === 256 ? colours[framebuffer[i]] : colours[framebuffer[i] & 0x0f];
  rgb[i * 3] = colour[0];
  rgb[i * 3 + 1] = colour[1];
  rgb[i * 3 + 2] = colour[2];
}

await mkdir(outDir, { recursive: true });
const name = `${game.id}-${game.version}-pic${picNumber}-view${viewNumber}.png`;
await writeFile(join(outDir, name), writePng(width, height, rgb));

const painted = framebuffer.reduce((count, pixel) => count + (pixel !== clearIndex ? 1 : 0), 0);
console.log(`[shot] ${name}`);
console.log(
  `[shot] a ${kind} Picture on a Plane ${plane.mask ? 'carrying' : 'without'} a mask, ` +
    `${width}x${height}, ${painted} of ${framebuffer.length} pixels painted, ` +
    `${plane.items.length} screen items, ${operations} drawing operations, ` +
    `${dirty.length} dirty rectangles, cel ${cel ? 'drawn' : 'not available'}`,
);
