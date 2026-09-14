/**
 * A SCI walk polygon, read out of the code that builds it.
 *
 * `docs/editor-parity.md` row 11. The No there said the true half — a SCI
 * walkable area is not a resource — and stopped one step short: from SCI2 a
 * room builds `Polygon` objects **in its own `init`, from literal operands**,
 * and that instruction stream is already decoded by this project. It is the
 * same shape as Broken Sword II's mouse boxes (7a), and the same rule applies
 * to what is refused: a coordinate that is computed rather than written is no
 * number an author can move, and it is refused by name rather than guessed at.
 *
 * Tier 1 throughout — the fixture is transcribed from King's Quest VII's own
 * `pyramidDoor`, whose stream is quoted in `sciPolygons.ts`.
 */

import { describe, expect, it } from 'vitest';

import { describeSciPolygons, sciPolygons } from '../src/authoring/sci/sciPolygons.js';
import { createProject, type Project, type SciProject } from '../src/authoring/project.js';

const SELECTORS = ['-objID-', 'init', 'type', 'yourself', 'new', 'setPolygon', 'doit'];
const INIT = SELECTORS.indexOf('init');
const TYPE = SELECTORS.indexOf('type');
const YOURSELF = SELECTORS.indexOf('yourself');
const NEW = SELECTORS.indexOf('new');
const SET_POLYGON = SELECTORS.indexOf('setPolygon');
/** The class number this fixture's `Polygon` is, which is not 34 on purpose. */
const POLYGON_SPECIES = 71;

let offset = 0;
const step = (name: string, ...operands: number[]) => ({
  offset: (offset += 3),
  name,
  operands,
  raw: 0,
});

/**
 * The stream King's Quest VII's `pyramidDoor` emits, with the points given.
 *
 * `type` is pushed as one of SCI's short forms where it can be, because that is
 * what the game does — a total-access polygon is `push0` and a reader that only
 * knew `pushi` would refuse every one of them.
 */
function buildsPolygon(type: number, points: ReadonlyArray<[number, number]>) {
  const typePush =
    type === 0
      ? step('push0')
      : type === 1
        ? step('push1')
        : type === 2
          ? step('push2')
          : step('pushi', type);
  return [
    step('pushi', SET_POLYGON),
    step('push1'),
    step('pushi', TYPE),
    step('push1'),
    typePush,
    step('pushi', INIT),
    step('pushi', points.length * 2),
    ...points.flatMap(([x, y]) => [step('pushi', x), step('pushi', y)]),
    step('pushi', YOURSELF),
    step('push0'),
    step('pushi', NEW),
    step('push0'),
    step('class', POLYGON_SPECIES),
    step('send', 4),
    step('send', 30),
    step('push'),
    step('self', 20),
    step('ret'),
  ];
}

function project(methodBody: ReturnType<typeof step>[]): SciProject {
  const made = createProject('a sci game');
  made.target = { engine: 'sci', version: 'sci2-1-middle' } as Project['target'];
  return {
    identification: { how: 'declared', evidence: [] },
    selectors: SELECTORS,
    classes: [{ number: POLYGON_SPECIES, script: 64946 }],
    scripts: [
      {
        number: 64946,
        objects: [
          {
            name: 'Polygon',
            isClass: true,
            species: POLYGON_SPECIES,
            superClass: POLYGON_SPECIES,
            variables: [],
            variableSelectors: [],
            methods: [],
          },
        ],
        exports: [],
        locals: [],
        bytes: '',
      },
      {
        number: 1250,
        objects: [
          {
            name: 'pyramidDoor',
            isClass: false,
            species: 0xffff,
            superClass: 46,
            variables: [],
            variableSelectors: [],
            methods: [
              { selector: 'init', selectorNumber: INIT, offset: 0, instructions: methodBody },
            ],
          },
        ],
        exports: [],
        locals: [],
        bytes: '',
      },
    ],
    resources: [],
    messages: [],
    vectorPictures: [],
    celPictures: [],
    languages: [],
    unrecoveredCount: 0,
  };
}

describe('a walk polygon is read from the literals its room pushes', () => {
  it('reads the points, in order, as signed script coordinates', () => {
    const found = sciPolygons(
      project(
        buildsPolygon(2, [
          [876, 79],
          [875, 29],
          [920, 27],
          [919, 82],
        ]),
      ),
    );
    expect(found.refused).toEqual([]);
    expect(found.polygons).toHaveLength(1);
    const [polygon] = found.polygons;
    expect(polygon.owner).toBe('pyramidDoor');
    expect(polygon.script).toBe(1250);
    expect(polygon.type).toBe(2);
    expect(polygon.typeName).toMatch(/barred access/);
    expect(polygon.points.map((point) => [point.x, point.y])).toEqual([
      [876, 79],
      [875, 29],
      [920, 27],
      [919, 82],
    ]);
  });

  /**
   * A coordinate off the left of the script's space is ordinary — a panorama's
   * Plane is scrolled by moving its own rectangle left — so the words are read
   * signed, the way every other SCI coordinate is.
   */
  it('reads a negative coordinate as negative rather than as 65,000', () => {
    const found = sciPolygons(
      project(
        buildsPolygon(0, [
          [0xfff2, 10],
          [40, 50],
          [60, 70],
        ]),
      ),
    );
    expect(found.polygons[0].points[0]).toMatchObject({ x: -14, y: 10 });
  });

  it("takes SCI's short pushes for the type, so a total-access polygon is not refused", () => {
    const found = sciPolygons(
      project(
        buildsPolygon(0, [
          [1, 2],
          [3, 4],
          [5, 6],
        ]),
      ),
    );
    expect(found.polygons[0].type).toBe(0);
    expect(found.polygons[0].typeName).toMatch(/total access/);
  });

  /**
   * 7a's rule, in SCI's terms: there is no number in the script to change, so
   * the polygon is refused **by name** rather than offered with a coordinate an
   * edit would not reach.
   */
  it('refuses a polygon whose coordinate is computed, and says whose it is', () => {
    const body = buildsPolygon(3, [
      [10, 20],
      [30, 40],
      [50, 60],
    ]);
    // The third push after `pushi init` and its count is the second point's x.
    const initAt = body.findIndex((one) => one.name === 'pushi' && one.operands[0] === INIT);
    body[initAt + 4] = step('lofsa', 1576);

    const found = sciPolygons(project(body));
    expect(found.polygons).toEqual([]);
    expect(found.refused).toHaveLength(1);
    expect(found.refused[0].owner).toBe('pyramidDoor');
    expect(found.refused[0].why).toMatch(/computes at least one of its polygon coordinates/);
  });

  it('finds nothing, and says why, in a game whose classes carry no Polygon', () => {
    const made = project([]);
    made.scripts[0].objects[0].name = 'Obj';
    const found = sciPolygons(made);
    expect(found.polygons).toEqual([]);
    expect(describeSciPolygons(found, 1250)).toMatch(/states no walk polygon/);
  });

  /**
   * The sentence a room pane shows, which has to distinguish three things an
   * empty list cannot: a room with no polygons, a room whose polygons are
   * computed, and a Version whose walkable area is a colour and not a shape.
   */
  it('counts what it found and names what it could not read', () => {
    const found = sciPolygons(
      project(
        buildsPolygon(1, [
          [1, 2],
          [3, 4],
          [5, 6],
        ]),
      ),
    );
    expect(describeSciPolygons(found, 1250)).toMatch(/1 walk polygon, 3 points/);
  });
});
