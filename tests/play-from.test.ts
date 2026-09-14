import { describe, expect, it } from 'vitest';
import { rectangleBox } from '../src/authoring/GameBuilder.js';
import { storeImage } from '../src/authoring/imageCodec.js';
import { createProject, type ProjectRoom } from '../src/authoring/project.js';
import { playableStart, startPointIn } from '../src/editor/playFrom.js';

function room(id: number, boxes: ProjectRoom['boxes'] = [], height = 144): ProjectRoom {
  return {
    id,
    name: `Room ${id}`,
    width: 320,
    height,
    background: storeImage({ width: 1, height: 1, pixels: new Uint8Array([0]) }),
    zPlanes: [],
    boxes,
    objects: [],
    onEnter: [],
    onExit: [],
  };
}

describe('playing the room being edited', () => {
  it('starts in the selected room rather than the game start room', () => {
    const project = createProject('Game');
    project.rooms.push(room(1), room(14, [rectangleBox(0, 100, 320, 40)]));
    project.start = { room: 1, x: 10, y: 20 };

    const played = playableStart(project, project.rooms[1]);

    expect(played.start.room).toBe(14);
  });

  it('leaves the project itself alone', () => {
    const project = createProject('Game');
    project.rooms.push(room(1), room(9, [rectangleBox(0, 100, 320, 40)]));
    project.start = { room: 1, x: 10, y: 20 };

    playableStart(project, project.rooms[1]);

    // Playing a room must not rewrite where the finished game begins.
    expect(project.start).toEqual({ room: 1, x: 10, y: 20 });
  });

  it('stands the player inside a walk box', () => {
    const point = startPointIn(room(2, [rectangleBox(40, 100, 80, 20)]));

    expect(point).toEqual({ x: 80, y: 110 });
  });

  it('skips a blocked box, which nobody can stand in', () => {
    const boxes = [rectangleBox(0, 0, 20, 10, { blocked: true }), rectangleBox(100, 120, 40, 20)];

    // The box runs to row 139, but the view ends at 127: the middle of the box
    // is behind the verb panel, so the player stands on the last visible row.
    expect(startPointIn(room(3, boxes))).toEqual({ x: 120, y: 127 });
  });

  it('falls back to low and central when a room has no boxes', () => {
    // Low in the 128 rows of room the player can see, not in the 144 rows
    // above the verbs — the text band sits between the two.
    expect(startPointIn(room(4))).toEqual({ x: 160, y: 102 });
  });

  it('keeps the player inside the visible rows of a full-height room', () => {
    // An imported room keeps the published game's height, often the full 200,
    // while the view shows only the top 128. Starting from the room's own
    // height put the player behind the verb panel, where actors are clipped
    // away entirely: the room drew and the character was simply absent.
    const tall = room(5, [], 200);

    expect(startPointIn(tall).y).toBeLessThan(128);
  });

  it('will not start the player in a box that is out of sight', () => {
    // The floor the importer invents for a box-less room used to sit across
    // the bottom of the room, which for a 200-high room is behind the verbs.
    const belowTheVerbs = room(6, [rectangleBox(0, 176, 320, 24)], 200);

    expect(startPointIn(belowTheVerbs).y).toBeLessThan(128);
  });

  it('prefers a box that reaches the visible rows over the first one listed', () => {
    const boxes = [rectangleBox(0, 176, 320, 24), rectangleBox(40, 100, 80, 20)];

    expect(startPointIn(room(7, boxes, 200))).toEqual({ x: 80, y: 110 });
  });

  it('honours a project that moved its verb line', () => {
    const project = createProject('Game');
    project.screen = { textHeight: 16, verbTop: 100 };
    project.rooms.push(room(3, [rectangleBox(0, 110, 320, 30)], 200));

    // 84 rows of room, not 100: the verb line moved, the text band did not.
    expect(playableStart(project, project.rooms[0]).start.y).toBeLessThan(84);
  });

  it('changes nothing when no room is selected', () => {
    const project = createProject('Game');
    expect(playableStart(project, null)).toBe(project);
  });
});

describe('a room whose box list is not all floor', () => {
  /** A box parked at the coordinates SCUMM uses to put things out of sight. */
  const offScreenBox = { ...rectangleBox(-32000, -32000, 16, 16) };

  it('does not start the player on a box that is off screen', () => {
    // A published game's box list carries degenerate boxes, and one of those
    // is an ordinary unblocked box as far as a filter on `blocked` can tell.
    // Picking one gave a start point of -31999, which Play then applied — and
    // went on applying, putting the player back exactly where they could not
    // be seen.
    const floor = rectangleBox(40, 90, 200, 30);
    const start = startPointIn(room(1, [offScreenBox, floor]));

    // Standing on the floor box, not merely clamped back into the room from
    // somewhere impossible.
    expect(start.x).toBeGreaterThanOrEqual(40);
    expect(start.x).toBeLessThan(240);
    expect(start.y).toBeGreaterThanOrEqual(90);
    expect(start.y).toBeLessThan(120);
  });

  it('falls back to the middle of the room when no box is usable', () => {
    const start = startPointIn(room(1, [offScreenBox]));

    expect(start.x).toBe(160);
    expect(start.y).toBeGreaterThan(0);
    expect(start.y).toBeLessThan(128);
  });

  it('still keeps the player inside the room horizontally', () => {
    const wide = { ...rectangleBox(300, 90, 400, 30) };
    const start = startPointIn(room(1, [wide]));

    expect(start.x).toBeLessThan(320);
  });
});
