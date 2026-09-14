import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { VAR } from '../src/engine/constants.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';
import { u16le } from './fixture.js';

/**
 * The things that stopped a real v6 game's opening from ever progressing.
 *
 * Each of these was found against Day of the Tentacle and none of them could
 * have been found against the fixture alone, because a fixture only asks
 * questions its author thought of. What the fixture *can* do is hold the
 * answers still, which is what this file is for: every case here is one
 * instruction or one engine rule whose reading was wrong, written as the
 * smallest script that tells the difference.
 *
 * They are grouped because they share a shape. A game's opening is a script
 * that arranges the world and then waits for the world to report back — an
 * actor to arrive, an animation to tick, a room to be on screen. Every fault
 * below broke one of those reports rather than the arranging, so the scripts
 * all behaved impeccably and the game sat there.
 */

const STOP = 0x66;

/** `pushByte n`. */
const byte = (value: number) => [0x00, value & 0xff];
/** `pushWord n`. */
const word = (value: number) => [0x01, ...u16le(value & 0xffff)];
/** `writeWordVar n`, popping the value to store. */
const store = (variable: number) => [0x43, ...u16le(variable)];

async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source, { random: () => 0.5 });
  return engine;
}

/** Runs `code` as global script 2 with the fixture's room loaded. */
async function runInRoom(code: number[], options: V6FixtureOptions = {}) {
  const engine = await bootV6({ ...options, script2: code });
  engine.boot(0);
  engine.startScene(1, null, 0);
  engine.scripts.runScript(2, false, false, []);
  return engine;
}

describe('beginOverride, which arms a skip point rather than taking it', () => {
  it('steps over the jump that follows it', async () => {
    // `beginOverride; jump past everything; <the scene>` is how a v6 game
    // makes a scene skippable. Running the jump plays nothing at all.
    const engine = await runInRoom([
      0x95, // beginOverride
      0x73,
      ...u16le(5), // jump past the write
      ...byte(7),
      ...store(250),
      STOP,
    ]);

    expect(engine.variables[250]).toBe(7);
    expect(engine.scriptState.currentOverride.pointer).toBeGreaterThanOrEqual(0);
  });

  it('arms the skip point with no cutscene open', async () => {
    const engine = await runInRoom([0x95, 0x73, ...u16le(0), STOP]);

    expect(engine.scriptState.cutSceneStack).toHaveLength(0);
    expect(engine.scriptState.currentOverride.pointer).toBeGreaterThanOrEqual(0);
  });
});

describe('putActorAtXY, whose room operand includes room 0', () => {
  it('parks an actor in room 0 rather than leaving it where it was', async () => {
    // The idiom for "this actor is finished with". A walk helper that borrows a
    // stand-in actor and parks it deadlocks every later caller if the parking
    // does not take.
    const engine = await runInRoom([
      ...byte(1),
      ...byte(40),
      ...byte(60),
      ...byte(1),
      0x7f, // putActorAtXY(1, 40, 60, room 1)
      ...byte(1),
      ...byte(0),
      ...byte(0),
      ...byte(0),
      0x7f, // putActorAtXY(1, 0, 0, room 0)
      STOP,
    ]);

    expect(engine.getActor(1)?.room).toBe(0);
  });

  it('still reads 0xFF as "leave the room alone"', async () => {
    const engine = await runInRoom([
      ...byte(1),
      ...byte(40),
      ...byte(60),
      ...byte(1),
      0x7f,
      ...byte(1),
      ...byte(50),
      ...byte(70),
      ...byte(0xff),
      0x7f,
      STOP,
    ]);

    const actor = engine.getActor(1)!;
    expect(actor.room).toBe(1);
    expect(actor.x).toBe(50);
  });
});

describe("actorOps's default form, which resets properties and not position", () => {
  it('leaves the actor in the room it is standing in', async () => {
    const engine = await runInRoom([
      ...byte(1),
      ...byte(40),
      ...byte(60),
      ...byte(1),
      0x7f, // putActorAtXY(1, 40, 60, room 1)
      ...byte(1),
      0x9d,
      0xc5, // actorOps.setCurrentActor(1)
      0x9d,
      0x53, // actorOps.default()
      STOP,
    ]);

    const actor = engine.getActor(1)!;
    expect(actor.room).toBe(1);
    expect(actor.x).toBe(40);
    // The properties really did go back to their defaults.
    expect(actor.talkColor).toBe(15);
    expect(actor.width).toBe(24);
  });
});

describe('a room load, which shows the cast the room already holds', () => {
  it('shows an actor placed in the room before the room was entered', async () => {
    const engine = await bootV6();
    engine.boot(0);

    const actor = engine.getActor(1)!;
    actor.costume = 1;
    engine.putActorInRoom(1, 1);
    expect(actor.visible).toBe(false);

    engine.startScene(1, null, 0);

    expect(actor.visible).toBe(true);
  });
});

describe('actorFollowCamera, which is also how a script changes room', () => {
  it('enters the room the actor is standing in', async () => {
    const engine = await bootV6();
    engine.boot(0);

    const actor = engine.getActor(1)!;
    actor.costume = 1;
    engine.putActorInRoom(1, 1);
    expect(engine.currentRoom).toBe(0);

    engine.actorFollowCamera(1);

    expect(engine.currentRoom).toBe(1);
    expect(actor.visible).toBe(true);
  });

  it('leaves the room alone when the actor is already in it', async () => {
    const engine = await bootV6();
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.putActorInRoom(1, 1);

    engine.actorFollowCamera(1);

    expect(engine.currentRoom).toBe(1);
  });
});

describe('a walk, which takes its first step in the frame it is started', () => {
  it('has moved by the end of that frame', async () => {
    const engine = await bootV6();
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.variables[VAR.EGO] = 1;
    const actor = engine.getActor(1)!;
    actor.costume = 1;
    engine.putActorInRoom(1, 1);
    engine.putActor(1, 20, 40);

    const from = { x: actor.x, y: actor.y };
    engine.startWalkActor(1, 120, 40, -1);
    engine.step();

    // One frame, one step. A script that walks an actor, breaks for a frame and
    // reads the position back gets a position that has changed — which is what
    // a v6 game's own walk helper is built on.
    expect({ x: actor.x, y: actor.y }).not.toEqual(from);
  });
});

describe('the object classes the engine reads for itself', () => {
  it('passes the hit test over an object a script marks untouchable', async () => {
    // 0xA0 is class 32 with the "set it" bit, which is how a game says "this
    // is not a hotspot". Day of the Tentacle marks the object it uses as the
    // mouse cursor that way, and the cursor object sits at the room's top-left
    // corner: a hit test asking about the wrong class found it under a pointer
    // that had not moved yet, and every click acted on the cursor.
    const engine = await runInRoom([
      ...word(500),
      ...word(0x80 | 32),
      ...word(1),
      0x6e, // setClass 500, [class 32 set]
      ...byte(36),
      ...byte(12),
      0xa0, // findObject(36, 68)
      ...store(250),
      STOP,
    ]);

    expect(engine.variables[250]).toBe(0);
    // Without the class it is found, so the point really is inside it.
    expect(engine.findObjectAt(36, 12)).toBe(0);
    engine.putClass(500, 32, false);
    expect(engine.findObjectAt(36, 12)).toBe(500);
  });
});

describe("an object's header, whose last field is the direction to face it from", () => {
  it('reads the direction from the end of a v6 header, not a v5 one', async () => {
    const engine = await bootV6();
    engine.boot(0);
    engine.startScene(1, null, 0);

    // v6's four position fields are 16-bit where v5's are bytes, so the
    // direction sits two bytes further on. Read at v5's distance it landed on
    // an unused field, and every object faced whatever was there.
    expect(engine.currentRoomData?.findObject(500)?.actorDir).toBe(1);
  });
});

describe('wait.forActor, which waits for an actor to arrive', () => {
  it('does not wait for one that has left the room', async () => {
    // The actor is moving, but somewhere else, so it is never going to arrive.
    // Waiting on it holds the script for the rest of the session.
    const engine = await runInRoom([
      ...byte(1),
      0xa9,
      0xa8, // wait.forActor
      ...u16le(0xfff9), // resume seven bytes back, as a real script does
      ...byte(9),
      ...store(250),
      STOP,
    ]);

    const actor = engine.getActor(1)!;
    engine.putActorInRoom(1, 2);
    actor.moving = 1;

    engine.scripts.runScript(2, false, false, []);

    // Ran straight through rather than parking on the wait.
    expect(engine.variables[250]).toBe(9);
  });

  it('still waits for one that is in the room and moving', async () => {
    const engine = await runInRoom([
      ...byte(1),
      0xa9,
      0xa8,
      ...u16le(0xfff9),
      ...byte(9),
      ...store(250),
      STOP,
    ]);

    const actor = engine.getActor(1)!;
    engine.putActorInRoom(1, 1);
    actor.moving = 1;
    engine.variables[250] = 0;

    engine.scripts.runScript(2, false, false, []);

    expect(engine.variables[250]).toBe(0);
  });
});

describe('a slot only stores a program counter it owns', () => {
  it('leaves every live script parked inside its own code', async () => {
    // `pc` is shared decode state. A script that starts another, or is ended by
    // one, must not come back with the other's program counter — the symptom is
    // an unknown opcode at an offset with no relation to the script named.
    const engine = await bootV6({
      script2: [...byte(0), ...word(3), ...word(0), 0x5e, 0x6c, STOP],
      script3: [...byte(7), ...store(251), 0x6c, STOP],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.scripts.runScript(2, false, false, []);

    for (let frame = 0; frame < 10; frame++) engine.step();

    for (const slot of engine.scriptState.slots) {
      if (slot.status === 0) continue;
      expect(slot.offset).toBeGreaterThanOrEqual(slot.base);
    }
  });
});
