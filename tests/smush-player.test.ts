import { describe, expect, it } from 'vitest';
import { SmushPlayer, DEFAULT_SMUSH_FPS } from '../src/engine/video/SmushPlayer.js';
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

const ahdr = (frames: number, speed: number) => [
  2,
  0,
  ...u16(frames),
  0,
  0,
  ...new Array(0x300).fill(0).map((_, i) => i & 0xff),
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

function san(frames: number[][], { count = frames.length, speed = 0 } = {}) {
  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', ahdr(count, speed)),
      ...frames.flatMap((f) => chunk('FRME', f)),
    ]),
  );
}

const screen = () => new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT);

/**
 * Playing a SMUSH sequence.
 *
 * The thing under test is **sync**, and the decision that governs it: frames are
 * selected against elapsed time rather than counted, so a slow frame skips
 * ahead instead of stretching the sequence. Drift then stays bounded rather than
 * accumulating — which is the failure a fixture cannot see and a person cannot
 * miss.
 */
describe('opening a sequence', () => {
  it('reads the frame count and the file’s own frame rate', () => {
    const player = new SmushPlayer();
    const sequence = player.open(san([[...fobj(1)]], { count: 3, speed: 12 }))!;

    expect(sequence.frameCount).toBe(3);
    expect(sequence.fps).toBe(12);
  });

  it('falls back to the default rate when the file overrides nothing', () => {
    const player = new SmushPlayer();
    const sequence = player.open(san([[...fobj(1)]], { speed: 0 }))!;
    expect(sequence.fps).toBe(DEFAULT_SMUSH_FPS);
  });

  it('returns null for a file that is not a SMUSH animation', () => {
    expect(new SmushPlayer().open(new Uint8Array(chunk('LECF', [1])))).toBeNull();
  });
});

describe('advancing against the clock', () => {
  it('draws the first frame as soon as it is due', () => {
    const player = new SmushPlayer();
    player.open(san([[...fobj(5)]], { speed: 10 }));
    const target = screen();

    expect(player.step(0, target)).toBe(true);
    expect(target[0]).toBe(5);
  });

  it('shows nothing new until the next frame is due', () => {
    const player = new SmushPlayer();
    player.open(san([[...fobj(1)], [...fobj(2)]], { speed: 10 }));
    const target = screen();

    player.step(0, target);
    // A tenth of a second per frame, so half of one is not enough.
    expect(player.step(0.05, target)).toBe(false);
    expect(target[0]).toBe(1);
  });

  it('selects a frame by elapsed time rather than counting steps', () => {
    // The point of the design: a long step lands on the frame the clock says,
    // not on the next one in sequence.
    const player = new SmushPlayer();
    player.open(san([[...fobj(1)], [...fobj(2)], [...fobj(3)], [...fobj(4)]], { speed: 10 }));
    const target = screen();

    player.step(0, target);
    player.step(0.3, target);
    expect(target[0]).toBe(4);
  });

  it('decodes the frames it skips over rather than jumping past them', () => {
    // Codecs 37 and 47 build each frame from the one before, so a skipped frame
    // corrupts every frame after it. Skipped frames are decoded, just not
    // waited for.
    const player = new SmushPlayer();
    player.open(san([[...fobj(1)], [...fobj(2)], [...fobj(9)]], { speed: 10 }));
    const target = screen();

    player.step(0.25, target);
    expect(target[0]).toBe(9);
  });

  it('reports itself finished once the frames run out', () => {
    const player = new SmushPlayer();
    player.open(san([[...fobj(1)]], { speed: 10 }));
    const target = screen();

    expect(player.finished).toBe(false);
    player.step(1, target);
    expect(player.finished).toBe(true);
  });
});

describe('the palette', () => {
  it('takes the one the header carries', () => {
    const player = new SmushPlayer();
    const sequence = player.open(san([[...fobj(1)]]))!;
    expect(sequence.palette).toHaveLength(0x300);
    expect(sequence.palette[1]).toBe(1);
  });

  it('updates it when a frame carries a new one', () => {
    const player = new SmushPlayer();
    const sequence = player.open(
      san([[...chunk('NPAL', new Array(0x300).fill(7)), ...fobj(1)]], { speed: 10 }),
    )!;

    player.step(0, screen());
    expect(sequence.palette[0]).toBe(7);
  });
});

describe('interleaved audio', () => {
  it('collects nothing from an IACT that is not audio', () => {
    // Full Throttle's bike fights drive their overlays through IACT. Decoding
    // those as samples is noise. (#103.)
    const notAudio = chunk('IACT', [...u16(4), ...u16(46), ...u16(0), ...u16(0), 1, 2, 3, 4]);
    const player = new SmushPlayer();
    player.open(san([[...notAudio, ...fobj(1)]], { speed: 10 }));

    player.step(0, screen());
    expect(player.takeAudio()).toBeNull();
  });

  it('gathers audio blocks in order, and hands them over once', () => {
    const codes = new Array(2048).fill(1);
    const block = [0, 0, 0x00, ...codes];
    const audio = chunk('IACT', [
      ...u16(8),
      ...u16(46),
      ...u16(0),
      ...u16(0),
      ...new Array(10).fill(0),
      (block.length - 2) >> 8,
      (block.length - 2) & 0xff,
      ...block.slice(2),
    ]);

    const player = new SmushPlayer();
    player.open(san([[...audio, ...fobj(1)]], { speed: 10 }));
    player.step(0, screen());

    const taken = player.takeAudio();
    expect(taken).not.toBeNull();
    // Taken once: a second call has nothing left to give, so audio is never
    // queued twice.
    expect(player.takeAudio()).toBeNull();
  });

  it('measures audio in seconds, which is what frames are matched against', () => {
    const samples = new Int16Array(IACT_FRAMES * 2);
    expect(SmushPlayer.durationOf({ samples })).toBeCloseTo(IACT_FRAMES / 22050, 6);
  });
});

const IACT_FRAMES = 1024;

describe('a codec it cannot draw', () => {
  it('says so once and keeps the sequence running', () => {
    const unknown = chunk('FOBJ', [
      ...u16(99),
      ...u16(0),
      ...u16(0),
      ...u16(2),
      ...u16(1),
      0,
      0,
      0,
      0,
      1,
      2,
    ]);
    const logs: string[] = [];
    const player = new SmushPlayer();
    player.onLog = (line) => logs.push(line);
    player.open(san([[...unknown], [...unknown]], { speed: 10 }));

    player.step(0, screen());
    player.step(0.2, screen());

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('99');
  });
});
