import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { decodeStrip } from '../src/engine/gfx/BitmapCodec.js';
import { buildFixture } from './fixture.js';

/**
 * The engine runs scripts synchronously inside one frame, so a script that
 * never yields takes the browser with it: the page stops painting and Chrome
 * offers to kill the tab. These cover the budget that turns that into a log
 * line and a still-usable page.
 */
describe('runaway script watchdog', () => {
  /** A boot script that jumps to itself: `jumpRelative -3`, forever. */
  const infiniteLoop = [0x18, 0xfd, 0xff];

  function loopingGame() {
    const fixture = buildFixture({ bootScript: infiniteLoop });
    const source = new MemoryDataSource('looping');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    return source;
  }

  it('returns from a boot script that never yields', async () => {
    const messages: string[] = [];
    const engine = await ScummEngine.create(loopingGame(), {
      onLog: (message) => messages.push(message),
    });

    // Without the budget this call never returns and the tab dies with
    // "Page Unresponsive".
    engine.boot(0);

    expect(engine.stuckScripts.has(1)).toBe(true);
    expect(messages.some((message) => /without yielding/.test(message))).toBe(true);
  });

  it('keeps stepping frames afterwards instead of wedging the loop', async () => {
    const engine = await ScummEngine.create(loopingGame());
    engine.boot(0);

    // Each frame pauses the stuck script again, so the shell keeps control.
    for (let i = 0; i < 5; i++) engine.step();
    expect(engine.frame).toBe(5);
  });

  it('reports a stuck script only once', async () => {
    const messages: string[] = [];
    const engine = await ScummEngine.create(loopingGame(), {
      onLog: (message) => messages.push(message),
    });

    engine.boot(0);
    for (let i = 0; i < 3; i++) engine.step();

    const warnings = messages.filter((message) => /without yielding/.test(message));
    expect(warnings).toHaveLength(1);
  });

  it('leaves a well-behaved game with nothing to report', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('fixture');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.step();

    expect(engine.stuckScripts.size).toBe(0);
  });
});

describe('code that runs off the end of a script', () => {
  function gameWithBoot(bootScript: number[]) {
    const fixture = buildFixture({ bootScript });
    const source = new MemoryDataSource('truncated');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    return source;
  }

  /**
   * Each of these ends mid-instruction, so the sentinel byte its loop waits
   * for is never in the code. Before the fetches were bounded, an out-of-range
   * read returned `undefined`, the sentinel could never match, and the loop
   * spun inside one opcode handler — past the reach of the opcode budget,
   * which only gets a turn between instructions.
   */
  const truncated: Array<[string, number[]]> = [
    // printEgo, then a parse-string list with no 0xFF terminator.
    ['a text list with no terminator', [0xd8, 0x0f]],
    // actorOps on actor 1, sub-opcode list cut off.
    ['an actor list with no terminator', [0x13, 0x01, 0x01]],
    // verbOps, cut off.
    ['a verb list with no terminator', [0x7a, 0x01, 0x01]],
    // A message that never reaches its NUL.
    ['a message with no terminator', [0x14, 0x00, 0x00, 0x00, 0x41, 0x42, 0x43]],
    // Expression opcode with no 0xFF.
    ['an expression with no terminator', [0xac, 0x00, 0x00, 0x01]],
    // pseudoRoom with no zero terminator.
    ['a pseudo-room list with no terminator', [0xcc, 0x01, 0x81]],
  ];

  for (const [name, bootScript] of truncated) {
    it(`stops a script ending in ${name}`, async () => {
      const messages: string[] = [];
      const engine = await ScummEngine.create(gameWithBoot(bootScript), {
        onLog: (message) => messages.push(message),
      });

      engine.boot(0);
      for (let i = 0; i < 3; i++) engine.step();

      // The point is that these calls return at all. Reporting the overrun is
      // the diagnostic that says which script to look at.
      expect(messages.some((m) => /read past the end|Unimplemented opcode/.test(m))).toBe(true);
    });
  }
});

describe('strip decoding with a bad height', () => {
  it('returns instead of looping when the height is zero', () => {
    // Codec 134 exits only when the row counter reaches the height, so a room
    // header this engine misreads as zero rows used to never exit.
    const src = new Uint8Array([0x86, 12, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    const dst = new Uint8Array(64);

    decodeStrip(src, 0, { dst, dstOffset: 0, dstStride: 8, height: 0, transparentColor: 255 });

    expect([...dst.slice(0, 8)]).toEqual(new Array(8).fill(0));
  });

  it('fills exactly the requested height', () => {
    const src = new Uint8Array([0x86, 7, ...new Array(32).fill(0)]);
    const dst = new Uint8Array(8 * 4);

    decodeStrip(src, 0, { dst, dstOffset: 0, dstStride: 8, height: 2, transparentColor: 255 });

    expect(dst[0]).toBe(7);
    // Rows past the height are untouched.
    expect([...dst.slice(16)]).toEqual(new Array(16).fill(0));
  });
});

describe('reporting what stopped a game', () => {
  it('says plainly when an unimplemented opcode stops the boot script', async () => {
    // 0x2f is one of the opcodes the table does not claim: several codes in its
    // family are different operations, so it is left unbound rather than
    // guessed at, and a script hitting it stops instead of misreading operands.
    const fixture = buildFixture({ bootScript: [0x2f, 0x01, 0x01] });
    const source = new MemoryDataSource('unimplemented');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const messages: string[] = [];
    const engine = await ScummEngine.create(source, {
      onLog: (message) => messages.push(message),
    });
    expect(() => engine.boot(0)).toThrow(/0x2f.*stopped the boot script/);

    expect(engine.unknownOpcodes.get(0x2f)).toBe(1);
    expect(messages.some((m) => /0x2f.*boot script/.test(m))).toBe(true);
  });

  it('names each engine activity as it starts, for tracing a freeze', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('fixture');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const activities: string[] = [];
    const engine = await ScummEngine.create(source, {
      onActivity: (activity) => activities.push(activity),
    });
    engine.boot(0);

    expect(activities).toContain('running the boot script');
    expect(engine.activity).toBe('idle');
  });
});

describe('music that cannot be synthesised', () => {
  function gameSource() {
    const fixture = buildFixture();
    const source = new MemoryDataSource('sound');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    return source;
  }

  it('stops reporting unplayable music as running', async () => {
    // A script that waits for music to finish waits for ever if the answer is
    // always "still playing" — a logo screen that never advances.
    const engine = await ScummEngine.create(gameSource());
    engine.sound.startSound(5);
    expect(engine.sound.isSoundRunning(5)).toBe(true);

    for (let i = 0; i < 119; i++) engine.sound.step();
    expect(engine.sound.isSoundRunning(5)).toBe(true);

    engine.sound.step();
    expect(engine.sound.isSoundRunning(5)).toBe(false);
  });

  it('ages music as the engine steps frames', async () => {
    const engine = await ScummEngine.create(gameSource());
    engine.boot(0);
    engine.sound.startSound(5);

    for (let i = 0; i < 200; i++) engine.step();
    expect(engine.sound.isSoundRunning(5)).toBe(false);
  });

  it('still reports a sound that was never started as not running', async () => {
    const engine = await ScummEngine.create(gameSource());
    expect(engine.sound.isSoundRunning(9)).toBe(false);
  });
});

describe('seeing what a waiting script is parked on', () => {
  it('names each live script, where it is and what it is about to run', async () => {
    const fixture = buildFixture({
      // breakHere, then jump back to it: yields every frame, for ever, which is
      // what a script waiting on a condition looks like from outside.
      bootScript: [0x80, 0x18, 0xfc, 0xff],
    });
    const source = new MemoryDataSource('waiting');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.step();

    const state = engine.describeScriptState();
    expect(state).toMatch(/script 1, offset \d+, opcode 0x[0-9a-f]{2}/);
  });

  it('says so plainly when nothing is running', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('idle');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const engine = await ScummEngine.create(source);
    expect(engine.describeScriptState()).toBe('no scripts running');
  });
});

describe('delay', () => {
  /** boot: delay 60 frames, then VAR[100] = 1234, then stop. */
  function delayedGame(frames: number) {
    const bootScript = [
      0x2e,
      frames & 0xff,
      (frames >> 8) & 0xff,
      (frames >> 16) & 0xff,
      0x1a,
      100,
      0,
      0xd2,
      0x04,
      0x00,
    ];
    const fixture = buildFixture({ bootScript });
    const source = new MemoryDataSource('delay');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    return source;
  }

  it('sleeps for the number of frames the script asked for', async () => {
    const engine = await ScummEngine.create(delayedGame(60));
    engine.boot(0);

    for (let i = 0; i < 30; i++) engine.step();
    expect(engine.variables[100]).toBe(0);

    for (let i = 0; i < 40; i++) engine.step();
    expect(engine.variables[100]).toBe(1234);
  });

  it('resumes a short delay promptly', async () => {
    const engine = await ScummEngine.create(delayedGame(2));
    engine.boot(0);

    for (let i = 0; i < 5; i++) engine.step();
    expect(engine.variables[100]).toBe(1234);
  });
});
