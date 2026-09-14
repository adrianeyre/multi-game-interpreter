import { describe, expect, it } from 'vitest';
import { DeltaPalette, readTextCue, XPAL_COMMAND } from '../src/engine/video/smush.js';
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
const i16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

const PALETTE_BYTES = 0x300;

const ahdr = (frames: number, speed: number, palette = (i: number) => i & 0xff) => [
  2,
  0,
  ...u16(frames),
  0,
  0,
  ...new Array(PALETTE_BYTES).fill(0).map((_, i) => palette(i)),
  ...u16(speed),
];

/** An uncompressed FOBJ filling a small rectangle with one colour. */
const fobj = (colour: number, w = 2, h = 1) =>
  chunk('FOBJ', [
    ...u16(20),
    ...u16(0),
    ...u16(0),
    ...u16(w),
    ...u16(h),
    0,
    0,
    0,
    0,
    ...new Array(w * h).fill(colour),
  ]);

function san(
  frames: number[][],
  { count = frames.length, speed = 10, palette } = {} as {
    count?: number;
    speed?: number;
    palette?: (i: number) => number;
  },
) {
  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', ahdr(count, speed, palette)),
      ...frames.flatMap((f) => chunk('FRME', f)),
    ]),
  );
}

const screen = () => new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);

/** `XPAL`'s set form: 768 signed deltas, one per palette component. */
const xpalSet = (delta: number, command = 0) =>
  chunk('XPAL', [
    ...u16(0),
    ...u16(command),
    ...new Array(PALETTE_BYTES).fill(0).flatMap(() => i16(delta)),
  ]);

/** `XPAL`'s step form: six bytes that say "advance by the deltas already set". */
const xpalStep = () => chunk('XPAL', [...u16(0), ...u16(XPAL_COMMAND.Step), ...u16(0)]);

/**
 * `XPAL`, `STOR`, `FTCH` and the text chunks.
 *
 * Tier 1, and the trap the process document names applies with full force: the
 * fixtures here encode this reading of ScummVM's `handleFrame`, so what they
 * establish is that the reader and the fixture agree. What they cannot
 * establish is that either matches Full Throttle — a demo does that.
 */
describe('a palette that moves between frames', () => {
  it('steps every component by the delta it was given', () => {
    const palette = new DeltaPalette();
    palette.setFull(new Uint8Array(PALETTE_BYTES).fill(10));

    // Seven extra bits of precision, so a delta of 128 is exactly one level.
    expect(palette.apply(new Uint8Array(xpalSet(128).slice(8)))).toBe(true);
    palette.apply(new Uint8Array(xpalStep().slice(8)));

    expect(palette.colours[0]).toBe(11);
  });

  it('accumulates, so a fade is smooth rather than a single jump', () => {
    const palette = new DeltaPalette();
    palette.setFull(new Uint8Array(PALETTE_BYTES).fill(0));
    palette.apply(new Uint8Array(xpalSet(64).slice(8)));

    // Half a level per step: the first step rounds to nothing and the second
    // reaches one. Truncating each step to a whole level instead is what turns
    // a forty-frame fade into a dozen visible bands.
    palette.apply(new Uint8Array(xpalStep().slice(8)));
    expect(palette.colours[0]).toBe(0);
    palette.apply(new Uint8Array(xpalStep().slice(8)));
    expect(palette.colours[0]).toBe(1);
  });

  it('clips rather than wrapping, at both ends', () => {
    const up = new DeltaPalette();
    up.setFull(new Uint8Array(PALETTE_BYTES).fill(250));
    up.apply(new Uint8Array(xpalSet(128 * 20).slice(8)));
    up.apply(new Uint8Array(xpalStep().slice(8)));
    expect(up.colours[0]).toBe(255);

    const down = new DeltaPalette();
    down.setFull(new Uint8Array(PALETTE_BYTES).fill(5));
    down.apply(new Uint8Array(xpalSet(-128 * 20).slice(8)));
    down.apply(new Uint8Array(xpalStep().slice(8)));
    expect(down.colours[0]).toBe(0);
  });

  it('reads a whole palette behind the deltas when the command says so', () => {
    const palette = new DeltaPalette();
    palette.setFull(new Uint8Array(PALETTE_BYTES).fill(0));

    const payload = [
      ...u16(0),
      ...u16(XPAL_COMMAND.SetWithPalette),
      ...new Array(PALETTE_BYTES).fill(0).flatMap(() => i16(0)),
      ...new Array(PALETTE_BYTES).fill(77),
    ];
    expect(palette.apply(new Uint8Array(payload))).toBe(true);
    expect(palette.colours[0]).toBe(77);
  });

  it('refuses a chunk too short for the form it claims', () => {
    // Read anyway, the deltas would come from whatever followed the chunk in
    // the file — a fade to an arbitrary colour rather than a missing one.
    const palette = new DeltaPalette();
    palette.setFull(new Uint8Array(PALETTE_BYTES).fill(10));

    expect(palette.apply(new Uint8Array([...u16(0), ...u16(0), 1, 2, 3]))).toBe(false);
    expect(palette.colours[0]).toBe(10);
  });

  it('does nothing on a step it has no deltas for', () => {
    // A malformed sequence, and the quiet answer is the right one: with the
    // accumulator left at zero this would fade the screen to black instead.
    const palette = new DeltaPalette();
    palette.reset(new Uint8Array(PALETTE_BYTES).fill(10));
    expect(palette.apply(new Uint8Array(xpalStep().slice(8)))).toBe(true);
    expect(palette.colours[0]).toBe(10);
  });

  it('lets a new palette arrive without moving the fade it is under', () => {
    const palette = new DeltaPalette();
    palette.reset(new Uint8Array(PALETTE_BYTES).fill(0));
    palette.apply(new Uint8Array(xpalSet(128).slice(8)));

    // `NPAL` replaces what is displayed; the fade carries on from where the
    // deltas were set, which is why the step lands on 1 and not on 51.
    palette.setFull(new Uint8Array(PALETTE_BYTES).fill(50));
    expect(palette.colours[0]).toBe(50);
    palette.apply(new Uint8Array(xpalStep().slice(8)));
    expect(palette.colours[0]).toBe(1);
  });
});

describe('a sequence whose palette fades', () => {
  it('hands the palette over only when something moved it', () => {
    const player = new SmushPlayer();
    player.open(san([[...fobj(1)], [...fobj(2)]]));
    const target = screen();

    // The header's palette counts as a change: it has to reach the screen once.
    expect(player.takePaletteChange()).not.toBeNull();
    expect(player.takePaletteChange()).toBeNull();

    player.step(0, target);
    expect(player.takePaletteChange()).toBeNull();
  });

  it('reports a malformed fade rather than letting it stick silently', () => {
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...chunk('XPAL', [...u16(0), ...u16(0), 1])]]));

    player.step(0, screen());
    expect(logs.join('\n')).toMatch(/XPAL/);
  });
});

describe('holding a frame with STOR and FTCH', () => {
  it('gives back the frame that was stored, not the one before it', () => {
    const player = new SmushPlayer();
    player.open(
      san([
        // Stored *after* this frame's objects are drawn, which is the ordering
        // the following FTCH depends on.
        [...fobj(5), ...chunk('STOR', [0, 0, 0, 0])],
        [...fobj(9)],
        [...chunk('FTCH', [0, 0, 0, 0, 0, 0])],
      ]),
    );
    const target = screen();

    player.step(0, target);
    expect(target[0]).toBe(5);
    player.step(0.1, target);
    expect(target[0]).toBe(9);
    player.step(0.1, target);
    expect(target[0]).toBe(5);
  });

  it('names a fetch that comes before any store', () => {
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...chunk('FTCH', [0, 0, 0, 0, 0, 0])]]));

    player.step(0, screen());
    expect(logs.join('\n')).toMatch(/FTCH/);
  });
});

describe('the subtitle chunks', () => {
  it('reads where a line goes as well as what it says', () => {
    const cue = readTextCue(
      new Uint8Array([
        ...i16(160),
        ...i16(180),
        ...i16(1),
        ...i16(0),
        ...i16(0),
        ...i16(320),
        ...i16(200),
        ...i16(0),
        ...[...'hi'].map((c) => c.charCodeAt(0)),
      ]),
      'TEXT',
    )!;

    expect(cue).toMatchObject({ x: 160, y: 180, flags: 1, width: 320, height: 200, text: 'hi' });
  });

  it('reads TRES as an index instead of words, which is what it carries', () => {
    const cue = readTextCue(new Uint8Array([...new Array(16).fill(0), ...u16(42)]), 'TRES')!;

    expect(cue.stringId).toBe(42);
    expect(cue.text).toBeNull();
  });

  it('refuses a chunk with no room for its header', () => {
    expect(readTextCue(new Uint8Array([1, 2, 3]), 'TEXT')).toBeNull();
  });

  it('carries the frame’s cues no further than the frame', () => {
    const player = new SmushPlayer();
    const text = chunk('TEXT', [...new Array(16).fill(0), 0x68, 0x69]);
    player.open(san([[...fobj(1), ...text], [...fobj(2)]]));
    const target = screen();

    player.step(0, target);
    expect(player.textCues).toHaveLength(1);
    player.step(0.1, target);
    expect(player.textCues).toHaveLength(0);
  });
});

describe('a chunk nothing here handles', () => {
  it('is named once rather than skipped in silence', () => {
    // `SKIP` is a real chunk this player has no use for. Named once and not
    // once per frame: a sequence that carries one carries it throughout, and a
    // notice per frame would bury everything else in the log.
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...chunk('SKIP', [1, 2, 3, 4])], [...chunk('SKIP', [5, 6, 7, 8])]]));

    player.step(0, screen());
    player.step(0.1, screen());
    expect(logs.filter((line) => line.includes('SKIP'))).toHaveLength(1);
  });
});

describe('the height of the framebuffer a video draws into', () => {
  it('is the whole screen, which is what v7 gives the room', () => {
    // Not the room band: v7 hands all 200 rows to the picture and draws its
    // interface as an overlay, so a video is not clipped to v5's layout.
    expect(SCREEN_HEIGHT).toBe(200);
    expect(SCREEN_WIDTH).toBe(320);
  });
});

describe('the size the delta decoders work at', () => {
  it('is the frame object’s own, not the screen’s', () => {
    // A sequence is free to be a different size from the display — 384x242 is
    // a real case. A decoder sized to the screen holds its reference frames at
    // the wrong stride, so every block referenced from the previous frame is
    // fetched from the wrong row and the picture shears a little more each
    // frame. Codec 37 is the one that would show it, so it is the one asked.
    const wide = 40;
    const tall = 3;
    const object = [
      ...u16(37),
      ...u16(0),
      ...u16(0),
      ...u16(wide),
      ...u16(tall),
      0,
      0,
      0,
      0,
      // A codec 37 payload too short to decode: what is under test is that the
      // decoder was built at all, and at the object's size.
      ...new Array(16).fill(0),
    ];

    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...chunk('FOBJ', object)]]));
    player.step(0, screen());

    // Built rather than skipped: an unbuilt decoder is reported as an
    // unimplemented codec, which would be the wrong diagnosis entirely.
    expect(logs.join('\n')).not.toMatch(/codec 37 is not implemented/i);
  });

  it('names a sequence whose pictures change size, which throws its history away', () => {
    const fobjOf = (w: number, h: number) =>
      chunk('FOBJ', [
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(w),
        ...u16(h),
        0,
        0,
        0,
        0,
        ...new Array(w * h).fill(3),
      ]);

    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...fobjOf(4, 1)], [...fobjOf(8, 1)]]));

    const target = screen();
    player.step(0, target);
    player.step(0.1, target);

    expect(logs.join('\n')).toMatch(/changed size mid-sequence/);
  });
});
