/**
 * Exports a real game with nothing edited, and checks it came back unchanged.
 *
 *   npm run reexport -- games/loom
 *   npm run reexport -- games/fate --sweep
 *
 * `CONTEXT.md` makes byte-identity a property of **unmodified** resources, and
 * four issues turn that into the same acceptance criterion in four places: an
 * exported, unedited v2, v3, v4 or v8 game is byte-identical to its input. That
 * was asserted against synthetic fixtures and against nothing else, which is
 * Tier 1 with Tier 1's trap — the fixture encodes this project's reading of the
 * format, so an export that agrees with it may still disagree with a game.
 *
 * A shipped install is the thing a fixture cannot be. Loom CD has 1032 scripts,
 * a `000.LFL` index, a `DISK01.LEC` container and four charset files kept
 * outside it under a different key; Fate of Atlantis is 2200 scripts in one
 * `LECF`. Reading either and writing it back is the whole import-export
 * pipeline against data nobody here wrote.
 *
 * Like `sweep` and `unrecovered`, it cannot run in CI: `games/` is gitignored
 * and stays that way.
 *
 * **What it does not do.** It does not edit anything. An *edited* export is
 * different bytes by definition, so its correctness is a claim about the game
 * still running, and running is what Tier 2 and the sweep are for — this tool
 * answers the narrower question that has an exact answer.
 */
import { resolve } from 'node:path';

import { exportEditedFiles } from '../src/authoring/exportEdits.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { formatSweepReport, sweepGame } from '../src/engine/sweep.js';
import { openGame } from '../src/hosting/openGame.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));
const path = resolve(positional[0] ?? '.');

/** `--sweep` runs the standing sweep over the *exported* game as well. */
const alsoSweep = flags.includes('--sweep');

const source = await openGame(path);
const log: string[] = [];
const engine = await ScummEngine.create(source, { onLog: (message) => log.push(message) });

const { originals } = await engine.toEditableGame({ progress: new LoadProgressTracker() });
if (!originals) {
  console.error(`${path} imported without the originals an export is written from.`);
  process.exit(1);
}

console.log(`${engine.targetName} "${engine.gameId}" — ${originals.layout}, re-exporting ${path}`);

const written = exportEditedFiles(originals, []);

/**
 * The first difference in a file, as an offset rather than a boolean.
 *
 * An offset is what makes a failure actionable: a mismatch at byte 0 is a key
 * or a header, one at the first directory entry is a width, and one deep in the
 * data is a single resource that moved.
 */
function firstDifference(mine: Uint8Array, theirs: Uint8Array): number | null {
  const shared = Math.min(mine.length, theirs.length);
  for (let index = 0; index < shared; index++) {
    if (mine[index] !== theirs[index]) return index;
  }
  return mine.length === theirs.length ? null : shared;
}

let differed = 0;
const exported: Array<[string, Uint8Array]> = [];

for (const file of written) {
  const original = await source.read(file.name);
  exported.push([file.name, file.data]);

  if (!original) {
    console.log(`  ${file.name}: written, but not present in the input`);
    differed++;
    continue;
  }

  const at = firstDifference(file.data, original);
  if (at === null) {
    console.log(`  ${file.name}: identical (${original.length} bytes)`);
    continue;
  }

  differed++;
  console.log(
    `  ${file.name}: differs at byte ${at} ` +
      `(${original.length} bytes in, ${file.data.length} out)`,
  );
}

console.log(
  differed === 0
    ? `\nAll ${written.length} files came back byte-identical.`
    : `\n${differed} of ${written.length} files changed with nothing edited.`,
);

if (alsoSweep) {
  // The stronger half, and the reason it is worth reloading rather than only
  // comparing: a game can be byte-identical and still have been read wrongly,
  // and it can differ in one padding byte and run perfectly. Comparing answers
  // the first; running the export answers the second.
  const replayLog: string[] = [];
  const reloaded = await ScummEngine.create(new MemoryDataSource(`${path} (exported)`, exported), {
    onLog: (message) => replayLog.push(message),
  });

  console.log(`\nSweeping the exported game.`);
  const report = sweepGame(reloaded, replayLog);
  console.log(`Settled in room ${report.settledInRoom}.`);
  console.log(formatSweepReport(report));

  process.exit(differed === 0 && report.findings.length === 0 ? 0 : 1);
}

process.exit(differed === 0 ? 0 : 1);
