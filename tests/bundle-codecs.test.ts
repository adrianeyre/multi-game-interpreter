import { describe, expect, it } from 'vitest';
import { decompressBundleBlock } from '../src/engine/sound/v7/bundleCodecs.js';

/**
 * Encodes bytes as codec 1's bit stream: every byte a literal.
 *
 * The control word is **not** written in neat sixteen-byte groups. The decoder
 * refills its mask from wherever the read pointer has reached at the moment the
 * sixteenth bit is consumed — which is in the middle of a literal run, one byte
 * before the literal that bit belongs to. So the encoder has to run the same
 * state machine to know where to put the next word.
 *
 * Writing this naively, in tidy groups, produced a stream the decoder read
 * exactly half of: the first test of it failed at twenty bytes out of forty,
 * which is the encoder being wrong rather than the decoder.
 */
function literals(bytes: number[]): Uint8Array {
  const out: number[] = [];
  // Reserve the first control word; every bit is a literal, so it is all ones.
  out.push(0xff, 0xff);
  let bitsLeft = 16;

  for (const byte of bytes) {
    // The bit for this literal is consumed *before* the byte is read, and the
    // refill happens on the consuming call.
    if (--bitsLeft === 0) {
      out.push(0xff, 0xff);
      bitsLeft = 16;
    }
    out.push(byte);
  }
  return new Uint8Array(out);
}

describe('decompressing a bundle block', () => {
  it('copies a stored block through unchanged', () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    expect([...decompressBundleBlock(0, input, 4)!]).toEqual([1, 2, 3, 4]);
  });

  it('does not read past the block’s declared size', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5, 6]);
    expect(decompressBundleBlock(0, input, 3)).toHaveLength(3);
  });

  it('decodes a run of literals', () => {
    const out = decompressBundleBlock(1, literals([7, 8, 9]), 3)!;
    expect([...out]).toEqual([7, 8, 9]);
  });

  it('refills its control mask every sixteen bits', () => {
    // The failure this guards: a decoder that refills late reads control bits
    // as data from byte seventeen onward, which produces a plausible-length
    // block of noise.
    const bytes = Array.from({ length: 40 }, (_, i) => i & 0xff);
    const out = decompressBundleBlock(1, literals(bytes), 40)!;
    expect([...out]).toEqual(bytes);
  });

  it('accumulates one delta pass for codec 2', () => {
    // Codec 2 is codec 1's output read as differences. Applying the wrong
    // number of passes gives audio that is recognisably the right sound and
    // audibly wrong, rather than silence.
    const out = decompressBundleBlock(2, literals([10, 1, 1, 1]), 4)!;
    expect([...out]).toEqual([10, 11, 12, 13]);
  });

  it('accumulates two delta passes for codec 3', () => {
    const out = decompressBundleBlock(3, literals([10, 1, 1, 1]), 4)!;
    // Second-order: the inner pass makes [10, 1, 2, 3], the outer [10, 11, 13, 16].
    expect([...out]).toEqual([10, 11, 13, 16]);
  });

  it('stops at the output size rather than overrunning the block', () => {
    const out = decompressBundleBlock(1, literals([1, 2, 3, 4, 5]), 3)!;
    expect(out).toHaveLength(3);
  });

  it('names an unimplemented codec rather than guessing', () => {
    // 13 and 15 are the ADPCM variants ScummVM records as The Curse of Monkey
    // Island's, which is v8. Audio decoded with the wrong codec is noise at the
    // right length, which passes every check except listening.
    expect(decompressBundleBlock(13, new Uint8Array([1, 2, 3]), 16)).toBeNull();
    expect(decompressBundleBlock(15, new Uint8Array([1, 2, 3]), 16)).toBeNull();
  });

  it('survives a truncated block instead of looping', () => {
    expect(decompressBundleBlock(1, new Uint8Array([0]), 16)).toHaveLength(0);
  });
});
