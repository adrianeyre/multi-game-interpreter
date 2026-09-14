// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAgosAudio } from '../src/authoring/agos/audioList.js';
import {
  effectsBankFileIn,
  effectsFileIn,
  speechFileIn,
} from '../src/engine/agos/sound/audioFiles.js';
import { agosAudioReader } from '../src/editor/agos/audioResources.js';
import { readTrackBytes, setAudioResourceReader } from '../src/editor/audioBytes.js';
import { audioFileName, audioMimeType } from '../src/editor/audioSave.js';
import { readSpeechIndex } from '../src/engine/agos/sound/speech.js';
import { detectAudioFormat, storeAudio, type ProjectAudio } from '../src/authoring/audio.js';
import { createProject, migrate } from '../src/authoring/project.js';
import { AudioSection } from '../src/editor/audioSection.js';
import type { AgosGameFolder } from '../src/editor/agos/resupply.js';

/**
 * The Audio section, for a game whose recordings are still in its folder.
 *
 * Four separable claims, and they are tested apart because they fail apart:
 * that a list can be built without copying bytes, that a project survives a
 * round trip carrying one, that a number can be turned back into bytes by
 * whatever has the folder open, and that a row offers a file at all — which is
 * the complaint this whole change answers.
 */

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];

/** Adventure Soft's own music format, by its signature. */
function gmf(): Uint8Array {
  return Uint8Array.from([...ascii('GMF'), 1, 0, 0, 0, 0]);
}

/** A Creative Voice File with one byte of sound in it. */
function voc(marker: number): number[] {
  return [...ascii('Creative Voice File'), 26, 0, 10, 1, 0x01, 1, 0, 0, 0, marker, 0];
}

/**
 * A speech container, built the way the games build one.
 *
 * The second word doubles as the table's size — that is the one-word
 * difference from the resource archive that `speech.ts` is written around — so
 * entry zero spans the table itself and the real recordings follow.
 */
function speechFile(clips: number[][]): Uint8Array {
  const table = clips.length + 1;
  const offsets: number[] = [0];
  let at = table * 4;
  for (const clip of clips) {
    offsets.push(at);
    at += clip.length;
  }
  return Uint8Array.from([...offsets.flatMap(le32), ...clips.flat()]);
}

describe('listing what an AGOS game has to play', () => {
  it('numbers the three kinds independently and copies none of their bytes', () => {
    const speechBytes = speechFile([voc(1), voc(2)]);
    const effectsBytes = speechFile([voc(3)]);

    const tracks = listAgosAudio({
      speech: { index: readSpeechIndex(speechBytes), file: 'SIMON.VOC' },
      effects: [{ number: 2, file: 'SFXXXX02', bytes: effectsBytes }],
      music: [{ number: 0, bytes: gmf() }],
      archiveFile: 'SIMON.GME',
    });

    // Smallest kind first: the thirty-six pieces of music a game has should not
    // sit under eleven thousand lines of speech.
    expect(tracks.map((track) => track.name)).toEqual([
      'Music 0',
      'Effect 1, bank 2',
      'Speech 1',
      'Speech 2',
    ]);

    // The whole constraint, as an assertion: not one entry carries bytes, in
    // the project or in the editor's store. Only a number and a length.
    for (const track of tracks) {
      expect(track.data).toBeUndefined();
      expect(track.storeKey).toBeUndefined();
      expect(track.resource?.engine).toBe('agos');
      expect(track.bytes).toBeGreaterThan(0);
    }

    // An effect carries two numbers because effect numbers restart per bank.
    expect(tracks[1]!.resource).toEqual({
      engine: 'agos',
      kind: 'effects',
      number: 1,
      bank: 2,
      file: 'SFXXXX02',
    });
    // Entry zero of a container names the offset table, not a sound, and it is
    // dropped rather than listed as an effect nobody can play.
    expect(tracks.filter((track) => track.resource?.kind === 'effects')).toHaveLength(1);
    // Music is sequenced, and saying so is what lets the section play it on the
    // OPL2 rather than hand it to a decoder that will refuse it.
    expect(tracks[0]!.format).toBe('agos-music');
  });

  it('recognises all three shapes AGOS music comes in', () => {
    expect(detectAudioFormat(gmf())).toBe('agos-music');
    // A Windows release: a count byte, then a standard MIDI file.
    expect(detectAudioFormat(Uint8Array.from([2, ...ascii('MThd')]))).toBe('agos-music');
    // Simon 2: XMIDI in an IFF container.
    expect(
      detectAudioFormat(Uint8Array.from([...ascii('FORM'), 0, 0, 0, 4, ...ascii('XMID')])),
    ).toBe('agos-music');
    // And a plain MIDI file is still a plain MIDI file.
    expect(detectAudioFormat(Uint8Array.from([...ascii('MThd'), 0, 0, 0, 6]))).toBe('midi');
  });

  it('keeps a resource track through a project round trip', () => {
    const track: ProjectAudio = {
      id: 1,
      name: 'Speech 12',
      format: 'voc',
      filename: 'SIMON.VOC',
      bytes: 400,
      resource: { engine: 'agos', kind: 'speech', number: 12, file: 'SIMON.VOC' },
    };
    const project = migrate({
      ...createProject('Simon'),
      audio: [track],
    } as never);
    // Neither inline nor in the store, and a loader that only knew those two
    // dropped it — which would empty the section on the next open.
    expect(project.audio).toHaveLength(1);
    expect(project.audio[0]!.resource?.number).toBe(12);
  });
});

describe('turning a number back into bytes', () => {
  afterEach(() => setAudioResourceReader(null));

  function folder(files: Record<string, Uint8Array>, archive: Record<number, Uint8Array>) {
    let reads = 0;
    const handle = {
      speechNames: Object.keys(files),
      read: async (name: string) => {
        reads += 1;
        return files[name] ?? null;
      },
      music: (track: number) => archive[track],
      sound: (bank: number) => archive[1000 + bank],
    } as unknown as AgosGameFolder;
    return { handle, reads: () => reads };
  }

  it('reads speech, effects and music out of the open folder', async () => {
    const files = {
      'SIMON.VOC': speechFile([voc(7), voc(8)]),
      SFXXXX02: speechFile([voc(9)]),
    };
    const source = folder(files, { 3: gmf() });
    const read = agosAudioReader(source.handle);

    const speech = await read({ engine: 'agos', kind: 'speech', number: 2, file: 'SIMON.VOC' });
    expect(speech?.[speech.length - 2]).toBe(8);

    const effect = await read({
      engine: 'agos',
      kind: 'effects',
      number: 1,
      bank: 2,
      file: 'SFXXXX02',
    });
    expect(effect?.[effect.length - 2]).toBe(9);

    const music = await read({ engine: 'agos', kind: 'music', number: 3 });
    expect(music && [...music]).toEqual([...gmf()]);

    // Nothing this release ships is a normal answer, not a throw.
    expect(await read({ engine: 'agos', kind: 'music', number: 9 })).toBeNull();
  });

  it('parses each container once rather than once per recording', async () => {
    const source = folder({ 'SIMON.VOC': speechFile([voc(1), voc(2)]) }, {});
    const read = agosAudioReader(source.handle);
    await read({ engine: 'agos', kind: 'speech', number: 1, file: 'SIMON.VOC' });
    await read({ engine: 'agos', kind: 'speech', number: 2, file: 'SIMON.VOC' });
    // A talkie's speech file is tens of megabytes. Reading it twice to play two
    // consecutive lines is the difference between a list that works and one
    // that stalls.
    expect(source.reads()).toBe(1);
  });

  it('says the folder is shut rather than pretending the track is empty', async () => {
    const track: ProjectAudio = {
      id: 1,
      name: 'Speech 12',
      format: 'voc',
      filename: 'SIMON.VOC',
      resource: { engine: 'agos', kind: 'speech', number: 12, file: 'SIMON.VOC' },
    };
    expect(await readTrackBytes(track)).toBeNull();

    const source = folder({ 'SIMON.VOC': speechFile([voc(1)]) }, {});
    setAudioResourceReader(agosAudioReader(source.handle));
    // Entry 1 is the only real recording; 12 is not there, and that too is null
    // rather than an exception.
    expect(await readTrackBytes(track)).toBeNull();
    expect(
      await readTrackBytes({ ...track, resource: { ...track.resource!, number: 1 } }),
    ).not.toBeNull();
  });
});

describe('the names of the files beside a game', () => {
  it('does not mistake the effects resource for the speech', () => {
    // Alphabetical, which is how the wrong one used to be taken.
    const names = ['effects.voc', 'simon.voc'];
    expect(speechFileIn(names)).toBe('simon.voc');
    expect(effectsFileIn(names)).toBe('effects.voc');
  });

  it('finds a bank however the retail folder spelled it', () => {
    const names = ['GAMEPC', 'SFXXXX13', 'sfxxxx15'];
    expect(effectsBankFileIn(names, 13)).toBe('SFXXXX13');
    expect(effectsBankFileIn(names, 15)).toBe('sfxxxx15');
    expect(effectsBankFileIn(names, 2)).toBeUndefined();
  });
});

describe('the Audio section offers a file', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setAudioResourceReader(null);
  });

  function section(tracks: ProjectAudio[]): { element: HTMLElement } {
    const element = document.createElement('div');
    const audio = new AudioSection({
      tracks: () => tracks,
      add: async () => tracks[0]!,
      remove: () => {},
      rename: () => {},
    });
    const render = (): void => {
      element.replaceChildren();
      audio.render(element);
    };
    audio.onChanged = render;
    document.body.appendChild(element);
    render();
    return { element };
  }

  it('saves a track that is still inside the game', async () => {
    const clicked: string[] = [];
    URL.createObjectURL = (() => 'blob:audio') as never;
    URL.revokeObjectURL = (() => {}) as never;
    vi.spyOn(document.body, 'appendChild').mockImplementation(function (
      this: HTMLElement,
      node: Node,
    ) {
      if (node instanceof HTMLAnchorElement) node.click = () => clicked.push(node.download);
      return HTMLElement.prototype.appendChild.call(this, node) as never;
    } as never);

    setAudioResourceReader(async () => Uint8Array.from(voc(1)));
    const { element } = section([
      {
        id: 1,
        name: 'Speech 1204',
        format: 'voc',
        filename: 'SIMON.VOC',
        bytes: 32,
        resource: { engine: 'agos', kind: 'speech', number: 1204, file: 'SIMON.VOC' },
      },
    ]);

    const save = element.querySelector<HTMLButtonElement>('.audio-save');
    expect(save).not.toBeNull();
    save!.click();
    await vi.waitFor(() => expect(clicked).toEqual(['Speech-1204.voc']));

    // The game's own number leads, because the id is only this editor's handle
    // for it and a second number in front would say nothing.
    expect(element.querySelector('.audio-name')?.textContent).toBe('Speech 1204');
  });

  it('says why on the row when the folder is not open', async () => {
    const { element } = section([
      {
        id: 1,
        name: 'Speech 1204',
        format: 'voc',
        filename: 'SIMON.VOC',
        resource: { engine: 'agos', kind: 'speech', number: 1204, file: 'SIMON.VOC' },
      },
    ]);
    element.querySelector<HTMLButtonElement>('.audio-save')!.click();
    await vi.waitFor(() =>
      expect(element.querySelector('.audio-reason')?.textContent).toContain('game folder'),
    );
  });

  it('pages a list of thousands and narrows it to one', () => {
    const tracks: ProjectAudio[] = [];
    for (let number = 1; number <= 250; number += 1) {
      tracks.push({
        id: number,
        name: `Speech ${number}`,
        format: 'voc',
        filename: 'SIMON.VOC',
        resource: { engine: 'agos', kind: 'speech', number, file: 'SIMON.VOC' },
      });
    }
    const { element } = section(tracks);

    // A row per track is what would freeze the page: the two Simons list 7,073
    // and 15,603 recordings.
    expect(element.querySelectorAll('.audio-item')).toHaveLength(100);
    const pager = element.querySelector('.audio-pager') as HTMLElement;
    expect(pager.textContent).toContain('1–100 of 250');
    expect(pager.querySelectorAll('button')[0]!.disabled).toBe(true);

    const filter = element.querySelector<HTMLInputElement>('.audio-filter input')!;
    filter.value = 'speech 137';
    filter.dispatchEvent(new Event('input'));
    expect(element.querySelectorAll('.audio-item')).toHaveLength(1);
    expect(element.querySelector('.audio-name')?.textContent).toBe('Speech 137');
    // And typing does not throw the caret out of the box it was typed into.
    expect(document.activeElement).toBe(element.querySelector('.audio-filter input'));
  });

  it('offers a file for an imported track too', () => {
    // Bytes that are an MP3 frame, under a name that says WAV: the format is
    // sniffed, so the file it saves as follows the bytes.
    const track = storeAudio(4, 'theme.wav', Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), 'Theme');
    const { element } = section([track]);
    const save = element.querySelector<HTMLButtonElement>('.audio-save')!;
    // The extension follows what the bytes turned out to be, not what the file
    // arrived called.
    expect(save.title).toBe('Save as Theme.mp3');
    expect(audioFileName({ ...track, name: '***' })).toBe('audio-4.mp3');
    expect(audioMimeType('voc')).toBe('application/octet-stream');
  });
});
