// @vitest-environment jsdom
/**
 * A SCI room, derived and then edited.
 *
 * `docs/editor-parity.md` rows 5, 6 and 7 for this family, and ADR 0037's
 * claim that a room can be derived from the game rather than invented. The
 * decisions worth a test are the ones that would rot silently:
 *
 * - a room is found by its **class chain**, not by a naming convention on the
 *   script, and SCI ships the base class under two names across the family;
 * - the positions are the **authored** property words, signed, and a thing
 *   with only one coordinate is not placed;
 * - the draw order is the order things occlude in, and the hit test is its
 *   reverse — a room where the wrong thing answers a click is worse than one
 *   that answers nothing;
 * - a cel's **origin** is applied and its **size does not scale** with its
 *   position, which is the pair of rules this branch got wrong twice;
 * - a drag and a typed number write the same two words.
 *
 * Every fixture here is built in this file. Nothing reads a game.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SciEditor } from '../src/editor/sci/SciEditor.js';
import { pieceBounds, type SciRoomPiece } from '../src/editor/sci/SciRoomCanvas.js';
import { sciPropertyName, sciRooms, sciSignedWord } from '../src/authoring/sci/sciRooms.js';
import { createProject, type Project, type SciProject } from '../src/authoring/project.js';
import type { SciProjectObject } from '../src/authoring/project.js';

/** Selector numbering used by every fixture below, so a name is a number. */
const SELECTORS = [
  '-objID-',
  'x',
  'y',
  'view',
  'loop',
  'cel',
  'priority',
  'picture',
  'name',
  'approachX',
  'approachY',
];
const X = 1;
const Y = 2;
const VIEW = 3;
const LOOP = 4;
const CEL = 5;
const PRIORITY = 6;
const PICTURE = 7;
const APPROACH_X = 9;
const APPROACH_Y = 10;

function object(over: Partial<SciProjectObject> & { name: string }): SciProjectObject {
  return {
    isClass: false,
    species: 100,
    superClass: 100,
    variables: [],
    variableSelectors: [],
    variablesAt: { resource: 'heap', offset: 10 },
    methods: [],
    ...over,
  };
}

/** SCI's own room base class, under whichever name the release ships it. */
function roomClass(name: string, species = 82): SciProjectObject {
  return object({ name, isClass: true, species, superClass: 0xffff, variables: [], methods: [] });
}

function sci(overrides: Partial<SciProject> = {}): SciProject {
  return {
    identification: { how: 'probe', evidence: [] },
    version: 'sci1-1',
    selectors: SELECTORS,
    classes: [],
    scripts: [],
    resources: [],
    messages: [],
    vectorPictures: [],
    celPictures: [],
    languages: [],
    unrecoveredCount: 0,
    ...overrides,
  };
}

/** One room script: the base class, a room instance, and whatever it places. */
function roomScript(
  number: number,
  options: {
    picture?: number;
    things?: SciProjectObject[];
    baseName?: string;
  } = {},
): SciProject['scripts'][number] {
  const picture = options.picture ?? 0xffff;
  return {
    number,
    objects: [
      roomClass(options.baseName ?? 'Room'),
      object({
        name: `rm${number}`,
        superClass: 82,
        variables: [0, 0, 0, 0, 0, 0, 0, picture],
        variableSelectors: [0, X, Y, VIEW, LOOP, CEL, PRIORITY, PICTURE],
      }),
      ...(options.things ?? []),
    ],
    exports: [],
    locals: [],
    bytes: '',
  };
}

/** A thing the room places, named and positioned. */
function placed(
  name: string,
  x: number,
  y: number,
  over: { view?: number; loop?: number; cel?: number; priority?: number; movable?: boolean } = {},
): SciProjectObject {
  const thing = object({
    name,
    variables: [0, x, y, over.view ?? 0, over.loop ?? 0, over.cel ?? 0, over.priority ?? 0],
    variableSelectors: [0, X, Y, VIEW, LOOP, CEL, PRIORITY],
  });
  if (over.movable === false) delete thing.variablesAt;
  return thing;
}

describe('a SCI room, derived from the game', () => {
  it('finds a room by its class chain, under either name the family ships', () => {
    for (const baseName of ['Room', 'Rm']) {
      const rooms = sciRooms(sci({ scripts: [roomScript(30, { baseName, picture: 95 })] }));
      expect(rooms).toHaveLength(1);
      expect(rooms[0]).toMatchObject({ script: 30, name: 'rm30', picture: 95 });
    }
  });

  it('follows the chain through a subclass rather than only its immediate super', () => {
    // Almost every SCI game subclasses Room once and then puts its rooms under
    // that. A derivation that only looked one hop up would find no rooms at
    // all in such a game, and would find them in a game that did not bother.
    const project = sci({
      scripts: [
        {
          number: 40,
          objects: [
            roomClass('Room'),
            object({ name: 'KQRoom', isClass: true, species: 90, superClass: 82 }),
            object({
              name: 'rm40',
              superClass: 90,
              variables: [0, 0, 0, 0, 0, 0, 0, 12],
              variableSelectors: [0, X, Y, VIEW, LOOP, CEL, PRIORITY, PICTURE],
            }),
          ],
          exports: [],
          locals: [],
          bytes: '',
        },
      ],
    });
    expect(sciRooms(project).map((room) => room.name)).toEqual(['rm40']);
  });

  it('is not fooled by a script with no room in it', () => {
    const project = sci({
      scripts: [
        {
          number: 999,
          objects: [roomClass('Room'), object({ name: 'aProp', superClass: 47 })],
          exports: [],
          locals: [],
          bytes: '',
        },
      ],
    });
    expect(sciRooms(project)).toEqual([]);
  });

  it('reads the Picture from the room’s own property, and calls none none', () => {
    const none = sciRooms(sci({ scripts: [roomScript(20, { picture: 0xffff })] }))[0];
    expect(none.picture).toBeNull();
    expect(none.note).toContain('declares no Picture');

    const zero = sciRooms(sci({ scripts: [roomScript(21, { picture: 0 })] }))[0];
    expect(zero.picture).toBeNull();
  });

  it('places only the things that declare both coordinates', () => {
    const halfway = object({
      name: 'noY',
      variables: [0, 40],
      variableSelectors: [0, X],
    });
    const room = sciRooms(
      sci({
        scripts: [roomScript(30, { picture: 95, things: [placed('lamp', 10, 20), halfway] })],
      }),
    )[0];
    expect(room.things.map((thing) => thing.name)).toEqual(['lamp']);
  });

  it('reads a coordinate as a signed word, because a thing walks on from off-screen', () => {
    expect(sciSignedWord(0xffa6)).toBe(-90);
    expect(sciSignedWord(90)).toBe(90);
    const room = sciRooms(
      sci({ scripts: [roomScript(30, { things: [placed('ego', 0xffa6, 120)] })] }),
    )[0];
    expect(room.things[0].x).toBe(-90);
  });

  it('orders things the way they occlude: priority, then the order declared', () => {
    const room = sciRooms(
      sci({
        scripts: [
          roomScript(30, {
            things: [
              placed('behind', 1, 1, { priority: 1 }),
              placed('sameA', 2, 2, { priority: 5 }),
              placed('sameB', 3, 3, { priority: 5 }),
              placed('front', 4, 4, { priority: 9 }),
            ],
          }),
        ],
      }),
    )[0];
    expect(room.things.map((thing) => thing.name)).toEqual(['behind', 'sameA', 'sameB', 'front']);
  });

  it('treats View 0 and View none as no View rather than as the game’s View 0', () => {
    const room = sciRooms(
      sci({
        scripts: [
          roomScript(30, {
            things: [
              placed('undeclared', 1, 1, { view: 0 }),
              placed('none', 2, 2, { view: 0xffff }),
              placed('real', 3, 3, { view: 930 }),
            ],
          }),
        ],
      }),
    )[0];
    expect(room.things.map((thing) => thing.view)).toEqual([null, null, 930]);
  });

  it('marks a thing unmovable when its property words have no recorded home', () => {
    const room = sciRooms(
      sci({
        scripts: [
          roomScript(30, {
            things: [placed('fixed', 1, 1, { movable: false }), placed('free', 2, 2)],
          }),
        ],
      }),
    )[0];
    expect(room.things.map((thing) => thing.movable)).toEqual([false, true]);
    expect(room.note).toContain('cannot be moved');
  });

  it('derives from a SCI3 script, where no method body was disassembled at all', () => {
    // The point of the row: a room is made of property words, not of code, so
    // it survives the one Version where `importSciGame` emits `methods: []`.
    const script = roomScript(30, { picture: 12, things: [placed('door', 50, 60)] });
    for (const one of script.objects) {
      one.methods = [];
      one.variablesAt = { resource: 'code', offset: 24 };
    }
    const room = sciRooms(sci({ version: 'sci3', scripts: [script] }))[0];
    expect(room.picture).toBe(12);
    expect(room.things[0]).toMatchObject({ name: 'door', x: 50, y: 60, movable: true });
  });

  it('reads SCI0 early’s doubled Selector ids, which are twice the shipped index', () => {
    // SCI0 early spent the low bit of a Selector id on a read/write toggle, so
    // an id read raw names the property two slots along — `x` comes out as
    // whatever Selector 2 is. Read raw, this room places nothing at all.
    const script = roomScript(30, { things: [placed('lamp', 10, 20)] });
    for (const one of script.objects) {
      one.variableSelectors = one.variableSelectors.map((id) => id * 2);
    }
    const project = sci({ version: 'sci0-early', scripts: [script] });
    expect(sciPropertyName(script.objects[2], 1, project)).toBe('x');
    expect(sciRooms(project)[0].things[0]).toMatchObject({ name: 'lamp', x: 10, y: 20 });
  });
});

describe('what a piece covers on the canvas', () => {
  const cel = {
    width: 160,
    height: 60,
    displaceX: 79,
    displaceY: 59,
    clearKey: 255,
    pixels: new Uint8Array(160 * 60),
  };

  function piece(x: number, y: number, withArt = true): SciRoomPiece {
    return {
      thing: {
        objectIndex: 0,
        name: 'button',
        x,
        y,
        xProperty: 1,
        yProperty: 2,
        view: 930,
        loop: 0,
        cel: 0,
        approach: null,
        priority: 0,
        movable: true,
      },
      cel: withArt ? cel : null,
      celResolution: null,
      image: null,
      why: null,
    };
  }

  /**
   * **A cel is measured against the resolution it was drawn for, never against
   * the Picture it stands on.** Those are the same number only when the two
   * agree, and in King's Quest VII they never do: its cast is drawn at 320x200
   * and its rooms at 640x480. Scaling a cast cel by the canvas ratio halves it
   * *and* halves its origin, so the thing is both too small and in the wrong
   * place — which is an owner's report that the images in a room do not line
   * up.
   *
   * A View declaring no resolution was drawn for the script's own space, so
   * its pixels are already script pixels and nothing is divided. That is the
   * engine's rule too (`celResolution` answers the script's space when a View
   * says nothing), and this is the canvas agreeing with it.
   */
  it('measures a cel against its own resolution, not the Picture it stands on', () => {
    // 640x480 over a 320x200 script space, which is King's Quest VII.
    const scale = { x: 2, y: 2.4 };

    // No declared resolution: the cel's pixels are the script's pixels.
    const asScript = pieceBounds(piece(100, 120), scale);
    // celOrigin: x = (160 >> 1) - 79 = 1, y = 60 - 59 - 1 = 0.
    expect(asScript.x).toBeCloseTo(99);
    expect(asScript.y).toBeCloseTo(120);
    expect(asScript.width).toBeCloseTo(160);
    expect(asScript.height).toBeCloseTo(60);

    // Drawn for 640x480, which is the room's own space: halved into the
    // script's, origin and size together.
    const hiRes = { ...piece(100, 120), celResolution: { width: 640, height: 480 } };
    const asRoom = pieceBounds(hiRes, scale);
    expect(asRoom.x).toBeCloseTo(100 - 0.5);
    expect(asRoom.y).toBeCloseTo(120);
    expect(asRoom.width).toBeCloseTo(80);
    expect(asRoom.height).toBeCloseTo(25);
  });

  it('gives a thing with no art a marker to be clicked on rather than nothing', () => {
    const bounds = pieceBounds(piece(100, 120, false), { x: 2, y: 2.4 });
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.x).toBeLessThan(100);
  });

  it('follows a drag rather than the stored position while one is in progress', () => {
    const bounds = pieceBounds(piece(100, 120), { x: 1, y: 1 }, { x: 10, y: 20 });
    expect(bounds.x).toBeCloseTo(10 - 1);
    expect(bounds.y).toBeCloseTo(20);
  });
});

// ------------------------------------------------------- the editor surface --

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: () => {},
      drawImage: () => {},
      clearRect: () => {},
      fillRect: () => {},
      strokeRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      setLineDash: () => {},
      save: () => {},
      restore: () => {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
    } as unknown as CanvasRenderingContext2D;
  } as never);
}

function projectWithRooms(): Project {
  const project = createProject('a sci game');
  project.target = { engine: 'sci', version: 'sci1-1' } as Project['target'];
  project.sci = sci({
    scripts: [
      roomScript(30, {
        picture: 95,
        things: [placed('lamp', 40, 120), placed('fixed', 10, 10, { movable: false })],
      }),
      roomScript(31, { picture: 0xffff }),
    ],
    resources: [{ type: 'vocab', number: 997, bytes: '' }],
  });
  return project;
}

describe('the room surface in the editor', () => {
  beforeEach(() => {
    stubCanvas();
    window.localStorage.clear();
  });

  function mount(project: Project): { editor: SciEditor; text: () => string } {
    const editor = new SciEditor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    return { editor, text: () => editor.element.textContent ?? '' };
  }

  it('lists the rooms it derived, with what each places', () => {
    const { text } = mount(projectWithRooms());
    expect(text()).toContain('Rooms');
    expect(text()).toContain('rm30 · 2 placed');
  });

  it('opens a room on a canvas, and says these are the shipped positions', () => {
    const { editor, text } = mount(projectWithRooms());
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('rm30'))!
      .click();

    expect(editor.element.querySelector('canvas.sci-room-surface')).not.toBeNull();
    expect(text()).toContain('Room 30 · rm30');
    // The promise the surface must not overstate.
    expect(text()).toContain('positions the resource ships');
  });

  it('writes both coordinate words when one is typed', () => {
    const project = projectWithRooms();
    const { editor } = mount(project);
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('rm30'))!
      .click();

    const field = [...editor.element.querySelectorAll('input')].find(
      (input) => input.getAttribute('aria-label') === 'x of lamp in room 30',
    ) as HTMLInputElement;
    field.value = '-90';
    field.dispatchEvent(new Event('change'));

    const lamp = project.sci!.scripts[0].objects[2];
    // Two's complement, because a property is a word and the thing walked off
    // the left of the screen.
    expect(lamp.variables[1]).toBe(0xffa6);
    // And the coordinate that was not typed is untouched rather than zeroed.
    expect(lamp.variables[2]).toBe(120);
  });

  it('refuses a coordinate that does not fit in a property word', () => {
    const project = projectWithRooms();
    const { editor } = mount(project);
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('rm30'))!
      .click();

    const field = [...editor.element.querySelectorAll('input')].find(
      (input) => input.getAttribute('aria-label') === 'x of lamp in room 30',
    ) as HTMLInputElement;
    field.value = '70000';
    field.dispatchEvent(new Event('change'));

    expect(project.sci!.scripts[0].objects[2].variables[1]).toBe(40);
  });

  it('shows a thing it cannot move as a number rather than as a field that does nothing', () => {
    const { editor } = mount(projectWithRooms());
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('rm30'))!
      .click();

    const fields = [...editor.element.querySelectorAll('input')].map((input) =>
      input.getAttribute('aria-label'),
    );
    expect(fields).toContain('x of lamp in room 30');
    expect(fields).not.toContain('x of fixed in room 30');
  });

  it('says why a room has no backdrop instead of drawing a black rectangle', () => {
    const { editor, text } = mount(projectWithRooms());
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('rm31'))!
      .click();
    expect(text()).toContain('names no Picture');
  });
});

/**
 * Row 8: a thing's walk-to point, which is not a room's walkable area.
 *
 * The row's No said only that a SCI walk *target* is a `Polygon` a room builds
 * as it runs. That is true of a room's walkable **area** and is a different
 * question. A **thing's** walk-to point — where a script sends the ego before
 * acting on it — is two property words on the instance, `approachX` and
 * `approachY`, in the same place and of the same kind as the `x` and `y` the
 * canvas already drags.
 */
describe("a thing's walk-to point is two property words", () => {
  /** A room placing one thing, given whichever approach words are named. */
  function withApproach(over: { x?: number; y?: number }) {
    const variables = [0, 20, 30, 0, 0, 0, 0];
    const variableSelectors = [0, X, Y, VIEW, LOOP, CEL, PRIORITY];
    if (over.x !== undefined) {
      variables.push(over.x);
      variableSelectors.push(APPROACH_X);
    }
    if (over.y !== undefined) {
      variables.push(over.y);
      variableSelectors.push(APPROACH_Y);
    }
    const thing = object({ name: 'door', variables, variableSelectors });
    return sciRooms(sci({ scripts: [roomScript(30, { picture: 95, things: [thing] })] }));
  }

  it('reads both words, signed, where the object declares them', () => {
    const [room] = withApproach({ x: 0xfff0, y: 120 });
    expect(room.things[0].approach).toMatchObject({ x: -16, y: 120 });
  });

  /**
   * Null and "the point is 0, 0" are different facts. 345 of King's Quest
   * VII's 929 walk-to points are genuinely 0, 0 — a thing an author walks to
   * the origin of — and an object that declares neither word has no point at
   * all.
   */
  it('answers null where the object declares neither word', () => {
    const [room] = withApproach({});
    expect(room.things[0].approach).toBeNull();
  });

  it('needs both words, because half a point is a number the game never reads', () => {
    const [room] = withApproach({ x: 40 });
    expect(room.things[0].approach).toBeNull();
  });
});
