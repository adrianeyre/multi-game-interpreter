import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { OF_OWNER_ROOM, VAR } from '../src/engine/constants.js';
import { compileGame } from '../src/authoring/compile.js';
import { Assembler } from '../src/authoring/Assembler.js';
import { defineGame, rectangleBox, type GameBuilder } from '../src/authoring/GameBuilder.js';
import { createImage, rect } from '../src/authoring/draw.js';
import { global, local, bit } from '../src/authoring/values.js';
import { buildCharset, measureText } from '../src/authoring/CharsetBuilder.js';
import { buildCostume, encodeCelPixels } from '../src/authoring/CostumeBuilder.js';
import { encodeSmap, encodeZPlane } from '../src/authoring/ImageEncoder.js';
import { readChunkHeader } from '../src/engine/resource/Chunk.js';
import { decodeStrip } from '../src/engine/gfx/BitmapCodec.js';
import demoGame from '../examples/demo/game.js';

/** Compiles a game and hands back an engine that has loaded it. */
async function run(game: GameBuilder): Promise<ScummEngine> {
  const compiled = compileGame(game);
  const source = new MemoryDataSource('compiled');
  source.set('GAME.000', compiled.index);
  source.set('GAME.001', compiled.data);
  return ScummEngine.create(source, { random: () => 0.5 });
}

function minimalGame(): GameBuilder {
  const background = createImage(320, 144, 3);
  rect(background, 0, 100, 320, 44, 8);

  const game = defineGame({
    name: 'Test',
    start: { room: 1, x: 100, y: 120 },
  });

  game.actor({
    id: 1,
    name: 'Tester',
    costume: {
      palette: [0, 1, 2, 3],
      frames: [
        {},
        { all: { image: createImage(8, 16, 1) } },
        { all: { image: createImage(8, 16, 2) } },
        { all: { image: createImage(8, 16, 1) } },
        { all: { image: createImage(8, 16, 3) } },
        { all: { image: createImage(8, 16, 1) } },
      ],
    },
  });

  game.verb({ id: 1, text: 'Look at', x: 10, y: 152, key: 'l' });

  const room = game.room({
    id: 1,
    name: 'testroom',
    background,
    boxes: [rectangleBox(0, 104, 320, 40)],
  });

  room
    .object({
      id: 300,
      name: 'rock',
      x: 160,
      y: 80,
      width: 16,
      height: 16,
      walkTo: { x: 168, y: 120 },
      states: [createImage(16, 16, 7)],
    })
    .on(1, (s) => s.move(global(230), 42));

  return game;
}

describe('assembler', () => {
  it('picks the literal form when given a number', () => {
    const s = new Assembler();
    s.move(global(10), 5);
    expect([...s.build()]).toEqual([0x1a, 10, 0, 5, 0]);
  });

  it('picks the variable form when given a variable', () => {
    const s = new Assembler();
    s.move(global(10), global(11));
    expect([...s.build()]).toEqual([0x9a, 10, 0, 11, 0]);
  });

  it('sets a mode bit per operand position', () => {
    const s = new Assembler();
    s.putActor(1, global(2), 3);
    // Operand 2 is a variable, so only bit 6 is set.
    expect(s.build()[0]).toBe(0x41);
  });

  it('encodes local and bit variables in their address spaces', () => {
    const s = new Assembler();
    s.move(local(3), bit(9));
    const bytes = s.build();
    expect(bytes[1] | (bytes[2] << 8)).toBe(0x4003);
    expect(bytes[3] | (bytes[4] << 8)).toBe(0x8009);
  });

  it('back-patches a forward jump', () => {
    const s = new Assembler();
    const end = s.label();
    s.jump(end);
    s.move(global(1), 1); // 5 bytes, skipped
    s.place(end);
    s.stop();

    const bytes = s.build();
    const displacement = ((bytes[1] | (bytes[2] << 8)) << 16) >> 16;
    expect(displacement).toBe(5);
  });

  it('refuses to build with an unplaced label', () => {
    const s = new Assembler();
    s.jump(s.label());
    expect(() => s.build()).toThrow(/never placed/);
  });

  it('encodes a delay as an inverted 24 bit count', () => {
    const s = new Assembler();
    s.delay(60);
    const bytes = s.build();
    const value = bytes[1] | (bytes[2] << 8) | (bytes[3] << 16);
    expect(0xffffff - value).toBe(60);
  });
});

describe('the sentence line in a compiled game', () => {
  it('stops composing one once a script writes verb 0 itself', async () => {
    // A published game drives its own line from its scripts. Composing one
    // here as well would be two authors writing to the same place.
    const game = minimalGame();
    game.script(10, (s) => {
      s.verbOps(0).text('Walk to').end();
    });

    const engine = await run(game);
    engine.boot(0);
    engine.scripts.runScript(10, false, false, []);

    engine.handleVerbClick(1);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('Walk to');
  });
});

describe('walk-box handling in actorOps', () => {
  it('leaves the instruction after followBoxes intact', async () => {
    // 16 is actor width, which takes a byte, so emitting `followBoxes` as 16
    // swallowed the first byte of the next instruction and the script carried
    // on from the middle of it. The pair the interpreter actually reads is 20
    // and 21.
    const game = minimalGame();
    game.script(10, (s) => {
      s.actorOps(1).followBoxes().end();
      s.move(global(120), 55);
    });

    const engine = await run(game);
    engine.boot(0);
    engine.scripts.runScript(10, false, false, []);

    expect(engine.variables[120]).toBe(55);
    expect(engine.actors[1].ignoreBoxes).toBe(false);
  });

  it('actually makes an actor ignore its walk boxes', async () => {
    const game = minimalGame();
    game.script(10, (s) => {
      s.actorOps(1).ignoreBoxes().end();
    });

    const engine = await run(game);
    engine.boot(0);
    engine.scripts.runScript(10, false, false, []);

    expect(engine.actors[1].ignoreBoxes).toBe(true);
  });
});

describe('image encoding', () => {
  it('round-trips through the engine decoder', () => {
    const image = createImage(16, 4, 0);
    for (let i = 0; i < image.pixels.length; i++) image.pixels[i] = i & 0xff;

    const smap = new Uint8Array(encodeSmap(image));
    const header = readChunkHeader(smap, 0);
    expect(header.tag).toBe('SMAP');

    // Decode strip 0 back and compare against the source pixels.
    const offset = smap[8] | (smap[9] << 8) | (smap[10] << 16) | (smap[11] << 24);
    const out = new Uint8Array(8 * 4);
    decodeStrip(smap, offset, {
      dst: out,
      dstOffset: 0,
      dstStride: 8,
      height: 4,
      transparentColor: 255,
    });

    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 8; x++) {
        expect(out[y * 8 + x]).toBe(image.pixels[y * 16 + x]);
      }
    }
  });

  it('emits a z-plane chunk with the expected tag', () => {
    const mask = new Uint8Array(16 * 4);
    mask[0] = 1;
    const bytes = new Uint8Array(encodeZPlane(1, mask, 16, 4));
    expect(readChunkHeader(bytes, 0).tag).toBe('ZP01');
  });
});

describe('costume encoding', () => {
  it('run-length encodes in column-major order', () => {
    const image = createImage(2, 4, 0);
    image.pixels.fill(5);
    // 8 pixels of colour 5. At 16 colours the run field is 4 bits, so a run of
    // 8 packs into one byte.
    expect(encodeCelPixels(image, 16)).toEqual([(5 << 4) | 8]);
  });

  it('uses an explicit length byte past the inline run limit', () => {
    const image = createImage(4, 8, 0);
    image.pixels.fill(3);
    expect(encodeCelPixels(image, 16)).toEqual([3 << 4, 32]);
  });

  it('defaults to the 32 colour packing', () => {
    const image = createImage(2, 4, 0);
    image.pixels.fill(5);
    // Three bits of run length, so a run of 8 needs the explicit form.
    expect(encodeCelPixels(image)).toEqual([5 << 3, 8]);
  });

  it('builds a costume the engine can parse', () => {
    const bytes = new Uint8Array(
      buildCostume({
        palette: [0, 1, 2],
        frames: [{}, { all: { image: createImage(8, 8, 1) } }],
      }),
    );
    expect(readChunkHeader(bytes, 0).tag).toBe('COST');
  });
});

describe('charset building', () => {
  it('produces a CHAR resource with a 1 bit font', () => {
    const bytes = new Uint8Array(buildCharset());
    expect(readChunkHeader(bytes, 0).tag).toBe('CHAR');
    expect(bytes[29]).toBe(1); // bits per pixel
  });

  it('measures text at 6 pixels per character', () => {
    expect(measureText('AB')).toBe(12);
  });
});

describe('compiled games load in the engine', () => {
  it('produces a container the detector recognises as SCUMM v5', async () => {
    const compiled = compileGame(minimalGame());
    const source = new MemoryDataSource('compiled');
    source.set('GAME.000', compiled.index);
    source.set('GAME.001', compiled.data);

    const detected = await detectGame(source);
    expect(detected.version).toBe(5);
    expect(detected.xorKey).toBe(0x69);
  });

  it('resolves every resource type', async () => {
    const compiled = compileGame(minimalGame());
    const source = new MemoryDataSource('compiled');
    source.set('GAME.000', compiled.index);
    source.set('GAME.001', compiled.data);
    const manager = await ResourceManager.load(source, await detectGame(source));

    expect(manager.getRoom(1)).not.toBeNull();
    expect(manager.getScript(1)).not.toBeNull(); // boot
    expect(manager.getScript(2)).not.toBeNull(); // sentence
    expect(manager.getCostume(1)).not.toBeNull();
    expect(manager.getCharset(0)).not.toBeNull();
    expect(manager.roomNames.get(1)).toBe('testroom');
  });

  it('boots into the starting room with the player placed', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);

    expect(engine.currentRoom).toBe(1);
    expect(engine.variables[VAR.EGO]).toBe(1);

    const actor = engine.getActor(1)!;
    expect(actor.room).toBe(1);
    expect(actor.visible).toBe(true);
    expect(actor.costume).toBe(1);
    expect(actor.name).toBe('Tester');
    expect(actor.x).toBe(100);
  });

  it('wires up the generated sentence and verb scripts', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);
    expect(engine.variables[VAR.SENTENCE_SCRIPT]).toBe(2);
    expect(engine.variables[VAR.VERB_SCRIPT]).toBe(3);
  });

  it('creates the verbs declared by the author', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);

    const verb = engine.verbs.get(1);
    expect(verb).toBeDefined();
    expect(verb!.text).toBe('Look at');
    expect(verb!.enabled).toBe(true);
    expect(verb!.key).toBe('l'.charCodeAt(0));
  });

  it('parses the authored objects out of the room', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);

    const object = engine.currentRoomData!.findObject(300);
    expect(object).toBeDefined();
    expect(object!.name).toBe('rock');
    expect(object!.walkX).toBe(168);
    expect(engine.getObjectName(300)).toBe('rock');
  });

  it('decodes the authored background into the room buffer', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);
    // The background is colour 3 above y=100 and colour 8 below.
    expect(engine.roomGraphics!.background[0]).toBe(3);
    expect(engine.roomGraphics!.background[110 * 320]).toBe(8);
  });

  it('runs an object verb handler through the sentence script', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);

    engine.doSentence(1, 300, 0);
    // The player walks to the object first, so give it time to arrive.
    for (let i = 0; i < 400 && engine.variables[230] !== 42; i++) engine.step();

    expect(engine.variables[230]).toBe(42);
  });

  it('sets object owner and state from the declaration', async () => {
    const engine = await run(minimalGame());
    engine.boot(0);
    expect(engine.getState(300)).toBe(1);
    // The room owns what nobody carries, and the room is 15 rather than 0 —
    // 0 means nobody has it at all, which the interpreter reads as "not here".
    expect(engine.getOwner(300)).toBe(OF_OWNER_ROOM);
    expect(engine.isObjectInRoom(300)).toBe(true);
  });
});

describe('the bundled demo game', () => {
  it('compiles without warnings', () => {
    const compiled = compileGame(demoGame);
    expect(compiled.warnings).toEqual([]);
    expect(compiled.stats.rooms).toBe(2);
    expect(compiled.stats.objects).toBe(4);
  });

  it('boots and reaches the street', async () => {
    const engine = await run(demoGame);
    engine.boot(0);

    expect(engine.currentRoom).toBe(1);
    expect(engine.currentRoomData!.objects.map((o) => o.id).sort()).toEqual([100, 101]);
    expect(engine.getActor(1)!.visible).toBe(true);
  });

  it('runs a few hundred frames without throwing', async () => {
    const engine = await run(demoGame);
    engine.boot(0);
    expect(() => {
      for (let i = 0; i < 300; i++) engine.step();
    }).not.toThrow();
  });

  it('opens the door and moves to the office', async () => {
    const engine = await run(demoGame);
    engine.boot(0);

    engine.doSentence(3, 100, 0); // OPEN the door
    for (let i = 0; i < 600 && engine.currentRoom === 1; i++) engine.step();

    expect(engine.currentRoom).toBe(2);
    expect(engine.getActor(1)!.room).toBe(2);
  });

  it('lets the player pick up the key in the office', async () => {
    const engine = await run(demoGame);
    engine.boot(0);

    engine.doSentence(3, 100, 0);
    for (let i = 0; i < 600 && engine.currentRoom === 1; i++) engine.step();

    engine.doSentence(2, 200, 0); // PICK UP the key
    // Waiting on the owner leaving 0 was waiting on a state it starts in only
    // when the object belongs to nobody; the key starts in the room.
    for (let i = 0; i < 600 && engine.isObjectInRoom(200); i++) engine.step();

    expect(engine.getOwner(200)).toBe(1);
    expect(engine.getInventoryCount(1)).toBe(1);
  });

  it('renders a frame with the room and the actor drawn', async () => {
    const engine = await run(demoGame);
    engine.boot(0);
    for (let i = 0; i < 10; i++) engine.step();
    engine.render();

    const pixels = engine.screen.copyPixels();
    // The room band must not be blank.
    const roomBand = pixels.slice(16 * 320, 144 * 320);
    expect(roomBand.some((value) => value !== 0)).toBe(true);
  });
});
