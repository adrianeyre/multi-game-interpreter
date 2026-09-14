import { describe, expect, it } from 'vitest';
import { Opl2, OPL2_RATE } from '../src/engine/sound/opl2/Opl2.js';

/**
 * A single audible voice on channel 0.
 *
 * The two operators are put in parallel and the modulator silenced, so what
 * comes out is one operator's raw waveform — the only arrangement in which the
 * chip's output can be compared against what the registers asked for.
 */
function voice(
  options: {
    waveform?: number;
    attack?: number;
    decay?: number;
    sustainRelease?: number;
    totalLevel?: number;
  } = {},
) {
  const { waveform = 0, attack = 15, decay = 0, sustainRelease = 0x00, totalLevel = 0 } = options;
  const chip = new Opl2();
  chip.write(0xc0, 0x01); // parallel, no feedback
  chip.write(0x40, 0x3f); // modulator fully attenuated
  chip.write(0x23, 0x21); // carrier: frequency multiple 1, sustaining
  chip.write(0x43, totalLevel);
  chip.write(0x63, (attack << 4) | decay);
  chip.write(0x83, sustainRelease);
  chip.write(0xe3, waveform);
  return chip;
}

/** Frequency number 0x200 in block 4, which is 388.4 Hz. */
function keyOn(chip: Opl2, fnum = 0x200, block = 4): void {
  chip.write(0xa0, fnum & 0xff);
  chip.write(0xb0, 0x20 | (block << 2) | ((fnum >> 8) & 3));
}

function keyOff(chip: Opl2, fnum = 0x200, block = 4): void {
  chip.write(0xb0, (block << 2) | ((fnum >> 8) & 3));
}

function render(chip: Opl2, samples: number): Float32Array {
  const out = new Float32Array(samples);
  chip.render(out);
  return out;
}

const peak = (samples: Float32Array): number => Math.max(...Array.from(samples, Math.abs));

function risingZeroCrossings(samples: Float32Array): number {
  let count = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) count++;
  }
  return count;
}

describe('the OPL2 chip', () => {
  it('is completely silent with every register at zero', () => {
    // Not "quiet": a synthesiser that idles at any non-zero value adds a hum
    // under everything, and it has to be exactly zero to prove it does not.
    expect(peak(render(new Opl2(), 4096))).toBe(0);
  });

  it('stays silent until a note is keyed on', () => {
    expect(peak(render(voice(), 4096))).toBe(0);
  });

  it('plays the pitch the frequency number and block ask for', () => {
    const chip = voice();
    keyOn(chip, 0x200, 4);

    const measured = risingZeroCrossings(render(chip, Math.round(OPL2_RATE)));
    const expected = (0x200 * OPL2_RATE) / 2 ** (20 - 4);

    expect(expected).toBeCloseTo(388.4, 1);
    expect(measured).toBeGreaterThanOrEqual(Math.floor(expected) - 1);
    expect(measured).toBeLessThanOrEqual(Math.ceil(expected) + 1);
  });

  it('raises the pitch by an octave for each block', () => {
    const rate = (block: number): number => {
      const chip = voice();
      keyOn(chip, 0x200, block);
      return risingZeroCrossings(render(chip, Math.round(OPL2_RATE)));
    };

    expect(rate(5) / rate(4)).toBeCloseTo(2, 1);
  });

  it('doubles the pitch when the frequency multiple doubles', () => {
    const chip = voice();
    chip.write(0x23, 0x22); // multiple 2
    keyOn(chip, 0x200, 4);

    expect(risingZeroCrossings(render(chip, Math.round(OPL2_RATE)))).toBeCloseTo(777, -1);
  });

  it('gives each of the four waveforms its own shape', () => {
    const shape = (waveform: number): { negatives: number; zeros: number } => {
      const chip = voice({ waveform });
      keyOn(chip);
      const out = render(chip, 4096);
      return {
        negatives: Array.from(out).filter((v) => v < -1e-6).length,
        zeros: Array.from(out).filter((v) => v === 0).length,
      };
    };

    // The full sine swings both ways; the other three are rectified, and
    // differ from each other in how much of the cycle they silence.
    expect(shape(0).negatives).toBeGreaterThan(1000);
    expect(shape(1).negatives).toBe(0);
    expect(shape(2).negatives).toBe(0);
    expect(shape(3).negatives).toBe(0);

    // The half sine silences half the cycle; the absolute value silences none
    // of it, because both humps survive.
    expect(shape(1).zeros).toBeGreaterThan(shape(2).zeros);

    // Waveforms 1 and 3 silence the same *amount* of the cycle, so counting
    // zeros cannot tell them apart. What separates them is where: the pulse
    // sine keeps the rising quarter of each half, giving two humps per cycle
    // where the half sine gives one.
    const humps = (waveform: number): number => {
      const chip = voice({ waveform });
      keyOn(chip);
      const out = render(chip, 4096);
      let count = 0;
      for (let i = 1; i < out.length; i++) {
        if (out[i - 1] === 0 && out[i] > 0) count++;
      }
      return count;
    };

    expect(humps(3)).toBeCloseTo(humps(1) * 2, -1);
  });

  it('opens faster at higher attack rates', () => {
    const samplesToFull = (attack: number): number => {
      const chip = voice({ attack });
      keyOn(chip);
      const out = render(chip, 1 << 16);
      const index = Array.from(out).findIndex((v) => Math.abs(v) > 0.12);
      return index < 0 ? Number.POSITIVE_INFINITY : index;
    };

    expect(samplesToFull(15)).toBeLessThan(samplesToFull(10));
    expect(samplesToFull(10)).toBeLessThan(samplesToFull(5));
    expect(samplesToFull(5)).toBeLessThan(samplesToFull(1));
  });

  it('decays to exactly the sustain level and holds there', () => {
    // Sustain level 4 is 4 * 32 envelope steps, and an envelope step is
    // 0.1875 dB, so the note should settle 24 dB below its peak.
    const chip = voice({ decay: 8, sustainRelease: 0x40 });
    keyOn(chip);
    const out = render(chip, Math.round(OPL2_RATE / 2));

    // Compared against an undecayed note rather than against this note's own
    // opening samples, where a fast decay has already started to bite.
    const reference = voice();
    keyOn(reference);
    const unattenuated = peak(render(reference, 4096));

    const settled = peak(out.subarray(-500));
    expect(settled / unattenuated).toBeCloseTo(10 ** (-24 / 20), 2);

    // Holding means holding: a sustaining operator must not keep fading.
    const later = peak(render(chip, Math.round(OPL2_RATE / 2)).subarray(-500));
    expect(later).toBeCloseTo(settled, 4);
  });

  it('falls to complete silence after key-off', () => {
    const chip = voice({ sustainRelease: 0x0a });
    keyOn(chip);
    render(chip, 4096);

    keyOff(chip);
    const tail = render(chip, Math.round(OPL2_RATE));

    expect(peak(tail.subarray(-1000))).toBe(0);
  });

  it('makes a note quieter as its total level rises', () => {
    const loudness = (totalLevel: number): number => {
      const chip = voice({ totalLevel });
      keyOn(chip);
      return peak(render(chip, 4096));
    };

    // Each step is 0.75 dB, so eight steps is 6 dB: half the amplitude.
    expect(loudness(8) / loudness(0)).toBeCloseTo(0.5, 2);
  });

  it('changes the timbre when the modulator is allowed through', () => {
    const chip = voice();
    chip.write(0xc0, 0x00); // frequency modulation rather than parallel
    chip.write(0x40, 0x00); // modulator at full volume
    chip.write(0x20, 0x21);
    chip.write(0x60, 0xf0);
    chip.write(0x80, 0x00);
    keyOn(chip);

    // A modulated sine is no longer a sine: it crosses zero far more often.
    const modulated = risingZeroCrossings(render(chip, 4096));

    const plain = voice();
    keyOn(plain);
    expect(modulated).toBeGreaterThan(risingZeroCrossings(render(plain, 4096)));
  });

  it('keeps its output inside full scale', () => {
    const chip = new Opl2();
    // Every channel at full volume in parallel, which is the loudest the chip
    // can be asked to be.
    for (let channel = 0; channel < 9; channel++) {
      chip.write(0xc0 + channel, 0x01);
      for (const slot of [0, 3]) {
        const register = [0, 1, 2, 8, 9, 10, 16, 17, 18][channel] + slot;
        chip.write(0x20 + register, 0x21);
        chip.write(0x40 + register, 0x00);
        chip.write(0x60 + register, 0xf0);
        chip.write(0x80 + register, 0x00);
      }
      chip.write(0xa0 + channel, 0x00);
      chip.write(0xb0 + channel, 0x20 | (4 << 2) | 2);
    }

    expect(peak(render(chip, 8192))).toBeLessThanOrEqual(1);
  });

  it('forgets everything on reset', () => {
    const chip = voice();
    keyOn(chip);
    render(chip, 1024);

    chip.reset();
    expect(peak(render(chip, 4096))).toBe(0);
    expect(chip.read(0x43)).toBe(0);
  });
});
