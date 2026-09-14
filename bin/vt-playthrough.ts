/**
 * Drives a Virtual Theatre game as far as it will go, and says where it stopped.
 *
 *   npm run play:vt -- <game>
 *
 * ## What this is for
 *
 * `docs/processes/verifying-version-support.md` asks Tier 2 evidence to be "a
 * specific place in a specific game" rather than "it works". For every other
 * family here that has to be a person, because their games are not
 * redistributable. These two are, so this is the one harness in the project
 * that can make a Tier 2 claim on a build machine — and the one place that can
 * ever move **Completable** from aspiration to measurement (#266, ADR 0023).
 *
 * ## Where the two games reach today
 *
 * **Sky reaches `room`.** `SkyEngine` loads the game, applies its Release's
 * starting state and runs its scripts — around 770 script runs over 200 ticks —
 * until a background is drawn, `MOUSE_STATUS` says the pointer is live, and the
 * pointer engine finds hotspots on that screen: a named room with the player
 * nominally in control. What it cannot do is the first thing a player asks of a
 * room — go somewhere — and this tool now does that click and names what stops
 * it. The click itself runs to an end: `fnNormalMouse` and its cursor-family
 * neighbours are implemented, and `fnSaveCoods` freezes the pointer, so the
 * `mouseClick` script assigns the player a get-to and completes. `fnGetTo` now
 * runs too — it reads the mega's place's own get-to table (the game's named
 * `high_floor_table` for a floor-click) and hands the walk over to the script
 * that table names — so the stop has moved one call along, to `fnInteract`,
 * which is the next thing the base script does once the get-to returns. What is
 * still missing is the router the *walk* needs, `fnAr`, and the screen→grid map
 * it would read (#256). The stall report below names what, and how often.
 *
 * **Lure reaches `loaded`.** `LureEngine` reads the game and its initial world
 * state — resource 16398, the snapshot the executable restores into a new game
 * (ADR 0024) — but runs no scripts, because Lure's bytecode is a separate system
 * this project does not read yet (ADR 0026). A reader that reaches the world
 * state is an interpreter's foundation, which a container reader alone was not
 * (#263); running its scripts is what would move it to `booted`.
 *
 * ADR 0023's line is the rule this follows: "That opens the door; it does not
 * walk through it." **Nothing here prints the word Completable until a run
 * reaches a last screen**, and the reached-point below is written from what the
 * run actually did rather than from what the tool hoped for. Reaching a room is
 * not playing through one; the click below is the measurement of that gap.
 *
 * ## What each stage means
 *
 * Each stage below is a claim of a different size, and they are listed so that
 * a later run can report a bigger one without this file having to argue about
 * what counts:
 *
 * | Stage | What it means |
 * | --- | --- |
 * | `refused` | No family claimed the files, or the one that did would not load them |
 * | `loaded` | An Engine exists for these files |
 * | `booted` | The engine ran its opening script without stalling |
 * | `room` | A named room is on screen with the player in control |
 * | `last-screen` | The game's ending was reached — the only stage that supports **Completable** |
 */

import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { looksLikeSky } from '../src/engine/sky/resource/skyDetect.js';
import { SkyEngine } from '../src/engine/sky/SkyEngine.js';
import { looksLikeLure } from '../src/engine/lure/resource/lureDetect.js';

/** How far a run got, smallest first. Only the last supports Completable. */
type Stage = 'refused' | 'loaded' | 'booted' | 'room' | 'last-screen';

const path = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
if (!path) {
  console.error('Usage: npm run play:vt -- <game>');
  console.error('');
  console.error('Fetch a game first, if you have not:');
  console.error('  npm run fetch:vt');
  process.exit(1);
}

const source = await openGame(resolve(path));
const names = source.list();

const game = looksLikeSky(names)
  ? 'Beneath a Steel Sky'
  : looksLikeLure(names)
    ? 'Lure of the Temptress'
    : null;

if (!game) {
  console.error(`${source.label} holds neither Virtual Theatre game's files.`);
  process.exit(1);
}

console.log(`Playing ${game} from ${source.label}`);
console.log('');

let stage: Stage = 'refused';
let reached: string;

const ticks = Number(
  process.argv
    .slice(2)
    .find((a) => a.startsWith('--ticks='))
    ?.split('=')[1] ?? 200,
);
let stall: string[] = [];
let savedAndRestored: string | null = null;
/** What the first player action — a click to go somewhere — stopped on. */
let firstBlocked: string | null = null;

try {
  const engine = await loadAdventureEngine(source);
  stage = 'loaded';
  reached = `an Engine loaded: ${engine.constructor.name}`;

  engine.boot();

  for (let tick = 0; tick < ticks && !engine.hasQuit; tick += 1) {
    engine.step();
    engine.render();
  }

  // `booted` is a bigger claim than `loaded`: the engine ran its opening logic
  // and kept going. Promote to it only once the engine has actually advanced
  // under stepping. An engine that loads and reads its world but runs no scripts
  // — Lure today, whose bytecode this project does not read yet (ADR 0026) —
  // leaves `frame` at 0 and stays at `loaded`, which is the honest stage for it.
  if (engine.frame > 0) {
    stage = 'booted';
    reached = `booted, room ${engine.currentRoom}`;
  }

  // A save and a restore, on a world that has actually run. #258's round trip,
  // against a shipped game rather than a fixture: the Compact table's mutable
  // fields are the world, so this is the check that they survive.
  try {
    const before = engine.currentRoom;
    const saved = engine.saveState('playthrough');
    engine.loadState(saved);
    savedAndRestored =
      engine.currentRoom === before
        ? `saved and restored, room ${before} either side`
        : `saved at room ${before} and restored at ${engine.currentRoom} — they should match`;
  } catch (error) {
    savedAndRestored = `save round trip failed: ${(error as Error).message}`;
  }

  // And the other half of ADR 0012: a save is Target-tagged, so another
  // family's is refused rather than half-applied. Checked here rather than in a
  // unit test because it is the live engine's own guard that has to hold.
  try {
    const foreign = { ...engine.saveState('foreign'), gameId: 'monkey2' };
    engine.loadState(foreign);
    savedAndRestored += '; a SCUMM save was ACCEPTED, which it must not be';
  } catch {
    savedAndRestored += '; a save tagged for another game is refused';
  }

  stall = engine.describeStall();
  const status = engine.describeStatus();

  // A room means a named room on screen with the player in control, and one
  // family can now answer that. `SkyEngine` checks three things together — a
  // background is drawn, `MOUSE_STATUS` says the pointer is live, and the
  // pointer engine finds hotspots on that screen — so the rung is earned by a
  // measurement rather than by an engine existing.
  //
  // Asked of the engine rather than through `AdventureEngine`, because ADR
  // 0011 caps that interface and five families have left it alone. A second
  // family needing the same question is when it earns a place on the seam.
  const room = engine instanceof SkyEngine ? engine.describeRoom() : null;
  if (room) {
    stage = 'room';
    reached = `ran ${ticks} ticks and reached a room: ${room}`;
  } else {
    reached = status
      ? `ran ${ticks} ticks and did not get past: ${status}`
      : `ran ${ticks} ticks with nothing reported`;
  }

  // The first thing a player does in a room is click somewhere to go there, and
  // this is the one harness that can try it. Reaching a room says the scenery is
  // up and the pointer is live; it does not say a click does anything. So do the
  // click — on a hotspot the pointer engine actually found, preferring the floor
  // because clicking the floor is how Sky walks — and report what it stops on.
  //
  // This runs after the stage is fixed, on purpose: reaching the room is a real
  // rung and the click does not un-reach it. What the click stops on is a rung's
  // worth of new information — the first thing a player cannot do — reported on
  // its own line rather than folded into the stage.
  if (engine instanceof SkyEngine && stage === 'room') {
    const spots = engine.hotspots();
    /*
     * **Not the floor, and this was a real mismeasurement.** This preferred a
     * hotspot named "floor" on the reasoning that "clicking the floor is how
     * Sky walks", and it reported the click as "absorbed silently". It was not
     * absorbed: `floor` on screen 0 is place 17, which is where Foster is
     * already standing, so `fnGetTo` correctly picks the trivial already-here
     * get-to and the walk has nowhere to go. The tool was clicking the one
     * destination that does nothing and calling the result a fault.
     *
     * So try every hotspot the pointer engine found, and report the first that
     * is informative — a stop names what a player cannot do, which is what this
     * line is for. `menu_bar` is skipped: it is the verb bar rather than
     * somewhere to walk, and its own script wants `fnStartMenu`, which is a
     * different missing thing that would mask the walk.
     */
    const ordered = [
      ...spots.filter((spot) => !/floor|menu/i.test(spot.name)),
      ...spots.filter((spot) => /floor/i.test(spot.name)),
    ];
    let target = ordered[0];
    let stop: string | null = null;
    for (const candidate of ordered) {
      engine.input.x = candidate.x;
      engine.input.y = candidate.y;
      engine.input.clicks += 1;
      // The click's own `mouseClick` script runs on the first step and completes
      // — it freezes the pointer (`fnSaveCoods`) and assigns the player a get-to
      // base script (`fnAssignBase`). The walk that script starts runs on the
      // ticks *after*, so step on until something stops or a short budget runs
      // out. What stops it is the get-to chain — walking (#256) — reported on
      // its own line rather than folded into the stage.
      for (let after = 0; after < 30 && !stop; after += 1) {
        engine.step();
        engine.render();
        stop = engine.lastStop;
      }
      target = candidate;
      if (stop) break;
    }
    if (target) {
      firstBlocked = stop
        ? `clicking ${target.name} at (${target.x},${target.y}) runs its script to an end and ` +
          `starts the get-to it assigns, which stops on ${stop}`
        : `clicking ${target.name} at (${target.x},${target.y}) changed nothing and stopped ` +
          `on nothing — a click a player would expect to do something was absorbed silently`;
    }
  }
} catch (error) {
  reached = (error as Error).message;
}

console.log(`Stage reached: ${stage}`);
console.log(`  ${reached.split('\n')[0]}`);
if (savedAndRestored) {
  console.log(`  ${savedAndRestored}`);
}
if (firstBlocked) {
  console.log('');
  console.log('First thing a player cannot do:');
  console.log(`  ${firstBlocked}`);
}
if (stall.length > 0) {
  console.log('');
  console.log('What the engine says it is doing:');
  for (const line of stall) console.log(`  ${line}`);
}
console.log('');

if (stage !== 'last-screen') {
  console.log('Completable: NOT claimed.');
  console.log(
    `  A last screen was not reached, so nothing here supports the claim. What stopped it`,
  );
  console.log(`  is the line above, and docs/released-games.md says the same.`);
} else {
  console.log('Completable: reached the last screen.');
}

// A refusal is the honest state today rather than a failure of the harness, so
// this exits 0. It becomes a failure when an engine exists and stops loading —
// which is exactly when a CI run should start complaining.
process.exit(0);
