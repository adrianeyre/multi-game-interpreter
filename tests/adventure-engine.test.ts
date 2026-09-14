import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { Screen } from '../src/engine/gfx/Screen.js';
import type { AdventureEngine } from '../src/engine/AdventureEngine.js';
import { buildFixture } from './fixture.js';
import { buildV6Fixture } from './fixtureV6.js';

function sourceFor(which: 'v5' | 'v6') {
  const fixture = which === 'v6' ? buildV6Fixture() : buildFixture();
  const source = new MemoryDataSource(which);
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return source;
}

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

/**
 * A file with its comments removed.
 *
 * Every check below is about what the *code* names. Prose is allowed to name
 * both families — explaining why the seam is where it is means naming what is
 * on each side of it — and a check that failed on a comment would be paid for
 * by deleting the explanation.
 */
function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * The seam between the app shell and an Engine family (ADR 0011).
 *
 * Step 1 of the AGI sequence, and it contains no AGI code — it is proved done
 * by SCUMM continuing to work, which the rest of the suite covers. What is left
 * to assert here is the property the seam exists for: that nothing on either
 * side of it names the other's types.
 */
describe('the host interface names no SCUMM type', () => {
  /**
   * A structural check rather than a type-level one, because the failure it
   * guards against is a member being *added* later that takes a `ScummEngine`
   * or a `SavedGame`. That typechecks perfectly; it just quietly closes the
   * seam again.
   */
  it('mentions neither SCUMM nor AGI anywhere in its own signatures', () => {
    const code = readCode('src/engine/AdventureEngine.ts');

    expect(code).not.toMatch(/ScummEngine|AgiEngine|SavedGame\b(?!Envelope)/);
    expect(code).not.toMatch(/\bverb\b|\bcutscene\b|\bparser\b/i);
  });

  /**
   * ADR 0011 puts a number on this: "if it grows past roughly thirty, the seam
   * is in the wrong place and this ADR should be revisited rather than the
   * interface widened." A test is the only thing that makes that reviewable.
   */
  it('stays small enough to be a description rather than a framework', () => {
    const source = read('src/engine/AdventureEngine.ts');
    const body = source.slice(source.indexOf('export interface AdventureEngine'));
    const members = [...body.matchAll(/^ {2}(?:readonly )?([a-zA-Z]\w*)[?]?[(:]/gm)];

    expect(members.length).toBeGreaterThan(10);
    expect(members.length).toBeLessThanOrEqual(30);
  });
});

describe('the shell holds an AdventureEngine, not a ScummEngine', () => {
  it('never names ScummEngine', () => {
    expect(readCode('src/main.ts')).not.toMatch(/ScummEngine/);
  });

  /**
   * The other half of ADR 0011's rule, and the one a later change is most
   * likely to break: "no new `if (engine is SCUMM)` branch anywhere in the
   * shell". A family check in the shell is the shape that would undo the
   * extraction one feature at a time.
   */
  it('never branches on which family is loaded', () => {
    const source = readCode('src/main.ts');
    expect(source).not.toMatch(/instanceof\s+(Scumm|Agi)/);
    expect(source).not.toMatch(/engine\.target\.engine|targetName ===/);
  });

  /** Input is a capability, so the shell must not be reaching past it. */
  it('does not reach through to verbs, keys or the framebuffer', () => {
    const source = readCode('src/main.ts');
    expect(source).not.toMatch(/engine\.verbs|engine\.pressKey|engine\.handleVerbClick/);
    expect(source).not.toMatch(/engine\.screen\.|engine\.palette|engine\.variables/);
    expect(source).not.toMatch(/CUTSCENEEXIT_KEY/);
  });
});

describe('the extracted seam sits above the script engines', () => {
  /**
   * An acceptance criterion of #122 worth keeping as a test: the v6/v7 stack
   * machine base and the extracted script state are untouched by this seam. If
   * one of them starts importing the host interface, the seam has moved down
   * into the bytecode, which is not where it belongs.
   */
  it('is not imported by the stack machine or the slot model', () => {
    for (const file of [
      'src/engine/script/StackScriptEngine.ts',
      'src/engine/script/ScriptScheduler.ts',
      'src/engine/script/ScriptSlot.ts',
      'src/engine/script/ScriptState.ts',
    ]) {
      expect(read(file)).not.toMatch(/AdventureEngine/);
    }
  });
});

describe('a loaded SCUMM game answers the whole interface', () => {
  /**
   * Assigned to the interface type rather than duck-checked, so this is the
   * compiler's assertion as much as the runner's — and then every member is
   * actually called, because an interface satisfied by accessors that throw is
   * satisfied on paper only.
   */
  it.each(['v5', 'v6'] as const)('as a %s game', async (which) => {
    const engine: AdventureEngine = await loadAdventureEngine(sourceFor(which));

    expect(engine.gameId).toBeTypeOf('string');
    expect(engine.targetName).toMatch(/^SCUMM v[567]$/);
    expect(engine.saveFormat).toBeGreaterThan(0);
    // The shell shows this on a save, so each family says the right thing
    // without the shell asking which family it is.
    expect(engine.saveNote).toMatch(/saves are kept in this browser|specific to this/i);
    expect(engine.frame).toBe(0);
    expect(engine.hasQuit).toBe(false);
    // SCUMM is the degenerate case of ADR 0015's two coordinate spaces: it
    // runs its scripts and draws its picture in the same one (#213).
    expect(engine.resolution.script).toEqual({ width: 320, height: 200 });
    expect(engine.resolution.display).toEqual({ width: 320, height: 200 });
    expect(engine.currentRoom).toBeTypeOf('number');
    expect(engine.describeStall().length).toBeGreaterThan(0);
    // Undefined is the healthy answer: nothing is wrong before boot.
    expect(engine.describeStatus()).toBeUndefined();
    expect(engine.roomName(-1)).toBeUndefined();

    engine.boot();
    engine.step();
    engine.render();

    const saved = engine.saveState('a test');
    expect(saved.gameId).toBe(engine.gameId);
    expect(saved.format).toBe(engine.saveFormat);
    engine.loadState(saved);

    // Attaching and detaching with no DOM: the surface is the only thing the
    // engine is given, so a stub is enough and there is nothing else to mock.
    const listeners: string[] = [];
    const target = {
      addEventListener: (type: string) => listeners.push(type),
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
    };
    engine.input.attach({
      canvas: target as unknown as HTMLElement,
      keys: target,
      overlay: target as unknown as HTMLElement,
      toScreen: () => ({ x: 0, y: 0 }),
      resumeSound: () => undefined,
    });
    // The press, not the click: every version's input script is told about a
    // button going down, and one entry point keeps the two shells in step.
    expect(listeners).toContain('mousedown');
    expect(listeners).toContain('keydown');
    engine.input.detach();
  });
});

describe('a save carries the Target that wrote it', () => {
  /**
   * ADR 0012: a save is Target-tagged, not version-tagged. A bare number cannot
   * say which *family* wrote it, and an AGI save restored into SCUMM is not a
   * near miss — it is 255 flags being read as a v6 variable array.
   */
  it('refuses a save from the other Engine family, rather than crashing', async () => {
    const engine = await loadAdventureEngine(sourceFor('v5'));
    engine.boot();
    const saved = engine.saveState('mine');

    const foreign = {
      ...saved,
      target: { engine: 'agi', interpreter: 0x2917, platform: 'dos' },
    };
    expect(() => engine.loadState(foreign)).toThrow(/AGI|share no state/);
  });

  it('tags its own saves with a SCUMM Target', async () => {
    const engine = await loadAdventureEngine(sourceFor('v6'));
    engine.boot();
    expect(engine.saveState('mine')).toMatchObject({
      target: { engine: 'scumm', version: 6 },
    });
  });
});

describe('an Engine declares its own coordinate spaces (#213)', () => {
  /**
   * The shell scales by `display` and maps clicks through `script`, so a shell
   * that still imports the module constants has not been widened — it has been
   * left behind a family that reports something else.
   */
  it('leaves the shell importing no screen constant of its own', () => {
    for (const file of ['src/main.ts']) {
      expect(read(file)).not.toMatch(/SCREEN_WIDTH|SCREEN_HEIGHT/);
    }
  });

  it('sizes the canvas by display and maps the pointer by script', () => {
    const source = read('src/main.ts');
    expect(source).toMatch(/display\.width \* scale/);
    expect(source).toMatch(/scriptSize\(\)\.width/);
  });

  it('builds a Screen at a size, which is what SCI2 needs and nothing else uses yet', () => {
    const big = new Screen(640, 480);
    expect(big.pixels.length).toBe(640 * 480);
    big.putPixel(639, 479, 7);
    expect(big.getPixel(639, 479)).toBe(7);
    // Out of bounds is still out of bounds, at the size it was built at.
    big.putPixel(640, 0, 7);
    expect(big.getPixel(640, 0)).toBe(0);

    const small = new Screen();
    expect(small.pixels.length).toBe(320 * 200);
  });
});
