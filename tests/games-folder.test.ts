import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInsideFolder, scanGamesFolder } from '../src/hosting/gamesFolder.js';

/**
 * Reading a `games/` folder.
 *
 * The point of the folder is that game data is too big to pick through a
 * browser dialog on every reload — Sam & Max's talkie is thirteen megabytes —
 * so what matters here is that the three shapes people actually have on disk
 * are all recognised, and that nothing outside the folder can be reached
 * through it.
 */
let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scumm-games-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const write = async (path: string, bytes = 4) => {
  await writeFile(join(root, path), new Uint8Array(bytes));
};

describe('what the folder holds', () => {
  it('is empty when there is no folder at all, which is the ordinary case', async () => {
    expect(await scanGamesFolder(join(root, 'nothing-here'))).toEqual([]);
  });

  it('reads a subfolder as one game, listing its files for the browser', async () => {
    await mkdir(join(root, 'dott'));
    await write('dott/DOTTDEMO.001', 900);
    await write('dott/DOTTDEMO.000', 100);

    const entries = await scanGamesFolder(root);

    expect(entries).toEqual([
      {
        id: 'dott',
        name: 'dott',
        kind: 'folder',
        // Sorted, so the list is stable between reloads rather than however
        // the filesystem happened to answer.
        files: ['DOTTDEMO.000', 'DOTTDEMO.001'],
        bytes: 1000,
      },
    ]);
  });

  /**
   * A game arrives as a zip — the demos from scummvm.org are zips — and the
   * browser can already unpack one, so asking for it to be extracted first is
   * a step worth sparing.
   */
  it('offers a zip without unpacking it, since the browser can', async () => {
    await write('samnmax.zip', 2048);

    expect(await scanGamesFolder(root)).toEqual([
      { id: 'samnmax.zip', name: 'samnmax.zip', kind: 'zip', files: [], bytes: 2048 },
    ]);
  });

  /**
   * Loose files are handed over whole rather than sorted into games by
   * filename. The engine's own detector decides which files pair up, exactly
   * as it does for a folder picked in the browser — so this module never has
   * to invent a rule about names.
   */
  it('offers loose files in the root as a single entry', async () => {
    await write('MONKEY2.000', 10);
    await write('MONKEY2.001', 20);
    await write('MONSTER.SOU', 30);

    const entries = await scanGamesFolder(root);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: '',
      kind: 'loose',
      files: ['MONKEY2.000', 'MONKEY2.001', 'MONSTER.SOU'],
      bytes: 60,
    });
  });

  it('keeps subfolders, zips and loose files apart in one folder', async () => {
    await mkdir(join(root, 'atlantis'));
    await write('atlantis/ATLANTIS.000');
    await write('dott.zip');
    await write('MONKEY2.000');

    const kinds = (await scanGamesFolder(root)).map((entry) => `${entry.kind}:${entry.id}`);

    expect(kinds).toEqual(['folder:atlantis', 'zip:dott.zip', 'loose:']);
  });

  it('ignores the notes and metadata that sit beside game data', async () => {
    await write('README.md');
    await write('.DS_Store');
    await write('.gitkeep');

    expect(await scanGamesFolder(root)).toEqual([]);
  });

  /**
   * A folder laid out for static hosting keeps its `manifest.json`, and it is
   * still honoured there — but it is not game data, and offering it as a file
   * to load would have the engine try to read JSON as a SCUMM index.
   */
  it('does not offer a manifest as though it were game data', async () => {
    await mkdir(join(root, 'monkey2'));
    await write('monkey2/manifest.json');
    await write('monkey2/MONKEY2.000');

    const entries = await scanGamesFolder(root);
    expect(entries[0].files).toEqual(['MONKEY2.000']);
  });

  it('skips an empty subfolder rather than offering a game with no files', async () => {
    await mkdir(join(root, 'empty'));
    expect(await scanGamesFolder(root)).toEqual([]);
  });
});

describe('a game that keeps things in subfolders', () => {
  it('lists what is inside them, because v7 releases put their videos there', async () => {
    // Full Throttle and The Dig do not keep everything beside the index. A
    // listing one level deep finds the index and none of the cutscenes, so the
    // game boots and then plays no video, no music and no speech.
    await mkdir(join(root, 'throttle'));
    await mkdir(join(root, 'throttle/VIDEO'));
    await mkdir(join(root, 'throttle/VOICE'));
    await write('throttle/FT.LA0', 100);
    await write('throttle/VIDEO/INTRO.SAN', 200);
    await write('throttle/VOICE/VOXDISK.BUN', 300);

    const [entry] = await scanGamesFolder(root);

    // Relative paths, so the server can serve them; a lookup still matches on
    // the base name alone, which is what lets a script ask for `INTRO.SAN`
    // without knowing which folder it is in.
    expect(entry.files).toEqual(['FT.LA0', 'VIDEO/INTRO.SAN', 'VOICE/VOXDISK.BUN']);
    expect(entry.bytes).toBe(600);
  });

  it('follows more than one level, and counts every file’s size', async () => {
    await mkdir(join(root, 'dig/A/B'), { recursive: true });
    await write('dig/A/B/deep.san', 50);

    const [entry] = await scanGamesFolder(root);
    expect(entry.files).toEqual(['A/B/deep.san']);
    expect(entry.bytes).toBe(50);
  });

  it('does not offer a game whose folders hold nothing', async () => {
    await mkdir(join(root, 'hollow/inner'), { recursive: true });
    expect(await scanGamesFolder(root)).toEqual([]);
  });

  it('still ignores the names that are never game data, at any depth', async () => {
    await mkdir(join(root, 'dott/extra'), { recursive: true });
    await write('dott/DOTT.000', 10);
    await write('dott/extra/README.md', 10);

    const [entry] = await scanGamesFolder(root);
    expect(entry.files).toEqual(['DOTT.000']);
  });
});

describe('staying inside the folder', () => {
  /**
   * The server hands back whatever the URL names, so this is the only thing
   * between a crafted request and the rest of the disk. It is checked on the
   * resolved path rather than by looking for `..` in the text, because there is
   * always another way to write `..`.
   */
  it('allows a file in the folder and in a subfolder of it', () => {
    expect(isInsideFolder('/srv/games', '/dott/DOTTDEMO.000')).toBe(true);
    expect(isInsideFolder('/srv/games', '/samnmax.zip')).toBe(true);
    expect(isInsideFolder('/srv/games', '/')).toBe(true);
  });

  it('refuses a path that climbs out, however it is spelled', () => {
    expect(isInsideFolder('/srv/games', '/../package.json')).toBe(false);
    expect(isInsideFolder('/srv/games', '/dott/../../package.json')).toBe(false);
    expect(isInsideFolder('/srv/games', '/./../.env')).toBe(false);
  });

  /**
   * A sibling whose name merely *starts* with the folder's name is outside it.
   * A prefix comparison without the separator would let `/srv/games-private`
   * through.
   */
  it('refuses a sibling folder with a matching prefix', () => {
    expect(isInsideFolder('/srv/games', '/../games-private/secret')).toBe(false);
  });
});
