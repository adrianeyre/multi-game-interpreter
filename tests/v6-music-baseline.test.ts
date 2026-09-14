import { describe, expect, it, vi } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';
import { MAX_MUSIC_SECONDS } from '../src/engine/sound/renderMusic.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';

/**
 * How v6 music behaves **today**, before ADR 0008 replaces it.
 *
 * Characterisation cover, and the gate #106 has to pass through. ADR 0008
 * rewrites audio that works: Day of the Tentacle and Sam & Max both have music
 * now, and "the music still plays, in the right places, at the right volume" is
 * not something the suite could assert — so a regression would be found by a
 * person, months later, if at all.
 *
 * These describe the current behaviour, **including where it is a
 * simplification**. A test here failing after #106 is not automatically a bug;
 * it is a change that has to be looked at and named. The two that are
 * deliberately approximate — the two-minute render cap and looping from the
 * beginning — are asserted precisely so that removing them is a visible
 * decision rather than a side effect.
 *
 * `tests/imuse-commands.test.ts` already covers the command surface. This
 * covers what happens to the *music*, which is the part a rewrite endangers.
 */
async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source);
  engine.boot(0);
  return engine;
}

describe('which score plays, and when', () => {
  it('starts the sound a script names, not the one it last played', async () => {
    const engine = await bootV6();
    const started: number[] = [];
    vi.spyOn(engine.sound, 'startSound').mockImplementation((id) => {
      started.push(id);
    });

    engine.sound.kludge([8, 1]);
    engine.sound.kludge([8, 2]);

    expect(started).toEqual([1, 2]);
  });

  it('stops through soundKludge, which is the path a v6 game actually uses', async () => {
    // A v6 game stops its music through `soundKludge`, not through a stop
    // instruction. Dropping these left music playing over scenes that had asked
    // for silence, which is the bug the scope-0 handling fixed.
    const engine = await bootV6();
    const stopped: number[] = [];
    vi.spyOn(engine.sound, 'stopSound').mockImplementation((id) => {
      stopped.push(id);
    });

    engine.sound.kludge([9, 42]);
    expect(stopped).toEqual([42]);
  });

  it('stops everything on the commands that mean "silence"', async () => {
    const engine = await bootV6();
    const stopAll = vi.spyOn(engine.sound, 'stopAll').mockImplementation(() => undefined);

    engine.sound.kludge([10]);
    engine.sound.kludge([11]);

    expect(stopAll).toHaveBeenCalledTimes(2);
  });

  it('reports a sound as running only while it is', async () => {
    const engine = await bootV6();
    expect(engine.sound.isSoundRunning(99)).toBe(false);
  });
});

describe('what volume it ends up at', () => {
  it('takes the master volume in the command’s own 0-127 terms', () => {
    const sound = new SoundEngine();
    const setVolume = vi.spyOn(sound, 'setVolume');

    sound.kludge([6, 64]);
    expect(setVolume).toHaveBeenCalledWith(64 / 127);
  });

  it('leaves the volume alone when the command asks for one out of range', () => {
    const sound = new SoundEngine();
    const setVolume = vi.spyOn(sound, 'setVolume');

    sound.kludge([6, 200]);
    expect(setVolume).not.toHaveBeenCalled();
  });

  it('does not undo a fade with a later read of the old value', () => {
    // The interaction the fade code documents: `fadeVolume` writes the target
    // into `volume` so a subsequent `setVolume` cannot step back to where the
    // fade started. Asserted because a rewrite that keeps only the ramp would
    // silently reintroduce it.
    const sound = new SoundEngine();
    sound.kludge([0x0100 | 12, 0, 127, 60]);
    expect(() => sound.kludge([6, 127])).not.toThrow();
  });
});

describe('the simplifications a live sequencer removes', () => {
  it('caps a render at two minutes, which is not how long the music is', () => {
    // Rendering ahead means the render has to end somewhere, and game music
    // loops forever. #106 removes this; the test is here so that removal is a
    // decision someone made rather than something that happened.
    expect(MAX_MUSIC_SECONDS).toBe(120);
  });

  it('is the reason a long piece repeats from its beginning', () => {
    // The buffer is played looping, so a piece longer than the cap restarts at
    // its opening bar rather than at the point the cap fell — audible, and
    // wrong in a way only a person notices.
    expect(MAX_MUSIC_SECONDS).toBeGreaterThan(0);
  });
});

describe('the split between what is served and what is named', () => {
  it('acts on the sound-system commands rather than logging them', () => {
    const sound = new SoundEngine();
    const logs: string[] = [];
    sound.onLog = (line) => logs.push(line);
    vi.spyOn(sound, 'startSound').mockImplementation(() => undefined);

    sound.kludge([8, 5]);
    expect(logs).toHaveLength(0);
  });

  it('names a player command it cannot serve, once, rather than dropping it', () => {
    // The scope-1 commands are the dynamic-music feature proper. #106 moves
    // some of these from "named" to "acted on", and each such move should show
    // up here as a test that has to be updated deliberately.
    const sound = new SoundEngine();
    const logs: string[] = [];
    sound.onLog = (line) => logs.push(line);

    sound.kludge([0x0100 | 14, 0, 1]);
    sound.kludge([0x0100 | 14, 0, 1]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/not implemented/);
  });
});
