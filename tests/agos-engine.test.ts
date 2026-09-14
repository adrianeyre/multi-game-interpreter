import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import { identifyForeignEngine } from '../src/engine/resource/engineSignatures.js';
import { describeMismatchedSource } from '../src/editor/importOrigin.js';
import { buildArchive, buildGamePc, buildGamePcFor, buildGraphicsArchive } from './fixtureAgos.js';

function agosSource(): MemoryDataSource {
  const source = new MemoryDataSource('simon-fixture');
  source.set('GAMEPC', buildGamePc({ withSpeech: true }));
  source.set('SIMON.GME', buildArchive());
  source.set('SIMON.VOC', Uint8Array.of(0));
  return source;
}

describe('AGOS is no longer a foreign engine', () => {
  /**
   * The same structural change AGI made in #125 and SCI in #216: a family stops
   * being *foreign* when it gains an interpreter, so its data routes to the
   * engine rather than to a table of things this project does not implement.
   */
  it('routes AGOS data to the AGOS engine', async () => {
    const engine = await loadAdventureEngine(agosSource());

    expect(engine).toBeInstanceOf(AgosEngine);
    expect(engine.targetName).toBe('AGOS Simon1 (talkie)');
  });

  it('no longer names Simon in the foreign-engine table', () => {
    expect(identifyForeignEngine(['gamepc', 'simon.gme'])).toBeNull();
  });

  it('still names the engines this project does not implement', () => {
    // Lure used to be the example here and left the table when it gained an
    // engine of its own (ADR 0026, #263); Flight of the Amazon Queen is still
    // foreign and stands in for it.
    expect(identifyForeignEngine(['queen.1c'])?.engine).toBe('Queen');
  });
});

describe('what the AGOS engine tells a player', () => {
  it('says why there is no text, which is that the font is not in the game', async () => {
    const engine = await loadAdventureEngine(agosSource());
    engine.boot();

    expect(engine.describeStatus()).toContain('not implemented');
    // AGOS keeps its font in the interpreter executable, and the fixture folder
    // holds game data only. Saying so is the whole point (ADR 0032): a player
    // whose game shows no words needs to know it is not a rendering fault.
    const stall = engine.describeStall().join(' ');
    expect(stall).toContain('interpreter executable');
    expect(stall).toContain('collected rather than drawn');
  });

  it('reports the Version it identified and how', async () => {
    const engine = await loadAdventureEngine(agosSource());

    expect(engine.gameId).toBe('agos-simon1');
    expect(engine.describeStall()[0]).toContain('Simon1');
  });
});

describe('the engine hands the game to the editor', () => {
  it('produces a Project holding the item tree, the strings and the Subroutines', async () => {
    const engine = await loadAdventureEngine(agosSource());
    const editable = await engine.toEditableGame({ progress: undefined as never });

    expect(editable?.project.target).toMatchObject({ engine: 'agos', releaseKind: 'talkie' });
    expect(editable?.project.agos?.items).toHaveLength(2);
    expect(editable?.project.agos?.subroutines.subroutines).toHaveLength(2);
    // Per game rather than per resource, because GAMEPC has no index.
    expect(editable?.project.agos?.editable.unrecovered).toBe(0);
  });

  it('asks whether editing is refused before doing the work, not after', async () => {
    const engine = await loadAdventureEngine(agosSource());

    expect(engine.describeEditRefusal()).toBeNull();
  });
});

describe('saving through the shell seam', () => {
  it('round-trips a game through saveState and loadState', async () => {
    const engine = await loadAdventureEngine(agosSource());
    engine.boot();
    const saved = engine.saveState('a save');

    expect(saved.gameId).toBe('agos-simon1');
    expect(() => engine.loadState(saved)).not.toThrow();
  });

  /**
   * A load's second half. The reference restores the world and then, for Simon
   * 1 and 2, sets bit 97 and runs subroutine 100 to re-enter the saved room
   * (`saveload.cpp:161-165`); without it the script that was running when the
   * load happened — at boot, the opening — keeps going and walks the player out
   * of the restored room (a save in room 53 ran on to room 171).
   *
   * The fixture GAMEPC carries no subroutine 100, so the room-re-entry task
   * cannot begin here — {@link AgosInterpreter.begin} returns null and the
   * interrupted opening is simply dropped. What is observable, and what this
   * pins, is the flag the reference sets alongside it: strip that half of the
   * load tail out and this fails.
   */
  it('arms the restore redraw so the saved room re-enters', async () => {
    const engine = await loadAdventureEngine(agosSource());
    engine.boot();
    const saved = engine.saveState('in a room');

    engine.loadState(saved);

    const inside = engine as unknown as {
      state: { bits: Set<number> };
      task: { reason: string } | null;
    };
    expect(inside.state.bits.has(97)).toBe(true);
    // The opening was running when the load arrived; it is not left running.
    expect(inside.task?.reason).not.toBe('the opening');
  });
});

describe('drawing reaches the screen', () => {
  /**
   * The whole path, end to end: a zone's two archive entries, the table of
   * image entries in the first, the VGA script one of them points at, and the
   * pixels the script places. ADR 0027's amendment in one test.
   */
  async function engineWithGraphics() {
    const source = new MemoryDataSource('simon-graphics');
    source.set('GAMEPC', buildGamePc({ withSpeech: true }));
    source.set('SIMON.GME', buildGraphicsArchive());
    source.set('SIMON.VOC', Uint8Array.of(0));
    return (await loadAdventureEngine(source)) as AgosEngine;
  }

  it('loads a zone from the archive by arithmetic rather than by lookup', async () => {
    const engine = await engineWithGraphics();

    expect(engine.loadZone(0)).toBe(true);
    // Zone 9 is not in this archive, and that is a normal answer rather than an
    // error: a game asks for zones it has not shipped.
    expect(engine.loadZone(9)).toBe(false);
  });

  it('runs the script an image entry names, and pixels land on the screen', async () => {
    const engine = await engineWithGraphics();

    expect(engine.drawImage(0, 1)).toBe(true);

    // Drawn at (1,1), and a draw's x is in eights of pixels: one row down and
    // eight columns across.
    const at = engine.screen.width * 1 + 8;
    expect(engine.screen.pixels[at]).toBe(1);
    expect(engine.screen.pixels[at + 1]).toBe(2);
  });

  it('says how much of the graphics language it could not run', async () => {
    const engine = await engineWithGraphics();
    engine.drawImage(0, 1);

    expect(engine.describeStatus()).toContain('zone(s) running');
  });
});

describe('exporting against a re-supplied folder', () => {
  /**
   * ADR 0010: above the size threshold the originals are not kept in the
   * browser and export becomes original-plus-diff. A talkie is comfortably
   * above it, so this is AGOS's normal path rather than its exception — and the
   * Project has to carry enough about where it came from to refuse the wrong
   * folder by name rather than writing edits into resources they do not belong
   * to.
   */
  it('records what the game was imported from', async () => {
    const engine = await loadAdventureEngine(agosSource());
    const editable = await engine.toEditableGame({ progress: undefined as never });

    expect(editable?.project.origin).toMatchObject({
      indexFile: 'GAMEPC',
      dataFile: 'SIMON.GME',
    });
    expect(editable?.project.origin?.indexBytes).toBeGreaterThan(0);
  });

  it('refuses a folder holding a different release of the same game', async () => {
    const engine = await loadAdventureEngine(agosSource());
    const editable = await engine.toEditableGame({ progress: undefined as never });
    const origin = editable!.project.origin!;

    // Same names, different sizes: a different release, whose resources are at
    // different offsets.
    expect(
      describeMismatchedSource(origin, {
        indexFile: 'GAMEPC',
        dataFile: 'SIMON.GME',
        indexBytes: origin.indexBytes + 1,
        dataBytes: origin.dataBytes,
      }),
    ).toMatch(/not the same size/);

    expect(
      describeMismatchedSource(origin, {
        indexFile: 'GAMEPC',
        dataFile: 'SIMON.GME',
        indexBytes: origin.indexBytes,
        dataBytes: origin.dataBytes,
      }),
    ).toBeNull();
  });
});

describe('AGOS 2 draws at its own size', () => {
  /**
   * The one place in this engine where a Version changes something the shell
   * can see. Scripts and display agree in both, so AGOS is SCUMM's and AGI's
   * degenerate case rather than SCI32's split.
   */
  async function engineFor(version: 'Simon1' | 'Feeble') {
    const target = {
      family: 'AGOS' as const,
      version,
      releaseKind: 'talkie' as const,
      platform: 'dos' as const,
    };
    const source = new MemoryDataSource(`agos-${version}`);
    source.set(version === 'Feeble' ? 'GAME22' : 'GAMEPC', buildGamePcFor(target));
    if (version === 'Simon1') source.set('SIMON.GME', buildGraphicsArchive());
    source.set('SIMON.VOC', Uint8Array.of(0));
    return (await loadAdventureEngine(source)) as AgosEngine;
  }

  it('gives Simon 1 a 320x200 screen', async () => {
    const engine = await engineFor('Simon1');

    expect(engine.resolution.display).toEqual({ width: 320, height: 200 });
    expect(engine.screen.width).toBe(320);
  });

  it('gives The Feeble Files a 640x480 one', async () => {
    const engine = await engineFor('Feeble');

    expect(engine.resolution.display).toEqual({ width: 640, height: 480 });
    expect(engine.screen.height).toBe(480);
    // Scripts and display agree, which is what makes this the degenerate case.
    expect(engine.resolution.script).toEqual(engine.resolution.display);
  });
});
