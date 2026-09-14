/**
 * Lure's picture decompressor.
 *
 * `lureDisk.ts` established that Lure's *palettes* are uncompressed and that
 * finding was over-generalised into "Lure stores its resources uncompressed".
 * Its pictures carry their own scheme, and this is the reader for it.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeLurePicture, LureDecodeError } from '../src/engine/lure/gfx/lureDecode.js';
import {
  parseLureDisk,
  readLureResource,
  lureDiskNumberFor,
  isLurePalette,
} from '../src/engine/lure/resource/lureDisk.js';

/**
 * Builds a resource in the format: a 1 KB favourites table, the literal
 * stream's offset, then the bit stream, then the literals.
 *
 * `bits` is written most-significant-bit first, which is the order the decoder
 * consumes them in — and the ninth bit of the first byte is the one the
 * original's `CL = 9` accounts for, so a fixture that forgets it desynchronises
 * exactly one bit in.
 */
function buildPicture(options: {
  table?: Uint8Array;
  bitStream: number[];
  literals: number[];
}): Uint8Array {
  const bitStream = Uint8Array.from(options.bitStream);
  const literals = Uint8Array.from(options.literals);
  const literalAt = 0x404 + bitStream.length;
  const out = new Uint8Array(literalAt + literals.length);
  if (options.table) out.set(options.table.subarray(0, 0x400), 0);
  new DataView(out.buffer).setUint32(0x400, literalAt, true);
  out.set(bitStream, 0x404);
  out.set(literals, literalAt);
  return out;
}

describe('decodeLurePicture', () => {
  it('refuses something too short to be a picture', () => {
    expect(() => decodeLurePicture(new Uint8Array(16), 64000)).toThrow(LureDecodeError);
  });

  it('refuses a literal-stream pointer outside the resource', () => {
    const bytes = new Uint8Array(0x500);
    new DataView(bytes.buffer).setUint32(0x400, 0x99999, true);
    expect(() => decodeLurePicture(bytes, 64000)).toThrow(/literal stream starts at/);
  });

  it('writes a literal, then ends when the stream says so', () => {
    // First bit clear then set selects the run/end branch; a zero count and a
    // zero marker is the end of the picture.
    const bytes = buildPicture({ bitStream: [0b01000000], literals: [0x41, 0x00, 0x00] });
    expect([...decodeLurePicture(bytes, 64000)]).toEqual([0x41]);
  });

  it('expands a run of one byte repeated', () => {
    // Same branch, but a non-zero count repeats the current index's byte.
    //
    // The *prefix* is asserted and not the whole output. Hand-writing a bit
    // stream that then terminates exactly where intended needs the original's
    // `CL = 9` accounted for bit by bit, and a fixture built on a shaky
    // reading of that would be asserting this test's misunderstanding rather
    // than the decoder's behaviour. What the run does is checkable without it;
    // termination is covered by the test above and by the shipped data below.
    const bytes = buildPicture({
      bitStream: [0b01000000, 0b01000000],
      literals: [0x07, 0x04, 0x00, 0x00],
    });
    const out = decodeLurePicture(bytes, 64000);
    expect([...out.subarray(0, 5)]).toEqual([0x07, 0x07, 0x07, 0x07, 0x07]);
  });

  it('refuses to run past the limit rather than truncating', () => {
    const bytes = buildPicture({
      bitStream: [0b01000000, 0b01000000],
      literals: [0x07, 0xff, 0x00, 0x00],
    });
    expect(() => decodeLurePicture(bytes, 4)).toThrow(/not a picture/);
  });
});

/**
 * And against the shipped containers, which is the only evidence that matters:
 * a fixture encodes this project's reading of the format, so the two agree by
 * construction.
 */
describe('the shipped containers', () => {
  const dir = join(process.cwd(), 'games', 'lure-of-the-temptress');

  /**
   * Whether the game's data is here, which is **not** whether its folder is.
   *
   * `games/<slug>/` is tracked — it carries a README and cover art — so the
   * directory exists on every checkout and only its contents are gitignored.
   * Guarding on the directory made this pass locally and fail on CI with
   * "expected 0 to be 99": the skip never fired, and there was nothing to
   * decode. The guard has to name a file the game ships.
   */
  const present = existsSync(join(dir, 'Disk1.vga'));

  it.skipIf(!present)(
    'hold 99 pictures that decode to exactly the 320x192 game area',
    async () => {
      let gameArea = 0;
      const lengths = new Set<number>();
      for (const name of ['Disk1.vga', 'Disk2.vga', 'Disk3.vga', 'Disk4.vga']) {
        const path = join(dir, name);
        if (!existsSync(path)) continue;
        const bytes = new Uint8Array(await readFile(path));
        const disk = parseLureDisk(bytes, lureDiskNumberFor(name) ?? undefined);
        for (const resource of disk.resources) {
          const data = readLureResource(bytes, disk, resource.id);
          if (!data || isLurePalette(data)) continue;
          try {
            const pixels = decodeLurePicture(data, 320 * 192);
            lengths.add(pixels.length);
            if (pixels.length === 320 * 192) gameArea += 1;
          } catch {
            // Not a picture. Most resources are not, and that is not a failure.
          }
        }
      }

      // The count is the evidence the decompressor is right: a wrong one
      // desynchronises within a few hundred bytes and stops at scattered
      // lengths, so 99 resources landing on one exact size is the finding.
      expect(gameArea).toBe(99);
      expect(lengths.has(320 * 192)).toBe(true);
    },
    120_000,
  );
});
