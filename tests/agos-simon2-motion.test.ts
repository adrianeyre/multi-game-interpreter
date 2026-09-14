import { describe, expect, it } from 'vitest';
import {
  AgosInterpreter,
  AgosState,
  WALK_SUBROUTINE_VARIABLE,
} from '../src/engine/agos/script/AgosInterpreter.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type {
  AgosSubroutineBlock,
  AgosInstruction,
} from '../src/engine/agos/script/subroutines.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import { buildGamePc } from './fixtureAgos.js';

const SIMON2: AgosTarget = {
  family: 'AGOS',
  version: 'Simon2',
  releaseKind: 'talkie',
  platform: 'dos',
};

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

function opcodeFor(table: 'simon1' | 'simon2', name: string): number {
  const index = OPCODE_NAMES[table]!.indexOf(name);
  if (index < 0) throw new Error(`${table} has no opcode called ${name}`);
  return index;
}

function instruction(opcode: number, ...operands: AgosInstruction['operands']): AgosInstruction {
  return { opcode, operands };
}

function blockOf(instructions: AgosInstruction[]): AgosSubroutineBlock {
  return {
    subroutines: [{ id: 1, lines: [{ instructions }], endMarker: 0xffff }],
    endMarker: 0xffff,
  };
}

function stateFor(target: AgosTarget): AgosState {
  return new AgosState(readGamePc(buildGamePc({ withSpeech: true }), target).items);
}

type AnimateCall = { zone: number; sprite: number; x: number; y: number; palette: number };
type StopCall = { zone: number; sprite: number };

function graphicsSpy() {
  const animated: AnimateCall[] = [];
  const stopped: StopCall[] = [];
  return {
    hooks: {
      loadZone: () => true,
      animate: (zone: number, sprite: number, x: number, y: number, palette: number) => {
        animated.push({ zone, sprite, x, y, palette });
        return true;
      },
      stopAnimate: (zone: number, sprite: number) => {
        stopped.push({ zone, sprite });
      },
    },
    animated,
    stopped,
  };
}

describe("Simon 2's animate takes its zone from the operand, not the id", () => {
  /**
   * Fault 1. `os2_animate` is `NNBNNN` — zone, sprite, an unused byte, x, y,
   * palette. Reading only the first operand as Simon 1 does (zone = id / 100)
   * threw the other five away and started every sprite in the wrong zone. Here
   * the zone is 124 and the sprite 51, whose hundreds column is zero: the old
   * code would have said zone 0.
   */
  it('passes zone, sprite, x, y and palette from the six-operand shape', () => {
    const state = stateFor(SIMON2);
    const gfx = graphicsSpy();
    const run = new AgosInterpreter(
      blockOf([
        instruction(
          opcodeFor('simon2', 'os2_animate'),
          { kind: 'word', value: 124 }, // zone
          { kind: 'word', value: 51 }, // sprite
          { kind: 'byte', value: 7 }, // the unused byte
          { kind: 'word', value: 160 }, // x
          { kind: 'word', value: 96 }, // y
          { kind: 'word', value: 3 }, // palette
        ),
      ]),
      state,
      SIMON2,
      gfx.hooks,
    );

    run.run(1);

    expect(gfx.animated).toEqual([{ zone: 124, sprite: 51, x: 160, y: 96, palette: 3 }]);
  });

  /**
   * Fault 4. `os2_stopAnimate` is `NN` — zone, sprite — and stopped that sprite
   * in that zone. It used to record an unloaded zone this engine never reads,
   * so the sprite went on animating.
   */
  it('stops the sprite the (zone, sprite) pair names', () => {
    const state = stateFor(SIMON2);
    const gfx = graphicsSpy();
    const run = new AgosInterpreter(
      blockOf([
        instruction(
          opcodeFor('simon2', 'os2_stopAnimate'),
          { kind: 'word', value: 124 },
          { kind: 'word', value: 51 },
        ),
      ]),
      state,
      SIMON2,
      gfx.hooks,
    );

    run.run(1);

    expect(gfx.stopped).toEqual([{ zone: 124, sprite: 51 }]);
    // And it does not pretend the whole zone was unloaded.
    expect(state.unloadedZones.has(124)).toBe(false);
  });
});

describe("Simon 2's marks pace a cutscene, blocking until an animation sets one", () => {
  /**
   * Fault 3. `os2_waitMark` used to *set* the bit it named and carry straight
   * on — backwards. It must block until the drawing bytecode raises the bit, so
   * a game script that starts an animation and waits for it to reach a moment
   * actually waits. Here the instruction after the wait is an animate whose
   * spy shows whether the script got past the wait.
   *
   * `run` satisfies waits as they arrive by contract, so this drives the task
   * with `begin`/`advance` to see it suspend and then resume.
   */
  it('suspends on os2_waitMark until the bit is set, then runs on', () => {
    const state = stateFor(SIMON2);
    const gfx = graphicsSpy();
    const run = new AgosInterpreter(
      blockOf([
        instruction(opcodeFor('simon2', 'os2_waitMark'), { kind: 'word', value: 5 }),
        instruction(
          opcodeFor('simon2', 'os2_animate'),
          { kind: 'word', value: 124 },
          { kind: 'word', value: 51 },
          { kind: 'byte', value: 0 },
          { kind: 'word', value: 160 },
          { kind: 'word', value: 96 },
          { kind: 'word', value: 3 },
        ),
      ]),
      state,
      SIMON2,
      gfx.hooks,
    );

    const task = run.begin(1)!;
    run.advance(task);
    // Blocked on the mark: the animate after it has not run.
    expect(gfx.animated).toEqual([]);
    expect(task.done).toBe(false);

    // The mark stays unset, so the script stays put however many frames pass.
    run.advance(task);
    expect(gfx.animated).toEqual([]);

    // The drawing bytecode raises the bit; now the wait arrives and the script
    // runs its animate.
    state.setMark(5);
    run.advance(task);
    expect(gfx.animated).toEqual([{ zone: 124, sprite: 51, x: 160, y: 96, palette: 3 }]);
    expect(task.done).toBe(true);
  });

  /**
   * The reference's own short-circuit: a bit already on satisfies the wait
   * without suspending, so a script does not hang on a moment that has passed.
   */
  it('does not suspend when the bit is already set', () => {
    const state = stateFor(SIMON2);
    const gfx = graphicsSpy();
    state.setMark(5);
    const run = new AgosInterpreter(
      blockOf([
        instruction(opcodeFor('simon2', 'os2_waitMark'), { kind: 'word', value: 5 }),
        instruction(
          opcodeFor('simon2', 'os2_animate'),
          { kind: 'word', value: 124 },
          { kind: 'word', value: 51 },
          { kind: 'byte', value: 0 },
          { kind: 'word', value: 160 },
          { kind: 'word', value: 96 },
          { kind: 'word', value: 3 },
        ),
      ]),
      state,
      SIMON2,
      gfx.hooks,
    );

    const task = run.begin(1)!;
    run.advance(task);

    expect(gfx.animated).toEqual([{ zone: 124, sprite: 51, x: 160, y: 96, palette: 3 }]);
    expect(task.done).toBe(true);
  });

  /**
   * `os2_clearMarks` turns every bit off between scenes, so a mark left set by
   * one cutscene does not let the next one's wait fall straight through.
   */
  it('clears every mark with os2_clearMarks', () => {
    const state = stateFor(SIMON2);
    state.setMark(3);
    state.setMark(11);
    expect(state.hasMark(3)).toBe(true);
    expect(state.hasMark(11)).toBe(true);

    state.clearMarks();

    expect(state.hasMark(3)).toBe(false);
    expect(state.hasMark(11)).toBe(false);
  });
});

describe("Simon 2's walk crosses a junction through variable 249", () => {
  /**
   * The headline of this run. When the walk sprite reaches a room junction it
   * leaves its room-change Subroutine's number in variable 249, and the idle
   * loop — for Simon 2, Feeble and the Puzzle Pack only — drains 249 before 254
   * (`hitarea_stuff_helper_2`). Without that drain the actor stands on the
   * junction with nothing to run the crossing, which is why a click walked Simon
   * nowhere. These pin the channel's rule; `takeQueuedSubroutine` is the seam
   * `AgosEngine.step` reads it through.
   */
  function blockWithSubroutines(ids: number[]): AgosSubroutineBlock {
    return {
      subroutines: ids.map((id) => ({ id, lines: [{ instructions: [] }], endMarker: 0xffff })),
      endMarker: 0xffff,
    };
  }

  it('takes and clears the Subroutine a walk left in 249', () => {
    const state = stateFor(SIMON2);
    const run = new AgosInterpreter(blockWithSubroutines([6]), state, SIMON2, graphicsSpy().hooks);

    state.write(WALK_SUBROUTINE_VARIABLE, 6);
    const taken = run.takeQueuedSubroutine(WALK_SUBROUTINE_VARIABLE);

    expect(taken).toBe(6);
    // Cleared, so the next idle pass does not run the crossing a second time.
    expect(state.read(WALK_SUBROUTINE_VARIABLE)).toBe(0);
  });

  it('reads nothing from an empty channel, which is the normal state', () => {
    const state = stateFor(SIMON2);
    const run = new AgosInterpreter(blockWithSubroutines([6]), state, SIMON2, graphicsSpy().hooks);

    expect(run.takeQueuedSubroutine(WALK_SUBROUTINE_VARIABLE)).toBeNull();
  });

  it('clears a queued id that names no Subroutine rather than running it', () => {
    const state = stateFor(SIMON2);
    const run = new AgosInterpreter(blockWithSubroutines([6]), state, SIMON2, graphicsSpy().hooks);

    state.write(WALK_SUBROUTINE_VARIABLE, 9999);

    expect(run.takeQueuedSubroutine(WALK_SUBROUTINE_VARIABLE)).toBeNull();
    expect(state.read(WALK_SUBROUTINE_VARIABLE)).toBe(0);
  });
});

describe("Simon 1's animate is unchanged by the split", () => {
  /**
   * The falsifier for Fault 1's fix: `os1_animate` keeps deriving its zone from
   * the sprite id's hundreds column, because Simon 1's ids are global. Sprite
   * 13402 lives in zone 134.
   */
  it('still reads the zone from the id it was given', () => {
    const state = stateFor(SIMON1);
    const gfx = graphicsSpy();
    const run = new AgosInterpreter(
      blockOf([
        instruction(
          opcodeFor('simon1', 'os1_animate'),
          { kind: 'word', value: 13402 },
          { kind: 'word', value: 0 },
          { kind: 'word', value: 10 },
          { kind: 'word', value: 20 },
          { kind: 'word', value: 2 },
        ),
      ]),
      state,
      SIMON1,
      gfx.hooks,
    );

    run.run(1);

    expect(gfx.animated).toEqual([{ zone: 134, sprite: 13402, x: 10, y: 20, palette: 2 }]);
  });
});
