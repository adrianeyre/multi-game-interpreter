import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { Assembler } from '../src/authoring/Assembler.js';
import { importGame } from '../src/authoring/importGame.js';
import { buildProject } from '../src/authoring/projectToGame.js';
import { keepPlayerVisible, playableStart } from '../src/editor/playFrom.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { OFF_SCREEN_POSITION } from '../src/engine/constants.js';
import { createProject, type Project } from '../src/authoring/project.js';
import { boxBounds } from '../src/authoring/GameBuilder.js';
import { buildFixture } from './fixture.js';

/**
 * Pressing Play on a room imported from a published game.
 *
 * The path has four stages — read the game, turn it into a project, compile the
 * project, run the compiled game — and every stage passed its own tests while
 * the whole produced a room background with nothing in it. These run the stages
 * together, because the faults were all in the joins: a state the room does not
 * carry, a costume numbered differently on each side, a start point chosen and
 * then overwritten.
 */
async function importGameFixture(
  options: Parameters<typeof buildFixture>[0] = {},
  importOptions: Parameters<typeof importGame>[1] = {},
): Promise<ReturnType<typeof importGame>> {
  const fixture = buildFixture(options);
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const resources = await ResourceManager.load(source, await detectGame(source));
  return importGame(resources, importOptions);
}

async function importedProject(options: Parameters<typeof buildFixture>[0] = {}): Promise<Project> {
  return (await importGameFixture(options)).project;
}

/** Bytecode for a room entry script, the way a published game would ship one. */
function entry(assemble: (s: Assembler) => void): number[] {
  const script = new Assembler();
  assemble(script);
  script.stop();
  return [...script.build()];
}

/** Compiles a project the way the editor's Play button does, and runs it. */
async function play(
  project: Project,
  frames = 40,
): Promise<{ engine: ScummEngine; start: Project['start'] }> {
  const played = playableStart(project, project.rooms[0]);
  const built = buildProject(played);
  expect(built.errors).toEqual([]);

  const source = new MemoryDataSource('preview');
  source.set('PREVIEW.000', built.index);
  source.set('PREVIEW.001', built.data);

  const engine = await ScummEngine.create(source);
  engine.boot(0);
  for (let i = 0; i < frames; i++) engine.step();
  return { engine, start: played.start };
}

describe('objects in a room imported from a published game', () => {
  it('keeps the state the published game starts them in', async () => {
    // The state lives in the index, not in the room, and reading it off the
    // parsed room gave every object state 0 — never drawn, never clickable.
    const project = await importedProject();
    const object = project.rooms[0].objects.find((candidate) => candidate.id === 500);

    expect(object?.initialState).toBe(1);
  });

  it('draws them when the room is played', async () => {
    const { engine } = await play(await importedProject());

    const report = engine.describeObjectState();
    expect(report).toMatch(/object 500[^|]*drawn/);
    expect(report).not.toMatch(/NOT DRAWN/);
  });

  it('keeps an object that does not start in state 1', async () => {
    // A door that starts open, a lamp that starts lit. The state is in the
    // index and the artwork is in the room, and picking the wrong image for
    // the state draws nothing at all rather than the wrong thing.
    const project = await importedProject({ objectImages: 3, objectState: 2 });
    const object = project.rooms[0].objects.find((candidate) => candidate.id === 500);
    expect(object?.initialState).toBe(2);
    expect(object?.states).toHaveLength(3);

    const { engine } = await play(project);

    const report = engine.describeObjectState();
    expect(report).toMatch(/object 500[^|]*state 2, drawn/);
  });

  it('makes them clickable, so the sentence line can fill in', async () => {
    const { engine } = await play(await importedProject());

    // The fixture's object sits at 32,64 and is 16 by 16.
    expect(engine.findObjectAt(36, 68)).toBe(500);
  });
});

describe('costumes in a game imported from a published one', () => {
  it('keeps the number the published game gave each costume', async () => {
    // The imported scripts change costumes by number, so a costume renumbered
    // on the way in is one those scripts can no longer find.
    const project = await importedProject({ costumeId: 7 });

    expect(project.actors[0].costumeId).toBe(7);
  });

  it('draws an actor a room script dresses by that number', async () => {
    const project = await importedProject({
      costumeId: 7,
      entryScript: entry((s) => {
        s.actorOps(2).costume(7).end();
        s.putActorInRoom(2, 1);
        s.putActor(2, 100, 120);
      }),
    });

    const { engine } = await play(project);

    const report = engine.describeActorState();
    expect(report).toMatch(/actor 2[^|]*drawn/);
    expect(report).not.toMatch(/NOT DRAWN/);
  });

  it('carries a costume past the actor cap through as the game shipped it', async () => {
    // A project's actor ids stop at 20, so a game with more costumes than that
    // always has some that cannot be actors; `maxActors` reproduces that in
    // miniature. They still have to exist, because the game's own scripts wear
    // them by number.
    const { project, notes } = await importGameFixture({ costumeId: 7 }, { maxActors: 0 });

    expect(project.costumes?.map((costume) => costume.id)).toEqual([7]);
    expect(notes.join(' ')).toMatch(/carried through exactly as the game shipped them/);
  });

  it('dresses an actor in one that never became an actor', async () => {
    const { project } = await importGameFixture(
      {
        costumeId: 7,
        entryScript: entry((s) => {
          s.actorOps(2).costume(7).end();
          s.putActorInRoom(2, 1);
          s.putActor(2, 100, 120);
        }),
      },
      { maxActors: 0 },
    );
    // With no actors of its own the project cannot compile, so give it the
    // default one, which wears nothing the room asks for.
    project.actors = createProject('t').actors;

    const { engine } = await play(project);

    const report = engine.describeActorState();
    expect(report).toMatch(/actor 2[^|]*drawn/);
    expect(report).not.toMatch(/costume 7 is not in the game data/);
  });
});

describe('the actor report on a costume it cannot draw', () => {
  it('separates a costume that is absent from one that failed to decode', async () => {
    const project = await importedProject({
      entryScript: entry((s) => {
        s.actorOps(2).costume(42).end();
        s.putActorInRoom(2, 1);
        s.putActor(2, 100, 120);
      }),
    });

    const { engine } = await play(project);

    expect(engine.describeActorState()).toMatch(/costume 42 is not in the game data/);
  });
});

describe('the player in a room imported from a published game', () => {
  it('is put back in sight when the room parks them off screen', async () => {
    // A published game's room may move the player out of sight and rely on its
    // own opening cutscene to bring them back. Playing one room never runs
    // that opening, so nothing does — and the start point Play chose is
    // discarded. The break is what lets the entry script run on after the boot
    // script has placed the player, which is the order the fault needs.
    const project = await importedProject({
      entryScript: entry((s) => {
        s.breakHere();
        s.actorOps(1).ignoreBoxes().end();
        s.putActor(1, OFF_SCREEN_POSITION, OFF_SCREEN_POSITION);
      }),
    });

    const { engine, start } = await play(project);
    expect(engine.actors[1].x).toBe(OFF_SCREEN_POSITION);

    const moved = keepPlayerVisible(engine, start);

    expect(moved).toMatch(/put them back/);
    expect(engine.actorPlacementProblems(1)).toEqual([]);
    expect(engine.describeActorState()).toMatch(/actor 1 \(ego\)[^|]*drawn/);
  });

  it('leaves a player the room placed somewhere visible alone', async () => {
    const project = await importedProject({
      entryScript: entry((s) => {
        s.breakHere();
        s.putActor(1, 120, 110);
      }),
    });

    const { engine, start } = await play(project);

    expect(keepPlayerVisible(engine, start)).toBeNull();
    expect(engine.actors[1].x).toBe(120);
  });

  it('leaves a room the game deliberately moved to alone', async () => {
    // Play overrides where the game starts, not where it goes. A game that
    // walks the player into another room has not lost them.
    const { engine, start } = await play(await importedProject());
    engine.startScene(0, null, 0);

    expect(keepPlayerVisible(engine, start)).toBeNull();
  });
});

describe('input in a room imported from a published game', () => {
  it('turns a verb and a click on an object into a sentence', async () => {
    // The whole of what "clicking does nothing" meant: the verb click has to
    // be accepted, the click in the room has to find a hotspot, and the two
    // have to become a pending sentence. Every one of those needed the object
    // to be in a state above 0.
    const { engine } = await play(await importedProject());
    expect(engine.userPut).toBe(true);

    engine.handleVerbClick(1);
    // Screen coordinates: the room view starts below the text band. Reported
    // as a press, which is where every click enters the engine, and resolved
    // by the compiled project's own input script rather than by the engine.
    engine.pressButton(1, 36, 68 + engine.screen.main.top);

    expect(engine.isSentencePending()).toBe(true);
  });
});

describe("a room's own scripts", () => {
  it('comes across, so the entry script can start one', async () => {
    // The fixture room carries local script 200, and its entry script starts
    // it. Left behind, the entry script ran, asked for a script that was not
    // there, and whatever it was meant to set up never happened.
    const project = await importedProject({
      entryScript: entry((s) => {
        s.startScript(200, []);
      }),
    });

    expect(project.rooms[0].localScripts?.map((script) => script.id)).toContain(200);

    const messages: string[] = [];
    const built = buildProject(playableStart(project, project.rooms[0]));
    expect(built.errors).toEqual([]);
    const source = new MemoryDataSource('preview');
    source.set('PREVIEW.000', built.index);
    source.set('PREVIEW.001', built.data);
    const engine = await ScummEngine.create(source, { onLog: (line) => messages.push(line) });
    engine.boot(0);
    for (let i = 0; i < 20; i++) engine.step();

    expect(messages.join('\n')).not.toMatch(/no local script 200/);
  });
});

/**
 * Everything the first real imported game did at once.
 *
 * Each fault had its own test and its own fix, and every one of them was found
 * by reading a single play log rather than by reasoning about the code. This
 * puts them back together — a box list that is not all floor, an entry script
 * that hides the player and starts a script of the room's own, an actor
 * dressed in a costume past the actor cap, an object that does not start in
 * state 1 — because they arrived together and it is together that they have to
 * work.
 */
describe('a room shaped like the one from the first real import', () => {
  async function playThatRoom() {
    const { project } = await importGameFixture(
      {
        offScreenBox: true,
        costumeId: 7,
        objectImages: 3,
        objectState: 2,
        entryScript: entry((s) => {
          s.startScript(200, []);
          s.breakHere();
          // The room hides the player, expecting an opening that never runs.
          s.actorOps(1).ignoreBoxes().end();
          s.putActor(1, OFF_SCREEN_POSITION, OFF_SCREEN_POSITION);
        }),
        localScript: entry((s) => {
          s.actorOps(2).costume(7).end();
          s.putActorInRoom(2, 1);
          s.putActor(2, 100, 120);
        }),
      },
      { maxActors: 0 },
    );
    project.actors = createProject('t').actors;

    const messages: string[] = [];
    const played = playableStart(project, project.rooms[0]);
    const built = buildProject(played);
    expect(built.errors).toEqual([]);

    const source = new MemoryDataSource('preview');
    source.set('PREVIEW.000', built.index);
    source.set('PREVIEW.001', built.data);
    const engine = await ScummEngine.create(source, { onLog: (line) => messages.push(line) });
    engine.boot(0);
    for (let i = 0; i < 40; i++) {
      engine.step();
      keepPlayerVisible(engine, played.start);
    }
    return { engine, messages, start: played.start, project };
  }

  it('starts the player on a box that is actually in the room', async () => {
    // Not merely inside the room: standing on real floor. Choosing the room's
    // hidden box and then clamping the result back inside the room would pass
    // a bounds check while putting the player in a corner they cannot walk out
    // of, so the assertion is about which box was chosen.
    const { start, project } = await playThatRoom();

    const floors = project.rooms[0].boxes
      .map(boxBounds)
      .filter((bounds) => bounds.x >= 0 && bounds.x < 320);
    expect(floors.length).toBeGreaterThan(0);
    expect(
      floors.some(
        (bounds) =>
          start.x >= bounds.x &&
          start.x < bounds.x + bounds.width &&
          start.y >= bounds.y &&
          start.y < bounds.y + bounds.height,
      ),
    ).toBe(true);
  });

  it('leaves the player in sight however the room hides them', async () => {
    const { engine } = await playThatRoom();

    expect(engine.actorPlacementProblems(1)).toEqual([]);
    expect(engine.describeActorState()).toMatch(/actor 1 \(ego\)[^|]*drawn/);
  });

  it("runs the room's own script, which places and dresses an actor", async () => {
    const { engine, messages } = await playThatRoom();

    expect(messages.join('\n')).not.toMatch(/no local script 200/);
    expect(engine.describeActorState()).toMatch(/actor 2[^|]*drawn/);
  });

  it('draws the object in the state the game starts it in', async () => {
    const { engine } = await playThatRoom();

    expect(engine.describeObjectState()).toMatch(/object 500[^|]*state 2, drawn/);
  });

  it('names no costume as missing', async () => {
    const { messages } = await playThatRoom();

    expect(messages.join('\n')).not.toMatch(/is not in the game data/);
  });
});
