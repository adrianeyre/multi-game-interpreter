/**
 * @vitest-environment jsdom
 *
 * Playing a Broken Sword animation back at the speed the game plays it.
 *
 * `docs/editor-parity.md` row 18 was a No in both Sword families, and §18a gave
 * the reason: a sprite resource carries frames and no timing, so a preview
 * would have to invent a rate. The resource half of that is true. The game half
 * is not — the rate is in the script, and so is the frame order — and what is
 * checked here is that the editor reads them out of the script rather than
 * picking them, and says so plainly on the resources where no script does.
 *
 * The counts these tests protect the behaviour of are measured against the
 * demos rather than asserted here: 145 of Broken Sword's 438 sprites and 185 of
 * Broken Sword II's 509 animations have a player this can name. A fixture
 * cannot check a count it builds itself, so what it checks is the rules that
 * produce it: a literal is followed, a variable is not, a table-driven call is
 * refused, and the millisecond figure comes from the engine's own tick.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SWORD1_CYCLE_MS,
  sword1Players,
  sword1SpritePlaybacks,
} from '../src/editor/sword1/playback.js';
import {
  SWORD2_CYCLE_MS,
  sword2Players,
  sword2AnimationPlaybacks,
} from '../src/editor/sword2/playback.js';
import { SWORD1_TICKS_PER_STEP } from '../src/engine/sword1/SwordEngine.js';
import { SWORD2_TICKS_PER_STEP } from '../src/engine/sword2/Sword2Engine.js';
import { Sword1Editor } from '../src/editor/sword1/Sword1Editor.js';
import { Sword2Editor } from '../src/editor/sword2/Sword2Editor.js';
import { SWORD1_SURFACES, type Sword1Project } from '../src/authoring/sword1/project.js';
import { SWORD2_SURFACES, type Sword2Project } from '../src/authoring/sword2/project.js';
import { importSword1Project } from '../src/authoring/sword1/import.js';
import { SwordResources } from '../src/engine/sword1/resource/SwordResources.js';
import { identifySword1 } from '../src/engine/sword1/resource/swordDetect.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { SWORD1_COMPACT_WORDS } from '../src/engine/sword1/resource/swordCompact.js';
import { IT } from '../src/engine/sword1/script/swordTokens.js';
import { CP } from '../src/engine/sword2/script/sword2Tokens.js';
import { SWORD2_INS } from '../src/engine/sword2/script/Sword2Logic.js';
import type { Project } from '../src/authoring/project.js';
import { toBase64 } from '../src/authoring/base64.js';
import {
  buildAnimTable,
  buildCompactResource,
  buildScriptResource,
  buildSpriteResource,
  buildSwordFixture,
  buildTextResource,
  buildSword2Anim,
} from './fixtureSword.js';

// --- Broken Sword 1 -------------------------------------------------------

/** `fnAnim(cdt, spr)` as the four words a script holds it in. */
const animCall = (
  at: number,
  cdt: { value: number; variable?: boolean },
  spr: { value: number; variable?: boolean },
  mcode = 5,
) => [
  {
    at,
    token: cdt.variable ? IT.PUSHVARIABLE : IT.PUSHNUMBER,
    operands: [cdt.value],
    words: 2,
  },
  {
    at: at + 2,
    token: spr.variable ? IT.PUSHVARIABLE : IT.PUSHNUMBER,
    operands: [spr.value],
    words: 2,
  },
  { at: at + 4, token: IT.MCODE, operands: [mcode, 2], words: 3 },
];

const TABLE = 0x04010001;
const SPRITE = 0x04010002;
const SET = 0x04010003;

function sword1(instructions: ReturnType<typeof animCall>, extra: Partial<Sword1Project> = {}) {
  const project: Sword1Project = {
    identification: { release: 'cd', how: 'shipped-files', evidence: 'paris2.clu' },
    editable: { editable: true, unrecovered: 0, reasons: [] },
    surfaces: SWORD1_SURFACES,
    sections: [],
    scripts: [
      {
        resource: 0x01030000,
        sections: [1],
        instructions: [...instructions, { at: 100, token: IT.SCRIPTEND, operands: [], words: 1 }],
        entries: [0],
        unrecovered: [],
        roundTrips: true,
      },
    ],
    text: [],
    palettes: [],
    pictures: [],
    rooms: [],
    effects: [],
    clusters: { present: [], absent: [], labels: {} },
    walkGrids: [],
    animTables: [{ resource: TABLE, frames: [0, 1, 2, 1] }],
    ...extra,
  };
  return project;
}

describe('finding the Broken Sword script that plays a sprite', () => {
  it('follows a literal fnAnim to the table that gives the frame order', () => {
    const project = sword1(animCall(0, { value: TABLE }, { value: SPRITE }));
    const players = sword1Players(project);
    expect(players.get(SPRITE)?.length).toBe(1);
    expect(players.get(SPRITE)?.[0]).toMatchObject({ opcode: 'fnAnim', table: TABLE, via: null });
  });

  it('refuses a sprite pushed from a variable, which names a different one each run', () => {
    // Commit 0600015's rule. The number in a variable is decided while the game
    // is running, so reading it as a resource id would preview the wrong art.
    const project = sword1(animCall(0, { value: TABLE }, { value: 7, variable: true }));
    expect(sword1Players(project).size).toBe(0);
  });

  it('refuses a table pushed from a variable for the same reason', () => {
    const project = sword1(animCall(0, { value: 7, variable: true }, { value: SPRITE }));
    expect(sword1Players(project).size).toBe(0);
  });

  it('is not fooled by fnSetFrame, which parks one frame and implies no rate', () => {
    const project = sword1(animCall(0, { value: TABLE }, { value: SPRITE }, 6));
    expect(sword1Players(project).size).toBe(0);
  });

  it('offers all eight of a direction set, because the direction is a run-time fact', () => {
    const project = sword1(animCall(0, { value: SET }, { value: 0 }), {
      animSets: [
        {
          resource: SET,
          entries: Array.from({ length: 8 }, (_, direction) => ({
            table: TABLE,
            sprite: SPRITE + direction,
          })),
        },
      ],
    });
    const players = sword1Players(project);
    expect(players.size).toBe(8);
    expect(players.get(SPRITE + 3)?.[0].via).toEqual({ set: SET, direction: 3 });
  });

  it('plays the table’s frame column at one frame a game cycle', () => {
    const project = sword1(animCall(0, { value: TABLE }, { value: SPRITE }));
    const { playbacks, refusal } = sword1SpritePlaybacks(project, SPRITE);
    expect(refusal).toBeNull();
    expect(playbacks.length).toBe(1);
    expect(playbacks[0].frames).toEqual([0, 1, 2, 1]);
    expect(playbacks[0].frameMs).toBeCloseTo((SWORD1_TICKS_PER_STEP * 1000) / 60);
    expect(playbacks[0].why).toMatch(/twelve a second/);
    expect(playbacks[0].why).toMatch(/animation table 0x4010001/);
  });

  it('says so where no script names the sprite, rather than guessing a rate', () => {
    const project = sword1(animCall(0, { value: TABLE }, { value: SPRITE }));
    const { playbacks, refusal } = sword1SpritePlaybacks(project, 0x04019999);
    expect(playbacks).toEqual([]);
    expect(refusal).toMatch(/no rate to play it at/);
    expect(refusal).toMatch(/something false about your own game/);
  });

  it('says so where the script names the sprite but this project lacks its table', () => {
    const project = sword1(animCall(0, { value: TABLE }, { value: SPRITE }), { animTables: [] });
    expect(sword1SpritePlaybacks(project, SPRITE).refusal).not.toBeNull();
  });
});

describe('importing the animation tables a Broken Sword script names', () => {
  /** An install whose one script plays a sprite through a table in MAPS. */
  async function imported(): Promise<Sword1Project> {
    // Cluster 3 is `GENERAL` here, so a table in its group 1 index 1 is the id
    // the script pushes — the top byte of an id is the cluster plus one. The ids the script names and the ids the fixture writes
    // have to agree, which is the whole point of reading them back rather than
    // asserting the reader against itself.
    const script = [
      IT.PUSHNUMBER,
      0x04010001,
      IT.PUSHNUMBER,
      0x04010002,
      IT.MCODE,
      5,
      2,
      IT.SCRIPTEND,
    ];
    const compact = new Array(SWORD1_COMPACT_WORDS).fill(0);
    const fixture = buildSwordFixture([
      {
        label: 'SCRIPTS',
        groups: 2,
        resources: [
          { group: 0, index: 0, bytes: buildScriptResource([script]) },
          { group: 1, index: 0, bytes: buildScriptResource([script]) },
        ],
      },
      {
        label: 'COMPACTS',
        groups: 2,
        resources: [
          { group: 0, index: 0, bytes: buildCompactResource([compact]) },
          { group: 1, index: 0, bytes: buildCompactResource([compact]) },
        ],
      },
      {
        label: 'TEXT',
        groups: 1,
        resources: [{ group: 0, index: 0, bytes: buildTextResource(['one']) }],
      },
      {
        label: 'GENERAL',
        groups: 2,
        resources: [
          {
            group: 1,
            index: 1,
            bytes: buildAnimTable([
              { x: 0, y: 0, frame: 4 },
              { x: 1, y: 2, frame: 5 },
              { x: 3, y: 4, frame: 6 },
            ]),
          },
          {
            group: 1,
            index: 2,
            bytes: buildSpriteResource(
              [{ width: 1, height: 1, pixels: Uint8Array.from([3]) }],
              'Sprite',
            ),
          },
        ],
      },
    ]);
    const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
    for (const [label, bytes] of fixture.clusters) entries.push([`clusters/${label}.CLU`, bytes]);
    const resources = await SwordResources.create(new MemoryDataSource('fixture', entries));
    for (const label of resources.availableClusters) await resources.loadCluster(label, true);
    return importSword1Project(resources, identifySword1(['swordres.rif', 'paris2.clu']));
  }

  it('reads the frame column out of the resource the script names', async () => {
    const project = await imported();
    expect(project.animTables).toEqual([{ resource: 0x04010001, frames: [4, 5, 6] }]);
  });

  it('carries enough for the sprite’s panel to play it', async () => {
    const project = await imported();
    const { playbacks } = sword1SpritePlaybacks(project, 0x04010002);
    expect(playbacks.length).toBe(1);
    expect(playbacks[0].frames).toEqual([4, 5, 6]);
  });
});

// --- Broken Sword II ------------------------------------------------------

const ANIM = 30;

/** `fnAnim`-shaped bytecode: two pointers, a resource, and the call. */
const sword2AnimCall = (
  at: number,
  resource: { value: number; variable?: boolean },
  opcode = 9,
) => [
  { at, token: CP.PUSH_LOCAL_ADDR, operands: [0], bytes: 3 },
  { at: at + 3, token: CP.PUSH_LOCAL_ADDR, operands: [8], bytes: 3 },
  {
    at: at + 6,
    token: resource.variable ? CP.PUSH_LOCAL_VAR32 : CP.PUSH_INT32,
    operands: [resource.value],
    bytes: 5,
  },
  { at: at + 11, token: CP.CALL_MCODE, operands: [opcode, 3], bytes: 4 },
];

/** `fnTheyDo(target, command, ins1..ins5)` — seven pushes and the call. */
const sword2TheyDo = (at: number, command: number, ins1: number, opcode = 41) => {
  const count = opcode === 40 ? 8 : 7;
  const values =
    opcode === 40 ? [0, 99, command, ins1, 0, 0, 0, 0] : [99, command, ins1, 0, 0, 0, 0];
  return [
    ...values.map((value, index) => ({
      at: at + index * 5,
      token: CP.PUSH_INT32,
      operands: [value],
      bytes: 5,
    })),
    { at: at + count * 5, token: CP.CALL_MCODE, operands: [opcode, count], bytes: 4 },
  ];
};

function sword2(instructions: { at: number; token: number; operands: number[]; bytes: number }[]) {
  const project: Sword2Project = {
    identification: { release: 'cd', how: 'shipped-files', evidence: 'speech2.clu' },
    editable: { editable: true, unrecovered: 0, reasons: [] },
    surfaces: SWORD2_SURFACES,
    objects: [
      {
        id: 7,
        name: 'nico',
        bytesBase64: toBase64(new Uint8Array(200)),
        instructions,
        entries: [0],
        unrecovered: [],
        roundTrips: true,
        layout: { localsAt: 92, localsBytes: 16, codeAt: 140, codeBytes: 60 },
      },
    ],
    globals: { count: 0, bytesBase64: '' },
    text: [],
    screens: [],
    palettes: [],
    animations: [
      {
        resource: ANIM,
        name: 'shrug',
        frames: 3,
        compression: 0,
        bytesBase64: toBase64(
          buildSword2Anim('shrug', [
            { x: 0, y: 0, width: 2, height: 2, colour: 7 },
            { x: 1, y: 1, width: 2, height: 2, colour: 8 },
            { x: 2, y: 2, width: 2, height: 2, colour: 9 },
          ]),
        ),
      },
    ],
    runLists: [],
    clusters: { present: [], absent: [] },
    walkGrids: [],
  };
  return project;
}

describe('finding the Broken Sword II object that plays an animation', () => {
  it('follows fnAnim’s literal resource id', () => {
    const players = sword2Players(sword2(sword2AnimCall(0, { value: ANIM })));
    expect(players.get(ANIM)?.[0]).toMatchObject({
      name: 'nico',
      opcode: 'fnAnim',
      reverse: false,
    });
  });

  it('marks fnReverseAnim as the backwards run it is', () => {
    const players = sword2Players(sword2(sword2AnimCall(0, { value: ANIM }, 64)));
    expect(players.get(ANIM)?.[0].reverse).toBe(true);
  });

  it('refuses a resource pushed from a variable', () => {
    expect(sword2Players(sword2(sword2AnimCall(0, { value: 4, variable: true }))).size).toBe(0);
  });

  it('refuses fnMegaTableAnim, which picks by the mega’s direction while running', () => {
    // 595 of the demo's play calls are this one, and that is why the count of
    // animations with a named player is 185 rather than most of 509.
    const players = sword2Players(sword2(sword2AnimCall(0, { value: ANIM }, 22)));
    expect(players.size).toBe(0);
  });

  it('follows a speech script’s INS_anim through fnTheyDo', () => {
    const players = sword2Players(sword2(sword2TheyDo(0, SWORD2_INS.ANIM, ANIM)));
    expect(players.get(ANIM)?.[0]).toMatchObject({ opcode: 'fnTheyDo', reverse: false });
  });

  it('finds the command by name, because fnTheyDoWeWait’s list starts one earlier', () => {
    // The off-by-one this was built wrong with once: fnTheyDoWeWait's first
    // parameter is a pointer to ob_logic and fnTheyDo's is the target, so a
    // fixed index reads the wrong word for one of the two.
    const players = sword2Players(sword2(sword2TheyDo(0, SWORD2_INS.REVERSE_ANIM, ANIM, 40)));
    expect(players.get(ANIM)?.[0]).toMatchObject({ opcode: 'fnTheyDoWeWait', reverse: true });
  });

  it('ignores a command that is not one of the two animation instructions', () => {
    expect(sword2Players(sword2(sword2TheyDo(0, SWORD2_INS.WALK, ANIM))).size).toBe(0);
  });

  it('plays the animation’s own frame count, forwards and backwards', () => {
    const project = sword2([
      ...sword2AnimCall(0, { value: ANIM }),
      ...sword2AnimCall(20, { value: ANIM }, 64),
    ]);
    const { playbacks, refusal } = sword2AnimationPlaybacks(project, ANIM);
    expect(refusal).toBeNull();
    expect(playbacks.map((playback) => playback.label)).toEqual(['forwards', 'backwards']);
    expect(playbacks[0].frames).toEqual([0, 1, 2]);
    expect(playbacks[1].frames).toEqual([2, 1, 0]);
    expect(playbacks[0].frameMs).toBeCloseTo((SWORD2_TICKS_PER_STEP * 1000) / 60);
  });

  it('says so where no object plays it, rather than picking a speed', () => {
    const { playbacks, refusal } = sword2AnimationPlaybacks(sword2([]), ANIM);
    expect(playbacks).toEqual([]);
    expect(refusal).toMatch(/fnMegaTableAnim/);
    expect(refusal).toMatch(/something false about your own game/);
  });
});

describe('the rate both families play at', () => {
  it('is the engine’s own game cycle and not a number chosen here', () => {
    expect(SWORD1_CYCLE_MS).toBeCloseTo((SWORD1_TICKS_PER_STEP * 1000) / 60);
    expect(SWORD2_CYCLE_MS).toBeCloseTo((SWORD2_TICKS_PER_STEP * 1000) / 60);
    expect(Math.round(1000 / SWORD1_CYCLE_MS)).toBe(12);
  });
});

// --- the panel ------------------------------------------------------------

/** The recording context `tests/sword-brush.test.ts` uses, for the same reason. */
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
      fillRect: () => {},
      strokeRect: () => {},
      save: () => {},
      restore: () => {},
      set fillStyle(_value: string) {},
      set strokeStyle(_value: string) {},
      set lineWidth(_value: number) {},
    } as unknown as CanvasRenderingContext2D;
  } as never);
}

function baseProject(): Project {
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
  };
}

function openSection(root: HTMLElement, title: string): void {
  const head = [...root.querySelectorAll<HTMLButtonElement>('.accordion-head')].find(
    (button) => button.querySelector('.accordion-title')?.textContent === title,
  );
  if (head?.getAttribute('aria-expanded') === 'false') head.click();
}

function clickRow(root: HTMLElement, text: string): void {
  [...root.querySelectorAll('button')]
    .find((button) => button.textContent?.includes(text))
    ?.click();
}

function playButtons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.sword-picture button')].filter((button) =>
    /^(Play|Stop) /.test(button.textContent ?? ''),
  );
}

describe('the Play button on a Broken Sword picture panel', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Sword 1, holding a two-frame sprite the one script plays. */
  function sword1Panel(played: boolean): { editor: Sword1Editor; project: Project } {
    stubCanvas();
    const sprite = buildSpriteResource([
      { width: 2, height: 2, pixels: Uint8Array.from([1, 2, 3, 1]) },
      { width: 2, height: 2, pixels: Uint8Array.from([2, 0, 2, 0]) },
    ]);
    const project: Project = {
      ...baseProject(),
      sword1: {
        ...sword1(animCall(0, { value: TABLE }, { value: played ? SPRITE : 0x04019999 })),
        palettes: [
          { resource: 0x06010000, bytesBase64: toBase64(new Uint8Array(768)), screens: [1] },
        ],
        pictures: [
          {
            resource: SPRITE,
            kind: 'sprite',
            width: 2,
            height: 2,
            frames: 2,
            bytesBase64: toBase64(sprite),
            screens: [1],
          },
        ],
        animTables: [{ resource: TABLE, frames: [1, 0] }],
      },
    };
    const editor = new Sword1Editor({ project: () => project, update: (m) => m(project) });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Pictures');
    clickRow(editor.element, `sprite 0x${SPRITE.toString(16)}`);
    return { editor, project };
  }

  it('offers a keyboard-operable button naming the script that plays it', () => {
    const { editor } = sword1Panel(true);
    const buttons = playButtons(editor.element);
    expect(buttons.length).toBe(1);
    expect(buttons[0].tagName).toBe('BUTTON');
    expect(buttons[0].getAttribute('aria-label')).toMatch(/named by fnAnim in script module/);
  });

  it('draws the table’s frames in order, one a game cycle, and stops on a second press', () => {
    vi.useFakeTimers();
    const { editor } = sword1Panel(true);
    const button = playButtons(editor.element)[0];
    button.click();
    expect(button.textContent).toMatch(/^Stop /);
    expect(editor.element.textContent).toMatch(/Playing 2 frames .* at 12 a second/);
    vi.advanceTimersByTime(SWORD1_CYCLE_MS * 3);
    button.click();
    expect(button.textContent).toMatch(/^Play /);
    expect(editor.element.textContent).toMatch(/Stopped/);
    // And the timer is gone: advancing again must not keep drawing.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says why there is no button where no script plays the sprite', () => {
    const { editor } = sword1Panel(false);
    expect(playButtons(editor.element).length).toBe(0);
    expect(editor.element.textContent).toMatch(/No script in this project plays this sprite/);
  });

  it('offers both runs on a Broken Sword II animation an object plays each way', () => {
    stubCanvas();
    const project: Project = {
      ...baseProject(),
      target: { engine: 'sword2', release: 'cd', platform: 'dos' },
      sword2: sword2([
        ...sword2AnimCall(0, { value: ANIM }),
        ...sword2AnimCall(20, { value: ANIM }, 64),
      ]),
    };
    const editor = new Sword2Editor({ project: () => project, update: (m) => m(project) });
    document.body.appendChild(editor.element);
    openSection(editor.element, 'Animations');
    clickRow(editor.element, 'shrug');
    expect(playButtons(editor.element).map((button) => button.textContent)).toEqual([
      'Play forwards',
      'Play backwards',
    ]);
  });
});
