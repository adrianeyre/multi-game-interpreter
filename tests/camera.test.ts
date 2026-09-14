import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { Screen, SCREEN_HEIGHT, SCREEN_WIDTH } from '../src/engine/gfx/Screen.js';
import { RoomGraphics } from '../src/engine/gfx/RoomGraphics.js';
import { VAR } from '../src/engine/constants.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';

/**
 * The camera and the screen bands, as they behave today.
 *
 * Characterisation cover, written before ADR 0007 generalises the camera to two
 * axes. A camera is exercised by every frame of every game and the
 * generalisation edits code v5 and v6 depend on, so what is true now is written
 * down first — otherwise a regression is found by a person, months later, in a
 * game rather than in a test.
 *
 * These assert current behaviour, including where it is an approximation. None
 * of them is a statement that the behaviour is ideal.
 */
async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source);
  engine.boot(0);
  engine.startScene(1, null, 0);
  return engine;
}

/** A room background whose every pixel encodes its own column, for drawRoom. */
function stripedRoom(width: number, height: number): RoomGraphics {
  const room = Object.create(RoomGraphics.prototype) as RoomGraphics;
  const background = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) background[y * width + x] = (x + y) & 0xff;
  }
  Object.assign(room, { width, height, background });
  return room;
}

describe('the camera bounds a room sets', () => {
  it('centres on half a screen and stops half a screen from the right edge', async () => {
    const engine = await bootV6({ roomWidth: 640 });

    // min and max are camera *centres*, not left edges: the camera cannot show
    // anything outside the room, so its centre stops half a screen in.
    expect(engine.camera.min).toBe(SCREEN_WIDTH >> 1);
    expect(engine.camera.max).toBe(640 - (SCREEN_WIDTH >> 1));
  });

  it('gives a room no wider than the screen nowhere to go', async () => {
    const engine = await bootV6({ roomWidth: 320 });
    expect(engine.camera.min).toBe(engine.camera.max);
  });
});

describe('moving the camera', () => {
  it('clamps a pan to the room bounds rather than following it out', async () => {
    const engine = await bootV6({ roomWidth: 640 });
    engine.panCameraTo(10_000);
    for (let frame = 0; frame < 200; frame++) engine.step();
    expect(engine.camera.current).toBe(engine.camera.max);
  });

  it('moves at most eight pixels a frame', async () => {
    const engine = await bootV6({ roomWidth: 640 });
    const before = engine.camera.current;
    engine.panCameraTo(engine.camera.max);
    engine.step();
    expect(Math.abs(engine.camera.current - before)).toBeLessThanOrEqual(8);
  });

  it('stops reporting movement once it arrives', async () => {
    const engine = await bootV6({ roomWidth: 640 });
    engine.panCameraTo(engine.camera.current);
    engine.step();
    expect(engine.camera.moving).toBe(false);
  });

  it('publishes its position to the script variable', async () => {
    const engine = await bootV6({ roomWidth: 640 });
    engine.setCameraAt(400);
    expect(engine.variables[VAR.CAMERA_POS_X]).toBe(400);
  });
});

describe('drawing the room through the camera', () => {
  it('draws from the leftmost visible column, not from the camera centre', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(640, 144);

    screen.drawRoom(room, 100);

    // Row 0 of the room band starts at the room's column 100.
    const top = screen.main.top;
    expect(screen.pixels[top * SCREEN_WIDTH]).toBe(100 & 0xff);
    expect(screen.pixels[top * SCREEN_WIDTH + 1]).toBe(101 & 0xff);
  });

  it('always draws the room from its top row', () => {
    // The assumption ADR 0007 removes: vertical scrolling does not exist before
    // v7, so the first row drawn is always row 0.
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(320, 400);

    screen.drawRoom(room, 0);

    const top = screen.main.top;
    expect(screen.pixels[top * SCREEN_WIDTH]).toBe(0);
    expect(screen.pixels[(top + 1) * SCREEN_WIDTH]).toBe(1);
  });

  it('clamps a camera past the right edge rather than reading past the row', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(640, 144);

    screen.drawRoom(room, 10_000);

    const top = screen.main.top;
    expect(screen.pixels[top * SCREEN_WIDTH]).toBe((640 - SCREEN_WIDTH) & 0xff);
  });

  it('fills with black below a room shorter than the band', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(320, 100);

    screen.pixels.fill(7);
    screen.drawRoom(room, 0);

    const top = screen.main.top;
    expect(screen.pixels[(top + 120) * SCREEN_WIDTH]).toBe(0);
  });
});

describe('the screen bands', () => {
  it('splits the screen into text, room and verb bands', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);

    expect(screen.text).toEqual({ top: 0, height: 16 });
    expect(screen.main).toEqual({ top: 16, height: 128 });
    expect(screen.verb).toEqual({ top: 144, height: SCREEN_HEIGHT - 144 });
  });

  it('gives the whole screen to the room when asked, which is v7’s layout', () => {
    // Already expressible: `setLayout` is data-driven, so a full-height room
    // band needs no new mechanism. What ADR 0007 has to establish is that
    // nothing downstream assumes the verb band is non-empty.
    const screen = new Screen();
    screen.setLayout(0, SCREEN_HEIGHT);

    expect(screen.text.height).toBe(0);
    expect(screen.main).toEqual({ top: 0, height: SCREEN_HEIGHT });
    expect(screen.verb.height).toBe(0);
  });
});

describe('the second axis, which v7 needs and earlier versions do not have', () => {
  it('gives a v6 room no more range than its own height allows', async () => {
    const engine = await bootV6({ roomWidth: 640, roomHeight: 144 });

    // The range is the room's height less the visible band, with no version
    // asked. A v6 room is 144 tall against a 128 band, so sixteen rows of it
    // sit behind the verb panel and are, in this model, scrollable — the
    // original never scrolls to them, and neither does this, because nothing
    // in v5 or v6 ever gives the camera a y.
    expect(engine.camera.minY).toBe(0);
    expect(engine.camera.maxY).toBe(144 - 128);
  });

  it('leaves a v6 camera at the room’s top row, however much range it has', async () => {
    const engine = await bootV6({ roomWidth: 640, roomHeight: 144 });
    engine.panCameraTo(engine.camera.max);
    for (let frame = 0; frame < 100; frame++) engine.step();

    // The compatibility guarantee: panning is an x instruction in v5 and v6, so
    // the y it defaults to is the one already set, and that is row 0 from the
    // room load onward.
    expect(engine.camera.currentY).toBe(0);
  });

  it('gives a room taller than the band somewhere to scroll to', async () => {
    const engine = await bootV6({ roomHeight: 400 });

    // A v6 game never asks for this, but the model does not refuse it: what
    // makes v5 and v6 stay put is their room heights, not a version check.
    expect(engine.camera.maxY).toBe(400 - 128);
  });

  it('draws from the camera’s row once there is a range to use', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(320, 400);

    screen.drawRoom(room, 0, 50);

    const top = screen.main.top;
    expect(screen.pixels[top * SCREEN_WIDTH]).toBe(50 & 0xff);
    expect(screen.pixels[(top + 1) * SCREEN_WIDTH]).toBe(51 & 0xff);
  });

  it('clamps a vertical camera past the bottom rather than reading past the room', () => {
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(320, 400);

    screen.drawRoom(room, 0, 10_000);

    const top = screen.main.top;
    expect(screen.pixels[top * SCREEN_WIDTH]).toBe((400 - 128) & 0xff);
  });

  it('ignores a vertical camera on a room that cannot scroll', () => {
    // The compatibility guarantee, stated as a test: every v5 and v6 room is
    // this case, so a stray y can never move one.
    const screen = new Screen();
    screen.setLayout(16, 144);
    const room = stripedRoom(320, 128);

    screen.drawRoom(room, 0, 40);

    const top = screen.main.top;
    expect(screen.pixels[top * SCREEN_WIDTH]).toBe(0);
  });

  it('moves both axes together rather than one after the other', async () => {
    const engine = await bootV6({ roomWidth: 640, roomHeight: 400 });
    engine.setCameraAt(engine.camera.min, 0);
    engine.panCameraTo(engine.camera.max, 200);
    engine.step();

    expect(engine.camera.current).toBeGreaterThan(engine.camera.min);
    expect(engine.camera.currentY).toBeGreaterThan(0);
  });
});
