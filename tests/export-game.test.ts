import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { decryptCopy } from '../src/engine/resource/xor.js';
import { exportEditedGame, rewriteGame } from '../src/authoring/exportGame.js';
import { importGame } from '../src/authoring/importGame.js';
import { assembleV6, disassembleV6 } from '../src/authoring/disassembleV6.js';
import { buildV6Fixture, V6_SCRIPT_RESULT } from './fixtureV6.js';
import { XOR_KEY } from './fixture.js';

/**
 * Writing an edited game back out.
 *
 * Not the compiler: that builds a game from a project's intent and emits v5
 * bytecode. This starts from a game that already exists and changes part of it,
 * which is what editing an imported game means — everything untouched has to
 * come out exactly as it went in, including the parts no importer understands.
 */
function encrypt(bytes: Uint8Array): Uint8Array {
  return decryptCopy(bytes, XOR_KEY);
}

async function loadFrom(index: Uint8Array, data: Uint8Array) {
  const source = new MemoryDataSource('rewritten');
  source.set('TENTACLE.000', encrypt(index));
  source.set('TENTACLE.001', encrypt(data));

  const game = await detectGame(source);
  return { source, resources: await ResourceManager.load(source, game) };
}

/** The fixture, decrypted, as the rewriter takes it. */
function plainFixture() {
  const fixture = buildV6Fixture();
  return {
    index: decryptCopy(fixture.index, XOR_KEY),
    data: decryptCopy(fixture.data, XOR_KEY),
  };
}

describe('rewriting a game with nothing changed', () => {
  it('produces a game that still loads', async () => {
    const { index, data } = plainFixture();
    const rewritten = rewriteGame(index, data, []);
    const { resources } = await loadFrom(rewritten.index, rewritten.data);

    expect(resources.roomCount).toBe(1);
    expect(resources.getScript(1)).not.toBeNull();
    expect(resources.getCostume(1)).not.toBeNull();
  });

  it('keeps every resource byte-identical', async () => {
    const { index, data } = plainFixture();
    const before = await loadFrom(index, data);
    const rewritten = rewriteGame(index, data, []);
    const after = await loadFrom(rewritten.index, rewritten.data);

    for (const id of [1, 2]) {
      expect(Array.from(after.resources.getScript(id)!)).toEqual(
        Array.from(before.resources.getScript(id)!),
      );
    }
    expect(Array.from(after.resources.getCostume(1)!)).toEqual(
      Array.from(before.resources.getCostume(1)!),
    );
  });
});

describe('replacing a script', () => {
  /**
   * The end-to-end claim of instruction editing (ADR 0005): decode a script,
   * change one instruction, write the game back, and the game *plays the
   * change*. Everything between those two points — offsets shifting, the
   * directories following them — is what this exercises.
   */
  async function withEditedScript(edit: (bytes: Uint8Array) => Uint8Array) {
    const { index, data } = plainFixture();
    const before = await loadFrom(index, data);

    // Script 2 is a chunk in room 1's block; find where it sits.
    const original = before.resources.getScript(2)!;
    const room = 1;
    const offset = findScriptOffset(data, original);

    const rewritten = rewriteGame(index, data, [{ room, offset, chunk: edit(original) }]);

    const source = new MemoryDataSource('edited');
    source.set('TENTACLE.000', encrypt(rewritten.index));
    source.set('TENTACLE.001', encrypt(rewritten.data));
    return ScummEngine.create(source);
  }

  it('plays the edited instruction', async () => {
    const engine = await withEditedScript((script) => {
      // The script body past the SCRP header: change `pushByte 7` to push 9.
      const listing = disassembleV6(script.subarray(8));
      listing.instructions[0] = { ...listing.instructions[0], streamOperand: 9 };
      const body = assembleV6(listing, script.subarray(8));

      const out = new Uint8Array(8 + body.length);
      out.set(script.subarray(0, 8));
      out.set(body, 8);
      // The chunk header carries its own size, which must follow the body.
      const size = out.length;
      out[4] = (size >> 24) & 0xff;
      out[5] = (size >> 16) & 0xff;
      out[6] = (size >> 8) & 0xff;
      out[7] = size & 0xff;
      return out;
    });

    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    // The fixture script sets var250 from the pushed value and var251 to twice
    // it. Editing the push changes both.
    expect(engine.variables[250]).toBe(9);
    expect(engine.variables[251]).toBe(18);
  });

  it('leaves the other scripts alone', async () => {
    const engine = await withEditedScript((script) => script);
    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    expect(engine.variables[250]).toBe(V6_SCRIPT_RESULT.var250);
  });

  it('follows a script that changed length, moving everything after it', async () => {
    /**
     * The case the directories exist for. A longer script pushes every resource
     * after it down its block, so an export that did not rewrite the offsets
     * would load the costume from the middle of the script.
     */
    const engine = await withEditedScript((script) => {
      const body = [...script.subarray(8)];
      // Two extra no-op instructions before the rest.
      body.unshift(0xbd, 0xbd);

      const out = new Uint8Array(8 + body.length);
      out.set(script.subarray(0, 8));
      out.set(body, 8);
      const size = out.length;
      out[4] = (size >> 24) & 0xff;
      out[5] = (size >> 16) & 0xff;
      out[6] = (size >> 8) & 0xff;
      out[7] = size & 0xff;
      return out;
    });

    engine.boot(0);
    engine.scripts.runScript(2, false, false, []);

    expect(engine.variables[250]).toBe(V6_SCRIPT_RESULT.var250);
    // The costume still resolves, which it would not if its directory entry
    // still pointed at where it used to be.
    expect(engine.resources.getCostume(1)).not.toBeNull();
  });
});

/** Where a resource's chunk sits within its disk block. */
function findScriptOffset(data: Uint8Array, script: Uint8Array): number {
  for (let at = 0; at < data.length - script.length; at++) {
    let same = true;
    for (let i = 0; i < 16 && same; i++) same = data[at + i] === script[i];
    if (!same) continue;

    // Offsets are counted from the LFLF header, which is the block this
    // resource is inside.
    for (let back = at; back >= 8; back--) {
      if (
        data[back] === 0x4c &&
        data[back + 1] === 0x46 &&
        data[back + 2] === 0x4c &&
        data[back + 3] === 0x46
      ) {
        return at - back;
      }
    }
  }
  throw new Error('script not found in the data file');
}

describe('writing an edited project back over its game', () => {
  /**
   * The end of the round trip. The project supplies changed scripts and nothing
   * else: art, geometry, sound and every resource no importer understands come
   * from the original files untouched, because a project is not a complete
   * description of the game and never claimed to be.
   */
  async function importedProject() {
    const { index, data } = plainFixture();
    const { resources } = await loadFrom(index, data);
    return { index, data, project: importGame(resources).project };
  }

  it('records where each imported script came from', async () => {
    const { project } = await importedProject();
    const [action] = project.rooms[0].onEnter;

    expect(action.type).toBe('raw');
    expect(action.type === 'raw' && action.origin).toMatchObject({ room: 1, prefix: 0 });
  });

  it('puts an edited room script back into the game', async () => {
    const { index, data, project } = await importedProject();
    const action = project.rooms[0].onEnter[0];
    if (action.type !== 'raw' || !action.origin) throw new Error('no imported script');

    // The fixture's entry script is a bare stop. Replace it with one that sets
    // a variable, so running the room proves the edit reached the game.
    const code = new Uint8Array([0x00, 0x2a, 0x43, 0xb0, 0x01, 0x66]);

    const rewritten = exportEditedGame(index, data, [{ ...action.origin, code }]);

    const source = new MemoryDataSource('edited');
    source.set('TENTACLE.000', encrypt(rewritten.index));
    source.set('TENTACLE.001', encrypt(rewritten.data));

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.startScene(1, null, 0);

    expect(engine.variables[432]).toBe(42);
  });

  it('leaves everything the project does not describe exactly as it was', async () => {
    const { index, data, project } = await importedProject();
    const action = project.rooms[0].onEnter[0];
    if (action.type !== 'raw' || !action.origin) throw new Error('no imported script');

    const before = await loadFrom(index, data);
    const rewritten = exportEditedGame(index, data, [
      { ...action.origin, code: new Uint8Array([0x00, 0x01, 0x43, 0xb0, 0x01, 0x66]) },
    ]);
    const after = await loadFrom(rewritten.index, rewritten.data);

    // The costume is a resource nothing in the project can describe, and it
    // follows the edited room's block. It must come back byte for byte.
    expect(Array.from(after.resources.getCostume(1)!)).toEqual(
      Array.from(before.resources.getCostume(1)!),
    );
    expect(Array.from(after.resources.getScript(2)!)).toEqual(
      Array.from(before.resources.getScript(2)!),
    );
  });

  it('changes nothing when no script was edited', async () => {
    const { index, data } = await importedProject();
    const rewritten = exportEditedGame(index, data, []);
    const after = await loadFrom(rewritten.index, rewritten.data);

    expect(after.resources.getCostume(1)).not.toBeNull();
    expect(after.resources.roomCount).toBe(1);
  });
});

describe('collecting the scripts an author changed', () => {
  /**
   * Only scripts the importer read out of this game can be written back. An
   * action authored in the editor has no origin and compiles to v5 bytecode;
   * putting that inside a v6 game would produce something no interpreter can
   * run, which is what the compile path refuses at the other door.
   */
  it('exports an imported script and skips an authored one', async () => {
    const { index, data } = plainFixture();
    const { resources } = await loadFrom(index, data);
    const { project } = importGame(resources);

    project.rooms[0].onExit = [
      { type: 'say', actor: 'ego', text: 'written in the editor' },
      ...project.rooms[0].onExit,
    ];

    const edits = [project.rooms[0].onEnter, project.rooms[0].onExit]
      .flat()
      .filter((action) => action.type === 'raw' && action.origin);

    expect(edits.length).toBeGreaterThan(0);
    // The authored `say` contributes nothing to the export.
    expect(edits.every((action) => action.type === 'raw' && action.origin)).toBe(true);
  });
});
