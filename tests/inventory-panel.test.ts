import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { VAR } from '../src/engine/constants.js';
import { VerbTable } from '../src/engine/verbs/Verbs.js';
import { u16le } from './fixture.js';
import { V6_OBJECT_VERB_ENTRYPOINT, buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';

/**
 * The inventory panel a v6 game draws for itself.
 *
 * A v6 game has no built-in inventory: `VAR_INVENTORY_SCRIPT` names a script of
 * the game's own, and the panel on screen is whatever that script last drew out
 * of image verbs. So the panel is only right if the interpreter runs the script
 * at the moments the original runs it — every change of ownership — and if a
 * carried object can still be read after its room is gone, because the script
 * asks each held item for its icon through the item's own verb code.
 *
 * Day of the Tentacle is the game that shows both. Without the first, Bernard's
 * panel keeps every slot switched off however much he is carrying; without the
 * second, every slot draws object 624, the empty-slot frame.
 */

const STOP = 0x66;
/** The fixture's object, which lives in room 1. */
const OBJECT = 500;
/** A variable the inventory script writes, so a test can see that it ran. */
const WITNESS = 300;
/** A second one, holding the argument it was called with. */
const ARGUMENT = 301;

/**
 * A script that records that it ran, and with what.
 *
 * `pushWordVar 0x4000` is local variable 0 — the argument an inventory script
 * is handed.
 */
const RECORDING_SCRIPT = [
  0x03,
  ...u16le(WITNESS), // pushWordVar var300
  0x00,
  0x01, // pushByte 1
  0x14, // add
  0x43,
  ...u16le(WITNESS), // writeWordVar var300
  0x03,
  ...u16le(0x4000), // pushWordVar local0
  0x43,
  ...u16le(ARGUMENT), // writeWordVar var301
  STOP,
];

async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture({ script3: RECORDING_SCRIPT, ...options });
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const engine = await ScummEngine.create(source, { onLog: () => {} });
  engine.boot(0);
  engine.startScene(1, null, 0);
  engine.variables[VAR.EGO] = 1;
  engine.variables[VAR.INVENTORY_SCRIPT] = 3;
  engine.variables[WITNESS] = 0;
  engine.variables[ARGUMENT] = -1;
  return engine;
}

describe('the inventory script', () => {
  it('runs when an object is picked up, and is told which', async () => {
    const engine = await bootV6();

    engine.pickupObject(OBJECT, 1);

    expect(engine.variables[WITNESS]).toBe(1);
    expect(engine.variables[ARGUMENT]).toBe(OBJECT);
  });

  it('runs when an object changes hands', async () => {
    const engine = await bootV6();

    engine.setOwnerOf(OBJECT, 1);

    expect(engine.variables[WITNESS]).toBe(1);
    expect(engine.variables[ARGUMENT]).toBe(OBJECT);
  });

  it('does nothing when the game has not named one', async () => {
    const engine = await bootV6();
    engine.variables[VAR.INVENTORY_SCRIPT] = 0;

    engine.pickupObject(OBJECT, 1);

    expect(engine.variables[WITNESS]).toBe(0);
  });
});

describe('a carried object', () => {
  it('keeps its verb code after the room it came from is gone', async () => {
    const engine = await bootV6();
    engine.pickupObject(OBJECT, 1);
    expect(engine.getVerbEntrypoint(OBJECT, 1)).toBe(V6_OBJECT_VERB_ENTRYPOINT);

    // Room 0 is no room at all: the object list goes with the room, which is
    // what leaves a held item unreadable when nothing kept a copy.
    engine.startScene(0, null, 0);
    expect(engine.currentRoomData).toBeNull();

    expect(engine.getVerbEntrypoint(OBJECT, 1)).toBe(V6_OBJECT_VERB_ENTRYPOINT);
    expect(engine.findObjectVerbCode(OBJECT, 1)).not.toBeNull();
  });

  it('is read out of the room the caller names, not the one on screen', async () => {
    const engine = await bootV6();
    engine.startScene(0, null, 0);

    // Nothing is on screen, so the only way to reach object 500's code is to
    // parse room 1 because `pickupObject` was told to.
    engine.pickupObject(OBJECT, 1);

    expect(engine.getVerbEntrypoint(OBJECT, 1)).toBe(V6_OBJECT_VERB_ENTRYPOINT);
  });
});

describe('a verb', () => {
  it('is drawn in the charset that was current when it was made', () => {
    const verbs = new VerbTable();

    expect(verbs.create(1).charsetId).toBe(1);
    expect(verbs.create(2, 3).charsetId).toBe(3);
    // Making it again replaces it, charset and all — `SO_VERB_NEW` on a slot
    // already in use is how a game re-uses one.
    expect(verbs.create(2, 4).charsetId).toBe(4);
  });
});
