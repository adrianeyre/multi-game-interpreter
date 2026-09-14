import { describe, expect, it, vi } from 'vitest';
import {
  DIGITAL_COMMAND,
  DIGITAL_GROUP,
  DIGITAL_PARAM,
  DigitalImuse,
  type DigitalAudio,
} from '../src/engine/sound/v7/digitalImuse.js';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';

/**
 * iMUSE Digital's script commands, which v7 delivers through the same opcode
 * v6 uses for iMUSE's MIDI commands and with an entirely different numbering.
 *
 * These assert the dispatch and its arithmetic, not the audio: the seam exists
 * because levels and pans need an `AudioContext` and the numbering does not,
 * which is also the reason the numbering was wrong for so long — nothing could
 * see it.
 */
function dispatch(cues: number[] = []) {
  const logs: string[] = [];
  const audio: DigitalAudio = {
    playMusicCue: vi.fn((id: number) => cues.includes(id)),
    playStreamCue: vi.fn((id: number) => cues.includes(id)),
    stop: vi.fn(),
    stopAll: vi.fn(),
    setLevel: vi.fn(),
    fadeLevel: vi.fn(),
    setPan: vi.fn(),
    fadePan: vi.fn(),
  };
  return { imuse: new DigitalImuse(audio, (line) => logs.push(line)), audio, logs };
}

describe('iMUSE Digital command numbering', () => {
  it('reads a sixteen-bit command rather than a scope and a command byte', () => {
    // 0x1000 is `SetState`. Split into bytes it reads as command 0, scope 16 —
    // which is what The Dig reported as unimplemented for the whole of v7.
    const { imuse } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetState, 7]);

    expect(imuse.musicState.state).toBe(7);
  });

  it('ignores an empty argument list rather than dispatching on undefined', () => {
    const { imuse, logs } = dispatch();
    imuse.command([]);

    expect(logs).toEqual([]);
  });

  it('reports an unknown command once, by both its numberings', () => {
    const { imuse, logs } = dispatch();
    imuse.command([0x1234, 5]);
    imuse.command([0x1234, 6]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('4660');
    expect(logs[0]).toContain('0x1234');
  });
});

describe('iMUSE Digital group volumes', () => {
  it('starts every group at full', () => {
    const { imuse } = dispatch();

    expect(imuse.groupVolume(DIGITAL_GROUP.Music)).toBe(127);
    expect(imuse.groupVolume(DIGITAL_GROUP.Master)).toBe(127);
  });

  it('scales a group by the master', () => {
    const { imuse } = dispatch();
    imuse.setGroupVolume(DIGITAL_GROUP.Master, 64);

    // (64 * (127 + 1)) / 128 = 64, so a full group under a half master is half.
    expect(imuse.groupVolume(DIGITAL_GROUP.Music)).toBe(64);
  });

  it('scales a group set after the master, not only the ones set before it', () => {
    const { imuse } = dispatch();
    imuse.setGroupVolume(DIGITAL_GROUP.Master, 64);
    imuse.command([DIGITAL_COMMAND.SetMusicGroupVolume, 127]);

    expect(imuse.groupVolume(DIGITAL_GROUP.Music)).toBe(64);
  });

  it('rescales every group when the master moves, not just the one set last', () => {
    const { imuse } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetSfxGroupVolume, 32]);
    imuse.setGroupVolume(DIGITAL_GROUP.Master, 64);

    // The SFX group's own volume is still 32; only its scaling changed.
    expect(imuse.groupVolume(DIGITAL_GROUP.Sfx)).toBe(16);
    expect(imuse.groupVolume(DIGITAL_GROUP.Speech)).toBe(64);
  });

  it('routes the three volume commands to their own groups', () => {
    const { imuse } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetSfxGroupVolume, 10]);
    imuse.command([DIGITAL_COMMAND.SetVoiceGroupVolume, 20]);
    imuse.command([DIGITAL_COMMAND.SetMusicGroupVolume, 30]);

    expect(imuse.groupVolume(DIGITAL_GROUP.Sfx)).toBe(10);
    expect(imuse.groupVolume(DIGITAL_GROUP.Speech)).toBe(20);
    expect(imuse.groupVolume(DIGITAL_GROUP.Music)).toBe(30);
  });

  it('rejects a volume outside 0..127 rather than clamping it', () => {
    // The difference shows only against a group that had been set: clamping
    // would take it to full, rejecting leaves it where the game put it.
    const { imuse } = dispatch();
    imuse.setGroupVolume(DIGITAL_GROUP.Music, 30);
    imuse.setGroupVolume(DIGITAL_GROUP.Music, 200);

    expect(imuse.groupVolume(DIGITAL_GROUP.Music)).toBe(30);
  });

  it('relevels the sounds in a group when the group moves', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 5, DIGITAL_PARAM.Group, DIGITAL_GROUP.Music]);
    vi.mocked(audio.setLevel).mockClear();

    imuse.command([DIGITAL_COMMAND.SetMusicGroupVolume, 64]);

    // (127 + 1) * 64 / 128 = 64, and 64/127 of full.
    expect(audio.setLevel).toHaveBeenCalledWith(5, 64 / 127);
  });

  it('leaves the sounds in other groups alone', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 5, DIGITAL_PARAM.Group, DIGITAL_GROUP.Sfx]);
    vi.mocked(audio.setLevel).mockClear();

    imuse.command([DIGITAL_COMMAND.SetMusicGroupVolume, 64]);

    expect(audio.setLevel).not.toHaveBeenCalled();
  });
});

describe('iMUSE Digital setParam', () => {
  it('sets a volume as the product of the sound and its group', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Volume, 25]);

    // (25 + 1) * 127 / 128 = 25, which is Full Throttle's own start-up command.
    expect(audio.setLevel).toHaveBeenCalledWith(2, 25 / 127);
  });

  it('keeps a full volume in a full group at full', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Volume, 127]);

    expect(audio.setLevel).toHaveBeenCalledWith(2, 1);
  });

  it('rejects a volume above 127 rather than clamping it', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Volume, 128]);

    expect(audio.setLevel).not.toHaveBeenCalled();
  });

  it('centres pan 64, because the range is 0..127 and not signed', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Pan, 64]);

    expect(audio.setPan).toHaveBeenCalledWith(2, 0);
  });

  it('pans hard left at 0', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Pan, 0]);

    expect(audio.setPan).toHaveBeenCalledWith(2, -1);
  });

  it('rejects a group beyond the sixteen rather than filing a sound under it', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Group, 16]);

    expect(audio.setLevel).not.toHaveBeenCalled();
  });

  it('reports an unimplemented parameter once, and names it in hex', () => {
    const { imuse, logs } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetParam, 2, DIGITAL_PARAM.Transpose, 3]);
    imuse.command([DIGITAL_COMMAND.SetParam, 4, DIGITAL_PARAM.Transpose, 5]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('0x900');
  });
});

describe('iMUSE Digital fadeParam', () => {
  it('fades a volume over sixtieths of a second', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Volume, 127, 120]);

    expect(audio.fadeLevel).toHaveBeenCalledWith(2, 1, 2);
  });

  it('sets rather than fades when the length is zero', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Volume, 64, 0]);

    expect(audio.fadeLevel).not.toHaveBeenCalled();
    expect(audio.setLevel).toHaveBeenCalledWith(2, 64 / 127);
  });

  it('stops the sound when a zero-length fade takes the volume to zero', () => {
    // How a script ends a piece. Setting the level to nothing instead would
    // leave the sound running silently and `isSoundRunning` answering yes.
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Volume, 0, 0]);

    expect(audio.stop).toHaveBeenCalledWith(2);
    expect(audio.setLevel).not.toHaveBeenCalled();
  });

  it('fades to silence over time without stopping the sound early', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Volume, 0, 60]);

    expect(audio.fadeLevel).toHaveBeenCalledWith(2, 0, 1);
    expect(audio.stop).not.toHaveBeenCalled();
  });

  it('fades a pan', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Pan, 127, 60]);

    expect(audio.fadePan).toHaveBeenCalledWith(2, 63 / 64, 1);
  });

  it('ignores sound 0, which is no sound', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 0, DIGITAL_PARAM.Volume, 64, 60]);

    expect(audio.fadeLevel).not.toHaveBeenCalled();
  });

  it('ignores a negative length', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Volume, 64, -1]);

    expect(audio.fadeLevel).not.toHaveBeenCalled();
  });

  it('reports a parameter that cannot be faded', () => {
    const { imuse, logs } = dispatch();
    imuse.command([DIGITAL_COMMAND.FadeParam, 2, DIGITAL_PARAM.Group, 1, 60]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('0x400');
  });
});

describe('iMUSE Digital musical state', () => {
  it('plays the cue a state names when the index happens to name one', () => {
    const { imuse, audio } = dispatch([3]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);

    expect(audio.playMusicCue).toHaveBeenCalledWith(3);
    expect(audio.setLevel).toHaveBeenCalledWith(3, 1);
  });

  it('does nothing on re-entering the state already playing', () => {
    // A game re-asserts its state constantly; restarting the piece each time is
    // heard as a stutter.
    const { imuse, audio } = dispatch([3]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);

    expect(audio.playMusicCue).toHaveBeenCalledTimes(1);
  });

  it('stops the previous state before starting the next', () => {
    const { imuse, audio } = dispatch([3, 4]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);
    imuse.command([DIGITAL_COMMAND.SetState, 4]);

    expect(audio.stop).toHaveBeenCalledWith(3);
    expect(audio.playMusicCue).toHaveBeenCalledWith(4);
  });

  it('stops the music on state 0 without asking for a cue', () => {
    const { imuse, audio } = dispatch([3]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);
    imuse.command([DIGITAL_COMMAND.SetState, 0]);

    expect(audio.stop).toHaveBeenCalledWith(3);
    expect(audio.playMusicCue).toHaveBeenCalledTimes(1);
  });

  it('reports the missing music table once, naming what is missing', () => {
    const { imuse, logs } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetState, 1]);
    imuse.command([DIGITAL_COMMAND.SetState, 2]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('state 1');
    expect(logs[0]).toContain('table');
  });

  it('records a state entered under a sequence rather than playing it', () => {
    const { imuse, audio } = dispatch([3, 4]);
    imuse.command([DIGITAL_COMMAND.SetSequence, 4]);
    vi.mocked(audio.playMusicCue).mockClear();

    imuse.command([DIGITAL_COMMAND.SetState, 3]);

    expect(audio.playMusicCue).not.toHaveBeenCalled();
    expect(imuse.musicState.state).toBe(3);
  });

  it('returns to the recorded state when the sequence ends', () => {
    const { imuse, audio } = dispatch([3, 4]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);
    imuse.command([DIGITAL_COMMAND.SetSequence, 4]);
    vi.mocked(audio.playMusicCue).mockClear();

    imuse.command([DIGITAL_COMMAND.SetSequence, 0]);

    expect(audio.playMusicCue).toHaveBeenCalledWith(3);
  });

  it('clears the cue point when the sequence changes', () => {
    const { imuse } = dispatch([4]);
    imuse.command([DIGITAL_COMMAND.SetSequence, 4]);
    imuse.command([DIGITAL_COMMAND.SetCuePoint, 2]);
    imuse.command([DIGITAL_COMMAND.SetSequence, 5]);

    expect(imuse.musicState.cuePoint).toBe(0);
  });

  it('ignores a cue point above the four a sequence has', () => {
    const { imuse } = dispatch([4]);
    imuse.command([DIGITAL_COMMAND.SetSequence, 4]);
    imuse.command([DIGITAL_COMMAND.SetCuePoint, 4]);

    expect(imuse.musicState.cuePoint).toBe(0);
  });
});

describe('iMUSE Digital streams and attributes', () => {
  it('starts a stream by cue number', () => {
    // The Dig's demo uses this in place of its first `SetState`, which is why
    // it plays without a music table.
    const { imuse, audio } = dispatch([9]);
    imuse.command([DIGITAL_COMMAND.StartStream, 9]);

    expect(audio.playMusicCue).toHaveBeenCalledWith(9);
  });

  it('reports a stream whose cue the index does not name', () => {
    const { imuse, logs } = dispatch();
    imuse.command([DIGITAL_COMMAND.StartStream, 9]);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('startStream');
  });

  it('switches from one stream to another', () => {
    const { imuse, audio } = dispatch([9, 10]);
    imuse.command([DIGITAL_COMMAND.SwitchStream, 9, 10]);

    expect(audio.stop).toHaveBeenCalledWith(9);
    expect(audio.playMusicCue).toHaveBeenCalledWith(10);
  });

  it('stops all sounds', () => {
    const { imuse, audio } = dispatch();
    imuse.command([DIGITAL_COMMAND.StopAllSounds]);

    expect(audio.stopAll).toHaveBeenCalled();
  });

  it('forgets what was playing, so the next state does not stop it again', () => {
    const { imuse, audio } = dispatch([3, 4]);
    imuse.command([DIGITAL_COMMAND.SetState, 3]);
    imuse.command([DIGITAL_COMMAND.StopAllSounds]);
    imuse.command([DIGITAL_COMMAND.SetState, 4]);

    expect(audio.stop).not.toHaveBeenCalled();
  });

  it('records an attribute by index and value', () => {
    // The only command here whose second argument is not a sound number.
    const { imuse } = dispatch();
    imuse.command([DIGITAL_COMMAND.SetAttribute, 6, 1]);

    expect(imuse.attribute(6)).toBe(1);
    expect(imuse.attribute(7)).toBe(0);
  });
});

describe('the digital dispatch through the sound engine', () => {
  it('is reached by v7 rather than v6s MIDI decoder', () => {
    const sound = new SoundEngine();
    const logs: string[] = [];
    sound.onLog = (message) => logs.push(message);

    // The Dig's own start-up command: 0x1000, state 1.
    sound.digital.command([DIGITAL_COMMAND.SetState, 1]);

    expect(sound.digital.musicState.state).toBe(1);
    expect(logs.join('\n')).not.toContain('scope');
  });

  it('leaves v6s scope-and-command decoder alone', () => {
    const sound = new SoundEngine();
    const logs: string[] = [];
    sound.onLog = (message) => logs.push(message);
    const setLevel = vi.spyOn(sound, 'setSoundLevel');

    // Full Throttle's own start-up command: 12, sound 2, volume (0x600) 25.
    // Through v6's decoder that is command 12 in scope 0, which iMUSE has no
    // such command for and which is what this used to be reported as.
    sound.kludge([12, 2, DIGITAL_PARAM.Volume, 25]);
    expect(logs.join('\n')).toContain('iMUSE command 12 (scope 0)');
    expect(setLevel).not.toHaveBeenCalled();

    // Through the digital decoder it sets a volume, and says nothing.
    logs.length = 0;
    sound.digital.command([12, 2, DIGITAL_PARAM.Volume, 25]);
    expect(logs).toEqual([]);
    expect(setLevel).toHaveBeenCalledWith(2, 25 / 127);
  });
});
