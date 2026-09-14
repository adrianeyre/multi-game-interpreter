/**
 * Regenerates `src/engine/agos/script/opcodeArgTables.ts` from ScummVM.
 *
 *   npm run gen:agos-tables -- /path/to/scummvm
 *
 * ## Why this is a command and not a copy-paste
 *
 * An AGOS instruction's length comes from a table outside the bytecode, and the
 * table shipped inside Adventure Soft's executable rather than with the game —
 * so unlike AGI, whose arity table can be read out of `agidata.ovl`, this one is
 * ours (ADR 0029). It is nine tables of up to 300 entries, and the failure a
 * single wrong character causes is the worst shape this project has: every
 * boundary after it is misread, the misreading re-emits byte for byte, and a
 * byte-identity check passes over a structure that is wrong.
 *
 * A person copying 2300 entries by hand will make that mistake eventually. A
 * script will not, and re-running it is how the table is checked rather than
 * trusted.
 *
 * ScummVM is this project's stated reference for how the originals behave
 * (`README.md`), and its checkout is an argument here for the same reason game
 * data always is: it is not vendored into this repository.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'src/engine/agos/script/opcodeArgTables.ts';
const NAMES_OUT = 'src/engine/agos/script/opcodeNames.ts';
const VGA_OUT = 'src/engine/agos/gfx/vgaOpcodeTables.ts';

/** The VGA script tables, which carry operand letters and a name in one string. */
const VGA_SOURCES: Record<string, string> = {
  elvira1: 'elvira1',
  elvira2: 'elvira2',
  waxworks: 'ww',
  simon1: 'simon1',
  simon2: 'simon2',
  feeblefiles: 'feeblefiles',
  puzzlepack: 'puzzlepack',
};

/**
 * Rebuilds the VGA script tables.
 *
 * AGOS's second bytecode (ADR 0027's amendment). ScummVM keeps these in its
 * debugger's header rather than beside the dispatch, because it uses them only
 * to print a script — which is what this project uses them for too, until the
 * renderer runs them.
 */
function vgaModule(root: string): string {
  const header = readFileSync(VGA_OUT, 'utf8').split('export const VGA_OPCODE_TABLES')[0];
  const debug = readFileSync(join(root, 'engines/agos/debug.h'), 'utf8');
  const lines = [
    header + 'export const VGA_OPCODE_TABLES: Record<string, readonly (string | null)[]> = {',
  ];
  for (const [key, name] of Object.entries(VGA_SOURCES)) {
    const pattern = new RegExp(
      `const char \\*const ${name}_videoOpcodeNameTable\\[\\] = \\{([\\s\\S]*?)\\n\\};`,
    );
    const table = pattern.exec(debug);
    if (!table) throw new Error(`no VGA opcode table for ${name}`);
    const entries: (string | null)[] = [];
    for (const token of table[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|\bnullptr\b|\bNULL\b/g)) {
      entries.push(token[0]!.startsWith('"') ? token[1]! : null);
    }
    lines.push(`  ${key}: [`);
    let line = '   ';
    for (const entry of entries) {
      const piece =
        entry === null ? ' null,' : ` '${entry.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`;
      if (line.length + piece.length > 96) {
        lines.push(line);
        line = '   ';
      }
      line += piece;
    }
    lines.push(line, '  ],');
  }
  lines.push('};\n');
  lines.push(readFileSync(VGA_OUT, 'utf8').split('};\n')[1] ?? '');
  return lines.join('\n');
}

/** Which dispatch file each argument table's Version keeps its opcode names in. */
const NAME_SOURCES: Record<string, string> = {
  elvira1: 'script_e1.cpp',
  elvira2: 'script_e2.cpp',
  waxworks: 'script_ww.cpp',
  simon1: 'script_s1.cpp',
  simon2: 'script_s2.cpp',
  feeblefiles: 'script_ff.cpp',
  puzzlepack: 'script_pp.cpp',
};

/**
 * Rebuilds the opcode name table.
 *
 * Names come from a different file than lengths — the dispatch table rather
 * than the argument table — and there is one per game rather than one per
 * argument table, so `simon1talkie` and `simon1dos` share `simon1`'s names.
 * They differ in how long two opcodes are, not in what they are called.
 */
function namesModule(root: string): string {
  const header = readFileSync(NAMES_OUT, 'utf8').split('export const OPCODE_NAMES')[0];
  const lines = [header + 'export const OPCODE_NAMES: Record<string, readonly string[]> = {'];
  for (const [key, file] of Object.entries(NAME_SOURCES)) {
    const dispatch = readFileSync(join(root, 'engines/agos', file), 'utf8');
    const table = /static const Opcode\w+ opcodes\[\] = \{([\s\S]*?)\n\t\};/.exec(dispatch);
    if (!table) throw new Error(`no opcode dispatch table in ${file}`);
    const names = [...table[1]!.matchAll(/OPCODE\((\w+)\)/g)].map((entry) => entry[1]);
    lines.push(`  ${key}: [`);
    let line = '   ';
    for (const name of names) {
      const piece = ` '${name}',`;
      if (line.length + piece.length > 96) {
        lines.push(line);
        line = '   ';
      }
      line += piece;
    }
    lines.push(line, '  ],');
  }
  lines.push('};\n');
  lines.push(readFileSync(NAMES_OUT, 'utf8').split('};\n')[1] ?? '');
  return lines.join('\n');
}

function tablesFrom(source: string): Map<string, (string | null)[]> {
  const tables = new Map<string, (string | null)[]>();
  const declaration =
    /static const char \*const opcodeArgTable_(\w+)\[(\d+)\] = \{([\s\S]*?)\n\};/g;
  for (const match of source.matchAll(declaration)) {
    const [, name, sizeText, body] = match;
    const size = Number(sizeText);
    const listed = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((entry) => entry[1]);
    // Entries a C array declaration leaves off are NULL: an opcode with no
    // length, which is a decode failure rather than a no-op.
    const padded: (string | null)[] = [...listed, ...Array<null>(size - listed.length).fill(null)];
    if (padded.length !== size)
      throw new Error(`${name}: ${listed.length} entries for size ${size}`);
    tables.set(name, padded);
  }
  if (tables.size === 0)
    throw new Error('No opcode argument tables found — has subroutine.cpp moved?');
  return tables;
}

const root = process.argv[2];
if (!root) {
  console.error('usage: npm run gen:agos-tables -- /path/to/scummvm');
  process.exit(1);
}

const source = readFileSync(join(root, 'engines/agos/subroutine.cpp'), 'utf8');
const tables = tablesFrom(source);
writeFileSync(NAMES_OUT, namesModule(root), 'utf8');
console.log(`wrote ${NAMES_OUT}`);
writeFileSync(VGA_OUT, vgaModule(root), 'utf8');
console.log(`wrote ${VGA_OUT}`);
for (const [name, entries] of tables) {
  const used = entries.filter((entry) => entry !== null).length;
  console.log(`${name}: ${used} opcodes of ${entries.length}`);
}
writeFileSync(OUT, existingHeaderPlus(tables), 'utf8');
console.log(`wrote ${OUT}`);

// Generated output is committed, so it has to look like the rest of the
// codebase or every regeneration shows up as a formatting diff.
execFileSync('npx', ['prettier', '--write', OUT, NAMES_OUT, VGA_OUT], { stdio: 'inherit' });

function quote(value: string | null): string {
  return value === null ? 'null' : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function existingHeaderPlus(tables: Map<string, (string | null)[]>): string {
  const header = readFileSync(OUT, 'utf8').split('export type AgosOpcodeTableName')[0];
  const lines: string[] = [header + 'export type AgosOpcodeTableName ='];
  lines.push([...tables.keys()].map((name) => `  | '${name}'`).join('\n') + ';\n');
  lines.push(
    'export const OPCODE_ARG_TABLES: Record<AgosOpcodeTableName, readonly (string | null)[]> = {',
  );
  for (const [name, entries] of tables) {
    lines.push(`  ${name}: [`);
    let line = '   ';
    for (const entry of entries) {
      const piece = ` ${quote(entry)},`;
      if (line.length + piece.length > 96) {
        lines.push(line);
        line = '   ';
      }
      line += piece;
    }
    lines.push(line, '  ],');
  }
  lines.push('};\n');
  return lines.join('\n');
}
