import { describe, expect, it } from 'vitest';
import {
  buildSkyCompactFixture,
  FIXTURE_FULL_COMPACT,
  FIXTURE_SHORT_COMPACT,
  FIXTURE_TURN_TABLE,
} from './fixtureSkyCompacts.js';
import {
  importSkyProject,
  toSkyProjectJson,
  wordsFromBase64,
} from '../src/authoring/sky/project.js';
import { compactWordName, formatCompactRecord } from '../src/authoring/sky/disassemble.js';
import { compactWords, editCompactWord } from '../src/authoring/sky/edits.js';
import { parseSkyCompacts, writeSkyCompacts } from '../src/engine/sky/resource/skyCompacts.js';
import { disassembleSkyScript, skyScriptNumbers } from '../src/authoring/sky/disassemble.js';
import { fromBase64 } from '../src/authoring/base64.js';

describe('Sky authoring surface (ADR 0025)', () => {
  it('reads the Compact table into an editable project that round-trips', () => {
    const bytes = buildSkyCompactFixture();
    const project = importSkyProject(bytes, 'cd', 'dos', 'the cd release');

    // Three records in the default fixture; the object table is what is read.
    expect(project.records.map((r) => r.name)).toEqual([
      FIXTURE_FULL_COMPACT.name,
      FIXTURE_SHORT_COMPACT.name,
      FIXTURE_TURN_TABLE.name,
    ]);
    // ADR 0025's precondition: the table re-emits byte for byte, so nothing is
    // Unrecovered and the editor may offer to change things.
    expect(project.editable).toMatchObject({
      roundTrips: true,
      editable: true,
      unrecovered: 0,
      reasons: [],
    });
  });

  it('holds text as its own surface, empty and saying why', () => {
    // ADR 0025 makes text Project content holding every language found. Sky's is
    // not read yet, so the surface is present and empty rather than faked —
    // dropping no language, which an all-or-nothing read never could.
    const project = importSkyProject(buildSkyCompactFixture(), 'cd', 'dos', 'x');
    expect(project.text.read).toBe(false);
    expect(project.text.languages).toEqual([]);
    expect(project.text.note).toMatch(/compressed/);
  });

  it('counts a record it cannot type as Unrecovered, and refuses editing', () => {
    // A type the format does not define is the Unrecovered unit here — a count
    // over the object table, never over scripts.
    const bytes = buildSkyCompactFixture({
      compacts: [{ name: 'mystery', type: 9, words: [1, 2, 3] }],
    });
    const project = importSkyProject(bytes, 'cd', 'dos', 'x');
    expect(project.editable.editable).toBe(false);
    expect(project.editable.unrecovered).toBe(1);
    expect(project.editable.reasons.join(' ')).toMatch(/could not be read into typed fields/);
  });

  it('serialises records to JSON whose words decode back unchanged', () => {
    const project = importSkyProject(buildSkyCompactFixture(), 'cd', 'dos', 'the cd release');
    const json = toSkyProjectJson(project);

    expect(json.identification).toBe('the cd release');
    const full = json.records.find((r) => r.name === FIXTURE_FULL_COMPACT.name)!;
    // The one truth is the words; base64 is just how JSON carries them.
    expect(Array.from(wordsFromBase64(full.wordsBase64))).toEqual(FIXTURE_FULL_COMPACT.words);
  });

  it('edits a field value and re-emits the table byte-identically but for that word', () => {
    const bytes = buildSkyCompactFixture();
    const project = importSkyProject(bytes, 'cd', 'dos', 'x');
    const json = toSkyProjectJson(project);

    // Change foster's xcood (word 6) to 999.
    const before = json.records.find((r) => r.name === 'foster')!;
    const after = editCompactWord(before, 6, 999);
    expect(compactWords(after)[6]).toBe(999);
    expect(compactWords(before)[6]).toBe(FIXTURE_FULL_COMPACT.words[6]); // input untouched

    // Feeding the edited words back through the real writer produces a file that
    // differs from the original only where the edit was — the writer's own
    // round-trip is what proves the edit is a value change and not a shape one.
    const compacts = parseSkyCompacts(bytes);
    const fosterId = compacts.records.find((r) => r.name === 'foster')!.id;
    const rewritten = writeSkyCompacts(bytes, compacts, new Map([[fosterId, compactWords(after)]]));
    expect(rewritten.length).toBe(bytes.length);
    const differences = [...rewritten].filter((b, i) => b !== bytes[i]).length;
    // 999 differs from the original word in both its bytes; nothing else moved.
    expect(differences).toBeGreaterThan(0);
    expect(differences).toBeLessThanOrEqual(2);
  });

  it('refuses an edit outside a record, because shape is fixed (ADR 0024)', () => {
    const project = importSkyProject(buildSkyCompactFixture(), 'cd', 'dos', 'x');
    const short = toSkyProjectJson(project).records.find(
      (r) => r.name === FIXTURE_SHORT_COMPACT.name,
    )!;
    // The short compact is 29 words; word 29 does not exist.
    expect(() => editCompactWord(short, 29, 1)).toThrow(/no word 29/);
  });

  it('names a compact word from its type, and a turn table frame', () => {
    // logic is word 0; the first mega-set field follows the 55 named ones.
    expect(compactWordName({ type: 'compact' }, 0)).toBe('logic');
    expect(compactWordName({ type: 'compact' }, 6)).toBe('xcood');
    expect(compactWordName({ type: 'compact' }, 55)).toBe('megaSet0.gridWidth');
    expect(compactWordName({ type: 'turnTable' }, 0)).toBe('turnTableUp[0]');
    expect(compactWordName({ type: 'turnTable' }, 6)).toBe('turnTableDown[1]');
    // An array kind has no field names, so a word is a word.
    expect(compactWordName({ type: 'routeBuffer' }, 3)).toBe('word 3');
  });

  it('lists a record with its named fields', () => {
    const project = importSkyProject(buildSkyCompactFixture(), 'cd', 'dos', 'x');
    const full = project.records.find((r) => r.name === 'foster')!;
    const listing = formatCompactRecord(full.record);
    expect(listing).toMatch(/foster {2}; compact/);
    expect(listing).toMatch(/logic: 100/);
    expect(listing).toMatch(/megaSet 0:/);
  });
});

/**
 * The bytecode surface: Preserved bytes and a read-only listing (ADR 0025).
 */
describe('Sky bytecode as Disassembly', () => {
  /** A one-module fixture: an entry table, then one script. */
  function moduleWith(...body: number[]): Uint16Array {
    // Entry 0 is the table's own length; entry 1 is the first script's offset.
    const table = [2, 2];
    return Uint16Array.from([...table, ...body]);
  }

  it('lists a script from its own entry, as instructions', () => {
    // push_number 7, script_exit.
    const module = moduleWith(2, 7, 13);
    const listing = disassembleSkyScript(module, 1);

    expect(listing.scriptNumber).toBe(1);
    expect(listing.start).toBe(2);
    expect(listing.stoppedBecause).toBeNull();
    expect(listing.lines.map((line) => line.name)).toEqual(['push_number', 'script_exit']);
    expect(listing.lines[0].operands).toEqual([7]);
  });

  it('names the mcode a call reaches, which is what a reader chases', () => {
    // call_mcode with argc 0 and mcode 8 (fnDrawScreen at stride 4 is 2).
    const module = moduleWith(11, 0, 8, 13);
    const listing = disassembleSkyScript(module, 1);
    expect(listing.lines[0].mcode).toBe('fnDrawScreen');
  });

  it('offers every script a module says it has, and never script 0', () => {
    // Entry 0 is the table's own length rather than a script.
    const module = Uint16Array.from([3, 3, 5, 0, 13, 0, 13]);
    expect(skyScriptNumbers(module, 2)).toEqual([(2 << 12) | 1, (2 << 12) | 2]);
    expect(() => disassembleSkyScript(module, 2 << 12)).toThrow(/no script 0/);
  });

  it('carries the modules into the project as Preserved bytes', () => {
    const module = moduleWith(2, 7, 13);
    const project = importSkyProject(
      buildSkyCompactFixture(),
      'cd',
      'dos',
      'a fixture',
      new Map([[0, module]]),
    );

    expect(project.scripts).toHaveLength(1);
    expect(project.scripts[0].numbers).toEqual([1]);
    // Byte-identical out and back: the bytecode is not reconstructed, it is kept.
    const json = toSkyProjectJson(project);
    const back = fromBase64(json.scripts![0].wordsBase64);
    expect(new Uint16Array(back.buffer, back.byteOffset, module.length)).toEqual(module);
  });
});
