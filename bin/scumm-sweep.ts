/**
 * Runs every verb handler on every object in every room of a real game.
 *
 *   npm run sweep -- games/fate
 *   npm run sweep -- games/fate --settle=20 --frames=8
 *
 * The tier between a synthetic fixture and a person playing the game, and #205
 * in full. The sweep itself is `src/engine/sweep.ts`; this file is the command
 * line around it — flags, the game, and printing. The split is what lets
 * `tests/sweep.test.ts` point the same code at every supported Target, which
 * is the criterion "it works for every supported Target, not just v5".
 *
 * It was invented once, as a one-off against Fate of Atlantis — 2675 handlers
 * across 750 objects in 96 rooms — and it found the pseudo-room fault that play
 * alone had not.
 *
 * Against a real game it cannot run in CI, for the reason nothing with real
 * data can: `games/` is gitignored and stays that way. It is a local tool, and
 * its output is what an issue quotes as evidence.
 */
import { resolve } from 'node:path';

import { ScummEngine } from '../src/engine/ScummEngine.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { formatSweepReport, sweepGame } from '../src/engine/sweep.js';
import { openGame } from '../src/hosting/openGame.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

function numberFlag(name: string, fallback: number): number {
  const found = flags.find((argument) => argument.startsWith(`--${name}=`));
  if (!found) return fallback;
  const value = Number(found.slice(name.length + 3));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const path = resolve(positional[0] ?? '.');

const settleFrames = numberFlag('settle', 12 * 60);
const handlerFrames = numberFlag('frames', 6);

/** `--room=42` sweeps one room, for chasing a finding back to its handler. */
const onlyRoom = numberFlag('room', 0);

/** `--verbose` prints a line per handler rather than only the findings. */
const verbose = flags.includes('--verbose');

/** `--strict` counts a script that spun as a finding rather than as expected. */
const strict = flags.includes('--strict');

const log: string[] = [];
const engine = await loadAdventureEngine(await openGame(path), {
  onLog: (message) => {
    log.push(message);
    if (verbose) console.log(`[log] ${message}`);
  },
});

if (!(engine instanceof ScummEngine)) {
  console.error(
    `${path} is not a SCUMM game. The sweep runs verb handlers on objects in ` +
      `rooms, which is SCUMM's object model; AGI has no equivalent surface — ` +
      `its behaviour is in Logic scripts a room runs, not in per-object ` +
      `handlers, so a sweep of it would be a different tool.`,
  );
  process.exit(1);
}

console.log(`${engine.targetName} "${engine.gameId}" — sweeping ${path}`);

const report = sweepGame(engine, log, {
  settleFrames,
  handlerFrames,
  onlyRoom,
  strict,
  onProgress: verbose ? (line) => console.log(line) : undefined,
});

console.log(`Settled after ${settleFrames} frames in room ${report.settledInRoom}.`);
console.log(formatSweepReport(report, strict));

process.exit(report.findings.length === 0 ? 0 : 1);
