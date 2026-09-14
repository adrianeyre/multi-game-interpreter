import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { Room } from '../src/engine/room/Room.js';
import { OF_OWNER_ROOM } from '../src/engine/constants.js';
import { importRoom } from '../src/authoring/importGame.js';
import { buildV6Fixture } from './fixtureV6.js';

/**
 * Loading a SCUMM v6 game's index and resources.
 *
 * Everything here runs against the synthetic v6 fixture, so it proves the
 * loader agrees with `fixtureV6.ts` — not that it agrees with Day of the
 * Tentacle. That distinction is the whole point of the tiers in
 * `docs/processes/verifying-version-support.md`, and it is why each assertion
 * below says which v6 format claim it depends on.
 */
async function loadV6(options: Parameters<typeof buildV6Fixture>[0] = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6-fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const game = await detectGame(source);
  const resources = await ResourceManager.load(source, game);
  // The version is not optional here: `CDHD` changed shape at v6 and the two
  // layouts are the same length, so a room parsed as v5 reads every object's
  // geometry wrongly and says nothing.
  const room = () => new Room(1, resources.getRoom(1)!, resources.game.version);
  return { game, resources, room };
}

describe('a synthetic v6 game', () => {
  it('is detected as v6, so the fixture is what it claims to be', async () => {
    const { game } = await loadV6();
    expect(game.version).toBe(6);
  });

  it('loads its index and addresses its resources', async () => {
    const { resources } = await loadV6();

    expect(resources.roomCount).toBe(1);
    // MAXS is the 38-byte v6 block: fifteen 16-bit fields, and these are three
    // of the ones v5's nine-field block does not carry at all.
    expect(resources.limits.numRooms).toBe(100);
    expect(resources.limits.numScripts).toBe(200);
    expect(resources.limits.numCostumes).toBe(30);
    expect(resources.limits.numGlobalObjects).toBe(600);
  });

  it('reads the room name out of RNAM', async () => {
    const { resources } = await loadV6();
    expect(resources.roomNames.get(1)).toBe('TENTACLE');
  });
});

describe('the v6 global object table', () => {
  /**
   * v6 stores DOBJ column-wise — every owner/state byte, then every 32-bit
   * class field — where v5 interleaves them as one four-byte record per
   * object. Read with the wrong layout this does not throw: it produces a
   * table of plausible owners, and the room then draws nothing and cannot be
   * clicked, which is indistinguishable from an engine bug.
   */
  it('reads owner and state from the packed byte column', async () => {
    const { resources } = await loadV6({ objectState: 2 });

    expect(resources.objectOwner[500]).toBe(OF_OWNER_ROOM);
    expect(resources.objectState[500]).toBe(2);
  });

  it('reads a full 32 bits of class data, which v5 has no room for', async () => {
    const { resources } = await loadV6();

    // Bit 23 is inside v5's 24-bit class field, so this alone would not catch a
    // v5-shaped read; it is the *position* of the bytes that differs.
    expect(resources.classData[500] & (1 << 23)).not.toBe(0);
    expect(resources.classData[499]).toBe(0);
  });
});

describe('AARY, the arrays the index declares', () => {
  it('records each declaration rather than dropping the block', async () => {
    const { resources } = await loadV6();

    expect(resources.arrayDeclarations).toEqual([
      { variable: 100, dim1: 10, dim2: 0, kind: 'int' },
      { variable: 101, dim1: 8, dim2: 0, kind: 'bit' },
    ]);
  });
});

describe('the v6 room palette', () => {
  /**
   * `PALS` > `WRAP` > `OFFS` + `APAL`, where each offset counts from the start
   * of the OFFS *data*. A wrong base lands mid-palette rather than on a header,
   * which reads back as a valid palette of the wrong colours — so these
   * assertions check the values, not just that something was found.
   */
  it('reads palette zero out of the PALS container', async () => {
    const { room } = await loadV6();
    const palette = room().palette;

    expect(palette).not.toBeNull();
    expect(palette).toHaveLength(768);
    // The fixture's palette is (i, 255 - i, i * 3).
    expect(Array.from(palette!.slice(0, 3))).toEqual([0, 255, 0]);
    expect(Array.from(palette!.slice(3, 6))).toEqual([1, 254, 3]);
  });

  /**
   * The offsets in `OFFS` count from the chunk's first byte, header included,
   * so an offset lands on an `APAL` header rather than on palette bytes. Both
   * this fixture and the reader used to be eight bytes out in the same
   * direction, which is why they agreed and why no real v6 room's palettes were
   * found. Asserting an *actual colour* rather than a length is what would have
   * caught it: a palette read from the wrong base is still 768 bytes long.
   */
  it('lands on the palette itself, not eight bytes into its header', async () => {
    const { room: load } = await loadV6();
    const room = load();

    // Colour 1 of the fixture's palette is (1, 254, 3).
    expect(room.palette).not.toBeNull();
    expect(Array.from(room.palette!.subarray(3, 6))).toEqual([1, 254, 3]);
  });

  it('finds palette zero when the room carries several', async () => {
    const { room } = await loadV6({ palettes: 3 });
    const palette = room().palette;

    expect(palette).toHaveLength(768);
    expect(Array.from(palette!.slice(0, 3))).toEqual([0, 255, 0]);
  });
});

describe('the v6 room itself', () => {
  it('reads RMHD, which v6 leaves exactly as v5 had it', async () => {
    const { room: load } = await loadV6({ roomWidth: 320, roomHeight: 144 });
    const room = load();

    expect(room.width).toBe(320);
    expect(room.height).toBe(144);
    expect(room.numObjects).toBe(1);
  });

  /**
   * `OBIM` is unchanged from v5. `OBCD` is not, and it is the same length in
   * both — v5 stores an object's position and size as four bytes counted in
   * eighths of a pixel, v6 as four 16-bit values counted in pixels. Nothing
   * about the block gives the difference away, so reading one as the other is
   * silent: the low byte of a 16-bit field becomes a whole byte field, the
   * object lands somewhere else with a height of zero, and a zero-height object
   * can never be clicked. Asserting the geometry rather than only the id and
   * name is what makes that visible.
   */
  it('reads the room object, whose OBCD is wider than v5 at the same length', async () => {
    const { room: load } = await loadV6();
    const room = load();

    expect(room.objects).toHaveLength(1);
    expect(room.objects[0].id).toBe(500);
    expect(room.objects[0].name).toBe('rubber chicken');
    expect(room.objects[0]).toMatchObject({ x: 32, y: 8, width: 16, height: 16 });
  });
});

describe('importing a v6 game', () => {
  /**
   * The reader is chosen by the game's version, not by a default. Reading a v6
   * script with the v5 reader does not fail — it produces a listing that is
   * confidently wrong for its whole length, which is worse.
   */
  it('reads its scripts with the v6 reader', async () => {
    const { resources } = await loadV6({
      entryScript: [
        0x00,
        0x07, // pushByte 7
        0x43,
        250,
        0, // writeWordVar var250
        0x66, // stopObjectCode
      ],
    });

    const room = importRoom(resources, 1);
    const [action] = room!.onEnter;

    expect(action.type).toBe('raw');
    // The v6 folded form. The v5 reader would have stopped at 0x00 with a
    // different listing entirely.
    expect(action.type === 'raw' && action.listing).toMatch(/var250 = 7/);
    expect(action.type === 'raw' && action.listing).toMatch(/stopObjectCode/);
  });
});

describe('drawing a v6 actor', () => {
  /**
   * The whole v6 costume path end to end: an AKOS resource is parsed, a chore
   * is chosen for the actor's frame and facing, stepped to its resting cel,
   * decoded from BOMP and handed to the shared renderer.
   *
   * Asked as "how many pixels does this actor contribute", by rendering twice,
   * because an actor the engine considers placed and visible can still be
   * clipped away to nothing.
   */
  async function actorPixels(): Promise<number> {
    const fixture = buildV6Fixture();
    const source = new MemoryDataSource('v6');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.startScene(1, null, 0);

    const actor = engine.actors[1];
    actor.costume = 1;
    actor.room = 1;
    actor.visible = true;
    engine.putActor(1, 80, 100);

    engine.render();
    const withActor = Uint8Array.from(engine.screen.pixels);

    actor.visible = false;
    engine.render();

    let differing = 0;
    for (let i = 0; i < withActor.length; i++) {
      if (engine.screen.pixels[i] !== withActor[i]) differing++;
    }
    return differing;
  }

  it('puts a v6 costume on the screen', async () => {
    expect(await actorPixels()).toBeGreaterThan(0);
  });

  it('draws the cel at its own size, not the whole costume', async () => {
    // The fixture's cel is 4x2. A path that drew the wrong extent — the whole
    // AKCD block, say — woulddiffer by  far more than eight pixels.
    expect(await actorPixels()).toBeLessThanOrEqual(8);
  });
});
