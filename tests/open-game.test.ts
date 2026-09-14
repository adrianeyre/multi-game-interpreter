import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openGame } from '../src/hosting/openGame.js';

const made: string[] = [];

async function folder(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scumm-open-'));
  made.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('opening a game from a path', () => {
  it('reads the files in subfolders as well as the ones beside the index', async () => {
    // A v7 release does not keep everything in one place: Full Throttle and
    // The Dig put their videos, audio bundles and subtitle fonts in `VIDEO/`,
    // `VOICE/` and the like. Reading only the top level found the index and
    // none of that, which had the diagnostic report no .NUT font beside a game
    // shipping eight of them.
    const dir = await folder();
    await writeFile(join(dir, 'FT.LA0'), Uint8Array.of(1));
    await mkdir(join(dir, 'VIDEO'));
    await writeFile(join(dir, 'VIDEO', 'INTRO.SAN'), Uint8Array.of(2));
    await mkdir(join(dir, 'VIDEO', 'FONTS'));
    await writeFile(join(dir, 'VIDEO', 'FONTS', 'FONT1.NUT'), Uint8Array.of(3));

    const source = await openGame(dir);

    // A lookup matches on the base name, so a script asking for a file by the
    // name it knows finds it wherever the release chose to put it.
    expect(await source.read('FT.LA0')).toEqual(Uint8Array.of(1));
    expect(await source.read('INTRO.SAN')).toEqual(Uint8Array.of(2));
    expect(await source.read('FONT1.NUT')).toEqual(Uint8Array.of(3));
  });

  it('tells two same-named files in different folders apart', async () => {
    // The Dig's demo keeps one `.voc` per line of dialogue in a folder per
    // room, and the line numbers recur across rooms: 39 of its 225 recordings
    // share a base name with another. Matching on the base name alone played
    // whichever was read last, which is a wrong line of dialogue rather than a
    // missing one — so a caller that knows the folder can ask for the path.
    const dir = await folder();
    await writeFile(join(dir, 'DIG.LA0'), Uint8Array.of(1));
    await mkdir(join(dir, 'audio', 'logo.1'), { recursive: true });
    await mkdir(join(dir, 'audio', 'nexus.23'), { recursive: true });
    await writeFile(join(dir, 'audio', 'logo.1', '1111.voc'), Uint8Array.of(10));
    await writeFile(join(dir, 'audio', 'nexus.23', '1111.voc'), Uint8Array.of(23));

    const source = await openGame(dir);

    expect(await source.read('audio/logo.1/1111.voc')).toEqual(Uint8Array.of(10));
    expect(await source.read('audio/nexus.23/1111.voc')).toEqual(Uint8Array.of(23));
  });

  it('lists both of them, so a scan can find either', async () => {
    // `list` is how the speech folders are discovered, so collapsing the two
    // to one name would hide half the recordings from the index that is built
    // from it.
    const dir = await folder();
    await mkdir(join(dir, 'audio', 'logo.1'), { recursive: true });
    await mkdir(join(dir, 'audio', 'nexus.23'), { recursive: true });
    await writeFile(join(dir, 'audio', 'logo.1', '1111.voc'), Uint8Array.of(10));
    await writeFile(join(dir, 'audio', 'nexus.23', '1111.voc'), Uint8Array.of(23));

    const listed = (await openGame(dir)).list().map((name) => name.replace(/\\/g, '/'));

    expect(listed).toContain('audio/logo.1/1111.voc');
    expect(listed).toContain('audio/nexus.23/1111.voc');
  });

  it('keeps a top-level file’s own name pointing at it', async () => {
    // A file at the root has one key, which *is* its base name, so a file in a
    // subfolder must not be able to take it. Otherwise a release with a stray
    // `VIDEO/FT.LA0` would answer the index lookup with the wrong file.
    const dir = await folder();
    await writeFile(join(dir, 'FT.LA0'), Uint8Array.of(1));
    await mkdir(join(dir, 'VIDEO'));
    await writeFile(join(dir, 'VIDEO', 'FT.LA0'), Uint8Array.of(2));

    const source = await openGame(dir);

    expect(await source.read('FT.LA0')).toEqual(Uint8Array.of(1));
    expect(await source.read('VIDEO/FT.LA0')).toEqual(Uint8Array.of(2));
  });

  it('reads a single file, since its pair usually sits beside it', async () => {
    const dir = await folder();
    const path = join(dir, 'MONKEY.000');
    await writeFile(path, Uint8Array.of(4));

    const source = await openGame(path);

    expect(await source.read('MONKEY.000')).toEqual(Uint8Array.of(4));
  });
});
