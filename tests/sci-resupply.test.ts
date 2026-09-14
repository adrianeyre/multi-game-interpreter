// @vitest-environment jsdom
/**
 * Re-supplying a SCI game folder, which is what an export packs into.
 *
 * Tier 1 over `fixtureSci.ts`. What is being checked is not the reading — the
 * reader has its own evidence — but the three decisions this module makes on
 * top of it: whether a folder is the one this project came from, which
 * container an export should therefore write, and which Volumes get carried
 * through unrebuilt (#227).
 *
 * The refusal is the part worth a test. A SCI1.1 project packed into a flat
 * SCI0 map does not fail: every entry still parses, at the wrong widths, and
 * the install loads and serves the wrong bytes. So the check is structural and
 * its wrongness would be silent, which is the shape of thing that rots.
 */

import { describe, expect, it } from 'vitest';

import { carriedVolumes, readSciGameFolder } from '../src/editor/sci/resupply.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { createProject, type Project } from '../src/authoring/project.js';
import { buildSci0Fixture, buildSci11Fixture, type SciFixture } from './fixtureSci.js';

/** The fixture's files as a directory picker would hand them over. */
function filesOf(fixture: SciFixture, extra: Record<string, Uint8Array> = {}): File[] {
  const all = new Map<string, Uint8Array>([...fixture.files, ...Object.entries(extra)]);
  return [...all].map(([name, data]) => {
    const copy = new Uint8Array(data);
    return new File([copy], name);
  });
}

/**
 * A Project as `SciEngine.toEditableGame` builds one: the class graph, under
 * the Target the detection arrived at.
 */
async function projectFrom(fixture: SciFixture): Promise<Project> {
  const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files), {
    onLog: () => undefined,
  });
  return {
    ...createProject(game.id),
    target: {
      engine: 'sci',
      version: game.version,
      platform: game.platform,
      identification: game.identification,
    },
    sci: await importSciGame(game, resources),
  };
}

describe('opening the folder a SCI project came from', () => {
  it('accepts it, and reports the container rather than deriving one', async () => {
    const fixture = buildSci11Fixture();
    const folder = await readSciGameFolder('kq6', filesOf(fixture), await projectFrom(fixture));

    expect(typeof folder).not.toBe('string');
    if (typeof folder === 'string') return;
    // Read off the folder's bytes, which is the only place either fact is:
    // ADR 0020 keeps the Version a probe and the map structure a reading, and
    // neither one implies the other.
    expect(folder.game.mapVersion).toBe('sci11');
    expect(folder.game.layout.mapFile).toBe('RESOURCE.MAP');
  });

  it("refuses a container that never carried this project's Version, and says which did", async () => {
    // The project is SCI1.1; the folder is a flat SCI0 map. Both read; the
    // pairing is the lie.
    const project = await projectFrom(buildSci11Fixture());
    const result = await readSciGameFolder('wrong', filesOf(buildSci0Fixture()), project);

    expect(typeof result).toBe('string');
    expect(String(result)).toContain('sci0-sci1-early');
    expect(String(result)).toContain('loads and serves the wrong bytes');
  });

  it('refuses a project of another family before it reads a byte', async () => {
    const project = await projectFrom(buildSci0Fixture());
    const scumm: Project = { ...project, target: { engine: 'scumm', version: 5 } };
    expect(await readSciGameFolder('kq4', filesOf(buildSci0Fixture()), scumm)).toBe(
      'This is not a SCI project.',
    );
  });
});

describe('the Volumes an export carries rather than rebuilds (#227)', () => {
  it('names the ones this folder holds, and only those', async () => {
    const fixture = buildSci0Fixture();
    const folder = await readSciGameFolder(
      'kq4',
      filesOf(fixture, { 'RESOURCE.AUD': Uint8Array.of(1, 2, 3, 4) }),
      await projectFrom(fixture),
    );

    expect(typeof folder).not.toBe('string');
    if (typeof folder === 'string') return;
    // `RESOURCE.SFX` is in the carried list and not in this folder, so it is
    // absent rather than promised: an export that wrote an empty one would
    // produce an install that looks complete and has no sound in it.
    expect(folder.carriedNames).toEqual(['RESOURCE.AUD']);
    expect(await carriedVolumes(folder)).toEqual([
      { name: 'RESOURCE.AUD', data: Uint8Array.of(1, 2, 3, 4) },
    ]);
  });

  it('holds none when the game shipped none', async () => {
    const fixture = buildSci0Fixture();
    const folder = await readSciGameFolder('kq4', filesOf(fixture), await projectFrom(fixture));

    expect(typeof folder).not.toBe('string');
    if (typeof folder === 'string') return;
    expect(folder.carriedNames).toEqual([]);
    expect(await carriedVolumes(folder)).toEqual([]);
  });
});
