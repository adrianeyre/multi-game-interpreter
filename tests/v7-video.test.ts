import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { VAR_V7 } from '../src/engine/constants.js';
import { buildV7Fixture } from './fixtureV7.js';

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

/** A `.SAN` of `frames` single-colour frames, all 256 colours set to `shade`. */
function san({ frames = 2, speed = 10, shade = 200 } = {}) {
  const fobj = (colour: number) =>
    chunk('FOBJ', [
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(2),
      ...u16(1),
      0,
      0,
      0,
      0,
      colour,
      colour,
    ]);

  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', [
        2,
        0,
        ...u16(frames),
        0,
        0,
        ...new Array(0x300).fill(shade),
        ...u16(speed),
      ]),
      ...new Array(frames).fill(0).flatMap((_, i) => chunk('FRME', fobj(i + 1))),
    ]),
  );
}

/**
 * A `.NUT` font of `count` uncompressed one-pixel glyphs, all colour `colour`.
 *
 * A `.NUT` is a SMUSH animation whose frames are letters, so the same container
 * builds both.
 */
function nut(count: number, colour: number) {
  // Codec 1, because that is what a font uses: one 16-bit byte count, then a
  // fill run of one pixel. Codec 20 glyphs are deliberately left transparent by
  // the reader — an undrawn letter beats a letter drawn from a misread stream.
  const glyph = () =>
    chunk('FOBJ', [
      ...u16(1),
      ...u16(0),
      ...u16(0),
      ...u16(1),
      ...u16(1),
      0,
      0,
      0,
      0,
      ...u16(2),
      1,
      colour,
    ]);

  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', [2, 0, ...u16(count), 0, 0, ...new Array(0x300).fill(0), ...u16(15)]),
      ...new Array(count).fill(0).flatMap(() => chunk('FRME', glyph())),
    ]),
  );
}

/** A `.SAN` of one frame carrying a `TEXT` chunk beside its picture. */
function sanWithText(words: string, { x = 0, y = 0, flags = 0 } = {}) {
  const header = [
    ...u16(x),
    ...u16(y),
    ...u16(flags),
    ...u16(0),
    ...u16(0),
    ...u16(320),
    ...u16(200),
    ...u16(0),
  ];
  const fobj = chunk('FOBJ', [
    ...u16(20),
    ...u16(0),
    ...u16(0),
    ...u16(2),
    ...u16(1),
    0,
    0,
    0,
    0,
    1,
    1,
  ]);

  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', [2, 0, ...u16(1), 0, 0, ...new Array(0x300).fill(200), ...u16(10)]),
      ...chunk('FRME', [
        ...fobj,
        ...chunk('TEXT', [...header, ...[...words].map((c) => c.charCodeAt(0))]),
      ]),
    ]),
  );
}

/** A `.SAN` of one frame whose subtitle is a `TRES` id rather than words. */
function sanWithTres(id: number, { x = 0, y = 0, flags = 0 } = {}) {
  const header = [
    ...u16(x),
    ...u16(y),
    ...u16(flags),
    ...u16(0),
    ...u16(0),
    ...u16(320),
    ...u16(200),
    ...u16(0),
  ];

  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', [2, 0, ...u16(1), 0, 0, ...new Array(0x300).fill(0), ...u16(10)]),
      ...chunk('FRME', chunk('TRES', [...header, ...u16(id)])),
    ]),
  );
}

/** Lets the asynchronous file read behind `playVideo` finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function bootV7(files: Record<string, Uint8Array> = {}) {
  const fixture = buildV7Fixture();
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  for (const [name, bytes] of Object.entries(files)) source.set(name, bytes);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  return { engine, logs };
}

/**
 * SMUSH playback, driven by the engine rather than by the decoder.
 *
 * Tier 1, and what it establishes is the *contract around* playback rather than
 * the decoding: the world stops, the palette is borrowed and given back, and
 * every way a video can fail to open ends with the game running again. Whether
 * a real `.SAN` decodes to the right pixels is Tier 2 and needs a demo.
 */
describe('asking for a video', () => {
  it('stops the world from the moment it is asked for, not when it opens', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san() });

    engine.playVideo('INTRO.SAN');
    // Still fetching, and already blocking. A script that carried on here
    // would reach the next scene before its cutscene had started.
    expect(engine.videoPlaying).toBe(true);

    const timer = engine.variables[engine.vars.TMR_1];
    engine.step();
    expect(engine.variables[engine.vars.TMR_1]).toBe(timer);
  });

  it('draws the video into the framebuffer, and render leaves it alone', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san() });

    engine.playVideo('INTRO.SAN');
    await settle();
    engine.step();
    expect(engine.screen.pixels[0]).toBe(1);

    // The verb panel and the room must not composite over a cutscene.
    engine.render();
    expect(engine.screen.pixels[0]).toBe(1);
  });

  it('runs the world again once the frames run out', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san({ frames: 1 }) });

    engine.playVideo('INTRO.SAN');
    await settle();

    // One step draws the last frame; the step after it is where playback ends.
    // The world does not resume on the frame that is still showing a picture.
    engine.step();
    expect(engine.videoPlaying).toBe(true);
    engine.step();
    expect(engine.videoPlaying).toBe(false);

    const timer = engine.variables[engine.vars.TMR_1];
    engine.step();
    expect(engine.variables[engine.vars.TMR_1]).toBe(timer + 1);
  });

  it('borrows the palette and gives the room’s back', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san({ frames: 1, shade: 200 }) });
    engine.palette.setFromClut(new Uint8Array(0x300).fill(3));

    engine.playVideo('INTRO.SAN');
    await settle();
    engine.step();
    // The last frame is still a frame: it is drawn with the video's colours and
    // the room's come back on the step after, not over the top of it.
    expect(engine.palette.getColor(0)).toEqual([200, 200, 200]);

    engine.step();
    // …and the room wears its own again afterwards. Without this the first
    // room after a cutscene comes back in the cutscene's colours.
    expect(engine.palette.getColor(0)).toEqual([3, 3, 3]);
  });
});

describe('a video that will not play', () => {
  it('names a file that is not beside the game, and keeps going', async () => {
    const { engine, logs } = await bootV7();

    engine.playVideo('MISSING.SAN');
    await settle();

    expect(engine.videoPlaying).toBe(false);
    expect(logs.join('\n')).toMatch(/MISSING\.SAN/);
  });

  it('names a file that is not a SMUSH animation, and keeps going', async () => {
    const { engine, logs } = await bootV7({ 'NOTVIDEO.SAN': new Uint8Array(chunk('LECF', [1])) });

    engine.playVideo('NOTVIDEO.SAN');
    await settle();

    expect(engine.videoPlaying).toBe(false);
    expect(logs.join('\n')).toMatch(/NOTVIDEO\.SAN/);
  });

  it('refuses a second video over one already playing', async () => {
    const { engine, logs } = await bootV7({ 'A.SAN': san(), 'B.SAN': san() });

    engine.playVideo('A.SAN');
    await settle();
    engine.playVideo('B.SAN');

    expect(logs.join('\n')).toMatch(/B\.SAN/);
    expect(engine.video.playing).toBe('A.SAN');
  });

  it('does not start a video the player skipped while it was loading', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san() });

    engine.playVideo('INTRO.SAN');
    engine.video.skip();
    await settle();

    // The fetch landing later must not restart what was already given up on.
    expect(engine.videoPlaying).toBe(false);
  });
});

/**
 * `kernelSetFunctions` under v7, whose numbers are its own.
 *
 * The list is pushed values first and a count last, so `06 00 02` is
 * "sub-function 6, argument 0".
 */
async function runKernel(args: number[], files: Record<string, Uint8Array> = {}) {
  const code: number[] = [];
  for (const value of args) code.push(0x00, value);
  code.push(0x00, args.length, 0xc9);

  const fixture = buildV7Fixture({ script2: code });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  for (const [name, bytes] of Object.entries(files)) source.set(name, bytes);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  return { engine, logs, run: () => engine.scripts.runScript(2, false, false, []) };
}

describe('the kernel hatch a v7 script plays a video through', () => {
  it('plays the file named by VAR_VIDEONAME rather than an operand', async () => {
    const { engine, run } = await runKernel([6, 0], { 'INTRO.SAN': san() });

    // Defining the array binds its handle into the variable, which is how the
    // name reaches the kernel: two instructions agreeing about a slot number.
    engine.scriptState.arrays.define(VAR_V7.VIDEONAME, 'string', 0, 32);
    engine.scriptState.arrays.writeString(VAR_V7.VIDEONAME, 0, 'INTRO.SAN');

    run();
    expect(engine.video.playing).toBe('INTRO.SAN');
  });

  it('warns rather than plays nothing quietly when no name is set', async () => {
    const { engine, logs, run } = await runKernel([6, 0]);

    run();
    expect(engine.videoPlaying).toBe(false);
    // The variable number is in the message on purpose: "no video was named"
    // and "the name was looked for in the wrong slot" look identical on screen.
    expect(logs.join('\n')).toMatch(new RegExp(String(VAR_V7.VIDEONAME)));
  });

  it('uses the rate a script set when the file declares none', async () => {
    // 15 sets the rate for the *next* video; the file's own header still wins
    // when it has one, which is the original's order of precedence.
    const code: number[] = [
      0x00,
      15,
      0x00,
      24,
      0x00,
      2,
      0xc9, // kernelSetFunctions 15, 24
      0x00,
      6,
      0x00,
      0,
      0x00,
      2,
      0xc9, // kernelSetFunctions 6, 0
    ];
    const fixture = buildV7Fixture({ script2: code });
    const source = new MemoryDataSource('v7');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    source.set('INTRO.SAN', san({ speed: 0 }));

    const logs: string[] = [];
    const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
    engine.boot(0);
    engine.scriptState.arrays.define(VAR_V7.VIDEONAME, 'string', 0, 32);
    engine.scriptState.arrays.writeString(VAR_V7.VIDEONAME, 0, 'INTRO.SAN');

    engine.scripts.runScript(2, false, false, []);
    await settle();

    expect(logs.join('\n')).toMatch(/24 fps/);
  });

  it('names an interactive scene rather than dropping it, argument and all', async () => {
    // The same sub-function, the other interaction model: Full Throttle's bike
    // fights are played, not watched, and they come through here with a
    // non-zero argument. #103.
    const { engine, logs, run } = await runKernel([6, 1]);

    run();
    expect(engine.videoPlaying).toBe(false);
    expect(logs.join('\n')).toMatch(/interactive SMUSH scene/i);
    expect(logs.join('\n')).toMatch(/#103/);
  });

  it('names a sub-function neither this nor the original implements', async () => {
    // 5 is not a sub-function v7 has: the original's switch has no case for it
    // and falls through to an error. Every number v7 *does* name is handled, so
    // this test has to reach for one outside the set — which is the honest
    // thing for it to be testing anyway, since a script arriving here means a
    // misread instruction stream rather than a gap in this build.
    const { engine, logs, run } = await runKernel([5, 1, 2]);
    run();
    expect(engine.videoPlaying).toBe(false);
    expect(logs.join('\n')).toMatch(/kernelSetFunctions/);
  });
});

describe('subtitles over a cutscene', () => {
  it('reads the fonts beside the game, and numbers them as ^f does', async () => {
    const { engine, logs } = await bootV7({
      'FONT0.NUT': nut(128, 9),
      'FONT1.NUT': nut(128, 11),
    });

    expect(logs.join('\n')).toMatch(/FONT0\.NUT/);
    expect(engine.video.fonts).toHaveLength(4);
    expect(engine.video.fonts[0]).not.toBeNull();
    expect(engine.video.fonts[2]).toBeNull();
  });

  it('draws the words a frame carries, over the picture', async () => {
    const { engine } = await bootV7({
      'FONT0.NUT': nut(128, 9),
      'TALK.SAN': sanWithText('hi', { x: 40, y: 100 }),
    });

    engine.playVideo('TALK.SAN');
    await settle();
    engine.step();

    // Colour 9 is the font's, and it is over the frame rather than under it:
    // drawn before the frame object, the video paints over its own words.
    expect(engine.screen.pixels[100 * 320 + 40]).toBe(9);
    expect(engine.screen.pixels[100 * 320 + 41]).toBe(9);
  });

  it('says so once when a game has subtitles but no font', async () => {
    const { engine, logs } = await bootV7({ 'TALK.SAN': sanWithText('hi') });

    engine.playVideo('TALK.SAN');
    await settle();
    engine.step();

    expect(logs.join('\n')).toMatch(/without their text/);
  });

  it('draws a line named by id, from the table beside the video', async () => {
    // A `TRES` cue carries a number, not words: the words live in `TALK.trs`,
    // named after the video that uses them.
    const { engine } = await bootV7({
      'FONT0.NUT': nut(128, 9),
      'TALK.SAN': sanWithTres(7, { x: 20, y: 60 }),
      'TALK.trs': new TextEncoder().encode('#7\r\nhi\r\n\r\n'),
    });

    engine.playVideo('TALK.SAN');
    await settle();
    engine.step();

    expect(engine.screen.pixels[60 * 320 + 20]).toBe(9);
  });

  it('names a missing table rather than drawing the line blank', async () => {
    const { engine, logs } = await bootV7({
      'FONT0.NUT': nut(128, 9),
      'TALK.SAN': sanWithTres(7),
    });

    engine.playVideo('TALK.SAN');
    await settle();
    engine.step();

    expect(logs.join('\n')).toMatch(/no string table was found/);
  });

  it('names the id when the table is there and the line is not', async () => {
    // A different fault from a missing table, and the id is what says which.
    const { engine, logs } = await bootV7({
      'FONT0.NUT': nut(128, 9),
      'TALK.SAN': sanWithTres(7),
      'TALK.trs': new TextEncoder().encode('#1\r\nsomething else\r\n\r\n'),
    });

    engine.playVideo('TALK.SAN');
    await settle();
    engine.step();

    expect(logs.join('\n')).toMatch(/subtitle 7/);
  });
});

/**
 * A v7 script naming its own video, with no help from the test.
 *
 * The path the game actually takes: `arrayOps` writes the file name into a
 * string array, defining it binds the handle into `VAR_VIDEONAME`, and
 * `kernelSetFunctions` 6 reads it back. Every step in bytecode, because the
 * three instructions agreeing is the thing that was missing — the array
 * instructions were installed for v6 only, so a v7 script could not write a
 * string at all and the kernel could never be given a name.
 */
describe('a v7 script that plays a video end to end', () => {
  const ARRAY_OPS = 0xa4;
  const ASSIGN_STRING = 205;
  const DIM_ARRAY = 0xbc;
  const DIM_STRING = 203;

  const word = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const text = (value: string) => [...[...value].map((c) => c.charCodeAt(0)), 0];

  async function runScript(code: number[], files: Record<string, Uint8Array> = {}) {
    const fixture = buildV7Fixture({ script2: code });
    const source = new MemoryDataSource('v7');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    for (const [name, bytes] of Object.entries(files)) source.set(name, bytes);

    const logs: string[] = [];
    const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);
    return { engine, logs };
  }

  it('writes a string into an array, which v7 could not do at all', async () => {
    const { engine } = await runScript([
      0x00,
      0, // where in the array to write
      ARRAY_OPS,
      ASSIGN_STRING,
      ...word(VAR_V7.VIDEONAME),
      ...text('INTRO.SAN'),
    ]);

    expect(engine.scriptState.arrays.readString(VAR_V7.VIDEONAME)).toBe('INTRO.SAN');
  });

  it('dimensions an array from the code stream and the stack', async () => {
    const { engine } = await runScript([0x00, 8, DIM_ARRAY, DIM_STRING, ...word(200)]);
    expect(engine.scriptState.arrays.has(200)).toBe(true);
  });

  it('plays the video its own instructions named', async () => {
    const { engine } = await runScript(
      [
        0x00,
        0,
        ARRAY_OPS,
        ASSIGN_STRING,
        ...word(VAR_V7.VIDEONAME),
        ...text('INTRO.SAN'),
        0x00,
        6,
        0x00,
        0,
        0x00,
        2,
        0xc9,
      ],
      { 'INTRO.SAN': san() },
    );

    // Defining the array bound its handle into the variable, and the kernel
    // read the name back out of it. Nothing in this test told the engine.
    expect(engine.video.playing).toBe('INTRO.SAN');
  });
});

describe('the end of a sequence, which is not its last frame', () => {
  it('holds the last frame while the audio queued behind it drains', async () => {
    // Audio is queued ahead of the picture — that is what makes it the clock —
    // so a cutscene's last frame is decoded while its closing line is still
    // playing. Ending on the last frame cuts that line off mid-word.
    const { engine } = await bootV7({ 'INTRO.SAN': san({ frames: 1 }) });
    let remaining = 0.5;
    engine.video.audioRemaining = () => remaining;

    engine.playVideo('INTRO.SAN');
    await settle();

    engine.step();
    expect(engine.videoPlaying).toBe(true);
    engine.step();
    expect(engine.videoPlaying).toBe(true);

    remaining = 0;
    engine.step();
    expect(engine.videoPlaying).toBe(false);
  });

  it('does not cut the audio of a sequence that ran to its end', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san({ frames: 1 }) });
    let cut = false;
    engine.video.onAudioStopped = () => {
      cut = true;
    };
    engine.video.audioRemaining = () => 0;

    engine.playVideo('INTRO.SAN');
    await settle();
    engine.step();
    engine.step();

    expect(engine.videoPlaying).toBe(false);
    expect(cut).toBe(false);
  });

  it('cuts the audio of a sequence the player skipped, which is the point', async () => {
    const { engine } = await bootV7({ 'INTRO.SAN': san({ frames: 40 }) });
    let cut = false;
    engine.video.onAudioStopped = () => {
      cut = true;
    };

    engine.playVideo('INTRO.SAN');
    await settle();
    engine.step();
    engine.video.skip();

    expect(engine.videoPlaying).toBe(false);
    expect(cut).toBe(true);
  });
});
