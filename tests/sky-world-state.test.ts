import { describe, expect, it } from 'vitest';
import { parseSkyCompacts } from '../src/engine/sky/resource/skyCompacts.js';
import {
  parseSkyWorldState,
  writeSkyWorldState,
  skyWorldStateBytes,
  describeSkyStateRefusal,
  SkyWorldStateError,
  SKY_SCRIPT_VARIABLES,
  SKY_RELOAD_SLOTS,
  SKY_STATE_REVISION,
} from '../src/engine/sky/save/skyWorldState.js';
import { buildSkyCompactFixture } from './fixtureSkyCompacts.js';

/** A state image, built from the layout rather than from what the reader wants. */
function buildState(options: {
  compactSizes: readonly number[];
  build?: number;
  revision?: number;
  declaredBytes?: number;
  fill?: number;
}): Uint8Array {
  const compactWords = options.compactSizes.reduce((total, size) => total + size, 0);
  const length =
    3 * 4 + 2 * 2 + 4 * 4 + SKY_SCRIPT_VARIABLES * 4 + SKY_RELOAD_SLOTS * 4 + compactWords * 2;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const u32 = (value: number): void => {
    view.setUint32(at, value >>> 0, true);
    at += 4;
  };
  const u16 = (value: number): void => {
    view.setUint16(at, value & 0xffff, true);
    at += 2;
  };

  u32(options.declaredBytes ?? length);
  u32(options.revision ?? SKY_STATE_REVISION);
  u32(options.build ?? 372);
  u16(0xffff);
  u16(0xffff);
  u32(2); // music
  u32(0); // character set
  u32(6); // cursor
  u32(4316); // palette
  for (let i = 0; i < SKY_SCRIPT_VARIABLES; i += 1) u32(i);
  for (let i = 0; i < SKY_RELOAD_SLOTS; i += 1) u32(1000 + i);
  for (let i = 0; i < compactWords; i += 1) u16((options.fill ?? 0x100) + i);
  return bytes;
}

const compacts = parseSkyCompacts(buildSkyCompactFixture());
const sizes = compacts.saveIds.map(
  (id) => compacts.records.find((record) => record.id === id)!.words.length,
);

describe('the Sky world state', () => {
  it('works out its own length from the Compact table, not from the file', () => {
    const fixed = 3 * 4 + 2 * 2 + 4 * 4 + SKY_SCRIPT_VARIABLES * 4 + SKY_RELOAD_SLOTS * 4;
    expect(skyWorldStateBytes(compacts)).toBe(
      fixed + sizes.reduce((total, size) => total + size, 0) * 2,
    );
  });

  it('reads every field, and round-trips byte-identically', () => {
    const bytes = buildState({ compactSizes: sizes });
    const state = parseSkyWorldState(bytes, compacts);

    expect(state.build).toBe(372);
    expect(state.revision).toBe(SKY_STATE_REVISION);
    expect(state.music).toBe(2);
    expect(state.cursor).toBe(6);
    expect(state.palette).toBe(4316);
    expect(state.variables).toHaveLength(SKY_SCRIPT_VARIABLES);
    expect(state.variables[100]).toBe(100);
    expect(state.reload[0]).toBe(1000);
    expect(state.compactWords).toHaveLength(compacts.saveIds.length);

    expect(writeSkyWorldState(state, compacts)).toEqual(bytes);
  });

  it('refuses a state of the wrong length rather than applying part of it', () => {
    // The rule that matters most here: this structure *is* the world, so a
    // state read half way is objects from two different games.
    const bytes = buildState({ compactSizes: sizes });
    expect(() => parseSkyWorldState(bytes.subarray(0, bytes.length - 2), compacts)).toThrow(
      SkyWorldStateError,
    );
    expect(() => parseSkyWorldState(bytes.subarray(0, bytes.length - 2), compacts)).toThrow(
      /must agree exactly/,
    );
  });

  it('refuses a state whose own size field disagrees with its length', () => {
    const bytes = buildState({ compactSizes: sizes, declaredBytes: 99 });
    expect(() => parseSkyWorldState(bytes, compacts)).toThrow(/says its own size/);
  });

  it('writes each position of the save list separately', () => {
    // The shipped table names one Compact twice in its 854 save ids. A writer
    // keyed by id writes the second copy for both, which happens to be right
    // for the shipped states and is a coincidence rather than a property.
    const state = parseSkyWorldState(buildState({ compactSizes: sizes }), compacts);
    const short = { ...state, compactWords: state.compactWords.slice(0, 1) };
    expect(() => writeSkyWorldState(short, compacts)).toThrow(/position/);
  });

  it('refuses a save from another build, and accepts one from a sibling CD build', () => {
    const floppy = parseSkyWorldState(buildState({ compactSizes: sizes, build: 348 }), compacts);
    expect(describeSkyStateRefusal(floppy, 348)).toBeNull();
    expect(describeSkyStateRefusal(floppy, 372)).toMatch(/would keep playing and be wrong/);

    // The three CD builds share a layout, which is why the shipped starting
    // states for 365, 368 and 372 all declare 368.
    const cd = parseSkyWorldState(buildState({ compactSizes: sizes, build: 368 }), compacts);
    expect(describeSkyStateRefusal(cd, 372)).toBeNull();
  });

  it('refuses a revision it does not know', () => {
    const future = parseSkyWorldState(
      buildState({ compactSizes: sizes, revision: SKY_STATE_REVISION + 1 }),
      compacts,
    );
    expect(describeSkyStateRefusal(future, 372)).toMatch(/written by something newer/);
  });
});
