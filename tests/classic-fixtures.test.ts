import { describe, expect, it } from 'vitest';

import { disassembleClassic } from '../src/authoring/disassembleClassic.js';
import { importGame } from '../src/authoring/importGame.js';
import { loadImage } from '../src/authoring/imageCodec.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { Room } from '../src/engine/room/Room.js';
import { buildClassicFixture } from './fixtureClassic.js';

/**
 * The Tier 1 fixtures #201 and #203 ask for, and what they are worth.
 *
 * A synthetic v2, v3 and v4 install each, structurally valid all the way down —
 * so detection, the index, the container or the file set, the room, its
 * objects, its palette, its picture and its bytecode all run in CI for Versions
 * whose games are not on this machine.
 *
 * And `verifying-version-support.md` is blunt about the limit: a fixture
 * encodes our reading of the format, so these and the engine agree with each
 * other and may both disagree with the game. The v4 case is the one that is
 * *also* measured, against `games/loom` — which is why the builder produces v4
 * too rather than only the two Versions that need it. The same code the real
 * install checks is the code the other two exercise.
 */
function load(version: 2 | 3 | 4) {
  const fixture = buildClassicFixture({ version });
  const source = new MemoryDataSource(`v${version}`, fixture.files);
  return { fixture, source };
}

describe.each([2, 3, 4] as const)('a synthetic SCUMM v%i install', (version) => {
  it('is detected as the version it is, with the right layout', async () => {
    const { source } = load(version);

    const game = await detectGame(source);

    expect(game.version).toBe(version);
    expect(game.layout).toBe(version === 4 ? 'lec-disks' : 'lfl-rooms');
    // Read from the index's own shape rather than guessed at, which is what
    // ADR 0013 makes the editing decision turn on.
    expect(game.identification).toBe('index-structure');
  });

  it('reads its index, its room and its script', async () => {
    const { fixture, source } = load(version);
    const resources = await ResourceManager.load(source, {
      indexFile: fixture.indexName,
      dataFiles: version === 4 ? ['DISK01.LEC'] : ['01.LFL'],
      charsetFiles: version === 4 ? ['901.LFL'] : [],
      layout: version === 4 ? 'lec-disks' : 'lfl-rooms',
      xorKey: version === 3 ? 0xff : 0,
      dataXorKey: version === 4 ? 0x69 : version === 3 ? 0xff : 0,
      version,
      id: 'fixture',
      identification: 'index-structure',
    });

    expect(resources.listRooms()).toEqual([1]);
    expect(resources.getRoom(1)).not.toBeNull();
    expect(resources.getScript(1)).not.toBeNull();
  });

  it('parses the room down to its object, its picture and its palette', async () => {
    const { fixture, source } = load(version);
    const resources = await ResourceManager.load(source, {
      indexFile: fixture.indexName,
      dataFiles: version === 4 ? ['DISK01.LEC'] : ['01.LFL'],
      charsetFiles: [],
      layout: version === 4 ? 'lec-disks' : 'lfl-rooms',
      xorKey: version === 3 ? 0xff : 0,
      dataXorKey: version === 4 ? 0x69 : version === 3 ? 0xff : 0,
      version,
      id: 'fixture',
      identification: 'index-structure',
    });

    const room = new Room(1, resources.getRoom(1)!, version);

    expect(room.width).toBe(320);
    expect(room.height).toBe(144);
    // The palette's own count, which is also how the colour depth is decided.
    expect(room.paletteColours).toBe(version === 4 ? 256 : 16);
    expect(room.backgroundOffset).toBeGreaterThan(0);
    expect(room.boxes).toHaveLength(1);
    expect(room.scripts.entry).not.toBeNull();

    const object = room.objects[0];
    expect(object.id).toBe(fixture.objectId);
    expect(object.name).toBe('lamp');
    expect([...object.verbs.keys()]).toEqual([1]);

    // The offset points at the handler rather than at the block it is in.
    // Written as zero for a while, which is the `OC` header — so the engine
    // decoded the object's own id and position as instructions and ran off the
    // end of the block. A passing suite said nothing; `npm run sweep` over the
    // fixture said "read past the end of its code", which is what that report
    // is for.
    const entry = object.verbCodeBase + object.verbs.get(1)!;
    expect(room.data[entry]).toBe(0x00);
  });

  it("decodes its boot script with its own Version's table", async () => {
    const { fixture, source } = load(version);
    const resources = await ResourceManager.load(source, {
      indexFile: fixture.indexName,
      dataFiles: version === 4 ? ['DISK01.LEC'] : ['01.LFL'],
      charsetFiles: [],
      layout: version === 4 ? 'lec-disks' : 'lfl-rooms',
      xorKey: version === 3 ? 0xff : 0,
      dataXorKey: version === 4 ? 0x69 : version === 3 ? 0xff : 0,
      version,
      id: 'fixture',
      identification: 'index-structure',
    });

    // Past the six byte header, which is where a pre-v5 script starts.
    const code = resources.getScript(1)!.subarray(6);
    const listing = disassembleClassic(code, version);

    expect(listing.reason).toBeNull();
    expect(listing.instructions.map((instruction) => instruction.name)).toEqual([
      'move',
      'stopObjectCode',
    ]);
    // v2 names a variable with one byte and v3 and v4 with two, so the same
    // instruction is a byte shorter there.
    expect(listing.instructions[0].length).toBe(version <= 2 ? 4 : 5);
  });
});

/**
 * Importing a pre-v5 room's artwork, which went through the wrong door.
 *
 * `importRoom` decoded every room's background with `decodeImage` — the reader
 * for v5's `RMIM` > `IM00` > `SMAP` nesting. A v2, v3 or v4 room has none of
 * those: `BM` *is* the strip table. So the reader found no chunk, drew
 * nothing, and returned a project whose every room was blank — which reads as
 * a game with no artwork rather than as an importer using the v5 door, and
 * which no test noticed because nothing asked what the pixels were.
 *
 * The engine had already met this fault twice on the playing side, in the two
 * places `verifying-version-support.md` records for Loom CD: object images
 * through the v5 reader, and a redrawn room through it again.
 */
describe.each([2, 3, 4] as const)('importing a synthetic SCUMM v%i room', (version) => {
  async function project() {
    const fixture = buildClassicFixture({ version });
    const source = new MemoryDataSource(`v${version}`, fixture.files);
    const resources = await ResourceManager.load(source, await detectGame(source));
    return importGame(resources, { rooms: resources.listRooms() }).project;
  }

  it('decodes the background rather than leaving it blank', async () => {
    const room = (await project()).rooms[0];
    const image = loadImage(room.background);

    expect(image.width).toBe(320);
    expect(image.height).toBe(144);
    // The fixture paints a ramp across the palette, so a blank room and a
    // decoded one differ in the only way that matters: a blank one is one
    // colour.
    expect(new Set(image.pixels).size).toBeGreaterThan(1);
  });

  it("decodes the object's picture, which is the same strip table", async () => {
    const room = (await project()).rooms[0];
    const object = room.objects[0];

    expect(object.states.length).toBeGreaterThan(0);
    const image = loadImage(object.states[0]);
    // Solid colour 3, which is what the fixture fills it with — so the check
    // is that it decoded at all, and to the right colour rather than to zero.
    expect(new Set(image.pixels)).toEqual(new Set([3]));
  });
});
