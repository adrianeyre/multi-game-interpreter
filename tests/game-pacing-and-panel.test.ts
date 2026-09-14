import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { VAR } from '../src/engine/constants.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';
import { u16le } from './fixture.js';

/**
 * How fast a game runs, and what its panel shows.
 *
 * Both were found by watching Day of the Tentacle in a browser rather than by
 * reading a log: it ran at six times its own speed, and the half of its
 * interface made of pictures was missing.
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

describe('the rate a game asks to run at', () => {
  it('is the sixtieths it puts in VAR_TIMER_NEXT', async () => {
    const engine = await bootV6();
    engine.boot(0);

    // Day of the Tentacle asks for six, which is ten cycles a second.
    engine.variables[VAR.TIMER_NEXT] = 6;
    expect(engine.ticksPerStep).toBe(6);
  });

  it('never asks for a cycle of no length, whatever the game writes', async () => {
    const engine = await bootV6();
    engine.boot(0);

    engine.variables[VAR.TIMER_NEXT] = 0;
    expect(engine.ticksPerStep).toBe(1);
    engine.variables[VAR.TIMER_NEXT] = -4;
    expect(engine.ticksPerStep).toBe(1);
  });

  it('advances the timers by the length of the cycle, not by one', async () => {
    const engine = await bootV6();
    engine.boot(0);
    engine.variables[VAR.TIMER_NEXT] = 6;
    engine.variables[VAR.TMR_1] = 0;
    engine.variables[VAR.TIMER_TOTAL] = 0;

    engine.step();

    // A script timing something in seconds counts sixtieths, so a cycle worth
    // six of them has to advance the count by six.
    expect(engine.variables[VAR.TIMER]).toBe(6);
    expect(engine.variables[VAR.TMR_1]).toBe(6);
    expect(engine.variables[VAR.TIMER_TOTAL]).toBe(6);
  });
});

describe('the verb panel', () => {
  it('draws a verb that is a picture rather than a word', async () => {
    // Verb 1 shows the fixture's object, positioned in the panel.
    const engine = await bootV6({
      script2: [
        ...byte(1),
        0x9e,
        0xc4, // verbOps.setCurrentVerb(1)
        ...word(500),
        0x9e,
        0x7c, // verbOps.image(500)
        ...byte(8),
        ...byte(150),
        0x9e,
        0x80, // verbOps.at(8, 150)
        0x9e,
        0x81, // verbOps.on()
        0x9e,
        0xff, // verbOps.end()
        STOP,
      ],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.scripts.runScript(2, false, false, []);

    engine.render();

    let painted = 0;
    for (let y = 150; y < 166; y++) {
      for (let x = 8; x < 24; x++) if (engine.screen.getPixel(x, y) !== 0) painted++;
    }
    // The whole point: an image verb used to be skipped, leaving the panel
    // blank where the inventory belongs.
    expect(painted).toBeGreaterThan(0);
  });

  it('gives an image verb bounds, so it can be clicked', async () => {
    const engine = await bootV6({
      script2: [
        ...byte(1),
        0x9e,
        0xc4,
        ...word(500),
        0x9e,
        0x7c,
        ...byte(8),
        ...byte(150),
        0x9e,
        0x80,
        0x9e,
        0x81,
        0x9e,
        0xff,
        STOP,
      ],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.scripts.runScript(2, false, false, []);
    engine.render();

    expect(engine.verbs.hitTest(10, 152)).toBe(1);
  });
});

describe('the debug channel', () => {
  it('does not put a script’s own notes on the screen', async () => {
    const engine = await bootV6({
      script2: [
        0xb6,
        0xfe, // printDebug.begin()
        0xb6,
        0x4b,
        ...[...'LEAVING verify start sound'].map((c) => c.charCodeAt(0)),
        0,
        ...byte(7),
        ...store(250),
        STOP,
      ],
    });
    engine.boot(0);
    engine.startScene(1, null, 0);
    engine.scripts.runScript(2, false, false, []);

    // Nothing shown, and the script carried on past it.
    expect(engine.currentText()).toBe('');
    expect(engine.variables[250]).toBe(7);
  });
});
