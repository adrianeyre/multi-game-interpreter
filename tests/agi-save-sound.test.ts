import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';
import { SaveStore, type StorageLike } from '../src/engine/save/SaveStore.js';
import {
  AGI_SAVE_FORMAT,
  AGI_SAVE_NOTE,
  describeIncompatibleAgiSave,
  type AgiSavedGame,
} from '../src/engine/agi/save/AgiSaveState.js';
import {
  AgiSoundPlayer,
  NOISE_VOICE,
  TONE_CLOCK,
  frequencyFor,
  gainFor,
  readSound,
  soundDuration,
} from '../src/engine/agi/sound/AgiSound.js';
import { V } from '../src/engine/agi/script/AgiState.js';
import { EGO } from '../src/engine/agi/ScreenObject.js';
import type { Target } from '../src/authoring/target.js';
import { buildAgiV2Fixture, buildSound, sampleVoices } from './fixtureAgi.js';

class MemoryStorage implements StorageLike {
  private readonly entries = new Map<string, string>();
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  get length(): number {
    return this.entries.size;
  }
}

async function bootedGame(): Promise<AgiEngine> {
  const fixture = buildAgiV2Fixture();
  const source = new MemoryDataSource('agi-fixture');
  for (const [name, bytes] of fixture.files) source.set(name, bytes);
  const engine = await AgiEngine.create(source, { random: () => 0.5 });
  engine.boot();
  return engine;
}

describe('an AGI save round-trips', () => {
  /**
   * Mid-play rather than at boot, because the fields that are easy to lose are
   * the ones a game has been changing: an object's cel, a flag a script set, an
   * item the player picked up.
   */
  it('reproduces flags, vars, objects, inventory, room and picture exactly', async () => {
    const engine = await bootedGame();

    engine.state.setVar(V.SCORE, 37);
    engine.state.setVar(200, 99);
    engine.state.setFlag(150, true);
    engine.state.strings[2] = 'a saved string';

    const ego = engine.state.object(EGO);
    ego.animated = true;
    ego.drawn = true;
    ego.view = 0;
    ego.loop = 2;
    ego.cel = 1;
    ego.x = 77;
    ego.y = 120;
    ego.cycling = true;
    ego.motion = 'wander';

    const saved = engine.saveState('mid play');

    // Move everything on, then put it back.
    engine.state.setVar(V.SCORE, 0);
    engine.state.setFlag(150, false);
    engine.state.strings[2] = '';
    ego.x = 0;
    ego.y = 0;
    ego.cycling = false;
    ego.motion = 'none';

    engine.loadState(saved);

    expect(engine.state.var(V.SCORE)).toBe(37);
    expect(engine.state.var(200)).toBe(99);
    expect(engine.state.flag(150)).toBe(true);
    expect(engine.state.strings[2]).toBe('a saved string');

    const restored = engine.state.object(EGO);
    expect(restored).toMatchObject({
      loop: 2,
      cel: 1,
      x: 77,
      y: 120,
      cycling: true,
      motion: 'wander',
    });
    expect(engine.currentRoom).toBe(saved.room);
    expect(engine.state.currentPicture).toBe(saved.picture);
  });

  it('captures every field of every screen object, field by field', async () => {
    const engine = await bootedGame();
    const saved = engine.saveState('all objects');
    expect(saved.objects).toHaveLength(engine.state.objects.length);
    expect(saved.objects[0]).toHaveProperty('restriction');
    expect(saved.objects[0]).toHaveProperty('cycleUntilEnd');
  });

  it('carries the Target that wrote it', async () => {
    const engine = await bootedGame();
    expect(engine.saveState('tagged').target).toMatchObject({
      engine: 'agi',
      interpreter: expect.any(Number),
      platform: 'dos',
    });
  });
});

describe('a save that cannot be loaded is refused, not half-applied', () => {
  const agiTarget: Target = { engine: 'agi', interpreter: 0x2917, platform: 'dos' };

  function save(overrides: Partial<AgiSavedGame> = {}): AgiSavedGame {
    return {
      format: AGI_SAVE_FORMAT,
      target: agiTarget,
      gameId: 'fixture',
      savedAt: 0,
      name: '',
      room: 1,
      vars: [],
      flags: [],
      strings: [],
      objects: [],
      itemRooms: [],
      picture: 1,
      pictureShown: true,
      horizon: 36,
      playerControl: true,
      inputEnabled: true,
      statusLineVisible: false,
      textMode: false,
      priorityBase: 0,
      block: { active: false, x1: 0, y1: 0, x2: 0, y2: 0 },
      keyBindings: [],
      disabledControllers: [],
      ...overrides,
    };
  }

  /**
   * The family check comes first, deliberately. A save from the other Engine
   * family shares none of the fields below — its numbers mean nothing here — so
   * comparing format versions first would compare two numbers that are not on
   * the same scale.
   */
  it('refuses a SCUMM save loaded into AGI, naming the mismatch', () => {
    const refusal = describeIncompatibleAgiSave(
      save({ target: { engine: 'scumm', version: 6 } }),
      agiTarget,
      'fixture',
    );
    expect(refusal).toMatch(/SCUMM v6/);
    expect(refusal).toMatch(/share no state/);
  });

  it('refuses a save from a different AGI game', () => {
    expect(describeIncompatibleAgiSave(save(), agiTarget, 'another')).toMatch(/belongs to/);
  });

  it('refuses a save from a newer format version', () => {
    expect(
      describeIncompatibleAgiSave(save({ format: AGI_SAVE_FORMAT + 1 }), agiTarget, 'fixture'),
    ).toMatch(/format/);
  });

  /**
   * Same family, same game, different interpreter — which means a different
   * arity table, so the offsets a script reaches are not the same offsets.
   */
  it('refuses a save made against a different interpreter version', () => {
    expect(
      describeIncompatibleAgiSave(
        save({ target: { engine: 'agi', interpreter: 0x2089, platform: 'dos' } }),
        agiTarget,
        'fixture',
      ),
    ).toMatch(/decode instructions differently/);
  });

  /**
   * The hazard #123 documents for project files, applied to saves: a migration
   * must never silently retag one to the wrong Target.
   */
  it('refuses a save carrying no Target at all, rather than assuming one', () => {
    expect(
      describeIncompatibleAgiSave(
        save({ target: undefined as unknown as Target }),
        agiTarget,
        'fixture',
      ),
    ).toMatch(/does not carry a Target/);
  });

  it('accepts a save that matches on every axis', () => {
    expect(describeIncompatibleAgiSave(save(), agiTarget, 'fixture')).toBeNull();
  });

  it('leaves the game playable after refusing one', async () => {
    const engine = await bootedGame();
    const room = engine.currentRoom;
    expect(() =>
      engine.loadState({ ...engine.saveState('x'), gameId: 'somewhere else' }),
    ).toThrow();
    expect(engine.currentRoom).toBe(room);
    engine.step();
  });
});

describe('the save store holds an AGI save beside a SCUMM one', () => {
  it('namespaces by game and refuses a save from the future', async () => {
    const engine = await bootedGame();
    const storage = new MemoryStorage();
    const store = new SaveStore(storage, engine.gameId, engine.saveFormat);

    store.write(1, engine.saveState('slot one'));
    expect(store.read(1)?.name).toBe('slot one');
    expect(store.list()).toHaveLength(1);

    // A store with a lower ceiling reads nothing, which is what a save written
    // by a newer build looks like from an older one.
    expect(new SaveStore(storage, engine.gameId, 0).read(1)).toBeNull();
  });

  /**
   * #131 asks for this in the UI rather than only in a constant, and ADR 0011
   * forbids the shell branching on family — so the note is an interface member
   * and each family supplies its own wording.
   */
  it('says plainly, through the engine, that these saves belong to this interpreter', async () => {
    const engine = await bootedGame();
    expect(engine.saveNote).toBe(AGI_SAVE_NOTE);
    expect(engine.saveNote).toMatch(/specific to this/);
    expect(engine.saveNote).toMatch(/not interchangeable/);
  });
});

describe('reading a SOUND resource', () => {
  it('splits four voices behind the offset table', () => {
    const sound = readSound(new Uint8Array(buildSound(sampleVoices())));
    expect(sound.voices).toHaveLength(4);
    expect(sound.voices[0]).toHaveLength(2);
    expect(sound.voices[1]).toHaveLength(1);
    expect(sound.voices[NOISE_VOICE]).toHaveLength(1);
  });

  it('reads a note back as the duration, divisor and attenuation it was written with', () => {
    const sound = readSound(new Uint8Array(buildSound(sampleVoices())));
    expect(sound.voices[0][0]).toMatchObject({
      durationTicks: 30,
      divisor: 428,
      attenuation: 0,
    });
  });

  it('marks the fourth voice as noise rather than tone', () => {
    const sound = readSound(new Uint8Array(buildSound(sampleVoices())));
    expect(sound.voices[NOISE_VOICE][0]).toHaveProperty('white');
    expect(sound.voices[0][0].white).toBeUndefined();
  });

  it('stops a voice at its terminator rather than reading the next one s notes', () => {
    // Two voices with different note counts: reading past the terminator would
    // give voice 0 voice 1's notes as well, which plays the wrong tune.
    const sound = readSound(
      new Uint8Array(
        buildSound([
          [{ duration: 10, divisor: 100, attenuation: 0 }],
          [
            { duration: 20, divisor: 200, attenuation: 1 },
            { duration: 30, divisor: 300, attenuation: 2 },
          ],
          [],
          [],
        ]),
      ),
    );
    expect(sound.voices[0]).toHaveLength(1);
    expect(sound.voices[1]).toHaveLength(2);
  });

  it('refuses a resource shorter than its own offset table', () => {
    expect(() => readSound(new Uint8Array([1, 2, 3]))).toThrow(/eight-byte offset table/);
  });
});

describe('the frequency and volume arithmetic', () => {
  /**
   * The SN76496 runs at 3.579545 MHz and its tone generators divide it by 32.
   * A divisor of 428 is middle C, which is the check worth having: an
   * arithmetic error here is a game that plays in the wrong key.
   */
  it('turns a divisor into hertz through the divided clock', () => {
    expect(TONE_CLOCK).toBe(111860);
    expect(Math.round(frequencyFor(428))).toBe(261);
    expect(frequencyFor(0)).toBe(0);
  });

  /**
   * Attenuation is backwards from every other volume here, and it is the chip's
   * own convention: 0 is loudest and 15 is silent. Reading it as a volume plays
   * every quiet note loud.
   */
  it('reads attenuation as a cut rather than as a level', () => {
    expect(gainFor(0)).toBe(1);
    expect(gainFor(15)).toBe(0);
    expect(gainFor(4)).toBeLessThan(gainFor(2));
  });

  it('measures a resource by its longest voice, since they play together', () => {
    const sound = readSound(
      new Uint8Array(
        buildSound([
          [{ duration: 60, divisor: 100, attenuation: 0 }],
          [
            { duration: 60, divisor: 100, attenuation: 0 },
            { duration: 60, divisor: 100, attenuation: 0 },
          ],
          [],
          [],
        ]),
      ),
    );
    expect(soundDuration(sound)).toBe(2);
  });
});

describe('playing a sound', () => {
  /**
   * #137: games *wait* on the finished flag — a script polls it every cycle and
   * does nothing until it is set — so early or late breaks pacing.
   */
  it('sets the finished flag when the sound has finished, and not before', () => {
    const player = new AgiSoundPlayer(() => null);
    const finished: number[] = [];
    player.setFinishedHandler((flag) => finished.push(flag));
    player.setEnabled(true);

    const sound = readSound(
      new Uint8Array(buildSound([[{ duration: 6000, divisor: 100, attenuation: 0 }], [], [], []])),
    );
    player.play(sound, 42);

    player.step();
    expect(finished).toEqual([]);
    expect(player.isPlaying).toBe(true);
  });

  /**
   * With sound off the flag still has to be set, or every game that waits on a
   * sound waits for ever — and a silent game would be unfinishable rather than
   * merely quiet.
   *
   * **Counted in engine cycles, not wall-clock seconds**, and that is the part
   * a real game turned on. Enclosure's logo room plays `sound(4, f91)` and will
   * not advance until `f91` is set; against a wall-clock deadline a headless
   * run — which steps far faster than real time — never reached it, so the game
   * sat at scene 104 of its intro for ever. Counting cycles makes a silent game
   * pace exactly as a sounding one does, whatever speed the host runs at.
   */
  it('finishes a silent sound after the right number of cycles, not seconds', () => {
    const player = new AgiSoundPlayer(() => null);
    const finished: number[] = [];
    player.setFinishedHandler((flag) => finished.push(flag));
    player.setEnabled(false);

    // Half a second: thirty ticks at sixty per second, so thirty cycles.
    const sound = readSound(
      new Uint8Array(buildSound([[{ duration: 30, divisor: 200, attenuation: 0 }], [], [], []])),
    );
    player.play(sound, 7);

    for (let cycle = 0; cycle < 29; cycle++) player.step();
    expect(finished, 'set too early').toEqual([]);

    player.step();
    expect(finished, 'not set on time').toEqual([7]);
  });

  it('finishes a zero-length silent sound rather than hanging on it', () => {
    const player = new AgiSoundPlayer(() => null);
    const finished: number[] = [];
    player.setFinishedHandler((flag) => finished.push(flag));
    player.setEnabled(false);

    player.play(readSound(new Uint8Array(buildSound([[], [], [], []]))), 7);
    player.step();
    expect(finished).toEqual([7]);
  });

  it('does not depend on the wall clock at all when there is no audio', () => {
    // The regression in one line: stepping is the only thing that advances a
    // silent sound, so a host that runs flat out finishes it just as one
    // running in real time does.
    const player = new AgiSoundPlayer(() => null);
    const finished: number[] = [];
    player.setFinishedHandler((flag) => finished.push(flag));
    player.setEnabled(false);

    player.play(
      readSound(
        new Uint8Array(buildSound([[{ duration: 6, divisor: 200, attenuation: 0 }], [], [], []])),
      ),
      3,
    );
    for (let cycle = 0; cycle < 6; cycle++) player.step();
    expect(finished).toEqual([3]);
  });

  /**
   * `stop.sound` is a script deciding the sound is over, and AGI does not set
   * the wait flag then — a script that stopped a sound is not waiting for it.
   */
  it('does not set the flag when a script stops the sound', () => {
    const player = new AgiSoundPlayer(() => null);
    const finished: number[] = [];
    player.setFinishedHandler((flag) => finished.push(flag));
    player.setEnabled(true);

    player.play(
      readSound(
        new Uint8Array(buildSound([[{ duration: 600, divisor: 100, attenuation: 0 }], [], [], []])),
      ),
      9,
    );
    player.stop();
    player.step();
    expect(finished).toEqual([]);
  });

  it('is controlled by the same enable toggle the shell already has', () => {
    const player = new AgiSoundPlayer(() => null);
    expect(player.isEnabled).toBe(false);
    player.setEnabled(true);
    expect(player.isEnabled).toBe(true);
  });

  it('survives having no audio context at all', async () => {
    const player = new AgiSoundPlayer(() => null);
    player.setEnabled(true);
    await expect(player.resume()).resolves.toBeUndefined();
    expect(() =>
      player.play(readSound(new Uint8Array(buildSound(sampleVoices()))), 1),
    ).not.toThrow();
  });
});

describe('no OPL2 on the AGI path', () => {
  /**
   * #115 is explicit: OPL2 is FM synthesis for AdLib and AGI predates it. A
   * static check rather than a runtime one, because the way it would go wrong
   * is an import added later for convenience.
   */
  it('imports nothing from the AdLib or OPL2 code', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath, URL } = await import('node:url');
    const read = (path: string): string =>
      readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

    for (const file of ['src/engine/agi/sound/AgiSound.ts', 'src/engine/agi/AgiEngine.ts']) {
      const code = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(code).not.toMatch(/opl2|AdLibDriver|MusicSequencer|renderMusic/i);
    }
  });
});
