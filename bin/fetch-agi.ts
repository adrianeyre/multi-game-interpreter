/**
 * Downloads a freely redistributable AGI game into `games/`, for local
 * diagnosis.
 *
 *   npm run fetch:agi                             # where to find games
 *   npm run fetch:agi -- <url> <id> "<licence>"   # fetch one
 *
 * ## Why this exists
 *
 * `docs/processes/verifying-version-support.md` warns that a synthetic fixture
 * "encodes our reading of the format — if that reading is wrong, the fixture and
 * the engine agree with each other and disagree with the game". For SCUMM the
 * escape from that trap is LucasArts' free demos, which found four faults in
 * the first hour, all invisible to a passing test suite.
 *
 * AGI's equivalent is better. AGI Studio and WinAGI produced over 180 freely
 * redistributable **fan-made games** across twenty-five years — real `*DIR`
 * indexes, real `VOL` volumes, real Logic bytecode, real vector Pictures — and
 * unlike Sierra's own releases they may be redistributed, so a script may fetch
 * them.
 *
 * ## Why it takes a URL rather than shipping a catalogue
 *
 * A hardcoded list of third-party download links is a list that rots, and a
 * rotted link in a tool like this is worse than no tool: it fails at the moment
 * someone is trying to diagnose something else. More importantly, "freely
 * redistributable" is a claim about a *specific release*, and a catalogue
 * invites fetching whatever is at a URL without anyone having checked. So the
 * licence is an argument, and stating it is the act of having checked.
 *
 * `SOURCES` below says where to look. It is prose because it is advice.
 *
 * ## The hard constraint
 *
 * **Nothing is committed.** `games/*` and `public/games/*` stay gitignored, and
 * `public/games/` deploys to the live site — committing there would redistribute
 * someone else's game from our own domain. The README's "It ships no game data"
 * is load-bearing and does not get qualified.
 *
 * CI therefore stays on the synthetic fixture, and AGI keeps the same blind spot
 * SCUMM has. That consequence is accepted rather than worked around (#125).
 */

import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GAMES_DIR = resolve(process.cwd(), 'games');

/** Where freely redistributable AGI games live, as of writing. */
const SOURCES = [
  {
    what: 'ScummVM wiki: AGI fan games',
    where: 'https://wiki.scummvm.org/index.php/AGI/Fan_Games',
    note: 'An alphabetical index of over 180 fan games, each with its own page and download.',
  },
  {
    what: 'SCI Programming: fan game archive',
    where: 'https://sciprogramming.com/fangames.php',
    note: 'Fan-made AGI and SCI games, free to download. The AGI archive thread has the bulk of them.',
  },
  {
    what: 'AGI Development Site',
    where: 'https://www.agidev.com/',
    note: 'The AGI Specification itself, plus games and the tools they were built with.',
  },
];

function usage(): void {
  console.log('Fetches a freely redistributable AGI game into games/, for local diagnosis.\n');
  console.log('  npm run fetch:agi -- <url> <id> "<licence>"\n');
  console.log('For example:\n');
  console.log('  npm run fetch:agi -- https://example.org/somegame.zip somegame \\');
  console.log('      "Freeware fan game, released by its author"\n');
  console.log('Where to find them:\n');
  for (const source of SOURCES) {
    console.log(`  ${source.what}`);
    console.log(`    ${source.where}`);
    console.log(`    ${source.note}\n`);
  }
  console.log('Prefer one AGI v2 game and one AGI v3 game: v3 is the only thing that');
  console.log('exercises the combined index and the LZW volumes against data we did not');
  console.log('write, which is the whole point of fetching anything.\n');
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
      'Games fetched by `npm run fetch:agi`. None of this is part of the\n' +
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
    console.error('A licence is required — it is what says this game may be redistributed.\n');
    console.error('  npm run fetch:agi -- <url> <id> "Freeware fan game, released by its author"');
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
  console.log(`  npm start, then ?game=${id}             # play it\n`);

  const contents = await readdir(GAMES_DIR);
  console.log(`games/ now holds: ${contents.join(', ')}`);
  console.log('`git status` should be clean — everything here is gitignored.');
}

await main();
