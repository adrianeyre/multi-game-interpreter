/**
 * Builds a `Sword2Project` from a loaded Broken Sword II install.
 *
 * A function of the resources rather than a method on the engine, for the reason
 * `sword1/import.ts` gives: the same build runs from a fixture with no engine,
 * which is what makes the editable-surface claims checkable.
 *
 * ## Why this walks the whole id space
 *
 * Sword2 has no table saying which ids are objects and which are screens: the
 * *resource's own header* says, in its `fileType` byte. So the import walks
 * every id the table holds an entry for and sorts by type — which is both the
 * only way to do it and a better one than Sword1's, because nothing here
 * depends on a table this project carries.
 *
 * The cost is that it needs every cluster resident, which is why the engine
 * loads them all before calling this.
 */

import { toBase64 } from '../base64.js';
import { disassembleSword2Object, roundTripsSword2Object } from './disassemble.js';
import {
  SWORD2_SURFACES,
  type Sword2Project,
  type Sword2ProjectAnimation,
  type Sword2ProjectObject,
  type Sword2ProjectPalette,
  type Sword2ProjectScreen,
  type Sword2ProjectText,
  type Sword2ProjectWalkGrid,
} from './project.js';
import type { Sword2Resources } from '../../engine/sword2/resource/Sword2Resources.js';
import type { Sword2Detection } from '../../engine/sword2/resource/sword2Detect.js';
import {
  RES_HEADER_SIZE,
  Sword2FileType,
  readSword2AnimHeader,
  readSword2MultiScreenHeader,
  readSword2ScreenHeader,
  SWORD2_TEXT_ENCODING,
  TEXT_HEADER_SIZE,
} from '../../engine/sword2/resource/sword2Headers.js';
import { parseSword2Object } from '../../engine/sword2/script/Sword2Interpreter.js';
import { SWORD2_GLOBAL_VAR_RESOURCE } from '../../engine/sword2/script/sword2Vars.js';
import { parseSword2WalkGrid } from '../../engine/sword2/script/sword2WalkGrid.js';
import { sword2Calls } from './calls.js';

/** How many bytes of screen and animation data to carry before stopping. */
const PICTURE_BUDGET = 24 * 1024 * 1024;

/**
 * Reads a text module's lines, with the speech each line names.
 *
 * A count, then one offset per line, then NUL-terminated strings. The offsets
 * are measured from the **resource's own start**, header included — which is
 * why this takes the whole resource and not its payload. ScummVM's
 * `fetchTextLine` is unambiguous about it (`file + READ_LE_UINT32(file +
 * ResHeader::size() + 4 + 4 * line)`), and measuring from the payload instead
 * lands 44 bytes late in every line: the demo's first subtitle came back as
 * "0I was sure Titipoco wasn't pointing at that barrel." rather than "The
 * barrel contained cool refreshing water.", and every line after it was a
 * fragment of the wrong sentence.
 *
 * The two bytes in front of every string are a **wav id**, and they are not
 * decoration: `fnISpeak` plays a line's speech by that number, so a project
 * that read the words and dropped the id would export a game that has
 * subtitles and no voices. They are carried beside the line rather than inside
 * it, so an author edits a sentence and the recording it belongs to stays put.
 */
export function readSword2TextEntries(
  resource: Uint8Array,
): Array<{ text: string; wavId: number }> {
  if (resource.length < RES_HEADER_SIZE + TEXT_HEADER_SIZE) return [];
  const view = new DataView(resource.buffer, resource.byteOffset, resource.byteLength);
  const count = view.getUint32(RES_HEADER_SIZE, true);
  const table = RES_HEADER_SIZE + TEXT_HEADER_SIZE;
  if (count === 0 || table + count * 4 > resource.length) return [];
  const decoder = new TextDecoder(SWORD2_TEXT_ENCODING);
  const lines: Array<{ text: string; wavId: number }> = [];
  for (let line = 0; line < count; line++) {
    const offset = view.getUint32(table + line * 4, true);
    if (offset === 0 || offset + 2 > resource.length) {
      lines.push({ text: '', wavId: 0 });
      continue;
    }
    let end = offset + 2;
    while (end < resource.length && resource[end] !== 0) end++;
    lines.push({
      text: decoder.decode(resource.subarray(offset + 2, end)),
      wavId: view.getUint16(offset, true),
    });
  }
  return lines;
}

/** The same module as lines alone, for a reader that has no use for the ids. */
export function readSword2Text(resource: Uint8Array): string[] {
  return readSword2TextEntries(resource).map((line) => line.text);
}

export function importSword2Project(
  resources: Sword2Resources,
  detection: Sword2Detection,
): Sword2Project {
  const reasons: string[] = [];
  const objects: Sword2ProjectObject[] = [];
  const text: Sword2ProjectText[] = [];
  const screens: Sword2ProjectScreen[] = [];
  const palettes: Sword2ProjectPalette[] = [];
  const animations: Sword2ProjectAnimation[] = [];
  const runLists: Array<{ resource: number; objects: number[]; screen?: number }> = [];

  /*
   * What it takes to say which screen a walk grid belongs to.
   *
   * Nothing in the data says it. `fnAddWalkGrid` registers a grid for whatever
   * session is running, and the session is a run list — so the route is: a run
   * list holds object ids, an object's script calls `fnAddWalkGrid` with a
   * constant, and the run list and the screen that share a session share a
   * *name*. "Run list for 11" and "Screen 11" are the game's own strings, and
   * they are the only thing joining the two.
   *
   * Which makes this a best effort by construction, and it says so: a grid
   * registered with a computed id, or from an object no run list holds, comes
   * out with an empty `screens` rather than a guessed one.
   */
  const walkGridBytes = new Map<number, Uint8Array>();
  const gridsByObject = new Map<number, Set<number>>();
  const screenBySession = new Map<number, number>();
  const runListSessions = new Map<number, number>();

  let unrecovered = 0;
  let pictureBytes = 0;
  let pictureSkipped = 0;

  let globals = { count: 0, bytesBase64: '' };

  for (const id of resources.allIds()) {
    const resource = resources.fetch(id);
    if (!resource) continue;

    switch (resource.header.fileType) {
      case Sword2FileType.GAME_OBJECT:
      case Sword2FileType.SCREEN_MANAGER: {
        try {
          const layout = parseSword2Object(resource.bytes);
          const disassembly = disassembleSword2Object(layout);
          const trip = roundTripsSword2Object(layout, disassembly);
          unrecovered += disassembly.unrecovered.length;
          if (!trip.ok) {
            reasons.push(
              `object "${layout.name}" (${id}) did not re-emit byte-identically: byte ` +
                `${trip.at} was ${trip.expected} and became ${trip.actual}`,
            );
          }
          for (const call of sword2Calls(disassembly.instructions, disassembly.entries)) {
            if (call.name !== 'fnAddWalkGrid' && call.name !== 'fnRegisterWalkGrid') continue;
            const argument = call.arguments[0];
            // Only a literal. A grid reached through a variable is one this
            // import cannot name, and naming it anyway is the guess the
            // record's doc comment promises not to make.
            if (!argument || argument.push !== 'int' || argument.value <= 0) continue;
            const set = gridsByObject.get(id) ?? new Set<number>();
            set.add(argument.value);
            gridsByObject.set(id, set);
          }
          objects.push({
            id,
            name: layout.name,
            bytesBase64: toBase64(resource.bytes),
            instructions: disassembly.instructions,
            entries: disassembly.entries,
            unrecovered: disassembly.unrecovered,
            roundTrips: trip.ok,
            layout: {
              localsAt: layout.localsAt,
              localsBytes: layout.localsBytes,
              codeAt: layout.codeAt,
              codeBytes: layout.codeBytes,
            },
          });
        } catch (error) {
          reasons.push(
            `object ${id} would not parse: ` +
              (error instanceof Error ? error.message : String(error)),
          );
        }
        break;
      }

      case Sword2FileType.GLOBAL_VAR_FILE:
        if (id === SWORD2_GLOBAL_VAR_RESOURCE) {
          globals = {
            count: Math.floor((resource.bytes.length - RES_HEADER_SIZE) / 4),
            bytesBase64: toBase64(resource.payload),
          };
        }
        break;

      case Sword2FileType.TEXT_FILE: {
        const entries = readSword2TextEntries(resource.bytes);
        text.push({
          resource: id,
          lines: entries.map((line) => line.text),
          wavIds: entries.map((line) => line.wavId),
        });
        break;
      }

      case Sword2FileType.RUN_LIST: {
        const view = new DataView(
          resource.payload.buffer,
          resource.payload.byteOffset,
          resource.payload.byteLength,
        );
        const ids: number[] = [];
        for (let at = 0; at + 4 <= resource.payload.length; at += 4) {
          const entry = view.getUint32(at, true);
          if (entry === 0) break;
          ids.push(entry);
        }
        runLists.push({ resource: id, objects: ids });
        const session = /(\d+)\s*$/.exec(resource.header.name);
        if (session) runListSessions.set(id, Number(session[1]));
        break;
      }

      case Sword2FileType.SCREEN_FILE: {
        if (resource.bytes.length < RES_HEADER_SIZE + 36) break;
        const named = /(\d+)\s*$/.exec(resource.header.name);
        if (named) screenBySession.set(Number(named[1]), id);
        const multi = readSword2MultiScreenHeader(resource.bytes, RES_HEADER_SIZE);
        const header = readSword2ScreenHeader(resource.bytes, RES_HEADER_SIZE + multi.screen);
        if (multi.palette && multi.palette + 1024 <= resource.bytes.length - RES_HEADER_SIZE) {
          palettes.push({
            screen: id,
            bytesBase64: toBase64(
              resource.bytes.subarray(
                RES_HEADER_SIZE + multi.palette,
                RES_HEADER_SIZE + multi.palette + 1024,
              ),
            ),
          });
        }
        if (pictureBytes + resource.bytes.length > PICTURE_BUDGET) {
          pictureSkipped++;
          break;
        }
        pictureBytes += resource.bytes.length;
        screens.push({
          resource: id,
          width: header.width,
          height: header.height,
          layers: header.noLayers,
          hasPalette: multi.palette !== 0,
          parallax: [
            multi.bgParallax[0] !== 0,
            multi.bgParallax[1] !== 0,
            multi.fgParallax[0] !== 0,
            multi.fgParallax[1] !== 0,
          ],
          bytesBase64: toBase64(resource.bytes),
        });
        break;
      }

      case Sword2FileType.WALK_GRID_FILE:
        walkGridBytes.set(id, resource.bytes);
        break;

      case Sword2FileType.ANIMATION_FILE:
      case Sword2FileType.MOUSE_FILE:
      case Sword2FileType.ICON_FILE: {
        if (resource.bytes.length < RES_HEADER_SIZE + 15) break;
        const anim = readSword2AnimHeader(resource.bytes, RES_HEADER_SIZE);
        if (pictureBytes + resource.bytes.length > PICTURE_BUDGET) {
          pictureSkipped++;
          break;
        }
        pictureBytes += resource.bytes.length;
        animations.push({
          resource: id,
          name: resource.header.name,
          frames: anim.noAnimFrames,
          compression: anim.runTimeComp,
          bytesBase64: toBase64(resource.bytes),
        });
        break;
      }

      default:
        break;
    }
  }

  /*
   * The walk grids, joined to their screens through the run lists.
   *
   * Carried whole and not budgeted: the demo's four grids are 1,120 bytes,
   * which against the 24 MB the screens get is a cap nothing could reach — and
   * a missing walk grid is not a blank panel, it is a screen the router walks
   * through walls on.
   */
  const gridUses = new Map<number, { screens: Set<number>; objects: Set<number> }>();
  const useOf = (grid: number): { screens: Set<number>; objects: Set<number> } => {
    const use = gridUses.get(grid) ?? { screens: new Set<number>(), objects: new Set<number>() };
    gridUses.set(grid, use);
    return use;
  };
  for (const [object, grids] of gridsByObject)
    for (const grid of grids) useOf(grid).objects.add(object);
  for (const runList of runLists) {
    const screen = screenBySession.get(runListSessions.get(runList.resource) ?? -1);
    if (screen === undefined) continue;
    // Carried on the run list as well as used here: a screen's canvas needs the
    // same join to know which objects stand on it, and deriving it twice would
    // be two places for the name rule to drift.
    runList.screen = screen;
    for (const object of runList.objects) {
      for (const grid of gridsByObject.get(object) ?? []) useOf(grid).screens.add(screen);
    }
  }

  const walkGrids: Sword2ProjectWalkGrid[] = [];
  for (const [id, bytes] of [...walkGridBytes].sort((first, second) => first[0] - second[0])) {
    const parsed = parseSword2WalkGrid(bytes);
    if (!parsed) {
      reasons.push(
        `walk grid ${id} is ${bytes.length} bytes, which is not as long as the bars and nodes ` +
          `its own counts declare, so it was left out rather than read past its end`,
      );
      continue;
    }
    const use = gridUses.get(id);
    walkGrids.push({
      resource: id,
      name: resources.fetch(id)?.header.name ?? '',
      screens: [...(use?.screens ?? [])].sort((first, second) => first - second),
      objects: [...(use?.objects ?? [])].sort((first, second) => first - second),
      headerBase64: toBase64(bytes.subarray(0, RES_HEADER_SIZE)),
      bars: parsed.bars,
      nodes: parsed.nodes,
    });
  }

  if (pictureSkipped > 0) {
    reasons.push(
      `${pictureSkipped} screen and animation resources were left out to keep the project ` +
        `under ${Math.round(PICTURE_BUDGET / (1024 * 1024))} MB; the editor asks for the game ` +
        `folder again to show them (ADR 0010's rule for a large import)`,
    );
  }

  const editable = objects.length > 0 || text.length > 0;
  if (!editable) {
    reasons.push(
      'no surface could be read: this install has an index but none of the clusters the ' +
        'editable surfaces come from',
    );
  }

  return {
    identification: {
      release: detection.release,
      how: detection.identification,
      evidence: detection.evidence,
    },
    editable: { editable, unrecovered, reasons },
    surfaces: SWORD2_SURFACES,
    objects,
    globals,
    text,
    screens,
    palettes,
    animations,
    walkGrids,
    runLists,
    clusters: { present: resources.presentClusters, absent: resources.absentClusters },
    resourceCount: resources.resourceCount,
  };
}

/** A one-line summary of what a project holds, for the editor's notes. */
export function describeSword2Project(project: Sword2Project): string[] {
  const instructions = project.objects.reduce(
    (total, object) => total + object.instructions.length,
    0,
  );
  const lines = project.text.reduce((total, entry) => total + entry.lines.length, 0);
  return [
    `Broken Sword II (${project.identification.release} release) — ` +
      `${project.identification.evidence}`,
    `${project.objects.length} objects, ${instructions} instructions, ` +
      `${project.objects.filter((object) => object.roundTrips).length} of ` +
      `${project.objects.length} re-emitting byte-identically`,
    `${project.globals.count} script variables, read from the game's own global variable file ` +
      `rather than from a table this project carries`,
    `${lines} text lines across ${project.text.length} modules`,
    `${project.runLists.length} run lists — the object ids alive in each session, which is how ` +
      `this game changes room`,
    `${project.screens.length} screens and ${project.palettes.length} palettes; ` +
      `${project.animations.length} animations (editable and written back: all three ` +
      `compression schemes re-encode, and the exporter carries both surfaces out into an ` +
      `install)`,
    `${(project.walkGrids ?? []).length} walk grids — ` +
      `${(project.walkGrids ?? []).reduce((total, grid) => total + grid.bars.length, 0)} bars and ` +
      `${(project.walkGrids ?? []).reduce((total, grid) => total + grid.nodes.length, 0)} nodes, ` +
      `editable and written back`,
    project.editable.unrecovered === 0
      ? 'Unrecovered 0: every script byte decoded to an instruction'
      : `Unrecovered ${project.editable.unrecovered} script bytes`,
  ];
}
