/**
 * Exports a SCI game with nothing edited, and checks every resource came back
 * as the bytes it arrived as.
 *
 *   npm run reexport:sci -- games/kq4
 *   npm run reexport:sci -- /tmp/fixtures/sci1-1 --version=sci1-1
 *
 * `npm run sweep:sci` decodes every Script resource and reports what it could
 * not read. That is half the editing question and it is the half that does not
 * involve a writer: a Script can decode perfectly and still be rebuilt wrong,
 * and nothing static will say so. This is the other half, and until it existed
 * SCI's round trip was checked by tests over a fixture and by throwaway scripts
 * over three demos — a true claim with no command behind it, which
 * `docs/processes/verifying-version-support.md` is explicit is how a claim
 * decays.
 *
 * ## The bar, in this project's own words
 *
 * `CONTEXT.md` defines **Unrecovered** as a resource that "could not be
 * Decompiled into editable structure, or that re-emitted as different bytes
 * than it arrived as", with a target of zero. So the comparison is per
 * resource, and every resource the Project carries is compared — not only the
 * Scripts. `exportSciGame` writes Views, Pictures, fonts, cursors and
 * `vocab.997` as well, and each of those has its own writer with its own way of
 * being wrong.
 *
 * ADR 0018's rule is what makes zero achievable rather than aspirational: an
 * **untouched script is not rebuilt**. The linker runs for the ones that
 * changed, and nothing here changes one, so a difference in this report is a
 * resource whose bytes were rewritten when they should have been carried, or
 * carried in a form that no longer reads back.
 *
 * ## The second half: packed, then read back
 *
 * This said Volumes were not compared, on the ground that "`RESOURCE.MAP` and
 * the Volumes are built by whoever is writing the game out" — which was true
 * while nobody wrote one. `packSciGame` does now, so the run has a second
 * stage: the resources that came out of the export are packed into an install
 * and read back through **`SciResources`**, the engine's own reader, rather
 * than through anything that knows how they were written.
 *
 * That direction is the whole point. A packer checked by its own idea of where
 * it put things agrees with itself about a map whose offsets are wrong; the
 * reader has been run against seventeen freely distributed Sierra demos and
 * their 4,157 resources, so a disagreement here is the writer's. The two
 * numbers stay separate in the report — a resource can survive the export and
 * be lost by the packer, and a single total would hide which.
 *
 * The packed install holds resources only. A game's video and audio Volumes
 * are carried through byte for byte rather than rebuilt (#227) and are named
 * rather than copied here, because copying a talkie's `RESOURCE.AUD` to
 * measure a map would read hundreds of megabytes to check nothing.
 *
 * ## Why a Version can be named
 *
 * ADR 0020: SCI stamps its Version nowhere, a resource map separates six
 * buckets and no more, and the finer seams are read from the game's own
 * resources by probe. When the probes leave more than one Version standing the
 * earliest is used, and `--version=` is the `declared` path — a person stating
 * a Version they know, against the same warning the editor gives.
 *
 * What that buys here is the whole reason the flag exists: the Version decides
 * the Kernel table, the Script layout and the Selector numbering, so exporting
 * the same bytes under two Versions asks two different questions of the same
 * writer. What it does not buy is safety — declaring the wrong Version and
 * getting byte-identity back means the misreading was written back faithfully,
 * which `CONTEXT.md` says under **Unrecovered** and is why `sweep:sci`'s
 * identification line belongs beside this number.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */
import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { packSciGame } from '../src/authoring/sci/packSciGame.js';
import { SCI_RESOURCE_TYPES } from '../src/engine/sci/resource/sciResourceTypes.js';
import { describeSciVersion, SCI_VERSIONS, type SciVersion } from '../src/engine/sci/sciVersion.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

const path = positional[0];
if (!path) {
  console.error('Usage: npm run reexport:sci -- <game> [--version=sci1-1] [--all]');
  process.exit(1);
}

const declared = flags.find((flag) => flag.startsWith('--version='))?.slice('--version='.length) as
  SciVersion | undefined;

if (declared && !SCI_VERSIONS.includes(declared)) {
  console.error(`--version must be one of:\n  ${SCI_VERSIONS.join('\n  ')}`);
  process.exit(1);
}

/** `--all` lists every differing resource rather than the first ten. */
const listAll = flags.includes('--all');

const source = await openGame(resolve(path));
const { game, resources } = await detectSciGame(source, { onLog: () => undefined });

/**
 * The declared Version replaces the detected one before the import reads a
 * byte.
 *
 * Before it, and not after: the Selector numbering, the Script layout and the
 * Kernel table are all decided from `game.version` while the Project is being
 * built, so a Version swapped in afterwards would describe an import that had
 * already happened under a different one.
 */
const version = declared ?? game.version;
const identification = declared ? 'declared' : game.identification;
const detectedNote =
  declared && declared !== game.version
    ? ` (detection said ${describeSciVersion(game.version)})`
    : '';

const project = await importSciGame({ ...game, version, identification }, resources);

console.log(
  `${describeSciVersion(version)} "${game.id}" — identified by ${identification}${detectedNote}`,
);
console.log(`re-exporting ${path}`);

const result = exportSciGame(project);
for (const problem of result.problems) console.log(`  problem: ${problem}`);

function firstDifference(a: Uint8Array, b: Uint8Array): number | null {
  const shared = Math.min(a.length, b.length);
  for (let at = 0; at < shared; at++) if (a[at] !== b[at]) return at;
  return a.length === b.length ? null : shared;
}

let identical = 0;
const differing: string[] = [];
const perType = new Map<string, { identical: number; total: number }>();

for (const [key, written] of result.resources) {
  const [type, digits] = key.split(':');
  const number = Number(digits);
  if (!SCI_RESOURCE_TYPES.includes(type as (typeof SCI_RESOURCE_TYPES)[number])) continue;

  const original = await resources.read(type as (typeof SCI_RESOURCE_TYPES)[number], number);
  if (!original) {
    // A resource the export wrote that the game does not hold. Nothing in an
    // unedited export should produce one, so it is a difference rather than a
    // category of its own.
    differing.push(`${key}: written by the export, absent from the game`);
    continue;
  }

  const tally = perType.get(type) ?? { identical: 0, total: 0 };
  tally.total++;

  const at = firstDifference(written, original);
  if (at === null) {
    identical++;
    tally.identical++;
  } else {
    differing.push(
      `${key}: ${written.length} bytes out, ${original.length} in — first difference at ${at}`,
    );
  }
  perType.set(type, tally);
}

const total = [...perType.values()].reduce((sum, tally) => sum + tally.total, 0);
console.log(
  `\n${total} resources compared — ${identical} byte-identical, ${differing.length} differing`,
);

for (const [type, tally] of [...perType].sort(([a], [b]) => a.localeCompare(b))) {
  const ok = tally.identical === tally.total;
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} ${type.padEnd(8)} ${tally.identical}/${tally.total} byte-identical`,
  );
}

const shown = listAll ? differing : differing.slice(0, 10);
for (const line of shown) console.log(`        ${line}`);
if (differing.length > shown.length) {
  console.log(`        …and ${differing.length - shown.length} more (--all lists them)`);
}

/**
 * Scripts rebuilt rather than carried through, which for an unedited export
 * should be none.
 *
 * ADR 0018 keeps an untouched script out of the linker entirely, so a non-zero
 * count here is a finding even when every byte still matches: it means
 * `isUntouched` decided a script had changed when nothing had, and the only
 * reason the bytes agree is that the linker happened to reproduce them.
 */
console.log(
  `\n  ${result.rebuilt.length === 0 ? 'ok  ' : 'FAIL'} scripts rebuilt by the linker: ` +
    `${result.rebuilt.length}${result.rebuilt.length ? ` (${result.rebuilt.slice(0, 12).join(', ')})` : ''}`,
);
console.log(
  `  ${result.recomposed.length === 0 ? 'ok  ' : 'FAIL'} cel Pictures recomposed: ` +
    `${result.recomposed.length}`,
);
console.log(`  note  ${result.carriedVolumes.length} Volumes carried through unrebuilt`);

/**
 * Packing, and then reading the packed install back through the engine.
 *
 * The map structure comes from the game rather than from its Version, and that
 * is not a shortcut around ADR 0020 — it is the one thing about a SCI container
 * that is never a guess. `detectMapVersion` reads it out of the map's own bytes
 * and returns null rather than guessing, while a Version is probed out of the
 * resources and may end as a bucket. `--version=` therefore changes how this
 * game is *read* and nothing about how it is packed.
 */
console.log(`\npacking ${result.resources.size} resources into a ${game.mapVersion} install`);
const packed = packSciGame(result.resources, { mapVersion: game.mapVersion, layout: game.layout });

for (const refusal of packed.refused) console.log(`  refused: ${refusal}`);

if (packed.files.length === 0) {
  console.log('\n  FAIL  nothing was packed, so there is no install to read back');
  process.exit(1);
}

console.log(
  `  wrote ${packed.mapFile} (${packed.files[0].data.length} bytes) and ` +
    `${packed.volumeFile} (${packed.volumeBytes} bytes, every resource uncompressed)`,
);

const packedSource = new MemoryDataSource(
  'packed',
  packed.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
);

const readBack = await detectSciGame(packedSource, { onLog: () => undefined });
console.log(
  `  read back as a ${readBack.game.mapVersion} map` +
    `${readBack.game.mapVersion === game.mapVersion ? '' : ` — and it went in as ${game.mapVersion}`}` +
    `, identified as ${describeSciVersion(readBack.game.version)}`,
);

let recovered = 0;
const lost: string[] = [];

for (const [key, written] of result.resources) {
  const [type, digits] = key.split(':');
  if (!SCI_RESOURCE_TYPES.includes(type as (typeof SCI_RESOURCE_TYPES)[number])) continue;
  const back = await readBack.resources.read(
    type as (typeof SCI_RESOURCE_TYPES)[number],
    Number(digits),
  );
  if (!back) {
    lost.push(`${key}: not in the packed install`);
    continue;
  }
  const at = firstDifference(written, back);
  if (at === null) recovered++;
  else lost.push(`${key}: ${back.length} bytes back, ${written.length} packed — differs at ${at}`);
}

console.log(
  `\n  ${lost.length === 0 ? 'ok  ' : 'FAIL'} ${recovered}/${result.resources.size} resources ` +
    `read back out of the packed install byte-identical`,
);
for (const line of listAll ? lost : lost.slice(0, 10)) console.log(`        ${line}`);
if (lost.length > 10 && !listAll) {
  console.log(`        …and ${lost.length - 10} more (--all lists them)`);
}
console.log(
  `  ${readBack.game.mapVersion === game.mapVersion ? 'ok  ' : 'FAIL'} the map structure ` +
    `survived the round trip`,
);

if (
  differing.length > 0 ||
  result.problems.length > 0 ||
  lost.length > 0 ||
  packed.refused.length > 0 ||
  readBack.game.mapVersion !== game.mapVersion
) {
  process.exit(1);
}
