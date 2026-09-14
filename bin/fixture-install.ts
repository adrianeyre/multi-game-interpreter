/**
 * Writes a synthetic AGI or SCI install to a folder, so the `bin/` tools can be
 * pointed at a Target nobody here owns a game for.
 *
 *   npm run fixture -- agi-v2 /tmp/fixtures/agi-v2
 *   npm run fixture -- sci sci1-1 /tmp/fixtures/sci1-1
 *   npm run fixture -- --list
 *
 * ## Why this is a command rather than a throwaway script
 *
 * Every other tool in `bin/` takes a path to a game folder, and only two of the
 * nineteen Targets on the AGI and SCI axes have real data on any one machine.
 * So the standing check across a whole Engine family — the one
 * `docs/processes/running-sandcastle.md` describes — needs installs on disk for
 * the other seventeen, and the SCUMM run that came before this wrote them with
 * a script it then deleted.
 *
 * That is the shape `tests/sweep.test.ts` was written to stop repeating: a
 * manual exercise is a true claim that decays without saying so. The emitter
 * being a command means the next run reproduces the last one's installs rather
 * than approximating them.
 *
 * ## What a fixture install is worth, which is less than it looks
 *
 * `docs/processes/verifying-version-support.md` calls this Tier 1 and names the
 * trap: a fixture encodes **this project's reading of the format**, so the
 * fixture and the engine agree with each other by construction. Pointing a tool
 * at one establishes that the tool *reaches* that Target. It establishes
 * nothing about a shipped game, and a report whose rows do not say which kind
 * they are has quietly promoted every fixture row in it.
 *
 * ## Layouts, not Versions — and the difference matters
 *
 * The argument below is a **resource layout**, because that is what a fixture
 * builder can actually build. It is not a Version:
 *
 * - AGI's two layouts are its two majors, and the major governs packaging and
 *   nothing else (ADR 0012). What fixes AGI's instruction encoding is the
 *   interpreter build, which is `npm run sweep:agi -- --interpreter=`.
 * - SCI's four builders cover three of the six map structures `detectMapVersion`
 *   tells apart, not four: the SCI32 and SCI3 builders both write a `sci2`
 *   container, because a SCI3 game ships the SCI32 one. `sci1-middle`,
 *   `sci1-late` and `kq5-fm-towns` have no builder, and are reached by
 *   `tests/sci-packing.test.ts` in process rather than by any install on disk.
 *   The thirteen Versions on `SCI_VERSIONS` are finer than any map,
 *   which is the whole of ADR 0020 — so a named Version reaches the tools
 *   through `npm run sweep:sci -- --version=` and not through a folder.
 *
 * Which means a row reading "SCI1 middle, swept under a SCI0-layout install"
 * is not a contradiction. It is the honest description of what was checked: the
 * Kernel table and the decoder for that Version, against bytes whose map is
 * somebody else's. The report has to say so, and the sweep prints it.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildAgiV2Fixture, buildAgiV3Fixture, type AgiFixture } from '../tests/fixtureAgi.js';
import {
  buildSci0Fixture,
  buildSci11Fixture,
  buildSci32Fixture,
  buildSci3Fixture,
  type SciFixture,
} from '../tests/fixtureSci.js';

/**
 * The layouts, with what each one is and which Versions reach the tools through
 * it.
 *
 * `reaches` is prose rather than a list of Version strings on purpose: it is
 * advice to whoever is building a matrix, and a machine-readable list here
 * would be a second place for the Version axis to live and drift from
 * `SCI_VERSIONS`.
 */
const LAYOUTS = {
  'agi-v2': {
    family: 'agi',
    what: 'four *DIR files and VOL.0 — AGI v2 packaging',
    reaches: 'every DOS v2 interpreter build; name one with sweep:agi --interpreter=',
    build: (): AgiFixture | SciFixture => buildAgiV2Fixture(),
  },
  'agi-v3': {
    family: 'agi',
    what: 'one <GAMEID>DIR beside <GAMEID>VOL.0, resources LZW-compressed',
    reaches: 'every v3 interpreter build; name one with sweep:agi --interpreter=',
    build: (): AgiFixture | SciFixture => buildAgiV3Fixture(),
  },
  sci0: {
    family: 'sci',
    what: 'RESOURCE.MAP as a flat six-byte list — the SCI0 map structure',
    reaches: 'SCI0 early through SCI1 late; name one with sweep:sci --version=',
    build: (): AgiFixture | SciFixture => buildSci0Fixture(),
  },
  'sci1-1': {
    family: 'sci',
    what: 'a type directory over five-byte entries, with a heap beside script 0',
    reaches: 'SCI1.1',
    build: (): AgiFixture | SciFixture => buildSci11Fixture(),
  },
  sci32: {
    family: 'sci',
    what: 'RESMAP.000 over RESSCI.000, six-byte entries with a plain 32-bit offset',
    reaches: 'SCI2 through SCI2.1 late; name one with sweep:sci --version=',
    build: (): AgiFixture | SciFixture => buildSci32Fixture(),
  },
  sci3: {
    family: 'sci',
    what: 'the SCI32 map over a Script resource with SCI3’s 22-byte header',
    reaches: 'SCI3',
    build: (): AgiFixture | SciFixture => buildSci3Fixture(),
  },
} as const;

type LayoutName = keyof typeof LAYOUTS;

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const positional = args.filter((argument) => !argument.startsWith('--'));

if (flags.includes('--list') || positional.length === 0) {
  console.log('Layouts this can write:\n');
  for (const [name, layout] of Object.entries(LAYOUTS)) {
    console.log(`  ${name.padEnd(8)} ${layout.what}`);
    console.log(`  ${''.padEnd(8)} reaches: ${layout.reaches}\n`);
  }
  console.log('Usage: npm run fixture -- <layout> <out>');
  console.log('   or: npm run fixture -- <family> <layout> <out>');
  process.exit(positional.length === 0 && !flags.includes('--list') ? 1 : 0);
}

/**
 * Three ways of naming the same layout, because two of them are what people
 * type.
 *
 * `agi-v2` is what `--list` prints. `agi v2` is what a matrix script writes,
 * where the family is the outer loop variable. And `sci sci0` is what that same
 * script writes for the other family — where the layout name already carries
 * the family, so joining the two words gives `sci-sci0`, which is nothing.
 *
 * The first version of this joined the words and stopped, so `agi v2` worked
 * and `sci sci0` failed with `Unknown layout "sci"` — including the example in
 * this file's own header, which is how it was found: the run this tool was
 * written for typed the documented form and got an error. So the family word is
 * *dropped* when the layout stands alone, rather than pattern-matched into a
 * name.
 */
const FAMILIES = new Set(['agi', 'sci']);
const [first, second, third] = positional;

const joined = second ? `${first}-${second}` : '';
let named: string;
let outPath: string | undefined;

if (joined in LAYOUTS) {
  named = joined;
  outPath = third;
} else if (second && second in LAYOUTS && FAMILIES.has(first ?? '')) {
  named = second;
  outPath = third;
} else {
  named = first ?? '';
  outPath = second;
}

if (!(named in LAYOUTS)) {
  console.error(`Unknown layout "${named}". Run with --list to see them.`);
  process.exit(1);
}
if (!outPath) {
  console.error('Usage: npm run fixture -- [<family>] <layout> <out>');
  process.exit(1);
}

const layout = LAYOUTS[named as LayoutName];
const out = resolve(outPath);

/**
 * Refuses to write inside the repository.
 *
 * A fixture install is a game-shaped folder, and `docs/processes/running-
 * sandcastle.md` is firm that no game-shaped folder belongs anywhere git can
 * see it. These bytes are synthetic and committing them would harm nobody — but
 * the habit is the thing being protected, and a tool that will write a game
 * folder into the worktree on request is a tool that eventually does.
 */
if (out.startsWith(resolve(process.cwd()))) {
  console.error(
    `${out} is inside this repository. Fixture installs are game-shaped folders and belong\n` +
      'outside it — write to a temporary folder instead.',
  );
  process.exit(1);
}

await mkdir(out, { recursive: true });
const fixture = layout.build();

for (const [name, bytes] of fixture.files) {
  await writeFile(join(out, name), bytes);
}

console.log(`${named} — ${layout.what}`);
console.log(`${fixture.files.size} files written to ${out}`);
for (const [name, bytes] of fixture.files) {
  console.log(`  ${name.padEnd(16)} ${bytes.length} bytes`);
}
console.log(`\nreaches: ${layout.reaches}`);
