import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { rectangleBox } from '../src/authoring/GameBuilder.js';
import { storeImage } from '../src/authoring/imageCodec.js';
import { createImage } from '../src/authoring/ImageEncoder.js';
import {
  anyPoseCels,
  createProject,
  visibleRoomRows,
  type Project,
  type ProjectRoom,
  type SpriteCel,
} from '../src/authoring/project.js';
import { buildProject } from '../src/authoring/projectToGame.js';
import { playableStart } from '../src/editor/playFrom.js';

const ART_WIDTH = 12;
const ART_HEIGHT = 20;

/** A cel of a known size, in a costume colour that always draws. */
function cel(width = ART_WIDTH, height = ART_HEIGHT): SpriteCel {
  return { image: storeImage(createImage(width, height, 1)), hold: 6 };
}

function room(id: number, height = 144, boxes = [rectangleBox(0, 100, 320, 28, { scale: 255 })]) {
  const background = createImage(320, height, 4);
  return {
    id,
    name: `room${id}`,
    width: 320,
    height,
    background: storeImage(background),
    zPlanes: [],
    boxes,
    objects: [],
    onEnter: [],
    onExit: [],
  } satisfies ProjectRoom;
}

/**
 * How many screen pixels the player contributes.
 *
 * The room is rendered twice, once with the player hidden, because "is the
 * character on screen" is the actual question — an actor the engine considers
 * placed and visible can still be clipped away to nothing.
 */
async function playerPixels(project: Project): Promise<number> {
  const built = buildProject(playableStart(project, project.rooms[0]));
  expect(built.errors).toEqual([]);

  const source = new MemoryDataSource('preview');
  source.set('PREVIEW.000', built.index);
  source.set('PREVIEW.001', built.data);

  const engine = await ScummEngine.create(source, {});
  engine.boot(0);
  for (let step = 0; step < 5; step++) engine.step();

  engine.render();
  const drawn = Uint8Array.from(engine.screen.pixels);
  engine.actors[project.actors[0].id].visible = false;
  engine.render();

  let differing = 0;
  for (let i = 0; i < drawn.length; i++) {
    if (engine.screen.pixels[i] !== drawn[i]) differing++;
  }
  return differing;
}

describe('a character the editor draws but the game does not', () => {
  it('finds artwork stored per direction, not only shared artwork', () => {
    // What an imported costume looks like: four genuinely different views and
    // no shared drawing at all.
    expect(anyPoseCels({ west: [cel()], east: [cel()] })).toHaveLength(1);
    // Shared artwork still wins when there is some.
    const shared = cel(4, 4);
    expect(anyPoseCels({ all: [shared], west: [cel()] })[0].image).toEqual(shared.image);
    expect(anyPoseCels({})).toEqual([]);
    expect(anyPoseCels(undefined)).toEqual([]);
  });

  it('draws a costume whose only artwork is per-direction', async () => {
    const project = createProject('Imported');
    project.rooms.push(room(1));
    // An imported costume, in shape: art under directions, none shared, and
    // none at all in the poses the engine draws (1-5). Every one of those used
    // to compile to an 8x16 placeholder block, so the cast of an imported game
    // was a set of small coloured rectangles.
    project.actors[0].poses = [{ west: [cel()], east: [cel()] }];

    expect(await playerPixels(project)).toBe(ART_WIDTH * ART_HEIGHT);
  });

  it('still has something to draw for a character with no artwork anywhere', async () => {
    const project = createProject('Blank');
    project.rooms.push(room(1));

    expect(await playerPixels(project)).toBeGreaterThan(0);
  });
});

describe('the rows of a room the player can actually see', () => {
  it('is the room view, not the screen row the verbs start at', () => {
    // The text band sits above the room view, so the two differ by its height.
    expect(visibleRoomRows({ textHeight: 16, verbTop: 144 })).toBe(128);
    expect(visibleRoomRows({ textHeight: 0, verbTop: 144 })).toBe(144);
    expect(visibleRoomRows()).toBe(128);
  });

  it('draws the whole player in a room taller than the view', async () => {
    const project = createProject('Tall');
    // A published room is often the full 200 rows with its floor low down.
    project.rooms.push(room(1, 200, [rectangleBox(0, 120, 320, 24, { scale: 255 })]));
    project.actors[0].poses = [{}, {}, {}, { all: [cel()] }];

    // Not "some of it": every pixel, or the character is standing in the band
    // behind the verb panel with its feet cut off.
    expect(await playerPixels(project)).toBe(ART_WIDTH * ART_HEIGHT);
  });
});
