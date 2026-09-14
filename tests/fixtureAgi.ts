/**
 * Builds synthetic but structurally valid AGI games in memory.
 *
 * The same reasoning as `fixture.ts` does for SCUMM: the resource layer is the
 * part most likely to break silently on a refactor, and it cannot be tested
 * against real game data, which is copyrighted and not redistributable.
 *
 * `docs/processes/verifying-version-support.md` names the trap this walks into,
 * and it is worth restating because AGI walks into it harder than SCUMM does: a
 * synthetic fixture "encodes our reading of the format — if that reading is
 * wrong, the fixture and the engine agree with each other and disagree with the
 * game." Every layout below is transcribed from the AGI Specification and from
 * ScummVM's own readers rather than inferred from what our code expects, and
 * the byte offsets are spelled out in comments so a future reader can check the
 * transcription rather than trust it.
 *
 * The blind spot that remains is the same one SCUMM has, and it is accepted
 * rather than worked around: CI runs on this fixture, and the real check is
 * `npm run diagnose` against a fetched freeware game (#125).
 */

import { AGI_DIR_NAMES } from '../src/engine/agi/resource/agiDetect.js';

export function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function u16be(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/**
 * The key AGI obfuscates Logic messages and the OBJECT file with.
 *
 * Eleven bytes, applied cyclically from the start of the encrypted region. Not
 * encryption in any useful sense — it is Lance Ewing's own observation that
 * Sierra used a colleague's name — but it has to be applied or every message
 * reads as noise.
 */
export const AVIS_DURGAN = 'Avis Durgan';

export function avisDurgan(bytes: number[]): number[] {
  return bytes.map((byte, index) => byte ^ AVIS_DURGAN.charCodeAt(index % AVIS_DURGAN.length));
}

// --------------------------------------------------------------- resources --

export interface LogicSpec {
  /** Bytecode, already assembled. */
  code: number[];
  /** Messages, 1-indexed as `print` addresses them. */
  messages: string[];
  /**
   * Whether to obfuscate the message text.
   *
   * True for every v2 resource and for an uncompressed v3 one; false for a v3
   * resource that was LZW-compressed, because ScummVM's own condition is
   * `~flags & RES_COMPRESSED` — the compression already obscures the text and
   * the interpreter does not decrypt on top of it.
   */
  encrypt?: boolean;
}

/**
 * A LOGIC resource.
 *
 * Layout, from ScummVM's `decodeLogic` and the AGI Specification:
 *
 *   0..1                     bytecode size, little-endian
 *   2..2+size-1              bytecode
 *   m = 2 + size             message count, one byte
 *   m+1..m+2                 total size of the message section, little-endian
 *   m+3..m+3+2*count-1       one 16-bit offset per message
 *   m+3+2*count..            the message text, NUL-separated
 *
 * Each message offset is **relative to `m + 1`**, not to the section start and
 * not to the file — the one detail no prose source states outright and the one
 * that puts every string one byte out if it is guessed. A zero offset means the
 * message is absent.
 *
 * The encrypted region is the text only: the count byte, the size field and the
 * offset table are plain.
 */
export function buildLogic(spec: LogicSpec): number[] {
  const encrypt = spec.encrypt ?? true;
  const count = spec.messages.length;

  const texts: number[][] = spec.messages.map((message) => [
    ...[...message].map((character) => character.charCodeAt(0)),
    0,
  ]);

  // Offsets are relative to `m + 1`, and the text begins at `m + 3 + 2*count`,
  // so the first message's offset is `2 + 2*count`.
  const offsets: number[] = [];
  let cursor = 2 + 2 * count;
  for (const text of texts) {
    offsets.push(cursor);
    cursor += text.length;
  }

  const textBytes = texts.flat();
  // The size field covers itself, the offset table and the text — which is why
  // ScummVM subtracts `2 + 2 * count` from it to get the text length.
  const messagesSize = 2 + 2 * count + textBytes.length;

  return [
    ...u16le(spec.code.length),
    ...spec.code,
    count,
    ...u16le(messagesSize),
    ...offsets.flatMap(u16le),
    ...(encrypt ? avisDurgan(textBytes) : textBytes),
  ];
}

/** One cel of a View: a pixel grid in 16 EGA colours, plus its transparency. */
export interface CelSpec {
  width: number;
  height: number;
  transparent: number;
  /** Row-major colour indices, `width * height` of them. */
  pixels: number[];
}

export interface LoopSpec {
  cels: CelSpec[];
  /**
   * The loop this one is a mirror of, when it is one.
   *
   * A mirrored loop is stored once and flipped at render time, and the *source*
   * loop's number is written into each cel's third byte. Two entries in the
   * View's loop offset table then point at the same bytes.
   */
  mirrorOf?: number;
}

/**
 * Run-length encodes one cel.
 *
 * Each byte is `(colour << 4) | runLength`, so a run is at most fifteen pixels
 * and a colour is one nibble. A zero byte ends the row. A trailing run of the
 * transparent colour may be omitted, and is here, because a reader that cannot
 * cope with a short row cannot read a real game's Views.
 */
function encodeCel(cel: CelSpec): number[] {
  const out: number[] = [];
  for (let y = 0; y < cel.height; y++) {
    const row = cel.pixels.slice(y * cel.width, (y + 1) * cel.width);
    // Drop the trailing transparent run, as Sierra's own tools do.
    let end = row.length;
    while (end > 0 && row[end - 1] === cel.transparent) end--;

    let x = 0;
    while (x < end) {
      const colour = row[x];
      let run = 1;
      while (x + run < end && row[x + run] === colour && run < 15) run++;
      out.push(((colour & 0x0f) << 4) | run);
      x += run;
    }
    out.push(0);
  }
  return out;
}

/**
 * A VIEW resource.
 *
 *   0     unknown, always 1 or 2 in real games
 *   1     unknown, always 1
 *   2     number of loops
 *   3..4  offset to the description string, or 0 for none
 *   5..   one 16-bit offset per loop, relative to the start of the resource
 *
 * A loop is:
 *
 *   0     number of cels
 *   1..   one 16-bit offset per cel, relative to the start of the loop
 *
 * A cel is:
 *
 *   0     width in AGI pixels (each two EGA pixels wide)
 *   1     height
 *   2     mirror info in the high nibble, transparent colour in the low one:
 *         bit 7 says this cel is mirrored, bits 4..6 hold the number of the
 *         loop that is *not* mirrored — the source the flip is taken from
 *   3..   run-length encoded rows
 */
export function buildView(loops: LoopSpec[], description?: string): number[] {
  const loopBodies: number[][] = [];
  // A mirrored loop shares its source's bytes exactly, so its body is not
  // emitted a second time — two offsets point at one place, which is how a real
  // game stores it and the thing a reader has to cope with.
  const bodyIndexForLoop: number[] = [];

  for (const [index, loop] of loops.entries()) {
    if (loop.mirrorOf !== undefined) {
      bodyIndexForLoop[index] = bodyIndexForLoop[loop.mirrorOf];
      continue;
    }
    const cels = loop.cels.map((cel) => {
      const mirrored = loops.some((other) => other.mirrorOf === index);
      const mirrorBits = mirrored ? 0x80 | ((index & 0x07) << 4) : 0;
      return [cel.width, cel.height, mirrorBits | (cel.transparent & 0x0f), ...encodeCel(cel)];
    });

    // Cel offsets are relative to the loop's own start, past its header.
    const header = 1 + cels.length * 2;
    const celOffsets: number[] = [];
    let cursor = header;
    for (const cel of cels) {
      celOffsets.push(cursor);
      cursor += cel.length;
    }
    bodyIndexForLoop[index] = loopBodies.length;
    loopBodies.push([cels.length, ...celOffsets.flatMap(u16le), ...cels.flat()]);
  }

  const descriptionBytes = description
    ? [...[...description].map((character) => character.charCodeAt(0)), 0]
    : [];

  const headerSize = 5 + loops.length * 2;
  const bodyStarts: number[] = [];
  let cursor = headerSize + descriptionBytes.length;
  for (const body of loopBodies) {
    bodyStarts.push(cursor);
    cursor += body.length;
  }

  return [
    2,
    1,
    loops.length,
    ...u16le(description ? headerSize : 0),
    ...loops.map((_loop, index) => u16le(bodyStarts[bodyIndexForLoop[index]])).flat(),
    ...descriptionBytes,
    ...loopBodies.flat(),
  ];
}

/**
 * A PICTURE resource: a list of draw commands, terminated by 0xFF.
 *
 * Passed through as given, because a Picture *is* its command stream — the
 * stored form is the editable form, which is the whole reason picture editing
 * is easier here than in SCUMM (#135).
 */
export function buildPicture(commands: number[]): number[] {
  return [...commands, 0xff];
}

/** One note: a duration in 1/60ths, a frequency divisor, and an attenuation. */
export interface NoteSpec {
  /** Duration in 1/60ths of a second. */
  duration: number;
  /** The ten-bit divisor of the 111,860 Hz clock. Zero means a rest. */
  divisor: number;
  /** 0 is full volume and 15 is silence, as the SN76496's attenuation is. */
  attenuation: number;
}

/**
 * A SOUND resource: four voice streams behind a table of offsets.
 *
 *   0..1  offset of voice 1 (tone, and the melody)
 *   2..3  offset of voice 2 (tone)
 *   4..5  offset of voice 3 (tone)
 *   6..7  offset of the noise voice
 *
 * Each voice is a run of five-byte notes and ends with two 0xFF bytes:
 *
 *   0..1  duration, little-endian, in 1/60ths of a second
 *   2     bit 7 clear, bits 5..0 the top six bits of the ten-bit divisor
 *   3     bit 7 set, bits 6..4 the chip register, bits 3..0 the low four bits
 *   4     bit 7 set, bits 6..4 the register, bits 3..0 the attenuation
 */
export function buildSound(voices: NoteSpec[][]): number[] {
  const bodies = voices.map((notes, voice) =>
    [
      ...notes.flatMap((note) => [
        ...u16le(note.duration),
        (note.divisor >> 4) & 0x3f,
        0x80 | (((voice * 2) & 0x07) << 4) | (note.divisor & 0x0f),
        0x80 | (((voice * 2 + 1) & 0x07) << 4) | (note.attenuation & 0x0f),
      ]),
      0xff,
      0xff,
    ].flat(),
  );

  const offsets: number[] = [];
  let cursor = 8;
  for (const body of bodies) {
    offsets.push(cursor);
    cursor += body.length;
  }

  return [...offsets.flatMap(u16le), ...bodies.flat()];
}

// ------------------------------------------------------------ the volumes --

export interface ResourceSpec {
  type: 'logic' | 'picture' | 'view' | 'sound';
  number: number;
  bytes: number[];
  /**
   * v3 only: store this resource compressed.
   *
   * `'lzw'` for a LOGIC, VIEW or SOUND; `'picture'` for the nibble packing a
   * Picture gets instead. Absent stores it as-is, which real v3 games also do —
   * the flag is per resource, not per game.
   */
  compress?: 'lzw' | 'picture';
}

const TYPE_TO_DIR = { logic: 0, picture: 1, view: 2, sound: 3 } as const;

export interface AgiFixture {
  files: Map<string, Uint8Array>;
  /** Which resources went in, so a test can assert against the intent. */
  resources: ResourceSpec[];
}

/**
 * Packs resources into a volume and its indexes.
 *
 * One volume, because the directory entry's four-bit volume number and
 * twenty-bit offset are exercised by the offsets rather than by the count — and
 * a second volume is added by the test that cares about it.
 */
function packVolume(
  resources: ResourceSpec[],
  major: 2 | 3,
): { volume: number[]; tables: number[][] } {
  const volume: number[] = [];
  const tables: number[][] = [[], [], [], []];
  // A slot per resource number, filled with the absent marker, so a sparse
  // game — which every AGI game is — round-trips.
  const highest = [0, 0, 0, 0];
  for (const resource of resources) {
    const dir = TYPE_TO_DIR[resource.type];
    highest[dir] = Math.max(highest[dir], resource.number);
  }
  for (const [dir, top] of highest.entries()) {
    tables[dir] = new Array((top + 1) * 3).fill(0xff);
  }

  for (const resource of resources) {
    const offset = volume.length;
    const stored = storedBytes(resource);

    if (major === 2) {
      volume.push(0x12, 0x34, 0, ...u16le(resource.bytes.length), ...stored);
    } else {
      // The top bit of byte 2 says "this is a Picture", which is what tells a
      // nibble-packed Picture apart from an LZW-compressed anything-else — the
      // two lengths differ in both cases.
      const flag = resource.compress === 'picture' ? 0x80 : 0;
      volume.push(
        0x12,
        0x34,
        flag,
        ...u16le(resource.bytes.length),
        ...u16le(stored.length),
        ...stored,
      );
    }

    const dir = TYPE_TO_DIR[resource.type];
    const at = resource.number * 3;
    // Volume number in the high nibble, then twenty bits of offset.
    tables[dir][at] = ((0 & 0x0f) << 4) | ((offset >> 16) & 0x0f);
    tables[dir][at + 1] = (offset >> 8) & 0xff;
    tables[dir][at + 2] = offset & 0xff;
  }

  return { volume, tables };
}

function storedBytes(resource: ResourceSpec): number[] {
  if (resource.compress === 'lzw') return lzwCompress(resource.bytes);
  if (resource.compress === 'picture') return packPictureNibbles(resource.bytes);
  return resource.bytes;
}

/** An AGI v2 game: four `*DIR` files and `VOL.0`. */
export function buildAgiV2Fixture(resources: ResourceSpec[] = defaultResources()): AgiFixture {
  const { volume, tables } = packVolume(resources, 2);
  const files = new Map<string, Uint8Array>();
  for (const [index, name] of AGI_DIR_NAMES.entries()) {
    files.set(name.toUpperCase(), new Uint8Array(tables[index]));
  }
  files.set('VOL.0', new Uint8Array(volume));
  return { files, resources };
}

/**
 * An AGI v3 game: one `<GAMEID>DIR` and `<GAMEID>VOL.0`.
 *
 * The combined index is an eight-byte header of four little-endian offsets —
 * logdir, picdir, viewdir, snddir — then the four tables back to back. The
 * first offset is always 8, the header being fixed-size.
 */
export function buildAgiV3Fixture(
  resources: ResourceSpec[] = defaultV3Resources(),
  gameId = 'fx',
): AgiFixture {
  const { volume, tables } = packVolume(resources, 3);

  const offsets: number[] = [];
  let cursor = 8;
  for (const table of tables) {
    offsets.push(cursor);
    cursor += table.length;
  }

  const files = new Map<string, Uint8Array>();
  files.set(
    `${gameId.toUpperCase()}DIR`,
    new Uint8Array([...offsets.flatMap(u16le), ...tables.flat()]),
  );
  files.set(`${gameId.toUpperCase()}VOL.0`, new Uint8Array(volume));
  return { files, resources };
}

// ---------------------------------------------------------- v3 compression --

/**
 * The encoder for AGI v3's adaptive LZW, written only so the fixture can be
 * compressed.
 *
 * Deliberately a *separate* implementation from the decoder rather than its
 * inverse: a fixture built by inverting the decoder would agree with the
 * decoder whatever either of them did, which is the trap this file's header
 * warns about, one level down. This follows the format description — nine-bit
 * codes growing as the dictionary fills, 256 to reset, 257 to end — and the
 * round-trip test is then a real check rather than a tautology.
 */
export function lzwCompress(bytes: number[]): number[] {
  const out: number[] = [];
  let bitBuffer = 0;
  let bitCount = 0;
  let bits = 9;

  const emit = (code: number): void => {
    bitBuffer |= code << bitCount;
    bitCount += bits;
    while (bitCount >= 8) {
      out.push(bitBuffer & 0xff);
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  // The codes this resource is made of, worked out first, so the width
  // bookkeeping below can be a separate pass. Standard LZW: extend the current
  // string while the dictionary knows it, and emit the longest match when it
  // stops knowing it.
  const codes: number[] = [];
  const dictionary = new Map<string, number>();
  // 258, because the decoder's first iteration burns entry 257 on a
  // meaningless prefix — see `lzwDecompress`. Numbering from 258 here is what
  // makes the two agree about which string every code above 257 names.
  let dictNext = 258;
  let current: number[] = [];

  const codeFor = (run: number[]): number =>
    run.length === 1 ? run[0] : (dictionary.get(run.join(',')) as number);

  for (const byte of bytes) {
    const candidate = [...current, byte];
    if (candidate.length === 1 || dictionary.has(candidate.join(','))) {
      current = candidate;
      continue;
    }
    codes.push(codeFor(current));
    if (dictNext < 1 << 11) dictionary.set(candidate.join(','), dictNext++);
    current = [byte];
  }
  if (current.length > 0) codes.push(codeFor(current));

  // Every compressed resource opens with a reset, per the specification's own
  // observation that 256 "seems to be the first code stored in all compressed
  // resources" — and the decoder's pre-loop depends on it being there.
  emit(256);

  /**
   * The decoder's own width bookkeeping, mirrored.
   *
   * Its `next` starts at 257 and advances once per code read after the first,
   * with the widen check — `next > (1 << bits) - 2` — running *before* the
   * entry is stored. Reproducing that here rather than deriving the encoder's
   * own rule is the point: a naive encoder widens one code early, and one code
   * early does not fail, it silently produces different bytes.
   */
  let mirrorNext = 257;
  for (const [index, code] of [...codes, 257].entries()) {
    if (index >= 1) {
      if (mirrorNext > (1 << bits) - 2 && bits < 11) bits++;
      mirrorNext++;
    }
    emit(code);
  }

  if (bitCount > 0) out.push(bitBuffer & 0xff);
  return out;
}

/**
 * Nibble-packs a Picture, the way an AGI v3 game stores one.
 *
 * The argument to `set visual colour` (0xF0) and `set priority colour` (0xF2)
 * is packed into four bits rather than eight, because there are only sixteen
 * colours — so everything after such a command sits off the byte boundary. The
 * specification's example, which is the clearest statement of it:
 *
 *   plain:      F0 06 F8 12 45 F0 07 F2 05 F8 14 67
 *   as stored:  F0 6F 81 24 5F 07 F2 5F 81 46 7
 */
export function packPictureNibbles(bytes: number[]): number[] {
  const nibbles: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    const code = bytes[index++];
    nibbles.push((code >> 4) & 0x0f, code & 0x0f);
    if ((code === 0xf0 || code === 0xf2) && index < bytes.length) {
      nibbles.push(bytes[index++] & 0x0f);
    }
  }
  if (nibbles.length % 2 === 1) nibbles.push(0);

  const out: number[] = [];
  for (let at = 0; at < nibbles.length; at += 2) {
    out.push((nibbles[at] << 4) | nibbles[at + 1]);
  }
  return out;
}

// ------------------------------------------------------- the fixture game --

/**
 * A tiny but complete game: two Logics, a Picture, a View and a Sound.
 *
 * `logic.0` is the one AGI runs every cycle. It moves the game into room 1 on
 * the first cycle and does nothing after that, which is the smallest thing that
 * is actually a game rather than a resource dump.
 */
export function defaultResources(): ResourceSpec[] {
  return [
    { type: 'logic', number: 0, bytes: buildLogic(bootLogic()) },
    { type: 'logic', number: 1, bytes: buildLogic(roomLogic()) },
    { type: 'picture', number: 1, bytes: buildPicture(samplePicture()) },
    { type: 'view', number: 0, bytes: buildView(sampleLoops()) },
    { type: 'sound', number: 1, bytes: buildSound(sampleVoices()) },
  ];
}

/** The same game, with v3's per-resource compression exercised both ways. */
export function defaultV3Resources(): ResourceSpec[] {
  return [
    // Compressed, so its messages are *not* Avis Durgan obfuscated — which is
    // ScummVM's own condition and an easy thing to get backwards.
    {
      type: 'logic',
      number: 0,
      bytes: buildLogic({ ...bootLogic(), encrypt: false }),
      compress: 'lzw',
    },
    // Uncompressed in a v3 volume, which real v3 games also contain: the flag
    // is per resource, not per game.
    { type: 'logic', number: 1, bytes: buildLogic(roomLogic()) },
    { type: 'picture', number: 1, bytes: buildPicture(samplePicture()), compress: 'picture' },
    { type: 'view', number: 0, bytes: buildView(sampleLoops()), compress: 'lzw' },
    { type: 'sound', number: 1, bytes: buildSound(sampleVoices()), compress: 'lzw' },
  ];
}

/**
 * `logic.0`, which AGI runs every cycle.
 *
 * The shape every AGI game's logic 0 has: set the game up on the first cycle,
 * then hand over to the room's own Logic by calling the Logic whose number is
 * the current room. That last step is what makes a room's script run at all —
 * AGI has no room-entry hook, only `call.v(v0)`.
 *
 * Variable 0 is the current room number; flag 5 is "this is a new room".
 */
export function bootLogic(): LogicSpec {
  return {
    code: [
      // if (isset(f11)) { new.room(1); }
      // Flag 11 is true only while logic 0 is running for the first time, which
      // is how an AGI game does its one-off setup without a boot script.
      0xff, // start the condition list
      0x07,
      11, // isset(f11)
      0xff, // end the condition list
      ...u16le(2), // skip 2 bytes if false
      0x12,
      1, // new.room(1)
      // call.v(v0) — run the current room's Logic
      0x17,
      0,
      0x00, // return
    ],
    messages: ['Welcome to the fixture.'],
  };
}

export function roomLogic(): LogicSpec {
  return {
    code: [
      // if (isset(f5)) { load.pic(v0); draw.pic(v0); show.pic; }
      // Flag 5 is true for exactly the first cycle in a room, which is how
      // every AGI room draws its picture once rather than every cycle.
      0xff,
      0x07,
      5,
      0xff,
      ...u16le(5),
      0x18,
      0, // load.pic(v0)
      0x19,
      0, // draw.pic(v0)
      0x1a, // show.pic
      // if (said("look")) { print(m2); } — word group 1
      0xff,
      0x0e,
      1,
      ...u16le(1),
      0xff,
      ...u16le(2),
      0x65,
      2, // print(m2)
      0x00, // return
    ],
    messages: ['You are in a small room.', 'Nothing but walls.'],
  };
}

/**
 * A picture with every command class in it.
 *
 * Deliberately includes a fill, because a fill that leaks is the fault #127
 * says no unit test catches — a test can at least assert it did not escape the
 * buffer, which is the half that is checkable.
 */
export function samplePicture(): number[] {
  return [
    0xf0,
    15, // visual colour 15 (white), picture draw on
    0xf6,
    10,
    10,
    100,
    10,
    100,
    80,
    10,
    80,
    10,
    10, // absolute line: a closed box
    0xf2,
    4, // priority colour 4, priority draw on
    0xf6,
    10,
    10,
    100,
    10,
    100,
    80,
    10,
    80,
    10,
    10,
    0xf1, // picture draw off
    0xf3, // priority draw off
    0xf0,
    2, // visual colour 2 (green)
    0xf8,
    50,
    40, // fill inside the box
    0xf7,
    20,
    90,
    0x11,
    0x22, // relative line from (20,90)
    0xf9,
    0, // pen size 0, solid circle
    0xfa,
    30,
    120, // plot with pen
  ];
}

/** Four loops, the fourth a mirror of the second — the case only eyes catch. */
export function sampleLoops(): LoopSpec[] {
  const cel = (colour: number): CelSpec => ({
    width: 4,
    height: 3,
    transparent: 0,
    // A shape that is not symmetrical, so a mirror that did not flip is
    // visible rather than plausible.
    pixels: [colour, colour, 0, 0, colour, 0, 0, 0, colour, colour, colour, 0],
  });

  return [
    { cels: [cel(1), cel(2)] },
    { cels: [cel(3), cel(4)] },
    { cels: [cel(5)] },
    { cels: [], mirrorOf: 1 },
  ];
}

export function sampleVoices(): NoteSpec[][] {
  return [
    // Middle C-ish, then a rest, on the melody voice.
    [
      { duration: 30, divisor: 428, attenuation: 0 },
      { duration: 15, divisor: 0, attenuation: 15 },
    ],
    [{ duration: 45, divisor: 856, attenuation: 4 }],
    [{ duration: 45, divisor: 642, attenuation: 4 }],
    // The noise channel, which is the fourth voice and not a tone.
    [{ duration: 20, divisor: 1, attenuation: 8 }],
  ];
}
