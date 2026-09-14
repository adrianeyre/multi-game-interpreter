import { describe, expect, it } from 'vitest';
import {
  parseLureWorldState,
  writeLureWorldState,
  describeLureWorldState,
  LureWorldStateError,
  LURE_SAVE_SLOT_BYTES,
  LURE_WORLD_STATE_ID,
} from '../src/engine/lure/resource/lureWorldState.js';

/**
 * A snapshot the reader will accept: exactly the save-slot length, with a few
 * non-zero bytes so a round-trip has something to preserve. The length is the
 * format knowledge under test — it is the executable's own slot size (#264), so
 * a resource of any other length is not this one.
 */
function snapshot(fill = 0): Uint8Array {
  const bytes = new Uint8Array(LURE_SAVE_SLOT_BYTES).fill(fill);
  bytes[0] = 0x12;
  bytes[LURE_SAVE_SLOT_BYTES - 1] = 0x34;
  return bytes;
}

describe('Lure world state (ADR 0024 third amendment)', () => {
  it('reads a resource of exactly the save-slot length', () => {
    const state = parseLureWorldState(snapshot());
    expect(state.bytes.length).toBe(LURE_SAVE_SLOT_BYTES);
    expect(LURE_SAVE_SLOT_BYTES).toBe(37504);
  });

  it('refuses any other length, because the length is what identifies it', () => {
    // The length is the tie to the new-game path: the executable restores a slot
    // of this size, so a resource of another size is not the world state.
    expect(() => parseLureWorldState(new Uint8Array(37503))).toThrow(LureWorldStateError);
    expect(() => parseLureWorldState(new Uint8Array(0))).toThrow(/is not resource/);
    expect(() => parseLureWorldState(new Uint8Array(37505))).toThrow(
      new RegExp(`${LURE_SAVE_SLOT_BYTES} bytes`),
    );
  });

  it('re-emits byte-identically, because it is Preserved bytes', () => {
    const bytes = snapshot(0x7f);
    const rewritten = writeLureWorldState(parseLureWorldState(bytes));
    expect(rewritten.length).toBe(bytes.length);
    expect([...rewritten]).toEqual([...bytes]);
  });

  it('does not alias its input, so a later edit cannot reach through it', () => {
    const bytes = snapshot();
    const state = parseLureWorldState(bytes);
    bytes[0] = 0xff;
    // The parsed state kept the value it read, not the caller's later mutation.
    expect(state.bytes[0]).toBe(0x12);
  });

  it('describes itself as the resource it is, and as Preserved bytes', () => {
    const note = describeLureWorldState(parseLureWorldState(snapshot()));
    expect(note).toContain(String(LURE_WORLD_STATE_ID));
    expect(note).toContain('Preserved bytes');
    // It must not claim to have typed the object table.
    expect(note).toMatch(/not typed/);
  });
});
