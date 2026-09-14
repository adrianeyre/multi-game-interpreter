import { describe, expect, it } from 'vitest';

import { assembleV8, disassembleV8 } from '../src/authoring/disassembleV6.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { readChunkHeader } from '../src/engine/resource/Chunk.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { Room } from '../src/engine/room/Room.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import {
  buildV8Fixture,
  V8_LOCAL_SCRIPT,
  V8_OBJECT_ID,
  V8_OBJECT_NAME,
  V8_ROOM,
  V8_VERB,
} from './fixtureV8.js';

/**
 * The Tier 1 fixture #196 asks for, and exactly what it is worth.
 *
 * A synthetic v8 install, structurally valid from the index down to a strip of
 * pixels, so detection, the 32-bit directories, the split room, the object
 * pairing and the verb table all run in CI for a Version whose game is not on
 * this machine.
 *
 * `verifying-version-support.md` is blunt about the limit and it is worth
 * repeating here rather than only there: this fixture encodes a reading of
 * ScummVM, so it and the engine agree with each other. Nothing below is
 * evidence that The Curse of Monkey Island runs.
 */
function load(): { source: MemoryDataSource; fixture: ReturnType<typeof buildV8Fixture> } {
  const fixture = buildV8Fixture();
  return { source: new MemoryDataSource('comi', fixture.files), fixture };
}

describe('a synthetic SCUMM v8 install', () => {
  it('is detected as v8 on the size of its MAXS', async () => {
    const game = await detectGame(load().source);

    expect(game.version).toBe(8);
    expect(game.layout).toBe('lecf-container');
    expect(game.identification).toBe('index-structure');
  });

  it('reads its index in thirty-two bits, names and all', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));

    expect(resources.limits.numVariables).toBe(1500);
    expect(resources.listRooms()).toEqual([V8_ROOM]);
    // The name table is what pairs an image with its object, so an empty one
    // is a room whose objects are all invisible rather than an error.
    expect(resources.objectNames.get(V8_OBJECT_NAME)).toBe(V8_OBJECT_ID);
  });

  it('finds the room and the sibling block holding its code', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));

    expect(resources.getRoom(V8_ROOM)).not.toBeNull();
    expect(resources.getRoomScripts(V8_ROOM)).not.toBeNull();
    // Two resources, not one view of the same bytes: reading the code out of
    // `ROOM` is what finds nothing at all.
    expect(resources.getRoomScripts(V8_ROOM)).not.toEqual(resources.getRoom(V8_ROOM));
  });

  it('reads the room header at v8 widths', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    expect(room.width).toBe(320);
    expect(room.height).toBe(144);
    expect(room.numObjects).toBe(1);
    // Read as v7's, the width's high half becomes the height and this is 0.
    expect(room.height).not.toBe(0);
  });

  it('finds the background through IMAG, WRAP and OFFS rather than IM00', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    expect(room.backgroundOffset).toBeGreaterThan(0);
  });

  it('pairs an object with its picture through the name table', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    const object = room.objects[0];
    expect(object.id).toBe(V8_OBJECT_ID);
    expect(object.name).toBe(V8_OBJECT_NAME);
    // Position and size come from the image at v8, as they do at v7 — but out
    // of 32-bit fields at different offsets.
    expect(object.x).toBe(64);
    expect(object.y).toBe(32);
    expect(object.width).toBe(16);
    expect(object.height).toBe(24);
  });

  it('reads a verb table of 32-bit pairs', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    const object = room.objects[0];
    expect([...object.verbs.keys()]).toEqual([V8_VERB]);
    // Counted from the chunk's first byte, tag included — the convention every
    // other Version already stores, which v8 reaches by a different sum.
    expect(object.verbs.get(V8_VERB)).toBe(8 + 4 * 3);
    // The object's code is in the scripts block, not the room, and it says so.
    expect(object.source).toBe(room.scriptData);
  });

  it('numbers a local script in thirty-two bits', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    expect([...room.scripts.local.keys()]).toEqual([V8_LOCAL_SCRIPT]);
    expect(room.scripts.entry).not.toBeNull();
    expect(room.scripts.exit).not.toBeNull();
  });

  it('reads a fifty-six byte walk box', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    expect(room.boxes).toHaveLength(1);
    expect(room.boxes[0].urx).toBe(320);
    expect(room.boxes[0].lly).toBe(144);
    expect(room.boxes[0].scale).toBe(255);
  });

  /**
   * Unrecovered = 0 for v8, asserted rather than assumed.
   *
   * #206 set the editing bar at Unrecovered = 0 on unmodified resources, and
   * for v8 nothing checked it: the round-trip test in
   * `v8-script-engine.test.ts` runs one hand-built script, and a hand-built
   * script contains the instructions whoever wrote it thought of. Every script
   * this fixture ships goes through the pair here instead, which is the
   * property `npm run unrecovered` reports on a game.
   *
   * It is deliberately the *pair* — `disassembleV8` with `assembleV8` — because
   * that is where the fault this test was written for lived. v8's stream
   * operand is four bytes where v6's is two, so a v8 listing re-emitted
   * through v6's writer comes back as different bytes and reads as a
   * decompiler defect. What this does not cover is a caller choosing the wrong
   * writer: the pairing is picked independently in `ActionEditor`,
   * `decompile.ts` and `bin/scumm-unrecovered.ts`, and only a shared selector
   * would make that mistake untypeable.
   */
  it('re-emits every one of its scripts as the bytes it arrived as', async () => {
    const { source } = load();
    const resources = await ResourceManager.load(source, await detectGame(source));
    const room = new Room(V8_ROOM, resources.getRoom(V8_ROOM)!, 8, resources.roomSources(V8_ROOM));

    // Sliced the way `npm run unrecovered` slices: a room script is an offset
    // and a length into the block v8 keeps a room's code in, which is `RMSC`
    // rather than `ROOM`.
    const code = room.scriptData;
    const slice = (at: { offset: number; length: number }): Uint8Array =>
      code.subarray(at.offset, at.offset + at.length);

    const scripts: Array<[string, Uint8Array]> = [
      ['room entry', slice(room.scripts.entry!)],
      ['room exit', slice(room.scripts.exit!)],
      [`local ${V8_LOCAL_SCRIPT}`, slice(room.scripts.local.get(V8_LOCAL_SCRIPT)!)],
    ];

    // A verb handler is sliced the way `npm run unrecovered` slices one: from
    // the first handler's offset to the end its own chunk header declares.
    // Running to the end of the source instead feeds the reader whatever
    // follows the block, which stops on an opcode that was never an opcode.
    const object = room.objects.find((candidate) => candidate.id === V8_OBJECT_ID)!;
    const verbSource = object.source!;
    const block = readChunkHeader(verbSource, object.verbCodeBase);
    const first = Math.min(...object.verbs.values());
    scripts.push([
      `object ${V8_OBJECT_ID} verbs`,
      verbSource.subarray(object.verbCodeBase + first, object.verbCodeBase + block.size),
    ]);

    // A count first, so a test that found nothing to check fails rather than
    // passing quietly — the one result worse than a failure.
    expect(scripts).toHaveLength(4);

    for (const [name, code] of scripts) {
      expect(code.length, name).toBeGreaterThan(0);
      const listing = disassembleV8(code);
      expect(listing.undecodedFrom, name).toBeNull();
      expect(Array.from(assembleV8(listing, code)), name).toEqual(Array.from(code));
    }
  });

  it('boots an engine tagged as v8', async () => {
    const engine = await ScummEngine.create(load().source);

    expect(engine.target).toEqual({
      engine: 'scumm',
      version: 8,
      identification: 'index-structure',
    });
  });
});
