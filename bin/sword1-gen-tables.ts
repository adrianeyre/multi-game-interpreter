/**
 * Regenerates Broken Sword 1's section tables and mcode names from ScummVM.
 *
 *   npm run gen:sword1-tables -- /path/to/scummvm
 *
 * The fourth generator of its kind here, after `bin/agos-gen-tables.ts`,
 * `bin/sludge-gen-tables.ts` and `bin/lure-gen-tables.ts`, and for the reason
 * ADR 0029 gave the first: a table that lives in the *interpreter* rather than
 * in the game is ours, and a table a person types out is a table with a typo in
 * it — where the typo then reads as a decoding fault.
 *
 * ## What it reads, and why these four tables and no others
 *
 * ADR 0033's rule is that a directory existing only in a support file is
 * derived from the shipped bytes. These four are the opposite case and it is
 * worth saying which side of the line each sits on, because Broken Sword's
 * `swordres.rif` *is* self-describing and most of what this family needs is
 * read from it:
 *
 * - **`_objectList`** (section -> compact resource id) and **`_scriptList`**
 *   (section -> script resource id). A RIF says where resource `0x03040007` is;
 *   it does not say that section 12's compacts are that resource. That mapping
 *   lived in Revolution's own interpreter, so it is ours to carry — the same
 *   standing as an opcode table, not the standing of ScummVM's `lure.dat`.
 * - **`_textList`** (section, language -> text resource id), for the same
 *   reason with a language axis on top.
 * - **The mcode names.** `interpretScript` reads a *number*; what number 38 is
 *   called is interpreter knowledge (ADR 0029's exact case).
 *
 * Everything else this family reads — offsets, lengths, frame headers, compact
 * bytes, script bytecode — comes out of the game's own files.
 *
 * ## Why the values are read rather than inferred
 *
 * `swordres.h` gives every id an explicit hexadecimal value, so nothing depends
 * on declaration order. The generator resolves each table entry through that
 * map and **fails on an unknown symbol** rather than emitting a zero, because a
 * zero here is a section that silently has no compacts.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = 'src/engine/sword1/resource/swordSections.ts';
const MCODE_OUT = 'src/engine/sword1/script/mcodeNames.ts';
const ROOM_OUT = 'src/engine/sword1/resource/swordRooms.ts';
const VAR_OUT = 'src/engine/sword1/script/scriptVars.ts';
const MENU_OUT = 'src/engine/sword1/resource/swordMenuTables.ts';
const FX_OUT = 'src/engine/sword1/sound/fxTable.ts';
const SEQ_OUT = 'src/engine/sword1/video/sequenceNames.ts';
const START_OUT = 'src/engine/sword1/script/startPositions.ts';
const PARAM_OUT = 'src/engine/sword1/script/mcodeParams.ts';
const TUNE_OUT = 'src/engine/sword1/sound/tuneNames.ts';

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const checkout = process.argv[2];
if (!checkout) fail('usage: npm run gen:sword1-tables -- /path/to/scummvm');

function read(...parts: string[]): string {
  const path = join(checkout as string, ...parts);
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail(`could not read ${path} — is that a ScummVM checkout?`);
  }
}

const swordres = read('engines', 'sword1', 'swordres.h');
const staticres = read('engines', 'sword1', 'staticres.cpp');
const logic = read('engines', 'sword1', 'logic.cpp');
const logicHeader = read('engines', 'sword1', 'logic.h');
const soundHeader = read('engines', 'sword1', 'sound.h');
const sworddefs = read('engines', 'sword1', 'sworddefs.h');

/** Every `#define NAME 0x…` in `swordres.h`, which is where the ids live. */
const defines = new Map<string, number>();
/**
 * Values are either a literal or a small arithmetic expression.
 *
 * `swordres.h` writes plain hex; `sworddefs.h` writes the script ids as
 * `(0*0x10000 + 25)` — section times the section stride plus a script number,
 * which is how a person reads a script id. Both are evaluated here rather than
 * only the first, because refusing the second means refusing the menu tables,
 * whose `useScript` fields are all of that shape.
 *
 * `evaluate` accepts only digits, hex literals, `*`, `+`, `-` and brackets, so
 * nothing in a header can turn into a call.
 */
function evaluate(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[\s\d()+\-*xXa-fA-F]+$/.test(trimmed)) return null;
  if (!/^[\s\d()+\-*]*(0[xX][0-9a-fA-F]+|\d+)[\s\d()+\-*xXa-fA-F]*$/.test(trimmed)) return null;
  try {
    const value = Function(`"use strict"; return (${trimmed});`)() as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const definePattern = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+([^\n\\]+)$/gm;
for (const source of [swordres, sworddefs, soundHeader]) {
  definePattern.lastIndex = 0;
  for (let match = definePattern.exec(source); match; match = definePattern.exec(source)) {
    const name = match[1] as string;
    if (defines.has(name)) continue;
    const value = evaluate((match[2] as string).replace(/\/\/.*$/, '').replace(/\/\*.*$/, ''));
    if (value !== null) defines.set(name, value);
  }
}
if (defines.size === 0) fail('no #define values in swordres.h; the format has changed');

/** Pulls one `name[TOTAL_SECTIONS] = { … };` table out of `staticres.cpp`. */
function tableBody(name: string): string {
  const start = staticres.indexOf(`${name}[TOTAL_SECTIONS]`);
  if (start < 0) fail(`no ${name} table in staticres.cpp; the format has changed`);
  const open = staticres.indexOf('{', start);
  const close = staticres.indexOf('};', open);
  if (open < 0 || close < 0) fail(`${name}'s table is not braced as expected`);
  return staticres.slice(open + 1, close);
}

/** Strips comments so a `// 12` section marker is never read as a value. */
function stripComments(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function resolve(token: string, where: string): number {
  const trimmed = token.trim();
  if (trimmed === '') fail(`empty entry in ${where}`);
  if (/^(0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) return Number(trimmed);
  const value = defines.get(trimmed);
  if (value === undefined) fail(`${where} names ${trimmed}, which swordres.h does not define`);
  return value;
}

function flatTable(name: string): number[] {
  const entries = stripComments(tableBody(name))
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  return entries.map((entry) => resolve(entry, name));
}

/** The text table is `[TOTAL_SECTIONS][7]`, so its rows are braced. */
function textTable(): number[][] {
  const body = stripComments(tableBody('_textList'));
  const rows: number[][] = [];
  const rowPattern = /\{([^{}]*)\}/g;
  for (let match = rowPattern.exec(body); match; match = rowPattern.exec(body)) {
    const row = (match[1] as string)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => resolve(entry, '_textList'));
    // `{0}` is C's zero-fill shorthand for a section with no text at all, and
    // it appears 40-odd times. Padding rather than refusing is the correct
    // reading: the row means "no text resource in any language", and a
    // generator that demanded seven tokens would refuse every unused section.
    if (row.length === 1 && row[0] === 0) {
      rows.push([0, 0, 0, 0, 0, 0, 0]);
      continue;
    }
    rows.push(row);
  }
  return rows;
}

const objectList = flatTable('_objectList');
const scriptList = flatTable('_scriptList');
const textList = textTable();

const TOTAL_SECTIONS = 150;
for (const [name, table] of [
  ['_objectList', objectList],
  ['_scriptList', scriptList],
] as const) {
  if (table.length !== TOTAL_SECTIONS) {
    fail(`${name} has ${table.length} entries and TOTAL_SECTIONS is ${TOTAL_SECTIONS}`);
  }
}
if (textList.length !== TOTAL_SECTIONS) {
  fail(`_textList has ${textList.length} rows and TOTAL_SECTIONS is ${TOTAL_SECTIONS}`);
}
for (const row of textList) {
  if (row.length !== 7) fail(`a _textList row has ${row.length} languages, not 7`);
}

/** The 100 mcodes, in table order — the number a script calls is the index. */
const mcodeStart = logic.indexOf('static const BSMcodeTable mcodeTable[');
if (mcodeStart < 0) fail('no mcodeTable in logic.cpp; the format has changed');
const mcodeBody = logic.slice(mcodeStart, logic.indexOf('};', mcodeStart));
const mcodeNames = [...mcodeBody.matchAll(/&Logic::([A-Za-z0-9_]+)/g)].map(
  (match) => match[1] as string,
);
if (mcodeNames.length === 0) fail('no mcode entries found; the format has changed');

const declared = /mcodeTable\[(\d+)\]/.exec(mcodeBody);
if (declared && Number(declared[1]) !== mcodeNames.length) {
  fail(`mcodeTable declares ${declared[1]} entries and ${mcodeNames.length} were read`);
}

function hex(value: number): string {
  return value === 0 ? '0' : `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function rows(values: number[], perLine: number): string {
  const out: string[] = [];
  for (let at = 0; at < values.length; at += perLine) {
    out.push(
      `  ${values
        .slice(at, at + perLine)
        .map(hex)
        .join(', ')},`,
    );
  }
  return out.join('\n');
}

const header = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Broken Sword addresses a section's compacts, scripts and text by resource id,
 * and the id is not derivable from \`swordres.rif\`: the index says where
 * resource 0x03040007 lives, not that section 12's compacts *are* that
 * resource. That mapping lived in Revolution's interpreter, so this project
 * carries it the way ADR 0029 has it carry an opcode table — ours, generated
 * rather than typed, and checked for length against TOTAL_SECTIONS so a table
 * that drifts fails loudly instead of quietly renumbering every section after
 * the drift.
 *
 * Read from ScummVM's \`engines/sword1/staticres.cpp\` with the ids resolved
 * through \`swordres.h\`. A zero means the section has no resource of that kind,
 * which is normal — 40 of the 150 sections are unused, and the mega sections
 * (128-134) have compacts but no scripts of their own.
 */

/** How many sections Broken Sword declares. A section is a resource group. */
export const SWORD1_SECTIONS = ${TOTAL_SECTIONS};
`;

const body = `
/** Section -> the compact (object) resource holding that section's objects. */
export const SWORD1_SECTION_COMPACTS: readonly number[] = [
${rows(objectList, 8)}
];

/** Section -> the script resource its objects' bytecode lives in. */
export const SWORD1_SECTION_SCRIPTS: readonly number[] = [
${rows(scriptList, 8)}
];

/**
 * Section -> text resource, one per language, in \`SWORD1_LANGUAGES\` order.
 *
 * A release ships the languages it was localised for and the rest of the row is
 * a resource the RIF does not hold — which is why \`SwordResources\` answers a
 * missing text resource with null rather than throwing. The Portuguese column
 * is the known case: ScummVM notes a build with six language groups being asked
 * for the seventh.
 */
export const SWORD1_SECTION_TEXT: readonly (readonly number[])[] = [
${textList.map((row) => `  [${row.map(hex).join(', ')}],`).join('\n')}
];
`;

writeFileSync(OUT, `${header}${body}`);

const mcodeFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * The mcode table: what Broken Sword's bytecode calls each of its hundred
 * machine-code routines. \`interpretScript\` reads a *number* (\`IT_MCODE\`
 * carries the index and the argument count), so the names live in the
 * interpreter rather than in the game — ADR 0029's exact case for a table being
 * ours.
 *
 * The argument count is **not** here, and deliberately: Broken Sword encodes it
 * in the instruction beside the mcode number, so it is read rather than tabled.
 * That is what makes this family's bytecode splittable into instructions
 * without a table — the property \`CONTEXT.md\` calls out for the SCUMM Stack
 * encoding and for the PMachine, and the reason Decompilation is available here.
 *
 * Read from ScummVM's \`engines/sword1/logic.cpp\`.
 */

/** The hundred mcodes, indexed by the number \`IT_MCODE\` carries. */
export const SWORD1_MCODE_NAMES: readonly string[] = [
${mcodeNames.map((name) => `  '${name}',`).join('\n')}
];

/** How many mcodes the table declares. A call above this is a decoding fault. */
export const SWORD1_MCODE_COUNT = SWORD1_MCODE_NAMES.length;

/** \`fnWalk\` for 69, or \`mcode69\` when the number is outside the table. */
export function sword1McodeName(number: number): string {
  return SWORD1_MCODE_NAMES[number] ?? \`mcode\${number}\`;
}
`;

writeFileSync(MCODE_OUT, mcodeFile);

// ---------------------------------------------------------------------------
// The mcode parameter names
// ---------------------------------------------------------------------------

/**
 * What each mcode calls its arguments, read from the mcode's own definition.
 *
 * `IT_MCODE` carries a number and an argument count, so a disassembler can say
 * `fnWalk(384, 216, 3, 0)` without help. What it cannot say without help is
 * that 384 is an x coordinate and 3 is a direction — the names live in
 * Revolution's interpreter exactly the way the mcode names do, so they are
 * generated here on the same footing (ADR 0029) rather than typed into the
 * editor.
 *
 * Every definition has the same shape:
 *
 * ```c
 * int Logic::fnWalk(Object *cpt, int32 id, int32 x, int32 y, int32 dir, int32 stance, int32 a, int32 b)
 * ```
 *
 * `cpt` and `id` are the interpreter's, not the script's: the six that follow
 * are what the script pushed, in push order. Where the author did not care, the
 * parameter is a single letter — `a, b, c, d, e, f, z` throughout, and `x` in
 * the trailing slot. Those are emitted as an empty string, because "this
 * argument has no name" is a fact worth carrying: an editor showing `z` as a
 * field label would be worse than one showing `argument 4`.
 *
 * The one meaningful pair of single letters is `x, y`, which is why the rule is
 * "a single letter is a placeholder unless it is an `x` immediately followed by
 * a `y`" rather than "a single letter is a placeholder". `fnWalk`,
 * `fnStandAt` and `fnFaceXy` are the three that depend on it.
 */
const PLACEHOLDER_PARAMS = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'z']);

function mcodeParams(name: string): string[] {
  // `Object *cpt, int32 id` in ninety-nine of the hundred and `Object
  // *compact, int id` in the other two: the two fixed leading parameters are
  // matched by shape rather than by spelling, so one renamed argument in
  // ScummVM does not read here as a missing definition.
  const pattern = new RegExp(
    `^int Logic::${name}\\(Object \\*\\w+, int(?:32)? \\w+,([^)]*)\\)`,
    'm',
  );
  const match = pattern.exec(logic);
  if (!match) fail(`no definition of ${name} in logic.cpp; the format has changed`);
  const raw = (match[1] as string)
    .split(',')
    .map((param) => param.trim().replace(/^int32\s+/, ''))
    .filter((param) => param.length > 0);
  if (raw.length !== 6) {
    fail(`${name} takes ${raw.length} script arguments, not six; the format has changed`);
  }
  return raw.map((param, at) => {
    if (param.length > 1) return param;
    if (param === 'x' && raw[at + 1] === 'y') return param;
    if (param === 'y' && raw[at - 1] === 'x') return param;
    if (PLACEHOLDER_PARAMS.has(param) || param === 'x' || param === 'y') return '';
    fail(`${name} has a parameter named "${param}", which is neither a name nor a placeholder`);
  });
}

const mcodeParamRows = mcodeNames.map(mcodeParams);

/**
 * The eight compass directions, which is what a `dir` argument may be.
 *
 * Here rather than in `swordDefs.ts` because it exists for exactly one reason:
 * a `dir` operand's editor is a list of eight choices, and typing that list out
 * is the thing ADR 0029 forbids. `sworddefs.h` is already read for the script
 * ids, so the names come from the same place the numbers do.
 */
const DIRECTION_SYMBOLS = [
  'UP',
  'UP_RIGHT',
  'RIGHT',
  'DOWN_RIGHT',
  'DOWN',
  'DOWN_LEFT',
  'LEFT',
  'UP_LEFT',
];
const directionNames = DIRECTION_SYMBOLS.map((symbol, expected) => {
  const value = defines.get(symbol);
  if (value === undefined) fail(`no ${symbol} in sworddefs.h; the format has changed`);
  if (value !== expected) fail(`${symbol} is ${value} and the table wants it at ${expected}`);
  return symbol.toLowerCase().replace('_', '-');
});
const namedParams = mcodeParamRows.flat().filter((param) => param.length > 0).length;

const paramFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * What each mcode calls its six arguments, so an editor can show a call as
 * named operands rather than as a row of numbers. \`IT_MCODE\` carries the
 * argument *count*; what the arguments *mean* lived in Revolution's
 * interpreter, which is ADR 0029's case for a table being ours and generated.
 *
 * An empty string is an argument the source names with a placeholder letter —
 * \`a\`, \`b\`, \`c\`, \`d\`, \`e\`, \`f\`, \`z\`, or a trailing \`x\`. It is kept in the
 * row rather than dropped so that argument 3 stays argument 3: the index into
 * this row is the index into the call's arguments.
 *
 * ${namedParams} of the ${mcodeParamRows.length * 6} argument slots have a name.
 *
 * Read from the mcode definitions in ScummVM's \`engines/sword1/logic.cpp\`.
 */

/** Mcode number -> its six argument names, empty where the source has none. */
export const SWORD1_MCODE_PARAMS: readonly (readonly string[])[] = [
${mcodeParamRows.map((row) => `  [${row.map((param) => `'${param}'`).join(', ')}],`).join('\n')}
];

/** \`'dir'\` for argument 2 of \`fnWalk\`, or null where the source names none. */
export function sword1McodeParamName(mcode: number, index: number): string | null {
  const name = SWORD1_MCODE_PARAMS[mcode]?.[index];
  return name ? name : null;
}

/**
 * The eight compass directions by number, which is what a \`dir\` argument is.
 *
 * Generated from the same \`sworddefs.h\` the script ids come from, and checked
 * on generation to run 0..7 in that order — a rotated table would be an editor
 * that quietly turns every mega the wrong way.
 */
export const SWORD1_DIRECTION_NAMES: readonly string[] = [
${directionNames.map((name) => `  '${name}',`).join('\n')}
];
`;

writeFileSync(PARAM_OUT, paramFile);

// ---------------------------------------------------------------------------
// The room definition table
// ---------------------------------------------------------------------------

/**
 * `_roomDefTable[TOTAL_ROOMS]` — per screen: its size, its layer and grid
 * resources, its two palettes and its two parallax layers.
 *
 * The same standing as the section tables above and for the same reason: the
 * RIF says where a layer resource is, not that screen 1's background *is* that
 * resource. Revolution's interpreter held this and so does this project.
 */
function roomTableBody(): string {
  const start = staticres.indexOf('_roomDefTable[TOTAL_ROOMS]');
  if (start < 0) fail('no _roomDefTable in staticres.cpp; the format has changed');
  const open = staticres.indexOf('{', start);
  // The table's own closing brace is the first `};` at column zero after it.
  const close = staticres.indexOf('\n};', open);
  if (open < 0 || close < 0) fail("_roomDefTable's table is not braced as expected");
  return staticres.slice(open + 1, close);
}

/** Splits a braced list into its top-level `{ … }` groups. */
function braceGroups(body: string): string[] {
  const groups: string[] = [];
  let depth = 0;
  let from = -1;
  for (let at = 0; at < body.length; at++) {
    const ch = body[at];
    if (ch === '{') {
      if (depth === 0) from = at + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && from >= 0) {
        groups.push(body.slice(from, at));
        from = -1;
      }
    }
  }
  return groups;
}

interface RoomDef {
  totalLayers: number;
  sizeX: number;
  sizeY: number;
  gridWidth: number;
  layers: number[];
  grids: number[];
  palettes: number[];
  parallax: number[];
}

function parseRooms(): RoomDef[] {
  const rooms: RoomDef[] = [];
  for (const group of braceGroups(stripComments(roomTableBody()))) {
    const inner = braceGroups(group);
    // Four scalars before the first inner brace, then four braced lists.
    const scalarPart = group.slice(0, group.indexOf('{'));
    const scalars = scalarPart
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => resolve(entry, '_roomDefTable'));
    if (scalars.length !== 4) {
      fail(`a _roomDefTable entry has ${scalars.length} scalars before its lists, not 4`);
    }
    if (inner.length !== 4) {
      fail(`a _roomDefTable entry has ${inner.length} braced lists, not 4`);
    }
    const list = (index: number, want: number): number[] => {
      const values = (inner[index] as string)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .map((entry) => resolve(entry, '_roomDefTable'));
      // C zero-fills a short initialiser, and this table relies on it
      // constantly — `{room2_l0,room2_l1,room2_l2}` for a four-slot array.
      while (values.length < want) values.push(0);
      if (values.length > want)
        fail(`a _roomDefTable list has ${values.length} entries, not ${want}`);
      return values;
    };
    rooms.push({
      totalLayers: scalars[0] as number,
      sizeX: scalars[1] as number,
      sizeY: scalars[2] as number,
      gridWidth: scalars[3] as number,
      layers: list(0, 4),
      grids: list(1, 3),
      palettes: list(2, 2),
      parallax: list(3, 2),
    });
  }
  return rooms;
}

const rooms = parseRooms();
const TOTAL_ROOMS = 100;
if (rooms.length !== TOTAL_ROOMS) {
  fail(`_roomDefTable has ${rooms.length} entries and TOTAL_ROOMS is ${TOTAL_ROOMS}`);
}

const roomFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Broken Sword's room definition table: per screen, how big it is, which
 * resources its background and mask layers are, which grids mask them, which
 * two palettes light it and which parallax layers scroll over it.
 *
 * Carried for the same reason \`swordSections.ts\` is: \`swordres.rif\` says
 * where resource 0x04010004 lives, not that screen 1's background *is* that
 * resource. That mapping was Revolution's interpreter's, so it is ours.
 *
 * \`gridWidth\` is the width in 16-pixel blocks **including the off-screen
 * edges**, which is why it is not \`sizeX / 16\`: the layer grids are indexed
 * against an imaginary screen 128 pixels wider on each side, and using the
 * visible width instead shifts every mask by eight blocks.
 *
 * Read from ScummVM's \`engines/sword1/staticres.cpp\`.
 */

/** One screen's definition. Screen 0 is unused and is all zeroes. */
export interface Sword1RoomDef {
  /** Background plus mask layers. One means "no masking" (\`verticalMask\` returns). */
  readonly totalLayers: number;
  readonly sizeX: number;
  readonly sizeY: number;
  /** Width in 16-pixel grid blocks, off-screen edges included. */
  readonly gridWidth: number;
  /** Layer 0 is the background; 1..3 are the mask layers' block data. */
  readonly layers: readonly number[];
  /** One grid per mask layer, so \`totalLayers - 1\` of them are meaningful. */
  readonly grids: readonly number[];
  /** \`[background palette (0..183), sprite palette (184..255)]\`. */
  readonly palettes: readonly number[];
  readonly parallax: readonly number[];
}

/** How many screens the table declares. */
export const SWORD1_TOTAL_ROOMS = ${TOTAL_ROOMS};

export const SWORD1_ROOMS: readonly Sword1RoomDef[] = [
${rooms
  .map(
    (room) =>
      `  {\n` +
      `    totalLayers: ${room.totalLayers},\n` +
      `    sizeX: ${room.sizeX},\n` +
      `    sizeY: ${room.sizeY},\n` +
      `    gridWidth: ${room.gridWidth},\n` +
      `    layers: [${room.layers.map(hex).join(', ')}],\n` +
      `    grids: [${room.grids.map(hex).join(', ')}],\n` +
      `    palettes: [${room.palettes.map(hex).join(', ')}],\n` +
      `    parallax: [${room.parallax.map(hex).join(', ')}],\n` +
      `  },`,
  )
  .join('\n')}
];
`;

writeFileSync(ROOM_OUT, roomFile);

// ---------------------------------------------------------------------------
// Script variables: how many, what they are called, and which start non-zero
// ---------------------------------------------------------------------------

function defineIn(source: string, name: string): number {
  const match = new RegExp(`^#define\\s+${name}\\s+(\\d+)`, 'm').exec(source);
  if (!match) fail(`no ${name} define; the format has changed`);
  return Number(match[1]);
}

const numScriptVars = defineIn(logicHeader, 'NUM_SCRIPT_VARS');
const nonZeroScriptVars = defineIn(logicHeader, 'NON_ZERO_SCRIPT_VARS');

const initStart = logic.indexOf('_scriptVarInit[NON_ZERO_SCRIPT_VARS][2]');
if (initStart < 0) fail('no _scriptVarInit in logic.cpp; the format has changed');
const initBody = logic.slice(logic.indexOf('{', initStart) + 1, logic.indexOf('\n};', initStart));
const initPairs = braceGroups(stripComments(initBody)).map((group) => {
  const parts = group.split(',').map((entry) => Number(entry.trim()));
  if (parts.length !== 2 || parts.some((value) => !Number.isFinite(value))) {
    fail(`a _scriptVarInit entry is not a pair of numbers: {${group}}`);
  }
  return parts as [number, number];
});
if (initPairs.length !== nonZeroScriptVars) {
  fail(
    `_scriptVarInit has ${initPairs.length} entries and NON_ZERO_SCRIPT_VARS is ${nonZeroScriptVars}`,
  );
}

/** The `ScriptVariableNames` enum — what the game's own author called each global. */
const enumStart = sworddefs.indexOf('enum ScriptVariableNames {');
if (enumStart < 0) fail('no ScriptVariableNames enum in sworddefs.h; the format has changed');
const enumBody = sworddefs.slice(
  sworddefs.indexOf('{', enumStart) + 1,
  sworddefs.indexOf('\n};', enumStart),
);
const varNames: string[] = [];
for (const line of stripComments(enumBody).split(',')) {
  const name = line.trim().replace(/\s*=\s*\d+$/, '');
  if (name === '') continue;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    fail(`ScriptVariableNames has an entry this generator cannot read: "${name}"`);
  varNames.push(name);
}
if (varNames.length === 0) fail('no entries in ScriptVariableNames');

const varFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Broken Sword's global script variables: how many there are, what Revolution
 * called them, and which of them do not start at zero.
 *
 * The names are the reason this file exists. \`IT_PUSHVARIABLE 147\` is what the
 * bytecode says, and a listing that prints \`147\` is a listing nobody can read;
 * printing \`ROOM_1_FLAG\` is the difference between Disassembly and
 * Decompilation for this family. The names are interpreter knowledge (the
 * compiled scripts carry only numbers), so ADR 0029 puts them on our side of
 * the line.
 *
 * \`SWORD1_SCRIPT_VAR_INIT\` is the game's own starting world: 95 of the 1,179
 * globals are non-zero at a new game, and they are what decides which screen
 * the game opens on. Without them a new game starts nowhere.
 *
 * Read from ScummVM's \`engines/sword1/logic.h\`, \`logic.cpp\` and
 * \`sworddefs.h\`.
 */

/** How many globals the interpreter carries. */
export const SWORD1_NUM_SCRIPT_VARS = ${numScriptVars};

/**
 * The names, in order, as far as Revolution named them.
 *
 * Shorter than \`SWORD1_NUM_SCRIPT_VARS\`: the enum names the globals the
 * scripts talk about and the tail is unnamed room flags. \`sword1ScriptVarName\`
 * answers \`var<n>\` past the end rather than an empty string, so a listing
 * always says something.
 */
export const SWORD1_SCRIPT_VAR_NAMES: readonly string[] = [
${varNames.map((name) => `  '${name}',`).join('\n')}
];

/** \`[variable, value]\` for each global that is non-zero at a new game. */
export const SWORD1_SCRIPT_VAR_INIT: readonly (readonly [number, number])[] = [
${initPairs.map(([variable, value]) => `  [${variable}, ${value}],`).join('\n')}
];

/** \`SCREEN\` for 18, or \`var900\` past the end of the names. */
export function sword1ScriptVarName(number: number): string {
  return SWORD1_SCRIPT_VAR_NAMES[number] ?? \`var\${number}\`;
}
`;

writeFileSync(VAR_OUT, varFile);

// ---------------------------------------------------------------------------
// The menu tables: what an inventory icon and a conversation subject look like
// ---------------------------------------------------------------------------

/**
 * `_objectDefs` and `_subjectList`, read from `staticres.cpp`.
 *
 * The same standing as every table above. An inventory item's icon resource and
 * its "use" script are the interpreter's knowledge: the game's scripts say
 * \`fnAddObject 7\`, and which picture that draws and what clicking it runs
 * lived in Revolution's menu code.
 */
const menu = read('engines', 'sword1', 'menu.cpp');
void menu;

function bracedTable(name: string, source: string): string[] {
  const start = source.indexOf(name);
  if (start < 0) fail(`no ${name} table in staticres.cpp; the format has changed`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  if (open < 0 || close < 0) fail(`${name}'s table is not braced as expected`);
  return braceGroups(stripComments(source.slice(open + 1, close)));
}

const objectDefs = bracedTable('Menu::_objectDefs', staticres).map((group) => {
  const values = group
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => resolve(entry, '_objectDefs'));
  while (values.length < 5) values.push(0);
  if (values.length !== 5) fail(`a _objectDefs entry has ${values.length} fields, not 5`);
  return values;
});

const subjectList = bracedTable('Menu::_subjectList', staticres).map((group) => {
  const values = group
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => resolve(entry, '_subjectList'));
  while (values.length < 2) values.push(0);
  if (values.length !== 2) fail(`a _subjectList entry has ${values.length} fields, not 2`);
  return values;
});

const TOTAL_POCKETS = 52;
if (objectDefs.length !== TOTAL_POCKETS + 1) {
  fail(
    `_objectDefs has ${objectDefs.length} entries and TOTAL_pockets + 1 is ${TOTAL_POCKETS + 1}`,
  );
}

const menuFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Broken Sword's menu tables: what each of the 52 inventory pockets looks like
 * and what clicking it runs, and what each conversation subject's icon is.
 *
 * Interpreter knowledge, like every other table this generator writes. A script
 * says \`fnAddObject 7\`; which picture that puts in the inventory bar, which
 * luggage cursor it becomes when picked up, and which script runs when it is
 * combined with something else all lived in Revolution's menu code rather than
 * in the game's data.
 *
 * Subjects are numbered from \`BASE_SUBJECT\` (256), so \`SWORD1_SUBJECTS[0]\`
 * is subject 256 — the offset is the caller's to apply and
 * \`sword1Subject()\` applies it.
 *
 * Read from ScummVM's \`engines/sword1/staticres.cpp\`.
 */

/** One inventory pocket: its icon, its luggage cursor and its use script. */
export interface Sword1MenuObject {
  /** The text id of its name, for the "look at" description. */
  readonly textDesc: number;
  readonly bigIconRes: number;
  readonly bigIconFrame: number;
  readonly luggageIconRes: number;
  readonly useScript: number;
}

/** One conversation subject's icon. */
export interface Sword1Subject {
  readonly subjectRes: number;
  readonly frameNo: number;
}

/** How many inventory pockets there are. Entry 0 is unusable. */
export const SWORD1_TOTAL_POCKETS = ${TOTAL_POCKETS};

/** Conversation subject numbering starts here. */
export const SWORD1_BASE_SUBJECT = 256;

export const SWORD1_MENU_OBJECTS: readonly Sword1MenuObject[] = [
${objectDefs
  .map(
    (fields) =>
      `  { textDesc: ${fields[0]}, bigIconRes: ${hex(fields[1] as number)}, ` +
      `bigIconFrame: ${fields[2]}, luggageIconRes: ${hex(fields[3] as number)}, ` +
      `useScript: ${fields[4]} },`,
  )
  .join('\n')}
];

export const SWORD1_SUBJECTS: readonly Sword1Subject[] = [
${subjectList
  .map((fields) => `  { subjectRes: ${hex(fields[0] as number)}, frameNo: ${fields[1]} },`)
  .join('\n')}
];

/** The subject entry for a subject *number*, which starts at 256. */
export function sword1Subject(subject: number): Sword1Subject | undefined {
  return SWORD1_SUBJECTS[subject - SWORD1_BASE_SUBJECT];
}
`;

writeFileSync(MENU_OUT, menuFile);

// ---------------------------------------------------------------------------
// The sound-effect table
// ---------------------------------------------------------------------------

/**
 * `_fxList` — per effect number: which sample, how it plays, and where.
 *
 * A script says `fnPlayFx 42`; which sample that is, whether it loops, and how
 * loud it should be in each room it can be heard from, all lived in
 * Revolution's own `fx_list.c`. Interpreter knowledge, so it is ours (ADR 0029).
 *
 * A `SampleId` is three numbers — the resource, and the two cluster/section
 * halves the original uses to find it — and a `RoomVol` is a room with a left
 * and a right volume. Seven of each per entry, zero-filled.
 */
/**
 * `#define FX_NEWTON {0x0C,0x07,0x06}` — a sample id is a braced triple, so
 * these need their own map: `resolve` reads scalars and would see the brace.
 */
const tripleDefines = new Map<string, number[]>();
const triplePattern = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+\{([^}]*)\}\s*$/gm;
for (let match = triplePattern.exec(swordres); match; match = triplePattern.exec(swordres)) {
  const values = (match[2] as string)
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((value) => Number.isFinite(value));
  if (values.length === 3) tripleDefines.set(match[1] as string, values);
}

const fxGroups = bracedTable('Sound::_fxList', staticres);

interface FxEntry {
  sampleId: number[];
  type: number;
  delay: number;
  roomVol: number[][];
}

const fxList: FxEntry[] = fxGroups.map((group) => {
  const body = stripComments(group).trim();

  // The sample id comes first and is either a literal triple or a symbol that
  // expands to one. Both shapes appear in the shipped table.
  let sampleId: number[];
  let rest: string;
  const braced = /^\{([^{}]*)\}\s*,?/.exec(body);
  if (braced) {
    sampleId = (braced[1] as string)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => resolve(entry, '_fxList sampleId'));
    while (sampleId.length < 3) sampleId.push(0);
    rest = body.slice(braced[0].length);
  } else {
    const symbol = /^([A-Za-z_][A-Za-z0-9_]*)\s*,?/.exec(body);
    if (!symbol) fail(`an _fxList entry does not start with a sample id: ${body.slice(0, 40)}`);
    const triple = tripleDefines.get(symbol[1] as string);
    if (!triple) fail(`_fxList names ${symbol[1]}, which is not a braced triple in swordres.h`);
    sampleId = triple;
    rest = body.slice(symbol[0].length);
  }

  // Then the two scalars, then the room/volume list.
  const listAt = rest.indexOf('{');
  const scalarText = listAt >= 0 ? rest.slice(0, listAt) : rest;
  const scalars = scalarText
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => resolve(entry, '_fxList'));
  const type = scalars[0] ?? 0;
  const delay = scalars[1] ?? 0;

  // Two levels: the list's own braces, then a triple per room. One call to
  // `braceGroups` returns the outer list's contents, so the triples need a
  // second.
  const outerList = listAt >= 0 ? (braceGroups(rest.slice(listAt))[0] ?? '') : '';
  const roomVol = braceGroups(outerList).map((triple) => {
    const values = triple
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map((entry) => resolve(entry, '_fxList roomVol'));
    while (values.length < 3) values.push(0);
    return values.slice(0, 3);
  });

  return { sampleId, type, delay, roomVol };
});

const fxFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Broken Sword's sound-effect table: what \`fnPlayFx <n>\` plays.
 *
 * Interpreter knowledge, like every other table this generator writes. The
 * scripts carry effect *numbers*; which sample each one is, whether it loops or
 * fires once or fires at random, and how loud it is in each room it carries
 * into all lived in Revolution's \`fx_list.c\`.
 *
 * The room/volume list is the part worth knowing about: an effect is not simply
 * "on" in one room. A river heard from the bank and from the bridge has two
 * entries with different left and right volumes, which is how the original
 * panned without positional audio.
 *
 * Read from ScummVM's \`engines/sword1/staticres.cpp\`.
 */

/** How an effect plays. */
export const Sword1FxType = {
  SPOT: 1,
  LOOP: 2,
  RANDOM: 3,
} as const;

/** One room this effect is audible in, and how loud on each side. */
export interface Sword1RoomVolume {
  readonly room: number;
  readonly leftVolume: number;
  readonly rightVolume: number;
}

export interface Sword1FxDef {
  /**
   * The sample, as Revolution's \`SampleId\`: a cluster and two indexes.
   *
   * Two indexes and not one, because the Windows demo renumbered its samples:
   * \`idStd\` is every other release's and \`idWinDemo\` is the demo's. The
   * resource id is assembled as \`cluster << 24 | index\`, and an index of
   * 0xFF means "this release does not ship this effect" — which is a real case
   * and the reason \`sword1SampleId\` can answer null.
   */
  readonly cluster: number;
  readonly idStd: number;
  readonly idWinDemo: number;
  readonly type: number;
  /** A frame delay for a spot effect, or a random chance for a random one. */
  readonly delay: number;
  readonly rooms: readonly Sword1RoomVolume[];
}

export const SWORD1_FX: readonly Sword1FxDef[] = [
${fxList
  .map(
    (fx) =>
      `  {\n` +
      `    cluster: ${fx.sampleId[0]},\n` +
      `    idStd: ${fx.sampleId[1]},\n` +
      `    idWinDemo: ${fx.sampleId[2]},\n` +
      `    type: ${fx.type},\n` +
      `    delay: ${fx.delay},\n` +
      `    rooms: [${fx.roomVol
        .filter((triple) => triple[0] !== 0)
        .map(
          (triple) => `{ room: ${triple[0]}, leftVolume: ${triple[1]}, rightVolume: ${triple[2]} }`,
        )
        .join(', ')}],\n` +
      `  },`,
  )
  .join('\n')}
];

/** How many effects the table declares. Above this is a decoding fault. */
export const SWORD1_FX_COUNT = SWORD1_FX.length;

/**
 * The resource id of an effect's sample, or null when this release has none.
 *
 * \`cluster << 24\` and not \`(cluster + 1) << 24\`: the fx table's cluster
 * byte is already the id's top byte, unlike \`rif.ts\`'s zero-based cluster
 * index. Adding one here would address the cluster after the right one.
 */
export function sword1SampleId(fxNo: number, windowsDemo = false): number | null {
  const fx = SWORD1_FX[fxNo];
  if (!fx) return null;
  const index = windowsDemo ? fx.idWinDemo : fx.idStd;
  if (index === 0xff || fx.cluster === 0) return null;
  return (fx.cluster << 24) | index;
}
`;

writeFileSync(FX_OUT, fxFile);

// ---------------------------------------------------------------------------
// The cutscene names
// ---------------------------------------------------------------------------

/**
 * `sequenceList` — what `fnPlaySequence <n>` names on disc.
 *
 * Sword2 needs no equivalent: its own `fnPlaySequence` takes the filename as a
 * pushed string, so the game carries it. Sword1 carries a number and the names
 * lived in the interpreter, which is ADR 0029's line again.
 */
const animation = read('engines', 'sword1', 'animation.cpp');
const seqStart = animation.indexOf('sequenceList[');
if (seqStart < 0) fail('no sequenceList in animation.cpp; the format has changed');
const seqBody = animation.slice(
  animation.indexOf('{', seqStart),
  animation.indexOf('};', seqStart),
);
const sequenceNames = [...seqBody.matchAll(/"([^"]*)"/g)].map((match) => match[1] as string);
if (sequenceNames.length === 0) fail('no sequence names found; the format has changed');

writeFileSync(
  SEQ_OUT,
  `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * What \`fnPlaySequence <n>\` names on disc. The scripts carry a *number* and
 * the names lived in Revolution's interpreter, so this project carries them —
 * ADR 0029's line, for the fifth table in this family.
 *
 * Broken Sword II needs no equivalent: its own \`fnPlaySequence\` takes the
 * filename as a pushed string, so the game carries it there.
 *
 * Read from ScummVM's \`engines/sword1/animation.cpp\`.
 */

/** Sequence number -> base filename, without an extension. */
export const SWORD1_SEQUENCE_NAMES: readonly string[] = [
${sequenceNames.map((name) => `  '${name}',`).join('\n')}
];

/** The name for a sequence number, or null when there is none. */
export function sword1SequenceName(sequence: number): string | null {
  return SWORD1_SEQUENCE_NAMES[sequence] ?? null;
}
`,
);

// ---------------------------------------------------------------------------
// The music filenames
// ---------------------------------------------------------------------------

/**
 * `_tuneList` — what `fnPlayMusic <n>` is called on disc.
 *
 * The same case as `sequenceList` above, and it was worth finding: a script
 * says `fnPlayMusic 8` and the file is `MUSIC/1M10.WAV`. Nothing in the shipped
 * game connects the two — `swordres.rif` indexes clusters and music is not in
 * one — so the mapping lived in Revolution's interpreter and is ours to carry.
 * Building a path out of the number instead, which is what this engine used to
 * do, looks for `MUSIC/8.WAV` and finds nothing in any release.
 *
 * Read from ScummVM's `engines/sword1/staticres.cpp`.
 */
const tuneStart = staticres.indexOf('_tuneList[TOTAL_TUNES]');
if (tuneStart < 0) fail('no _tuneList in staticres.cpp; the format has changed');
const tuneBody = staticres.slice(
  staticres.indexOf('{', tuneStart),
  staticres.indexOf('};', tuneStart),
);
const tuneNames = [...stripComments(tuneBody).matchAll(/"([^"]*)"/g)].map(
  (match) => match[1] as string,
);
if (tuneNames.length === 0) fail('no tune names found; the format has changed');

writeFileSync(
  TUNE_OUT,
  `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Tune number -> the base filename it is stored under, without an extension.
 *
 * \`fnPlayMusic\` carries a number and the release carries \`MUSIC/1M10.WAV\`;
 * this table is the only thing that joins them, and it lived in Revolution's
 * interpreter rather than in the game (ADR 0029). An empty entry is a number
 * the original left spare.
 *
 * Broken Sword II needs no equivalent: its music is a \`WAV_FILE\` resource
 * addressed by id, so the game carries the mapping itself.
 *
 * Read from ScummVM's \`engines/sword1/staticres.cpp\`.
 */

/** Tune number -> base filename, without an extension. Empty where spare. */
export const SWORD1_TUNE_NAMES: readonly string[] = [
${tuneNames.map((name) => `  '${name}',`).join('\n')}
];

/** The base filename for a tune number, or null where the number is spare. */
export function sword1TuneName(tune: number): string | null {
  return SWORD1_TUNE_NAMES[tune] || null;
}
`,
);

// ---------------------------------------------------------------------------
// The start positions
// ---------------------------------------------------------------------------

/**
 * `_startData` and `_helperData` — what a new game *does* before it draws.
 *
 * The flattest statement of ADR 0029's line in this family. `swordres.rif`
 * says where every resource is and the compacts say what every object is; not
 * one byte of the shipped game says that a new game puts George at 481,413
 * facing down on floor 1 of section 1. That was a table in Revolution's
 * interpreter, and without it the engine boots with `SCREEN` still at its
 * uninitialised zero and draws a black rectangle.
 *
 * The arrays are written through macros (`GEORGE_POS`, `LOGIC_SET_VAR8`, …)
 * that expand to a little bytecode of their own, so this expands the macros
 * rather than reading numbers: the operand widths are the macro's, and a
 * generator that guessed them would emit a stream whose every instruction after
 * the first is misaligned.
 *
 * Symbols come from three places and all three are resolved rather than
 * assumed — `#define`s already in `defines`, the `ScriptVariableNames` enum
 * (which is what a `LOGIC_SET_VAR*` names), and the two enums in `logic.h`.
 * An unknown symbol fails the run, because a zero here is a start position
 * that silently puts George nowhere.
 */

/** Every entry of a C enum, by name, honouring an explicit `= n`. */
function enumValues(source: string, name: string): Map<string, number> {
  const start = source.indexOf(`enum ${name} {`);
  if (start < 0) fail(`no ${name} enum; the format has changed`);
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('\n};', start));
  const values = new Map<string, number>();
  let next = 0;
  for (const entry of stripComments(body).split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(trimmed);
    if (assigned) {
      const value = evaluate(assigned[2] as string);
      if (value === null) fail(`${name}.${assigned[1]} has a value this generator cannot read`);
      values.set(assigned[1] as string, value);
      next = value + 1;
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      fail(`${name} has an entry this generator cannot read: "${trimmed}"`);
    }
    values.set(trimmed, next);
    next++;
  }
  return values;
}

const startOpcodes = enumValues(logicHeader, 'StartPosOpcodes');
const helperScripts = enumValues(logicHeader, 'HelperScripts');
const scriptVarValues = enumValues(sworddefs, 'ScriptVariableNames');

/**
 * A symbol inside a start-position array.
 *
 * `#define`s win over enum entries, and a name that is both with *different*
 * values fails the run rather than picking one — that collision is exactly the
 * kind of thing a hand-typed table gets wrong and never notices.
 */
function resolveStart(token: string, where: string): number {
  const trimmed = token.trim();
  if (/^-?(0[xX][0-9a-fA-F]+|\d+)$/.test(trimmed)) return Number(trimmed);
  const defined = defines.get(trimmed);
  const enumerated =
    startOpcodes.get(trimmed) ?? helperScripts.get(trimmed) ?? scriptVarValues.get(trimmed);
  if (defined !== undefined && enumerated !== undefined && defined !== enumerated) {
    fail(`${where} names ${trimmed}, which is a #define (${defined}) and an enum (${enumerated})`);
  }
  const value = defined ?? enumerated;
  if (value === undefined) fail(`${where} names ${trimmed}, which nothing in sword1 defines`);
  return value;
}

const u8 = (value: number): number[] => [value & 0xff];
const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];
const u24 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
const u32 = (value: number): number[] => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];

function opcode(name: string): number {
  const value = startOpcodes.get(name);
  if (value === undefined) fail(`logic.h's StartPosOpcodes has no ${name}`);
  return value;
}

/**
 * The macro expansions, straight off `staticres.cpp`'s own `#define` block.
 *
 * Kept as data rather than as a switch so that the operand widths sit beside
 * each other and can be read against the C in one glance. A width wrong here is
 * a stream that decodes as noise from that instruction on.
 */
const startMacros: Record<string, { arity: number; emit: (args: number[]) => number[] }> = {
  INIT_SEQ_END: { arity: 0, emit: () => [opcode('opcSeqEnd')] },
  LOGIC_CALL_FN: {
    arity: 2,
    emit: (a) => [opcode('opcCallFn'), ...u8(a[0] as number), ...u8(a[1] as number)],
  },
  LOGIC_CALL_FN_LONG: {
    arity: 4,
    emit: (a) => [
      opcode('opcCallFnLong'),
      ...u8(a[0] as number),
      ...u32(a[1] as number),
      ...u32(a[2] as number),
      ...u32(a[3] as number),
    ],
  },
  LOGIC_SET_VAR8: {
    arity: 2,
    emit: (a) => [opcode('opcSetVar8'), ...u16(a[0] as number), ...u8(a[1] as number)],
  },
  LOGIC_SET_VAR16: {
    arity: 2,
    emit: (a) => [opcode('opcSetVar16'), ...u16(a[0] as number), ...u16(a[1] as number)],
  },
  LOGIC_SET_VAR32: {
    arity: 2,
    emit: (a) => [opcode('opcSetVar32'), ...u16(a[0] as number), ...u32(a[1] as number)],
  },
  GEORGE_POS: {
    arity: 4,
    emit: (a) => [
      opcode('opcGeorge'),
      ...u16(a[0] as number),
      ...u16(a[1] as number),
      ...u8(a[2] as number),
      ...u24(a[3] as number),
    ],
  },
  RUN_START_SCRIPT: {
    arity: 1,
    emit: (a) => [opcode('opcRunStart'), ...u8(a[0] as number)],
  },
  RUN_HELPER_SCRIPT: {
    arity: 1,
    emit: (a) => [opcode('opcRunHelper'), ...u8(a[0] as number)],
  },
};

/** Splits a macro's argument list on commas that are not inside brackets. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const ch = text[at];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(from, at));
      from = at + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** Arrays that end in neither a terminator nor a tail jump. See below. */
const unterminated: string[] = [];

/** Expands one `const uint8 g_name[] = { … };` body into its bytes. */
function startArrayBytes(name: string): number[] {
  const start = staticres.indexOf(`const uint8 ${name}[]`);
  if (start < 0) fail(`no ${name} in staticres.cpp; the format has changed`);
  const open = staticres.indexOf('{', start);
  const close = staticres.indexOf('\n};', open);
  if (open < 0 || close < 0) fail(`${name} is not braced as expected`);
  const body = stripComments(staticres.slice(open + 1, close));

  const bytes: number[] = [];
  const invocation = /([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^()]*)\))?/g;
  for (let match = invocation.exec(body); match; match = invocation.exec(body)) {
    const macro = startMacros[match[1] as string];
    if (!macro) fail(`${name} uses ${match[1]}, which is not one of staticres.cpp's macros`);
    const args = match[3] === undefined ? [] : splitArguments(match[3]);
    if (args.length !== macro.arity) {
      fail(`${name}: ${match[1]} takes ${macro.arity} arguments and was given ${args.length}`);
    }
    bytes.push(...macro.emit(args.map((argument) => resolveStart(argument, `${name}`))));
  }
  if (bytes.length === 0) fail(`${name} expanded to nothing`);
  /*
   * A program ends either in INIT_SEQ_END or in a tail jump — `opcRunStart`
   * and `opcRunHelper` assign to the original's data pointer rather than
   * calling, so a third of these arrays end with RUN_HELPER_SCRIPT and never
   * reach an opcSeqEnd of their own.
   *
   * **And two end in neither**, which is recorded rather than fixed. ScummVM's
   * `runStartScript` loops on `while (*data != opcSeqEnd)` with no bound, so an
   * array with no terminator walks into whichever array the linker put next —
   * so these two are a latent defect in the reference rather than a shape this
   * generator should accept silently or paper over by appending a byte the
   * source does not have. They are emitted exactly as written; the interpreter
   * stops at the end of the array, which is the only safe reading.
   */
  const last = bytes[bytes.length - 1];
  const tail = bytes[bytes.length - 2];
  if (
    last !== opcode('opcSeqEnd') &&
    tail !== opcode('opcRunStart') &&
    tail !== opcode('opcRunHelper')
  ) {
    unterminated.push(name);
  }
  return bytes;
}

/** `_startData[]` — one entry per section, `NULL` where the game has none. */
function pointerTable(declaration: string): Array<string | null> {
  const start = staticres.indexOf(declaration);
  if (start < 0) fail(`no ${declaration} in staticres.cpp; the format has changed`);
  const body = staticres.slice(staticres.indexOf('{', start) + 1, staticres.indexOf('\n};', start));
  // Comments are stripped *first*: the unsupported entries are written
  // `NULL, //g_startPos6,` and reading the commented-out name as the entry
  // would turn every hole into a start position the demo cannot run.
  return stripComments(body)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => (entry === 'NULL' || entry === 'nullptr' ? null : entry));
}

const startNames = pointerTable('const uint8 *const Logic::_startData[]');
const helperNames = pointerTable('const uint8 *const Logic::_helperData[]');
if (startNames.length === 0) fail('_startData is empty');
if (helperNames.length !== helperScripts.size) {
  fail(
    `_helperData has ${helperNames.length} entries and HelperScripts names ${helperScripts.size}`,
  );
}
if (helperNames.some((entry) => entry === null)) fail('_helperData has a NULL entry');

const startData = startNames.map((entry) => (entry === null ? null : startArrayBytes(entry)));
const helperData = helperNames.map((entry) => startArrayBytes(entry as string));

/** `0x01, 0x02, …`, wrapped, for a byte array literal. */
function byteRows(values: number[]): string {
  const out: string[] = [];
  for (let at = 0; at < values.length; at += 16) {
    out.push(
      `    ${values
        .slice(at, at + 16)
        .map((byte) => `0x${byte.toString(16).padStart(2, '0')}`)
        .join(', ')},`,
    );
  }
  return out.join('\n');
}

const startFile = `/**
 * GENERATED by \`npm run gen:sword1-tables\`. Do not edit by hand.
 *
 * Broken Sword's start positions: what a new game does before it draws.
 *
 * This is the flattest case ADR 0029 has in this family. \`swordres.rif\` says
 * where every resource lives and the compacts say what every object is; not one
 * byte of the shipped game says that a new game stands George at 481,413 facing
 * down on floor 1 and then enters section 1. That lived in Revolution's own
 * interpreter, and an engine without it boots with \`SCREEN\` at its
 * uninitialised zero and draws a black rectangle.
 *
 * ## It is a bytecode, and a second one
 *
 * Not the script bytecode \`SwordInterpreter\` runs — a much smaller language
 * with eight opcodes, whose whole job is to set globals and place the player.
 * It is carried as *bytes* rather than as decoded steps on purpose: the widths
 * are the original's macros' (\`GEORGE_POS\` writes a 24-bit place, and
 * nothing else in this family writes a 24-bit anything), and a table of decoded
 * steps would put this generator's reading of those widths beyond the reach of
 * the test that checks them.
 *
 * \`opcRunStart\` and \`opcRunHelper\` **replace** the stream rather than
 * calling into it — the original assigns to its data pointer and does not
 * return — so they are tail jumps and anything after one is unreachable.
 *
 * Read from ScummVM's \`engines/sword1/staticres.cpp\` and \`logic.h\`.
 */

/** The eight opcodes of the start-position language, and the five \`opcCallFn\` ids. */
export const Sword1StartOpcode = {
${[...startOpcodes].map(([name, value]) => `  ${name}: ${value},`).join('\n')}
} as const;

/** \`HELP_SPAIN2\` and its six siblings, indexes into \`SWORD1_HELPER_DATA\`. */
export const Sword1HelperScript = {
${[...helperScripts].map(([name, value]) => `  ${name}: ${value},`).join('\n')}
} as const;

/**
 * Section -> its start-position program, or null where the game supports none.
 *
 * ${startData.filter((entry) => entry !== null).length} of the ${startData.length} entries are programs; the rest are sections a
 * boot parameter cannot start in, which the original refuses by name.
 */
export const SWORD1_START_DATA: readonly (readonly number[] | null)[] = [
${startData
  .map((bytes, section) =>
    bytes === null ? `  null, // ${section}` : `  // ${section}\n  [\n${byteRows(bytes)}\n  ],`,
  )
  .join('\n')}
];

/** The seven helper programs, run on top of a start position that asks for one. */
export const SWORD1_HELPER_DATA: readonly (readonly number[])[] = [
${helperData
  .map((bytes, index) => `  // ${helperNames[index]}\n  [\n${byteRows(bytes)}\n  ],`)
  .join('\n')}
];

/** The highest section a boot parameter may name. */
export const SWORD1_MAX_START_POSITION = ${startData.length - 1};

/**
 * Programs that carry no terminator at all: ${unterminated.length === 0 ? 'none' : unterminated.join(', ')}.
 *
 * Recorded rather than repaired. The reference's \`runStartScript\` loops on
 * \`while (*data != opcSeqEnd)\` with no bound, so in C these run off the end
 * of their own array into whatever the linker placed next. This project stops
 * at the end of the array instead, which is the only reading that is safe and
 * the only one that is the same on every build.
 */
export const SWORD1_UNTERMINATED_START_DATA: readonly string[] = [
${unterminated.map((name) => `  '${name}',`).join('\n')}
];
`;

writeFileSync(START_OUT, startFile);

// Formatted the way every other file here is, or every regeneration shows up as
// a formatting diff and `npm run format:check` fails on generated output.
execFileSync(
  'npx',
  [
    'prettier',
    '--write',
    OUT,
    MCODE_OUT,
    ROOM_OUT,
    VAR_OUT,
    MENU_OUT,
    FX_OUT,
    SEQ_OUT,
    START_OUT,
    PARAM_OUT,
    TUNE_OUT,
  ],
  { stdio: 'inherit' },
);

process.stdout.write(
  `wrote ${OUT} (${objectList.length} sections), ${MCODE_OUT} (${mcodeNames.length} mcodes), ` +
    `${ROOM_OUT} (${rooms.length} rooms), ${VAR_OUT} (${numScriptVars} vars, ` +
    `${varNames.length} named, ${initPairs.length} non-zero) and ${MENU_OUT} ` +
    `(${objectDefs.length} pockets, ${subjectList.length} subjects) and ${FX_OUT} ` +
    `(${fxList.length} effects) and ${START_OUT} ` +
    `(${startData.filter((entry) => entry !== null).length} of ${startData.length} start positions, ` +
    `${helperData.length} helpers) and ${PARAM_OUT} (${namedParams} named arguments) and ` +
    `${TUNE_OUT} (${tuneNames.filter((name) => name !== '').length} tunes)\n`,
);
