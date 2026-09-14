import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { OFF_SCREEN_POSITION } from '../src/engine/constants.js';
import { buildFixture } from './fixture.js';

/**
 * Whether the actor report's drawn / NOT DRAWN verdict can be trusted.
 *
 * It is the report somebody reaches for when the room is drawn and the
 * character is missing, so a wrong verdict is worse than no verdict: it sends
 * them into the renderer after a fault that is really a placement one. The
 * verdict used to check the actor's room, its visibility, its costume and its
 * vertical position, and never once whether it was anywhere on screen
 * sideways — so an actor parked at the position scripts use to hide one was
 * reported as drawn.
 */
async function roomWithActor(roomWidth = 320): Promise<ScummEngine> {
  const fixture = buildFixture({ roomWidth });
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source, { random: () => 0.5 });
  engine.boot(0);
  engine.startScene(1, null, 0);
  const actor = engine.actors[1];
  actor.costume = 1;
  actor.room = 1;
  engine.putActor(1, 160, 120);
  return engine;
}

/**
 * Puts an actor exactly where a report said one was.
 *
 * `putActor` snaps to the nearest walk box, so it cannot be used to reach the
 * state being reproduced. A script that ignores boxes can, and the state is
 * what the verdict has to describe however it was arrived at.
 */
function park(engine: ScummEngine, x: number, y: number): void {
  const actor = engine.actors[1];
  actor.x = x;
  actor.y = y;
}

describe('the actor report on an actor that is off screen sideways', () => {
  it('does not call one parked at the hiding position drawn', async () => {
    const engine = await roomWithActor();
    park(engine, OFF_SCREEN_POSITION, OFF_SCREEN_POSITION);

    const report = engine.describeActorState();

    expect(report).toMatch(/actor 1[^|]*NOT DRAWN/);
    expect(report).toMatch(/park an actor at to hide it/);
  });

  it('names a position outside the room as outside the room', async () => {
    const engine = await roomWithActor();
    park(engine, -40, 120);

    expect(engine.describeActorState()).toMatch(/x -40 is outside the 320 pixel wide room/);
  });

  it('separates being off camera from being outside the room', async () => {
    // A wide room the camera can only show part of: the actor is exactly where
    // it should be and the camera is elsewhere, which is not a fault at all.
    const engine = await roomWithActor(640);
    park(engine, 600, 120);
    engine.camera.current = 160;

    const report = engine.describeActorState();

    expect(report).toMatch(/x 600 is off camera/);
    expect(report).not.toMatch(/outside the/);
  });

  it('still calls an actor in front of the camera drawn', async () => {
    const engine = await roomWithActor();

    const report = engine.describeActorState();

    expect(report).toMatch(/actor 1[^|]*drawn/);
    expect(report).not.toMatch(/NOT DRAWN/);
  });

  it('keeps reporting the vertical case it already handled', async () => {
    const engine = await roomWithActor();
    park(engine, 160, 190);

    expect(engine.describeActorState()).toMatch(/is below the \d+ row room view/);
  });
});
