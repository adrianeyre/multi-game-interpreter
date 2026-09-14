/**
 * Builds a `Sword1Project` from a loaded Broken Sword install.
 *
 * The one place that decides what the editor gets to see, and it is deliberately
 * a *function of the resources* rather than a method on the engine: the same
 * build runs from a test fixture with no engine at all, which is what makes the
 * editable-surface claims checkable.
 *
 * ## The order of work matters for one reason
 *
 * Scripts are decompiled first and their round-trip checked, because
 * `editable.unrecovered` is a count over script words and the editor's refusal
 * message depends on it. Everything else is preservation or a trivial
 * round-trip, so it cannot fail in a way that changes the verdict.
 */

import { toBase64 } from '../base64.js';
import { disassembleSword1Script, roundTripsSword1Script } from './disassemble.js';
import { SWORD1_PLAY_CALLS, sword1Calls } from './calls.js';
import {
  SWORD1_SURFACES,
  type Sword1Project,
  type Sword1ProjectAnimSet,
  type Sword1ProjectAnimTable,
  type Sword1ProjectEffect,
  type Sword1ProjectPalette,
  type Sword1ProjectGrid,
  type Sword1ProjectPicture,
  type Sword1ProjectRoom,
  type Sword1ProjectScript,
  type Sword1ProjectSection,
  type Sword1ProjectStartPosition,
  type Sword1ProjectText,
  type Sword1ProjectWalkGrid,
  type Sword1SurfaceKind,
} from './project.js';
import type { Sword1Executable } from './executable.js';
import type { SwordResources } from '../../engine/sword1/resource/SwordResources.js';
import type { Sword1Detection } from '../../engine/sword1/resource/swordDetect.js';
import {
  CPT,
  readCompactSection,
  SWORD1_COMPACT_WORDS,
} from '../../engine/sword1/resource/swordCompact.js';
import {
  readSwordHeader,
  sword1SpriteFrames,
  SWORD1_LANGUAGES,
  SWORD1_HEADER_SIZE,
  SWORD1_TOTAL_SECTIONS,
  SwordType,
  type Sword1Language,
} from '../../engine/sword1/resource/swordDefs.js';
import {
  SWORD1_SECTION_COMPACTS,
  SWORD1_SECTION_SCRIPTS,
  SWORD1_SECTION_TEXT,
} from '../../engine/sword1/resource/swordSections.js';
import { SWORD1_ROOMS } from '../../engine/sword1/resource/swordRooms.js';
import { SWORD1_FX, sword1SampleId } from '../../engine/sword1/sound/fxTable.js';
import { parseSword1ScriptModule } from '../../engine/sword1/script/swordTokens.js';
import { readSwordTextResource } from '../../engine/sword1/resource/swordTextResources.js';
import { parseSwordParallax } from '../../engine/sword1/gfx/swordDecode.js';
import { parseSword1WalkGrid } from '../../engine/sword1/script/swordWalkGrid.js';

/** How many bytes of picture data to carry before a surface is left out. */
const PICTURE_BUDGET = 24 * 1024 * 1024;

/**
 * Where a resource is *used*, so a picker can say so.
 *
 * Built once from the room table rather than searched per resource, because the
 * table is 100 rooms and the pictures are hundreds — a search per picture is
 * quadratic for no reason.
 */
function screensByResource(): Map<number, number[]> {
  const uses = new Map<number, number[]>();
  const add = (resource: number, screen: number): void => {
    if (!resource) return;
    const list = uses.get(resource) ?? [];
    if (!list.includes(screen)) list.push(screen);
    uses.set(resource, list);
  };
  SWORD1_ROOMS.forEach((room, screen) => {
    for (const layer of room.layers) add(layer, screen);
    for (const grid of room.grids) add(grid, screen);
    for (const palette of room.palettes) add(palette, screen);
    for (const parallax of room.parallax) add(parallax, screen);
  });
  return uses;
}

export function importSword1Project(
  resources: SwordResources,
  detection: Sword1Detection,
  executables: readonly Sword1Executable[] = [],
): Sword1Project {
  const reasons: string[] = [];
  const uses = screensByResource();

  // --- scripts, which decide the verdict ---------------------------------
  const scripts: Sword1ProjectScript[] = [];
  const scriptSections = new Map<number, number[]>();
  SWORD1_SECTION_SCRIPTS.forEach((resource, section) => {
    if (resource === 0) return;
    const list = scriptSections.get(resource) ?? [];
    list.push(section);
    scriptSections.set(resource, list);
  });

  let unrecovered = 0;
  for (const [resource, sections] of [...scriptSections].sort((a, b) => a[0] - b[0])) {
    const fetched = resources.fetch(resource);
    if (!fetched) continue;
    try {
      const module = parseSword1ScriptModule(fetched.payload, resources.bigEndian);
      const disassembly = disassembleSword1Script(module);
      const trip = roundTripsSword1Script(module, disassembly);
      unrecovered += disassembly.unrecovered.length;
      if (!trip.ok) {
        reasons.push(
          `script module ${resource.toString(16)} did not re-emit byte-identically: word ` +
            `${trip.at} was ${trip.expected} and became ${trip.actual}`,
        );
      }
      scripts.push({
        resource,
        sections,
        instructions: disassembly.instructions,
        entries: disassembly.entries,
        unrecovered: disassembly.unrecovered,
        roundTrips: trip.ok,
      });
    } catch (error) {
      reasons.push(
        `script module ${resource.toString(16)} would not parse: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  // --- compacts -----------------------------------------------------------
  /** Walk grid resource to the floors and screens that name it: see below. */
  const floorUses = new Map<number, { screens: Set<number>; floors: Set<number> }>();
  const sections: Sword1ProjectSection[] = [];
  for (let section = 0; section < SWORD1_TOTAL_SECTIONS; section++) {
    const resource = SWORD1_SECTION_COMPACTS[section] ?? 0;
    if (resource === 0) continue;
    const fetched = resources.fetch(resource);
    if (!fetched) continue;
    try {
      const open = readCompactSection(fetched.bytes, section, resources.bigEndian);
      /*
       * Where each record *ends*, which is not where the engine stops reading.
       *
       * `compactIn` hands the interpreter a 3,085-word window because that is
       * the size of ScummVM's `Object` struct and the scripts address fields
       * by their offset in it. The records themselves are packed far tighter:
       * the demo's are 22, 25 and 57 words, so every window but the last
       * overlaps the record after it. Reading is unharmed — a script only
       * touches the fields its object's type has — but a *project* built out
       * of those windows holds each record several times over, and writing it
       * back made the demo's compact cluster 200 KB of game into 1,026 KB of
       * repetition.
       *
       * So a record runs to the next offset in use, whichever slot holds it.
       * "Whichever slot" rather than "the next slot" because three of the
       * demo's sections declare their offsets out of order.
       */
      const inUse = [...new Set(open.offsets)].sort((first, second) => first - second);
      const compacts = [];
      for (let index = 0; index < open.count; index++) {
        const start = open.offsets[index];
        if (start === undefined) continue;
        const next = inUse.find((offset) => offset > start) ?? open.words.length;
        const end = Math.min(start + SWORD1_COMPACT_WORDS, next, open.words.length);
        if (end <= start) continue;
        const words = open.words.subarray(start, end);
        /*
         * A FLOOR compact names its walk grid, and that is the only place the
         * link exists: there is no table of screens to grids.
         *
         * Read out of the record's *packed* extent — 25 words, measured, for
         * every one of the demo's 93 floors — rather than the 3,085-word
         * window the engine hands a script, so a short record cannot borrow
         * the next record's word and invent a grid nobody named. `CPT` holds
         * byte offsets, which is why these shift down by two.
         */
        if (end - start > CPT.RESOURCE >> 2 && words[CPT.TYPE >> 2] === SwordType.FLOOR) {
          const grid = words[CPT.RESOURCE >> 2] ?? 0;
          if (grid) {
            const use = floorUses.get(grid) ?? { screens: new Set(), floors: new Set() };
            use.screens.add(words[CPT.SCREEN >> 2] ?? 0);
            use.floors.add(section * 0x10000 + index);
            floorUses.set(grid, use);
          }
        }
        compacts.push({
          id: section * 0x10000 + index,
          section,
          index,
          wordsBase64: toBase64(new Uint8Array(words.buffer, words.byteOffset, words.byteLength)),
        });
      }
      sections.push({
        section,
        resource,
        compacts,
        offsets: open.offsets.slice(0, open.count),
        words: open.words.length,
      });
    } catch (error) {
      reasons.push(
        `section ${section}'s compacts would not parse: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  // --- text ---------------------------------------------------------------
  const text: Sword1ProjectText[] = [];
  for (let section = 0; section < SWORD1_TOTAL_SECTIONS; section++) {
    const row = SWORD1_SECTION_TEXT[section];
    if (!row) continue;
    SWORD1_LANGUAGES.forEach((language: Sword1Language, at: number) => {
      const resource = row[at] ?? 0;
      if (resource === 0) return;
      const fetched = resources.fetch(resource);
      if (!fetched) return;
      const lines = readSwordTextResource(fetched.payload, resources.bigEndian);
      if (lines.length === 0) return;
      text.push({ section, language, resource, lines });
    });
  }

  // --- palettes -----------------------------------------------------------
  const palettes: Sword1ProjectPalette[] = [];
  const seenPalettes = new Set<number>();
  for (const room of SWORD1_ROOMS) {
    for (const resource of room.palettes) {
      if (!resource || seenPalettes.has(resource)) continue;
      seenPalettes.add(resource);
      const fetched = resources.fetch(resource);
      if (!fetched) continue;
      palettes.push({
        resource,
        bytesBase64: toBase64(fetched.bytes.subarray(0, 768)),
        screens: uses.get(resource) ?? [],
      });
    }
  }

  // --- pictures -----------------------------------------------------------
  // Budgeted, like Sky's sprite surface: a full install's graphics are far more
  // than a project document should carry, so the biggest resources are taken
  // until the budget runs out and the rest are named as absent rather than
  // silently missing.
  const pictures: Sword1ProjectPicture[] = [];
  let pictureBytes = 0;
  let pictureSkipped = 0;
  const addPicture = (
    resource: number,
    kind: Sword1ProjectPicture['kind'],
    width: number,
    height: number,
    frames: number,
    grid?: Sword1ProjectGrid,
  ): void => {
    if (!resource) return;
    if (pictures.some((picture) => picture.resource === resource)) return;
    const fetched = resources.fetch(resource);
    if (!fetched) return;
    // A mask's grid rides in the same budget as the mask, because carrying one
    // without the other is carrying neither: see `gridFor`.
    const cost =
      fetched.bytes.length + (grid ? (resources.fetch(grid.resource)?.bytes.length ?? 0) : 0);
    if (pictureBytes + cost > PICTURE_BUDGET) {
      pictureSkipped++;
      return;
    }
    pictureBytes += cost;
    pictures.push({
      resource,
      kind,
      width,
      height,
      frames,
      bytesBase64: toBase64(fetched.bytes),
      screens: uses.get(resource) ?? [],
      ...(grid ? { grid } : {}),
    });
  };

  /**
   * A mask layer's Grid, carried with it.
   *
   * Without it a mask is a bag of 16x8 blocks in storage order with nothing
   * saying where any of them goes, so the editor could only refuse to draw it.
   * The demo's 15 grids are 140.7 KB together, against a 24 MB budget, so this
   * is the cheap half of making mask layers editable at all.
   */
  const gridFor = (
    room: (typeof SWORD1_ROOMS)[number],
    layer: number,
  ): Sword1ProjectGrid | undefined => {
    const resource = room.grids[layer - 1];
    if (!resource) return undefined;
    const fetched = resources.fetch(resource);
    if (!fetched) return undefined;
    return { resource, pitch: room.gridWidth, bytesBase64: toBase64(fetched.bytes) };
  };

  SWORD1_ROOMS.forEach((room, screen) => {
    if (room.sizeX === 0) return;
    addPicture(room.layers[0], 'background', room.sizeX, room.sizeY, 1);
    for (let layer = 1; layer < room.totalLayers; layer++) {
      addPicture(room.layers[layer], 'mask', room.sizeX, room.sizeY, 1, gridFor(room, layer));
    }
    for (const parallax of room.parallax) {
      if (!parallax) continue;
      const fetched = resources.fetch(parallax);
      if (!fetched) continue;
      try {
        const header = parseSwordParallax(fetched.bytes, resources.bigEndian);
        addPicture(parallax, 'parallax', header.width, header.height, 1);
      } catch {
        // Not a parallax after all; the room table is wrong for this release,
        // which is a note rather than a failure.
      }
    }
    void screen;
  });

  // Sprites, which is what answers SCUMM's costume surface: every drawable a
  // compact can name, taken after the screens so a sprite never displaces a
  // background. A resource says it is a sprite in its own header type, so this
  // needs no table of ids — and the frame count comes from the frame table
  // rather than from anywhere that could disagree with it.
  for (const resource of resources.allIds()) {
    const fetched = resources.fetch(resource);
    if (!fetched) continue;
    if (readSwordHeader(fetched.bytes, resources.bigEndian).type !== 'Sprite') continue;
    const frames = sword1SpriteFrames(fetched.bytes, resources.bigEndian);
    if (frames.length === 0) continue;
    const width = Math.max(...frames.map((frame) => frame.header.width));
    const height = Math.max(...frames.map((frame) => frame.header.height));
    addPicture(resource, 'sprite', width, height, frames.length);
  }

  if (pictureSkipped > 0) {
    reasons.push(
      `${pictureSkipped} picture resources were left out to keep the project under ` +
        `${Math.round(PICTURE_BUDGET / (1024 * 1024))} MB; the editor asks for the game folder ` +
        `again to show them (ADR 0010's rule for a large import)`,
    );
  }

  // --- walk grids ---------------------------------------------------------
  /*
   * The bars a mega may not cross and the nodes it routes between, carried
   * whole rather than budgeted.
   *
   * Not in the picture budget, and the numbers are why: the demo's 62 floors
   * name 62 distinct grid resources and 9 of them are in this install, at
   * 5,656 bytes together. Against the 24 MB the pictures get, a cap would be
   * arithmetic nobody could ever hit — and unlike a picture, a missing walk
   * grid is not a blank panel but a screen the router silently walks through
   * walls on.
   *
   * The bars come back as segments. `swordWalkGrid.ts` derives the other seven
   * fields, and all nine of this demo's grids re-emit byte-identically from
   * that derivation — `npm run sweep:sword` counts it every run.
   */
  const walkGrids: Sword1ProjectWalkGrid[] = [];
  for (const [resource, use] of [...floorUses].sort((a, b) => a[0] - b[0])) {
    const fetched = resources.fetch(resource);
    if (!fetched) continue;
    const grid = parseSword1WalkGrid(fetched.bytes, resources.bigEndian);
    if (!grid) {
      reasons.push(
        `walk grid ${resource.toString(16)} is ${fetched.bytes.length} bytes, which is not as ` +
          `long as the bars and nodes its own counts declare, so it was left out rather than ` +
          `read past its end`,
      );
      continue;
    }
    walkGrids.push({
      resource,
      screens: [...use.screens].sort((first, second) => first - second),
      floors: [...use.floors].sort((first, second) => first - second),
      scaleA: grid.scaleA,
      scaleB: grid.scaleB,
      headerBase64: toBase64(fetched.bytes.subarray(0, SWORD1_HEADER_SIZE)),
      bars: grid.bars,
      nodes: grid.nodes,
    });
  }

  // --- animation tables ---------------------------------------------------
  /*
   * The frame order a script names, so a preview can play what the game plays.
   *
   * A sprite resource carries frames and no order and no rate; the script's
   * `fnAnim(cdt, spr)` supplies both — the `cdt` table is the order, and the
   * driver walks it one entry a game cycle. So the tables the demo's scripts
   * *name as literals* come in here, together with the eight-entry direction
   * sets `fnAnim(cdt, 0)` resolves through. Nothing is followed from a
   * variable: that number is decided at run time (commit `0600015`'s rule),
   * and reading a resource by it would show an animation belonging to some
   * other sprite entirely.
   *
   * Not budgeted, for the same arithmetic the walk grids give: only the frame
   * column is kept, and the demo's tables cost a few tens of kilobytes against
   * the pictures' 24 MB.
   */
  const animTables: Sword1ProjectAnimTable[] = [];
  const animSets: Sword1ProjectAnimSet[] = [];
  const seenTable = new Set<number>();
  const seenSet = new Set<number>();

  const readAnimTable = (resource: number): Sword1ProjectAnimTable | null => {
    const fetched = resources.fetch(resource);
    if (!fetched) return null;
    const bytes = fetched.payload;
    if (bytes.length < 4) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = !resources.bigEndian;
    const count = view.getUint32(0, little);
    // 12 bytes an entry, the third word being the frame. A declared count the
    // resource is not long enough for is a table this does not carry, rather
    // than one it reads past the end of.
    if (count === 0 || 4 + count * 12 > bytes.length) return null;
    const frames: number[] = [];
    for (let index = 0; index < count; index++)
      frames.push(view.getInt32(4 + index * 12 + 8, little));
    return { resource, frames };
  };

  const readAnimSet = (resource: number): Sword1ProjectAnimSet | null => {
    const fetched = resources.fetch(resource);
    if (!fetched) return null;
    const bytes = fetched.payload;
    if (bytes.length < 8 * 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const little = !resources.bigEndian;
    const entries: { table: number; sprite: number }[] = [];
    for (let direction = 0; direction < 8; direction++) {
      entries.push({
        table: view.getUint32(direction * 8, little),
        sprite: view.getUint32(direction * 8 + 4, little),
      });
    }
    return { resource, entries };
  };

  const takeTable = (resource: number): void => {
    if (!resource || seenTable.has(resource)) return;
    seenTable.add(resource);
    const table = readAnimTable(resource);
    if (table) animTables.push(table);
  };

  for (const script of scripts) {
    for (const call of sword1Calls(script.instructions, script.entries)) {
      const player = SWORD1_PLAY_CALLS[call.name];
      if (!player) continue;
      const cdt = call.arguments[player.cdt];
      const spr = call.arguments[player.spr];
      if (!cdt || !spr || cdt.push !== 'number' || spr.push !== 'number') continue;
      if (cdt.value === 0) continue;
      if (spr.value !== 0) {
        takeTable(cdt.value);
        continue;
      }
      // `cdt && !spr`: a direction set, which is eight tables and eight
      // sprites. Every one of them is carried, because the direction that
      // picks between them is a run-time fact.
      if (seenSet.has(cdt.value)) continue;
      seenSet.add(cdt.value);
      const set = readAnimSet(cdt.value);
      if (!set) continue;
      animSets.push(set);
      for (const entry of set.entries) takeTable(entry.table);
    }
  }

  /*
   * --- room definitions, and where they are read from ---------------------
   *
   * The install's own executable when it has one, and the built-in table only
   * when it has not. The two are not the same table: the demo's `SWORD.EXE`
   * disagrees with the built-in one on six of its hundred screens, because its
   * clusters number those screens' resources differently. Reading the built-in
   * one regardless would show an author a screen this install does not have,
   * and — now that an export writes the table back — would make an export that
   * edited nothing rewrite six screens.
   */
  const holder = executables.find((executable) => executable.rooms !== null) ?? null;
  const table = holder?.rooms?.rooms ?? SWORD1_ROOMS;
  const rooms: Sword1ProjectRoom[] = table
    .map((room, screen) => ({
      screen,
      width: room.sizeX,
      height: room.sizeY,
      totalLayers: room.totalLayers,
      gridWidth: room.gridWidth,
      layers: [...room.layers],
      grids: [...room.grids],
      palettes: [...room.palettes],
      parallax: [...room.parallax],
    }))
    .filter((room) => room.width > 0);

  /*
   * --- start positions ----------------------------------------------------
   *
   * Only from an executable, and there is no built-in fallback on purpose. A
   * placement is addressed by its *ordinal in the file being written*, so a
   * list carrying ordinals no file gave out would be a list of edits with
   * nowhere to go. A folder with no executable simply has no start positions
   * to show, which is the truth about that folder.
   */
  const placer = executables.find((executable) => executable.starts !== null) ?? null;
  const startPositions: Sword1ProjectStartPosition[] = (placer?.starts?.placements ?? []).map(
    (placement) => ({
      index: placement.index,
      place: placement.place,
      x: placement.x,
      y: placement.y,
      direction: placement.direction,
    }),
  );

  /*
   * --- what each surface's standing is, for *this* folder -----------------
   *
   * The one surface whose standing is not a property of the project format but
   * of what the folder shipped. An executable makes the room table writable
   * and brings a start-position surface with it; clusters alone leave the room
   * table where it was.
   */
  const surfaces: Record<string, Sword1SurfaceKind> = { ...SWORD1_SURFACES };
  if (holder !== null) surfaces.rooms = 'editable';
  if (placer !== null) surfaces.startPositions = 'editable';

  // --- effects ------------------------------------------------------------
  const effects: Sword1ProjectEffect[] = SWORD1_FX.map((fx, fxNo) => ({
    fxNo,
    sample: sword1SampleId(fxNo, detection.release === 'demo'),
    type: fx.type,
    delay: fx.delay,
    rooms: fx.rooms.map((entry) => ({ ...entry })),
  })).filter((effect) => effect.sample !== null);

  const editable = scripts.length > 0 || sections.length > 0 || text.length > 0;
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
    surfaces,
    sections,
    scripts,
    text,
    palettes,
    pictures,
    rooms,
    ...(placer === null ? {} : { startPositions }),
    ...(holder === null && placer === null
      ? {}
      : {
          interpreter: {
            rooms: holder?.file ?? null,
            startPositions: placer?.file ?? null,
          },
        }),
    walkGrids,
    animTables,
    animSets,
    effects,
    clusters: {
      present: resources.availableClusters,
      absent: resources.absentClusters,
      labels: resources.clusterLabels,
    },
  };
}

/** A one-line summary of what a project holds, for the editor's notes. */
export function describeSword1Project(project: Sword1Project): string[] {
  const scriptInstructions = project.scripts.reduce(
    (total, script) => total + script.instructions.length,
    0,
  );
  const compacts = project.sections.reduce((total, section) => total + section.compacts.length, 0);
  const lines = project.text.reduce((total, entry) => total + entry.lines.length, 0);
  const languages = [...new Set(project.text.map((entry) => entry.language))];
  return [
    `Broken Sword (${project.identification.release} release) — ${project.identification.evidence}`,
    `${project.scripts.length} script modules, ${scriptInstructions} instructions, ` +
      `${project.scripts.filter((script) => script.roundTrips).length} of ` +
      `${project.scripts.length} re-emitting byte-identically`,
    `${project.sections.length} sections, ${compacts} compacts — Preserved words with named ` +
      `fields the bytecode itself addresses by offset`,
    `${lines} text lines across ${languages.length} languages (${languages.join(', ') || 'none'})`,
    `${project.palettes.length} palettes, ${project.pictures.length} pictures ` +
      `(editable: this project decodes Broken Sword's sprite compressions and writes all of ` +
      `them back)`,
    `${project.rooms.length} room definitions — editable here and not writable back, because ` +
      `the room table lived in Revolution's interpreter rather than in the game's files`,
    `${(project.walkGrids ?? []).length} walk grids — ` +
      `${(project.walkGrids ?? []).reduce((total, grid) => total + grid.bars.length, 0)} bars and ` +
      `${(project.walkGrids ?? []).reduce((total, grid) => total + grid.nodes.length, 0)} nodes, ` +
      `editable and written back`,
    `${project.effects.length} sound effects`,
    project.editable.unrecovered === 0
      ? 'Unrecovered 0: every script word decoded to an instruction'
      : `Unrecovered ${project.editable.unrecovered} script words`,
  ];
}
