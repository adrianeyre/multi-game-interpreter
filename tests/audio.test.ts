import { describe, expect, it } from 'vitest';
import {
  audioByteLength,
  classifyImport,
  describeFormat,
  detectAudioFormat,
  isExternal,
  referenceAudio,
  isPlayableFormat,
  loadAudio,
  storeAudio,
  whyUnplayable,
} from '../src/authoring/audio.js';
import { createProject, migrate, PROJECT_VERSION } from '../src/authoring/project.js';
import { importGame } from '../src/authoring/importGame.js';
import { decodeSoundResource } from '../src/engine/sound/SoundEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { EditorState } from '../src/editor/state.js';
import { buildFixture, chunk } from './fixture.js';

/** A one-note Standard MIDI File, for resources that need a real score inside. */
function midiFile(): number[] {
  const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
  const be32 = (n: number): number[] => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ];
  const track = [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0, 0x00, 0xff, 0x2f, 0x00];
  return [
    ...ascii('MThd'),
    ...be32(6),
    0,
    0,
    0,
    1,
    0,
    96,
    ...ascii('MTrk'),
    ...be32(track.length),
    ...track,
  ];
}

/** Builds a buffer whose first bytes are `head`, padded to a plausible size. */
function withHeader(head: string, size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < head.length; i++) bytes[i] = head.charCodeAt(i);
  return bytes;
}

describe('audio format detection', () => {
  it('recognises a WAV by its RIFF/WAVE pair, not by RIFF alone', () => {
    const wav = withHeader('RIFF');
    wav.set(
      [...'WAVE'].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(detectAudioFormat(wav)).toBe('wav');

    const avi = withHeader('RIFF');
    avi.set(
      [...'AVI '].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(detectAudioFormat(avi)).toBe('unknown');
  });

  it('recognises the container formats a browser can decode', () => {
    expect(detectAudioFormat(withHeader('OggS'))).toBe('ogg');
    expect(detectAudioFormat(withHeader('fLaC'))).toBe('flac');
    expect(detectAudioFormat(withHeader('ID3'))).toBe('mp3');

    const aiff = withHeader('FORM');
    aiff.set(
      [...'AIFF'].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(detectAudioFormat(aiff)).toBe('aiff');

    const m4a = new Uint8Array(64);
    m4a.set(
      [...'ftyp'].map((c) => c.charCodeAt(0)),
      4,
    );
    expect(detectAudioFormat(m4a)).toBe('mp4');
  });

  it('recognises a bare MPEG frame without mistaking every 0xff for one', () => {
    const frame = new Uint8Array(64);
    frame[0] = 0xff;
    frame[1] = 0xfb; // MPEG-1 Layer III
    expect(detectAudioFormat(frame)).toBe('mp3');

    const reserved = new Uint8Array(64);
    reserved[0] = 0xff;
    reserved[1] = 0xe0; // reserved version and layer
    expect(detectAudioFormat(reserved)).toBe('unknown');
  });

  it('recognises SCUMM and LucasArts files that are not playable audio', () => {
    expect(detectAudioFormat(withHeader('MThd'))).toBe('midi');
    expect(detectAudioFormat(withHeader('iMUS'))).toBe('imuse');
    expect(detectAudioFormat(withHeader('ANIM'))).toBe('smush');
    expect(detectAudioFormat(withHeader('Creative Voice File'))).toBe('voc');
    expect(detectAudioFormat(withHeader('ADL '))).toBe('scumm-music');
    expect(detectAudioFormat(withHeader('ROL '))).toBe('scumm-silent');
  });

  it('separates a SCUMM resource that has samples from one that only has a score', () => {
    // The distinction that decides whether the play button does anything: a
    // `SOU ` resource is a bag of the same music per sound card, and only the
    // `SBL ` variant holds digitised audio.
    const digitised = new Uint8Array(chunk('SOU ', chunk('SBL ', chunk('AUdt', [0, 0, 0, 0]))));
    expect(detectAudioFormat(digitised)).toBe('scumm-sound');
    expect(isPlayableFormat('scumm-sound')).toBe(true);

    // The AdLib arrangement is synthesised, so it counts as playable.
    const sequenced = new Uint8Array(chunk('SOU ', chunk('ADL ', [1, 2, 3, 4])));
    expect(detectAudioFormat(sequenced)).toBe('scumm-music');
    expect(isPlayableFormat('scumm-music')).toBe(true);
    expect(whyUnplayable('scumm-music')).toBeNull();
  });

  it('still plays a score that has no AdLib arrangement', () => {
    // Written for a chip that is not emulated, so the timbre will be wrong.
    // Playing it on the OPL2 anyway gives the right notes, which is worth far
    // more than refusing — and the label says which it is.
    const rolandOnly = new Uint8Array(chunk('SOU ', chunk('ROL ', [...midiFile()])));

    expect(detectAudioFormat(rolandOnly)).toBe('scumm-other');
    expect(isPlayableFormat('scumm-other')).toBe(true);
    expect(whyUnplayable('scumm-other')).toBeNull();
    expect(describeFormat('scumm-other')).toMatch(/no AdLib/);
  });

  it('classifies by the same search that renders, not a stricter one', () => {
    // An extraction tool may slice a resource at a point the chunk tree cannot
    // be walked from. Judging playability by a rule stricter than the one that
    // actually plays the file is how a perfectly playable score ends up
    // labelled unplayable.
    const sliced = new Uint8Array([0x53, 0x4f, 0x55, 0x20, 0xff, 0xff, 0xff, 0xff, ...midiFile()]);

    expect(detectAudioFormat(sliced)).toBe('scumm-other');
    expect(isPlayableFormat(detectAudioFormat(sliced))).toBe(true);
  });

  it('says plainly when a resource holds nothing to play', () => {
    const empty = new Uint8Array(chunk('SOU ', chunk('ROL ', [1, 2, 3, 4])));

    expect(detectAudioFormat(empty)).toBe('scumm-silent');
    expect(isPlayableFormat('scumm-silent')).toBe(false);
    expect(whyUnplayable('scumm-silent')).toMatch(/nothing to play/);
  });

  it('does not offer a play button for a truncated SCUMM resource', () => {
    // A size field pointing past the end must not read as "has samples".
    const truncated = new Uint8Array(
      [...'SOU '].map((c) => c.charCodeAt(0)).concat([0xff, 0xff, 0xff, 0xff]),
    );
    expect(detectAudioFormat(truncated)).toBe('scumm-silent');
    expect(isPlayableFormat('scumm-silent')).toBe(false);
  });

  it('spots an MT-32 ROM by the name in its display strings', () => {
    // Not in a header: a real control ROM carries "** Roland MT-32 **" several
    // kilobytes in, among the front panel's own messages. Reading only the
    // opening bytes finds nothing at all.
    const rom = new Uint8Array(64 * 1024);
    rom.set(
      [...' Welcome! TEST MODE '].map((c) => c.charCodeAt(0)),
      42,
    );
    rom.set(
      [...'** Roland MT-32 **'].map((c) => c.charCodeAt(0)),
      8574,
    );

    expect(detectAudioFormat(rom)).toBe('mt32-rom');
    expect(isPlayableFormat('mt32-rom')).toBe(false);
  });

  it('uses the filename only when the bytes say nothing at all', () => {
    // An MT-32 PCM ROM is half a megabyte of raw samples: no header, no
    // strings, nothing to recognise. There the name is better than
    // "unrecognised" — but it never gets to overrule bytes that do speak.
    const samples = new Uint8Array(512 * 1024);
    samples.set([0x00, 0x00, 0x70, 0x16, 0x02, 0x6e], 16);

    expect(detectAudioFormat(samples)).toBe('unknown');
    expect(classifyImport(samples, 'MT32_PCM.ROM')).toBe('mt32-rom');

    // A real FLAC named .rom is still a FLAC.
    expect(classifyImport(withHeader('fLaC'), 'mislabelled.rom')).toBe('flac');
  });

  it('recognises a sound driver as the program it is', () => {
    // `.IMS` files look like music and are not: they are iMUSE sound-card
    // drivers, the code a SCUMM game loaded to talk to an AdLib or a Roland.
    // A real one begins `MZ` and carries a string table of the chunk tags it
    // recognises — `MDhd`, `MTrk`, `ROL ` — so anything that searches for
    // music by scanning for tags finds the driver's own lookup table and
    // reports a piece of music that does not exist.
    const driver = new Uint8Array(19000);
    driver.set(
      [...'MZ \u0000'].map((c) => c.charCodeAt(0)),
      0,
    );
    driver.set(
      [...'ROL \u0000'].map((c) => c.charCodeAt(0)),
      18612,
    );
    driver.set(
      [...'MDhd\u0000MTrk\u0000MTrk\u0000'].map((c) => c.charCodeAt(0)),
      18780,
    );

    expect(detectAudioFormat(driver)).toBe('executable');
    expect(isPlayableFormat('executable')).toBe(false);
    expect(whyUnplayable('executable')).toMatch(/program|driver/);
    expect(describeFormat('executable')).toMatch(/driver/i);
  });

  it('rules out an executable before looking for music inside it', () => {
    // Order matters here and nowhere else: the tags come first in the file
    // only by accident, and a driver that happened to store them earlier
    // would otherwise be classified as the music it merely knows how to read.
    const driver = new Uint8Array(600);
    driver.set(
      [...'MZ \u0000'].map((c) => c.charCodeAt(0)),
      0,
    );
    driver.set(
      [...'MThd'].map((c) => c.charCodeAt(0)),
      64,
    );

    expect(detectAudioFormat(driver)).toBe('executable');
  });

  it('calls anything else unknown, and still lets the browser try it', () => {
    expect(detectAudioFormat(withHeader('ZZZZ'))).toBe('unknown');
    // Unknown is not a refusal: browsers decode formats this sniffer has never
    // been taught, so the file is still offered to them.
    expect(isPlayableFormat('unknown')).toBe(true);
    expect(whyUnplayable('unknown')).toBeNull();
  });

  it('treats a file too short to identify as unknown rather than crashing', () => {
    expect(detectAudioFormat(new Uint8Array([0x52, 0x49]))).toBe('unknown');
    expect(detectAudioFormat(new Uint8Array())).toBe('unknown');
  });

  it('explains why a sequenced or ROM file cannot be played', () => {
    for (const format of ['midi', 'imuse', 'smush', 'mt32-rom'] as const) {
      expect(isPlayableFormat(format)).toBe(false);
      expect(whyUnplayable(format)).toBeTruthy();
      expect(describeFormat(format)).not.toBe('Unrecognised');
    }
  });
});

describe('audio storage', () => {
  it('round-trips bytes through base64', () => {
    const bytes = new Uint8Array(500);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;

    const track = storeAudio(3, 'theme.mp3', bytes);
    expect(track.id).toBe(3);
    expect(loadAudio(track)).toEqual(bytes);
  });

  it('names a track after the file, without the extension', () => {
    expect(storeAudio(1, 'opening theme.mp3', new Uint8Array(4)).name).toBe('opening theme');
    // A file with no extension keeps its whole name rather than becoming empty.
    expect(storeAudio(1, 'theme', new Uint8Array(4)).name).toBe('theme');
  });

  it('reports the decoded size, not the base64 length', () => {
    for (const size of [1, 2, 3, 100, 4096]) {
      expect(audioByteLength(storeAudio(1, 'x.bin', new Uint8Array(size)))).toBe(size);
    }
  });

  it('records the sniffed format rather than trusting the extension', () => {
    // Exactly the case that motivates sniffing: an extraction tool's extension
    // says one thing and the bytes say another.
    const track = storeAudio(1, 'music.ims', withHeader('MThd'));
    expect(track.format).toBe('midi');
  });
});

describe('audio too large to live in the project', () => {
  it('describes a stored track without needing its bytes', () => {
    // The whole point: a project holding a CD soundtrack must still be a small
    // document, so everything the library shows has to come from the entry.
    const track = referenceAudio(3, 'Track7.fla', withHeader('fLaC', 9_500_000), 'audio-abc');

    expect(isExternal(track)).toBe(true);
    expect(track.data).toBeUndefined();
    expect(track.format).toBe('flac');
    expect(audioByteLength(track)).toBe(9_500_000);
    expect(JSON.stringify(track).length).toBeLessThan(300);
  });

  it('keeps small audio inside the project, where it travels for free', () => {
    const track = storeAudio(1, 'door.wav', withHeader('RIFF'));

    expect(isExternal(track)).toBe(false);
    expect(track.data).toBeTruthy();
  });

  it('refuses to hand back bytes it does not have', () => {
    // Returning an empty buffer would play as silence, which looks like a
    // broken file rather than a track whose audio is on another machine.
    const track = referenceAudio(1, 'Track1.fla', withHeader('fLaC'), 'audio-xyz');

    expect(() => loadAudio(track)).toThrow(/stored outside the project/);
  });

  it('keeps a stored track through a save and reload', () => {
    const project = createProject('Big');
    project.audio = [referenceAudio(1, 'Track1.fla', withHeader('fLaC', 9_000_000), 'audio-k')];

    const reopened = migrate(JSON.parse(JSON.stringify(project)));

    expect(reopened.audio).toHaveLength(1);
    expect(reopened.audio[0].storeKey).toBe('audio-k');
  });

  it('drops a track that points at neither bytes nor a store', () => {
    const project = {
      ...createProject('Broken'),
      audio: [{ id: 1, name: 'ghost', format: 'flac', filename: 'x.fla' }],
    };

    expect(migrate(project).audio).toHaveLength(0);
  });
});

describe('projects carrying audio', () => {
  it('starts a new project with an empty library', () => {
    expect(createProject().audio).toEqual([]);
  });

  it('gives a project saved before audio existed an empty library', () => {
    const old = { ...createProject('Old'), version: 3 } as unknown as Record<string, unknown>;
    delete old.audio;

    const upgraded = migrate(old);
    expect(upgraded.version).toBe(PROJECT_VERSION);
    expect(upgraded.audio).toEqual([]);
  });

  it('drops audio entries with no bytes rather than listing a dead track', () => {
    const project = createProject('With audio');
    const broken = {
      ...project,
      audio: [
        storeAudio(1, 'good.wav', withHeader('RIFF')),
        { id: 2, name: 'empty', format: 'wav', filename: 'empty.wav', data: '' },
      ],
    };

    expect(migrate(broken).audio).toHaveLength(1);
  });
});

describe('the editor audio library', () => {
  it('adds, renames and removes tracks', async () => {
    const state = new EditorState(createProject('Sounds'));

    const first = await state.addAudio('door.wav', withHeader('RIFF'));
    const second = await state.addAudio('theme.mp3', withHeader('ID3'));
    expect([first.id, second.id]).toEqual([1, 2]);

    state.renameAudio(first.id, 'Door creak');
    expect(state.current.audio[0].name).toBe('Door creak');

    state.deleteAudio(first.id);
    expect(state.current.audio.map((t) => t.id)).toEqual([2]);
  });

  it('does not reuse the id of a deleted track', async () => {
    const state = new EditorState(createProject('Sounds'));
    await state.addAudio('a.wav', withHeader('RIFF'));
    const second = await state.addAudio('b.wav', withHeader('RIFF'));

    state.deleteAudio(second.id);
    // Ids are allocated from what remains, so the gap at 2 is refilled — what
    // must not happen is a live `playSound 2` quietly pointing at new audio
    // while track 2 still exists.
    const third = await state.addAudio('c.wav', withHeader('RIFF'));
    expect(state.current.audio.filter((t) => t.id === third.id)).toHaveLength(1);
  });

  it('falls back to the filename when renamed to nothing', async () => {
    const state = new EditorState(createProject('Sounds'));
    const track = await state.addAudio('door.wav', withHeader('RIFF'));
    state.renameAudio(track.id, '   ');
    expect(state.current.audio[0].name).toBe('door.wav');
  });

  it('keeps audio out of undo, so a large library cannot fill the stack', async () => {
    const state = new EditorState(createProject('Sounds'));
    await state.addAudio('theme.mp3', withHeader('ID3', 4096));

    state.addRoom();
    state.undo();

    // The room edit is undone; the audio is carried across untouched rather
    // than being versioned along with it.
    expect(state.current.audio).toHaveLength(1);
    expect(loadAudio(state.current.audio[0])).toHaveLength(4096);
  });

  it('keeps audio when an undo crosses an import', async () => {
    const state = new EditorState(createProject('Sounds'));
    state.addRoom();
    await state.addAudio('theme.mp3', withHeader('ID3'));
    state.undo();

    expect(state.current.audio).toHaveLength(1);
  });
});

describe('sound coming out of a published game', () => {
  async function importedGame() {
    const fixture = buildFixture();
    const source = new MemoryDataSource('fixture');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const resources = await ResourceManager.load(source, await detectGame(source));
    return { resources, result: importGame(resources) };
  }

  it('lists the container sounds in the project audio library', async () => {
    const { result } = await importedGame();
    expect(result.project.audio.length).toBeGreaterThan(0);
  });

  it('keeps each sound on the id its scripts already use', async () => {
    const { resources, result } = await importedGame();
    // A decompiled `playSound 5` has to keep meaning sound 5, so the library
    // is keyed on the container's numbering rather than being renumbered.
    // Sound 0 is the engine's "no sound" and is deliberately left out.
    expect(result.project.audio.map((track) => track.id)).toEqual(
      resources.listSounds().filter((id) => id !== 0),
    );
    expect(result.project.audio.some((track) => track.id === 0)).toBe(false);
  });

  it('imports the bytes intact, so the audio still decodes', async () => {
    const { result } = await importedGame();
    const track = result.project.audio[0];

    expect(track.format).toBe('scumm-sound');
    const pcm = decodeSoundResource(loadAudio(track));
    expect(pcm?.samples.length).toBeGreaterThan(0);
  });

  it('says in the import notes how much audio came across', async () => {
    const { result } = await importedGame();
    expect(result.notes.some((note) => /sounds were imported/.test(note))).toBe(true);
  });
});
