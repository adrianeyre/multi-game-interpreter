import { buildCharsetPayload, buildSmap, chunk, u16le, u32le } from './fixture.js';

/**
 * Builds a synthetic but structurally valid SCUMM v8 game in memory.
 *
 * The same reasoning as the v5, v6 and v7 fixtures, and the same warning,
 * which matters more here than anywhere else in this repository: **The Curse
 * of Monkey Island is not on this machine.** Every claim below is read out of
 * ScummVM rather than measured against a shipped game, so this fixture and the
 * reader agree with each other and may both disagree with the game. That is
 * the Tier 1 trap `verifying-version-support.md` names, and v8 is the Version
 * currently sitting in it: what would settle it is a person with the game and
 * a named checkpoint.
 *
 * Every structural claim therefore cites the ScummVM source it comes from, and
 * those citations are the thing to check in review — not whether the tests
 * pass, which they will either way.
 *
 * What v8 does differently, and where each is established:
 *
 * - **The index counts in thirty-two bits.** `MAXS` is two 50-byte version
 *   strings and then seventeen 32-bit counts, and every resource directory
 *   opens with a 32-bit entry count. (`ScummEngine_v8::readMAXS`,
 *   `ScummEngine::readResTypeList`.)
 * - **`DOBJ` is records, not columns**, and each record opens with a forty
 *   byte object *name*. (`ScummEngine_v8::readGlobalObjects`.)
 * - **A room is two resources.** `ROOM` holds the header, the palette, the
 *   boxes and the object images; a sibling `RMSC` in the same `LFLF` holds the
 *   entry, exit and local scripts and the object *code*. Its directory in the
 *   index is `DRSC`. (`ScummEngine::setupRoomSubBlocks`, which fetches
 *   `rtRoomScripts` separately, and `ScummEngine_v8::readIndexBlock`.)
 * - **`RMHD` is 32-bit**: a version, then width, height, object count, z-plane
 *   count and transparency, all as words. (`RoomHeader.v8` in `object.h`.)
 * - **`IMHD` opens with a name**, thirty-two bytes of it, and everything after
 *   is 32-bit. There is no object id in it at all, which is why the name table
 *   above is load-bearing. (`ImageHeader.v8`, and
 *   `ScummEngine_v8::getObjectIdFromOBIM`.)
 * - **A picture is reached through a table.** `IMAG` > `WRAP` > `OFFS` holds
 *   32-bit offsets to the `SMAP`s, in place of a run of `IMxx` blocks — for a
 *   room's background as much as for an object's states.
 *   (`ScummEngine::getObjectImage`.)
 * - **A verb table is pairs of words.** Verb number and offset, both 32-bit,
 *   terminated by a zero verb. (`ScummEngine::getVerbEntrypoint`.)
 * - **A local script's number is 32-bit**, where v7 writes two bytes and
 *   everything earlier writes one. (`ScummEngine::setupRoomSubBlocks`.)
 * - **A walk box is fifty-six bytes**: eight 32-bit coordinates, then mask,
 *   flags, scale slot and scale as words of their own. (`Box.v8` in
 *   `boxes.cpp`, and `getBoxBaseAddr`, which indexes from four rather than
 *   two.)
 *
 * And what does *not* change, each worth checking because the opposite is
 * plausible: `CDHD` is v7's, unwidened; the container is still `LECF` with
 * `LOFF` and `LFLF`; and the bytes of a script are the stack encoding v6
 * introduced, renumbered rather than reshaped (ADR 0006).
 */

/** v8 keeps an object's name in forty bytes in the index. */
const INDEX_NAME_BYTES = 40;

/** …and in thirty-two in an `IMHD`, which is not the same number. */
const IMHD_NAME_BYTES = 32;

/** The `IMHD` version the retail game writes. 800 is the demo's, without flags. */
const IMHD_VERSION = 801;

/** The room this fixture builds, and the object in it. */
export const V8_ROOM = 1;
export const V8_OBJECT_ID = 17;
export const V8_OBJECT_NAME = 'grog machine';
export const V8_VERB = 4;
export const V8_LOCAL_SCRIPT = 2001;

/**
 * A v8 script: push a word, write it to a variable, stop.
 *
 * The stack encoding with v8's numbering, and both halves of that matter. The
 * *encoding* is v6's — a value is pushed by an instruction of its own — so
 * `pushWord` is 0x01 here as it is there. The *numbering* is not: `writeWordVar`
 * is 0x43 at v6 and 0x6d at v8, and `stopObjectCode` is 0x65 there and 0x7b
 * here. And the immediate is four bytes rather than two, which is the whole of
 * what "32-bit immediates" means for a script's bytes.
 *
 * Written with the numbers this project's own v8 table carries, so a fixture
 * that stops decoding is a disagreement worth chasing rather than a typo.
 */
export const V8_SCRIPT: number[] = [
  0x01, // pushWord
  ...u32le(55),
  0x6d, // writeWordVar — v6's 0x43, renumbered
  ...u32le(260),
  0x7b, // stopObjectCode — v6's 0x65, renumbered
];

function fixedString(text: string, length: number): number[] {
  const out = new Array<number>(length).fill(0);
  for (let i = 0; i < Math.min(text.length, length); i++) out[i] = text.charCodeAt(i);
  return out;
}

/** `IMAG` > `WRAP` > `OFFS` > one `SMAP`, which is how v8 stores a picture. */
function imag(smap: number[]): number[] {
  // The `OFFS` table is a 32-bit entry per state, counted from the `OFFS`
  // block's own first byte, and entry zero is the table's own size.
  const offs = chunk('OFFS', [...u32le(8 + 4), ...u32le(8 + 4 + 4)]);
  return chunk('IMAG', chunk('WRAP', [...offs, ...smap]));
}

/** A v8 walk box: eight 32-bit corners, then four 32-bit fields. */
function box(): number[] {
  return [
    ...u32le(0),
    ...u32le(0), // upper left
    ...u32le(320),
    ...u32le(0), // upper right
    ...u32le(320),
    ...u32le(144), // lower right
    ...u32le(0),
    ...u32le(144), // lower left
    ...u32le(0), // mask
    ...u32le(0), // flags
    ...u32le(0), // scale slot — none, so the scale below is the box's own
    ...u32le(255), // scale
    ...u32le(0),
    ...u32le(0), // two words ScummVM reads nothing out of
  ];
}

function roomBlock(): number[] {
  return chunk('ROOM', [
    ...chunk('RMHD', [
      ...u32le(801), // version
      ...u32le(320), // width
      ...u32le(144), // height
      ...u32le(1), // objects
      ...u32le(1), // z-planes
      ...u32le(0), // transparency
    ]),
    ...chunk(
      'CLUT',
      new Array(768).fill(0).map((_, i) => i % 256),
    ),
    ...chunk('BOXD', [...u32le(1), ...box()]),
    ...chunk('RMIM', [...chunk('RMIH', u16le(0)), ...imag(buildSmap(40, 144, 1))]),
    ...chunk('OBIM', [
      ...chunk('IMHD', [
        ...fixedString(V8_OBJECT_NAME, IMHD_NAME_BYTES),
        ...u32le(0),
        ...u32le(0), // the eight bytes ScummVM reads nothing out of
        ...u32le(IMHD_VERSION),
        ...u32le(1), // image count
        ...u32le(64), // x
        ...u32le(32), // y
        ...u32le(16), // width
        ...u32le(24), // height
        ...u32le(90), // facing, as an angle
        ...u32le(0), // flags
        ...new Array(15 * 2).fill(0).flatMap(() => u32le(0)),
      ]),
      ...imag(buildSmap(2, 24, 9)),
    ]),
  ]);
}

function roomScriptsBlock(): number[] {
  // Verb number and offset, both 32-bit, terminated by a zero verb. The
  // offset is counted from the `VERB` chunk's *payload* — three words of table
  // is where the code starts — which is v8's own convention and one this
  // fixture would rather state than inherit.
  const verbTable = [...u32le(V8_VERB), ...u32le(4 * 3), ...u32le(0)];
  return chunk('RMSC', [
    ...chunk('ENCD', V8_SCRIPT),
    ...chunk('EXCD', V8_SCRIPT),
    ...chunk('LSCR', [...u32le(V8_LOCAL_SCRIPT), ...V8_SCRIPT]),
    ...chunk('OBCD', [
      ...chunk('CDHD', [
        ...u32le(801), // version
        ...u16le(V8_OBJECT_ID),
        0, // parent
        0, // parent state
      ]),
      ...chunk('VERB', [...verbTable, ...V8_SCRIPT]),
      ...chunk('OBNA', [...V8_OBJECT_NAME.split('').map((c) => c.charCodeAt(0)), 0]),
    ]),
  ]);
}

export interface V8Fixture {
  indexName: string;
  dataName: string;
  index: Uint8Array;
  data: Uint8Array;
  files: Array<[string, Uint8Array]>;
  /** Where the object's verb code starts inside the `RMSC` block. */
  verbEntry: number;
}

export function buildV8Fixture(): V8Fixture {
  const room = roomBlock();
  const scripts = roomScriptsBlock();

  const lflf = chunk('LFLF', [...room, ...scripts]);
  // `LOFF` is a count and then a room number with a 32-bit offset each, and
  // the offset is where the `LFLF` starts inside the container.
  const loff = chunk('LOFF', [1, V8_ROOM, ...u32le(0)]);
  const container = chunk('LECF', [...loff, ...lflf]);

  // The `LFLF` sits after `LECF`'s header and the whole `LOFF`, and `LOFF`'s
  // own offsets are absolute within the container — so it has to be patched
  // once the sizes are known rather than guessed at.
  const lflfAt = 8 + loff.length;
  const data = new Uint8Array(container);
  data.set(new Uint8Array(u32le(lflfAt)), 8 + 8 + 1 + 1);

  const index = new Uint8Array([
    ...chunk('RNAM', [0]),
    ...chunk('MAXS', [
      ...fixedString('v8 engine', 50),
      ...fixedString('v8 data', 50),
      ...u32le(1500), // variables
      ...u32le(2048), // bit variables
      ...u32le(40),
      ...u32le(2), // scripts
      ...u32le(1), // sounds
      ...u32le(1), // charsets
      ...u32le(1), // costumes
      ...u32le(2), // rooms
      ...u32le(80),
      ...u32le(64), // global objects
      ...u32le(60),
      ...u32le(200), // local objects
      ...u32le(100),
      ...u32le(128),
      ...u32le(80), // inventory
      ...u32le(200),
      ...u32le(50), // verbs
    ]),
    ...directory('DROO', [
      [0, 0],
      [V8_ROOM, 0],
    ]),
    ...directory('DRSC', [
      [0, 0],
      [V8_ROOM, 0],
    ]),
    ...directory('DSCR', [[V8_ROOM, 0]]),
    ...directory('DCOS', [[V8_ROOM, 0]]),
    ...directory('DCHR', [[V8_ROOM, 0]]),
    ...directory('DSOU', [[V8_ROOM, 0]]),
    ...chunk('DOBJ', [
      ...u32le(64),
      ...new Array(64).fill(0).flatMap((_, i) => [
        ...fixedString(i === V8_OBJECT_ID ? V8_OBJECT_NAME : '', INDEX_NAME_BYTES),
        1, // state
        V8_ROOM, // room
        ...u32le(0), // class
      ]),
    ]),
  ]);

  return {
    indexName: 'COMI.LA0',
    dataName: 'COMI.LA1',
    index,
    data,
    files: [
      ['COMI.LA0', index],
      ['COMI.LA1', data],
    ],
    // Past the `VERB` header and the table's own three words.
    verbEntry: 8 + 4 * 3,
  };
}

/** A directory: a 32-bit count, then room numbers, then 32-bit offsets. */
function directory(name: string, entries: Array<[number, number]>): number[] {
  return chunk(name, [
    ...u32le(entries.length),
    ...entries.map(([room]) => room),
    ...entries.flatMap(([, offset]) => u32le(offset)),
  ]);
}

/** Re-exported so a v8 test can build a charset without reaching for v5's. */
export { buildCharsetPayload };
