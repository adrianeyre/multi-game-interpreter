/**
 * Downloads a freely redistributable Virtual Theatre game into `games/`.
 *
 *   npm run fetch:vt                              # where to find them
 *   npm run fetch:vt -- <url> <id> "<licence>"    # fetch one
 *
 * A sibling of `bin/fetch-agi.ts` and `bin/fetch-sci.ts`, deliberately the same
 * shape. What differs is how much this one is worth.
 *
 * ## Why this script matters more than its siblings
 *
 * `docs/processes/verifying-version-support.md` opens by saying real game data
 * "cannot live in this repository", so **Completable** "is not something CI can
 * ever assert". That is true of every family here except this one.
 *
 * Revolution Software released **both** their adventures as freeware in 2003 —
 * Lure of the Temptress and Beneath a Steel Sky — with ScummVM's involvement
 * and their own blessing. They are the only complete commercial games this
 * project may lawfully fetch on a build machine, which makes them the only
 * escape from Tier 1's trap: "a fixture encodes our reading of the format. If
 * that reading is wrong, the fixture and the engine agree with each other and
 * disagree with the game."
 *
 * ADR 0023 leans on exactly this, and #266 is where it gets cashed.
 *
 * ## What each game is worth pointing this at
 *
 * **Lure of the Temptress** is the one that pays off today. Its container
 * format is read and verified (#261) and its resource addressing was derived
 * from the game's own executable rather than guessed — so a fetched copy can be
 * checked against a reader that already exists, rather than only looked at.
 *
 * **Beneath a Steel Sky** pays off differently for each release, and which one
 * you fetch decides how far it gets. The index reading is settled — 1,445
 * resources on the freeware floppy release and 5,097 on the CD, each packed one
 * checked against the CRC of its own unpacked bytes — so the question is no
 * longer addressing but where a release keeps its Compact table.
 *
 * The **freeware CD release** ships `sky.cpt` and is the one that boots:
 * `SkyEngine` loads it, applies its Release's starting state and runs its
 * scripts. The **freeware floppy release** ships neither `sky.cpt` nor
 * `SKY.EXE`, so it has no object table to read and is refused by name. An
 * **original release** keeps the table in `SKY.EXE`, which reading is not
 * implemented (#246, #252) — and note that ScummVM's demo mirror carries DOS
 * demos that *do* ship `SKY.EXE`, so a release to check such a reader against
 * is fetchable even though no freeware release of the full game is one.
 *
 * ## Why it takes a URL rather than shipping a catalogue
 *
 * The same reasoning as its siblings, and it survives the obvious objection.
 * There are only two games and one canonical source, so a hardcoded pair of
 * links looks safe — but a rotted link in a tool like this fails at the moment
 * somebody is trying to diagnose something else, and "freely redistributable"
 * is a claim about a *specific release*. Making the licence an argument is what
 * makes stating it the act of having checked.
 *
 * ## The hard constraint
 *
 * **Nothing fetched here is ever committed.** The `games` directory and the
 * game folders inside it are gitignored, and `public/games/` deploys to the live site, so committing there
 * would be redistributing somebody else's game from our own domain. The rule
 * does not bend for a permissive licence, and it does not bend for these two
 * even though their licence would allow it — the repository has no game data to
 * carry, and that is a property worth keeping rather than an accident.
 */

import { appendFile, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const GAMES_DIR = resolve(process.cwd(), 'games');

/**
 * Where the freeware releases live, as of writing.
 *
 * Prose rather than a manifest, matching `fetch:sci`: each entry says what the
 * place holds, so somebody choosing between them chooses on more than a domain.
 */
const SOURCES = [
  {
    what: "ScummVM's freeware games",
    where: 'https://www.scummvm.org/games/',
    note:
      'The canonical home of both releases. Revolution released them through ' +
      'ScummVM in 2003, so this is the publisher-sanctioned distribution rather ' +
      'than a mirror of one.',
  },
  {
    what: 'ScummVM downloads — extras',
    where: 'https://downloads.scummvm.org/frs/extras/',
    note:
      'The files themselves, one directory per game, several release variants ' +
      'each, with .sha256 files beside them. Check the digest: a licence permits ' +
      'redistribution and says nothing about what a mirror served you.',
  },
];

/**
 * What is worth fetching, and what each one exercises.
 *
 * Named precisely rather than as "a Virtual Theatre game", because the two
 * families are separate engines (ADR 0026) and reach very different depths
 * today.
 */
const WANTED = [
  'Lure of the Temptress — the one with a reader behind it. Ships Revolution’s',
  '  own executable, four VGA containers and four EGA, and 613 resources whose',
  '  addressing is verified. Check it against the container reader.',
  '',
  'Beneath a Steel Sky, floppy — the smaller of the two, and the one whose',
  '  sky.dnr holds 1,445 entries. The index reader should parse it exactly.',
  '',
  'Beneath a Steel Sky, CD — 5,097 index entries and roughly six times the',
  '  data. Worth having because it is the same entry layout at a very',
  '  different scale, which is what caught a 16-bit reading that fitted the',
  '  floppy alone.',
];

function usage(): void {
  console.log('Fetches a freely redistributable Virtual Theatre game into games/.\n');
  console.log('  npm run fetch:vt -- <url> <id> "<licence>"\n');
  console.log('For example:\n');
  console.log('  npm run fetch:vt -- https://example.org/lure-x.y.zip lure \\');
  console.log('      "Freeware, released by Revolution Software in 2003"\n');
  console.log('Where to find them:\n');
  for (const source of SOURCES) {
    console.log(`  ${source.what}`);
    console.log(`    ${source.where}`);
    console.log(`    ${source.note}\n`);
  }
  console.log('What to fetch:\n');
  for (const line of WANTED) console.log(`  ${line}`);
  console.log('');
  console.log('These two are the only complete commercial games this project may');
  console.log('lawfully fetch, which makes them the only escape from the synthetic-fixture');
  console.log('trap in docs/processes/verifying-version-support.md.\n');
  console.log('Nothing fetched here is ever committed: games/* is gitignored.');
  console.log('Run `git status` afterwards — it should be clean.');
}

/**
 * Records what was fetched and under what licence.
 *
 * Written to `games/LICENCES.txt`, itself gitignored, so the record travels
 * with the download rather than with the repository — which is the right way
 * round, because the repository has no game data to attribute.
 */
async function recordLicence(id: string, url: string, licence: string): Promise<void> {
  const path = join(GAMES_DIR, 'LICENCES.txt');
  let header = '';
  try {
    await stat(path);
  } catch {
    header =
      'Games fetched by the `npm run fetch:*` scripts. None of this is part of\n' +
      'the repository: what these scripts write is gitignored and these files\n' +
      'are yours, locally.\n\n';
  }

  await appendFile(
    path,
    `${id}.zip\n  Source:  ${url}\n  Licence: ${licence}\n  Fetched: ${new Date().toISOString()}\n\n`,
  );
  if (header) {
    // Prepended rather than written first, so a file a sibling fetcher already
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
    // checked it, and a default would make the check skippable — which matters
    // more here than for the siblings, because these two are whole commercial
    // games rather than fan-made ones.
    console.error('A licence is required — it is what says this game may be redistributed.\n');
    console.error(
      '  npm run fetch:vt -- <url> <id> "Freeware, released by Revolution Software in 2003"',
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
  console.log(`  npm start, then drop games/${id}.zip on the page`);
  console.log('');
  console.log('How far a fetched game gets: run `npm run play:vt -- games/' + id + '.zip`');
  console.log('and it prints the Stage by name. Sky has an Engine and its freeware CD');
  console.log('release boots on it; the floppy release and the DOS demos are refused for');
  console.log('want of a Compact table this project can reach. Lure has no interpreter, so');
  console.log('it is refused by name. `npm run sweep:vt` is the other half and reads every');
  console.log('resource either way.\n');

  const contents = await readdir(GAMES_DIR);
  console.log(`games/ now holds: ${contents.join(', ')}`);
  console.log('`git status` should be clean — everything this wrote is gitignored.');
}

await main();
