import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ANIMATE_COMMAND, ANIMATE_FRAME, VAR, packAnimateActor } from '../src/engine/constants.js';
import { MF_TURN } from '../src/engine/actor/Actor.js';
import { buildFixture } from './fixture.js';

/**
 * `animateActor`, whose argument is a frame unless it is one of three commands.
 *
 * The commands sit at the *top* of the range — the original derives them as
 * `0x3F - (argument >> 2) + 2`, four arguments each with a direction in the low
 * two bits — so the reserved block is the last twelve values and everything
 * below it is a frame passed as it is. Numbering the commands up from one put
 * the reserved block at 4 to 15, which are ordinary chores in a real game.
 */
const ACTOR = 1;

async function withActor() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('animate');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const engine = await ScummEngine.create(source);
  engine.startScene(1, null, 0);
  engine.variables[VAR.EGO] = ACTOR;

  const actor = engine.getActor(ACTOR)!;
  actor.costume = 1;
  engine.putActorInRoom(ACTOR, 1);
  // `putActor` shows an actor that is in the current room.
  engine.putActor(ACTOR, 100, 120);
  return { engine, actor };
}

describe('animating an actor', () => {
  it('plays the frame the argument names, as it is', async () => {
    const { engine, actor } = await withActor();

    engine.animateActor(ACTOR, 9);

    expect(actor.frame).toBe(9);
  });

  it('plays a low-numbered chore rather than reading it as a command', async () => {
    const { engine, actor } = await withActor();
    actor.standFrame = 3;

    // Day of the Tentacle animates Purple Tentacle's drink through chores 6 to
    // 9. Read as a command, 6 meant "stand" and the animation never played.
    engine.animateActor(ACTOR, 6);

    expect(actor.frame).toBe(6);
  });

  it('stands the actor up and stops them moving', async () => {
    const { engine, actor } = await withActor();
    actor.moving = MF_TURN;

    engine.animateActor(ACTOR, packAnimateActor(ANIMATE_COMMAND.Stand));

    expect(actor.frame).toBe(actor.standFrame);
    expect(actor.moving).toBe(0);
  });

  it('faces a direction at once', async () => {
    const { engine, actor } = await withActor();
    actor.facing = 90;

    // Old direction 0 is west.
    engine.animateActor(ACTOR, packAnimateActor(ANIMATE_COMMAND.SetDirection, 0));

    expect(actor.facing).toBe(270);
    expect(actor.moving & MF_TURN).toBe(0);
  });

  it('turns to a direction over time rather than snapping', async () => {
    const { engine, actor } = await withActor();
    actor.facing = 90;

    engine.animateActor(ACTOR, packAnimateActor(ANIMATE_COMMAND.TurnToDirection, 0));

    expect(actor.facing).toBe(90);
    expect(actor.moving & MF_TURN).not.toBe(0);
    expect(actor.targetFacing).toBe(270);
  });

  it('resolves a pseudo-frame against the actor own frames', async () => {
    const { engine, actor } = await withActor();
    actor.standFrame = 7;

    engine.animateActor(ACTOR, ANIMATE_FRAME.Stand);

    expect(actor.frame).toBe(7);
  });

  it('names the reserved commands at the top of the range', () => {
    expect(packAnimateActor(ANIMATE_COMMAND.Stand)).toBe(0xfc);
    expect(packAnimateActor(ANIMATE_COMMAND.SetDirection, 2)).toBe(0xfa);
    expect(packAnimateActor(ANIMATE_COMMAND.TurnToDirection, 3)).toBe(0xf7);
  });
});
