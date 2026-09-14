import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import {
  LoadProgressTracker,
  formatBytes,
  plural,
  type LoadProgress,
} from '../src/engine/resource/progress.js';
import { decryptCopy, decryptRange } from '../src/engine/resource/xor.js';
import { XOR_KEY, buildFixture } from './fixture.js';

function fixtureSource() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return source;
}

describe('load progress tracker', () => {
  it('maps stages onto an increasing fraction', () => {
    const seen: LoadProgress[] = [];
    const tracker = new LoadProgressTracker((update) => seen.push(update));

    tracker.report('detecting', 'detecting');
    tracker.report('reading-data', 'half read', 0.5);
    tracker.report('reading-data', 'read', 1);
    tracker.finish('done');

    expect(seen.map((update) => update.message)).toEqual([
      'detecting',
      'half read',
      'read',
      'done',
    ]);
    const fractions = seen.map((update) => update.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions[0]).toBeGreaterThan(0);
    expect(fractions.at(-1)).toBe(1);
  });

  it('never goes backwards when a stage reports out of order', () => {
    const seen: number[] = [];
    const tracker = new LoadProgressTracker((update) => seen.push(update.fraction));

    tracker.report('parsing-container', 'late stage');
    tracker.report('detecting', 'early stage');

    expect(seen[1]).toBe(seen[0]);
  });

  it('clamps a stage fraction to its own span', () => {
    const seen: number[] = [];
    const tracker = new LoadProgressTracker((update) => seen.push(update.fraction));

    tracker.report('reading-data', 'nonsense', 5);
    tracker.report('parsing-container', 'later');

    expect(seen[0]).toBeLessThan(1);
    expect(seen[1]).toBeGreaterThan(seen[0]);
  });

  it('reports nothing and never yields without a listener', async () => {
    const tracker = new LoadProgressTracker();
    expect(tracker.enabled).toBe(false);
    tracker.report('detecting', 'ignored');
    tracker.finish('ignored');
    // Resolves without a timer or animation frame, so tests stay synchronous.
    await tracker.yieldToUi();
  });

  it('waits for a task after the frame, so the change is painted before work resumes', async () => {
    // A requestAnimationFrame callback runs *before* the browser paints the
    // frame, and the microtasks it queues run before the paint too. A yield
    // that resolves in either hands the thread straight back to seconds of
    // blocking work with the change it just made still invisible — which is
    // the one failure this yield exists to prevent. Only a task queued from
    // inside the frame runs after the pixels are on screen.
    const realRaf = globalThis.requestAnimationFrame;
    let framed = false;
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      framed = true;
      callback(0);
      return 1;
    }) as typeof globalThis.requestAnimationFrame;

    try {
      const tracker = new LoadProgressTracker(() => {});
      let resumed = false;
      const yielding = tracker.yieldToUi().then(() => {
        resumed = true;
      });

      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
      expect(framed).toBe(true);
      expect(resumed).toBe(false);

      await yielding;
      expect(resumed).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = realRaf;
    }
  });

  it('agrees in number when naming what it found', () => {
    expect(plural(1, 'room')).toBe('1 room');
    expect(plural(0, 'room')).toBe('0 rooms');
    expect(plural(12, 'script')).toBe('12 scripts');
  });

  it('formats byte counts for humans', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('chunked decryption', () => {
  it('matches a whole-file decrypt', () => {
    const data = new Uint8Array(2000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 0xff;

    const out = new Uint8Array(data.length);
    for (let at = 0; at < data.length; at += 512) {
      decryptRange(out, data, XOR_KEY, at, at + 512);
    }

    expect([...out]).toEqual([...decryptCopy(data, XOR_KEY)]);
  });

  it('leaves an unencrypted file byte-identical', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const out = new Uint8Array(data.length);
    decryptRange(out, data, 0, 0, data.length);
    expect([...out]).toEqual([...data]);
  });
});

describe('progress through a real load', () => {
  it('names each step and finishes at a full bar', async () => {
    const source = fixtureSource();
    const seen: LoadProgress[] = [];
    const tracker = new LoadProgressTracker((update) => seen.push(update));

    const engine = await ScummEngine.create(source, { progress: tracker });
    tracker.report('booting', 'Running the boot script…', 0.2);
    engine.boot(0);
    tracker.finish('Ready');

    const stages = [...new Set(seen.map((update) => update.stage))];
    expect(stages).toEqual([
      'detecting',
      'reading-index',
      'parsing-index',
      'reading-data',
      'decrypting',
      'parsing-container',
      'preparing',
      'booting',
      'ready',
    ]);

    const fractions = seen.map((update) => update.fraction);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
    expect(fractions.at(-1)).toBe(1);
    expect(seen.every((update) => update.message.length > 0)).toBe(true);
  });

  it('loads identically with and without progress reporting', async () => {
    const quiet = await ResourceManager.load(fixtureSource(), await detectGame(fixtureSource()));

    const source = fixtureSource();
    const loud = await ResourceManager.load(
      source,
      await detectGame(source),
      new LoadProgressTracker(() => undefined),
    );

    expect([...loud.data]).toEqual([...quiet.data]);
    expect(loud.roomCount).toBe(quiet.roomCount);
    expect(loud.describeDirectories()).toBe(quiet.describeDirectories());
  });

  it('summarises what the index contained', async () => {
    const source = fixtureSource();
    const manager = await ResourceManager.load(source, await detectGame(source));
    expect(manager.describeDirectories()).toMatch(/^Indexed \d+ objects(, \d+ \w+s)+$/);
    expect(manager.roomCount).toBe(1);
  });
});

describe('data source byte progress', () => {
  it('reports the whole file at once for an in-memory source', async () => {
    const source = new MemoryDataSource('memory');
    source.set('A.000', new Uint8Array(64));

    const seen: Array<[number, number | undefined]> = [];
    await source.read('A.000', (loaded, total) => seen.push([loaded, total]));

    expect(seen).toEqual([[64, 64]]);
  });

  it('reports nothing for a file that is not there', async () => {
    const source = new MemoryDataSource('memory');
    const seen: number[] = [];
    expect(await source.read('missing.000', (loaded) => seen.push(loaded))).toBeNull();
    expect(seen).toEqual([]);
  });
});
