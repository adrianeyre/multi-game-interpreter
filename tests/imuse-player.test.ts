import { describe, expect, it, vi } from 'vitest';
import {
  FADE_VOLUME,
  ImusePlayer,
  readStartParameters,
  transposeClamp,
  type ImusePlayerHost,
} from '../src/engine/sound/ImusePlayer.js';
import { ImuseCommands, type ImuseHost } from '../src/engine/sound/imuse.js';
import {
  MIDI_CONTROL_CHANGE,
  MIDI_META,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  type MidiEvent,
  type MidiFile,
} from '../src/engine/sound/midi.js';
import type { MidiSynth } from '../src/engine/sound/synth.js';

/**
 * The live iMUSE player (a port of ScummVM's `Player`) and the command layer
 * above it.
 *
 * Everything here drives the sequencer on its own timer — `onTimer`, four
 * milliseconds of music per call — against a synthesiser that only records
 * what it was told. What is being tested is the *sequencing*: which events
 * reach the card, and when, after a script has changed the player's state.
 */

const DIVISION = 480;
/** 120 bpm: a beat is half a second, which is 125 timer ticks. */
const TIMER_TICKS_PER_BEAT = 125;

function recordingSynth() {
  const events: MidiEvent[] = [];
  const detunes = new Map<number, number>();
  const synth: MidiSynth = {
    sampleRate: 1000,
    handle: (event) => events.push(event),
    render: (out) => out.fill(0),
    releaseAll: vi.fn(),
    setDetune: (channel, semitones) => detunes.set(channel, semitones),
    unreadableSysex: 0,
    instrumentsLoaded: 0,
  };
  const notes = () =>
    events.filter((e) => e.command === MIDI_NOTE_ON && e.data2 > 0).map((e) => e.data1);
  return { synth, events, detunes, notes };
}

const note = (tick: number, key: number, channel = 0): MidiEvent => ({
  tick,
  command: MIDI_NOTE_ON,
  channel,
  data1: key,
  data2: 100,
});
const off = (tick: number, key: number, channel = 0): MidiEvent => ({
  tick,
  command: MIDI_NOTE_OFF,
  channel,
  data1: key,
  data2: 0,
});

/** Two source bytes carry one payload byte, high nibble first. */
const nibbles = (bytes: number[]) => bytes.flatMap((b) => [(b >> 4) & 0x0f, b & 0x0f]);

const sysex = (tick: number, code: number, body: number[]): MidiEvent => ({
  tick,
  command: MIDI_META,
  channel: 0,
  data1: 0xf0,
  data2: 0,
  sysex: Uint8Array.from([0x7d, code, ...body, 0xf7]),
});

/** A hook jump the score carries: sysex 48, nibble-encoded after one skipped byte. */
const hookJump = (tick: number, hook: number, beat: number, tickInBeat = 0) =>
  sysex(tick, 48, [
    0,
    ...nibbles([hook, 0, 0, beat >> 8, beat & 0xff, tickInBeat >> 8, tickInBeat & 0xff]),
  ]);

/** Notes on beats 1 to 8, key 60 + beat. */
function eightBeats(extra: MidiEvent[] = []): MidiFile {
  const events: MidiEvent[] = [];
  for (let beat = 1; beat <= 8; beat++) {
    events.push(note((beat - 1) * DIVISION, 60 + beat));
    events.push(off((beat - 1) * DIVISION + 240, 60 + beat));
  }
  events.push(...extra);
  events.sort((a, b) => a.tick - b.tick);
  return { division: DIVISION, events, duration: events[events.length - 1].tick };
}

function playerFor(midi: MidiFile, host: ImusePlayerHost = {}, newSystem = false) {
  const recording = recordingSynth();
  const player = new ImusePlayer(7, midi, { synth: recording.synth, host, newSystem });
  const run = (timerTicks: number) => {
    for (let i = 0; i < timerTicks; i++) player.onTimer();
  };
  return { player, run, ...recording };
}

describe('playing a score', () => {
  it('plays each note as its moment comes, not all at once', () => {
    const { run, notes } = playerFor(eightBeats());
    run(1);
    expect(notes()).toEqual([61]);
    run(TIMER_TICKS_PER_BEAT);
    expect(notes()).toEqual([61, 62]);
  });

  it('stops at the end of its score, and says so once', () => {
    const ended = vi.fn();
    const { player, run } = playerFor(eightBeats(), { ended });
    run(TIMER_TICKS_PER_BEAT * 9);
    expect(player.active).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(ended).toHaveBeenCalledWith(7);
  });

  it('counts half-beats for VAR_MUSIC_TIMER', () => {
    const { player, run } = playerFor(eightBeats());
    run(TIMER_TICKS_PER_BEAT * 2);
    expect(player.musicTimer()).toBe(4);
    expect(player.beatIndex).toBe(3);
  });

  it('follows a tempo change the score makes', () => {
    const fast: MidiEvent = {
      tick: 0,
      command: MIDI_META,
      channel: 0,
      data1: 0x51,
      data2: 0,
      tempo: 250_000,
    };
    const { run, notes } = playerFor(eightBeats([fast]));
    // At double speed the second beat is due after half the time.
    run(TIMER_TICKS_PER_BEAT / 2 + 1);
    expect(notes()).toEqual([61, 62]);
  });
});

describe('jumps', () => {
  it('moves the playing position at once, playing nothing in between', () => {
    const { player, run, notes, synth } = playerFor(eightBeats());
    run(1);
    expect(player.jump(0, 6, 0)).toBe(true);
    run(1);
    expect(notes()).toEqual([61, 66]);
    // Notes left hanging by the jump are released.
    expect(synth.releaseAll).toHaveBeenCalled();
  });

  it('refuses a position past the end of the score', () => {
    const { player } = playerFor(eightBeats());
    expect(player.jump(0, 99, 0)).toBe(false);
  });

  it('chases state on a scan, and sounds the notes held at the destination', () => {
    // Beat 3's note is held across beat 4's start; a scan to beat 4 re-sounds
    // it, a jump would not.
    const held = eightBeats().events.filter(
      (e) => !(e.command === MIDI_NOTE_OFF && e.data1 === 63),
    );
    const midi: MidiFile = { division: DIVISION, events: held, duration: 7 * DIVISION + 240 };
    const { player, events } = playerFor(midi);
    player.scan(0, 4, 0);
    const sounded = events.filter((e) => e.command === MIDI_NOTE_ON).map((e) => e.data1);
    expect(sounded).toEqual([63]);
  });
});

describe('loops', () => {
  it('goes back to the loop start when it reaches the loop end, count times', () => {
    const { player, run, notes } = playerFor(eightBeats());
    // Once: on reaching beat 4, back to beat 2. The loop is checked on the
    // timer tick *after* the parser reaches its end point, as `onTimer` orders
    // them, so an event sitting exactly on that point is heard before the loop.
    expect(player.setLoop(1, 2, 0, 4, 0)).toBe(true);
    run(TIMER_TICKS_PER_BEAT * 7 + 2);
    expect(notes()).toEqual([61, 62, 63, 64, 62, 63, 64, 65, 66]);
  });

  it('treats a count of zero as no loop, as the original does', () => {
    const { player, run, notes } = playerFor(eightBeats());
    player.setLoop(0, 2, 0, 4, 0);
    run(TIMER_TICKS_PER_BEAT * 4 + 2);
    expect(notes()).toEqual([61, 62, 63, 64, 65]);
  });

  it('refuses a loop shorter than a beat', () => {
    const { player } = playerFor(eightBeats());
    expect(player.setLoop(1, 3, 0, 4, 0)).toBe(false);
  });

  it('can be cleared while it plays', () => {
    const { player, run, notes } = playerFor(eightBeats());
    player.setLoop(5, 1, 0, 3, 0);
    player.clearLoop();
    run(TIMER_TICKS_PER_BEAT * 3 + 2);
    expect(notes()).toEqual([61, 62, 63, 64]);
  });

  it('takes a loop the score itself sets (sysex 80)', () => {
    const loop = sysex(10, 80, [0, ...nibbles([0, 1, 0, 1, 0, 0, 0, 3, 0, 0])]);
    const { run, notes } = playerFor(eightBeats([loop]));
    run(TIMER_TICKS_PER_BEAT * 4 + 2);
    expect(notes().slice(0, 5)).toEqual([61, 62, 63, 61, 62]);
  });
});

describe('hooks, which is how iMUSE branches', () => {
  it('ignores a hook jump in the score until its hook is armed', () => {
    const { run, notes } = playerFor(eightBeats([hookJump(DIVISION + 10, 3, 6)]));
    run(TIMER_TICKS_PER_BEAT * 2 + 1);
    expect(notes()).toEqual([61, 62, 63]);
  });

  it('takes the jump once the script arms the hook, and consumes it', () => {
    const { player, run, notes } = playerFor(eightBeats([hookJump(DIVISION + 10, 3, 6)]));
    expect(player.setHook(0, 3, 0)).toBe(0);
    run(TIMER_TICKS_PER_BEAT * 2);
    expect(notes()).toEqual([61, 62, 66]);
    expect(player.getParam(18, 0)).toBe(0);
  });

  it('takes a hook of zero unconditionally', () => {
    const { run, notes } = playerFor(eightBeats([hookJump(DIVISION + 10, 0, 7)]));
    run(TIMER_TICKS_PER_BEAT * 2);
    expect(notes()).toEqual([61, 62, 67]);
  });

  it('gates a part on/off hook the same way', () => {
    // Sysex 50: channel, then hook and on/off nibble-encoded.
    const mute = sysex(DIVISION + 10, 50, [0, ...nibbles([4, 0])]);
    const { player, run, notes } = playerFor(eightBeats([mute]));
    run(TIMER_TICKS_PER_BEAT * 2);
    expect(notes()).toEqual([61, 62, 63]);

    const second = playerFor(eightBeats([mute]));
    second.player.setHook(2, 4, 0);
    second.run(TIMER_TICKS_PER_BEAT * 2);
    expect(second.notes()).toEqual([61, 62]);
    void player;
  });
});

describe('markers', () => {
  it('tells the host each marker as the music reaches it', () => {
    const marker = vi.fn();
    const { run } = playerFor(eightBeats([sysex(DIVISION * 2, 64, [0, 9])]), { marker });
    run(TIMER_TICKS_PER_BEAT * 2 - 5);
    expect(marker).not.toHaveBeenCalled();
    run(10);
    expect(marker).toHaveBeenCalledWith(7, 9);
    // The SMF terminator is not a marker.
    expect(marker).toHaveBeenCalledTimes(1);
  });

  it('fires Sam & Max trigger events on sysex 0 in the new system', () => {
    const triggerEvent = vi.fn();
    const { run } = playerFor(eightBeats([sysex(10, 0, [5])]), { triggerEvent }, true);
    run(5);
    expect(triggerEvent).toHaveBeenCalledWith(7, 5);
  });
});

describe('pitch', () => {
  it('transposes every part, folding relative moves into ±7', () => {
    const { player, detunes } = playerFor(eightBeats());
    expect(player.setTranspose(0, 5)).toBe(0);
    expect(detunes.get(0)).toBe(5);
    player.setTranspose(1, 5);
    // 10 folds down an octave to -2.
    expect(player.transpose).toBe(-2);
    expect(player.setTranspose(0, 30)).toBe(-1);
  });

  it('clamps by octaves, as transpose_clamp does', () => {
    expect(transposeClamp(10, -7, 7)).toBe(-2);
    expect(transposeClamp(-10, -7, 7)).toBe(2);
    expect(transposeClamp(3, -7, 7)).toBe(3);
  });

  it('detunes in 1/128ths of a semitone', () => {
    const { player, detunes } = playerFor(eightBeats());
    player.setDetune(64);
    expect(detunes.get(3)).toBeCloseTo(0.5);
  });
});

describe('volume, parts and speed', () => {
  const volumes = (events: MidiEvent[], channel = 0) =>
    events
      .filter((e) => e.command === MIDI_CONTROL_CHANGE && e.data1 === 7 && e.channel === channel)
      .map((e) => e.data2);

  it('scales each part by the player volume', () => {
    const { player, events } = playerFor(eightBeats());
    player.setVolume(63);
    expect(volumes(events).at(-1)).toBe(63);
    expect(player.setVolume(200)).toBe(-1);
  });

  it('silences a part that is switched off, and only that part', () => {
    const midi = eightBeats([note(DIVISION + 5, 40, 1)]);
    const { player, run, notes } = playerFor(midi);
    player.setPartOn(0, false);
    run(TIMER_TICKS_PER_BEAT * 2);
    expect(notes()).toEqual([40]);
  });

  it('sets a part volume as heard through the player volume', () => {
    const { player, events } = playerFor(eightBeats());
    player.setVolume(63);
    player.setPartVolume(2, 127);
    // (127 * (63 + 1)) >> 7, the original's fixed-point scaling.
    expect(volumes(events, 2).at(-1)).toBe(63);
  });

  it('runs faster at a higher speed', () => {
    const { player, run, notes } = playerFor(eightBeats());
    player.setSpeed(255);
    run(TIMER_TICKS_PER_BEAT / 2 + 2);
    expect(notes()).toEqual([61, 62]);
  });

  it('fades the volume over sixtieths of a second, and stops at silence', () => {
    const ended = vi.fn();
    const { player, run } = playerFor(eightBeats(), { ended });
    player.addParameterFader(FADE_VOLUME, 0, 30); // half a second
    run(60);
    expect(player.volume).toBeGreaterThan(0);
    expect(player.volume).toBeLessThan(127);
    run(80);
    expect(player.active).toBe(false);
    expect(ended).toHaveBeenCalled();
  });
});

describe('start parameters', () => {
  it('reads an MDhd header', () => {
    const header = Uint8Array.from([
      ...[...'MDhd'].map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      8,
      0,
      0,
      90,
      100,
      0,
      2,
      0,
      128,
    ]);
    expect(readStartParameters(header)).toEqual({
      priority: 90,
      volume: 100,
      pan: 0,
      transpose: 2,
      detune: 0,
      speed: 128,
    });
  });

  it('treats an all-zero header as none, as MI1 ships them', () => {
    const header = Uint8Array.from([
      ...[...'MDhd'].map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      8,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    expect(readStartParameters(header)).toBeNull();
  });
});

describe('the command layer', () => {
  function commandsWith(player: ImusePlayer | null) {
    const ran: number[][] = [];
    const host: ImuseHost = {
      player: (id) => (player && id === player.id ? player : null),
      run: (args) => {
        ran.push(args);
        return 0;
      },
      status: (id) => player?.id === id,
      stop: vi.fn(),
      log: vi.fn(),
    };
    return { commands: new ImuseCommands(host), ran, host };
  }

  it('routes a jump to the sound’s player', () => {
    const { player } = playerFor(eightBeats());
    const { commands } = commandsWith(player);
    expect(commands.playerCommand(7, [0x107, 7, 0, 5, 0])).toBe(0);
    expect(player.beatIndex).toBe(5);
  });

  it('answers -1 for a sound with no player', () => {
    const { commands } = commandsWith(null);
    expect(commands.playerCommand(7, [0x107, 3, 0, 5, 0])).toBe(-1);
  });

  it('reads a parameter back, as a script does through VAR_SOUNDRESULT', () => {
    const { player } = playerFor(eightBeats());
    const { commands } = commandsWith(player);
    commands.playerCommand(4, [0x104, 7, 0, 3]);
    expect(commands.playerCommand(0, [0x100, 7, 3, 0])).toBe(3);
  });

  it('runs queued commands when the music reaches their marker', () => {
    const { commands, ran } = commandsWith(null);
    expect(commands.playerCommand(14, [0x10e, 7, 9])).toBe(0);
    commands.playerCommand(15, [0x10f, 8, 12]);
    commands.playerCommand(15, [0x10f, -1]);
    expect(commands.playerCommand(23, [0x117, 0])).toBe(1);

    commands.marker(7, 8); // the wrong marker
    expect(ran).toEqual([]);
    commands.marker(7, 9);
    expect(ran).toEqual([[8, 12, 0, 0, 0, 0, 0]]);
    expect(commands.playerCommand(23, [0x117, 0])).toBe(0);
  });

  it('does not run a list the script is still writing', () => {
    const { commands, ran } = commandsWith(null);
    commands.playerCommand(14, [0x10e, 7, 9]);
    commands.playerCommand(15, [0x10f, 8, 12]);
    commands.marker(7, 9);
    expect(ran).toEqual([]);
  });

  it('clears the queue', () => {
    const { commands, ran } = commandsWith(null);
    commands.playerCommand(14, [0x10e, 7, 9]);
    commands.playerCommand(15, [0x10f, 8, 12]);
    commands.playerCommand(15, [0x10f, -1]);
    commands.playerCommand(16, [0x110]);
    commands.marker(7, 9);
    expect(ran).toEqual([]);
  });

  it('fires a Sam & Max trigger on its marker, once', () => {
    const { commands, ran } = commandsWith(null);
    commands.newSystem = true;
    expect(commands.systemCommand(17, [17, 7, 0, 4, 8, 20, 0, 0, 0, 0, 0, 0])).toBe(0);
    commands.triggerEvent(7, 4);
    commands.triggerEvent(7, 4);
    expect(ran).toEqual([[8, 20, 0, 0, 0, 0, 0, 0]]);
  });

  it('fires the triggers still hung on a sound when it stops', () => {
    const { commands, ran } = commandsWith(null);
    commands.newSystem = true;
    commands.systemCommand(17, [17, 7, 0, 4, 8, 20, 0, 0, 0, 0, 0, 0]);
    commands.soundEnded(7);
    expect(ran).toHaveLength(1);
    commands.soundEnded(7);
    expect(ran).toHaveLength(1);
  });

  it('runs a deferred command after its time, in hundredths of a second', () => {
    const { commands, ran } = commandsWith(null);
    commands.systemCommand(20, [20, 50, 8, 20, 0, 0, 0, 0]);
    commands.step(0.4);
    expect(ran).toEqual([]);
    commands.step(0.2);
    expect(ran).toEqual([[8, 20, 0, 0, 0, 0]]);
  });

  it('puts a sound on a volume channel and follows that channel', () => {
    const { player } = playerFor(eightBeats());
    const { commands } = commandsWith(player);
    commands.systemCommand(16, [16, 7, 2]);
    commands.systemCommand(17, [17, 2, 0]);
    expect(player.getParam(1, 0)).toBe(127);
    // The player's own volume is unchanged; what it is heard at is not.
    expect(commands.channelVolumeFor(7)).toBe(0);
  });
});
