/**
 * The modulation envelopes an iMUSE AdLib instrument carries.
 *
 * ScummVM's `AdLibInstrument` is 30 bytes: the eleven register values, then
 * two *effect* definitions (`flagsA`/`extraA`, `flagsB`/`extraB`) and a note
 * `duration`. Each effect is a four-stage envelope that sweeps one parameter
 * of the playing voice — its pitch, a level, an attack rate, the other
 * envelope's depth — which is what makes the original's AdLib music breathe:
 * vibrato that fades in, a brass swell, a drum that stops itself.
 *
 * This is a port of the `Struct10`/`Struct11` machinery in
 * audio/adlib.cpp (`mcInitStuff`, `struct10Init`, `struct10Setup`,
 * `struct10OnTimer`, `mcIncStuff`), kept apart from the driver so its
 * arithmetic — sixteen-bit, eight-bit, and a table ScummVM itself indexes past
 * its end — can be read against the reference in one place.
 */

const i16 = (value: number) => (value << 16) >> 16;
const u16 = (value: number) => value & 0xffff;

/** The envelope's state (`Struct10`). */
export interface ModulationEnvelope {
  active: number;
  curVal: number;
  count: number;
  maxValue: number;
  startValue: number;
  loop: number;
  tableA: number[];
  tableB: number[];
  /** The depth the other envelope can modulate (`unk3`). */
  depth: number;
  modWheel: number;
  modWheelLast: number;
  speedLoMax: number;
  numSteps: number;
  speedHi: number;
  direction: number;
  speedLo: number;
  speedLoCounter: number;
}

/** What the envelope drives (`Struct11`). */
export interface ModulationTarget {
  modifyVal: number;
  param: number;
  followsModWheel: boolean;
  retriggers: boolean;
}

export const idleEnvelope = (): ModulationEnvelope => ({
  active: 0,
  curVal: 0,
  count: 0,
  maxValue: 0,
  startValue: 0,
  loop: 0,
  tableA: [0, 0, 0, 0],
  tableB: [0, 0, 0, 0],
  depth: 31,
  modWheel: 31,
  modWheelLast: 31,
  speedLoMax: 1,
  numSteps: 1,
  speedHi: 0,
  direction: 1,
  speedLo: 0,
  speedLoCounter: 0,
});

export const idleTarget = (): ModulationTarget => ({
  modifyVal: 0,
  param: 0,
  followsModWheel: false,
  retriggers: false,
});

/**
 * Which voice parameter each of the sixteen effect types drives
 * (`g_paramTable1`). 0-12 are carrier registers, 13-25 the modulator's, 26-27
 * the channel's, 28-29 pitch, 30-31 the other envelope's mod wheel and depth.
 */
export const EFFECT_PARAMS = [29, 28, 27, 0, 3, 4, 7, 8, 13, 16, 17, 20, 21, 30, 31, 0];

/** How far each effect type may sweep (`g_maxValTable`). */
const EFFECT_MAX = [
  0x2ff, 0x1f, 0x7, 0x3f, 0x0f, 0x0f, 0x0f, 0x3, 0x3f, 0x0f, 0x0f, 0x0f, 0x3, 0x3e, 0x1f, 0,
];

/** Steps per stage, indexed by a scaled rate (`g_numStepsTable`). */
const NUM_STEPS = [
  1, 2, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 21, 24, 30, 36, 50, 64, 82, 100, 136, 160, 192, 240,
  276, 340, 460, 600, 860, 1200, 1600,
];

/** `g_volumeLookupTable[a][b]`: `a * (b + 1) / 32`, with column 0 forced to 0. */
function volumeLookup(a: number, b: number): number {
  if (b <= 0) return 0;
  return (a * (b + 1)) >> 5;
}

/** `lookupVolume`: a signed scale of `a` by `b` in 32nds. */
export function lookupVolume(a: number, b: number): number {
  if (b === 0) return 0;
  if (b === 31) return a;
  if (a < -63 || a > 63) return (b * (a + 1)) >> 5;
  if (b < 0) return a < 0 ? volumeLookup(-a, -b) : -volumeLookup(a, -b);
  return a < 0 ? -volumeLookup(-a, b) : volumeLookup(a, b);
}

/** The original's shared eight-bit noise source (`randomNr`). */
export class ModulationRandom {
  private seed = 1;
  next(scale: number): number {
    if (this.seed & 1) this.seed = (this.seed >> 1) ^ 0xb8;
    else this.seed >>= 1;
    return (this.seed * scale) >> 8;
  }
}

/**
 * Starts an effect on a voice (`mcInitStuff` + `struct10Init`).
 *
 * `startValue` is what the parameter is now — a register's current value, or
 * the voice's level — since the envelope sweeps *around* it.
 */
export function startModulation(
  env: ModulationEnvelope,
  target: ModulationTarget,
  other: ModulationEnvelope,
  flags: number,
  extra: readonly number[],
  startValue: (param: number) => number,
  modWheel: number,
  random: ModulationRandom,
): void {
  target.modifyVal = 0;
  target.followsModWheel = (flags & 0x40) !== 0;
  env.loop = flags & 0x20;
  target.retriggers = (flags & 0x10) !== 0;
  target.param = EFFECT_PARAMS[flags & 0x0f];
  env.maxValue = EFFECT_MAX[flags & 0x0f];
  env.depth = 31;
  env.modWheel = target.followsModWheel ? modWheel >> 2 : 31;

  switch (target.param) {
    case 30:
      env.startValue = 31;
      other.modWheel = 0;
      break;
    case 31:
      env.startValue = 0;
      other.depth = 0;
      break;
    default:
      env.startValue = startValue(target.param);
  }

  env.active = 1;
  env.curVal = 0;
  env.modWheelLast = 31;
  env.count = i16((extra[0] ?? 0) * 63);
  env.tableA = [extra[1] ?? 0, extra[3] ?? 0, extra[5] ?? 0, extra[6] ?? 0];
  env.tableB = [extra[2] ?? 0, extra[4] ?? 0, 0, extra[7] ?? 0];
  setupStage(env, random);
}

/** `struct10Setup`: the rate and extent of the envelope's current stage. */
function setupStage(env: ModulationEnvelope, random: ModulationRandom): void {
  const stage = env.active - 1;
  const rate = env.tableA[stage];
  let steps = NUM_STEPS[Math.min(NUM_STEPS.length - 1, volumeLookup(rate & 0x7f, env.depth))];
  if (rate & 0x80) steps = random.next(steps);
  if (steps === 0) steps++;
  env.numSteps = env.speedLoMax = steps;

  let change = 0;
  if (stage !== 2) {
    const max = env.maxValue;
    const start = env.startValue;
    const level = env.tableB[stage];
    let wanted = lookupVolume(max, (level & 0x7f) - 31);
    if (level & 0x80) wanted = random.next(wanted);
    if (wanted + start > max) change = max - start;
    else change = wanted + start < 0 ? -start : wanted;
    change -= env.curVal;
  }

  env.speedHi = i16(Math.trunc(change / steps));
  if (change < 0) {
    change = -change;
    env.direction = -1;
  } else {
    env.direction = 1;
  }
  env.speedLo = u16(change % steps);
  env.speedLoCounter = 0;
}

/**
 * One step of an envelope (`struct10OnTimer`).
 *
 * Returns bit 1 when the driven value changed — so the parameter must be
 * rewritten — and bit 2 when a looping envelope wrapped, which retriggers the
 * note if the effect asks for it.
 */
export function stepModulation(
  env: ModulationEnvelope,
  target: ModulationTarget,
  random: ModulationRandom,
): number {
  let result = 0;
  if (env.count && (env.count = i16(env.count - 17)) <= 0) {
    env.active = 0;
    return 0;
  }

  let value = env.curVal + env.speedHi;
  env.speedLoCounter = u16(env.speedLoCounter + env.speedLo);
  if (env.speedLoCounter >= env.speedLoMax) {
    env.speedLoCounter = u16(env.speedLoCounter - env.speedLoMax);
    value += env.direction;
  }
  if (env.curVal !== value || env.modWheel !== env.modWheelLast) {
    env.curVal = i16(value);
    env.modWheelLast = env.modWheel;
    const scaled = lookupVolume(env.curVal, env.modWheelLast);
    if (scaled !== target.modifyVal) {
      target.modifyVal = i16(scaled);
      result = 1;
    }
  }

  env.numSteps = u16(env.numSteps - 1);
  if (!env.numSteps) {
    env.active++;
    if (env.active > 4) {
      if (env.loop) {
        env.active = 1;
        result |= 2;
        setupStage(env, random);
      } else {
        env.active = 0;
      }
    } else {
      setupStage(env, random);
    }
  }
  return result;
}

/**
 * How a generic effect parameter maps onto a register (`g_setParamTable`):
 * the register base, the field's shift and mask, and whether it is stored
 * inverted. Indexed by parameter after the operator offset is removed.
 */
export const EFFECT_REGISTERS: readonly {
  base: number;
  shift: number;
  mask: number;
  inversion: number;
}[] = [
  { base: 0x40, shift: 0, mask: 63, inversion: 63 },
  { base: 0xe0, shift: 2, mask: 0, inversion: 0 },
  { base: 0x40, shift: 6, mask: 192, inversion: 0 },
  { base: 0x20, shift: 0, mask: 15, inversion: 0 },
  { base: 0x60, shift: 4, mask: 240, inversion: 15 },
  { base: 0x60, shift: 0, mask: 15, inversion: 15 },
  { base: 0x80, shift: 4, mask: 240, inversion: 15 },
  { base: 0x80, shift: 0, mask: 15, inversion: 15 },
  { base: 0xe0, shift: 0, mask: 3, inversion: 0 },
  { base: 0x20, shift: 7, mask: 128, inversion: 0 },
  { base: 0x20, shift: 6, mask: 64, inversion: 0 },
  { base: 0x20, shift: 5, mask: 32, inversion: 0 },
  { base: 0x20, shift: 4, mask: 16, inversion: 0 },
  { base: 0xc0, shift: 0, mask: 1, inversion: 0 },
  { base: 0xc0, shift: 1, mask: 14, inversion: 0 },
];
