import { readS16LE, readS32LE, readU16BE, readU16LE, readU32LE } from '../util/ByteStream.js';
import {
  CHUNK_HEADER_SIZE,
  SMALL_CHUNKS,
  chunkData,
  findChunk,
  findChunks,
  iterateChunks,
  readChunkHeader,
  readSmallChunkHeader,
} from '../resource/Chunk.js';
import type { Chunk } from '../resource/Chunk.js';
import type { ColorCycle } from '../gfx/Palette.js';
import { isImageStateTag } from '../gfx/RoomGraphics.js';

/**
 * The room's palettes, out of the v6 `PALS` block.
 *
 * v5 rooms carry one `CLUT` and that is the palette. v6 rooms can carry several
 * and switch between them, so the block is a container: `PALS` holds `WRAP`,
 * which holds an `OFFS` table of 32-bit offsets followed by the `APAL`
 * palettes themselves.
 *
 * **Each offset counts from the first byte of the `OFFS` chunk**, header
 * included — so an offset lands on an `APAL` header. The original reaches the
 * palette bytes by adding the same offset to the table's *data* instead, which
 * comes out eight bytes further along and is exactly where the `APAL` payload
 * begins: the header it skips and the header it does not count are the same
 * eight bytes. Reading it either way works, and reading it half each way — a
 * chunk header expected at the payload — finds no palettes at all, which is
 * what happened here until a real room was tried.
 *
 * All of them are read, because `roomOps`'s "new palette" form selects one by
 * number: Sam & Max's film noir mode is a second palette rather than a filter,
 * and a room that only kept palette zero would play it in colour.
 *
 * Layout established by `findPalInPals` in ScummVM's `palette.cpp`.
 */
function readPalettes(data: Uint8Array, pals: Chunk): Uint8Array[] {
  const wrap = findChunk(data, pals.dataOffset, 'WRAP', pals.dataOffset + pals.dataSize);
  if (!wrap) return [];

  const offs = findChunk(data, wrap.dataOffset, 'OFFS', wrap.dataOffset + wrap.dataSize);
  if (!offs || offs.dataSize < 4) return [];

  const palettes: Uint8Array[] = [];
  for (let entry = 0; entry + 4 <= offs.dataSize; entry += 4) {
    const at = readU32LE(data, offs.dataOffset + entry);
    const apal = readChunkHeader(data, offs.offset + at);
    // The table is sized by the block, not by a count, so a non-APAL entry is
    // the end of the real palettes rather than a fault worth reporting.
    if (apal.tag !== 'APAL') break;
    palettes.push(chunkData(data, apal));
  }
  return palettes;
}

/** A walk box: a convex quadrilateral the actors are allowed to stand in. */
export interface WalkBox {
  ulx: number;
  uly: number;
  urx: number;
  ury: number;
  lrx: number;
  lry: number;
  llx: number;
  lly: number;
  mask: number;
  flags: number;
  /** Either a literal scale (0-255) or, with bit 15 set, a scale slot index. */
  scale: number;
}

export const BOX_INVISIBLE = 0x80;
export const BOX_LOCKED = 0x40;
export const BOX_PLAYER_ONLY = 0x20;
export const INVALID_BOX = 0xff;

/** A perspective scaling ramp: actors shrink between two screen rows. */
export interface ScaleSlot {
  scale1: number;
  y1: number;
  scale2: number;
  y2: number;
  x1: number;
  x2: number;
}

export interface RoomObjectImage {
  /** Offset of the OBIM chunk within the room buffer. */
  obimOffset: number;
  /** IM01..IMxx chunk offsets, indexed by state - 1. */
  imageOffsets: number[];
  width: number;
  height: number;
  /**
   * Where the object sits, for the versions that record it here.
   *
   * v5 and v6 keep an object's position in its `CDHD` and leave the image
   * header to describe only the picture; v7 moved it into `IMHD` and shrank
   * `CDHD` to an id and a parent. Zero for v5 and v6, whose `CDHD` is read
   * for it instead.
   */
  x: number;
  y: number;
  hotspots: Array<{ x: number; y: number }>;
  flags: number;
  /**
   * Which way an actor using this object ends up facing, where the image
   * records it.
   *
   * v8 only, and an *angle* in the file rather than a direction — 0 to 359,
   * which is why it cannot live in the byte v5 keeps it in. Absent for every
   * earlier Version, whose `CDHD` carries it.
   */
  actorDir?: number;
}

/**
 * The buffers a room needs beyond its own, and the table that pairs them.
 *
 * Empty for every Version before v8, which keeps a room's code, its pictures
 * and its object numbers in the one resource.
 */
export interface RoomSources {
  /** The `RMSC` block holding a v8 room's scripts and object code. */
  scripts?: Uint8Array;
  /** The index's object name table, which is how a v8 image finds its id. */
  objectNames?: ReadonlyMap<string, number>;
}

const EMPTY_NAMES: ReadonlyMap<string, number> = new Map();

/**
 * Field offsets in a v8 `IMHD`, which shares none of them with v7's.
 *
 * Written out rather than derived, because the whole of the risk here is
 * arithmetic: thirty-two bytes of name, eight ScummVM reads nothing out of,
 * and then eight 32-bit fields. (`ImageHeader.v8` in ScummVM's `object.h`.)
 */
const V8_IMHD_NAME_BYTES = 32;
const V8_IMHD_VERSION = 40;
const V8_IMHD_IMAGE_COUNT = 44;
const V8_IMHD_X = 48;
const V8_IMHD_Y = 52;
const V8_IMHD_WIDTH = 56;
const V8_IMHD_HEIGHT = 60;
const V8_IMHD_ACTOR_DIR = 64;
const V8_IMHD_FLAGS = 68;
const V8_IMHD_HOTSPOTS = 72;
const V8_IMHD_HOTSPOT_SLOTS = 15;

/**
 * The `IMHD` version that carries a flags field, which the COMI demo does not.
 *
 * The retail game writes 801 and the demo writes 800, and the difference is
 * one 32-bit field — so every hotspot in the demo sits four bytes earlier than
 * the struct says. (`ScummEngine::resetRoomObject`, which reads the demo's
 * hotspots at a hard-coded 0x44.)
 */
const V8_IMHD_VERSION_WITH_FLAGS = 801;

export interface RoomObject {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  parent: number;
  parentState: number;
  walkX: number;
  walkY: number;
  actorDir: number;
  /** Verb entry points: verb id -> offset into the object's script block. */
  verbs: Map<number, number>;
  /** Offset of the OBCD chunk and of its verb code, within the room buffer. */
  obcdOffset: number;
  /**
   * What the verb table's offsets are counted from: the `VERB` chunk's own
   * first byte, tag included.
   *
   * Not the `OBCD`'s first byte, which is the reading a synthetic fixture and
   * this engine happily agreed on for months. In a real game the difference is
   * the `OBCD` header plus the whole `CDHD` — thirty-odd bytes — so every verb
   * script started that far short of its first instruction, which lands inside
   * the `VERB` header: `V` and `R` decode as instructions, and the script died
   * with an unknown opcode somewhere past the object it belonged to. Day of the
   * Tentacle's first door is where that shows.
   *
   * -1 when the object has no `VERB` chunk at all.
   */
  verbCodeBase: number;
  name: string;
  image?: RoomObjectImage;
  /** Runtime visibility state, mirrored from the global object state table. */
  state: number;
  /**
   * The buffer this object's offsets are relative to, when not its room's own.
   *
   * Set only on a floating object — one a script moved into this room from
   * another. Its code and image stay in the room that owns them, so it has to
   * carry that room's buffer with it: read against the room it now sits in,
   * every offset it holds lands on unrelated bytes.
   */
  source?: Uint8Array;
}

export interface RoomScripts {
  /** Room entry script (ENCD), or null. */
  entry: { offset: number; length: number } | null;
  /** Room exit script (EXCD), or null. */
  exit: { offset: number; length: number } | null;
  /** Local scripts by id (200+), as offsets into the room buffer. */
  local: Map<number, { offset: number; length: number }>;
}

/**
 * A parsed room.
 *
 * Holds views into the resource manager's buffer rather than copies: a room is
 * up to a few hundred kilobytes and the script VM addresses code by offset, so
 * keeping one buffer and passing offsets around matches how SCUMM itself works.
 */
export class Room {
  readonly number: number;
  readonly data: Uint8Array;

  width = 0;
  height = 0;
  numObjects = 0;
  numZPlanes = 0;

  /** Palette payload — `CLUT` in v5, `PALS`'s selected `APAL` in v6 — or null. */
  palette: Uint8Array | null = null;

  /**
   * Every palette the room carries, for v6's "new palette" form to pick from.
   *
   * One entry for a v5 room, several for a v6 one. `palette` is whichever of
   * these is in force, and starts as the first.
   */
  palettes: Uint8Array[] = [];

  /**
   * How many colours this room's palette holds, where the room says so.
   *
   * Only v2-v4 write it down, and it is the one structural answer to "is this
   * a sixteen-colour release" — better than measuring the palette, because a
   * release that padded its block would measure long and read as 256-colour,
   * and the codec that then ran would be the wrong one for every strip.
   * Zero before v5's `CLUT`, which carries no count.
   */
  paletteColours = 0;

  cycles: ColorCycle[] = [];
  transparentColor = 255;

  boxes: WalkBox[] = [];
  /** Raw BOXM payload; the engine recomputes routes rather than trusting it. */
  boxMatrix: Uint8Array | null = null;

  /**
   * Every box set the room carries, in the order the blocks appear.
   *
   * `boxes` and `boxMatrix` are whichever set is in force. A v5 room has one;
   * a v6 room can have several, selected by `setBoxSet`, which is how a room
   * changes where the actors may walk without changing rooms.
   */
  readonly boxSets: WalkBox[][] = [];
  readonly boxMatrixSets: Uint8Array[] = [];
  scaleSlots: ScaleSlot[] = [];

  objects: RoomObject[] = [];
  scripts: RoomScripts = { entry: null, exit: null, local: new Map() };

  /** Offset of the room's background image (the IM00 inside RMIM). */
  backgroundOffset = -1;

  /**
   * The SCUMM version this room came from.
   *
   * Needed because `CDHD` — an object's position, size and parent — changed
   * shape at v6: v5 stores four bytes counted in eighths of a pixel, v6 stores
   * four 16-bit values counted in pixels. Reading one as the other is quiet and
   * ruinous: the low byte of a 16-bit field parses as a whole byte field, so
   * every object comes out somewhere else with a height of zero, and a
   * zero-height object can never be clicked.
   */
  readonly version: number;

  /**
   * Where this room's code lives, which at v8 is not where its pictures do.
   *
   * v8 splits a room in two: `ROOM` keeps the header, the palettes, the boxes
   * and the object *images*, and a sibling `RMSC` block in the same `LFLF`
   * keeps the entry and exit scripts, the local scripts and the object *code*.
   * Every Version before it keeps both in the one resource, so this is the
   * same buffer as `data` for all of them and the split costs nothing to read.
   * (`ScummEngine::setupRoomSubBlocks`, which fetches `rtRoomScripts`
   * separately at v8 and uses the room resource for everything else.)
   */
  readonly scriptData: Uint8Array;

  /**
   * The game's object name table, which is how a v8 image finds its object.
   *
   * v8's `IMHD` carries a name where every earlier Version carries an object
   * id, so pairing an image with the code that owns it goes through the
   * index's own name table rather than through a number in the room. Empty for
   * every Version before v8, which has an id to hand and never asks.
   * (`ScummEngine_v8::getObjectIdFromOBIM`.)
   */
  private readonly objectNames: ReadonlyMap<string, number>;

  constructor(number: number, data: Uint8Array, version = 5, sources: RoomSources = {}) {
    this.number = number;
    this.data = data;
    this.version = version;
    this.scriptData = sources.scripts ?? data;
    this.objectNames = sources.objectNames ?? EMPTY_NAMES;
    this.parse();
  }

  private parse(): void {
    if (this.version < 5) {
      this.parseSmall();
      return;
    }

    const root = readChunkHeader(this.data, 0);
    const start = root.dataOffset;
    const end = root.dataOffset + root.dataSize;

    for (const chunk of iterateChunks(this.data, start, end)) {
      switch (chunk.tag) {
        case 'RMHD': {
          // Three layouts, not two. v7 puts a 32-bit version field in front of
          // the three counts, so a v6 reader takes that version as the width
          // and the width as the height. v8 keeps the version field and widens
          // the three counts to 32 bits as well, so a v7 reader takes the low
          // half of the width as the whole width and the high half as the
          // height — which for a 1280 pixel room is a width of 1280 and a
          // height of 0. Ten bytes, twenty-four bytes and six, all plausible
          // sizes for a header, and nothing about the block gives it away.
          // (`RoomHeader` in ScummVM's `object.h`, read in
          // `ScummEngine::setupRoomSubBlocks`.)
          const base = chunk.dataOffset + (this.version >= 7 ? 4 : 0);
          if (this.version >= 8) {
            this.width = readU32LE(this.data, base);
            this.height = readU32LE(this.data, base + 4);
            this.numObjects = readU32LE(this.data, base + 8);
            break;
          }
          this.width = readU16LE(this.data, base);
          this.height = readU16LE(this.data, base + 2);
          this.numObjects = readU16LE(this.data, base + 4);
          break;
        }
        case 'CLUT':
          this.palettes = [chunkData(this.data, chunk)];
          this.palette = this.palettes[0];
          break;
        case 'PALS':
          this.palettes = readPalettes(this.data, chunk);
          this.palette = this.palettes[0] ?? null;
          break;
        case 'CYCL':
          this.cycles = parseColorCycles(this.data, chunk, this.version);
          break;
        case 'TRNS':
          this.transparentColor = readU16LE(this.data, chunk.dataOffset) & 0xff;
          break;
        case 'BOXD':
          // A room can carry several box sets and switch between them with
          // v6's `setBoxSet`; the first is the one it starts in.
          this.boxSets.push(parseBoxes(this.data, chunk, this.version));
          this.boxes = this.boxSets[0];
          break;
        case 'BOXM':
          this.boxMatrixSets.push(chunkData(this.data, chunk));
          this.boxMatrix = this.boxMatrixSets[0];
          break;
        case 'SCAL':
          this.scaleSlots = parseScaleSlots(this.data, chunk, this.version);
          break;
        case 'RMIM':
          this.backgroundOffset = this.findBackground(chunk);
          break;
        case 'ENCD':
          this.scripts.entry = { offset: chunk.dataOffset, length: chunk.dataSize };
          break;
        case 'EXCD':
          this.scripts.exit = { offset: chunk.dataOffset, length: chunk.dataSize };
          break;
        case 'LSCR': {
          // The script's own number, and it is not one byte at every Version:
          // v7 writes two and v8 writes four. Reading one byte of a v7 id
          // numbers the script by its low half *and* starts its code a byte
          // early, so the first instruction is decoded from the high byte of
          // the number — which is a script that runs and is not the script it
          // was. (`ScummEngine::setupRoomSubBlocks`, the local script walk.)
          const idBytes = this.version >= 8 ? 4 : this.version >= 7 ? 2 : 1;
          const id =
            idBytes === 4
              ? readU32LE(this.data, chunk.dataOffset)
              : idBytes === 2
                ? readU16LE(this.data, chunk.dataOffset)
                : this.data[chunk.dataOffset];
          this.scripts.local.set(id, {
            offset: chunk.dataOffset + idBytes,
            length: chunk.dataSize - idBytes,
          });
          break;
        }
        default:
          break;
      }
    }

    // v8's code is in the sibling `RMSC` block rather than in `ROOM`, so the
    // scripts and the object code are walked separately when the two buffers
    // differ. For every earlier Version this is the same buffer and the walk
    // above already found them.
    if (this.scriptData !== this.data) {
      const scriptRoot = readChunkHeader(this.scriptData, 0);
      this.parseRoomScripts(scriptRoot.dataOffset, scriptRoot.dataOffset + scriptRoot.dataSize);
      this.parseObjects(
        start,
        end,
        scriptRoot.dataOffset,
        scriptRoot.dataOffset + scriptRoot.dataSize,
      );
      return;
    }

    this.parseObjects(start, end);
  }

  /**
   * The entry, exit and local scripts of a room whose code is a block of its
   * own.
   *
   * Only v8 reaches this. The three tags are the ones `setupRoomSubBlocks`
   * looks for in `rtRoomScripts` rather than in the room resource, and looking
   * for them in the room resource at v8 finds nothing at all — which is a room
   * that enters, draws and then does nothing, rather than a room that fails.
   */
  private parseRoomScripts(start: number, end: number): void {
    for (const chunk of iterateChunks(this.scriptData, start, end)) {
      switch (chunk.tag) {
        case 'ENCD':
          this.scripts.entry = { offset: chunk.dataOffset, length: chunk.dataSize };
          break;
        case 'EXCD':
          this.scripts.exit = { offset: chunk.dataOffset, length: chunk.dataSize };
          break;
        case 'LSCR': {
          // v8 numbers a local script in thirty-two bits, as it numbers every
          // other script. Reading one byte of it gives the right answer for
          // the first 255 and the wrong one after that, silently.
          const id = readU32LE(this.scriptData, chunk.dataOffset);
          this.scripts.local.set(id, {
            offset: chunk.dataOffset + 4,
            length: chunk.dataSize - 4,
          });
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * A v2-v4 room: the same furniture under two character tags.
   *
   * The tags are not abbreviations of v5's and the mapping is worth writing
   * down once — `newTag2Old` in ScummVM's `resource.cpp` is the reference:
   *
   *   HD  room header      RMHD        BX  walk boxes        BOXD
   *   PA  palette          CLUT        CC  colour cycles     CYCL
   *   SA  scale slots      SCAL        BM  the background    RMIM / SMAP
   *   OI  object image     OBIM        OC  object code       OBCD
   *   EN  entry script     ENCD        EX  exit script       EXCD
   *   LS  local script     LSCR        SP  EGA palette       EPAL
   *
   * The background is the sharpest difference and not just a rename: v5 wraps
   * its image in `RMIM` and then `IM00` and then `SMAP`, and v4 has none of
   * those — `BM` is the strip table itself. So `backgroundOffset` points at the
   * `BM` block and `RoomGraphics.decodeSmallImage` reads it, where a v5 room's
   * points at `IM00` and `decodeImage` reads that.
   */
  private parseSmall(): void {
    const root = readSmallChunkHeader(this.data, 0);
    const start = root.dataOffset;
    const end = root.dataOffset + root.dataSize;

    for (const chunk of iterateChunks(this.data, start, end, SMALL_CHUNKS)) {
      switch (chunk.tag) {
        case 'HD':
          this.width = readU16LE(this.data, chunk.dataOffset);
          this.height = readU16LE(this.data, chunk.dataOffset + 2);
          this.numObjects = readU16LE(this.data, chunk.dataOffset + 4);
          break;
        case 'PA': {
          // A v2-v4 palette opens with a sixteen-bit *byte* count and then the
          // RGB triples, where v5's `CLUT` is triples from its first byte.
          // Two bytes, and they are the difference between a room's colours
          // and every one of them shifted by two thirds of a colour — which
          // does not fail, it renders the whole room in the wrong hues.
          // (`ScummEngine::setPaletteFromPtr`, the `GF_SMALL_HEADER` branch.)
          const payload = chunkData(this.data, chunk);
          this.paletteColours = Math.floor(readU16LE(this.data, chunk.dataOffset) / 3);
          this.palettes = [payload.subarray(2)];
          this.palette = this.palettes[0];
          break;
        }
        case 'CC':
          this.cycles = parseColorCycles(this.data, chunk, this.version);
          break;
        case 'BX':
          this.boxSets.push(parseBoxes(this.data, chunk, this.version));
          this.boxes = this.boxSets[0];
          break;
        case 'BM':
          this.backgroundOffset = chunk.offset;
          break;
        case 'EN':
          this.scripts.entry = { offset: chunk.dataOffset, length: chunk.dataSize };
          break;
        case 'EX':
          this.scripts.exit = { offset: chunk.dataOffset, length: chunk.dataSize };
          break;
        case 'LS': {
          const id = this.data[chunk.dataOffset];
          this.scripts.local.set(id, {
            offset: chunk.dataOffset + 1,
            length: chunk.dataSize - 1,
          });
          break;
        }
        default:
          break;
      }
    }

    this.parseSmallObjects(start, end);
  }

  /**
   * v2-v4 objects: an `OC` for behaviour and an `OI` for appearance.
   *
   * The `OC` block *is* the code header — there is no `CDHD` inside it, which
   * is why `findResourceData(CDHD, …)` finds nothing in a v4 room and ScummVM
   * reads the fields at fixed offsets instead (`ScummEngine_v4::resetRoomObject`).
   * Two of those fields share a byte, which is the part a reader gets wrong
   * quietly: the top bit of the `y` byte is the parent state rather than part
   * of the coordinate, and the height is the *top five bits* of a byte whose
   * low three are the direction an actor faces when it arrives. Read either as
   * a whole byte and the object is in roughly the right place, the wrong size,
   * and facing the wrong way.
   *
   * The verb table follows the header at a fixed offset and is otherwise v5's:
   * a verb number and a sixteen-bit offset, terminated by a zero verb. Its
   * offsets count from the `OC` block's own first byte, which is what
   * `verbCodeBase` records.
   */
  private parseSmallObjects(start: number, end: number): void {
    const images = new Map<number, RoomObjectImage>();

    for (const oi of findChunks(this.data, start, 'OI', end, SMALL_CHUNKS)) {
      const id = readU16LE(this.data, oi.offset + 6);
      images.set(id, {
        obimOffset: oi.offset,
        // A v4 object has one image and it starts right after the id, so there
        // is no table of states to walk — the offset *is* the image.
        imageOffsets: [oi.offset + 8],
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        hotspots: [],
        flags: 0,
      });
    }

    // v2 packs the last four fields into three bytes where v3 and v4 spend
    // five. Same header up to the parent, and then they diverge: v2's walk-to
    // point is two *bytes* in eighths of a pixel with the height and the
    // arrival direction sharing the byte after them, and v3's is two words
    // with a byte of its own for the pair. Read one as the other and an object
    // is the right size in the wrong place, facing the wrong way.
    const narrow = this.version <= 2;

    for (const oc of findChunks(this.data, start, 'OC', end, SMALL_CHUNKS)) {
      const at = oc.offset;
      const id = readU16LE(this.data, at + 6);
      const packedY = this.data[at + 10];
      const packedHeight = this.data[at + (narrow ? 15 : 17)];

      const object: RoomObject = {
        id,
        x: this.data[at + 9] * 8,
        y: (packedY & 0x7f) * 8,
        width: this.data[at + 11] * 8,
        height: packedHeight & 0xf8,
        parent: this.data[at + 12],
        // v2 counts the parent state in eighths too, as it counts everything.
        parentState: packedY & 0x80 ? (narrow ? 8 : 1) : 0,
        walkX: narrow ? this.data[at + 13] * 8 : readU16LE(this.data, at + 13),
        walkY: narrow ? (this.data[at + 14] & 0x1f) * 8 : readU16LE(this.data, at + 15),
        actorDir: packedHeight & 7,
        verbs: new Map(),
        obcdOffset: at,
        // v4 has no `VERB` chunk to count from: the table sits in the `OC`
        // block and its offsets count from that block's first byte.
        verbCodeBase: at,
        name: '',
        image: images.get(id),
        state: 0,
      };

      // The name's own offset is a byte in the header, and the verb table runs
      // from just past it up to the name. Reading the table to a fixed length
      // rather than to its zero terminator would run into the name.
      // v2's name offset is two bytes earlier, for the same reason its header
      // is: its walk-to point is two bytes where v3's is two words. The byte
      // it shares with nothing is the one after the packed height, which is
      // where `getObjectOrActorName` reads it.
      const nameOffset = this.data[at + (narrow ? 16 : 18)];
      let cursor = at + (narrow ? 17 : 19);
      while (cursor + 3 <= at + oc.size) {
        const verbId = this.data[cursor];
        if (verbId === 0) break;
        object.verbs.set(verbId, readU16LE(this.data, cursor + 1));
        cursor += 3;
      }

      if (nameOffset > 0 && at + nameOffset < at + oc.size) {
        object.name = decodeName(this.data, at + nameOffset, oc.size - nameOffset);
      }

      this.objects.push(object);
    }
  }

  /** RMIM contains RMIH (z-plane count) and IM00 (the actual image). */
  private findBackground(rmim: Chunk): number {
    const inner = rmim.dataOffset;
    const innerEnd = rmim.dataOffset + rmim.dataSize;

    const rmih = findChunk(this.data, inner, 'RMIH', innerEnd);
    if (rmih) this.numZPlanes = readU16LE(this.data, rmih.dataOffset);

    if (this.version >= 8) {
      // v8 has no `IM00`. The picture is one entry in a table: `IMAG` holds a
      // `WRAP`, the `WRAP` opens with an `OFFS` block of 32-bit offsets, and
      // the background is the one for state 1. Looking for `IM00` here finds
      // nothing and draws nothing, which is a room with its furniture and no
      // floor. (`ScummEngine::getObjectImage`, the v8 branch.)
      const offsets = wrapImageOffsets(this.data, inner, innerEnd);
      return offsets.length > 0 ? offsets[0] : -1;
    }

    const im00 = findChunk(this.data, inner, 'IM00', innerEnd);
    return im00 ? im00.offset : -1;
  }

  /**
   * Pairs each OBCD (behaviour) with its OBIM (appearance).
   *
   * The two are separate top-level chunks that correlate only by object id, and
   * a room may legitimately have an OBCD with no image (a trigger zone) or an
   * OBIM with no code (pure scenery).
   */
  private parseObjects(start: number, end: number, codeStart = start, codeEnd = end): void {
    const images = new Map<number, RoomObjectImage>();
    // Where the object *code* is, which is the scripts buffer at v8 and this
    // same buffer everywhere else. Kept as a local rather than read off `this`
    // at each use, so the two halves of the pairing are visibly two halves.
    const code = this.scriptData;

    for (const obim of findChunks(this.data, start, 'OBIM', end)) {
      const imhd = findChunk(this.data, obim.dataOffset, 'IMHD', obim.dataOffset + obim.dataSize);
      if (!imhd) continue;
      const base = imhd.dataOffset;
      // v7's `IMHD` is its own layout, not v6's with a field or two moved: a
      // 32-bit version, then the id and image count, then the object's
      // position and size — which v5 and v6 keep in `CDHD` and v7 does not
      // keep there at all. (`ImageHeader.v7` in ScummVM's `object.h`.)
      const v8 = this.version >= 8;
      const v7 = this.version >= 7;

      if (v8) {
        // v8's `IMHD` shares no field position with v7's. It opens with a
        // thirty-two byte object *name*, then eight bytes ScummVM does not
        // read, then a version, an image count, and the position, size and
        // facing as 32-bit values — seventy-two bytes before the first
        // hotspot, where v7 has twenty-two. Read as v7's, the name's first
        // four characters become the header version and its next two the
        // object id, so every object in the room comes back numbered after its
        // own letters. (`ImageHeader.v8` in ScummVM's `object.h`, read in
        // `ScummEngine::resetRoomObject`.)
        const headerVersion = readU32LE(this.data, base + V8_IMHD_VERSION);
        const imageCount = readU32LE(this.data, base + V8_IMHD_IMAGE_COUNT);
        // The COMI demo writes header version 800, which is this layout with
        // the flags field missing — so everything after it sits four bytes
        // earlier. (`ScummEngine::resetRoomObject`, which reads the hotspots
        // at 0x44 for 800 and from the struct for 801.)
        const hasFlags = headerVersion >= V8_IMHD_VERSION_WITH_FLAGS;
        const hotspotBase = base + (hasFlags ? V8_IMHD_HOTSPOTS : V8_IMHD_FLAGS);

        const hotspots: Array<{ x: number; y: number }> = [];
        // No hotspot count of its own: v8 has room for fifteen and the image
        // count says how many of them are an image's.
        for (let i = 0; i < Math.min(imageCount, V8_IMHD_HOTSPOT_SLOTS); i++) {
          hotspots.push({
            x: readS32LE(this.data, hotspotBase + i * 8),
            y: readS32LE(this.data, hotspotBase + i * 8 + 4),
          });
        }

        // The name is the only thing this block and the object's code have in
        // common, and the index's table is what turns it into a number.
        const name = readFixedName(this.data, base, V8_IMHD_NAME_BYTES);
        const found = this.objectNames.get(name);
        if (found === undefined) continue;

        images.set(found, {
          obimOffset: obim.offset,
          imageOffsets: wrapImageOffsets(
            this.data,
            obim.dataOffset,
            obim.dataOffset + obim.dataSize,
          ),
          width: readU32LE(this.data, base + V8_IMHD_WIDTH),
          height: readU32LE(this.data, base + V8_IMHD_HEIGHT),
          x: readS32LE(this.data, base + V8_IMHD_X),
          y: readS32LE(this.data, base + V8_IMHD_Y),
          hotspots,
          // Bit 4 of v8's flags is the one ScummVM reads, and it reads it the
          // other way up: set means *do not* mask against the z-plane.
          flags: hasFlags ? readU32LE(this.data, base + V8_IMHD_FLAGS) & 0xff : 0,
          actorDir: readU32LE(this.data, base + V8_IMHD_ACTOR_DIR) & 0xff,
        });
        continue;
      }

      const id = readU16LE(this.data, base + (v7 ? 4 : 0));
      const imageCount = readU16LE(this.data, base + (v7 ? 6 : 2));
      const flags = v7 ? 0 : this.data[base + 6];
      // Width and height land at the same two offsets in both layouts, by
      // coincidence rather than by design: v7 spends its extra four bytes on
      // the version field and saves them again on fields v6 has and it does
      // not. Written out rather than shared, so a later correction to one does
      // not silently move the other.
      const width = readU16LE(this.data, base + 12);
      const height = readU16LE(this.data, base + 14);
      const hotspotCount = readU16LE(this.data, base + (v7 ? 20 : 16));
      const hotspotBase = base + (v7 ? 22 : 18);
      const x = v7 ? readS16LE(this.data, base + 8) : 0;
      const y = v7 ? readS16LE(this.data, base + 10) : 0;

      const hotspots: Array<{ x: number; y: number }> = [];
      for (let i = 0; i < Math.min(hotspotCount, 15); i++) {
        hotspots.push({
          x: readS16LE(this.data, hotspotBase + i * 4),
          y: readS16LE(this.data, hotspotBase + i * 4 + 2),
        });
      }

      images.set(id, {
        obimOffset: obim.offset,
        imageOffsets: imageStateOffsets(this.data, obim),
        width: width || imageCount * 0,
        height,
        x,
        y,
        hotspots,
        flags,
      });
    }

    for (const obcd of findChunks(code, codeStart, 'OBCD', codeEnd)) {
      const inner = obcd.dataOffset;
      const innerEnd = obcd.dataOffset + obcd.dataSize;

      const cdhd = findChunk(code, inner, 'CDHD', innerEnd);
      if (!cdhd) continue;
      const base = cdhd.dataOffset;

      // v7's `CDHD` is eight bytes and holds almost nothing: a 32-bit version,
      // the object number, a parent and a parent state. Its position and size
      // are in the `IMHD` instead, which is why they are taken from the image
      // below rather than from here. v5's and v6's are both fifteen bytes and
      // both start with the object number, so between those two nothing about
      // the block's size gives the difference away.
      // (`CodeHeader` in ScummVM's `object.h`.)
      const v7 = this.version >= 7;
      const wide = this.version >= 6 && !v7;
      // v8's `CDHD` is v7's, unchanged and unwidened — the one place in the
      // whole Version where nothing grew. (`ScummEngine::resetRoomObject`,
      // whose v8 branch reads `cdhd->v7`.)
      const id = readU16LE(code, base + (v7 ? 4 : 0));
      const image = images.get(id);
      const flags = v7 ? 0 : code[base + (wide ? 10 : 6)];
      const object: RoomObject = {
        id,
        x: v7 ? (image?.x ?? 0) : wide ? readS16LE(code, base + 2) : code[base + 2] * 8,
        y: v7 ? (image?.y ?? 0) : wide ? readS16LE(code, base + 4) : code[base + 3] * 8,
        width: v7 ? (image?.width ?? 0) : wide ? readU16LE(code, base + 6) : code[base + 4] * 8,
        height: v7 ? (image?.height ?? 0) : wide ? readU16LE(code, base + 8) : code[base + 5] * 8,
        parentState: v7 ? code[base + 7] : flags === 0x80 ? 1 : flags & 0x0f,
        parent: code[base + (v7 ? 6 : wide ? 11 : 7)],
        // v6 has two 16-bit fields here that no version reads, where v5 keeps
        // the walk-to position. So a v6 object has none, and the engine falls
        // back to its hotspot — which is what the original does. v7 has no room
        // for one at all.
        walkX: wide ? 0 : v7 ? 0 : readS16LE(code, base + 8),
        walkY: wide ? 0 : v7 ? 0 : readS16LE(code, base + 10),
        // Last field in the header, so its offset is the whole of the rest of
        // it: v5 keeps four one-byte position fields and a walk-to point, v6
        // four 16-bit ones and two unread 16-bit fields in the walk-to point's
        // place. Reading v6's at v5's distance-plus-two landed on the low byte
        // of the second unread field, so every object faced whatever happened
        // to be there — and an actor walked to an object turned the wrong way.
        //
        // v8 keeps it in the `IMHD` with everything else it moved there, as an
        // *angle* rather than a direction, which is why it arrives already
        // reduced to a byte.
        actorDir:
          this.version >= 8 ? (image?.actorDir ?? 0) : v7 ? 0 : code[base + (wide ? 16 : 12)],
        verbs: new Map(),
        obcdOffset: obcd.offset,
        verbCodeBase: -1,
        name: '',
        image,
        state: 0,
        // Which buffer this object's code is in, for the engine that runs it.
        // Only v8 sets it from here, and only because only v8 puts the code
        // somewhere other than the room.
        source: code === this.data ? undefined : code,
      };

      const verb = findChunk(code, inner, 'VERB', innerEnd);
      if (verb) {
        object.verbCodeBase = verb.offset;
        if (this.version >= 8) {
          // v8's verb table is pairs of 32-bit words — the verb number and its
          // offset — terminated by a zero verb, where every earlier Version
          // spends a byte and a sixteen bit offset. Read narrow, the first
          // verb number is right and the offset is the number's own high half,
          // so the first handler runs from somewhere near the start of the
          // block rather than from its own first instruction.
          // (`ScummEngine::getVerbEntrypoint`, the v8 branch.)
          let cursor = verb.dataOffset;
          while (cursor + 8 <= verb.dataOffset + verb.dataSize) {
            const verbId = readU32LE(code, cursor);
            if (verbId === 0) break;
            // v8 counts its offsets from the `VERB` *payload* and every
            // earlier Version counts them from the chunk's first byte, tag
            // included. Normalised to the latter here so `verbCodeBase` means
            // one thing across the family rather than two — ScummVM does the
            // same sum the other way round, adding eight at the point of use.
            object.verbs.set(verbId, CHUNK_HEADER_SIZE + readU32LE(code, cursor + 4));
            cursor += 8;
          }
        } else {
          // A table of (verb id, u16 offset) pairs terminated by a zero id.
          let cursor = verb.dataOffset;
          while (cursor < verb.dataOffset + verb.dataSize) {
            const verbId = code[cursor];
            if (verbId === 0) break;
            const offset = readU16LE(code, cursor + 1);
            object.verbs.set(verbId, offset);
            cursor += 3;
          }
        }
      }

      const obna = findChunk(code, inner, 'OBNA', innerEnd);
      if (obna) {
        object.name = decodeName(code, obna.dataOffset, obna.dataSize);
      }

      this.objects.push(object);
    }
  }

  findObject(id: number): RoomObject | undefined {
    return this.objects.find((object) => object.id === id);
  }
}

/**
 * Image state offsets inside an `OBIM`: `IM01`, `IM02`, … in order.
 *
 * Matching on "IM" alone also matched `IMHD`, the header that sits in front of
 * them, so every object was counted as having one state more than it ships —
 * and asking for that state handed back the header to be decoded as artwork.
 */
function imageStateOffsets(data: Uint8Array, obim: Chunk): number[] {
  const offsets: number[] = [];
  for (const child of iterateChunks(data, obim.dataOffset, obim.dataOffset + obim.dataSize)) {
    if (isImageStateTag(child.tag)) offsets.push(child.offset);
  }
  return offsets;
}

/**
 * Where each image state's bitmap starts, for the `IMAG`/`WRAP`/`OFFS` nesting
 * v8 uses in place of a run of `IMxx` blocks.
 *
 * The offsets are counted from the `OFFS` block's own first byte, tag
 * included, and the table starts one entry in — entry zero is the table's own
 * size. Returned in state order, so index 0 is state 1, which is the same
 * convention `imageOffsets` already has.
 */
function wrapImageOffsets(data: Uint8Array, start: number, end: number): number[] {
  const imag = findChunk(data, start, 'IMAG', end);
  if (!imag) return [];

  const wrap = findChunk(data, imag.dataOffset, 'WRAP', imag.dataOffset + imag.dataSize);
  if (!wrap) return [];

  const offs = findChunk(data, wrap.dataOffset, 'OFFS', wrap.dataOffset + wrap.dataSize);
  if (!offs) return [];

  const offsets: number[] = [];
  // The first entry sits at the block's data start, which is `offs.offset + 8`
  // — and ScummVM writes that as `ptr + 4 + 4 * state` with state counted from
  // one, which is the same address by a different route.
  const count = Math.floor(offs.dataSize / 4);
  for (let i = 0; i < count; i++) {
    const at = offs.offset + 4 + 4 * (i + 1);
    if (at + 4 > offs.offset + offs.size) break;
    offsets.push(offs.offset + readU32LE(data, at));
  }
  return offsets;
}

/**
 * A fixed-width NUL-padded name, as v8 writes one into an `IMHD`.
 *
 * Trimmed at the first NUL rather than at the field's end, because the bytes
 * after it are whatever the compiler left there and the table this is looked
 * up in holds the trimmed form.
 */
function readFixedName(data: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = data[offset + i];
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out.trim();
}

/** Object names are plain bytes, terminated by NUL, sometimes with escapes. */
function decodeName(data: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = data[offset + i];
    if (byte === 0) break;
    // 0xFF introduces a two-or-four byte escape (colour, verb key, keep-alive).
    if (byte === 0xff) {
      const code = data[offset + i + 1];
      i += code === 1 || code === 2 || code === 3 || code === 8 ? 1 : 3;
      continue;
    }
    out += String.fromCharCode(byte);
  }
  // `@` is padding, not part of the name. LucasArts leaves a run of it so a
  // script can write a longer name into the same space with `setObjectName`,
  // and it turns up wherever the spare room was wanted: "urn@@@@@@@@" at the
  // end, "@@@@@@@@coal" at the start, "orichalcum (@@@@@ beads)" in the middle
  // where a count goes. None of it is meant to be seen, and the glyph is not
  // blank in the fonts this game writes text with — charsets 1, 2 and 5 all
  // draw it — so left in it appears on the sentence line and in every line of
  // dialogue that names the object.
  //
  // A run between two spaces would leave a double space behind it, so the run
  // takes one of them with it: "orichalcum (@@@@@ beads)" is a bag of beads,
  // not a bag of " beads".
  return out.replace(/ ?@+ ?/g, (run) => (run.startsWith(' ') && run.endsWith(' ') ? ' ' : ''));
}

/**
 * A room's colour cycles, in whichever of the two record layouts it uses.
 *
 * v5's `CYCL` is a list: an index (0 terminates), two ignored bytes, a
 * big-endian rate, flags, then the inclusive palette range. v2-v4's `CC` is a
 * *table* — sixteen fixed four-byte slots, each a big-endian rate and then the
 * range, with no index, no flags and no terminator. (`ScummEngine::initCycl`,
 * which branches on `GF_SMALL_HEADER` for exactly this.)
 *
 * The rate is a divisor of 16384 in both, so a larger stored value means
 * faster cycling — inverted from the delay the engine actually counts down.
 */
function parseColorCycles(data: Uint8Array, chunk: Chunk, version: number): ColorCycle[] {
  if (version < 5) return parseSmallColorCycles(data, chunk);

  const cycles: ColorCycle[] = [];
  let cursor = chunk.dataOffset;
  const end = chunk.dataOffset + chunk.dataSize;

  while (cursor < end) {
    const index = data[cursor++];
    if (index === 0) break;
    cursor += 2;
    const rate = readU16BE(data, cursor);
    cursor += 2;
    const flags = readU16BE(data, cursor);
    cursor += 2;
    const start = data[cursor++];
    const cycleEnd = data[cursor++];

    cycles.push({
      start,
      end: cycleEnd,
      delay: rate === 0 ? 0 : Math.max(1, Math.floor(16384 / rate)),
      direction: flags & 2 ? -1 : 1,
      counter: 0,
    });
  }
  return cycles;
}

/** How many slots a pre-v5 `CC` table has, occupied or not. */
const SMALL_CYCLE_SLOTS = 16;

/**
 * The rate a pre-v5 room writes into a slot it is not using.
 *
 * Not zero, which is the part that has to be known rather than derived: an
 * unused slot holds 0x0AAA, and 16384/0x0AAA is 6 — a perfectly ordinary
 * delay. Read as a live cycle it rotates a range the room never meant to
 * rotate, six times a second, for as long as the room is on screen.
 *
 * Loom's opening screen is the case that named this. Its `CC` is
 * `0A AA 01 0E` and then thirteen zeroed slots, so it cycles nothing at all;
 * read as v5's layout the same bytes parse as an index, a rate and a range of
 * 0 to 10, and the menu's background — colour 0 — rotates through the palette.
 * The screen flickers blue, green, teal, red, and the prompt underneath it
 * disappears each time its own colour comes round to the background's.
 * (`ScummEngine::initCycl` skips this value explicitly.)
 */
const SMALL_CYCLE_UNUSED_RATE = 0x0aaa;

/**
 * A pre-v5 `CC` table: sixteen slots of a big-endian rate and an inclusive
 * palette range.
 *
 * A slot is live only if its rate is neither zero nor the unused marker and its
 * range runs forwards; everything else is a slot the room left empty, and the
 * table is walked to its end rather than to a terminator because it has none.
 *
 * Direction is not stored. The original sets the flags to 2 for every slot it
 * fills, which is its own "rotate downwards", so there is one direction here
 * and it is not the one v5 defaults to.
 */
function parseSmallColorCycles(data: Uint8Array, chunk: Chunk): ColorCycle[] {
  const cycles: ColorCycle[] = [];
  const end = chunk.dataOffset + chunk.dataSize;

  for (let slot = 0; slot < SMALL_CYCLE_SLOTS; slot++) {
    const at = chunk.dataOffset + slot * 4;
    if (at + 4 > end) break;

    const rate = readU16BE(data, at);
    const start = data[at + 2];
    const cycleEnd = data[at + 3];
    if (rate === 0 || rate === SMALL_CYCLE_UNUSED_RATE || start >= cycleEnd) continue;

    cycles.push({
      start,
      end: cycleEnd,
      delay: Math.max(1, Math.floor(16384 / rate)),
      direction: -1,
      counter: 0,
    });
  }
  return cycles;
}

/** BOXD: a 16-bit count followed by 20 byte box records. */
/**
 * A room's walk boxes, whose header and stride both change before v5.
 *
 * Four layouts, and none of the differences fails loudly:
 *
 *   v5+  a sixteen-bit count, boxes from byte two, twenty bytes each
 *   v4   an *eight*-bit count, boxes from byte one, twenty bytes each
 *   v3   the same, at eighteen bytes each — no scale field
 *   v2   the same, at eight, with byte coordinates in their own order
 *
 * v4 is the one worth naming, because it differs from v5 by a single byte at
 * the front: read v5's word count and every box in the room is shifted one
 * byte, which gives coordinates that are plausible, boxes that are the right
 * *number*, and an actor that walks into walls. The box count itself comes out
 * as the real count plus whatever the first box's low byte is, so it is not
 * even reliably too large.
 *
 * (`ScummEngine::getNumBoxes` and `getBoxBaseAddr`, and the `Box` union.)
 */
function parseBoxes(data: Uint8Array, chunk: Chunk, version: number): WalkBox[] {
  const wide = version >= 5;
  const count =
    version >= 8
      ? readU32LE(data, chunk.dataOffset)
      : wide
        ? readU16LE(data, chunk.dataOffset)
        : data[chunk.dataOffset];
  // v8 counts its boxes in thirty-two bits and spends fifty-six bytes on each
  // one, where v5 spends two and twenty. (`getNumBoxes` and `getBoxBaseAddr`,
  // whose v8 arm adds 4 rather than 2 before indexing.)
  const first = chunk.dataOffset + (version >= 8 ? 4 : wide ? 2 : 1);
  const stride = version >= 8 ? 56 : version <= 2 ? 8 : version === 3 ? 18 : 20;
  const end = chunk.dataOffset + chunk.dataSize;

  const boxes: WalkBox[] = [];
  for (let i = 0; i < count; i++) {
    const base = first + i * stride;
    if (base + stride > end) break;

    if (version >= 8) {
      // Eight 32-bit coordinates, then the mask, the flags, a scale *slot* and
      // a scale — each a word of its own where every earlier Version packs the
      // slot into the top bit of the scale.
      boxes.push({
        ulx: readS32LE(data, base),
        uly: readS32LE(data, base + 4),
        urx: readS32LE(data, base + 8),
        ury: readS32LE(data, base + 12),
        lrx: readS32LE(data, base + 16),
        lry: readS32LE(data, base + 20),
        llx: readS32LE(data, base + 24),
        lly: readS32LE(data, base + 28),
        mask: readU32LE(data, base + 32) & 0xff,
        flags: readU32LE(data, base + 36) & 0xff,
        // Expressed the way every other Version writes it, so nothing
        // downstream has to learn that v8 has two fields here: the top bit
        // names a slot, and the slot is one-based in both readings.
        scale:
          readU32LE(data, base + 40) !== 0
            ? 0x8000 | ((readU32LE(data, base + 40) - 1) & 0x7fff)
            : readU32LE(data, base + 44) & 0xffff,
      });
      continue;
    }

    if (version <= 2) {
      // v2 stores six bytes rather than eight coordinates: the two y values,
      // then the four x values, which is enough because its boxes are
      // trapezoids with horizontal top and bottom edges.
      const uy = data[base];
      const ly = data[base + 1];
      boxes.push({
        ulx: data[base + 2] * 8,
        uly: uy * 8,
        urx: data[base + 3] * 8,
        ury: uy * 8,
        lrx: data[base + 5] * 8,
        lry: ly * 8,
        llx: data[base + 4] * 8,
        lly: ly * 8,
        mask: data[base + 6],
        flags: data[base + 7],
        scale: 255,
      });
      continue;
    }

    boxes.push({
      ulx: readS16LE(data, base),
      uly: readS16LE(data, base + 2),
      urx: readS16LE(data, base + 4),
      ury: readS16LE(data, base + 6),
      lrx: readS16LE(data, base + 8),
      lry: readS16LE(data, base + 10),
      llx: readS16LE(data, base + 12),
      lly: readS16LE(data, base + 14),
      mask: data[base + 16],
      flags: data[base + 17],
      // v3's box ends at the flags; anything scaled there is scaled by a
      // `SA` slot rather than by the box, so the default is "no scaling".
      scale: version === 3 ? 255 : readU16LE(data, base + 18),
    });
  }
  return boxes;
}

/**
 * SCAL: four slots of (scale, y) pairs. An all-zero slot is unused.
 *
 * Eight bytes a slot before v8 and sixteen at it, for the same four fields at
 * twice the width. (`ScummEngine::setupRoomSubBlocks`, whose v8 arm steps the
 * pointer by 16 rather than by 8.)
 */
function parseScaleSlots(data: Uint8Array, chunk: Chunk, version: number): ScaleSlot[] {
  const slots: ScaleSlot[] = [];
  const stride = version >= 8 ? 16 : 8;
  const count = Math.floor(chunk.dataSize / stride);
  for (let i = 0; i < count; i++) {
    const base = chunk.dataOffset + i * stride;
    const read = version >= 8 ? readU32LE : readU16LE;
    const step = version >= 8 ? 4 : 2;
    slots.push({
      scale1: read(data, base),
      y1: read(data, base + step),
      scale2: read(data, base + step * 2),
      y2: read(data, base + step * 3),
      x1: 0,
      x2: 0,
    });
  }
  return slots;
}
