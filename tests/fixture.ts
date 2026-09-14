/**
 * Builds a synthetic but structurally valid SCUMM v5 game in memory.
 *
 * The chunk and integer helpers below are exported because `fixtureV6.ts`
 * builds the v6 equivalent from the same primitives: chunk framing, XOR
 * encryption and little-endian integers are the container format, which every
 * SCUMM version shares. What differs between versions is which blocks go
 * inside, and that is the part each builder writes for itself.
 *
 * The engine's resource layer is the part most likely to break silently on a
 * refactor, and it cannot be tested against real game data (which is
 * copyrighted and not redistributable). A hand-built game exercises the same
 * code paths — chunk nesting, XOR, directories, LOFF, room parsing, bytecode —
 * with content we control and can assert on exactly.
 */

import { OF_OWNER_ROOM } from '../src/engine/constants.js';

export const XOR_KEY = 0x69;

/**
 * Where verb 1's code starts, counted from the first byte of the `VERB` chunk.
 *
 * That is the base a real game's verb table counts from, tag included: the
 * chunk header (8) then this object's one-entry table (3 + 1). Getting it wrong
 * points the interpreter into the middle of a header, which decodes as
 * instructions and fails somewhere else entirely.
 */
export const V5_OBJECT_VERB_OFFSET = 8 + 4;

/**
 * The same point counted from the `OBCD`'s first byte, which is what
 * `getVerbEntrypoint` answers: the `OBCD` header (8) and the `CDHD` chunk
 * (8 + 13) in front of the `VERB`.
 */
export const V5_OBJECT_VERB_ENTRYPOINT = 8 + 8 + 13 + V5_OBJECT_VERB_OFFSET;

/** What `V5_OBJECT_VERB_SCRIPT` leaves behind, so a test need not restate it. */
export const V5_OBJECT_VERB_RESULT = { variable: 260, value: 55 };

/**
 * Verb 1's code: a write a test can look for, then a stop.
 *
 * `move` takes a *word*, so the value is two bytes. Written as one, the
 * `stopObjectCode` after it was swallowed as the value's high byte — the
 * script wrote 41015 instead of 55 and then ran on into whatever followed it.
 */
export const V5_OBJECT_VERB_SCRIPT: number[] = [
  0x1a,
  ...u16le(V5_OBJECT_VERB_RESULT.variable),
  ...u16le(V5_OBJECT_VERB_RESULT.value),
  0xa0, // stopObjectCode
];

export function tag(name: string): number[] {
  return [...name].map((character) => character.charCodeAt(0));
}

export function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

export function u32be(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Wraps a payload in a chunk header whose size includes the header. */
export function chunk(name: string, payload: number[]): number[] {
  return [...tag(name), ...u32be(payload.length + 8), ...payload];
}

/** A background strip using codec 1 (raw 8 bit pixels). */
function rawStrip(height: number, color: number): number[] {
  return [1, ...new Array(8 * height).fill(color)];
}

/** An SMAP with `strips` raw strips, all one colour. */
export function buildSmap(strips: number, height: number, color: number): number[] {
  const stripData: number[][] = [];
  for (let i = 0; i < strips; i++) stripData.push(rawStrip(height, color + i));

  // The offset table sits at byte 8 of the chunk and holds absolute offsets
  // from the start of the chunk.
  const tableSize = strips * 4;
  let cursor = 8 + tableSize;
  const table: number[] = [];
  for (const strip of stripData) {
    table.push(...u32le(cursor));
    cursor += strip.length;
  }

  return chunk('SMAP', [...table, ...stripData.flat()]);
}

/**
 * A `BOMP` image of a solid rectangle, which is what a blast object ships.
 *
 * One run per line: a control byte carrying the count biased by one in its top
 * seven bits and the run flag in bit 0, then the colour. A line's own byte
 * count comes first so a reader can find the next line without decoding this
 * one — which is exactly the property a test of a truncated image needs.
 */
export function buildBomp(width: number, height: number, color: number): number[] {
  const lines: number[] = [];
  for (let y = 0; y < height; y++) {
    const runs: number[] = [];
    // A run's count is 1..128, so a line wider than that takes several.
    for (let left = 0; left < width; left += 128) {
      const count = Math.min(128, width - left);
      runs.push(((count - 1) << 1) | 1, color);
    }
    lines.push(...u16le(runs.length), ...runs);
  }

  // Ten bytes of header before the first line: two unused, the size, then a
  // four-byte pad. Eight would put the reader two bytes into the first line,
  // which decodes as a line length of whatever the first run happens to say.
  return chunk('BOMP', [
    ...u16le(0),
    ...u16le(width),
    ...u16le(height),
    ...u16le(0),
    ...u16le(0),
    ...lines,
  ]);
}

export interface FixtureOptions {
  roomWidth?: number;
  roomHeight?: number;
  /** Bytecode for global script 2. */
  script2?: number[];
  /** Bytecode for global script 1 (the boot script). */
  bootScript?: number[];
  /** Bytecode for the room's entry script. */
  entryScript?: number[];
  /** Bytecode for the room's local script 200, which a room script may start. */
  localScript?: number[];
  /**
   * Directory slot the costume is listed under. Defaults to 1.
   *
   * A published game numbers its costumes wherever it likes, and a fixture
   * whose only costume is number 1 cannot tell a preserved id from a freshly
   * assigned one.
   */
  costumeId?: number;
  /**
   * How many image states the room's object ships, and which it starts in.
   *
   * A published game's objects are rarely all in state 1 — a door that starts
   * open, a lamp that starts lit — and the state lives in the index while the
   * artwork lives in the room, which is exactly the join an import has to get
   * right.
   */
  objectImages?: number;
  objectState?: number;
  /**
   * The object's `OBNA`, so a test can give it the `@` padding a real game
   * leaves room with.
   */
  objectName?: string;
  /**
   * Prepends a walk box parked where SCUMM puts things out of sight.
   *
   * Published games carry these, and one is an ordinary unblocked box to
   * anything that only asks whether a box is blocked — which is how Play came
   * to choose a start point of -31999.
   */
  offScreenBox?: boolean;
}

export interface Fixture {
  index: Uint8Array;
  data: Uint8Array;
  indexName: string;
  dataName: string;
}

/**
 * Assembles the pair of files a v5 game ships as.
 *
 * Directory offsets are written relative to the LFLF chunk header, which is the
 * convention the loader treats as its baseline.
 */
export function buildFixture(options: FixtureOptions = {}): Fixture {
  const roomWidth = options.roomWidth ?? 320;
  const roomHeight = options.roomHeight ?? 144;
  const strips = roomWidth / 8;

  const bootScript = options.bootScript ?? [
    // VAR[100] = 1234
    0x1a,
    ...u16le(100),
    ...u16le(1234),
    // stopObjectCode
    0x00,
  ];
  const script2 = options.script2 ?? [0x00];
  const entryScript = options.entryScript ?? [
    // VAR[101] = 7
    0x1a,
    ...u16le(101),
    ...u16le(7),
    0x00,
  ];

  // --- room -----------------------------------------------------------------

  const palette: number[] = [];
  for (let i = 0; i < 256; i++) palette.push(i % 64, (i * 2) % 64, (i * 3) % 64);

  // A degenerate box parked out of sight, of the kind a published game keeps
  // in its list. Unblocked, and shaped like any other box.
  const hiddenBox = options.offScreenBox
    ? [
        ...u16le(-32000 & 0xffff),
        ...u16le(-32000 & 0xffff),
        ...u16le(-31984 & 0xffff),
        ...u16le(-32000 & 0xffff),
        ...u16le(-31984 & 0xffff),
        ...u16le(-31984 & 0xffff),
        ...u16le(-32000 & 0xffff),
        ...u16le(-31984 & 0xffff),
        0,
        0,
        ...u16le(255),
      ]
    : [];

  const boxes: number[] = [
    ...u16le(options.offScreenBox ? 3 : 2),
    ...hiddenBox,
    // A wide strip along the bottom of the room.
    ...u16le(0),
    ...u16le(100),
    ...u16le(319),
    ...u16le(100),
    ...u16le(319),
    ...u16le(140),
    ...u16le(0),
    ...u16le(140),
    0,
    0,
    ...u16le(255),
    // Sits directly on top of the strip, so the two are neighbours.
    ...u16le(0),
    ...u16le(60),
    ...u16le(319),
    ...u16le(60),
    ...u16le(319),
    ...u16le(100),
    ...u16le(0),
    ...u16le(100),
    0,
    0,
    ...u16le(255),
  ];

  const objectImages = options.objectImages ?? 1;
  const objectState = options.objectState ?? 1;

  const objectImage = chunk('OBIM', [
    ...chunk('IMHD', [
      ...u16le(500), // object id
      ...u16le(objectImages), // image count
      ...u16le(0), // unknown
      0, // flags
      0, // unknown
      ...u16le(0),
      ...u16le(0), // unknown pair
      ...u16le(16), // width
      ...u16le(16), // height
      ...u16le(1), // hotspot count
      ...u16le(4),
      ...u16le(8), // hotspot 0
    ]),
    // IM01, IM02, ... one per state, each a different colour so a test can
    // tell which one was drawn.
    ...Array.from({ length: objectImages }, (_, index) =>
      chunk(`IM${String(index + 1).padStart(2, '0')}`, buildSmap(2, 16, 40 + index * 4)),
    ).flat(),
  ]);

  const objectCode = chunk('OBCD', [
    ...chunk('CDHD', [
      ...u16le(500),
      4, // x / 8
      8, // y / 8
      2, // w / 8
      2, // h / 8
      0x01, // flags -> parent state 1
      0, // parent
      ...u16le(40), // walk x
      ...u16le(120), // walk y
      1, // actor direction
    ]),
    ...chunk('VERB', [1, ...u16le(V5_OBJECT_VERB_OFFSET), 0, ...V5_OBJECT_VERB_SCRIPT]),
    ...chunk('OBNA', [...tag(options.objectName ?? 'brass lamp'), 0]),
  ]);

  const room = chunk('ROOM', [
    ...chunk('RMHD', [...u16le(roomWidth), ...u16le(roomHeight), ...u16le(1)]),
    ...chunk('CYCL', [1, 0, 0, ...[0x00, 0x40], ...[0x00, 0x00], 16, 31, 0]),
    ...chunk('TRNS', [...u16le(255)]),
    ...chunk('CLUT', palette),
    ...chunk('BOXD', boxes),
    ...chunk('BOXM', [0xff, 0, 1, 1, 0xff]),
    ...chunk('SCAL', new Array(32).fill(0)),
    ...chunk('RMIM', [
      ...chunk('RMIH', u16le(1)),
      ...chunk('IM00', [
        ...buildSmap(strips, roomHeight, 10),
        ...chunk('ZP01', [
          // One 16 bit offset per strip, then a run-length mask per strip.
          ...new Array(strips).fill(0).flatMap((_, i) => u16le(8 + strips * 2 + i * 3)),
          ...new Array(strips).fill(0).flatMap(() => [0x80 | roomHeight, 0x00, 0x00]),
        ]),
      ]),
    ]),
    ...objectImage,
    ...objectCode,
    ...chunk('ENCD', entryScript),
    ...chunk('EXCD', [0x00]),
    ...chunk('NLSC', u16le(1)),
    ...chunk('LSCR', [200, ...(options.localScript ?? [0x00])]),
  ]);

  // --- disk block -----------------------------------------------------------

  const script1 = chunk('SCRP', bootScript);
  const script2Chunk = chunk('SCRP', script2);
  const charset = chunk('CHAR', buildCharsetPayload());
  const costume = chunk('COST', buildCostumePayload());
  const sound = chunk('SOUN', chunk('SBL ', chunk('AUdt', buildVocPayload())));

  const lflfPayload = [...room, ...script1, ...script2Chunk, ...charset, ...costume, ...sound];
  const lflf = chunk('LFLF', lflfPayload);

  // Offsets of each resource relative to the LFLF chunk header.
  const roomOffset = 8;
  const script1Offset = roomOffset + room.length;
  const script2Offset = script1Offset + script1.length;
  const charsetOffset = script2Offset + script2Chunk.length;
  const costumeOffset = charsetOffset + charset.length;
  const soundOffset = costumeOffset + costume.length;

  // LOFF holds the file offset of each room's LFLF header, so it can only be
  // written once the size of everything before it is known.
  const loffPayload = [1, 1, ...u32le(0)];
  const loff = chunk('LOFF', loffPayload);
  const lflfFileOffset = 8 + loff.length;

  const loffFinal = chunk('LOFF', [1, 1, ...u32le(lflfFileOffset)]);
  const lecf = chunk('LECF', [...loffFinal, ...lflf]);

  // --- index ----------------------------------------------------------------

  const roomNames = chunk('RNAM', [1, ...tag('TESTROOM').map((c) => c ^ 0xff), 0xff, 0]);

  const maxs = chunk('MAXS', [
    ...u16le(800), // variables
    ...u16le(16),
    ...u16le(2048), // bit variables
    ...u16le(200), // local objects
    ...u16le(50),
    ...u16le(9), // charsets
    ...u16le(100),
    ...u16le(50),
    ...u16le(80), // inventory
  ]);

  const directory = (entries: Array<{ room: number; offset: number }>): number[] => [
    ...u16le(entries.length),
    ...entries.map((entry) => entry.room),
    ...entries.flatMap((entry) => u32le(entry.offset)),
  ];

  const droo = chunk(
    'DROO',
    directory([
      { room: 0, offset: 0 },
      { room: 1, offset: roomOffset },
    ]),
  );
  const dscr = chunk(
    'DSCR',
    directory([
      { room: 0, offset: 0 },
      { room: 1, offset: script1Offset },
      { room: 1, offset: script2Offset },
    ]),
  );
  const costumeSlot = options.costumeId ?? 1;
  const costumeEntries: Array<{ room: number; offset: number }> = [{ room: 0, offset: 0 }];
  for (let id = 1; id <= costumeSlot; id++) {
    costumeEntries[id] =
      id === costumeSlot ? { room: 1, offset: costumeOffset } : { room: 0, offset: 0 };
  }
  const dcos = chunk('DCOS', directory(costumeEntries));
  const dchr = chunk('DCHR', directory([{ room: 1, offset: charsetOffset }]));
  const dsou = chunk(
    'DSOU',
    directory([
      { room: 0, offset: 0 },
      { room: 1, offset: soundOffset },
    ]),
  );

  // `DOBJ` is column-wise in v5 exactly as it is in v6: a count, then one
  // owner/state byte per object, then one 32-bit class field per object. The
  // fixture wrote it as interleaved four-byte records for a long time, and the
  // engine read it back the same way, so the two agreed with each other and
  // disagreed with every shipped game — the trap
  // `docs/processes/verifying-version-support.md` names.
  const objectCount = 600;
  const owners: number[] = [];
  const classFields: number[] = [];
  for (let i = 0; i < objectCount; i++) {
    // Packed as state<<4 | owner. A real index gives room objects owner
    // `OF_OWNER_ROOM` (15) — owner 0 means nobody has it — so the fixture uses
    // 15 too, or it would not exercise the in-room test the engine applies.
    owners.push(i === 500 ? OF_OWNER_ROOM | (objectState << 4) : OF_OWNER_ROOM);
    // Class 24 on one object, to prove the field is read at all. The top eight
    // bits are real class space here, so class 32 — `Untouchable` — is
    // reachable from the index, which it is not under the old layout.
    const classBits = i === 500 ? 1 << (24 - 1) : 0;
    classFields.push(...u32le(classBits));
  }
  const dobj = chunk('DOBJ', [...u16le(objectCount), ...owners, ...classFields]);

  const indexBytes = [...roomNames, ...maxs, ...droo, ...dscr, ...dcos, ...dchr, ...dsou, ...dobj];

  return {
    index: encrypt(indexBytes),
    data: encrypt(lecf),
    indexName: 'TESTGAME.000',
    dataName: 'TESTGAME.001',
  };
}

export function encrypt(bytes: number[]): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ^ XOR_KEY) & 0xff;
  return out;
}

/**
 * A one-bit-per-pixel font with a single defined glyph ('A', 65).
 *
 * Layout matches the real format: 29 bytes of preamble, then bits-per-pixel,
 * height, glyph count and the offset table.
 */
export function buildCharsetPayload(): number[] {
  const numChars = 128;
  const preamble: number[] = [
    ...u32le(0), // little-endian size, unused here
    0x3c,
    0x36, // magic
    ...new Array(15).fill(15), // colour map
  ];
  // Bytes 8..28 inclusive of the chunk; the base for offsets is chunk byte 29.
  while (preamble.length < 21) preamble.push(0);

  const header = [1, 8, ...u16le(numChars)];
  const tableSize = numChars * 4;
  const table = new Array(tableSize).fill(0);

  // Glyph 'A': width 8, height 8, no bearing, then eight rows of bits.
  const glyph = [8, 8, 0, 0, 0x18, 0x24, 0x42, 0x42, 0x7e, 0x42, 0x42, 0x00];
  const glyphOffset = header.length + tableSize;
  const offsetBytes = u32le(glyphOffset);
  const slot = 65 * 4 + 4 - header.length;
  for (let i = 0; i < 4; i++) table[slot + i] = offsetBytes[i];

  return [...preamble, ...header, ...table, ...glyph];
}

/**
 * A 16 colour costume with one limb and one cel.
 *
 * The cel is 8x8 and run-length encoded as two runs, so the decoder's
 * "length 0 means the count follows" path is exercised.
 */
/**
 * A costume with one animating limb.
 *
 * `numAnim` is the highest animation index the costume answers for. The
 * default of 1 covers only frame 0, because an animation index is
 * `direction + frame * 4`; pass a larger value to exercise a frame above 0.
 */
export function buildCostumePayload({
  numAnim = 1,
  version = 5,
}: { numAnim?: number; version?: number } = {}): number[] {
  const numColors = 16;

  // Offsets inside a costume are relative to `base`, and base depends on the
  // version: byte 2 of the chunk for v5, byte 8 for v6. Since every offset is
  // relative, the body is *identical* — the only difference is six bytes of
  // padding between the chunk header and `numAnim`, which in v5 the header
  // itself occupies.
  //
  //   v5: [0..7] header, [8] numAnim, [9] format, [10..] palette
  //   v6: [0..7] header, [8..13] padding, [14] numAnim, [15] format, [16..] palette
  const lead = version >= 6 ? new Array(6).fill(0) : [];
  const paletteBytes = new Array(numColors).fill(0).map((_, i) => i);

  const body: number[] = [];
  const push = (...values: number[]): number => {
    const at = body.length;
    body.push(...values);
    return at;
  };

  // Reserve the fixed tables: 2 bytes anim-cmd offset, 32 bytes frame table,
  // 64 bytes data table.
  const animCmdPointerAt = push(0, 0);
  const frameTableAt = push(...new Array(32).fill(0));
  const dataTableAt = push(...new Array(64).fill(0));

  // Body offsets are relative to chunk byte 2, and the tables start at byte 10
  // + numColors of the chunk, i.e. byte 8 + numColors of the body.
  const bodyBase = 8 + numColors;
  const rel = (bodyOffset: number): number => bodyBase + bodyOffset;

  // Animation commands: a single command 0 (draw cel 0).
  const animCmdsAt = push(0x00, 0x7b);

  // Cel: 12 byte header then RLE data.
  const rle: number[] = [
    // Colour 1, run 8 (encoded inline) - twice for 16 pixels...
    (1 << 4) | 8,
    (2 << 4) | 0,
    56, // ...then colour 2 with an explicit run of 56.
  ];
  const celAt = push(
    ...u16le(8), // width
    ...u16le(8), // height
    ...u16le(0), // relX
    ...u16le(0xfff8), // relY (-8)
    ...u16le(0), // moveX
    ...u16le(0), // moveY
    ...rle,
  );

  // Limb 0's frame table: one entry pointing at the cel.
  const limbFramesAt = push(...u16le(rel(celAt)));

  // Animation 0: mask with limb 0 set, pointing at command index 0.
  const animAt = push(...u16le(0x8000), ...u16le(0), 0x00);

  const write16 = (at: number, value: number): void => {
    body[at] = value & 0xff;
    body[at + 1] = (value >> 8) & 0xff;
  };

  write16(animCmdPointerAt, rel(animCmdsAt));
  write16(frameTableAt, rel(limbFramesAt));
  // The data table holds one offset per animation index; point every index the
  // costume claims at the single animation defined above.
  const entries = Math.min(numAnim + 1, 32);
  for (let i = 0; i < entries; i++) write16(dataTableAt + i * 2, rel(animAt));

  return [
    ...lead,
    numAnim,
    0x58, // format: 16 colours, mirroring allowed
    ...paletteBytes,
    ...body,
  ];
}

/** A tiny Creative Voice File with one 8 bit PCM block. */
export function buildVocPayload(): number[] {
  const samples = [128, 200, 128, 56, 128, 200, 128, 56];
  const header = [
    ...tag('Creative Voice File'),
    0x1a,
    ...u16le(0x1a),
    ...u16le(0x010a),
    ...u16le(0x1129),
  ];
  while (header.length < 0x1a) header.push(0);

  const blockSize = samples.length + 2;
  return [
    ...header,
    1, // block type: sound data
    blockSize & 0xff,
    (blockSize >> 8) & 0xff,
    (blockSize >> 16) & 0xff,
    256 - Math.round(1000000 / 11025), // sample rate divisor
    0, // codec: 8 bit unsigned PCM
    ...samples,
    0, // terminator
  ];
}
