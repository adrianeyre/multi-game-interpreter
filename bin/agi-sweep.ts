/**
 * A static sweep of every Logic in an AGI game.
 *
 *   npm run sweep:agi -- games/kq3
 *   npm run sweep:agi -- games/kq3 --interpreter=2917
 *
 * ## What it answers, and why it is static
 *
 * The same question `sweep:sci` asks and for the same reason (#219): AGI's
 * characteristic failure is not a crash, it is **a misread instruction
 * boundary**. An argument count off by one produces a listing that looks like
 * instructions, decompiles to a tree that looks like code, and re-emits to
 * bytes that match — because the emitter uses the same wrong table. Nothing
 * about engine state will show it. Decompiling every Logic and reporting what
 * could not be read will.
 *
 * So this reports three things, each a different kind of fact:
 *
 * - **The arity probe**, per candidate table: which tables this game's own
 *   bytecode admits, and which it rules out. That is the measurement ADR 0013's
 *   refusal turns on, published rather than described.
 * - **Unrecovered Logics**, in this project's own sense: one that would not
 *   decompile, or that re-emitted as different bytes than it arrived as. The
 *   target is zero and the fix is always a better decompiler.
 * - **Opcodes reached**, so an instruction the tables know and the interpreter
 *   does not is named before a player finds it.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */

import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import { probeArityTable } from '../src/engine/agi/resource/arityProbe.js';
import { decompileLogic } from '../src/authoring/agi/decompileLogic.js';
import { disassembleLogic } from '../src/authoring/agi/disassembleLogic.js';
import { opcodeSetFor } from '../src/engine/agi/script/opcodes.js';
import {
  describeTarget,
  formatInterpreterVersion,
  type InterpreterVersion,
  type Target,
} from '../src/authoring/target.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const path = args.find((argument) => !argument.startsWith('--'));
if (!path) {
  console.error('Usage: npm run sweep:agi -- <game> [--interpreter=2917]');
  process.exit(1);
}

/**
 * `--interpreter=2917` sweeps under a table you name rather than the game's.
 *
 * Worth having because the probe's answer is sometimes two tables, and the
 * useful next question is what each of them makes of the game.
 */
const declared = flags
  .find((flag) => flag.startsWith('--interpreter='))
  ?.slice('--interpreter='.length);

const source = await openGame(resolve(path));
const detected = await detectAgiGame(source);
const resources = await AgiResources.load(source, detected, { onLog: () => undefined });
const logics = resources.list('logic');

if (detected.target.engine !== 'agi') throw new Error('Not an AGI game.');

const probe = probeArityTable({
  major: detected.layout.major,
  platform: detected.target.platform,
  gameId: detected.id,
  logics,
  read: (logic) => resources.read('logic', logic),
  encrypted: (logic) => !resources.wasCompressed('logic', logic),
});

const interpreter: InterpreterVersion = declared
  ? (Number.parseInt(declared, 16) as InterpreterVersion)
  : (probe.survivors[0]?.interpreter ?? detected.target.interpreter);

const target: Target = { ...detected.target, interpreter };
const opcodes = opcodeSetFor(target);

console.log(
  `${describeTarget(target)} "${detected.id}" — ${logics.length} Logics, ` +
    `${resources.list('picture').length} Pictures, ${resources.list('view').length} Views, ` +
    `${resources.list('sound').length} Sounds`,
);
console.log(`\nThe arity table, probed against the game's own bytecode:`);
for (const note of probe.notes) console.log(`  ${note}`);
if (declared) {
  console.log(`  swept under ${formatInterpreterVersion(interpreter)}, named on the command line`);
}

/** Opcode numbers met, so a report can name what a game actually reaches. */
const reached = new Map<string, number>();
const unrecovered: string[] = [];
let instructions = 0;
let statements = 0;

for (const number of logics) {
  const bytes = resources.read('logic', number);
  const encryptedMessages = !resources.wasCompressed('logic', number);

  const listing = disassembleLogic(bytes, target, { opcodes, encryptedMessages });
  instructions += listing.instructions.length;
  for (const instruction of listing.instructions) {
    reached.set(instruction.name, (reached.get(instruction.name) ?? 0) + 1);
    for (const condition of instruction.conditions ?? []) {
      reached.set(condition.name, (reached.get(condition.name) ?? 0) + 1);
    }
  }

  const result = decompileLogic(bytes, target, { encryptedMessages });
  if (result.unrecovered) unrecovered.push(`logic ${number}: ${result.unrecovered}`);
  else statements += result.tree?.statements.length ?? 0;
}

const say = (ok: boolean, label: string, detail = ''): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail}`);
};

/**
 * A narrowing is not a failure, and `sweep:sci` already draws this line.
 *
 * Two surviving arity tables is a gap in what this project can establish from
 * the bytes in front of it, not a fault in what it read — the same distinction
 * the SCI sweep makes for a Kernel slot it has no name for. Printing FAIL
 * beside it invites someone to go looking for a bug that is not there.
 */
const note = (label: string, detail = ''): void => {
  console.log(`  note ${label}${detail}`);
};

console.log(
  `\n${instructions} instructions decoded, ${statements} top-level statements decompiled, ` +
    `${reached.size} distinct commands reached`,
);
console.log();
say(unrecovered.length === 0, `Unrecovered Logics: ${unrecovered.length}`);
for (const line of unrecovered.slice(0, 12)) console.log(`         ${line}`);
if (probe.survivors.length === 1) {
  say(true, `arity tables the bytecode admits: 1 — identified by probe`);
} else if (probe.survivors.length > 1) {
  note(
    `arity tables the bytecode admits: ${probe.survivors.length} ` +
      `(${probe.survivors.map((c) => formatInterpreterVersion(c.interpreter)).join(', ')}) — ` +
      `narrowed, not identified`,
  );
} else {
  say(false, 'arity tables the bytecode admits: 0 — every candidate contradicts the game');
}

/**
 * The commands the game reaches that carry no operands in this build's table.
 *
 * Not a fault on its own — plenty of AGI commands take none — but it is the
 * shape a misread table leaves behind, so it is worth having in the report
 * beside the probe rather than only in it.
 */
const unknown = [...reached.keys()].filter((name) => name.startsWith('unknown'));
say(
  unknown.length === 0,
  `commands with no entry in this table: ${unknown.length}`,
  unknown.length ? ` (${unknown.join(', ')})` : '',
);

if (unrecovered.length > 12) {
  console.log(`\n${unrecovered.length - 12} more Unrecovered Logics not listed.`);
}
