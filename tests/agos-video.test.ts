import { describe, expect, it } from 'vitest';
import {
  describeUndecodableVideo,
  identifyAgosVideo,
  videoFileCandidates,
} from '../src/engine/agos/video/agosVideo.js';
import { AgosVideoPlayback, SECONDS_PER_STEP } from '../src/engine/agos/video/AgosVideoPlayback.js';
import { buildSmacker } from './fixtureSmacker.js';

/** A DXA header, which is all this project ever reads of one. */
const DXA = Uint8Array.from([0x44, 0x45, 0x58, 0x41, 0, 0, 0, 0]);

function surface(width = 8, height = 8) {
  return { width, height, pixels: new Uint8Array(width * height) };
}

/** Steps a playback until it says the sequence is over, or gives up. */
function playToEnd(video: AgosVideoPlayback, target: ReturnType<typeof surface>): number {
  for (let step = 0; step < 1000; step += 1) {
    if (!video.advance(target)) return step;
  }
  throw new Error('the sequence never ended');
}

describe('identifying an AGOS 2 video', () => {
  it('recognises Smacker, which is what the discs carry', () => {
    const file = buildSmacker({ width: 4, height: 4, frames: [{ blocks: [{ kind: 'skip' }] }] });

    expect(identifyAgosVideo(file)).toEqual({ format: 'smacker', decodable: true });
  });

  it('recognises DXA by name and refuses to decode it', () => {
    // ADR 0024's rule: read what the publisher shipped rather than another
    // implementation's derivation of it. A DXA is ScummVM's re-encode.
    expect(identifyAgosVideo(DXA)).toEqual({ format: 'dxa', decodable: false });
  });

  it('says a file is not a video it knows rather than guessing', () => {
    expect(identifyAgosVideo(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({
      format: 'unknown',
      decodable: false,
    });
  });

  it('names the DXA case in a sentence that says what would play instead', () => {
    const message = describeUndecodableVideo('INTRO.dxa', identifyAgosVideo(DXA));

    expect(message).toContain('INTRO.dxa');
    expect(message).toContain('.smk');
    expect(message).toContain('skipped');
  });

  it('tries a bare name with the extensions the games leave off', () => {
    expect(videoFileCandidates('INTRO')).toEqual(['INTRO.smk', 'INTRO.dxa', 'INTRO']);
    expect(videoFileCandidates('INTRO.smk')).toEqual(['INTRO.smk']);
    expect(videoFileCandidates('  ')).toEqual([]);
  });
});

describe('playing a video at the AGOS screen', () => {
  const film = () =>
    buildSmacker({
      width: 8,
      height: 8,
      frameRateMs: 16,
      frames: [
        {
          blocks: [
            { kind: 'fill', colour: 4 },
            { kind: 'skip' },
            { kind: 'skip' },
            { kind: 'skip' },
          ],
        },
        {
          blocks: [
            { kind: 'fill', colour: 5 },
            { kind: 'skip' },
            { kind: 'skip' },
            { kind: 'skip' },
          ],
        },
      ],
    });

  it('stops the world from the moment a video is asked for', () => {
    const video = new AgosVideoPlayback();

    expect(video.active).toBe(false);
    video.beginLoad('INTRO.smk', new Uint8Array(768));
    // Active while the file is still being fetched, not only once it opens: a
    // script that kept running would reach the next scene before its cutscene
    // had started.
    expect(video.active).toBe(true);
    expect(video.playing).toBe('INTRO.smk');
  });

  it('draws its frames and then says the sequence is over', () => {
    const video = new AgosVideoPlayback();
    const target = surface();

    video.beginLoad('INTRO.smk', new Uint8Array(768));
    expect(video.open(film())).toBe(true);
    video.advance(target);

    expect(target.pixels[0]).toBe(4);
    const steps = playToEnd(video, target);
    expect(steps).toBeGreaterThan(0);
    expect(video.active).toBe(false);
  });

  it('gives up on a DXA by name and puts the world back', () => {
    const video = new AgosVideoPlayback();
    const said: string[] = [];
    video.onLog = (message) => said.push(message);

    video.beginLoad('INTRO.dxa', new Uint8Array(768));

    expect(video.open(DXA)).toBe(false);
    expect(video.active).toBe(false);
    expect(said.join(' ')).toContain('DXA');
  });

  it('gives up on bytes that are not a video at all', () => {
    const video = new AgosVideoPlayback();
    const said: string[] = [];
    video.onLog = (message) => said.push(message);

    video.beginLoad('NOTAVIDEO', new Uint8Array(768));

    expect(video.open(Uint8Array.from([9, 9, 9, 9, 9, 9, 9, 9]))).toBe(false);
    expect(said.join(' ')).toContain('not a video format this project decodes');
  });

  it('borrows the room’s palette and hands it back when the video ends', () => {
    const video = new AgosVideoPlayback();
    const target = surface();
    const room = new Uint8Array(768).fill(9);
    let restored: Uint8Array | null = null;
    video.onPaletteRestored = (rgb) => {
      restored = rgb;
    };

    video.beginLoad('INTRO.smk', room);
    video.open(film());
    playToEnd(video, target);

    // Without this the first room after a cutscene wears the cutscene's
    // colours, which reads as a palette bug in the room rather than in the
    // video.
    expect(restored).not.toBeNull();
    expect(restored![0]).toBe(9);
  });

  it('hands over a palette only for a frame that changed one', () => {
    const video = new AgosVideoPlayback();
    const target = surface();
    const changes: number[] = [];
    video.onPalette = (rgb) => changes.push(rgb[0] ?? 0);

    video.beginLoad('INTRO.smk', new Uint8Array(768));
    video.open(
      buildSmacker({
        width: 8,
        height: 8,
        frames: [
          { blocks: [{ kind: 'fill', colour: 1 }], palette: [[0x3f, 0x3f, 0x3f]] },
          { blocks: [{ kind: 'fill', colour: 2 }] },
        ],
      }),
    );
    playToEnd(video, target);

    expect(changes).toEqual([0xff]);
  });

  it('hands a frame’s audio over as it is decoded', () => {
    const video = new AgosVideoPlayback();
    const target = surface();
    const heard: number[] = [];
    video.onAudio = (audio) => heard.push(audio.samples.length);

    video.beginLoad('INTRO.smk', new Uint8Array(768));
    video.open(
      buildSmacker({
        width: 8,
        height: 8,
        audioRate: 22_050,
        frames: [{ blocks: [{ kind: 'fill', colour: 1 }], audio: new Uint8Array(64) }],
      }),
    );
    playToEnd(video, target);

    expect(heard).toEqual([64]);
  });

  it('keeps the file’s own frame rate rather than one frame per step', () => {
    const video = new AgosVideoPlayback();
    const target = surface();

    // One frame a second, against a host running at sixty steps a second.
    video.beginLoad('SLOW.smk', new Uint8Array(768));
    video.open(
      buildSmacker({
        width: 8,
        height: 8,
        frameRateMs: 1000,
        frames: [
          { blocks: [{ kind: 'fill', colour: 3 }] },
          { blocks: [{ kind: 'fill', colour: 6 }] },
        ],
      }),
    );

    for (let step = 0; step < 30; step += 1) video.advance(target);

    // Half a second in, the second frame is not due yet.
    expect(SECONDS_PER_STEP * 30).toBeCloseTo(0.5);
    expect(target.pixels[0]).toBe(3);
  });

  it('centres a video smaller than the screen rather than stretching it', () => {
    const video = new AgosVideoPlayback();
    const target = surface(16, 16);

    video.beginLoad('SMALL.smk', new Uint8Array(768));
    video.open(
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
      }),
    );
    video.advance(target);

    // Scaling it up would be this interpreter inventing a picture the game
    // never showed, so the corners stay empty and the middle carries the video.
    expect(target.pixels[0]).toBe(0);
    expect(target.pixels[4 * 16 + 4]).toBe(7);
  });
});
