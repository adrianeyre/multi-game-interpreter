/**
 * A Broken Sword **compact** — the record one object in the world is made of.
 *
 * ## Why the byte offsets are the interface
 *
 * Broken Sword's bytecode reaches into a compact by *byte offset*:
 * `IT_PUSHLONGOFFSET 44` pushes the object's x coordinate, and
 * `IT_POPLONGOFFSET 8` writes its logic mode. The offsets are compiled into
 * every shipped script, so they are part of the format in exactly the way an
 * opcode number is — a layout off by one field is not a slightly wrong reading,
 * it is every script writing the wrong member.
 *
 * That is why this module names the offsets and why nothing here is free to
 * move. It also decides the representation: a compact is a flat run of 3,085
 * signed 32-bit words, so an `Int32Array` view over the bytes *is* the record,
 * and `word = offset / 4` is the whole of the address translation. Typed
 * accessors sit on top for the engine's own readability; the script sees the
 * words.
 *
 * ## What a compact resource looks like
 *
 * A section's compacts arrive as one resource in `COMPACTS.CLU`:
 *
 * ```text
 * Header      20 bytes
 * uint32      objectCount
 * uint32[]    objectOffset      one per object, from the start of this table
 * …           the compacts themselves
 * ```
 *
 * The offset table is indexed from **one** — entry 0 is the count — which is
 * ScummVM's `addr + (id + 1) * 4` and the reason `compactOffset` adds one.
 *
 * ## Endianness
 *
 * The Macintosh release stores compacts big-endian; the PC releases little.
 * ScummVM byte-swaps the whole resource on load and then says "DON'T do endian
 * conversion here. it's already done." This module does the same: `readCompacts`
 * normalises once, and everything downstream is host-order words.
 */

import { SWORD1_HEADER_SIZE, SWORD1_WALKANIM_SIZE } from './swordDefs.js';

/**
 * Byte offsets of the fields the scripts and the engine name.
 *
 * The comments are the field's own name in Revolution's header, kept because a
 * script listing reads `o_ycoord` and a person matching a listing to this table
 * should not have to translate.
 */
export const CPT = {
  /** `o_type` — floor, mouse, sprite, non-mega, mega, player or text. */
  TYPE: 0,
  /** `o_status` — the bit flags for logic, drawing and mouse. */
  STATUS: 4,
  /** `o_logic` — which driver runs this compact. */
  LOGIC: 8,
  /** `o_place` — the floor a mega is standing on. */
  PLACE: 12,
  /** `o_down_flag` — an mcode's return value, passed back to the script. */
  DOWN_FLAG: 16,
  /** `o_target` — the object a get-to is heading for. */
  TARGET: 20,
  /** `o_screen` — which screen (room) this compact is on. */
  SCREEN: 24,
  /** `o_frame` — the frame within its sprite resource. */
  FRAME: 28,
  /** `o_resource` — the sprite resource id. */
  RESOURCE: 32,
  /** `o_sync` — a sync received this cycle; cleared at the end of it. */
  SYNC: 36,
  /** `o_pause` — cycles left on a `fnPause`. */
  PAUSE: 40,
  /** `o_xcoord` — in the game's 128-offset space, not the screen's. */
  XCOORD: 44,
  YCOORD: 48,
  MOUSE_X1: 52,
  MOUSE_Y1: 56,
  MOUSE_X2: 60,
  MOUSE_Y2: 64,
  PRIORITY: 68,
  MOUSE_ON: 72,
  MOUSE_OFF: 76,
  MOUSE_CLICK: 80,
  INTERACT: 84,
  GET_TO_SCRIPT: 88,
  /** `o_scale_a`/`o_scale_b` — the floor's scale ramp, `y * a + b`. */
  SCALE_A: 92,
  SCALE_B: 96,
  ANIM_X: 100,
  ANIM_Y: 104,
  /** `o_tree` — the logic tree: a level, and an id and pc per level. */
  TREE: 108,
  /** `o_bookmark` — a copy of the tree, for `fnSetBookmark`. */
  BOOKMARK: 152,
  DIR: 196,
  SPEECH_PEN: 200,
  SPEECH_WIDTH: 204,
  SPEECH_TIME: 208,
  TEXT_ID: 212,
  TAG: 216,
  ANIM_PC: 220,
  ANIM_RESOURCE: 224,
  WALK_PC: 228,
  /** `talk_table[6]` — six (x, y) pairs a speaker's text is placed by. */
  TALK_TABLE: 232,
  /** `o_event_list[5]` — five (event, script) pairs this compact subscribes to. */
  EVENT_LIST: 280,
  INS1: 320,
  INS2: 324,
  INS3: 328,
  MEGA_RESOURCE: 332,
  WALK_RESOURCE: 336,
  /** `o_route[600]` — the router's output, five words per node. */
  ROUTE: 340,
} as const;

/** A tree's fields, relative to `CPT.TREE` or `CPT.BOOKMARK`. */
export const TREE = {
  LEVEL: 0,
  /** Five script ids follow the level, then five program counters. */
  SCRIPT_ID: 4,
  SCRIPT_PC: 24,
} as const;

/** One route node: five words. */
export const ROUTE_NODE_WORDS = 5;

/** The whole record, in bytes. Fixed by `o_route`'s 600 nodes. */
export const SWORD1_COMPACT_SIZE = CPT.ROUTE + SWORD1_WALKANIM_SIZE * ROUTE_NODE_WORDS * 4;

/** The whole record, in 32-bit words. What a script's offsets index. */
export const SWORD1_COMPACT_WORDS = SWORD1_COMPACT_SIZE / 4;

/**
 * One compact, as the script sees it and as the engine reads it.
 *
 * A window onto the section's bytes rather than a copy: an mcode that moves an
 * object and a script that reads its position afterwards must see the same
 * word, and saving a game writes the section's bytes straight out.
 */
export class SwordCompact {
  /** Words of this compact, aliasing the section's buffer. */
  readonly words: Int32Array;

  constructor(
    words: Int32Array,
    /** `section * 0x10000 + index` — the id scripts and logs use. */
    readonly id: number,
  ) {
    this.words = words;
  }

  /** Reads the word at a byte offset, which is what the bytecode asks for. */
  get(offset: number): number {
    return this.words[offset >> 2] ?? 0;
  }

  /** Writes the word at a byte offset. Out of range is dropped, not thrown. */
  set(offset: number, value: number): void {
    const at = offset >> 2;
    if (at >= 0 && at < this.words.length) this.words[at] = value | 0;
  }

  get type(): number {
    return this.get(CPT.TYPE);
  }
  get status(): number {
    return this.get(CPT.STATUS);
  }
  set status(value: number) {
    this.set(CPT.STATUS, value);
  }
  get logic(): number {
    return this.get(CPT.LOGIC);
  }
  set logic(value: number) {
    this.set(CPT.LOGIC, value);
  }
  get screen(): number {
    return this.get(CPT.SCREEN);
  }
  set screen(value: number) {
    this.set(CPT.SCREEN, value);
  }
  get x(): number {
    return this.get(CPT.XCOORD);
  }
  set x(value: number) {
    this.set(CPT.XCOORD, value);
  }
  get y(): number {
    return this.get(CPT.YCOORD);
  }
  set y(value: number) {
    this.set(CPT.YCOORD, value);
  }
  get frame(): number {
    return this.get(CPT.FRAME);
  }
  set frame(value: number) {
    this.set(CPT.FRAME, value);
  }
  get resource(): number {
    return this.get(CPT.RESOURCE);
  }
  set resource(value: number) {
    this.set(CPT.RESOURCE, value);
  }
  get sync(): number {
    return this.get(CPT.SYNC);
  }
  set sync(value: number) {
    this.set(CPT.SYNC, value);
  }
  get pause(): number {
    return this.get(CPT.PAUSE);
  }
  set pause(value: number) {
    this.set(CPT.PAUSE, value);
  }
  get priority(): number {
    return this.get(CPT.PRIORITY);
  }
  get dir(): number {
    return this.get(CPT.DIR);
  }
  set dir(value: number) {
    this.set(CPT.DIR, value);
  }

  /** The current logic level in the tree. */
  get scriptLevel(): number {
    return this.get(CPT.TREE + TREE.LEVEL);
  }
  set scriptLevel(value: number) {
    this.set(CPT.TREE + TREE.LEVEL, value);
  }

  scriptId(level: number): number {
    return this.get(CPT.TREE + TREE.SCRIPT_ID + level * 4);
  }
  setScriptId(level: number, value: number): void {
    this.set(CPT.TREE + TREE.SCRIPT_ID + level * 4, value);
  }
  scriptPc(level: number): number {
    return this.get(CPT.TREE + TREE.SCRIPT_PC + level * 4);
  }
  setScriptPc(level: number, value: number): void {
    this.set(CPT.TREE + TREE.SCRIPT_PC + level * 4, value);
  }

  /** Copies the tree into the bookmark, or back. `fnSetBookmark`/`fnGotoBookmark`. */
  copyTree(fromOffset: number, toOffset: number): void {
    for (let at = 0; at < 44; at += 4) this.set(toOffset + at, this.get(fromOffset + at));
  }
}

/** A section's compacts, as one buffer with an index into it. */
export interface SwordCompactSection {
  readonly section: number;
  /** The whole resource's payload, after the 20-byte header. Host-order words. */
  readonly words: Int32Array;
  /** How many objects the section declares. */
  readonly count: number;
  /** Word index of each object's first word, by object index. */
  readonly offsets: readonly number[];
}

/** Raised with something a person can act on. */
export class SwordCompactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwordCompactError';
  }
}

/**
 * Reads a compact resource into host-order words with an index.
 *
 * `big` selects the Macintosh clusters' byte order. The swap happens exactly
 * once, here, which is ScummVM's arrangement and the reason nothing downstream
 * asks which platform it is on.
 */
export function readCompactSection(
  bytes: Uint8Array,
  section: number,
  big = false,
): SwordCompactSection {
  if (bytes.length <= SWORD1_HEADER_SIZE) {
    throw new SwordCompactError(
      `Section ${section}'s compact resource is ${bytes.length} bytes, which is not long enough ` +
        `to hold even its own header.`,
    );
  }
  const payload = bytes.subarray(SWORD1_HEADER_SIZE);
  if (payload.length % 4 !== 0) {
    throw new SwordCompactError(
      `Section ${section}'s compact resource has ${payload.length} bytes after its header, ` +
        `which is not a whole number of 32-bit words. ScummVM refuses this too — a compact ` +
        `resource is words all the way down.`,
    );
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const words = new Int32Array(payload.length / 4);
  for (let at = 0; at < words.length; at++) words[at] = view.getInt32(at * 4, !big);

  const count = words[0] >>> 0;
  if (count === 0 || count + 1 > words.length) {
    throw new SwordCompactError(
      `Section ${section} declares ${count} objects, which does not fit in the ${words.length} ` +
        `words its compact resource holds.`,
    );
  }

  const offsets: number[] = [];
  for (let index = 0; index < count; index++) {
    // The table is one-based: word 0 is the count, so object `index` is at
    // word `index + 1`. Its value is a *byte* offset from the table's start.
    const byteOffset = words[index + 1] >>> 0;
    offsets.push(byteOffset >> 2);
  }

  return { section, words, count, offsets };
}

/**
 * A window onto one object, or null when the section does not hold it.
 *
 * Null rather than throwing: a script may name an object in a section that a
 * localised build ships without, and the engine's answer to that is to skip the
 * object rather than to stop the game.
 */
export function compactIn(section: SwordCompactSection, index: number): SwordCompact | null {
  if (index < 0 || index >= section.count) return null;
  const start = section.offsets[index];
  if (start === undefined) return null;
  // Short-tail tolerance: a section whose last compact is a text compact can be
  // shorter than a full mega, because `o_route` is only written for megas. The
  // words that exist are the words the scripts touch.
  const end = Math.min(start + SWORD1_COMPACT_WORDS, section.words.length);
  if (end <= start) return null;
  return new SwordCompact(section.words.subarray(start, end), section.section * 0x10000 + index);
}
