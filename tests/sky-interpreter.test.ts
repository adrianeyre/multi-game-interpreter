import { describe, expect, it } from 'vitest';
import {
  SkyInterpreter,
  SkyMcodeUnimplemented,
  type SkyScriptWorld,
} from '../src/engine/sky/script/SkyInterpreter.js';
import { SKY_MCODE_STRIDE } from '../src/engine/sky/script/skyMcodes.js';

/** A world with no screen, which is the point: the machine needs none. */
class TestWorld implements SkyScriptWorld {
  readonly variables = new Map<number, number>();
  readonly compact = new Map<number, number>();
  readonly calls: { mcode: number; a: number; b: number; c: number }[] = [];
  /** mcodes that pause rather than complete, by number. */
  pausing = new Set<number>();
  /** mcodes with nothing behind them, by number. */
  missing = new Set<number>();

  readVariable(index: number): number {
    return this.variables.get(index) ?? 0;
  }
  writeVariable(index: number, value: number): void {
    this.variables.set(index, value);
  }
  readCompact(offset: number): number {
    return this.compact.get(offset) ?? 0;
  }
  writeCompact(offset: number, value: number): void {
    this.compact.set(offset, value);
  }
  callMcode(mcode: number, a: number, b: number, c: number): boolean {
    if (this.missing.has(mcode)) throw new SkyMcodeUnimplemented(mcode);
    this.calls.push({ mcode, a, b, c });
    return !this.pausing.has(mcode);
  }
}

function script(...words: number[]): Uint16Array {
  return Uint16Array.from(words);
}

describe('SkyInterpreter', () => {
  it('runs arithmetic and stores the result in a script variable', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    // push 7, push 5, minus (7 - 5), pop into variable 3, exit.
    const report = machine.run(script(2, 7, 2, 5, 7, 6, 3 * 4, 19), 0);
    expect(report.outcome.kind).toBe('finished');
    expect(world.variables.get(3)).toBe(2);
  });

  it('divides a variable operand by four, because it counts bytes', () => {
    // The unit change. A machine that forgets it reads variable 40 as 10.
    const world = new TestWorld();
    world.variables.set(10, 99);
    const machine = new SkyInterpreter(world);
    machine.run(script(0, 40, 6, 4 * 4, 19), 0);
    expect(world.variables.get(4)).toBe(99);
  });

  it('divides a branch operand by two, because it counts bytes', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    // push 0, skip_zero over four bytes (two words), push 1 / pop var 0 skipped
    const report = machine.run(script(2, 0, 5, 4, 2, 1, 2, 5, 6, 0, 19), 0);
    expect(report.outcome.kind).toBe('finished');
    // The skip landed on `push 5`, so variable 0 is 5 rather than 1.
    expect(world.variables.get(0)).toBe(5);
  });

  it('loops backwards through a negative skip_not_zero', () => {
    // Every one of the 708 skip_not_zero instructions in the shipped game goes
    // backwards. A machine reading the distance unsigned never loops.
    const world = new TestWorld();
    world.variables.set(0, 3);
    const machine = new SkyInterpreter(world);
    const report = machine.run(
      script(
        0,
        0, // push var 0
        2,
        1, // push 1
        7, // minus
        6,
        0, // pop var 0
        0,
        0, // push var 0
        18,
        0x10000 - 22, // skip_not_zero back eleven words, to the start
        19, // exit
      ),
      0,
    );
    expect(report.outcome.kind).toBe('finished');
    expect(world.variables.get(0)).toBe(0);
  });

  it('takes a switch case, and its default when nothing matches', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    // switch on 20, cases 10 and 20; the second lands on `push 2`.
    const taken = script(2, 20, 14, 2, 10, 8, 20, 14, 2, 2, 111, 6, 0, 19, 2, 222, 6, 0, 19);
    machine.run(taken, 0);
    expect(world.variables.get(0)).toBe(222);

    // Switch on something no case matches: the default distance applies.
    const missed = script(2, 99, 14, 2, 10, 8, 20, 14, 2, 2, 111, 6, 0, 19, 2, 222, 6, 0, 19);
    const other = new TestWorld();
    new SkyInterpreter(other).run(missed, 0);
    expect(other.variables.get(0)).toBe(111);
  });

  it('pops a call’s arguments in reverse', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    machine.run(script(2, 1, 2, 2, 2, 3, 11, 3, 5 * SKY_MCODE_STRIDE, 19), 0);
    expect(world.calls).toEqual([{ mcode: 5, a: 1, b: 2, c: 3 }]);
  });

  it('pauses where an mcode says "not yet", and says what for', () => {
    // Normal, not an error: fnSpeakWait pauses until the line is over.
    const world = new TestWorld();
    world.pausing.add(37);
    const machine = new SkyInterpreter(world);
    const report = machine.run(script(2, 1, 11, 1, 37 * SKY_MCODE_STRIDE, 19), 0);
    expect(report.outcome).toMatchObject({ kind: 'paused', offset: 5 });
    if (report.outcome.kind === 'paused') {
      expect(report.outcome.waitingFor).toMatch(/^fn/);
    }
  });

  it('stops on an mcode with nothing behind it, naming it and where', () => {
    // Never silently skipped: an mcode passed over leaves the world in a state
    // the script did not ask for, which shows up later and somewhere else.
    const world = new TestWorld();
    world.missing.add(63);
    const machine = new SkyInterpreter(world);
    const report = machine.run(script(2, 1, 11, 1, 63 * SKY_MCODE_STRIDE, 19), 0);
    expect(report.outcome.kind).toBe('stopped');
    if (report.outcome.kind === 'stopped') {
      expect(report.outcome.reason).toMatch(/fnRunFrames is not implemented/);
      expect(report.outcome.reason).toMatch(/word 2/);
    }
    expect(machine.unimplemented.get('fnRunFrames')).toBe(1);
  });

  it('stops rather than looping forever', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    // skip_always back onto itself.
    const report = machine.run(script(9, 0x10000 - 4), 0);
    expect(report.outcome.kind).toBe('stopped');
    if (report.outcome.kind === 'stopped') expect(report.outcome.reason).toMatch(/looping/);
  });

  it('reads and writes the running compact’s fields', () => {
    const world = new TestWorld();
    world.compact.set(6, 160);
    const machine = new SkyInterpreter(world);
    // push_offset 6, push 8, plus, pop_offset 7.
    machine.run(script(15, 6, 2, 8, 8, 16, 7, 19), 0);
    expect(world.compact.get(7)).toBe(168);
  });

  it('keeps the last instructions, so a stall can be read back', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    machine.run(script(2, 1, 2, 2, 8, 19), 0);
    const recent = machine.recentInstructions();
    expect(recent[recent.length - 1].name).toBe('script_exit');
    expect(recent.length).toBeLessThanOrEqual(16);
  });

  it('names the variable a poll loop reads and never writes', () => {
    // The instrumentation behind Bug 2: a variable read many times with zero
    // writes is one nothing on this side sets, so the loop reading it cannot
    // end. Here variable 13 is read three times, written none, and variable 4
    // is both read and written — so 13 is the one a stall names (#268).
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    // Across three runs: each reads var 13, then writes var 4 once and reads
    // it once (copying it on to var 5), so var 4 is both read and written.
    for (let i = 0; i < 3; i += 1) {
      // push var 13, pop var 4, push var 4, pop var 5, exit.
      machine.run(script(0, 13 * 4, 6, 4 * 4, 0, 4 * 4, 6, 5 * 4, 19), 0);
    }
    const traffic = machine.variableTraffic();
    const thirteen = traffic.find((t) => t.index === 13);
    const four = traffic.find((t) => t.index === 4);
    expect(thirteen).toEqual({ index: 13, reads: 3, writes: 0 });
    expect(four).toMatchObject({ index: 4, writes: 3 });
    // Busiest-read variable sorts first; the never-written one is the cause.
    const polled = traffic.find((t) => t.writes === 0 && t.reads > 0);
    expect(polled?.index).toBe(13);
  });

  it('counts which mcodes the scripts called, by number', () => {
    const world = new TestWorld();
    const machine = new SkyInterpreter(world);
    // Call mcode 5 twice and mcode 7 once.
    machine.run(script(2, 1, 11, 1, 5 * SKY_MCODE_STRIDE, 19), 0);
    machine.run(script(2, 1, 11, 1, 5 * SKY_MCODE_STRIDE, 19), 0);
    machine.run(script(2, 1, 11, 1, 7 * SKY_MCODE_STRIDE, 19), 0);
    const counts = machine.mcodeCallCounts();
    expect(counts[0]).toEqual({ mcode: 5, count: 2 });
    expect(counts.find((c) => c.mcode === 7)).toEqual({ mcode: 7, count: 1 });
  });
});
