import { describe, expect, it } from 'vitest';

import { ClassicScriptEngine } from '../src/engine/script/ClassicScriptEngine.js';
import { ScriptEngine as ScriptEngineV5 } from '../src/engine/script/v5/ScriptEngine.js';

/**
 * The shape ADR 0014 asked for on the Classic side, pinned.
 *
 * These are structural assertions rather than behavioural ones on purpose: the
 * behaviour is covered by every other v5 test in this suite, and what the
 * extraction could break silently is the *seam* — a Version quietly inheriting
 * a concrete table instead of installing one, which would work perfectly until
 * v4 arrived beside it and inherited v5's opcode numbers.
 */
describe('the Classic script engine base', () => {
  it('is abstract, so no Version is the default one', () => {
    // `abstract` is erased at runtime, so the check that survives compilation
    // is that the base does not carry an opcode table of its own: a Version
    // installs one, and there is no Version that is merely "the base".
    expect(
      Object.getOwnPropertyNames(ClassicScriptEngine.prototype).includes('installOpcodes'),
    ).toBe(false);
  });

  it('holds the shared installer the Versions build on', () => {
    expect(
      Object.getOwnPropertyNames(ClassicScriptEngine.prototype).includes(
        'installClassicSharedOpcodes',
      ),
    ).toBe(true);
  });

  it('has v5 as a delta over it rather than as itself', () => {
    expect(Object.getPrototypeOf(ScriptEngineV5.prototype)).toBe(ClassicScriptEngine.prototype);
    expect(Object.getOwnPropertyNames(ScriptEngineV5.prototype)).toContain('installOpcodes');
  });
});
