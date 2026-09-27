import {
  MIDI_CONTROL_CHANGE,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  MIDI_PITCH_BEND,
  type MidiEvent,
} from './midi.js';
import {
  PCSPK_ENVELOPE_STEPS,
  PCSPK_FREQUENCIES,
  PCSPK_OUTPUT_INDEX,
  PCSPK_OUTPUT_SHIFT,
  PCSPK_OUT_INSTRUMENT_DATA,
} from './speakerTables.js';

/**
 * iMUSE's PC speaker driver: a port of ScummVM's `IMuseDriver_PCSpk`
 * (engines/scumm/imuse/drivers/pcspk.cpp), effects and all.
 *
 * The speaker can sound one pitch. Each part holds at most one note, and of the
 * parts holding one the highest priority is heard (`updateNote`'s `>=`, so the
 * later part wins a tie). What makes it music rather than a beeper is the
 * instrument: 23 bytes the score loads through iMUSE sysex, which give a note a
 * length, a vibrato read from one of four built-in waveforms, and two envelope
 * generators that can bend the pitch, deepen or speed the vibrato, switch its
 * waveform, or modulate each other. Those generators are ported line for line —
 * including their eight- and sixteen-bit wrap-around, which some instruments
 * depend on.
 *
 * Instrument layout, as `noteOn` and `setupEffects` read it: [0] note length in
 * driver ticks (0 = held), [1] vibrato speed, [2] vibrato depth, [3] velocity
 * sensitivity, [4] vibrato waveform, [5] envelope A flags and [6..13] its
 * definition, [14] envelope B flags and [15..22] its definition.
 */

/** The 8253 timer's input clock. */
const PIT_CLOCK = 1193180;
/** How loud the square is, of full scale. */
const AMPLITUDE = 0.3;
/** The driver's timer: `MidiDriver_Emulated`'s default 250 Hz. */
const TIMER_HZ = 250;

const u8 = (value: number) => value & 0xff;
const i8 = (value: number) => (value << 24) >> 24;
const u16 = (value: number) => value & 0xffff;
const i16 = (value: number) => (value << 16) >> 16;

interface Envelope {
  state: number;
  currentLevel: number;
  duration: number;
  maxLevel: number;
  startLevel: number;
  loop: number;
  stateTargetLevels: number[];
  stateModWheelLevels: number[];
  modWheelSensitivity: number;
  modWheelState: number;
  modWheelLast: number;
  stateNumSteps: number;
  stateStepCounter: number;
  changePerStep: number;
  dir: number;
  changePerStepRem: number;
  changeCountRem: number;
}

interface EffectDefinition {
  phase: number;
  type: number;
  useModWheel: number;
}

const newEnvelope = (): Envelope => ({
  state: 0,
  currentLevel: 0,
  duration: 0,
  maxLevel: 0,
  startLevel: 0,
  loop: 0,
  stateTargetLevels: [0, 0, 0, 0],
  stateModWheelLevels: [0, 0, 0, 0],
  modWheelSensitivity: 0,
  modWheelState: 0,
  modWheelLast: 0,
  stateNumSteps: 0,
  stateStepCounter: 0,
  changePerStep: 0,
  dir: 0,
  changePerStepRem: 0,
  changeCountRem: 0,
});

interface SpeakerChannel {
  active: number;
  note: number;
  sustainNoteOff: number;
  length: number;
  /** Offset into `PCSPK_OUT_INSTRUMENT_DATA`, or -1 for none. */
  waveform: number;
  unkA: number;
  unkB: number;
  unkC: number;
  unkE: number;
  unk60: number;
  envelopeA: Envelope;
  effectA: EffectDefinition;
  envelopeB: Envelope;
  effectB: EffectDefinition;
  instrument: Uint8Array;
  priority: number;
  /** Channel volume: zero silences the part, anything else is full. */
  tl: number;
  modWheel: number;
  pitchBend: number;
  sustain: number;
  pitchBendFactor: number;
  pitchBendRaw: number;
  /** Transpose and detune together, in 1/128ths of a semitone. */
  offset: number;
}

const newChannel = (): SpeakerChannel => ({
  active: 0,
  note: 0,
  sustainNoteOff: 0,
  length: 0,
  waveform: -1,
  unkA: 0,
  unkB: 0,
  unkC: 0,
  unkE: 0,
  unk60: 0,
  envelopeA: newEnvelope(),
  effectA: { phase: 0, type: 0, useModWheel: 0 },
  envelopeB: newEnvelope(),
  effectB: { phase: 0, type: 0, useModWheel: 0 },
  instrument: new Uint8Array(23),
  priority: 0,
  tl: 0,
  modWheel: 0,
  pitchBend: 0,
  sustain: 0,
  pitchBendFactor: 2,
  pitchBendRaw: 0,
  offset: 0,
});

/** The size of a PC speaker instrument, as `Instrument_PcSpk` stores it. */
export const PCSPK_INSTRUMENT_SIZE = 23;

export class PcSpeakerDriver {
  unreadableSysex = 0;
  instrumentsLoaded = 0;

  private readonly channels = new Map<number, SpeakerChannel>();
  private activeChannel: SpeakerChannel | null = null;
  private lastActiveChannel: SpeakerChannel | null = null;
  private lastActiveOut = 0;
  private effectTimer = 0;
  private randBase = 1;

  // The square wave and the speaker cone's smoothing.
  private frequency = 0;
  private phase = 0;
  private level = 0;
  private readonly decay = 0xa000 / 65536;
  private untilTimer = 0;

  constructor(readonly sampleRate: number) {}

  private channel(number: number): SpeakerChannel {
    let channel = this.channels.get(number);
    if (!channel) {
      channel = newChannel();
      this.channels.set(number, channel);
    }
    return channel;
  }

  // --- MIDI in ------------------------------------------------------------------

  handle(event: MidiEvent): void {
    const channel = this.channel(event.channel);
    switch (event.command) {
      case MIDI_NOTE_OFF:
        this.noteOff(channel, event.data1);
        break;
      case MIDI_NOTE_ON:
        if (event.data2) this.noteOn(channel, event.data1, event.data2);
        else this.noteOff(channel, event.data1);
        break;
      case MIDI_CONTROL_CHANGE:
        this.controlChange(channel, event.data1, event.data2);
        break;
      case MIDI_PITCH_BEND:
        channel.pitchBendRaw = ((event.data2 << 7) | event.data1) - 0x2000;
        this.refreshBend(channel);
        break;
      default:
        break;
    }
  }

  /** Loads a part's 23-byte instrument (`sysEx_customInstrument`). */
  setInstrument(number: number, data: Uint8Array): void {
    if (data.length < PCSPK_INSTRUMENT_SIZE) {
      this.unreadableSysex++;
      return;
    }
    this.channel(number).instrument.set(data.subarray(0, PCSPK_INSTRUMENT_SIZE));
    this.instrumentsLoaded++;
  }

  setPriority(number: number, priority: number): void {
    this.channel(number).priority = u8(priority);
  }

  /** Transpose plus detune, in semitones (`transpose` and `detune` together). */
  setDetune(number: number, semitones: number): void {
    const channel = this.channel(number);
    channel.offset = Math.round(semitones * 128);
    this.refreshBend(channel);
  }

  /** Stops one part's note (`allNotesOff` through controller 123). */
  releaseChannel(number: number): void {
    const channel = this.channels.get(number);
    if (!channel) return;
    channel.active = 0;
    this.updateNote();
  }

  releaseAll(): void {
    for (const channel of this.channels.values()) channel.active = 0;
    this.updateNote();
  }

  private refreshBend(channel: SpeakerChannel): void {
    channel.pitchBend = i16(
      channel.offset + ((channel.pitchBendRaw * channel.pitchBendFactor) >> 6),
    );
  }

  private noteOff(channel: SpeakerChannel, note: number): void {
    if (channel.sustain) {
      if (channel.note === note) channel.sustainNoteOff = 1;
    } else if (channel.note === note) {
      channel.active = 0;
      this.updateNote();
    }
  }

  private noteOn(channel: SpeakerChannel, note: number, velocity: number): void {
    const instrument = channel.instrument;
    channel.note = note;
    channel.sustainNoteOff = 0;
    channel.length = instrument[0];
    channel.waveform =
      instrument[4] * 256 < PCSPK_OUT_INSTRUMENT_DATA.length ? instrument[4] * 256 : -1;
    channel.unkA = 0;
    channel.unkB = instrument[1];
    channel.unkC = instrument[2];
    channel.unkE = 0;
    channel.unk60 = 0;
    channel.active = 1;

    // A note on the channel already sounding must re-send its frequency even
    // when it is the same note.
    if (this.lastActiveChannel === channel) {
      this.lastActiveChannel = null;
      this.lastActiveOut = 0;
    }
    this.updateNote();

    channel.unkC = u8(channel.unkC + effectModifier(instrument[3] + ((velocity & 0xfe) << 4)));
    if (channel.unkC > 63) channel.unkC = 63;

    if (instrument[5] & 0x80) {
      this.setupEffects(channel, channel.envelopeA, channel.effectA, instrument[5], 6);
    }
    if (instrument[14] & 0x80) {
      this.setupEffects(channel, channel.envelopeB, channel.effectB, instrument[14], 15);
    }
  }

  private controlChange(channel: SpeakerChannel, control: number, value: number): void {
    switch (control) {
      case 1:
        if (channel.envelopeA.state && channel.effectA.useModWheel) {
          channel.envelopeA.modWheelState = value >> 2;
        }
        if (channel.envelopeB.state && channel.effectB.useModWheel) {
          channel.envelopeB.modWheelState = value >> 2;
        }
        break;
      case 7:
        channel.tl = value;
        if (this.activeChannel === channel) {
          if (channel.tl === 0) {
            this.lastActiveChannel = null;
            this.lastActiveOut = 0;
            this.frequency = 0;
          } else {
            this.output((channel.note << 7) + channel.pitchBend + channel.unk60 + channel.unkE);
          }
        }
        break;
      case 16:
        channel.pitchBendFactor = value;
        this.refreshBend(channel);
        break;
      case 18:
        channel.priority = value;
        this.updateNote();
        break;
      case 64:
        channel.sustain = value;
        if (!value && channel.sustainNoteOff) {
          channel.active = 0;
          this.updateNote();
        }
        break;
      case 120:
      case 123:
        channel.active = 0;
        this.updateNote();
        break;
      default:
        break;
    }
  }

  // --- the speaker ----------------------------------------------------------------

  private updateNote(): void {
    let priority = 0;
    this.activeChannel = null;
    for (const channel of this.channels.values()) {
      if (channel.active && channel.priority >= priority) {
        priority = channel.priority;
        this.activeChannel = channel;
      }
    }
    const active = this.activeChannel;
    if (!active || active.tl === 0) {
      this.frequency = 0;
      this.lastActiveChannel = null;
      this.lastActiveOut = 0;
    } else {
      this.output(active.pitchBend + (active.note << 7));
    }
  }

  /** A pitch in 1/128ths of a semitone, to the timer divisor the original sends. */
  private output(out: number): void {
    const value = u16(out);
    const v1 = (value >> 7) & 0xff;
    const v2 = (value >> 2) & 0x1e;
    const shift = PCSPK_OUTPUT_SHIFT[v1 & 0x7f] ?? 7;
    const base = (PCSPK_OUTPUT_INDEX[v1 & 0x7f] ?? 0) << 5;
    const divisor = (PCSPK_FREQUENCIES[(base + v2) >> 1] ?? 0x8000) >> shift;

    if (this.lastActiveChannel !== this.activeChannel || this.lastActiveOut !== value) {
      this.frequency = divisor > 0 ? PIT_CLOCK / divisor : 0;
      this.lastActiveChannel = this.activeChannel;
      this.lastActiveOut = value;
    }
  }

  /** The driver's own 250 Hz tick: note lengths, vibrato and envelopes. */
  onTimer(): void {
    if (!this.activeChannel) return;

    for (const channel of this.channels.values()) {
      if (!channel.active) continue;

      if (channel.length === 0 || (channel.length = u8(channel.length - 1)) !== 0) {
        if (channel.unkB && channel.unkC) {
          channel.unkA = u8(channel.unkA + channel.unkB);
          if (channel.waveform >= 0) {
            channel.unkE = i16(
              (PCSPK_OUT_INSTRUMENT_DATA[channel.waveform + channel.unkA] * channel.unkC) >> 4,
            );
          }
        }

        if (++this.effectTimer > 3) {
          this.effectTimer = 0;
          if (channel.envelopeA.state) {
            this.updateEffectGenerator(channel, channel.envelopeA, channel.effectA);
          }
          if (channel.envelopeB.state) {
            this.updateEffectGenerator(channel, channel.envelopeB, channel.effectB);
          }
        }
      } else {
        channel.active = 0;
        this.updateNote();
        return;
      }
    }

    const active = this.activeChannel as SpeakerChannel | null;
    if (active && active.tl) {
      this.output((active.note << 7) + active.pitchBend + active.unk60 + active.unkE);
    } else {
      this.frequency = 0;
      this.lastActiveChannel = null;
      this.lastActiveOut = 0;
    }
  }

  /**
   * Renders the square wave, running the driver's timer as the audio advances
   * — so effects keep time with what is heard, not with the page.
   */
  render(out: Float32Array): void {
    const perTimer = this.sampleRate / TIMER_HZ;
    let written = 0;
    while (written < out.length) {
      if (this.untilTimer < 1) {
        this.untilTimer += perTimer;
        this.onTimer();
      }
      const span = Math.min(out.length - written, Math.floor(this.untilTimer));
      const step = this.frequency / this.sampleRate;
      for (let i = written; i < written + span; i++) {
        let target = 0;
        if (step > 0) {
          this.phase += step;
          if (this.phase >= 1) this.phase -= Math.floor(this.phase);
          target = this.phase < 0.5 ? AMPLITUDE : -AMPLITUDE;
        }
        this.level = this.level * this.decay + target * (1 - this.decay);
        out[i] = this.level;
      }
      written += span;
      this.untilTimer -= span;
    }
  }

  // --- effects ---------------------------------------------------------------------

  private randScale(input: number): number {
    if (this.randBase & 1) this.randBase = (this.randBase >> 1) ^ 0xb8;
    else this.randBase >>= 1;
    return i16((this.randBase * input) >> 8);
  }

  private modLevel(level: number, mod: number): number {
    if (!mod) return 0;
    if (mod === 31) return level;
    if (level < -63 || level > 63) return i16((mod * (level + 1)) >> 6);
    if (mod < 0) {
      return level < 0 ? effectModifier((-level << 5) - mod) : -effectModifier((level << 5) - mod);
    }
    // The positive branch reads `-level` for both signs in the original; kept,
    // since the instruments were tuned against that behaviour.
    return level < 0 ? -effectModifier((-level << 5) + mod) : effectModifier((-level << 5) + mod);
  }

  private setupEffects(
    channel: SpeakerChannel,
    env: Envelope,
    def: EffectDefinition,
    flags: number,
    dataAt: number,
  ): void {
    def.phase = 0;
    def.useModWheel = flags & 0x40;
    env.loop = flags & 0x20;
    def.type = flags & 0x1f;

    env.modWheelSensitivity = 31;
    env.modWheelState = def.useModWheel ? channel.modWheel >> 2 : 31;

    switch (def.type) {
      case 0:
        env.maxLevel = 767;
        env.startLevel = 383;
        break;
      case 1:
        env.maxLevel = 31;
        env.startLevel = 15;
        break;
      case 2:
        env.maxLevel = 63;
        env.startLevel = channel.unkB;
        break;
      case 3:
        env.maxLevel = 63;
        env.startLevel = channel.unkC;
        break;
      case 4:
        env.maxLevel = 3;
        env.startLevel = channel.instrument[4];
        break;
      case 5:
        env.maxLevel = 62;
        env.startLevel = 31;
        env.modWheelState = 0;
        break;
      case 6:
        env.maxLevel = 31;
        env.startLevel = 0;
        env.modWheelSensitivity = 0;
        break;
      default:
        break;
    }

    const data = channel.instrument.subarray(dataAt);
    env.state = 1;
    env.currentLevel = 0;
    env.modWheelLast = 31;
    env.duration = i16(data[0] * 63);
    env.stateTargetLevels = [data[1], data[3], data[5], data[6]];
    env.stateModWheelLevels = [data[2], data[4], 0, data[7]];
    this.initNextEnvelopeState(env);
  }

  private initNextEnvelopeState(env: Envelope): void {
    const last = env.state - 1;

    let steps =
      PCSPK_ENVELOPE_STEPS[
        effectModifier(((env.stateTargetLevels[last] & 0x7f) << 5) + env.modWheelSensitivity)
      ] ?? 1;
    if (env.stateTargetLevels[last] & 0x80) steps = this.randScale(steps);
    if (!steps) steps = 1;
    env.stateNumSteps = env.stateStepCounter = steps;

    let change = 0;
    if (last !== 2) {
      change = this.modLevel(env.maxLevel, (env.stateModWheelLevels[last] & 0x7f) - 31);
      if (env.stateModWheelLevels[last] & 0x80) change = this.randScale(change);
      if (change + env.startLevel > env.maxLevel) change = env.maxLevel - env.startLevel;
      else if (change + env.startLevel < 0) change = -env.startLevel;
      change -= env.currentLevel;
    }

    env.changePerStep = i16(Math.trunc(change / steps));
    if (change < 0) {
      change = -change;
      env.dir = -1;
    } else {
      env.dir = 1;
    }
    env.changePerStepRem = change % steps;
    env.changeCountRem = 0;
  }

  private updateEffectGenerator(
    channel: SpeakerChannel,
    env: Envelope,
    def: EffectDefinition,
  ): void {
    if (!(this.advanceEffectEnvelope(env, def) & 1)) return;
    switch (def.type) {
      case 0:
      case 1:
        channel.unk60 = i16(def.phase << 4);
        break;
      case 2:
        channel.unkB = u8((def.phase & 0xff) + channel.instrument[1]);
        break;
      case 3:
        channel.unkC = u8((def.phase & 0xff) + channel.instrument[2]);
        break;
      case 4: {
        const table = (channel.instrument[4] + (def.phase & 0xff)) * 256;
        channel.waveform = table < PCSPK_OUT_INSTRUMENT_DATA.length ? table : -1;
        break;
      }
      case 5:
        env.modWheelState = def.phase & 0xff;
        break;
      case 6:
        env.modWheelSensitivity = def.phase & 0xff;
        break;
      default:
        break;
    }
  }

  private advanceEffectEnvelope(env: Envelope, def: EffectDefinition): number {
    if (env.duration !== 0) {
      env.duration = i16(env.duration - 17);
      if (env.duration <= 0) {
        env.state = 0;
        return 0;
      }
    }

    let changed = 0;
    let level = i16(env.currentLevel + env.changePerStep);
    env.changeCountRem = i16(env.changeCountRem + env.changePerStepRem);
    if (env.changeCountRem >= env.stateNumSteps) {
      env.changeCountRem = i16(env.changeCountRem - env.stateNumSteps);
      level = i16(level + env.dir);
    }

    if (env.currentLevel !== level || env.modWheelLast !== env.modWheelState) {
      env.currentLevel = level;
      env.modWheelLast = env.modWheelState;
      const phase = this.modLevel(level, i8(env.modWheelState));
      if (def.phase !== phase) {
        changed |= 1;
        def.phase = phase;
      }
    }

    if (!(env.stateStepCounter = i16(env.stateStepCounter - 1))) {
      if (++env.state > 4) {
        if (env.loop) {
          env.state = 1;
          changed |= 2;
        } else {
          env.state = 0;
          return changed;
        }
      }
      this.initNextEnvelopeState(env);
    }
    return changed;
  }
}

/** `getEffectModifier`, with its sixteen- and eight-bit truncation. */
function effectModifier(level: number): number {
  const value = u16(level);
  const base = u8(Math.floor(value / 32));
  const index = value % 32;
  if (index === 0) return 0;
  return (base * (index + 1)) >> 5;
}
