import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildFixture } from './fixture.js';

/**
 * What happens when the boot script does not finish.
 *
 * It used to be reported twice, contradictorily. The engine logged that an
 * unimplemented opcode had stopped the boot script "so the game cannot start",
 * and then three lines later the loader logged "Boot script finished" and put
 * `Ready` on the status line — the same words a game that booted successfully
 * gets. The only thing that eventually disagreed was the stuck-state report
 * ten seconds later, which described symptoms (still in room 0, no scripts
 * running) rather than the cause the engine had known all along.
 *
 * So `boot` raises the failure rather than exposing it as a field: a caller
 * cannot present a dead session as a live one by forgetting to look.
 */
function engineWithBoot(bootScript: number[], onLog?: (message: string) => void) {
  const fixture = buildFixture({ bootScript });
  const source = new MemoryDataSource('boot');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  return ScummEngine.create(source, onLog ? { onLog } : {});
}

/** 0x4f is unbound in the v5 table, which is what stopped Full Throttle. */
const UNIMPLEMENTED = [0x4f, 0x00];

describe('a boot script that was stopped, not finished (#63)', () => {
  it('fails the boot rather than returning as though it had worked', async () => {
    const engine = await engineWithBoot(UNIMPLEMENTED);
    expect(() => engine.boot(0)).toThrow();
  });

  it('fails with the reason the engine already logged', async () => {
    const messages: string[] = [];
    const engine = await engineWithBoot(UNIMPLEMENTED, (m) => messages.push(m));

    let thrown = '';
    try {
      engine.boot(0);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }

    // The load failure puts the first line of the message on the status line,
    // so the reason has to be in the message rather than only in the log.
    expect(thrown).toMatch(/Unimplemented opcode 0x4f/);
    expect(thrown).toMatch(/stopped the boot script/);
    expect(thrown).toMatch(/the game cannot start/);
    expect(thrown.split('\n')[0]).toBe(thrown);
    expect(messages.some((m) => m.includes('0x4f'))).toBe(true);
  });

  it('does not claim the opcode simply needs implementing', async () => {
    // The old wording sent a reader off to extend the opcode table when the
    // actual cause could be that the engine is reading the wrong script format
    // entirely — which is exactly what a v7 game misread as v5 produces.
    const messages: string[] = [];
    const engine = await engineWithBoot(UNIMPLEMENTED, (m) => messages.push(m));
    expect(() => engine.boot(0)).toThrow();

    const joined = messages.join('\n');
    expect(joined).not.toMatch(/needs implementing for this release/);
    expect(joined).toMatch(/not v5 bytecode|check the version/);
  });

  it('lets a healthy boot script through', async () => {
    const engine = await engineWithBoot([0x1a, 100, 0, 0xd2, 0x04, 0x00]);

    expect(() => engine.boot(0)).not.toThrow();
    expect(engine.variables[100]).toBe(1234);
  });

  it('fails a second boot for the same reason, not just the first', async () => {
    // The report itself is once-per-opcode so the log does not fill up. The
    // failure is not: a reload that stops the same way has to stop the same
    // way.
    const engine = await engineWithBoot(UNIMPLEMENTED);

    expect(() => engine.boot(0)).toThrow(/0x4f/);
    expect(() => engine.boot(0)).toThrow(/0x4f/);
  });

  it('does not fail the boot when a script the boot script started dies', async () => {
    // Script 2 is a separate script; the boot script itself still finishes, so
    // the game is running and the load succeeded.
    const fixture = buildFixture({
      // startScript 2, then a marker so the boot script's own completion is
      // visible.
      bootScript: [0x0a, 0x02, 0xff, 0x1a, 100, 0, 0xd2, 0x04, 0x00],
      script2: UNIMPLEMENTED,
    });
    const source = new MemoryDataSource('child');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const messages: string[] = [];
    const engine = await ScummEngine.create(source, { onLog: (m) => messages.push(m) });

    expect(() => engine.boot(0)).not.toThrow();
    expect(engine.variables[100]).toBe(1234);
    // Proves the child really did hit the opcode, so the case is not vacuous.
    expect(engine.unknownOpcodes.get(0x4f)).toBe(2);
    expect(messages.some((m) => /0x4f in script 2/.test(m))).toBe(true);
  });

  it('logs a failed restart instead of throwing out of the frame loop', async () => {
    // restart() is called from a script, mid-frame. A throw there would escape
    // requestAnimationFrame and stop the game with a browser error rather than
    // a reason on screen.
    const messages: string[] = [];
    const engine = await engineWithBoot(UNIMPLEMENTED, (m) => messages.push(m));
    expect(() => engine.boot(0)).toThrow();

    expect(() => engine.restart()).not.toThrow();
    expect(messages.some((m) => /0x4f.*stopped the boot script/.test(m))).toBe(true);
  });
});
