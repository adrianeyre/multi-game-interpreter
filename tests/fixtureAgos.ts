/**
 * Synthetic AGOS bytecode, built byte by byte.
 *
 * Real game data is copyrighted and never lives in this repository
 * (`docs/processes/verifying-version-support.md`), so the fixture stands in for
 * it — with the trap that process names kept in mind: *a fixture encodes our
 * reading of the format*. Every layout here is written from ScummVM's
 * `engines/agos/subroutine.cpp` rather than from what our reader happens to
 * expect, so that the two can disagree.
 */

import { hasWideOpcodes, opcodeTableFor, type AgosTarget } from '../src/engine/agos/agosVersion.js';
import { OPCODE_ARG_TABLES } from '../src/engine/agos/script/opcodeArgTables.js';

/** A big-endian byte builder, because AGOS files are big-endian throughout. */
export class AgosBytes {
  private readonly bytes: number[] = [];

  byte(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  word(value: number): this {
    return this.byte(value >> 8).byte(value);
  }

  long(value: number): this {
    return this.word(Math.floor(value / 0x10000)).word(value & 0xffff);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/**
 * A Simon-shaped Subroutine block: a verb table plus one called Subroutine.
 *
 * `withSpeech` writes the talkie form of opcode 67, whose argument string is
 * `BTS` where the floppy release's is `BT`. Opcode 162 differs the same way,
 * and those two are the whole of the disagreement. That one operand is the whole reason
 * ADR 0027's tripwire fired: two releases of one game disagreeing about an
 * instruction's length is what says a title is not a Version on its own.
 */
export function buildSimonSubroutineBlock(options: { withSpeech: boolean }): Uint8Array {
  const out = new AgosBytes();

  // Subroutine 0 — the verb table. Its lines carry a verb and two nouns.
  out.word(0).word(0);
  out.word(0); // a line follows
  out.word(101).word(202).word(303); // verb, noun1, noun2
  out.byte(1).word(0x0002).long(0x0000_002a); // opcode 1 "I ": an item id
  out.byte(0xff); // end of line
  out.word(0xffff); // end of Subroutine 0

  // Subroutine 42 — called by number, so no guard.
  out.word(0).word(42);
  out.word(0); // a line follows
  out.byte(11).byte(0x07); // opcode 11 "B ": a plain byte
  out.byte(12).byte(0xff).byte(0x03); // opcode 12 "B ": 0xFF, then a variable
  out.byte(67).byte(0x05).word(0x0001).long(0x0000_0100); // opcode 67: B, then T
  if (options.withSpeech) out.word(0x1234); // the talkie's extra S operand
  out.byte(0xff);
  out.word(0xffff);

  out.word(0xffff); // end of the block
  return out.finish();
}

/** An Elvira 1 block, which reads 16-bit opcodes and terminates lines on 10000. */
export function buildElviraSubroutineBlock(): Uint8Array {
  const out = new AgosBytes();
  out.word(0).word(7);
  out.word(0); // a line follows
  out.word(0).word(0).word(0); // Elvira 1 writes three words it then ignores
  out.word(12).word(0x0007); // opcode 12 "F ": a word
  out.word(10_000); // end of line
  out.word(0xffff);
  out.word(0xffff);
  return out.finish();
}

/**
 * A whole `GAMEPC`: header, string pool, two items and a Subroutine block.
 *
 * Small, and complete in the sense that matters — ADR 0030 rebuilds this file
 * whole rather than patching it, so a fixture that leaves a region out would
 * not exercise the property the exporter depends on.
 */
export function buildGamePc(options: { withSpeech: boolean }): Uint8Array {
  const out = new AgosBytes();

  // Header: item array size, the version word, items initialised, strings.
  out.long(2).long(0x80).long(2).long(3);

  // The string pool, NUL-separated. Many Subroutines index one table (ADR 0009's
  // shape), which is why it lives here rather than beside the code that shows it.
  const text = 'one\0two\0three\0';
  out.long(text.length);
  for (const character of text) out.byte(character.charCodeAt(0));

  // Item 2 — a room. Its sub-structure is sized by counting two-bit fields in
  // the exit mask, so the mask has to survive into the model to be written back.
  out.word(11).word(12).word(0); // adjective, noun, state
  out.long(0xffffffff).long(0x00000001).long(0xffffffff); // next, child, parent
  out.word(0).word(0x0007); // the trailing word, then classFlags
  out.long(1); // sub-structures follow
  out.word(1); // a room
  out.word(42).word(0x0001); // subroutine id, exit mask: one exit set
  out.long(0x00000001); // that exit's destination
  out.word(0); // no more sub-structures

  // Item 3 — an object, sized by counting set bits in its flag mask.
  out.word(21).word(22).word(1);
  out.long(0xffffffff).long(0xffffffff).long(0x00000000);
  out.word(0).word(0x0003);
  out.long(1);
  out.word(2); // an object
  out.long(0x0002); // flags: bit 1 only, so one 16-bit value follows
  out.word(0x1234);
  out.long(0x0000005a); // the object's name id
  out.word(0);

  const block = buildSimonSubroutineBlock(options);
  for (const byte of block) out.byte(byte);
  return out.finish();
}

/**
 * An archive index, little-endian as the format is — and unlike `GAMEPC`.
 *
 * The first word is the table's own size in bytes, which is also the first
 * resource's offset: the format reuses it rather than spending four more bytes.
 */
export function buildArchive(): Uint8Array {
  const table = [12, 12, 20]; // table size, then two offsets
  const bytes: number[] = [];
  for (const value of table) {
    bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  }
  while (bytes.length < 12) bytes.push(0);
  for (let index = 0; index < 8; index += 1) bytes.push(0xa0 + index); // resource 1
  for (let index = 0; index < 4; index += 1) bytes.push(0xb0 + index); // resource 2
  return Uint8Array.from(bytes);
}

/**
 * A graphics archive holding one zone: its scripts and its pixels.
 *
 * Zone numbering is arithmetic rather than a lookup — entry `zone * 2` holds
 * the scripts and `zone * 2 + 1` holds the pixels — so zone 0 is entries 0 and
 * 1. The script resource is a table of image entries pointing at VGA scripts,
 * which is the shape ADR 0027's amendment is about: a graphics resource is not
 * a bitmap.
 */
export function buildGraphicsArchive(): Uint8Array {
  // Scripts: a nine-word header, one image entry, then the script it points at.
  const scripts = new AgosBytes();
  scripts.word(0).word(1).word(0).word(0).word(0).word(18).word(0).word(0).word(0);
  scripts.word(1).word(0).word(0).word(26); // image 1, script at offset 26
  // Simon 1 reads 16-bit VGA opcodes — the opposite of its game bytecode.
  scripts.word(10).word(1).word(0).word(1).word(1).word(0); // DRAW image 1 at (1,1)
  scripts.word(0); // RET
  const scriptBytes = scripts.finish();

  // Pixels: an eight-byte entry per image, width stored in pixels.
  const pixels = new AgosBytes();
  pixels.long(0).long(0); // entry 0 is never an image
  pixels.long(16); // entry 1: pixels start at offset 16
  pixels
    .byte(0)
    .byte(2)
    .word(2 * 2); // flags, height 2, width 4 pixels in 2 bytes
  pixels.byte(0x12).byte(0x34).byte(0x56).byte(0x78);
  const pixelBytes = pixels.finish();

  // The index: two entries, and the first is the table's own size doubling as
  // the first resource's offset — the format reusing a word rather than
  // spending four more bytes on one that would always agree with it.
  const tableBytes = 8;
  const out: number[] = [];
  const put = (value: number): void => {
    out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
  };
  put(tableBytes);
  put(tableBytes + scriptBytes.length);
  for (const byte of scriptBytes) out.push(byte);
  for (const byte of pixelBytes) out.push(byte);
  return Uint8Array.from(out);
}

/**
 * A `GAMEPC` for any Version, built from that Version's own tables.
 *
 * Seven Versions differ in three ways this has to respect: whether an item
 * record carries a 32-bit name and an extra padding word (Elvira 1 and 2),
 * whether the header's initialised count is the array size (the same two), and
 * whether opcodes are 16 bits wide (Elvira 1 alone).
 *
 * The instruction it writes is **looked up in the Version's argument table**
 * rather than hardcoded — an opcode that takes no operands, whichever number
 * that is. A fixture that hardcoded an opcode number would be testing one
 * Version's table against six others', which is the trap
 * `docs/processes/verifying-version-support.md` names: a fixture that encodes
 * our reading rather than the format's.
 */
export function buildGamePcFor(
  target: AgosTarget,
  options: {
    /**
     * The instructions the fixture's one Subroutine holds, instead of the
     * operand-free default.
     *
     * For a test that needs a game to *do* something on boot. The caller writes
     * the bytes, because an opcode's operands are the Version's business and a
     * helper that guessed them would be the fixture encoding our reading twice.
     */
    readonly body?: (out: AgosBytes) => void;
    /**
     * Which Subroutine number the fixture's one Subroutine is.
     *
     * **101 by default, because that is the one an AGOS boot calls.** It used
     * to be 1, which is the *heartbeat* — queued on a timer rather than called
     * — so a fixture numbered 1 modelled a game whose opening never runs.
     */
    readonly id?: number;
    /** The string pool, NUL-separated and NUL-terminated. */
    readonly text?: string;
    /**
     * Verbs to give the verb table a guarded line for, ahead of the Subroutine.
     *
     * For a test about what a *player* can do, because the bar refuses a verb
     * no guard could match — so a fixture with no verb table models a game in
     * which every click is legitimately declined, and a default verb installed
     * into it would be refused for the right reason and look like a bug.
     *
     * Each verb gets one line whose two nouns are the wildcard, which is the
     * shape of a line that answers for anything.
     */
    readonly verbs?: readonly number[];
  } = {},
): Uint8Array {
  const wide = hasWideOpcodes(target.version);
  const early = target.version === 'Elvira1' || target.version === 'Elvira2';
  const table = OPCODE_ARG_TABLES[opcodeTableFor(target)];

  // An opcode this Version has that takes nothing, so the fixture needs no
  // knowledge of any operand encoding.
  const bare = table.findIndex((entry, index) => entry === ' ' && index !== 0);
  if (bare < 0) throw new Error(`no operand-free opcode in ${opcodeTableFor(target)}`);

  const out = new AgosBytes();
  const text = options.text ?? 'lamp\0brass\0';
  const stringCount = text.split('\0').length - 1;
  // Elvira 1 and 2 take the initialised count from the array size; the rest
  // carry it separately. Both add two for the predefined pair.
  out.long(1).long(0x80).long(1).long(stringCount);

  out.long(text.length);
  for (const character of text) out.byte(character.charCodeAt(0));

  // One item, in this Version's layout.
  if (early) out.long(0x0000_0001); // the 32-bit name Elvira 1 and 2 carry
  out.word(1).word(0).word(0); // adjective, noun, state
  if (wide) out.word(0); // Elvira 1's word between state and next
  out.long(0xffffffff).long(0xffffffff).long(0xffffffff); // next, child, parent
  if (wide) out.word(0).word(0).word(0);
  else out.word(0);
  out.word(0); // classFlags
  out.long(0); // no sub-structures

  // The verb table, when a caller asked for one. Subroutine 0, whose lines
  // carry a guard where every other Subroutine's do not — which is the whole
  // difference between a line a click can reach and a line called by number.
  if (options.verbs?.length) {
    if (wide) throw new Error('the verb-table fixture is written for the byte-opcode Versions');
    out.word(0).word(0);
    for (const verb of options.verbs) {
      out.word(0); // a line follows
      // Both nouns wildcard, which is `GUARD_ANY` — `0xFFFF` as stored, and the
      // sentinel a guard for "anything" is actually written with.
      out.word(verb).word(0xffff).word(0xffff);
      out.byte(bare);
      out.byte(0xff); // end of line
    }
    out.word(0xffff); // end of Subroutine 0
  }

  // One Subroutine holding one operand-free instruction, or whatever the caller
  // asked for instead.
  out.word(0).word(options.id ?? 101);
  out.word(0);
  if (options.body) {
    if (wide) out.word(0).word(0).word(0);
    options.body(out);
    if (wide) out.word(10_000);
    else out.byte(0xff);
    out.word(0xffff);
    out.word(0xffff);
    return out.finish();
  }
  if (wide) {
    // Elvira 1 writes three words at the head of every line of a Subroutine
    // that is not the verb table, and then ignores them. Leaving them out here
    // would make the fixture disagree with the format rather than with us.
    out.word(0).word(0).word(0);
    out.word(bare);
    out.word(10_000);
  } else {
    out.byte(bare);
    out.byte(0xff);
  }
  out.word(0xffff);
  out.word(0xffff);
  return out.finish();
}
