/**
 * The editable form of a Sky game (ADR 0025).
 *
 * Three families before this held behaviour in three shapes; Sky and Lure share
 * a fourth, and ADR 0024 gives the reason: the world is not in the bytecode. A
 * Sky **Compact** carries where an object is, what mode it is in, what it looks
 * like and which logic drives it, so most of what a person means by "edit this
 * game" is a field in that table rather than an instruction.
 *
 * So the editable surface this reads is the **Compact table**: named records
 * with typed, named fields, the round-trip for which already exists in
 * `skyCompacts.ts`. This module is the authoring layer over it — the analogue of
 * `authoring/agos/project.ts` — and it does three things:
 *
 * 1. builds a per-record model the editor can list and select
 * 2. works out whether ADR 0025's conditions hold, without ever refusing to open
 *    a game that fails them (a game that cannot be edited can still be read)
 * 3. keeps text as a **separate** surface, per the ADR, rather than folding it
 *    into the records
 *
 * ## Text is its own surface, and it is empty for now
 *
 * ADR 0025 makes text Project content holding every language found. Sky keeps
 * its text compressed in its data file with the tree in the executable, and this
 * project does not read it yet, so the surface is present and empty rather than
 * absent or faked. An empty surface drops no language; the moment a reader lands,
 * dropping one becomes Unrecovered. Building an unchecked text decoder would be
 * the guess this family's readers refuse — the same stance `skyCompacts.ts` takes
 * on `SKY.EXE`.
 */

import { fromBase64, toBase64 } from '../base64.js';
import { skyScriptNumbers } from './disassemble.js';
import {
  parseSkyCompacts,
  writeSkyCompacts,
  type SkyCompactRecord,
  type SkyCompacts,
} from '../../engine/sky/resource/skyCompacts.js';
import type { SkyPlatform, SkyRelease, Target } from '../target.js';
import type {
  SkyProject,
  SkyProjectPalette,
  SkyProjectPicture,
  SkyProjectSprite,
  SkyProjectRecord,
  SkyProjectText,
} from '../project.js';
import type { SkyDrawables } from './pictures.js';

/** A record as the editor talks about one: its identity plus its typed record. */
export interface NamedCompact {
  readonly id: number;
  readonly list: number;
  readonly index: number;
  readonly name: string;
  readonly record: SkyCompactRecord;
}

/** The rich import-time model, holding the live `SkyCompacts` rather than JSON. */
/**
 * One script module, held whole.
 *
 * `numbers` is what the module's own entry table says it holds, so a listing
 * pane can offer the scripts that exist rather than probing for them. Entry 0
 * is the table's own length and not a script, which is why the numbers start
 * at one.
 */
export interface SkyScriptModule {
  readonly number: number;
  readonly words: Uint16Array;
  readonly numbers: readonly number[];
}

export interface SkyAuthoringProject {
  readonly target: Target & { engine: 'sky' };
  /** How the Release was established, in words for the editor. */
  readonly identification: string;
  readonly compacts: SkyCompacts;
  readonly records: readonly NamedCompact[];
  readonly text: SkyProjectText;
  /**
   * The bytecode, as **Preserved bytes** and a read-only listing (ADR 0025).
   *
   * The modules are carried whole and unaltered — that is what Preserved bytes
   * means, and it is deliberate rather than a gap — and the listing is produced
   * from them on demand rather than stored, because 65,061 instructions is a
   * thing to read a screenful of, not a thing to keep twice.
   *
   * Empty when a caller imports without them, which is how a Compact table on
   * its own still opens.
   */
  readonly scripts: readonly SkyScriptModule[];
  /**
   * The drawable resources for the picture surface — screens, room backgrounds
   * and palettes (ADR 0025).
   *
   * A read-only viewer, and empty when a caller imports without them, exactly
   * like `scripts`: a Compact table on its own still opens.
   */
  readonly pictures: readonly SkyProjectPicture[];
  readonly sprites: readonly SkyProjectSprite[];
  readonly palettes: readonly SkyProjectPalette[];
  readonly editable: SkyEditabilityReport;
}

export interface SkyEditabilityReport {
  /** Whether the table re-emitted byte for byte with nothing replaced. */
  readonly roundTrips: boolean;
  /** True only when the table round-trips and nothing is Unrecovered. */
  readonly editable: boolean;
  /**
   * A count over the object table (ADR 0025), never over scripts.
   *
   * One per record the reader could not turn into typed fields — an unknown
   * type, or a starting-state change past the end of a state. Published with a
   * target of zero and never widened into a fallback.
   */
  readonly unrecovered: number;
  readonly reasons: readonly string[];
}

/** Why text is empty, said once so the editor and the notes agree. */
export const SKY_TEXT_NOTE =
  'Sky keeps its text compressed in its data file with the decompression tree in the ' +
  'executable, and this project does not read it yet. This surface holds every language it ' +
  'finds (ADR 0025); until a reader lands it finds none, which drops nothing.';

/** The text surface as it stands: present, empty, and saying why. */
export function skyTextSurface(): SkyProjectText {
  return { languages: [], read: false, note: SKY_TEXT_NOTE };
}

/**
 * Reads `sky.cpt` bytes into a Project, and works out whether it may be edited.
 *
 * Importing never fails on the editability check: a game that cannot be edited
 * can still be read, and saying so is more useful than refusing to open it. What
 * the check governs is whether the editor offers to change anything.
 */
export function importSkyProject(
  bytes: Uint8Array,
  release: SkyRelease,
  platform: SkyPlatform,
  identification: string,
  modules: ReadonlyMap<number, Uint16Array> = new Map(),
  drawables: SkyDrawables = { pictures: [], palettes: [], sprites: [] },
): SkyAuthoringProject {
  const compacts = parseSkyCompacts(bytes);

  // The round-trip that ADR 0025 makes a precondition: with nothing replaced,
  // the writer must reproduce the file it read. A table that does not is one the
  // reader misunderstood, and editing it would write a change into a misreading.
  const rewritten = writeSkyCompacts(bytes, compacts);
  const roundTrips = rewritten.length === bytes.length && rewritten.every((b, i) => b === bytes[i]);

  const reasons: string[] = [];
  if (!roundTrips) reasons.push('the Compact table did not re-emit byte for byte');
  if (compacts.notes.length > 0) {
    reasons.push(
      `${compacts.notes.length} record(s) could not be read into typed fields: ` +
        compacts.notes.map((note) => note.reason).join('; '),
    );
  }

  const unrecovered = compacts.notes.length;
  const editable = roundTrips && unrecovered === 0;

  const records: NamedCompact[] = compacts.records.map((record) => ({
    id: record.id,
    list: record.list,
    index: record.index,
    name: record.name,
    record,
  }));

  return {
    target: { engine: 'sky', release, platform },
    identification,
    compacts,
    records,
    text: skyTextSurface(),
    scripts: [...modules.entries()]
      .sort(([a], [b]) => a - b)
      .map(([number, words]) => ({
        number,
        words,
        numbers: skyScriptNumbers(words, number),
      })),
    pictures: drawables.pictures,
    palettes: drawables.palettes,
    sprites: drawables.sprites,
    editable: { roundTrips, editable, unrecovered, reasons },
  };
}

/**
 * Serialises the rich model into the JSON `Project.sky`.
 *
 * The records carry their words as base64 of their little-endian bytes — the one
 * truth the fields are a view over, and Preserved bytes so a record nobody edits
 * re-emits unchanged.
 */
export function toSkyProjectJson(project: SkyAuthoringProject): SkyProject {
  return {
    identification: project.identification,
    editable: {
      editable: project.editable.editable,
      unrecovered: project.editable.unrecovered,
      reasons: [...project.editable.reasons],
    },
    records: project.records.map((named) => recordToJson(named.record)),
    text: { ...project.text, languages: [...project.text.languages] },
    scripts: project.scripts.map((module) => ({
      number: module.number,
      scripts: module.numbers.length,
      // Preserved bytes: carried out and back unaltered, because this project
      // does not claim to reconstruct Sky bytecode into editable structure.
      wordsBase64: toBase64(
        new Uint8Array(module.words.buffer, module.words.byteOffset, module.words.byteLength),
      ),
    })),
    // The drawable surfaces, carried through as Preserved bytes for the editor's
    // read-only picture viewer (ADR 0025).
    pictures: project.pictures.map((picture) => ({ ...picture })),
    palettes: project.palettes.map((palette) => ({ ...palette })),
    sprites: project.sprites.map((sprite) => ({ ...sprite })),
  };
}

/** One record as JSON: identity, type, and its words base64'd. */
export function recordToJson(record: SkyCompactRecord): SkyProjectRecord {
  return {
    id: record.id,
    list: record.list,
    index: record.index,
    name: record.name,
    type: record.type,
    wordsBase64: wordsToBase64(record.words),
  };
}

/** A record's words as base64 of their little-endian bytes. */
export function wordsToBase64(words: Uint16Array): string {
  const bytes = new Uint8Array(words.length * 2);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint16(i * 2, word, true));
  return toBase64(bytes);
}

/** The inverse: base64 back to words, for an edit or the writer. */
export function wordsFromBase64(base64: string): Uint16Array {
  const bytes = fromBase64(base64);
  const words = new Uint16Array(Math.floor(bytes.length / 2));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < words.length; i += 1) words[i] = view.getUint16(i * 2, true);
  return words;
}
