import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { Room } from '../src/engine/room/Room.js';
import { buildV7Fixture, type V7FixtureOptions } from './fixtureV7.js';

/**
 * Reading a v7 index and its resources.
 *
 * Tier 1: the fixture and the reader are written from the same reading of
 * ScummVM, so these prove the two agree and nothing more. What they cannot
 * prove is that the reading is right — only a demo does that.
 */
async function loadV7(options: V7FixtureOptions = {}) {
  const fixture = buildV7Fixture(options);
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);

  const game = await detectGame(source);
  const resources = await ResourceManager.load(source, game);
  return { fixture, game, resources };
}

describe('loading a v7 index', () => {
  it('reads the resource limits out of a 138-byte MAXS', async () => {
    const { resources } = await loadV7();

    // v7's field order is its own. Reading it as v6's list puts the global
    // object count where the verb count belongs, which is the kind of error
    // that shows up as an unrelated crash much later.
    expect(resources.limits.numVariables).toBe(800);
    expect(resources.limits.numBitVariables).toBe(2048);
    expect(resources.limits.numGlobalObjects).toBe(600);
    expect(resources.limits.numLocalObjects).toBe(200);
    expect(resources.limits.numVerbs).toBe(100);
    expect(resources.limits.numInventory).toBe(80);
    expect(resources.limits.numRooms).toBe(100);
    expect(resources.limits.numScripts).toBe(200);
    expect(resources.limits.numSounds).toBe(100);
    expect(resources.limits.numCharsets).toBe(9);
    expect(resources.limits.numCostumes).toBe(30);
  });

  it('keeps the two version strings MAXS opens with', async () => {
    const { resources } = await loadV7();

    // Cheap evidence that the block was read at the right offset at all: if
    // these come back as mojibake, every count after them is wrong too.
    expect(resources.engineVersionString).toBe('Fixture engine v7');
    expect(resources.dataVersionString).toBe('Fixture data v7');
  });

  it('reads DOBJ as three columns, not v6’s two', async () => {
    const { resources } = await loadV7({ objectState: 2 });

    expect(resources.objectState[500]).toBe(2);
    expect(resources.objectRoom[500]).toBe(1);
    expect(resources.classData[500]).toBe(1 << 23);
  });

  it('records no owner for a v7 object, because the index carries none', async () => {
    const { resources } = await loadV7();

    // ScummVM memsets the owner table after reading v7's DOBJ. Reading v6's
    // packed byte here instead would give every object an owner taken from its
    // state, which reads as a plausible number and is not one.
    expect(resources.objectOwner[500]).toBe(0xff);
  });

  it('reads the audio cue names from ANAM', async () => {
    const { resources } = await loadV7();

    // Nine bytes each, and audio rather than objects — the distinction that
    // decides whether the bundle reader can find anything.
    expect(resources.audioNames).toEqual(['EXIT', 'ROADHOUS', 'BIKE']);
  });

  it('resolves the resources the directories point at', async () => {
    const { resources } = await loadV7();

    expect(resources.roomCount).toBe(1);
    expect(resources.getScript(2)).not.toBeNull();
    expect(resources.getResource('costume', 1)).not.toBeNull();
    expect(resources.getResource('charset', 0)).not.toBeNull();
    expect(resources.getResource('sound', 1)).not.toBeNull();
  });

  it('does not copy the data file, since a v7 game is not encrypted', async () => {
    const { game } = await loadV7();

    // The saving this stands for is Full Throttle's ~148 MB not being
    // duplicated to XOR every byte with zero.
    expect(game.xorKey).toBe(0);
  });
});

describe('reading a v7 room', () => {
  it('reads RMHD past its leading version field', async () => {
    const { resources } = await loadV7({ roomWidth: 640, roomHeight: 400 });
    const data = resources.getResource('room', 1)!;
    const room = new Room(1, data, 7);

    // Read as v6, the width would come back as the version field's low half.
    expect(room.width).toBe(640);
    expect(room.height).toBe(400);
  });

  it('takes an object’s position and size from IMHD, where v7 keeps them', async () => {
    const { resources } = await loadV7();
    const data = resources.getResource('room', 1)!;
    const room = new Room(1, data, 7);

    const object = room.objects.find((candidate) => candidate.id === 500);
    expect(object).toBeDefined();
    expect(object!.x).toBe(32);
    expect(object!.y).toBe(8);
    expect(object!.width).toBe(16);
    expect(object!.height).toBe(16);
  });

  it('reads the object’s parent state from v7’s eight-byte CDHD', async () => {
    const { resources } = await loadV7({ objectState: 1 });
    const data = resources.getResource('room', 1)!;
    const room = new Room(1, data, 7);

    const object = room.objects.find((candidate) => candidate.id === 500)!;
    expect(object.parentState).toBe(1);
    expect(object.parent).toBe(0);
  });

  it('still finds the object’s name and verb table, which v7 did not move', async () => {
    const { resources } = await loadV7();
    const data = resources.getResource('room', 1)!;
    const room = new Room(1, data, 7);

    const object = room.objects.find((candidate) => candidate.id === 500)!;
    expect(object.name).toBe('rubber chicken');
    expect(object.verbs.get(1)).toBeDefined();
  });
});
