import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFolderReadme, scanGamesFolder } from '../src/hosting/gamesFolder.js';
import { describeEntry, entryBaseUrl, entrySubtitle, entryTitle } from '../src/ui/gamesFolder.js';

/**
 * A game's own README, as the folder listing sees it.
 *
 * A folder called `indy` with `ATLANTIS.000` in it does not say which release
 * it is or what works in it, so a game's folder can carry a `README.md`: the
 * player lists the game under the README's title and shows the text when the
 * entry is clicked.
 *
 * Two things have to hold for that to be worth having. The README has to be
 * found and read for its title — cheaply, without loading a file that might be
 * a game's whole history — and it must not become game data: handed to the
 * engine's detector, or counted in the size the UI promises the load will cost.
 */
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgi-readme-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (path: string, contents: string | number) => {
  await writeFile(
    join(root, path),
    typeof contents === 'number' ? new Uint8Array(contents) : contents,
  );
};

describe('finding a game’s README', () => {
  it('names the file and reads the title out of its first heading', async () => {
    await mkdir(join(root, 'indy'));
    await write('indy/ATLANTIS.000', 10);
    await write('indy/README.md', '# Indiana Jones and the Fate of Atlantis\n\nSCUMM v5.\n');

    const [entry] = await scanGamesFolder(root);

    expect(entry).toMatchObject({
      id: 'indy',
      // The folder's own name is kept: it is what the loader logs and what a
      // data source is labelled with.
      name: 'indy',
      readme: 'README.md',
      title: 'Indiana Jones and the Fate of Atlantis',
    });
  });

  it('records the filename as it is spelled, because a URL is case-sensitive', async () => {
    await mkdir(join(root, 'dott'));
    await write('dott/TENTACLE.000', 10);
    await write('dott/readme.md', '# Day of the Tentacle\n');

    const [entry] = await scanGamesFolder(root);
    expect(entry.readme).toBe('readme.md');
    expect(entry.title).toBe('Day of the Tentacle');
  });

  it('offers the README without a title when the file does not open with one', async () => {
    await mkdir(join(root, 'game'));
    await write('game/GAME.000', 10);
    await write('game/README.md', '```\nnot a title\n```\n');

    const [entry] = await scanGamesFolder(root);
    expect(entry.readme).toBe('README.md');
    expect(entry.title).toBeUndefined();
  });

  /**
   * The second line is the convention for saying what a game runs on, so the
   * list can show "SCUMM v6" beside a name without opening the game's index.
   * It is the author's claim and is never acted on — the loader's own detector
   * still decides what the files are.
   */
  it('reads what the game runs on from the second line', async () => {
    await mkdir(join(root, 'sam'));
    await write('sam/SAMNMAX.000', 10);
    await write('sam/README.md', '# Sam & Max Hit the Road\n\nSCUMM v6\n\nLucasArts, 1993.\n');

    const [entry] = await scanGamesFolder(root);
    expect(entry.title).toBe('Sam & Max Hit the Road');
    expect(entry.engine).toBe('SCUMM v6');
  });

  it('leaves it out when the README opens straight into prose', async () => {
    await mkdir(join(root, 'game'));
    await write('game/GAME.000', 10);
    await write(
      'game/README.md',
      '# A game\n\nA long opening paragraph that is prose rather than the name of an interpreter.\n',
    );

    const [entry] = await scanGamesFolder(root);
    expect(entry.title).toBe('A game');
    expect(entry.engine).toBeUndefined();
  });

  it('says nothing at all about a folder that has no README', async () => {
    await mkdir(join(root, 'game'));
    await write('game/GAME.000', 10);

    const [entry] = await scanGamesFolder(root);
    expect(entry.readme).toBeUndefined();
    expect(entry.title).toBeUndefined();
    expect(entry.engine).toBeUndefined();
  });

  /**
   * The folder's own README describes the folder — "Drop a game you own in
   * here" — and is not the name of a game. It is still offered as text, so the
   * loose entry has something to show, but it never becomes a title.
   */
  it('never titles the loose entry after the folder’s own README', async () => {
    await write('MONKEY2.000', 10);
    await write('README.md', '# Your games folder\n\nDrop a game in here.\n');

    const [entry] = await scanGamesFolder(root);
    expect(entry).toMatchObject({ kind: 'loose', readme: 'README.md' });
    expect(entry.title).toBeUndefined();
    expect(entry.engine).toBeUndefined();
  });

  it('reads only the head of a long README, which is where a title can be', async () => {
    await mkdir(join(root, 'game'));
    await write('game/GAME.000', 10);
    await write('game/README.md', `# Title\n\n${'text '.repeat(40_000)}`);

    expect((await readFolderReadme(join(root, 'game')))?.title).toBe('Title');
  });

  it('is nothing for a folder that is not there', async () => {
    expect(await readFolderReadme(join(root, 'nothing-here'))).toBeNull();
  });
});

describe('documentation is not game data', () => {
  /**
   * `README.md` was already skipped as a file to load. Its pictures have to be
   * skipped for the same reason and one more: a 145 kB piece of box art
   * reported inside "9.6 MB" is a promise about the load that is not true.
   */
  it('keeps the README and its images out of the file list and the size', async () => {
    await mkdir(join(root, 'indy'));
    await write('indy/ATLANTIS.000', 1000);
    await write('indy/README.md', '# Indy\n');
    await write('indy/image.jpg', 5000);
    await write('indy/screenshot.png', 5000);

    const [entry] = await scanGamesFolder(root);

    expect(entry.files).toEqual(['ATLANTIS.000']);
    expect(entry.bytes).toBe(1000);
    expect(describeEntry(entry)).toBe('1 file · 1000 B');
  });

  it('keeps them out at any depth, since a README can sit in a subfolder', async () => {
    await mkdir(join(root, 'dig/VIDEO'), { recursive: true });
    await write('dig/DIG.LA0', 10);
    await write('dig/VIDEO/INTRO.SAN', 10);
    await write('dig/VIDEO/notes.md', 10);

    const [entry] = await scanGamesFolder(root);
    expect(entry.files).toEqual(['DIG.LA0', 'VIDEO/INTRO.SAN']);
  });

  it('does not offer a folder that holds only documentation', async () => {
    await mkdir(join(root, 'notes'));
    await write('notes/README.md', '# Nothing to play\n');

    expect(await scanGamesFolder(root)).toEqual([]);
  });
});

describe('what the browser calls an entry', () => {
  const entry = {
    id: 'indy',
    name: 'indy',
    kind: 'folder' as const,
    files: ['ATLANTIS.000'],
    bytes: 1000,
  };

  it('is the README’s title where there is one', () => {
    expect(entryTitle({ ...entry, title: 'Fate of Atlantis' })).toBe('Fate of Atlantis');
  });

  it('falls back to the folder name, which is what it showed before', () => {
    expect(entryTitle(entry)).toBe('indy');
    expect(entryTitle({ ...entry, title: '   ' })).toBe('indy');
  });

  it('says what it runs on first, then how it will be read and how big it is', () => {
    expect(entrySubtitle({ ...entry, engine: 'SCUMM v5' })).toBe('SCUMM v5 · 1 file · 1000 B');
  });

  it('says only the rest when no README named an interpreter', () => {
    expect(entrySubtitle(entry)).toBe('1 file · 1000 B');
    expect(entrySubtitle({ ...entry, engine: '  ' })).toBe('1 file · 1000 B');
  });

  /**
   * The base a README's own `![](image.jpg)` resolves against. Resolved
   * against the page instead, it would name a file at the site root — which is
   * a broken image on every README that has a picture in it.
   */
  it('resolves a README’s relative links against the game’s own folder', () => {
    expect(entryBaseUrl(entry)).toBe('games/indy/');
    expect(entryBaseUrl({ ...entry, id: '', kind: 'loose' })).toBe('games/');
  });
});
