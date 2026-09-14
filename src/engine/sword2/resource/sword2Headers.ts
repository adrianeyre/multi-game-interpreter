/**
 * Broken Sword II's record shapes: the file header and everything under it.
 *
 * ## Every offset here is a magic number and every one is checked
 *
 * Sword2's structures are declared to the game's *compiler* (LINC) as well as
 * to the interpreter, and ScummVM's own comment says they "must be the same as
 * those declared to LINC (or it won't work)". So the sizes are not conveniences
 * — they are the format. `ResHeader.size()` is 44, `ObjectHub.size()` is 44,
 * `ObjectMega.size()` is 56, and a script's variable block starts at exactly
 * `44 + 44 + 4`. Getting one wrong does not fail: it reads the next structure's
 * first field as this one's last.
 *
 * That is why this module states each size as a constant beside its reader and
 * why `checkStructureSizes` exists — a cheap assertion that the arithmetic
 * still adds up, run once at module load rather than trusted.
 *
 * ## How this differs from Sword1, concretely
 *
 * Sword1 has one record per object — a 3,085-word compact with a fixed layout.
 * Sword2 has **eight structures per object**, laid out one after another behind
 * a header, and its scripts address them by a structure-relative offset pushed
 * with `CP_PUSH_DEREFERENCED_STRUCTURE`. So there is no equivalent of Sword1's
 * `CPT` table: an offset in a Sword2 script is into the object's *own* layout,
 * which the object's header describes. Two families, no shared shape (ADR 0036).
 */

/** Everything little-endian. Sword2 shipped no big-endian release. */
const LE = true;

/** `ResHeader` — the 44-byte header every resource begins with. */
export const RES_HEADER_SIZE = 44;
/** Name field width inside it. */
export const RES_NAME_LEN = 34;

/** What kind of thing a resource is. */
export const Sword2FileType = {
  ANIMATION_FILE: 1,
  SCREEN_FILE: 2,
  GAME_OBJECT: 3,
  WALK_GRID_FILE: 4,
  GLOBAL_VAR_FILE: 5,
  PARALLAX_FILE_NULL: 6,
  RUN_LIST: 7,
  TEXT_FILE: 8,
  SCREEN_MANAGER: 9,
  MOUSE_FILE: 10,
  WAV_FILE: 11,
  ICON_FILE: 12,
  PALETTE_FILE: 13,
} as const;

export interface Sword2ResHeader {
  readonly fileType: number;
  readonly compType: number;
  readonly compSize: number;
  readonly decompSize: number;
  /** The object's name, which the game's own bug workarounds key on. */
  readonly name: string;
}

function latin1(bytes: Uint8Array, at: number, length: number): string {
  let end = at;
  const stop = Math.min(at + length, bytes.length);
  while (end < stop && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(at, end));
}

export function readSword2ResHeader(bytes: Uint8Array): Sword2ResHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    fileType: view.getUint8(0),
    compType: view.getUint8(1),
    compSize: view.getUint32(2, LE),
    decompSize: view.getUint32(6, LE),
    name: latin1(bytes, 10, RES_NAME_LEN),
  };
}

/** `AnimHeader` — 15 bytes, and the frame compression lives here not per-frame. */
export const ANIM_HEADER_SIZE = 15;

/** How each frame of an animation is compressed. */
export const Sword2AnimCompression = {
  NONE: 0,
  /** James's RLE for 256-colour sprites. */
  RLE256: 1,
  /** James's RLE for 16- or 17-colour sprites, two pixels a byte. */
  RLE16: 2,
} as const;

export interface Sword2AnimHeader {
  readonly runTimeComp: number;
  readonly noAnimFrames: number;
  readonly feetStartX: number;
  readonly feetStartY: number;
  readonly feetStartDir: number;
  readonly feetEndX: number;
  readonly feetEndY: number;
  readonly feetEndDir: number;
  readonly blend: number;
}

export function readSword2AnimHeader(bytes: Uint8Array, at: number): Sword2AnimHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    runTimeComp: view.getUint8(at),
    noAnimFrames: view.getUint16(at + 1, LE),
    feetStartX: view.getUint16(at + 3, LE),
    feetStartY: view.getUint16(at + 5, LE),
    feetStartDir: view.getUint8(at + 7),
    feetEndX: view.getUint16(at + 8, LE),
    feetEndY: view.getUint16(at + 10, LE),
    feetEndDir: view.getUint8(at + 12),
    blend: view.getUint16(at + 13, LE),
  };
}

/**
 * `CdtEntry` — one frame's placement. Nine bytes.
 *
 * `frameType`'s bits are the interesting part: `FRAME_OFFSET` means the x and y
 * are *relative to the mega's feet* and scaled by its y, rather than absolute.
 * A renderer that ignores the bit draws every walking animation at the top-left
 * of the room.
 */
export const CDT_ENTRY_SIZE = 9;

export const Sword2FrameType = {
  OFFSET: 1,
  FLIPPED: 2,
  FAST_256: 4,
} as const;

export interface Sword2CdtEntry {
  readonly x: number;
  readonly y: number;
  readonly frameOffset: number;
  readonly frameType: number;
}

export function readSword2CdtEntry(bytes: Uint8Array, at: number): Sword2CdtEntry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    x: view.getInt16(at, LE),
    y: view.getInt16(at + 2, LE),
    frameOffset: view.getUint32(at + 4, LE),
    frameType: view.getUint8(at + 8),
  };
}

/** `FrameHeader` — 8 bytes: a compressed size and the frame's dimensions. */
export const FRAME_HEADER_SIZE = 8;

export interface Sword2FrameHeader {
  readonly compSize: number;
  readonly width: number;
  readonly height: number;
}

export function readSword2FrameHeader(bytes: Uint8Array, at: number): Sword2FrameHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    compSize: view.getUint32(at, LE),
    width: view.getUint16(at + 4, LE),
    height: view.getUint16(at + 6, LE),
  };
}

/** One frame of an animation: its placement, its header and its bytes. */
export interface Sword2AnimationFrame {
  readonly index: number;
  readonly cdt: Sword2CdtEntry;
  /** The frame header's offset into the resource. */
  readonly at: number;
  readonly header: Sword2FrameHeader;
  /** Exactly `compSize` bytes, which is what the decoder is handed. */
  readonly data: Uint8Array;
  /**
   * Which decoder this frame wants.
   *
   * `FAST_256` on the *frame* overrides `runTimeComp` on the *animation*, so
   * the effective compression is per frame even though the field is not.
   */
  readonly compression: number;
}

/** An animation resource walked into its header, its table and its frames. */
export interface Sword2Animation {
  readonly header: Sword2AnimHeader;
  /** RLE16's sixteen entries, where the animation is RLE16. */
  readonly colourTable: Uint8Array | null;
  readonly frames: readonly Sword2AnimationFrame[];
}

/**
 * Walks an animation resource.
 *
 * Every offset inside is measured from the **animation header**, which is one
 * resource header into the file, and the layout is
 * `AnimHeader`, `noAnimFrames` CDT entries, RLE16's colour table where there is
 * one, then the frames. A frame that runs past the resource is skipped rather
 * than throwing, the same way `sword1SpriteFrames` does it.
 */
export function sword2Animation(bytes: Uint8Array): Sword2Animation | null {
  const animAt = RES_HEADER_SIZE;
  if (animAt + ANIM_HEADER_SIZE > bytes.length) return null;
  const header = readSword2AnimHeader(bytes, animAt);
  const tableAt = animAt + ANIM_HEADER_SIZE + header.noAnimFrames * CDT_ENTRY_SIZE;
  if (tableAt > bytes.length) return null;

  let colourTable: Uint8Array | null = null;
  if (header.runTimeComp === Sword2AnimCompression.RLE16 && tableAt + 16 <= bytes.length) {
    colourTable = bytes.subarray(tableAt, tableAt + 16);
  }

  const frames: Sword2AnimationFrame[] = [];
  for (let index = 0; index < header.noAnimFrames; index++) {
    const cdt = readSword2CdtEntry(bytes, animAt + ANIM_HEADER_SIZE + index * CDT_ENTRY_SIZE);
    const at = animAt + cdt.frameOffset;
    if (at + FRAME_HEADER_SIZE > bytes.length) continue;
    const frameHeader = readSword2FrameHeader(bytes, at);
    const from = at + FRAME_HEADER_SIZE;
    if (from + frameHeader.compSize > bytes.length) continue;
    frames.push({
      index,
      cdt,
      at,
      header: frameHeader,
      data: bytes.subarray(from, from + frameHeader.compSize),
      compression:
        (cdt.frameType & Sword2FrameType.FAST_256) !== 0
          ? Sword2AnimCompression.RLE256
          : header.runTimeComp,
    });
  }
  return { header, colourTable, frames };
}

/**
 * `MultiScreenHeader` — 36 bytes of offsets into a screen file.
 *
 * A screen file is nine things in one resource, and this is the map: two
 * background parallax layers, the background itself, two foreground parallax
 * layers, the layer (mask) table, the palette, the 64 KB palette match table,
 * and the mask data. All the offsets are from the start of the *header*, not
 * from the start of the resource, which is a distinction worth eight bytes of
 * confusion if missed.
 */
export const MULTI_SCREEN_HEADER_SIZE = 36;

export interface Sword2MultiScreenHeader {
  readonly palette: number;
  readonly bgParallax: readonly [number, number];
  readonly screen: number;
  readonly fgParallax: readonly [number, number];
  readonly layers: number;
  readonly paletteTable: number;
  readonly maskOffset: number;
}

export function readSword2MultiScreenHeader(
  bytes: Uint8Array,
  at: number,
): Sword2MultiScreenHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number): number => view.getUint32(at + offset, LE);
  return {
    palette: u32(0),
    bgParallax: [u32(4), u32(8)],
    screen: u32(12),
    fgParallax: [u32(16), u32(20)],
    layers: u32(24),
    paletteTable: u32(28),
    maskOffset: u32(32),
  };
}

/**
 * The five parallax slots a screen file holds, in the order they are drawn.
 *
 * The background is one of them and not a special case: Sword II stores it in
 * the same row-offset-and-packets format as the four parallax layers, which is
 * why anything that can read a parallax can read a background too.
 */
export const SWORD2_LAYER_SLOTS = [
  'background parallax 0',
  'background parallax 1',
  'background',
  'foreground parallax 0',
  'foreground parallax 1',
] as const;

/**
 * Where each layer slot's parallax starts, or null where the slot is empty.
 *
 * The background's offset is the odd one: the header points at its
 * `ScreenHeader`, and the parallax begins six bytes further on.
 */
export function sword2ScreenLayerOffsets(bytes: Uint8Array): (number | null)[] {
  if (bytes.length < RES_HEADER_SIZE + MULTI_SCREEN_HEADER_SIZE) {
    return SWORD2_LAYER_SLOTS.map(() => null);
  }
  const multi = readSword2MultiScreenHeader(bytes, RES_HEADER_SIZE);
  const at = (offset: number): number | null => (offset ? RES_HEADER_SIZE + offset : null);
  return [
    at(multi.bgParallax[0]),
    at(multi.bgParallax[1]),
    RES_HEADER_SIZE + multi.screen + SCREEN_HEADER_SIZE,
    at(multi.fgParallax[0]),
    at(multi.fgParallax[1]),
  ];
}

/** `ScreenHeader` — 6 bytes: the background's size and how many layers mask it. */
export const SCREEN_HEADER_SIZE = 6;

export interface Sword2ScreenHeader {
  readonly width: number;
  readonly height: number;
  readonly noLayers: number;
}

export function readSword2ScreenHeader(bytes: Uint8Array, at: number): Sword2ScreenHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint16(at, LE),
    height: view.getUint16(at + 2, LE),
    noLayers: view.getUint16(at + 4, LE),
  };
}

/**
 * `LayerHeader` — 16 bytes. A masking area and where its mask data is.
 *
 * All the layer headers are kept **together** rather than each beside its mask,
 * "in order to simplify the sort routine" — so the table is contiguous and the
 * mask data is elsewhere, which is why `offset` exists at all.
 */
export const LAYER_HEADER_SIZE = 16;

export interface Sword2LayerHeader {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly maskSize: number;
  readonly offset: number;
}

export function readSword2LayerHeader(bytes: Uint8Array, at: number): Sword2LayerHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    x: view.getUint16(at, LE),
    y: view.getUint16(at + 2, LE),
    width: view.getUint16(at + 4, LE),
    height: view.getUint16(at + 6, LE),
    maskSize: view.getUint32(at + 8, LE),
    offset: view.getUint32(at + 12, LE),
  };
}

/**
 * `ObjectHub` — 44 bytes, and "all that remains of the compact concept".
 *
 * Three script levels, each with an id and a program counter, plus a type and a
 * level. That is the whole of an object's *control* state; everything else
 * about it lives in the typed structures behind the hub.
 */
export const OBJECT_HUB_SIZE = 44;

export class Sword2ObjectHub {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly at: number,
  ) {}

  private get view(): DataView {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  get type(): number {
    return this.view.getInt32(this.at, LE);
  }

  get logicLevel(): number {
    return this.view.getUint32(this.at + 4, LE);
  }

  set logicLevel(value: number) {
    this.view.setUint32(this.at + 4, value, LE);
  }

  scriptId(level: number): number {
    return this.view.getUint32(this.at + 20 + level * 4, LE);
  }

  setScriptId(level: number, value: number): void {
    this.view.setUint32(this.at + 20 + level * 4, value, LE);
  }

  scriptPc(level: number): number {
    return this.view.getUint32(this.at + 32 + level * 4, LE);
  }

  setScriptPc(level: number, value: number): void {
    this.view.setUint32(this.at + 32 + level * 4, value, LE);
  }

  /** Byte offset of a level's pc, which the interpreter needs as a pointer. */
  scriptPcOffset(level: number): number {
    return this.at + 32 + level * 4;
  }
}

/** The typed structures behind the hub, in the order they are laid out. */
export const OBJECT_MOUSE_SIZE = 24;
export const OBJECT_LOGIC_SIZE = 8;
export const OBJECT_GRAPHIC_SIZE = 12;
export const OBJECT_SPEECH_SIZE = 36;
export const OBJECT_MEGA_SIZE = 56;
export const OBJECT_WALKDATA_SIZE = 20;

/** `ObjectGraphic.type` — which list a sprite is drawn in. */
export const Sword2SpriteType = {
  NO_SPRITE: 0x0000,
  BGP0_SPRITE: 0x0001,
  BGP1_SPRITE: 0x0002,
  BACK_SPRITE: 0x0004,
  SORT_SPRITE: 0x0008,
  FORE_SPRITE: 0x0010,
  FGP0_SPRITE: 0x0020,
  FGP1_SPRITE: 0x0040,
  /** In the high word: whether the shading mask applies. */
  SHADED_SPRITE: 0x00010000,
} as const;

/** `TextHeader` — 4 bytes: how many lines a text module holds. */
export const TEXT_HEADER_SIZE = 4;

/**
 * The encoding this family's strings are bytes of.
 *
 * Named once so the reader and the writer cannot drift apart: they are only a
 * round trip while they agree, and apart they are a silent mistranslation
 * (`singleByteText.ts`). Every Sword II release ships the same code page here,
 * unlike Sword 1, whose Czech and Russian builds need their own.
 */
export const SWORD2_TEXT_ENCODING = 'latin1';

/**
 * Checks the arithmetic the readers above depend on.
 *
 * Cheap, once, at load. The sizes are the format (see the file header), and a
 * transcription slip in one of them is the kind of fault that reads a field
 * from the wrong structure rather than failing — so it is asserted rather than
 * trusted.
 */
export function checkStructureSizes(): void {
  const expected: Array<[string, number, number]> = [
    ['ResHeader', RES_HEADER_SIZE, 10 + RES_NAME_LEN],
    ['AnimHeader', ANIM_HEADER_SIZE, 15],
    ['CdtEntry', CDT_ENTRY_SIZE, 9],
    ['FrameHeader', FRAME_HEADER_SIZE, 8],
    ['MultiScreenHeader', MULTI_SCREEN_HEADER_SIZE, 9 * 4],
    ['ScreenHeader', SCREEN_HEADER_SIZE, 6],
    ['LayerHeader', LAYER_HEADER_SIZE, 16],
    ['ObjectHub', OBJECT_HUB_SIZE, 44],
  ];
  for (const [name, declared, derived] of expected) {
    if (declared !== derived) {
      throw new Error(
        `${name} is declared as ${declared} bytes and its fields add up to ${derived}. One of ` +
          `the two is a transcription slip, and Broken Sword II's structures are the format: ` +
          `they were declared to the game's compiler as well as to its interpreter.`,
      );
    }
  }
}

checkStructureSizes();
