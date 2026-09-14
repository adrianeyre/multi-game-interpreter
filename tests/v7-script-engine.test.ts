import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { StackScriptEngine } from '../src/engine/script/StackScriptEngine.js';
import { ScriptEngineV7 } from '../src/engine/script/v7/ScriptEngine.js';
import {
  measureV7Message,
  v7MessageFallback,
  v7MessageKey,
} from '../src/engine/script/v7/message.js';
import { buildV7Fixture, V7_SCRIPT_RESULT, type V7FixtureOptions } from './fixtureV7.js';

/**
 * The v7 stack machine.
 *
 * Every script here is hand-assembled, so what is checked is the engine's
 * reading of specific bytes. v7 shares v6's opcode numbering — ScummVM gives it
 * no table of its own — so these mostly prove the shared base is reached, and
 * the delta tests prove where v7 diverges.
 */
async function bootV7(options: V7FixtureOptions = {}) {
  const fixture = buildV7Fixture(options);
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);

  const logs: string[] = [];
  const engine = await ScummEngine.create(source, { onLog: (line) => logs.push(line) });
  return { engine, logs };
}

async function run(code: number[]) {
  const { engine, logs } = await bootV7({ script2: code });
  engine.boot(0);
  engine.scripts.runScript(2, false, false, []);
  return { engine, logs };
}

describe('choosing an interpreter', () => {
  it('uses the v7 engine for a v7 game', async () => {
    const { engine } = await bootV7();
    expect(engine.scripts).toBeInstanceOf(ScriptEngineV7);
    expect(engine.scripts).toBeInstanceOf(StackScriptEngine);
  });

  it('draws the global script boundary where v7 does, not where v6 does', async () => {
    const { engine } = await bootV7();
    // Not a limit but a boundary: a number on the wrong side of it is looked
    // for in the room rather than the index, and reported missing.
    expect(engine.numGlobalScripts).toBe(2000);
  });
});

describe('the instructions v7 shares with v6', () => {
  it('runs a script built from the shared stack core', async () => {
    // The fixture's default script 2 is arithmetic through push, mul and
    // writeWordVar — all installed by the shared base, at v6's numbers.
    const { engine } = await bootV7();
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);
    expect(engine.variables[250]).toBe(V7_SCRIPT_RESULT.var250);
    expect(engine.variables[251]).toBe(V7_SCRIPT_RESULT.var251);
  });

  it('jumps backwards to the right byte', async () => {
    // The v6 fault that no test caught: a backward displacement counted from
    // before the fetch lands two bytes early, in the middle of the instruction
    // the loop starts with. Shared code now, so it is worth asserting per
    // version rather than trusting the move.
    const { engine } = await run([
      0x00,
      0x00,
      0x43,
      0xfa,
      0x00, // var250 = 0
      0x03,
      0xfa,
      0x00,
      0x00,
      0x01,
      0x14,
      0x43,
      0xfa,
      0x00, // var250 += 1
      0x03,
      0xfa,
      0x00,
      0x00,
      0x03,
      0x0f, // var250 != 3
      0x5c,
      0xee,
      0xff, // jumpIfTrue back to the increment: -18 from offset 23
      0x66,
    ]);
    expect(engine.variables[250]).toBe(3);
  });
});

describe('the v7 delta', () => {
  it('reports an unimplemented opcode by number rather than skipping it', async () => {
    const { logs } = await run([0x00, 0x07, 0xfe]);
    expect(logs.some((line) => line.includes('0xfe'))).toBe(true);
  });

  it('reports the instruction trail it inherits from the shared base', async () => {
    const { logs } = await run([0x00, 0x07, 0x00, 0x09, 0xfe]);
    expect(logs.some((line) => line.includes('last instructions'))).toBe(true);
  });

  it('names the sound instructions it does not serve, rather than dropping them', async () => {
    // v7 routes sound into iMUSE Digital, which is #104 and #106. Named once,
    // with the issue that will serve it, rather than silently doing nothing.
    const { logs } = await run([0x00, 0x05, 0x74, 0x66]);
    expect(logs.some((line) => line.includes('startSound'))).toBe(true);
  });

  it('consumes both camera operands, so the next instruction is not misread', async () => {
    // `setCameraAt` takes an x and a y in v7 and only an x in v6. Popping one
    // would leave the other for the following instruction to read as its own,
    // which is the fault that surfaces somewhere else entirely.
    const { engine } = await run([
      0x00,
      0xa0, // pushByte 160  (x)
      0x00,
      0x14, // pushByte 20   (y)
      0x7a, //       setCameraAt
      0x00,
      0x63,
      0x43,
      0xfa,
      0x00, // var250 = 99
      0x66,
    ]);
    // The proof that both operands were consumed: the write after it lands.
    expect(engine.variables[250]).toBe(99);
    expect(engine.camera.current).toBe(160);
  });

  it('puts the camera instructions at v6’s numbers, not at its neighbours’', async () => {
    // v6 and v7 are one encoding: 0x78 pans, 0x79 follows, 0x7a sets. These
    // were installed at 0x79, 0x7f and 0x7b, and 0x7b is `loadRoom` — so every
    // room change in a v7 game set a camera follow instead, silently.
    const { engine } = await run([0x00, 0x02, 0x7b]);
    expect(engine.currentRoom).toBe(2);
    expect(engine.camera.following).not.toBe(2);
  });

  it('follows an actor at 0x79, where v6 puts actorFollowCamera', async () => {
    const { engine } = await run([0x00, 0x03, 0x79]);
    expect(engine.camera.following).toBe(3);
  });

  it('counts its own opcode coverage through the shared table', async () => {
    const { engine } = await bootV7();
    const scripts = engine.scripts as ScriptEngineV7;
    expect(scripts.implementedOpcodes).toBeGreaterThan(0);
    expect(scripts.unimplementedOpcodes.length).toBeGreaterThan(0);
  });
});

describe('v7 message encoding', () => {
  it('measures a message the way the reader must', () => {
    const code = new Uint8Array([0x48, 0x69, 0x00]);
    expect(measureV7Message(code, 0)).toBe(3);
  });

  it('returns null for an unterminated message rather than guessing', () => {
    // A guess here hides a drifted program counter behind text that happens to
    // decode, which is worse than stopping.
    expect(measureV7Message(new Uint8Array([0x48, 0x69]), 0)).toBeNull();
  });

  it('reads a line as a language-bundle tag, not as the words', () => {
    // The v7 difference that matters most: the string in the code names an
    // entry in the language bundle. Rendering it raw shows a tag where
    // dialogue should be.
    expect(v7MessageKey('/BOOK067/Hello there.')).toBe('BOOK067');
    expect(v7MessageFallback('/BOOK067/Hello there.')).toBe('Hello there.');
  });

  it('treats a string with no key as a literal', () => {
    expect(v7MessageKey('Hello there.')).toBeNull();
    expect(v7MessageFallback('Hello there.')).toBe('Hello there.');
  });
});

/**
 * The instructions v6 and v7 read the same way.
 *
 * v6 and v7 are one encoding — ScummVM gives v7 no opcode table of its own and
 * expresses the difference as version branches inside shared handlers — so the
 * great majority of the set is one implementation in `StackScriptEngine`
 * (ADR 0006). These prove v7 reaches it, and that the handful v7 answers
 * differently replace the shared ones rather than sitting beside them.
 */
/** `parseString`'s sub-opcodes, at the numbers both versions use. */
const STRING_OP_AT = 65;
const STRING_OP_TEXT = 75;

/** A v7 game with one line of text in its bundle, for the talk instructions. */
async function runWithLanguage(code: number[]) {
  const fixture = buildV7Fixture({ script2: code });
  const source = new MemoryDataSource('v7');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  source.set('LANGUAGE.BND', new TextEncoder().encode('@TAG\n001/a line\n'));

  const engine = await ScummEngine.create(source);
  engine.boot(0);
  engine.scripts.runScript(2, false, false, []);
  return { engine };
}

describe('the surface v7 shares with v6', () => {
  it('changes rooms, which is the instruction a first screen needs', async () => {
    const { engine } = await run([0x00, 0x02, 0x7b]);
    expect(engine.currentRoom).toBe(2);
  });

  it('puts an actor somewhere, four operands and all', async () => {
    // The fourth is the room, and 0xFF means "wherever the actor already is".
    // Reading only three leaves the room on the stack for the next
    // instruction to consume as its own.
    const { engine } = await run([
      0x00,
      0x01, // actor 1
      0x00,
      0x64, // x 100
      0x00,
      0x32, // y 50
      0x00,
      0xff, // room: leave it
      0x7f, // putActorAtXY
    ]);

    const actor = engine.getActor(1)!;
    expect([actor.x, actor.y]).toEqual([100, 50]);
  });

  it('answers getState with v7’s operand list, not v6’s', async () => {
    // One of the handful v7 reads differently: the room is looked up rather
    // than pushed, so a v6-shaped read pops one operand too many and the next
    // instruction reads a value that belonged to this one.
    const { engine } = await run([
      0x00,
      0x01, // object 1
      0x63, // getState
      0x43,
      0xfa,
      0x00, // var250 = it
      0x00,
      0x63,
      0x43,
      0xfb,
      0x00, // var251 = 99, which only lands if the stack is level
    ]);

    expect(engine.variables[251]).toBe(99);
  });

  it('reaches every instruction v6 does, bar the sound it answers by report', async () => {
    // The honest measure of this change: v7's coverage is v6's, minus the
    // three sound instructions it names rather than serves. Before the shared
    // set was reachable it was in the thirties, which is why a real script
    // stopped whatever it did.
    const { engine, logs } = await run([0x00, 0x05, 0x76, 0x66]);
    expect(logs.some((line) => line.includes('startMusic'))).toBe(true);
    expect(engine.sound.unsupported.size).toBe(0);
  });

  it('starts a sound the index names, rather than reporting the number', async () => {
    // v7 hands the number to iMUSE Digital and the index's `ANAM` table says
    // which bundle cue it names. The fixture's table has three, so 1 is a real
    // cue and 5 is not — and only the second is worth a log line.
    const named = await run([0x00, 0x01, 0x74]);
    expect(named.logs.some((line) => line.includes('startSound'))).toBe(false);

    const unnamed = await run([0x00, 0x05, 0x74]);
    expect(unnamed.logs.some((line) => line.includes('no bundle cue'))).toBe(true);
  });

  it('sends soundKludge to iMUSE Digital, not to v6s MIDI decoder', async () => {
    // 0x1000 is `SetState`. v6 splits the first argument into a scope byte and
    // a command byte, which reads this as command 0 in scope 16 and reports it
    // unimplemented — which is what The Dig did for the whole of v7.
    const { engine, logs } = await run([
      0x01,
      0x00,
      0x10, // pushWord 0x1000, the command
      0x00,
      0x01, // pushByte 1, the state
      0x00,
      0x02, // pushByte 2, the argument count
      0xac, // soundKludge
    ]);

    expect(engine.sound.digital.musicState.state).toBe(1);
    expect(logs.some((line) => line.includes('scope'))).toBe(false);
  });

  it('stops a sound at 0x75, which it used to report as startMusic', async () => {
    // Reported as the *next* instruction's name while failing to do this one:
    // a v7 game could not stop a sound, and was told the wrong thing about it.
    const { logs } = await run([0x00, 0x01, 0x75]);
    expect(logs.some((line) => line.includes('startMusic'))).toBe(false);
  });

  it('does not make the camera follow the ego on entering a room', async () => {
    // v5 and v6 snap the camera and set a follow here; v7 does not — under v7
    // the camera is told who to follow by `actorFollowCamera` and nothing
    // else, so doing it here too overrides what the room's entry script had
    // just set.
    const { engine } = await run([
      0x00,
      0x01, // object 1
      0x00,
      0x01, // room 1
      0x00,
      0xff,
      0x00,
      0xff, // x, y: -1 means "do not walk"
      0x85, // loadRoomWithEgo
    ]);

    // The room changed, so the handler ran — and it left the camera follow
    // alone while doing it.
    expect(engine.currentRoom).toBe(1);
    expect(engine.camera.following).toBe(0);
  });

  it('stops resource hints at the global script boundary, as v7 does', async () => {
    // Above the boundary a number names a room script, which lives in the
    // room's own resource and is not something the index can be asked for.
    // v5 and v6 do reach for it, so this is a version branch, not a bounds
    // check — and reaching for it reports a missing resource every time.
    const asked: number[] = [];
    const above = 2500; // past v7's boundary of 2000
    const below = 12;

    for (const script of [above, below]) {
      const { engine } = await bootV7({
        script2: [
          0x01,
          script & 0xff,
          (script >> 8) & 0xff, // pushWord
          0x9b,
          0x64, // resourceRoutines.loadScript
        ],
      });
      engine.boot(0);
      // Recorded rather than inferred from the log: asking for a script that
      // is not there is silent, so a test reading the log passes whether the
      // guard is present or not.
      engine.ensureResource = (_kind, number) => asked.push(number);
      engine.scripts.runScript(2, false, false, []);
    }

    expect(asked).toEqual([below]);
  });

  it('covers most of the instruction set rather than a handful of it', async () => {
    const { engine } = await bootV7();
    const scripts = engine.scripts as ScriptEngineV7;
    // Not an exact figure — the point is the order of magnitude. Before the
    // shared set was reachable this was in the thirties, which is why a real
    // script stopped almost immediately whatever it did.
    expect(scripts.implementedOpcodes).toBeGreaterThan(150);
  });

  it('speaks a line, resolving the tag rather than showing it', async () => {
    // The talk and print family is shared and only the message reading is
    // v7's: an array assignment stores the tag itself, and a spoken line shows
    // what the tag means. Reading it the other way puts `/TAG.001/` on screen.
    const { engine } = await runWithLanguage([
      0x00,
      0x01, // actor 1
      0xba, // talkActor
      ...[...'/TAG.001/fallback'].map((c) => c.charCodeAt(0)),
      0,
    ]);

    expect(engine.currentText()).toBe('a line');
  });

  it('falls back to the words carried beside a tag that does not resolve', async () => {
    // Full Throttle's normal case: it ships no bundle at all, so every line is
    // the fallback written next to its tag.
    const { engine } = await run([
      0x00,
      0x01,
      0xba,
      ...[...'/NOPE.001/said anyway'].map((c) => c.charCodeAt(0)),
      0,
    ]);

    expect(engine.currentText()).toBe('said anyway');
  });

  it('prints a caption with no speaker, through the shared slots', async () => {
    const { engine } = await run([
      0x00,
      0x50, // x 80
      0x00,
      0x28, // y 40
      0xb4,
      STRING_OP_AT,
      0xb4,
      STRING_OP_TEXT,
      ...[...'plain'].map((c) => c.charCodeAt(0)),
      0,
    ]);

    expect(engine.currentText()).toBe('plain');
  });
});

/**
 * Where the two v7 games disagree with each other rather than with v6.
 *
 * Rare, and this is the only one the engine has to answer: rebuilding the box
 * matrix re-places the actors in The Dig and does not in Full Throttle. Read
 * from the game's identity, which this project already treats as load-bearing —
 * a save is refused when it belongs to a different title.
 */
describe('a v7 difference that belongs to one game', () => {
  async function bootNamed(stem: string, script: number[]) {
    const fixture = buildV7Fixture({ script2: script });
    const source = new MemoryDataSource('v7');
    source.set(`${stem}.LA0`, fixture.index);
    source.set(`${stem}.LA1`, fixture.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.startScene(1, null, 0);
    return engine;
  }

  it('re-places The Dig’s actors when the box matrix is rebuilt', async () => {
    const engine = await bootNamed('DIG', [0x9a]);
    expect(engine.replacesActorsOnRebuild).toBe(true);

    let replaced = 0;
    engine.putActorsOnValidBoxes = () => {
      replaced++;
    };
    engine.scripts.runScript(2, false, false, []);

    expect(replaced).toBe(1);
  });

  it('leaves Full Throttle’s alone, because it does not ask', async () => {
    // Guessing the other way moves actors out from under whatever a script had
    // just positioned.
    const engine = await bootNamed('FT', [0x9a]);
    expect(engine.replacesActorsOnRebuild).toBe(false);

    let replaced = 0;
    engine.putActorsOnValidBoxes = () => {
      replaced++;
    };
    engine.scripts.runScript(2, false, false, []);

    expect(replaced).toBe(0);
  });
});
