import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { OBJECT_CLASS, OF_OWNER_ROOM } from '../src/engine/constants.js';
import type { RoomObject } from '../src/engine/room/Room.js';
import { buildFixture } from './fixture.js';

/**
 * Which object the cursor is over.
 *
 * Everything the player can do to a room goes through this: the name that
 * appears on hover, the verb line, and the click that runs an object's script.
 * Atlantis's opening room has fifteen objects and all of them start in state 0,
 * having no artwork of their own — so gating touchability on an object's own
 * state left the room with no names on hover and no way to click the statue
 * that opens the hatch.
 */
const OBJECT = 500;

async function inRoom(messages: string[] = []) {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source, { onLog: (m) => messages.push(m) });
  engine.startScene(1, null, 0);
  return engine;
}

/** The fixture's object, as parsed, so a test can give it a parent. */
function roomObject(engine: ScummEngine, id: number): RoomObject {
  const object = engine.currentRoomData?.findObject(id);
  if (!object) throw new Error(`object ${id} is not in the room`);
  return object;
}

describe('finding the object under the cursor', () => {
  it('finds an object that has no artwork and so sits in state 0', async () => {
    const engine = await inRoom();
    engine.putState(OBJECT, 0);

    // State says which picture to draw, not whether the object can be
    // touched. A hotspot drawn as part of the background is state 0 for the
    // whole game and is still the thing the player clicks.
    expect(engine.findObjectAt(36, 68)).toBe(OBJECT);
    expect(engine.getVerbEntrypoint(OBJECT, 1)).toBeGreaterThan(0);
  });

  it('ignores an object marked untouchable', async () => {
    const engine = await inRoom();
    engine.putClass(OBJECT, OBJECT_CLASS.Untouchable, true);

    expect(engine.findObjectAt(36, 68)).toBe(0);
  });

  it('ignores an object an actor is carrying', async () => {
    const engine = await inRoom();
    engine.setOwnerOf(OBJECT, 3);

    expect(engine.findObjectAt(36, 68)).toBe(0);

    engine.setOwnerOf(OBJECT, OF_OWNER_ROOM);
    expect(engine.findObjectAt(36, 68)).toBe(OBJECT);
  });

  it('misses a point outside the object', async () => {
    const engine = await inRoom();
    expect(engine.findObjectAt(300, 10)).toBe(0);
  });

  describe('with a parent object', () => {
    /**
     * Gives the fixture's object a parent, the way a handle belongs to a door.
     * `parent` is a one-based index into the room's object list.
     */
    function withParent(engine: ScummEngine, parentState: number) {
      const room = engine.currentRoomData!;
      const child = roomObject(engine, OBJECT);
      // Sized to nothing so the parent can never be the hit itself; only its
      // state matters here.
      const parent: RoomObject = {
        ...child,
        id: 501,
        parent: 0,
        parentState: 0,
        width: 0,
        height: 0,
      };
      room.objects.push(parent);

      child.parent = room.objects.length; // one-based index of the parent
      child.parentState = parentState;
      return parent;
    }

    it('finds the child while the parent is in the expected state', async () => {
      const engine = await inRoom();
      const parent = withParent(engine, 1);
      engine.putState(parent.id, 1);

      expect(engine.findObjectAt(36, 68)).toBe(OBJECT);
    });

    it('does not find the child once the parent leaves that state', async () => {
      const engine = await inRoom();
      const parent = withParent(engine, 1);
      engine.putState(parent.id, 2);

      expect(engine.findObjectAt(36, 68)).toBe(0);
    });

    it('reports a parent chain that loops rather than hanging the frame', async () => {
      const engine = await inRoom();
      const room = engine.currentRoomData!;
      const child = roomObject(engine, OBJECT);

      // Each object names the other as its parent, both states satisfied.
      const parent: RoomObject = { ...child, id: 501, parentState: 0, width: 0, height: 0 };
      room.objects.push(parent);
      const childIndex = room.objects.indexOf(child) + 1;
      child.parent = room.objects.length;
      child.parentState = 0;
      parent.parent = childIndex;
      engine.putState(parent.id, 0);
      engine.putState(OBJECT, 0);

      // The point is that the sweep terminates at all; the report says why,
      // rather than a log line written on every hit test the cursor causes.
      expect(engine.findObjectAt(36, 68)).toBe(0);
      expect(engine.describeTouchability()).toMatch(/parent chain from object \d+ loops/);
    });
  });
});

describe('explaining why a room cannot be touched', () => {
  it('names the reason for each object the hit test passes over', async () => {
    // The whole point of the report: a room the player cannot touch anything
    // in looks exactly like a room with nothing in it, and the reason is what
    // tells the two apart.
    const engine = await inRoom();

    expect(engine.describeTouchability()).toMatch(/1 of 1 reachable/);
    expect(engine.describeTouchability()).toMatch(/object 500 \(brass lamp\).*reachable/);

    engine.setOwnerOf(OBJECT, 3);
    expect(engine.describeTouchability()).toMatch(/UNREACHABLE — owned by 3, so not in the room/);

    engine.setOwnerOf(OBJECT, OF_OWNER_ROOM);
    engine.putClass(OBJECT, OBJECT_CLASS.Untouchable, true);
    expect(engine.describeTouchability()).toMatch(/UNREACHABLE — the Untouchable class is set/);
  });

  it('does not call a state 0 object unreachable', async () => {
    // The fault this whole area exists for: state is about drawing, and a
    // hotspot with no artwork is state 0 for the whole game.
    const engine = await inRoom();
    engine.putState(OBJECT, 0);

    expect(engine.describeTouchability()).toMatch(/1 of 1 reachable/);
  });

  it('says when an object is too small to have a point inside it', async () => {
    const engine = await inRoom();
    const object = roomObject(engine, OBJECT);
    object.width = 0;

    expect(engine.describeTouchability()).toMatch(/UNREACHABLE — zero sized/);
    expect(engine.describeTouchability()).toMatch(/0 of 1 reachable/);
  });

  it('says nothing is loaded when no room is', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('fixture');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);

    expect(engine.describeTouchability()).toBe('no room loaded');
  });
});
