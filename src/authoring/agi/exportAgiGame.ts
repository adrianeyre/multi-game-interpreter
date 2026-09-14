/**
 * Writing an AGI project back out as game files an interpreter runs.
 *
 * Simpler than v7's export, and for a structural reason. ADR 0009 notes that
 * exporting v7 means rewriting a *set* of files rather than a pair, and that a
 * language bundle which fails to write leaves "a game full of missing dialogue
 * rather than a game that fails to load". AGI has no file outside its volumes
 * to keep in step — a Logic's messages are inside the Logic — so this stays the
 * narrower problem ADR 0010 was written to handle.
 *
 * Always emitted as AGI v2 packaging, whatever the project was imported from,
 * and that is a deliberate narrowing rather than an oversight. v3 changes
 * packaging only: one combined index instead of four files, and volumes whose
 * resources may be LZW-compressed. The *resources* are identical either way, so
 * a v3 game exported as v2 is the same game — and writing an LZW *compressor*
 * to re-emit a v3 volume would add a second implementation of a format whose
 * decoder is already the delicate part. The AGI Specification says as much:
 * "it is therefore possible to convert a version 3 game into the version 2
 * format and vice versa".
 */

import { fromBase64 } from '../base64.js';
import type { AgiProject, Project } from '../project.js';
import { emitLogic, type AgiLogicTree } from './decompileLogic.js';

/** One file to write, as the editor's zip and folder writers both want it. */
export interface AgiExportFile {
  name: string;
  data: Uint8Array;
}

export interface AgiExportResult {
  files: AgiExportFile[];
  errors: string[];
  warnings: string[];
}

const DIR_NAMES = ['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR'] as const;

/** A resource, with the bytes to write and the number it is indexed under. */
interface Emitted {
  number: number;
  bytes: Uint8Array;
}

/**
 * Turns a project into `LOGDIR`, `PICDIR`, `VIEWDIR`, `SNDDIR`, `VOL.0`,
 * `WORDS.TOK` and `OBJECT`.
 *
 * A Logic with a tree is re-emitted from it; a Logic marked Unrecovered is
 * written from the bytes it arrived as. That is the whole of what Unrecovered
 * costs an author: the resource still ships, it is just not editable
 * (`CONTEXT.md`).
 */
export function exportAgiGame(project: Project): AgiExportResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const agi = project.agi;
  if (project.target.engine !== 'agi' || !agi) {
    return {
      files: [],
      errors: ['This is not an AGI project, so it cannot be exported as AGI game files.'],
      warnings,
    };
  }

  const logics: Emitted[] = [];
  for (const logic of agi.logics) {
    if (logic.tree) {
      try {
        logics.push({ number: logic.number, bytes: emitLogic(logic.tree as AgiLogicTree) });
        continue;
      } catch (error) {
        // Named rather than silently falling back to the original bytes: an
        // author who edited this Logic would otherwise export a game without
        // their change in it and no indication why.
        errors.push(
          `Logic ${logic.number} could not be written: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
    }

    logics.push({ number: logic.number, bytes: fromBase64(logic.bytes) });
    if (logic.unrecovered) {
      warnings.push(
        `Logic ${logic.number} is Unrecovered and was written back exactly as it ` +
          `arrived. Any change an author wanted here was not possible to make.`,
      );
    }
  }

  const carried = (entries: AgiProject['pictures']): Emitted[] =>
    entries.map((entry) => ({ number: entry.number, bytes: fromBase64(entry.bytes) }));

  const tables: Emitted[][] = [
    logics,
    carried(agi.pictures),
    carried(agi.views),
    carried(agi.sounds),
  ];

  if (errors.length > 0) return { files: [], errors, warnings };

  const { volume, directories } = packVolume(tables);

  const files: AgiExportFile[] = [
    ...DIR_NAMES.map((name, index) => ({ name, data: directories[index] })),
    { name: 'VOL.0', data: volume },
  ];

  files.push({ name: 'WORDS.TOK', data: writeVocabulary(agi.words) });
  files.push({ name: 'OBJECT', data: writeObjects(agi.inventory) });

  return { files, errors, warnings };
}

/**
 * Packs every resource into one volume and builds the four index tables.
 *
 * One volume rather than several: AGI's directory entry gives four bits of
 * volume number and twenty of offset, so a single volume holds a megabyte —
 * more than any AGI game, fan-made or Sierra's.
 */
function packVolume(tables: Emitted[][]): { volume: Uint8Array; directories: Uint8Array[] } {
  const volume: number[] = [];
  const directories: Uint8Array[] = [];

  for (const entries of tables) {
    const highest = entries.reduce((top, entry) => Math.max(top, entry.number), -1);
    // Sparse, filled with the absent marker: a game with Logic 0, 1 and 99 has
    // a hundred entries and three resources, and that is normal.
    const table = new Uint8Array((highest + 1) * 3).fill(0xff);

    for (const entry of entries) {
      const offset = volume.length;
      volume.push(
        0x12,
        0x34,
        0,
        entry.bytes.length & 0xff,
        (entry.bytes.length >> 8) & 0xff,
        ...entry.bytes,
      );

      const at = entry.number * 3;
      // Volume 0 in the high nibble, then twenty bits of offset.
      table[at] = (offset >> 16) & 0x0f;
      table[at + 1] = (offset >> 8) & 0xff;
      table[at + 2] = offset & 0xff;
    }

    directories.push(table);
  }

  return { volume: new Uint8Array(volume), directories };
}

/**
 * Writes `WORDS.TOK`.
 *
 * The prefix-reuse encoding is rebuilt rather than carried, because the words
 * are stored in the project as a flat list — so the file is regenerated from
 * them and will not be byte-identical to the one it came from unless the
 * original happened to use the same reuse choices. That is acceptable here in a
 * way it is not for a Logic: the vocabulary has no code in it, and a `said`
 * matches on group numbers, which round-trip exactly.
 */
function writeVocabulary(entries: ReadonlyArray<readonly [string, number]>): Uint8Array {
  const sections = new Map<number, Array<[string, number]>>();
  for (const [word, group] of entries) {
    const letter = word.charCodeAt(0) - 'a'.charCodeAt(0);
    if (letter < 0 || letter > 25) continue;
    const list = sections.get(letter) ?? [];
    list.push([word, group]);
    sections.set(letter, list);
  }

  const body: number[] = [];
  const offsets = new Array(26).fill(0);

  for (const letter of [...sections.keys()].sort((a, b) => a - b)) {
    offsets[letter] = 52 + body.length;
    let previous = '';

    for (const [word, group] of sections.get(letter)!.sort((a, b) => a[0].localeCompare(b[0]))) {
      let reuse = 0;
      while (reuse < previous.length && previous[reuse] === word[reuse]) reuse++;
      body.push(reuse);

      const rest = word.slice(reuse);
      for (const [index, character] of [...rest].entries()) {
        // The high bit marks the last character of a word, and the rest is the
        // character XORed with 0x7F.
        const last = index === rest.length - 1;
        body.push((character.charCodeAt(0) ^ 0x7f) | (last ? 0x80 : 0));
      }
      body.push((group >> 8) & 0xff, group & 0xff);
      previous = word;
    }
    // A zero reuse-count byte terminates the section.
    body.push(0);
  }

  const header: number[] = [];
  for (const offset of offsets) header.push((offset >> 8) & 0xff, offset & 0xff);
  return new Uint8Array([...header, ...body]);
}

function writeObjects(inventory: AgiProject['inventory']): Uint8Array {
  const namesAt = inventory.items.length * 3;
  const nameOffsets = new Map<string, number>();
  const nameBytes: number[] = [];

  for (const item of inventory.items) {
    if (nameOffsets.has(item.name)) continue;
    nameOffsets.set(item.name, namesAt + nameBytes.length);
    nameBytes.push(...[...item.name].map((character) => character.charCodeAt(0)), 0);
  }

  const out: number[] = [namesAt & 0xff, (namesAt >> 8) & 0xff, inventory.maxAnimatedObjects];
  for (const item of inventory.items) {
    const offset = nameOffsets.get(item.name)!;
    out.push(offset & 0xff, (offset >> 8) & 0xff, item.startRoom);
  }
  out.push(...nameBytes);

  const bytes = new Uint8Array(out);
  if (!inventory.encrypted) return bytes;

  const key = 'Avis Durgan';
  const encrypted = new Uint8Array(bytes.length);
  for (const [index, byte] of bytes.entries()) {
    encrypted[index] = byte ^ key.charCodeAt(index % key.length);
  }
  return encrypted;
}
