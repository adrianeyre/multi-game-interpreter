import { describe, expect, it } from 'vitest';
import { PSAD_SAMPLE_RATE, readPsadSlice } from '../src/engine/video/psad.js';
import { SmushPlayer } from '../src/engine/video/SmushPlayer.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/engine/gfx/Screen.js';

function chunk(tag: string, payload: number[]): number[] {
  const size = payload.length;
  return [
    ...[...tag].map((c) => c.charCodeAt(0)),
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...payload,
    ...(size & 1 ? [0] : []),
  ];
}

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];

const PALETTE_BYTES = 0x300;

const ahdr = (frames: number) => [
  2,
  0,
  ...u16(frames),
  0,
  0,
  ...new Array(PALETTE_BYTES).fill(0),
  ...u16(15),
];

const san = (frames: number[][]) =>
  new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', ahdr(frames.length)),
      ...frames.flatMap((f) => chunk('FRME', f)),
    ]),
  );

const screen = () => new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);

/** A PSAD header: track, index, maxFrames, flags, volume, pan. */
const psadHeader = (index: number, track = 1) => [
  ...u16(track),
  ...u16(index),
  ...u16(0),
  ...u16(0),
  127,
  0,
];

/** An index-zero PSAD: the SAUD container, then samples. */
const firstSlice = (samples: number[], declared = samples.length) => [
  ...psadHeader(0),
  ...chunk('SAUD', [
    ...chunk('STRK', new Array(14).fill(0)),
    ...chunk('SHDR', [0, 0, 0, 0]),
    ...[...'SDAT'].map((c) => c.charCodeAt(0)),
    ...be32(declared),
    ...samples,
  ]),
];

describe('reading Full Throttle cutscene audio', () => {
  it('decodes the samples in an opening slice', () => {
    const slice = readPsadSlice(new Uint8Array(firstSlice([128, 255, 0])));
    expect(slice).not.toBeNull();
    expect(slice!.track).toBe(1);
    expect(slice!.index).toBe(0);
    // 8-bit unsigned, centred on 128: silence, full positive, full negative.
    expect([...slice!.samples]).toEqual([0, 0, 0x7f00, 0x7f00, -0x8000, -0x8000]);
  });

  it('reads a later slice as bare samples, with no container to look for', () => {
    // The one that decides whether a cutscene has sound past its first
    // fraction of a second: only index zero carries `SAUD`.
    const slice = readPsadSlice(new Uint8Array([...psadHeader(1), 128, 192]));
    expect(slice!.index).toBe(1);
    expect([...slice!.samples]).toEqual([0, 0, 0x4000, 0x4000]);
  });

  it('does not mistake a later slice for a malformed one', () => {
    // A continuation begins with sample bytes, which will not spell `SAUD`.
    // Rejecting it would silence everything after the first slice.
    const slice = readPsadSlice(new Uint8Array([...psadHeader(7), 130]));
    expect(slice).not.toBeNull();
    expect(slice!.samples.length).toBe(2);
  });

  it('clamps an SDAT that declares the whole stream to what is present', () => {
    // `SDAT`'s size is the length of the stream, not of this chunk, so it runs
    // past the buffer as a matter of course.
    const slice = readPsadSlice(new Uint8Array(firstSlice([128, 128], 40000)));
    expect(slice!.samples.length).toBe(4);
  });

  it('accepts an opening slice that carries metadata and no samples yet', () => {
    const noSdat = [...psadHeader(0), ...chunk('SAUD', [...chunk('STRK', new Array(14).fill(0))])];
    const slice = readPsadSlice(new Uint8Array(noSdat));
    expect(slice).not.toBeNull();
    expect(slice!.samples.length).toBe(0);
  });

  it('refuses a chunk too short to hold a header', () => {
    expect(readPsadSlice(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('centres a mono stream across both channels', () => {
    // Not one channel: Full Throttle's cutscenes would play on the left only.
    const slice = readPsadSlice(new Uint8Array([...psadHeader(1), 200, 100]));
    const samples = [...slice!.samples];
    expect(samples[0]).toBe(samples[1]);
    expect(samples[2]).toBe(samples[3]);
  });

  it('runs at the same rate as The Dig cutscene audio', () => {
    expect(PSAD_SAMPLE_RATE).toBe(22050);
  });
});

describe('a v7 cutscene that carries its audio in PSAD', () => {
  it('collects it across frames instead of playing silent', () => {
    const player = new SmushPlayer();
    player.open(
      san([
        [...chunk('PSAD', firstSlice([128, 255]))],
        [...chunk('PSAD', [...psadHeader(1), 128, 0])],
      ]),
    );

    player.step(0, screen());
    player.step(0.1, screen());

    const audio = player.takeAudio();
    expect(audio).not.toBeNull();
    expect([...audio!.samples]).toEqual([0, 0, 0x7f00, 0x7f00, 0, 0, -0x8000, -0x8000]);
  });

  it('names a PSAD it cannot read rather than going quietly silent', () => {
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...chunk('PSAD', [1, 2])]]));

    player.step(0, screen());
    expect(logs.filter((line) => line.includes('PSAD'))).toHaveLength(1);
  });
});

describe('an IACT that carries an interactive sequence rather than audio', () => {
  it('is named, because the frames still decode without it', () => {
    // The failure this catches is not a blank screen. Full Throttle's bike
    // combat plays through as a passive cutscene and looks like it works.
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...chunk('IACT', [...u16(4), ...u16(46), ...u16(0), ...u16(0), 1, 2])]]));

    player.step(0, screen());
    const named = logs.filter((line) => line.includes('IACT'));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('will not respond');
  });

  it('is not named for an ordinary audio IACT', () => {
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(
      san([
        [
          ...chunk('IACT', [
            ...u16(8),
            ...u16(46),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...u16(0),
            ...be32(0),
          ]),
        ],
      ]),
    );

    player.step(0, screen());
    expect(logs.filter((line) => line.includes('IACT'))).toHaveLength(0);
  });
});
