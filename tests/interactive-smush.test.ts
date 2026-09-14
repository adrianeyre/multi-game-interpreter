import { describe, expect, it } from 'vitest';
import { SmushPlayer } from '../src/engine/video/SmushPlayer.js';
import { InteractiveSequence, SequenceLayer } from '../src/engine/video/InteractiveSequence.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildV6Fixture } from './fixtureV6.js';

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

function san(frames: number) {
  return new Uint8Array(
    chunk('ANIM', [
      ...chunk('AHDR', [2, 0, ...u16(frames), 0, 0, ...new Array(0x300).fill(0), ...u16(10)]),
      ...new Array(frames).fill(0).flatMap((_, i) => chunk('FRME', fobj(i + 1))),
    ]),
  );
}

function sequence(frames = 4, held: number[] = []) {
  const player = new SmushPlayer();
  player.open(san(frames));
  return new InteractiveSequence(player, { isKeyHeld: (k) => held.includes(k) });
}

const screen = () => new Uint8Array(320 * 200);

/**
 * Interactive SMUSH — the sequences that are gameplay rather than cutscene.
 *
 * These cover the machinery: layered compositing, live held input, and a script
 * ending a sequence early. **They cannot cover the claim #103 actually makes**,
 * which is that a bike fight is *winnable* — that is Tier 2 on retail Full
 * Throttle and the reason the issue is `ready-for-human`.
 */
describe('driving a sequence and the video together', () => {
  it('reads back where the video has reached, so a script can branch on it', () => {
    const seq = sequence();
    seq.advance(0.25, screen());
    expect(seq.position).toBeCloseTo(0.25, 6);
    expect(seq.frameAt(seq.position)).toBe(2);
  });

  it('ends when the game says so, not only when the video runs out', () => {
    // A won fight. Kept distinct from the player's own end so that "the video
    // ran out" and "the game decided" stay tellable apart — a script expecting
    // the second and getting the first has a bug worth seeing.
    const seq = sequence(100);
    expect(seq.finished).toBe(false);
    seq.stop();
    expect(seq.finished).toBe(true);
  });

  it('draws nothing more once it has finished', () => {
    const seq = sequence();
    seq.stop();
    const target = screen();
    seq.advance(1, target);
    expect(target[0]).toBe(0);
  });
});

describe('compositing over the video', () => {
  it('draws the video first, then actors, then overlays', () => {
    // A wrong order does not look like an error, it looks like a missing
    // sprite — which is why the order is named rather than incidental.
    const drawn: string[] = [];
    const seq = sequence();
    seq.addLayer(SequenceLayer.Overlay, () => drawn.push('overlay'));
    seq.addLayer(SequenceLayer.Actors, () => drawn.push('actors'));

    const target = screen();
    seq.advance(0, target);

    expect(drawn).toEqual(['actors', 'overlay']);
    // The video is under both: frame 1 painted colour 1.
    expect(target[0]).toBe(1);
  });

  it('redraws overlays on a frame where the video did not advance', () => {
    // A health bar draining between video frames must still move, or it
    // appears to freeze with the picture.
    let draws = 0;
    const seq = sequence();
    seq.addLayer(SequenceLayer.Overlay, () => draws++);

    seq.advance(0, screen());
    seq.advance(0.01, screen());

    expect(draws).toBe(2);
  });

  it('keeps several layers at the same level, in the order they were added', () => {
    const drawn: string[] = [];
    const seq = sequence();
    seq.addLayer(SequenceLayer.Overlay, () => drawn.push('first'));
    seq.addLayer(SequenceLayer.Overlay, () => drawn.push('second'));

    seq.advance(0, screen());
    expect(drawn).toEqual(['first', 'second']);
  });
});

describe('live input during a sequence', () => {
  it('reports a key the player is holding', () => {
    const seq = sequence(4, [37]);
    expect(seq.isKeyHeld(37)).toBe(true);
    expect(seq.isKeyHeld(39)).toBe(false);
  });
});

describe('held keys, which the engine did not track before', () => {
  async function boot() {
    const fixture = buildV6Fixture();
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    return engine;
  }

  it('stays held across frames, where the last-press variable does not', async () => {
    // `VAR_KEYPRESS` answers "was this the last key hit", which is yes for one
    // frame and no thereafter — a control that fires once and then sticks.
    const engine = await boot();
    engine.pressKey(37);

    expect(engine.isKeyHeld(37)).toBe(true);
    engine.step();
    expect(engine.isKeyHeld(37)).toBe(true);
  });

  it('releases one key without clearing the others', async () => {
    // Releasing one direction while another is still down must not clear both.
    const engine = await boot();
    engine.pressKey(37);
    engine.pressKey(38);
    engine.releaseKey(37);

    expect(engine.isKeyHeld(37)).toBe(false);
    expect(engine.isKeyHeld(38)).toBe(true);
  });

  it('still clears everything when no key is named, as its callers expect', async () => {
    const engine = await boot();
    engine.pressKey(37);
    engine.releaseKey();
    expect(engine.isKeyHeld(37)).toBe(false);
  });
});
