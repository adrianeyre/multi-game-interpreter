import { describe, expect, it } from 'vitest';
import {
  decodeIactBlock,
  iactAudioPayload,
  iactBlockLength,
  IACT_SAMPLE_RATE,
  readIactHeader,
} from '../src/engine/video/iact.js';

const u16le = (v: number) => [v & 0xff, (v >> 8) & 0xff];

/** An IACT chunk header: code, flags, unknown, userId. */
const header = (code: number, flags: number, userId = 0) => [
  ...u16le(code),
  ...u16le(flags),
  ...u16le(0),
  ...u16le(userId),
];

describe('telling audio IACT from the rest', () => {
  it('recognises the one code and flags pair that means audio', () => {
    expect(readIactHeader(new Uint8Array(header(8, 46)))!.isAudio).toBe(true);
  });

  it('does not treat an interactive-sequence IACT as audio', () => {
    // Full Throttle's bike fights drive their overlays through IACT. A reader
    // that assumed audio would decode gameplay data as samples. (#103.)
    expect(readIactHeader(new Uint8Array(header(4, 46)))!.isAudio).toBe(false);
    expect(readIactHeader(new Uint8Array(header(8, 12)))!.isAudio).toBe(false);
  });

  it('keeps the user id, which says whether it is speech, music or an effect', () => {
    expect(readIactHeader(new Uint8Array(header(8, 46, 3)))!.userId).toBe(3);
  });

  it('returns null for a chunk too short to hold a header', () => {
    expect(readIactHeader(new Uint8Array([1, 2]))).toBeNull();
  });
});

describe('the audio payload', () => {
  it('starts eighteen bytes in, past the audio form’s extra fields', () => {
    // The audio form carries a track id, an index, a frame count and a 32-bit
    // size beyond the common header.
    const chunk = new Uint8Array([...header(8, 46), ...new Array(10).fill(0), 1, 2, 3]);
    expect([...iactAudioPayload(chunk)!]).toEqual([1, 2, 3]);
  });

  it('gives nothing for a chunk that is not audio, rather than a guess', () => {
    const chunk = new Uint8Array([...header(4, 46), ...new Array(10).fill(0), 1, 2, 3]);
    expect(iactAudioPayload(chunk)).toBeNull();
  });
});

describe('decoding a block', () => {
  it('scales the two channels by their own shift amounts', () => {
    // The detail worth stating: one shift used for both channels gives audio
    // quiet on one side and clipped on the other, which sounds like a bad
    // recording rather than a bug.
    const codes: number[] = [];
    for (let i = 0; i < 1024; i++) codes.push(1, 1);
    const block = new Uint8Array([0, 0, 0x38, ...codes]); // left shift 3, right 8

    const samples = decodeIactBlock(block)!;
    expect(samples[0]).toBe(1 << 3);
    expect(samples[1]).toBe(1 << 8);
  });

  it('reads a code as signed, so the waveform’s lower half is not inverted', () => {
    // Read unsigned, every negative sample becomes a loud positive one, which
    // is audible as a buzz rather than as silence.
    const codes: number[] = [];
    for (let i = 0; i < 1024; i++) codes.push(0xff, 0xff); // -1
    const block = new Uint8Array([0, 0, 0x00, ...codes]);

    const samples = decodeIactBlock(block)!;
    expect(samples[0]).toBe(-1);
  });

  it('escapes to a raw big-endian sample on 0x80', () => {
    const codes: number[] = [0x80, 0x12, 0x34, 0x80, 0x56, 0x78];
    for (let i = 0; i < 1022; i++) codes.push(0, 0);
    const block = new Uint8Array([0, 0, 0x00, ...codes]);

    const samples = decodeIactBlock(block)!;
    expect(samples[0]).toBe(0x1234);
    expect(samples[1]).toBe(0x5678);
  });

  it('stops at the end of a short block rather than reading past it', () => {
    const block = new Uint8Array([0, 0, 0x00, 1, 1, 1]);
    const samples = decodeIactBlock(block)!;
    expect(samples.length).toBeLessThan(2048);
  });

  it('measures a block from its own big-endian length', () => {
    const payload = new Uint8Array([0x00, 0x10, ...new Array(16).fill(0)]);
    expect(iactBlockLength(payload, 0)).toBe(0x10 + 2);
  });

  it('plays at the rate the format fixes', () => {
    expect(IACT_SAMPLE_RATE).toBe(22050);
  });
});
