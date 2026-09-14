import { OF_OWNER_ROOM } from '../src/engine/constants.js';
import {
  buildCharsetPayload,
  buildSmap,
  buildVocPayload,
  chunk,
  encrypt,
  tag,
  u16le,
  u32le,
} from './fixture.js';

/**
 * Builds a synthetic but structurally valid SCUMM v6 game in memory.
 *
 * The same reasoning as the v5 fixture: real game data is copyrighted and not
 * redistributable, so the only way to test the resource layer is to build a
 * game whose contents we control. The container format — chunk framing, XOR
 * encryption, LECF/LFLF/LOFF — is shared with v5 and comes from `fixture.ts`.
 *
 * **This file encodes our reading of the v6 format, so it is not evidence that
 * a real v6 game loads.** If a claim here is wrong, the loader will be written
 * to match it and Day of the Tentacle will still fail. Every structural claim
 * therefore cites the ScummVM source that establishes it, and those citations
 * are the thing to check in review — not whether the tests pass, which they
 * will either way.
 *
 * Where v6 differs from v5, and why each is here:
 *
 * - **`MAXS` is 38 bytes**, fifteen 16-bit fields against v5's nine. This is
 *   what identifies the version (`ScummEngine_v6::readMAXS`, which accepts no
 *   other size).
 * - **`DOBJ` is column-wise**: a count, then one owner/state byte per object,
 *   then one 32-bit class field per object. v5 interleaves them as a 4-byte
 *   record each. (`ScummEngine::readGlobalObjects`.)
 * - **`AARY`** declares the script arrays a game predefines. v5 has no such
 *   block. (`ScummEngine_v6::readArrayFromIndexFile`.)
 * - **`PALS` replaces `CLUT`**: a container holding `WRAP`, which holds an
 *   `OFFS` table of 32-bit offsets and then the `APAL` palettes themselves.
 *   Offsets are relative to the start of the `OFFS` *data*, not to the room or
 *   the file. (`findPalInPals` in `palette.cpp`.)
 * - **`RMHD` is unchanged** from v5 — width, height, object count as 16-bit
 *   values. v7 is where it grows. (`setupRoomSubBlocks`.)
 */

/** An `APAL` palette is 256 colours of three bytes. */
const APAL_SIZE = 768;

/** Every chunk here is a four-character tag and a 32-bit size. */
const CHUNK_HEADER_SIZE = 8;

/**
 * One 256-colour palette, distinguishable from the v5 fixture's.
 *
 * Colour 1 is the bright value the room's artwork uses, so a test can tell a
 * palette that was read from one that was defaulted.
 */
function buildPalette(): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 256; i++) bytes.push(i, 255 - i, (i * 3) & 0xff);
  // A short palette would be read as a valid one with the wrong colours, which
  // is the sort of fixture bug that looks like an engine bug.
  if (bytes.length !== APAL_SIZE) throw new Error(`palette is ${bytes.length} bytes`);
  return bytes;
}

/**
 * The room palette block: `PALS` > `WRAP` > `OFFS` + `APAL`.
 *
 * The offset table holds one entry per palette, each counted **from the first
 * byte of the `OFFS` chunk, its eight-byte header included** — so an offset
 * lands on an `APAL` header. Real rooms are written this way; this fixture
 * counted from the table's data instead, which is eight bytes short, and the
 * reader was written to match it. Both agreed and no real v6 room's palettes
 * were found. (`findPalInPals` in `palette.cpp`, which adds the offset to the
 * table's data and so arrives at the `APAL` payload — the header it skips is
 * the header this offset does not count.)
 */
function buildPals(palettes: number[][]): number[] {
  const apals = palettes.map((palette) => chunk('APAL', palette));
  const tableSize = palettes.length * 4;

  const offsets: number[] = [];
  let at = CHUNK_HEADER_SIZE + tableSize;
  for (const apal of apals) {
    offsets.push(...u32le(at));
    at += apal.length;
  }

  return chunk('PALS', [...chunk('WRAP', [...chunk('OFFS', offsets), ...apals.flat()])]);
}

/**
 * A v6 global script whose every instruction is named.
 *
 * v6 is a stack machine: operands are pushed, then an instruction consumes
 * them. Nothing here depends on the engine's state, so a decoder test can
 * assert the reading of these exact bytes, and an execution test can assert
 * the variable it leaves behind.
 *
 * Opcode numbers are from ScummVM's `setupOpcodes` in `script_v6.cpp`.
 */
export const V6_SCRIPT: number[] = [
  0x00,
  0x07, // pushByte 7
  0x43,
  ...u16le(250), // writeWordVar var250        (pops 7)
  0x03,
  ...u16le(250), // pushWordVar var250
  0x00,
  0x02, // pushByte 2
  0x16, // mul                        (7 * 2)
  0x43,
  ...u16le(251), // writeWordVar var251        (pops 14)
  0x66, // stopObjectCode
];

/** What `V6_SCRIPT` leaves behind, so a test need not restate the arithmetic. */
export const V6_SCRIPT_RESULT = { var250: 7, var251: 14 };

/**
 * Where verb 1's code starts, counted from the first byte of the `VERB` chunk.
 *
 * That is the base a real game's verb table counts from, tag included, so it
 * is the `VERB` header (8) plus this object's one-entry table (3 + 1). Getting
 * it wrong points the interpreter into the middle of a header, which decodes
 * as instructions and fails somewhere else entirely.
 */
export const V6_OBJECT_VERB_OFFSET = 8 + 4;

/**
 * The same point counted from the `OBCD`'s first byte, which is what
 * `getVerbEntrypoint` answers: the `OBCD` header (8) and the `CDHD` chunk
 * (8 + 17, v6's payload being four 16-bit fields where v5 has four bytes) in
 * front of the `VERB`.
 */
export const V6_OBJECT_VERB_ENTRYPOINT = 8 + 8 + 17 + V6_OBJECT_VERB_OFFSET;

/** Verb 1's code: a write a test can look for, then a stop. */
export const V6_OBJECT_VERB_SCRIPT: number[] = [
  0x00,
  0x37, // pushByte 55
  0x43,
  ...u16le(260), // writeWordVar var260
  0x66, // stopObjectCode
];

/**
 * An AKOS costume with one 4x2 cel and chores that all draw it.
 *
 * Every chore points at the same place, so the cel draws whichever frame and
 * facing the actor happens to be in — the point of the fixture is that a v6
 * costume reaches the screen at all, not which chore was selected.
 */
export interface AkosCostumeOptions {
  /** How many colours `AKPL` names. Sixteen unless a test needs more. */
  colors?: number;
  /** The cel's single colour, as an index into `AKPL`. */
  celColor?: number;
  /**
   * An `RGBS` block, one triplet per colour, or omitted for a costume without
   * one. Real v7 costumes mostly carry these and the recolour instruction
   * needs them; the default has none so that the older tests, which are about
   * drawing, keep exercising the shorter resource.
   */
  rgbs?: number[];
}

export function buildAkosCostume(options: AkosCostumeOptions = {}): number[] {
  const colors = options.colors ?? 16;
  const celColor = options.celColor ?? 6;
  const bompLine = (control: number[]) => [...u16le(control.length), ...control];
  const run = (count: number, color: number) => [((count - 1) << 1) | 1, color];
  const cel = [...bompLine(run(4, celColor)), ...bompLine(run(4, celColor))];

  const chores = 16;

  return chunk('AKOS', [
    ...chunk('AKHD', [
      ...u16le(1), // version
      ...u16le(0), // flags: four directions, drawn facing left
      ...u16le(chores),
      ...u16le(1), // cels
      ...u16le(5), // codec 5: BOMP
      ...u16le(1), // layers
    ]),
    // Every colour maps to itself, so a cel's own index is the screen colour
    // unless the actor overrides it.
    ...chunk(
      'AKPL',
      new Array(colors).fill(0).map((_, index) => index & 0xff),
    ),
    ...(options.rgbs ? chunk('RGBS', options.rgbs) : []),
    ...chunk('AKOF', [...u32le(0), ...u16le(0)]),
    ...chunk('AKCI', [
      ...u16le(4), // width
      ...u16le(2), // height
      ...u16le(0x10000 - 2), // relX
      ...u16le(0x10000 - 2), // relY
      ...u16le(0), // moveX
      ...u16le(0), // moveY
    ]),
    ...chunk('AKCD', cel),
    // Every chore rests at sequence position 1, which holds cel 0. Position 0
    // is never entered: a chore offset of zero means "no chore".
    ...chunk(
      'AKCH',
      new Array(chores).fill(0).flatMap(() => u16le(1)),
    ),
    ...chunk('AKSQ', [0x00, 0x00]),
  ]);
}

export interface V6FixtureOptions {
  roomWidth?: number;
  roomHeight?: number;
  /** How the one AKOS costume in the fixture is built. */
  costume?: AkosCostumeOptions;
  /** Bytecode for global script 1, the boot script. Defaults to a bare stop. */
  bootScript?: number[];
  /** Bytecode for global script 2. Defaults to `V6_SCRIPT`. */
  script2?: number[];
  /** Bytecode for global script 3. Defaults to a bare stop. */
  script3?: number[];
  /** Bytecode for the room's entry script. */
  entryScript?: number[];
  /** How many palettes the room's `PALS` block carries. Defaults to 1. */
  palettes?: number;
  /** Which state the room's object starts in, as the index records it. */
  objectState?: number;
  /** Bytecode for verb 1 of the room's object. */
  objectVerbScript?: number[];
}

export interface V6Fixture {
  index: Uint8Array;
  data: Uint8Array;
  indexName: string;
  dataName: string;
}

export function buildV6Fixture(options: V6FixtureOptions = {}): V6Fixture {
  const roomWidth = options.roomWidth ?? 320;
  const roomHeight = options.roomHeight ?? 144;
  const strips = roomWidth / 8;
  const objectState = options.objectState ?? 1;
  const paletteCount = options.palettes ?? 1;

  const palettes = new Array(paletteCount).fill(0).map(() => buildPalette());

  // --- the room's object ----------------------------------------------------

  // Object 500, one image state, a plain rectangle. The layout of OBIM and
  // OBCD is unchanged from v5, so this mirrors the v5 fixture deliberately:
  // anything that differs here would be a claim about v6 that nothing in
  // ScummVM's room handling supports.
  const objectWidth = 16;
  const objectHeight = 16;
  // `IMHD`, laid out as `ImageHeader.old` in ScummVM's `object.h`: the id and
  // image count, two unread words and a flags byte, *then* the picture's own
  // width and height at offsets twelve and fourteen, then the hotspots. Written
  // with the size four bytes early — which is where a reading of the field
  // names alone puts it — the picture measures one by nothing, and anything
  // that trusts the image header rather than the object's box draws nothing at
  // all. A verb's picture is exactly that: `drawVerbBitmap` reads its size from
  // here and never looks at the `CDHD`.
  const imhd = chunk('IMHD', [
    ...u16le(500), // object id
    ...u16le(1), // image state count
    ...u16le(0), // unread
    0, // flags
    0, // unread
    ...u16le(0), // unread
    ...u16le(0), // unread
    ...u16le(objectWidth),
    ...u16le(objectHeight),
    ...u16le(1), // hotspot count
    ...u16le(0),
    ...u16le(0),
  ]);
  const objectImage = chunk('OBIM', [
    ...imhd,
    ...chunk('IM01', buildSmap(objectWidth / 8, objectHeight, 40)),
  ]);

  // `CDHD` is where v6 differs from v5 and the two are the same *length*, so
  // nothing catches a misreading: v5 stores position and size as four bytes
  // counted in eighths of a pixel, v6 as four 16-bit values counted in pixels.
  // Read one as the other and the low byte of a 16-bit field becomes a whole
  // byte field — every object lands somewhere else with a height of zero, and
  // a zero-height object can never be clicked. The two fields where v5 keeps
  // the walk-to position are unread in v6. (`readCodeHeader` in `object.cpp`,
  // which branches on `_game.version == 6`.)
  const verbTable = [
    1,
    ...u16le(V6_OBJECT_VERB_OFFSET), // verb 1
    0, // end of table
  ];
  const objectCode = chunk('OBCD', [
    ...chunk('CDHD', [
      ...u16le(500),
      ...u16le(32), // x, in pixels
      ...u16le(8), // y
      ...u16le(objectWidth),
      ...u16le(objectHeight),
      0x01, // flags -> parent state 1
      0, // parent
      ...u16le(0), // unread in v6, where v5 keeps the walk-to position
      ...u16le(0),
      1, // actor direction
    ]),
    // Real games keep the verb code inside `VERB`, after the table, and the
    // offsets are counted from the start of that chunk.
    ...chunk('VERB', [...verbTable, ...(options.objectVerbScript ?? V6_OBJECT_VERB_SCRIPT)]),
    ...chunk('OBNA', [...tag('rubber chicken'), 0]),
  ]);

  // --- the room -------------------------------------------------------------

  const boxes = [
    ...u16le(1),
    ...u16le(0),
    ...u16le(roomHeight - 40),
    ...u16le(roomWidth),
    ...u16le(roomHeight - 40),
    ...u16le(roomWidth),
    ...u16le(roomHeight),
    ...u16le(0),
    ...u16le(roomHeight),
    0,
    0,
    ...u16le(255),
  ];

  const room = chunk('ROOM', [
    ...chunk('RMHD', [...u16le(roomWidth), ...u16le(roomHeight), ...u16le(1)]),
    ...chunk('TRNS', [...u16le(255)]),
    ...buildPals(palettes),
    ...chunk('BOXD', boxes),
    ...chunk('BOXM', [0xff, 0, 1, 1, 0xff]),
    ...chunk('SCAL', new Array(32).fill(0)),
    ...chunk('RMIM', [
      ...chunk('RMIH', u16le(1)),
      ...chunk('IM00', [...buildSmap(strips, roomHeight, 10)]),
    ]),
    ...objectImage,
    ...objectCode,
    ...chunk('ENCD', options.entryScript ?? [0x66]),
    ...chunk('EXCD', [0x66]),
    ...chunk('NLSC', u16le(0)),
  ]);

  // --- disk block -----------------------------------------------------------

  const script1 = chunk('SCRP', options.bootScript ?? [0x66]);
  const script2 = chunk('SCRP', options.script2 ?? V6_SCRIPT);
  const script3 = chunk('SCRP', options.script3 ?? [0x66]);
  const charset = chunk('CHAR', buildCharsetPayload());
  const costume = buildAkosCostume(options.costume);
  const sound = chunk('SOUN', chunk('SBL ', chunk('AUdt', buildVocPayload())));

  const lflf = chunk('LFLF', [
    ...room,
    ...script1,
    ...script2,
    ...script3,
    ...charset,
    ...costume,
    ...sound,
  ]);

  const roomOffset = 8;
  const script1Offset = roomOffset + room.length;
  const script2Offset = script1Offset + script1.length;
  const script3Offset = script2Offset + script2.length;
  const charsetOffset = script3Offset + script3.length;
  const costumeOffset = charsetOffset + charset.length;
  const soundOffset = costumeOffset + costume.length;

  const loff = chunk('LOFF', [1, 1, ...u32le(0)]);
  const lflfFileOffset = 8 + loff.length;
  const lecf = chunk('LECF', [...chunk('LOFF', [1, 1, ...u32le(lflfFileOffset)]), ...lflf]);

  // --- index ----------------------------------------------------------------

  const roomNames = chunk('RNAM', [1, ...tag('TENTACLE').map((c) => c ^ 0xff), 0xff, 0]);

  // Fifteen 16-bit fields, in the order `ScummEngine_v6::readMAXS` reads them.
  // Two are read and discarded there; they are written as the values a real
  // release carries so the block is not merely the right length.
  const maxs = chunk('MAXS', [
    ...u16le(800), // variables
    ...u16le(16), // discarded
    ...u16le(2048), // bit variables
    ...u16le(200), // local objects
    ...u16le(50), // arrays
    ...u16le(0), // discarded
    ...u16le(100), // verbs
    ...u16le(50), // FL objects
    ...u16le(80), // inventory
    ...u16le(100), // rooms
    ...u16le(200), // scripts
    ...u16le(100), // sounds
    ...u16le(9), // charsets
    ...u16le(30), // costumes
    ...u16le(600), // global objects
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
      { room: 1, offset: script3Offset },
    ]),
  );
  const dcos = chunk(
    'DCOS',
    directory([
      { room: 0, offset: 0 },
      { room: 1, offset: costumeOffset },
    ]),
  );
  const dchr = chunk('DCHR', directory([{ room: 1, offset: charsetOffset }]));
  const dsou = chunk(
    'DSOU',
    directory([
      { room: 0, offset: 0 },
      { room: 1, offset: soundOffset },
    ]),
  );

  // Column-wise, unlike v5: every owner/state byte, then every class field.
  const objectCount = 600;
  const owners: number[] = [];
  const classes: number[] = [];
  for (let i = 0; i < objectCount; i++) {
    // The room owns its objects, which the index writes as `OF_OWNER_ROOM`;
    // the state is the high nibble of the same byte.
    owners.push(i === 500 ? OF_OWNER_ROOM | (objectState << 4) : OF_OWNER_ROOM);
    classes.push(...u32le(i === 500 ? 1 << 23 : 0));
  }
  const dobj = chunk('DOBJ', [...u16le(objectCount), ...owners, ...classes]);

  // Each entry is variable number, dim2, dim1, type; a zero variable ends it.
  // Type 4 is the bit-array marker ScummVM preserves; everything else becomes
  // an integer array.
  const aary = chunk('AARY', [
    ...u16le(100),
    ...u16le(0),
    ...u16le(10),
    ...u16le(5),
    ...u16le(101),
    ...u16le(0),
    ...u16le(8),
    ...u16le(4),
    ...u16le(0),
  ]);

  const indexBytes = [
    ...roomNames,
    ...maxs,
    ...droo,
    ...dscr,
    ...dcos,
    ...dchr,
    ...dsou,
    ...dobj,
    ...aary,
  ];

  return {
    index: encrypt(indexBytes),
    data: encrypt(lecf),
    indexName: 'TENTACLE.000',
    dataName: 'TENTACLE.001',
  };
}
