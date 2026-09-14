import { describe, expect, it } from 'vitest';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { AgiState, F, V } from '../src/engine/agi/script/AgiState.js';
import { LogicEngine, type LogicHost } from '../src/engine/agi/script/LogicEngine.js';
import { opcodeSetFor } from '../src/engine/agi/script/opcodes.js';
import { EGO, createScreenObject } from '../src/engine/agi/ScreenObject.js';
import { PICTURE_TOP } from '../src/engine/agi/gfx/agiPalette.js';
import type { Target } from '../src/authoring/target.js';
import { buildAgiV2Fixture, buildAgiV3Fixture, buildLogic, u16le } from './fixtureAgi.js';

const TARGET: Target = {
  engine: 'agi',
  interpreter: 0x2917,
  platform: 'dos',
  identification: 'agidata',
};

function sourceFrom(files: Map<string, Uint8Array>): MemoryDataSource {
  const source = new MemoryDataSource('agi-fixture');
  for (const [name, bytes] of files) source.set(name, bytes);
  return source;
}

/**
 * A host with nothing behind it, so an opcode's semantics can be asserted on
 * their own.
 *
 * This is the payoff of `LogicHost` being an interface rather than the Engine:
 * the interpreter is testable without a canvas, a sound context or a loaded
 * game.
 */
function stubHost(overrides: Partial<LogicHost> = {}): LogicHost & { logs: string[] } {
  const state = new AgiState();
  state.reset();
  const logs: string[] = [];
  const items = new Array(16).fill(0);
  const nothing = (): void => undefined;

  return {
    state,
    opcodes: opcodeSetFor(TARGET),
    logs,
    logicBytes: () => null,
    logicMessagesEncrypted: () => true,
    itemName: () => '',
    spokenWord: () => '',
    loadPicture: nothing,
    drawPicture: nothing,
    overlayPicture: nothing,
    discardPicture: nothing,
    showPicture: nothing,
    showPriorityScreen: nothing,
    addToPicture: nothing,
    loadView: nothing,
    discardView: nothing,
    viewLoopCount: () => 4,
    viewCelCount: () => 3,
    applyCelSize: nothing,
    loadSound: nothing,
    playSound: nothing,
    stopSound: nothing,
    discardSound: nothing,
    loadLogic: nothing,
    discardLogic: nothing,
    print: nothing,
    display: nothing,
    clearLines: nothing,
    clearTextRect: nothing,
    setTextAttribute: nothing,
    setCursorCharacter: nothing,
    configureScreen: nothing,
    statusLine: nothing,
    textScreen: nothing,
    graphicsScreen: nothing,
    shakeScreen: nothing,
    closeWindow: nothing,
    getNumber: nothing,
    getString: nothing,
    parseString: nothing,
    saidWords: () => [],
    // The real engine sets the flag here, and the whole point of the flag is
    // that a later `said` sees it — so a stub that did nothing would make the
    // "stops matching" test pass for the wrong reason.
    acceptSaid: () => state.setFlag(F.SAID_ACCEPTED, true),
    wordToString: nothing,
    itemRoom: (item) => items[item] ?? 0,
    setItemRoom: (item, room) => {
      items[item] = room;
    },
    carriedRoom: 255,
    showInventoryItem: nothing,
    showInventoryScreen: nothing,
    saveGame: nothing,
    restoreGame: nothing,
    restartGame: nothing,
    showMemory: nothing,
    pauseGame: nothing,
    showVersion: nothing,
    setMenu: nothing,
    setMenuItem: nothing,
    submitMenu: nothing,
    menuInput: nothing,
    random: (low) => low,
    reportUnimplemented: (name) => logs.push(`unimplemented ${name}`),
    log: (message) => logs.push(message),
    ...overrides,
  };
}

/** Runs one Logic built from raw bytecode against a stub host. */
function runCode(code: number[], host = stubHost(), messages: string[] = []) {
  const bytes = new Uint8Array(buildLogic({ code, messages }));
  const engine = new LogicEngine({ ...host, logicBytes: () => bytes });
  engine.run(0);
  return { host, engine };
}

describe('opcode semantics', () => {
  it('assigns, adds and subtracts within one byte, wrapping as AGI does', () => {
    const { host } = runCode([
      0x03,
      5,
      200, // assignn v5 = 200
      0x05,
      5,
      100, // addn v5 += 100  -> 300, wraps to 44
      0x00,
    ]);
    expect(host.state.var(5)).toBe(44);
  });

  /** A countdown that wrapped to 255 would run for ever, and games use these. */
  it('stops decrement at zero rather than wrapping', () => {
    const { host } = runCode([0x03, 5, 1, 0x02, 5, 0x02, 5, 0x02, 5, 0x00]);
    expect(host.state.var(5)).toBe(0);
  });

  it('reads and writes a variable named by another variable', () => {
    const { host } = runCode([
      0x03,
      1,
      7, // v1 = 7
      0x03,
      2,
      42, // v2 = 42
      0x09,
      1,
      2, // lindirectv: v[v1] = v2  -> v7 = 42
      0x0a,
      3,
      1, // rindirect: v3 = v[v1]   -> v3 = 42
      0x00,
    ]);
    expect(host.state.var(7)).toBe(42);
    expect(host.state.var(3)).toBe(42);
  });

  it('sets, resets and toggles flags, including indirectly', () => {
    const { host } = runCode([
      0x0c,
      20, // set f20
      0x0e,
      20, // toggle f20
      0x03,
      1,
      21, // v1 = 21
      0x0f,
      1, // set.v: set f[v1] -> f21
      0x00,
    ]);
    expect(host.state.flag(20)).toBe(false);
    expect(host.state.flag(21)).toBe(true);
  });

  it('multiplies and divides, and leaves a division by zero alone', () => {
    const { host } = runCode([
      0x03,
      1,
      6,
      0xa5,
      1,
      7, // v1 *= 7 -> 42
      0xa7,
      1,
      0, // v1 /= 0 -> unchanged, not Infinity
      0x00,
    ]);
    expect(host.state.var(1)).toBe(42);
  });

  it('reports an unimplemented opcode by name rather than dropping it', () => {
    const { host } = runCode([0xb3, 1, 2, 3, 4, 0x00]);
    expect(host.logs.join(' ')).toMatch(/fence\.mouse/);
  });

  it('stops at an opcode this build has no entry for', () => {
    const { host } = runCode([0xc0, 0x00]);
    expect(host.logs.join(' ')).toMatch(/unknown 0xc0/);
  });
});

describe('a Logic message reaches print intact', () => {
  /**
   * The regression test for a bug real game data found and every test here
   * missed.
   *
   * The interpreter had its own message decryptor, separate from the one the
   * disassembler used, and it restarted the Avis Durgan key at each message
   * instead of at the start of the text region. The **first** message in every
   * Logic therefore came out right and every later one came out as noise — so a
   * single-message test passes and a real game shows half its text as garbage.
   *
   * Hence: more than one message, and the assertion is on the later ones.
   */
  it('decrypts every message, not just the first', () => {
    const printed: string[] = [];
    const host = stubHost({ print: (text) => printed.push(text) });
    runCode([0x65, 1, 0x65, 2, 0x65, 3, 0x00], host, [
      'first message',
      'second message',
      'a third, longer one',
    ]);

    expect(printed).toEqual(['first message', 'second message', 'a third, longer one']);
  });

  it('decrypts a plain table too, which a compressed v3 Logic has', () => {
    const printed: string[] = [];
    const host = stubHost({
      print: (text) => printed.push(text),
      logicMessagesEncrypted: () => false,
    });
    const bytes = new Uint8Array(
      buildLogic({ code: [0x65, 1, 0x65, 2, 0x00], messages: ['one', 'two'], encrypt: false }),
    );
    new LogicEngine({ ...host, logicBytes: () => bytes }).run(0);

    expect(printed).toEqual(['one', 'two']);
  });

  it('says so rather than printing noise when a message is not there', () => {
    const host = stubHost();
    runCode([0x65, 9, 0x00], host, ['only one']);
    expect(host.logs.join(' ')).toMatch(/printed message 9/);
  });
});

describe('conditions', () => {
  function evaluate(conditions: number[], setup: (state: AgiState) => void = () => undefined) {
    const host = stubHost();
    setup(host.state);
    // if (conditions) { set f100 }
    runCode([0xff, ...conditions, 0xff, ...u16le(2), 0x0c, 100, 0x00], host);
    return host.state.flag(100);
  }

  it('compares a variable with a number and with another variable', () => {
    expect(evaluate([0x01, 5, 3], (s) => s.setVar(5, 3))).toBe(true);
    expect(evaluate([0x01, 5, 3], (s) => s.setVar(5, 4))).toBe(false);
    expect(
      evaluate([0x02, 5, 6], (s) => {
        s.setVar(5, 9);
        s.setVar(6, 9);
      }),
    ).toBe(true);
    expect(evaluate([0x03, 5, 10], (s) => s.setVar(5, 4))).toBe(true);
    expect(evaluate([0x05, 5, 2], (s) => s.setVar(5, 4))).toBe(true);
  });

  it('ands its terms together', () => {
    expect(
      evaluate([0x07, 1, 0x07, 2], (s) => {
        s.setFlag(1, true);
        s.setFlag(2, true);
      }),
    ).toBe(true);
    expect(evaluate([0x07, 1, 0x07, 2], (s) => s.setFlag(1, true))).toBe(false);
  });

  /** The two structure bytes an `if` has beyond its tests. */
  it('ors a group and joins it to the surrounding ands', () => {
    // isset(f1) && (isset(f2) || isset(f3))
    const conditions = [0x07, 1, 0xfc, 0x07, 2, 0x07, 3, 0xfc];
    expect(
      evaluate(conditions, (s) => {
        s.setFlag(1, true);
        s.setFlag(3, true);
      }),
    ).toBe(true);
    expect(evaluate(conditions, (s) => s.setFlag(1, true))).toBe(false);
    expect(
      evaluate(conditions, (s) => {
        s.setFlag(2, true);
        s.setFlag(3, true);
      }),
    ).toBe(false);
  });

  it('negates only the term the not precedes', () => {
    expect(
      evaluate([0xfd, 0x07, 1, 0x07, 2], (s) => {
        s.setFlag(2, true);
      }),
    ).toBe(true);
    expect(
      evaluate([0xfd, 0x07, 1, 0x07, 2], (s) => {
        s.setFlag(1, true);
        s.setFlag(2, true);
      }),
    ).toBe(false);
  });

  it('tests inventory with has(), which is a room comparison', () => {
    const host = stubHost();
    host.setItemRoom(3, 255);
    runCode([0xff, 0x09, 3, 0xff, ...u16le(2), 0x0c, 100, 0x00], host);
    expect(host.state.flag(100)).toBe(true);
  });
});

describe('said', () => {
  function saidWith(spoken: number[], wanted: number[], entered = true) {
    const host = stubHost({ saidWords: () => spoken });
    host.state.setFlag(F.ENTERED_COMMAND, entered);
    const words = wanted.flatMap((word) => u16le(word));
    runCode([0xff, 0x0e, wanted.length, ...words, 0xff, ...u16le(2), 0x0c, 100, 0x00], host);
    return host;
  }

  it('matches an exact phrase and consumes the line', () => {
    const host = saidWith([10, 20], [10, 20]);
    expect(host.state.flag(100)).toBe(true);
  });

  it('does not match a phrase the player did not finish', () => {
    expect(saidWith([10], [10, 20]).state.flag(100)).toBe(false);
  });

  it('does not match when the player said more than the phrase', () => {
    expect(saidWith([10, 20, 30], [10, 20]).state.flag(100)).toBe(false);
  });

  /** Group 1 is the wildcard every vocabulary defines. */
  it('matches any word against group 1', () => {
    expect(saidWith([10, 99], [10, 1]).state.flag(100)).toBe(true);
  });

  /**
   * 9999 is "the rest of the line, whatever it is". Without it a game fails to
   * match half the phrases it accepts, which reads as the parser not
   * understanding rather than as an engine fault.
   */
  it('matches the rest of the line against group 9999', () => {
    expect(saidWith([10, 20, 30, 40], [10, 9999]).state.flag(100)).toBe(true);
  });

  it('never matches when the player has typed nothing', () => {
    expect(saidWith([10], [10], false).state.flag(100)).toBe(false);
  });

  /** The first `said` to match consumes the line, so later ones stop trying. */
  it('stops matching once a said has accepted the input', () => {
    const host = stubHost({ saidWords: () => [10] });
    host.state.setFlag(F.ENTERED_COMMAND, true);
    runCode(
      [
        0xff,
        0x0e,
        1,
        ...u16le(10),
        0xff,
        ...u16le(2),
        0x0c,
        100,
        0xff,
        0x0e,
        1,
        ...u16le(10),
        0xff,
        ...u16le(2),
        0x0c,
        101,
        0x00,
      ],
      host,
    );
    expect(host.state.flag(100)).toBe(true);
    expect(host.state.flag(101)).toBe(false);
  });
});

describe('control flow', () => {
  it('skips the block when the condition is false', () => {
    const { host } = runCode([0xff, 0x07, 1, 0xff, ...u16le(2), 0x0c, 100, 0x0c, 101, 0x00]);
    expect(host.state.flag(100)).toBe(false);
    expect(host.state.flag(101)).toBe(true);
  });

  it('runs an else branch when the condition is false', () => {
    // if (f1) { set f100 } else { set f101 }
    const { host } = runCode([
      0xff,
      0x07,
      1,
      0xff,
      ...u16le(5),
      0x0c,
      100,
      0xfe,
      ...u16le(2),
      0x0c,
      101,
      0x00,
    ]);
    expect(host.state.flag(100)).toBe(false);
    expect(host.state.flag(101)).toBe(true);
  });

  it('refuses a runaway goto rather than freezing the page', () => {
    // A backwards jump to itself, which would loop for ever.
    const { host } = runCode([0x0c, 1, 0xfe, ...u16le(0x10000 - 5), 0x00]);
    expect(host.logs.join(' ')).toMatch(/instructions in one cycle/);
  });

  it('refuses a call that recurses rather than overflowing the stack', () => {
    const bytes = new Uint8Array(buildLogic({ code: [0x16, 0, 0x00], messages: [] }));
    const host = stubHost({ logicBytes: () => bytes });
    new LogicEngine(host).run(0);
    expect(host.logs.join(' ')).toMatch(/deep/);
  });

  it('keeps a ring buffer of the instructions it ran', () => {
    const { engine } = runCode([0x0c, 1, 0x0c, 2, 0x0c, 3, 0x00]);
    const names = engine.recentInstructions().map((entry) => entry.name);
    expect(names).toEqual(['set', 'set', 'set', 'return']);
  });
});

describe('a fixture game boots and reaches its first room', () => {
  async function load(which: 'v2' | 'v3') {
    const fixture = which === 'v3' ? buildAgiV3Fixture() : buildAgiV2Fixture();
    return AgiEngine.create(sourceFrom(fixture.files), { random: () => 0.5 });
  }

  it.each(['v2', 'v3'] as const)('as an AGI %s game', async (which) => {
    const engine = await load(which);
    engine.boot();

    // logic 0 moved the game into room 1, and room 1's own Logic drew and
    // showed its picture — which is the whole of "reaches its first
    // interactive room" for a game this size.
    expect(engine.currentRoom).toBe(1);
    expect(engine.state.currentPicture).toBe(1);
    expect(engine.state.pictureShown).toBe(true);
    expect(engine.hasQuit).toBe(false);
  });

  it('runs the room Logic through logic 0, which is the only route there is', async () => {
    const engine = await load('v2');
    engine.boot();
    const names = engine.recentInstructions().map((entry) => entry.name);
    // `call.v` is logic 0 handing over: AGI has no room-entry hook.
    expect(names).toContain('call.v');
    expect(names).toContain('draw.pic');
  });

  it('clears the new-room flag after the cycle that saw it', async () => {
    const engine = await load('v2');
    engine.boot();
    expect(engine.state.flag(F.NEW_ROOM)).toBe(false);
    // And the picture is not redrawn every cycle, which is what that flag is
    // there to prevent.
    engine.state.currentPicture = -1;
    for (let cycle = 0; cycle < 10; cycle++) engine.step();
    expect(engine.state.currentPicture).toBe(-1);
  });

  it('renders the picture into the room band of the screen', async () => {
    const engine = await load('v2');
    engine.boot();
    engine.render();

    // Row 0 is the status line's band and the picture starts at PICTURE_TOP.
    const roomRow = engine.screen.pixels.subarray(
      PICTURE_TOP * 320 + 20 * 320,
      PICTURE_TOP * 320 + 20 * 320 + 320,
    );
    expect(roomRow.some((pixel) => pixel !== 0)).toBe(true);
  });

  it('is loaded by the shared loader rather than by SCUMM detection', async () => {
    const fixture = buildAgiV2Fixture();
    const engine = await loadAdventureEngine(sourceFrom(fixture.files));
    expect(engine.targetName).toMatch(/^AGI v2/);
    expect(engine.saveFormat).toBeGreaterThan(0);
    // AGI is 320x200 in both of ADR 0015's coordinate spaces, as SCUMM is
    // (#213). The pair only diverges for SCI32.
    expect(engine.resolution.script).toEqual({ width: 320, height: 200 });
    expect(engine.resolution.display).toEqual({ width: 320, height: 200 });
  });

  it('answers the whole AdventureEngine surface', async () => {
    const engine = await load('v2');
    engine.boot();

    expect(engine.gameId).toBeTypeOf('string');
    expect(engine.frame).toBeGreaterThan(0);
    expect(engine.roomName(1)).toBeUndefined();
    expect(engine.describeStall().length).toBeGreaterThan(0);
    engine.step();
    engine.render();
  });

  /**
   * ADR 0013's refusal, asked before the work rather than found by attempting
   * it. A shell that can only learn this by calling `toEditableGame` reports it
   * after raising and dropping a spinner, which is indistinguishable from a
   * button that does nothing — and that is how it was reported.
   */
  /**
   * A game stopped at its first screen has two shapes that read identically in
   * a twelve-instruction tail of logic 0: the room's own Logic running every
   * cycle and getting nowhere, or logic 0 never calling it. They need opposite
   * fixes, so the stall report says which one it is.
   */
  it('says which Logics are running when a game gets nowhere', async () => {
    const engine = await load('v2');
    engine.boot();
    engine.step();

    const line = engine.describeStall().find((entry) => entry.startsWith('Logics run:'));
    expect(line).toBeDefined();
    expect(line).toMatch(/\b0\b/);
  });

  it('says why it cannot be edited before anything tries to edit it', async () => {
    const engine = await load('v2');

    const refusal = engine.describeEditRefusal();
    expect(refusal).toMatch(/could not be identified/);

    // The same words either way round, so the button's answer and the thrown
    // one cannot drift apart.
    await expect(engine.toEditableGame({ progress: new LoadProgressTracker() })).rejects.toThrow(
      refusal!,
    );
  });

  it('refuses nothing once a version has been declared for it', async () => {
    const engine = await loadAdventureEngine(sourceFrom(buildAgiV2Fixture().files), {
      declaredInterpreter: { interpreter: 0x2440, platform: 'dos' },
    });

    expect(engine.describeEditRefusal()).toBeNull();
  });

  it('refuses nothing once the interpreter has been read from the game', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.set('AGIDATA.OVL', new TextEncoder().encode('AGI 2.917'));
    const engine = await loadAdventureEngine(sourceFrom(fixture.files));

    expect(engine.describeEditRefusal()).toBeNull();
  });
});

describe('the cycle order', () => {
  /**
   * #129: "a game that renders before it moves looks fine and desynchronises".
   * The check that holds it is that a script reading a position sees where the
   * object is *now*, not where it was last cycle.
   */
  it('moves objects before running the logics, not after', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    const ego = engine.state.object(EGO);
    ego.animated = true;
    ego.drawn = true;
    ego.x = 50;
    ego.y = 100;
    ego.stepSize = 4;
    ego.stepTime = 1;
    // Set through the variable rather than on the object, because that is the
    // real path: under player control the cycle copies `V.EGO_DIRECTION` into
    // ego before it moves anything, so writing the object directly is
    // overwritten a moment later.
    engine.state.setVar(V.EGO_DIRECTION, 3); // east

    const before = ego.x;
    engine.state.setVar(V.TIME_DELAY, 0);
    engine.step();

    expect(ego.x).toBeGreaterThan(before);
  });

  it('paces itself from the time-delay variable rather than every frame', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.setVar(V.TIME_DELAY, 2);

    const room = engine.currentRoom;
    const framesBefore = engine.frame;
    for (let frame = 0; frame < 5; frame++) engine.step();
    // Frames still advance; the point is that the cycle does not run on all of
    // them, which is what keeps an AGI game at its authored speed.
    expect(engine.frame).toBe(framesBefore + 5);
    expect(engine.currentRoom).toBe(room);
  });
});

describe('a new room resets what AGI resets and preserves what it preserves', () => {
  it('keeps the variables, the flags and ego view, and clears the object table', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    engine.state.setVar(V.SCORE, 42);
    engine.state.setFlag(200, true);
    const ego = engine.state.object(EGO);
    ego.view = 0;
    ego.animated = true;
    const other = engine.state.object(3);
    other.animated = true;
    other.view = 7;
    other.cycling = true;

    engine.state.setVar(V.TIME_DELAY, 0);
    engine.state.pendingRoom = 1;
    engine.step();

    // Preserved: the score, the author's own flags, and ego's View.
    expect(engine.state.var(V.SCORE)).toBe(42);
    expect(engine.state.flag(200)).toBe(true);
    expect(engine.state.var(V.EGO_VIEW)).toBe(ego.view);
    // Reset: every other object's animation state, and player control.
    expect(other.cycling).toBe(false);
    expect(other.view).toBe(0);
    expect(engine.state.playerControl).toBe(true);
  });

  it('records the room it came from, so a script can tell which door was used', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    expect(engine.state.var(V.PREVIOUS_ROOM)).toBe(0);
    expect(engine.state.var(V.CURRENT_ROOM)).toBe(1);
  });
});

describe('blocking, which comes from the picture rather than the geometry', () => {
  /**
   * AGI's whole answer to walk boxes. Priority 0 is a control line that blocks,
   * and it is drawn into the picture — so what blocks walking is a property of
   * the art (`CONTEXT.md`).
   */
  it('refuses a step onto a priority-0 control line', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    const ego = engine.state.object(EGO);
    ego.animated = true;
    ego.drawn = true;
    ego.width = 1;
    ego.x = 50;
    ego.y = 100;
    ego.stepSize = 1;
    ego.stepTime = 1;
    engine.state.setVar(V.EGO_DIRECTION, 3); // east

    // Paint a control line directly to the east.
    const priority = (engine as unknown as { picture: { priority: Uint8Array } }).picture.priority;
    for (let row = 90; row < 110; row++) priority[row * 160 + 51] = 0;

    engine.state.setVar(V.TIME_DELAY, 0);
    engine.step();
    expect(ego.x).toBe(50);
    expect(ego.stopped).toBe(true);
  });

  it('stops at a screen edge and records which edge it was', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    const ego = engine.state.object(EGO);
    ego.animated = true;
    ego.drawn = true;
    ego.width = 1;
    ego.x = 0;
    ego.y = 100;
    ego.stepSize = 1;
    ego.stepTime = 1;
    engine.state.setVar(V.EGO_DIRECTION, 7); // west, into the left edge

    engine.state.setVar(V.TIME_DELAY, 0);
    engine.step();
    expect(ego.x).toBe(0);
    expect(engine.state.var(V.EGO_BORDER)).toBe(4);
  });
});

describe('keys, controllers and when input is consumed', () => {
  /**
   * A game binds a controller to a key with `set.key(ascii, scan, controller)`
   * and uses whichever half suits: Tab by ASCII, F10 by scan code.
   *
   * Comparing low bytes unconditionally means every scan-code binding has an
   * ASCII part of zero — so pressing *any* function key, whose ASCII part is
   * also zero, fires all of them at once. Enclosure binds five controllers that
   * way, one of which skips its opening cutscene.
   */
  it('fires only the controller whose half of the binding matches', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    engine.state.keyBindings.set(10, 9); // Tab, by ASCII
    engine.state.keyBindings.set(40, 0x4400); // F10, by scan code
    engine.state.keyBindings.set(2, 0x3b00); // F1, by scan code

    engine.pressKey(0x4400);
    expect([...engine.state.firedControllers]).toEqual([40]);

    engine.state.firedControllers.clear();
    engine.pressKey(9);
    expect([...engine.state.firedControllers]).toEqual([10]);
  });

  it('never fires a disabled controller', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.keyBindings.set(20, 0x4400);
    engine.state.disabledControllers.add(20);

    engine.pressKey(0x4400);
    expect([...engine.state.firedControllers]).toEqual([]);
  });

  /**
   * A key arrives *between* cycles and the logics that test it run in the
   * middle of one, so clearing at the top of `step` throws the press away
   * before anything can see it — which reads as a game ignoring its own
   * controls.
   */
  it('keeps a controller fired between cycles until the logics have run', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.setVar(V.TIME_DELAY, 0);
    engine.state.keyBindings.set(40, 0x4400);

    engine.pressKey(0x4400);
    expect(engine.state.firedControllers.has(40)).toBe(true);

    // Still set while the cycle runs, and cleared only once it is over.
    let seenDuringCycle = false;
    engine.onInstruction = () => {
      if (engine.state.firedControllers.has(40)) seenDuringCycle = true;
    };
    engine.step();
    engine.onInstruction = null;

    expect(seenDuringCycle, 'the logics never saw the controller').toBe(true);
    expect(engine.state.firedControllers.has(40)).toBe(false);
  });
});

describe('the game starts as though it had just entered a room', () => {
  /**
   * How a game's one-off setup runs at all: the first-cycle code tests flag 5
   * the same way a room's entry code does, rather than having a hook of its
   * own.
   *
   * Enclosure binds every one of its keys inside `if (isset(f5))` in logic 91,
   * called from logic 0's first cycle. Without this the block never runs, no
   * key is ever bound, and the game silently ignores its own controls.
   */
  it('sets the new-room flag before the first cycle, alongside the first-time flag', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));

    engine.state.reset();
    expect(engine.state.flag(F.NEW_ROOM)).toBe(true);
    expect(engine.state.flag(F.LOGIC_ZERO_FIRST_TIME)).toBe(true);
  });
});

describe('text attributes in graphics mode', () => {
  /**
   * In graphics mode, **any** non-zero background means inverted — black on
   * white — whatever colours were actually asked for. Not an approximation:
   * Enclosure's logo screen asks for `set.text.attribute(0, 1)`, black on
   * *blue*, and the reference screenshot that ships with the game shows black
   * on white.
   *
   * Found by comparing a render against that screenshot, which is the check
   * #127 asks for doing exactly what it is for.
   */
  it('reads a non-zero background as black on white, not as the colour asked for', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    engine.setTextAttribute(0, 1);
    engine.display(19, 8, 'HELLO');
    engine.render();

    const pixels = engine.screen.pixels;
    const row = 19 * 8;
    const cell = pixels.subarray(row * 320 + 8 * 8, row * 320 + 8 * 8 + 8);
    // White ground with black glyph pixels in it — not blue anywhere.
    expect([...cell]).toContain(15);
    expect([...cell]).not.toContain(1);
  });

  it('treats a zero background as transparent, so a picture shows through', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();

    engine.setTextAttribute(9, 0);
    engine.display(19, 8, 'X');
    engine.render();

    const row = 19 * 8;
    const cell = engine.screen.pixels.subarray(row * 320 + 8 * 8, row * 320 + 8 * 8 + 8);
    // The glyph is drawn in the colour asked for, and the rest is untouched.
    expect([...cell]).toContain(9);
  });
});

describe('move.obj arrives when it is within one step, not exactly on target', () => {
  /**
   * A real game hung on its own title screen because of this.
   *
   * AGI works out a direction by comparing each axis's remaining distance
   * against the **step size**, and a direction of zero *is* the arrival test.
   * Testing for exact equality instead means an object four pixels from its
   * target with a step of six overshoots to +2, turns round, overshoots back,
   * and never sets the flag its script is polling — so the script waits for
   * ever while everything else looks fine.
   *
   * Enclosure's intro does `move.obj(o4, 104, 20, 6, f223)` from x=100.
   */
  it('sets the arrival flag when the gap is smaller than the step', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.setVar(V.TIME_DELAY, 0);

    const object = engine.state.object(4);
    object.animated = true;
    object.updating = true;
    object.x = 100;
    object.y = 20;
    object.stepSize = 6;
    object.stepTime = 1;
    object.motion = 'move.obj';
    object.moveTo = { x: 104, y: 20, endFlag: 223 };
    engine.state.setFlag(223, false);

    engine.step();

    expect(engine.state.flag(223)).toBe(true);
    expect(object.motion).toBe('none');
  });

  it('walks there first when the gap is larger than the step', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.setVar(V.TIME_DELAY, 0);

    const object = engine.state.object(4);
    object.animated = true;
    object.updating = true;
    object.ignoreBlocks = true;
    object.ignoreHorizon = true;
    object.x = 20;
    object.y = 100;
    object.stepSize = 5;
    object.stepTime = 1;
    object.motion = 'move.obj';
    object.moveTo = { x: 60, y: 100, endFlag: 223 };
    engine.state.setFlag(223, false);

    engine.step();
    expect(engine.state.flag(223)).toBe(false);
    expect(object.x).toBeGreaterThan(20);

    // And it does arrive rather than oscillating around the target for ever.
    for (let cycle = 0; cycle < 40 && !engine.state.flag(223); cycle++) engine.step();
    expect(engine.state.flag(223)).toBe(true);
    expect(Math.abs(object.x - 60)).toBeLessThan(object.stepSize);
  });

  it('hands control back to the player when ego finishes a scripted walk', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.setVar(V.TIME_DELAY, 0);
    engine.state.playerControl = false;

    const ego = engine.state.object(EGO);
    ego.animated = true;
    ego.updating = true;
    ego.x = 50;
    ego.y = 100;
    ego.stepSize = 4;
    ego.motion = 'move.obj';
    ego.moveTo = { x: 52, y: 100, endFlag: 60 };

    engine.step();
    expect(engine.state.flag(60)).toBe(true);
    expect(engine.state.playerControl).toBe(true);
  });
});

describe('animation cycling', () => {
  it('wraps a plain cycle and sets a flag at the end of a one-shot one', async () => {
    const engine = await AgiEngine.create(sourceFrom(buildAgiV2Fixture().files));
    engine.boot();
    engine.state.setVar(V.TIME_DELAY, 0);

    const object = engine.state.object(2);
    Object.assign(object, createScreenObject(2), {
      animated: true,
      drawn: true,
      updating: true,
      cycling: true,
      celCount: 3,
      cycleTime: 1,
      cycleUntilEnd: 'forward' as const,
      cycleEndFlag: 60,
    });

    for (let cycle = 0; cycle < 6; cycle++) engine.step();

    expect(engine.state.flag(60)).toBe(true);
    expect(object.cycling).toBe(false);
  });
});
