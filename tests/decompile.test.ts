import { describe, expect, it } from 'vitest';
import { Assembler } from '../src/authoring/Assembler.js';
import { emitActions } from '../src/authoring/actions.js';
import {
  assembleClassic,
  disassembleClassic,
  formatClassicListing,
} from '../src/authoring/disassembleClassic.js';
import { decompileScript } from '../src/authoring/decompile.js';
import { fromBase64 } from '../src/authoring/base64.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { importGame } from '../src/authoring/importGame.js';
import { buildFixture } from './fixture.js';

describe('reading v5 bytecode', () => {
  const disassemble = (code: Uint8Array) => disassembleClassic(code, 5);

  it('reads instructions whose layout it knows', () => {
    // startSound 3, then stopObjectCode.
    const listing = disassemble(new Uint8Array([0x1c, 0x03, 0x00]));

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions[0].text).toBe('startSound 3');
    expect(listing.instructions[0].length).toBe(2);
  });

  it('reads a variable operand as a variable, not as a number', () => {
    // The parameter bit says operand one is a variable rather than a literal.
    const listing = disassemble(new Uint8Array([0x1c | 0x80, 0x05, 0x00, 0x00]));

    expect(listing.instructions[0].text).toBe('startSound Var[5]');
    expect(listing.instructions[0].length).toBe(3);
  });

  it('measures the argument list it used to stop at', () => {
    // `startScript` carries a 0xFF-terminated argument list. Its length is not
    // *derivable* from the encoding, which is what the reader that stopped here
    // was right about — and it is measurable, which is what it was wrong about.
    const listing = disassemble(new Uint8Array([0x1c, 0x03, 0x0a, 0x09, 0xff, 0x00]));

    expect(listing.undecodedFrom).toBeNull();
    expect(listing.instructions.map((instruction) => instruction.name)).toEqual([
      'startSound',
      'startScript',
      'stopObjectCode',
    ]);
    expect(listing.instructions[1].length).toBe(3);
  });

  it('measures an inline message rather than reading its letters as opcodes', () => {
    // setObjectName: an object, then a NUL-terminated message. Reading the
    // message short is how a string's own letters end up being executed.
    const code = new Uint8Array([0x54, 0x0a, 0x00, 0x48, 0x69, 0x00, 0x00]);
    const listing = disassemble(code);

    expect(listing.instructions[0].name).toBe('setObjectName');
    expect(listing.instructions[0].length).toBe(6);
    expect(listing.instructions[1].name).toBe('stopObjectCode');
  });

  it('does not run off the end of a truncated script', () => {
    // The last instruction claims an operand that is not there.
    const listing = disassemble(new Uint8Array([0x1c]));

    expect(listing.instructions).toHaveLength(0);
    expect(listing.undecodedFrom).toBe(0);
  });

  it('stops at an opcode this Version has no instruction for', () => {
    // 0x4c is v5's `soundKludge`, and v4 does not have it at all — ScummVM
    // clears the slot rather than leaving v5's inherited. A v4 table with the
    // instruction still in it would read a whole argument list that is not
    // there.
    const listing = disassembleClassic(new Uint8Array([0x1c, 0x03, 0x4c, 0x00]), 4);

    expect(listing.instructions).toHaveLength(1);
    expect(listing.undecodedFrom).toBe(2);
    expect(listing.reason).toMatch(/no instruction for/);
  });

  it('shows the bytes it could not read, so nothing is hidden', () => {
    const code = new Uint8Array([0x1c, 0x03, 0x4c]);
    const text = formatClassicListing(disassembleClassic(code, 4), code);

    expect(text).toMatch(/startSound 3/);
    expect(text).toMatch(/kept exactly as they were/);
    expect(text).toMatch(/4c/);
  });

  it('re-emits an untouched script byte for byte', () => {
    const code = new Uint8Array([
      0x1c, 0x03, 0x0a, 0x09, 0xff, 0x54, 0x0a, 0x00, 0x48, 0x69, 0x00, 0x00,
    ]);
    const rebuilt = assembleClassic(disassemble(code), code);

    expect(Array.from(rebuilt)).toEqual(Array.from(code));
  });

  it('writes an edited operand back without moving anything around it', () => {
    const code = new Uint8Array([0x1c, 0x03, 0x1c, 0x04, 0x00]);
    const listing = disassemble(code);
    listing.instructions[0].fields[0].value = 9;
    const rebuilt = assembleClassic(listing, code);

    expect(Array.from(rebuilt)).toEqual([0x1c, 0x09, 0x1c, 0x04, 0x00]);
  });
});

describe('bringing a script into a project', () => {
  const script = new Uint8Array([0x1c, 0x03, 0x0a, 0x09, 0xff, 0x00]);

  it('keeps the script as one block of preserved bytes', () => {
    // Still one Action, and deliberately: ADR 0005 chose an instruction table
    // over decompiling into project Actions, so what an author edits is a
    // reading of the bytes rather than a translation of them.
    const { actions } = decompileScript(script);

    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe('raw');
  });

  it('preserves every byte exactly', () => {
    const { actions } = decompileScript(script);
    const raw = actions[0] as { type: 'raw'; bytes: string };

    expect(Array.from(fromBase64(raw.bytes))).toEqual(Array.from(script));
  });

  it('compiles back to the bytes it came from', () => {
    // The property the whole design rests on: whatever the reader understood,
    // the game still runs exactly as it did.
    const assembler = new Assembler();
    emitActions(assembler, decompileScript(script).actions);

    expect(Array.from(assembler.build())).toEqual(Array.from(script));
  });

  it('says how much it managed to read', () => {
    const whole = decompileScript(script);
    expect(whole.readable).toBe(3);
    expect(whole.partial).toBe(false);

    // A v4 table has no entry for v5's 0x4c, so this one does stop.
    const partial = decompileScript(new Uint8Array([0x1c, 0x03, 0x4c, 0x00]), undefined, 4);
    expect(partial.partial).toBe(true);
  });

  it('produces nothing at all for an empty script', () => {
    expect(decompileScript(new Uint8Array()).actions).toEqual([]);
  });
});

describe('importing a game brings its behaviour with it', () => {
  async function imported() {
    const fixture = buildFixture();
    const source = new MemoryDataSource('fixture');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    return importGame(await ResourceManager.load(source, await detectGame(source)));
  }

  it('brings a room entry script across instead of dropping it', async () => {
    const { project } = await imported();
    const withEntry = project.rooms.filter((room) => room.onEnter.length > 0);

    expect(withEntry.length).toBeGreaterThan(0);
    expect(withEntry[0].onEnter[0].type).toBe('raw');
  });

  it('gives an object its verb scripts', async () => {
    const { project } = await imported();
    const handlers = project.rooms.flatMap((room) =>
      room.objects.flatMap((object) => object.handlers),
    );

    expect(handlers.length).toBeGreaterThan(0);
    expect(handlers.every((handler) => handler.actions.length > 0)).toBe(true);
  });

  it('produces a project that still compiles', async () => {
    // Behaviour that arrives as bytecode has to survive being compiled again,
    // or importing a game would produce something that cannot be played.
    const { project } = await imported();
    const { buildProject } = await import('../src/authoring/projectToGame.js');

    expect(buildProject(project).errors).toEqual([]);
  });
});
