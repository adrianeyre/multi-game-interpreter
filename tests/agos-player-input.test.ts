// @vitest-environment jsdom
/**
 * What a player does, and whether it reaches the game.
 *
 * The engine could already draw Simon 1, run its bytecode and resolve a click
 * against the boxes its Subroutines define — and a player still could not do
 * anything with it. Three separate faults, none of which errored or drew
 * anything wrong:
 *
 * - keys were listened for on the canvas, which never holds focus, so no key
 *   ever arrived;
 * - no verb was live until the player picked one, where Simon 1 always has one
 *   live, so every click on the floor or on a thing returned "idle";
 * - nothing consulted the player's request to leave a sequence, so the opening
 *   ran for fifty-five seconds with no way out.
 *
 * Each test below is one of those, written so that it fails if the fault comes
 * back rather than only if the mechanism disappears.
 */

import { describe, expect, it } from 'vitest';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import { AgosInput } from '../src/engine/agos/AgosInput.js';
import { AgosInterpreter, AgosState } from '../src/engine/agos/script/AgosInterpreter.js';
import type { AgosGraphicsHooks } from '../src/engine/agos/script/AgosInterpreter.js';
import { HitAreaTable } from '../src/engine/agos/world/hitAreas.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import { AgosBytes, buildArchive, buildGamePcFor } from './fixtureAgos.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

/** Simon 1's opcode numbers, from the table the engine itself decodes with. */
const ADD_BOX = 107;
const DISABLE_BOX = 110;
const WAIT_SYNC = 119;
const B_SET = 153;
const LET = 42;

/**
 * Writes `o_addBox id, x, y, w, h, item, verb`, whose operands are `NNNNNIN`.
 *
 * `item` is the number the *game* writes, which is two below the number it
 * means — the first two item slots are predefined and `fileReadItemID` accounts
 * for them. `'none'` is the separate spelling for a box about nothing: lead 7,
 * which stands alone rather than introducing an id.
 */
function addBox(
  out: AgosBytes,
  box: { id: number; x: number; y: number; width: number; height: number },
  item: number | 'none',
  verb: number,
): void {
  out.byte(ADD_BOX);
  out.word(box.id).word(box.x).word(box.y).word(box.width).word(box.height);
  if (item === 'none') out.word(0x0007);
  else out.word(0x0002).long(item);
  out.word(verb);
}

/**
 * A Simon 1 game whose boot Subroutine builds the interface Simon 1 builds.
 *
 * Box 101 and 102 are the two the default verb comes from, and a room box over
 * the top band is the thing a player clicks. The numbers are the game's own —
 * 101 to 112 for the strip and the room band ending at y 135 — because the
 * default-verb rule is written against box *numbers* rather than against
 * positions.
 */
async function engineWithInterface(
  extra: (out: AgosBytes) => void = () => undefined,
): Promise<AgosEngine> {
  const source = new MemoryDataSource('simon-interface');
  source.set(
    'GAMEPC',
    buildGamePcFor(SIMON1, {
      // The verbs the two default boxes carry, and the one a flagged box uses,
      // so the bar has guards to match them against.
      verbs: [201, 205],
      body: (out) => {
        // The room, carrying the item a click there is about.
        addBox(out, { id: 0, x: 0, y: 0, width: 320, height: 135 }, 2, 201);
        // The strip's first two boxes, whose verbs are the defaults.
        addBox(out, { id: 101, x: 0, y: 144, width: 47, height: 18 }, 3, 201);
        addBox(out, { id: 102, x: 47, y: 144, width: 52, height: 18 }, 3, 205);
        extra(out);
      },
    }),
  );
  source.set('SIMON.GME', buildArchive());
  source.set('SIMON.VOC', Uint8Array.of(0));
  const engine = await AgosEngine.create(source);
  engine.boot();
  engine.step();
  return engine;
}

/**
 * The graphics an interpreter needs but these tests do not use.
 *
 * Required rather than optional on the hooks because a game's whole
 * contribution to the screen is those two calls, so an interpreter without
 * them could not run a real game — and a test of the *waiting* still has to
 * supply them.
 */
function noGraphics(extra: Partial<AgosGraphicsHooks> = {}): AgosGraphicsHooks {
  return { loadZone: () => false, animate: () => false, ...extra };
}

/** The surface an `AgosInput` is given, with the two targets kept apart. */
function surfaceSpy() {
  const canvas = new EventTarget();
  const keys = new EventTarget();
  let resumed = 0;
  return {
    canvas,
    keys,
    get resumed() {
      return resumed;
    },
    surface: {
      canvas: canvas as unknown as HTMLElement,
      keys,
      overlay: new EventTarget() as unknown as HTMLElement,
      toScreen: (client: { clientX: number; clientY: number }) => ({
        x: client.clientX,
        y: client.clientY,
      }),
      resumeSound: () => {
        resumed += 1;
      },
    },
  };
}

function sinkSpy() {
  const clicks: { x: number; y: number }[] = [];
  const keys: string[] = [];
  let rightClicks = 0;
  return {
    clicks,
    keys,
    get rightClicks() {
      return rightClicks;
    },
    sink: {
      verb: () => undefined,
      click: (x: number, y: number) => {
        clicks.push({ x, y });
      },
      key: (key: string) => {
        keys.push(key);
      },
      rightClick: () => {
        rightClicks += 1;
      },
    },
  };
}

describe('a keystroke reaches the game', () => {
  /**
   * The regression, and the reason it was invisible: `InputSurface.keys` is
   * documented as "the window in the app, so a keystroke reaches the game
   * without the canvas having to hold focus", and this listened on the canvas.
   * A canvas with no `tabindex` never receives a `keydown`, so nothing arrived
   * and nothing said so.
   */
  it('listens on the surface it was given for keys, not on the canvas', () => {
    const spy = surfaceSpy();
    const sink = sinkSpy();
    new AgosInput(sink.sink).attach(spy.surface);

    spy.keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sink.keys).toEqual(['Escape']);

    // And not by also listening on the canvas, which would double every key.
    spy.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(sink.keys).toEqual(['Escape']);
  });

  it('stops listening when detached', () => {
    const spy = surfaceSpy();
    const sink = sinkSpy();
    const input = new AgosInput(sink.sink);
    input.attach(spy.surface);
    input.detach();

    spy.keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sink.keys).toEqual([]);
  });
});

describe('a pointer reaches the game', () => {
  it('starts the audio context, which browsers only allow from a gesture', () => {
    const spy = surfaceSpy();
    const sink = sinkSpy();
    new AgosInput(sink.sink).attach(spy.surface);

    spy.canvas.dispatchEvent(
      new MouseEvent('pointerdown', { button: 0, clientX: 10, clientY: 20 }),
    );

    expect(spy.resumed).toBe(1);
    expect(sink.clicks).toEqual([{ x: 10, y: 20 }]);
  });

  /**
   * The right button is not a second click in this family: it has one job,
   * cutting a line of speech short, and it carries no position because it is
   * not a command at one.
   */
  it('reports the right button separately, and does not resolve it as a click', () => {
    const spy = surfaceSpy();
    const sink = sinkSpy();
    new AgosInput(sink.sink).attach(spy.surface);

    spy.canvas.dispatchEvent(
      new MouseEvent('pointerdown', { button: 2, clientX: 10, clientY: 20 }),
    );

    expect(sink.rightClicks).toBe(1);
    expect(sink.clicks).toEqual([]);
  });
});

describe('a verb is always live, which is what makes a click do anything', () => {
  /**
   * `resetVerbs` and the half of `AGOSEngine_Simon1::handleMouseMoved` that
   * calls it. Simon 1 never has an empty bar: box 101's verb stands in over the
   * room and box 102's over the panel. Without it every click returned "idle"
   * and the game looked like one whose scripts were not running.
   */
  it('takes box 101’s verb for a click on the room', async () => {
    const engine = await engineWithInterface();

    expect(engine.verbBar.verb).toBeNull();
    expect(engine.click(100, 60)).toBe(true);
    expect(engine.verbBar.verb).toBe(201);
  });

  it('takes box 102’s verb for a click in the panel, as the reference switches at y 136', async () => {
    const engine = await engineWithInterface();

    // 135 is still the room band; 136 is the panel. The boundary is the
    // reference's own number.
    engine.click(10, 135);
    expect(engine.verbBar.verb).toBe(201);

    engine.verbBar.clear();
    engine.click(10, 136);
    expect(engine.verbBar.verb).toBe(205);
  });

  /**
   * `_defaultVerb = 0` in the reference's strip branch. A player who picked
   * "give" and then moves the pointer over the room towards what they meant to
   * give must not have it quietly turned back into "walk to".
   */
  it('keeps a verb the player picked instead of replacing it with the default', async () => {
    const engine = await engineWithInterface();

    // Click the strip's second box: an explicit choice of verb 205.
    expect(engine.click(60, 150)).toBe(true);
    expect(engine.verbBar.verb).toBe(205);

    // Now click the room, where the default would be 201. The command runs
    // with the verb the player chose.
    engine.click(100, 60);
    expect(engine.verbBar.verb).toBe(205);
  });

  /**
   * A disabled box is the game saying there is no default here — a close-up, a
   * menu, a screen with no verb bar. Leaving the previous room's verb in the
   * bar would issue commands the player never chose.
   */
  it('clears the bar when the game has disabled the box the default comes from', async () => {
    const engine = await engineWithInterface((out) => {
      out.byte(DISABLE_BOX).word(101);
    });

    engine.click(100, 60);
    expect(engine.verbBar.verb).toBeNull();
  });
});

/**
 * `setVerbText` (`input.cpp:34`): variable 60 says which **text box** the player
 * clicked, and **0xFFFF** when the box is not one. Nothing wrote it, so it kept
 * its initial zero — and zero is not "nothing", it is slot zero.
 *
 * The cost was Simon 2's walk. Its street's walk handler opens `o_eq 84, 0 ;
 * o_let 1, 156 ; o_let 2, 112`, and variable 84 is a copy of 60 — so every floor
 * click was read as a click on scenery, the pointer position the click had just
 * written into variables 1 and 2 was replaced by that scenery's standing spot,
 * and Simon walked to the same place wherever the player clicked. With this
 * written he walks to x 216, then x 56, then x 208 for three different clicks.
 */
describe('a click says it was not on a text box, which is not the same as slot zero', () => {
  it('writes 0xFFFF for an ordinary box', async () => {
    const engine = await engineWithInterface();

    engine.click(100, 60);

    const state = (engine as unknown as { state: { read(variable: number): number } }).state;
    expect(state.read(60)).toBe(0xffff);
  });
});

describe('a box may carry a whole command', () => {
  /**
   * `ha->verb & 0x4000` in the reference. The flag says "issue me against my
   * item now" rather than "select me", and the verb is the remaining bits — so
   * a box like this read whole presents a verb number no guard could match and
   * the click would do nothing at all.
   *
   * The two boxes below differ only in that bit, which is what makes the pair
   * the test: the plain one leaves its verb in the bar for the player to point
   * somewhere, and the flagged one does not, because it has already been
   * pointed.
   */
  it('issues a flagged box’s verb instead of selecting it, and masks the flag out', async () => {
    const engine = await engineWithInterface((out) => {
      addBox(out, { id: 20, x: 0, y: 40, width: 20, height: 20 }, 'none', 205);
      addBox(out, { id: 21, x: 40, y: 40, width: 20, height: 20 }, 3, 0x4000 | 205);
    });

    // A box with a verb and nothing to point it at: the verb is selected, and
    // it is the verb the box named rather than the flag bit as well.
    expect(engine.click(5, 45)).toBe(true);
    expect(engine.verbBar.verb).toBe(205);

    // The flagged box: the same verb, against its own item, and nothing is left
    // selected for the next click to pick up.
    engine.verbBar.clear();
    expect(engine.click(45, 45)).toBe(true);
    expect(engine.verbBar.verb).toBeNull();
  });
});

describe('the boxes can be read by id, live or not', () => {
  it('finds a disabled box, where a click does not', () => {
    const table = new HitAreaTable();
    table.add(101, 0, 0, 10, 10, 1, 201);
    table.setEnabled(101, false);

    expect(table.at(5, 5)).toBeUndefined();
    expect(table.find(101)).toMatchObject({ verb: 201, enabled: false });
  });

  it('reads through the flags a box’s id carries, as the rest of the table does', () => {
    const table = new HitAreaTable();
    table.add(3101, 0, 0, 10, 10, 1, 201);

    expect(table.find(101)?.verb).toBe(201);
  });
});

describe('a player can leave a sequence that is playing', () => {
  /**
   * Building the state by hand rather than through a game, because what is
   * under test is the wait itself: a script blocked on a sync, and the two
   * things a player can do about it.
   */
  function blocked(bits: number[] = []) {
    const bytes = buildGamePcFor(SIMON1, {
      body: (out) => {
        for (const bit of bits) out.byte(B_SET).byte(bit);
        // Wait for a sync nothing will ever raise, then set a variable — so a
        // test can see whether the instruction after the wait ran.
        out.byte(WAIT_SYNC).word(4242);
        out.byte(LET).byte(90).word(7);
      },
    });
    const game = readGamePc(bytes, SIMON1);
    const state = new AgosState(game.items);
    const interpreter = new AgosInterpreter(
      game.subroutines,
      state,
      SIMON1,
      noGraphics(),
      game.strings,
    );
    const task = interpreter.begin(101, 'a sequence')!;
    interpreter.advance(task);
    return { interpreter, state, task };
  }

  it('blocks on a sync that never arrives, until asked to stop', () => {
    const { interpreter, state, task } = blocked();

    expect(task.wait).toMatchObject({ kind: 'sync', id: 4242 });
    interpreter.advance(task);
    expect(state.read(90)).toBe(0);
  });

  /**
   * **The instruction after the wait still runs**, which is the property that
   * makes this divergence safe. Escape shortens the waiting, not the script, so
   * nothing is left unexecuted and no later script can find the world half
   * built. Abandoning a sequence is the other route, below, and it needs the
   * game's permission because it does leave instructions unrun.
   */
  it('cuts the wait short and runs the rest of the sequence, when the game has not marked it skippable', () => {
    const { interpreter, state, task } = blocked();

    state.exitCutscene = true;
    interpreter.advance(task);

    expect(state.read(90)).toBe(7);
    expect(task.done).toBe(true);
  });

  /**
   * Bit flag 9 is the game saying the sequence may be abandoned. Then the
   * reference's own route is taken: Subroutine 170 puts the world where the
   * sequence would have left it, and the waiting script is thrown away.
   */
  it('abandons the sequence and lets the game tidy up, when the game has marked it skippable', () => {
    const bytes = buildGamePcFor(SIMON1, {
      body: (out) => {
        out.byte(B_SET).byte(9);
        out.byte(WAIT_SYNC).word(4242);
        // Would run if the sequence were merely un-waited, and must not.
        out.byte(LET).byte(90).word(7);
      },
    });
    const game = readGamePc(bytes, SIMON1);
    const state = new AgosState(game.items);
    const interpreter = new AgosInterpreter(
      game.subroutines,
      state,
      SIMON1,
      noGraphics(),
      game.strings,
    );
    const task = interpreter.begin(101, 'a skippable sequence')!;
    interpreter.advance(task);
    expect(task.wait).toMatchObject({ kind: 'sync', id: 4242 });

    state.exitCutscene = true;
    interpreter.advance(task);

    expect(task.done).toBe(true);
    // The instruction behind the wait was abandoned rather than hurried.
    expect(state.read(90)).toBe(0);
  });

  it('forgets a request made during an earlier wait, so one Escape skips one thing', () => {
    const { interpreter, state, task } = blocked();

    state.exitCutscene = true;
    interpreter.advance(task);
    expect(state.exitCutscene).toBe(false);
  });
});

describe('a line of speech can be cut short', () => {
  function speaking(bits: number[] = []) {
    const bytes = buildGamePcFor(SIMON1, {
      body: (out) => {
        for (const bit of bits) out.byte(B_SET).byte(bit);
        // 200 is the speech wait rather than an id the drawing bytecode raises.
        out.byte(WAIT_SYNC).word(200);
        out.byte(LET).byte(90).word(7);
      },
    });
    const game = readGamePc(bytes, SIMON1);
    const state = new AgosState(game.items);
    let stopped = 0;
    const interpreter = new AgosInterpreter(
      game.subroutines,
      state,
      SIMON1,
      noGraphics({
        stopSpeech: () => {
          stopped += 1;
        },
      }),
      game.strings,
    );
    const task = interpreter.begin(101, 'a line')!;
    // A line that lasts far longer than the test will run for.
    state.speechUntil = 1000;
    interpreter.advance(task);
    return { interpreter, state, task, stopped: () => stopped };
  }

  it('waits for the recording, and the right button ends it', () => {
    const { interpreter, state, task, stopped } = speaking();

    expect(task.wait).toMatchObject({ kind: 'sync', id: 200 });
    interpreter.advance(task);
    expect(state.read(90)).toBe(0);

    state.rightButtonDown = true;
    interpreter.advance(task);

    expect(stopped()).toBe(1);
    expect(state.read(90)).toBe(7);
  });

  /**
   * Bit flag 14 says the mouth-closing animation has already run, and the
   * reference tests it so that a second right button on the same line does not
   * play it twice.
   */
  it('declines when the game says the line has already been closed off', () => {
    const { interpreter, state, task, stopped } = speaking([14]);

    state.rightButtonDown = true;
    interpreter.advance(task);

    expect(stopped()).toBe(0);
    expect(state.read(90)).toBe(0);
  });
});

describe('the whole path, from a keystroke to a script that was stuck', () => {
  /**
   * The three faults together, because separately each of them looks like
   * something else: a key that never arrives looks like a game with no skip, a
   * skip that nothing reads looks like a key that never arrives, and either
   * looks like a script that has hung. This drives the engine the way the shell
   * does — attach a surface, dispatch a real event — and asks whether the
   * script that was waiting for a sync nothing raises has moved on.
   */
  async function stuckGame() {
    const source = new MemoryDataSource('simon-stuck');
    source.set(
      'GAMEPC',
      buildGamePcFor(SIMON1, {
        body: (out) => {
          out.byte(WAIT_SYNC).word(4242);
          // Adding a box is something a test can see from outside, without
          // reaching into the engine: `playerVerbs` reports the boxes that are
          // live, and this one is only added once the wait is over.
          addBox(out, { id: 30, x: 0, y: 0, width: 10, height: 10 }, 'none', 205);
        },
        verbs: [205],
      }),
    );
    source.set('SIMON.GME', buildArchive());
    source.set('SIMON.VOC', Uint8Array.of(0));
    const engine = await AgosEngine.create(source);
    const spy = surfaceSpy();
    engine.input.attach(spy.surface);
    engine.boot();
    engine.step();
    return { engine, spy };
  }

  it('is stuck until a key arrives, and moves on when one does', async () => {
    const { engine, spy } = await stuckGame();

    // Several frames, and the sync never comes.
    for (let frame = 0; frame < 10; frame += 1) engine.step();
    expect(engine.playerVerbs()).toEqual([]);

    // Escape, dispatched where the shell dispatches it.
    spy.keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    engine.step();

    expect(engine.playerVerbs()).toEqual([{ id: 205, boxes: 1, dispatchable: true }]);
  });

  /**
   * A key the interface does not use must not act as a skip, or every keystroke
   * would hurry whatever is playing.
   */
  it('is not moved on by some other key', async () => {
    const { engine, spy } = await stuckGame();

    spy.keys.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
    engine.step();

    expect(engine.playerVerbs()).toEqual([]);
  });
});

describe('a script can queue the next Subroutine', () => {
  /**
   * Variable 254 read as a channel rather than a value, which is what
   * `hitarea_stuff_helper` does on every idle pass: a script that cannot call
   * another directly leaves its number here, and the Engine picks it up once
   * nothing is running.
   */
  it('takes the Subroutine a script left in variable 254, and clears the channel', () => {
    const game = readGamePc(buildGamePcFor(SIMON1, { id: 101 }), SIMON1);
    const state = new AgosState(game.items);
    const interpreter = new AgosInterpreter(
      game.subroutines,
      state,
      SIMON1,
      noGraphics(),
      game.strings,
    );

    expect(interpreter.takeQueuedSubroutine()).toBeNull();

    state.write(254, 101);
    expect(interpreter.takeQueuedSubroutine()).toBe(101);
    // Cleared, or the same Subroutine would be started on every frame for ever.
    expect(state.read(254)).toBe(0);
  });

  it('clears a number naming a Subroutine the game does not have, rather than retrying it', () => {
    const game = readGamePc(buildGamePcFor(SIMON1, { id: 101 }), SIMON1);
    const state = new AgosState(game.items);
    const interpreter = new AgosInterpreter(
      game.subroutines,
      state,
      SIMON1,
      noGraphics(),
      game.strings,
    );

    state.write(254, 9999);
    expect(interpreter.takeQueuedSubroutine()).toBeNull();
    expect(state.read(254)).toBe(0);
  });
});
