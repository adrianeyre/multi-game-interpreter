import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import {
  SUPPORTED_VERSIONS,
  type ScummVersion,
  describeUnsupportedVersion,
  detectGame,
} from '../src/engine/resource/GameDetector.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildFixture, chunk, XOR_KEY } from './fixture.js';

/**
 * Which SCUMM version a set of files is, and what happens when it is one there
 * is no interpreter for.
 *
 * The version used to be detected, logged and then dropped on the floor: the
 * only thing that read it was the log line naming it. A v6 game therefore got
 * as far as booting, where the v5 opcode set ran over v6 bytecode and produced
 * a black screen with no error — the worst of the available outcomes, because
 * it looks identical to a bug in a game that *is* supported.
 */

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

function encrypt(bytes: number[]): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ^ XOR_KEY) & 0xff;
  return out;
}

/** A game whose index is `indexBytes`, paired with a data file so it is found. */
function gameWith(indexBytes: number[], stem = 'TESTGAME'): MemoryDataSource {
  const source = new MemoryDataSource(stem);
  source.set(`${stem}.000`, encrypt(indexBytes));
  source.set(`${stem}.001`, encrypt([...chunk('LECF', [])]));
  return source;
}

/**
 * A v6 index: the same chunk layout as v5, but MAXS grew from 26 bytes to 38.
 * That size is the only thing detection needs, so the rest is left empty.
 */
function v6Index(): number[] {
  return [...chunk('RNAM', [0]), ...chunk('MAXS', new Array(30).fill(0))];
}

/**
 * A v7 index. MAXS is two 50-byte version strings followed by *fifteen* 16-bit
 * counts — 130 bytes of payload, 138 with the header — which is the only thing
 * detection needs from it.
 *
 * This was written as sixteen counts and 140 bytes, from counting the fields
 * rather than reading them; `ScummEngine_v7::readMAXS` makes fifteen
 * `readUint16LE` calls. Both the fixture and the size table were wrong
 * together, and both games still reached the right answer through the
 * size fallback, which is precisely the shape of agreement that hides a fault.
 */
function v7Index(): number[] {
  return [...chunk('RNAM', [0]), ...chunk('MAXS', new Array(130).fill(0))];
}

/**
 * A v8 index: two version strings then *seventeen* 32-bit counts, 168 bytes.
 *
 * Same correction as v7's, and this one has teeth: with v7 supported, a v8
 * game misidentified as v7 no longer changes which titles a refusal names, it
 * runs The Curse of Monkey Island through the v7 interpreter.
 */
function v8Index(): number[] {
  return [...chunk('RNAM', [0]), ...chunk('MAXS', new Array(168).fill(0))];
}

/** A v5 index, from the real fixture. */
function v5Index(): Uint8Array {
  return buildFixture().index;
}

/**
 * A block in a pre-v5 index: little-endian size (including the 6 byte header)
 * then a *two* character tag, where v5 has a four character tag and a
 * big-endian size.
 */
function oldBlock(tag: string, payload: number[]): number[] {
  return [
    ...u32le(payload.length + 6),
    ...[...tag].map((character) => character.charCodeAt(0)),
    ...payload,
  ];
}

/** A v3/v4 index: room names, then the room directory. */
function oldIndex(): number[] {
  return [...oldBlock('RN', [0]), ...oldBlock('0R', [...u16le(1), 0])];
}

describe('SCUMM version detection', () => {
  it('identifies the v5 fixture as v5', async () => {
    const source = new MemoryDataSource('v5');
    const fixture = buildFixture();
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    expect((await detectGame(source)).version).toBe(5);
  });

  it('reads the version from the MAXS size rather than the file name', async () => {
    // Named like a v5 game, shaped like a v6 one. The name loses.
    expect((await detectGame(gameWith(v6Index(), 'MONKEY2'))).version).toBe(6);
  });

  it('is not fooled into v6 by a v5 index', async () => {
    const source = new MemoryDataSource('v5');
    source.set('TESTGAME.000', v5Index());
    source.set('TESTGAME.001', encrypt(chunk('LECF', [])));

    expect((await detectGame(source)).version).toBe(5);
  });
});

describe('accepting the versions that have an interpreter', () => {
  it('accepts a v6 game rather than refusing it', async () => {
    // This used to be a refusal test. v6 now has a script engine, so the
    // detector's job for it is to say "6" and get out of the way.
    expect((await detectGame(gameWith(v6Index(), 'TENTACLE'))).version).toBe(6);
  });

  it('accepts a v7 game rather than refusing it', async () => {
    // This used to be a refusal test too. v7 now has a reader.
    expect((await detectGame(gameWith(v7Index(), 'FT'))).version).toBe(7);
  });

  it('accepts a v8 game rather than refusing it', async () => {
    // The last of the three conversions this file records. v8 has a script
    // engine, a 32-bit index reader and a writer, so detection's job for it is
    // the same as for every other Version: say the number and get out of the
    // way.
    expect((await detectGame(gameWith(v8Index(), 'COMI'))).version).toBe(8);
  });

  it('names every version it implements, and there are seven', () => {
    expect([...SUPPORTED_VERSIONS]).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
});

/**
 * The refusal itself, asked of the function rather than through detection.
 *
 * Unreachable now — every member of `ScummVersion` has an interpreter — and
 * the seam is kept for the Version that arrives before its engine does. A
 * guard with no test is a guard that has rotted by the time it is needed, so
 * it is exercised directly instead of through a detection path that can no
 * longer produce it.
 */
describe('the refusal a version with no interpreter would get', () => {
  it('names the version it found and the file it looked at', () => {
    const refusal = describeUnsupportedVersion(9 as ScummVersion, 'COMI.000');
    expect(refusal).toMatch(/SCUMM v9/);
    expect(refusal).toMatch(/COMI\.000/);
  });

  it('lists the versions there are interpreters for', () => {
    expect(describeUnsupportedVersion(9 as ScummVersion, 'COMI.000')).toMatch(
      /v2, v3, v4, v5, v6, v7 and v8/,
    );
  });

  it('points at a game the reader is likely to have', () => {
    expect(describeUnsupportedVersion(9 as ScummVersion, 'COMI.000')).toMatch(/Atlantis/);
  });
});

describe('reading a version from the shape of its index', () => {
  it('reads a pre-v5 index as v4 rather than misreading it as v5', async () => {
    // The bug this covers: no MAXS chunk anywhere, so the old code fell through
    // to `return 5` and handed a v4 index to the v5 parser. v4 now has an
    // interpreter, so the answer is the version rather than a refusal — the
    // thing being asserted is still that it is not called v5.
    const game = await detectGame(gameWith(oldIndex(), 'MONKEY'));
    expect(game.version).toBe(4);
    expect(game.layout).toBe('lec-disks');
  });

  it('names the file it read the version out of', async () => {
    const game = await detectGame(gameWith(v8Index(), 'COMI'));
    expect(game.indexFile).toBe('COMI.000');
    expect(game.identification).toBe('index-structure');
  });

  /**
   * Full Throttle is v7, and there was no branch that could ever conclude v7:
   * the heuristic recognised v4 and v6 and defaulted everything else to v5. So
   * FT was relabelled v5 and let through — all 148.8 MB of it read and
   * decrypted, then its v7 scripts executed as v5 bytecode. The log filled
   * with unimplemented opcodes whose byte dumps were ASCII text, the
   * interpreter having walked into a string and read the characters as
   * instructions.
   */
  it('reads a v7 game as v7 rather than relabelling it v5', async () => {
    // Still the same assertion the refusal made, and still the one that
    // matters: the answer must be 7. What changed is what happens next.
    expect((await detectGame(gameWith(v7Index(), 'FT'))).version).toBe(7);
  });

  it('reads a v8 index as v8, on its 176 byte MAXS', async () => {
    expect((await detectGame(gameWith(v8Index(), 'COMI'))).version).toBe(8);
  });

  it('reads a v7 game whose files use the .LA0 naming', async () => {
    // FT ships FT.LA0 / FT.LA1, which the loader accepts interchangeably with
    // .000/.001, so the pair is identified from the index rather than the name.
    const source = new MemoryDataSource('fullthrottle.zip');
    source.set('FT.LA0', new Uint8Array(v7Index()));
    source.set('FT.LA1', new Uint8Array([...chunk('LECF', [])]));

    expect((await detectGame(source)).version).toBe(7);
  });

  it('reads a MAXS too big to be v5 as v7, even at a size it does not know', async () => {
    // A release variant whose MAXS is not one of the four known sizes. It is
    // far too big to be v5's nine 16-bit counts, and between v7's 138 and v8's
    // 176 there is nothing else it could be.
    const index = [...chunk('RNAM', [0]), ...chunk('MAXS', new Array(142).fill(0))];
    expect((await detectGame(gameWith(index, 'DIG'))).version).toBe(7);
  });

  it('does not call an unrecognised v8-sized MAXS v7', async () => {
    // The other end of that guess, and now the whole of what it costs: both
    // versions run, so a v8 game read as v7 is The Curse of Monkey Island on
    // the wrong interpreter rather than one refusal wearing another's text.
    const index = [...chunk('RNAM', [0]), ...chunk('MAXS', new Array(178).fill(0))];
    const game = await detectGame(gameWith(index, 'COMI'));
    expect(game.version).toBe(8);
    // Not a size any release writes, so the answer is a guess and says so —
    // which is what stops it being edited (ADR 0013).
    expect(game.identification).toBe('guess');
  });

  it('still reads a MAXS near the v5 size as v5', async () => {
    // The other side of that threshold: a v5 block padded by a few bytes must
    // not be refused as a later version.
    const index = [...chunk('RNAM', [0]), ...chunk('MAXS', new Array(22).fill(0))];
    expect((await detectGame(gameWith(index, 'TESTGAME'))).version).toBe(5);
  });

  it('still loads a v5 game', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('v5');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    await expect(ScummEngine.create(source)).resolves.toBeDefined();
  });
});
