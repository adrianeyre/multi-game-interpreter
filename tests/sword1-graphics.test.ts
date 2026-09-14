import { describe, expect, it } from 'vitest';
import {
  compressionOf,
  decodeSwordFrame,
  decodeSwordParallaxRow,
  decompressHIF,
  decompressRLE0,
  decompressRLE7,
  decompressTony,
  fastShrink,
  parseSwordParallax,
  SwordDecodeError,
} from '../src/engine/sword1/gfx/swordDecode.js';
import {
  compressRLE0,
  compressRLE7,
  compressSwordParallaxRow,
  compressTony,
  compressHIF,
  encodeSwordFrame,
  encodeSwordParallax,
  swordEncodeRefusal,
  swordHifClaim,
} from '../src/engine/sword1/gfx/swordEncode.js';
import { SwordScreen } from '../src/engine/sword1/gfx/SwordScreen.js';
import {
  composeSwordMask,
  decomposeSwordMask,
  parseSwordGrid,
  MASK_BLOCK_BYTES,
  SCRNGRID_X,
  SCRNGRID_Y,
  SWORD1_GRID_CELLS_AT,
} from '../src/engine/sword1/gfx/swordMask.js';
import { SwordText } from '../src/engine/sword1/gfx/SwordText.js';
import { CPT, SwordCompact } from '../src/engine/sword1/resource/swordCompact.js';
import type { SwordObjects } from '../src/engine/sword1/resource/SwordObjects.js';
import { SWORD1_ROOMS } from '../src/engine/sword1/resource/swordRooms.js';
import { SwordResources } from '../src/engine/sword1/resource/SwordResources.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { buildSpriteResource, buildSwordFixture, Writer } from './fixtureSword.js';
import {
  SWORD1_CZECH_GAME_FONT,
  SWORD1_GAME_FONT,
  SWORD1_SCREEN_WIDTH,
  sword1SpriteFrames,
  SwordStatus,
  SwordType,
} from '../src/engine/sword1/resource/swordDefs.js';

/** Three clusters and no font: the shape both "missing" assertions want. */
const BARE = [
  {
    label: 'COMPACTS',
    groups: 1,
    resources: [{ group: 0, index: 0, bytes: new Uint8Array(4) }],
  },
  {
    label: 'GENERAL',
    groups: 1,
    resources: [{ group: 0, index: 0, bytes: new Uint8Array(4) }],
  },
  {
    label: 'SCRIPTS',
    groups: 1,
    resources: [{ group: 0, index: 0, bytes: new Uint8Array(4) }],
  },
];

describe('RLE7', () => {
  it('treats a byte over 127 as a literal and 1..127 as a run of n + 1', () => {
    // 200 literal; run of 3 twos; 0 literal (a transparent pixel, not a run).
    const out = new Uint8Array(8);
    const written = decompressRLE7(Uint8Array.from([200, 2, 2, 0]), 4, out);
    expect(written).toBe(5);
    expect(Array.from(out.subarray(0, 5))).toEqual([200, 2, 2, 2, 0]);
  });

  it('reads zero as a literal, which is the case that desynchronises a naive reader', () => {
    // If zero were a run, the following 9 would be consumed as its colour and
    // the 9 would vanish from the output.
    const out = new Uint8Array(4);
    decompressRLE7(Uint8Array.from([0, 200]), 2, out);
    expect(Array.from(out.subarray(0, 2))).toEqual([0, 200]);
  });

  it('refuses to run past the frame rather than corrupting the next one', () => {
    expect(() => decompressRLE7(Uint8Array.from([100, 7]), 2, new Uint8Array(4))).toThrow(
      SwordDecodeError,
    );
  });
});

describe('RLE0', () => {
  it('is RLE7 mirrored: a non-zero byte is a literal and zero begins a skip', () => {
    const out = new Uint8Array(8);
    const written = decompressRLE0(Uint8Array.from([5, 0, 3, 6]), 4, out);
    expect(written).toBe(5);
    expect(Array.from(out.subarray(0, 5))).toEqual([5, 0, 0, 0, 6]);
  });
});

describe('Tony', () => {
  it('always reads a flat part and then a literal part, in that order', () => {
    const out = new Uint8Array(8);
    // 2 flat 7s, then 3 literals; then 0 flat, then 1 literal.
    decompressTony(Uint8Array.from([2, 7, 3, 1, 2, 3, 0, 1, 9]), 9, out);
    expect(Array.from(out.subarray(0, 6))).toEqual([7, 7, 1, 2, 3, 9]);
  });
});

describe('HIF', () => {
  it('copies literals when the control bit is clear', () => {
    const out = new Uint8Array(8);
    // Control byte 0x00: eight literals.
    const written = decompressHIF(Uint8Array.from([0x00, 1, 2, 3, 4, 5, 6, 7, 8]), out);
    expect(written).toBe(8);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('back-copies byte at a time, so a distance of one is a run', () => {
    const out = new Uint8Array(8);
    // Literal 0xAB, then a match: repeat nibble 0 (so 2 + 1 = 3 bytes copied)
    // at distance 1. A block copy would read uninitialised bytes instead.
    decompressHIF(Uint8Array.from([0b01000000, 0xab, 0x00, 0x00, 0xff, 0xff]), out);
    expect(Array.from(out.subarray(0, 4))).toEqual([0xab, 0xab, 0xab, 0xab]);
  });

  it('reads its info word big-endian, in an otherwise little-endian format', () => {
    // 0x1000 big-endian is repeat 1, distance 1; read little-endian it would be
    // 0x0010 — repeat 0, distance 17 — which back-copies from before the start.
    const out = new Uint8Array(8);
    decompressHIF(Uint8Array.from([0b01000000, 0x5a, 0x10, 0x00, 0xff, 0xff]), out);
    expect(out[1]).toBe(0x5a);
  });
});

describe('choosing a decoder', () => {
  it('tests the tag by character, the way the original does', () => {
    expect(compressionOf('RLE7')).toBe('rle7');
    expect(compressionOf('RLE0')).toBe('rle0');
    expect(compressionOf('xIxx')).toBe('tony');
    expect(compressionOf('Nu  ')).toBe('raw');
  });

  it('ignores the tag entirely on the PlayStation conversion', () => {
    // The conversion recompressed every sprite with HIF and left the old tags,
    // so believing the tag there draws noise.
    expect(compressionOf('RLE7', true)).toBe('hif');
  });
});

describe('decoding a frame', () => {
  it('leaves transparency where a decoder stops short, not stale pixels', () => {
    const pixels = decodeSwordFrame(Uint8Array.from([200]), 'rle7', 1, 4, 1);
    expect(Array.from(pixels)).toEqual([200, 0, 0, 0]);
  });
});

/** Decoding what an encoder wrote, which is the only check that means anything. */
function roundTrip(pixels: Uint8Array, compression: 'rle7' | 'rle0' | 'tony'): number[] {
  const written = encodeSwordFrame(pixels, compression);
  return Array.from(
    decodeSwordFrame(written.bytes, written.compression, written.bytes.length, pixels.length, 1),
  );
}

describe('writing RLE7 back', () => {
  it('spends a run on a pair rather than two literals, the way the original did', () => {
    // Both are two bytes and both decode alike, so this is a choice and not a
    // deduction — it is here because the shipped frames make it.
    expect(Array.from(compressRLE7(Uint8Array.from([200, 200])) ?? [])).toEqual([1, 200]);
  });

  it('writes a run remainder of one as a literal, never as code 0', () => {
    // 129 copies split 128 + 1, and code 0 is a *literal zero*: emitting it as
    // the one-long tail writes a transparent pixel and eats the next code.
    const pixels = new Uint8Array(129).fill(200);
    expect(Array.from(compressRLE7(pixels) ?? [])).toEqual([127, 200, 200]);
    expect(roundTrip(pixels, 'rle7')).toEqual(Array.from(pixels));
  });

  it('moves the split back a pixel when the tail could not be a literal', () => {
    // Colour 50 has no literal form, so 129 copies go 127 + 2 rather than
    // 128 + 1 — the second of which has no encoding at all.
    const pixels = new Uint8Array(129).fill(50);
    expect(Array.from(compressRLE7(pixels) ?? [])).toEqual([126, 50, 1, 50]);
    expect(roundTrip(pixels, 'rle7')).toEqual(Array.from(pixels));
  });

  it('declines a lone pixel of a colour it cannot say, and the frame goes raw', () => {
    // Literals are 0 and 128..255 and a run is at least two, so one pixel of
    // colour 50 between two others is simply not expressible. A decoder can
    // never produce that, but an imported picture can.
    const pixels = Uint8Array.from([200, 50, 201]);
    expect(compressRLE7(pixels)).toBeNull();
    const written = encodeSwordFrame(pixels, 'rle7');
    expect(written.compression).toBe('raw');
    expect(written.tag).toBe('NONE');
    expect(written.retagged).toContain('between 1 and 127');
    expect(Array.from(written.bytes)).toEqual([200, 50, 201]);
  });
});

describe('writing RLE0 back', () => {
  it('writes a zero run as a length pair and everything else as itself', () => {
    const pixels = Uint8Array.from([5, 0, 0, 0, 6]);
    expect(Array.from(compressRLE0(pixels))).toEqual([5, 0, 3, 6]);
    expect(roundTrip(pixels, 'rle0')).toEqual([5, 0, 0, 0, 6]);
  });

  it('splits a zero run longer than a length byte can hold', () => {
    const pixels = new Uint8Array(300);
    pixels[299] = 9;
    expect(Array.from(compressRLE0(pixels)).slice(0, 4)).toEqual([0, 255, 0, 44]);
    expect(roundTrip(pixels, 'rle0')).toEqual(Array.from(pixels));
  });
});

describe('writing Tony back', () => {
  it('fills a literal block to exactly 255 by cutting a run in half', () => {
    // Stopping at 254 with a run sitting one byte past the cap is the obvious
    // implementation and is not what the original wrote.
    const pixels = new Uint8Array(4 + 254 + 3);
    pixels.fill(9, 0, 4);
    for (let at = 0; at < 254; at++) pixels[4 + at] = at % 2 === 0 ? 1 : 2;
    pixels.fill(7, 4 + 254);
    const bytes = compressTony(pixels);
    expect(Array.from(bytes.subarray(0, 3))).toEqual([4, 9, 255]);
    expect(Array.from(bytes.subarray(bytes.length - 2))).toEqual([2, 7]);
    expect(roundTrip(pixels, 'tony')).toEqual(Array.from(pixels));
  });

  it('writes no trailing literal header when the frame ends on a flat block', () => {
    expect(Array.from(compressTony(Uint8Array.from([7, 7, 7, 7])))).toEqual([4, 7]);
  });

  it('keeps a run below the threshold as literals, because it is cheaper', () => {
    // Three 5s cost three literal bytes and two bytes plus a restarted pair as
    // a run, so four is where a run starts paying.
    expect(Array.from(compressTony(Uint8Array.from([1, 5, 5, 5, 2])))).toEqual([
      1, 1, 4, 5, 5, 5, 2,
    ]);
  });
});

describe('writing HIF, which is measured in pixels and not in bytes', () => {
  /** Encoded, decoded with the reader that already existed, read as pixels. */
  function throughHif(pixels: Uint8Array): number[] {
    const out = new Uint8Array(pixels.length);
    decompressHIF(compressHIF(pixels), out);
    return Array.from(out);
  }

  it('claims pixels rather than bytes, and refuses nothing', () => {
    // The refusal this replaces was about the wrong property: it said a
    // re-encode would not reproduce Revolution's bytes, which is true of every
    // LZ encoder that is not Revolution's and is not what a frame needs.
    expect(swordEncodeRefusal('hif')).toBeNull();
    expect(swordHifClaim()).toContain('pixels');
    expect(swordHifClaim()).toContain('sweep:sword');
  });

  it('reads back a frame of literals with no match in it', () => {
    const pixels = Uint8Array.from([9, 3, 7, 1, 4, 8, 2, 6, 5]);
    expect(throughHif(pixels)).toEqual(Array.from(pixels));
  });

  it('reads back a flat frame, which is one match at distance one', () => {
    // Distance one is a run, because the decoder copies a byte at a time from
    // a moving source. An encoder that refused to point at its own output
    // would write 4,000 literals for a frame of transparency.
    const pixels = new Uint8Array(4000).fill(0);
    expect(throughHif(pixels)).toEqual(Array.from(pixels));
    // And it is worth a size check, because this is the case a frame of a
    // sprite mostly is: 4,000 pixels as matches of eighteen.
    expect(compressHIF(pixels).length).toBeLessThan(1000);
  });

  it('reads back a frame whose matches overlap what they copy', () => {
    const pixels = new Uint8Array(600);
    for (let at = 0; at < pixels.length; at++) pixels[at] = at % 3;
    expect(throughHif(pixels)).toEqual(Array.from(pixels));
  });

  it('reads back a repeated block far enough back to need the whole window', () => {
    const block = Uint8Array.from({ length: 40 }, (_unused, at) => (at * 37) % 251);
    const pixels = new Uint8Array(4200);
    for (let at = 0; at < pixels.length; at++) pixels[at] = (at * 131) % 241;
    pixels.set(block, 0);
    pixels.set(block, 4096);
    expect(throughHif(pixels)).toEqual(Array.from(pixels));
  });

  it('writes the one match `0xFFFF` would swallow a byte shorter instead', () => {
    // Eighteen bytes from 4,096 back encodes as the word that ends the stream,
    // so it has to be written as seventeen. If it were not, the decoder would
    // stop at that match and everything after it would be transparency — which
    // is what the tail of this frame is checking.
    const run = Uint8Array.from({ length: 18 }, (_unused, at) => 200 + at);
    const pixels = new Uint8Array(4096 + 18 + 8);
    for (let at = 0; at < pixels.length; at++) pixels[at] = (at * 97) % 199;
    pixels.set(run, 0);
    pixels.set(run, 4096);
    pixels.set(Uint8Array.from([11, 12, 13, 14, 15, 16, 17, 18]), 4096 + 18);
    expect(throughHif(pixels)).toEqual(Array.from(pixels));
  });

  it('reads back frames of noise, which is the case with no matches to find', () => {
    // A fixed sequence rather than `Math.random`, so a failure is one a rerun
    // reproduces.
    let seed = 12345;
    const pixels = Uint8Array.from({ length: 5000 }, () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >> 16) & 0xff;
    });
    expect(throughHif(pixels)).toEqual(Array.from(pixels));
  });

  it('ends the stream, so a buffer longer than the frame stays transparent', () => {
    const bytes = compressHIF(Uint8Array.from([1, 2, 3]));
    const out = new Uint8Array(8).fill(9);
    expect(decompressHIF(bytes, out)).toBe(3);
    // The decoder stops at the terminator rather than reading whatever follows
    // the stream as more pixels.
    expect(Array.from(out)).toEqual([1, 2, 3, 9, 9, 9, 9, 9]);
  });

  it('goes through `encodeSwordFrame`, tagged NONE because no tag means HIF', () => {
    const pixels = Uint8Array.from([4, 4, 4, 4, 4, 1, 2, 3]);
    const written = encodeSwordFrame(pixels, 'hif');
    expect(written.compression).toBe('hif');
    // The conversion selected HIF by platform and left the original tags in
    // place, so there is nothing to write into the header that would say so.
    expect(written.tag).toBe('NONE');
    expect(written.retagged).toBeNull();
    expect(Array.from(decodeSwordFrame(written.bytes, 'hif', written.bytes.length, 4, 2))).toEqual(
      Array.from(pixels),
    );
  });

  it('writes an empty frame as nothing but a terminator', () => {
    expect(Array.from(compressHIF(new Uint8Array(0)))).toEqual([0x80, 0xff, 0xff]);
  });
});

describe('walking a sprite resource', () => {
  it('finds every frame, with its header and exactly its own bytes', () => {
    const sprite = buildSpriteResource([
      { width: 2, height: 1, pixels: Uint8Array.from([1, 2]) },
      { width: 1, height: 2, pixels: Uint8Array.from([3, 4]), offsetX: -5 },
    ]);
    const frames = sword1SpriteFrames(sprite);
    expect(frames.map((frame) => frame.header.width)).toEqual([2, 1]);
    expect(frames[1].header.offsetX).toBe(-5);
    expect(Array.from(frames[1].data)).toEqual([3, 4]);
  });

  it('skips a frame whose offset runs past the resource rather than throwing', () => {
    const sprite = buildSpriteResource([{ width: 2, height: 1, pixels: Uint8Array.from([1, 2]) }]);
    const truncated = sprite.subarray(0, sprite.length - 1);
    expect(sword1SpriteFrames(truncated)).toEqual([]);
  });
});

describe('shrinking', () => {
  it('samples the middle of each cell with an 8.8 accumulator', () => {
    const src = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const out = new Uint8Array(16);
    const size = fastShrink(src, 4, 4, 128, out);
    expect(size).toEqual({ width: 2, height: 2 });
    // Half a step in, then a step: columns 1 and 3, rows 1 and 3. Starting at
    // zero instead would give columns 0 and 2 — visibly the wrong pixels.
    expect(Array.from(out.subarray(0, 4))).toEqual([6, 8, 14, 16]);
  });

  it('stipples colour 200 to transparent, which is how a shadow shrinks', () => {
    const src = new Uint8Array(16).fill(200);
    const out = new Uint8Array(16);
    fastShrink(src, 4, 4, 128, out);
    // Row 0 stipples at x=0, row 1 at x=1: a checkerboard, not a solid block.
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 200, 200, 0]);
  });
});

describe('parallax', () => {
  it('reads a row offset table sized by the height, not the width', () => {
    const layer = new Writer().ascii('PARALLAX', 16).u16(640).u16(400).done();
    const bytes = new Writer()
      .raw(layer)
      .raw(new Uint8Array(400 * 4))
      .done();
    const parsed = parseSwordParallax(bytes);
    expect(parsed.width).toBe(640);
    expect(parsed.rows).toHaveLength(400);
  });

  it('decodes a row as (skip, length, pixels) runs with no count prefix', () => {
    const header = new Writer().ascii('PARALLAX', 16).u16(8).u16(1).done();
    const body = new Writer().raw(header).u32(24).raw([2, 3, 9, 9, 9, 0, 0]).done();
    const parsed = parseSwordParallax(body);
    const strip = decodeSwordParallaxRow(body, parsed, 0);
    expect(Array.from(strip as Uint8Array)).toEqual([0, 0, 9, 9, 9, 0, 0, 0]);
  });

  it('refuses a resource whose row table does not fit, rather than reading garbage', () => {
    const header = new Writer().ascii('PARALLAX', 16).u16(640).u16(400).done();
    expect(() => parseSwordParallax(header)).toThrow(/not a parallax/);
  });
});

describe('writing a parallax back', () => {
  /** Encodes a row, decodes it through the real reader, and returns pixels. */
  function tripRow(pixels: number[]): number[] {
    const row = compressSwordParallaxRow(Uint8Array.from(pixels));
    const header = new Writer().ascii('PARALLAX', 16).u16(pixels.length).u16(1).done();
    const bytes = new Writer()
      .raw(header)
      .u32(row ? header.length + 4 : 0)
      .raw(row ?? [])
      .done();
    const parsed = parseSwordParallax(bytes);
    const strip = decodeSwordParallaxRow(bytes, parsed, 0);
    return strip ? Array.from(strip) : new Array<number>(pixels.length).fill(0);
  }

  it('writes a row as (skip, length, pixels) triples', () => {
    const row = compressSwordParallaxRow(Uint8Array.from([0, 0, 9, 9, 9, 0, 7]));
    expect(Array.from(row as Uint8Array)).toEqual([2, 3, 9, 9, 9, 1, 1, 7]);
  });

  it('writes the trailing copy length the reader never looks at', () => {
    // A row ending in transparency still spends the pair, because the original
    // does: dropping it leaves every later row's offset two bytes early.
    const row = compressSwordParallaxRow(Uint8Array.from([5, 0, 0]));
    expect(Array.from(row as Uint8Array)).toEqual([0, 1, 5, 2, 0]);
  });

  it('leaves a row that ends on a copy without one', () => {
    const row = compressSwordParallaxRow(Uint8Array.from([0, 5]));
    expect(Array.from(row as Uint8Array)).toEqual([1, 1, 5]);
  });

  it('gives a wholly transparent row no bytes at all, which is offset zero', () => {
    expect(compressSwordParallaxRow(Uint8Array.from([0, 0, 0]))).toBeNull();
  });

  it('splits a skip longer than 255 rather than overflowing the byte', () => {
    const pixels = new Array<number>(300).fill(0);
    pixels[299] = 4;
    expect(tripRow(pixels)).toEqual(pixels);
  });

  it('splits a copy longer than 255 the same way', () => {
    const pixels = new Array<number>(300).fill(6);
    pixels[0] = 0;
    expect(tripRow(pixels)).toEqual(pixels);
  });

  it('round-trips a whole layer through the reader, row table and all', () => {
    const width = 6;
    const height = 4;
    const pixels = Uint8Array.from([
      0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 3, 0, 4, 0, 0, 5, 5, 5, 5, 0,
    ]);
    const type = new Writer().ascii('PARALLAX', 16).done();
    const bytes = encodeSwordParallax(pixels, width, height, type);
    const parsed = parseSwordParallax(bytes);
    expect(parsed.width).toBe(width);
    expect(parsed.rows).toHaveLength(height);
    const read = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      const strip = decodeSwordParallaxRow(bytes, parsed, row);
      if (strip) read.set(strip, row * width);
    }
    expect(Array.from(read)).toEqual(Array.from(pixels));
    // The empty row is offset zero, not an offset into a zero-length body.
    expect(parsed.rows[1]).toBe(0);
  });
});

describe('the font and text sprites', () => {
  /** A three-glyph font: space, then two boxes, starting at character 32. */
  function fontFixture(): SwordResources | Promise<SwordResources> {
    const glyph = (width: number, ink: number): Uint8Array => {
      const pixels = new Uint8Array(width * 6);
      pixels.fill(ink);
      return pixels;
    };
    const frames = [] as Array<{ width: number; height: number; pixels: Uint8Array }>;
    for (let code = 32; code < 128; code++) {
      frames.push({
        width: code === 32 ? 4 : 6,
        height: 6,
        pixels: glyph(code === 32 ? 4 : 6, 193),
      });
    }
    const font = buildSpriteResource(frames);
    const fixture = buildSwordFixture([
      {
        label: 'COMPACTS',
        groups: 1,
        resources: [{ group: 0, index: 0, bytes: new Uint8Array(4) }],
      },
      {
        label: 'SCRIPTS',
        groups: 1,
        resources: [{ group: 0, index: 0, bytes: new Uint8Array(4) }],
      },
      // GENERAL is cluster index 2, so its ids start 0x03…; the font's real id
      // is 0x04000000, which is cluster 3. Four clusters keeps the numbering.
      { label: 'MAPS', groups: 1, resources: [{ group: 0, index: 0, bytes: new Uint8Array(4) }] },
      { label: 'GENERAL', groups: 1, resources: [{ group: 0, index: 0, bytes: font }] },
    ]);
    const entries: Array<[string, Uint8Array]> = [['swordres.rif', fixture.rif]];
    for (const [label, bytes] of fixture.clusters) entries.push([`${label}.CLU`, bytes]);
    return SwordResources.create(new MemoryDataSource('font', entries));
  }

  it('measures a line from the font’s own frame widths', async () => {
    const resources = await fontFixture();
    await resources.loadResident();
    const text = new SwordText(resources, SWORD1_GAME_FONT);
    expect(text.fontMissing).toBeNull();
    expect(text.lineHeight).toBe(6);
    // Two 6-wide glyphs overlapping by three, plus the final letter's overlap
    // back: 3 + 3 + 3 = 9 for "ab".
    expect(text.analyzeSentence('ab', 400)[0].width).toBe(9);
  });

  it('renders a sprite whose height is a whole number of lines', async () => {
    const resources = await fontFixture();
    await resources.loadResident();
    const text = new SwordText(resources, SWORD1_GAME_FONT);
    const sprite = text.makeTextSprite('ab cd', 12, 210);
    expect(sprite).not.toBeNull();
    expect((sprite as { height: number }).height % text.lineHeight).toBe(0);
    // The pen colour is what the glyph's letter ink becomes.
    expect(Array.from((sprite as { pixels: Uint8Array }).pixels)).toContain(210);
  });

  it('resolves the font when its cluster arrives, not once at construction', async () => {
    // This is the order `SwordEngine.create` uses: the constructor builds the
    // text object, and `await resources.loadResident()` is three lines later.
    // Answered once and kept, the engine reported "no font, so no subtitles"
    // for the whole session on an install whose font is right there — measured
    // on the mounted demo, where this id fetches 70,414 bytes once GENERAL is
    // resident. The id was never the problem; the moment was.
    const resources = await fontFixture();
    const text = new SwordText(resources, SWORD1_GAME_FONT);
    expect(text.fontMissing).toMatch(/not resident/);
    expect(text.makeTextSprite('hello', 100, 1)).toBeNull();

    await resources.loadResident();
    expect(text.fontMissing).toBeNull();
    expect(text.lineHeight).toBe(6);
    expect(text.makeTextSprite('hello', 100, 1)).not.toBeNull();
  });

  it('prefers the Czech font where there is one and falls back where there is not', async () => {
    // Presence, not a language flag: a release's language is not established
    // until its text is read. The fallback has to be lazy for the same reason
    // the resolution does — at construction neither id fetches.
    const resources = await fontFixture();
    const text = new SwordText(resources, [SWORD1_CZECH_GAME_FONT, SWORD1_GAME_FONT]);
    await resources.loadResident();
    expect(text.fontMissing).toBeNull();
    // And the id named in the refusal is the plain font's, not the Czech one's:
    // a missing Czech font is a preference unmet, not the reason for silence.
    const bare = buildSwordFixture(BARE);
    const neither = await SwordResources.create(
      new MemoryDataSource('nofont', [
        ['swordres.rif', bare.rif],
        ...[...bare.clusters].map(
          ([label, bytes]) => [`${label}.CLU`, bytes] as [string, Uint8Array],
        ),
      ]),
    );
    await neither.loadResident();
    const missing = new SwordText(neither, [SWORD1_CZECH_GAME_FONT, SWORD1_GAME_FONT]);
    expect(missing.fontMissing).toMatch(/0x04000000/);
  });

  it('says the font is missing rather than drawing nothing silently', async () => {
    const fixture = buildSwordFixture(BARE);
    const entries: Array<[string, Uint8Array]> = [['swordres.rif', fixture.rif]];
    for (const [label, bytes] of fixture.clusters) entries.push([`${label}.CLU`, bytes]);
    const resources = await SwordResources.create(new MemoryDataSource('nofont', entries));
    await resources.loadResident();
    const text = new SwordText(resources, SWORD1_GAME_FONT);
    // This fixture has three clusters and the font's id names a fourth, so the
    // step that failed is the cluster lookup — named, rather than folded into
    // one "not in swordres.rif" that would fit a missing index just as badly.
    expect(text.fontMissing).toMatch(/names cluster 4, and swordres\.rif lists 3 clusters/);
    expect(text.makeTextSprite('hello', 100, 1)).toBeNull();
  });
});

/**
 * The background is re-laid every frame, so a sprite that moves leaves nothing.
 *
 * `Screen::draw` begins with `memcpy(_screenBuf, _layerBlocks[0], ...)` — every
 * call, not once per room. Blitting the background only when the screen is
 * entered and compositing onto the result forever looks correct on frame one
 * and accumulates: measured on the mounted demo, 2,500 frames of George and the
 * subtitle turned the Paris café into dark smears over two thirds of the
 * picture, and the subtitle underneath them was unreadable.
 *
 * Screen 1 is a real entry in the generated room table, so this drives the real
 * geometry (784x400) with a stub resource reader standing in for the cluster.
 */
describe('re-laying the background', () => {
  const SCREEN = 1;
  const BACKGROUND_INK = 7;
  const SPRITE_INK = 200;

  /** Screen 1's background, a constant fill, and nothing else fetchable. */
  function screenUnderTest(): {
    renderer: SwordScreen;
    compact: SwordCompact;
    window: Uint8Array;
  } {
    const room = SWORD1_ROOMS[SCREEN];
    const background = new Uint8Array(room.sizeX * room.sizeY).fill(BACKGROUND_INK);
    const resources = {
      bigEndian: false,
      fetch: (id: number) => (id === room.layers[0] ? { bytes: background } : null),
      describeMissingResource: () => 'not in this fixture',
    } as unknown as SwordResources;

    // A TEXT compact: its pixels come from `setTextSprite`, so no sprite
    // resource has to be built to move something across the screen.
    const compact = new SwordCompact(new Int32Array(64), 0x10001);
    compact.set(CPT.TYPE, SwordType.TEXT);
    compact.set(CPT.STATUS, SwordStatus.FORE);
    compact.set(CPT.TARGET, compact.id);

    const objects = {
      fetch: (id: number) => (id === compact.id ? compact : null),
    } as unknown as SwordObjects;

    const renderer = new SwordScreen(resources, objects);
    renderer.newScreen(SCREEN);
    renderer.setTextSprite(compact.id, {
      width: 8,
      height: 8,
      pixels: new Uint8Array(64).fill(SPRITE_INK),
    });
    return { renderer, compact, window: new Uint8Array(SWORD1_SCREEN_WIDTH * 480) };
  }

  /** The window pixel at a room coordinate, through `present`'s 40-row bar. */
  function at(window: Uint8Array, roomX: number, roomY: number): number {
    return window[(roomY + 40) * SWORD1_SCREEN_WIDTH + roomX];
  }

  function drawAt(
    renderer: SwordScreen,
    compact: SwordCompact,
    window: Uint8Array,
    x: number,
    y: number,
  ): void {
    // Game space is offset by 128 in both axes; these land at room 100,100 and
    // room 300,100.
    compact.set(CPT.ANIM_X, x + 128);
    compact.set(CPT.ANIM_Y, y + 128);
    renderer.addToGraphicList(0, compact.id);
    renderer.draw();
    renderer.present(window);
  }

  it('draws the sprite where it is', () => {
    const { renderer, compact, window } = screenUnderTest();
    drawAt(renderer, compact, window, 100, 100);
    expect(at(window, 104, 104)).toBe(SPRITE_INK);
  });

  it('leaves the background behind, when the sprite moves on', () => {
    const { renderer, compact, window } = screenUnderTest();
    drawAt(renderer, compact, window, 100, 100);
    drawAt(renderer, compact, window, 300, 100);

    expect(at(window, 304, 104)).toBe(SPRITE_INK);
    // Where it was, and the whole 8x8 of it.
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        expect(at(window, 100 + column, 100 + row)).toBe(BACKGROUND_INK);
      }
    }
  });
});

/**
 * Where a mask grid's cells start inside its resource.
 *
 * ScummVM does `_layerGrid[cnt] = (uint16 *)openFetchRes(...); _layerGrid[cnt] += 14;`
 * on a pointer to byte 0 of the resource, so the cells begin 28 bytes in and
 * the 20-byte `Header` is *inside* that 28 — this engine used to add the two
 * together and read from byte 48, which slid every grid ten cells to the left
 * and made masks land in the wrong column. Measured against the demo, 28 gives
 * every grid exactly `pitch` x 82 cells (82 is `sizeY / 8 + 32`); 48 gives
 * 81.85 rows, which cannot be a map of anything.
 */
describe('a mask grid', () => {
  const SCREEN = 1;
  const BACKGROUND_INK = 7;
  const SPRITE_INK = 200;
  const MASK_INK = 99;
  const GRID_CELLS_AT = 28;

  /** Screen 1's geometry, so the pitch arithmetic under test is the real one. */
  const room = SWORD1_ROOMS[SCREEN];
  // The imaginary screen's width in blocks: 784 / 16 visible plus eight
  // off-screen each side, which is exactly what the room table calls
  // `gridWidth` and why that field is not `sizeX / 16`.
  const GRID_PITCH = room.gridWidth;

  /**
   * A grid whose only non-zero cells are the two the sprite at room 100,100
   * should read: block column 6 + 8 off-screen, block rows 12 and 13 + 16.
   */
  function gridResource(cells: readonly number[]): Uint8Array {
    const bytes = new Uint8Array(GRID_CELLS_AT + GRID_PITCH * 82 * 2);
    const view = new DataView(bytes.buffer);
    for (const cell of cells) view.setUint16(GRID_CELLS_AT + cell * 2, 1, true);
    return bytes;
  }

  function screenUnderTest(cells: readonly number[]): {
    renderer: SwordScreen;
    compact: SwordCompact;
    window: Uint8Array;
  } {
    const background = new Uint8Array(room.sizeX * room.sizeY).fill(BACKGROUND_INK);
    // One 16x8 block of solid ink, the block the grid cells point at.
    const blocks = new Uint8Array(20 + MASK_BLOCK_BYTES).fill(MASK_INK);
    const grid = gridResource(cells);
    const resources = {
      bigEndian: false,
      fetch: (id: number) => {
        if (id === room.layers[0]) return { bytes: background, payload: background };
        if (id === room.layers[1]) return { bytes: blocks, payload: blocks.subarray(20) };
        if (id === room.grids[0]) return { bytes: grid, payload: grid.subarray(20) };
        return null;
      },
      describeMissingResource: () => 'not in this fixture',
    } as unknown as SwordResources;

    const compact = new SwordCompact(new Int32Array(64), 0x10001);
    compact.set(CPT.TYPE, SwordType.TEXT);
    // Sorted, not foreground: a FORE sprite is in front of the masks by
    // definition and `verticalMask` is never reached for it.
    compact.set(CPT.STATUS, SwordStatus.SORT);
    compact.set(CPT.TARGET, compact.id);
    compact.set(CPT.ANIM_X, 100 + 128);
    compact.set(CPT.ANIM_Y, 100 + 128);

    const objects = {
      fetch: (id: number) => (id === compact.id ? compact : null),
    } as unknown as SwordObjects;

    const renderer = new SwordScreen(resources, objects);
    renderer.newScreen(SCREEN);
    renderer.setTextSprite(compact.id, {
      width: 8,
      height: 8,
      pixels: new Uint8Array(64).fill(SPRITE_INK),
    });
    renderer.addToGraphicList(0, compact.id);
    renderer.draw();
    const window = new Uint8Array(SWORD1_SCREEN_WIDTH * 480);
    renderer.present(window);
    return { renderer, compact, window };
  }

  /** The window pixel at a room coordinate, through `present`'s 40-row bar. */
  function at(window: Uint8Array, roomX: number, roomY: number): number {
    return window[(roomY + 40) * SWORD1_SCREEN_WIDTH + roomX];
  }

  /** Bottom row first, then the row above it: the column the sprite stands in. */
  const COLUMN = [(12 + 16 + 1) * GRID_PITCH + 6 + 8, (12 + 16) * GRID_PITCH + 6 + 8];

  it('puts the block in front of the sprite standing under it', () => {
    const { window } = screenUnderTest(COLUMN);
    expect(at(window, 104, 104)).toBe(MASK_INK);
    expect(at(window, 100, 100)).toBe(MASK_INK);
  });

  it('reads the cells 28 bytes in, not 48', () => {
    // The same column, ten cells to the right: where reading from byte 48
    // would have found them. Nothing should be masked.
    const { window } = screenUnderTest(COLUMN.map((cell) => cell + 10));
    expect(at(window, 104, 104)).toBe(SPRITE_INK);
  });

  it('leaves the sprite alone where the grid is empty', () => {
    const { window } = screenUnderTest([]);
    expect(at(window, 104, 104)).toBe(SPRITE_INK);
    expect(at(window, 120, 104)).toBe(BACKGROUND_INK);
  });
});

/**
 * The mask/grid pair, both ways.
 *
 * A mask layer is blocks in storage order and the grid says where each goes, so
 * composing is the only way to see one and decomposing is the only way to
 * change one. The room here is 32x16, which is two grid columns and two grid
 * rows of *visible* screen — the other sixteen columns and thirty-two rows are
 * the imaginary screen's off-screen margin, which is what makes cell 8,16 the
 * top-left of the room rather than cell 0,0.
 */
describe('a mask layer and its grid', () => {
  const WIDTH = 32;
  const HEIGHT = 16;
  const PITCH = WIDTH / SCRNGRID_X + 16;
  const ROWS = HEIGHT / SCRNGRID_Y + 32;
  const HOME = 8 + 16 * PITCH;

  /** Three blocks of flat colour, so where each lands is readable. */
  function blocks(): Uint8Array {
    const bytes = new Uint8Array(3 * MASK_BLOCK_BYTES);
    bytes.fill(11, 0, MASK_BLOCK_BYTES);
    bytes.fill(22, MASK_BLOCK_BYTES, 2 * MASK_BLOCK_BYTES);
    bytes.fill(33, 2 * MASK_BLOCK_BYTES);
    return bytes;
  }

  /** A grid resource: 28 bytes of preamble, then `pitch * rows` cells. */
  function gridBytes(cells: Readonly<Record<number, number>>, bigEndian = false): Uint8Array {
    const bytes = new Uint8Array(SWORD1_GRID_CELLS_AT + PITCH * ROWS * 2);
    const view = new DataView(bytes.buffer);
    for (const [cell, value] of Object.entries(cells)) {
      view.setUint16(SWORD1_GRID_CELLS_AT + Number(cell) * 2, value, !bigEndian);
    }
    return bytes;
  }

  it('reads the cells 28 bytes in, at whichever byte order the release uses', () => {
    const little = parseSwordGrid(gridBytes({ [HOME]: 0x0102 }), PITCH);
    expect(little.pitch).toBe(PITCH);
    expect(little.rows).toBe(ROWS);
    expect(little.cells[HOME]).toBe(0x0102);
    expect(parseSwordGrid(gridBytes({ [HOME]: 0x0102 }, true), PITCH, true).cells[HOME]).toBe(
      0x0102,
    );
    // The other order reads the same bytes as the swap, which is the point of
    // reading rather than viewing: a Mac grid seen little-endian is a mess.
    expect(parseSwordGrid(gridBytes({ [HOME]: 0x0102 }, true), PITCH).cells[HOME]).toBe(0x0201);
  });

  it('lays each block where its cell puts it', () => {
    const grid = parseSwordGrid(gridBytes({ [HOME]: 1, [HOME + PITCH + 1]: 2, 0: 3 }), PITCH);
    const pixels = composeSwordMask(blocks(), grid, WIDTH, HEIGHT);

    expect(pixels[0]).toBe(11);
    expect(pixels[15]).toBe(11);
    // Second cell: one block across and one down, so room 16,8.
    expect(pixels[8 * WIDTH + 16]).toBe(22);
    // The block the third cell names is off the imaginary screen's left edge,
    // so none of it lands in the room.
    expect(pixels.includes(33)).toBe(false);
    // Nothing else was painted: two blocks of 128 pixels each.
    expect(pixels.filter((pixel) => pixel !== 0).length).toBe(2 * MASK_BLOCK_BYTES);
  });

  it('takes an unchanged picture apart into the bytes it came from', () => {
    const grid = parseSwordGrid(gridBytes({ [HOME]: 1, [HOME + PITCH + 1]: 2, 0: 3 }), PITCH);
    const original = blocks();
    const pixels = composeSwordMask(original, grid, WIDTH, HEIGHT);
    const taken = decomposeSwordMask(original, grid, pixels, WIDTH, HEIGHT);

    expect([...taken.blocks]).toEqual([...original]);
    expect(taken.conflicts).toEqual([]);
    expect(taken.written).toBe(3);
  });

  it('writes an edited block back, and drops paint no cell covers', () => {
    const grid = parseSwordGrid(gridBytes({ [HOME]: 1 }), PITCH);
    const original = blocks();
    const pixels = new Uint8Array(WIDTH * HEIGHT).fill(77);
    const taken = decomposeSwordMask(original, grid, pixels, WIDTH, HEIGHT);

    // The one cell's block took the paint over it...
    expect([...taken.blocks.subarray(0, MASK_BLOCK_BYTES)]).toEqual(
      Array.from({ length: MASK_BLOCK_BYTES }, () => 77),
    );
    // ...and the three quarters of the room no cell covers went nowhere.
    expect([...taken.blocks.subarray(MASK_BLOCK_BYTES)]).toEqual([
      ...original.subarray(MASK_BLOCK_BYTES),
    ]);
  });

  it('names a block two cells want to fill differently rather than picking one', () => {
    // Broken Sword stores a repeated block once. Two cells, one block: the
    // first cell's pixels are what `blocks` holds, and the second cell's
    // disagreement is reported rather than written over it.
    const grid = parseSwordGrid(gridBytes({ [HOME]: 1, [HOME + 1]: 1 }), PITCH);
    const pixels = new Uint8Array(WIDTH * HEIGHT);
    pixels.fill(5, 0, 16);
    const taken = decomposeSwordMask(blocks(), grid, pixels, WIDTH, HEIGHT);

    expect(taken.conflicts).toEqual([1]);
    expect(taken.written).toBe(1);
  });

  it('says nothing is wrong when both cells agree', () => {
    const grid = parseSwordGrid(gridBytes({ [HOME]: 1, [HOME + 1]: 1 }), PITCH);
    const pixels = new Uint8Array(WIDTH * HEIGHT).fill(6);
    expect(decomposeSwordMask(blocks(), grid, pixels, WIDTH, HEIGHT).conflicts).toEqual([]);
  });
});
