import type { ScummEngine } from '../../ScummEngine.js';
import { ClassicScriptEngine } from '../ClassicScriptEngine.js';
import type { ScriptState } from '../ScriptState.js';

/**
 * The SCUMM v5 bytecode interpreter — Monkey Island 2, Fate of Atlantis.
 *
 * The first delta on `ClassicScriptEngine`, and a thin one: v5 is the Version
 * the base was extracted from, so almost every instruction it runs is a shared
 * one at a shared number. What is here is the handful of opcode numbers v5
 * spends differently from its predecessors.
 *
 * ADR 0014 records why the base exists at all. ADR 0006 set the discipline this
 * followed: the extraction landed on its own, with no new Version beside it, so
 * a regression in Atlantis — which carries the whole fault list this engine was
 * beaten into shape against — is attributable to the refactor rather than to a
 * second Version arriving at the same time.
 */
export class ScriptEngine extends ClassicScriptEngine {
  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    this.installOpcodes();
  }

  /**
   * v5's table: everything Classic shares, then the four numbers it re-spends.
   *
   * Each of these is an opcode v3 and v4 use for something else, which is
   * exactly why they are not in the shared installer. `0x22` is the clearest:
   * v5 reads an actor's animation counter there and v4 saves or loads a game,
   * so a shared binding would not fail — it would run the wrong instruction on
   * the wrong Version and carry on.
   */
  protected installOpcodes(): void {
    this.installClassicSharedOpcodes();

    const bind = (handler: (this: this) => void, ...codes: number[]): void => {
      for (const code of codes) this.dispatch[code] = handler;
    };

    // v3 and v4 spend 0x22 on saveLoadGame.
    bind(this.o_getAnimCounter, 0x22, 0xa2);
    // v3 waits for an actor here; v4 and v5 read its scale.
    bind(this.o_getActorScale, 0x3b, 0xbb);
    // v3 sets box flags here; v4 and v5 run the box matrix operations.
    bind(this.o_matrixOps, 0x30, 0xb0);
    // v3 and v4 save and load variables here. v5 dropped it.
    bind(this.o_dummy, 0xa7);
  }
}
