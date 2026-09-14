import { describe, expect, it } from 'vitest';
import { SwordEngine } from '../src/engine/sword1/SwordEngine.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { IT } from '../src/engine/sword1/script/swordTokens.js';
import { CPT, SWORD1_COMPACT_WORDS } from '../src/engine/sword1/resource/swordCompact.js';
import {
  SwordStatus,
  SwordType,
  SWORD1_MENU_BAR_HEIGHT,
  SWORD1_PLAYER,
  SWORD1_SCREEN_WIDTH,
  SwordLogicMode,
} from '../src/engine/sword1/resource/swordDefs.js';
import { SV } from '../src/engine/sword1/script/swordVarIndex.js';
import { BS1L_BUTTON_DOWN } from '../src/engine/sword1/SwordUi.js';
import {
  buildCompactResource,
  buildFontResource,
  buildScriptResource,
  buildSwordFixture,
  buildTextResource,
  type SwordFixtureCluster,
} from './fixtureSword.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { SWORD1_START_DATA } from '../src/engine/sword1/script/startPositions.js';
import { buildSmacker } from './fixtureSmacker.js';

/**
 * A bootable install.
 *
 * The cluster *order* is the fixture's one hard constraint: the generated
 * section tables address `SCRIPTS` as cluster 0, `COMPACTS` as 1, `TEXT` as 2
 * and `GENERAL` as 3, and a resource id carries its cluster in its top byte. So
 * the clusters go in that order or every id in the game points at the wrong
 * file — which is a fixture bug that would look exactly like a reader bug.
 */
function install(
  options: {
    scriptBody?: number[];
    text?: string[];
    withMouseCompact?: boolean;
    videos?: ReadonlyArray<readonly [string, Uint8Array]>;
  } = {},
) {
  const mega = (overrides: Record<number, number> = {}): number[] => {
    const words = new Array(SWORD1_COMPACT_WORDS).fill(0);
    for (const [offset, value] of Object.entries(overrides)) {
      words[Number(offset) >> 2] = value;
    }
    return words;
  };

  // George: a player who runs script 0 of section 128, on screen 1.
  const george = mega({
    [CPT.TYPE]: SwordType.PLAYER,
    [CPT.STATUS]: SwordStatus.LOGIC | SwordStatus.SORT,
    [CPT.LOGIC]: SwordLogicMode.SCRIPT,
    [CPT.SCREEN]: 1,
    [CPT.XCOORD]: 200,
    [CPT.YCOORD]: 300,
    [CPT.TREE + 4]: 128 * 0x10000,
    [CPT.TREE + 24]: 0,
  });

  /**
   * Something clickable: a non-mega on screen 1 with the MOUSE bit and a
   * rectangle in the game's own 128-offset space. 228..328 across and 168..268
   * down is 100..200 / 0..100 once the origin and the menu bar come off, which
   * is a rectangle wholly inside the 640x480 display and away from its edges.
   */
  const doorway = mega({
    [CPT.TYPE]: SwordType.NON_MEGA,
    [CPT.STATUS]: SwordStatus.MOUSE,
    [CPT.SCREEN]: 1,
    [CPT.MOUSE_X1]: 228,
    [CPT.MOUSE_Y1]: 168,
    [CPT.MOUSE_X2]: 328,
    [CPT.MOUSE_Y2]: 268,
    [CPT.PRIORITY]: 1,
    [CPT.MOUSE_CLICK]: 7,
  });

  /**
   * The fixture's boot script with `fnAddHuman` (mcode 49) in front of it.
   *
   * Without it `MOUSE_STATUS` has no human bit and `SwordUi.engine` returns
   * before it hit-tests anything — which is the game's own rule and not a
   * fixture detail, so the scripts that want a pointer have to ask for one.
   */
  const addHuman = [IT.MCODE, 49, 0];

  const scriptBody = options.scriptBody ?? [
    // Count the cycles in a global, then stop for this cycle.
    IT.PUSHVARIABLE,
    SV.RETURN_VALUE_2,
    IT.PUSHNUMBER,
    1,
    IT.PLUS,
    IT.POPVAR,
    SV.RETURN_VALUE_2,
    IT.MCODE,
    19,
    1, // fnPause, which stops the cycle
    IT.PUSHNUMBER,
    1,
    IT.SCRIPTEND,
  ];
  // `fnPause` pops one argument, so the pause count has to be pushed first.
  const script = [IT.PUSHNUMBER, 1, ...scriptBody];
  // George's own script, which additionally turns the human on when the fixture
  // is meant to be clickable.
  const playerScript = options.withMouseCompact
    ? [IT.PUSHNUMBER, 1, ...addHuman, ...scriptBody]
    : script;

  const clusters: SwordFixtureCluster[] = [
    {
      label: 'SCRIPTS',
      groups: 2,
      resources: [
        // 0x01000000 — section 0's scripts, which `fnIdle` reaches for.
        { group: 0, index: 0, bytes: buildScriptResource([script, script]) },
        // 0x01010000 — section 128's scripts.
        { group: 1, index: 0, bytes: buildScriptResource([playerScript]) },
      ],
    },
    {
      label: 'COMPACTS',
      groups: 2,
      resources: [
        // 0x02000000 — section 149, the two text compacts.
        {
          group: 0,
          index: 0,
          bytes: buildCompactResource([
            mega({ [CPT.TYPE]: SwordType.TEXT }),
            mega({ [CPT.TYPE]: SwordType.TEXT }),
          ]),
        },
        // 0x02010000 — section 128, George. With `withMouseCompact`, a second
        // object beside him that asks for the pointer: a compact with the MOUSE
        // status bit, a rectangle and a click script, which is the only thing
        // that puts an entry on the hit list.
        {
          group: 1,
          index: 0,
          bytes: buildCompactResource(options.withMouseCompact ? [george, doorway] : [george]),
        },
      ],
    },
    {
      label: 'TEXT',
      groups: 1,
      resources: [
        { group: 0, index: 0, bytes: buildTextResource(options.text ?? ['hello', 'world']) },
      ],
    },
    {
      label: 'GENERAL',
      groups: 1,
      // 0x04000000 — `GAME_FONT`, because GENERAL is the fourth cluster. A
      // fixture without one cannot tell "the font is missing" from "the font
      // was looked for at the wrong moment".
      resources: [{ group: 0, index: 0, bytes: buildFontResource() }],
    },
  ];

  const fixture = buildSwordFixture(clusters);
  const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
  for (const [label, bytes] of fixture.clusters) entries.push([`clusters/${label}.CLU`, bytes]);
  // A region cluster, so the Release reads as retail rather than as a demo.
  entries.push(['clusters/paris2.clu', new Uint8Array(8)]);
  // Films, under the folder name a release keeps them in. A fixture with no
  // `smackshi/` entry can only test the branch where a sequence is missing.
  for (const [name, bytes] of options.videos ?? []) entries.push([name, bytes]);
  return new MemoryDataSource('sword1 fixture', entries);
}

describe('loading', () => {
  it('is claimed by the Sword1 family rather than falling through to SCUMM', async () => {
    const engine = await loadAdventureEngine(install(), { progress: new LoadProgressTracker() });
    expect(engine).toBeInstanceOf(SwordEngine);
    expect(engine.targetName).toMatch(/^Sword1 /);
  });

  it('reports the Release it identified and the evidence for it', async () => {
    const logs: string[] = [];
    const engine = await SwordEngine.create(install(), { onLog: (line) => logs.push(line) });
    expect(engine.gameId).toBe('sword1-cd');
    expect(logs.join('\n')).toMatch(/paris2\.clu/);
  });

  it('presents one 640x480 space, because its pointer is in display pixels', async () => {
    const engine = await SwordEngine.create(install());
    expect(engine.resolution.script).toEqual({ width: 640, height: 480 });
    expect(engine.resolution.display).toEqual({ width: 640, height: 480 });
  });

  // The regression this pair exists for. `src/main.ts` and `PlayOverlay` both
  // map a click as `(clientY / rect.height) * script.height`, and with a
  // `script.height` of 400 against a 480-pixel canvas that is a scale by 5/6:
  // every Y landed high, and the bottom bar could not be reached at all.
  // Denominated in the bar the click has to land in rather than in the ratio,
  // because a test that asserts the ratio passes at any ratio that is wrong in
  // the same way twice.
  it('maps a click at the foot of the canvas into the bottom menu bar', async () => {
    const engine = await SwordEngine.create(install());
    const { script, display } = engine.resolution;
    /** What the shell does with a pointer event, in one line, as it does it. */
    const toScreenY = (clientY: number, canvasHeight: number): number =>
      Math.floor((clientY / canvasHeight) * script.height);

    // A canvas at 1x, clicked one pixel above its bottom edge. The bottom bar
    // is the conversation chooser, and it starts one bar's height up.
    const atFoot = toScreenY(display.height - 1, display.height);
    expect(atFoot).toBeGreaterThanOrEqual(display.height - SWORD1_MENU_BAR_HEIGHT);

    // And at 2x, because the scale the player picked must not change where a
    // click lands.
    expect(toScreenY((display.height - 1) * 2, display.height * 2)).toBe(atFoot);

    // The top bar still starts at zero, so `SwordUi`'s `pointerY < 40` test is
    // reachable from the top edge.
    expect(toScreenY(0, display.height)).toBe(0);
  });
});

describe('running', () => {
  it('boots into the world the game’s own starting globals describe', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    // `NEW_SCREEN` comes from the 95 non-zero globals a new game starts with,
    // so a booted engine is somewhere rather than nowhere.
    expect(engine.describeStall().join('\n')).toMatch(/sections alive/);
  });

  it('enters a screen before running a cycle, and runs scripts after', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    // The first steps enter the screen (an await), then cycles run.
    for (let tick = 0; tick < 40; tick++) {
      engine.step();
      await Promise.resolve();
    }
    const stall = engine.describeStall().join('\n');
    expect(stall).toMatch(/logic cycles/);
  });

  it('draws without throwing once a screen is entered', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    for (let tick = 0; tick < 20; tick++) {
      engine.step();
      await Promise.resolve();
    }
    expect(() => engine.render()).not.toThrow();
    expect(engine.screen.pixels).toHaveLength(640 * 480);
  });

  it('names an mcode it does not implement rather than stopping', async () => {
    const engine = await SwordEngine.create(
      // mcode 17 is fnPlaySequence, which this project skips.
      install({ scriptBody: [IT.MCODE, 17, 1, IT.PUSHNUMBER, 1, IT.SCRIPTEND] }),
    );
    engine.boot();
    for (let tick = 0; tick < 30; tick++) {
      engine.step();
      await Promise.resolve();
    }
    const status = engine.describeStatus() ?? '';
    const stall = engine.describeStall().join('\n');
    expect(`${status}\n${stall}`).toMatch(/cutscene|fnPlaySequence/);
  });

  it('finds the game font, rather than looking for it before the clusters load', async () => {
    // `SwordEngine.create` builds the text object in the constructor and awaits
    // `loadResident` three lines later, so a font resolved once at construction
    // is resolved at the one moment nothing is fetchable. The symptom is this
    // status line, on an install whose font is present.
    const engine = await SwordEngine.create(install());
    engine.boot();
    expect(engine.describeStatus() ?? '').not.toMatch(/no font/);
  });

  it('no longer carries a caveat about an unimplemented walk animator', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    const stall = engine.describeStall().join('\n');
    expect(stall).not.toMatch(/not implemented/);
    // The router reports itself instead, which is what a stalled walk needs.
    expect(stall).toMatch(/router:/);
  });
});

describe('the start position', () => {
  /** The globals as the save format lays them out, which is index-by-index. */
  const globals = (engine: SwordEngine): number[] =>
    (engine.saveState('probe') as unknown as { scriptVars: number[] }).scriptVars;

  it('places George and names a section, which is what a boot with no start position did not', async () => {
    // Before this existed, `initialise` set the 95 non-zero globals and stopped:
    // `NEW_SCREEN` and `SCREEN` were both zero — the uninitialised value, not a
    // screen number — so the first cycle entered nothing, no region cluster was
    // ever asked for, and the mounted demo drew 0 non-black pixels of 307,200.
    const engine = await SwordEngine.create(install());
    engine.boot();
    const vars = globals(engine);
    expect(vars[SV.CHANGE_X]).toBe(481);
    expect(vars[SV.CHANGE_Y]).toBe(413);
    expect(vars[SV.CHANGE_DIR]).toBe(4); // DOWN
    // Twenty-four bits, and the one place in this family that writes that width.
    expect(vars[SV.CHANGE_PLACE]).toBe(0x010000); // FLOOR_1
    expect(vars[SV.CHANGE_STANCE]).toBe(0); // STAND
    expect(vars[SV.GEORGE_CDT_FLAG]).toBe(0x02010001); // GEO_TLK_TABLE
    // Section 0 is not a place; the original enters section 1 from it.
    expect(vars[SV.NEW_SCREEN]).toBe(1);
  });

  it('starts in the section asked for, which is what "play from here" needs', async () => {
    const engine = await SwordEngine.create(install(), { startPosition: 3 });
    engine.boot();
    expect(globals(engine)[SV.NEW_SCREEN]).toBe(3);
  });

  it('refuses a section the table has no program for, in a sentence, and still boots', async () => {
    const logs: string[] = [];
    // 27 of the 81 entries are null: sections the original can only be reached
    // by playing to. Silently starting in one would put George nowhere.
    const empty = SWORD1_START_DATA.findIndex((entry) => entry === null);
    const engine = await SwordEngine.create(install(), {
      startPosition: empty,
      onLog: (line) => logs.push(line),
    });
    engine.boot();
    expect(logs.join(String.fromCharCode(10))).toMatch(
      new RegExp(`no start position for section ${empty}`),
    );
    expect(() => engine.render()).not.toThrow();
  });

  it('refuses a section past the end of the table rather than reading past it', async () => {
    const logs: string[] = [];
    const engine = await SwordEngine.create(install(), {
      startPosition: 999,
      onLog: (line) => logs.push(line),
    });
    engine.boot();
    expect(logs.join(String.fromCharCode(10))).toMatch(/956\.\.962 naming Spain revisited/);
  });
});

describe('saving', () => {
  it('writes the globals, the compacts and the live list', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    engine.step();
    await Promise.resolve();
    const saved = engine.saveState('slot one') as unknown as {
      scriptVars: number[];
      sections: unknown[];
      liveList: number[];
    };
    expect(saved.scriptVars.length).toBeGreaterThan(1000);
    expect(saved.sections.length).toBeGreaterThan(0);
    expect(saved.liveList).toHaveLength(150);
  });

  it('restores a save it wrote, and the world comes back with it', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    for (let tick = 0; tick < 10; tick++) {
      engine.step();
      await Promise.resolve();
    }
    const george = (engine as unknown as { objects: { fetch(id: number): { x: number } | null } })
      .objects;
    void george;
    const saved = engine.saveState('before');
    const after = await SwordEngine.create(install());
    after.boot();
    expect(() => after.loadState(saved)).not.toThrow();
  });

  it('refuses another family’s save rather than half-applying it', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    const saved = engine.saveState('mine');
    expect(() => after(engine, { ...saved, gameId: 'lure-floppy' })).toThrow(/refused/);
  });

  it('refuses a save from a future format', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    const saved = engine.saveState('mine');
    expect(() => after(engine, { ...saved, format: 99 })).toThrow(/format 99/);
  });

  function after(engine: SwordEngine, saved: ReturnType<SwordEngine['saveState']>): void {
    engine.loadState(saved);
  }

  /** One global, read out of the save's own byte-for-byte copy of the block. */
  function scriptVar(engine: SwordEngine, index: number): number {
    return (engine.saveState('probe') as unknown as { scriptVars: number[] }).scriptVars[index];
  }

  /** Step and draw, letting the event loop turn so a screen load can finish. */
  async function run(engine: SwordEngine, frames: number): Promise<void> {
    for (let at = 0; at < frames; at++) {
      engine.step();
      engine.render();
      await new Promise((done) => setImmediate(done));
    }
  }

  /*
   * The two things a restore is *for*, tested separately because they come back
   * by different routes: where George is standing is in his compact, and what
   * he is carrying is in the globals.
   */

  it('publishes George’s own position as the position the screen is entered at', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    await run(engine, 8);

    // 481,413 is where the start position put George and what `CHANGE_X` and
    // `CHANGE_Y` still say — they hold the *doorway* the room was last entered
    // by, and a restore that leaves them alone walks George back to it. That is
    // the defect this covers: `bin/play-probe.ts` saved at 371,413 on the real
    // demo and restored to 481,413 before `Control::doRestore`'s last five
    // lines (`control.cpp:3084-3090`) were mirrored here.
    expect(scriptVar(engine, SV.CHANGE_X)).toBe(481);
    const player = (
      engine as unknown as { objects: { fetch(id: number): { x: number; y: number } | null } }
    ).objects.fetch(SWORD1_PLAYER);
    if (!player) throw new Error('George has no compact');
    player.x = 371;

    const saved = engine.saveState('mid-room');
    player.x = 251;
    engine.loadState(saved);

    // The globals now say where George is rather than where he came in, so the
    // screen entry that follows stands him where the save did. The entry itself
    // needs a room to load and this fixture's screen has none, so the end to
    // end half of this is measured on the real demo by `bin/play-probe.ts`.
    expect(engine.playerAt()).toEqual({ x: 371, y: 413 });
    expect(scriptVar(engine, SV.CHANGE_X)).toBe(371);
    expect(scriptVar(engine, SV.CHANGE_Y)).toBe(413);
    expect(scriptVar(engine, SV.CHANGE_STANCE)).toBe(0); // STAND
  });

  it('puts back what George was carrying', async () => {
    const engine = await SwordEngine.create(install());
    engine.boot();
    await run(engine, 8);
    expect(engine.inventoryIcons).toEqual([]);

    // A pocket global is the inventory: `SwordUi.buildMenu` reads these 52 and
    // the bar is what it draws, so putting one in and taking it out again is
    // the whole round trip a player would see.
    const logic = (engine as unknown as { logic: { setVar(at: number, value: number): void } })
      .logic;
    logic.setVar(SV.POCKET_1 + 2, 1);
    expect(engine.inventoryIcons).toEqual([3]);

    const saved = engine.saveState('carrying');
    logic.setVar(SV.POCKET_1 + 2, 0);
    expect(engine.inventoryIcons).toEqual([]);
    engine.loadState(saved);
    await run(engine, 8);

    expect(engine.inventoryIcons).toEqual([3]);
  });
});

describe('editing', () => {
  it('opens an editable project with scripts that re-emit byte-identically', async () => {
    const engine = await SwordEngine.create(install());
    expect(engine.describeEditRefusal()).toBeNull();
    const editable = await engine.toEditableGame({
      progress: new LoadProgressTracker(),
    });
    expect(editable).not.toBeNull();
    const project = editable!.project;
    expect(project.target).toMatchObject({ engine: 'sword1', release: 'cd', platform: 'dos' });
    expect(project.sword1?.scripts.length).toBeGreaterThan(0);
    expect(project.sword1?.scripts.every((script) => script.roundTrips)).toBe(true);
    expect(project.sword1?.editable.unrecovered).toBe(0);
  });

  it('carries text, compacts and effects, which is what the surfaces need', async () => {
    const engine = await SwordEngine.create(install({ text: ['one', 'two', 'three'] }));
    const editable = await engine.toEditableGame({ progress: new LoadProgressTracker() });
    const sword1 = editable!.project.sword1!;
    expect(sword1.text[0].lines).toEqual(['one', 'two', 'three']);
    expect(sword1.sections.some((section) => section.compacts.length > 0)).toBe(true);
    expect(sword1.effects.length).toBeGreaterThan(0);
    expect(sword1.surfaces.rooms).toBe('editable-not-writable');
  });

  it('says which clusters are absent rather than showing empty sections', async () => {
    const engine = await SwordEngine.create(install());
    const editable = await engine.toEditableGame({ progress: new LoadProgressTracker() });
    expect(editable!.project.sword1!.clusters.present).toContain('SCRIPTS');
  });
});

/**
 * The four accessors `bin/play-probe.ts` asks this family through.
 *
 * They are tested here rather than left to the probe because the probe is a
 * command and cannot fail a build. Each of these caught something real while it
 * was being written: the hit list is emptied at the end of every cycle, so a
 * `pointerTargets` that re-read the renderer answered zero for a screen with
 * thirteen clickable things on it; and the display/room conversion is three
 * separate offsets, any one of which put the pointer somewhere the game agreed
 * was empty.
 */
describe('what a harness may ask', () => {
  /**
   * Steps the engine, letting the event loop turn between frames.
   *
   * The turn is not optional: entering a screen starts an asynchronous cluster
   * read from inside a synchronous `step`, and a loop that never yields leaves
   * the engine on `loading` forever. `bin/play-probe.ts` has the same `await`
   * for the same reason, and a test written without it measures a game that
   * never got past its first screen change.
   */
  async function run(engine: SwordEngine, frames: number): Promise<void> {
    for (let at = 0; at < frames; at++) {
      engine.step();
      engine.render();
      await new Promise((done) => setImmediate(done));
    }
  }

  /**
   * One script variable, out of the save's byte-for-byte copy of the block.
   *
   * Through the save rather than through a getter: `scriptVars` is not on the
   * envelope's declared type, and the alternative — a public accessor for
   * every variable a test wants — would widen the engine for the tests' sake.
   */
  function scriptVar(engine: SwordEngine, index: number): number {
    return (engine.saveState('probe') as unknown as { scriptVars: number[] }).scriptVars[index];
  }

  it('reports the hit list the pointer was tested against, after the cycle cleared it', async () => {
    const engine = await SwordEngine.create(install({ withMouseCompact: true }));
    engine.boot();
    // `NEW_SCREEN` is 1 from the start position, so the first step enters the
    // screen — asynchronously — and a later one runs a cycle on it.
    await run(engine, 6);
    const targets = engine.pointerTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(128 * 0x10000 + 1);
    expect(targets[0].type).toBe(SwordType.NON_MEGA);
    expect(targets[0].clickScript).toBe(7);
  });

  it('gives the target in display pixels, which is where a pointer can be put', async () => {
    const engine = await SwordEngine.create(install({ withMouseCompact: true }));
    engine.boot();
    await run(engine, 6);
    const [target] = engine.pointerTargets();
    // Inside the display, which a room coordinate handed back unconverted
    // would not be: the rectangle is at 228..328 across in the game's space.
    expect(target.x).toBeGreaterThanOrEqual(0);
    expect(target.x).toBeLessThan(SWORD1_SCREEN_WIDTH);
    expect(target.y).toBeGreaterThanOrEqual(SWORD1_MENU_BAR_HEIGHT);

    // And the engine agrees the point is over that compact, which it records
    // in `SPECIAL_ITEM`. This is the assertion that matters: it goes back
    // through `SwordUi`'s own conversion, so it fails if the origin, the menu
    // bar or the scroll offset is dropped from either direction — and a test
    // that repeated the arithmetic instead would pass with all three wrong.
    engine.input.x = target.x;
    engine.input.y = target.y;
    await run(engine, 1);
    expect(scriptVar(engine, SV.SPECIAL_ITEM)).toBe(target.id);

    // One pixel above the bar is the inventory rather than the room, so the
    // same compact is *not* found there. Without this the test above passes
    // for a conversion that forgot the bar entirely.
    engine.input.y = SWORD1_MENU_BAR_HEIGHT - 1;
    await run(engine, 1);
    expect(scriptVar(engine, SV.SPECIAL_ITEM)).not.toBe(target.id);
  });

  it('says why the player is not in control, and stops saying it when they are', async () => {
    const bare = await SwordEngine.create(install());
    bare.boot();
    await run(bare, 6);
    // Nothing in the bare fixture calls `fnAddHuman`, so the game itself says
    // there is no player in control — which is the true answer, and the one the
    // probe prints rather than calling the engine broken.
    expect(bare.describeNotInteractive()).toMatch(/MOUSE_STATUS has no human bit/);

    const clickable = await SwordEngine.create(install({ withMouseCompact: true }));
    clickable.boot();
    await run(clickable, 6);
    expect(clickable.describeNotInteractive()).toBeNull();
  });

  it('reads George out of his compact, so a script that moves him moves the answer', async () => {
    const engine = await SwordEngine.create(
      install({
        scriptBody: [
          // Write 321 into the running compact's own `XCOORD`, which for
          // section 128 is George.
          IT.PUSHNUMBER,
          321,
          IT.POPLONGOFFSET,
          CPT.XCOORD,
          IT.MCODE,
          19,
          1, // fnPause, which stops the cycle
          IT.PUSHNUMBER,
          1,
          IT.SCRIPTEND,
        ],
      }),
    );
    // The compact's own resident words, before anything has run.
    expect(engine.playerAt()).toEqual({ x: 200, y: 300 });
    engine.boot();
    await run(engine, 6);
    // The world, not the file: a reading that cached the compact at load would
    // still be answering 200,300 here. The y is the start position's
    // `CHANGE_Y`, applied by the mega logic — which is the other half of the
    // same point.
    expect(engine.playerAt()).toEqual({ x: 321, y: 413 });
  });

  it('puts George where a pointer can be put, with the scroll taken off', async () => {
    const engine = await SwordEngine.create(install({ withMouseCompact: true }));
    engine.boot();
    await run(engine, 6);

    // Screen 1 is 784 pixels wide against a 640-pixel display, so the room is
    // scrolled — which is the whole point of this test. At scroll 0 a
    // conversion that forgets the scroll passes every assertion below.
    expect(scriptVar(engine, SV.SCROLL_OFFSET_X)).toBeGreaterThan(0);

    const here = engine.playerAt();
    const feet = engine.playerOnScreen();
    if (!here || !feet) throw new Error('George has no compact');
    expect(feet.x).toBeGreaterThanOrEqual(0);
    expect(feet.x).toBeLessThan(SWORD1_SCREEN_WIDTH);
    expect(feet.y).toBeGreaterThanOrEqual(SWORD1_MENU_BAR_HEIGHT);

    // The assertion that matters: put the pointer where the engine says George
    // is, and the engine's own forward conversion in `SwordUi.engine` lands
    // back on him. A version that drops the scroll is 33 pixels out here —
    // which is the mistake `bin/play-probe.ts` made when it did the subtraction
    // itself, and the reason the subtraction is the engine's now. A check that
    // repeated the arithmetic in the test would have agreed with the bug.
    engine.input.x = feet.x;
    engine.input.y = feet.y;
    await run(engine, 1);
    expect(scriptVar(engine, SV.MOUSE_X)).toBe(here.x);
    expect(scriptVar(engine, SV.MOUSE_Y)).toBe(here.y);
  });

  it('gives a target its whole rectangle, so a caller can aim somewhere inside', async () => {
    const engine = await SwordEngine.create(install({ withMouseCompact: true }));
    engine.boot();
    await run(engine, 6);
    const [target] = engine.pointerTargets();
    expect(target.left).toBeLessThan(target.x);
    expect(target.right).toBeGreaterThan(target.x);
    expect(target.top).toBeLessThan(target.y);
    expect(target.bottom).toBeGreaterThan(target.y);

    // A corner is over the compact and two pixels past the far edge is not, so
    // the rectangle is the one the hit test uses rather than a rectangle drawn
    // around the midpoint. A caller picks a walk point by staying out of every
    // rectangle that is not the floor, and it can only do that if these are the
    // engine's own numbers, converted once, by the engine.
    engine.input.x = target.left + 1;
    engine.input.y = target.top + 1;
    await run(engine, 1);
    expect(scriptVar(engine, SV.SPECIAL_ITEM)).toBe(target.id);

    engine.input.x = target.right + 2;
    engine.input.y = target.bottom + 2;
    await run(engine, 1);
    expect(scriptVar(engine, SV.SPECIAL_ITEM)).not.toBe(target.id);
  });

  it('turns a synthetic press and release into the click the scripts see', async () => {
    const engine = await SwordEngine.create(install({ withMouseCompact: true }));
    engine.boot();
    await run(engine, 6);
    const [target] = engine.pointerTargets();
    engine.input.x = target.x;
    engine.input.y = target.y;
    await run(engine, 1);

    engine.input.pressButton('left');
    await run(engine, 1);
    engine.input.releaseButton('left');
    await run(engine, 3);
    // `MOUSE_BUTTON` is what a script branches on, and `SwordUi` holds a press
    // back a cycle so that a left and a right in one frame arrive together. So
    // this is only 1 after the bits have been through that delay — which is
    // the mechanism the probe's hover/press/release/settle sequence feeds, and
    // a harness that pressed and read in one frame would see 0 forever.
    expect(scriptVar(engine, SV.MOUSE_BUTTON)).toBe(BS1L_BUTTON_DOWN);
  });
});

describe('skipping a cutscene', () => {
  /**
   * A film far longer than any test will sit through.
   *
   * The opening on the disc is 1908 frames, which at this engine's pace is over
   * three minutes; the whole point of Escape is that a player does not watch
   * them. A two-frame fixture would end on its own and pass whether the skip
   * worked or not, so this one is 300 and every assertion below is made inside
   * the first handful.
   */
  const film = (frames: number): Uint8Array =>
    buildSmacker({
      width: 8,
      height: 8,
      frameRateMs: 16,
      frames: Array.from({ length: frames }, (_unused, at) => ({
        blocks: [
          { kind: 'fill' as const, colour: (at % 200) + 1 },
          { kind: 'skip' as const },
          { kind: 'skip' as const },
          { kind: 'skip' as const },
        ],
      })),
    });

  /** An install whose first cycle plays sequence 1, which is `ladder`. */
  function playsAFilm() {
    return install({
      // The fixture pushes the argument before this body runs; mcode 17 is
      // fnPlaySequence and 1 is `ladder` in `SWORD1_SEQUENCE_NAMES`.
      scriptBody: [IT.MCODE, 17, 1, IT.PUSHNUMBER, 1, IT.SCRIPTEND],
      videos: [['smackshi/ladder.smk', film(300)]],
    });
  }

  /** Steps, yielding between frames so the film's load can land. */
  async function step(engine: SwordEngine, frames: number): Promise<void> {
    for (let at = 0; at < frames; at++) {
      engine.step();
      await new Promise((done) => setImmediate(done));
    }
  }

  it('offers the skip only while a film is running', async () => {
    const engine = await SwordEngine.create(playsAFilm());
    engine.boot();
    expect(engine.cutsceneSkippable).toBe(false);

    await step(engine, 4);
    expect(engine.cutsceneSkippable).toBe(true);
    expect(engine.describeStatus() ?? '').toMatch(/press Escape to skip it/);
    expect(engine.describeNotInteractive()).toMatch(/ladder/);
  });

  it('ends a 300-frame film on one Escape rather than on its 300th frame', async () => {
    const engine = await SwordEngine.create(playsAFilm());
    engine.boot();
    await step(engine, 4);
    expect(engine.cutsceneSkippable).toBe(true);

    engine.input.pressSkip();
    engine.step();

    expect(engine.cutsceneSkippable).toBe(false);
    expect(engine.describeStatus() ?? '').not.toMatch(/press Escape/);
  });

  it('keeps playing when nothing is pressed, which is what made the opening long', async () => {
    // The control for the test above: this is what the probe measured before it
    // learned to press. Sixty frames in, with nothing pressed, the film is 1/5
    // of the way through and the player is still not in control.
    const engine = await SwordEngine.create(playsAFilm());
    engine.boot();
    await step(engine, 60);

    expect(engine.cutsceneSkippable).toBe(true);
    expect(engine.describeNotInteractive()).not.toBeNull();
  });
});

describe('the player compact', () => {
  it('is section 128, which is what makes George the player', () => {
    expect(Math.floor(SWORD1_PLAYER / 0x10000)).toBe(128);
  });
});
