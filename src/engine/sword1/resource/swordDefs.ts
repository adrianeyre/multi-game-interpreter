/**
 * The constants and record shapes Broken Sword's own data is written in.
 *
 * One module rather than constants scattered through the engine, for the reason
 * `CONTEXT.md` gives about a Version: the numbers here are *the format*, and a
 * second copy of one of them is a second place for the format to drift.
 *
 * Everything is little-endian on the PC releases. The Macintosh release stores
 * its cluster contents big-endian while keeping `swordres.rif` little-endian
 * (see `rif.ts`), which is why the readers below take an explicit endianness
 * rather than assuming one — a reader that assumes produces plausible garbage
 * instead of an error.
 */

/** The game area, in the game's own coordinates. 640x400 inside a 640x480 display. */
export const SWORD1_SCREEN_WIDTH = 640;
export const SWORD1_SCREEN_DEPTH = 400;
/** Including the 40-pixel bars top and bottom that the menus live in. */
export const SWORD1_SCREEN_FULL_DEPTH = 480;
export const SWORD1_MENU_BAR_HEIGHT = 40;

/**
 * The game's own coordinate origin, which is not the screen's.
 *
 * Broken Sword's scripts place things in a space offset by 128 in both axes, so
 * a compact at (128, 128) is at the top-left visible pixel. Subtracting these is
 * the whole of the conversion and forgetting to is a 128-pixel diagonal error
 * that still draws — the worst kind.
 */
export const SWORD1_SCREEN_LEFT_EDGE = 128;
export const SWORD1_SCREEN_TOP_EDGE = 128;

/** Sections are groups; `ITM_PER_SEC` is the width of a resource id's index field. */
export const SWORD1_TOTAL_SECTIONS = 150;
export const SWORD1_TOTAL_ROOMS = 100;
export const SWORD1_ITM_PER_SEC = 0x10000;
export const SWORD1_ITM_ID = 0xffff;

/** Text compacts live here, after all the megas. */
export const SWORD1_TEXT_SECT = 149;
export const SWORD1_MAX_TEXT_OBS = 2;

/** The player's compact id — George, and the id every mega script starts from. */
export const SWORD1_PLAYER = 8388608;

/** `o_type`: what kind of thing a compact is. */
export const SwordType = {
  FLOOR: 1,
  MOUSE: 2,
  SPRITE: 3,
  NON_MEGA: 4,
  MEGA: 5,
  PLAYER: 6,
  TEXT: 7,
} as const;

/** `o_status`: the bit flags that decide logic, drawing and mouse handling. */
export const SwordStatus = {
  MOUSE: 1,
  LOGIC: 2,
  EVENTS: 4,
  FORE: 8,
  BACK: 16,
  SORT: 32,
  SHRINK: 64,
  BOOKMARK: 128,
  TALK_WAIT: 256,
  OVERRIDE: 512,
} as const;

/**
 * `o_logic`: which driver runs a compact this cycle.
 *
 * Not an enum of script opcodes — this is the compact's *mode*, and the script
 * changes it by writing the field. `LOGIC_script` is the one that runs bytecode;
 * everything else is a driver in `SwordLogic` that eventually sets it back.
 */
export const SwordLogicMode = {
  IDLE: 0,
  SCRIPT: 1,
  AR_ANIMATE: 2,
  INTERACTION: 3,
  SPEECH: 4,
  FULL_ANIM: 5,
  ANIM: 6,
  PAUSE: 7,
  WAIT_FOR_SYNC: 8,
  QUIT: 9,
  RESTART: 10,
  BOOKMARK: 11,
  WAIT_FOR_TALK: 12,
  START_TALK: 13,
  CHOOSE: 14,
  NEW_SCRIPT: 15,
  PAUSE_FOR_EVENT: 16,
} as const;

/** The eight compass directions a mega faces; `STAND` shares 0 with `UP`. */
export const SWORD1_DIRECTIONS = 8;

/**
 * `CHANGE_STANCE`'s "stand still" value, which is `UP`'s zero.
 *
 * Named separately from the direction it shares a number with because the two
 * are read by different globals: a start position writes `STAND` into
 * `CHANGE_STANCE` and a compass direction into `CHANGE_DIR`, and one constant
 * doing both jobs is how they get swapped.
 */
export const SWORD1_STAND = 0;

/** George's default talk table, which a start position resets him to. */
export const SWORD1_GEO_TLK_TABLE = 0x02010001;

/** How many script levels a compact's logic tree carries. */
export const SWORD1_SCRIPT_LEVELS = 5;
/** How many event slots a compact subscribes with. */
export const SWORD1_TOTAL_EVENTS = 5;
/** The router's output buffer, in nodes. Fixes `Object`'s size. */
export const SWORD1_WALKANIM_SIZE = 600;

/** The `Header` every cluster resource begins with. 20 bytes. */
export const SWORD1_HEADER_SIZE = 20;

export interface SwordHeader {
  /** `Script`, `File`, `Anim`, … — six bytes, NUL-padded. */
  readonly type: string;
  readonly version: number;
  readonly compLength: number;
  readonly compression: string;
  readonly decompLength: number;
}

function latin1(bytes: Uint8Array, at: number, length: number): string {
  let end = at;
  while (end < at + length && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(at, end));
}

/** Reads the 20-byte resource header. `big` for the Macintosh clusters. */
export function readSwordHeader(bytes: Uint8Array, big = false): SwordHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: latin1(bytes, 0, 6),
    version: view.getUint16(6, !big),
    compLength: view.getUint32(8, !big),
    compression: latin1(bytes, 12, 4),
    decompLength: view.getUint32(16, !big),
  };
}

/**
 * The per-frame header inside a sprite resource. 16 bytes.
 *
 * Sixteen and not twelve: `width`/`height` are a `uint16` pair at 8 and 10, and
 * `offsetX`/`offsetY` a signed pair at 12 and 14. They are separate fields, and
 * reading the offsets from the size fields is a mistake that draws — every
 * sprite lands at its own width and height away from where it belongs.
 */
export const SWORD1_FRAME_HEADER_SIZE = 16;

export interface SwordFrameHeader {
  /** Four bytes; the last is `7`, `0` or `T` and selects the decoder. */
  readonly runTimeComp: string;
  readonly compSize: number;
  readonly width: number;
  readonly height: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export function readSwordFrameHeader(bytes: Uint8Array, at: number, big = false): SwordFrameHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    runTimeComp: new TextDecoder('latin1').decode(bytes.subarray(at, at + 4)),
    compSize: view.getUint32(at + 4, !big),
    width: view.getUint16(at + 8, !big),
    height: view.getUint16(at + 10, !big),
    offsetX: view.getInt16(at + 12, !big),
    offsetY: view.getInt16(at + 14, !big),
  };
}

/** One frame of a sprite resource: where it sits, its header, and its bytes. */
export interface Sword1SpriteFrame {
  readonly index: number;
  /** The frame header's offset into the resource. */
  readonly at: number;
  readonly header: SwordFrameHeader;
  /** Exactly `compSize` bytes, which is what the decoder is handed. */
  readonly data: Uint8Array;
}

/**
 * Walks a sprite resource's frame table.
 *
 * ```text
 * Header   20 bytes
 * uint32   frameCount
 * uint32[] frameOffset   frameCount of them, from the resource's start
 * …        per frame: a 16-byte FrameHeader, then compSize bytes
 * ```
 *
 * One walker rather than the same arithmetic in the renderer, the editor and
 * the sweep. A frame whose offset or size runs past the resource is skipped
 * rather than throwing: the caller wants the frames that are there.
 */
export function sword1SpriteFrames(bytes: Uint8Array, big = false): Sword1SpriteFrame[] {
  if (bytes.length < SWORD1_HEADER_SIZE + 8) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(SWORD1_HEADER_SIZE, !big);
  // A table of `count + 1` offsets needs to fit before the first frame does.
  if (count === 0 || SWORD1_HEADER_SIZE + 4 + (count + 1) * 4 > bytes.length) return [];
  const frames: Sword1SpriteFrame[] = [];
  for (let index = 0; index < count; index++) {
    const at = view.getUint32(SWORD1_HEADER_SIZE + (index + 1) * 4, !big);
    if (at + SWORD1_FRAME_HEADER_SIZE > bytes.length) continue;
    const header = readSwordFrameHeader(bytes, at, big);
    const from = at + SWORD1_FRAME_HEADER_SIZE;
    if (from + header.compSize > bytes.length) continue;
    frames.push({ index, at, header, data: bytes.subarray(from, from + header.compSize) });
  }
  return frames;
}

/**
 * The parallax header: sixteen bytes of type tag, then a size.
 *
 * The tag is what tells a parallax from a background, and reading it rather
 * than assuming is what keeps a malformed resource from being drawn as pixels.
 */
export const SWORD1_PARALLAX_HEADER_SIZE = 20;

export interface SwordParallaxHeader {
  readonly type: string;
  readonly sizeX: number;
  readonly sizeY: number;
}

export function readSwordParallaxHeader(
  bytes: Uint8Array,
  at: number,
  big = false,
): SwordParallaxHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: latin1(bytes, at, 16),
    sizeX: view.getUint16(at + 16, !big),
    sizeY: view.getUint16(at + 18, !big),
  };
}

/** One entry of an animation table: where to put a frame, and which frame. */
export interface SwordAnimUnit {
  readonly animX: number;
  readonly animY: number;
  readonly animFrame: number;
}

/** The walk grid's header: the scale ramp and how much geometry follows. */
export interface SwordWalkGridHeader {
  readonly scaleA: number;
  readonly scaleB: number;
  readonly numBars: number;
  readonly numNodes: number;
}

export function readSwordWalkGridHeader(
  bytes: Uint8Array,
  at: number,
  big = false,
): SwordWalkGridHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    scaleA: view.getInt32(at, !big),
    scaleB: view.getInt32(at + 4, !big),
    numBars: view.getInt32(at + 8, !big),
    numNodes: view.getInt32(at + 12, !big),
  };
}

/** The languages a release may carry subtitles for, in the game's own order. */
export const SWORD1_LANGUAGES = [
  'english',
  'french',
  'german',
  'italian',
  'spanish',
  'czech',
  'portuguese',
] as const;

export type Sword1Language = (typeof SWORD1_LANGUAGES)[number];

/**
 * Named resource ids the engine reaches for by name rather than through a
 * section table.
 *
 * Four, and each is a thing the interpreter owns rather than a thing a room
 * has: the font it draws subtitles with, the Czech release's own font (which is
 * HIF-compressed where the others are not), and the two control-panel fonts.
 * They are here rather than in the generated tables because they are named in
 * code, and a name in code wants a constant beside it.
 *
 * ## These four are checked, and the two next to them are not the same fonts
 *
 * `swordres.h` puts eight ids in a row at `0x0400000n` and it is easy to read
 * the wrong one out of the block. The four below are the four ScummVM actually
 * fetches, at the lines that fetch them:
 *
 * - `GAME_FONT 0x04000000` — `text.cpp:52`, `_fontId = czechVersion ?
 *   CZECH_GAME_FONT : GAME_FONT`.
 * - `CZECH_GAME_FONT 0x04000004` — the other arm of that line, and the one
 *   `text.cpp:239` tests for to decompress.
 * - `SR_FONT 0x04050000` and `SR_REDFONT 0x04050002` — `control.cpp:639` and
 *   `:709`, the save/restore panel's own two.
 *
 * `0x04000001` and `0x04000005` are `OTHER_SR_FONT` and `CZECH_SR_FONT`: a
 * *different pair of fonts* for a different panel, and neither is shipped in
 * the English demo at all — measured, they are index 1 and 5 of `GENERAL`
 * group 0, which declares one slot. Setting either as the game font loses the
 * subtitles entirely, where the ids below fetch 70,414 bytes each.
 */
export const SWORD1_GAME_FONT = 0x04000000;
export const SWORD1_CZECH_GAME_FONT = 0x04000004;
export const SWORD1_SR_FONT = 0x04050000;
export const SWORD1_SR_REDFONT = 0x04050002;
