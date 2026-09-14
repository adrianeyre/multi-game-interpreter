import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import {
  captureState,
  describeIncompatibleSave,
  describeUnsaveableMoment,
  restoreState,
  SAVE_FORMAT,
} from '../src/engine/save/SaveState.js';
import { buildV7Fixture } from './fixtureV7.js';
import { buildV6Fixture } from './fixtureV6.js';

async function bootV7() {
  const fixture = buildV7Fixture();
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set('LANGUAGE.BND', new TextEncoder().encode('@TAG\n001/a line\n'));
  const engine = await ScummEngine.create(source);
  engine.boot(0);
  engine.startScene(1, null, 0);
  return engine;
}

async function bootV6() {
  const fixture = buildV6Fixture();
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source);
  engine.boot(0);
  engine.startScene(1, null, 0);
  return engine;
}

describe('saving a v7 game', () => {
  it('round-trips the second camera axis', async () => {
    const engine = await bootV7();
    engine.setCameraAt(engine.camera.min, 0);
    engine.camera.currentY = 0;

    const saved = captureState(engine, 'test');
    expect(saved.camera.currentY).toBe(0);
    expect(saved.camera.maxY).toBe(engine.camera.maxY);

    engine.camera.currentY = 999;
    restoreState(engine, saved);
    expect(engine.camera.currentY).toBe(0);
  });

  it('records which language bundle it was made against', async () => {
    const engine = await bootV7();
    expect(captureState(engine).languageBundle).toBe('LANGUAGE.BND');
  });

  it('refuses a save made against a different localisation', async () => {
    // The lines are named by tag, so restoring against another bundle shows
    // plausible text in the wrong language — a translation bug rather than a
    // save that should have been refused.
    const engine = await bootV7();
    const saved = captureState(engine);
    const foreign = { ...saved, languageBundle: 'LANGUAGE.DEU' };

    expect(describeIncompatibleSave(engine, foreign)).toMatch(/language bundle|LANGUAGE\.DEU/);
  });

  it('treats no bundle on both sides as a match, since Full Throttle ships none', async () => {
    const engine = await bootV6();
    const saved = captureState(engine);
    expect(saved.languageBundle).toBeNull();
    expect(describeIncompatibleSave(engine, saved)).toBeNull();
  });
});

describe('refusing a save that cannot be restored', () => {
  it('reports the loaded game’s real version, not a guess between two', async () => {
    // Written as `saved.scummVersion === 5 ? 6 : 5` while there were two
    // versions, which called a v7 game v5 the moment a third existed.
    const engine = await bootV7();
    const saved = captureState(engine);
    const fromV6 = { ...saved, scummVersion: 6 };

    expect(describeIncompatibleSave(engine, fromV6)).toContain('is v7');
  });

  it('refuses an older save format rather than half-reading it', async () => {
    const engine = await bootV7();
    const saved = captureState(engine);
    const older = { ...saved, format: SAVE_FORMAT - 1 };

    expect(describeIncompatibleSave(engine, older)).toMatch(/format/);
  });

  it('refuses to save during a video', async () => {
    // Deliberate, not a limitation: the original does not, and a save that
    // resumed mid-sequence is a worse answer than one that declines.
    const engine = await bootV7();
    // Asked for rather than asserted: the refusal has to follow from playback
    // actually being under way, which is the only thing the save path can see.
    engine.video.beginLoad('intro.san', engine.palette.snapshot());

    expect(describeUnsaveableMoment(engine)).toMatch(/video/i);
    expect(() => captureState(engine)).toThrow(/video/i);
  });

  it('saves normally once the video ends', async () => {
    const engine = await bootV7();
    engine.video.beginLoad('intro.san', engine.palette.snapshot());
    engine.video.skip();
    expect(() => captureState(engine)).not.toThrow();
  });
});

describe('what a v6 save keeps doing', () => {
  it('writes zeros for the axis it does not use, and restores them', async () => {
    // One camera model, not two: a v5 or v6 save carries the second axis and
    // restores it, which is exactly what it did before the field existed.
    const engine = await bootV6();
    const saved = captureState(engine);

    expect(saved.camera.currentY).toBe(0);
    restoreState(engine, saved);
    expect(engine.camera.currentY).toBe(0);
  });
});

describe('the musical state a save carries', () => {
  it('records the state the sequencer is in, not the track playing', async () => {
    // The distinction iMUSE is built on (ADR 0008): restoring a track resumes
    // the right piece from its opening bar, where restoring a state resumes the
    // scene.
    const engine = await bootV7();
    engine.sound.kludge([8, 42]);

    expect(captureState(engine).musicState?.id).toBe(42);
  });

  it('records silence as silence rather than as the last thing played', async () => {
    const engine = await bootV7();
    engine.sound.kludge([8, 42]);
    engine.sound.kludge([9, 42]);

    expect(captureState(engine).musicState).toBeNull();
  });

  it('puts the state back on restore', async () => {
    const engine = await bootV7();
    engine.sound.kludge([8, 42]);
    const saved = captureState(engine);

    engine.sound.kludge([8, 43]);
    restoreState(engine, saved);

    expect(engine.sound.sequencer.state?.id).toBe(42);
  });

  it('restores without a transition, so it does not fade in from silence', async () => {
    // `restore` rather than `enter`: a crossfade into the music that was
    // already playing is a fade from silence, which is audible and is not what
    // the player left.
    const engine = await bootV7();
    engine.sound.kludge([8, 42]);
    const saved = captureState(engine);

    restoreState(engine, saved);
    expect(engine.sound.sequencer.state?.id).toBe(42);
  });

  it('carries the field for a v6 game too, since there is one sequencer', async () => {
    const engine = await bootV6();
    const saved = captureState(engine);

    expect(saved.musicState).toBeNull();
    expect(() => restoreState(engine, saved)).not.toThrow();
  });
});
