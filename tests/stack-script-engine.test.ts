import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { StackScriptEngine } from '../src/engine/script/StackScriptEngine.js';
import { ScriptEngineV6 } from '../src/engine/script/v6/ScriptEngine.js';
import { buildV6Fixture, type V6FixtureOptions } from './fixtureV6.js';

/**
 * The stack machine v6 and v7 share (ADR 0006).
 *
 * These are about the base rather than about v6: that the seam is where the ADR
 * says it is, and that the instruction trail — which v5 has always had and v6
 * never did — now reports from the shared decode loop, so v7 inherits it rather
 * than reimplementing it.
 */
async function bootV6(options: V6FixtureOptions = {}) {
  const fixture = buildV6Fixture(options);
  const source = new MemoryDataSource('v6');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  return { engine, logs };
}

describe('the shared stack machine base', () => {
  it('is what a v6 engine is built on', async () => {
    const { engine } = await bootV6();
    expect(engine.scripts).toBeInstanceOf(ScriptEngineV6);
    expect(engine.scripts).toBeInstanceOf(StackScriptEngine);
  });

  it('reports the instructions leading up to an unknown opcode', async () => {
    // 0xfe is not a v6 opcode. The two pushes in front of it are the point: an
    // unknown opcode is usually not the bug but its first symptom, an earlier
    // instruction having consumed the wrong number of operands, so the report
    // is worth little without what ran before it.
    const { engine, logs } = await bootV6({ script2: [0x00, 0x07, 0x00, 0x09, 0xfe] });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    const trail = logs.find((line) => line.includes('last instructions'));
    expect(trail).toBeDefined();
    // Oldest first, so the unknown opcode is last and the pushes before it read
    // in the order they ran.
    expect(trail).toMatch(/0x00.*0x00.*0xfe/);
  });

  it('reports the trail when a script reads past the end of its code', async () => {
    // `pushWordVar` with only one of its two operand bytes present: the fetch
    // runs off the end of the script, which is the overrun path.
    const { engine, logs } = await bootV6({ script2: [0x00, 0x01, 0x03, 0xfa] });
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    const trail = logs.find((line) => line.includes('last instructions'));
    expect(trail).toBeDefined();
    expect(trail).toContain('0x03');
  });

  it('counts a v6 engine’s implemented opcodes through the shared table', async () => {
    const { engine } = await bootV6();
    const scripts = engine.scripts as ScriptEngineV6;

    // The coverage accessors moved to the base with the dispatch table, so they
    // must still answer for v6 exactly as before.
    expect(scripts.implementedOpcodes).toBe(160);
    expect(scripts.unimplementedOpcodes).toHaveLength(256 - 160);
  });
});
