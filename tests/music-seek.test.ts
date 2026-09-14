import { describe, expect, it } from 'vitest';
import {
  findHookJumps,
  findMarkers,
  jumpTargetTick,
  renderMidiToOpl2,
  ticksToSeconds,
} from '../src/engine/sound/renderMusic.js';
import {
  MIDI_META,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  MIDI_PROGRAM_CHANGE,
  type MidiFile,
} from '../src/engine/sound/midi.js';

/**
 * Starting a score part way in.
 *
 * This is what makes dynamic music possible at all here: the engine renders a
 * whole score to samples and plays the buffer, so there is no playing position
 * for an iMUSE jump to move — but re-rendering from the destination gets the
 * same musical result, at the cost of a seam.
 */
function score(events: MidiFile['events'], duration = 960): MidiFile {
  return { division: 96, events, duration };
}

const note = (tick: number, key: number) => ({
  tick,
  command: MIDI_NOTE_ON,
  channel: 0,
  data1: key,
  data2: 100,
});

describe('rendering from a tick', () => {
  it('produces a shorter rendering than starting from the beginning', () => {
    const midi = score([note(0, 60), note(480, 64), note(960, 67)]);

    const whole = renderMidiToOpl2(midi, 22050);
    const late = renderMidiToOpl2(midi, 22050, 480);

    expect(late.samples.length).toBeLessThan(whole.samples.length);
    expect(late.samples.length).toBeGreaterThan(0);
  });

  it('starts at the beginning when asked for tick zero', () => {
    const midi = score([note(0, 60), note(480, 64)]);

    expect(renderMidiToOpl2(midi, 22050, 0).samples.length).toBe(
      renderMidiToOpl2(midi, 22050).samples.length,
    );
  });

  it('applies state-setting events before the jump without spending time on them', () => {
    /**
     * Seeking is not skipping. Everything before the destination that sets
     * state still has to happen, or the music resumes misconfigured — but none
     * of it may advance the clock, or the jump would take as long as the music
     * it skipped.
     *
     * Asserted through tempo, because that is the state change this renderer
     * exposes in its output length. Instruments come from sysex in SCUMM
     * rather than from programme changes, so a bare programme change would
     * prove nothing here.
     */
    const midi = score([
      { tick: 0, command: MIDI_PROGRAM_CHANGE, channel: 0, data1: 48, data2: 0 },
      { tick: 100, command: MIDI_META, channel: 0, data1: 0, data2: 0, tempo: 250_000 },
      note(480, 64),
      { tick: 960, command: MIDI_NOTE_OFF, channel: 0, data1: 64, data2: 0 },
    ]);

    const seeked = renderMidiToOpl2(midi, 22050, 480);
    const fromStart = renderMidiToOpl2(midi, 22050);

    // The seek skipped 480 ticks of waiting, so it must be shorter — but it
    // kept the tempo those ticks established.
    expect(seeked.samples.length).toBeLessThan(fromStart.samples.length);
    expect(seeked.samples.length).toBeGreaterThan(0);
  });

  it('does not sound the notes it skipped over', () => {
    // Applying them on the way past would fire every note the score played
    // before the jump as one instant chord.
    const midi = score([note(0, 60), note(100, 62), note(200, 64), note(480, 67)]);
    const skipped = renderMidiToOpl2(midi, 22050, 480);
    const only = renderMidiToOpl2(score([note(480, 67)]), 22050, 480);

    expect(skipped.samples.length).toBe(only.samples.length);
  });

  it('carries the tempo set before the jump', () => {
    const slow = score([
      { tick: 0, command: MIDI_META, channel: 0, data1: 0, data2: 0, tempo: 1_000_000 },
      note(480, 60),
      { tick: 960, command: MIDI_NOTE_OFF, channel: 0, data1: 60, data2: 0 },
    ]);
    const fast = score([
      { tick: 0, command: MIDI_META, channel: 0, data1: 0, data2: 0, tempo: 250_000 },
      note(480, 60),
      { tick: 960, command: MIDI_NOTE_OFF, channel: 0, data1: 60, data2: 0 },
    ]);

    // The gap between the jump target and the note off is the same number of
    // ticks; only the tempo differs, so the slower one must render longer.
    expect(renderMidiToOpl2(slow, 22050, 480).samples.length).toBeGreaterThan(
      renderMidiToOpl2(fast, 22050, 480).samples.length,
    );
  });
});

describe('where a jump lands', () => {
  /**
   * The command names a position in beats, because a sequencer thinks in
   * beats; the renderer thinks in the file's ticks. Beats are numbered from one
   * in the command, which is the off-by-one worth stating rather than
   * discovering.
   */
  it('treats beat one as the start', () => {
    expect(jumpTargetTick(96, 1)).toBe(0);
  });

  it('converts a beat to ticks through the file division', () => {
    expect(jumpTargetTick(96, 5)).toBe(384);
    expect(jumpTargetTick(192, 5)).toBe(768);
  });

  it('adds the subdivision within the beat', () => {
    expect(jumpTargetTick(96, 3, 24)).toBe(216);
  });

  it('never lands before the start', () => {
    expect(jumpTargetTick(96, 0)).toBe(0);
    expect(jumpTargetTick(96, -5)).toBe(0);
  });
});

describe('converting ticks to seconds', () => {
  /**
   * What a loop needs to position itself: the buffer holds seconds and the
   * commands speak in beats.
   */
  it('uses the default tempo when the score sets none', () => {
    // 500,000 microseconds a quarter note, 96 ticks a quarter: 96 ticks is half
    // a second.
    expect(ticksToSeconds(96, score([note(0, 60)]))).toBeCloseTo(0.5, 3);
  });

  it('uses a tempo the score set before that point', () => {
    const midi = score([
      { tick: 0, command: MIDI_META, channel: 0, data1: 0, data2: 0, tempo: 250_000 },
      note(0, 60),
    ]);
    expect(ticksToSeconds(96, midi)).toBeCloseTo(0.25, 3);
  });

  it('ignores a tempo set after the point asked about', () => {
    const midi = score([
      note(0, 60),
      { tick: 200, command: MIDI_META, channel: 0, data1: 0, data2: 0, tempo: 250_000 },
    ]);
    expect(ticksToSeconds(96, midi)).toBeCloseTo(0.5, 3);
  });

  it('is zero at the start', () => {
    expect(ticksToSeconds(0, score([note(0, 60)]))).toBe(0);
  });
});

describe('markers in a score', () => {
  /**
   * iMUSE hides them in sysex: a block whose first byte is zero, then a
   * one-byte id. They matter because they are the only positions in a score the
   * *game* knows about — a jump to a beat is the engine's idea of where to go,
   * a jump to a marker is the composer's.
   */
  /**
   * An iMUSE sysex block: manufacturer, sub-command, a byte every branch of the
   * original skips, then the payload.
   */
  const sysex = (tick: number, code: number, payload: number[]) => ({
    tick,
    command: 0xf0,
    channel: 0,
    data1: 0,
    data2: 0,
    sysex: Uint8Array.from([0x7d, code, 0, ...payload]),
  });

  const MARKER = 64;

  it('finds a marker and its position', () => {
    const midi = score([note(0, 60), sysex(480, MARKER, [7]), note(960, 64)]);
    expect(findMarkers(midi)).toEqual([{ id: 7, tick: 480 }]);
  });

  it('finds several, in the order the score reaches them', () => {
    const midi = score([sysex(100, MARKER, [1]), sysex(50, MARKER, [2]), sysex(200, MARKER, [3])]);
    expect(findMarkers(midi).map((marker) => marker.id)).toEqual([1, 2, 3]);
  });

  it('ignores sysex that is not a marker', () => {
    // Anything whose first byte is not zero belongs to another part of iMUSE's
    // vocabulary, and reading it as a marker would invent positions.
    const midi = score([sysex(10, 48, [1, 7]), sysex(20, 1, [0]), sysex(30, MARKER, [4])]);
    expect(findMarkers(midi)).toEqual([{ id: 4, tick: 30 }]);
  });

  it('reads several ids out of one block, as the format allows', () => {
    expect(findMarkers(score([sysex(10, MARKER, [4, 5])]))).toEqual([
      { id: 4, tick: 10 },
      { id: 5, tick: 10 },
    ]);
  });

  it('ignores sysex from another manufacturer', () => {
    const midi = score([{ ...sysex(10, MARKER, [4]), sysex: Uint8Array.from([0x41, 64, 0, 4]) }]);
    expect(findMarkers(midi)).toEqual([]);
  });

  it('finds none in a score that carries none', () => {
    expect(findMarkers(score([note(0, 60)]))).toEqual([]);
  });
});

describe('hook jumps, which the score carries', () => {
  /**
   * How iMUSE actually branches: the composer puts exits in the score, each
   * waiting on a hook number, and the game chooses between them by arming one.
   * Jumping to a beat is the crude version — it makes the engine guess a
   * position the composer had already marked.
   *
   * Sub-command 48, nibble-encoded, which is the opposite of the marker block
   * beside it. Read one the other's way and you get a plausible wrong number.
   */
  const HOOK_JUMP = 48;

  /** Two source bytes carry one payload byte, high nibble first. */
  const nibbles = (bytes: number[]) => bytes.flatMap((b) => [(b >> 4) & 0x0f, b & 0x0f]);

  const jumpBlock = (
    tick: number,
    hook: number,
    track: number,
    beat: number,
    tickInBeat: number,
  ) => ({
    tick,
    command: 0xf0,
    channel: 0,
    data1: 0,
    data2: 0,
    sysex: Uint8Array.from([
      0x7d,
      HOOK_JUMP,
      0,
      ...nibbles([
        hook,
        (track >> 8) & 0xff,
        track & 0xff,
        (beat >> 8) & 0xff,
        beat & 0xff,
        (tickInBeat >> 8) & 0xff,
        tickInBeat & 0xff,
      ]),
    ]),
  });

  it('reads the hook and the destination', () => {
    const midi = score([jumpBlock(240, 3, 1, 17, 48)]);

    expect(findHookJumps(midi)).toEqual([
      { hook: 3, track: 1, beat: 17, tickInBeat: 48, tick: 240 },
    ]);
  });

  it('reads a destination past a byte, which the pairs exist for', () => {
    // Beat 300 does not fit in a byte; the big-endian pair is why the payload
    // is laid out this way at all.
    expect(findHookJumps(score([jumpBlock(0, 1, 0, 300, 0)]))[0].beat).toBe(300);
  });

  it('ignores a marker block, which is not nibble-encoded', () => {
    const marker = {
      tick: 10,
      command: 0xf0,
      channel: 0,
      data1: 0,
      data2: 0,
      sysex: Uint8Array.from([0x7d, 64, 0, 4]),
    };
    expect(findHookJumps(score([marker]))).toEqual([]);
  });

  it('ignores a jump block too short to hold a destination', () => {
    const short = {
      tick: 10,
      command: 0xf0,
      channel: 0,
      data1: 0,
      data2: 0,
      sysex: Uint8Array.from([0x7d, 48, 0, 1, 2]),
    };
    expect(findHookJumps(score([short]))).toEqual([]);
  });
});
