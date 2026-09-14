/**
 * @vitest-environment jsdom
 *
 * The walk grid, carried through the project and back out again.
 *
 * `docs/editor-parity.md` called this the largest gap in the two Broken Sword
 * surfaces: the bars a character may not cross and the nodes its router turns
 * at are a real resource, and the importer used not to carry one. What is
 * checked here is the whole path — the codec against bytes a router already
 * reads, the edits against the project, the canvas's keyboard decisions, and
 * the two sidebars an author actually clicks.
 */
import { describe, expect, it } from 'vitest';
import {
  SWORD_BAR_BYTES,
  SWORD_NODE_BYTES,
  parseSword1WalkGrid,
  readSwordWalkBarFields,
  sword1WalkGridBytes,
  swordWalkBarFields,
  writeSword1WalkGrid,
  type SwordWalkBar,
  type SwordWalkNode,
} from '../src/engine/sword1/script/swordWalkGrid.js';
import {
  parseSword2WalkGrid,
  sword2WalkGridBytes,
  writeSword2WalkGrid,
} from '../src/engine/sword2/script/sword2WalkGrid.js';
import { SWORD1_HEADER_SIZE } from '../src/engine/sword1/resource/swordDefs.js';
import { RES_HEADER_SIZE } from '../src/engine/sword2/resource/sword2Headers.js';
import {
  deleteSword1WalkBar,
  editSword1WalkBar,
  editSword1WalkNode,
  Sword1EditError,
} from '../src/authoring/sword1/edits.js';
import {
  deleteSword2WalkBar,
  editSword2WalkBar,
  editSword2WalkNode,
  Sword2EditError,
} from '../src/authoring/sword2/edits.js';
import { SWORD1_SURFACES } from '../src/authoring/sword1/project.js';
import { SWORD2_SURFACES } from '../src/authoring/sword2/project.js';
import type { Project } from '../src/authoring/project.js';
import { toBase64 } from '../src/authoring/base64.js';
import {
  describeSceneWalk,
  describeSceneWalkUnder,
  sameSceneWalkSelection,
  sceneWalkAt,
  sceneWalkDeletion,
  sceneWalkNudge,
  sceneWalkPoint,
  type SceneModel,
  type SceneWalk,
} from '../src/editor/sceneCanvas.js';
import { sword1ScreenWalk } from '../src/editor/sword1/screenScene.js';
import { sword2ScreenWalk } from '../src/editor/sword2/screenScene.js';
import { Sword2Resources } from '../src/engine/sword2/resource/Sword2Resources.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import {
  readSword2WalkData,
  Sword2RouteResult,
  Sword2Router,
} from '../src/engine/sword2/script/Sword2Router.js';
import { Sword2FileType } from '../src/engine/sword2/resource/sword2Headers.js';
import { buildSword2Fixture, sword2Header, Writer } from './fixtureSword.js';
import { Sword1Editor } from '../src/editor/sword1/Sword1Editor.js';
import { Sword2Editor } from '../src/editor/sword2/Sword2Editor.js';

const BARS: SwordWalkBar[] = [
  { x1: 10, y1: 20, x2: 40, y2: 60 },
  { x1: 100, y1: 8, x2: 100, y2: 90 },
];
const NODES: SwordWalkNode[] = [
  { x: 12, y: 24 },
  { x: 200, y: 150 },
];

/** A Sword 1 grid resource as the game stores one, header and all. */
function sword1GridBytes(bars = BARS, nodes = NODES, scaleA = 0, scaleB = 0): Uint8Array {
  const bytes = new Uint8Array(sword1WalkGridBytes(bars.length, nodes.length));
  const view = new DataView(bytes.buffer);
  // The header this project never invents: type, version, lengths, scheme.
  bytes.set(new TextEncoder().encode('GRID  '), 0);
  view.setUint16(6, 1, true);
  view.setUint32(8, bytes.length, true);
  bytes.set(new TextEncoder().encode('NONE'), 12);
  view.setUint32(16, bytes.length - SWORD1_HEADER_SIZE, true);
  view.setInt32(SWORD1_HEADER_SIZE, scaleA, true);
  view.setInt32(SWORD1_HEADER_SIZE + 4, scaleB, true);
  view.setInt32(SWORD1_HEADER_SIZE + 8, bars.length, true);
  view.setInt32(SWORD1_HEADER_SIZE + 12, nodes.length, true);
  let at = SWORD1_HEADER_SIZE + 16;
  for (const bar of bars) {
    const fields = swordWalkBarFields(bar);
    const words = [
      fields.x1,
      fields.y1,
      fields.x2,
      fields.y2,
      fields.xmin,
      fields.ymin,
      fields.xmax,
      fields.ymax,
      fields.dx,
      fields.dy,
    ];
    words.forEach((word, index) => view.setInt16(at + index * 2, word, true));
    view.setInt32(at + 20, fields.co, true);
    at += SWORD_BAR_BYTES;
  }
  for (const node of nodes) {
    view.setInt16(at, node.x, true);
    view.setInt16(at + 2, node.y, true);
    at += SWORD_NODE_BYTES;
  }
  return bytes;
}

function sword2GridBytes(bars = BARS, nodes = NODES, name = 'grid11'): Uint8Array {
  const sword1 = sword1GridBytes(bars, nodes);
  const bytes = new Uint8Array(sword2WalkGridBytes(bars.length, nodes.length));
  // File type 4 is a walk grid; both length words are zero in this family's
  // own grids, and that is copied rather than corrected.
  bytes[0] = 4;
  bytes.set(new TextEncoder().encode(name), 10);
  bytes.set(sword1.subarray(SWORD1_HEADER_SIZE + 8), RES_HEADER_SIZE);
  return bytes;
}

describe('a Broken Sword walk grid as bytes', () => {
  it('reads the four numbers an author edits and writes back the eleven stored', () => {
    const grid = parseSword1WalkGrid(sword1GridBytes())!;
    expect(grid.bars).toEqual(BARS);
    expect(grid.nodes).toEqual(NODES);
    expect(grid.scaleA).toBe(0);
  });

  it('re-emits an untouched grid byte for byte', () => {
    const bytes = sword1GridBytes(BARS, NODES, 7, 9);
    const grid = parseSword1WalkGrid(bytes)!;
    const again = writeSword1WalkGrid(grid, bytes.subarray(0, SWORD1_HEADER_SIZE));
    expect([...again]).toEqual([...bytes]);
  });

  it('derives the seven fields the router reads, so a moved bar blocks where it is', () => {
    const bytes = sword1GridBytes();
    const grid = parseSword1WalkGrid(bytes)!;
    const moved = {
      ...grid,
      bars: [{ x1: 5, y1: 5, x2: 25, y2: 45 }, grid.bars[1]],
    };
    const out = writeSword1WalkGrid(moved, bytes.subarray(0, SWORD1_HEADER_SIZE));
    const view = new DataView(out.buffer);
    const stored = readSwordWalkBarFields(view, SWORD1_HEADER_SIZE + 16, 2, true)[0];
    // Not asserted against constants: asserted against what the bar is. dx and
    // dy are the deltas, the box is the extent, and `co` is the line constant
    // `SwordRouter` tests a point against.
    expect(stored).toEqual(swordWalkBarFields({ x1: 5, y1: 5, x2: 25, y2: 45 }));
    expect(stored.dx).toBe(20);
    expect(stored.dy).toBe(40);
    expect(stored.xmin).toBe(5);
    expect(stored.xmax).toBe(25);
    expect(stored.co).toBe(5 * 20 - 5 * 40);
  });

  it('corrects both length words when a grid loses a bar', () => {
    const bytes = sword1GridBytes();
    const grid = parseSword1WalkGrid(bytes)!;
    const out = writeSword1WalkGrid(
      { ...grid, bars: [grid.bars[0]] },
      bytes.subarray(0, SWORD1_HEADER_SIZE),
    );
    const view = new DataView(out.buffer);
    expect(out.length).toBe(bytes.length - SWORD_BAR_BYTES);
    expect(view.getUint32(8, true)).toBe(out.length);
    expect(view.getUint32(16, true)).toBe(out.length - SWORD1_HEADER_SIZE);
  });

  it('refuses bytes that are not a grid rather than reading past them', () => {
    expect(parseSword1WalkGrid(new Uint8Array(8))).toBeNull();
    const short = sword1GridBytes().subarray(0, SWORD1_HEADER_SIZE + 20);
    expect(parseSword1WalkGrid(short)).toBeNull();
  });

  it('reads and re-emits a Broken Sword II grid, whose header carries its name', () => {
    const bytes = sword2GridBytes();
    const grid = parseSword2WalkGrid(bytes)!;
    expect(grid.bars).toEqual(BARS);
    expect(grid.nodes).toEqual(NODES);
    const again = writeSword2WalkGrid(grid, bytes.subarray(0, RES_HEADER_SIZE));
    expect([...again]).toEqual([...bytes]);
    expect(new TextDecoder('latin1').decode(again.subarray(10, 16))).toBe('grid11');
  });

  it('refuses Sword II bytes that are not a grid', () => {
    expect(parseSword2WalkGrid(new Uint8Array(RES_HEADER_SIZE))).toBeNull();
  });
});

function sword1Project(): Project {
  return {
    version: 6,
    target: { engine: 'sword1', release: 'cd', platform: 'dos' },
    name: 'test',
    start: { room: 1, x: 0, y: 0 },
    defaultResponse: '',
    screen: { textHeight: 40, verbTop: 0 },
    verbs: [],
    actors: [],
    rooms: [],
    scripts: [],
    audio: [],
    sword1: {
      identification: { release: 'cd', how: 'shipped-files', evidence: 'paris2.clu' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD1_SURFACES,
      sections: [],
      scripts: [],
      text: [],
      palettes: [],
      pictures: [],
      rooms: [
        {
          screen: 1,
          width: 640,
          height: 400,
          totalLayers: 1,
          gridWidth: 40,
          layers: [1],
          grids: [],
          palettes: [6, 7],
          parallax: [0, 0],
        },
      ],
      effects: [],
      clusters: { present: [], absent: [], labels: {} },
      walkGrids: [
        {
          resource: 0x070a0001,
          screens: [1],
          floors: [0x00120000],
          scaleA: 0,
          scaleB: 0,
          headerBase64: toBase64(sword1GridBytes().subarray(0, SWORD1_HEADER_SIZE)),
          bars: BARS.map((bar) => ({ ...bar })),
          nodes: NODES.map((node) => ({ ...node })),
        },
      ],
    },
  };
}

function sword2Project(): Project {
  return {
    ...sword1Project(),
    target: { engine: 'sword2', release: 'cd', platform: 'dos' },
    sword1: undefined,
    sword2: {
      identification: { release: 'cd', how: 'shipped-files', evidence: 'speech2.clu' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD2_SURFACES,
      objects: [],
      globals: { count: 0, bytesBase64: '' },
      text: [],
      screens: [
        {
          resource: 22,
          width: 640,
          height: 480,
          layers: 1,
          hasPalette: true,
          parallax: [false, false, false, false],
          bytesBase64: '',
        },
      ],
      palettes: [],
      animations: [],
      runLists: [],
      clusters: { present: [], absent: [] },
      walkGrids: [
        {
          resource: 1638,
          name: 'grid11',
          screens: [22],
          objects: [9],
          headerBase64: toBase64(sword2GridBytes().subarray(0, RES_HEADER_SIZE)),
          bars: BARS.map((bar) => ({ ...bar })),
          nodes: NODES.map((node) => ({ ...node })),
        },
      ],
    },
  };
}

describe('editing a walk grid in a project', () => {
  it('moves one end of a bar and leaves the other where it was', () => {
    const project = sword1Project();
    editSword1WalkBar(project, 0x070a0001, 0, { end: 1, x: 55, y: 66 });
    expect(project.sword1!.walkGrids![0].bars[0]).toEqual({ x1: 10, y1: 20, x2: 55, y2: 66 });
  });

  it('slides a whole bar by its midpoint, keeping its length', () => {
    const project = sword1Project();
    editSword1WalkBar(project, 0x070a0001, 0, { end: null, x: 25, y: 40 });
    const bar = project.sword1!.walkGrids![0].bars[0];
    expect(bar.x2 - bar.x1).toBe(30);
    expect(bar.y2 - bar.y1).toBe(40);
    expect(Math.round((bar.x1 + bar.x2) / 2)).toBe(25);
  });

  it('clamps to what a 16-bit field holds rather than to the screen', () => {
    const project = sword1Project();
    // Off the edge of a scrolling screen is ordinary; off the end of the field
    // is not, so only the second is corrected.
    editSword1WalkBar(project, 0x070a0001, 0, { end: 0, x: 900, y: 99999 });
    expect(project.sword1!.walkGrids![0].bars[0]).toMatchObject({ x1: 900, y1: 32767 });
  });

  it('deletes a bar and renumbers nothing that is addressed by number', () => {
    const project = sword1Project();
    deleteSword1WalkBar(project, 0x070a0001, 0);
    expect(project.sword1!.walkGrids![0].bars).toEqual([BARS[1]]);
    expect(project.sword1!.walkGrids![0].nodes).toHaveLength(2);
  });

  it('moves a node', () => {
    const project = sword1Project();
    editSword1WalkNode(project, 0x070a0001, 1, 300, 250);
    expect(project.sword1!.walkGrids![0].nodes[1]).toEqual({ x: 300, y: 250 });
  });

  it('says which grid or index it has not got', () => {
    const project = sword1Project();
    expect(() => editSword1WalkBar(project, 999, 0, { end: 0, x: 0, y: 0 })).toThrow(
      Sword1EditError,
    );
    expect(() => deleteSword1WalkBar(project, 0x070a0001, 9)).toThrow(/holds 2 bars/);
    expect(() => editSword1WalkNode(project, 0x070a0001, 9, 0, 0)).toThrow(/holds 2 nodes/);
  });

  it('does all of that on a Broken Sword II grid too, through its own records', () => {
    const project = sword2Project();
    editSword2WalkBar(project, 1638, 1, { end: 0, x: 111, y: 12 });
    expect(project.sword2!.walkGrids![0].bars[1]).toEqual({ x1: 111, y1: 12, x2: 100, y2: 90 });
    editSword2WalkNode(project, 1638, 0, 13, 26);
    expect(project.sword2!.walkGrids![0].nodes[0]).toEqual({ x: 13, y: 26 });
    deleteSword2WalkBar(project, 1638, 1);
    expect(project.sword2!.walkGrids![0].bars).toHaveLength(1);
    expect(() => editSword2WalkBar(project, 1, 0, { end: 0, x: 0, y: 0 })).toThrow(Sword2EditError);
  });

  it('writes an edited grid back out as a resource the router can read', () => {
    const project = sword1Project();
    editSword1WalkBar(project, 0x070a0001, 0, { end: 1, x: 55, y: 66 });
    const grid = project.sword1!.walkGrids![0];
    const out = writeSword1WalkGrid(grid, sword1GridBytes().subarray(0, SWORD1_HEADER_SIZE));
    expect(parseSword1WalkGrid(out)!.bars[0]).toEqual({ x1: 10, y1: 20, x2: 55, y2: 66 });
  });
});

/** The overlay as the canvas sees it, with whatever is selected. */
function walk(selected: SceneWalk['selected'] = null): SceneWalk {
  return {
    label: 'walk grid 0x70A0001',
    bars: BARS.map((bar, index) => ({ index, ...bar })),
    nodes: NODES.map((node, index) => ({ index, ...node })),
    selected,
  };
}

function walkModel(walkGrid: SceneWalk, extra: Partial<SceneModel> = {}): SceneModel {
  const moves: Array<{ x: number; y: number }> = [];
  return {
    label: 'Screen 1',
    help: '',
    picture: () => ({ width: 640, height: 400, pixels: new Uint8Array(640 * 400), palette: [] }),
    items: () => [],
    grid: () => null,
    selected: () => null,
    select: () => {},
    walk: () => walkGrid,
    moveWalk: (_selection, x, y) => void moves.push({ x, y }),
    deleteWalkBar: () => {},
    ...extra,
  };
}

describe('the walk overlay on the shared scene canvas', () => {
  it('picks a node before a bar end, and a bar end before its body', () => {
    // Node 0 sits at 12, 24 and bar 0 starts at 10, 20: within a few pixels
    // both are under the pointer, and the smaller thing has to win or it can
    // never be picked at all.
    expect(sceneWalkAt(walk(), 12, 24)).toEqual({ kind: 'node', index: 0 });
    expect(sceneWalkAt(walk(), 40, 60)).toEqual({ kind: 'bar', index: 0, end: 1 });
    expect(sceneWalkAt(walk(), 25, 40)).toEqual({ kind: 'bar', index: 0, end: null });
    expect(sceneWalkAt(walk(), 400, 300)).toBeNull();
  });

  it('finds the point a selection stands at, so a nudge knows where it starts', () => {
    expect(sceneWalkPoint(walk(), { kind: 'node', index: 1 })).toEqual({ x: 200, y: 150 });
    expect(sceneWalkPoint(walk(), { kind: 'bar', index: 0, end: 0 })).toEqual({ x: 10, y: 20 });
    expect(sceneWalkPoint(walk(), { kind: 'bar', index: 0, end: null })).toEqual({ x: 25, y: 40 });
    expect(sceneWalkPoint(walk(), { kind: 'bar', index: 7, end: null })).toBeNull();
  });

  it('says what is under the cursor in coordinates and names', () => {
    expect(describeSceneWalk(walk(), { kind: 'node', index: 0 })).toBe('Node 0 at 12, 24');
    expect(describeSceneWalk(walk(), { kind: 'bar', index: 1, end: 0 })).toBe(
      'Bar 1 end 1, 100, 8 to 100, 90',
    );
    expect(describeSceneWalkUnder(walk(), 12, 24)).toBe('12, 24 — Node 0 at 12, 24');
    expect(describeSceneWalkUnder(walk(), 400, 300)).toBe('400, 300');
  });

  it('knows when two selections are the same one', () => {
    expect(sameSceneWalkSelection(null, null)).toBe(true);
    expect(sameSceneWalkSelection({ kind: 'node', index: 1 }, { kind: 'node', index: 1 })).toBe(
      true,
    );
    expect(
      sameSceneWalkSelection(
        { kind: 'bar', index: 1, end: 0 },
        { kind: 'bar', index: 1, end: null },
      ),
    ).toBe(false);
  });

  it('moves what is selected with Alt and an arrow, clamped to the picture', () => {
    const grid = walk({ kind: 'node', index: 1 });
    expect(sceneWalkNudge(walkModel(grid), grid, 'ArrowRight', 8)).toEqual({
      kind: 'move',
      selection: { kind: 'node', index: 1 },
      x: 208,
      y: 150,
    });
    const atEdge = walk({ kind: 'bar', index: 1, end: 0 });
    expect(sceneWalkNudge(walkModel(atEdge), atEdge, 'ArrowUp', 8)).toMatchObject({ y: 0 });
  });

  it('refuses with a sentence rather than silently doing nothing', () => {
    const nothing = walk();
    expect(sceneWalkNudge(walkModel(nothing), nothing, 'ArrowUp', 1)).toEqual({
      kind: 'refuse',
      message: 'Nothing in the walk grid is selected to move.',
    });
    const readOnly = walk({ kind: 'bar', index: 0, end: null });
    const model = walkModel(readOnly, {
      moveWalk: undefined,
      deleteWalkBar: undefined,
      walkImmutable: 'This screen’s grid is on the other disc.',
    });
    expect(sceneWalkNudge(model, readOnly, 'ArrowUp', 1)).toEqual({
      kind: 'refuse',
      message: 'This screen’s grid is on the other disc.',
    });
    expect(sceneWalkDeletion(model, readOnly)).toMatchObject({ kind: 'refuse' });
  });

  it('deletes a bar and explains why it will not delete a node', () => {
    const bar = walk({ kind: 'bar', index: 1, end: 1 });
    expect(sceneWalkDeletion(walkModel(bar), bar)).toEqual({ kind: 'delete', index: 1 });
    const node = walk({ kind: 'node', index: 0 });
    expect(sceneWalkDeletion(walkModel(node), node)).toMatchObject({
      kind: 'refuse',
      message: expect.stringContaining('renumbers every node after it'),
    });
  });

  it('hands each screen the grid its own family names for it', () => {
    const sword1 = sword1ScreenWalk(sword1Project().sword1!, 1, { kind: 'node', index: 0 })!;
    expect(sword1.label).toContain('walk grid');
    expect(sword1.bars).toHaveLength(2);
    expect(sword1.selected).toEqual({ kind: 'node', index: 0 });
    expect(sword1ScreenWalk(sword1Project().sword1!, 99, null)).toBeNull();

    const sword2 = sword2ScreenWalk(sword2Project().sword2!, 22, null)!;
    expect(sword2.label).toContain('grid11');
    expect(sword2.nodes).toHaveLength(2);
  });
});

describe('the walk grid section in both sidebars', () => {
  it('lists a Broken Sword grid and edits a bar from the keyboard alone', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    expect(editor.element.textContent).toContain('Walk grids');
    openSection(editor.element, 'Walk grids');
    const row = [...editor.element.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('Grid 0x70A0001'),
    );
    expect(row?.textContent).toContain('2 bars, 2 nodes');
    row!.click();

    const detail = editor.element.textContent ?? '';
    expect(detail).toContain('screen 1');
    const field = [...editor.element.querySelectorAll('input')].find(
      (input) => input.id === 'sword1-walk-70a0001-bar-0-y2',
    );
    expect(field).toBeDefined();
    field!.value = '77';
    field!.dispatchEvent(new Event('change'));
    expect(project.sword1!.walkGrids![0].bars[0]).toEqual({ x1: 10, y1: 20, x2: 40, y2: 77 });
  });

  it('deletes a bar from the panel, and offers no way to delete a node', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Walk grids');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Grid 0x70A0001'))
      ?.click();
    const labels = () =>
      [...editor.element.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels()).toContain('Delete bar 1');
    expect(labels().some((label) => label?.startsWith('Delete node'))).toBe(false);
    expect(editor.element.textContent).toContain('address a node by its index');

    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent === 'Delete bar 0')!
      .click();
    expect(project.sword1!.walkGrids![0].bars).toEqual([BARS[1]]);
  });

  it('lists a Broken Sword II grid by its own name and moves a node', () => {
    const project = sword2Project();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Walk grids');
    const row = [...editor.element.querySelectorAll('button')].find((button) =>
      button.textContent?.startsWith('grid11'),
    );
    expect(row).toBeDefined();
    row!.click();
    const field = [...editor.element.querySelectorAll('input')].find(
      (input) => input.id === 'sword2-walk-1638-node-1-x',
    );
    field!.value = '250';
    field!.dispatchEvent(new Event('change'));
    expect(project.sword2!.walkGrids![0].nodes[1]).toEqual({ x: 250, y: 150 });
  });
});

function openSection(root: HTMLElement, title: string): void {
  const head = [...root.querySelectorAll<HTMLButtonElement>('.accordion-head')].find(
    (button) => button.querySelector('.accordion-title')?.textContent === title,
  );
  if (head?.getAttribute('aria-expanded') === 'false') head.click();
}

/**
 * The other half of the proof: an *edited* grid loads and routes.
 *
 * The sweep says an untouched grid comes back byte for byte; that says nothing
 * about whether a changed one is still a grid. So this moves a wall through the
 * same edit an author makes in the panel, writes the resource with the same
 * encoder the exporter uses, hands it to the router the game runs, and asks
 * whether the walk that was blocked now goes through.
 */
describe('an edited walk grid still routes', () => {
  /** An ObjectWalkdata: the mega's own step sizes, which routing needs. */
  function walkData(): Uint8Array {
    const body = new Writer().i32(12).i32(0).i32(0).i32(0).i32(0);
    for (let dir = 0; dir < 8; dir++) body.i32(0);
    for (let dir = 0; dir < 8; dir++) body.i32(dir & 1);
    for (let index = 0; index < 8 * 13; index++) body.i32(index % 13 < 6 ? 6 : 0);
    for (let index = 0; index < 8 * 13; index++) body.i32(index % 13 < 6 ? 2 : 0);
    return body.done();
  }

  async function routeThrough(bytes: Uint8Array): Promise<number> {
    const fixture = buildSword2Fixture([{ name: 'general.clu', resources: [{ id: 1, bytes }] }]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, cluster] of fixture.clusters) entries.push([name, cluster]);
    const resources = await Sword2Resources.create(new MemoryDataSource('grid', entries));
    await resources.loadResident();
    const routing = new Sword2Router(resources);
    routing.addWalkGrid(1);
    // Straight down the room, through where the wall is: the same walk the
    // router's own tests use, so a failure here is the grid and not the walk.
    return routing.routeFinder(
      { feetX: 100, feetY: 100, dir: 4, scaleA: 0, scaleB: 0x10000 },
      readSword2WalkData(walkData(), 0)!,
      100,
      300,
      4,
    );
  }

  it('lets a mega through a wall an author moved out of the way', async () => {
    const project = sword2Project();
    const grid = project.sword2!.walkGrids![0];
    // A wall right across the room and no node on the far side to route via:
    // the walk fails, which is the "before".
    (grid.bars as SwordWalkBar[]).splice(0, grid.bars.length, {
      x1: 0,
      y1: 200,
      x2: 640,
      y2: 200,
    });
    (grid.nodes as SwordWalkNode[]).splice(0, grid.nodes.length);
    const header = sword2Header(Sword2FileType.WALK_GRID_FILE, 'grid11', 0);
    expect(await routeThrough(writeSword2WalkGrid(grid, header))).toBe(Sword2RouteResult.FAILED);

    // The same edit the panel makes: drag the wall's two ends out of the way.
    editSword2WalkBar(project, 1638, 0, { end: 0, x: 0, y: 460 });
    editSword2WalkBar(project, 1638, 0, { end: 1, x: 640, y: 460 });
    expect(await routeThrough(writeSword2WalkGrid(grid, header))).toBe(Sword2RouteResult.FOUND);
  });

  it('lets a deleted bar stop blocking, and the grid is still readable', async () => {
    const project = sword2Project();
    const grid = project.sword2!.walkGrids![0];
    (grid.bars as SwordWalkBar[]).splice(0, grid.bars.length, {
      x1: 0,
      y1: 200,
      x2: 640,
      y2: 200,
    });
    (grid.nodes as SwordWalkNode[]).splice(0, grid.nodes.length);
    deleteSword2WalkBar(project, 1638, 0);
    const bytes = writeSword2WalkGrid(grid, sword2Header(Sword2FileType.WALK_GRID_FILE, 'g', 0));
    expect(parseSword2WalkGrid(bytes)!.bars).toEqual([]);
    expect(await routeThrough(bytes)).toBe(Sword2RouteResult.FOUND);
  });
});
