import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { buildFixture } from './fixture.js';

/**
 * Whether placing an actor makes it drawable.
 *
 * Position and visibility are one operation in the original: an actor is on
 * screen because something put it there. Splitting them left `putActor` able to
 * position an actor in the room the player is looking at and leave it undrawn —
 * a room that renders correctly with nobody in it, no error anywhere.
 */
async function roomWithActor(): Promise<ScummEngine> {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source, { random: () => 0.5 });
  engine.boot(0);
  engine.startScene(1, null, 0);
  return engine;
}

describe('placing an actor', () => {
  it('shows one that already belongs to the current room', async () => {
    const engine = await roomWithActor();
    const actor = engine.actors[1];
    // The room was assigned before the room was entered, which is what a script
    // does when it sets up a scene and then loads it.
    actor.costume = 1;
    actor.room = 1;
    expect(actor.visible).toBe(false);

    engine.putActor(1, 160, 120);

    expect(actor.visible).toBe(true);
  });

  it('starts it from its init frame rather than mid-stride', async () => {
    const engine = await roomWithActor();
    const actor = engine.actors[1];
    actor.costume = 1;
    actor.room = 1;

    engine.putActor(1, 160, 120);

    expect(actor.cost.stopped).toBe(0);
  });

  it('leaves one belonging to another room hidden', async () => {
    const engine = await roomWithActor();
    const actor = engine.actors[1];
    actor.costume = 1;
    actor.room = 2;

    engine.putActor(1, 160, 120);

    expect(actor.visible).toBe(false);
  });

  it('hides one that no longer belongs to the room it is shown in', async () => {
    const engine = await roomWithActor();
    const actor = engine.actors[1];
    actor.costume = 1;
    engine.putActorInRoom(1, 1);
    expect(actor.visible).toBe(true);

    actor.room = 2;
    engine.putActor(1, 160, 120);

    expect(actor.visible).toBe(false);
  });

  it('still positions the actor', async () => {
    const engine = await roomWithActor();
    const actor = engine.actors[1];
    actor.costume = 1;
    actor.room = 1;

    engine.putActor(1, 120, 120);

    // Snapped onto a walk box, so the y may move; the x is inside box 1.
    expect(actor.x).toBe(120);
    expect(actor.visible).toBe(true);
  });
});
