import { describe, expect, it } from 'vitest';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { VAR } from '../src/engine/constants.js';
import { buildV7Fixture } from './fixtureV7.js';
import { buildFixture } from './fixture.js';

/**
 * A v7 actor's animation state.
 *
 * Every v7 costume is an `AKOS`, and which reader a costume needs is decided
 * from its own tag. The draw path did that; the paths that *drive* the
 * animation did not, and asked the classic reader instead — which throws on
 * AKHD's size field. `startAnimActor` then returned before assigning
 * `actor.frame`, so an actor kept the frame it was constructed with.
 *
 * That is the shape of fault these tests exist for: the actor still drew, so
 * both v7 games looked like they were working, while standing, walking,
 * talking and every animation a script asked for all selected the same
 * frame-zero chore. Nothing an actor did ever changed what was on screen.
 */
const ACTOR = 1;

async function withAkosActor() {
  // The room's only walkbox sits at its foot, so a shorter room is one the
  // actor is placed inside the view of.
  const fixture = buildV7Fixture({ roomHeight: 128 });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set(fixture.languageName, fixture.language);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.startScene(1, null, 0);
  engine.variables[VAR.EGO] = ACTOR;

  const actor = engine.getActor(ACTOR)!;
  actor.costume = 1;
  engine.putActorInRoom(ACTOR, 1);
  engine.putActor(ACTOR, 100, 100);
  return { engine, actor, logs };
}

/** How many screen pixels the actor contributes, drawn against itself hidden. */
function actorPixels(engine: ScummEngine, actor: { visible: boolean }): number {
  engine.render();
  const drawn = Uint8Array.from(engine.screen.pixels);

  const wasVisible = actor.visible;
  actor.visible = false;
  engine.render();
  actor.visible = wasVisible;

  let differing = 0;
  for (let i = 0; i < drawn.length; i++) {
    if (engine.screen.pixels[i] !== drawn[i]) differing++;
  }
  return differing;
}

describe('animating an actor in an AKOS costume', () => {
  it('records the frame a script asked for', async () => {
    const { engine, actor } = await withAkosActor();

    // The whole fault in one assertion: this kept the frame the actor was
    // placed with, whatever a script asked for.
    // v7 reads the argument in thousands, so a bare 9 is frame 9.
    engine.animateActor(ACTOR, 9);

    expect(actor.frame).toBe(9);
  });

  it('reads the standard poses off the actor as the classic path does', async () => {
    const { engine, actor } = await withAkosActor();
    actor.standFrame = 7;

    // 2000 is v7's stand command, where v5 and v6 spell it 0xFC.
    engine.animateActor(ACTOR, 2000);

    expect(actor.frame).toBe(7);
  });

  it('lets the frame choose the chore, so a new frame draws something else', async () => {
    const { engine, actor } = await withAkosActor();

    engine.startAnimActor(actor, 0);
    const standing = actorPixels(engine, actor);

    // The fixture costume has sixteen chores, so frame 4 selects past its last
    // one and draws nothing. A frame that never reaches chore selection would
    // draw the same thing at both, which is the symptom being pinned here
    // rather than the blank frame itself.
    engine.startAnimActor(actor, 4);
    const past = actorPixels(engine, actor);

    expect(standing).toBeGreaterThan(0);
    expect(past).toBe(0);
  });

  it('restarts the chore when the frame changes', async () => {
    const { engine, actor } = await withAkosActor();

    engine.startAnimActor(actor, 2);
    engine.render();
    // Drawing stepped the chore, so the position is no longer "unstarted".
    expect(actor.cost.curpos[0]).not.toBe(0xffff);

    engine.startAnimActor(actor, 3);

    // A chore is stepped through `curpos[0]`. Carrying the last frame's
    // position into a different chore resumes it at an arbitrary offset in
    // someone else's opcode stream.
    expect(actor.cost.curpos[0]).toBe(0xffff);
  });

  it('does not restart the chore when the same frame is asked for again', async () => {
    const { engine, actor } = await withAkosActor();

    engine.startAnimActor(actor, 2);
    engine.render();
    const position = actor.cost.curpos[0];

    engine.startAnimActor(actor, 2);

    expect(position).not.toBe(0xffff);
    expect(actor.cost.curpos[0]).toBe(position);
  });

  it('starts the init frame from the beginning', async () => {
    const { engine, actor } = await withAkosActor();
    actor.initFrame = 1;

    engine.startAnimActor(actor, 2);
    engine.render();
    engine.startAnimActor(actor, 1);

    expect(actor.frame).toBe(1);
    expect(actor.cost.curpos[0]).toBe(0xffff);
    expect(actor.cost.stopped).toBe(0);
  });

  it('turns the actor without going near the classic reader', async () => {
    const { engine, actor, logs } = await withAkosActor();

    engine.setActorDirection(actor, 90);

    expect(actor.facing).toBe(90);
    expect(actor.needRedraw).toBe(true);
    // Turning asked the classic reader for the costume purely to re-decode
    // limbs an AKOS costume does not have, and the refusal was remembered
    // against a costume that is fine.
    expect(logs.filter((line) => line.startsWith('Costume 1'))).toEqual([]);
  });

  it('reports the actor as drawn rather than as a costume that would not decode', async () => {
    const { engine } = await withAkosActor();

    // The misleading half of the fault. `describeActorState` is the stall
    // report's account of why nothing is on screen, and it named a costume
    // that decodes perfectly well — sending you after a missing resource that
    // was right there.
    const report = engine.describeActorState();

    expect(report).toContain(`actor ${ACTOR}`);
    expect(report).toContain('drawn');
    expect(report).not.toContain('NOT DRAWN');
  });

  it('stays quiet about the costume across a stepped frame', async () => {
    const { engine, logs } = await withAkosActor();

    // The per-frame animation step asked the classic reader for the costume
    // once an actor was on screen, so a game that had never called an
    // animation opcode still logged a complaint about a good costume.
    for (let step = 0; step < 3; step++) engine.step();

    expect(logs.filter((line) => line.startsWith('Costume 1'))).toEqual([]);
  });

  it('warms the costume cache through the reader the resource needs', async () => {
    const { engine, logs } = await withAkosActor();

    // A script asks for a resource ahead of using it, and warming the cache
    // used to mean handing an `AKOS` costume to the classic reader. That both
    // logged a complaint about a good costume and remembered the failure, so
    // the stall report went on repeating it afterwards.
    engine.ensureResource('costume', 1);

    expect(logs.filter((line) => line.startsWith('Costume 1'))).toEqual([]);
    expect(engine.describeActorState()).not.toContain('did not decode');
  });

  it('still decodes a classic costume through the classic reader', async () => {
    // The gate has to send each format to its own reader, not route both to
    // the newer one: a v6 game carries `COST` costumes and v7 was where `AKOS`
    // arrived, so both paths are live in the same build.
    const fixture = buildFixture();
    const source = new MemoryDataSource('classic');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    const engine = await ScummEngine.create(source);
    engine.startScene(1, null, 0);
    const actor = engine.getActor(ACTOR)!;
    actor.costume = 1;
    engine.putActorInRoom(ACTOR, 1);
    engine.putActor(ACTOR, 100, 120);

    engine.startAnimActor(actor, 0);

    expect(actor.frame).toBe(0);
    // Inverting the gate would send this resource to `parseAkos`, which reads
    // its tag and refuses it — so the absence of that complaint is what says
    // the classic reader is still the one being asked.
    expect(engine.describeActorState()).not.toContain('is not an AKOS costume');
    expect(engine.describeActorState()).not.toContain('could not be decoded');
  });
});
