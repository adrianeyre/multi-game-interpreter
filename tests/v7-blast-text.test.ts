import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { VAR_V7 } from '../src/engine/constants.js';
import { buildV7Fixture } from './fixtureV7.js';
import { buildVocPayload, tag, u32be } from './fixture.js';

/**
 * Text a v7 script draws straight to the screen.
 *
 * v7 has no verb panel: its inventory, its dialogue menus and Full Throttle's
 * action wheel are all lines a script queues for one frame and queues again the
 * next. Two `kernelSetFunctions` sub-functions do it — 16 centred, 17 left —
 * and neither takes the text as an operand, so the whole feature turns on
 * reading the right variable and the right argument positions.
 * (`ScummEngine_v7::o6_kernelSetFunctions` cases 16 and 17, and
 * `ScummEngine_v7::enqueueText`.)
 *
 * The fixture's font has exactly one glyph, 'A', so every string here is made
 * of it: eight pixels wide, and lit on columns 1 to 6 of each cell. That is
 * what makes a position assertion possible at all.
 */

/** The x of the leftmost lit column of a glyph drawn with its cell at x. */
const GLYPH_LEFT_BEARING = 1;
/** How wide one 'A' advances. */
const GLYPH_WIDTH = 8;

/** `kernelSetFunctions`: values pushed first, the count last, then the call. */
function kernelCode(...calls: number[][]): number[] {
  const code: number[] = [];
  for (const args of calls) {
    for (const value of args) code.push(0x00, value);
    code.push(0x00, args.length, 0xc9);
  }
  return code;
}

async function bootBlast(code: number[]) {
  const fixture = buildV7Fixture({ script2: code });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);

  // Defining the array binds its handle into the variable, which is how the
  // text reaches the kernel: the script and the interpreter agreeing about a
  // slot number rather than passing a string.
  engine.scriptState.arrays.define(VAR_V7.STRING2DRAW, 'string', 0, 64);

  return {
    engine,
    logs,
    setText: (text: string) => engine.scriptState.arrays.writeString(VAR_V7.STRING2DRAW, 0, text),
    run: () => engine.scripts.runScript(2, false, false, []),
  };
}

/** The bounding box of everything drawn, or null for an empty screen. */
function litBounds(engine: ScummEngine): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} | null {
  engine.render();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      if (engine.screen.pixels[y * 320 + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? null : { minX, maxX, minY, maxY };
}

/**
 * A talkie release's speech file holding one sample at offset 1.
 *
 * Offset 1 rather than 0 because a script's speech offset is only acted on when
 * it is positive, which is how "this line has a recording" is expressed.
 */
/**
 * A speech file holding one sample, at offset 1.
 *
 * The VOC follows the `VCTL` header immediately: `Crea` is the first four
 * characters of `Creative Voice File`, not a chunk header of its own. This
 * fixture used to insert one, matching what the reader then did — so the two
 * agreed and every real release read as having no speech.
 */
function speechFile(): Uint8Array {
  return Uint8Array.from([0, ...tag('VCTL'), ...u32be(8), ...buildVocPayload()]);
}

describe('text a v7 script blasts over the frame', () => {
  it('draws the line the script left in an array, not one it passed as an operand', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    setText('AAA');

    run();

    expect(engine.currentBlastTexts().map((entry) => entry.text)).toEqual(['AAA']);
  });

  it('reads charset, colour and position in the order the original passes them', async () => {
    // charset, colour, x, y — not the x, y, colour a caller would guess, and a
    // transposition here draws a readable line in the wrong place, which is the
    // kind of wrong that looks like a layout bug rather than a decoding one.
    const { engine, setText, run } = await bootBlast(kernelCode([17, 4, 5, 20, 100]));
    setText('AAA');

    run();

    expect(engine.currentBlastTexts()[0]).toEqual({
      text: 'AAA',
      charset: 4,
      color: 5,
      x: 20,
      y: 100,
      centred: false,
    });
  });

  it('starts a left-aligned line at the x it was given', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    setText('AAA');
    run();

    const bounds = litBounds(engine);
    expect(bounds?.minX).toBe(20 + GLYPH_LEFT_BEARING);
    expect(bounds?.minY).toBe(100);
  });

  it('centres a centred line on the x it was given', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([16, 0, 5, 160, 100]));
    setText('AAA');
    run();

    // Half of the line's own width to the left of 160, which is what makes the
    // difference between the two sub-functions worth having.
    const left = 160 - (3 * GLYPH_WIDTH) / 2;
    expect(litBounds(engine)?.minX).toBe(left + GLYPH_LEFT_BEARING);
  });

  it('draws a line for each break in the string', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    // One call, two rows: a script that wants two lines of a menu writes them
    // as one string with a break, so the queue holds one entry per call rather
    // than one per row.
    setText('AAA\nAAA');
    run();

    // The glyph is eight tall and lit to row 6, so one row ends at 106 and a
    // second starts a font height below it.
    expect(litBounds(engine)?.maxY).toBe(100 + 8 + 6);
  });

  it('draws a line asking for a font the game has not got', async () => {
    // The original would fail outright. Falling back to font 0 draws the line
    // in the wrong face; dropping it leaves a menu with a missing row, and a
    // player can read the first.
    const { engine, setText, run } = await bootBlast(kernelCode([17, 7, 5, 20, 100]));
    setText('AAA');
    run();

    expect(litBounds(engine)).not.toBeNull();
  });

  it('drops the blank strings The Dig sends constantly', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    setText(' ');

    run();

    // The original checks for exactly the empty and one-space cases and
    // returns. Queueing them would fill a bounded queue with nothing.
    expect(engine.currentBlastTexts()).toHaveLength(0);
  });

  it('drops an empty string as well', async () => {
    const { engine, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    // Never written to, so the array reads back empty.
    run();

    expect(engine.currentBlastTexts()).toHaveLength(0);
  });

  it('keeps nothing past the frame it was queued in', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    setText('AAA');
    run();
    expect(engine.currentBlastTexts()).toHaveLength(1);

    engine.step();

    // A caption stays up only while the script keeps asking for it, which is
    // what makes this different from speech.
    expect(engine.currentBlastTexts()).toHaveLength(0);
  });

  it('draws the same frame twice, so a second render is not a blank one', async () => {
    const { engine, setText, run } = await bootBlast(kernelCode([17, 0, 5, 20, 100]));
    setText('AAA');
    run();

    engine.render();
    const first = Uint8Array.from(engine.screen.pixels);
    engine.render();

    // Draining the queue while drawing it would make this the empty screen —
    // and the host is free to render a frame more than once.
    expect(Uint8Array.from(engine.screen.pixels)).toEqual(first);
  });

  it('stops at the queue the original stops at, and says so once', async () => {
    const calls: number[][] = [];
    for (let i = 0; i < 60; i++) calls.push([17, 0, 5, 20, 100]);
    const { engine, logs, setText, run } = await bootBlast(kernelCode(...calls));
    setText('AAA');

    run();

    expect(engine.currentBlastTexts()).toHaveLength(50);
    expect(logs.filter((line) => line.includes('queued for one frame'))).toHaveLength(1);
  });
});

describe('captions, when the player has turned them off', () => {
  const spoken = (engine: ScummEngine) => ({
    ...engine.beginTextOptions(255),
    text: 'AAA',
    speechOffset: 1,
    speechSize: 8,
  });

  it('takes the setting from the options screen', async () => {
    const { engine, run } = await bootBlast(kernelCode([215, 0]));
    expect(engine.subtitles).toBe(true);

    run();

    expect(engine.subtitles).toBe(false);
  });

  it('turns them back on for a non-zero argument', async () => {
    const { engine, run } = await bootBlast(kernelCode([215, 0], [215, 1]));
    run();
    expect(engine.subtitles).toBe(true);
  });

  it('shows no text for a line the player can hear', async () => {
    const { engine } = await bootBlast([0x66]);
    engine.sound.attachSpeech(speechFile());
    engine.setSubtitles(false);

    engine.showText(spoken(engine));

    expect(engine.currentText()).toBe('');
    // The line still runs for as long as its recording does: a script waiting
    // for the message is waiting for the audio, captions or not.
    expect(engine.messageFramesRemaining()).toBeGreaterThan(0);
  });

  it('shows the text of a line that has no recording', async () => {
    const { engine } = await bootBlast([0x66]);
    engine.setSubtitles(false);

    engine.showText({ ...engine.beginTextOptions(255), text: 'AAA' });

    // Suppressing this one would deliver the line not at all, which is why the
    // setting reaches only spoken lines.
    expect(engine.currentText()).toBe('AAA');
  });

  it('shows the text of a spoken line while they are on', async () => {
    const { engine } = await bootBlast([0x66]);
    engine.sound.attachSpeech(speechFile());

    engine.showText(spoken(engine));

    expect(engine.currentText()).toBe('AAA');
  });
});
