import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { VAR } from '../src/engine/constants.js';
import { buildClassicFixture } from './fixtureClassic.js';

/**
 * `VAR_MUSIC_TIMER` when there is no music to time.
 *
 * The variable is the position of the piece that is playing, and games wait on
 * it — so the one thing it must never do is stop. It did, and only in a
 * browser: the test for "can this engine say where the music has got to" was
 * *is there an audio context*, which is a different question and answers yes
 * wherever a player is sitting and no in every headless tool this project has.
 * So the fault was invisible to `npm run diagnose`, to `npm run shot`, to
 * `npm run sweep` and to every test, and reproduced on the first click of a
 * real session.
 *
 * Loom CD is where it bites hardest, because its score is not in the game at
 * all — the CD release pressed it as audio tracks. Nothing ever plays, the
 * position is always nothing, and the opening menu's script waits for the timer
 * to pass 26 before it arms the three buttons. The menu draws, the prompt
 * appears, and clicking STANDARD, PRACTICE or EXPERT does nothing at all.
 */
async function bootClassic(): Promise<ScummEngine> {
  const fixture = buildClassicFixture({ version: 4 });
  const engine = await ScummEngine.create(new MemoryDataSource('v4', fixture.files));
  engine.boot();
  return engine;
}

describe('the music timer', () => {
  it('keeps moving when nothing is playing', async () => {
    const engine = await bootClassic();
    const before = engine.variables[VAR.MUSIC_TIMER];

    for (let step = 0; step < 30; step++) engine.step();

    expect(engine.variables[VAR.MUSIC_TIMER]).toBeGreaterThan(before);
  });

  it('keeps moving even where the browser has given us an audio context', async () => {
    const engine = await bootClassic();
    // The one thing a browser has that a headless run does not. On its own it
    // says nothing about whether a piece of music is playing, which is what the
    // timer actually reports — and treating it as though it did is what pinned
    // the variable at nothing for every player and no test.
    (engine.sound as unknown as { context: unknown }).context = { currentTime: 0 };
    const before = engine.variables[VAR.MUSIC_TIMER];

    for (let step = 0; step < 30; step++) engine.step();

    expect(engine.variables[VAR.MUSIC_TIMER]).toBeGreaterThan(before);
  });

  it('reports no position rather than the beginning when there is none', async () => {
    const engine = await bootClassic();
    (engine.sound as unknown as { context: unknown }).context = { currentTime: 0 };

    // Nothing is playing, so there is no position. Zero is a *place in a piece
    // of music* and would be indistinguishable from one sitting on its first
    // beat, which is exactly the confusion that stalled the variable.
    expect(engine.sound.musicTimer()).toBeNull();
  });
});
