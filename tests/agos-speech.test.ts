import { describe, expect, it } from 'vitest';
import {
  decodeVoc,
  decodeWav,
  readSpeechIndex,
  speechKind,
} from '../src/engine/agos/sound/speech.js';

function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

const text = (value: string): number[] => [...new TextEncoder().encode(value)];

describe('the speech index', () => {
  /**
   * The trap this file exists to avoid: a speech file's table size is in its
   * **second** word, where the resource archive's is in its first. Read one the
   * way you read the other and the offsets are almost right, which is worse than
   * being wrong, because most sounds still play.
   */
  it('takes the table size from the second word, not the first', () => {
    const bytes = Uint8Array.from([
      ...u32le(12),
      ...u32le(12),
      ...u32le(16),
      0xaa,
      0xbb,
      0xcc,
      0xdd,
      0xee,
    ]);
    const index = readSpeechIndex(bytes);

    expect(index.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(index.read(2)).toEqual(Uint8Array.of(0xee));
  });

  it('treats two entries with one offset as the same recording, reused', () => {
    const bytes = Uint8Array.from([
      ...u32le(16),
      ...u32le(16),
      ...u32le(20),
      ...u32le(20),
      1,
      2,
      3,
      4,
    ]);
    const index = readSpeechIndex(bytes);

    // The games reuse a line by pointing at it twice, so both entries play the
    // same bytes. What is genuinely absent is an entry whose offset has
    // reached the end of the file.
    expect(index.read(1)).toEqual(index.read(0));
    expect(index.read(2)).toBeUndefined();
  });
});

describe('decoding what a talkie ships', () => {
  it('decodes a Creative VOC block, rate divisor and all', () => {
    const header = text('Creative Voice File');
    while (header.length < 20) header.push(0);
    const voc = Uint8Array.from([
      ...header,
      26,
      0,
      0x0a,
      0x01,
      0x29,
      0x11,
      1,
      4,
      0,
      0,
      0xa5,
      0,
      128,
      255,
    ]);

    const decoded = decodeVoc(voc);

    expect(decoded.sampleRate).toBe(Math.round(1_000_000 / (256 - 0xa5)));
    expect(decoded.samples[0]).toBe(0);
    expect(decoded.samples[1]).toBeCloseTo(0.99, 1);
  });

  it('refuses a file that is not a VOC rather than producing noise', () => {
    expect(() => decodeVoc(Uint8Array.of(1, 2, 3))).toThrow(/not a Creative Voice File/);
  });

  it('decodes 8-bit PCM WAV, where 128 is silence', () => {
    const wav = Uint8Array.from([
      ...text('RIFF'),
      ...u32le(0),
      ...text('WAVE'),
      ...text('fmt '),
      ...u32le(16),
      1,
      0,
      1,
      0,
      ...u32le(22050),
      ...u32le(22050),
      1,
      0,
      8,
      0,
      ...text('data'),
      ...u32le(3),
      128,
      255,
      0,
    ]);

    const decoded = decodeWav(wav);

    expect(decoded.sampleRate).toBe(22050);
    expect(decoded.samples[0]).toBe(0);
    expect(decoded.samples[2]).toBe(-1);
  });
});

describe('knowing which decoder a recording needs', () => {
  it('recognises the original formats and the re-encoded ones', () => {
    expect(speechKind(Uint8Array.from(text('Creative Voice File')))).toBe('voc');
    expect(speechKind(Uint8Array.from(text('RIFF....WAVE')))).toBe('wav');
    // ADR 0028 admits GOG and Steam data, whose speech ScummVM's tools
    // re-encoded. The browser decodes those, which is why admitting them cost
    // almost nothing.
    expect(speechKind(Uint8Array.from(text('OggS')))).toBe('browser');
    expect(speechKind(Uint8Array.from(text('fLaC')))).toBe('browser');
    expect(speechKind(Uint8Array.of(0xff, 0xfb, 0, 0))).toBe('browser');
    expect(speechKind(Uint8Array.of(1, 2, 3, 4))).toBe('unknown');
  });
});
