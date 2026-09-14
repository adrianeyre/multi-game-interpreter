import { describe, expect, it } from 'vitest';
import { SwordRouter, whatTarget, RouteResult } from '../src/engine/sword1/script/SwordRouter.js';
import {
  readSword2WalkData,
  Sword2RouteResult,
  Sword2Router,
} from '../src/engine/sword2/script/Sword2Router.js';
import { Sword2Resources } from '../src/engine/sword2/resource/Sword2Resources.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import {
  advanceSequence,
  findSequenceFile,
  findSequenceFiles,
  openFirstSequence,
  openSequence,
} from '../src/engine/sword1/video/SwordSequences.js';
import {
  sword1SequenceName,
  SWORD1_SEQUENCE_NAMES,
} from '../src/engine/sword1/video/sequenceNames.js';
import { buildSmacker } from './fixtureSmacker.js';
import { buildSword2Fixture, sword2Header, Writer } from './fixtureSword.js';
import { Sword2FileType } from '../src/engine/sword2/resource/sword2Headers.js';

/**
 * A walk grid with one bar and two nodes, built from the format.
 *
 * Eleven fields a bar: the two ends, the bounding box, the deltas, and `co` —
 * the line equation's constant. They are all *stored*, not derived, which is
 * what makes `lineCheck` a few multiplies rather than a solve.
 */
function walkGrid(
  bars: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  nodes: Array<{ x: number; y: number }>,
): Uint8Array {
  const body = new Writer().u32(bars.length).u32(nodes.length);
  for (const bar of bars) {
    const dx = bar.x2 - bar.x1;
    const dy = bar.y2 - bar.y1;
    body
      .u16(bar.x1)
      .u16(bar.y1)
      .u16(bar.x2)
      .u16(bar.y2)
      .u16(Math.min(bar.x1, bar.x2))
      .u16(Math.min(bar.y1, bar.y2))
      .u16(Math.max(bar.x1, bar.x2))
      .u16(Math.max(bar.y1, bar.y2))
      .u16(dx)
      .u16(dy)
      .i32(bar.y1 * dx - bar.x1 * dy);
  }
  for (const node of nodes) body.u16(node.x).u16(node.y);
  const payload = body.done();
  return new Writer()
    .raw(sword2Header(Sword2FileType.WALK_GRID_FILE, 'grid', payload.length))
    .raw(payload)
    .done();
}

/** An `ObjectWalkdata`: 916 bytes of flags, counts and step sizes. */
function walkData(
  options: { slowIn?: boolean; slowOut?: number; turns?: boolean } = {},
): Uint8Array {
  const frames = 12;
  const body = new Writer()
    .i32(frames)
    .i32(options.turns ? 1 : 0)
    .i32(options.turns ? 1 : 0)
    .i32(options.slowIn ? 1 : 0)
    .i32(options.slowOut ?? 0);
  for (let dir = 0; dir < 8; dir++) body.i32(options.slowIn ? 3 : 0);
  for (let dir = 0; dir < 8; dir++) body.i32(dir & 1);
  // Step sizes: a modest move per frame, different per direction so the
  // derived `modX`/`modY` are not all the same.
  for (let index = 0; index < 8 * 13; index++) body.i32(index % 13 < 6 ? 6 : 0);
  for (let index = 0; index < 8 * 13; index++) body.i32(index % 13 < 6 ? 2 : 0);
  return body.done();
}

describe('facing', () => {
  it('prefers straight over diagonal, which is what a Broken Sword walk looks like', () => {
    // A shallow slope reads as "right" rather than "down-right": the diagonal
    // band is deliberately narrow.
    expect(whatTarget(0, 0, 100, 5)).toBe(2);
    // The diagonal band is narrow: at dx 100 it runs from about dy 12 to dy 44,
    // and anything steeper reads as straight down.
    expect(whatTarget(0, 0, 100, 30)).toBe(3);
    expect(whatTarget(0, 0, 100, 60)).toBe(4);
    expect(whatTarget(0, 0, 5, 100)).toBe(4);
    expect(whatTarget(0, 0, -100, 5)).toBe(6);
    expect(whatTarget(0, 0, -100, -30)).toBe(7);
  });
});

describe('Broken Sword II’s router', () => {
  async function router(grids: Uint8Array[]): Promise<Sword2Router> {
    const fixture = buildSword2Fixture([
      {
        name: 'general.clu',
        resources: grids.map((bytes, index) => ({ id: index + 1, bytes })),
      },
    ]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, bytes] of fixture.clusters) entries.push([name, bytes]);
    const resources = await Sword2Resources.create(new MemoryDataSource('grid', entries));
    await resources.loadResident();
    return new Sword2Router(resources);
  }

  it('reads an ObjectWalkdata and refuses one that is not one', () => {
    const parsed = readSword2WalkData(walkData({ slowIn: true, slowOut: 4, turns: true }), 0);
    expect(parsed?.nWalkFrames).toBe(12);
    expect(parsed?.usingSlowInFrames).toBe(true);
    expect(parsed?.usingSlowOutFrames).toBe(4);
    expect(parsed?.nSlowInFrames[0]).toBe(3);
    expect(readSword2WalkData(new Uint8Array(10), 0)).toBeNull();
  });

  it('adds and removes walk grids, which is how a session changes its floor', async () => {
    const routing = await router([walkGrid([], [{ x: 100, y: 100 }])]);
    expect(routing.walkGridCount).toBe(0);
    routing.addWalkGrid(1);
    routing.addWalkGrid(1);
    expect(routing.walkGridCount).toBe(1);
    routing.removeWalkGrid(1);
    expect(routing.walkGridCount).toBe(0);
  });

  it('answers "already there" for a zero-length walk and still writes a turn', async () => {
    const routing = await router([walkGrid([], [{ x: 200, y: 200 }])]);
    routing.addWalkGrid(1);
    const walk = readSword2WalkData(walkData(), 0)!;
    const result = routing.routeFinder(
      { feetX: 100, feetY: 100, dir: 0, scaleA: 0, scaleB: 0x10000 },
      walk,
      100,
      100,
      4,
    );
    expect(result).toBe(Sword2RouteResult.ALREADY_THERE);
    // A stand frame, then the turn, then the end marker.
    expect(routing.walkLength).toBeGreaterThan(0);
    expect(routing.walkAnim[0].dir).toBe(0);
  });

  it('walks across an open floor and leaves the mega at the target', async () => {
    const routing = await router([walkGrid([], [{ x: 150, y: 150 }])]);
    routing.addWalkGrid(1);
    const walk = readSword2WalkData(walkData(), 0)!;
    const result = routing.routeFinder(
      { feetX: 100, feetY: 100, dir: 2, scaleA: 0, scaleB: 0x10000 },
      walk,
      260,
      140,
      2,
    );
    expect(result).toBe(Sword2RouteResult.FOUND);
    const nodes = routing.walkLength;
    expect(nodes).toBeGreaterThan(2);
    // Slidy slides onto the exact target, which is the whole point of it.
    // Slidy slides onto the exact target, which is the whole point of it. The
    // last node is the stand frame, so the walk's own end is the one before.
    const last = routing.walkAnim[nodes - 2];
    expect(Math.abs(last.x - 260)).toBeLessThanOrEqual(4);
  });

  it('refuses a target sitting on a bar rather than walking into it', async () => {
    const routing = await router([
      walkGrid([{ x1: 200, y1: 0, x2: 200, y2: 400 }], [{ x: 150, y: 150 }]),
    ]);
    routing.addWalkGrid(1);
    const walk = readSword2WalkData(walkData(), 0)!;
    const result = routing.routeFinder(
      { feetX: 100, feetY: 100, dir: 2, scaleA: 0, scaleB: 0x10000 },
      walk,
      200,
      100,
      2,
    );
    expect(result).toBe(Sword2RouteResult.FAILED);
    expect(routing.describe()).toMatch(/on a walk-grid bar/);
  });

  it('refuses a target with no line to it through the grid', async () => {
    // A wall right across the room, and no node on the far side to route via.
    const routing = await router([walkGrid([{ x1: 0, y1: 200, x2: 640, y2: 200 }], [])]);
    routing.addWalkGrid(1);
    const walk = readSword2WalkData(walkData(), 0)!;
    expect(
      routing.routeFinder(
        { feetX: 100, feetY: 100, dir: 4, scaleA: 0, scaleB: 0x10000 },
        walk,
        100,
        300,
        4,
      ),
    ).toBe(Sword2RouteResult.FAILED);
  });

  it('takes the solid animator for a walk with no end direction', async () => {
    const routing = await router([walkGrid([], [{ x: 150, y: 150 }])]);
    routing.addWalkGrid(1);
    const walk = readSword2WalkData(walkData({ slowOut: 4 }), 0)!;
    // Direction 8 is "any", which is what a plain click sends.
    const result = routing.routeFinder(
      { feetX: 100, feetY: 100, dir: 2, scaleA: 0, scaleB: 0x10000 },
      walk,
      280,
      110,
      8,
    );
    expect(result).toBe(Sword2RouteResult.FOUND);
    // Solid ends facing a real direction rather than 8.
    expect(routing.endDirection).toBeLessThan(8);
  });

  it('reports the grid it is working from, for a stalled walk', async () => {
    const routing = await router([walkGrid([{ x1: 0, y1: 0, x2: 10, y2: 10 }], [{ x: 5, y: 5 }])]);
    routing.addWalkGrid(1);
    const walk = readSword2WalkData(walkData(), 0)!;
    routing.routeFinder({ feetX: 1, feetY: 1, dir: 0, scaleA: 0, scaleB: 0x10000 }, walk, 9, 9, 0);
    expect(routing.describe()).toMatch(/1 walk grids, 1 bars/);
  });
});

describe('Broken Sword’s router still answers the same values', () => {
  it('names its results the way the scripts branch on them', () => {
    expect(RouteResult.FAILED).toBe(0);
    expect(RouteResult.FOUND).toBe(1);
    expect(RouteResult.ALREADY_THERE).toBe(2);
  });

  it('is constructible without a game, which is what makes it testable', () => {
    // The constructor takes its collaborators and reads nothing, so a router
    // exists before any resource does.
    expect(
      () =>
        new SwordRouter(
          { fetch: () => null } as never,
          { fetch: () => null, describeMissingResource: () => '' } as never,
        ),
    ).not.toThrow();
  });
});

describe('cutscenes', () => {
  it('prefers a film inside a video folder over one in the root', () => {
    const names = ['intro.smk', 'smackshi/intro.smk', 'video/other.smk'];
    expect(findSequenceFile(names, 'intro')).toBe('smackshi/intro.smk');
    expect(findSequenceFile(names, 'other')).toBe('video/other.smk');
    expect(findSequenceFile(names, 'missing')).toBeNull();
  });

  it('matches case-insensitively, because releases disagree about it', () => {
    expect(findSequenceFile(['SMACKSHI/INTRO.SMK'], 'intro')).toBe('SMACKSHI/INTRO.SMK');
  });

  it('refuses bytes that are not a Smacker rather than drawing noise', () => {
    expect(openSequence('intro', new Uint8Array(64))).toBeNull();
  });

  it('offers a wrong extension after the right one, never instead of it', () => {
    // The Broken Sword II demo folder, which holds `demo.smdk` — the same
    // 289,700 bytes its own `files.txt` calls `demo.smk`. `game.exe` knows one
    // filename, `%s.smk`, so that stays first and the odd one is a fallback.
    const names = ['Docks.clu', 'Enddemo.smk', 'demo.smdk', 'files.txt'];
    expect(findSequenceFiles(names, 'demo')).toEqual(['demo.smdk']);
    expect(findSequenceFiles(names, 'enddemo')).toEqual(['Enddemo.smk']);
    expect(findSequenceFiles(['intro.smk', 'intro.smdk'], 'intro')).toEqual([
      'intro.smk',
      'intro.smdk',
    ]);
    expect(findSequenceFiles(names, 'eye')).toEqual([]);
  });

  it('lets the bytes decide between candidates, not the extension', async () => {
    const smacker = buildSmacker({
      width: 8,
      height: 8,
      frameRateMs: 16,
      frames: Array.from({ length: 3 }, () => ({
        blocks: [
          { kind: 'fill' as const, colour: 1 },
          { kind: 'skip' as const },
          { kind: 'skip' as const },
          { kind: 'skip' as const },
        ],
      })),
    });
    const read = async (file: string): Promise<Uint8Array | null> =>
      file === 'demo.smdk' ? smacker : new Uint8Array(64);
    const opened = await openFirstSequence(['demo.txt', 'demo.smdk'], 'demo', read);
    expect(opened?.file).toBe('demo.smdk');
    expect(opened?.sequence.smacker.info.frameCount).toBe(3);

    // Nothing readable: the caller gets null and says so, rather than stalling.
    expect(
      await openFirstSequence(['demo.txt'], 'demo', async () => new Uint8Array(64)),
    ).toBeNull();
  });

  it('names Broken Sword’s sequences, which its scripts carry as numbers', () => {
    expect(SWORD1_SEQUENCE_NAMES.length).toBeGreaterThan(10);
    expect(SWORD1_SEQUENCE_NAMES).toContain('intro');
    expect(sword1SequenceName(9999)).toBeNull();
  });

  it('centres a film in the framebuffer rather than stretching it', () => {
    // A stub sequence: one frame, smaller than the screen.
    const pixels = new Uint8Array(4 * 2).fill(7);
    const sequence = {
      name: 'stub',
      frame: 0,
      smacker: {
        info: { width: 4, height: 2, displayHeight: 2, frameCount: 1 },
        nextFrame: () => ({
          pixels,
          palette: new Uint8Array(768),
          paletteChanged: true,
          audio: [],
        }),
      },
    } as never;

    const out = new Uint8Array(8 * 4);
    const frame = advanceSequence(sequence, out, 8, 4);
    expect(frame).not.toBeNull();
    // Left inset by two, top by one: the film sits in the middle.
    expect(out[1 * 8 + 2]).toBe(7);
    expect(out[0]).toBe(0);
  });

  it('answers null once the frames run out, which is how the engine ends one', () => {
    const sequence = {
      name: 'stub',
      frame: 1,
      smacker: {
        info: { width: 1, height: 1, displayHeight: 1, frameCount: 1 },
        nextFrame: () => null,
      },
    } as never;
    expect(advanceSequence(sequence, new Uint8Array(4), 2, 2)).toBeNull();
  });
});
