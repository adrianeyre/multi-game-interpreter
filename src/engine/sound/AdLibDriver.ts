import { Opl2 } from './opl2/Opl2.js';
import {
  MIDI_CONTROL_CHANGE,
  MIDI_META,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  MIDI_PITCH_BEND,
  MIDI_PROGRAM_CHANGE,
  type MidiEvent,
} from './midi.js';

/**
 * Plays MIDI on an OPL2.
 *
 * The chip has no notion of a note: it has nine voices, each a pair of
 * operators that have to be given a frequency, an instrument and a moment to
 * start. This turns note-on and note-off into that, allocates the nine voices
 * between however many MIDI channels the music uses, and steals the oldest
 * note when a tenth is asked for — the same compromise every AdLib driver of
 * the era made, and the reason busy passages drop their quietest voices.
 */

/** The eleven bytes that define an AdLib instrument. */
export interface AdLibInstrument {
  /** Modulator then carrier: AM/VIB/EG/KSR/multiple. */
  characteristic: [number, number];
  /** Modulator then carrier: key scale level and total level. */
  level: [number, number];
  /** Modulator then carrier: attack and decay. */
  attackDecay: [number, number];
  /** Modulator then carrier: sustain and release. */
  sustainRelease: [number, number];
  /** Modulator then carrier: waveform select. */
  waveform: [number, number];
  /** Feedback and the connection bit, as written to the 0xC0 register. */
  feedback: number;
}

/**
 * The instrument used until the music says otherwise.
 *
 * A plain, clearly audible tone rather than an attempt at a piano: it exists
 * so that a score whose instrument definitions were not understood still plays
 * its notes. Wrong timbre is a problem someone can hear and report; silence is
 * one they cannot.
 */
export const DEFAULT_INSTRUMENT: AdLibInstrument = {
  characteristic: [0x01, 0x01],
  level: [0x8f, 0x06],
  attackDecay: [0xf2, 0xf4],
  sustainRelease: [0xf7, 0xf7],
  waveform: [0x00, 0x00],
  feedback: 0x0a,
};

/** Register offsets of each channel's modulator and carrier. */
const CHANNEL_REGISTERS: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x03],
  [0x01, 0x04],
  [0x02, 0x05],
  [0x08, 0x0b],
  [0x09, 0x0c],
  [0x0a, 0x0d],
  [0x10, 0x13],
  [0x11, 0x14],
  [0x12, 0x15],
];

const VOICE_COUNT = CHANNEL_REGISTERS.length;

/**
 * Frequency numbers for the twelve semitones of an octave, in block 4.
 *
 * Derived rather than tabulated: a frequency number is `f * 2^(20-block) /
 * clock`, and the note frequencies are equal temperament from A4 = 440 Hz.
 */
const SEMITONE_FNUM = (() => {
  const table = new Uint16Array(12);
  for (let semitone = 0; semitone < 12; semitone++) {
    // MIDI note 60 is middle C; C5 = 523.25 Hz sits comfortably in block 4.
    const frequency = 523.2511 * Math.pow(2, semitone / 12);
    table[semitone] = Math.round((frequency * Math.pow(2, 20 - 4)) / (3579545 / 72));
  }
  return table;
})();

interface Voice {
  /** MIDI channel currently owning it, or -1. */
  owner: number;
  note: number;
  /** Rising counter, so the oldest voice is the one with the lowest value. */
  age: number;
  keyed: boolean;
  block: number;
  frequencyNumber: number;
}

export class AdLibDriver {
  private readonly voices: Voice[] = Array.from({ length: VOICE_COUNT }, () => ({
    owner: -1,
    note: -1,
    age: 0,
    keyed: false,
    block: 0,
    frequencyNumber: 0,
  }));

  /** Instrument per MIDI channel. */
  private readonly instruments = new Map<number, AdLibInstrument>();
  /** Volume per MIDI channel, 0-127. */
  private readonly volumes = new Map<number, number>();
  /** Pitch bend per MIDI channel, in semitones. */
  private readonly bends = new Map<number, number>();

  private clock = 0;

  /**
   * System-exclusive messages whose shape was not recognised.
   *
   * SCUMM carries its instrument definitions in SysEx, and the exact layout
   * varies between games. Counting what could not be read turns "the music
   * sounds wrong" into a number, which is the difference between a bug that
   * can be chased and one that cannot.
   */
  unreadableSysex = 0;
  /** Instrument definitions successfully taken from the music. */
  instrumentsLoaded = 0;

  constructor(private readonly chip: Opl2) {
    this.reset();
  }

  reset(): void {
    this.chip.reset();
    for (const voice of this.voices) {
      voice.owner = -1;
      voice.note = -1;
      voice.age = 0;
      voice.keyed = false;
    }
    this.instruments.clear();
    this.volumes.clear();
    this.bends.clear();
    this.clock = 0;
    this.unreadableSysex = 0;
    this.instrumentsLoaded = 0;

    // Wave select has to be enabled explicitly, or every operator is a sine
    // and three quarters of the chip's timbres are unreachable.
    this.chip.write(0x01, 0x20);
  }

  handle(event: MidiEvent): void {
    switch (event.command) {
      case MIDI_NOTE_ON:
        if (event.data2 === 0) this.noteOff(event.channel, event.data1);
        else this.noteOn(event.channel, event.data1, event.data2);
        break;

      case MIDI_NOTE_OFF:
        this.noteOff(event.channel, event.data1);
        break;

      case MIDI_PROGRAM_CHANGE:
        // Programs are indices into a bank this driver does not have: SCUMM
        // supplies its instruments through SysEx instead. Remembering the
        // number without acting on it keeps a channel on whatever instrument
        // the music last defined for it.
        break;

      case MIDI_CONTROL_CHANGE:
        if (event.data1 === 7) {
          this.volumes.set(event.channel, event.data2);
          this.refreshChannelVolume(event.channel);
        } else if (event.data1 === 123 || event.data1 === 120) {
          this.allNotesOff(event.channel);
        }
        break;

      case MIDI_PITCH_BEND: {
        const value = ((event.data2 << 7) | event.data1) - 8192;
        // Two semitones either way, the General MIDI default.
        this.bends.set(event.channel, (value / 8192) * 2);
        this.refreshChannelPitch(event.channel);
        break;
      }

      case MIDI_META:
        if (event.sysex) this.handleSysex(event.sysex);
        break;

      default:
        break;
    }
  }

  /**
   * Reads an instrument definition out of a system-exclusive message.
   *
   * SCUMM's own layout is not documented publicly and no sample of it was
   * available while this was written, so what is accepted here is the shape
   * every AdLib instrument has: a channel followed by the eleven register
   * values. Anything else is counted and ignored rather than guessed at, so a
   * score whose instruments are not understood plays with the default voice
   * instead of falling silent.
   */
  private handleSysex(payload: Uint8Array): void {
    // A leading manufacturer id, then a channel, then the eleven bytes.
    const body = payload[0] === 0x7d || payload[0] === 0x00 ? payload.subarray(1) : payload;
    if (body.length < 12) {
      this.unreadableSysex++;
      return;
    }

    const channel = body[0] & 0x0f;
    const b = body.subarray(1);

    this.instruments.set(channel, {
      characteristic: [b[0], b[1]],
      level: [b[2], b[3]],
      attackDecay: [b[4], b[5]],
      sustainRelease: [b[6], b[7]],
      waveform: [b[8], b[9]],
      feedback: b[10],
    });
    this.instrumentsLoaded++;
  }

  private instrumentFor(channel: number): AdLibInstrument {
    return this.instruments.get(channel) ?? DEFAULT_INSTRUMENT;
  }

  private noteOn(channel: number, note: number, velocity: number): void {
    const voice = this.allocate(channel);
    const index = this.voices.indexOf(voice);

    voice.owner = channel;
    voice.note = note;
    voice.age = ++this.clock;
    voice.keyed = true;

    this.program(index, this.instrumentFor(channel), channel, velocity);
    this.setPitch(index, note + (this.bends.get(channel) ?? 0));
  }

  private noteOff(channel: number, note: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || voice.note !== note || !voice.keyed) continue;
      voice.keyed = false;
      this.chip.write(0xb0 + index, (voice.block << 2) | ((voice.frequencyNumber >> 8) & 3));
    }
  }

  private allNotesOff(channel: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || !voice.keyed) continue;
      voice.keyed = false;
      this.chip.write(0xb0 + index, (voice.block << 2) | ((voice.frequencyNumber >> 8) & 3));
    }
  }

  /** A free voice, or failing that the oldest sounding one. */
  private allocate(channel: number): Voice {
    const free = this.voices.find((voice) => !voice.keyed && voice.owner === -1);
    if (free) return free;

    const released = this.voices.find((voice) => !voice.keyed);
    if (released) return released;

    // Everything is sounding: the note that has been held longest is the one
    // least likely to be missed.
    void channel;
    return this.voices.reduce((oldest, voice) => (voice.age < oldest.age ? voice : oldest));
  }

  /** Writes an instrument into a voice's registers. */
  private program(
    index: number,
    instrument: AdLibInstrument,
    channel: number,
    velocity: number,
  ): void {
    const [modulator, carrier] = CHANNEL_REGISTERS[index];

    this.chip.write(0x20 + modulator, instrument.characteristic[0]);
    this.chip.write(0x20 + carrier, instrument.characteristic[1]);
    this.chip.write(0x60 + modulator, instrument.attackDecay[0]);
    this.chip.write(0x60 + carrier, instrument.attackDecay[1]);
    this.chip.write(0x80 + modulator, instrument.sustainRelease[0]);
    this.chip.write(0x80 + carrier, instrument.sustainRelease[1]);
    this.chip.write(0xe0 + modulator, instrument.waveform[0]);
    this.chip.write(0xe0 + carrier, instrument.waveform[1]);
    this.chip.write(0xc0 + index, instrument.feedback);

    // The modulator keeps its own level, which is part of the timbre. Only the
    // carrier's level is loudness, so that is where velocity and channel
    // volume are applied.
    this.chip.write(0x40 + modulator, instrument.level[0]);
    this.chip.write(0x40 + carrier, this.carrierLevel(instrument, channel, velocity));
  }

  /**
   * Combines the instrument's own level with velocity and channel volume.
   *
   * Total level is an attenuation, so louder is a smaller number, and the
   * three contributions add rather than multiply — which is the same
   * logarithmic domain the chip itself works in.
   */
  private carrierLevel(instrument: AdLibInstrument, channel: number, velocity: number): number {
    const keyScale = instrument.level[1] & 0xc0;
    const base = instrument.level[1] & 0x3f;

    const volume = this.volumes.get(channel) ?? 127;
    // Velocity and volume each span the 6-bit attenuation range at most half
    // way, so a quiet note is quiet without becoming inaudible.
    const attenuation =
      base + Math.round(((127 - velocity) * 24) / 127) + Math.round(((127 - volume) * 24) / 127);

    return keyScale | Math.min(0x3f, attenuation);
  }

  private refreshChannelVolume(channel: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || !voice.keyed) continue;
      const carrier = CHANNEL_REGISTERS[index][1];
      this.chip.write(0x40 + carrier, this.carrierLevel(this.instrumentFor(channel), channel, 127));
    }
  }

  private refreshChannelPitch(channel: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || !voice.keyed) continue;
      this.setPitch(index, voice.note + (this.bends.get(channel) ?? 0));
    }
  }

  /** Turns a (possibly fractional) MIDI note into a block and frequency number. */
  private setPitch(index: number, note: number): void {
    const clamped = Math.max(0, Math.min(127, note));
    // Note 60 is middle C, and the table is written for the octave above it.
    const octave = Math.floor((clamped - 60) / 12) + 4;
    const block = Math.max(0, Math.min(7, octave));

    const semitone = clamped - 60 - (block - 4) * 12;
    const whole = Math.floor(semitone);
    const fraction = semitone - whole;

    const low = SEMITONE_FNUM[Math.max(0, Math.min(11, whole))];
    const high = SEMITONE_FNUM[Math.max(0, Math.min(11, whole + 1))] ?? low;
    // Interpolating between semitones is what makes a pitch bend continuous
    // rather than a staircase.
    const frequencyNumber = Math.max(0, Math.min(0x3ff, Math.round(low + (high - low) * fraction)));

    const voice = this.voices[index];
    voice.block = block;
    voice.frequencyNumber = frequencyNumber;

    this.chip.write(0xa0 + index, frequencyNumber & 0xff);
    this.chip.write(
      0xb0 + index,
      (voice.keyed ? 0x20 : 0) | (block << 2) | ((frequencyNumber >> 8) & 3),
    );
  }
}
