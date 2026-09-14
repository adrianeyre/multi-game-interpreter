/**
 * Plays a SCI game's front end and reports the room a player actually reaches.
 *
 *   npm run play:sci -- <game>
 *   npm run play:sci -- <game> --click=145,133
 *   npm run play:sci -- <game> --seconds=8
 *
 * **This exists because measurements kept being taken in the wrong game.**
 * `sci-rooms.ts` enters a room by sending `newRoom`, which is the right trade
 * for sweeping a hundred rooms and the wrong one for asking whether a player
 * can do anything. The two differ in ways that silently invalidate a reading:
 *
 * - the **room Plane's rectangle** differs. King's Quest VII's room 1000 is
 *   `0,0 320x200` in script coordinates entered by `newRoom` and `0,10 320x190`
 *   played, with the interface bar at `0,137 320x63` — so the same screen pixel
 *   is a different script point in the two;
 * - **Features are not dispatched `handleEvent` on a pointer move** in a room
 *   entered by `newRoom`, and are when played. A hover test run there measures
 *   nothing and looks like a failure;
 * - the **room's own script** differs, because a played room has been entered
 *   by its own route with its own chapter state.
 *
 * Every wrong turn recorded in `games/kings-quest-vii-the-princeless-bride`
 * had that one shape: a measurement taken in one context and read as though it
 * were another. So the played route is a tool here rather than a probe written
 * again each time, and it reports the plane rectangle it measured against so a
 * reader can tell which game a number came from.
 *
 * ## How the front end is driven
 *
 * **By what is on screen, never by fixed coordinates or fixed waits.** Two
 * earlier probes with the same fixed waits ended in different rooms on
 * different runs, because the front end's timing decides how far it gets. This
 * waits for the buttons to be *drawn* and clicks their measured centres. It
 * also presses the **middle** button on the main menu, which is the one that
 * starts a game — a probe that always pressed the topmost looked exactly like a
 * menu ignoring its clicks.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */

import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { SciEngine } from '../src/engine/sci/SciEngine.js';
import { SCI_EVENT } from '../src/engine/sci/SciInput.js';
import { describeSciVersion } from '../src/engine/sci/sciVersion.js';

const args = process.argv.slice(2);
const flags = args.filter((one) => one.startsWith('--'));
const path = args.find((one) => !one.startsWith('--'));
if (!path) {
  console.error('Usage: npm run play:sci -- <game> [--click=X,Y] [--seconds=6]');
  process.exit(1);
}
const seconds = Number(flags.find((f) => f.startsWith('--seconds='))?.slice(10) ?? 6);
const clickAt = flags.find((f) => f.startsWith('--click='))?.slice(8);

const engine = await SciEngine.create(await openGame(resolve(path)), { onLog: () => {} });
engine.boot();
await new Promise((done) => setTimeout(done, 800));

/**
 * Cycles at about the rate a browser runs them.
 *
 * The game paces itself off `GetTime`, so a burst of cycles with no wall clock
 * between them is a game whose own timers never advance.
 */
const run = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i++) {
    engine.step();
    engine.render();
    await new Promise((done) => setTimeout(done, 3));
  }
};
const room = (): number | undefined => engine.machine.globals[13]?.offset;
const selectors = engine.selectors.numbers;

/** Every screen item now on any Plane, as display rectangles. */
const items = (): Array<{ x: number; y: number; w: number; h: number }> => {
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const [, plane] of (engine as unknown as { gamePlanes: Map<string, never> })
    .gamePlanes as Map<string, { bounds: { x: number; y: number }; items: never[] }>) {
    for (const item of plane.items as unknown as Array<{
      x: number;
      y: number;
      size?: { width: number; height: number } | null;
      cel?: { width: number; height: number };
    }>) {
      const size = item.size ?? { width: item.cel?.width ?? 0, height: item.cel?.height ?? 0 };
      out.push({
        x: plane.bounds.x + item.x,
        y: plane.bounds.y + item.y,
        w: size.width,
        h: size.height,
      });
    }
  }
  return out;
};
/** The button-shaped things, topmost first. */
const buttons = () =>
  items()
    .filter((one) => one.w > 40 && one.w < 420 && one.h > 20 && one.h < 130)
    .sort((a, b) => a.y - b.y);

/**
 * A click, as the game will only accept one.
 *
 * Move, move again, press, release: the game re-tests its Features when the
 * pointer position changes, and that is the only thing that arms the Feature a
 * press is then given to.
 */
const click = async (x: number, y: number, settle = 90): Promise<void> => {
  engine.input.moveTo(Math.max(0, x - 10), Math.max(0, y - 10));
  await run(6);
  engine.input.moveTo(x, y);
  await run(10);
  engine.input.post({ type: SCI_EVENT.mouseDown, message: 0, modifiers: 0, x, y });
  await run(5);
  engine.input.post({ type: SCI_EVENT.mouseUp, message: 0, modifiers: 0, x, y });
  await run(settle);
};
const key = async (code: number): Promise<void> => {
  engine.input.post({ type: SCI_EVENT.keyDown, message: code, modifiers: 0, x: 0, y: 0 });
  await run(18);
};
/** Waits for a condition rather than for a number of cycles. */
const until = async (want: () => boolean, limit = 1500): Promise<boolean> => {
  for (let cycle = 0; cycle < limit; cycle += 10) {
    if (want()) return true;
    await run(10);
  }
  return want();
};

console.log(`\n${describeSciVersion(engine.game.version)} "${engine.game.id}": playing in\n`);

await until(() => (room() ?? 0) > 0);
await run(240);
console.log(`  boot settled in room ${room()}`);

await click(320, 240, 150); // past the opening card
await until(() => buttons().length >= 3);
{
  const menu = buttons();
  // The middle button starts a game. The topmost does not.
  const start = menu[1] ?? menu[0];
  console.log(`  menu in room ${room()}, ${menu.length} buttons; pressing the middle one`);
  if (start) await click(start.x + (start.w >> 1), start.y + (start.h >> 1), 180);
}
await until(() => buttons().length > 0 || (room() ?? 0) >= 1000);
for (const code of [82, 79, 83, 69]) await key(code); // a name, where one is asked for
await key(13);
await run(240);
await until(() => buttons().length > 0 || (room() ?? 0) >= 1000);
{
  const next = buttons()[0];
  if (next) await click(next.x + (next.w >> 1), next.y + (next.h >> 1), 180);
}
await until(() => (room() ?? 0) >= 1000 || buttons().length === 0);
if ((room() ?? 0) < 1000) await click(320, 240, 200);
await until(() => (room() ?? 0) >= 1000);
await run(Math.max(60, seconds * 60));

const landed = room();
console.log(`\n  a player reaches room ${landed}\n`);

// **The Plane rectangle this reading was taken against**, because the same room
// measures differently by route and a number without it cannot be compared.
const planes = (engine as unknown as { gamePlanes: Map<string, { bounds: Rect }> }).gamePlanes;
const scriptRects = (engine as unknown as { planeScriptRects: Map<string, Rect> }).planeScriptRects;
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
for (const [id, plane] of planes) {
  const script = scriptRects.get(id);
  console.log(
    `  plane ${id}: screen ${plane.bounds.x},${plane.bounds.y} ` +
      `${plane.bounds.width}x${plane.bounds.height}` +
      (script ? `  script ${script.x},${script.y} ${script.width}x${script.height}` : ''),
  );
}

const ego = engine.machine.object(engine.machine.globals[0]!);
const read = (name: string): number | undefined => {
  const selector = selectors.get(name);
  if (selector === undefined || !ego) return undefined;
  const index = engine.machine.resolveProperty(ego, selector);
  return index >= 0 ? ego.variables[index]?.offset : undefined;
};
const signed = (value: number | undefined) =>
  value === undefined ? '-' : value > 32767 ? value - 65536 : value;
console.log(
  `\n  ego ${signed(read('x'))},${signed(read('y'))} view=${read('view')} mover=${read('mover')}`,
);

/**
 * Clicks a **script** point, mapped through the room Plane's own rectangle.
 *
 * That mapping is the only one that means the same thing in both routes, and
 * getting it from the screen instead is what hid King's Quest VII's south exit:
 * played, room 1000's Plane covers script rows 0 to 137, so an exit at row 129
 * to 150 is clipped and only its first eight rows can be clicked at all.
 */
const clickScript = async (sx: number, sy: number): Promise<boolean> => {
  // **Re-read every time.** A room change replaces the Plane, and a panoramic
  // room scrolls its own — King's Quest VII's room 1100 is 960 script columns
  // on a 320-column screen — so a rectangle captured once maps later clicks off
  // the edge of the display.
  const [id, plane] = [...planes].find(([, p]) => p.bounds.height > 100) ?? [];
  const script = id ? scriptRects.get(id) : undefined;
  if (!plane || !script) {
    console.log('  no room Plane to map a click against.');
    return false;
  }
  const x = Math.round(plane.bounds.x + ((sx - script.x) * plane.bounds.width) / script.width);
  const y = Math.round(plane.bounds.y + ((sy - script.y) * plane.bounds.height) / script.height);
  const before = room();
  const inside = sy >= script.y && sy < script.y + script.height;
  await click(x, y, 300);
  const onScreen = x >= 0 && x < engine.screen.width && y >= 0 && y < engine.screen.height;
  // The script columns and rows actually on screen, so an off-screen point says
  // what to walk towards rather than only that it missed. A panoramic room
  // scrolls its Plane under a window the size of the display.
  const visible =
    `script x ${script.x}..${script.x + script.width - 1}, ` +
    `y ${script.y}..${script.y + script.height - 1}`;
  console.log(
    `  script ${sx},${sy} -> screen ${x},${y}` +
      `${inside ? '' : ' (below the room Plane)'}` +
      `${onScreen ? '' : ` (OFF SCREEN — visible now: ${visible})`}: ` +
      `ego ${signed(read('x'))},${signed(read('y'))}  room ${before} -> ${room()}`,
  );
  return room() !== before;
};

if (clickAt) {
  console.log('');
  // Several points, separated by semicolons, so a route can be walked.
  for (const one of clickAt.split(';')) {
    const [sx, sy] = one.split(',').map(Number);
    if (Number.isNaN(sx) || Number.isNaN(sy)) continue;
    await clickScript(sx, sy);
    await run(120);
  }
}

console.log(
  '\n  Driven through the game’s own front end, so this says what a player can\n' +
    '  reach. A room entered with "npm run rooms:sci" is a different game: its\n' +
    '  Plane rectangle, its running script and whether Features are dispatched on\n' +
    '  a pointer move all differ. Numbers from the two are not comparable.\n',
);
