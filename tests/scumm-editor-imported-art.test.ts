// @vitest-environment jsdom
/**
 * The SCUMM editor showing an imported game's art, and handing it back out.
 *
 * Three faults stood between a decompiled SCUMM game and its pictures, and
 * each passed every test that looked at the import alone — the project held
 * all of the art, and the editor simply did not show it:
 *
 * - opening a SCUMM project after any other family left the centre column
 *   empty, because every other surface mounts by replacing it and nothing put
 *   the room, sprite and object canvases back;
 * - the player sprite opened blank, because the sprite canvas chose a facing
 *   for actor 1 of the project the editor started on and kept it for actor 1
 *   of the imported one, whose art is all per-direction;
 * - exporting that sprite always refused with "no cel", because the export
 *   asked for the shared drawing whatever facing was on screen.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { storeImage } from '../src/authoring/imageCodec.js';
import { createImage } from '../src/authoring/ImageEncoder.js';
import { createProject, type Project, type SpriteCel } from '../src/authoring/project.js';
import { renderSpriteCel, spriteFilename } from '../src/editor/imageExport.js';
import { SpriteCanvas } from '../src/editor/SpriteCanvas.js';
import { EditorState } from '../src/editor/state.js';

/** Source with comments stripped, so a test reads code rather than prose. */
function readCode(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

const cel = (width: number, height: number, color: number): SpriteCel => ({
  image: storeImage(createImage(width, height, color)),
  hold: 6,
});

/**
 * A project shaped like a decompiled game: actor 1 wears a costume whose four
 * views all differ, so every direction is drawn and the shared `all` is empty.
 */
function importedProject(): Project {
  const project = createProject('atlantis');
  const standing = {
    west: [cel(17, 49, 1)],
    east: [cel(17, 49, 2)],
    south: [cel(17, 49, 3)],
    north: [cel(17, 49, 4)],
  };
  project.actors = [
    {
      id: 1,
      name: 'Costume 1',
      talkColor: 11,
      walkSpeed: { x: 5, y: 2 },
      costumeId: 1,
      palette: [10, 20, 30, 40],
      poses: [{}, {}, {}, standing],
      handlers: [],
      otherwise: [],
    },
  ];
  return project;
}

beforeAll(() => {
  // jsdom has no 2D context. The sprite canvas only needs one to exist here;
  // what is under test is which cels it chooses, not how it paints them.
  HTMLCanvasElement.prototype.getContext = (() => ({})) as never;
});

describe('the player sprite of a project that arrives after the editor opened', () => {
  it('shows a drawn facing, not the empty shared one', () => {
    // The editor's own start-up project: a hand-drawn actor 1 on `all`.
    const state = new EditorState(createProject('My Game'));
    const sprite = new SpriteCanvas(state);
    sprite.actorId = 1;
    expect(sprite.facing).toBe('all');

    // The decompiled game arrives from IndexedDB, with an actor 1 of its own.
    state.replaceProject(importedProject());
    sprite.actorId = state.selected.actorId;

    expect(sprite.facing).not.toBe('all');
    expect(sprite.cels).toHaveLength(1);
    expect(sprite.cels[0].image.width).toBe(17);
  });

  it('keeps a facing the author picked while the project stays the same', () => {
    const state = new EditorState(importedProject());
    const sprite = new SpriteCanvas(state);
    sprite.actorId = 1;
    sprite.facing = 'north';

    // An ordinary edit mutates the same project, and the same actor is
    // selected again on every render: the choice must survive both.
    state.update((project) => {
      project.actors[0].name = 'Indy';
    });
    sprite.actorId = 1;

    expect(sprite.facing).toBe('north');
  });
});

describe('exporting the sprite on screen', () => {
  const palette = Array.from({ length: 256 }, (_, index) => [index, index, index]);

  it('renders the facing it is given', () => {
    const actor = importedProject().actors[0];
    expect(renderSpriteCel(actor, 3, 0, palette)).toBeNull();

    const west = renderSpriteCel(actor, 3, 0, palette, 'west');
    expect(west).not.toBeNull();
    expect(west!.width).toBe(17);
    // Costume colour 1 through the actor's palette to game colour 10.
    expect([...west!.rgba.slice(0, 4)]).toEqual([10, 10, 10, 255]);
  });

  it('names the facing in the file, unless it is the shared drawing', () => {
    const actor = importedProject().actors[0];
    expect(spriteFilename(actor, 3, 0, 'atlantis', 'west')).toBe(
      'atlantis-actor-1-costume-1-pose-3-west-cel-1.png',
    );
    expect(spriteFilename(actor, 3, 0, 'atlantis')).toBe(
      'atlantis-actor-1-costume-1-pose-3-cel-1.png',
    );
  });

  it('is asked for the facing the sprite canvas shows', () => {
    const code = readCode('src/editor/main.ts');
    const call = code.slice(code.indexOf('void exportSpriteCel('));
    expect(call.slice(0, call.indexOf(').catch'))).toMatch(/sprite\.facing/);
  });
});

describe('the SCUMM surface after another family held the centre column', () => {
  it('puts its panes back before rendering into them', () => {
    const code = readCode('src/editor/main.ts');
    const renderAll = code.slice(code.indexOf('function renderAll'));
    const scummBranch = renderAll.slice(renderAll.indexOf('return;'));
    expect(scummBranch.indexOf('mountScummSurface()')).toBeGreaterThan(-1);
    expect(scummBranch.indexOf('mountScummSurface()')).toBeLessThan(
      scummBranch.indexOf('renderTabs()'),
    );

    const mount = code.slice(code.indexOf('function mountScummSurface'));
    expect(mount.slice(0, mount.indexOf('\n}'))).toMatch(
      /centre\.replaceChildren\(\.\.\.scummCentre\)/,
    );
  });
});
