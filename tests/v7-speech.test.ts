import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildV7Fixture } from './fixtureV7.js';

/**
 * v7 recorded speech, which is three different things wearing one encoding.
 *
 * Every v6-or-later message can carry control code 10: fourteen bytes holding
 * two 32-bit numbers. What they point into is a property of the release rather
 * than of the version. Full Throttle's are a byte offset into `MONSTER.SOU` and
 * the size of the `VCTL` header there, exactly as a v6 talkie's are. The Dig's
 * demo reuses the same two fields as a room number and a line number and keeps
 * one `.voc` per line in a folder per room. The full releases carry the pair
 * but address speech by cue name inside a `.BUN`, so the numbers lead nowhere.
 *
 * v7 used to drop the payload instead of decoding it — filtering out bytes
 * below 0x20, which kept the `0xff` markers and any printable payload byte — so
 * the demo's first line displayed as line noise and no v7 release ever spoke.
 */

/** Speech control code 10: two 32-bit values, high halves four bytes on. */
function speechCode(first: number, second: number): number[] {
  const halves = [first & 0xffff, first >>> 16, second & 0xffff, second >>> 16];
  return halves.flatMap((half) => [0xff, 0x0a, half & 0xff, (half >> 8) & 0xff]);
}

/** `talkActor` on actor 1, saying one message. */
function talkScript(message: number[]): number[] {
  return [0x00, 0x01, 0xba, ...message, 0x00];
}

/** A minimal VOC: the header, one 8-bit block at 11025 Hz, and a terminator. */
function voc(sampleCount: number): Uint8Array {
  const header = new Uint8Array(0x1a);
  header.set([...'Creative Voice File'].map((c) => c.charCodeAt(0)));
  header[0x14] = 0x1a;
  const blockSize = sampleCount + 2;
  const block = new Uint8Array(4 + blockSize + 1);
  block[0] = 1;
  block[1] = blockSize & 0xff;
  block[2] = (blockSize >> 8) & 0xff;
  block[3] = (blockSize >> 16) & 0xff;
  block[4] = 256 - Math.round(1000000 / 11025); // divisor for 11025 Hz
  block[5] = 0;
  block.fill(128, 6, 6 + sampleCount);
  return new Uint8Array([...header, ...block]);
}

async function boot(script: number[], files: Record<string, Uint8Array> = {}) {
  const fixture = buildV7Fixture({ script2: script });
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

const LINE = [...'Hi there.'].map((character) => character.charCodeAt(0));

describe('a v7 line that names its own recording', () => {
  it('shows the words without the speech payload mixed into them', async () => {
    // The payload's own bytes include `0xff` markers and, for these numbers, a
    // printable 'W'. Filtering on 0x20 keeps exactly those, which is how the
    // demo's first line came out as `ÿÿÿWÿI can't use these things together.`
    const { engine } = await boot(talkScript([...speechCode(1, 1111), ...LINE]));
    expect(engine.currentText()).toBe('Hi there.');
  });

  it('leaves an ordinary line alone', async () => {
    const { engine } = await boot(talkScript(LINE));
    expect(engine.currentText()).toBe('Hi there.');
  });
});

describe('speech held one file per line, as The Dig’s demo keeps it', () => {
  const files = {
    'audio/logo.1/1111.voc': voc(4410),
    'audio/wreck_19/2222.voc': voc(2205),
  };

  it('indexes the folders by their numbers, not by a table of room names', async () => {
    // ScummVM hard-codes eight room names to build the path. The folders are in
    // the game's own files, so the numbers are read off them instead — which
    // also covers the copies that spell the separator with an underscore.
    const { logs } = await boot(talkScript(LINE), files);
    expect(logs).toContain('Indexed 2 recorded lines held one file per line');
  });

  it('reads nothing when there are no such folders', async () => {
    const { logs } = await boot(talkScript(LINE));
    expect(logs.some((line) => line.includes('one file per line'))).toBe(false);
  });

  it('follows a spoken line from its two numbers to its file', async () => {
    // The whole chain in one: the script's message carries room 1 and line
    // 1111, `showText` reads them as a room and a line rather than as an offset
    // into a speech file, and the folder scan turns them into `logo.1/1111`.
    const { engine } = await boot(talkScript([...speechCode(1, 1111), ...LINE]), files);
    expect(engine.sound.hasVoiceFiles()).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const sample = engine.sound.startVoiceFile(1, 1111);
    expect(sample).not.toBeNull();
    expect(sample!.pcm.samples.length).toBe(4410);
    expect(sample!.duration).toBeCloseTo(4410 / 11025, 2);
  });

  it('times the first play by its text and the second by its audio', async () => {
    // The read is asynchronous and a script asks for a line from inside an
    // instruction, so the first ask starts the read and reports nothing. That
    // is the same seam the lazily-opened bundles have (#114), and text-length
    // timing is what a copy with no recordings would give — right for a line
    // without audio rather than wrong for one with it. Asked of a line this
    // script never spoke, because a spoken one has already been fetched.
    const { engine } = await boot(talkScript(LINE), files);
    expect(engine.sound.startVoiceFile(1, 1111)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.sound.startVoiceFile(1, 1111)!.pcm.samples.length).toBe(4410);
  });

  it('finds a line in a folder spelt with an underscore', async () => {
    const { engine } = await boot(talkScript(LINE), files);
    expect(engine.sound.startVoiceFile(19, 2222)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.sound.startVoiceFile(19, 2222)!.pcm.samples.length).toBe(2205);
  });

  it('reports nothing for a room and line it has no file for', async () => {
    const { engine } = await boot(talkScript(LINE), files);
    expect(engine.sound.startVoiceFile(3, 5)).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.sound.startVoiceFile(3, 5)).toBeNull();
  });

  it('carries no mouth-sync cues, because a bare VOC has none', async () => {
    // `MONSTER.SOU` keeps them in the `VCTL` header. There is no such header
    // here, and a fabricated list would animate a mouth against nothing.
    const { engine } = await boot(talkScript(LINE), files);
    engine.sound.startVoiceFile(1, 1111);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.sound.startVoiceFile(1, 1111)!.syncTimes).toEqual([]);
  });
});
