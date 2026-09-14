import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import {
  createObjectIdAllocator,
  importGame,
  importPoses,
  importRoom,
} from '../src/authoring/importGame.js';
import {
  renderBackground,
  backgroundFilename,
  renderObjectState,
  renderSpriteCel,
  spriteFilename,
} from '../src/editor/imageExport.js';
import {
  Costume,
  celToRowMajor,
  costumeDecodeData,
  createCostumeData,
  decodeCel,
  getLimbCel,
} from '../src/engine/gfx/Costume.js';
import type { Cel } from '../src/engine/gfx/Costume.js';
import { buildCostume } from '../src/authoring/CostumeBuilder.js';
import { ACTOR_ID_LIMIT, poseHasArt } from '../src/authoring/project.js';
import { loadImage, storeImage } from '../src/authoring/imageCodec.js';
import { validateProject } from '../src/authoring/project.js';
import { buildFixture } from './fixture.js';

async function resources() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return ResourceManager.load(source, await detectGame(source));
}

describe('importing a published game', () => {
  it('brings each room across with its size and name', async () => {
    const { project } = importGame(await resources());

    expect(project.rooms.length).toBeGreaterThan(0);
    const room = project.rooms[0];
    expect(room.id).toBe(1);
    expect(room.name).toBe('TESTROOM');
    expect(room.width).toBe(320);
    expect(room.height).toBe(144);
  });

  it('decodes the background to editable pixels', async () => {
    const room = importRoom(await resources(), 1)!;
    const image = loadImage(room.background);

    expect(image.width).toBe(320);
    expect(image.height).toBe(144);
    // A decoded background is not blank: the fixture paints known colours.
    expect(new Set(image.pixels).size).toBeGreaterThan(1);
  });

  it('brings walk boxes across as editable quadrilaterals', async () => {
    const room = importRoom(await resources(), 1)!;

    expect(room.boxes.length).toBeGreaterThan(0);
    const box = room.boxes[0];
    expect(box.ul).toEqual({ x: 0, y: 100 });
    expect(box.lr.x).toBe(319);
    expect(typeof box.mask).toBe('number');
  });

  it('brings objects across with their position and walk-to point', async () => {
    const room = importRoom(await resources(), 1)!;

    expect(room.objects.length).toBeGreaterThan(0);
    const object = room.objects[0];
    expect(object.id).toBeGreaterThan(0);
    expect(object.walkTo).toHaveProperty('x');
    expect(['north', 'east', 'south', 'west']).toContain(object.facing);
  });

  it('produces a project that compiles and plays, not merely one that parses', async () => {
    const { project } = importGame(await resources());
    // Every validation problem is fatal to buildProject, so anything left here
    // is a game that cannot be played in the editor at all.
    expect(validateProject(project)).toEqual([]);
  });

  it('keeps object ids out of the actor range', async () => {
    const { project } = importGame(await resources());
    const ids = project.rooms.flatMap((room) => room.objects.map((object) => object.id));

    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(ACTOR_ID_LIMIT);
  });

  it('gives a room with no walk boxes a floor, so it can compile', async () => {
    const { project } = importGame(await resources());
    for (const room of project.rooms) expect(room.boxes.length).toBeGreaterThan(0);
  });

  it("brings each room's colours across", async () => {
    const room = importRoom(await resources(), 1)!;

    expect(room.palette).toBeDefined();
    expect(room.palette).toHaveLength(256);
    // Six-bit VGA values are scaled to fill a byte, as the engine does before
    // drawing; without it every colour is four times too dark.
    expect(Math.max(...room.palette!.flat())).toBeGreaterThan(63);
  });
});

describe('object id allocation', () => {
  it('leaves an id that is already legal alone', () => {
    const ids = createObjectIdAllocator();
    expect(ids.assign(500)).toBe(500);
    expect(ids.renumbered).toEqual([]);
  });

  it('moves an id out of the actor range and records the move', () => {
    const ids = createObjectIdAllocator();
    expect(ids.assign(16)).toBe(ACTOR_ID_LIMIT);
    expect(ids.renumbered).toEqual([{ from: 16, to: ACTOR_ID_LIMIT }]);
  });

  it('never issues the same id twice', () => {
    const ids = createObjectIdAllocator();
    const assigned = [20, 20, 5, 21].map((id) => ids.assign(id));
    expect(new Set(assigned).size).toBe(assigned.length);
  });
});

describe('exporting a background', () => {
  it("renders the artwork in the room's own colours", async () => {
    const room = importRoom(await resources(), 1)!;
    const rendered = renderBackground(room);

    expect(rendered.width).toBe(room.width);
    expect(rendered.rgba).toHaveLength(room.width * room.height * 4);
    // Every pixel opaque: this is artwork, not a layer over something.
    expect(rendered.rgba[3]).toBe(255);

    const first = room.palette![loadImage(room.background).pixels[0]];
    expect([rendered.rgba[0], rendered.rgba[1], rendered.rgba[2]]).toEqual(first);
  });

  it('names the file after the game and room', async () => {
    const room = importRoom(await resources(), 1)!;
    expect(backgroundFilename(room, 'Monkey Island')).toBe('monkey-island-room-1-testroom.png');
  });

  it('records what could not come across, rather than dropping it quietly', async () => {
    const { project, notes } = importGame(await resources());

    expect(project.imported?.game).toBe('testgame');
    expect(project.imported?.scripts.length).toBeGreaterThan(0);
    expect(notes.join(' ')).toMatch(/not editable/);
  });

  it('reports progress a room at a time', async () => {
    const seen: string[] = [];
    importGame(await resources(), { onProgress: (_done, _total, what) => seen.push(what) });

    expect(seen[0]).toMatch(/^room \d+$/);
  });

  it('imports only the rooms asked for', async () => {
    const { project } = importGame(await resources(), { rooms: [1] });
    expect(project.rooms.map((room) => room.id)).toEqual([1]);
  });
});

describe('cel pixel order', () => {
  /**
   * Cels decode column-major, because that is the order the runs fill and the
   * order the renderer walks. Reading one as rows is what turns a sprite into
   * a blob of colour, so the conversion is worth pinning exactly.
   */
  const cel: Cel = {
    width: 3,
    height: 2,
    dataOffset: 0,
    relX: 0,
    relY: 0,
    moveX: 0,
    moveY: 0,
  };

  it('transposes a column-major cel into rows', () => {
    // Columns are (1,2), (3,4), (5,6) reading downward.
    const columnMajor = new Uint8Array([1, 2, 3, 4, 5, 6]);

    expect([...celToRowMajor(cel, columnMajor)]).toEqual([1, 3, 5, 2, 4, 6]);
  });

  it('round-trips a single column and a single row', () => {
    const column: Cel = { ...cel, width: 1, height: 4 };
    expect([...celToRowMajor(column, new Uint8Array([9, 8, 7, 6]))]).toEqual([9, 8, 7, 6]);

    const row: Cel = { ...cel, width: 4, height: 1 };
    expect([...celToRowMajor(row, new Uint8Array([9, 8, 7, 6]))]).toEqual([9, 8, 7, 6]);
  });
});

describe('exporting sprites and object art', () => {
  const gamePalette = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 3) % 256]);

  it('maps a costume colour through the actor palette', () => {
    const actor = {
      id: 1,
      name: 'Guard',
      talkColor: 11,
      walkSpeed: { x: 5, y: 2 },
      // Costume colour 1 is game colour 9, colour 2 is game colour 3.
      palette: [9, 3],
      handlers: [],
      otherwise: [],
      poses: [
        {
          all: [
            { image: storeImage({ width: 2, height: 1, pixels: new Uint8Array([1, 2]) }), hold: 6 },
          ],
        },
      ],
    };

    const rendered = renderSpriteCel(actor, 0, 0, gamePalette)!;

    expect([rendered.rgba[0], rendered.rgba[1], rendered.rgba[2]]).toEqual(gamePalette[9]);
    expect([rendered.rgba[4], rendered.rgba[5], rendered.rgba[6]]).toEqual(gamePalette[3]);
  });

  it('leaves costume colour 0 transparent', () => {
    const actor = {
      id: 1,
      name: 'Blank',
      talkColor: 11,
      walkSpeed: { x: 5, y: 2 },
      palette: [4],
      handlers: [],
      otherwise: [],
      // A single transparent pixel: nothing should be painted over it.
      poses: [
        {
          all: [
            { image: storeImage({ width: 1, height: 1, pixels: new Uint8Array([0]) }), hold: 6 },
          ],
        },
      ],
    };

    const rendered = renderSpriteCel(actor, 0, 0, gamePalette)!;
    expect(rendered.rgba[3]).toBe(0);
  });

  it('leaves object index 255 transparent and paints the rest', () => {
    const object = {
      id: 30,
      name: 'Door',
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      walkTo: { x: 0, y: 0 },
      facing: 'south' as const,
      initialState: 1,
      classes: [],
      handlers: [],
      otherwise: [],
      states: [storeImage({ width: 2, height: 1, pixels: new Uint8Array([255, 7]) })],
    };

    const rendered = renderObjectState(object, 0, gamePalette)!;

    expect(rendered.rgba[3]).toBe(0);
    expect(rendered.rgba[7]).toBe(255);
    expect([rendered.rgba[4], rendered.rgba[5], rendered.rgba[6]]).toEqual(gamePalette[7]);
  });

  it('returns nothing for a state or cel that does not exist', () => {
    const actor = {
      id: 1,
      name: 'Empty',
      talkColor: 11,
      walkSpeed: { x: 5, y: 2 },
      palette: [],
      poses: [],
      handlers: [],
      otherwise: [],
    };
    expect(renderSpriteCel(actor, 3, 0, gamePalette)).toBeNull();
  });

  it('names a sprite file after its actor, pose and cel', () => {
    const actor = {
      id: 2,
      name: 'Guard',
      talkColor: 11,
      walkSpeed: { x: 5, y: 2 },
      palette: [],
      poses: [],
      handlers: [],
      otherwise: [],
    };
    expect(spriteFilename(actor, 3, 0, 'My Game')).toBe('my-game-actor-2-guard-pose-3-cel-1.png');
  });
});

describe('a costume through the encoder and back', () => {
  /**
   * Built with the authoring encoder, read back with the engine's decoder.
   *
   * The fixture game's costume has no drawable cels, so nothing else here
   * exercises the path an imported sprite actually takes. A round trip does,
   * and it is the test that fails if cel pixels are read in the wrong order —
   * the artwork is deliberately not square, since a transpose of a square
   * survives a careless comparison.
   */
  const pixels = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const image = { width: 3, height: 4, pixels };

  function decodedCel() {
    const bytes = buildCostume({
      palette: Array.from({ length: 15 }, (_, i) => i + 1),
      colors: 16,
      frames: [{}, { all: { image, relX: 0, relY: -4 } }],
    });

    const costume = new Costume(1, new Uint8Array(bytes));
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 180, 1, 0xffff);

    const cel = getLimbCel(costume, cost, 0);
    expect(cel).not.toBeNull();
    return { costume, cel: cel! };
  }

  it('returns the pixels that went in, once rows are restored', () => {
    const { costume, cel } = decodedCel();

    expect(cel.width).toBe(3);
    expect(cel.height).toBe(4);
    expect([...celToRowMajor(cel, decodeCel(costume, cel))]).toEqual([...pixels]);
  });

  it('keeps the cel offset the encoder was given', () => {
    const { cel } = decodedCel();
    expect(cel.relY).toBe(-4);
  });
});

describe('which poses an imported costume keeps', () => {
  const image = {
    width: 2,
    height: 3,
    pixels: new Uint8Array([1, 2, 3, 4, 5, 6]),
  };

  /**
   * A costume with art on the init pose and on the standing pose.
   *
   * `numAnim` is rewritten to the last valid animation index, which is what a
   * published game stores and what the engine's own bound (`anim > numAnim`)
   * assumes. The authoring encoder writes a count instead — one higher — so a
   * costume straight out of it cannot show this bug at all.
   */
  function standingCostume() {
    const bytes = buildCostume({
      palette: Array.from({ length: 15 }, (_, i) => i + 1),
      colors: 16,
      frames: [{}, { all: { image } }, {}, { all: { image } }],
    });

    const data = new Uint8Array(bytes);
    expect(data[8]).toBe(16);
    data[8] = 15;
    return new Costume(1, data);
  }

  it('keeps the standing pose, which is what the engine draws when idle', () => {
    // The bound used to stop one frame short. A character with no cel for pose
    // 3 looks right in the sprite editor and is invisible in the game.
    const poses = importPoses(standingCostume());

    expect(poseHasArt(poses[3])).toBe(true);
  });

  it('keeps the init pose too', () => {
    expect(poseHasArt(importPoses(standingCostume())[1])).toBe(true);
  });

  /**
   * A limb bigger than any sprite could be is misread data, and the importer is
   * the only thing that would believe it: the renderer clips a cel to the
   * screen and never allocates one, while this composites every limb into a
   * buffer sized by their bounding box.
   *
   * Two of Sam & Max's costumes yield cels of 51579x5706 at offset 3072,4382 in
   * poses the game never asks for. Taking them at face value meant allocating
   * half a gigabyte per pose and spending twenty seconds on one costume — which
   * is why the import that "did nothing" appeared to do nothing.
   */
  it('leaves out a limb too big to be artwork rather than allocating for it', () => {
    const bytes = buildCostume({
      palette: Array.from({ length: 15 }, (_, i) => i + 1),
      colors: 16,
      frames: [{}, { all: { image } }],
    });
    const data = new Uint8Array(bytes);

    // Widen the one cel's header to something no sprite could be. The header is
    // width, height, relX, relY, moveX, moveY as 16-bit values.
    const costume = new Costume(1, data);
    const celAt = findCelHeader(data);
    data[celAt] = 0xff;
    data[celAt + 1] = 0xff;

    const started = Date.now();
    const poses = importPoses(costume);
    const spent = Date.now() - started;

    // No art, and — the point — no 65535-pixel-wide buffer to build it in.
    expect(poseHasArt(poses[1])).toBe(false);
    expect(spent).toBeLessThan(1000);
  });

  /**
   * The cel header follows the animation command stream, and its own width is
   * the first thing in it — so the encoder's known width is what identifies it.
   */
  function findCelHeader(data: Uint8Array): number {
    for (let at = 0; at + 12 < data.length; at++) {
      if (data[at] === image.width && data[at + 1] === 0 && data[at + 2] === image.height) {
        return at;
      }
    }
    throw new Error('the fixture costume has no cel header to widen');
  }
});
