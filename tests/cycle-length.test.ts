import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { Palette } from '../src/engine/gfx/Palette.js';
import { TEXT_SLOT, VAR, VAR_V6 } from '../src/engine/constants.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';
import { buildFixture } from './fixture.js';
import { u16le } from './fixture.js';

/**
 * What one cycle is worth.
 *
 * A SCUMM game sets its own cycle rate and most of the interpreter's counters
 * are denominated in sixtieths rather than in cycles — a script delay, the time
 * a line of text stays up, a colour cycle's period. Once the shell started
 * pacing the engine at the game's rate rather than at sixty cycles a second,
 * every one of those counters became wrong by exactly that rate: Day of the
 * Tentacle asks for six sixtieths a cycle, so every wait in the game took six
 * times as long as it was written to.
 *
 * These say what each counter is denominated in, because the two units are
 * indistinguishable at sixty cycles a second and only diverge on a real game.
 */

const STOP = 0x66;
const byte = (value: number) => [0x00, value & 0xff];
const word = (value: number) => [0x01, ...u16le(value & 0xffff)];
const store = (variable: number) => [0x43, ...u16le(variable)];

async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return ScummEngine.create(source, { random: () => 0.5 });
}

/** Runs the engine at the game's own rate for a number of sixtieths. */
function runFor(engine: ScummEngine, sixtieths: number): number {
  let cycles = 0;
  for (let ticks = 0; ticks < sixtieths; ticks += engine.ticksPerStep) {
    engine.step();
    cycles++;
  }
  return cycles;
}

describe('a script delay', () => {
  it('is a length of time, so it ends after that many sixtieths', async () => {
    // Script 2 waits a second and then writes a variable, so the moment it
    // resumes is observable without reaching into the slot.
    const engine = await bootV6({
      script2: [
        ...word(60),
        0xb0, // delay 60 sixtieths — one second
        ...byte(9),
        ...store(250),
        STOP,
      ],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    // Ten cycles a second, the rate Day of the Tentacle asks for.
    engine.variables[VAR.TIMER_NEXT] = 6;
    engine.scripts.runScript(2, false, false, []);

    // Half a second in, still waiting.
    runFor(engine, 30);
    expect(engine.variables[250]).toBe(0);

    // A second in, awake — after ten cycles, not sixty. Counted per cycle the
    // wait would still have five sixths of itself left to run.
    runFor(engine, 36);
    expect(engine.variables[250]).toBe(9);
  });

  it('takes the same wall-clock time whatever rate the game runs at', async () => {
    const script = [...word(120), 0xb0, ...byte(1), ...store(250), STOP];

    for (const rate of [1, 4, 6, 12]) {
      const engine = await bootV6({ script2: script });
      engine.boot(0);
      engine.startScene(1, null, 0);
      engine.variables[VAR.TIMER_NEXT] = rate;
      engine.scripts.runScript(2, false, false, []);

      let cycles = 0;
      while (engine.variables[250] === 0 && cycles < 1000) {
        engine.step();
        cycles++;
      }

      // However many cycles that took, they add up to the two seconds the
      // script asked for — to within the one cycle the last step overshoots by.
      expect(engine.variables[250], `rate ${rate}, woke`).toBe(1);
      expect(cycles * rate, `rate ${rate}, elapsed`).toBeGreaterThanOrEqual(120);
      expect(cycles * rate, `rate ${rate}, elapsed`).toBeLessThan(120 + rate);
    }
  });
});

describe('delayFrames', () => {
  it('counts cycles rather than sixtieths, whatever the rate', async () => {
    // The one wait in the instruction set that is *not* a length of time: it
    // has its own counter in the original because it means "let this many
    // cycles happen", and folding it into the sixtieths above makes it end
    // almost at once on a game with a long cycle.
    const engine = await bootV6({
      script2: [...word(10), 0xca, ...byte(3), ...store(250), STOP],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.variables[VAR.TIMER_NEXT] = 6;
    engine.scripts.runScript(2, false, false, []);

    for (let i = 0; i < 9; i++) engine.step();
    expect(engine.variables[250]).toBe(0);

    engine.step();
    expect(engine.variables[250]).toBe(3);
  });
});

describe('a line of text', () => {
  it('stays up for its own length rather than for that many cycles', async () => {
    const engine = await bootV6();
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.variables[VAR.TIMER_NEXT] = 6;
    engine.variables[VAR.CHARINC] = 4;

    engine.showText({
      actor: 0,
      slot: TEXT_SLOT.Speech,
      x: 0,
      y: 0,
      color: 15,
      right: 319,
      center: false,
      left: true,
      overhead: false,
      hasPosition: true,
      text: 'hello',
      speechOffset: 0,
      speechSize: 0,
    });
    const frames = engine.messageFramesRemaining();
    expect(frames).toBeGreaterThan(0);

    // Ten cycles of six sixtieths spend sixty of the timer's units, not ten.
    for (let i = 0; i < 10; i++) engine.step();
    expect(engine.messageFramesRemaining()).toBe(Math.max(0, frames - 60));
  });
});

describe('a colour cycle', () => {
  it('rotates on its delay in sixtieths, and carries the remainder', () => {
    const palette = new Palette();
    const rgb = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) rgb[i * 3] = i;
    palette.setFromClut(rgb);
    // A delay of ten sixtieths: one rotation every ten of them, however many
    // cycles those fall in.
    palette.setCycles([{ start: 0, end: 3, delay: 10, direction: 1, counter: 0 }]);

    const firstColour = (): number => {
      palette.flush();
      return palette.rgba[0];
    };

    // Two cycles of six sixtieths is twelve — one rotation, with two carried.
    palette.step(6);
    palette.step(6);
    expect(firstColour()).toBe(3);

    // Eight more sixtieths reaches the next rotation because the two were
    // kept. Reset to zero instead, this would still be two short.
    palette.step(6);
    palette.step(2);
    expect(firstColour()).toBe(2);
  });
});

describe('the variables the interpreter owns', () => {
  it('reports the expanded memory a v6 game refuses to start without', async () => {
    const engine = await bootV6();
    engine.boot(0);
    // Day of the Tentacle opens on "WARNING: EMS detects less than 2
    // megabytes." and waits there when this is zero.
    expect(engine.variables[VAR_V6.EMS_SPACE]).toBe(10000);
  });

  it('tells a v6 game how big the room it just entered is', async () => {
    const engine = await bootV6({ roomWidth: 480, roomHeight: 144 });
    engine.boot(0);
    engine.startScene(1, null, 0);

    expect(engine.variables[VAR_V6.ROOM_WIDTH]).toBe(480);
    expect(engine.variables[VAR_V6.ROOM_HEIGHT]).toBe(144);
  });
});

describe('drawing an object', () => {
  it('records the state, so a later redraw keeps it', async () => {
    const engine = await bootV6({ objectState: 1 });
    engine.boot(0);
    engine.startScene(1, null, 0);

    engine.drawObject(500, 2);

    // The global table, not just the room's copy of the object: everything
    // that redraws the room reads the state from here, so an object drawn
    // without recording it reverted the moment anything else changed.
    expect(engine.getState(500)).toBe(2);
  });
});

describe('v5 drawObject', () => {
  it('puts away whatever else stands on the same box', async () => {
    // Two objects sharing a rectangle is how a room stores two appearances of
    // one thing — the open door and the shut one. v5 hides the rest before it
    // draws the one it was asked for.
    const fixture = buildFixture({});
    const source = new MemoryDataSource('v5');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source, { random: () => 0.5 });
    engine.boot(0);
    engine.startScene(1, null, 0);

    const room = engine.currentRoomData;
    expect(room).not.toBeNull();
    const object = room!.objects[0];
    // A second object standing exactly where the first does.
    room!.objects.push({ ...object, id: object.id + 1, verbs: new Map() });
    engine.putState(object.id + 1, 1);
    expect(engine.getState(object.id + 1)).toBe(1);

    engine.clearObjectsSharingBox(object.id);
    expect(engine.getState(object.id + 1)).toBe(0);
    expect(engine.getState(object.id)).not.toBe(0);
  });
});
