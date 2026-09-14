import { describe, expect, it } from 'vitest';
import {
  AgosInterpreter,
  AgosState,
  type AgosGraphicsHooks,
} from '../src/engine/agos/script/AgosInterpreter.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type {
  AgosInstruction,
  AgosOperand,
  AgosSubroutine,
  AgosSubroutineBlock,
} from '../src/engine/agos/script/subroutines.js';
import { buildGamePc } from './fixtureAgos.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

const SIMON2: AgosTarget = {
  family: 'AGOS',
  version: 'Simon2',
  releaseKind: 'talkie',
  platform: 'dos',
};

const names = OPCODE_NAMES.simon1!;

function op(name: string, ...operands: AgosOperand[]): AgosInstruction {
  const opcode = names.indexOf(name);
  if (opcode < 0) throw new Error(`no opcode named ${name}`);
  return { opcode, operands };
}

const word = (value: number): AgosOperand => ({ kind: 'word', value });
const byte = (value: number): AgosOperand => ({ kind: 'byte', value });

function subroutine(id: number, ...lines: AgosInstruction[][]): AgosSubroutine {
  return { id, lines: lines.map((instructions) => ({ instructions })), endMarker: 0xffff };
}

function blockOf(...subroutines: AgosSubroutine[]): AgosSubroutineBlock {
  return { subroutines, endMarker: 0xffff };
}

function interpreterOf(block: AgosSubroutineBlock, graphics?: AgosGraphicsHooks) {
  const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
  const state = new AgosState(game.items);
  return {
    state,
    interpreter: new AgosInterpreter(block, state, SIMON1, graphics, game.strings),
  };
}

/** The same, as Simon 2 — the only difference that matters here is the target. */
function simon2InterpreterOf(block: AgosSubroutineBlock) {
  const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
  const state = new AgosState(game.items);
  return {
    state,
    interpreter: new AgosInterpreter(block, state, SIMON2, undefined, game.strings),
  };
}

/** Simon 2 with a graphics host that answers whether a voice is sounding. */
function simon2InterpreterOfWithSpeech(block: AgosSubroutineBlock, speechActive: () => boolean) {
  const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
  const state = new AgosState(game.items);
  const graphics: AgosGraphicsHooks = {
    loadZone: () => false,
    animate: () => false,
    speechActive,
  };
  return {
    state,
    interpreter: new AgosInterpreter(block, state, SIMON2, graphics, game.strings),
  };
}

/**
 * An AGOS script blocks, and until it could this interpreter was running a
 * different program from the one the game holds.
 *
 * Simon 1's intro is eleven pictures and a dozen synchronised animations. With
 * no way to suspend, the whole sequence ran between two frames of the renderer:
 * every wait fell through, every picture but the last was overwritten before it
 * was drawn, and a player saw the final frame of an intro that had already
 * finished.
 */
describe('a Subroutine that runs across frames', () => {
  it('stops at a wait and carries on where it left off', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(
        subroutine(
          1,
          [op('o_let', byte(10), word(1)), op('o_waitSync', word(500))],
          [op('o_let', byte(11), word(2))],
        ),
      ),
    );

    const task = interpreter.begin(1)!;
    interpreter.advance(task);

    // The first line ran and the second has not: the task is holding a wait.
    expect(state.read(10)).toBe(1);
    expect(state.read(11)).toBe(0);
    expect(task.wait).toEqual({ kind: 'sync', id: 500, until: 1000 });
    expect(task.done).toBe(false);

    // A frame in which nothing arrives changes nothing, which is what makes
    // calling this once a frame the whole of the scheduling.
    interpreter.advance(task);
    expect(state.read(11)).toBe(0);

    // Now the drawing bytecode raises it.
    state.syncsRaised.add(500);
    interpreter.advance(task);

    expect(state.read(11)).toBe(2);
    expect(task.done).toBe(true);
  });

  it('gives up on a sync that never arrives rather than hanging', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(subroutine(1, [op('o_waitSync', word(500))], [op('o_let', byte(11), word(2))])),
    );

    const task = interpreter.begin(1)!;
    interpreter.advance(task);
    expect(task.done).toBe(false);

    // The reference's own thousand drawing-machine ticks, after which it warns
    // and carries on. A wait that cannot time out turns one unraised sync into
    // a hung game.
    state.vgaTicks = 1000;
    interpreter.advance(task);

    expect(state.read(11)).toBe(2);
    expect(task.done).toBe(true);
  });

  it('waits two and a half times as long in Simon 2, which is not Simon 1', () => {
    // `waitForSync`'s cap is `(getGameType() == GType_SIMON1) ? 1000 : 2500`
    // (`script.cpp:1076`): Simon 1 alone waits 1000, and Simon 2 waits 2500.
    // Capping Simon 2 at 1000 timed out every beat of its intro before the VGA
    // sprite raised the sync — one measured beat raises its sync at tick 1794,
    // which a 1000-tick cap never reaches — so the whole intro played by
    // timeout rather than by sync.
    const { state, interpreter } = simon2InterpreterOf(
      blockOf(subroutine(1, [op('o_waitSync', word(500))], [op('o_let', byte(11), word(2))])),
    );

    const task = interpreter.begin(1)!;
    interpreter.advance(task);
    expect(task.wait).toEqual({ kind: 'sync', id: 500, until: 2500 });

    // Still waiting where Simon 1 would already have given up.
    state.vgaTicks = 1000;
    interpreter.advance(task);
    expect(task.done).toBe(false);

    state.vgaTicks = 2500;
    interpreter.advance(task);
    expect(state.read(11)).toBe(2);
    expect(task.done).toBe(true);
  });

  it('does not wait for a sync that has already been raised', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(subroutine(1, [op('o_waitSync', word(7)), op('o_let', byte(11), word(2))])),
    );
    state.syncsRaised.add(7);

    const task = interpreter.begin(1)!;
    interpreter.advance(task);

    // The reference's `_lastVgaWaitFor` short-circuit: a script that waits for
    // what has just happened does not wait.
    expect(state.read(11)).toBe(2);
    expect(task.done).toBe(true);
  });

  it('holds the speech wait while a voice is sounding, and ends it when the sprite raises the sync', () => {
    // The reported "random audio". Sync 200 is the speech wait: the reference
    // never times a line — the mouth sprite loops on `IF_SPEECH` while the
    // voice sounds and raises `SYNC 200` when it stops. This used to satisfy
    // 200 from the clock alone, and a Talkie's MP3 has a length of zero
    // (`playSpeech` returns 0 because the browser decodes it), so `clock >=
    // speechUntil` was true on the frame the wait was set and four lines
    // started on top of each other. With a voice active the clock fallback
    // stands down and the wait holds until the sync is raised.
    const { state, interpreter } = simon2InterpreterOfWithSpeech(
      blockOf(subroutine(1, [op('o_waitSync', word(200))], [op('o_let', byte(11), word(2))])),
      () => true,
    );

    // A zero-length line, exactly as an MP3 hands back: speechUntil is now.
    state.speechUntil = state.clock;

    const task = interpreter.begin(1)!;
    interpreter.advance(task);
    // Still waiting, though the clock has already passed the (zero) length —
    // because a voice is sounding, which is what stops the overlap.
    expect(state.read(11)).toBe(0);
    expect(task.done).toBe(false);

    // The mouth sprite finishes and raises the sync, which is what ends it.
    state.syncsRaised.add(200);
    interpreter.advance(task);
    expect(state.read(11)).toBe(2);
    expect(task.done).toBe(true);
  });

  it('falls back to the clock for the speech wait when no voice is sounding at all', () => {
    // A release with no speech, or a headless run with no audio: nothing will
    // ever raise sync 200, so the clock is the only thing that can end the
    // wait. It stands in only while `speechActive` is false.
    const { state, interpreter } = simon2InterpreterOfWithSpeech(
      blockOf(subroutine(1, [op('o_waitSync', word(200))], [op('o_let', byte(11), word(2))])),
      () => false,
    );
    state.speechUntil = state.clock;

    const task = interpreter.begin(1)!;
    // The first pass sets the wait; the next tests it, exactly as every other
    // wait here — and with no voice sounding and the clock already past the
    // (zero) length, the fallback ends it rather than hanging forever.
    interpreter.advance(task);
    interpreter.advance(task);
    expect(state.read(11)).toBe(2);
    expect(task.done).toBe(true);
  });

  it('ends the Subroutine on o_done rather than running its later lines', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(
        subroutine(
          1,
          [op('o_let', byte(10), word(1)), op('o_done')],
          [op('o_let', byte(11), word(2))],
        ),
      ),
    );

    const task = interpreter.begin(1)!;
    interpreter.advance(task);

    // The shape this matters in is Simon 1's idle timer: "if that bit is set,
    // come back in three seconds and stop here", followed by a line that
    // decrements the countdown the first line had just decided to leave alone.
    expect(state.read(10)).toBe(1);
    expect(state.read(11)).toBe(0);
    expect(task.done).toBe(true);
  });

  it('suspends a nested call with its caller', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(
        subroutine(1, [op('o_process', word(9))], [op('o_let', byte(12), word(3))]),
        subroutine(9, [op('o_waitSync', word(500))], [op('o_let', byte(11), word(2))]),
      ),
    );

    const task = interpreter.begin(1)!;
    interpreter.advance(task);

    // Two frames deep, and the outer one has not moved on: `o_process` is a
    // call, so a callee that blocks blocks the pair.
    expect(task.frames).toHaveLength(2);
    expect(state.read(11)).toBe(0);
    expect(state.read(12)).toBe(0);

    state.syncsRaised.add(500);
    interpreter.advance(task);

    expect(state.read(11)).toBe(2);
    expect(state.read(12)).toBe(3);
    expect(task.done).toBe(true);
  });

  it('runs to completion for a caller with no frames to spend', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(subroutine(1, [op('o_waitSync', word(500))], [op('o_let', byte(11), word(2))])),
    );

    // `run` is the sweep's and a unit test's entry point: it satisfies waits as
    // they arrive, because a caller with no clock cannot wait for the drawing
    // bytecode to raise anything.
    expect(interpreter.run(1)).toBe(true);
    expect(state.read(11)).toBe(2);
  });
});

/**
 * A room object's description reaches the screen through a slot.
 *
 * `oww_addTextBox` puts a slot number on a hit area; `oww_setLongText` fills the
 * slot in with a string (and a recorded voice line where the release has one);
 * and Simon 2's `os2_printLongText` (opcode 70) reads the slot back and shows
 * it. In Simon 1's table opcode 70 is `oww_printLongText`, so this only resolves
 * to the right handler under the Simon 2 target.
 */
describe('a text-box slot shows its stored line', () => {
  function op2(name: string, ...operands: AgosOperand[]): AgosInstruction {
    const opcode = OPCODE_NAMES.simon2!.indexOf(name);
    if (opcode < 0) throw new Error(`no simon2 opcode named ${name}`);
    return { opcode, operands };
  }

  it('reads the slot back, shows the string it holds and sizes the window', () => {
    const { state, interpreter } = simon2InterpreterOf(
      blockOf(subroutine(1, [op2('os2_printLongText', word(3))])),
    );
    // The slot `oww_setLongText` filled in when the room was set up: string 2 is
    // 'three' in the fixture. A recorded voice line rides along but no graphics
    // host is listening here, so only the text is asserted.
    state.longText.set(3, { string: 2, speech: 99 });

    interpreter.run(1);

    expect(state.onScreen).toEqual(['three']);
    expect(state.messages).toContain('three');
    // The reference writes variable 51 with the height the text needs, so the
    // game can size the window: `strlen / 53 * 8 + 8`. 'three' is one line, 8.
    expect(state.read(51)).toBe(8);
  });

  it('shows nothing and stays quiet for a slot the room never filled in', () => {
    const { state, interpreter } = simon2InterpreterOf(
      blockOf(subroutine(1, [op2('os2_printLongText', word(4))])),
    );

    interpreter.run(1);

    // An empty slot is not the game saying nothing; it is the game not asking.
    expect(state.onScreen).toEqual([]);
    expect(state.messages).toEqual([]);
  });
});

/**
 * A word operand from 30000 up is a variable, not a number.
 *
 * `getVarOrWord`, and the rule that makes a click reach the floor: Simon 1's
 * walk handler is `os1_getPathPosn 30001, 30002, 6, 7`, which means *take the x
 * and y out of variables 1 and 2*.
 */
describe('a word operand that names a variable', () => {
  it('reads variable n from a word of 30000 plus n', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(subroutine(1, [op('o_let', byte(5), word(42)), op('o_let', byte(6), word(30_005))])),
    );

    interpreter.run(1);

    expect(state.read(5)).toBe(42);
    // Variable 5, not the number 30005.
    expect(state.read(6)).toBe(42);
  });

  it('leaves a word below the range as the number it is', () => {
    const { state, interpreter } = interpreterOf(
      blockOf(subroutine(1, [op('o_let', byte(5), word(29_999))])),
    );

    interpreter.run(1);

    // Simon's variables number 0 to 255 and the range is twice that, so a word
    // inside it cannot be a literal a game meant — and one below it can.
    expect(state.read(5)).toBe(29_999);
  });
});
