/**
 * Renders an AGI game's Pictures and Views to PNG files, for looking at.
 *
 *   npm run render:agi -- games/somegame out/
 *   npm run render:agi -- games/somegame out/ --picture=1 --view=0
 *
 * ## Why this exists
 *
 * Several of the AGI issues say their correctness is judged **by eye** and that
 * no unit test catches the failures: a flood fill that leaks, a priority band
 * off by one row, a mirrored loop that did not flip. Each of those produces
 * output that is plausible and wrong.
 *
 * A test cannot make that judgement. What it *can* do is stop the judgement
 * being a one-off: this turns "render a named Picture and compare it against a
 * reference" from an hour of wiring into one command, so the check is repeatable
 * by whoever next changes the renderer.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument — the same rule `npm run diagnose` follows.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import { AgiPicture } from '../src/engine/agi/gfx/AgiPicture.js';
import {
  AGI_EGA_PALETTE,
  PICTURE_HEIGHT,
  PICTURE_WIDTH,
} from '../src/engine/agi/gfx/agiPalette.js';
import { loopIsMirrored, readView } from '../src/engine/agi/gfx/AgiView.js';

/**
 * Palette indices to RGB, scaled.
 *
 * `scaleX` defaults to 2 because an AGI pixel *is* two EGA pixels — that one is
 * the format rather than a zoom. `scaleY` is a zoom, and defaults to 1 so a
 * Picture comes out at its real proportions.
 *
 * Both axes are replicated. Writing a buffer of `height` rows and then telling
 * the PNG header it has `height * 4` is how the first version of this produced
 * a cel with the sprite crammed into the top quarter and black below — which
 * looked exactly like a decoder fault and was not one.
 */
function toRgb(
  indices: Uint8Array,
  width: number,
  height: number,
  scaleX = 2,
  scaleY = 1,
): Uint8Array {
  const outWidth = width * scaleX;
  const rgb = new Uint8Array(outWidth * height * scaleY * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = AGI_EGA_PALETTE[indices[y * width + x] & 0x0f];
      for (let stepY = 0; stepY < scaleY; stepY++) {
        for (let stepX = 0; stepX < scaleX; stepX++) {
          const at = ((y * scaleY + stepY) * outWidth + x * scaleX + stepX) * 3;
          rgb[at] = red;
          rgb[at + 1] = green;
          rgb[at + 2] = blue;
        }
      }
    }
  }
  return rgb;
}

const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const flags = process.argv.slice(2).filter((argument) => argument.startsWith('--'));

if (positional.length < 2) {
  console.log("Renders an AGI game's Pictures and Views to PNG, for looking at.\n");
  console.log('  npm run render:agi -- <game path> <output dir> [--picture=N] [--view=N]\n');
  console.log('With no --picture or --view, renders the first few of each.');
  process.exit(0);
}

const gamePath = resolve(positional[0]);
const outDir = resolve(positional[1]);
const wanted = (name: string): number | null => {
  const flag = flags.find((argument) => argument.startsWith(`--${name}=`));
  return flag ? Number(flag.slice(name.length + 3)) : null;
};

const source = await openGame(gamePath);
const game = await detectAgiGame(source);
const resources = await AgiResources.load(source, game, {
  onLog: (m) => console.log(`[log] ${m}`),
});
await mkdir(outDir, { recursive: true });

const pictureNumber = wanted('picture');
const pictures = pictureNumber === null ? resources.list('picture').slice(0, 3) : [pictureNumber];

for (const number of pictures) {
  const picture = new AgiPicture();
  const result = picture.execute(resources.read('picture', number));
  for (const note of result.notes) console.log(`  picture ${number}: ${note.message}`);

  await writeFile(
    join(outDir, `picture-${number}-visual.png`),
    writePng(
      PICTURE_WIDTH * 2,
      PICTURE_HEIGHT,
      toRgb(picture.visual, PICTURE_WIDTH, PICTURE_HEIGHT),
    ),
  );
  // The priority buffer as its own image, because a band off by one row is
  // invisible in the visual output and obvious here.
  await writeFile(
    join(outDir, `picture-${number}-priority.png`),
    writePng(
      PICTURE_WIDTH * 2,
      PICTURE_HEIGHT,
      toRgb(picture.priority, PICTURE_WIDTH, PICTURE_HEIGHT),
    ),
  );
  console.log(`picture ${number}: ${result.commands.length} commands`);
}

const viewNumber = wanted('view');
const views = viewNumber === null ? resources.list('view').slice(0, 3) : [viewNumber];

for (const number of views) {
  const view = readView(resources.read('view', number));
  console.log(
    `view ${number}: ${view.loops.length} loops` +
      `${view.description ? ` — "${view.description}"` : ''}`,
  );

  for (const [loopIndex, loop] of view.loops.entries()) {
    const mirror = loop.mirrorOf === null ? '' : ` (mirror of ${loop.mirrorOf})`;
    console.log(`  loop ${loopIndex}: ${loop.cels.length} cels${mirror}`);

    for (const [celIndex, cel] of loop.cels.entries()) {
      // Drawn with the mirror applied, so a loop that should be flipped and is
      // not shows up as two identical images.
      const mirrored = loopIsMirrored(cel, loopIndex);
      const pixels = new Uint8Array(cel.width * cel.height);
      for (let y = 0; y < cel.height; y++) {
        for (let x = 0; x < cel.width; x++) {
          const source = mirrored ? cel.width - 1 - x : x;
          pixels[y * cel.width + x] = cel.pixels[y * cel.width + source];
        }
      }

      // Scaled up on both axes: a cel is often under thirty pixels wide, which
      // is too small to judge anything by. 8x horizontally is the format's own
      // doubling times four; 4x vertically keeps the proportions right.
      await writeFile(
        join(outDir, `view-${number}-loop-${loopIndex}-cel-${celIndex}.png`),
        writePng(cel.width * 8, cel.height * 4, toRgb(pixels, cel.width, cel.height, 8, 4)),
      );
    }
  }
}

console.log(`\nWritten to ${outDir}`);
