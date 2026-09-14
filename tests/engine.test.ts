import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { OF_OWNER_ROOM, VAR } from '../src/engine/constants.js';
import {
  buildFixture,
  V5_OBJECT_VERB_ENTRYPOINT,
  V5_OBJECT_VERB_RESULT,
  type FixtureOptions,
} from './fixture.js';

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

async function makeEngine(options: FixtureOptions = {}): Promise<ScummEngine> {
  const fixture = buildFixture(options);
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  // A fixed random source keeps `getRandomNr` assertions stable.
  return ScummEngine.create(source, { random: () => 0.5 });
}

describe('engine bootstrap', () => {
  it('sizes its variable space from the game limits', async () => {
    const engine = await makeEngine();
    expect(engine.variables.length).toBeGreaterThanOrEqual(800);
    expect(engine.bitVariables.length).toBe(2048 / 8);
  });

  it('seeds the variables the scripts expect to find set', async () => {
    const engine = await makeEngine();
    expect(engine.variables[VAR.EGO]).toBe(1);
    expect(engine.variables[VAR.VIDEOMODE]).toBe(19);
    expect(engine.variables[VAR.CURSORSTATE]).toBe(1);
  });

  it('runs the boot script', async () => {
    const engine = await makeEngine();
    engine.boot(0);
    expect(engine.variables[100]).toBe(1234);
  });

  it('passes the boot parameter as local variable 0', async () => {
    const engine = await makeEngine({
      // VAR[102] = local 0. Opcode 0x9A is `move` with the source operand
      // flagged as a variable reference, and 0x4000 selects the local space.
      bootScript: [0x9a, ...u16(102), ...u16(0x4000), 0x00],
    });
    engine.boot(7);
    expect(engine.variables[102]).toBe(7);
  });
});

describe('script interpreter', () => {
  it('evaluates arithmetic opcodes', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(10),
        ...u16(7), // VAR[10] = 7
        0x5a,
        ...u16(10),
        ...u16(3), // VAR[10] += 3
        0x3a,
        ...u16(10),
        ...u16(2), // VAR[10] -= 2
        0x1b,
        ...u16(10),
        ...u16(4), // VAR[10] *= 4
        0x5b,
        ...u16(10),
        ...u16(2), // VAR[10] /= 2
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[10]).toBe(16);
  });

  it('guards against division by zero', async () => {
    const engine = await makeEngine({
      bootScript: [0x1a, ...u16(11), ...u16(9), 0x5b, ...u16(11), ...u16(0), 0x00],
    });
    engine.boot(0);
    expect(engine.variables[11]).toBe(0);
  });

  it('increments and decrements', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(12),
        ...u16(5),
        0x46,
        ...u16(12),
        0x46,
        ...u16(12),
        0xc6,
        ...u16(12),
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[12]).toBe(6);
  });

  it('applies bitwise and/or', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(13),
        ...u16(0b1100),
        0x17,
        ...u16(13),
        ...u16(0b1010), // and
        0x57,
        ...u16(13),
        ...u16(0b0001), // or
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[13]).toBe(0b1001);
  });

  it('takes a conditional jump when the comparison fails', async () => {
    // isEqual jumps forward when the values differ, skipping the assignment.
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(20),
        ...u16(1), // VAR[20] = 1
        0x48,
        ...u16(20),
        ...u16(2),
        ...u16(5), // if (VAR[20] == 2) else jump +5
        0x1a,
        ...u16(21),
        ...u16(99), // skipped
        0x1a,
        ...u16(22),
        ...u16(7), // reached
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[21]).toBe(0);
    expect(engine.variables[22]).toBe(7);
  });

  it('falls through when the comparison holds', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(20),
        ...u16(2),
        0x48,
        ...u16(20),
        ...u16(2),
        ...u16(5),
        0x1a,
        ...u16(21),
        ...u16(99),
        0x1a,
        ...u16(22),
        ...u16(7),
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[21]).toBe(99);
  });

  it('jumps unconditionally', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x18,
        ...u16(5), // jump over the next instruction
        0x1a,
        ...u16(30),
        ...u16(99),
        0x1a,
        ...u16(31),
        ...u16(1),
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[30]).toBe(0);
    expect(engine.variables[31]).toBe(1);
  });

  it('reads and writes bit variables', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(0x8005),
        ...u16(1), // bit var 5 = 1
        0x9a,
        ...u16(40),
        ...u16(0x8005), // VAR[40] = bit var 5
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[40]).toBe(1);
  });

  it('reads and writes script locals', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(0x4003),
        ...u16(42), // local 3 = 42
        0x9a,
        ...u16(41),
        ...u16(0x4003), // VAR[41] = local 3
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[41]).toBe(42);
  });

  it('writes a range of variables', async () => {
    const engine = await makeEngine({
      // setVarRange starting at VAR[50], 3 byte-sized values.
      bootScript: [0x26, ...u16(50), 3, 11, 22, 33, 0x00],
    });
    engine.boot(0);
    expect([engine.variables[50], engine.variables[51], engine.variables[52]]).toEqual([
      11, 22, 33,
    ]);
  });

  it('evaluates a stack expression', async () => {
    const engine = await makeEngine({
      bootScript: [
        // VAR[60] = (3 + 4) * 2
        0xac,
        ...u16(60),
        0x01,
        ...u16(3),
        0x01,
        ...u16(4),
        0x02, // add
        0x01,
        ...u16(2),
        0x04, // multiply
        0xff,
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[60]).toBe(14);
  });

  it('produces a random number within range', async () => {
    const engine = await makeEngine({
      bootScript: [0x16, ...u16(70), 10, 0x00],
    });
    engine.boot(0);
    expect(engine.variables[70]).toBeGreaterThanOrEqual(0);
    expect(engine.variables[70]).toBeLessThanOrEqual(10);
  });

  it('starts another script and reports it as no longer running', async () => {
    const engine = await makeEngine({
      // startScript 2 with no arguments, then record whether it is running.
      bootScript: [0x0a, 2, 0xff, 0x68, ...u16(80), 2, 0x00],
      script2: [0x1a, ...u16(81), ...u16(5), 0x00],
    });
    engine.boot(0);
    expect(engine.variables[81]).toBe(5); // script 2 ran
    expect(engine.variables[80]).toBe(0); // and finished before the check
  });

  it('yields at breakHere and resumes on the next frame', async () => {
    const engine = await makeEngine({
      bootScript: [
        0x1a,
        ...u16(90),
        ...u16(1),
        0x80, // breakHere
        0x1a,
        ...u16(90),
        ...u16(2),
        0x00,
      ],
    });
    engine.boot(0);
    expect(engine.variables[90]).toBe(1);

    engine.step();
    expect(engine.variables[90]).toBe(2);
  });

  it('stops a script that hits an unimplemented opcode instead of running garbage', async () => {
    const messages: string[] = [];
    const fixture = buildFixture({ bootScript: [0x2f, 0x00] });
    const source = new MemoryDataSource('fixture');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source, { onLog: (m) => messages.push(m) });

    // Boot throws because the boot script was stopped rather than finished;
    // what this case is about is the log line, so the failure is swallowed.
    expect(() => engine.boot(0)).toThrow(/Unimplemented opcode/);
    expect(messages.some((m) => m.includes('Unimplemented opcode'))).toBe(true);
  });
});

describe('rooms and objects', () => {
  it('loads a room, its graphics and its boxes', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);

    expect(engine.currentRoom).toBe(1);
    expect(engine.currentRoomData?.width).toBe(320);
    expect(engine.roomGraphics?.width).toBe(320);
    expect(engine.boxes?.count).toBe(2);
    expect(engine.variables[VAR.ROOM]).toBe(1);
  });

  it('runs the room entry script', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    expect(engine.variables[101]).toBe(7);
  });

  it('decodes the background into the room buffer', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    // The fixture fills strip n with colour 10 + n.
    expect(engine.roomGraphics!.background[0]).toBe(10);
    expect(engine.roomGraphics!.background[8]).toBe(11);
  });

  it('reads and writes object state and owner', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);

    expect(engine.getState(500)).toBe(1);
    engine.putState(500, 2);
    expect(engine.getState(500)).toBe(2);

    engine.setOwnerOf(500, 1);
    expect(engine.getOwner(500)).toBe(1);
    expect(engine.getInventoryCount(1)).toBe(1);
    expect(engine.findInventory(1, 1)).toBe(500);
  });

  it('sets and clears object classes', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);

    engine.putClass(500, 22, true);
    expect(engine.getClass(500, 22)).toBe(true);
    engine.putClass(500, 22, false);
    expect(engine.getClass(500, 22)).toBe(false);
    engine.putClass(500, 22, true);
    engine.clearClasses(500);
    expect(engine.getClass(500, 22)).toBe(false);
  });

  it('finds an object under a point', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    expect(engine.findObjectAt(36, 68)).toBe(500);
    expect(engine.findObjectAt(300, 10)).toBe(0);
  });

  it('stops finding an object once an actor is carrying it', async () => {
    // The owner byte says who has the object: 15 is the room, an actor number
    // means it is in a pocket. Reading the room as owner 0 made every object
    // in every room look as though somebody else held it, so nothing in a room
    // could be clicked and no verb ever appeared on hover.
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    expect(engine.isObjectInRoom(500)).toBe(true);

    engine.setOwnerOf(500, 1);
    expect(engine.isObjectInRoom(500)).toBe(false);
    expect(engine.findObjectAt(36, 68)).toBe(0);

    engine.setOwnerOf(500, OF_OWNER_ROOM);
    expect(engine.findObjectAt(36, 68)).toBe(500);
  });

  it('reports an object name and lets a script override it', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    expect(engine.getObjectName(500)).toBe('brass lamp');
    engine.setObjectName(500, 'lamp');
    expect(engine.getObjectName(500)).toBe('lamp');
  });

  it('uses the walk-to point for an object position', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    expect(engine.getObjectOrActorXY(500)).toEqual({ x: 40, y: 120 });
  });

  /**
   * The entry point is measured from the object, and the table's own numbers
   * are measured from the `VERB` chunk — so the answer is the chunk's position
   * within the object plus the entry. The fixture's `OBCD` header and `CDHD`
   * come to 29 bytes, and the handler sits 12 into the `VERB` chunk.
   */
  it('finds the verb entry point declared by an object', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    expect(engine.getVerbEntrypoint(500, 1)).toBe(V5_OBJECT_VERB_ENTRYPOINT);
  });

  it('runs the handler that entry point names', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    engine.scripts.runObjectScript(500, 1, false, false, []);

    // The fixture's handler writes a number no other script writes.
    expect(engine.variables[V5_OBJECT_VERB_RESULT.variable]).toBe(V5_OBJECT_VERB_RESULT.value);
  });
});

describe('actors', () => {
  it('places an actor and snaps it onto a walk box', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);

    engine.putActorInRoom(1, 1);
    engine.putActor(1, 160, 200); // below every box

    const actor = engine.getActor(1)!;
    expect(actor.y).toBe(140); // pulled up onto box 0
    expect(actor.walkbox).toBe(0);
  });

  it('walks an actor toward a destination over successive frames', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    engine.putActorInRoom(1, 1);
    engine.putActor(1, 20, 120);

    const actor = engine.getActor(1)!;
    const startX = actor.x;
    engine.startWalkActor(1, 300, 120, -1);

    for (let i = 0; i < 200 && actor.moving; i++) engine.step();

    expect(actor.x).toBeGreaterThan(startX);
    expect(actor.moving).toBe(0);
  });

  it('turns to face the direction it walks in', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    engine.putActorInRoom(1, 1);
    engine.putActor(1, 160, 120);

    engine.startWalkActor(1, 300, 120, -1);
    for (let i = 0; i < 10; i++) engine.step();

    expect(engine.getActor(1)!.facing).toBe(90); // east
  });

  it('does not move an actor that is in another room', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    engine.putActorInRoom(1, 5);
    engine.startWalkActor(1, 300, 120, -1);
    engine.step();
    expect(engine.getActor(1)!.moving).toBe(0);
  });

  it('measures the distance between two positioned things', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    engine.putActorInRoom(1, 1);
    engine.putActor(1, 40, 120);
    // The object's walk-to point is exactly where the actor stands.
    expect(engine.getObjectOrActorDistance(1, 500)).toBe(0);
  });
});

describe('camera', () => {
  it('clamps to the room bounds', async () => {
    const engine = await makeEngine({ roomWidth: 640 });
    engine.startScene(1, null, 0);

    engine.setCameraAt(0);
    expect(engine.camera.current).toBe(160);

    engine.setCameraAt(10000);
    expect(engine.camera.current).toBe(480);
  });

  it('pans toward its destination one step at a time', async () => {
    const engine = await makeEngine({ roomWidth: 640 });
    engine.startScene(1, null, 0);
    engine.setCameraAt(160);
    engine.panCameraTo(400);

    const before = engine.camera.current;
    engine.step();
    expect(engine.camera.current).toBeGreaterThan(before);
    expect(engine.camera.current).toBeLessThanOrEqual(400);
  });
});

describe('sentences', () => {
  it('queues a sentence and reports it as pending', async () => {
    const engine = await makeEngine();
    engine.startScene(1, null, 0);
    engine.doSentence(1, 500, 0);
    expect(engine.isSentencePending()).toBe(true);
  });

  it('clears the queue on stopSentence', async () => {
    const engine = await makeEngine();
    engine.doSentence(1, 500, 0);
    engine.stopSentence();
    expect(engine.isSentencePending()).toBe(false);
  });
});
