import { describe, expect, it } from 'vitest';
import { Assembler } from '../src/authoring/Assembler.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { VAR } from '../src/engine/constants.js';
import { buildFixture } from './fixture.js';

/**
 * What the editor's Play overlay reads to decide whether a game started.
 *
 * Pressing Play on a published game reported a room background, a verb panel,
 * no player and no response to clicks — and no error anywhere, because the one
 * line that would have named the fault was written to a status element that was
 * overwritten a moment later. The overlay now keeps the log and asks the engine
 * what state it is in; these cover the answers it relies on.
 */
function gameWithBoot(bootScript: number[]) {
  const fixture = buildFixture({ bootScript });
  const source = new MemoryDataSource('play');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return source;
}

async function boot(assemble: (s: Assembler) => void) {
  const script = new Assembler();
  assemble(script);
  const messages: string[] = [];
  const engine = await ScummEngine.create(gameWithBoot([...script.build()]), {
    onLog: (message) => messages.push(message),
  });
  engine.boot(0);
  for (let i = 0; i < 5; i++) engine.step();
  return { engine, messages };
}

describe('describing why input is not being accepted', () => {
  it('does not claim input is off when it is still on', async () => {
    // Nothing in `beginCutscene` suspends input — the game's own cutscene start
    // script does that — so a depth with input still on is a real state, and
    // reporting it as "input is off" sent a reader after the wrong fault.
    const { engine } = await boot((s) => {
      s.loadRoom(1);
      s.cutscene([]);
      s.stop();
    });

    expect(engine.userPut).toBe(true);
    expect(engine.scriptState.cutSceneStack.length).toBe(1);
    expect(engine.describeInputState()).toMatch(/cutscene is running, but input is still on/);
  });

  it('says a cutscene is holding input when it genuinely is', async () => {
    const { engine } = await boot((s) => {
      s.loadRoom(1);
      s.cutscene([]);
      s.userputOff();
      s.stop();
    });

    expect(engine.userPut).toBe(false);
    expect(engine.describeInputState()).toMatch(/input is off because a cutscene is running/);
  });

  it('adds no explanation when no cutscene is running', async () => {
    const { engine } = await boot((s) => {
      s.loadRoom(1);
      s.stop();
    });

    expect(engine.scriptState.cutSceneStack.length).toBe(0);
    expect(engine.describeInputState()).not.toMatch(/cutscene is running/);
  });
});

describe('a room that is drawn but never handed over', () => {
  it('leaves the player outside the room that is on screen', async () => {
    // The reported shape: the room loads and draws, and the player is never
    // put into it. Whatever stops the hand-over, this is what it looks like
    // from outside, and it is what the overlay reports as "not started".
    const { engine } = await boot((s) => {
      s.loadRoom(1);
      s.cutscene([]);
      s.stop();
    });

    expect(engine.currentRoom).toBe(1);

    const ego = engine.actors[engine.variables[VAR.EGO]];
    expect(ego.isInCurrentRoom(engine.currentRoom)).toBe(false);
  });

  it('puts the player in the room when the boot script gets that far', async () => {
    const { engine } = await boot((s) => {
      s.loadRoom(1);
      s.putActorInRoom(1, 1);
      s.putActor(1, 160, 120);
      s.userputOn();
      s.stop();
    });

    const ego = engine.actors[engine.variables[VAR.EGO]];
    expect(ego.isInCurrentRoom(engine.currentRoom)).toBe(true);
    expect(engine.userPut).toBe(true);
    expect(engine.describeInputState()).not.toMatch(/cutscene is running/);
  });
});

describe('a script that is not in the game', () => {
  it('says so rather than doing nothing quietly', async () => {
    // How a game imported room by room fails: the room's entry script starts
    // a global script that was never brought across, the caller carries on as
    // though it ran, and the scene it was meant to set up never happens.
    const { messages } = await boot((s) => {
      s.loadRoom(1);
      s.startScript(150, []);
      s.stop();
    });

    expect(messages.join('\n')).toMatch(/Script 150 was started but there is no global script/);
  });

  it('says it once, however often the game asks', async () => {
    const { messages } = await boot((s) => {
      s.loadRoom(1);
      s.startScript(150, []);
      s.startScript(150, []);
      s.startScript(150, []);
      s.stop();
    });

    const said = messages.filter((line) => line.includes('Script 150 was started'));
    expect(said).toHaveLength(1);
  });
});
