/**
 * Boots a real SCI game headlessly and reports the state it reaches.
 *
 *   npm run diagnose:sci -- games/sci-longbow.zip
 *   npm run diagnose:sci -- games/sci-kq4.zip 30 --play
 *
 * `npm run sweep:sci` is static — it decodes every Script resource without
 * running one — and `npm run shot:sci` renders a Picture standalone. Neither
 * answers the question this one does: **what is the game doing after it has
 * been running for a while, and what is it waiting for?**
 *
 * That gap is why `docs/processes/verifying-version-support.md` could say for a
 * round that "the events are not reaching the scripts" and be wrong about it.
 * The evidence that corrected it — a poll count, a consumed-event count and an
 * empty queue — was gathered by a throwaway script, and a throwaway script is
 * an anecdote. This is the same measurement as a command, so the next reading
 * of it can be compared with the last.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { writePng } from './png.js';
import { openGame } from '../src/hosting/openGame.js';
import { SciEngine } from '../src/engine/sci/SciEngine.js';
import { SCI_EVENT, SCI_MOD } from '../src/engine/sci/SciInput.js';
import { readSelectorTable } from '../src/engine/sci/script/selectors.js';
import {
  describeSciVersion,
  SCI_VERSIONS,
  selectorIdCarriesReadWriteBit,
  type SciVersion,
} from '../src/engine/sci/sciVersion.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

const path = positional[0];
if (!path) {
  console.error(
    'Usage: npm run diagnose:sci -- <game> [seconds] [--play] [--trace] ' +
      '[--click=x,y] [--png=FILE] [--version=sci1-late]',
  );
  process.exit(1);
}
const seconds = Number(positional[1] ?? 10);

/** `--play` clicks and types, the way a player faced with a menu would. */
const play = flags.includes('--play');
/**
 * `--type=word` types a word before pressing Enter.
 *
 * A Sierra game of this period can open on a question, and King's Quest IV
 * does: its first screen is a manual check with a text field, and until one is
 * answered the game is doing exactly what it should and going nowhere. Clicks
 * and blank Enters cannot answer it, so a diagnosis of what the *game* does
 * needs a way to get past what the *publisher* put in front of it.
 */
const typed = flags.find((flag) => flag.startsWith('--type='))?.slice('--type='.length) ?? '';
/** `--trace` prints every instruction, which is a lot and occasionally the only way. */
const trace = flags.includes('--trace');
/** `--click=160,100` aims the clicks somewhere specific rather than at the middle. */
const clickAt = (flags.find((f) => f.startsWith('--click='))?.slice('--click='.length) ?? '')
  .split(',')
  .map(Number);
/**
 * `--png=out/room.png` writes the framebuffer the browser would paint.
 *
 * `shot:sci` renders a Picture *standalone*, which answers whether the decoder
 * works and not whether the game drew a room. This is the running game's own
 * screen after its scripts have had a while — the Plane the compositor built,
 * the cast the scripts animated, the palette the game chose. That is the only
 * picture that can settle "reaches its first screen", and per
 * `verifying-version-support.md` it is a fault class nothing else reaches: the
 * game does the right thing and the picture is wrong.
 */
const pngPath = flags.find((f) => f.startsWith('--png='))?.slice('--png='.length);

/**
 * `--version=sci1-late` boots under a Version you name rather than the game's.
 *
 * The counterpart of the same flag on `sweep:sci` and `reexport:sci`, and it
 * closes the one column a matrix over `SCI_VERSIONS` could not otherwise fill.
 * The static sweep and the re-export could both be asked about any Version;
 * *plays* could only ever be asked about whichever Version detection settled
 * on, so twelve of thirteen rows had a decode and an export number and a blank
 * where booting should be.
 *
 * ADR 0013's warning holds: naming the wrong Version gives a game that runs
 * and does the wrong things. That is why the header line and the engine log
 * both say `declared` and both print what detection found.
 */
const declared = flags.find((flag) => flag.startsWith('--version='))?.slice('--version='.length) as
  SciVersion | undefined;

if (declared && !SCI_VERSIONS.includes(declared)) {
  console.error(`--version must be one of:\n  ${SCI_VERSIONS.join('\n  ')}`);
  process.exit(1);
}

const engine = await SciEngine.create(await openGame(resolve(path)), {
  onLog: (message) => console.log(`[log] ${message}`),
  ...(declared ? { declaredVersion: declared } : {}),
});

// Selector names make a stack readable. A SCI frame carries a Selector number
// and nothing else, and "selector 125" and "handleEvent" are the same fact told
// to a machine and to a person.
const selectorBytes = await engine.resources.read('vocab', 997);
// Doubled for SCI0 early, the same way the engine reads it — a report that
// names Selectors off an undoubled table names the wrong ones.
const selectorNames = selectorBytes
  ? readSelectorTable(selectorBytes, {
      lsbToggle: selectorIdCarriesReadWriteBit(engine.game.version),
    }).names
  : [];
const selectorName = (number: number): string =>
  number < 0 ? 'entry' : (selectorNames[number] ?? `selector ${number}`);

if (trace) engine.machine.trace = (line) => console.log(`[trace] ${line}`);

engine.boot();
// The boot is asynchronous — script 0 is read from a Volume — so a synchronous
// loop entered straight away would step an engine with nothing loaded.
await new Promise((resolve) => setTimeout(resolve, 500));

const cycles = Math.max(1, Math.round(seconds * 60));
const clickX = Number.isFinite(clickAt[0]) ? clickAt[0] : 160;
const clickY = Number.isFinite(clickAt[1]) ? clickAt[1] : 100;
/**
 * `--click=` is given in the **script's** space and delivered in the screen's.
 *
 * The script's space is the one a reader can pick a number from: a SCI script's
 * own coordinates are 320x200 whatever the game composites at, so "the middle"
 * is 160,100 in every SCI game and 320,240 in only some of them.
 *
 * Both of the ways in are the *player's* space, though. `moveTo` is what a
 * `pointermove` reaches and `post` is what a `pointerdown` reaches, and both
 * convert what they are handed with `SciInput`'s own display-to-script rule —
 * so a caller that hands `post` a script coordinate has it converted a second
 * time. King's Quest VII composites at 640x480, and a click meant for 105,92
 * arrived at the scripts as 53,38: half as far across and a fifth as far down
 * as the hover that had just armed the button. The Feature under the pointer
 * was armed correctly and then asked whether a point in the sky above it was
 * inside it, said no, and the menu registered every click and acted on none.
 *
 * Converted once, here, so the hover and the press are the same place.
 */
const { script: scriptRes, display: displayRes } = engine.resolution;
const hoverX = Math.round((clickX * displayRes.width) / scriptRes.width);
const hoverY = Math.round((clickY * displayRes.height) / scriptRes.height);
let injected = 0;

let typedSoFar = 0;
for (let cycle = 0; cycle < cycles; cycle++) {
  // A character every few cycles, so the game's own edit loop sees each one.
  if (cycle > 60 && cycle % 6 === 0 && typedSoFar < typed.length) {
    engine.input.post({
      type: SCI_EVENT.keyDown,
      message: typed.charCodeAt(typedSoFar++),
      modifiers: 0,
      x: 0,
      y: 0,
    });
  }
  // Nothing is pressed until the word is in: an Enter before it submits an
  // empty answer, and the game is right to reject one.
  const answering = typedSoFar < typed.length;
  // **The pointer is moved before it is clicked, because a real one always
  // is.** A SCI game learns where the mouse is from `kGetEvent`'s x and y, and
  // an interface that highlights under the pointer only re-scans when the
  // position it last saw differs from the one it is being told now. King's
  // Quest VII's `User::handleEvent` compares against globals 70 and 71 and
  // skips the whole hover arm when they match — so a run that teleports the
  // pointer to the button once and leaves it there exercises the click and
  // never the hover, and in that game the hover is what arms the click.
  // Away, then onto the target, so each pass is a change.
  if (play && !answering && cycle > 30 && cycle % 40 === 10) engine.input.moveTo(0, 0);
  if (play && !answering && cycle > 30 && cycle % 40 === 20) {
    engine.input.moveTo(hoverX, hoverY);
  }
  if (play && !answering && cycle > 30 && cycle % 40 === 0) {
    // A press and a release, because a script that watches for one and not the
    // other is a real thing and injecting only `mouseDown` hides it.
    engine.input.post({
      type: SCI_EVENT.mouseDown,
      message: 0,
      modifiers: 0,
      x: hoverX,
      y: hoverY,
    });
    engine.input.post({ type: SCI_EVENT.mouseUp, message: 0, modifiers: 0, x: hoverX, y: hoverY });
    engine.input.post({
      type: SCI_EVENT.keyDown,
      message: 13,
      modifiers: SCI_MOD.shift & 0,
      x: hoverX,
      y: hoverY,
    });
    injected += 3;
  }
  engine.step();
  // Yields so the pending-script loads a Kernel call asked for can complete.
  await new Promise((resolve) => setImmediate(resolve));
}
engine.render();

if (pngPath) {
  const out = resolve(pngPath);
  await mkdir(dirname(out), { recursive: true });
  // The palette holds a base, a cycled copy and an intensity, and `rgba` is
  // the three of them combined on demand. The browser gets there through
  // `present`; a file writer has to ask, and forgetting to made a room with 187
  // colours in its framebuffer come out as a black PNG.
  engine.palette.flush();
  const { width, height } = engine.screen;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < engine.screen.pixels.length; i++) {
    const entry = engine.screen.pixels[i] * 4;
    rgb[i * 3] = engine.palette.rgba[entry];
    rgb[i * 3 + 1] = engine.palette.rgba[entry + 1];
    rgb[i * 3 + 2] = engine.palette.rgba[entry + 2];
  }
  await writeFile(out, writePng(width, height, rgb));
  console.log(`[log] wrote ${out}`);
}

const pixels = engine.screen.pixels;
const histogram = new Map<number, number>();
for (const pixel of pixels) histogram.set(pixel, (histogram.get(pixel) ?? 0) + 1);
const ranked = [...histogram].sort((a, b) => b[1] - a[1]);
const background = ranked[0]?.[1] ?? 0;

const report: string[] = [
  '',
  `${describeSciVersion(engine.game.version)} "${engine.game.id}" after ${seconds}s ` +
    `(${engine.frame} cycles), identified by ${engine.game.identification}`,
  '',
  ...engine.describeStall().map((line) => `  ${line}`),
  '',
  '  stack, innermost last:',
  ...(engine.machine.frames.length === 0
    ? ['    nothing running — the machine ran out of frames']
    : engine.machine.frames.map(
        (frame) =>
          `    script ${frame.script} pc ${frame.pc} ${selectorName(frame.selector)}` +
          `(${frame.selector})`,
      )),
  '',
  `  screen: ${engine.screen.width}x${engine.screen.height}, ${histogram.size} distinct colours, ` +
    `${(((pixels.length - background) / pixels.length) * 100).toFixed(1)}% not the commonest`,
  `  every Kernel call, by count: ${[...engine.kernelCalls]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(', ')}`,
  play ? `  events injected: ${injected}` : '  no events injected — pass --play to click and type',
  '',
];
console.log(report.join('\n'));
