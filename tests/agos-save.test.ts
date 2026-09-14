import { describe, expect, it } from 'vitest';
import { AgosState } from '../src/engine/agos/script/AgosInterpreter.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { loadAgosState, saveAgosState } from '../src/engine/agos/save/AgosSaveState.js';
import type { Target } from '../src/authoring/target.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import { buildGamePc } from './fixtureAgos.js';

const AGOS_TARGET: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};
const TALKIE: Target = {
  engine: 'agos',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};
const FLOPPY: Target = { ...TALKIE, releaseKind: 'floppy' };

function freshState(): AgosState {
  return new AgosState(readGamePc(buildGamePc({ withSpeech: true }), AGOS_TARGET).items);
}

describe('saving an AGOS game', () => {
  it('restores the variables and where every item ended up', () => {
    const played = freshState();
    played.write(7, 1234);
    played.place(3, 0); // the object is picked up out of the room

    const saved = saveAgosState(played, TALKIE, 'simon1', 'in the ditch');
    const restored = freshState();
    loadAgosState(restored, saved, TALKIE);

    expect(restored.read(7)).toBe(1234);
    expect(restored.parentOf(3)).toBe(played.parentOf(3));
    expect(restored.parentOf(3)).not.toBe(2);
  });

  it('refuses a save made for the other release of the same game', () => {
    const saved = saveAgosState(freshState(), TALKIE, 'simon1', 'a save');

    // The two decode two opcodes differently, so restoring across them would
    // put the variables into a game whose scripts were read differently.
    expect(() => loadAgosState(freshState(), saved, FLOPPY)).toThrow(/was made for/);
  });

  it('refuses a save from a format it does not read, rather than half-applying it', () => {
    const saved = { ...saveAgosState(freshState(), TALKIE, 'simon1', 'a save'), format: 99 };
    const state = freshState();

    expect(() => loadAgosState(state, saved, TALKIE)).toThrow(/format 99/);
    expect(state.read(7)).toBe(0);
  });
});

/**
 * The pending timers, which the reference saves and this used not to.
 *
 * A room's own scheduled Subroutines live in the timer queue, not in the
 * variables; a save that dropped them restored the world but not the clockwork
 * that drives it, and the engine kept running whatever it was already running
 * — for a fresh boot, the opening. So a save taken in one room resumed the
 * intro and walked out of it (`AgosEngine.loadState`).
 */
describe('a save carries the pending timers', () => {
  it('restores the scheduled Subroutines, rebased onto the loading clock', () => {
    const played = freshState();
    played.clock = 100;
    played.timeEvents.push({ due: 130, subroutine: 5 }); // due in thirty seconds
    played.timeEvents.push({ due: 100, subroutine: 9 }); // due now

    const saved = saveAgosState(played, TALKIE, 'simon1', 'ticking');
    // The file holds them relative to the save, not as absolute clock values.
    expect(saved.timeEvents).toEqual([
      { due: 30, subroutine: 5 },
      { due: 0, subroutine: 9 },
    ]);

    const restored = freshState();
    restored.clock = 500; // a different engine, a different clock
    loadAgosState(restored, saved, TALKIE);

    // Rebased so "in thirty seconds" is thirty seconds from *this* clock.
    expect(restored.timeEvents).toEqual([
      { due: 530, subroutine: 5 },
      { due: 500, subroutine: 9 },
    ]);
  });

  it('replaces the timers rather than merging, so the boot heartbeat is dropped', () => {
    const played = freshState();
    // The save was taken in a room with nothing scheduled — Simon idle, waiting
    // for a click.
    expect(played.timeEvents).toEqual([]);
    const saved = saveAgosState(played, TALKIE, 'simon1', 'idle');

    const loading = freshState();
    loading.timeEvents.push({ due: 0, subroutine: 1 }); // the boot heartbeat
    loadAgosState(loading, saved, TALKIE);

    // Not merged with the boot's timer: the loaded world's schedule is the one
    // that was saved, empty and all.
    expect(loading.timeEvents).toEqual([]);
  });
});
