import { describe, expect, it, vi } from 'vitest';
import { SoundEngine } from '../src/engine/sound/SoundEngine.js';

/**
 * Music asked for before the browser will let audio start.
 *
 * A browser refuses to create a running `AudioContext` outside a user gesture,
 * and a game starts its title music before the player has clicked anything. The
 * request therefore arrives, finds no context, and used to be dropped — and it
 * stayed dropped, because by the time the player clicked, the script had moved
 * on and would not ask again. Atlantis's whole title sequence was silent for
 * that reason.
 */
/**
 * The smallest `AudioContext` `resume` needs to believe it has one. No audio
 * comes out of it — what is being tested is which sounds the engine reaches
 * for once a context exists, not what they sound like.
 */
function installFakeAudio(): () => void {
  const gain = { gain: { value: 0 }, connect: () => undefined };
  const context = {
    state: 'running',
    destination: {},
    currentTime: 0,
    createGain: () => gain,
    resume: async () => undefined,
  };
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    AudioContext: function () {
      return context;
    },
  };
  return () => {
    (globalThis as { window?: unknown }).window = previous;
  };
}

describe('a sound asked for before there is an audio context', () => {
  it('is remembered rather than dropped', () => {
    const sound = new SoundEngine();
    sound.startSound(21);

    // The bookkeeping a script polls is answered either way.
    expect(sound.isSoundRunning(21)).toBe(true);
  });

  it('is started again when the context arrives', async () => {
    const sound = new SoundEngine();
    sound.startSound(21);

    const started: number[] = [];
    const original = sound.startSound.bind(sound);
    vi.spyOn(sound, 'startSound').mockImplementation((id: number) => {
      started.push(id);
      original(id);
    });

    const restore = installFakeAudio();
    await sound.resume();
    restore();

    expect(started).toEqual([21]);
  });

  it('does not replay it a second time', async () => {
    const sound = new SoundEngine();
    sound.startSound(21);
    const restore = installFakeAudio();
    await sound.resume();

    const started: number[] = [];
    vi.spyOn(sound, 'startSound').mockImplementation((id: number) => {
      started.push(id);
    });
    await sound.resume();
    restore();

    expect(started).toEqual([]);
  });
});
