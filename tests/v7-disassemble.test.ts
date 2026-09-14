import { describe, expect, it } from 'vitest';
import {
  assembleV7,
  disassembleV6,
  disassembleV7,
  formatV6Listing,
} from '../src/authoring/disassembleV6.js';
import { buildV7Fixture, V7_SCRIPT } from './fixtureV7.js';
import { u16le } from './fixture.js';
import { iterateChunks, readChunkHeader } from '../src/engine/resource/Chunk.js';

/**
 * Reading v7 bytecode back.
 *
 * ADR 0005's property carries over unchanged: v7 is a stack machine, so every
 * instruction boundary is measurable and decode-then-re-emit gives back the
 * same bytes. What differs from v6 is only how an inline message is measured,
 * which is why this shares the walker rather than copying eleven hundred lines
 * whose every folding fix would then need finding twice.
 */
describe('a v7 listing', () => {
  it('folds the pushes into expressions rather than showing stack operations', () => {
    const listing = disassembleV7(new Uint8Array(V7_SCRIPT));
    const text = formatV6Listing(listing, new Uint8Array(V7_SCRIPT));

    // The point of folding: a script reads as arithmetic, not as six pushes.
    expect(text).toMatch(/var250 = 9/);
    expect(text).toMatch(/var250 \* 3/);
  });

  it('decodes the same bytes as v6 where the two encodings agree', () => {
    // v7 shares v6's opcode numbering entirely — ScummVM gives it no table of
    // its own — so a script using no messages must read identically.
    const code = new Uint8Array(V7_SCRIPT);
    expect(disassembleV7(code).instructions.map((i) => i.name)).toEqual(
      disassembleV6(code).instructions.map((i) => i.name),
    );
  });

  it('re-emits an untouched script byte for byte', () => {
    const code = new Uint8Array(V7_SCRIPT);
    const listing = disassembleV7(code);

    expect(listing.undecodedFrom).toBeNull();
    expect([...assembleV7(listing, code)]).toEqual([...code]);
  });

  it('stops rather than guessing when an instruction cannot be measured', () => {
    // ADR 0005's other half: a reader that guessed a length would re-emit an
    // edited script the engine then read as something else.
    const code = new Uint8Array([0x00, 0x07, 0xfe, 0x00]);
    const listing = disassembleV7(code);

    expect(listing.undecodedFrom).not.toBeNull();
    expect(listing.reason).toBeTruthy();
  });

  it('round-trips every script in the v7 fixture', () => {
    const fixture = buildV7Fixture();
    const lecf = readChunkHeader(fixture.data, 0)!;
    const lflf = [...iterateChunks(fixture.data, lecf.dataOffset, lecf.offset + lecf.size)].find(
      (chunk) => chunk.tag === 'LFLF',
    )!;

    const scripts = [
      ...iterateChunks(fixture.data, lflf.dataOffset, lflf.offset + lflf.size),
    ].filter((chunk) => chunk.tag === 'SCRP');
    expect(scripts.length).toBeGreaterThan(0);

    for (const script of scripts) {
      const code = fixture.data.subarray(script.dataOffset, script.dataOffset + script.dataSize);
      const listing = disassembleV7(code);
      expect(listing.undecodedFrom).toBeNull();
      expect([...assembleV7(listing, code)]).toEqual([...code]);
    }
  });

  it('carries an inline message through unchanged', () => {
    // A v7 string is a /TAG/ reference into a language bundle rather than the
    // words, and the reader's job is to measure it exactly, not to resolve it.
    const message = [...'/NEW.007/faint light'].map((c) => c.charCodeAt(0));
    const code = new Uint8Array([
      0x00,
      0x01, // pushByte 1  (the actor)
      0xb8, // talkActor
      ...message,
      0x00, // terminator
      0x66,
    ]);

    const listing = disassembleV7(code);
    expect([...assembleV7(listing, code)]).toEqual([...code]);
  });

  it('re-emits a changed instruction only where it was changed', () => {
    const code = new Uint8Array([0x00, 0x07, 0x43, ...u16le(250), 0x66]);
    const listing = disassembleV7(code);

    // Change the pushed constant from 7 to 9.
    listing.instructions[0].streamOperand = 9;
    const out = assembleV7(listing, code);

    expect(out[1]).toBe(9);
    expect([...out.subarray(2)]).toEqual([...code.subarray(2)]);
  });
});
