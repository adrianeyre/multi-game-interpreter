/**
 * Enters every room a SCI game declares and reports what each one drew.
 *
 *   npm run rooms:sci -- <game>
 *   npm run rooms:sci -- <game> --shots=out/rooms
 *   npm run rooms:sci -- <game> --rooms=35,1250,1400
 *   npm run rooms:sci -- <game> --fresh
 *
 * **The dynamic sweep `sci-sweep.ts` says comes second.** That file's header is
 * right that a static decode of every Script resource attacks SCI's
 * characteristic failure more directly — a Kernel table off by one produces a
 * game that runs and does the wrong things, and no report about engine state
 * shows it. What a static sweep cannot answer is the question this one is for:
 * **does a room draw?** That is a fault class of its own, named in
 * `docs/processes/verifying-version-support.md` — the game does the right thing
 * and the picture is wrong — and until this existed it was answered one room at
 * a time by looking at a PNG.
 *
 * ## How a room is entered, and why it is not by playing
 *
 * `newRoom` is sent to the game object directly rather than driven to through
 * the game's own front end. Playing to a room is the stronger evidence and it
 * does not scale: King's Quest VII's front end is four screens and a minute of
 * cycles before the first room, and a hundred rooms behind puzzles nobody here
 * has solved. Sending `newRoom` runs the room's **own** `init` — which is the
 * thing being measured — and one engine is reused across every room, so the
 * whole game is a couple of minutes rather than a couple of hours.
 *
 * What that does **not** prove is that a player can reach the room, and the
 * report says so rather than implying a playthrough.
 *
 * ## A room that was asked for is not a room that was entered
 *
 * **This is the trap, and the first version of this file fell into it.** A SCI
 * game may refuse a room and go somewhere else — King's Quest VII sends 98 of
 * its 108 to room 1000 when the chapter it belongs to has not been started —
 * and `newRoom` reports nothing about that. Read without checking, all 98
 * produced the *same* reading, 67.4% lit and 103 colours, and it was room
 * 1000's screen a hundred times over. The summary counted them as 98 rooms
 * drawing.
 *
 * So every room is checked against **global 13**, SCI's own current-room number
 * at every Version, and a room that landed somewhere else is counted as
 * redirected rather than as drawn. Only rooms that were actually entered are in
 * the drew and blank counts.
 *
 * `--fresh` boots a new engine for every room, which turns most of those
 * redirects back into entries: a game refuses a room because of the state it is
 * in, and a game that has just booted is in the state its own first room is
 * entered from. It costs a boot per room — minutes become the better part of an
 * hour on a game the size of King's Quest VII — and it is the reading to quote,
 * because a shared engine measures the rooms a hundred earlier rooms left
 * reachable rather than the rooms the game has.
 *
 * ## What "drew" means, stated as numbers and not as a verdict
 *
 * Two numbers per room: the share of the framebuffer that is not near-black,
 * and how many distinct colours are on it. **Both, and neither on its own**,
 * because each has a way of flattering the engine:
 *
 * - a room that is *meant* to be mostly black — a chapter card, a night scene —
 *   is indistinguishable from a broken one by lit share alone;
 * - and a room filled with **one flat colour** is 100% lit and has drawn
 *   nothing. Seven of King's Quest VII's did exactly that, and the first
 *   version of this rule — 20% lit *or* 64 colours — counted every one of them
 *   as a room that drew.
 *
 * So a room drew when there are **more than 16 colours on it and more than 5%
 * of it is not near-black**. A flat fill fails the first test whatever its
 * brightness, and a cast standing on an undrawn backdrop fails the second: room
 * 100 is Valanice on black, 13 colours and 1% lit, and it is not a room that
 * drew.
 *
 * Both numbers are printed per room whatever the rule says, so a reader can
 * disagree with it rather than having to trust it.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { SciEngine } from '../src/engine/sci/SciEngine.js';
import { sciRooms } from '../src/authoring/sci/sciRooms.js';
import { describeSciVersion } from '../src/engine/sci/sciVersion.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

const path = positional[0];
if (!path) {
  console.error('Usage: npm run rooms:sci -- <game> [--shots=DIR] [--rooms=1,2,3] [--seconds=4]');
  process.exit(1);
}

const shots = flags.find((flag) => flag.startsWith('--shots='))?.slice('--shots='.length);
const only = (flags.find((flag) => flag.startsWith('--rooms='))?.slice('--rooms='.length) ?? '')
  .split(',')
  .filter(Boolean)
  .map(Number);
const seconds = Number(
  flags.find((flag) => flag.startsWith('--seconds='))?.slice('--seconds='.length) ?? 4,
);
const fresh = flags.includes('--fresh');

/** A booted engine, settled past script 0's own startup. */
async function booted(quiet: boolean): Promise<SciEngine> {
  const made = await SciEngine.create(await openGame(resolve(path!)), {
    onLog: (message) => {
      if (!quiet) console.log(`[log] ${message}`);
    },
  });
  made.boot();
  // The boot is asynchronous — script 0 is read from a Volume — so a loop
  // entered straight away would step an engine with nothing loaded.
  await new Promise((done) => setTimeout(done, 800));
  // Settle the front end. A room entered before script 0 has finished its own
  // startup is a room whose `init` runs against half a game.
  await run(made, 6 * 60);
  return made;
}

async function run(on: SciEngine, cycles: number): Promise<void> {
  for (let cycle = 0; cycle < cycles; cycle++) {
    on.step();
    // Yields so the pending loads a Kernel call asked for can complete.
    await new Promise((done) => setImmediate(done));
  }
}

let engine = await booted(false);

/**
 * SCI's own global 13 is the room number, at every Version.
 *
 * Reported beside the number that was asked for, because they differ and the
 * difference is information: King's Quest VII's rooms 26 and 29 both land on
 * 26, which is a room redirecting to another in its own `init`.
 */
const currentRoom = (): number | undefined => engine.machine.globals[13]?.offset;

const newRoom = engine.selectors.numbers.get('newRoom');
if (!newRoom) {
  console.error('This game has no "newRoom" Selector, so rooms cannot be entered by number.');
  process.exit(1);
}

const editable = await engine.toEditableGame({} as never);
const declared = editable?.project.sci ? sciRooms(editable.project.sci) : [];
const wanted = only.length > 0 ? only : declared.map((room) => room.script);

console.log(
  `\n${describeSciVersion(engine.game.version)} "${engine.game.id}": ` +
    `entering ${wanted.length} rooms, ${seconds}s each\n`,
);

let drew = 0;
let blank = 0;
let refused = 0;
let redirected = 0;
const quiet: string[] = [];
const elsewhere: string[] = [];

for (const number of wanted) {
  // A fresh engine per room, where asked: a game refuses a room because of the
  // state it is in, and a hundred rooms of accumulated state is not a state any
  // player is ever in.
  if (fresh && drew + blank + redirected + refused > 0) engine = await booted(true);
  const gameObject = (engine as unknown as { gameObjectRef: unknown }).gameObjectRef;
  try {
    engine.machine.invoke(gameObject as never, newRoom, [{ segment: 0, offset: number } as never]);
  } catch (error) {
    console.log(`  room ${number}: newRoom threw — ${String(error).slice(0, 120)}`);
    refused++;
    continue;
  }
  await run(engine, Math.max(1, Math.round(seconds * 60)));

  // A whole-frame composite rather than the engine's dirty-rect repair, so the
  // reading is of what the display list holds and not of what the last frame
  // happened to touch.
  const frame = new Uint8Array(engine.screen.pixels.length);
  engine.compositor.composite(frame, engine.screen.width, engine.screen.height);
  engine.palette.flush();

  let lit = 0;
  const colours = new Set<number>();
  for (let index = 0; index < frame.length; index++) {
    const entry = frame[index] * 4;
    const r = engine.palette.rgba[entry];
    const g = engine.palette.rgba[entry + 1];
    const b = engine.palette.rgba[entry + 2];
    // Near-black rather than black: a room lit by one dim colour is as blank to
    // a player as one lit by none.
    if (r + g + b > 24) lit++;
    colours.add((r << 16) | (g << 8) | b);
  }
  const share = (lit / frame.length) * 100;
  const painted = colours.size > 16 && share > 5;
  const landed = currentRoom();
  const entered = landed === number;

  if (!entered) {
    redirected++;
    elsewhere.push(`${number} -> ${landed}`);
  } else if (painted) {
    drew++;
  } else {
    blank++;
    quiet.push(`room ${number}`);
  }

  console.log(
    `  room ${number}${entered ? '' : ` -> ${landed}, not entered`}: ` +
      `${share.toFixed(1)}% lit, ${colours.size} colours` +
      `${entered && !painted ? (colours.size <= 1 ? '  <- one flat colour' : '  <- nothing drawn') : ''}`,
  );

  if (shots) {
    const rgb = new Uint8Array(frame.length * 3);
    for (let index = 0; index < frame.length; index++) {
      const entry = frame[index] * 4;
      rgb[index * 3] = engine.palette.rgba[entry];
      rgb[index * 3 + 1] = engine.palette.rgba[entry + 1];
      rgb[index * 3 + 2] = engine.palette.rgba[entry + 2];
    }
    await mkdir(resolve(shots), { recursive: true });
    await writeFile(
      resolve(shots, `room-${number}.png`),
      writePng(engine.screen.width, engine.screen.height, rgb),
    );
  }
}

const entered = drew + blank;
console.log(
  `\n  ${wanted.length} rooms asked for: ${entered} entered, ${redirected} sent elsewhere, ` +
    `${refused} refused.\n` +
    `  Of the ${entered} entered, ${drew} drew and ${blank} did not.` +
    (quiet.length > 0 ? `\n  nothing drawn in: ${quiet.join(', ')}` : '') +
    (elsewhere.length > 0 ? `\n  sent elsewhere: ${elsewhere.join(', ')}` : ''),
);
console.log(
  (fresh
    ? '\n  A fresh engine per room, so each reading is of a room entered from a booted game.'
    : '\n  One engine across every room, so a redirect may be state a hundred earlier rooms\n' +
      '  left behind rather than a rule about that room. --fresh boots one per room.') +
    '\n  A room the game sent elsewhere is not a reading about that room: what was on screen\n' +
    '  was wherever it landed. Entered by sending "newRoom", not by playing, so this says a\n' +
    "  room's own init draws it and says nothing about whether a player can reach it.\n",
);
