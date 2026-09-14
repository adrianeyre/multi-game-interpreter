import { describe, expect, it, vi } from 'vitest';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';

/**
 * iMUSE commands, as `soundKludge` delivers them.
 *
 * The first element packs two bytes: the low one is the command, the high one
 * its scope. Scope 0 addresses the sound system and scope 1 a *player* — the
 * thing sequencing one piece of music.
 *
 * These are the scope-0 ones, which this engine can act on. The scope-1
 * commands are the dynamic-music feature proper and need a live sequencer; they
 * are asserted here to be *reported* rather than silently dropped, which is the
 * behaviour that hid them before.
 */
function engineWithSpies() {
  const sound = new SoundEngine();
  const logs: string[] = [];
  sound.onLog = (message) => logs.push(message);

  return {
    sound,
    logs,
    startSound: vi.spyOn(sound, 'startSound').mockImplementation(() => undefined),
    stopSound: vi.spyOn(sound, 'stopSound').mockImplementation(() => undefined),
    stopAll: vi.spyOn(sound, 'stopAll').mockImplementation(() => undefined),
    setVolume: vi.spyOn(sound, 'setVolume'),
  };
}

describe('sound-scope iMUSE commands', () => {
  it('starts a sound', () => {
    const { sound, startSound } = engineWithSpies();
    sound.kludge([8, 42]);

    expect(startSound).toHaveBeenCalledWith(42);
  });

  it('stops a sound', () => {
    const { sound, stopSound } = engineWithSpies();
    sound.kludge([9, 42]);

    expect(stopSound).toHaveBeenCalledWith(42);
  });

  it('stops everything', () => {
    /**
     * The one that mattered most: a v6 game asks for silence through this, not
     * through `stopMusic`. Dropping it left music playing over scenes that had
     * asked for none.
     */
    const { sound, stopAll } = engineWithSpies();
    sound.kludge([11]);

    expect(stopAll).toHaveBeenCalled();
  });

  it('sets the master volume, in the command\u2019s own 0-127 terms', () => {
    const { sound, setVolume } = engineWithSpies();
    sound.kludge([6, 127]);

    expect(setVolume).toHaveBeenCalledWith(1);
  });

  it('ignores a volume outside the range the command allows', () => {
    const { sound, setVolume } = engineWithSpies();
    sound.kludge([6, 200]);

    expect(setVolume).not.toHaveBeenCalled();
  });

  it('does nothing for the commands that do nothing in the original either', () => {
    const { sound, logs, startSound, stopAll } = engineWithSpies();
    sound.kludge([2]);
    sound.kludge([3]);

    expect(startSound).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
});

describe('player-scope commands, which need a live sequencer', () => {
  it('names one rather than dropping it', () => {
    // Scope 1, command 7: jump to a point in the sequence.
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x107, 3, 1, 0, 0]);

    expect(logs.join('\n')).toMatch(/not implemented/);
    expect(logs.join('\n')).toMatch(/scope 1/);
  });

  it('says each distinct command once, since a game polls', () => {
    const { sound, logs } = engineWithSpies();
    for (let i = 0; i < 20; i++) sound.kludge([0x107, 3]);

    expect(logs).toHaveLength(1);
  });

  it('distinguishes one unimplemented command from another', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x107, 3]); // jump
    sound.kludge([0x10c, 1, 2, 3]); // set hook

    expect(logs).toHaveLength(2);
  });
});

describe('a malformed command', () => {
  it('ignores an empty argument list rather than reading past it', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([]);

    expect(logs).toEqual([]);
  });
});

describe('a jump command with music playing', () => {
  /**
   * This engine has no sequencer — it renders a score to samples and plays the
   * buffer — so a jump is served by re-rendering from the destination. These
   * assert the routing, not the audio: without an `AudioContext` there is
   * nothing to play, which is also true of the test environment.
   */
  it('is no longer reported as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([8, 5]);
    sound.kludge([0x107, 5, 3, 0]);

    expect(logs.join('\n')).not.toMatch(/command 7/);
  });

  it('still reports the player commands that have no answer here', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x109, 5, 1, 2, 3]); // set a loop

    expect(logs.join('\n')).toMatch(/not implemented/);
  });

  it('does nothing when no music is playing to jump within', () => {
    const { sound } = engineWithSpies();
    expect(() => sound.kludge([0x107, 5, 3, 0])).not.toThrow();
  });
});

describe('loops and fades', () => {
  it('no longer reports a loop as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([8, 5]);
    sound.kludge([0x109, 5, 1, 0, 5, 0]);

    expect(logs.join('\n')).not.toMatch(/command 9/);
  });

  it('no longer reports a volume fade as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x10d, 5, 64, 30]);

    expect(logs.join('\n')).not.toMatch(/command 13/);
  });

  it('takes a fade with no music playing without complaint', () => {
    // A fade is about the output, not about a particular piece, so it is not
    // conditional on something playing.
    const { sound } = engineWithSpies();
    expect(() => sound.kludge([0x10d, 5, 0, 60])).not.toThrow();
  });

  it('still reports a hook, which cannot be served without markers', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x10c, 5, 1, 2, 3]);

    expect(logs.join('\n')).toMatch(/not implemented/);
  });
});

describe('triggers, which hang a command on a marker', () => {
  it('no longer reports a trigger as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    // Command 17 with a non-zero payload arms; the rest is the command to run.
    sound.kludge([17, 5, 0, 3, 9, 5]);

    expect(logs.join('\n')).not.toMatch(/command 17/);
  });

  it('says when a trigger names a marker the score does not carry', () => {
    /**
     * Arming a timer that can never be right is worse than doing nothing: the
     * command would fire at an arbitrary moment rather than not at all.
     */
    const { sound, logs } = engineWithSpies();
    sound.kludge([17, 5, 0, 42, 9, 5]);

    expect(logs.join('\n')).toMatch(/marker 42/);
  });

  it('clears a trigger without complaint', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([19, 5, 0, 3]);

    expect(logs.join('\n')).not.toMatch(/command 19/);
  });

  it('drops armed triggers when everything stops', () => {
    // A trigger belongs to the music it was hung on; left armed it would fire
    // over whatever is playing by then, or over silence.
    const { sound } = engineWithSpies();
    expect(() => {
      sound.kludge([17, 5, 0, 3, 9, 5]);
      sound.stopAll();
    }).not.toThrow();
  });
});

describe('arming a hook', () => {
  it('no longer reports the jump hook as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([8, 5]);
    sound.kludge([0x10c, 5, 0, 3]); // class 0: the jump hook

    expect(logs.join('\n')).not.toMatch(/command 12/);
  });

  it('still reports the hook classes that adjust parts', () => {
    // Transpose, part on/off, volume and program hooks are a different
    // feature, and claiming them would be claiming more than is here.
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x10c, 5, 2, 1, 0]);

    expect(logs.join('\n')).toMatch(/not implemented/);
  });

  it('takes a hook with no music playing without complaint', () => {
    const { sound } = engineWithSpies();
    expect(() => sound.kludge([0x10c, 5, 0, 3])).not.toThrow();
  });

  it('drops armed hooks when everything stops', () => {
    const { sound } = engineWithSpies();
    expect(() => {
      sound.kludge([0x10c, 5, 0, 3]);
      sound.stopAll();
    }).not.toThrow();
  });
});
