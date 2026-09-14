import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ObjectWhere, ScriptStatus, VAR } from '../src/engine/constants.js';
import { buildFixture } from './fixture.js';

/** The only object the fixture room carries artwork for. */
const OBJECT = 500;

async function makeEngine(): Promise<ScummEngine> {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return ScummEngine.create(source);
}

async function inRoom(): Promise<ScummEngine> {
  const engine = await makeEngine();
  engine.boot(0);
  engine.startScene(1, null, 0);
  return engine;
}

function occupySlot(
  engine: ScummEngine,
  index: number,
  script: number,
  where = ObjectWhere.Global,
) {
  const slot = engine.scriptState.slots[index];
  slot.reset();
  slot.number = script;
  slot.status = ScriptStatus.Running;
  slot.where = where;
  engine.scriptState.currentSlot = index;
  return slot;
}

describe('object state in the stuck report', () => {
  it('says an object with artwork and a live state is drawn', async () => {
    const engine = await inRoom();

    const report = engine.describeObjectState();
    expect(report).toMatch(new RegExp(`object ${OBJECT}\\b`));
    expect(report).toMatch(/drawn/);
    expect(report).not.toMatch(/NOT DRAWN/);
  });

  it('names state 0 as the reason an object is absent', async () => {
    const engine = await inRoom();
    engine.putState(OBJECT, 0);

    expect(engine.describeObjectState()).toMatch(/NOT DRAWN — state 0/);
  });

  it('says when an object is absent because someone is carrying it', async () => {
    const engine = await inRoom();
    engine.setOwnerOf(OBJECT, 3);

    expect(engine.describeObjectState()).toMatch(/NOT DRAWN — owned by 3, so not in the room/);
  });

  it('counts the hotspots rather than listing them', async () => {
    const engine = await inRoom();

    // Only objects with artwork can be missing from the screen, so the rest
    // would be noise in a report about a room that looks empty.
    const report = engine.describeObjectState();
    expect(report).not.toMatch(/object 0\b/);
  });

  it('says so plainly when no room is loaded', async () => {
    const engine = await makeEngine();
    engine.boot(0);
    engine.startScene(0, null, 0);

    expect(engine.describeObjectState()).toBe('no room loaded');
  });
});

describe('cutscene detail in the stuck report', () => {
  it('leaves the input line alone when no cutscene is open', async () => {
    const engine = await inRoom();

    const report = engine.describeInputState();
    expect(report).toMatch(/userPut on, cursor on, cutscene depth 0/);
    expect(report).not.toMatch(/cutscenes:/);
  });

  it('names the script holding each open cutscene', async () => {
    const engine = await inRoom();

    occupySlot(engine, 0, 206);
    engine.beginCutscene([9]);

    const report = engine.describeInputState();
    expect(report).toMatch(/cutscene depth 1/);
    expect(report).toMatch(/cutscenes: script 206, data 9, no skip point/);
  });

  it('reports the skip point once an override is armed', async () => {
    const engine = await inRoom();

    occupySlot(engine, 0, 206);
    engine.beginCutscene([0]);
    engine.beginOverride(0, 55290);

    expect(engine.describeInputState()).toMatch(/script 206, data 0, skip @55290/);
  });

  it('marks a cutscene whose owning script has died', async () => {
    const engine = await inRoom();

    const slot = occupySlot(engine, 0, 206);
    engine.beginCutscene([0]);
    // Not a room change, so nothing unwinds it; the report has to say why the
    // depth is stuck rather than leaving a bare number.
    slot.reset();

    expect(engine.describeInputState()).toMatch(/script 206 \(gone\)/);
  });

  it('reports the override variable alongside the stack', async () => {
    const engine = await inRoom();

    occupySlot(engine, 0, 206);
    engine.beginCutscene([0]);
    engine.variables[VAR.OVERRIDE] = 1;

    expect(engine.describeInputState()).toMatch(/override 1$/);
  });
});
