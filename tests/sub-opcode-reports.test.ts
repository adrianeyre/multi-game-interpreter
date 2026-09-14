import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildV7Fixture } from './fixtureV7.js';

/**
 * What an unimplemented sub-opcode is reported to have cost.
 *
 * A sub-opcode is a byte after the opcode, but the arguments it describes are
 * not all read the same way, and every one of these instructions was reported
 * as having left its operands in the code — the one thing that cannot be true
 * of `kernelSetFunctions`, which pops its whole argument list before it looks
 * at the number. A report that invents a corrupted instruction stream sends a
 * reader hunting a desync that is not there, which is the same fault as naming
 * a costume that decodes perfectly well: worse than saying nothing, because it
 * is confidently wrong about where to look.
 */
async function run(code: number[]) {
  const fixture = buildV7Fixture({ script2: code });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  engine.boot(0);
  engine.scripts.runScript(2, false, false, []);
  return logs.filter((line) => line.startsWith('Unimplemented'));
}

describe('reporting a sub-opcode the engine does not implement', () => {
  it('does not claim a misread script when the arguments were already popped', async () => {
    // `kernelSetFunctions` reads its whole argument list off the stack before
    // dispatching on the first entry, so an unimplemented function costs
    // exactly itself. Push a one-entry list naming function 0x63, which is in
    // no version's table.
    const [line] = await run([0x00, 0x63, 0x00, 0x01, 0xc9]);

    expect(line).toContain('kernelSetFunctions sub-opcode 0x63');
    expect(line).toContain('nothing after it is misread');
    expect(line).not.toContain('being misread');
  });

  it('says an actorOps argument is left on the stack, not in the code', async () => {
    // The sub-opcode byte is the whole of what `actorOps` reads from the code;
    // its arguments were pushed by preceding instructions. So the stream is
    // intact and what is left is a stack value nobody claimed — which is a
    // real fault, and a different one.
    //
    // 0x5a is a gap in the set itself, between `InitAnimation` and `Width`,
    // so it stays unimplemented in a way a real sub-opcode does not: this
    // test first used 0xe1, which the Full Throttle demo turned out to emit.
    const [line] = await run([0x00, 0x01, 0x9d, 0x5a]);

    expect(line).toContain('actorOps sub-opcode 0x5a');
    expect(line).toContain('still on the stack');
    expect(line).toContain('instruction stream itself is intact');
  });

  it('will not guess for an instruction whose family reads operands both ways', async () => {
    // `wait` takes a jump displacement inline for some sub-opcodes and its
    // actor off the stack for others, so the encoding of one nothing has
    // identified is not knowable. Saying so beats picking.
    const [line] = await run([0xa9, 0x7f]);

    expect(line).toContain('wait sub-opcode 0x7f');
    expect(line).toContain('depending on');
    expect(line).not.toContain('still on the stack');
  });

  it('reports each instruction and sub-opcode pair once', async () => {
    // These run every frame a script is alive, so a bare log buries the rest
    // of the report under thousands of copies of one line.
    const lines = await run([0x00, 0x01, 0x9d, 0x5a, 0x00, 0x01, 0x9d, 0x5a]);

    expect(lines).toHaveLength(1);
  });
});
