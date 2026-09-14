import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { importGame } from '../src/authoring/importGame.js';
import { createProject, migrate } from '../src/authoring/project.js';
import { buildProject, describeUnbuildableTarget } from '../src/authoring/projectToGame.js';
import { buildFixture } from './fixture.js';
import { buildV6Fixture } from './fixtureV6.js';

async function load(which: 'v5' | 'v6') {
  const fixture = which === 'v6' ? buildV6Fixture() : buildFixture();
  const source = new MemoryDataSource(which);
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const game = await detectGame(source);
  return ResourceManager.load(source, game);
}

describe('a project knows which SCUMM version it is for', () => {
  /**
   * A different number from the project *format* version, which changes when
   * the editor's shape does. Sharing one field would break either migration or
   * version selection, and eventually both (ADR 0004).
   */
  it('keeps the game target separate from the project format version', () => {
    const project = createProject('fresh');
    expect(project.version).toBe(6);
    // A project created in the editor rather than imported has no game to have
    // identified, so it carries no identification — which reads as positively
    // identified, and is right: nothing about it was guessed.
    expect(project.target).toEqual({ engine: 'scumm', version: 5 });

    project.target = { engine: 'scumm', version: 6 };
    expect(project.version).toBe(6);
  });

  it('defaults a project written before v6 support to v5, which is what it was', () => {
    const older = { version: 5, name: 'older', rooms: [], actors: [] };
    expect(migrate(older).target).toEqual({ engine: 'scumm', version: 5 });
  });

  it('keeps a v6 target across a save and load', () => {
    const project = createProject('tentacle');
    project.target = { engine: 'scumm', version: 6 };

    expect(migrate(JSON.parse(JSON.stringify(project))).target).toEqual({
      engine: 'scumm',
      version: 6,
    });
  });
});

describe('importing sets the target from the game', () => {
  it('imports a v5 game as a v5 project', async () => {
    const { project } = importGame(await load('v5'));
    // The identification rides along, because ADR 0013's editing rule turns on
    // it and it cannot be recovered later from the version alone.
    expect(project.target).toEqual({
      engine: 'scumm',
      version: 5,
      identification: 'index-structure',
    });
  });

  it('imports a v6 game as a v6 project', async () => {
    const { project } = importGame(await load('v6'));
    expect(project.target).toEqual({
      engine: 'scumm',
      version: 6,
      identification: 'index-structure',
    });
  });
});

describe('refusing to compile a v6 project to v5 output', () => {
  /**
   * The compiler emits v5 bytecode. A v6 project's imported scripts are v6
   * instructions, and mixing the two in one script is not a game — so this is
   * refused with a reason rather than built into something no interpreter can
   * run.
   */
  it('says why, rather than producing an unrunnable game', () => {
    const project = createProject('tentacle');
    project.target = { engine: 'scumm', version: 6 };

    expect(describeUnbuildableTarget(project)).toMatch(/v6/);
    const built = buildProject(project);
    expect(built.errors.join(' ')).toMatch(/refused|not supported/);
    expect(built.data).toHaveLength(0);
  });

  it('does not refuse a v5 project over its target', () => {
    const project = createProject('ordinary');

    expect(describeUnbuildableTarget(project)).toBeNull();
    // A blank project still fails validation for having no rooms — which is a
    // complaint about its contents, not about the version it targets.
    expect(buildProject(project).errors.join(' ')).not.toMatch(/v6|target/);
  });

  it('builds an imported v5 game, whose target is v5', async () => {
    const { project } = importGame(await load('v5'));
    const built = buildProject(project);

    expect(built.errors).toEqual([]);
    expect(built.data.length).toBeGreaterThan(0);
  });
});
