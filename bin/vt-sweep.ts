/**
 * A static sweep of a Virtual Theatre game's resources, against real shipped
 * bytes.
 *
 *   npm run sweep:vt -- <game>
 *
 * ## Why this one is different from every other sweep here
 *
 * `docs/processes/verifying-version-support.md` opens by saying real game data
 * "cannot live in this repository", so **Completable** "is not something CI can
 * ever assert". That is true of every family in this project except these two:
 * Revolution released both their adventures as freeware in 2003, and
 * `npm run fetch:vt` pulls them onto a build machine lawfully.
 *
 * So this sweep is the one that escapes Tier 1's trap — "a fixture encodes our
 * reading of the format; if that reading is wrong, the fixture and the engine
 * agree with each other and disagree with the game" — by checking against bytes
 * nobody here wrote.
 *
 * ## What it checks, and why each check is worth something
 *
 * **Sky.** Every resource is cut out and unpacked. That is worth far more than
 * it sounds, because each packed resource carries a CRC of its own *unpacked*
 * bytes: a wrong index reading fails the packed CRC, and a wrong decompressor
 * fails the unpacked one, and the two are told apart in the message. Nothing
 * has to be drawn or played for the check to bite.
 *
 * **Lure.** Every container is parsed and rewritten, and the rewrite is
 * compared byte for byte against the file it came from. That is the property an
 * export depends on (ADR 0010): whatever this project has not learned to read,
 * it has at least not destroyed.
 *
 * ## What it does not check
 *
 * That either game *plays*, and that stays true now both of them partly do.
 * Sky has an Engine and the freeware CD release boots on it; Lure has one too,
 * which reads the game and its initial world state but runs no scripts. Neither
 * fact is established here, because reading a resource and running one are
 * different claims and a sweep that implied otherwise by passing would be the
 * misleading kind of green. Tier 2 evidence
 * in the sense `verifying-version-support.md` means — a named place reached in
 * a named game — is `bin/vt-playthrough.ts`'s to report, and it reports a Stage
 * by name rather than a verdict.
 */

import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { looksLikeSky } from '../src/engine/sky/resource/skyDetect.js';
import { looksLikeLure } from '../src/engine/lure/resource/lureDetect.js';
import { SkyResources } from '../src/engine/sky/resource/SkyResources.js';
import { looksRncPacked } from '../src/engine/sky/resource/rnc.js';
import { readSkyGraphic, isSkyPalette, isSkyScreen } from '../src/engine/sky/gfx/skyGraphic.js';
import { skyMcodeName, SKY_MCODES, SKY_MCODE_STRIDE } from '../src/engine/sky/script/skyMcodes.js';
import {
  listSkyScript,
  skyScriptCount,
  skyScriptOffset,
  SKY_MODULE_0,
} from '../src/engine/sky/script/skyOpcodes.js';
import {
  parseSkyCompacts,
  writeSkyCompacts,
  describeMissingCompacts,
} from '../src/engine/sky/resource/skyCompacts.js';
import { parseSkyWorldState, writeSkyWorldState } from '../src/engine/sky/save/skyWorldState.js';
import { GRID_FILE_START, TOT_NO_GRIDS } from '../src/engine/sky/resource/SkyGrid.js';
import {
  parseLureDisk,
  writeLureDisk,
  isLurePalette,
  lureDiskNumberFor,
  readLureResource,
} from '../src/engine/lure/resource/lureDisk.js';
import { decodeLurePicture } from '../src/engine/lure/gfx/lureDecode.js';

const path = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (!path) {
  console.error('Usage: npm run sweep:vt -- <game>');
  console.error('');
  console.error('Fetch a game first, if you have not:');
  console.error('  npm run fetch:vt');
  process.exit(1);
}

const source = await openGame(resolve(path));
const names = source.list();

/** A finding, in the same shape the other sweeps report. */
interface Finding {
  readonly label: string;
  readonly count: number;
  readonly detail?: string;
}

const findings: Finding[] = [];
const unrecovered: string[] = [];

function require(name: string): Promise<Uint8Array> {
  return source.read(name).then((bytes) => {
    if (!bytes) throw new Error(`${name} is not in ${source.label}.`);
    return bytes;
  });
}

/** Case-insensitive, because a DOS release's case is whatever unzipped it. */
function find(base: string): string | null {
  return names.find((name) => name.toLowerCase().endsWith(base)) ?? null;
}

async function sweepSky(): Promise<void> {
  const dnr = find('sky.dnr');
  const dsk = find('sky.dsk');
  if (!dnr || !dsk) throw new Error('Both sky.dnr and sky.dsk are needed.');

  const resources = SkyResources.open(await require(dnr), await require(dsk));
  console.log(resources.describe());
  console.log('');

  let read = 0;
  let packed = 0;
  let unpackedBytes = 0;
  const failures: string[] = [];

  for (const id of resources.ids()) {
    let raw: Uint8Array;
    try {
      raw = resources.rawBytes(id);
    } catch (error) {
      failures.push(`${id}: ${(error as Error).message}`);
      continue;
    }
    // Carrying a marker is not the same as being unpacked: a handful per
    // release are marked stored and carry one anyway, and the game leaves those
    // alone. Counting markers rather than unpackings overstated this by four.
    const wasUnpacked = looksRncPacked(raw, 22) && resources.entry(id)?.stored === false;
    try {
      const bytes = resources.read(id);
      read += 1;
      unpackedBytes += bytes.length;
      if (wasUnpacked) packed += 1;
    } catch (error) {
      failures.push(`${id}: ${(error as Error).message}`);
    }
  }

  findings.push({
    label: 'resources that could not be read',
    count: failures.length,
    detail: `${read} read, ${packed} of them unpacked, ${(unpackedBytes / 1_048_576).toFixed(1)} MB`,
  });
  unrecovered.push(...failures);

  const cptName = find('sky.cpt');
  if (!cptName) {
    // Not a failure of the sweep: the freeware floppy ships no Compact table
    // and cannot, which is a fact about that release rather than about the
    // reader. It is said out loud rather than passed over.
    console.log('');
    console.log(describeMissingCompacts(names));
  } else {
    const cptBytes = await require(cptName);
    const compacts = parseSkyCompacts(cptBytes);
    const rewritten = writeSkyCompacts(cptBytes, compacts);
    const identical =
      rewritten.length === cptBytes.length && rewritten.every((byte, i) => byte === cptBytes[i]);
    const byType = new Map<string, number>();
    for (const record of compacts.records) {
      byType.set(record.type, (byType.get(record.type) ?? 0) + 1);
    }

    console.log('');
    console.log(
      `Compact table: ${compacts.records.length} records ` +
        `(${[...byType].map(([type, count]) => `${count} ${type}`).join(', ')}), ` +
        `${compacts.aliases.length} aliases, ${compacts.emptySlots} empty slots.`,
    );
    console.log(
      `  ${compacts.saveIds.length} ids a save has to carry, and a starting state for ` +
        `${compacts.resetStates.map((state) => `v0.0${state.build}`).join(', ')}.`,
    );
    console.log(`  Rewrite ${identical ? 'byte-identical' : 'DIFFERS'}.`);

    // The screen→grid map the auto-router needs is not in here: no record's
    // words address a grid resource. This is the load-bearing half of refusing
    // that map by name (SkyGrid.ts / ADR 0033) — "it is not game-authored data"
    // stated as a number rather than asserted. If this ever prints non-zero,
    // the map has a home in the shipped bytes and the refusal must be revisited.
    let gridRefs = 0;
    const gridLast = GRID_FILE_START + TOT_NO_GRIDS - 1;
    for (const record of compacts.records) {
      for (const word of record.words) {
        if (word >= GRID_FILE_START && word <= gridLast) gridRefs += 1;
      }
    }
    console.log(
      `  Compact words addressing a grid resource (${GRID_FILE_START}..${gridLast}): ${gridRefs}.`,
    );
    findings.push({ label: 'compact words addressing a grid resource', count: gridRefs });

    // Each Release's starting state is a save image, so reading and rewriting
    // one checks the save format against real data — before there is an engine
    // to save from, and without anybody having played anything.
    let states = 0;
    let stateRoundTrips = 0;
    for (const reset of compacts.resetStates) {
      states += 1;
      const stateBytes = new Uint8Array(
        reset.words.buffer,
        reset.words.byteOffset,
        reset.words.byteLength,
      );
      try {
        const state = parseSkyWorldState(stateBytes, compacts);
        const back = writeSkyWorldState(state, compacts);
        if (back.length === stateBytes.length && back.every((byte, i) => byte === stateBytes[i])) {
          stateRoundTrips += 1;
        } else {
          unrecovered.push(`starting state v0.0${reset.build}: rewrite differed`);
        }
      } catch (error) {
        unrecovered.push(`starting state v0.0${reset.build}: ${(error as Error).message}`);
      }
    }
    console.log(
      `  Starting states: ${stateRoundTrips} of ${states} read and rewritten byte-identically.`,
    );
    findings.push({
      label: 'starting states that did not round-trip',
      count: states - stateRoundTrips,
    });

    findings.push({ label: 'compacts the reader could not type', count: compacts.notes.length });
    findings.push({
      label: 'compact tables whose rewrite differed',
      count: identical ? 0 : 1,
    });
    unrecovered.push(...compacts.notes.map((note) => `compact ${note.id}: ${note.reason}`));
  }

  // Every picture in the game, measured against its own length. A wrong
  // reading of the geometry words shows up as a resource whose length fits and
  // whose width times height does not, and there are none.
  let pictures = 0;
  let paletteCount = 0;
  let fullScreens = 0;
  let geometryMismatch = 0;
  for (const id of resources.ids()) {
    let bytes: Uint8Array;
    try {
      bytes = resources.read(id);
    } catch {
      continue;
    }
    if (isSkyPalette(bytes)) paletteCount += 1;
    if (isSkyScreen(bytes)) fullScreens += 1;
    const graphic = readSkyGraphic(bytes);
    if (graphic) {
      pictures += 1;
      if (graphic.width * graphic.height !== graphic.frameBytes) geometryMismatch += 1;
    }
  }
  console.log('');
  console.log(
    `Pictures: ${pictures} whose geometry describes them exactly, ${fullScreens} full ` +
      `320x200 screens, ${paletteCount} palettes.`,
  );
  findings.push({ label: 'pictures whose geometry disagreed', count: geometryMismatch });

  // Every script in the game, listed. This is the check the encoding spike
  // (#248) asks for, run over shipped bytecode rather than argued about: if a
  // boundary were measured rather than derived, a listing would drift and stop
  // somewhere in the middle of a script rather than at its exit.
  const modules = resources
    .ids()
    .filter((id) => id >= SKY_MODULE_0 && id < SKY_MODULE_0 + 16)
    .sort((a, b) => a - b);

  let scripts = 0;
  let listed = 0;
  let listedInstructions = 0;
  const stops: string[] = [];
  // Where every script's calls out of the interpreter land. A table of the
  // wrong length or a stride of the wrong size shows up here as an operand
  // that is not a multiple of four, or one past the end.
  const mcodeCalls = new Map<number, number>();
  let mcodeOutside = 0;

  for (const id of modules) {
    const bytes = resources.read(id);
    const words = new Uint16Array(Math.floor(bytes.length / 2));
    for (let w = 0; w < words.length; w += 1) words[w] = bytes[w * 2] | (bytes[w * 2 + 1] << 8);

    // From 1: entry 0 is the table's own length rather than a script.
    for (let index = 1; index < skyScriptCount(words); index += 1) {
      const offset = skyScriptOffset(words, index);
      if (offset === 0 || offset >= words.length) continue;
      scripts += 1;
      const listing = listSkyScript(words, offset);
      listedInstructions += listing.instructions.length;
      for (const instruction of listing.instructions) {
        if (instruction.name !== 'call_mcode') continue;
        const raw = instruction.operands[1];
        const mcode = raw / SKY_MCODE_STRIDE;
        if (raw % SKY_MCODE_STRIDE !== 0 || mcode >= SKY_MCODES.length) {
          mcodeOutside += 1;
          continue;
        }
        mcodeCalls.set(mcode, (mcodeCalls.get(mcode) ?? 0) + 1);
      }
      if (listing.stoppedBecause) {
        stops.push(`module ${id} script ${index}: ${listing.stoppedBecause.split('.')[0]}`);
      } else {
        listed += 1;
      }
    }
  }

  console.log('');
  console.log(
    `Scripts: ${scripts} across ${modules.length} modules, ${listedInstructions} instructions.`,
  );
  console.log(`  ${listed} listed to an exit without the listing having to stop.`);

  const totalCalls = [...mcodeCalls.values()].reduce((sum, count) => sum + count, 0);
  const busiest = [...mcodeCalls.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([mcode, count]) => `${skyMcodeName(mcode)} (${count})`);
  console.log(
    `  ${totalCalls} calls out of the interpreter, reaching ${mcodeCalls.size} of ` +
      `${SKY_MCODES.length} mcodes. Busiest: ${busiest.join(', ')}.`,
  );

  findings.push({ label: 'scripts a listing could not walk', count: stops.length });
  findings.push({ label: 'calls landing outside the mcode table', count: mcodeOutside });
  unrecovered.push(...stops);

  console.log('');
  console.log('Every packed resource above was checked against the CRC of its own unpacked bytes,');
  console.log('which the compressor wrote into it. Nothing here is this project’s own reading.');
  if (resources.notes.length > 0) {
    console.log('');
    console.log(
      `${resources.notes.length} entries are unusual rather than unreadable — listed above, and`,
    );
    console.log('handled the way the game handles them. They are not a failure of this sweep.');
  }
}

async function sweepLure(): Promise<void> {
  const containers = names
    .filter((name) => /disk\d\.(vga|ega)$/i.test(name))
    .sort((a, b) => a.localeCompare(b));

  let resources = 0;
  let palettes = 0;
  // Game-area pictures split by resource-id shape. The 320x192 backgrounds a
  // room shows carry ids with a non-zero high byte (room << 8 | layer); a small
  // set of small ids (< 0x100) on disk 1 decode to the same geometry but stand
  // apart from that scheme. The engine draws the first game-area picture it
  // finds (resource 24 = 0x18, a small id) — this counts both classes so the
  // report can say precisely which class that picture is in.
  const LURE_GAME_AREA = 320 * 192;
  let gameAreaPictures = 0;
  let roomIdPictures = 0;
  let smallIdPictures = 0;
  const roundTripFailures: string[] = [];
  const parseFailures: string[] = [];

  for (const name of containers) {
    const bytes = await require(name);
    // Not the digit in the name: the EGA set numbers itself 5 to 8.
    const expected = lureDiskNumberFor(name);
    let disk;
    try {
      disk = parseLureDisk(bytes, expected ?? undefined);
    } catch (error) {
      parseFailures.push(`${name}: ${(error as Error).message}`);
      continue;
    }

    resources += disk.resources.length;
    for (const resource of disk.resources) {
      const raw = bytes.subarray(resource.offset, resource.offset + resource.size);
      if (isLurePalette(raw)) {
        palettes += 1;
        continue;
      }
      const data = readLureResource(bytes, disk, resource.id);
      if (!data) continue;
      try {
        if (decodeLurePicture(data, LURE_GAME_AREA).length === LURE_GAME_AREA) {
          gameAreaPictures += 1;
          if (resource.id >= 0x100) roomIdPictures += 1;
          else smallIdPictures += 1;
        }
      } catch {
        // Not a picture. Most resources are not.
      }
    }

    const rewritten = writeLureDisk(bytes, disk);
    const identical =
      rewritten.length === bytes.length && rewritten.every((byte, i) => byte === bytes[i]);
    if (!identical) roundTripFailures.push(name);

    console.log(
      `  ${name}: disk ${disk.diskNumber}, ${disk.resources.length} resources, ` +
        `rewrite ${identical ? 'byte-identical' : 'DIFFERS'}`,
    );
  }

  console.log('');
  console.log(
    `  Game-area pictures: ${gameAreaPictures} (${roomIdPictures} with a room id ` +
      `>= 0x100 in room<<8|layer form, ${smallIdPictures} with a small id < 0x100). ` +
      `The picture the engine draws at load, resource 24 (0x18), is in the small-id ` +
      `class — not the room-background class, so it is not a screen a room shows.`,
  );

  console.log('');
  findings.push({ label: 'containers that would not parse', count: parseFailures.length });
  findings.push({
    label: 'containers whose rewrite differed',
    count: roundTripFailures.length,
    detail: `${containers.length} containers, ${resources} resources, ${palettes} palettes`,
  });
  unrecovered.push(...parseFailures);
}

const isSky = looksLikeSky(names);
const isLure = looksLikeLure(names);

if (!isSky && !isLure) {
  console.error(`${source.label} holds neither game's files.`);
  console.error('');
  console.error('Sky needs sky.dnr and sky.dsk; Lure needs disk1.vga and at least one more.');
  process.exit(1);
}

console.log(`Sweeping ${source.label}`);
console.log('');

if (isSky) await sweepSky();
if (isLure) await sweepLure();

console.log('');
for (const finding of findings) {
  const detail = finding.detail ? ` (${finding.detail})` : '';
  console.log(
    `${finding.count === 0 ? '  ok  ' : ' FAIL '} ${finding.label}: ${finding.count}${detail}`,
  );
}

if (unrecovered.length > 0) {
  console.log('');
  console.log('Unrecovered:');
  for (const line of unrecovered.slice(0, 10)) console.log(`   ${line}`);
  if (unrecovered.length > 10) console.log(`   …and ${unrecovered.length - 10} more`);
}

console.log('');
console.log('This sweep reads resources. It does not play the game — that is what');
console.log('`npm run play:vt` reports, by Stage, and no Stage below last-screen supports');
console.log('Completable, so it stays unclaimed — see docs/released-games.md.');

process.exit(unrecovered.length > 0 ? 1 : 0);
