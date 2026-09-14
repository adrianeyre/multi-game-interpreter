/**
 * Boots a real game headlessly and reports the state it reaches.
 *
 *   npm run diagnose -- ~/games/atlantis
 *   npm run diagnose -- ~/games/atlantis.zip 20
 *
 * The browser has the stall report, but reading it there means playing to the
 * point of the fault and copying text out of a log pane. This runs the same
 * descriptions over real game data in a couple of seconds, which is the
 * difference between diagnosing a fault and guessing at one: an engine defect
 * that only shows up on a shipped game cannot be reproduced against the test
 * fixture, because the fixture is built to be correct.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */
import { resolve } from 'node:path';

import { VAR } from '../src/engine/constants.js';
import { openGame } from '../src/hosting/openGame.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';

/**
 * The bit variables a script is spinning on, and whether anything set them.
 *
 * A SCUMM script waits by re-testing a bit every frame. When one never comes
 * true the game sits there with every script behaving correctly and nothing to
 * show for it, so the useful question is which bits the waiting scripts are
 * reading and what is in them.
 */
function describeWaitedBits(engine: ScummEngine, bits: number[]): string {
  if (bits.length === 0) return 'none named';
  return bits
    .map((bit) => `bit ${bit} = ${(engine.bitVariables[bit >> 3] >> (bit & 7)) & 1}`)
    .join(', ');
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const positional = args.filter((a) => !a.startsWith('--'));

const path = resolve(positional[0] ?? '.');
const seconds = Number(positional[1] ?? 12);

/** `--bits=35,36` reports those bit variables and logs anything that sets them. */
const watched = (flags.find((a) => a.startsWith('--bits='))?.slice('--bits='.length) ?? '')
  .split(',')
  .map((part) => part.trim())
  .filter((part) => part !== '')
  .map(Number)
  .filter((bit) => Number.isInteger(bit) && bit >= 0);

/** `--trace` logs every script start and stop. */
const trace = flags.includes('--trace');

/**
 * `--play` dismisses text windows as a player would, and types a line.
 *
 * Without it a diagnostic run stops at the first thing a game says, which looks
 * identical to being stuck and is the opposite: a window holds the cycle
 * *because* it is waiting for the player. AGI games talk before they hand over
 * control, so a run that cannot press a key cannot see past the opening
 * cutscene — and "reaches its first interactive room" is a question about what
 * happens after it.
 */
const play = flags.includes('--play');

/** `--say=open door` types a line once the game accepts input. */
const say = flags.find((argument) => argument.startsWith('--say='))?.slice('--say='.length) ?? '';

// Whichever family the files belong to. The shell already picks between them
// (ADR 0011), and a diagnostic that only read one would be no use against the
// half of the games it could not load.
const engine = await loadAdventureEngine(await openGame(path), {
  onLog: (message) => console.log(`[log] ${message}`),
});

// The SCUMM-specific switches, applied where they apply. A branch here is not
// the thing ADR 0011 forbids: that rule is about the *shell*, and this is a
// diagnostic whose whole job is to say family-specific things about a game.
if (engine instanceof ScummEngine) {
  for (const bit of watched) engine.watchedBits.add(bit);
  engine.traceScripts = trace;
} else if (watched.length > 0 || trace) {
  console.log('[log] --bits and --trace are SCUMM switches; this is not a SCUMM game.');
}

engine.boot();

/** Rooms the game passed through, so a run reports where it went. */
const visited: number[] = [engine.currentRoom];
let saidIt = false;

// Counted in sixtieths rather than in steps, because a step is not a fixed
// length of time: the game says how many sixtieths each of its cycles stands
// for, so `20` on the command line means twenty seconds of game time whatever
// rate the game happens to be running at.
for (let ticks = 0; ticks < Math.round(seconds * 60); ticks += engine.ticksPerStep) {
  if (play && engine instanceof ScummEngine) {
    // A player who has seen the intro presses escape. SCUMM only skips when
    // the game has armed a resume point, so this asks the engine whether the
    // scene is skippable rather than pressing hopefully every frame — and a
    // run that reaches a playable room only by skipping is worth telling apart
    // from one that gets there on its own.
    if (!engine.userPut && engine.scriptState.currentOverride.pointer >= 0) {
      engine.pressKey(engine.variables[engine.vars.CUTSCENEEXIT_KEY] || 27);
      engine.releaseKey();
      console.log(`[log] skipped the scene at frame ${engine.frame}`);
    }
  }

  if (play && engine instanceof AgiEngine) {
    // A player pressing a key at a text window. Through the engine's own input
    // path, so this exercises what a browser exercises.
    if (engine.isWaitingForKey) engine.pressKey(13);
    else if (say && !saidIt && engine.state.inputEnabled && engine.state.playerControl) {
      engine.submitLine(say);
      saidIt = true;
      console.log(`[log] typed "${say}"`);
    }
  }

  engine.step();

  if (engine.currentRoom !== visited[visited.length - 1]) {
    visited.push(engine.currentRoom);
    console.log(`[log] room ${engine.currentRoom}`);
  }
}
engine.render();

const report = [
  '',
  `${engine.targetName} "${engine.gameId}" — room ${engine.currentRoom} after ` +
    `${seconds}s (frame ${engine.frame})` +
    (engine instanceof ScummEngine ? `, ego is actor ${engine.variables[VAR.EGO]}` : ''),
  '',
  // Whatever the family says it is waiting on. For SCUMM that is actors,
  // objects, scripts and input; for AGI it is the room, the object table, the
  // set flags and the opcode ring buffer.
  `Rooms visited: ${visited.join(' -> ')}`,
  '',
  ...engine.describeStall().flatMap((line) => [line, '']),
  ...(engine instanceof ScummEngine
    ? [
        `Reachable: ${engine.describeTouchability()}`,
        '',
        `Waited bits: ${describeWaitedBits(engine, watched)}`,
      ]
    : []),
];
console.log(report.join('\n'));
