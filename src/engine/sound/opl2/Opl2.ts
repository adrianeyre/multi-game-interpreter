import {
  CHANNEL_OPERATORS,
  EXP,
  FREQUENCY_MULTIPLE,
  KEY_SCALE_LEVEL,
  KEY_SCALE_SHIFT,
  LOG_SINE,
  PHASE_LENGTH,
  SILENCE,
  SLOT_TO_OPERATOR,
} from './tables.js';

/**
 * A Yamaha YM3812 — the OPL2, the chip on an AdLib card and a Sound Blaster.
 *
 * Nine two-operator voices. Each operator is a sine oscillator with its own
 * envelope; a channel either uses the first to bend the phase of the second
 * (frequency modulation, which is where the characteristic FM timbres come
 * from) or simply adds the two together.
 *
 * All the arithmetic happens in the logarithmic domain. `LOG_SINE` gives the
 * attenuation of a sine rather than its value, envelope, volume and key
 * scaling are then *added* to it, and `EXP` converts the total back to an
 * amplitude once. That is not a shortcut — it is what the hardware does, and
 * it is why a chip built from adders can multiply.
 *
 * This models the chip's behaviour rather than its clock cycles. Waveforms,
 * frequencies and the shape of the envelopes are computed as specified;
 * envelope *rates* follow the documented halving-every-four-steps progression
 * rather than being matched to hardware measurements. Music therefore plays at
 * the right pitch with the right timbre, and a note's decay is close rather
 * than sample-exact.
 */

/** The chip's own sample rate: its 3.58 MHz clock divided by 72. */
export const OPL2_RATE = 3579545 / 72;

/** Phase is accumulated in fixed point, with this many fractional bits. */
const PHASE_FRACTION = 10;

/** Envelope levels run 0 (full volume) to 511 (silent). */
const ENVELOPE_MAX = 511;

/**
 * Attenuation units per envelope step, per total-level step, and per key
 * scale step, expressed in the log table's own units of 1/256 of an octave.
 *
 * One unit is 6.0206 / 256 dB. An envelope step is 0.1875 dB, a total-level
 * step 0.75 dB, and a key-scale-level step 0.375 dB, which is where these
 * three numbers come from.
 */
const PER_ENVELOPE_STEP = 8;
const PER_TOTAL_LEVEL_STEP = 32;
const PER_KEY_SCALE_STEP = 16;

type EnvelopePhase = 'off' | 'attack' | 'decay' | 'sustain' | 'release';

class Operator {
  /** Fixed-point phase; the top bits index the sine table. */
  phase = 0;
  phaseIncrement = 0;

  envelopePhase: EnvelopePhase = 'off';
  /** 0 is loudest. Starts silent so an un-keyed operator contributes nothing. */
  envelopeLevel = ENVELOPE_MAX;

  attackRate = 0;
  decayRate = 0;
  sustainLevel = 0;
  releaseRate = 0;

  multiple = 0;
  keyScaleLevel = 0;
  totalLevel = 0;
  waveform = 0;
  /** Sustaining operators hold at the sustain level; percussive ones decay on. */
  sustaining = false;
  /** Key scale rate: high notes run their envelopes faster. */
  keyScaleRate = false;

  /** Cached from the owning channel, because both feed the phase step. */
  frequencyNumber = 0;
  block = 0;

  keyScaleAttenuation = 0;

  reset(): void {
    this.phase = 0;
    this.phaseIncrement = 0;
    this.envelopePhase = 'off';
    this.envelopeLevel = ENVELOPE_MAX;
    this.attackRate = 0;
    this.decayRate = 0;
    this.sustainLevel = 0;
    this.releaseRate = 0;
    this.multiple = 0;
    this.keyScaleLevel = 0;
    this.totalLevel = 0;
    this.waveform = 0;
    this.sustaining = false;
    this.keyScaleRate = false;
    this.frequencyNumber = 0;
    this.block = 0;
    this.keyScaleAttenuation = 0;
  }

  /**
   * Recomputes the phase step and the key-scaled attenuation.
   *
   * Called whenever the note or any setting feeding them changes, so the
   * render loop never has to.
   */
  refresh(): void {
    // f = fnum * rate / 2^(20 - block), and a cycle is PHASE_LENGTH steps, so
    // with ten fractional bits the step is simply fnum shifted by the block.
    const base = (this.frequencyNumber << this.block) >>> 0;
    this.phaseIncrement = (base * FREQUENCY_MULTIPLE[this.multiple]) >>> 1;

    // Higher notes are quieter, by an amount the octave and the top of the
    // frequency number decide between them.
    const raw = KEY_SCALE_LEVEL[(this.frequencyNumber >> 6) & 0x0f] - 8 * (7 - this.block);
    const scaled = raw <= 0 ? 0 : raw >> KEY_SCALE_SHIFT[this.keyScaleLevel];
    this.keyScaleAttenuation = scaled * PER_KEY_SCALE_STEP;
  }

  keyOn(): void {
    this.envelopePhase = 'attack';
    this.phase = 0;
  }

  keyOff(): void {
    if (this.envelopePhase !== 'off') this.envelopePhase = 'release';
  }

  /** The envelope rate in the chip's 0-63 scale, given a 0-15 setting. */
  private effectiveRate(setting: number): number {
    if (setting === 0) return 0;
    // Key scaling adds up to four steps, from the octave and the top bit of
    // the frequency number — a note an octave up decays measurably faster.
    const keyScale = this.keyScaleRate
      ? (this.block << 1) | ((this.frequencyNumber >> 9) & 1)
      : this.block >> 1;
    return Math.min(63, setting * 4 + keyScale);
  }

  /**
   * Advances the envelope by one sample.
   *
   * `counter` is the chip-wide sample counter: a rate decides how often a step
   * is taken by masking it, which is how one counter drives eighteen envelopes
   * running at different speeds without any per-operator timers.
   */
  private stepEnvelope(counter: number): void {
    if (this.envelopePhase === 'off' || this.envelopePhase === 'sustain') return;

    const rate =
      this.envelopePhase === 'attack'
        ? this.effectiveRate(this.attackRate)
        : this.envelopePhase === 'decay'
          ? this.effectiveRate(this.decayRate)
          : this.effectiveRate(this.releaseRate);

    if (rate === 0) return;

    // Each group of four rate steps halves the period, which is the
    // progression the chip's documentation describes.
    const shift = 13 - (rate >> 2);
    const period = shift > 0 ? 1 << shift : 1;
    if ((counter & (period - 1)) !== 0) return;

    // Beyond the fastest period the rate keeps climbing by taking bigger steps.
    const size = (4 + (rate & 3)) * (shift >= 0 ? 1 : 1 << -shift);

    if (this.envelopePhase === 'attack') {
      // Attack approaches full volume proportionally, which is what gives an
      // FM note its fast opening and soft landing rather than a linear ramp.
      this.envelopeLevel -= 1 + ((this.envelopeLevel * size) >> 7);
      if (this.envelopeLevel <= 0) {
        this.envelopeLevel = 0;
        this.envelopePhase = 'decay';
      }
      return;
    }

    this.envelopeLevel += size;
    if (this.envelopePhase === 'decay' && this.envelopeLevel >= this.sustainLevel) {
      this.envelopeLevel = this.sustainLevel;
      // A sustaining operator holds here until key-off; a percussive one keeps
      // fading, which is the difference between an organ and a plucked string.
      this.envelopePhase = this.sustaining ? 'sustain' : 'release';
    }
    if (this.envelopeLevel >= ENVELOPE_MAX) {
      this.envelopeLevel = ENVELOPE_MAX;
      this.envelopePhase = 'off';
    }
  }

  /**
   * One sample, as a signed amplitude of roughly +/-2048.
   *
   * `modulation` shifts the phase, in phase-table steps: this is the whole of
   * frequency modulation, and passing zero gives a plain oscillator.
   */
  sample(counter: number, modulation: number): number {
    this.stepEnvelope(counter);
    if (this.envelopePhase === 'off') return 0;

    this.phase = (this.phase + this.phaseIncrement) >>> 0;

    const index = ((this.phase >>> PHASE_FRACTION) + modulation) & (PHASE_LENGTH - 1);
    const attenuation =
      this.envelopeLevel * PER_ENVELOPE_STEP +
      this.totalLevel * PER_TOTAL_LEVEL_STEP +
      this.keyScaleAttenuation;

    return waveSample(index, this.waveform, attenuation);
  }
}

/**
 * Looks up one point of a waveform and applies an attenuation, in the log
 * domain throughout.
 *
 * The OPL2's four waveforms are all derived from the same quarter-sine table:
 * the full sine, the same with its negative half silenced, the absolute value,
 * and only the rising quarters. Building them by reflection rather than
 * storing four tables is what the hardware does.
 */
function waveSample(index: number, waveform: number, attenuation: number): number {
  const quarter = index & 0xff;
  const segment = (index >> 8) & 3;

  let negative = (segment & 2) !== 0;
  let silent = false;

  switch (waveform) {
    case 1:
      // Negative half removed.
      if (negative) silent = true;
      negative = false;
      break;
    case 2:
      // Absolute value: both humps positive.
      negative = false;
      break;
    case 3:
      // Only the rising quarter of each half survives.
      if (segment & 1) silent = true;
      negative = false;
      break;
    default:
      break;
  }

  if (silent) return 0;

  const base = segment & 1 ? LOG_SINE[255 - quarter] : LOG_SINE[quarter];
  const total = base + attenuation;
  if (total >= SILENCE) return 0;

  // Mantissa from the exponential table, exponent applied by shifting: the
  // two together cover the chip's whole dynamic range from 256 entries. The
  // table counts upwards, so the low byte is complemented to read it.
  const magnitude = (EXP[255 - (total & 0xff)] | 0x400) >> (total >> 8);
  return negative ? -magnitude : magnitude;
}

class Channel {
  frequencyNumber = 0;
  block = 0;
  keyOn = false;
  feedback = 0;
  /** False for frequency modulation, true for the two operators in parallel. */
  additive = false;

  /** The modulator's last two outputs, which is what feedback averages. */
  previous = 0;
  beforePrevious = 0;

  reset(): void {
    this.frequencyNumber = 0;
    this.block = 0;
    this.keyOn = false;
    this.feedback = 0;
    this.additive = false;
    this.previous = 0;
    this.beforePrevious = 0;
  }
}

export class Opl2 {
  private readonly operators: Operator[] = Array.from({ length: 18 }, () => new Operator());
  private readonly channels: Channel[] = Array.from({ length: 9 }, () => new Channel());

  /** Drives every envelope; one tick per rendered sample. */
  private counter = 0;

  /** Every register written, so state can be inspected and restored. */
  private readonly registers = new Uint8Array(256);

  reset(): void {
    for (const operator of this.operators) operator.reset();
    for (const channel of this.channels) channel.reset();
    this.registers.fill(0);
    this.counter = 0;
  }

  /** The last value written to a register, for tests and diagnostics. */
  read(register: number): number {
    return this.registers[register & 0xff];
  }

  /**
   * Writes one of the chip's registers.
   *
   * Unknown and unimplemented registers are accepted and remembered rather
   * than rejected: a driver writing the rhythm or test registers should not
   * fail, it should simply not hear those things.
   */
  write(register: number, value: number): void {
    const address = register & 0xff;
    const data = value & 0xff;
    this.registers[address] = data;

    const group = address & 0xf0;
    const offset = address & 0x1f;
    const operator = offset < 32 ? SLOT_TO_OPERATOR[offset] : -1;

    switch (group) {
      case 0x20:
        if (operator < 0) break;
        {
          const op = this.operators[operator];
          op.multiple = data & 0x0f;
          op.keyScaleRate = (data & 0x10) !== 0;
          op.sustaining = (data & 0x20) !== 0;
          // Vibrato and tremolo are accepted but not modelled; they are a
          // shallow effect and their absence is a subtlety, not a wrong note.
          op.refresh();
        }
        break;

      case 0x40:
        if (operator < 0) break;
        {
          const op = this.operators[operator];
          op.totalLevel = data & 0x3f;
          op.keyScaleLevel = (data >> 6) & 3;
          op.refresh();
        }
        break;

      case 0x60:
        if (operator < 0) break;
        this.operators[operator].attackRate = (data >> 4) & 0x0f;
        this.operators[operator].decayRate = data & 0x0f;
        break;

      case 0x80:
        if (operator < 0) break;
        // Sustain is stored as an attenuation in envelope units, so the
        // envelope can compare against it directly. 15 means fully silent.
        {
          const level = (data >> 4) & 0x0f;
          this.operators[operator].sustainLevel = level === 0x0f ? ENVELOPE_MAX : level * 32;
          this.operators[operator].releaseRate = data & 0x0f;
        }
        break;

      case 0xe0:
        if (operator < 0) break;
        this.operators[operator].waveform = data & 3;
        break;

      case 0xa0:
      case 0xb0:
        this.writeChannel(address, data);
        break;

      case 0xc0: {
        const index = address & 0x0f;
        if (index >= 9) break;
        this.channels[index].feedback = (data >> 1) & 7;
        this.channels[index].additive = (data & 1) !== 0;
        break;
      }

      default:
        break;
    }
  }

  private writeChannel(address: number, data: number): void {
    const index = address & 0x0f;
    if (index >= 9) return;
    const channel = this.channels[index];

    if ((address & 0xf0) === 0xa0) {
      channel.frequencyNumber = (channel.frequencyNumber & 0x300) | data;
    } else {
      channel.frequencyNumber = (channel.frequencyNumber & 0xff) | ((data & 3) << 8);
      channel.block = (data >> 2) & 7;

      const keying = (data & 0x20) !== 0;
      const wasKeyed = channel.keyOn;
      channel.keyOn = keying;

      for (const operator of CHANNEL_OPERATORS[index]) {
        const op = this.operators[operator];
        op.frequencyNumber = channel.frequencyNumber;
        op.block = channel.block;
        op.refresh();
        if (keying && !wasKeyed) op.keyOn();
        else if (!keying && wasKeyed) op.keyOff();
      }
      return;
    }

    for (const operator of CHANNEL_OPERATORS[index]) {
      const op = this.operators[operator];
      op.frequencyNumber = channel.frequencyNumber;
      op.block = channel.block;
      op.refresh();
    }
  }

  /** One sample, summed across all nine channels, as a signed integer. */
  private sample(): number {
    let total = 0;

    for (const [index, channel] of this.channels.entries()) {
      const [modulatorIndex, carrierIndex] = CHANNEL_OPERATORS[index];
      const modulator = this.operators[modulatorIndex];
      const carrier = this.operators[carrierIndex];

      // Feedback takes the average of the modulator's last two outputs, which
      // damps the oscillation the raw previous sample would cause.
      const feedback =
        channel.feedback === 0
          ? 0
          : ((channel.previous + channel.beforePrevious) >> 1) >> (9 - channel.feedback);

      const modulated = modulator.sample(this.counter, feedback >> 1);
      channel.beforePrevious = channel.previous;
      channel.previous = modulated;

      total += channel.additive
        ? modulated + carrier.sample(this.counter, 0)
        : carrier.sample(this.counter, modulated >> 1);
    }

    this.counter = (this.counter + 1) >>> 0;
    return total;
  }

  /**
   * Fills a buffer at the chip's own rate.
   *
   * The divisor is where the chip's numbers become a signal, and it was set
   * for the theoretical worst case — nine channels at full volume, which sums
   * to about nine times one operator's ±4085. Real scores are nowhere near
   * that, and the result was music at about a fifth of the level everything
   * else in the mix plays at. Measured across Atlantis's own pieces the raw
   * peak is around 2800, so a quarter of the old divisor puts the loudest of
   * them near full scale and leaves the rest in proportion — a fixed scale,
   * because normalising each piece to its own peak would make a quiet cue as
   * loud as a fanfare. The clamp below is what catches a score louder than any
   * of those.
   */
  render(out: Float32Array): void {
    for (let i = 0; i < out.length; i++) {
      const value = this.sample() / 4096;
      // Nine voices at full volume would sum past full scale. Clamping is a
      // last resort that keeps a loud passage merely loud, rather than letting
      // it wrap round into noise.
      out[i] = value > 1 ? 1 : value < -1 ? -1 : value;
    }
  }
}
