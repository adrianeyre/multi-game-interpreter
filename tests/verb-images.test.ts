import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildFixture } from './fixture.js';

/**
 * A verb that shows an object instead of a word.
 *
 * This is how Indiana Jones and the Fate of Atlantis draws its inventory: each
 * slot is a verb pointing at an object, and the panel blits that object's image
 * (`drawVerbBitmap`). Drawing only the text verbs left the panel with its words
 * and nothing else — the player could not see what they were carrying, could
 * not click it, and could not use one thing with another. The arrows that
 * scroll the inventory are image verbs too, so the list could not even be
 * paged.
 */
async function inRoom() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source);
  engine.boot(0);
  engine.startScene(1, null, 0);
  // A panel to draw into: the fixture boots full-screen.
  engine.setScreenLayout(0, 144);
  return engine;
}

/** The fixture's object, whose image is a flat block of one colour. */
const OBJECT = 500;

describe('an image verb', () => {
  it('draws the object it names into the verb panel', async () => {
    const engine = await inRoom();
    const verb = engine.verbs.getOrCreate(101);
    verb.type = 'image';
    verb.image = OBJECT;
    verb.x = 16;
    verb.y = 150;
    verb.enabled = true;

    engine.render();

    // Something other than the cleared panel is there now.
    let painted = 0;
    for (let y = 150; y < 166; y++) {
      for (let x = 16; x < 32; x++) if (engine.screen.getPixel(x, y) !== 0) painted++;
    }
    expect(painted).toBeGreaterThan(0);
  });

  it('gives the slot bounds, so what is drawn can be clicked', async () => {
    const engine = await inRoom();
    const verb = engine.verbs.getOrCreate(101);
    verb.type = 'image';
    verb.image = OBJECT;
    verb.x = 16;
    verb.y = 150;
    verb.enabled = true;

    engine.render();

    expect(verb.bounds).toEqual({ left: 16, top: 150, right: 32, bottom: 166 });
    expect(engine.verbs.hitTest(20, 154)).toBe(101);
  });

  it('draws nothing for a slot that names no object', async () => {
    const engine = await inRoom();
    const verb = engine.verbs.getOrCreate(101);
    verb.type = 'image';
    verb.image = 0;
    verb.x = 16;
    verb.y = 150;
    verb.enabled = true;

    engine.render();

    let painted = 0;
    for (let y = 150; y < 166; y++) {
      for (let x = 16; x < 32; x++) if (engine.screen.getPixel(x, y) !== 0) painted++;
    }
    expect(painted).toBe(0);
  });
});
