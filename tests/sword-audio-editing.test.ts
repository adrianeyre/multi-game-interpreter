// @vitest-environment jsdom
/**
 * Broken Sword's and Broken Sword II's audio, listed and replaced.
 *
 * The editing half of the audio work, and the thing worth testing about it is
 * not that a list has rows: it is that the three numbers a row carries —
 * which family, which kind, which of the game's own numbers — still find the
 * bytes after a round trip through a re-supplied folder (ADR 0034). A listing
 * that lists and cannot play is the failure this file is written against, and
 * it is a silent one: every row looks right.
 *
 * The fixtures are built from the formats, as `fixtureSword.ts` explains, and
 * two of them are worth naming here because they are the parts a reader gets
 * subtly wrong rather than loudly:
 *
 * - Sword 1's **demo speech** states its uncompressed length *inside* the RLE
 *   stream, so the first two runs decode to the length's own words and the
 *   original blanks them. The container built below does exactly that, which
 *   is why the decoded line begins with two zeroes rather than with audio.
 * - Sword 1's **effect ids** are `cluster << 24 | index`, and the cluster
 *   number is the RIF's one-based position. Effect 1 is cluster 12, so the
 *   fixture index has twelve clusters and eleven of them are empty.
 */
import { describe, expect, it } from 'vitest';
import { listSword1Audio } from '../src/authoring/sword1/audioList.js';
import {
  listSword2Audio,
  sword2AudioKind,
  type Sword2AudioEntry,
} from '../src/authoring/sword2/audioList.js';
import {
  missingBytesReason,
  readTrackBytes,
  setAudioResourceReader,
} from '../src/editor/audioBytes.js';
import { readSword1GameFolder } from '../src/editor/sword1/resupply.js';
import { sword1AudioReader } from '../src/editor/sword1/audioResources.js';
import { waveOf } from '../src/editor/sword1/audioResources.js';
import { readSword2GameFolder } from '../src/editor/sword2/resupply.js';
import { sword2AudioReader } from '../src/editor/sword2/audioResources.js';
import { AudioSection } from '../src/editor/audioSection.js';
import { Sword1Editor, type Sword1EditorOptions } from '../src/editor/sword1/Sword1Editor.js';
import { Sword2Editor } from '../src/editor/sword2/Sword2Editor.js';
import { EditorState } from '../src/editor/state.js';
import { createProject } from '../src/authoring/project.js';
import { SWORD1_SURFACES } from '../src/authoring/sword1/project.js';
import { SWORD2_SURFACES } from '../src/authoring/sword2/project.js';
import { toBase64 } from '../src/authoring/base64.js';
import { Sword2FileType } from '../src/engine/sword2/resource/sword2Headers.js';
import { buildSwordFixture, buildSword2Fixture, sword2Header, Writer } from './fixtureSword.js';
import { encodeSword2Clu } from '../src/engine/sword2/sound/sword2Clu.js';
import type { Project } from '../src/authoring/project.js';
import type { ProjectAudio } from '../src/authoring/audio.js';
import type { Sword1Release } from '../src/engine/sword1/resource/swordDetect.js';

// ---------------------------------------------------------------- fixtures --

/** A file as a directory picker hands one over: bytes, and where they sat. */
function pathed(path: string, bytes: Uint8Array): File {
  const file = new File([bytes as BlobPart], path.split('/').pop() ?? path);
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

function sword1Project(release: Sword1Release, present: readonly string[]): Project {
  return {
    ...createProject('Broken Sword'),
    target: { engine: 'sword1', release, platform: 'dos' },
    sword1: {
      identification: { release, how: 'shipped-files', evidence: 'a fixture' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD1_SURFACES,
      sections: [],
      scripts: [],
      text: [],
      palettes: [],
      pictures: [],
      rooms: [],
      effects: [],
      clusters: { present, absent: [] },
    },
  };
}

function sword2Project(present: readonly string[]): Project {
  return {
    ...createProject('Broken Sword II'),
    target: { engine: 'sword2', release: 'cd', platform: 'dos' },
    sword2: {
      identification: { release: 'cd', how: 'fallback', evidence: 'a fixture' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD2_SURFACES,
      objects: [],
      globals: { count: 0, bytesBase64: '' },
      text: [],
      screens: [],
      palettes: [],
      animations: [],
      runLists: [],
      clusters: { present, absent: [] },
    },
  };
}

/** The bytes of effect 1: cluster 12, group 0, index 6 in the Windows demo. */
const EFFECT_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
const TUNE_BYTES = Uint8Array.from([9, 9, 9, 9]);

const SWORD1_FIXTURE = buildSwordFixture([
  ...Array.from({ length: 11 }, (_unused, at) => ({
    label: `EMPTY${at + 1}`,
    groups: 0,
    resources: [],
  })),
  { label: 'GENERAL', groups: 1, resources: [{ group: 0, index: 6, bytes: EFFECT_BYTES }] },
]);

/**
 * One line of the demo's speech, RLE'd the way `COWS.MAD` holds one.
 *
 * `data`, then runs: two one-sample copies whose samples are the low and high
 * halves of the uncompressed byte length, then the audio. Decoding it yields
 * eight samples of which the first two are blanked, which is the original's
 * own behaviour (`sound.cpp:713`) and the reason a line does not begin with a
 * click.
 */
const SPEECH_LINE = new Writer()
  .ascii('data', 4)
  .u16(1)
  .u16(16) // the low half of "sixteen bytes", read as a sample and then blanked
  .u16(1)
  .u16(0) // and the high half
  .u16(3)
  .u16(100)
  .u16(101)
  .u16(102)
  .u16(-3)
  .u16(-5)
  .done();

/** The container: a 28-byte index naming room 1 line 1, then the line. */
const COWS_MAD = new Writer()
  .u32(28)
  .u32(0) // room 0 records nothing
  .u32(12) // room 1's block starts at word 3
  .u32(0) // room 2 records nothing
  .u32(0) // the word room 1's block overlaps with
  .u32(0) // line 1's offset, measured from the end of the index
  .u32(SPEECH_LINE.length)
  .raw(SPEECH_LINE)
  .done();

function sword1Files(options: { rif?: boolean; music?: boolean } = {}): File[] {
  const files: File[] = [];
  if (options.rif !== false) files.push(pathed('bs1/CLUSTERS/SWORDRES.RIF', SWORD1_FIXTURE.rif));
  files.push(pathed('bs1/CLUSTERS/GENERAL.CLU', SWORD1_FIXTURE.clusters.get('GENERAL')!));
  if (options.music !== false) files.push(pathed('bs1/MUSIC/1M2.WAV', TUNE_BYTES));
  files.push(pathed('bs1/SPEECH/COWS.MAD', COWS_MAD));
  files.push(pathed('bs1/SMACKSHI/ENDDEMO.SMK', Uint8Array.of(0)));
  return files;
}

const WAV_PAYLOAD = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

/**
 * Two clusters named by `resource.inf`, one of which the folder below omits.
 *
 * Deliberately: the index names every cluster the release was built with,
 * present or not, so a check that reads the index's names rather than the
 * files actually found can never refuse anything.
 */
const SWORD2_FIXTURE = buildSword2Fixture([
  {
    name: 'general.clu',
    resources: [
      { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'unused', 0) },
      {
        id: 1,
        bytes: new Writer()
          .raw(sword2Header(Sword2FileType.WAV_FILE, 'Wav fxdoor', WAV_PAYLOAD.length))
          .raw(WAV_PAYLOAD)
          .done(),
      },
    ],
  },
  {
    name: 'docks.clu',
    resources: [{ id: 20, bytes: sword2Header(Sword2FileType.SCREEN_FILE, 'docks', 0) }],
  },
]);

function sword2Files(): File[] {
  return [
    pathed('bs2/resource.inf', SWORD2_FIXTURE.inf),
    pathed('bs2/resource.tab', SWORD2_FIXTURE.tab),
    pathed('bs2/cd.inf', SWORD2_FIXTURE.cdInf),
    pathed('bs2/clusters/general.clu', SWORD2_FIXTURE.clusters.get('general.clu')!),
  ];
}

/** The three lines of a speech container, as the format lays one out. */
const SPEECH_LINES = [Int16Array.from([0, 7, 14, 7]), Int16Array.from([-16, -8, 0, 8, 16])];

/**
 * A `speech1.clu`, built by this project because nothing here ships one.
 *
 * Both Broken Sword II installs reachable from this repository are the DOS
 * demo, and neither holds a speech or music container — so this fixture, and
 * every test below that reads it, says that the reader and the writer agree
 * with each other and says nothing about a retail disc. `docs/editor-parity.md`
 * §27a is where that is stated on the surface.
 */
function speechContainer(): Uint8Array {
  const payloads = SPEECH_LINES.map((line) => encodeSword2Clu(line));
  // Three slots: the middle one is a line the release never recorded, which
  // the index states as an offset and a length of zero.
  const head = 8 + 3 * 8;
  const out = new Uint8Array(head + payloads[0]!.length + payloads[1]!.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 3, true);
  let at = head;
  [0, 2].forEach((slot, which) => {
    const payload = payloads[which]!;
    view.setUint32(8 + slot * 8, at, true);
    view.setUint32(8 + slot * 8 + 4, payload.length, true);
    out.set(payload, at);
    at += payload.length;
  });
  return out;
}

function sword2FilesWithSpeech(): File[] {
  return [...sword2Files(), pathed('bs2/clusters/speech1.clu', speechContainer())];
}

// ----------------------------------------------------------------- listings --

describe('listing what a Broken Sword release has to listen to', () => {
  const names = ['CLUSTERS/SWORDRES.RIF', 'MUSIC/1M2.WAV', 'SPEECH/COWS.MAD'];

  it('lists a tune only where its file is actually beside the game', () => {
    // 269 tunes are named by the generated table and the demo ships 46 of
    // them. A listing that showed all 269 would be 223 rows that cannot play.
    const tracks = listSword1Audio({ names, windowsDemo: true, hasSample: () => false });
    expect(tracks.map((track) => track.resource?.number)).toEqual([1]);
    expect(tracks[0].name).toBe('Music 1 — 1m2');
    expect(tracks[0].filename).toBe('MUSIC/1M2.WAV');
  });

  it('lists an effect only where its sample is reachable', () => {
    const all = listSword1Audio({ names, windowsDemo: true, hasSample: (id) => id === 0x0c000006 });
    const effects = all.filter((track) => track.resource?.kind === 'effects');
    expect(effects.map((track) => track.name)).toEqual(['Effect 1']);
  });

  it('carries a speech line’s screen in its bank, and calls it a wav', () => {
    // The two numbers are not interchangeable: line 3 names three thousand
    // recordings and screen 12 line 3 names one. And the format is `wav`
    // because `sword1AudioReader` hands over a real WAVE — the container's own
    // bytes are Revolution's RLE, which nothing downstream decodes.
    const tracks = listSword1Audio({
      names,
      windowsDemo: true,
      hasSample: () => false,
      speech: {
        file: 'SPEECH/COWS.MAD',
        entries: [{ room: 145, line: 251, at: 100, length: 20, lengthAt: 8 }],
      },
    });
    const speech = tracks[tracks.length - 1];
    expect(speech.name).toBe('Speech, screen 145 line 251');
    expect(speech.resource).toMatchObject({ kind: 'speech', number: 251, bank: 145 });
    expect(speech.format).toBe('wav');
  });

  it('numbers its own rows rather than reusing the game’s numbers', () => {
    // A tune 1, an effect 1 and a speech line 1 all exist, so the game's
    // numbers would collide as project ids. They live on `resource` instead.
    const tracks = listSword1Audio({
      names,
      windowsDemo: true,
      hasSample: (id) => id === 0x0c000006,
      speech: {
        file: 'SPEECH/COWS.MAD',
        entries: [{ room: 1, line: 1, at: 0, length: 4, lengthAt: 8 }],
      },
    });
    expect(tracks.map((track) => track.id)).toEqual([1, 2, 3]);
  });
});

describe('listing what a Broken Sword II release has to listen to', () => {
  it('decides the kind by the cluster a sound lives in', () => {
    // A `WAV_FILE` header says nothing about whether it is a line, a tune or a
    // footstep. Where it was packaged is the whole of the evidence.
    expect(sword2AudioKind('speech1.clu')).toBe('speech');
    expect(sword2AudioKind('MUSIC.CLU')).toBe('music');
    expect(sword2AudioKind('general.clu')).toBe('effects');
  });

  it('sorts music, then effects, then speech, and keeps the game’s number', () => {
    const entries: Sword2AudioEntry[] = [
      { id: 719, name: 'Wav fxwater11', bytes: 204092, cluster: 'general.clu' },
      { id: 40, name: '', bytes: 900, cluster: 'speech1.clu' },
      { id: 7, name: 'Wav m1', bytes: 5000, cluster: 'music1.clu' },
    ];
    const tracks = listSword2Audio({ entries });
    expect(tracks.map((track) => track.resource?.kind)).toEqual(['music', 'effects', 'speech']);
    expect(tracks.map((track) => track.id)).toEqual([1, 2, 3]);
    expect(tracks[1].name).toBe('Wav fxwater11 (719)');
    expect(tracks[1].bytes).toBe(204092);
    // A resource with no name in its header still says which number it is.
    expect(tracks[2].name).toBe('Speech 40');
  });

  it('carries the container a line was read out of, when it came from one', () => {
    // A retail release keeps speech and music in `speech1.clu` and
    // `music1.clu`, which `resource.inf` never names, so the entry's own file
    // is the only thing that says where to read it back from. An effect has
    // no file: it is a resource, and `resource.tab` says which cluster.
    const tracks = listSword2Audio({
      entries: [
        { id: 40, name: '', bytes: 900, cluster: 'speech1.clu', file: 'clusters/speech1.clu' },
        { id: 719, name: 'Wav fxwater11', bytes: 4, cluster: 'general.clu' },
      ],
    });
    const speech = tracks.find((track) => track.resource?.kind === 'speech')!;
    expect(speech.filename).toBe('clusters/speech1.clu');
    expect(speech.resource).toEqual({
      engine: 'sword2',
      kind: 'speech',
      number: 40,
      file: 'clusters/speech1.clu',
    });
    const effect = tracks.find((track) => track.resource?.kind === 'effects')!;
    expect(effect.filename).toBe('general.clu');
    expect(effect.resource).toEqual({ engine: 'sword2', kind: 'effects', number: 719 });
  });
});

// -------------------------------------------------------- where bytes live --

describe('finding a track’s bytes', () => {
  const original = Uint8Array.from([1, 1, 1, 1]);
  const replacement = Uint8Array.from([2, 2]);

  function gameTrack(): ProjectAudio {
    return {
      id: 1,
      name: 'Effect 1',
      format: 'wav',
      filename: 'fx1.wav',
      resource: { engine: 'sword1', kind: 'effects', number: 1 },
    };
  }

  it('prefers a replacement over the game’s own recording', async () => {
    // The order this is written in is the whole of the fix. A replaced
    // recording keeps its `resource` — that is how an export knows which of
    // the game's sounds it stands in for — so asking the game first plays the
    // original over the top of every replacement, which reads as a Replace
    // button that silently does nothing.
    setAudioResourceReader(async () => original);
    try {
      const track = { ...gameTrack(), data: toBase64(replacement) };
      expect([...(await readTrackBytes(track))!]).toEqual([...replacement]);
      expect([...(await readTrackBytes(gameTrack()))!]).toEqual([...original]);
    } finally {
      setAudioResourceReader(null);
    }
  });

  it('says nothing rather than throwing when no folder is open', async () => {
    setAudioResourceReader(null);
    expect(await readTrackBytes(gameTrack())).toBeNull();
  });

  it('names the place the folder button actually is, per family', async () => {
    // A message that sends somebody to a pane with no such button is worse
    // than one that names none. AGOS's sits above its properties; both Broken
    // Swords put theirs at the top of the Audio section itself.
    expect(missingBytesReason(gameTrack())).toContain('top of this section');
    const agos: ProjectAudio = {
      ...gameTrack(),
      resource: { engine: 'agos', kind: 'speech', number: 1 },
    };
    expect(missingBytesReason(agos)).toContain('bar above the properties');
  });
});

// ------------------------------------------------------ re-supplied folders --

describe('re-supplying a Broken Sword folder', () => {
  it('accepts the folder the project was imported beside', async () => {
    const folder = await readSword1GameFolder(
      'bs1',
      sword1Files(),
      sword1Project('demo', ['GENERAL']),
    );
    expect(typeof folder).not.toBe('string');
    if (typeof folder === 'string') return;
    expect(folder.windowsDemo).toBe(true);
    expect(folder.clusterFiles.get('GENERAL')).toBe('bs1/CLUSTERS/GENERAL.CLU');
    expect(folder.speech?.file).toBe('bs1/SPEECH/COWS.MAD');
  });

  it('refuses a different release, and says what would have gone wrong', async () => {
    // Not a failure to open: a `cd` folder's effects are addressed through the
    // other column of the fx table, so its recordings would play under the
    // wrong numbers rather than not play at all.
    const refusal = await readSword1GameFolder('bs1', sword1Files(), sword1Project('cd', []));
    expect(typeof refusal).toBe('string');
    expect(refusal as string).toMatch(/demo release and this project was imported from the cd/);
  });

  it('finds a sound container beside the clusters, which the index never names', async () => {
    const folder = await readSword2GameFolder(
      'bs2',
      sword2FilesWithSpeech(),
      sword2Project(['general.clu']),
    );
    if (typeof folder === 'string') throw new Error(folder);
    expect(folder.resources.soundFiles.map((found) => found.name)).toEqual(['speech1.clu']);
    const index = await folder.resources.readSoundIndex(folder.resources.soundFiles[0]!.file);
    // Three slots, two recordings: the middle line is one the release never
    // made, and the index says so with a zero offset and a zero length.
    expect(index?.count).toBe(3);
    expect(index?.entries().map((entry) => entry.index)).toEqual([0, 2]);
  });

  it('reads a line out of a container as a WAVE, decoded', async () => {
    const folder = await readSword2GameFolder(
      'bs2',
      sword2FilesWithSpeech(),
      sword2Project(['general.clu']),
    );
    if (typeof folder === 'string') throw new Error(folder);
    const bytes = await sword2AudioReader(folder)({
      engine: 'sword2',
      kind: 'speech',
      number: 2,
      file: 'bs2/clusters/speech1.clu',
    });
    expect(bytes).not.toBeNull();
    expect(String.fromCharCode(...bytes!.slice(0, 4))).toBe('RIFF');
    const samples = new Int16Array(bytes!.buffer, bytes!.byteOffset + 44, (bytes!.length - 44) / 2);
    expect([...samples]).toEqual([...SPEECH_LINES[1]!]);
  });

  it('answers nothing for a line the container never recorded', async () => {
    const folder = await readSword2GameFolder(
      'bs2',
      sword2FilesWithSpeech(),
      sword2Project(['general.clu']),
    );
    if (typeof folder === 'string') throw new Error(folder);
    const bytes = await sword2AudioReader(folder)({
      engine: 'sword2',
      kind: 'speech',
      number: 1,
      file: 'bs2/clusters/speech1.clu',
    });
    expect(bytes).toBeNull();
  });

  it('refuses a folder short of a cluster the project was imported beside', async () => {
    const refusal = await readSword1GameFolder(
      'bs1',
      sword1Files(),
      sword1Project('demo', ['GENERAL', 'PARIS1']),
    );
    expect(refusal as string).toContain('PARIS1');
  });

  it('refuses a folder with no cluster index', async () => {
    const refusal = await readSword1GameFolder(
      'bs1',
      sword1Files({ rif: false }),
      sword1Project('demo', []),
    );
    expect(refusal as string).toContain('swordres.rif');
  });

  it('refuses a project that is not Broken Sword’s at all', async () => {
    const refusal = await readSword1GameFolder('bs1', sword1Files(), createProject('SCUMM'));
    expect(refusal).toBe('This is not a Broken Sword project.');
  });
});

describe('reading one of Broken Sword’s own recordings back', () => {
  async function reader() {
    const folder = await readSword1GameFolder(
      'bs1',
      sword1Files(),
      sword1Project('demo', ['GENERAL']),
    );
    if (typeof folder === 'string') throw new Error(folder);
    return sword1AudioReader(folder);
  }

  it('reads an effect by range out of the cluster the index names', async () => {
    // By range and not through `SwordResources`: that class answers only for a
    // resident cluster, and making `PARIS1.CLU` resident is 13.5 MB held to
    // hand back a twenty-kilobyte footstep.
    const bytes = await (await reader())({ engine: 'sword1', kind: 'effects', number: 1 });
    expect([...(bytes ?? [])]).toEqual([...EFFECT_BYTES]);
  });

  it('reads a tune as the file beside the game that the tune table names', async () => {
    const bytes = await (await reader())({ engine: 'sword1', kind: 'music', number: 1 });
    expect([...(bytes ?? [])]).toEqual([...TUNE_BYTES]);
  });

  it('hands speech over as a real WAVE rather than as the container’s RLE', async () => {
    const bytes = await (
      await reader()
    )({
      engine: 'sword1',
      kind: 'speech',
      number: 1,
      bank: 1,
    });
    expect(bytes).not.toBeNull();
    const wave = bytes!;
    expect(String.fromCharCode(...wave.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wave.slice(8, 12))).toBe('WAVE');
    const samples = new Int16Array(wave.buffer, wave.byteOffset + 44, (wave.length - 44) / 2);
    // The first two are the length the stream carried in place of a header,
    // blanked; the rest are the line.
    expect([...samples]).toEqual([0, 0, 100, 101, 102, -5, -5, -5]);
  });

  it('answers nothing for a line this release never recorded', async () => {
    const bytes = await (await reader())({ engine: 'sword1', kind: 'speech', number: 9, bank: 1 });
    expect(bytes).toBeNull();
  });

  it('answers nothing for another family’s resource', async () => {
    expect(await (await reader())({ engine: 'sword2', kind: 'effects', number: 1 })).toBeNull();
  });
});

describe('the WAVE a decoded line is wrapped in', () => {
  it('declares mono 16-bit PCM at the family’s 11.025 kHz', () => {
    const wave = waveOf(Int16Array.from([1, -1]), 11025);
    const view = new DataView(wave.buffer, wave.byteOffset, wave.byteLength);
    expect(wave.length).toBe(48);
    expect(view.getUint32(4, true)).toBe(36 + 4); // RIFF size: everything after it
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(11025);
    expect(view.getUint32(28, true)).toBe(11025 * 2); // bytes per second
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(4); // data length
  });
});

describe('re-supplying a Broken Sword II folder', () => {
  it('accepts the folder and reads a sound out of it by id', async () => {
    const folder = await readSword2GameFolder('bs2', sword2Files(), sword2Project(['general.clu']));
    expect(typeof folder).not.toBe('string');
    if (typeof folder === 'string') return;
    // The payload rather than the whole resource: the 44-byte header in front
    // of it is the game's bookkeeping, and a file saved with it on the front
    // is a WAVE nothing will open.
    const bytes = await sword2AudioReader(folder)({ engine: 'sword2', kind: 'effects', number: 1 });
    expect([...(bytes ?? [])]).toEqual([...WAV_PAYLOAD]);
  });

  it('refuses a folder short of a cluster the project was imported beside', async () => {
    // `docks.clu` is named by `resource.inf` and is not in the folder, which
    // is the case the index's own cluster list cannot see: it lists what the
    // release was built with rather than what arrived.
    const refusal = await readSword2GameFolder(
      'bs2',
      sword2Files(),
      sword2Project(['general.clu', 'docks.clu']),
    );
    expect(refusal as string).toContain('docks.clu');
  });

  it('refuses a folder that is not a Broken Sword II install', async () => {
    const refusal = await readSword2GameFolder(
      'bs2',
      [pathed('bs2/readme.txt', Uint8Array.of(0))],
      sword2Project([]),
    );
    expect(refusal as string).toContain('resource.inf');
  });

  it('refuses a project that is not Broken Sword II’s at all', async () => {
    const refusal = await readSword2GameFolder('bs2', sword2Files(), createProject('SCUMM'));
    expect(refusal).toBe('This is not a Broken Sword II project.');
  });
});

// ------------------------------------------------------------- the surface --

describe('the Audio section’s replace button', () => {
  const tracks: ProjectAudio[] = [
    {
      id: 1,
      name: 'Effect 1',
      format: 'wav',
      filename: 'fx1.wav',
      resource: { engine: 'sword1', kind: 'effects', number: 1 },
    },
  ];

  function sectionOptions(replace?: AudioSectionOptionsReplace) {
    return {
      tracks: () => tracks,
      add: async () => tracks[0],
      remove: () => undefined,
      rename: () => undefined,
      ...(replace ? { replace } : {}),
    };
  }

  it('is on every row where the surface can write a replacement back', () => {
    const section = new AudioSection(sectionOptions(async () => tracks[0]));
    const body = document.createElement('div');
    section.render(body);
    expect(body.querySelectorAll('button.audio-replace')).toHaveLength(1);
  });

  it('is absent where it would import a file into a void', () => {
    // A project whose audio is the author's own imports has no notion of "the
    // recording this stands in for", so remove-and-import already covers it.
    const section = new AudioSection(sectionOptions());
    const body = document.createElement('div');
    section.render(body);
    expect(body.querySelectorAll('button.audio-replace')).toHaveLength(0);
  });

  it('draws a surface’s own header above the rows', () => {
    const section = new AudioSection({
      ...sectionOptions(),
      header: (body) => {
        const bar = document.createElement('div');
        bar.className = 'sword-folder-bar';
        body.appendChild(bar);
      },
    });
    const body = document.createElement('div');
    section.render(body);
    expect(body.firstElementChild?.className).toBe('sword-folder-bar');
  });
});

type AudioSectionOptionsReplace = (
  id: number,
  filename: string,
  bytes: Uint8Array,
) => Promise<ProjectAudio | null>;

describe('replacing one of the game’s recordings', () => {
  function projectWithGameAudio(): Project {
    return {
      ...createProject('Broken Sword'),
      audio: [
        {
          id: 4,
          name: 'Effect 1',
          format: 'wav',
          filename: 'fx1.wav',
          resource: { engine: 'sword1', kind: 'effects', number: 1 },
        },
      ],
    };
  }

  it('keeps the id and the resource, and puts the new bytes behind them', async () => {
    // Both have to survive. The id is what a `playSound` action says, and the
    // resource is which of the game's own sounds this one stands in for —
    // without it an export has nowhere to put the replacement.
    const state = new EditorState(projectWithGameAudio());
    const bytes = new Uint8Array(64);
    bytes.set([0x52, 0x49, 0x46, 0x46]);

    const replaced = await state.replaceAudio(4, 'door.wav', bytes);
    expect(replaced?.id).toBe(4);
    expect(replaced?.resource).toEqual({ engine: 'sword1', kind: 'effects', number: 1 });
    expect(replaced?.filename).toBe('door.wav');
    expect(state.current.audio).toHaveLength(1);
    expect([...(await readTrackBytes(state.current.audio[0]))!]).toEqual([...bytes]);
  });

  it('says nothing for a track that is not there', async () => {
    const state = new EditorState(projectWithGameAudio());
    expect(await state.replaceAudio(99, 'door.wav', new Uint8Array(4))).toBeNull();
  });
});

describe('the Audio section on both Broken Sword surfaces', () => {
  function section(): AudioSection {
    return new AudioSection({
      tracks: () => [],
      add: async () => ({ id: 1, name: 'a', format: 'wav', filename: 'a.wav' }),
      remove: () => undefined,
      rename: () => undefined,
    });
  }

  const surfaces = [
    {
      name: 'Broken Sword',
      build: (options: Sword1EditorOptions) => new Sword1Editor(options).element,
      project: () => sword1Project('demo', []),
    },
    {
      name: 'Broken Sword II',
      build: (options: Sword1EditorOptions) => new Sword2Editor(options).element,
      project: () => sword2Project([]),
    },
  ];

  for (const surface of surfaces) {
    it(`${surface.name} points the shared section at itself on every render`, () => {
      // The hooks are re-pointed in `renderList`, not in the Audio pane's own
      // render. One section instance is shared between the families, so a
      // surface that only claimed it when its Audio pane was open would leave
      // another family's `onChanged` in place — which redraws a sidebar this
      // surface does not have, and looks exactly like a play button that does
      // nothing.
      const audio = section();
      const stale = (): void => undefined;
      audio.onChanged = stale;
      const project = surface.project();
      surface.build({ project: () => project, update: (mutate) => mutate(project), audio });
      expect(audio.onChanged).not.toBe(stale);
    });

    it(`${surface.name} offers the folder the recordings are read from`, async () => {
      const audio = section();
      const project = surface.project();
      let asked = 0;
      const element = surface.build({
        project: () => project,
        update: (mutate) => mutate(project),
        audio,
        folderName: () => null,
        openGameFolder: async () => {
          asked++;
          return 'That folder is the cd release and this project is the demo.';
        },
      });

      const open = (label: string): HTMLButtonElement | undefined =>
        [...element.querySelectorAll('button')].find((button) =>
          (button.textContent ?? '').includes(label),
        );
      // The sidebar is an accordion now, and Audio is not one of the sections
      // it opens with — so the row has to be reached the way a person reaches
      // it, by opening the section that holds it.
      const audioHead = [...element.querySelectorAll<HTMLButtonElement>('.accordion-head')].find(
        (button) => button.querySelector('.accordion-title')?.textContent === 'Audio',
      );
      if (audioHead?.getAttribute('aria-expanded') === 'false') audioHead.click();
      open('recordings')!.click();
      const folderButton = open('Open game folder');
      expect(folderButton).toBeDefined();

      folderButton!.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(asked).toBe(1);
      // The refusal is shown beside the button that would try again, rather
      // than being swallowed into a folder that silently stayed shut.
      expect(element.textContent).toContain('cd release');
    });
  }
});
