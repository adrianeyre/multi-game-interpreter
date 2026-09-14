import { describe, expect, it } from 'vitest';
import {
  AgosInterpreter,
  AgosState,
  type AgosScriptLibrary,
} from '../src/engine/agos/script/AgosInterpreter.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type { AgosSubroutine, AgosSubroutineBlock } from '../src/engine/agos/script/subroutines.js';

const SIMON2: AgosTarget = {
  family: 'AGOS',
  version: 'Simon2',
  releaseKind: 'talkie',
  platform: 'dos',
};

const sub = (id: number): AgosSubroutine => ({ id, lines: [], endMarker: 0 });

/**
 * The contract behind Simon 2's effects bank: the reference reloads a
 * non-resident Subroutine's table — and swaps its sounds — on *every* jump to
 * it, not only the first (`subroutine.cpp:378`). The bytes are cached so the
 * disassembly is not re-read, but the jump itself must still be observable so
 * the engine can put the running table's effects bank in place. A side effect
 * hung on the cached `subroutine()` lookup fired once and then never again,
 * which froze the bank on whichever table was warmed up last.
 */
describe('a jump to a Subroutine outside GAMEPC', () => {
  const externalId = 5301;
  const residentId = 42;
  const block: AgosSubroutineBlock = { subroutines: [sub(residentId)], endMarker: 0 };

  function harness() {
    const lookups: number[] = [];
    const jumps: number[] = [];
    const library: AgosScriptLibrary = {
      subroutine(id) {
        lookups.push(id);
        return sub(id);
      },
      enterSubroutine(id) {
        jumps.push(id);
      },
      string: () => undefined,
    };
    const interpreter = new AgosInterpreter(
      block,
      new AgosState([]),
      SIMON2,
      undefined,
      [],
      Math.random,
      library,
    );
    return { interpreter, lookups, jumps };
  }

  it('is announced on every jump, even after the bytes are cached', () => {
    const { interpreter, lookups, jumps } = harness();

    interpreter.begin(externalId);
    interpreter.begin(externalId);
    interpreter.begin(externalId);

    // The disassembly is read once — that is what `found` is for.
    expect(lookups).toEqual([externalId]);
    // But the jump is announced each time, which is what lets the engine keep
    // the effects bank tracking the running table.
    expect(jumps).toEqual([externalId, externalId, externalId]);
  });

  it('is not announced for a Subroutine that lives in GAMEPC', () => {
    const { interpreter, lookups, jumps } = harness();

    interpreter.begin(residentId);

    // A resident Subroutine never reaches the library, so no table is loaded
    // and no bank is swapped — matching the reference's early return.
    expect(lookups).toEqual([]);
    expect(jumps).toEqual([]);
  });
});
