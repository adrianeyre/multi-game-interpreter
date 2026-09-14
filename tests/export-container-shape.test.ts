import { describe, expect, it } from 'vitest';

import { rewriteGame } from '../src/authoring/exportGame.js';
import { decryptCopy } from '../src/engine/resource/xor.js';
import { readU32LE } from '../src/engine/util/ByteStream.js';
import { buildFixture, XOR_KEY } from './fixture.js';

/**
 * Two things about a real `LECF` container that no fixture was shaped like.
 *
 * Both were found by exporting Fate of Atlantis and Day of the Tentacle with
 * nothing edited and comparing the result to the input — `npm run reexport`,
 * which is that check as a command. Neither could have been found here first,
 * and that is the point worth keeping. `docs/processes/verifying-version-support.md`
 * calls it Tier 1's trap: a fixture encodes this project's reading of a format,
 * and then the fixture and the engine agree with each other and disagree with
 * the game. These are the trap sprung, written down so the readings cannot
 * drift back.
 */

/** The fixture decrypted, which is the form the rewriter takes. */
function plain(options?: Parameters<typeof buildFixture>[0]) {
  const fixture = buildFixture(options);
  return {
    index: decryptCopy(fixture.index, XOR_KEY),
    data: decryptCopy(fixture.data, XOR_KEY),
  };
}

/**
 * Where LOFF's payload starts: the `LECF` header, then `LOFF`'s own.
 *
 * The payload is a count, then five bytes per room — one for the room number
 * and four for its offset. So for a single-room fixture the count is at `+0`,
 * the room number at `+1` and the offset at `+2`.
 */
const LOFF_PAYLOAD = 16;
const FIRST_ROOM = LOFF_PAYLOAD + 1;
const FIRST_OFFSET = LOFF_PAYLOAD + 2;

function loffTag(data: Uint8Array): string {
  return String.fromCharCode(data[8], data[9], data[10], data[11]);
}

/** The same container with its LOFF entry pointing at the block inside. */
function pointInsideTheBlock(data: Uint8Array): Uint8Array {
  const moved = new Uint8Array(data);
  const shifted = readU32LE(moved, FIRST_OFFSET) + 8;
  moved[FIRST_OFFSET] = shifted & 0xff;
  moved[FIRST_OFFSET + 1] = (shifted >> 8) & 0xff;
  moved[FIRST_OFFSET + 2] = (shifted >> 16) & 0xff;
  moved[FIRST_OFFSET + 3] = (shifted >> 24) & 0xff;
  return moved;
}

describe('a container whose LOFF points inside the LFLF', () => {
  /**
   * Both conventions ship, and the reader already knew it:
   * `ResourceManager.roomNumberForOffset` matches a LOFF entry against the
   * `LFLF` chunk's own offset *or* against the `ROOM` block inside it. The
   * writer knew only the first, so re-exporting Atlantis produced a container
   * whose every room was numbered 255 and whose every offset was eight bytes
   * short — a file that still loaded, because the reader is tolerant, and that
   * had lost which block was which room.
   */
  it('reproduces the offset base it was given, rather than imposing one', () => {
    const fixture = plain();
    const inside = pointInsideTheBlock(fixture.data);

    // The bias is real and this test would be vacuous without it.
    expect(readU32LE(inside, FIRST_OFFSET)).toBe(readU32LE(fixture.data, FIRST_OFFSET) + 8);
    expect(loffTag(inside)).toBe('LOFF');

    const rewritten = rewriteGame(fixture.index, inside, []);

    expect(Array.from(rewritten.data)).toEqual(Array.from(inside));
  });

  it('keeps the room number, rather than losing it to a failed lookup', () => {
    const fixture = plain();
    const inside = pointInsideTheBlock(fixture.data);
    const room = inside[FIRST_ROOM];

    const rewritten = rewriteGame(fixture.index, inside, []);

    // 255 is what a missed lookup used to write: `?? -1`, truncated to a byte.
    expect(rewritten.data[FIRST_ROOM]).toBe(room);
    expect(rewritten.data[FIRST_ROOM]).not.toBe(255);
  });

  it('still reproduces the other convention, which is what the fixtures write', () => {
    const fixture = plain();

    const rewritten = rewriteGame(fixture.index, fixture.data, []);

    expect(Array.from(rewritten.data)).toEqual(Array.from(fixture.data));
  });
});

describe('a container bigger than the call stack', () => {
  /**
   * The writer built every buffer as a `number[]` filled by spreading —
   * `payload.push(...bytes)`, `chunk('LFLF', [...block.bytes])`. A spread
   * passes each element as a separate argument, so the limit is not memory but
   * the call stack, somewhere in the low hundreds of thousands of bytes.
   *
   * Every fixture here is a few kilobytes. Fate of Atlantis is one 9MB block
   * and could not be exported at all: `RangeError: Maximum call stack size
   * exceeded`, out of a code path with coverage and no failing test.
   */
  it('exports a resource far larger than a spread can carry', () => {
    // Comfortably past the argument limit, and still quick to build.
    const big = new Array<number>(400_000).fill(0x00);
    const fixture = plain({ script2: big });

    expect(fixture.data.length).toBeGreaterThan(400_000);

    const rewritten = rewriteGame(fixture.index, fixture.data, []);

    expect(rewritten.data.length).toBe(fixture.data.length);
    expect(Array.from(rewritten.data)).toEqual(Array.from(fixture.data));
  });
});
