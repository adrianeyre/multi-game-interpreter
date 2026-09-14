import {
  buildBomp,
  buildCharsetPayload,
  buildSmap,
  buildVocPayload,
  chunk,
  tag,
  u16le,
  u32le,
} from './fixture.js';
import { buildAkosCostume, type AkosCostumeOptions } from './fixtureV6.js';

/**
 * Builds a synthetic but structurally valid SCUMM v7 game in memory.
 *
 * The same reasoning as the v5 and v6 fixtures: real game data is copyrighted
 * and not redistributable, so the only way to test the resource layer is to
 * build a game whose contents we control. The container framing — chunk
 * headers, LECF/LFLF/LOFF — is shared and comes from `fixture.ts`.
 *
 * **This file encodes our reading of the v7 format, so it is not evidence that
 * Full Throttle loads.** If a claim here is wrong, the loader will be written to
 * match it and the game will still fail — which is exactly how four v6 faults
 * survived a passing suite. Every structural claim therefore cites the ScummVM
 * source that establishes it, and those citations are the thing to check in
 * review, not whether the tests pass.
 *
 * Where v7 differs from v6, and why each is here:
 *
 * - **No XOR obfuscation.** v7 data files are stored plain, so nothing here is
 *   encrypted and the fixture's `xorKey` is 0.
 * - **`MAXS` is 138 bytes**: two 50-byte version strings, then *fifteen* 16-bit
 *   counts in an order of their own. (`ScummEngine_v7::readMAXS` in
 *   `resource.cpp`, which reads two 50-byte strings and then fifteen
 *   `readUint16LE` calls. 100 + 30 + 8 bytes of chunk header = 138.)
 * - **`DOBJ` carries a room per object**: a count, then one *state* byte per
 *   object, then one *room* byte per object, then one 32-bit class field per
 *   object. v6 packs owner and state into a single byte and has no room table;
 *   v7 stores no owner at all and fills it with 0xFF at load.
 *   (`ScummEngine_v7::readGlobalObjects`.)
 * - **`ANAM` is new**: a count, then nine bytes of name per *audio* cue. It
 *   names iMUSE Digital's sounds, not objects.
 *   (`ScummEngine_v7::readIndexBlock`, which passes it to `setAudioNames`.)
 * - **`RMHD` grows a leading 32-bit version field**, then width, height and
 *   object count as 16-bit values — ten bytes where v5 and v6 have six.
 *   (`RoomHeader.v7` in `object.h`, read in `ScummEngine::resetRoomSubBlocks`.)
 * - **`CDHD` is unrecognisable**: a 32-bit version, the object id, a parent and
 *   a parent state — eight bytes, against v6's fifteen. The object's position
 *   and size are **not here**; v7 reads them from the `IMHD` instead.
 *   (`CodeHeader.v7` in `object.h`, and the `_game.version == 7` branch of
 *   `ScummEngine::resetRoomObject`.)
 * - **`IMHD` carries the position and size** it did not have to before, after
 *   its own leading 32-bit version field. (`ImageHeader.v7` in `object.h`.)
 *
 * And, as importantly, what does **not** change, each of which was worth
 * checking because a plausible-sounding claim in the other direction would have
 * cost a fixture rewrite:
 *
 * - The room image is still `RMIM` > `IM00` **inside** the `ROOM` resource.
 *   ScummVM's separate room-image resource is `heversion >= 70`, which is
 *   Humongous Entertainment, not v7. (`resetRoomSubBlocks` in `room.cpp`.)
 * - Object names are still `OBNA` inside the `OBCD`.
 *   (`ScummEngine::getObjOrActorName`.)
 * - The `VERB` table is still a byte verb number, a 16-bit offset from the
 *   start of the `VERB` chunk itself, and a zero terminator. v8 is where those
 *   become 32-bit. (`ScummEngine::getVerbEntrypoint` in `script.cpp`.)
 * - The opcode numbering is v6's. ScummVM gives v7 no opcode table of its own:
 *   `ScummEngine_v7` inherits v6's and overrides one handler, with the rest of
 *   the delta expressed as `_game.version >= 7` branches inside shared
 *   handlers. So the bytes of `V7_SCRIPT` below are v6 encoding on purpose.
 */

/** An `APAL` palette is 256 colours of three bytes. */
const APAL_SIZE = 768;

/** Every chunk here is a four-character tag and a 32-bit size. */
const CHUNK_HEADER_SIZE = 8;

/**
 * The 32-bit value v7 puts at the front of `RMHD`, `CDHD` and `IMHD`.
 *
 * ScummVM never reads it — it only skips past it by using the wider struct —
 * so its value is not load-bearing. It is written as a recognisable non-zero
 * number so that a reader which forgets to skip it fails on an absurd width
 * rather than on a plausible one.
 */
const V7_BLOCK_VERSION = 801;

/** One 256-colour palette, distinguishable from the v5 and v6 fixtures'. */
function buildPalette(): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < 256; i++) bytes.push((i * 2) & 0xff, i, 255 - i);
  if (bytes.length !== APAL_SIZE) throw new Error(`palette is ${bytes.length} bytes`);
  return bytes;
}

/**
 * The room palette block: `PALS` > `WRAP` > `OFFS` + `APAL`, as in v6.
 *
 * Offsets count from the first byte of the `OFFS` chunk, its eight-byte header
 * included. This is the arithmetic that was wrong in the v6 fixture *and* in
 * the reader, so that both agreed and no real room's palettes were found;
 * it is repeated here in its corrected form rather than re-derived.
 * (`findPalInPals` in `palette.cpp`.)
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
 * A v7 global script whose every instruction is named.
 *
 * The encoding is v6's, deliberately: v7 shares v6's opcode numbering (see the
 * header comment). What makes this a v7 script is the container it sits in, not
 * its bytes — which is the whole reason a v7 engine can be a delta over a
 * shared stack machine rather than a second interpreter.
 */
export const V7_SCRIPT: number[] = [
  0x00,
  0x09, // pushByte 9
  0x43,
  ...u16le(250), // writeWordVar var250        (pops 9)
  0x03,
  ...u16le(250), // pushWordVar var250
  0x00,
  0x03, // pushByte 3
  0x16, // mul                        (9 * 3)
  0x43,
  ...u16le(251), // writeWordVar var251        (pops 27)
  0x66, // stopObjectCode
];

/** What `V7_SCRIPT` leaves behind, so a test need not restate the arithmetic. */
export const V7_SCRIPT_RESULT = { var250: 9, var251: 27 };

/**
 * Where verb 1's code starts, counted from the first byte of the `VERB` chunk.
 *
 * That is the base a real game's verb table counts from, tag included: the
 * chunk header (8) then this object's one-entry table (3 + 1). Getting it wrong
 * points the interpreter into the middle of a header, which decodes as
 * instructions and fails somewhere else entirely.
 */
export const V7_OBJECT_VERB_OFFSET = 8 + 4;

/**
 * The same point counted from the `OBCD`'s first byte, which is what
 * `getVerbEntrypoint` answers: the `OBCD` header (8) and the `CDHD` chunk
 * (8 + 8, where v6's payload is 15 rather than 8) in front of the `VERB`.
 */
export const V7_OBJECT_VERB_ENTRYPOINT = 8 + 8 + 8 + V7_OBJECT_VERB_OFFSET;

/** Verb 1's code: a write a test can look for, then a stop. */
export const V7_OBJECT_VERB_SCRIPT: number[] = [
  0x00,
  0x2a, // pushByte 42
  0x43,
  ...u16le(260), // writeWordVar var260
  0x66, // stopObjectCode
];

/** The object the second room carries, for a floating-object test to load. */
export const V7_FLOATING_OBJECT = 501;

/** The room it lives in, which is never the room the fixture starts in. */
export const V7_FLOATING_ROOM = 2;

/**
 * The object the floating one stands behind, in the room it comes from.
 *
 * A floating object's `parent` is a one-based index into its *own* room's
 * object list, so it means nothing in the room it is loaded into. Giving it a
 * real parent back home is what makes that observable: carried across, index 1
 * names whatever this room happens to have first instead.
 */
export const V7_FLOATING_PARENT = 502;

/** Verb 1 of the floating object: a different write, from a different buffer. */
export const V7_FLOATING_VERB_SCRIPT: number[] = [
  0x00,
  0x4d, // pushByte 77
  0x43,
  ...u16le(261), // writeWordVar var261
  0x66, // stopObjectCode
];

/**
 * The strings a v7 game displays, which live outside its scripts.
 *
 * Full Throttle ships `LANGUAGE.BND` and The Dig `LANGUAGE.TAB`; a script names
 * a line by index rather than carrying its characters. The fixture builds the
 * tab-separated form, which is the one whose layout can be stated without
 * guessing: an index, a tab, the text, a newline.
 */
export const V7_LANGUAGE_LINES: ReadonlyArray<readonly [number, string]> = [
  [1, 'Where does that leave me?'],
  [2, 'a rubber chicken'],
  [3, 'It looks like a hopper.'],
];

function buildLanguageTab(lines: ReadonlyArray<readonly [number, string]>): Uint8Array {
  const text = lines.map(([index, line]) => `${index}\t${line}`).join('\n') + '\n';
  return new TextEncoder().encode(text);
}

export interface V7FixtureOptions {
  roomWidth?: number;
  /** Rooms taller than the screen are the case v7 adds; the default is one. */
  roomHeight?: number;
  /** Bytecode for global script 1, the boot script. Defaults to a bare stop. */
  bootScript?: number[];
  /** Bytecode for global script 2. Defaults to `V7_SCRIPT`. */
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
  /**
   * Ship the room's object as blast artwork: one `BOMP` image state per colour
   * given, instead of the single `SMAP` it carries by default.
   *
   * Which of the two an object holds is what decides whether a script may blast
   * it over the finished frame, so a fixture that only ever ships `SMAP` cannot
   * reach the drawing at all. More than one colour gives an object more than one
   * picture, which is what the image argument chooses between.
   */
  blastObjectColours?: number[];
  /** How the one AKOS costume in the fixture is built. */
  costume?: AkosCostumeOptions;
  /**
   * A second room, room 2, carrying the floating object and its parent.
   *
   * What a floating object is loaded from: a script asks for an object by room
   * and number, and the interesting case is the one where that room is not the
   * room the game is in. Off by default, because it changes the shape of `LOFF`
   * and `DROO` and most tests want the single-room layout.
   */
  secondRoom?: boolean;
  /** Lines for the language bundle. Defaults to `V7_LANGUAGE_LINES`. */
  languageLines?: ReadonlyArray<readonly [number, string]>;
}

export interface V7Fixture {
  index: Uint8Array;
  data: Uint8Array;
  indexName: string;
  dataName: string;
  /** The language bundle, which is a file beside the container, not a resource. */
  language: Uint8Array;
  languageName: string;
}

export function buildV7Fixture(options: V7FixtureOptions = {}): V7Fixture {
  const roomWidth = options.roomWidth ?? 320;
  const roomHeight = options.roomHeight ?? 200;
  const strips = roomWidth / 8;
  const objectState = options.objectState ?? 1;
  const paletteCount = options.palettes ?? 1;

  const palettes = new Array(paletteCount).fill(0).map(() => buildPalette());

  // --- the room's object ----------------------------------------------------

  // Object 500. Where v6 keeps the object's position and size in `CDHD`, v7
  // keeps them in `IMHD` and reduces `CDHD` to an id and a parent — so a reader
  // that carries v6's layout forward finds a 32-bit version field where it
  // expects an object number, and every object in the game is wrong.
  const objectWidth = 16;
  const objectHeight = 16;

  /** `IM01` upwards: the name an image state is found by. */
  const imageStateTag = (state: number): string => `IM${String(state).padStart(2, '0')}`;

  /**
   * One object's `OBIM` and `OBCD` pair, in v7's shapes.
   *
   * Two rooms need one each — the second room exists only to be borrowed from —
   * and a difference between two hand-written copies would read as a difference
   * between rooms rather than as the mistake it was.
   */
  const buildObject = (spec: {
    id: number;
    x: number;
    y: number;
    /** One-based index into the room's own object list, or 0 for no parent. */
    parent: number;
    parentState: number;
    verbScript: number[];
    name: string;
    colour: number;
    /** One `BOMP` per colour in place of the `SMAP`, for a blastable object. */
    blastColours?: number[];
  }): { image: number[]; code: number[] } => {
    const images = spec.blastColours
      ? spec.blastColours.flatMap((colour, index) =>
          chunk(imageStateTag(index + 1), buildBomp(objectWidth, objectHeight, colour)),
        )
      : chunk('IM01', buildSmap(objectWidth / 8, objectHeight, spec.colour));

    const imhd = chunk('IMHD', [
      ...u32le(V7_BLOCK_VERSION),
      ...u16le(spec.id), // object id
      ...u16le(spec.blastColours?.length ?? 1), // image state count
      ...u16le(spec.x), // x position
      ...u16le(spec.y), // y position
      ...u16le(objectWidth),
      ...u16le(objectHeight),
      0,
      0,
      0, // three unread bytes
      1, // actor direction
      ...u16le(1), // hotspot count
      ...u16le(0), // hotspot 0 x
      ...u16le(0), // hotspot 0 y
    ]);

    const verbTable = [
      1,
      ...u16le(V7_OBJECT_VERB_OFFSET), // verb 1
      0, // end of table
    ];

    return {
      image: chunk('OBIM', [...imhd, ...images]),
      code: chunk('OBCD', [
        ...chunk('CDHD', [
          ...u32le(V7_BLOCK_VERSION),
          ...u16le(spec.id), // object id
          spec.parent, // parent
          spec.parentState, // parent state
        ]),
        ...chunk('VERB', [...verbTable, ...spec.verbScript]),
        ...chunk('OBNA', [...tag(spec.name), 0]),
      ]),
    };
  };

  const { image: objectImage, code: objectCode } = buildObject({
    id: 500,
    x: 32,
    y: 8,
    parent: 0,
    parentState: objectState,
    verbScript: options.objectVerbScript ?? V7_OBJECT_VERB_SCRIPT,
    name: 'rubber chicken',
    colour: 40,
    blastColours: options.blastObjectColours,
  });

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
    // Ten bytes, not v6's six: the leading 32-bit version is what a v6 reader
    // would consume as the width.
    ...chunk('RMHD', [
      ...u32le(V7_BLOCK_VERSION),
      ...u16le(roomWidth),
      ...u16le(roomHeight),
      ...u16le(1),
    ]),
    ...chunk('TRNS', [...u16le(255)]),
    ...buildPals(palettes),
    ...chunk('BOXD', boxes),
    ...chunk('BOXM', [0xff, 0, 1, 1, 0xff]),
    ...chunk('SCAL', new Array(32).fill(0)),
    // Still inside the room, as in v5 and v6.
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

  /**
   * Room 2: a room the game never enters, holding the floating object.
   *
   * Same shape as room 1 — a room a floating object comes out of is an ordinary
   * room, and one built to a reduced shape would test the reduced shape.
   */
  const secondRoom = options.secondRoom ?? false;
  // First in the room, so it is the parent at index 1.
  const floatingParent = buildObject({
    id: V7_FLOATING_PARENT,
    x: 96,
    y: 16,
    parent: 0,
    parentState: 0,
    verbScript: [0x66],
    name: 'shipping pallet',
    colour: 80,
  });
  // Behind that parent, and only while the parent is in state 2 — the ordinary
  // shape of a child object, and one whose parent index is wrong anywhere else.
  const floating = buildObject({
    id: V7_FLOATING_OBJECT,
    x: 64,
    y: 16,
    parent: 1,
    parentState: 2,
    verbScript: V7_FLOATING_VERB_SCRIPT,
    name: 'floating crate',
    colour: 60,
  });
  const room2 = chunk('ROOM', [
    ...chunk('RMHD', [
      ...u32le(V7_BLOCK_VERSION),
      ...u16le(roomWidth),
      ...u16le(roomHeight),
      ...u16le(1),
    ]),
    ...chunk('TRNS', [...u16le(255)]),
    ...buildPals(palettes),
    ...chunk('BOXD', boxes),
    ...chunk('BOXM', [0xff, 0, 1, 1, 0xff]),
    ...chunk('SCAL', new Array(32).fill(0)),
    ...chunk('RMIM', [
      ...chunk('RMIH', u16le(1)),
      ...chunk('IM00', [...buildSmap(strips, roomHeight, 20)]),
    ]),
    ...floatingParent.image,
    ...floatingParent.code,
    ...floating.image,
    ...floating.code,
    ...chunk('ENCD', [0x66]),
    ...chunk('EXCD', [0x66]),
    ...chunk('NLSC', u16le(0)),
  ]);

  // --- disk block -----------------------------------------------------------

  const script1 = chunk('SCRP', options.bootScript ?? [0x66]);
  const script2 = chunk('SCRP', options.script2 ?? V7_SCRIPT);
  const script3 = chunk('SCRP', options.script3 ?? [0x66]);
  const charset = chunk('CHAR', buildCharsetPayload());
  // AKOS is unchanged between v6 and v7, so the v6 builder is reused rather
  // than copied — a second copy would drift the moment either is corrected.
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

  const lflf2 = chunk('LFLF', room2);

  // `LOFF` holds the file offset of each room's `LFLF` header, so its own size
  // has to be known before those offsets can be worked out — hence a payload
  // built once with zeroes to measure and once with the answers.
  const loffPayload = (first: number, second: number): number[] =>
    secondRoom ? [2, 1, ...u32le(first), 2, ...u32le(second)] : [1, 1, ...u32le(first)];
  const lflfFileOffset = 8 + 8 + loffPayload(0, 0).length;
  const lflf2FileOffset = lflfFileOffset + lflf.length;
  const lecf = chunk('LECF', [
    ...chunk('LOFF', loffPayload(lflfFileOffset, lflf2FileOffset)),
    ...lflf,
    ...(secondRoom ? lflf2 : []),
  ]);

  // --- index ----------------------------------------------------------------

  const roomNames = chunk('RNAM', [1, ...tag('FULLTHRO').map((c) => c ^ 0xff), 0xff, 0]);

  /** A 50-byte version string, space-padded, as the two `MAXS` fields carry. */
  const versionString = (text: string): number[] => {
    const bytes = [...tag(text)];
    while (bytes.length < 50) bytes.push(0);
    return bytes.slice(0, 50);
  };

  // Two 50-byte strings, then fifteen 16-bit fields in the order
  // `ScummEngine_v7::readMAXS` reads them. One is read and discarded there; it
  // is written as a plausible value so the block is not merely the right
  // length. 100 + 30 + 8 = 138, which is what `Chunk.size` reports.
  const maxs = chunk('MAXS', [
    ...versionString('Fixture engine v7'),
    ...versionString('Fixture data v7'),
    ...u16le(800), // variables
    ...u16le(2048), // bit variables
    ...u16le(40), // discarded
    ...u16le(600), // global objects
    ...u16le(200), // local objects
    ...u16le(50), // new names
    ...u16le(100), // verbs
    ...u16le(50), // FL objects
    ...u16le(80), // inventory
    ...u16le(50), // arrays
    ...u16le(100), // rooms
    ...u16le(200), // scripts
    ...u16le(100), // sounds
    ...u16le(9), // charsets
    ...u16le(30), // costumes
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
      // Room 2's `ROOM` is the first thing in its own `LFLF`, and directory
      // offsets are counted from that header.
      ...(secondRoom ? [{ room: 2, offset: 8 }] : []),
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

  // Three columns, not v6's two: state, then room, then class. v7 stores no
  // owner — ScummVM fills the owner table with 0xFF after reading — so an
  // importer that expects v6's packed owner/state byte reads the state column
  // as owners and the room column as states.
  const objectCount = 600;
  const states: number[] = [];
  const rooms: number[] = [];
  const classes: number[] = [];
  for (let i = 0; i < objectCount; i++) {
    const isFloating = secondRoom && i === V7_FLOATING_OBJECT;
    // State 2 because that is the state its child names as the one it belongs
    // to; in any other, the child is untouchable in the room it comes from.
    const isFloatingParent = secondRoom && i === V7_FLOATING_PARENT;
    states.push(i === 500 ? objectState : isFloating ? 1 : isFloatingParent ? 2 : 0);
    rooms.push(i === 500 ? 1 : isFloating || isFloatingParent ? V7_FLOATING_ROOM : 0);
    classes.push(...u32le(i === 500 || isFloating || isFloatingParent ? 1 << 23 : 0));
  }
  const dobj = chunk('DOBJ', [...u16le(objectCount), ...states, ...rooms, ...classes]);

  // Nine bytes of name per audio cue, which is what iMUSE Digital addresses its
  // bundle entries by. Not object names: those are still `OBNA` in the `OBCD`.
  const audioName = (text: string): number[] => {
    const bytes = [...tag(text)];
    while (bytes.length < 9) bytes.push(0);
    return bytes.slice(0, 9);
  };
  const anam = chunk('ANAM', [
    ...u16le(3),
    ...audioName('EXIT'),
    ...audioName('ROADHOUS'),
    ...audioName('BIKE'),
  ]);

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
    ...anam,
    ...aary,
  ];

  // Not encrypted: v7 data files are stored plain, so `encrypt` is deliberately
  // absent here where the v5 and v6 fixtures use it.
  return {
    index: new Uint8Array(indexBytes),
    data: new Uint8Array(lecf),
    indexName: 'FT.LA0',
    dataName: 'FT.LA1',
    language: buildLanguageTab(options.languageLines ?? V7_LANGUAGE_LINES),
    languageName: 'LANGUAGE.TAB',
  };
}

/** The size `MAXS` comes to, which is what identifies a v7 index. */
export const V7_MAXS_SIZE = 138;
