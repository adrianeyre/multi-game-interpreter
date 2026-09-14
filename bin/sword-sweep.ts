/**
 * Reads every resource of a Broken Sword or Broken Sword II install and reports.
 *
 *   npm run sweep:sword -- /path/to/game
 *
 * A sibling of `npm run sweep`, `sweep:agi`, `sweep:agos`, `sweep:sci` and
 * `sweep:vt`, and it exists for the reason
 * `docs/processes/verifying-version-support.md` gives: a fixture "encodes our
 * reading of the format", so the only escape from it agreeing with the reader
 * by construction is to point the reader at a real install and count.
 *
 * Neither Broken Sword is freeware, so this cannot run in CI the way
 * `sweep:vt` does — it is Tier 2, "a person with the data". What it does is
 * make that person's check one command:
 *
 * - every resource the index names is fetched and its header read,
 * - every script module or game object is decompiled and round-tripped,
 * - every sprite frame is decoded **and re-encoded**, and the re-encoded bytes
 *   compared with the original's,
 * - and anything that failed is printed with its id and its reason.
 *
 * The headline numbers are the two round-trip counts. A module that re-emits
 * byte-identically is a module this project can edit safely; one that does not
 * is a decoding fault, and the sweep is what turns "it seems to work" into a
 * count. The frame count is the same claim about pictures: an encoder that
 * reproduces every shipped frame byte for byte is one an export can use without
 * the export stopping being a copy of the game.
 */

import { openGame } from '../src/hosting/openGame.js';
import { readRangeFrom } from '../src/engine/resource/DataSource.js';
import { SwordResources } from '../src/engine/sword1/resource/SwordResources.js';
import { looksLikeSword1, identifySword1 } from '../src/engine/sword1/resource/swordDetect.js';
import { Sword2Resources } from '../src/engine/sword2/resource/Sword2Resources.js';
import {
  looksLikeSword2,
  identifySword2,
  refineSword2Release,
} from '../src/engine/sword2/resource/sword2Detect.js';
import { parseSword1ScriptModule } from '../src/engine/sword1/script/swordTokens.js';
import {
  disassembleSword1Script,
  roundTripsSword1Script,
} from '../src/authoring/sword1/disassemble.js';
import {
  disassembleSword2Object,
  roundTripsSword2Object,
} from '../src/authoring/sword2/disassemble.js';
import { parseSword2Object } from '../src/engine/sword2/script/Sword2Interpreter.js';
import { sword1Calls } from '../src/authoring/sword1/calls.js';
import { sword2Calls } from '../src/authoring/sword2/calls.js';
import { SWORD1_SECTION_SCRIPTS } from '../src/engine/sword1/resource/swordSections.js';
import {
  MULTI_SCREEN_HEADER_SIZE,
  RES_HEADER_SIZE,
  readSword2MultiScreenHeader,
  SCREEN_HEADER_SIZE,
  Sword2FileType,
  sword2Animation,
} from '../src/engine/sword2/resource/sword2Headers.js';
import { readSwordHeader, sword1SpriteFrames } from '../src/engine/sword1/resource/swordDefs.js';
import { sword1SpeechFileIn } from '../src/engine/sword1/sound/musicFiles.js';
import { readSword1SpeechIndex } from '../src/engine/sword1/sound/speechIndex.js';
import { compressSpeech, readSpeechRuns } from '../src/engine/sword1/sound/swordAudio.js';
import { formatResourceId } from '../src/engine/sword1/resource/rif.js';
import { writeSword1WalkGrid } from '../src/engine/sword1/script/swordWalkGrid.js';
import { writeSword2WalkGrid } from '../src/engine/sword2/script/sword2WalkGrid.js';
import { importSword1Project } from '../src/authoring/sword1/import.js';
import { importSword2Project } from '../src/authoring/sword2/import.js';
import { fromBase64 } from '../src/authoring/base64.js';
import {
  compressionOf,
  decodeSwordFrame,
  decodeSwordParallaxRow,
  parseSwordParallax,
} from '../src/engine/sword1/gfx/swordDecode.js';
import {
  compressHIF,
  encodeSwordFrame,
  encodeSwordParallax,
} from '../src/engine/sword1/gfx/swordEncode.js';
import { decompressHIF } from '../src/engine/sword1/gfx/swordDecode.js';
import { decodeSword2Frame, parseSword2Parallax } from '../src/engine/sword2/gfx/sword2Decode.js';
import { encodeSword2Frame, encodeSword2Parallax } from '../src/engine/sword2/gfx/sword2Encode.js';

/** What a sweep found out about one family's pictures. */
interface FrameTally {
  decoded: number;
  undecodable: number;
  identical: number;
  /** Different bytes, identical pixels — a tie the format allows. */
  tied: number;
  differs: number;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let at = 0; at < left.length; at++) if (left[at] !== right[at]) return false;
  return true;
}

/** Speech lines decoded and written back, the same claim as `FrameTally`. */
interface SpeechTally {
  decoded: number;
  undecodable: number;
  identical: number;
  /** Different bytes, identical samples — the format has ties too. */
  tied: number;
  differs: number;
}

function speechLine(tally: SpeechTally): string {
  const total = tally.identical + tally.tied + tally.differs;
  if (total === 0 && tally.undecodable === 0) return 'no speech container';
  return (
    `${tally.decoded} speech lines decoded, ${tally.undecodable} would not; ` +
    `${tally.identical} of ${total} re-encode byte-identically` +
    (tally.tied > 0 ? `, ${tally.tied} differ in bytes and not in samples` : '') +
    (tally.differs > 0 ? `, ${tally.differs} decode differently` : '')
  );
}

/** Layers re-encoded whole, which is the check an export actually makes. */
interface LayerTally {
  identical: number;
  differs: number;
}

function layerLine(tally: LayerTally): string {
  const total = tally.identical + tally.differs;
  return total === 0
    ? 'no parallax layers'
    : `${tally.identical} of ${total} parallax layers re-encode byte-identically`;
}

/**
 * Walk grids re-emitted from the four numbers a bar is carried as.
 *
 * A different claim from the picture tallies, and a stronger one: a bar stores
 * eleven fields and the editor holds four, so this counts whether *deriving*
 * the other seven gives the shipped bytes back. If it ever does not, an author
 * who never touched a grid would still export a changed one.
 */
interface GridTally {
  identical: number;
  differs: number;
}

function gridLine(tally: GridTally, bars: number, nodes: number): string {
  const total = tally.identical + tally.differs;
  return total === 0
    ? 'no walk grids'
    : `${tally.identical} of ${total} walk grids (${bars} bars, ${nodes} nodes) re-emit ` +
        `byte-identically from their segments`;
}

function frameLine(tally: FrameTally): string {
  const total = tally.identical + tally.tied + tally.differs;
  return (
    `${tally.decoded} sprite frames decoded, ${tally.undecodable} would not; ` +
    `${tally.identical} of ${total} re-encode byte-identically` +
    (tally.tied > 0 ? `, ${tally.tied} differ in bytes and not in pixels` : '') +
    (tally.differs > 0 ? `, ${tally.differs} decode differently` : '')
  );
}

/** A line's header with different runs after it, so the result can be re-read. */
function withRuns(header: Uint8Array, runs: Uint8Array): Uint8Array {
  const joined = new Uint8Array(header.length + runs.length);
  joined.set(header, 0);
  joined.set(runs, header.length);
  return joined;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const path = process.argv[2];
if (!path) fail('usage: npm run sweep:sword -- /path/to/game');

const source = await openGame(path);
const names = source.list();

if (looksLikeSword1(names)) {
  const detection = identifySword1(names);
  const resources = await SwordResources.create(source, {
    onLog: (line) => process.stdout.write(`${line}\n`),
  });
  process.stdout.write(`Broken Sword (${detection.release} release) — ${detection.evidence}\n`);

  // Every cluster resident: a sweep is not a game, so the residency rules that
  // keep a browser's memory bounded do not apply and reading everything is the
  // point.
  for (const label of resources.availableClusters) {
    if (SwordResources.isStreamed(label)) continue;
    await resources.loadCluster(label, true);
  }

  let read = 0;
  let failed = 0;
  for (const id of resources.allIds()) {
    try {
      if (resources.fetch(id)) read++;
      else failed++;
    } catch (error) {
      failed++;
      process.stdout.write(
        `  resource ${id.toString(16)}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const modules = new Set(SWORD1_SECTION_SCRIPTS.filter((id) => id !== 0));
  let trips = 0;
  let differs = 0;
  let instructions = 0;
  let unrecovered = 0;
  // How much of the editor's named-argument view the shipped scripts support.
  // A call the grouping cannot attribute is still listed instruction by
  // instruction, so this is a coverage number rather than a failure count.
  let calls = 0;
  let grouped = 0;
  let named = 0;
  let argumentCount = 0;
  for (const id of modules) {
    const resource = resources.fetch(id);
    if (!resource) continue;
    try {
      const module = parseSword1ScriptModule(resource.payload, resources.bigEndian);
      const disassembly = disassembleSword1Script(module);
      instructions += disassembly.instructions.length;
      unrecovered += disassembly.unrecovered.length;
      for (const call of sword1Calls(disassembly.instructions, disassembly.entries)) {
        calls++;
        if (call.arguments.length === 0 && call.count > 0) continue;
        grouped++;
        argumentCount += call.arguments.length;
        named += call.arguments.filter((argument) => argument.name !== null).length;
      }
      const trip = roundTripsSword1Script(module, disassembly);
      if (trip.ok) trips++;
      else {
        differs++;
        process.stdout.write(
          `  module ${id.toString(16)} differs at word ${trip.at}: ` +
            `${trip.expected} became ${trip.actual}\n`,
        );
      }
    } catch (error) {
      differs++;
      process.stdout.write(
        `  module ${id.toString(16)}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  // Pictures. A sprite resource says so in its header type, and the frames
  // inside carry their own compression tag, so this needs no table: decode
  // each frame, write it back in the tag it came in, and compare.
  const frames: FrameTally = { decoded: 0, undecodable: 0, identical: 0, tied: 0, differs: 0 };
  // HIF is counted separately and in pixels, never in bytes: no PC release
  // carries a HIF frame, so there is no original stream to be identical to.
  // What is being measured is that `compressHIF` writes something
  // `decompressHIF` reads back — the same pixels this frame decoded to.
  const hif = { written: 0, same: 0, differs: 0, pixels: 0, bytes: 0 };
  for (const id of resources.allIds()) {
    const resource = resources.fetch(id);
    if (!resource || readSwordHeader(resource.bytes, resources.bigEndian).type !== 'Sprite') {
      continue;
    }
    for (const frame of sword1SpriteFrames(resource.bytes, resources.bigEndian)) {
      const compression = compressionOf(frame.header.runTimeComp);
      let pixels;
      try {
        pixels = decodeSwordFrame(
          frame.data,
          compression,
          frame.header.compSize,
          frame.header.width,
          frame.header.height,
        );
      } catch {
        frames.undecodable++;
        continue;
      }
      frames.decoded++;

      const asHif = compressHIF(pixels);
      const fromHif = new Uint8Array(pixels.length);
      decompressHIF(asHif, fromHif);
      hif.written++;
      hif.pixels += pixels.length;
      hif.bytes += asHif.length;
      if (sameBytes(fromHif, pixels)) hif.same++;
      else hif.differs++;

      const written = encodeSwordFrame(pixels, compression);
      if (written.compression === compression && sameBytes(written.bytes, frame.data)) {
        frames.identical++;
        continue;
      }
      // Different bytes are only a fault if they are different *pixels*. Both
      // of these formats have ties — two encodings a decoder cannot tell apart
      // — so the second comparison is the one that decides.
      const again = decodeSwordFrame(
        written.bytes,
        written.compression,
        written.bytes.length,
        frame.header.width,
        frame.header.height,
      );
      if (sameBytes(again, pixels)) frames.tied++;
      else frames.differs++;
      process.stdout.write(
        `  ${formatResourceId(id)} frame ${frame.index} (${frame.header.runTimeComp.trim()}, ` +
          `${frame.header.width}x${frame.header.height}) re-encodes to ` +
          (written.bytes.length === frame.data.length
            ? `the same ${written.bytes.length} bytes split differently`
            : `${written.bytes.length} bytes, not ${frame.data.length}`) +
          `, and the pixels ${sameBytes(again, pixels) ? 'match' : 'do not match'}\n`,
      );
    }
  }

  // Parallax layers, whole: the row table moves when a row's length changes,
  // so re-encoding row by row would not catch an encoder that writes a correct
  // row at the wrong offset.
  const layers: LayerTally = { identical: 0, differs: 0 };
  for (const id of resources.allIds()) {
    const resource = resources.fetch(id);
    if (!resource || !readSwordHeader(resource.bytes, resources.bigEndian).type.startsWith('PARAL'))
      continue;
    let parallax;
    try {
      parallax = parseSwordParallax(resource.bytes, resources.bigEndian);
    } catch {
      continue;
    }
    const pixels = new Uint8Array(parallax.width * parallax.height);
    for (let row = 0; row < parallax.height; row++) {
      const strip = decodeSwordParallaxRow(resource.bytes, parallax, row);
      if (strip) pixels.set(strip, row * parallax.width);
    }
    const written = encodeSwordParallax(
      pixels,
      parallax.width,
      parallax.height,
      resource.bytes.subarray(0, 16),
      resources.bigEndian,
    );
    if (sameBytes(written, resource.bytes.subarray(0, written.length))) layers.identical++;
    else {
      layers.differs++;
      process.stdout.write(
        `  ${formatResourceId(id)} is a ${parallax.width}x${parallax.height} parallax that ` +
          `re-encodes to ${written.length} bytes, not ${resource.bytes.length}\n`,
      );
    }
  }

  // Speech, which is the one sound format that is not a file a browser can
  // play: Revolution's own 16-bit RLE inside a WAVE header. The check is the
  // sprite check said in samples — decode a line, write it back with
  // `compressSpeech`, compare with the bytes the container holds.
  const speech: SpeechTally = { decoded: 0, undecodable: 0, identical: 0, tied: 0, differs: 0 };
  const speechFile = sword1SpeechFileIn(names);
  const speechIndex = speechFile ? await readSword1SpeechIndex(source, speechFile) : null;
  if (speechIndex) {
    const mode = /(?:^|[/\\])cows\.mad$/i.test(speechIndex.file) ? 'demo' : 'wave';
    for (const entry of speechIndex.entries()) {
      const bytes = await readRangeFrom(
        source,
        speechIndex.file,
        entry.at,
        entry.at + entry.length,
      );
      if (!bytes || bytes.length === 0) continue;
      let stream;
      try {
        stream = readSpeechRuns(bytes, resources.bigEndian, mode);
      } catch {
        speech.undecodable++;
        continue;
      }
      speech.decoded++;
      const written = compressSpeech(stream.samples, resources.bigEndian);
      const original = bytes.subarray(stream.runsAt);
      if (sameBytes(written, original)) {
        speech.identical++;
        continue;
      }
      // Same tie the frames have: two encodings of the same samples. What
      // decides is whether the samples come back, so decode the written bytes
      // by walking them the way the container's own runs are walked.
      const again = readSpeechRuns(
        withRuns(bytes.subarray(0, stream.runsAt), written),
        resources.bigEndian,
        mode,
      ).samples;
      const matched = sameBytes(
        new Uint8Array(again.buffer, again.byteOffset, again.byteLength),
        new Uint8Array(stream.samples.buffer, stream.samples.byteOffset, stream.samples.byteLength),
      );
      if (matched) speech.tied++;
      else speech.differs++;
      // Same length and different bytes is the commonest of the nine, so it
      // gets its own sentence: "re-encodes to 78968 bytes, not 78968" is a
      // line that reads like a bug in the report rather than a tie in the
      // data.
      process.stdout.write(
        `  speech room ${entry.room} line ${entry.line} re-encodes to ` +
          (written.length === original.length
            ? `the same ${written.length} bytes split differently`
            : `${written.length} bytes, not ${original.length}`) +
          `, and the samples ${matched ? 'match' : 'do not match'}\n`,
      );
    }
  }

  /*
   * Walk grids, re-emitted from the segments the project carries.
   *
   * The import is run rather than the resources re-read, because what is being
   * checked is the editor's own reading: `Sword1ProjectWalkGrid` holds two
   * endpoints per bar and nothing else, and the seven fields the resource
   * stores beside them are derived on the way out.
   */
  const grids: GridTally = { identical: 0, differs: 0 };
  let gridBars = 0;
  let gridNodes = 0;
  for (const grid of importSword1Project(resources, detection).walkGrids ?? []) {
    const original = resources.fetch(grid.resource);
    if (!original) continue;
    gridBars += grid.bars.length;
    gridNodes += grid.nodes.length;
    const written = writeSword1WalkGrid(grid, fromBase64(grid.headerBase64), resources.bigEndian);
    if (sameBytes(written, original.bytes)) grids.identical++;
    else {
      grids.differs++;
      process.stdout.write(
        `  walk grid ${formatResourceId(grid.resource)} re-emits to ${written.length} bytes, ` +
          `not ${original.bytes.length}\n`,
      );
    }
  }

  process.stdout.write(
    `${read} resources read, ${failed} unreadable; ` +
      `${trips} of ${trips + differs} script modules re-emit byte-identically; ` +
      `${frameLine(frames)}; ` +
      `${hif.written} frames written as HIF and decoded again: ${hif.same} give back the same ` +
      `pixels, ${hif.differs} do not (${hif.pixels} pixels in ${hif.bytes} bytes); ` +
      `${layerLine(layers)}; ${speechLine(speech)}; ` +
      `${gridLine(grids, gridBars, gridNodes)}; ` +
      `${instructions} instructions, ${unrecovered} unrecovered words; ` +
      `${grouped} of ${calls} calls group into named arguments ` +
      `(${named} of ${argumentCount} arguments named)\n`,
  );
  process.exit(
    differs > 0 ||
      unrecovered > 0 ||
      frames.differs > 0 ||
      layers.differs > 0 ||
      speech.differs > 0 ||
      grids.differs > 0
      ? 1
      : 0,
  );
}

if (looksLikeSword2(names)) {
  const resources = await Sword2Resources.create(source, {
    onLog: (line) => process.stdout.write(`${line}\n`),
  });
  const detection = refineSword2Release(identifySword2(names), resources.clusterNames);
  process.stdout.write(`Broken Sword II (${detection.release} release) — ${detection.evidence}\n`);

  for (const name of resources.presentClusters) await resources.loadCluster(name, true);

  let read = 0;
  let failed = 0;
  let trips = 0;
  let differs = 0;
  let instructions = 0;
  let unrecovered = 0;
  let calls = 0;
  let grouped = 0;
  let named = 0;
  let parameters = 0;

  for (const id of resources.allIds()) {
    let resource;
    try {
      resource = resources.fetch(id);
    } catch (error) {
      failed++;
      process.stdout.write(
        `  resource ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      continue;
    }
    if (!resource) {
      failed++;
      continue;
    }
    read++;
    if (
      resource.header.fileType !== Sword2FileType.GAME_OBJECT &&
      resource.header.fileType !== Sword2FileType.SCREEN_MANAGER
    ) {
      continue;
    }
    try {
      const object = parseSword2Object(resource.bytes);
      const disassembly = disassembleSword2Object(object);
      instructions += disassembly.instructions.length;
      unrecovered += disassembly.unrecovered.length;
      for (const call of sword2Calls(disassembly.instructions, disassembly.entries)) {
        calls++;
        if (call.arguments.length === 0 && call.count > 0) continue;
        grouped++;
        parameters += call.arguments.length;
        named += call.arguments.filter((argument) => argument.name !== null).length;
      }
      const trip = roundTripsSword2Object(object, disassembly);
      if (trip.ok) trips++;
      else {
        differs++;
        process.stdout.write(
          `  object ${id} ("${object.name}") differs at byte ${trip.at}: ` +
            `${trip.expected} became ${trip.actual}\n`,
        );
      }
    } catch (error) {
      differs++;
      process.stdout.write(
        `  object ${id}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const frames: FrameTally = { decoded: 0, undecodable: 0, identical: 0, tied: 0, differs: 0 };
  for (const id of resources.allIds()) {
    const resource = resources.fetch(id);
    if (!resource || resource.header.fileType !== Sword2FileType.ANIMATION_FILE) continue;
    const animation = sword2Animation(resource.bytes);
    if (!animation) continue;
    for (const frame of animation.frames) {
      const decoded = decodeSword2Frame(
        frame.data,
        frame.compression,
        frame.header.width,
        frame.header.height,
        animation.colourTable ?? undefined,
      );
      if (!decoded.ok) {
        frames.undecodable++;
        continue;
      }
      frames.decoded++;
      let written;
      try {
        written = encodeSword2Frame(
          decoded.pixels,
          frame.header.width,
          frame.header.height,
          animation.header.runTimeComp,
          frame.cdt.frameType,
          animation.colourTable ?? undefined,
        );
      } catch {
        frames.differs++;
        continue;
      }
      if (sameBytes(written, frame.data)) {
        frames.identical++;
        continue;
      }
      const again = decodeSword2Frame(
        written,
        frame.compression,
        frame.header.width,
        frame.header.height,
        animation.colourTable ?? undefined,
      );
      const matches = again.ok && sameBytes(again.pixels, decoded.pixels);
      if (matches) frames.tied++;
      else frames.differs++;
      process.stdout.write(
        `  animation ${id} frame ${frame.index} (compression ${frame.compression}, ` +
          `frameType ${frame.cdt.frameType}, ${frame.header.width}x${frame.header.height}) ` +
          `re-encodes to ` +
          (written.length === frame.data.length
            ? `the same ${written.length} bytes split differently`
            : `${written.length} bytes, not ${frame.data.length}`) +
          `, and the pixels ${matches ? 'match' : 'do not match'}\n`,
      );
    }
  }

  // A screen file holds five parallax layers, of which the background is one.
  const layers: LayerTally = { identical: 0, differs: 0 };
  for (const id of resources.allIds()) {
    const resource = resources.fetch(id);
    if (!resource || resource.header.fileType !== Sword2FileType.SCREEN_FILE) continue;
    const bytes = resource.bytes;
    if (bytes.length < RES_HEADER_SIZE + MULTI_SCREEN_HEADER_SIZE) continue;
    const multi = readSword2MultiScreenHeader(bytes, RES_HEADER_SIZE);
    const at = [
      RES_HEADER_SIZE + multi.screen + SCREEN_HEADER_SIZE,
      ...multi.bgParallax.filter(Boolean).map((offset) => RES_HEADER_SIZE + offset),
      ...multi.fgParallax.filter(Boolean).map((offset) => RES_HEADER_SIZE + offset),
    ];
    for (const layerAt of at) {
      const parallax = parseSword2Parallax(bytes, layerAt);
      if (!parallax) continue;
      const written = encodeSword2Parallax(parallax.pixels, parallax.width, parallax.height);
      if (sameBytes(written, bytes.subarray(layerAt, layerAt + written.length))) layers.identical++;
      else {
        layers.differs++;
        process.stdout.write(
          `  screen ${id} has a ${parallax.width}x${parallax.height} layer at ${layerAt} that ` +
            `re-encodes to ${written.length} bytes\n`,
        );
      }
    }
  }

  // The same claim on Sword2's side, against the grids `fnAddWalkGrid` names.
  const grids: GridTally = { identical: 0, differs: 0 };
  let gridBars = 0;
  let gridNodes = 0;
  for (const grid of importSword2Project(resources, detection).walkGrids ?? []) {
    const original = resources.fetch(grid.resource);
    if (!original) continue;
    gridBars += grid.bars.length;
    gridNodes += grid.nodes.length;
    const written = writeSword2WalkGrid(grid, fromBase64(grid.headerBase64));
    if (sameBytes(written, original.bytes)) grids.identical++;
    else {
      grids.differs++;
      process.stdout.write(
        `  walk grid ${grid.resource} ("${grid.name}") re-emits to ${written.length} bytes, ` +
          `not ${original.bytes.length}\n`,
      );
    }
  }

  process.stdout.write(
    `${read} resources read, ${failed} unreadable; ` +
      `${trips} of ${trips + differs} objects re-emit byte-identically; ` +
      `${frameLine(frames)}; ${layerLine(layers)}; ` +
      `${gridLine(grids, gridBars, gridNodes)}; ` +
      `${instructions} instructions, ${unrecovered} unrecovered bytes; ` +
      `${grouped} of ${calls} calls group into named parameters ` +
      `(${named} of ${parameters} parameters named)\n`,
  );
  process.exit(
    differs > 0 || unrecovered > 0 || frames.differs > 0 || layers.differs > 0 || grids.differs > 0
      ? 1
      : 0,
  );
}

fail(
  `${path} holds neither a Broken Sword index (swordres.rif beside a cluster) nor a Broken ` +
    `Sword II one (resource.inf and resource.tab).`,
);
