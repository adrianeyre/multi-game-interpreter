import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { importGame } from '../src/authoring/importGame.js';
import { buildProject } from '../src/authoring/projectToGame.js';
import { playableStart } from '../src/editor/playFrom.js';
import { buildFixture } from './fixture.js';

/**
 * The line above the verbs that says what the player is about to do.
 *
 * It is the half of the verb panel that makes it an interface rather than a
 * row of words: pressing "Open" and moving onto a door has to say "Open door".
 * A published game writes it from its own scripts; a compiled project has no
 * such script, so nothing ever filled it in and the panel drove nothing.
 */
async function playImported() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const resources = await ResourceManager.load(source, await detectGame(source));
  const project = importGame(resources).project;

  const built = buildProject(playableStart(project, project.rooms[0]));
  expect(built.errors).toEqual([]);

  const preview = new MemoryDataSource('preview');
  preview.set('PREVIEW.000', built.index);
  preview.set('PREVIEW.001', built.data);

  const engine = await ScummEngine.create(preview);
  engine.boot(0);
  for (let i = 0; i < 10; i++) engine.step();
  return engine;
}

/** Where the fixture's object sits, in screen coordinates. */
function overTheObject(engine: ScummEngine): { x: number; y: number } {
  return { x: 36, y: 68 + engine.screen.main.top };
}

describe('the sentence line', () => {
  it('exists and is on in a compiled game', async () => {
    const engine = await playImported();
    const line = engine.verbs.get(0);

    expect(line).toBeDefined();
    expect(line?.enabled).toBe(true);
  });

  it('shows the verb the player chose', async () => {
    const engine = await playImported();

    engine.handleVerbClick(1);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('Look at');
  });

  it('names what the cursor is over', async () => {
    const engine = await playImported();

    engine.handleVerbClick(1);
    const { x, y } = overTheObject(engine);
    engine.setMousePosition(x, y);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('Look at brass lamp');
  });

  it('names a thing under the cursor even before a verb is chosen', async () => {
    const engine = await playImported();

    const { x, y } = overTheObject(engine);
    engine.setMousePosition(x, y);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('brass lamp');
  });

  it('empties again when the cursor leaves the thing', async () => {
    const engine = await playImported();
    engine.handleVerbClick(1);
    const { x, y } = overTheObject(engine);
    engine.setMousePosition(x, y);
    engine.render();

    engine.setMousePosition(300, y);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('Look at');
  });

  it('names nothing while the cursor is down in the verb panel', async () => {
    // The panel is not the room, and an object at the same room coordinates
    // should not be named because the cursor happens to be over a verb.
    const engine = await playImported();
    engine.handleVerbClick(1);

    engine.setMousePosition(36, engine.screen.verb.top + 8);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('Look at');
  });

  it('names a hotspot that has no artwork of its own', async () => {
    // The case a real game is made of: most of a room's objects are hotspots
    // drawn as part of the background, so they sit in state 0 for the whole
    // game. Atlantis's opening room is fifteen of them, and while the hit test
    // skipped state 0 the line stayed blank over every one — the room read as
    // empty and the statue that opens the hatch could not be clicked.
    const engine = await playImported();
    const object = engine.currentRoomData!.objects[0];
    engine.putState(object.id, 0);

    engine.handleVerbClick(1);
    const { x, y } = overTheObject(engine);
    engine.setMousePosition(x, y);
    engine.render();

    expect(engine.getState(object.id)).toBe(0);
    expect(engine.verbs.get(0)?.text).toBe('Look at brass lamp');
  });

  it('hands the line over to a game that writes it itself', async () => {
    // A published game drives its own sentence line from its scripts, and two
    // authors writing to one place is worse than either alone.
    const engine = await playImported();
    engine.claimSentenceLine();
    engine.verbs.getOrCreate(0).text = 'Give the lamp to the man';

    engine.handleVerbClick(1);
    engine.render();

    expect(engine.verbs.get(0)?.text).toBe('Give the lamp to the man');
  });
});
