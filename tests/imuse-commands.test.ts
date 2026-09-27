import { describe, expect, it, vi } from 'vitest';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';

/**
 * iMUSE commands, as `soundKludge` delivers them.
 *
 * The first element packs two bytes: the low one is the command, the high one
 * its scope. Scope 0 addresses the sound system and scope 1 a *player* — the
 * thing sequencing one piece of music.
 *
 * These assert the routing: without an `AudioContext` nothing plays, so no
 * player exists and a player command answers -1 exactly as the original's does
 * for a sound that is not running. What the live sequencer does with a command
 * is `tests/imuse-player.test.ts`'s subject.
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
  it('answers -1 for a sound with no player, as the original does', () => {
    // Scope 1, command 7: jump to a point in the sequence. Served now — but
    // only by a player, and nothing is playing.
    const { sound, logs } = engineWithSpies();
    expect(sound.kludge([0x107, 3, 1, 0, 0])).toBe(-1);
    expect(logs).toEqual([]);
  });

  it('names a command number the original does not have', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x11e, 3]);

    expect(logs.join('\n')).toMatch(/not implemented/);
    expect(logs.join('\n')).toMatch(/scope 1/);
  });

  it('says each distinct command once, since a game polls', () => {
    const { sound, logs } = engineWithSpies();
    for (let i = 0; i < 20; i++) sound.kludge([0x11e, 3]);

    expect(logs).toHaveLength(1);
  });

  it('distinguishes one unknown command from another', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x11e, 3]);
    sound.kludge([0x11f, 1, 2, 3]);

    expect(logs).toHaveLength(2);
  });
});

describe('the commands Day of the Tentacle boots with', () => {
  /**
   * The two `verifying-version-support.md` recorded as caveats: "command 255
   * (scope 255)" and "command 1 (scope 1)".
   */
  it('takes -1 as "process the queue", not as a command', () => {
    // `Sound::soundKludge` special-cases a first argument of -1: it flushes the
    // queued commands. Commands run as they arrive here, so there is nothing
    // to flush and nothing to report.
    const { sound, logs } = engineWithSpies();
    sound.kludge([-1]);
    expect(logs).toEqual([]);
  });

  it('keeps the last result across the flush, as VAR_SOUNDRESULT would', () => {
    const { sound } = engineWithSpies();
    expect(sound.kludge([13, 42])).toBe(0);
    expect(sound.kludge([-1])).toBe(0);
  });

  it('serves command 1 as a player priority rather than naming it', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x101, 5, 90]);
    expect(logs).toEqual([]);
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
   * The routing, not the audio: without an `AudioContext` there is nothing to
   * play, which is also true of the test environment.
   */
  it('is no longer reported as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([8, 5]);
    sound.kludge([0x107, 5, 3, 0]);

    expect(logs.join('\n')).not.toMatch(/command 7/);
  });

  it('no longer reports a loop, which the live sequencer serves', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x109, 5, 1, 2, 3]); // set a loop

    expect(logs.join('\n')).not.toMatch(/not implemented/);
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

  it('no longer reports a transpose hook either', () => {
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x10c, 5, 1, 2, 3]);

    expect(logs.join('\n')).not.toMatch(/not implemented/);
  });
});

describe('triggers, which hang a command on a marker', () => {
  it('no longer reports a trigger as unimplemented', () => {
    const { sound, logs } = engineWithSpies();
    // Command 17 with a non-zero payload arms; the rest is the command to run.
    sound.kludge([17, 5, 0, 3, 9, 5]);

    expect(logs.join('\n')).not.toMatch(/command 17/);
  });

  it('is a trigger only in Sam & Max, where the original makes it one', () => {
    /**
     * Every other iMUSE game numbers 17 `set_channel_volume`. A trigger armed
     * in Sam & Max's numbering reports success; one aimed at a channel that
     * does not exist fails, which is the old system reading the same numbers.
     */
    const { sound } = engineWithSpies();
    expect(sound.kludge([17, 9, 0, 42, 9, 5])).toBe(-1);

    sound.configureImuse({ newSystem: true });
    expect(sound.kludge([17, 9, 0, 42, 9, 5])).toBe(0);
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

  it('takes the hook classes that adjust parts too', () => {
    // Transpose, part on/off, volume and programme hooks are armed the same
    // way and waited on by the score's own sysex, which the player reads.
    const { sound, logs } = engineWithSpies();
    sound.kludge([0x10c, 5, 2, 1, 0]);

    expect(logs.join('\n')).not.toMatch(/not implemented/);
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
