/**
 * The tables the YM3812 works from.
 *
 * The chip does its arithmetic in the logarithmic domain: every operator turns
 * a phase into an attenuation, attenuations are *added* rather than multiplied,
 * and the sum is converted back to a linear amplitude once at the end. That is
 * why a table of logarithms of a sine and a table of powers of two are enough
 * to build the whole synthesiser, and why volume, envelope and key scaling can
 * all be applied as simple additions.
 *
 * Everything here is derived from the arithmetic rather than transcribed from
 * a dump, so the numbers can be checked by reading them.
 */

/**
 * Attenuation, as -log2(sin(x)) in units of 1/256 of a power of two, for the
 * first quarter of a sine.
 *
 * A quarter is all that is stored: the second quarter is the first reversed,
 * and the lower half is the upper half with the sign flipped. 256 entries per
 * quarter therefore give 1024 phase steps in a full cycle.
 */
export const LOG_SINE = new Uint16Array(256);

/**
 * 2^(x/256) - 1, scaled by 1024, for x in [0, 256).
 *
 * The inverse of the table above: it turns a total attenuation back into an
 * amplitude. Only the fractional part of the exponent is looked up here — the
 * whole part is applied by shifting — which is how the chip covers its entire
 * dynamic range from 256 entries.
 *
 * The stored value is 2^(x/256) *minus one* so that it fits in ten bits; the
 * implied leading one is put back with an OR. That also means the table is
 * indexed by the complement of the attenuation's low byte: attenuating by more
 * means reading further down a table that counts upwards.
 */
export const EXP = new Uint16Array(256);

for (let i = 0; i < 256; i++) {
  // The sine is sampled at the centre of each step, which is what keeps the
  // quarter-wave reflection continuous across the join.
  const angle = ((i + 0.5) * Math.PI) / 512;
  LOG_SINE[i] = Math.round(-Math.log2(Math.sin(angle)) * 256);
  EXP[i] = Math.round((Math.pow(2, i / 256) - 1) * 1024);
}

/** Phase steps in a full cycle. */
export const PHASE_BITS = 10;
export const PHASE_LENGTH = 1 << PHASE_BITS;

/**
 * The largest attenuation worth computing, in the same 1/256 units.
 *
 * Beyond this the amplitude rounds to zero anyway, so clamping here keeps the
 * exponent shift inside its useful range instead of running off the end.
 */
export const SILENCE = 0x1fff;

/**
 * How much quieter a note gets as it rises in pitch, per octave block.
 *
 * Real instruments lose volume as they go up, and the chip models it with four
 * settings: off, 3 dB, 1.5 dB and 6 dB per octave. The table is indexed by the
 * fraction of an octave (the top four bits of the F-number) and gives the
 * attenuation in 1/8 dB, which the operator then scales by the setting.
 */
export const KEY_SCALE_LEVEL = [0, 32, 40, 45, 48, 50, 51, 52, 53, 54, 55, 56, 56, 57, 57, 58];

/** The shift applied to `KEY_SCALE_LEVEL` for each of the four KSL settings. */
export const KEY_SCALE_SHIFT = [8, 1, 2, 0];

/**
 * The multiplier applied to an operator's frequency, indexed by its MULT
 * setting, doubled.
 *
 * Doubled because the first two entries are a half and a one: storing twice
 * the value keeps the table integral, and the caller shifts back down.
 */
export const FREQUENCY_MULTIPLE = [1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 20, 24, 24, 30, 30];

/**
 * Which of the 18 operator register slots belongs to which of the 9 channels.
 *
 * The chip's registers are not laid out one channel after another: operators
 * sit in three groups of six, so channel n's two operators are at these
 * offsets rather than at 2n and 2n+1. Getting this wrong is the classic OPL
 * bug, where notes play on the wrong voice with the wrong instrument.
 */
export const OPERATOR_SLOT = [0, 1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 16, 17, 18, 19, 20, 21];

/** Register offset -> operator index, or -1 where the register is unused. */
export const SLOT_TO_OPERATOR = (() => {
  const table = new Int8Array(32).fill(-1);
  for (const [operator, slot] of OPERATOR_SLOT.entries()) table[slot] = operator;
  return table;
})();

/** The two operators belonging to each of the nine channels. */
export const CHANNEL_OPERATORS: ReadonlyArray<readonly [number, number]> = [
  [0, 3],
  [1, 4],
  [2, 5],
  [6, 9],
  [7, 10],
  [8, 11],
  [12, 15],
  [13, 16],
  [14, 17],
];
