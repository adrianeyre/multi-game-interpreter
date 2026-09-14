import { describe, expect, it } from 'vitest';
import { rectangleBox } from '../src/authoring/GameBuilder.js';
import { storeImage } from '../src/authoring/imageCodec.js';
import { buildProject } from '../src/authoring/projectToGame.js';
import { createProject, type ProjectRoom } from '../src/authoring/project.js';

/**
 * A room the size of a real one, with art that does not compress away.
 *
 * Authored rooms are small and flat-shaded, so the compiler was only ever fed
 * payloads of a few kilobytes. A room decompiled from a published game is
 * hundreds of kilobytes of varied pixels, and appending it by spreading the
 * bytes as call arguments hit the argument limit — reported as "Maximum call
 * stack size exceeded", which says nothing about size being the problem.
 */
function busyRoom(id: number, width: number, height: number): ProjectRoom {
  const pixels = new Uint8Array(width * height);
  // Deliberately noisy: a flat fill would run-length encode to almost nothing
  // and never reach the size that broke.
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7 + (i >> 5)) & 0xff;

  return {
    id,
    name: `Room ${id}`,
    width,
    height,
    background: storeImage({ width, height, pixels }),
    zPlanes: [],
    boxes: [rectangleBox(0, height - 20, width, 20, { scale: 255 })],
    objects: [],
    onEnter: [],
    onExit: [],
  };
}

describe('compiling a game the size of a published one', () => {
  it('compiles a full-size room without blowing the stack', () => {
    const project = createProject('Large');
    project.rooms.push(busyRoom(1, 640, 480));
    project.start = { room: 1, x: 100, y: 120 };

    const built = buildProject(project);

    expect(built.errors).toEqual([]);
    expect(built.data.length).toBeGreaterThan(300_000);
  });

  it('compiles several large rooms at once', () => {
    const project = createProject('Larger');
    for (let id = 1; id <= 4; id++) project.rooms.push(busyRoom(id, 320, 144));
    project.start = { room: 1, x: 100, y: 120 };

    const built = buildProject(project);

    expect(built.errors).toEqual([]);
    expect(built.stats.rooms).toBe(4);
  });
});
