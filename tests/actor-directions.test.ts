import { describe, expect, it } from 'vitest';
import {
  createProject,
  definedFacings,
  migrate,
  poseCels,
  poseHasArt,
  PROJECT_VERSION,
  type ProjectRoom,
  type SpriteCel,
  type SpritePose,
} from '../src/authoring/project.js';
import { buildProject } from '../src/authoring/projectToGame.js';
import { rectangleBox } from '../src/authoring/GameBuilder.js';
import { storeImage } from '../src/authoring/imageCodec.js';
import { createImage } from '../src/authoring/ImageEncoder.js';
import { defaultSpriteFrames } from '../src/editor/SpriteCanvas.js';

const cel = (color: number): SpriteCel => ({
  image: storeImage(createImage(8, 16, color)),
  hold: 6,
});

/** A room a project needs before it will compile at all. */
function roomFor(): ProjectRoom {
  return {
    id: 1,
    name: 'Room',
    width: 320,
    height: 144,
    background: storeImage(createImage(320, 144, 1)),
    zPlanes: [],
    boxes: [rectangleBox(0, 100, 320, 40, { scale: 255 })],
    objects: [],
    onEnter: [],
    onExit: [],
  };
}

describe('a pose that can differ by direction', () => {
  it('falls back to the shared artwork for a direction with none of its own', () => {
    const pose: SpritePose = { all: [cel(1)], north: [cel(2)] };

    expect(poseCels(pose, 'north')).toHaveLength(1);
    expect(poseCels(pose, 'north')[0].image).toEqual(pose.north?.[0].image);
    // West has no drawing of its own, so it uses the shared one rather than
    // being blank — a character must not vanish when it turns.
    expect(poseCels(pose, 'west')[0].image).toEqual(pose.all?.[0].image);
  });

  it('reports an empty pose as empty for every facing', () => {
    expect(poseHasArt({})).toBe(false);
    expect(poseCels({}, 'south')).toEqual([]);
    expect(poseCels(undefined, 'all')).toEqual([]);
  });

  it('lists only the facings that have their own artwork', () => {
    expect(definedFacings({ all: [cel(1)], east: [cel(2)] })).toEqual(['all', 'east']);
    expect(definedFacings({ west: [] })).toEqual([]);
  });
});

describe('upgrading a project that predates directions', () => {
  it('turns one list of cels into the shared artwork', () => {
    // Version 4 held a single list per pose, drawn whichever way the character
    // faced — which is exactly what `all` means, so nothing is lost.
    const old = {
      ...createProject('Old'),
      version: 4,
      actors: [{ ...createProject().actors[0], poses: [[], [cel(1), cel(2)]] }],
    } as unknown;

    const upgraded = migrate(old);

    expect(upgraded.version).toBe(PROJECT_VERSION);
    expect(upgraded.actors[0].poses[0]).toEqual({});
    expect(upgraded.actors[0].poses[1].all).toHaveLength(2);
  });

  it('leaves a project that already has directions alone', () => {
    const project = createProject('New');
    project.actors[0].poses = [{}, { north: [cel(3)] }];

    expect(migrate(JSON.parse(JSON.stringify(project))).actors[0].poses[1].north).toHaveLength(1);
  });
});

describe('the cel budget four directions have to fit inside', () => {
  it('shares one entry between directions drawn the same way', () => {
    // The crash this guards against: importing four directions multiplied the
    // artwork by four, and a costume holding 120 cels ran out of room for
    // pictures it did not actually have — taking the whole editor down on
    // every render, because the status bar rebuilds the project each time.
    const project = createProject('Budget');
    project.rooms.push(roomFor());
    project.actors[0].poses = Array.from({ length: 6 }, () => ({
      all: Array.from({ length: 8 }, (_, i) => cel((i % 15) + 1)),
    }));

    expect(buildProject(project).errors).toEqual([]);
  });

  it('still refuses a costume that genuinely has too many pictures', () => {
    const project = createProject('Too many');
    project.rooms.push(roomFor());
    project.actors[0].poses = [
      {},
      { all: [cel(1)] },
      {
        all: Array.from({ length: 200 }, (_, i) => {
          const image = createImage(8, 16, 1);
          image.pixels[i % image.pixels.length] = (i % 15) + 2;
          image.pixels[(i * 7) % image.pixels.length] = (i % 13) + 2;
          return { image: storeImage(image), hold: 6 };
        }),
      },
      { all: [cel(1)] },
      { all: [cel(1)] },
      { all: [cel(1)] },
    ];

    expect(buildProject(project).errors.join(' ')).toMatch(/at most/);
  });
});

describe('compiling directional poses', () => {
  /** A playable project whose player has artwork in every pose. */
  function project() {
    const built = createProject('Directions');
    built.rooms.push(roomFor());
    built.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));
    return built;
  }

  it('compiles a project whose poses are all shared, as before', () => {
    expect(buildProject(project()).errors).toEqual([]);
  });

  it('compiles a pose that has its own artwork per direction', () => {
    const built = project();
    built.actors[0].poses[2] = {
      north: [cel(1), cel(2)],
      south: [cel(3), cel(4)],
      east: [cel(5)],
      west: [cel(6)],
    };

    const compiled = buildProject(built);
    expect(compiled.errors).toEqual([]);
    expect(compiled.data.length).toBeGreaterThan(0);
  });

  it('still draws something for a direction the author never touched', () => {
    // A pose with art for one direction only must not leave the actor
    // invisible for the other three.
    const built = project();
    built.actors[0].poses[2] = { east: [cel(5)] };

    expect(buildProject(built).errors).toEqual([]);
  });

  it('writes each direction own drawing into the costume', () => {
    const oneDrawing = project();
    oneDrawing.actors[0].poses[2] = { all: [cel(1)] };

    const fourDrawings = project();
    fourDrawings.actors[0].poses[2] = {
      north: [cel(1)],
      south: [cel(2)],
      east: [cel(3)],
      west: [cel(4)],
    };

    const shared = buildProject(oneDrawing).data;
    const directional = buildProject(fourDrawings).data;

    // Four different pictures are four entries; one picture used for all four
    // directions is a single entry that the four animations share.
    expect(directional.length).toBeGreaterThan(shared.length);
  });
});
