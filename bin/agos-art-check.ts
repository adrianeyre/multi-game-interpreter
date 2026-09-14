/**
 * What the editor's Art tab would show for a real game.
 *
 * Written because the tab showed a row of black squares against Simon 1 and
 * every test passed: the fixtures paired a script id with a pixel-table slot
 * the same way the reader did, so both were wrong together. This asks the
 * question a fixture cannot — do these decode into pictures? — and answers it
 * as a count of images with more than one colour in them.
 *
 *   npm run check:agos-art -- <game folder> [maxZone]
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readAgosArchive } from '../src/engine/agos/resource/gameArchive.js';
import { packedZones } from '../src/engine/agos/resource/zoneSource.js';
import { readAgosArt } from '../src/authoring/agos/images.js';
import { decodeZoneImage } from '../src/editor/agos/zonePixels.js';
import { encodeSpriteRefusal } from '../src/engine/agos/gfx/agosImage.js';
import { paintImage } from '../src/authoring/agos/paint.js';
import { readVgaFile } from '../src/engine/agos/gfx/vgaFile.js';
import { countVgaPaletteBanks, readVgaPaletteHalf } from '../src/engine/agos/gfx/vgaPalette.js';

const folder = process.argv[2]!;
const maxZone = Number(process.argv[3] ?? '24');
const names = await readdir(folder);
const archiveName = names.find((each) => each.toLowerCase().endsWith('.gme'))!;
const archive = readAgosArchive(new Uint8Array(await readFile(resolve(folder, archiveName))));
const zones = packedZones(archive, 'Simon1');
const art = readAgosArt(zones, { maxZone });

let colouredZones = 0;
let greyZones = 0;
for (const zone of art.zones) {
  const scripts = zones.zone(zone)!.scripts;
  let banks: number;
  try {
    banks = countVgaPaletteBanks(readVgaFile(scripts).headerAt);
  } catch {
    banks = 0;
  }
  if (banks === 0) {
    greyZones += 1;
    continue;
  }
  // A bank of nothing but black is a bank, and a zone whose first bank has
  // real colours in it is one the Art tab can show properly.
  const colours = readVgaPaletteHalf(scripts, 0, 0);
  if (colours.some((each) => each.some((value) => value > 0))) colouredZones += 1;
  else greyZones += 1;
}

let blank = 0;
let drawn = 0;
let undecodable = 0;
let writable = 0;
let repainted = 0;
for (const listed of art.images) {
  const pixels = zones.zone(listed.zone)!.pixels;
  let bitmap;
  try {
    bitmap = decodeZoneImage(pixels, listed.id);
  } catch {
    undecodable += 1;
    continue;
  }
  if (new Set(bitmap.pixels).size <= 1) blank += 1;
  else drawn += 1;

  if (encodeSpriteRefusal(listed.flags)) continue;
  writable += 1;
  // A paint that changes one pixel, written back and read again. This is the
  // whole claim the Art tab makes, checked against the game rather than a
  // fixture: the picture that comes back is the picture that went in.
  const edited = { ...bitmap, pixels: new Uint8Array(bitmap.pixels) };
  edited.pixels[0] = (edited.pixels[0]! + 1) & 0x0f;
  try {
    const after = decodeZoneImage(paintImage(pixels, listed.id, edited), listed.id);
    if (after.pixels.every((value, at) => value === edited.pixels[at])) repainted += 1;
  } catch {
    // Counted by its absence from `repainted`.
  }
}

console.log(`zones ${art.zones.length}, images ${art.images.length}`);
console.log(`  decode to a picture: ${drawn}`);
console.log(`  decode to one flat colour: ${blank}`);
console.log(`  do not decode: ${undecodable}`);
console.log(`  offered as writable: ${writable}`);
console.log(`  survive a paint and read back identical: ${repainted}`);
console.log(`  zones whose first palette bank has colours in it: ${colouredZones}`);
console.log(`  zones that can only be shown in greys: ${greyZones}`);
