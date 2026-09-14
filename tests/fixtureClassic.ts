import { encodeSmallImage } from '../src/authoring/ImageEncoder.js';
import { buildCharsetPayload } from './fixture.js';

/**
 * Synthetic v2, v3 and v4 installs — the Tier 1 fixtures #201 and #203 ask for.
 *
 * Structurally valid all the way down: an index the resource layer walks, a
 * room with a header, a palette, boxes and a real encoded picture, an object
 * with a verb table and a name, and scripts the interpreter runs. What that
 * buys is the whole stack in CI — detection, the index, the container or the
 * file set, the room, the objects and the bytecode — for Versions whose games
 * are not on this machine.
 *
 * What it does **not** buy is any confidence that the reading is right, and
 * `verifying-version-support.md` is blunt about why: a fixture encodes our
 * reading of the format, so the fixture and the engine agree with each other
 * and may both disagree with the game. Everything here is transcribed from
 * ScummVM rather than measured against a shipped release. The one Version in
 * this family that *has* been measured is v4, against `games/loom`, and this
 * builder deliberately produces v4 too — so the same code that is checked
 * against a real install is the code the v3 and v2 fixtures exercise.
 */

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

/** A pre-v5 block: a little-endian size that includes the header, then a tag. */
function small(tag: string, payload: number[]): number[] {
  return [...u32(payload.length + 6), tag.charCodeAt(0), tag.charCodeAt(1), ...payload];
}

function xored(bytes: number[], key: number): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key;
  return out;
}

export interface ClassicFixtureOptions {
  version: 2 | 3 | 4;
  roomWidth?: number;
  roomHeight?: number;
  /** Sixteen colours rather than 256, which changes the codec and the table. */
  sixteenColour?: boolean;
  /** The boot script's bytes, in this Version's own encoding. */
  bootScript?: number[];
}

export interface ClassicFixture {
  version: 2 | 3 | 4;
  /** Every file the install ships, by name, ready for a `MemoryDataSource`. */
  files: Array<[string, Uint8Array]>;
  indexName: string;
  /** The room the fixture builds, for a test that wants to name it. */
  roomNumber: number;
  /** The object in that room, likewise. */
  objectId: number;
}

/** v2 stores a box as six byte coordinates rather than eight words. */
function narrowBoxes(version: 2 | 3 | 4): boolean {
  return version <= 2;
}

/** The one room every fixture builds: a header, palette, boxes and a picture. */
function buildRoom(
  version: 2 | 3 | 4,
  width: number,
  height: number,
  sixteenColour: boolean,
  entryScript: number[],
): { bytes: number[]; scriptOffset: number } {
  const colours = sixteenColour ? 16 : 256;
  const palette: number[] = [...u16(colours * 3)];
  for (let i = 0; i < colours; i++) {
    palette.push((i * 3) % 64, (i * 5) % 64, (i * 7) % 64);
  }

  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = i % colours;
  const picture = encodeSmallImage({ width, height, pixels }, sixteenColour);

  // One box across the bottom. The header and the stride both change before
  // v5: a byte count rather than a word, and no scale field at v3.
  const boxes: number[] = narrowBoxes(version)
    ? [1, 0, height - 1, 0, width / 8 - 1, 0, width / 8 - 1, 0, 0]
    : [
        1,
        ...u16(0),
        ...u16(height - 16),
        ...u16(width - 1),
        ...u16(height - 16),
        ...u16(width - 1),
        ...u16(height - 1),
        ...u16(0),
        ...u16(height - 1),
        0,
        0,
        ...(version >= 4 ? u16(255) : []),
      ];

  // v2 packs an object's last four fields into three bytes where v3 and v4
  // spend five, and its name offset moves with them.
  const narrow = version <= 2;
  const name = [...'lamp'].map((character) => character.charCodeAt(0));
  const headerBytes = narrow ? 11 : 13;
  // A verb number, a sixteen-bit offset and a zero terminator — four bytes.
  const verbTableBytes = 4;
  const nameOffset = 6 + headerBytes + verbTableBytes;
  // Where the handler actually is, counted from the `OC` block's own first
  // byte, which is what a pre-v5 verb table's offsets count from. Written as
  // zero for a while, which points at the block header: the engine decoded the
  // object's own id and position as instructions and ran off the end of the
  // block, and the sweep said so.
  const verbEntry = nameOffset + name.length + 1;
  const verbTable = [1, ...u16(verbEntry), 0];

  // Sixteen pixels square, and the header has to agree with the picture: the
  // height byte carries the height in its top five bits and the arrival
  // direction in its low three, so 0x11 is "sixteen high, facing 1". Written
  // as 0x21 for a while — thirty-two high — and the decoder duly read twice
  // the picture, taking whatever followed it as the bottom half.
  const objectHeader = narrow
    ? [...u16(700), 0, 4, 6, 2, 0, 8, 6, 0x11, nameOffset]
    : [...u16(700), 0, 4, 6, 2, 0, ...u16(64), ...u16(48), 0x11, nameOffset];

  const object = small('OC', [
    ...objectHeader,
    ...verbTable,
    ...name,
    0,
    // The verb handler the table points at, which is the whole point of the
    // object being here: a sweep runs it.
    0x00,
  ]);
  const objectImage = small('OI', [
    ...u16(700),
    ...encodeSmallImage(
      { width: 16, height: 16, pixels: new Uint8Array(256).fill(3) },
      sixteenColour,
    ),
  ]);

  const header = small('HD', [...u16(width), ...u16(height), ...u16(1)]);
  const entry = small('EN', entryScript);

  const children = [...header, ...palette2(palette), ...boxes2(boxes), ...bm(picture)];
  const scriptOffsetInRoom = 6 + children.length;
  const ro = small('RO', [...children, ...entry, ...objectImage, ...object]);
  return { bytes: ro, scriptOffset: scriptOffsetInRoom };
}

function palette2(payload: number[]): number[] {
  return small('PA', payload);
}

function boxes2(payload: number[]): number[] {
  return small('BX', payload);
}

function bm(payload: number[]): number[] {
  return small('BM', payload);
}

/**
 * The index every pre-v5 Version writes, in the shape its Version writes it.
 *
 * v4 is a series of blocks with two character tags; v2 and v3 are one record
 * opening with a magic word. The two are not variations on each other, which is
 * why they are built separately rather than parameterised.
 */
function buildLflIndex(version: 2 | 3, scriptOffset: number): number[] {
  // A realistic count, because the number matters to detection. v2 and v3 are
  // told apart by the width of this table, and on a table of two the two
  // readings can walk to the same end — a real release has seven or eight
  // hundred objects and the readings diverge by thousands of bytes.
  const objects = 100;
  const objectTable: number[] = [];
  for (let i = 0; i < objects; i++) {
    // v3 writes three class bytes and a packed owner/state byte; v2 writes the
    // packed byte alone.
    if (version >= 3) objectTable.push(0x01, 0x00, 0x00);
    objectTable.push(0x10);
  }

  return [
    ...u16(0x0100),
    ...u16(objects),
    ...objectTable,
    // Rooms: a count, a room-number column that carries nothing but is still
    // there, then one offset each.
    2,
    0,
    1,
    ...u16(0),
    ...u16(0),
    // Costumes: none.
    0,
    // Scripts: two, the first absent.
    2,
    0,
    1,
    ...u16(0xffff),
    ...u16(scriptOffset),
    // Sounds: none.
    0,
  ];
}

function buildLecIndex(scriptOffset: number): number[] {
  const objects = 2;
  const objectTable: number[] = [];
  for (let i = 0; i < objects; i++) objectTable.push(0x01, 0x00, 0x00, 0x10);

  return [
    ...small('RN', [
      1,
      ...[...'room'].map((c) => c.charCodeAt(0) ^ 0xff),
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0,
    ]),
    ...small('0R', [...u16(2), 1, ...u32(0), 1, ...u32(0)]),
    ...small('0S', [...u16(2), 0, ...u32(0xffffffff), 1, ...u32(scriptOffset)]),
    ...small('0N', [...u16(1), 0, ...u32(0xffffffff)]),
    ...small('0C', [...u16(1), 0, ...u32(0xffffffff)]),
    ...small('0O', [...u16(objects), ...objectTable]),
  ];
}

export function buildClassicFixture(options: ClassicFixtureOptions): ClassicFixture {
  const { version } = options;
  const width = options.roomWidth ?? 320;
  const height = options.roomHeight ?? 144;
  const sixteenColour = options.sixteenColour ?? version <= 3;

  // Written in each Version's own encoding, which is the point of having three
  // fixtures rather than one: v2 assigns with a one byte variable reference
  // and v3 and v4 with two.
  const bootScript =
    version <= 2 ? [0x1a, 100, ...u16(1234), 0x00] : [0x1a, ...u16(100), ...u16(1234), 0x00];
  const entryScript =
    version <= 2 ? [0x1a, 101, ...u16(7), 0x00] : [0x1a, ...u16(101), ...u16(7), 0x00];

  const room = buildRoom(version, width, height, sixteenColour, entryScript);
  const script = small('SC', options.bootScript ?? bootScript);

  if (version === 4) {
    // `LF`'s payload is the room number and then the resources, and a
    // directory offset counts from the `RO` block rather than from the `LF`.
    const body = [...u16(1), ...room.bytes, ...script];
    const roomOffset = 6 + 6 + 1 + 5;
    const container = small('LE', [
      ...small('FO', [1, 1, ...u32(roomOffset)]),
      ...small('LF', body),
    ]);

    return {
      version,
      files: [
        ['000.LFL', new Uint8Array(buildLecIndex(room.bytes.length))],
        ['DISK01.LEC', xored(container, 0x69)],
        // A real font rather than a stub. v4 keeps a charset in a file of its
        // own, opening with a 32-bit size where v5 puts a `CHAR` header — so
        // the payload the v5 and v6 fixtures wrap in a chunk *is* the file
        // here, and its glyph offsets land on the base a v4 charset uses.
        // Without one the engine draws no text at all, which makes every
        // question about where a printed line goes unanswerable below v5.
        ['901.LFL', new Uint8Array(buildCharsetPayload())],
      ],
      indexName: '000.LFL',
      roomNumber: 1,
      objectId: 700,
    };
  }

  // v2 and v3: the room is its own file and a resource offset is an offset
  // into it, so the script follows the `RO` block with nothing in between.
  const roomFile = [...room.bytes, ...script];
  const key = version === 3 ? 0xff : 0x00;

  return {
    version,
    files: [
      ['00.LFL', xored(buildLflIndex(version, room.bytes.length), key)],
      ['01.LFL', xored(roomFile, key)],
    ],
    indexName: '00.LFL',
    roomNumber: 1,
    objectId: 700,
  };
}
