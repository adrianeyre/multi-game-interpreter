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
import { gmInstrument, gmPercussion } from './gmAdLibBank.js';
import { mt32ProgramToGm } from './mt32.js';
import {
  EFFECT_REGISTERS,
  idleEnvelope,
  idleTarget,
  ModulationRandom,
  startModulation,
  stepModulation,
  type ModulationEnvelope,
  type ModulationTarget,
} from './adlibModulation.js';

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
  /**
   * The two modulation effects of an iMUSE instrument: flags (bit 7 enables,
   * the low nibble picks the parameter) and eight bytes of envelope.
   */
  effectA?: { flags: number; extra: number[] };
  effectB?: { flags: number; extra: number[] };
  /** Note length in 63rds of a timer step, 0 for "until released". */
  duration?: number;
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

/**
 * Where a score's instruments come from.
 *
 * - `score`: the score defines them in system-exclusive blocks, as an AdLib
 *   (`ADL `) arrangement does, and programme changes are not bank selections.
 * - `gm`: programme changes name General MIDI instruments (`GMD `, `MIDI`),
 *   and channel 10 is percussion.
 * - `mt32`: programme changes name MT-32 presets (`ROL `), which are mapped to
 *   General MIDI first — iMUSE's `Instrument_Program::send` does the same when
 *   an MT-32 score meets a device that is not one.
 */
export type InstrumentBank = 'score' | 'gm' | 'mt32';

/** General MIDI's percussion channel, counted from zero. */
const PERCUSSION_CHANNEL = 9;

interface Voice {
  /** MIDI channel currently owning it, or -1. */
  owner: number;
  note: number;
  /** Rising counter, so the oldest voice is the one with the lowest value. */
  age: number;
  keyed: boolean;
  block: number;
  frequencyNumber: number;
  /** What it was keyed with, so a volume change rescales the right levels. */
  instrument: AdLibInstrument;
  velocity: number;
  /** The instrument's two modulation effects, running while the note sounds. */
  envelopeA: ModulationEnvelope;
  targetA: ModulationTarget;
  envelopeB: ModulationEnvelope;
  targetB: ModulationTarget;
  /** Time left before the instrument ends the note itself, or 0. */
  duration: number;
  /** Loudness added by an effect, modulator then carrier, in level steps. */
  levelMod: [number, number];
  /** Pitch added by an effect, in semitones. */
  pitchMod: number;
}

/** `MidiDriver_ADLIB`'s timer divider: its envelopes step at 250 × 0xD69/0x411B Hz. */
const TIMER_INCREASE = 0xd69;
const TIMER_THRESHOLD = 0x411b;

export class AdLibDriver {
  private readonly voices: Voice[] = Array.from({ length: VOICE_COUNT }, () => ({
    owner: -1,
    note: -1,
    age: 0,
    keyed: false,
    block: 0,
    frequencyNumber: 0,
    instrument: DEFAULT_INSTRUMENT,
    velocity: 127,
    envelopeA: idleEnvelope(),
    targetA: idleTarget(),
    envelopeB: idleEnvelope(),
    targetB: idleTarget(),
    duration: 0,
    levelMod: [0, 0],
    pitchMod: 0,
  }));

  /** Every register as last written, since effects sweep from what is there. */
  private readonly registers = new Uint8Array(256);
  private readonly random = new ModulationRandom();
  private timerCounter = 0;
  private readonly modWheels = new Map<number, number>();

  private write(register: number, value: number): void {
    this.registers[register & 0xff] = value & 0xff;
    this.chip.write(register, value);
  }

  /** Instrument per MIDI channel. */
  private readonly instruments = new Map<number, AdLibInstrument>();
  /** Volume per MIDI channel, 0-127. */
  private readonly volumes = new Map<number, number>();
  /** Pitch bend per MIDI channel, in semitones. */
  private readonly bends = new Map<number, number>();

  /** Instrument bank per channel, where it differs from the driver's. */
  private readonly banks = new Map<number, InstrumentBank>();
  /** iMUSE part priority per channel; unset is 0, so all are equal. */
  private readonly priorities = new Map<number, number>();

  /** Fine tuning per MIDI channel, in semitones, for iMUSE's detune. */
  private readonly detunes = new Map<number, number>();

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

  constructor(
    private readonly chip: Opl2,
    private readonly bank: InstrumentBank = 'score',
  ) {
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
    this.detunes.clear();
    this.clock = 0;
    this.unreadableSysex = 0;
    this.instrumentsLoaded = 0;

    // Wave select has to be enabled explicitly, or every operator is a sine
    // and three quarters of the chip's timbres are unreachable.
    this.write(0x01, 0x20);
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
        // In an AdLib arrangement a programme number is not a bank selection:
        // SCUMM supplies its instruments through SysEx instead, so the channel
        // keeps whatever the music last defined for it. The other arrangements
        // name instruments by number and expect the synthesiser to own them,
        // which is what the GM bank is for.
        {
          const bank = this.bankFor(event.channel);
          if (bank !== 'score') {
            const program = bank === 'mt32' ? mt32ProgramToGm(event.data1) : event.data1;
            this.instruments.set(event.channel, gmInstrument(program));
          }
        }
        break;

      case MIDI_CONTROL_CHANGE:
        if (event.data1 === 7) {
          this.volumes.set(event.channel, event.data2);
          this.refreshChannelVolume(event.channel);
        } else if (event.data1 === 1) {
          this.modulationWheel(event.channel, event.data2);
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
        // Sysex is the sequencer's to read: iMUSE instrument definitions reach
        // the driver through `setInstrument`, already decoded, and a Roland
        // score's patch data is for a synthesiser this is not.
        break;

      default:
        break;
    }
  }

  /**
   * Gives a channel an instrument, as iMUSE's `Instrument_AdLib::send` does.
   *
   * The instrument data itself comes from the score's sysex, decoded by the
   * sequencer (`imuseInstruments.ts`) — the driver only holds what it is given.
   */
  setInstrument(channel: number, instrument: AdLibInstrument): void {
    this.instruments.set(channel, instrument);
    this.instrumentsLoaded++;
  }

  /**
   * Chooses how one channel's programme changes are read.
   *
   * Per channel because one chip is shared by every playing piece (as
   * ScummVM's single `MidiDriver_ADLIB` is), and an AdLib score and a Roland
   * score can be playing at once.
   */
  setChannelBank(channel: number, bank: InstrumentBank): void {
    this.banks.set(channel, bank);
  }

  /** A channel's iMUSE part priority, which decides who keeps a voice. */
  setPriority(channel: number, priority: number): void {
    this.priorities.set(channel, priority);
  }

  /** Gives a channel a General MIDI bank instrument (`AdLibPart::programChange`). */
  selectBankInstrument(channel: number, program: number): void {
    this.instruments.set(channel, gmInstrument(program));
  }

  /** Which channel holds each voice while keyed (-1 for none), for diagnostics. */
  get voiceOwners(): number[] {
    return this.voices.map((voice) => (voice.keyed ? voice.owner : -1));
  }

  /** Releases one channel's notes. */
  releaseChannel(channel: number): void {
    this.allNotesOff(channel);
  }

  private bankFor(channel: number): InstrumentBank {
    return this.banks.get(channel) ?? this.bank;
  }

  private instrumentFor(channel: number): AdLibInstrument {
    return this.instruments.get(channel) ?? DEFAULT_INSTRUMENT;
  }

  /**
   * Detunes a channel by a fraction of a semitone, or several.
   *
   * iMUSE's detune and fine transpose arrive here: ScummVM's AdLib driver adds
   * them to the pitch-bend sum, which is what this is, so they bend notes that
   * are already sounding as well as the next ones.
   */
  setDetune(channel: number, semitones: number): void {
    if (semitones === 0) this.detunes.delete(channel);
    else this.detunes.set(channel, semitones);
    this.refreshChannelPitch(channel);
  }

  /** Releases every sounding note, for a jump that leaves notes hanging. */
  releaseAll(): void {
    for (let channel = 0; channel < 16; channel++) this.allNotesOff(channel);
  }

  private pitchOffset(channel: number): number {
    return (this.bends.get(channel) ?? 0) + (this.detunes.get(channel) ?? 0);
  }

  private noteOn(channel: number, note: number, velocity: number): void {
    // General MIDI drums: the key picks the instrument, not the pitch. A drum
    // key with no voice in the bank is dropped rather than played as a tone.
    let instrument = this.instrumentFor(channel);
    if (this.bankFor(channel) !== 'score' && channel % 16 === PERCUSSION_CHANNEL) {
      const drum = gmPercussion(note);
      if (!drum) return;
      instrument = drum;
    }

    const voice = this.allocate(channel);
    if (!voice) return;
    const index = this.voices.indexOf(voice);

    voice.owner = channel;
    voice.note = note;
    voice.age = ++this.clock;
    voice.keyed = true;
    voice.instrument = instrument;
    voice.velocity = velocity;
    voice.levelMod = [0, 0];
    voice.pitchMod = 0;
    voice.duration = (instrument.duration ?? 0) * 63;

    this.program(index, instrument, channel, velocity);
    this.setPitch(index, note + this.pitchOffset(channel));

    // `mcKeyOn`: the effects start once the note is keyed, from the registers
    // it was keyed with.
    const wheel = this.modWheels.get(channel) ?? 0;
    for (const [effect, env, target, other] of [
      [instrument.effectA, voice.envelopeA, voice.targetA, voice.envelopeB],
      [instrument.effectB, voice.envelopeB, voice.targetB, voice.envelopeA],
    ] as const) {
      if (effect && effect.flags & 0x80) {
        startModulation(
          env,
          target,
          other,
          effect.flags,
          effect.extra,
          (param) => this.parameterValue(index, param),
          wheel,
          this.random,
        );
      } else {
        env.active = 0;
      }
    }
  }

  /**
   * The driver's timer: note durations and modulation, as
   * `MidiDriver_ADLIB::onTimer` runs them, called at 250 Hz by the card.
   */
  onTimer(): void {
    this.timerCounter += TIMER_INCREASE;
    while (this.timerCounter >= TIMER_THRESHOLD) {
      this.timerCounter -= TIMER_THRESHOLD;
      for (const [index, voice] of this.voices.entries()) {
        if (!voice.keyed) continue;
        if (voice.duration && (voice.duration -= 0x11) <= 0) {
          // The instrument's own length ran out: the note ends here, and the
          // original stops the pass at it.
          voice.duration = 0;
          this.keyOff(index, voice);
          return;
        }
        if (voice.envelopeA.active) {
          this.modulate(index, voice, voice.envelopeA, voice.targetA, voice.envelopeB);
        }
        if (voice.envelopeB.active) {
          this.modulate(index, voice, voice.envelopeB, voice.targetB, voice.envelopeA);
        }
      }
    }
  }

  /** `mcIncStuff`: one envelope step, and its effect on the voice. */
  private modulate(
    index: number,
    voice: Voice,
    env: ModulationEnvelope,
    target: ModulationTarget,
    other: ModulationEnvelope,
  ): void {
    const code = stepModulation(env, target, this.random);
    if (code & 1) {
      const value = env.startValue + target.modifyVal;
      switch (target.param) {
        case 0:
          // Levels are loudness here, and this driver's levels are
          // attenuation: the sweep is applied as the change it makes.
          voice.levelMod[1] = target.modifyVal;
          this.write(
            0x40 + CHANNEL_REGISTERS[index][1],
            this.carrierLevel(voice.instrument, voice.owner, voice.velocity, voice.levelMod[1]),
          );
          break;
        case 13:
          voice.levelMod[0] = target.modifyVal;
          this.write(0x40 + CHANNEL_REGISTERS[index][0], this.modulatorLevel(voice));
          break;
        case 28:
        case 29:
          // Pitch, in the original's 1/128ths of a semitone after its offset.
          voice.pitchMod = ((value - (target.param === 28 ? 15 : 383)) * 16) / 128;
          this.setPitch(index, voice.note + this.pitchOffset(voice.owner) + voice.pitchMod);
          break;
        case 30:
          other.modWheel = (target.modifyVal << 24) >> 24;
          break;
        case 31:
          other.depth = (target.modifyVal << 24) >> 24;
          break;
        default:
          this.setParameter(index, target.param, value);
      }
    }
    if (code & 2 && target.retriggers) {
      const register = 0xb0 + index;
      const current = this.registers[register];
      this.write(register, current & ~0x20);
      this.write(register, current | 0x20);
    }
  }

  /** Where a register field lives for an effect parameter (`adlibSetParam`). */
  private parameterRegister(index: number, param: number) {
    const [modulator, carrier] = CHANNEL_REGISTERS[index];
    if (param <= 12) return { spec: EFFECT_REGISTERS[param], offset: carrier };
    if (param <= 25) return { spec: EFFECT_REGISTERS[param - 13], offset: modulator };
    if (param <= 27) return { spec: EFFECT_REGISTERS[param - 13], offset: index };
    return null;
  }

  /** `adlibGetRegValueParam`: an effect's starting point. */
  private parameterValue(index: number, param: number): number {
    if (param === 28) return 0xf;
    if (param === 29) return 0x17f;
    // Levels start from the voice's loudness (`_vol1`/`_vol2`): the inverse
    // of the attenuation it was keyed with, so a sweep can go either way.
    if (param === 0 || param === 13) {
      const operator = CHANNEL_REGISTERS[index][param === 0 ? 1 : 0];
      return 0x3f - (this.registers[0x40 + operator] & 0x3f);
    }
    const found = this.parameterRegister(index, param);
    if (!found) return 0;
    const { spec, offset } = found;
    let value = (this.registers[spec.base + offset] & spec.mask) >> spec.shift;
    if (spec.inversion) value = spec.inversion - value;
    return value;
  }

  private setParameter(index: number, param: number, value: number): void {
    const found = this.parameterRegister(index, param);
    if (!found) return;
    const { spec, offset } = found;
    const stored = spec.inversion ? spec.inversion - value : value;
    const register = spec.base + offset;
    this.write(register, (this.registers[register] & ~spec.mask) | ((stored & 0xff) << spec.shift));
  }

  /** `AdLibPart::modulationWheel`: effects that follow the wheel follow it live. */
  private modulationWheel(channel: number, value: number): void {
    this.modWheels.set(channel, value);
    for (const voice of this.voices) {
      if (voice.owner !== channel || !voice.keyed) continue;
      if (voice.envelopeA.active && voice.targetA.followsModWheel) {
        voice.envelopeA.modWheel = value >> 2;
      }
      if (voice.envelopeB.active && voice.targetB.followsModWheel) {
        voice.envelopeB.modWheel = value >> 2;
      }
    }
  }

  private keyOff(index: number, voice: Voice): void {
    voice.keyed = false;
    voice.envelopeA.active = 0;
    voice.envelopeB.active = 0;
    this.write(0xb0 + index, (voice.block << 2) | ((voice.frequencyNumber >> 8) & 3));
  }

  private noteOff(channel: number, note: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || voice.note !== note || !voice.keyed) continue;
      this.keyOff(index, voice);
    }
  }

  private allNotesOff(channel: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || !voice.keyed) continue;
      this.keyOff(index, voice);
    }
  }

  /**
   * A voice for a new note, as `MidiDriver_ADLIB::allocateVoice` chooses one.
   *
   * A free voice if there is one — a released voice counts, as the original
   * frees a voice at note-off. Otherwise the sounding voice whose part has the
   * *lowest* priority no higher than the new note's is stolen, the oldest of
   * those if several tie; and if every voice belongs to a more important
   * part, the new note is not played. That is what lets a sound effect's
   * score cut through the music without the music's bass line taking its
   * voices back.
   */
  private allocate(channel: number): Voice | null {
    const free = this.voices.find((voice) => !voice.keyed && voice.owner === -1);
    if (free) return free;

    const released = this.voices.find((voice) => !voice.keyed);
    if (released) return released;

    const priority = this.priorities.get(channel) ?? 0;
    let best: Voice | null = null;
    for (const voice of this.voices) {
      const owner = this.priorities.get(voice.owner) ?? 0;
      if (owner > priority) continue;
      const bestOwner = best ? (this.priorities.get(best.owner) ?? 0) : Infinity;
      if (!best || owner < bestOwner || (owner === bestOwner && voice.age < best.age)) best = voice;
    }
    return best;
  }

  /** Writes an instrument into a voice's registers. */
  private program(
    index: number,
    instrument: AdLibInstrument,
    channel: number,
    velocity: number,
  ): void {
    const [modulator, carrier] = CHANNEL_REGISTERS[index];

    this.write(0x20 + modulator, instrument.characteristic[0]);
    this.write(0x20 + carrier, instrument.characteristic[1]);
    this.write(0x60 + modulator, instrument.attackDecay[0]);
    this.write(0x60 + carrier, instrument.attackDecay[1]);
    this.write(0x80 + modulator, instrument.sustainRelease[0]);
    this.write(0x80 + carrier, instrument.sustainRelease[1]);
    this.write(0xe0 + modulator, instrument.waveform[0]);
    this.write(0xe0 + carrier, instrument.waveform[1]);
    this.write(0xc0 + index, instrument.feedback);

    // The modulator keeps its own level, which is part of the timbre. Only the
    // carrier's level is loudness, so that is where velocity and channel
    // volume are applied.
    this.write(0x40 + modulator, instrument.level[0]);
    this.write(0x40 + carrier, this.carrierLevel(instrument, channel, velocity));
  }

  private modulatorLevel(voice: Voice): number {
    const level = voice.instrument.level[0];
    const attenuation = (level & 0x3f) - voice.levelMod[0];
    return (level & 0xc0) | Math.max(0, Math.min(0x3f, attenuation));
  }

  /**
   * Combines the instrument's own level with velocity and channel volume.
   *
   * Total level is an attenuation, so louder is a smaller number, and the
   * three contributions add rather than multiply — which is the same
   * logarithmic domain the chip itself works in.
   */
  private carrierLevel(
    instrument: AdLibInstrument,
    channel: number,
    velocity: number,
    loudness = 0,
  ): number {
    const keyScale = instrument.level[1] & 0xc0;
    const base = instrument.level[1] & 0x3f;

    const volume = this.volumes.get(channel) ?? 127;
    // Velocity and volume each span the 6-bit attenuation range at most half
    // way, so a quiet note is quiet without becoming inaudible.
    const attenuation =
      base +
      Math.round(((127 - velocity) * 24) / 127) +
      Math.round(((127 - volume) * 24) / 127) -
      loudness;

    return keyScale | Math.max(0, Math.min(0x3f, attenuation));
  }

  private refreshChannelVolume(channel: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || !voice.keyed) continue;
      const carrier = CHANNEL_REGISTERS[index][1];
      this.write(
        0x40 + carrier,
        this.carrierLevel(voice.instrument, channel, voice.velocity, voice.levelMod[1]),
      );
    }
  }

  private refreshChannelPitch(channel: number): void {
    for (const [index, voice] of this.voices.entries()) {
      if (voice.owner !== channel || !voice.keyed) continue;
      this.setPitch(index, voice.note + this.pitchOffset(channel) + voice.pitchMod);
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

    this.write(0xa0 + index, frequencyNumber & 0xff);
    this.write(
      0xb0 + index,
      (voice.keyed ? 0x20 : 0) | (block << 2) | ((frequencyNumber >> 8) & 3),
    );
  }
}
