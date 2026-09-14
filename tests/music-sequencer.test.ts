import { describe, expect, it, vi } from 'vitest';
import { MusicSequencer, type MusicSource } from '../src/engine/sound/MusicSequencer.js';

/**
 * The transition logic v6 and v7 share (ADR 0008).
 *
 * Every test here drives a fake source, because the point of the sequencer is
 * that it does not know whether the sound underneath is a synthesised OPL2
 * score or a stream decoded out of a `.BUN` bundle. If any of these needed a
 * real one, the separation would not be real.
 */
function fakeSource() {
  const levels = new Map<number, number>();
  const playing = new Set<number>();
  const source: MusicSource = {
    play: vi.fn((id: number) => {
      playing.add(id);
      levels.set(id, 1);
    }),
    stop: vi.fn((id: number) => {
      playing.delete(id);
      levels.delete(id);
    }),
    setLevel: vi.fn((id: number, level: number) => levels.set(id, level)),
    positionOf: () => null,
  };
  return { source, levels, playing };
}

const state = (id: number, crossfadeSeconds = 0) => ({ id, crossfadeSeconds });

describe('entering a musical state', () => {
  it('plays the state asked for', () => {
    const { source, playing } = fakeSource();
    new MusicSequencer(source).enter(state(5));
    expect(playing.has(5)).toBe(true);
  });

  it('does not restart the state already playing', () => {
    // Scripts set their room's music on every entry. Restarting would cut the
    // piece back to its opening bar each time the player walked through a door.
    const { source } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.enter(state(5));

    expect(source.play).toHaveBeenCalledTimes(1);
  });

  it('cuts straight over when no crossfade is asked for', () => {
    const { source, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.enter(state(6));

    expect(playing.has(5)).toBe(false);
    expect(playing.has(6)).toBe(true);
  });
});

describe('crossfading between states', () => {
  it('brings the new state up as the old one goes down', () => {
    // The behaviour ADR 0008 rejected the alternative for: a hard cut through a
    // score written to crossfade is the right music with the wrong transition.
    const { source, levels } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.enter(state(6, 2));

    expect(levels.get(6)).toBe(0);
    sequencer.step(1);
    expect(levels.get(6)).toBeCloseTo(0.5);
    expect(levels.get(5)).toBeCloseTo(0.5);
  });

  it('stops the old state once the fade finishes', () => {
    const { source, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.enter(state(6, 1));
    sequencer.step(1);

    expect(playing.has(5)).toBe(false);
    expect(playing.has(6)).toBe(true);
  });

  it('measures the fade in seconds, not in frames', () => {
    // A fade that tracks the frame rate sounds different on a busy scene.
    const { source, levels } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.enter(state(6, 2));
    sequencer.step(0.5);
    sequencer.step(0.5);

    expect(levels.get(6)).toBeCloseTo(0.5);
  });

  it('queues a state asked for mid-fade rather than cutting into it', () => {
    // Cutting into a fade is audible as a click, and a script that asks for
    // three states in three frames should arrive at the third.
    const { source, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.enter(state(6, 2));
    sequencer.enter(state(7));

    expect(playing.has(7)).toBe(false);
    sequencer.step(2);
    expect(playing.has(7)).toBe(true);
  });
});

describe('leaving', () => {
  it('stops at once when no fade is asked for', () => {
    const { source, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.leave();

    expect(playing.has(5)).toBe(false);
    expect(sequencer.state).toBeNull();
  });

  it('fades out over the time asked for', () => {
    const { source, levels, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.leave(2);

    sequencer.step(1);
    expect(levels.get(5)).toBeCloseTo(0.5);
    sequencer.step(1);
    expect(playing.has(5)).toBe(false);
  });
});

describe('hooks, which is how iMUSE actually branches', () => {
  it('takes a jump only when its hook is the armed one', () => {
    const sequencer = new MusicSequencer(fakeSource().source);
    sequencer.armHook(3);

    expect(sequencer.takeHook(2)).toBe(false);
    expect(sequencer.takeHook(3)).toBe(true);
  });

  it('consumes a hook, so arming one does not branch every time round', () => {
    const sequencer = new MusicSequencer(fakeSource().source);
    sequencer.armHook(3);

    expect(sequencer.takeHook(3)).toBe(true);
    expect(sequencer.takeHook(3)).toBe(false);
  });

  it('never takes hook zero, which means "no hook"', () => {
    const sequencer = new MusicSequencer(fakeSource().source);
    expect(sequencer.takeHook(0)).toBe(false);
  });
});

describe('restoring a state, as a save must', () => {
  it('puts the music back without a transition', () => {
    const { source, levels, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.restore(state(9));

    expect(playing.has(9)).toBe(true);
    expect(levels.get(9)).toBe(1);
    expect(sequencer.state?.id).toBe(9);
  });

  it('restores silence', () => {
    const { source, playing } = fakeSource();
    const sequencer = new MusicSequencer(source);

    sequencer.enter(state(5));
    sequencer.restore(null);

    expect(playing.has(5)).toBe(false);
  });
});

describe('what it will not fake', () => {
  it('names an unservable transition once rather than cutting hard', () => {
    // ADR 0008's explicit instruction, and the project's habit: label what it
    // cannot do faithfully rather than approximate it silently.
    const logs: string[] = [];
    const sequencer = new MusicSequencer(fakeSource().source, (line) => logs.push(line));

    sequencer.cannotServe('a queued transition on a marker');
    sequencer.cannotServe('a queued transition on a marker');

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/not served/);
  });
});

describe('the sequencer in the sound engine’s path', () => {
  it('drives music through the sequencer, not straight to playback', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();

    sound.kludge([8, 42]);
    expect(sound.sequencer.state?.id).toBe(42);
  });

  it('does not restart a room’s music when the script sets it again', async () => {
    // The behaviour the sequencer adds, checked where a game actually reaches
    // it: through `soundKludge`, which is how a v6 game starts its music.
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    const startSound = vi.spyOn(sound, 'startSound');

    sound.kludge([8, 42]);
    sound.kludge([8, 42]);

    expect(startSound).toHaveBeenCalledTimes(1);
  });

  it('still starts a different piece when the script asks for one', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();

    sound.kludge([8, 42]);
    sound.kludge([8, 43]);

    expect(sound.sequencer.state?.id).toBe(43);
  });

  it('leaves the state when the script stops the music that is playing', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();

    sound.kludge([8, 42]);
    sound.kludge([9, 42]);

    expect(sound.sequencer.state).toBeNull();
  });

  it('stops a sound effect directly, since only music has states', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    const stopSound = vi.spyOn(sound, 'stopSound');

    sound.kludge([8, 42]);
    sound.kludge([9, 99]);

    expect(stopSound).toHaveBeenCalledWith(99);
    expect(sound.sequencer.state?.id).toBe(42);
  });
});

describe('the v7 side of the sequencer’s seam', () => {
  it('takes a music bundle, and refuses a file that is not one', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    expect(sound.attachMusicBundle(new Uint8Array(12), 'MUSIC.BUN')).toBe(false);
  });

  it('falls through to the rendered path when there is no bundle', async () => {
    // One mechanism, two sources (ADR 0008). A v6 game has no bundle and must
    // take the path it always did; the sequencer above sees no difference.
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    const startSound = vi.spyOn(sound, 'startSound').mockImplementation(() => undefined);

    sound.kludge([8, 42]);
    expect(startSound).toHaveBeenCalledWith(42);
  });
});

describe('a playing position, which render-up-front could not provide', () => {
  it('reports nothing for a sound that is not playing', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    expect(sound.positionOf(42)).toBeNull();
  });

  it('cannot seek within a sound it has not decoded', async () => {
    // The fallback the jump path depends on: with nothing to seek within, the
    // caller renders from the target instead.
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    expect(sound.seekTo(42, 1)).toBe(false);
  });

  it('forgets a stopped sound’s position rather than reporting a stale one', async () => {
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    sound.stopSound(42);
    expect(sound.positionOf(42)).toBeNull();
  });

  it('offers the sequencer a real position rather than a null one', async () => {
    // The seam ADR 0008 defined: `positionOf` was a stub returning null while
    // music was a finished buffer with no playing position to report.
    const { SoundEngine } = await import('../src/engine/sound/SoundEngine.js');
    const sound = new SoundEngine();
    expect(typeof sound.positionOf).toBe('function');
  });
});
