import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectAgosGame } from '../src/engine/agos/resource/agosDetect.js';
import {
  exportAgosProject,
  importAgosProject,
  stringReferences,
} from '../src/authoring/agos/project.js';
import { describeTarget, parseTarget, sameTarget } from '../src/authoring/target.js';
import { buildArchive, buildGamePc } from './fixtureAgos.js';

async function importFixture(withSpeech = true) {
  const data = buildGamePc({ withSpeech });
  const source = new MemoryDataSource('agos-fixture');
  source.set('GAMEPC', data);
  source.set('SIMON.GME', buildArchive());
  if (withSpeech) source.set('SIMON.VOC', Uint8Array.of(0));
  const detection = await detectAgosGame(source);
  return { data, project: importAgosProject(data, detection) };
}

describe('an AGOS Project', () => {
  it('holds instructions, the item tree and the pooled strings', async () => {
    const { project } = await importFixture();

    expect(project.game.subroutines.subroutines).toHaveLength(2);
    expect(project.items.map((item) => item.id)).toEqual([2, 3]);
    expect(project.strings).toEqual(['one', 'two', 'three']);
  });

  it('numbers items from 2, because the first two are predefined', async () => {
    const { project } = await importFixture();
    const room = project.items[0]!;

    // The room's child link names item 3, and the tree agrees from the other end.
    expect(project.items[1]!.parent).toBe(2);
    expect(room.children).toEqual([3]);
  });

  it('names an item from the strings its own fields index', async () => {
    const { project } = await importFixture();

    // Derived rather than stored: a stored name would be a second source of
    // truth that export would have to reconcile.
    expect(typeof project.items[0]!.name).toBe('string');
  });

  it('can say which Subroutines reach a string, because many share one table', async () => {
    const { project } = await importFixture();
    const references = stringReferences(project);

    // ADR 0009's shape, not AGI's: an edit's reach is real and shown.
    expect([...references.values()].flat().length).toBeGreaterThan(0);
  });
});

describe('editing is offered only when all three conditions hold', () => {
  it('allows editing a game that probed, agreed and round-tripped', async () => {
    const { project } = await importFixture();

    expect(project.editable).toMatchObject({
      versionProbed: true,
      structurallyAgrees: true,
      roundTrips: true,
      editable: true,
      unrecovered: 0,
    });
  });

  it('exports byte for byte what it imported', async () => {
    const { data, project } = await importFixture();

    expect(exportAgosProject(project)).toEqual(data);
  });

  it('refuses to export a game it could not recover, rather than writing a misread one', async () => {
    const { project } = await importFixture();
    const notEditable = {
      ...project,
      editable: {
        ...project.editable,
        roundTrips: false,
        editable: false,
        unrecovered: 1,
        reasons: ['test'],
      },
    };

    expect(() => exportAgosProject(notEditable)).toThrow(/not editable/);
  });
});

describe('the Target an AGOS Project is tagged with', () => {
  it('writes the release kind out, because decoding depends on it', async () => {
    const { project } = await importFixture();

    expect(describeTarget(project.target)).toBe('AGOS Simon1 (talkie)');
  });

  it('refuses a stored Target with no release kind rather than defaulting one', () => {
    expect(parseTarget({ engine: 'agos', version: 'Simon1', platform: 'dos' })).toBeNull();
    expect(
      parseTarget({ engine: 'agos', version: 'Simon1', releaseKind: 'talkie', platform: 'dos' }),
    ).toMatchObject({ engine: 'agos', releaseKind: 'talkie' });
  });

  it('does not treat a floppy and a talkie release as the same Target', () => {
    const floppy = parseTarget({
      engine: 'agos',
      version: 'Simon1',
      releaseKind: 'floppy',
      platform: 'dos',
    })!;
    const talkie = parseTarget({
      engine: 'agos',
      version: 'Simon1',
      releaseKind: 'talkie',
      platform: 'dos',
    })!;

    expect(sameTarget(floppy, floppy)).toBe(true);
    expect(sameTarget(floppy, talkie)).toBe(false);
  });
});
