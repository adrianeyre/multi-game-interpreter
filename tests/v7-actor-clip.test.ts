import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { V7_CLIP_FROM_BOX } from '../src/engine/actor/Actor.js';
import { buildV7Fixture } from './fixtureV7.js';

/**
 * How a v7 actor decides which z-plane hides it.
 *
 * v6 keeps two fields and reads a zero override as "no override, use the
 * walkbox". v7 keeps one, so it needs a number that cannot be a plane to say
 * the same thing, and the original picked 100: every v7 actor starts there and
 * the renderer swaps it for the box's own mask as it draws.
 *
 * Read as a plane number instead, 100 is past the end of every room's list, so
 * the actor is masked against nothing and walks in front of the scenery it
 * belongs behind. That is why the write side cannot be copied from ScummVM
 * without the read side: `IgnoreBoxes` writing 100 into an engine that takes
 * it literally is worse than the zero it replaced.
 */
const ACTOR = 1;

async function withRoom() {
  const fixture = buildV7Fixture({ roomHeight: 128 });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.startScene(1, null, 0);

  const actor = engine.getActor(ACTOR)!;
  actor.costume = 1;
  engine.putActorInRoom(ACTOR, 1);
  engine.putActor(ACTOR, 100, 100);
  return { engine, actor, logs };
}

/** How many screen pixels the actor contributes, drawn against itself hidden. */
function actorPixels(engine: ScummEngine, actor: { visible: boolean }): number {
  engine.render();
  const drawn = Uint8Array.from(engine.screen.pixels);

  const wasVisible = actor.visible;
  actor.visible = false;
  engine.render();
  actor.visible = wasVisible;

  let differing = 0;
  for (let i = 0; i < drawn.length; i++) {
    if (engine.screen.pixels[i] !== drawn[i]) differing++;
  }
  return differing;
}

/** Puts the actor's walkbox behind a z-plane that covers the whole room. */
function maskEverything(engine: ScummEngine): void {
  engine.boxes!.boxes[0].mask = 1;
  engine.roomGraphics!.zPlanes[0].fill(0xff);
}

describe("a v7 actor's clip plane", () => {
  it('starts out deferring to the walkbox rather than at plane zero', async () => {
    // Nothing has to ask for this. A script need never call `initActor`, and
    // an actor is drawn long before one does, so a default of zero would mean
    // every actor in both games ignored its room's masks until something
    // happened to set the field.
    const { actor } = await withRoom();

    expect(actor.forceClip).toBe(V7_CLIP_FROM_BOX);
  });

  it('keeps that default across a reset', async () => {
    const { engine, actor } = await withRoom();

    engine.initActor(actor, 0);

    expect(actor.forceClip).toBe(V7_CLIP_FROM_BOX);
  });

  it('is masked by its box plane while it defers to the box', async () => {
    const { engine, actor } = await withRoom();
    const unmasked = actorPixels(engine, actor);
    maskEverything(engine);

    // The regression this catches: reading the sentinel as a plane number
    // asks for plane 100, which no room has, so the actor draws over the mask
    // and this count does not change.
    expect(actorPixels(engine, actor)).toBeLessThan(unmasked);
  });

  it('honours plane zero when a script asks for it literally', async () => {
    const { engine, actor } = await withRoom();
    maskEverything(engine);

    // v6 reads zero as "no override" and would fall through to the box, which
    // is the mask this room has everywhere. v7 has no such reading: zero is
    // plane zero, and nothing masks against it.
    actor.forceClip = 0;

    expect(actorPixels(engine, actor)).toBeGreaterThan(0);
  });
});

describe("the Full Throttle demo's own AlwaysZClip number", () => {
  /** Runs a script in the fixture, so a sub-opcode goes through the dispatcher. */
  async function runScript(code: number[]) {
    const fixture = buildV7Fixture({ script2: code });
    const source = new MemoryDataSource('v7');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const logs: string[] = [];
    const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);
    return { engine, logs };
  }

  it('sets the clip plane, as the number it is an alias for does', async () => {
    // Select actor 1 with `Init` (197), then push 3 and ask for 225. ScummVM
    // carries this as a constant of its own handled by the same case, and the
    // demo's boot script is the only place it turns up — so a full copy of the
    // game never shows it missing.
    const { engine, logs } = await runScript([0x00, ACTOR, 0x9d, 197, 0x00, 3, 0x9d, 225]);

    expect(engine.getActor(ACTOR)!.forceClip).toBe(3);
    expect(logs.filter((line) => line.includes('actorOps sub-opcode 0xe1'))).toEqual([]);
  });

  it('has IgnoreBoxes hand the actor back to the box, not to plane zero', async () => {
    // v6 clears the override here so the box takes over again. v7 writes the
    // value that *means* the box, because clearing it to zero would pin the
    // actor to a real plane — and this sub-opcode fires whenever a script
    // takes an actor off the walk grid, which both games do constantly.
    const { engine } = await runScript([0x00, ACTOR, 0x9d, 197, 0x9d, 95]);

    const actor = engine.getActor(ACTOR)!;
    expect(actor.ignoreBoxes).toBe(true);
    expect(actor.forceClip).toBe(V7_CLIP_FROM_BOX);
  });

  it('leaves nothing of its own on the stack', async () => {
    // What an unhandled sub-opcode costs here is not a misread script but an
    // unclaimed stack value, which the next instruction to pop reads as its
    // own. Asking for plane 3 and then 4 catches it: if the first left its 3
    // behind, the second pops that instead.
    const { engine } = await runScript([
      0x00,
      ACTOR,
      0x9d,
      197,
      0x00,
      3,
      0x9d,
      225,
      0x00,
      4,
      0x9d,
      225,
    ]);

    expect(engine.getActor(ACTOR)!.forceClip).toBe(4);
  });
});
