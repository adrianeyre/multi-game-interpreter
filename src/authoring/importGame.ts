import {
  Costume,
  celToRowMajor,
  costumeDecodeData,
  createCostumeData,
  decodeCel,
  getLimbCel,
  increaseAnims,
} from '../engine/gfx/Costume.js';
import { RoomGraphics, findObjectImage } from '../engine/gfx/RoomGraphics.js';
import { Room, type RoomObject, type WalkBox } from '../engine/room/Room.js';
import type { Action } from './actions.js';
import { isPlayableFormat, storeAudio, type ProjectAudio } from './audio.js';
import { toBase64 } from './base64.js';
import { decompileScript, type ScriptDialect } from './decompile.js';
import { SCUMM_VERSION_TARGETS } from './target.js';
import {
  CHUNK_HEADER_SIZE,
  SMALL_CHUNK_HEADER_SIZE,
  readChunkHeader,
} from '../engine/resource/Chunk.js';
import type { ResourceManager } from '../engine/resource/ResourceManager.js';
import { rectangleBox, type BoxDefinition } from './GameBuilder.js';
import type { IndexedImage } from './ImageEncoder.js';
import { storeImage } from './imageCodec.js';
import { paletteFromClut } from './palette.js';
import {
  ACTOR_ID_LIMIT,
  createProject,
  visibleRoomRows,
  type ImportedScript,
  type Project,
  type ProjectActor,
  type ProjectHandler,
  type ProjectObject,
  type ProjectRoom,
  POSE_DIRECTIONS,
  poseHasArt,
  type SpriteCel,
  type SpritePose,
} from './project.js';

/**
 * Turns a loaded game back into an editable project.
 *
 * The compiler in `projectToGame` runs the other way, and the two are not
 * symmetric: a project holds intent (an object with verb handlers, a box with a
 * scale ramp) while a compiled game holds bytes. Art, geometry and object
 * layout survive the round trip because they are data either way. Behaviour
 * does not — scripts are bytecode here and structured actions there — so
 * scripts come back as bytes to read rather than actions to edit, and that
 * asymmetry is deliberate rather than unfinished.
 *
 * Everything happens in memory from resources the player already loaded. No
 * file is written and nothing leaves the browser.
 */

export interface ImportOptions {
  /** Rooms to import. Every room in the game by default. */
  rooms?: number[];
  /** Called between rooms so a large game can show progress. */
  onProgress?: (done: number, total: number, what: string) => void;
  /** Costumes to bring in as editable actors, capped by the actor id range. */
  maxActors?: number;
}

export interface ImportResult {
  project: Project;
  /** What could not be brought across, in the author's terms. */
  notes: string[];
}

/**
 * Gives every imported object an id the project format allows.
 *
 * Published games number objects from 1, but a project reserves everything
 * below `ACTOR_ID_LIMIT` for actors — the sentence script has only a number to
 * work with and tells the two apart arithmetically. An imported object with a
 * low id therefore has to move, or the project cannot be compiled or played at
 * all. Ids that are already legal and unused are left exactly as they are, so
 * most objects keep the number they have in the original game.
 */
export interface ObjectIdAllocator {
  assign(originalId: number): number;
  readonly renumbered: Array<{ from: number; to: number }>;
}

export function createObjectIdAllocator(): ObjectIdAllocator {
  const used = new Set<number>();
  const renumbered: Array<{ from: number; to: number }> = [];
  let next = ACTOR_ID_LIMIT;

  return {
    renumbered,
    assign(originalId: number): number {
      if (originalId >= ACTOR_ID_LIMIT && !used.has(originalId)) {
        used.add(originalId);
        return originalId;
      }
      while (used.has(next)) next++;
      const assigned = next;
      used.add(assigned);
      renumbered.push({ from: originalId, to: assigned });
      return assigned;
    },
  };
}

/** Old-style SCUMM directions, in the order `oldDirToNewDir` maps them. */
const FACINGS = ['west', 'east', 'south', 'north'] as const;

export function importGame(resources: ResourceManager, options: ImportOptions = {}): ImportResult {
  const notes: string[] = [];
  const gameName = resources.game.id;
  const project = createProject(gameName);

  // An imported game's project targets the version it came from: its preserved
  // scripts are that version's instructions, and there is no converting them
  // (ADR 0004).
  //
  // Each version named, not clamped with `>=`. A clamp is how a later version
  // acquires an earlier one's tag: `>= 6 ? 6 : 5` made a v7 import a v6 project
  // holding v7 bytecode, which no assembler could re-emit.
  const version = resources.game.version;
  project.target = {
    engine: 'scumm',
    version: SCUMM_VERSION_TARGETS.find((candidate) => candidate === version) ?? 5,
    // Carried from detection rather than assumed. ADR 0013's rule turns on it:
    // a Version reached by guess plays and is refused for editing, and that
    // cannot be worked out again later from the answer alone.
    identification: resources.game.identification,
  };

  const roomIds = options.rooms ?? resources.listRooms();
  const total = roomIds.length;
  let done = 0;

  let inheritedPalette: number[][] | undefined;
  const ids = createObjectIdAllocator();
  const floorsAdded: number[] = [];

  for (const id of roomIds) {
    options.onProgress?.(done, total, `room ${id}`);
    done++;

    try {
      const before = resources.getRoom(id)
        ? new Room(id, resources.getRoom(id)!, resources.game.version, resources.roomSources(id))
            .boxes.length
        : 0;
      const room = importRoom(resources, id, inheritedPalette, ids);
      if (room) {
        if (room.palette) inheritedPalette = room.palette;
        if (before === 0) floorsAdded.push(id);
        project.rooms.push(room);
      } else notes.push(`Room ${id} has no image data and was skipped`);
    } catch (error) {
      notes.push(`Room ${id} could not be read: ${describe(error)}`);
    }
  }

  const { audio, notes: audioNotes } = importSounds(resources);
  project.audio = audio;
  notes.push(...audioNotes);

  const {
    actors,
    imported: importedCostumes,
    carried,
    notes: costumeNotes,
  } = importCostumes(resources, options.maxActors ?? ACTOR_ID_LIMIT - 1);
  if (actors.length > 0) project.actors = actors;
  if (carried.length > 0) project.costumes = carried;
  notes.push(...costumeNotes);

  project.start = {
    room: project.rooms[0]?.id ?? 1,
    x: 160,
    y: 100,
  };

  project.imported = {
    game: gameName,
    importedAt: Date.now(),
    scripts: collectScripts(resources, roomIds),
    costumes: importedCostumes,
    renumberedObjects: ids.renumbered,
  };

  if (ids.renumbered.length > 0) {
    notes.push(
      `${ids.renumbered.length} objects were renumbered because ids below ` +
        `${ACTOR_ID_LIMIT} belong to actors in a project (for example ` +
        `${ids.renumbered[0].from} became ${ids.renumbered[0].to}).`,
    );
  }

  // The Unrecovered count, per game, as `CONTEXT.md` asks for it: a resource
  // that could not be read into editable structure is a defect with a target of
  // zero, not an escape hatch, so the number is stated at import rather than
  // left to be noticed. AGI has shown this in the editor since ADR 0013; SCUMM
  // had nowhere to show it because until now every Classic script was one.
  const unrecovered = countUnrecovered(project);
  notes.push(
    unrecovered.total === 0
      ? `All ${unrecovered.scripts} scripts read into instructions; Unrecovered is 0.`
      : `${unrecovered.total} of ${unrecovered.scripts} scripts could not be read all ` +
          `the way through and are held as they arrived. Their bytes are unchanged ` +
          `and the game still plays them; they cannot be edited instruction by ` +
          `instruction.`,
  );
  if (floorsAdded.length > 0) {
    notes.push(
      `Rooms ${floorsAdded.join(', ')} had no walk boxes, which a project cannot ` +
        `compile, so each was given one across the bottom. Delete it if the room ` +
        `is not meant to be walked in.`,
    );
  }

  if (project.imported.scripts.length > 0) {
    notes.push(
      `${project.imported.scripts.length} scripts were imported as bytecode to read. ` +
        `The editor stores behaviour as actions, which bytecode cannot be turned ` +
        `back into, so they are not editable.`,
    );
  }

  return { project, notes };
}

// ------------------------------------------------------------------ rooms ---

export function importRoom(
  resources: ResourceManager,
  id: number,
  inherited?: number[][],
  ids: ObjectIdAllocator = createObjectIdAllocator(),
): ProjectRoom | null {
  const resource = resources.getRoom(id);
  if (!resource) return null;

  const parsed = new Room(id, resource, resources.game.version, resources.roomSources(id));
  if (parsed.width <= 0 || parsed.height <= 0) return null;

  const dialect = dialectOf(resources);

  const graphics = new RoomGraphics(
    parsed.width,
    parsed.height,
    parsed.numZPlanes,
    parsed.transparentColor,
  );
  if (parsed.backgroundOffset >= 0) decodeRoomBackground(graphics, parsed);

  // A room without its own table keeps the previous room's, exactly as the
  // engine does at runtime — so an imported room is drawn in the colours it
  // would have had on screen, not in the editor's defaults.
  const palette = parsed.palette ? paletteFromClut(parsed.palette) : inherited;

  return {
    id,
    name: resources.roomNames.get(id) || `Room ${id}`,
    width: parsed.width,
    height: parsed.height,
    palette,
    background: storeImage({
      width: parsed.width,
      height: parsed.height,
      pixels: graphics.background,
    }),
    // Only where the picture is one block that can be swapped for another,
    // which is the pre-v5 layouts. `ArtOrigin` says why v5 and later are left
    // out rather than recorded and quietly unusable.
    ...(parsed.version < 5 && parsed.backgroundOffset >= 0
      ? {
          artOrigin: {
            room: parsed.number,
            chunkOffset: parsed.backgroundOffset,
            sixteenColour: sixteenColour(parsed),
          },
        }
      : {}),
    zPlanes: graphics.zPlanes.map((plane) => storeImage(unpackZPlane(plane, graphics))),
    boxes: importBoxes(parsed),
    objects: parsed.objects.map((object) => importObject(parsed, object, ids, resources)),
    // The room's own behaviour, preserved rather than dropped. It arrives as
    // the game's bytecode with a reading of it, so a room that ran a script on
    // entry still runs it — and an author can see what it does.
    onEnter: scriptActions(parsed, parsed.scripts.entry, `Room ${id} entry script`, dialect),
    onExit: scriptActions(parsed, parsed.scripts.exit, `Room ${id} exit script`, dialect),
    // The room's own scripts, which its entry script starts by number. Left
    // behind, the entry script ran, asked for script 200, found nothing, and
    // the scene it was supposed to set up never happened.
    localScripts: [...parsed.scripts.local.entries()]
      .sort(([a], [b]) => a - b)
      .map(([scriptId, block]) => ({
        id: scriptId,
        name: `Room ${id} script ${scriptId}`,
        actions: scriptActions(
          parsed,
          block,
          `Room ${id} local script ${scriptId}`,
          dialect,
          // LSCR's payload starts with the script's own number.
          1,
        ),
      }))
      .filter((script) => script.actions.length > 0),
  };
}

/** A script's actions, or an empty list where the room had no script. */
function scriptActions(
  room: Room,
  block: { offset: number; length: number } | null,
  label: string,
  dialect: ScriptDialect,
  /** Bytes of the chunk's payload that come before the code — `LSCR`'s id. */
  prefix = 0,
): Action[] {
  if (!block || block.length <= 0) return [];
  // A v8 room's code is in its `RMSC` block rather than in `ROOM`, and
  // `scriptData` is that block where there is one.
  const source = room.scriptData;
  const end = Math.min(block.offset + block.length, source.length);
  if (end <= block.offset) return [];

  const actions = decompileScript(source.subarray(block.offset, end), label, dialect).actions;

  // Where this script sits in the room resource, so an edit can be written
  // back to it. The header is eight bytes from v5 on and six before it — a
  // four character tag and a big-endian size against a little-endian size and
  // a two character one — and anything the payload carries before the code
  // comes after that. Two bytes, and getting them wrong writes an edited
  // script over the tail of the block header in front of it.
  const headerSize = room.version >= 5 ? CHUNK_HEADER_SIZE : SMALL_CHUNK_HEADER_SIZE;
  const chunkOffset = block.offset - prefix - headerSize;
  for (const action of actions) {
    if (action.type === 'raw') action.origin = { room: room.number, chunkOffset, prefix };
  }
  return actions;
}

/**
 * How many of a project's preserved scripts were read short.
 *
 * Counted from the notes the reader left rather than by reading everything
 * again: `decompileScript` marks a partial read on the Action it produces, so
 * the count is already in the project by the time it is asked for.
 */
function countUnrecovered(project: Project): { scripts: number; total: number } {
  let scripts = 0;
  let total = 0;

  const walk = (actions: Action[] | undefined): void => {
    if (!actions) return;
    for (const action of actions) {
      if (action.type !== 'raw') continue;
      scripts++;
      if (action.note?.includes('Read as far as it could be followed')) total++;
    }
  };

  for (const room of project.rooms) {
    walk(room.onEnter);
    walk(room.onExit);
    for (const script of room.localScripts ?? []) walk(script.actions);
    for (const object of room.objects) {
      for (const handler of object.handlers ?? []) walk(handler.actions);
    }
  }
  for (const script of project.scripts ?? []) walk(script.actions);

  return { scripts, total };
}

/**
 * Which reader this game's scripts need.
 *
 * The bytes of a v6 script mean nothing to the v5 reader and the reverse, so
 * this is not a nicety: reading a v6 script as v5 produces a listing that is
 * confidently wrong for its whole length.
 */
function dialectOf(resources: ResourceManager): ScriptDialect {
  const version = resources.game.version;
  // Every supported Version is its own dialect now. It used to collapse to
  // "5 or 6", which was right while v5 was the only Classic Version and wrong
  // for v7 the moment v7 arrived: a v7 script read with the v6 reader measures
  // every inline message by v6's rule, which is a different length.
  if (version >= 2 && version <= 8) return version as ScriptDialect;
  return 5;
}

/**
 * Expands a 1-bit-per-pixel z-plane into one byte per pixel.
 *
 * The engine packs masks by strip because that is how the format stores them
 * and how it draws them; the editor paints them as images like everything else.
 */
function unpackZPlane(plane: Uint8Array, graphics: RoomGraphics): IndexedImage {
  const pixels = new Uint8Array(graphics.width * graphics.height);
  for (let y = 0; y < graphics.height; y++) {
    for (let x = 0; x < graphics.width; x++) {
      const byte = plane[y * graphics.strips + (x >> 3)];
      pixels[y * graphics.width + x] = byte & (0x80 >> (x & 7)) ? 1 : 0;
    }
  }
  return { width: graphics.width, height: graphics.height, pixels };
}

/**
 * Whether this room's pixels index sixteen colours or 256.
 *
 * Read off the count the room's own palette carries rather than off the
 * Version or the title: the two eras of v4 release ship the same containers
 * and differ here, and the palette says which it is in its first two bytes.
 * The engine decides it the same way, and the two must agree or an imported
 * room is decoded with a table of the wrong width.
 */
function sixteenColour(room: Room): boolean {
  return room.paletteColours > 0 && room.paletteColours <= 16;
}

/**
 * A room's background, decoded through the codec its Version actually uses.
 *
 * v5 wraps its image in `RMIM`, `IM00` and `SMAP`; v2 to v4 have none of
 * those and `BM` is the strip table itself. Importing a pre-v5 room through
 * the v5 reader finds no chunk, draws nothing, and produces a project whose
 * every room is blank — which reads as a game with no artwork rather than as
 * an importer using the wrong door.
 */
function decodeRoomBackground(graphics: RoomGraphics, room: Room): void {
  if (room.version < 5) {
    graphics.decodeSmallImage(
      room.data,
      // `BM`'s payload is the strip table, straight after its header.
      room.backgroundOffset + SMALL_CHUNK_HEADER_SIZE,
      0,
      0,
      room.width,
      room.height,
      sixteenColour(room),
    );
    return;
  }

  graphics.decodeImage(room.data, room.backgroundOffset, 0, 0, room.width, room.height, true);
}

/**
 * A walk box, with its scale expressed the way the editor understands it.
 *
 * A scale with bit 15 set names one of the room's scale slots rather than a
 * size. The editor has room-wide perspective instead of slots, so such a box is
 * marked as following the perspective and the slot number is dropped — the
 * shape and routing are what matter for editing, and a wrong fixed scale would
 * be worse than none.
 */
/**
 * A room's walk boxes, with a floor added when it has none.
 *
 * A room with no boxes is legal in a published game — a title card has nothing
 * to walk on — but a project with one cannot be compiled, so importing a game
 * that has any such room would produce something that never plays. A single
 * box across the bottom is visible, obviously editable, and easily deleted,
 * which a silent failure to compile is not.
 */
function importBoxes(room: Room): BoxDefinition[] {
  if (room.boxes.length > 0) return room.boxes.map(importBox);

  // Across the bottom of what can be *seen*, not of the room. A published room
  // is often the full 200 rows tall while the view shows only its top 128 — the
  // rows between the text band and the verb panel — so a floor at the room's
  // own bottom is a floor behind the verbs, and an actor standing on it is
  // clipped away entirely rather than merely low.
  const bottom = Math.max(1, Math.min(room.height, visibleRoomRows()));
  const top = Math.max(0, bottom - 24);
  return [rectangleBox(0, top, room.width, bottom - top, { scale: 255 })];
}

function importBox(box: WalkBox): BoxDefinition {
  const usesSlot = (box.scale & 0x8000) !== 0;
  return {
    ul: { x: box.ulx, y: box.uly },
    ur: { x: box.urx, y: box.ury },
    lr: { x: box.lrx, y: box.lry },
    ll: { x: box.llx, y: box.lly },
    ...(usesSlot ? { perspective: true } : { scale: box.scale || 255 }),
    mask: box.mask,
    blocked: (box.flags & 0x80) !== 0,
  };
}

function importObject(
  room: Room,
  object: RoomObject,
  ids: ObjectIdAllocator,
  resources: ResourceManager,
): ProjectObject {
  return {
    id: ids.assign(object.id),
    name: object.name || `Object ${object.id}`,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    walkTo: { x: object.walkX, y: object.walkY },
    facing: FACINGS[object.actorDir & 3],
    initialState: initialStateOf(resources, object.id),
    classes: [],
    states: importObjectStates(room, object),
    ...(room.version < 5 && object.image
      ? {
          artOrigin: {
            room: room.number,
            chunkOffset: object.image.obimOffset,
            sixteenColour: sixteenColour(room),
          },
        }
      : {}),
    handlers: importVerbs(room, object, dialectOf(resources)),
    otherwise: [],
  };
}

/**
 * Which state an object starts in, which the room does not say.
 *
 * A room resource carries an object's artwork, one image per state, and says
 * nothing about which of them is showing — that lives in the index's global
 * object table alongside the ownership. `Room` fills its own `state` in from
 * that table when the room is entered and leaves it zero until then, so an
 * import that read it off the parsed room recorded every object as state 0:
 * the one state that is deliberately never drawn, and never a hotspot either.
 * The result was an imported room that drew its background and nothing else,
 * and could not be clicked.
 *
 * An object the table does not reach falls back to state 1 rather than 0, on
 * the same reasoning the compiler uses for an authored object: there is
 * artwork, so something is meant to be seen.
 */
function initialStateOf(resources: ResourceManager, originalId: number): number {
  const state = resources.objectState[originalId];
  return state === undefined ? 1 : state;
}

/**
 * An object's verb scripts, each preserved as the game's own bytecode.
 *
 * This is the behaviour an author most wants to see: what happens when the
 * player looks at, opens or picks up a thing. It was previously lost entirely,
 * leaving an imported game full of objects that did nothing.
 */
function importVerbs(room: Room, object: RoomObject, dialect: ScriptDialect): ProjectHandler[] {
  if (object.verbCodeBase < 0 || object.verbs.size === 0) return [];

  // The table's offsets are counted from the `VERB` chunk's own first byte,
  // which is what the engine resolves them against before running one.
  const entries = [...object.verbs.entries()].map(([verbId, relative]) => ({
    verbId,
    start: object.verbCodeBase + relative,
  }));

  // Sorted by where the code sits, not by verb number: one script ends where
  // the next begins, and that is a fact about the layout rather than about the
  // verbs. Sorting by id would slice at the wrong places.
  entries.sort((a, b) => a.start - b.start);

  let blockEnd = room.data.length;
  try {
    const chunk = readChunkHeader(room.data, object.obcdOffset);
    if (chunk.size > 0) blockEnd = Math.min(blockEnd, object.obcdOffset + chunk.size);
  } catch {
    // A malformed header leaves the end of the room as the bound, which is
    // wide rather than wrong: the script stops itself at `stopObjectCode`.
  }

  const handlers: ProjectHandler[] = [];
  for (const [index, entry] of entries.entries()) {
    const end = index + 1 < entries.length ? entries[index + 1].start : blockEnd;
    if (entry.start < 0 || end <= entry.start || entry.start >= room.data.length) continue;

    const code = room.data.subarray(entry.start, Math.min(end, room.data.length));
    if (code.length === 0) continue;

    handlers.push({
      verbId: entry.verbId,
      actions: decompileScript(code, `Object ${object.id}, verb ${entry.verbId}`, dialect).actions,
    });
  }

  // Back into verb order for the editor, which lists them by verb.
  return handlers.sort((a, b) => a.verbId - b.verbId);
}

/**
 * One image per state the object ships art for.
 *
 * Decoded into a buffer the size of the object rather than the room, so the
 * editor gets a sprite it can place rather than a room-sized image that is
 * almost entirely empty.
 */
function importObjectStates(room: Room, object: RoomObject): ReturnType<typeof storeImage>[] {
  const image = object.image;
  if (!image || object.width <= 0 || object.height <= 0) return [];

  const small = room.version < 5;
  const states: ReturnType<typeof storeImage>[] = [];
  const count = Math.max(1, image.imageOffsets.length);

  for (let state = 1; state <= count; state++) {
    const offset = findObjectImage(room.data, image.obimOffset, state, small);
    if (offset === null) continue;

    const canvas = new RoomGraphics(object.width, object.height, 0, room.transparentColor);
    try {
      // A pre-v5 object picture is the same strip table its room's background
      // is, with no `SMAP` and no `IMxx` around it — so the v5 reader finds no
      // chunk and draws nothing, and every object in the game is simply
      // absent. The same fault Loom CD had on screen, on the import side of
      // the same wall.
      if (small) {
        canvas.decodeSmallImage(
          room.data,
          offset,
          0,
          0,
          object.width,
          object.height,
          sixteenColour(room),
        );
      } else {
        canvas.decodeImage(room.data, offset, 0, 0, object.width, object.height, true);
      }
    } catch {
      continue;
    }
    states.push(
      storeImage({ width: object.width, height: object.height, pixels: canvas.background }),
    );
  }
  return states;
}

// --------------------------------------------------------------- costumes ---

interface CostumeImport {
  actors: ProjectActor[];
  imported: Array<{ id: number; poses: number; limbs: number }>;
  /** Costumes carried through as the published game's own bytes. */
  carried: Array<{ id: number; bytes: string }>;
  notes: string[];
}

/**
 * Costumes, as far as the editor's actor model reaches.
 *
 * Actor ids stop at `ACTOR_ID_LIMIT` because the sentence script has to tell
 * actors from objects arithmetically, so a game with more costumes than that
 * cannot have all of them as editable actors. The rest are still listed, with
 * their shape, so nothing silently disappears.
 */
function importCostumes(resources: ResourceManager, maxActors: number): CostumeImport {
  const actors: ProjectActor[] = [];
  const imported: Array<{ id: number; poses: number; limbs: number }> = [];
  const carried: Array<{ id: number; bytes: string }> = [];
  const notes: string[] = [];

  const available = resources.listCostumes();
  for (const id of available) {
    const resource = resources.getCostume(id);
    if (!resource) continue;

    let costume: Costume;
    try {
      costume = new Costume(id, resource, resources.game.version);
    } catch {
      continue;
    }

    const poses = importPoses(costume);
    const drawn = poses.filter(poseHasArt).length;
    imported.push({ id, poses: drawn, limbs: costume.numAnim });

    // Beyond the actor cap, or with nothing to draw as a pose: kept as the
    // bytes the game shipped. Those bytes are already the format the
    // interpreter reads, so copying them through is exact, small, and means a
    // script that dresses an actor in costume 94 finds costume 94. What it
    // does not give is an editable sprite, which is the same trade the import
    // already makes for scripts.
    if (drawn === 0 || actors.length >= maxActors) {
      carried.push({ id, bytes: toBase64(resource) });
      continue;
    }

    if (drawn > 0 && actors.length < maxActors) {
      actors.push({
        id: actors.length + 1,
        name: `Costume ${id}`,
        talkColor: 11,
        walkSpeed: { x: 5, y: 2 },
        // The published game's own number, kept. Actor ids have to be
        // renumbered — a project's stop at ACTOR_ID_LIMIT — but costume ids do
        // not, and the imported scripts change costumes by number. Numbering
        // these sequentially left every such script dressing an actor in a
        // costume the compiled game had never heard of: the actor stood in the
        // right place, on a walk box, and was never drawn.
        costumeId: id,
        // Costume colour 0 is the transparent slot, and the project's list
        // starts at colour 1 — the compiler puts the 0 back. Copying the table
        // whole shifted every colour by one, which is why imported sprites
        // came out in somebody else's clothes.
        palette: [...costume.palette.subarray(1)],
        poses,
        handlers: [],
        otherwise: [],
      });
    }
  }

  if (carried.length > 0) {
    notes.push(
      `${imported.length} costumes were found and ${actors.length} became editable actors ` +
        `(ids stop at ${ACTOR_ID_LIMIT - 1}). The other ${carried.length} are carried ` +
        `through exactly as the game shipped them, so the scripts that wear them still ` +
        `work — but they cannot be edited.`,
    );
  }
  return { actors, imported, carried, notes };
}

/** The animation that places every limb, which each pose is drawn on top of. */
const INIT_FRAME = 1;

/** How many animation steps of a pose to capture before calling it a loop. */
const MAX_CELS_PER_POSE = 8;

/**
 * Walks a costume's animations the way the renderer does, one step at a time.
 *
 * Reusing the runtime path rather than re-reading the tables means the imported
 * sprite is what the engine actually draws, including the cel ordering that
 * makes a walk cycle read as walking.
 */
export function importPoses(costume: Costume): SpritePose[] {
  const poses: SpritePose[] = [];
  // Animations are numbered `direction + frame * 4` and the engine accepts an
  // index up to and including numAnim, so the highest usable frame is
  // numAnim / 4 — and a loop bound has to be one past it. Stopping short drops
  // the last frame, which for a full costume is the standing pose: the one the
  // engine draws whenever the character is not doing anything, so the
  // character was invisible in play while looking fine in the sprite editor.
  const frames = Math.max(1, Math.floor(costume.numAnim / 4) + 1);

  for (let frame = 0; frame < frames; frame++) {
    const pose: SpritePose = {};

    // Every direction, not just the one facing the camera. A costume stores a
    // separate animation per direction — a character walking away is drawn
    // from behind, not mirrored — so importing one facing and reusing it for
    // the rest gives a character who moons the camera the whole way round the
    // room. Only the facings that differ are kept, below.
    for (const direction of POSE_DIRECTIONS) {
      const cels = importFacing(costume, frame, DIRECTION_ANGLE[direction]);
      if (cels.length > 0) pose[direction] = cels;
    }

    // A costume whose four directions are the same artwork — common for
    // objects and for simple characters — collapses to one shared list, which
    // is both smaller and what the sprite editor should show.
    const identical = POSE_DIRECTIONS.every((direction) =>
      sameCels(pose[direction], pose[POSE_DIRECTIONS[0]]),
    );
    if (identical && pose[POSE_DIRECTIONS[0]]) {
      const shared = pose[POSE_DIRECTIONS[0]];
      for (const direction of POSE_DIRECTIONS) delete pose[direction];
      pose.all = shared;
    }

    poses[frame] = pose;
  }
  return poses;
}

/** The angle each direction is stored at, from the engine's own table. */
const DIRECTION_ANGLE: Record<(typeof POSE_DIRECTIONS)[number], number> = {
  west: 270,
  east: 90,
  south: 180,
  north: 0,
};

/** One pose, decoded facing one way. */
function importFacing(costume: Costume, frame: number, angle: number): SpriteCel[] {
  const cost = createCostumeData();
  // The init animation first, then the pose on top of it.
  //
  // A pose animation only touches the limbs it animates — walking moves the
  // legs and says nothing about the head — and the engine relies on the init
  // animation having placed the rest. Decoding a pose on its own leaves every
  // limb it does not mention empty, which is a character missing its head
  // rather than a character standing still.
  costumeDecodeData(costume, cost, angle, INIT_FRAME, 0xffff);
  if (frame !== INIT_FRAME) costumeDecodeData(costume, cost, angle, frame, 0xffff);

  const cels: SpriteCel[] = [];
  for (let step = 0; step < MAX_CELS_PER_POSE; step++) {
    const image = compositeLimbs(costume, cost);
    if (image) cels.push({ image: storeImage(image), hold: 6 });
    if (!increaseAnims(costume, cost)) break;
  }
  return cels;
}

/**
 * The largest a limb can be and still be a drawing.
 *
 * Generous on purpose: the screen is 320x200 and the widest room is a few
 * thousand pixels, so this is far past anything real while still orders of
 * magnitude below the values a misread cel produces. The offsets are bounded
 * too, since a plausible size at an implausible position gives the same
 * enormous bounding box.
 */
const MAX_CEL_EXTENT = 2048;

function isPlausibleCel(cel: {
  width: number;
  height: number;
  relX: number;
  relY: number;
}): boolean {
  return (
    cel.width <= MAX_CEL_EXTENT &&
    cel.height <= MAX_CEL_EXTENT &&
    Math.abs(cel.relX) <= MAX_CEL_EXTENT &&
    Math.abs(cel.relY) <= MAX_CEL_EXTENT
  );
}

/** Whether two facings ended up with byte-identical artwork. */
function sameCels(a: SpriteCel[] | undefined, b: SpriteCel[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every(
    (cel, index) =>
      cel.image.data === b[index].image.data &&
      cel.image.width === b[index].image.width &&
      cel.image.height === b[index].image.height,
  );
}

/** Draws every visible limb of the current pose into one image. */
function compositeLimbs(costume: Costume, cost: ReturnType<typeof createCostumeData>) {
  const parts: Array<{ x: number; y: number; width: number; height: number; pixels: Uint8Array }> =
    [];

  for (let limb = 0; limb < 16; limb++) {
    const cel = getLimbCel(costume, cost, limb);
    if (!cel || cel.width <= 0 || cel.height <= 0) continue;
    // A limb bigger than any sprite could be is misread data, not artwork, and
    // the importer is the only thing that would believe it: the renderer clips
    // a cel to the screen and never allocates one, while this composites every
    // limb into a single buffer sized by their bounding box. Two of Sam & Max's
    // costumes yield cels of 51579x5706 at offset 3072,4382 in poses the game
    // never asks for, and taking them at face value meant allocating half a
    // gigabyte and spending twenty seconds per costume filling it.
    if (!isPlausibleCel(cel)) continue;
    parts.push({
      x: cel.relX,
      y: cel.relY,
      width: cel.width,
      height: cel.height,
      // Cels decode column-major, which is what the renderer wants and the
      // opposite of what an image is.
      pixels: celToRowMajor(cel, decodeCel(costume, cel)),
    });
  }
  if (parts.length === 0) return null;

  const left = Math.min(...parts.map((part) => part.x));
  const top = Math.min(...parts.map((part) => part.y));
  const right = Math.max(...parts.map((part) => part.x + part.width));
  const bottom = Math.max(...parts.map((part) => part.y + part.height));

  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  const pixels = new Uint8Array(width * height);

  for (const part of parts) {
    for (let y = 0; y < part.height; y++) {
      for (let x = 0; x < part.width; x++) {
        const value = part.pixels[y * part.width + x];
        // Index 0 is the costume's transparent colour, so it must not overwrite
        // a limb drawn under this one.
        if (value === 0) continue;
        const destX = part.x - left + x;
        const destY = part.y - top + y;
        pixels[destY * width + destX] = value;
      }
    }
  }
  return { width, height, pixels };
}

// ---------------------------------------------------------------- scripts ---

/**
 * Every script in the game, as bytes.
 *
 * Read-only by nature: turning bytecode back into the editor's actions is a
 * decompiler, not an importer. Keeping the bytes means an author can at least
 * see what a room does, and compare it with what they build.
 */
/**
 * How much sound one import may carry.
 *
 * A project is a single JSON document that has to survive being autosaved,
 * exported and reopened, so audio cannot be allowed to grow without limit just
 * because a game shipped a lot of it. The cap is generous enough for the
 * effects of a v5 game and small enough that an import cannot produce a file
 * the browser refuses to store.
 */
const SOUND_IMPORT_BUDGET = 24 * 1024 * 1024;

/**
 * Lifts the game's sound resources into the project's audio library.
 *
 * Each keeps the id it had, because the game's own scripts refer to sounds by
 * number and a decompiled project's `playSound` actions have to keep meaning
 * the same sound. Digitised effects and AdLib music both play; a piece that
 * only ever had a Roland or PC speaker version comes across too, listed and
 * labelled with the reason it is silent, so that an author sees what the game
 * had rather than finding it missing.
 */
function importSounds(resources: ResourceManager): {
  audio: ProjectAudio[];
  notes: string[];
} {
  const audio: ProjectAudio[] = [];
  const notes: string[] = [];
  let sequenced = 0;
  let budget = SOUND_IMPORT_BUDGET;
  let skipped = 0;

  for (const id of resources.listSounds()) {
    // Sound 0 is the engine's "no sound": `startSound 0` is defined to do
    // nothing, so a track there could never be played and would only be a
    // confusing first row in the library.
    if (id === 0) continue;

    let bytes: Uint8Array | null;
    try {
      bytes = resources.getSound(id);
    } catch {
      // A sound that will not load is not a reason to abandon the import.
      continue;
    }
    if (!bytes || bytes.length === 0) continue;

    if (bytes.length > budget) {
      skipped++;
      continue;
    }
    budget -= bytes.length;

    const track = storeAudio(id, `sound ${id}`, bytes, `Sound ${id}`);
    if (!isPlayableFormat(track.format)) sequenced++;
    audio.push(track);
  }

  if (skipped > 0) {
    notes.push(
      `${skipped} sounds were left out because the project's audio would have ` +
        `exceeded ${Math.round(SOUND_IMPORT_BUDGET / (1024 * 1024))} MB. ` +
        `Import the ones you need as files.`,
    );
  }

  if (audio.length > 0) {
    notes.push(
      `${audio.length} sounds were imported, keeping their original numbers` +
        (sequenced > 0
          ? `. ${sequenced} of them hold neither a score nor digitised audio, ` +
            `so they are listed but have nothing to play.`
          : '.'),
    );
  }

  return { audio, notes };
}

function collectScripts(resources: ResourceManager, roomIds: number[]): ImportedScript[] {
  const scripts: ImportedScript[] = [];

  for (const id of resources.listScripts()) {
    const bytes = resources.getScript(id);
    if (bytes) scripts.push({ kind: 'global', id, size: bytes.length });
  }

  for (const roomId of roomIds) {
    const resource = resources.getRoom(roomId);
    if (!resource) continue;

    let room: Room;
    try {
      room = new Room(roomId, resource, resources.game.version, resources.roomSources(roomId));
    } catch {
      continue;
    }

    if (room.scripts.entry) {
      scripts.push({ kind: 'entry', id: roomId, room: roomId, size: room.scripts.entry.length });
    }
    if (room.scripts.exit) {
      scripts.push({ kind: 'exit', id: roomId, room: roomId, size: room.scripts.exit.length });
    }
    for (const [id, block] of room.scripts.local) {
      scripts.push({ kind: 'local', id, room: roomId, size: block.length });
    }
    for (const object of room.objects) {
      for (const verb of object.verbs.keys()) {
        scripts.push({ kind: 'object', id: object.id, room: roomId, verb, size: 0 });
      }
    }
  }
  return scripts;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
