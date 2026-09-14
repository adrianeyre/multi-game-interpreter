/**
 * Exports an AGI game with nothing edited, and checks every resource came back
 * as the bytes it arrived as.
 *
 *   npm run reexport:agi -- games/kq3 --interpreter=2089
 *   npm run reexport:agi -- /tmp/fixtures/agi-v2 --interpreter=2917 --files
 *
 * The sibling of `npm run reexport`, which does this for SCUMM, and the second
 * half of the question `npm run sweep:agi` asks. The sweep decompiles each
 * Logic and re-emits **that Logic** to compare it; this rebuilds the whole
 * install and then reads it back, so a Logic that survives its own round trip
 * and is then written to the wrong offset, indexed under the wrong volume or
 * obfuscated with the wrong key is caught here and nowhere else.
 *
 * ## Resources, not files — and that is the bar, not a softening of it
 *
 * `CONTEXT.md` defines **Unrecovered** as a *resource* that "re-emitted as
 * different bytes than it arrived as", and the word is resource on purpose.
 * `exportAgiGame` writes one `VOL.0`, by design: a game that shipped four
 * volumes is repacked into one, so every directory entry's volume number and
 * offset legitimately changes and comparing `VOL.0` to `VOL.0` reports a
 * failure that is not one. King's Quest III is the case — 78,782 bytes of
 * `VOL.0` in, 650,064 out, and not one Logic altered.
 *
 * So this exports, opens the export as a game, and compares **resource against
 * resource**: every Logic, Picture, View and Sound read back through the same
 * reader the engine uses. The file table is still printed, under `--files`,
 * because repackaging is worth seeing — it is just not the thing that fails a
 * run.
 *
 * ## What it does not do
 *
 * It does not edit anything. An *edited* export is different bytes by
 * definition, so its correctness is a claim about the game still running, and
 * running is what Tier 2 and `npm run shot:agi` are for. This answers the
 * narrower question that has an exact answer.
 *
 * ## Why it can refuse before it starts
 *
 * ADR 0013: an AGI game whose interpreter version fell back to a guess **plays**
 * on that guess and is **refused for editing**, because an argument count is not
 * in the bytecode. `importAgiGame` enforces that, so this tool inherits the
 * refusal rather than working around it — and `--interpreter=` is the declared
 * path out, which is a person stating a version they know rather than the engine
 * inferring one it does not.
 *
 * Note what that means for the check itself: re-emitting under a *wrong*
 * declared table writes the misreading back byte for byte and this tool passes.
 * Byte-identity establishes that nothing was lost, not that anything was
 * understood — `CONTEXT.md` says so under **Unrecovered**, and it is why
 * `sweep:agi`'s arity probe belongs beside this number rather than instead of
 * it.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */
import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import { exportAgiGame } from '../src/authoring/agi/exportAgiGame.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import {
  AGI_PLATFORMS,
  DEFAULT_AGI_INTERPRETER,
  describeTarget,
  type AgiPlatform,
} from '../src/authoring/target.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

const path = positional[0];
if (!path) {
  console.error(
    'Usage: npm run reexport:agi -- <game> [--interpreter=2917] [--platform=dos] [--files]',
  );
  process.exit(1);
}

/**
 * `--interpreter=2917` declares a build, which is ADR 0013's `declared` path.
 *
 * Written the way `sweep:agi` takes it — bare hex digits, `2917` for 2.917 and
 * `3149` for 3.002.149 — so the two commands in one matrix row are not spelled
 * two different ways.
 */
const declaredDigits = flags
  .find((flag) => flag.startsWith('--interpreter='))
  ?.slice('--interpreter='.length);
const declaredPlatform = flags
  .find((flag) => flag.startsWith('--platform='))
  ?.slice('--platform='.length) as AgiPlatform | undefined;

if (declaredPlatform && !AGI_PLATFORMS.includes(declaredPlatform)) {
  console.error(`--platform must be one of ${AGI_PLATFORMS.join(', ')}.`);
  process.exit(1);
}

const declaredInterpreter = declaredDigits
  ? { interpreter: Number.parseInt(declaredDigits, 16), platform: declaredPlatform ?? 'dos' }
  : undefined;

/** `--files` prints the file table as well, which repackaging makes noisy. */
const showFiles = flags.includes('--files');

const RESOURCE_KINDS = ['logic', 'picture', 'view', 'sound'] as const;
type ResourceKind = (typeof RESOURCE_KINDS)[number];

const source = await openGame(resolve(path));
const detectedInput = await detectAgiGame(source, declaredInterpreter);
const engine = await AgiEngine.create(source, {
  onLog: () => undefined,
  ...(declaredInterpreter ? { declaredInterpreter } : {}),
});

const refusal = engine.describeEditRefusal();
if (refusal) {
  console.error(`${path} cannot be edited, so it cannot be re-exported.\n`);
  console.error(refusal);
  console.error('\nDeclare a build with --interpreter= to export under a named table.');
  process.exit(1);
}

const project = await engine.toEditableGame({ progress: new LoadProgressTracker() });
const target = project.project.target;
console.log(`${describeTarget(target)} "${project.project.name}" — re-exporting ${path}`);

const result = exportAgiGame(project.project);
for (const error of result.errors) console.error(`  error: ${error}`);
for (const warning of result.warnings) console.log(`  warning: ${warning}`);

/**
 * The export, opened as a game.
 *
 * Detected rather than assumed, which is a check in itself: an export whose
 * directory files no longer look like an AGI install fails here, before a
 * single resource is compared.
 */
const exported = new MemoryDataSource(`${path} (re-exported)`);
for (const file of result.files) exported.set(file.name, file.data);

/**
 * The export is re-opened under a **v2** build, whatever the input was.
 *
 * `exportAgiGame` always writes v2 packaging — four `*DIR` files and `VOL.0` —
 * and says so: v3 changes packaging only, the resources are identical either
 * way, and the AGI Specification states a v3 game converts to the v2 format.
 * So re-opening a v3 game's export under its own v3 build asks a v3 reader for
 * a v2 volume: the header widths differ, the sizes read as nonsense, and the
 * report blames the exporter for the tool's own pairing. That happened while
 * this file was being written, and the wrong reading was `picture 1 claims 4080
 * stored bytes from a 298 byte volume`.
 *
 * The build named here is arbitrary and has to be: an arity table decides how
 * a Logic *decodes* and nothing about how a resource is found or unpacked, and
 * this comparison is bytes against bytes with nothing decoded. What matters is
 * that the major matches the packaging in front of the reader.
 *
 * Which makes the v3 row a slightly different claim, and the report should say
 * it plainly: for a v3 game this measures that every resource survives the
 * conversion to v2 packaging, because that conversion is what an export is.
 */
const reopened = await detectAgiGame(exported, {
  interpreter: DEFAULT_AGI_INTERPRETER,
  platform: declaredPlatform ?? 'dos',
});
const before = await AgiResources.load(source, detectedInput, { onLog: () => undefined });
const after = await AgiResources.load(exported, reopened, { onLog: () => undefined });

if (detectedInput.layout.major === 3) {
  console.log(
    '  note  the input is v3 packaging and an export is always v2, so the files below are\n' +
      '        a conversion rather than a rewrite — the resources are what is compared',
  );
}

function firstDifference(a: Uint8Array, b: Uint8Array): number | null {
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at++) if (a[at] !== b[at]) return at;
  return a.length === b.length ? null : shared;
}

let identical = 0;
const differing: string[] = [];
const lost: string[] = [];
const perKind = new Map<ResourceKind, { identical: number; total: number }>();

for (const kind of RESOURCE_KINDS) {
  const numbers = before.list(kind);
  const tally = { identical: 0, total: numbers.length };
  perKind.set(kind, tally);

  for (const number of numbers) {
    const original = before.read(kind, number);
    let rebuilt: Uint8Array | null;
    try {
      rebuilt = after.read(kind, number);
    } catch (error) {
      // A resource the export indexed and cannot read back is a worse fault
      // than one that came back different, and it reads as an exception rather
      // than as a mismatch, so it is caught rather than allowed to end the run
      // on the first instance.
      lost.push(
        `${kind} ${number}: could not be read from the export — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    if (!rebuilt) {
      lost.push(`${kind} ${number}: absent from the export`);
      continue;
    }

    const at = firstDifference(rebuilt, original);
    if (at === null) {
      identical++;
      tally.identical++;
    } else {
      differing.push(
        `${kind} ${number}: ${rebuilt.length} bytes out, ${original.length} in — ` +
          `first difference at ${at}`,
      );
    }
  }
}

const total = [...perKind.values()].reduce((sum, tally) => sum + tally.total, 0);
console.log(
  `\n${total} resources compared — ${identical} byte-identical, ` +
    `${differing.length} differing, ${lost.length} unreadable from the export`,
);
for (const kind of RESOURCE_KINDS) {
  const tally = perKind.get(kind)!;
  if (tally.total === 0) continue;
  const ok = tally.identical === tally.total;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${kind.padEnd(8)} ${tally.identical}/${tally.total} byte-identical`,
  );
}
for (const line of differing.slice(0, 10)) console.log(`        ${line}`);
if (differing.length > 10) console.log(`        …and ${differing.length - 10} more`);
for (const line of lost.slice(0, 10)) console.log(`        ${line}`);

const unrecovered = project.project.agi?.logics.filter((logic) => logic.unrecovered) ?? [];
console.log(
  `\n  ${unrecovered.length === 0 ? 'ok  ' : 'FAIL'} Unrecovered Logics: ${unrecovered.length}`,
);
for (const logic of unrecovered.slice(0, 10)) {
  console.log(`        logic ${logic.number}: ${logic.unrecovered}`);
}

/**
 * The files, which are informational because repackaging is expected.
 *
 * `WORDS.TOK` and `OBJECT` are the two worth looking at even so: neither is a
 * numbered resource, so neither is in the comparison above, and both are
 * written from a parsed form rather than carried through.
 */
if (showFiles) {
  const inputFiles = new Map<string, Uint8Array>();
  for (const name of source.list()) {
    const bytes = await source.read(name);
    if (bytes) inputFiles.set(name.toUpperCase(), bytes);
  }

  console.log(`\n${result.files.length} files written:`);
  for (const file of result.files) {
    const original = inputFiles.get(file.name.toUpperCase());
    if (!original) {
      console.log(`  new   ${file.name.padEnd(16)} ${file.data.length} bytes, not in the input`);
      continue;
    }
    const at = firstDifference(file.data, original);
    console.log(
      at === null
        ? `  same  ${file.name.padEnd(16)} ${file.data.length} bytes`
        : `  differ ${file.name.padEnd(15)} ${file.data.length} out, ${original.length} in ` +
            `— first difference at ${at}`,
    );
  }

  const written = new Set(result.files.map((file) => file.name.toUpperCase()));
  const dropped = [...inputFiles.keys()].filter((name) => !written.has(name));
  if (dropped.length > 0) console.log(`  not written: ${dropped.join(', ')}`);
}

if (differing.length > 0 || lost.length > 0 || result.errors.length > 0) process.exit(1);
