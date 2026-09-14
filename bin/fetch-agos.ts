/**
 * Downloads a freely redistributable AGOS demo into `games/`, for local
 * diagnosis and for the Structural agreement sweep.
 *
 *   npm run fetch:agos                              # where to find them
 *   npm run fetch:agos -- <url> <id> "<licence>"    # fetch one
 *
 * A sibling of `bin/fetch-agi.ts`, `bin/fetch-sci.ts` and `bin/fetch-vt.ts`,
 * deliberately the same shape. What differs is what it is *for*.
 *
 * ## This one exists to answer a question, not to have a game to look at
 *
 * ADR 0027 decided that an AGOS Version is a **title**, and wrote down what
 * would falsify it: two releases of the same game disagreeing about an opcode's
 * length. Half of that tripwire has already fired — Simon 1's floppy and talkie
 * disagree about opcodes 67 and 162, which is why a release kind is part of the
 * Target. The half that remains is whether two releases of one game *and one
 * release kind* disagree. If they do, the Version axis has to drop to the
 * release, as AGI's dropped to the interpreter build.
 *
 * Only real releases can answer that, and `docs/processes/verifying-version-
 * support.md` is explicit that no game data will ever live in this repository.
 * The demos are the way out: Adventure Soft's are freely redistributable, and
 * ScummVM's Game Demos page collects them.
 *
 * **What the demos reach.** Elvira 1, Waxworks, Simon 1 in three DOS releases
 * across both release kinds, Simon 2 in two, and The Feeble Files in two
 * languages. Elvira 2 and the Puzzle Pack have no demo anywhere, so those two
 * Versions stay unswept and the sweep's report says so rather than implying
 * coverage it does not have.
 *
 * **And the non-DOS ones are worth fetching even though they are out of scope.**
 * ADR 0028 declines Amiga, Atari ST and Acorn *packagings* while recording that
 * they "differ in [graphics encoding and packaging] while agreeing about every
 * instruction". That makes an Acorn Simon 1 the strongest available test of the
 * Version axis: same title, same release kind, a completely different release.
 * A `GAMEPC` inside one either decodes under Simon 1's table or falsifies
 * ADR 0027.
 *
 * ## Why it takes a URL rather than shipping a catalogue
 *
 * The same reasoning as its three siblings. A hardcoded list of third-party
 * links rots, and it rots at the moment somebody is trying to diagnose
 * something else. More importantly, "freely redistributable" is a claim about a
 * *specific release*, and making the licence an argument is what makes stating
 * it the act of having checked.
 *
 * ## The hard constraint
 *
 * **Nothing fetched here is ever committed.** `games/` and `public/games/` are
 * gitignored, and `public/games/` deploys to the live site, so committing there
 * would be redistributing somebody else's game from our own domain. The
 * README's "It ships no game data" is load-bearing and does not get qualified,
 * not even for a demo whose whole purpose was to be given away.
 */

import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GAMES_DIR = resolve(process.cwd(), 'games');

/**
 * Where freely redistributable AGOS data lives, as of writing.
 *
 * Prose rather than a manifest, matching its siblings: each entry says what the
 * place holds, so somebody choosing between them chooses on more than a domain.
 */
const SOURCES = [
  {
    what: 'ScummVM: Game Demos, Adventure Soft section',
    where: 'https://www.scummvm.org/demos/',
    note:
      'Eighteen Adventure Soft demos: Elvira 1 (DOS, Amiga, Atari ST), Waxworks (DOS), ' +
      'Simon 1 (DOS floppy, DOS CD, DOS alternative, Acorn x3, Amiga, Amiga CD32), ' +
      'Simon 2 (DOS CD English and German), The Feeble Files (DOS English and German), ' +
      'and Personal Nightmare, which is a different engine. Downloads are zips under ' +
      'downloads.scummvm.org/frs/demos/agos/.',
  },
  {
    what: 'ScummVM wiki: AGOS',
    where: 'https://wiki.scummvm.org/index.php/AGOS',
    note: 'What each release ships and which files name it, useful for reading a sweep’s output.',
  },
];

function usage(): void {
  console.log('Fetches a freely redistributable AGOS demo into games/, for local diagnosis.\n');
  console.log('  npm run fetch:agos -- <url> <id> "<licence>"\n');
  console.log('For example:\n');
  console.log('  npm run fetch:agos -- \\');
  console.log(
    '      https://downloads.scummvm.org/frs/demos/agos/simon1-dos-floppy-demo-en.zip \\',
  );
  console.log(
    '      simon1-floppy-demo "Freely redistributable demo, from ScummVM’s demos page"\n',
  );
  console.log('Where to find them:\n');
  for (const source of SOURCES) {
    console.log(`  ${source.what}`);
    console.log(`    ${source.where}`);
    console.log(`    ${source.note}\n`);
  }
  console.log('Fetch more than one release per Version, and for Simon 1 and Simon 2 both');
  console.log('release kinds. That pairing is the point: ADR 0027 says a Version is a');
  console.log('title, and two releases of one game and one release kind disagreeing about');
  console.log('an opcode’s length is what would falsify it.\n');
  console.log('Then:\n');
  console.log('  npm run sweep:agos -- games/<id>.zip\n');
  console.log('Nothing fetched here is ever committed: games/ is gitignored and stays');
  console.log('that way. Run `git status` afterwards — it should be clean.');
}

/**
 * Records what was fetched and under what licence.
 *
 * Written to `games/LICENCES.txt`, which is itself gitignored — so the record
 * travels with the download rather than with the repository, which is the right
 * way round: the repository has no game data to attribute.
 */
async function recordLicence(id: string, url: string, licence: string): Promise<void> {
  const path = join(GAMES_DIR, 'LICENCES.txt');
  let header = '';
  try {
    await stat(path);
  } catch {
    header =
      'Games fetched by `npm run fetch:agos`. None of this is part of the\n' +
      'repository: games/ is gitignored and these files are yours, locally.\n\n';
  }

  await appendFile(
    path,
    `${header}${id}.zip\n  Source:  ${url}\n  Licence: ${licence}\n  Fetched: ${new Date().toISOString()}\n\n`,
  );
}

async function main(): Promise<void> {
  const [url, id, licence] = process.argv.slice(2);

  if (!url || !id) {
    usage();
    return;
  }

  if (!licence) {
    // Refused rather than defaulted. Stating the licence is the act of having
    // checked it, and a default would make the check skippable.
    console.error('A licence is required — it is what says this demo may be redistributed.\n');
    console.error(
      '  npm run fetch:agos -- <url> <id> "Freely redistributable demo, from ScummVM’s demos page"',
    );
    process.exitCode = 1;
    return;
  }

  if (!/^https:\/\//.test(url)) {
    console.error('Only https URLs are fetched, so the download cannot be tampered with.');
    process.exitCode = 1;
    return;
  }

  await mkdir(GAMES_DIR, { recursive: true });
  const target = join(GAMES_DIR, `${id}.zip`);

  console.log(`Fetching ${url}…`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}.`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(target, bytes);
  await recordLicence(id, url, licence);

  console.log(`  ${(bytes.length / 1024).toFixed(0)} KB written to games/${id}.zip`);
  console.log(`  Licence recorded in games/LICENCES.txt\n`);
  console.log('Next:');
  console.log(`  npm run sweep:agos -- games/${id}.zip   # Structural agreement over the game`);
  console.log(`  npm start, then ?game=${id}             # play what there is of it\n`);

  const contents = await readdir(GAMES_DIR);
  console.log(`games/ now holds ${contents.length} entries.`);
  console.log('`git status` should be clean — everything here is gitignored.');
}

await main();
