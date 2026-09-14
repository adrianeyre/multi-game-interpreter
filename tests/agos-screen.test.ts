import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import { AgosBytes, buildArchive, buildGamePcFor } from './fixtureAgos.js';
import { buildSmacker } from './fixtureSmacker.js';

/**
 * The two things a player sees, driven through the whole Engine rather than
 * through the pieces: the words a game says, and the video it plays.
 *
 * Both are Tier 1 against a synthetic fixture
 * (`docs/processes/verifying-version-support.md`). What is proved here is that
 * a game asking reaches a screen — not that a real release looks right, which
 * needs the discs.
 */

/** Lets the asynchronous file read behind a video finish. */
const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

const FEEBLE: AgosTarget = {
  family: 'AGOS',
  version: 'Feeble',
  releaseKind: 'floppy',
  platform: 'dos',
};

/**
 * An interpreter executable with an 8x8 font in it.
 *
 * The font is built rather than transcribed, which is ADR 0032's whole point:
 * this project reads formats and the glyphs are content. What the fixture
 * reproduces is the shape a real table has, not any release's letters.
 */
function buildInterpreter(): Uint8Array {
  const rows = [0x7c, 0x42, 0x5a, 0x66, 0x3c, 0x24, 0x18, 0x7e];
  const bytes = new Uint8Array(2048 + 96 * 8);
  for (let index = 0; index < 2048; index += 1) bytes[index] = (index * 37 + 11) & 0xff;
  for (let index = 0; index < 96; index += 1) {
    const character = 32 + index;
    if (character === 32) continue;
    for (let row = 0; row < 7; row += 1) {
      bytes[2048 + index * 8 + row] = rows[(character + row) % rows.length]!;
    }
  }
  return bytes;
}

/** A Simon 1 game whose Subroutine 1 says one of its own strings. */
function simonSaying(): MemoryDataSource {
  const source = new MemoryDataSource('simon-says');
  source.set(
    'GAMEPC',
    // Opcode 64 is `o_msg` in Simon 1's table, and its `T` operand is a lead
    // word that is not 0 or 3 followed by a 32-bit string id.
    buildGamePcFor(SIMON1, {
      body: (out: AgosBytes) => out.byte(64).word(1).long(0),
    }),
  );
  source.set('SIMON.GME', buildArchive());
  source.set('SIMON.VOC', Uint8Array.of(0));
  return source;
}

/** Whether anything at all was drawn. */
function hasInk(pixels: Uint8Array): boolean {
  return pixels.some((pixel) => pixel !== 0);
}

describe('text a game asks to show, reaching an AGOS screen', () => {
  it('draws the words when an interpreter executable is beside the game', async () => {
    const source = simonSaying();
    source.set('SIMON.EXE', buildInterpreter());

    const engine = await AgosEngine.create(source);
    // Boot *starts* the opening Subroutine; a frame runs it. An AGOS script
    // blocks, so nothing executes until something spends a frame on it.
    engine.boot();
    engine.step();
    engine.render();

    expect(hasInk(engine.screen.pixels)).toBe(true);
    expect(engine.describeStall().join(' ')).toContain('glyphs read from an interpreter');
  });

  it('draws nothing and says why when there is no interpreter beside it', async () => {
    const engine = await AgosEngine.create(simonSaying());
    engine.boot();
    engine.step();
    engine.render();

    // The honest outcome rather than a degraded one: AGOS keeps its font in the
    // interpreter, and a row of boxes would turn that fact into something that
    // looks like a rendering fault (ADR 0032).
    expect(hasInk(engine.screen.pixels)).toBe(false);
    expect(engine.describeStatus()).toContain('none was found beside this game');
  });

  it('says at load that the font came out of an executable, and from where', async () => {
    const source = simonSaying();
    source.set('SIMON.EXE', buildInterpreter());
    const said: string[] = [];

    await AgosEngine.create(source, { onLog: (message) => said.push(message) });

    expect(said.join(' ')).toContain('Font read from SIMON.EXE at offset 2048');
  });
});

describe('video an AGOS 2 game asks for, played by the Engine', () => {
  /** A Feeble game whose Subroutine 1 names a video and plays it. */
  function feeblePlaying(): MemoryDataSource {
    const source = new MemoryDataSource('feeble-video');
    source.set(
      'GAME22',
      // 182 is `off_loadVideo`, whose `T` operand names a string; 183 is
      // `off_playVideo`, which takes nothing. Two opcodes rather than one
      // because that is what the games do.
      buildGamePcFor(FEEBLE, {
        body: (out: AgosBytes) => out.byte(182).word(1).long(0).byte(183),
      }),
    );
    return source;
  }

  const film = (): Uint8Array =>
    buildSmacker({
      width: 8,
      height: 8,
      frames: [
        {
          blocks: [
            { kind: 'fill', colour: 7 },
            { kind: 'fill', colour: 6 },
            { kind: 'fill', colour: 5 },
            { kind: 'fill', colour: 4 },
          ],
        },
      ],
    });

  it('stops the world and puts the video on the screen', async () => {
    const source = feeblePlaying();
    source.set('lamp.smk', film());

    const engine = await AgosEngine.create(source);
    engine.boot();
    engine.step();
    await settle();

    expect(engine.describeStall().join(' ')).toContain('the world is stopped');
    engine.render();
    // 640x480 with an 8x8 video centred in it: the picture starts at (316, 236)
    // and the screen around it stays as it was, because a video smaller than
    // the screen is one the game meant to sit in a window.
    expect(engine.screen.pixels[236 * 640 + 316]).toBe(7);
    expect(engine.screen.pixels[240 * 640 + 316]).toBe(5);
    expect(engine.screen.pixels[0]).toBe(0);
  });

  it('says what it has when the folder holds ScummVM’s re-encode instead', async () => {
    const source = feeblePlaying();
    source.set('lamp.dxa', Uint8Array.from([0x44, 0x45, 0x58, 0x41, 0, 0, 0, 0]));
    const said: string[] = [];

    const engine = await AgosEngine.create(source, { onLog: (message) => said.push(message) });
    engine.boot();
    engine.step();
    await settle();

    // ADR 0024's rule, arriving as something a player reads: a folder of DXA
    // files is a complete ScummVM install and the person who put it there has
    // done nothing wrong, so the message names the format rather than a fault.
    expect(said.join(' ')).toContain('DXA');
    expect(engine.describeStall().join(' ')).toContain('video: none playing');
  });

  it('carries on when the video is not beside the game at all', async () => {
    const said: string[] = [];

    const engine = await AgosEngine.create(feeblePlaying(), {
      onLog: (message) => said.push(message),
    });
    engine.boot();
    engine.step();
    await settle();

    expect(said.join(' ')).toContain('is not beside the game');
    engine.step();
    // Two frames, not one: the first ran the opening Subroutine that asked for
    // the video, and this is the one after it.
    expect(engine.frame).toBe(2);
  });

  it('runs the world again once the video has ended', async () => {
    const source = feeblePlaying();
    source.set('lamp.smk', film());

    const engine = await AgosEngine.create(source);
    engine.boot();
    engine.step();
    await settle();

    for (let step = 0; step < 60; step += 1) {
      engine.step();
      engine.render();
    }

    expect(engine.describeStall().join(' ')).toContain('video: none playing');
  });
});
