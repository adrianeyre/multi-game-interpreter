/**
 * Downloads a freely redistributable SCI game into `games/`, for local
 * diagnosis.
 *
 *   npm run fetch:sci                             # where to find games
 *   npm run fetch:sci -- <url> <id> "<licence>"   # fetch one
 *
 * A sibling of `bin/fetch-agi.ts` and deliberately the same shape, for the same
 * reason: `docs/processes/verifying-version-support.md` warns that a synthetic
 * fixture "encodes our reading of the format — if that reading is wrong, the
 * fixture and the engine agree with each other and disagree with the game".
 * Pointing `diagnose` at data nobody here wrote is the only escape, and for AGI
 * it found four v6 faults and one v7 fault in the first hour.
 *
 * ## What exists for SCI, and what does not
 *
 * **SCI0 and SCI1.1: fan-made games.** SCI Companion produced them the way AGI
 * Studio did for AGI — real `RESOURCE.MAP` indexes, real Volumes, real PMachine
 * bytecode, real Views and Pictures — and they are freely distributed. Sierra's
 * own SCI demos circulate too.
 *
 * **SCI2, SCI2.1 and SCI3: nothing.** No fan toolchain targets SCI32, so there
 * are no fan-made games for it at all. For the exact half of the family that is
 * hardest — new compositor, new resource layout, streaming Volumes, Robot —
 * there is no free data, and `diagnose`, `sweep` and `shot` have nothing to
 * point at. That is a standing limitation of this project, recorded in
 * `docs/processes/verifying-version-support.md` rather than solved here.
 *
 * ## Why it takes a URL rather than shipping a catalogue
 *
 * The same reasoning as `fetch:agi`. A hardcoded list of third-party download
 * links is a list that rots, and a rotted link in a tool like this fails at the
 * moment someone is trying to diagnose something else. And "freely
 * redistributable" is a claim about a *specific release*: making the licence an
 * argument is what makes stating it the act of having checked.
 *
 * ## The hard constraint
 *
 * **Nothing fetched here is ever committed.** What this script writes —
 * `games/*.zip` and `games/LICENCES.txt` — is gitignored, and `public/games/`
 * deploys to the live site, so committing there would be redistributing
 * someone else's game from our own domain. The rule does not bend for a
 * permissive licence.
 */

import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GAMES_DIR = resolve(process.cwd(), 'games');

/**
 * Where freely distributed SCI data lives, as of writing.
 *
 * Prose, because it is advice rather than a manifest. Each entry says what the
 * place actually holds, so somebody choosing between them is choosing on more
 * than a domain name.
 */
const SOURCES = [
  {
    what: 'SCI Programming: fan game archive',
    where: 'https://sciprogramming.com/fangames.php',
    note:
      'The main archive of fan-made SCI games, most built with SCI Companion and ' +
      'targeting SCI0 or SCI1.1. Free to download; each game states its own terms.',
  },
  {
    what: 'SCI Programming forums',
    where: 'https://sciprogramming.com/community/',
    note: 'Where releases are announced, including the ones not yet in the archive index.',
  },
  {
    what: "ScummVM's freeware games",
    where: 'https://www.scummvm.org/games/',
    note:
      'Sierra released a handful of SCI titles as freeware. These are complete ' +
      'commercial games, so they exercise the resource layer far harder than a fan game.',
  },
  {
    what: "ScummVM's demos",
    where: 'https://www.scummvm.org/demos/',
    note:
      'Sierra SCI demos, freely distributed. Small, and the quickest way to a real ' +
      'RESOURCE.MAP in front of a person.',
  },
  {
    what: 'SCI Companion',
    where: 'https://github.com/EricOakford/SCI-Companion',
    note:
      'The toolchain most fan games were built with. Worth having beside them: what it ' +
      'writes is what this project has to read, and its source documents the layouts.',
  },
];

/**
 * What to prefer fetching, and why those two.
 *
 * SCI0 and SCI1.1 rather than "some SCI game": they are the two Versions the
 * family is built outwards from (#219, #221), they are where the fan data
 * actually is, and between them they exercise both Script resource layouts —
 * object data inline with relocations, and the code/heap pair.
 */
const WANTED = [
  'One SCI0 game — a flat 6-byte RESOURCE.MAP, EGA Views, the parser, and',
  '  object data inline in the Script resource with a relocation list.',
  '',
  'One SCI1.1 game — a type directory at the front of the map with 5-byte',
  '  entries, VGA Views, MESSAGE resources, and the code/heap split.',
];

function usage(): void {
  console.log('Fetches a freely redistributable SCI game into games/, for local diagnosis.\n');
  console.log('  npm run fetch:sci -- <url> <id> "<licence>"\n');
  console.log('For example:\n');
  console.log('  npm run fetch:sci -- https://example.org/somegame.zip somegame \\');
  console.log('      "Freeware fan game, released by its author"\n');
  console.log('Where to find them:\n');
  for (const source of SOURCES) {
    console.log(`  ${source.what}`);
    console.log(`    ${source.where}`);
    console.log(`    ${source.note}\n`);
  }
  console.log('What to fetch:\n');
  for (const line of WANTED) console.log(`  ${line}`);
  console.log('');
  console.log('There is no free SCI2, SCI2.1 or SCI3 data at all — no fan toolchain');
  console.log('targets SCI32 — so for half the family this script has nothing to offer');
  console.log('and the Tier 1 fixture is all there is. See');
  console.log('docs/processes/verifying-version-support.md.\n');
  console.log('Nothing fetched here is ever committed: games/*.zip and games/LICENCES.txt');
  console.log('are gitignored. Run `git status` afterwards — it should be clean.');
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
      'Games fetched by `npm run fetch:sci` and `npm run fetch:agi`. None of this\n' +
      'is part of the repository: what these scripts write is gitignored and\n' +
      'these files are yours, locally.\n\n';
  }

  await appendFile(
    path,
    `${id}.zip\n  Source:  ${url}\n  Licence: ${licence}\n  Fetched: ${new Date().toISOString()}\n\n`,
  );
  if (header) {
    // Prepended rather than written first, so a file `fetch:agi` already
    // started keeps its own header instead of gaining a second one.
    const { readFile } = await import('node:fs/promises');
    const body = await readFile(path, 'utf8');
    await writeFile(path, header + body);
  }
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
    console.error('A licence is required — it is what says this game may be redistributed.\n');
    console.error('  npm run fetch:sci -- <url> <id> "Freeware fan game, released by its author"');
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
  console.log(`  npm run diagnose -- games/${id}.zip     # what it loads and what it reaches`);
  console.log(`  npm run sweep -- games/${id}.zip        # unknown opcodes and Kernel numbers`);
  console.log(`  npm start, then ?game=${id}             # play it\n`);

  const contents = await readdir(GAMES_DIR);
  console.log(`games/ now holds: ${contents.join(', ')}`);
  console.log('`git status` should be clean — everything this wrote is gitignored.');
}

await main();
