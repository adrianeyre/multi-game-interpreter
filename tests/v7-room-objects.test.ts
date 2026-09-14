import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScriptEngineV7 } from '../src/engine/script/v7/ScriptEngine.js';
import { OF_OWNER_ROOM, OF_OWNER_ROOM_V7, VAR } from '../src/engine/constants.js';
import { V7_FLOATING_OBJECT, V7_FLOATING_ROOM, buildV7Fixture } from './fixtureV7.js';
import { buildV6Fixture } from './fixtureV6.js';

/**
 * Whether a v7 room's objects are in it at all.
 *
 * v5 and v6 pack an owner and a state into one `DOBJ` byte; v7 keeps three
 * columns — a state per object, a room per object, then a class — and no owner
 * column whatsoever, so the original fills the owner table with `0xFF` and
 * never reads it for a room object. The gate here asked only whether the owner
 * was `OF_OWNER_ROOM` (15), which no v7 object can ever be: nothing in any v7
 * room was drawn, nothing could be clicked, and both games were unfinishable
 * for want of one comparison.
 */
const OBJECT = 500;

/** The object's size in the fixture, and so how many pixels it covers. */
const OBJECT_PIXELS = 16 * 16;

async function bootV7(options: Parameters<typeof buildV7Fixture>[0] = {}) {
  const fixture = buildV7Fixture(options);
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.startScene(1, null, 0);
  engine.variables[VAR.EGO] = 1;
  return { engine, logs };
}

/** The screen as it stands, for counting what a later render changed. */
function snapshot(engine: ScummEngine): Uint8Array {
  engine.render();
  return Uint8Array.from(engine.screen.pixels);
}

/** How many pixels the screen now differs from a snapshot in. */
function changedSince(engine: ScummEngine, before: Uint8Array): number {
  engine.render();
  let changed = 0;
  for (let i = 0; i < before.length; i++) {
    if (engine.screen.pixels[i] !== before[i]) changed++;
  }
  return changed;
}

describe('a v7 room object with no owner', () => {
  it('leaves 0xFF in the owner table, which means the room has it', async () => {
    const { engine } = await bootV7();

    expect(engine.getOwner(OBJECT)).toBe(OF_OWNER_ROOM_V7);
    expect(engine.isObjectInRoom(OBJECT)).toBe(true);
  });

  it('draws it into the room background', async () => {
    const { engine } = await bootV7();

    // Against the same room with the object's state cleared, which is the one
    // other reason it would not be drawn.
    const drawn = snapshot(engine);
    engine.putState(OBJECT, 0);
    expect(changedSince(engine, drawn)).toBe(OBJECT_PIXELS);
  });

  it('reports it as drawn and lets the player click it', async () => {
    const { engine } = await bootV7();

    expect(engine.describeObjectState()).toContain('drawn');
    expect(engine.describeObjectState()).not.toContain('not in the room');
    expect(engine.findObjectAt(40, 16)).toBe(OBJECT);
  });

  it('still takes it out of the room when an actor picks it up', async () => {
    const { engine } = await bootV7();
    const drawn = snapshot(engine);

    engine.pickupObject(OBJECT, 1);

    expect(engine.isObjectInRoom(OBJECT)).toBe(false);
    expect(engine.inventory).toContain(OBJECT);
    expect(engine.findObjectAt(40, 16)).toBe(0);
    expect(changedSince(engine, drawn)).toBe(OBJECT_PIXELS);
  });

  it('still counts the room itself as the owner when a script puts it back', async () => {
    const { engine } = await bootV7();

    engine.pickupObject(OBJECT, 1);
    engine.setOwnerOf(OBJECT, OF_OWNER_ROOM);

    expect(engine.isObjectInRoom(OBJECT)).toBe(true);
    expect(engine.inventory).not.toContain(OBJECT);
  });

  it('does not read 0xFF as the room on a version that has an owner column', async () => {
    // v6 packs the owner into four bits, so 0xFF cannot come out of its index —
    // but the two values must not be conflated for versions that read an owner,
    // or an object held by actor 15 would read as scenery.
    const fixture = buildV6Fixture();
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.startScene(1, null, 0);

    engine.setOwnerOf(OBJECT, OF_OWNER_ROOM_V7);

    expect(engine.isObjectInRoom(OBJECT)).toBe(false);
  });
});

/**
 * Floating objects: ones a script moves into this room from another.
 *
 * Both v7 games use them — an object described by one room appearing in a
 * different one — and the engine had a warning where the implementation should
 * have been, so the object simply was not there. What makes them awkward is
 * that an object's image and code are *offsets into its own room's buffer*, so
 * the entry has to carry that buffer along, and its `parent` is a one-based
 * index into that room's object list, so it means something else here.
 */
describe('loading a floating object', () => {
  it('adds it to the room it was loaded into', async () => {
    const { engine, logs } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);

    const object = engine.currentRoomData?.findObject(V7_FLOATING_OBJECT);
    expect(object).toBeDefined();
    expect(object?.name).toBe('floating crate');
    expect(logs.join(' ')).not.toContain('floating object');
  });

  it('runs its verb code out of the room it came from', async () => {
    const { engine } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    // Read against this room's buffer instead, the same offset lands on
    // unrelated bytes and decodes as some other instruction entirely.
    (engine.scripts as ScriptEngineV7).runObjectScript(V7_FLOATING_OBJECT, 1, false, false, []);

    expect(engine.variables[261]).toBe(77);
  });

  it('draws it, having arrived after the room was built', async () => {
    const { engine } = await bootV7({ secondRoom: true });
    const before = snapshot(engine);

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);

    expect(changedSince(engine, before)).toBe(OBJECT_PIXELS);
  });

  it('drops the parent it had back home, which indexes that room and not this', async () => {
    const { engine } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);

    const object = engine.currentRoomData?.findObject(V7_FLOATING_OBJECT);
    expect(object?.parent).toBe(0);
    expect(object?.parentState).toBe(0);
    expect(engine.findObjectAt(70, 20)).toBe(V7_FLOATING_OBJECT);

    // The parent it holds back home, put back: index 1 names this room's first
    // object, 500, which is not in the state the floating object belongs to, so
    // the hit test passes over it — an object nobody can click.
    object!.parent = 1;
    object!.parentState = 2;
    expect(engine.findObjectAt(70, 20)).toBe(0);
  });

  it('leaves the room it borrowed from alone', async () => {
    const { engine } = await bootV7({ secondRoom: true });

    // A verb added to the copy here must not follow the object home: the room
    // it came from is parsed once and kept, so a shared verb map would hand the
    // next caller an object carrying whatever the last one did to it.
    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    engine.currentRoomData?.findObject(V7_FLOATING_OBJECT)?.verbs.set(99, 0);
    engine.nukeFloatingObjects(0, 600);

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    const reloaded = engine.currentRoomData?.findObject(V7_FLOATING_OBJECT);
    expect(reloaded?.verbs.has(99)).toBe(false);
    expect(reloaded?.verbs.has(1)).toBe(true);
  });

  it('does nothing the second time it is asked for the same object', async () => {
    const { engine } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);

    const matching = engine.currentRoomData?.objects.filter(
      (object) => object.id === V7_FLOATING_OBJECT,
    );
    expect(matching?.length).toBe(1);
  });

  it('says so once when the room does not have the object', async () => {
    const { engine, logs } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(999, V7_FLOATING_ROOM);
    engine.loadFloatingObject(999, V7_FLOATING_ROOM);

    const complaints = logs.filter((line) => line.includes('floating object 999'));
    expect(complaints.length).toBe(1);
  });

  it('removes only floating objects when a script nukes a range', async () => {
    const { engine } = await bootV7({ secondRoom: true });
    const roomOnly = snapshot(engine);

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    engine.nukeFloatingObjects(0, 600);

    // The room's own object is described by the room's resource and is not the
    // script's to remove; nuking a range over it would empty the room.
    expect(engine.currentRoomData?.findObject(OBJECT)).toBeDefined();
    expect(engine.currentRoomData?.findObject(V7_FLOATING_OBJECT)).toBeUndefined();
    // And what the floating object drew is gone with it.
    expect(changedSince(engine, roomOnly)).toBe(0);
  });

  it('keeps a floating object outside the range it was told to nuke', async () => {
    const { engine } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    engine.nukeFloatingObjects(0, V7_FLOATING_OBJECT - 1);

    expect(engine.currentRoomData?.findObject(V7_FLOATING_OBJECT)).toBeDefined();
  });

  it('takes them with the room when the game moves on', async () => {
    const { engine } = await bootV7({ secondRoom: true });

    engine.loadFloatingObject(V7_FLOATING_OBJECT, V7_FLOATING_ROOM);
    engine.startScene(1, null, 0);

    expect(engine.currentRoomData?.findObject(V7_FLOATING_OBJECT)).toBeUndefined();
  });
});
