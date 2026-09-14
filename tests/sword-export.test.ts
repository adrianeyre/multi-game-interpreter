import { describe, expect, it } from 'vitest';
import { exportSword1Game, Sword1ExportError } from '../src/authoring/sword1/export.js';
import { exportSword2Game, Sword2ExportError } from '../src/authoring/sword2/export.js';
import { Sword2EditError } from '../src/authoring/sword2/edits.js';
import { importSword1Project } from '../src/authoring/sword1/import.js';
import { importSword2Project } from '../src/authoring/sword2/import.js';
import { SwordResources } from '../src/engine/sword1/resource/SwordResources.js';
import { Sword2Resources } from '../src/engine/sword2/resource/Sword2Resources.js';
import { identifySword1 } from '../src/engine/sword1/resource/swordDetect.js';
import { identifySword2 } from '../src/engine/sword2/resource/sword2Detect.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { resourceId } from '../src/engine/sword1/resource/rif.js';
import { parseSword1SpeechIndex } from '../src/engine/sword1/sound/speechIndex.js';
import { compressSpeech, expandSpeech } from '../src/engine/sword1/sound/swordAudio.js';
import { writeWavePcm } from '../src/engine/sound/wave.js';
import {
  appendSword1Compact,
  deleteSword1Compact,
  editSword1StartPosition,
  editSword1TextLine,
  replaceSword1Picture,
  sword1CompactDeleteRefusal,
} from '../src/authoring/sword1/edits.js';
import { readSword1Executable } from '../src/authoring/sword1/executable.js';
import { sword1PicturePixels } from '../src/editor/sword1/pictureFiles.js';
import {
  appendSword2Object,
  deleteSword2Object,
  editSword2Global,
  editSword2PaletteColour,
  editSword2RunList,
  editSword2TextLine,
  replaceSword2AnimationFrame,
  replaceSword2ScreenLayer,
  sword2ObjectDeleteRefusal,
} from '../src/authoring/sword2/edits.js';
import { sword2PicturePixels, sword2ScreenLayerPixels } from '../src/editor/sword2/pictureFiles.js';
import type { Project } from '../src/authoring/project.js';
import { IT } from '../src/engine/sword1/script/swordTokens.js';
import { CP } from '../src/engine/sword2/script/sword2Tokens.js';
import { SWORD1_COMPACT_WORDS } from '../src/engine/sword1/resource/swordCompact.js';
import { RES_HEADER_SIZE, Sword2FileType } from '../src/engine/sword2/resource/sword2Headers.js';
import {
  encodeSword2Clu,
  parseSword2CluIndex,
  SWORD2_CLU_RATE,
} from '../src/engine/sword2/sound/sword2Clu.js';
import { readSword2Sound } from '../src/authoring/sword2/soundContainer.js';
import type { Sword2FixtureCluster, SwordFixtureCluster } from './fixtureSword.js';
import {
  buildCompactResource,
  buildScriptResource,
  buildSpriteResource,
  buildSwordFixture,
  buildSword2Anim,
  buildSword2Fixture,
  buildSword2Globals,
  buildSword2Screen,
  buildSword2Object,
  buildSword2RunList,
  buildSword2Text,
  buildTextResource,
  sword1ExecutableWithRooms,
  sword1ExecutableWithStarts,
  sword2Header,
  Writer,
} from './fixtureSword.js';

const SCRIPT = [IT.PUSHNUMBER, 1, IT.POPVAR, 0, IT.SCRIPTEND];

/**
 * A speech container with one room and two lines in it.
 *
 * Small on purpose: what these tests are about is that the export reaches the
 * file at all and reports what it did, and the container's own layout has its
 * own suite in `sword1-speech-export.test.ts`.
 */
function speechContainer(): { name: string; data: Uint8Array } {
  const line = (samples: Int16Array): Uint8Array => {
    const stated = (samples.length + 2) * 2;
    const full = new Int16Array(samples.length + 2);
    full[0] = stated & 0xffff;
    full[1] = stated >>> 16;
    full.set(samples, 2);
    const runs = compressSpeech(full);
    const out = new Uint8Array(40 + runs.length);
    const view = new DataView(out.buffer);
    const put = (at: number, text: string): void => {
      for (let index = 0; index < text.length; index++) out[at + index] = text.charCodeAt(index);
    };
    put(0, 'RIFF');
    view.setUint32(4, 36 + stated, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 11025, true);
    view.setUint32(28, 22050, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    put(36, 'data');
    out.set(runs, 40);
    return out;
  };

  const first = line(Int16Array.from([5, 5, 5, 9, 3, 7, 7]));
  const second = line(Int16Array.from([1, 2, 2, 2, 8]));
  const words = new Uint32Array(7);
  const indexBytes = (words.length + 1) * 4;
  // Room 0's block begins at word 2, and a line's pair is read one word early:
  // line n's length is at `base + n * 2` with its offset in the word before.
  words[0] = 2 * 4;
  words[3] = 0;
  words[4] = first.length;
  words[5] = first.length;
  words[6] = second.length;

  const data = new Uint8Array(indexBytes + first.length + second.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, indexBytes, true);
  for (let word = 0; word < words.length; word++) view.setUint32(4 + word * 4, words[word]!, true);
  data.set(first, indexBytes);
  data.set(second, indexBytes + first.length);
  return { name: 'SPEECH/COWS.MAD', data };
}

/** A minimal but complete Broken Sword install, cluster order as the ids need. */
function sword1Install(extra: readonly SwordFixtureCluster[] = []) {
  const compact = new Array(SWORD1_COMPACT_WORDS).fill(0);
  return buildSwordFixture([
    {
      label: 'SCRIPTS',
      groups: 2,
      resources: [
        { group: 0, index: 0, bytes: buildScriptResource([SCRIPT]) },
        { group: 1, index: 0, bytes: buildScriptResource([SCRIPT]) },
      ],
    },
    {
      label: 'COMPACTS',
      groups: 2,
      resources: [
        { group: 0, index: 0, bytes: buildCompactResource([compact]) },
        { group: 1, index: 0, bytes: buildCompactResource([compact]) },
      ],
    },
    {
      label: 'TEXT',
      groups: 1,
      resources: [{ group: 0, index: 0, bytes: buildTextResource(['one', '', 'three']) }],
    },
    {
      label: 'GENERAL',
      groups: 1,
      resources: [{ group: 0, index: 0, bytes: new Uint8Array(32).fill(3) }],
    },
    ...extra,
  ]);
}

/**
 * The two clusters a picture needs, to put behind the four above.
 *
 * A background is found by its id in the room table and by nothing else, and
 * screen 2's first layer is `0x06020001` — cluster 5, group 2, index 1 — so an
 * install that holds one has to have a sixth cluster for it to be in. It
 * carries no resource header: a background *is* its 640x400 pixels, which is
 * the measured shape of every one of them and the reason the exporter has to
 * substitute it whole rather than behind a header.
 *
 * A sprite is found by its header type instead, so it can sit anywhere; it is
 * put in the same cluster to keep the fixture small.
 */
function pictureClusters(): SwordFixtureCluster[] {
  const background = new Uint8Array(640 * 400).fill(11);
  return [
    // Empty, and there only to put PARIS1 at the cluster number its ids name.
    { label: 'MAPS', groups: 1, resources: [] },
    {
      label: 'PARIS1',
      groups: 3,
      resources: [
        { group: 2, index: 1, bytes: background },
        {
          // Index 7, because the room table already spends 0 on screen 2's
          // palette and 1 to 3 on its layers.
          group: 2,
          index: 7,
          bytes: buildSpriteResource(
            [
              { width: 2, height: 2, pixels: Uint8Array.from([1, 2, 3, 4]) },
              { width: 3, height: 1, pixels: Uint8Array.from([9, 5, 9]) },
            ],
            'Sprite',
          ),
        },
      ],
    },
  ];
}

/** Reads an export back in, which is the only way to read the rebuilt cluster. */
async function reimportSword1(report: { files: readonly { name: string; data: Uint8Array }[] }) {
  const entries: Array<[string, Uint8Array]> = report.files.map((file) => [file.name, file.data]);
  const resources = await SwordResources.create(new MemoryDataSource('exported', entries));
  for (const label of resources.availableClusters) await resources.loadCluster(label, true);
  return importSword1Project(resources, identifySword1(['swordres.rif', 'paris2.clu']));
}

/** The same fixture install, imported with executables beside its clusters. */
async function importWith(
  source: Parameters<typeof exportSword1Game>[0],
  executables: ReadonlyArray<{ name: string; data: Uint8Array }>,
) {
  const entries: Array<[string, Uint8Array]> = [[source.indexFile, source.index]];
  for (const cluster of source.clusters) entries.push([cluster.name, cluster.data]);
  const resources = await SwordResources.create(new MemoryDataSource('fixture', entries));
  for (const label of resources.availableClusters) await resources.loadCluster(label, true);
  return importSword1Project(
    resources,
    identifySword1(['swordres.rif', 'paris2.clu']),
    executables.map((each) => readSword1Executable(each.name, each.data)),
  );
}

async function sword1Project(extra: readonly SwordFixtureCluster[] = []): Promise<{
  project: Project;
  source: Parameters<typeof exportSword1Game>[0];
}> {
  const fixture = sword1Install(extra);
  const entries: Array<[string, Uint8Array]> = [['clusters/swordres.rif', fixture.rif]];
  for (const [label, bytes] of fixture.clusters) entries.push([`clusters/${label}.CLU`, bytes]);
  const resources = await SwordResources.create(new MemoryDataSource('fixture', entries));
  for (const label of resources.availableClusters) await resources.loadCluster(label, true);
  const sword1 = importSword1Project(resources, identifySword1(['swordres.rif', 'paris2.clu']));

  return {
    project: {
      version: 6,
      target: { engine: 'sword1', release: 'cd', platform: 'dos' },
      name: 'fixture',
      start: { room: 1, x: 0, y: 0 },
      defaultResponse: '',
      screen: { textHeight: 40, verbTop: 0 },
      verbs: [],
      actors: [],
      rooms: [],
      scripts: [],
      audio: [],
      sword1,
    },
    source: {
      indexFile: 'clusters/swordres.rif',
      index: fixture.rif,
      clusters: [...fixture.clusters].map(([label, data]) => ({
        name: `clusters/${label}.CLU`,
        label,
        data,
      })),
    },
  };
}

describe('exporting Broken Sword', () => {
  it('writes every cluster and the index back', async () => {
    const { project, source } = await sword1Project();
    const report = exportSword1Game(source, project.sword1!);
    const names = report.files.map((file) => file.name).sort();
    expect(names).toContain('clusters/swordres.rif');
    expect(names).toContain('clusters/SCRIPTS.CLU');
    expect(names).toContain('clusters/GENERAL.CLU');
  });

  it('re-emits an untouched install byte-identically', async () => {
    // The property the whole exporter exists for: a diff of an exported install
    // is the author's changes and nothing else.
    const { project, source } = await sword1Project();
    const report = exportSword1Game(source, project.sword1!);
    for (const file of report.files) {
      const original =
        file.name === source.indexFile
          ? source.index
          : source.clusters.find((cluster) => cluster.name === file.name)?.data;
      expect(original, `no original for ${file.name}`).toBeDefined();
      expect(Array.from(file.data), file.name).toEqual(Array.from(original as Uint8Array));
    }
  });

  /*
   * The interpreter, which holds two surfaces no cluster does.
   *
   * These two tests are the pair that makes `rooms` an editable surface rather
   * than an editable-and-unwritable one: an export handed the executables and
   * given nothing to change hands them back byte for byte, and an export given
   * one start position to move changes that placement's field and nothing else
   * in 600 KB of code.
   */
  it('carries the executables out byte-identically when nothing was edited', async () => {
    const { source } = await sword1Project();
    const exe = { name: 'SWORD.EXE', data: sword1ExecutableWithRooms(0x1234) };
    const runner = { name: 'RUNSWORD.EXE', data: Uint8Array.from({ length: 512 }, (_, at) => at) };
    const sword1 = await importWith(source, [exe, runner]);
    const report = exportSword1Game({ ...source, executables: [exe, runner] }, sword1);
    for (const file of [exe, runner]) {
      const written = report.files.find((each) => each.name === file.name);
      expect(written, file.name).toBeDefined();
      expect(Array.from(written!.data), file.name).toEqual(Array.from(file.data));
    }
    // The launcher holds neither table and is still carried: a file the export
    // was handed is a file the export is responsible for putting back.
    expect(report.executables.map((each) => each.file)).toEqual(['SWORD.EXE', 'RUNSWORD.EXE']);
    for (const each of report.executables) expect(each.edits).toEqual([]);
  });

  it('writes a moved start position into the executable it was read from, and only there', async () => {
    const { source } = await sword1Project();
    const placements = [
      { x: 481, y: 413, direction: 4, place: 0x10000 },
      { x: 300, y: 388, direction: 2, place: 0x10001 },
      { x: 128, y: 400, direction: 7, place: 0x30004 },
      { x: -20, y: 260, direction: 0, place: 0x50002 },
      { x: 640, y: 300, direction: 6, place: 0x50003 },
      { x: 96, y: 355, direction: 1, place: 0x60000 },
      { x: 512, y: 420, direction: 3, place: 0x60001 },
      { x: 220, y: 390, direction: 5, place: 0x70000 },
      { x: 333, y: 333, direction: 2, place: 0x70001 },
    ];
    const exe = { name: 'SWORD.EXE', data: sword1ExecutableWithStarts(0x7f24, placements) };
    const sword1 = await importWith(source, [exe]);
    expect(sword1.startPositions?.length).toBe(placements.length);
    expect(sword1.interpreter?.startPositions).toBe('SWORD.EXE');
    expect(sword1.surfaces.startPositions).toBe('editable');

    const project = {
      version: 6,
      target: { engine: 'sword1', release: 'cd', platform: 'dos' },
      name: 'fixture',
      start: { room: 1, x: 0, y: 0 },
      defaultResponse: '',
      screen: { textHeight: 40, verbTop: 0 },
      verbs: [],
      actors: [],
      rooms: [],
      scripts: [],
      audio: [],
      sword1,
    } as unknown as Project;
    editSword1StartPosition(project, 2, { x: 200, direction: 1 });

    const report = exportSword1Game({ ...source, executables: [exe] }, project.sword1!);
    const written = report.files.find((each) => each.name === 'SWORD.EXE')!;
    const differing: number[] = [];
    for (let at = 0; at < exe.data.length; at++) {
      if (exe.data[at] !== written.data[at]) differing.push(at);
    }
    const named = report.executables[0]!.edits;
    expect(named.map((edit) => edit.what)).toEqual([
      "start position 2's x",
      "start position 2's direction",
    ]);
    // Every byte that moved is inside a field the edit named, which is the
    // claim: not "the file changed" but "only these bytes changed".
    for (const at of differing) {
      expect(named.some((edit) => at >= edit.at && at < edit.at + 4)).toBe(true);
    }
    expect(differing.length).toBeGreaterThan(0);
  });

  it('leaves the speech container alone unless it is handed one', async () => {
    // Not a gap: the container is 43.9 MB in the demo and 45.5 MB on a retail
    // disc, so an export with no line to replace has no reason to carry a copy
    // of it. What matters is that it says so rather than implying it wrote one.
    const { project, source } = await sword1Project();
    const report = exportSword1Game(source, project.sword1!);
    expect(report.speech).toBeNull();
    expect(report.files.some((file) => /cows\.mad$/i.test(file.name))).toBe(false);
  });

  it('rebuilds the speech container, and copies it when nothing was replaced', async () => {
    const { project, source } = await sword1Project();
    const speech = speechContainer();
    const report = exportSword1Game({ ...source, speech: { ...speech } }, project.sword1!);
    const written = report.files.find((file) => file.name === 'SPEECH/COWS.MAD');
    expect(written).toBeDefined();
    expect(Array.from(written!.data)).toEqual(Array.from(speech.data));
    expect(report.speech).toEqual({ file: 'SPEECH/COWS.MAD', replaced: [] });
  });

  it('carries a replaced line of speech out with the rest of the export', async () => {
    // The other half of `compressSpeech`, which until this had nothing to write
    // into: `exportSword1Game` rebuilt the clusters and the index and left the
    // speech where it was, so a line an author replaced played in the editor
    // and never in the game.
    const { project, source } = await sword1Project();
    const speech = speechContainer();
    const wanted = new Int16Array(64);
    for (let at = 0; at < wanted.length; at++) wanted[at] = Math.round(Math.sin(at / 3) * 5000);

    const report = exportSword1Game(
      {
        ...source,
        speech: {
          ...speech,
          replacements: [{ room: 0, line: 1, wav: writeWavePcm(wanted, 11025) }],
        },
      },
      project.sword1!,
    );
    expect(report.speech?.replaced).toEqual(['screen 0 line 1']);

    const written = report.files.find((file) => file.name === 'SPEECH/COWS.MAD')!.data;
    const index = parseSword1SpeechIndex('SPEECH/COWS.MAD', written)!;
    const entry = index.locate(0, 1)!;
    const decoded = expandSpeech(
      written.subarray(entry.at, entry.at + entry.length),
      false,
      'demo',
    );
    // The demo's first two samples are the length it states inside its own run
    // stream, which `expandSpeech` zeroes; the audio follows them.
    expect(Array.from(decoded.subarray(2))).toEqual(Array.from(wanted));
  });

  it('writes a replaced tune beside the install, and names it', async () => {
    // Music is the one kind that is not a resource at all: Broken Sword keeps
    // it as `MUSIC/1M10.WAV` beside the install and addresses it by name (ADR
    // 0029), so a replaced tune leaves as a file rather than through the index.
    const { project, source } = await sword1Project();
    const tune = writeWavePcm(Int16Array.from([1, -1, 2, -2]), 11025);
    const report = exportSword1Game(
      { ...source, music: [{ file: 'MUSIC/1M2.WAV', data: tune }] },
      project.sword1!,
    );
    expect(report.music).toEqual(['MUSIC/1M2.WAV']);
    const written = report.files.find((file) => file.name === 'MUSIC/1M2.WAV');
    expect(Array.from(written!.data)).toEqual(Array.from(tune));
    // And the index and clusters are still exactly what they were.
    expect(report.files.filter((file) => /\.CLU$/.test(file.name))).toHaveLength(
      source.clusters.length,
    );
  });

  it('substitutes a replaced effect into the cluster that holds it', async () => {
    // An effect is an ordinary cluster resource that begins `RIFF` with no
    // Sword1 header of its own, so it is replaced whole and the cluster is
    // relaid around it — which is why this reads it back through the game's
    // own reader rather than out of the exporter's buffer.
    const { project, source } = await sword1Project();
    const id = resourceId(3, 0, 0); // GENERAL, the fourth cluster in the fixture.
    const effect = writeWavePcm(Int16Array.from([5, 6, 7, 8, 9]), 11025);
    const report = exportSword1Game(
      { ...source, effects: [{ id, data: effect }] },
      project.sword1!,
    );

    const entries: Array<[string, Uint8Array]> = report.files.map((file) => [file.name, file.data]);
    const resources = await SwordResources.create(new MemoryDataSource('exported', entries));
    for (const label of resources.availableClusters) await resources.loadCluster(label, true);
    expect(Array.from(resources.fetch(id)!.bytes)).toEqual(Array.from(effect));
  });

  it('re-imports what it exported, so the round trip closes', async () => {
    const { project, source } = await sword1Project();
    const report = exportSword1Game(source, project.sword1!);
    const entries: Array<[string, Uint8Array]> = report.files.map((file) => [file.name, file.data]);
    const resources = await SwordResources.create(new MemoryDataSource('exported', entries));
    for (const label of resources.availableClusters) await resources.loadCluster(label, true);
    const again = importSword1Project(resources, identifySword1(['swordres.rif', 'paris2.clu']));
    expect(again.editable.unrecovered).toBe(0);
    expect(again.text[0].lines).toEqual(['one', '', 'three']);
    expect(again.scripts.every((script) => script.roundTrips)).toBe(true);
  });

  it('carries an edited line of text into the exported game', async () => {
    const { project, source } = await sword1Project();
    editSword1TextLine(project, project.sword1!.text[0].resource, 0, 'edited');
    const report = exportSword1Game(source, project.sword1!);
    expect(report.rewritten.length).toBeGreaterThan(0);

    const entries: Array<[string, Uint8Array]> = report.files.map((file) => [file.name, file.data]);
    const resources = await SwordResources.create(new MemoryDataSource('exported', entries));
    for (const label of resources.availableClusters) await resources.loadCluster(label, true);
    const again = importSword1Project(resources, identifySword1(['swordres.rif', 'paris2.clu']));
    // The hole survives the trip too, which is what keeps line numbers stable.
    expect(again.text[0].lines).toEqual(['edited', '', 'three']);
  });

  it('keeps the index’s shape when a resource changes length', async () => {
    const { project, source } = await sword1Project();
    // A much longer line moves every resource after it in TEXT.CLU.
    editSword1TextLine(project, project.sword1!.text[0].resource, 0, 'x'.repeat(400));
    const report = exportSword1Game(source, project.sword1!);
    const entries: Array<[string, Uint8Array]> = report.files.map((file) => [file.name, file.data]);
    const resources = await SwordResources.create(new MemoryDataSource('exported', entries));
    for (const label of resources.availableClusters) await resources.loadCluster(label, true);
    // Every id the original index held is still addressable at its own id.
    expect(resources.allIds()).toEqual(
      await (async () => {
        const fixture = sword1Install();
        const original: Array<[string, Uint8Array]> = [['swordres.rif', fixture.rif]];
        for (const [label, bytes] of fixture.clusters) original.push([`${label}.CLU`, bytes]);
        const before = await SwordResources.create(new MemoryDataSource('before', original));
        return before.allIds();
      })(),
    );
  });

  it('carries a painted background into the exported game', async () => {
    // The measurement this closes: before it, `SWORD1_SURFACES.pictures` said
    // `editable-not-writable` because the encoders existed and the exporter
    // never called them — a picture an author painted could not leave the
    // editor. Paint one pixel, export, and read that pixel back out of the
    // rebuilt cluster.
    const { project, source } = await sword1Project(pictureClusters());
    const background = project.sword1!.pictures.find((picture) => picture.kind === 'background');
    expect(background, 'the fixture holds no background').toBeDefined();

    const painted = new Uint8Array(background!.width * background!.height).fill(11);
    const at = background!.width * 7 + 3;
    painted[at] = 42;
    replaceSword1Picture(
      project,
      background!.resource,
      0,
      painted,
      background!.width,
      background!.height,
    );

    const report = exportSword1Game(source, project.sword1!);
    expect(report.rewritten).toContain(background!.resource);
    const again = await reimportSword1(report);
    const written = again.pictures.find((picture) => picture.resource === background!.resource)!;
    expect(sword1PicturePixels(written, 0)!.pixels[at]).toBe(42);
  });

  it('carries an edited sprite frame into the exported game', async () => {
    // A sprite is the other half of the same measurement and the harder half:
    // it is a *headed* resource, so a re-encode that changes size has to leave
    // `comp_length` and `decomp_length` describing the new bytes rather than
    // the old ones. Substituting it whole would have left both stale.
    const { project, source } = await sword1Project(pictureClusters());
    const sprite = project.sword1!.pictures.find((picture) => picture.kind === 'sprite');
    expect(sprite, 'the fixture holds no sprite').toBeDefined();

    replaceSword1Picture(project, sprite!.resource, 1, Uint8Array.from([9, 6, 9]), 3, 1);
    const report = exportSword1Game(source, project.sword1!);
    expect(report.rewritten).toContain(sprite!.resource);
    const again = await reimportSword1(report);
    const written = again.pictures.find((picture) => picture.resource === sprite!.resource)!;
    expect([...sword1PicturePixels(written, 1)!.pixels]).toEqual([9, 6, 9]);
    // And the frame beside it is untouched, which is what says the rebuild put
    // the frame table back rather than rewrote the sprite.
    expect([...sword1PicturePixels(written, 0)!.pixels]).toEqual([1, 2, 3, 4]);
  });

  it('re-emits an install with pictures in it byte-identically', async () => {
    // Carrying pictures out must not cost the property the exporter exists
    // for: every picture is substituted on every export, edited or not, so a
    // substitution that is not exactly the bytes that arrived would show here.
    const { project, source } = await sword1Project(pictureClusters());
    expect(project.sword1!.pictures.length).toBeGreaterThan(0);
    const report = exportSword1Game(source, project.sword1!);
    for (const file of report.files) {
      const original =
        file.name === source.indexFile
          ? source.index
          : source.clusters.find((cluster) => cluster.name === file.name)?.data;
      expect(original, `no original for ${file.name}`).toBeDefined();
      expect(file.data.length, file.name).toBe((original as Uint8Array).length);
      expect(
        file.data.every((byte, at) => byte === (original as Uint8Array)[at]),
        file.name,
      ).toBe(true);
    }
  });

  it('refuses to write a script module that did not round-trip on import', async () => {
    const { project, source } = await sword1Project();
    (project.sword1!.scripts as unknown as Array<{ roundTrips: boolean }>)[0].roundTrips = false;
    expect(() => exportSword1Game(source, project.sword1!)).toThrow(Sword1ExportError);
    expect(() => exportSword1Game(source, project.sword1!)).toThrow(/misreading/);
  });

  it('refuses to write an edit into a cluster the folder does not hold', async () => {
    const { project, source } = await sword1Project();
    const short = { ...source, clusters: source.clusters.slice(1) };
    expect(() => exportSword1Game(short, project.sword1!)).toThrow(
      /which this folder does not hold/,
    );
  });

  it('carries an absent cluster through instead of refusing every real install', async () => {
    // Every shipped `swordres.rif` names both discs' clusters whichever disc it
    // was read from, so "a cluster is missing" is the normal case rather than a
    // fault: the demo declares fourteen and holds six. Refusing on absence
    // refused every install there is, which is what this exporter used to do.
    const { project, source } = await sword1Project();
    const dropped = source.clusters[source.clusters.length - 1]!;
    const short = { ...source, clusters: source.clusters.slice(0, -1) };
    const untouched = {
      ...project.sword1!,
      scripts: [],
      sections: [],
      text: [],
      palettes: [],
    };
    const report = exportSword1Game(short, untouched);
    expect(report.missing).toEqual([dropped.label]);
    expect(report.files.map((file) => file.name)).not.toContain(dropped.name);
    // And the index still names it, so re-supplying the other disc still works.
    const index = report.files.find((file) => file.name === source.indexFile)!;
    expect(Array.from(index.data)).toEqual(Array.from(source.index));
  });
});

/** A minimal Broken Sword II install. */
function sword2Install(extra: readonly Sword2FixtureCluster[] = []) {
  const script = [CP.PUSH_INT32, 1, 0, 0, 0, CP.POP_GLOBAL_VAR32, 62, 0, CP.END_SCRIPT];
  return buildSword2Fixture([
    {
      name: 'general.clu',
      resources: [
        { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'pointer', 0) },
        { id: 1, bytes: buildSword2Globals(new Array(64).fill(0)) },
        { id: 2, bytes: buildSword2RunList([8]) },
        { id: 8, bytes: buildSword2Object('george', [script, [CP.END_SCRIPT]]) },
      ],
    },
    {
      name: 'text.clu',
      // Real wav ids, because zero is the value a broken export writes and a
      // fixture of zeroes cannot tell the two apart.
      resources: [{ id: 9, bytes: buildSword2Text(['hello', 'again'], [3887, 3888]) }],
    },
    ...extra,
  ]);
}

/** A cluster with a sound resource in it, and a screen that is not one. */
function effectCluster(): Sword2FixtureCluster {
  return {
    name: 'sounds.clu',
    resources: [
      { id: 20, bytes: sword2Header(Sword2FileType.SCREEN_FILE, 'lobby', 0) },
      {
        id: 30,
        bytes: new Writer()
          .raw(sword2Header(Sword2FileType.WAV_FILE, 'Wav fxdoor', 4))
          .raw(waveBytes([1, 2]))
          .done(),
      },
    ],
  };
}

/** A PCM WAVE as an author would drop one on a row. */
function waveBytes(samples: readonly number[]): Uint8Array {
  return writeWavePcm(Int16Array.from(samples), SWORD2_CLU_RATE);
}

/** A speech container, laid out the way the retail format lays one out. */
function soundContainer(lines: ReadonlyArray<Int16Array>): Uint8Array {
  const payloads = lines.map((line) => encodeSword2Clu(line));
  const head = 8 + payloads.length * 8;
  const out = new Uint8Array(head + payloads.reduce((sum, one) => sum + one.length, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, payloads.length, true);
  let at = head;
  payloads.forEach((payload, index) => {
    view.setUint32(8 + index * 8, at, true);
    view.setUint32(8 + index * 8 + 4, payload.length, true);
    out.set(payload, at);
    at += payload.length;
  });
  return out;
}

/** The export read back as a resource set, for the checks that need one. */
async function sword2ResourcesOf(
  report: { files: readonly { name: string; data: Uint8Array }[] },
  fixture: { inf: Uint8Array; tab: Uint8Array; cdInf: Uint8Array },
): Promise<Sword2Resources> {
  const entries: Array<[string, Uint8Array]> = [
    ['resource.inf', fixture.inf],
    ['resource.tab', fixture.tab],
    ['cd.inf', fixture.cdInf],
    ...report.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
  ];
  return Sword2Resources.create(new MemoryDataSource('exported', entries));
}

/**
 * A third cluster, holding the two surfaces an export used to leave behind.
 *
 * The screen has a hole in its background — so the re-encode meets both of a
 * parallax row's two forms — and one mask layer, so there is a block after the
 * edited one for the rebuild to move and a set of offsets to shift.
 */
function pictureCluster(): Sword2FixtureCluster {
  return {
    name: 'docks.clu',
    resources: [
      {
        id: 20,
        bytes: buildSword2Screen(
          'lobby',
          8,
          4,
          3,
          { x: 2, y: 1, width: 3, height: 2 },
          { x: 0, y: 0, width: 4, height: 2, colour: 5 },
        ),
      },
      {
        id: 21,
        bytes: buildSword2Anim('walk', [
          { x: 1, y: 2, width: 2, height: 2, colour: 7 },
          { x: 3, y: 4, width: 2, height: 1, colour: 8 },
        ]),
      },
    ],
  };
}

/** Reads an export back in, which is the only way to read the rebuilt cluster. */
async function reimportSword2(
  report: { files: readonly { name: string; data: Uint8Array }[] },
  fixture: { inf: Uint8Array; tab: Uint8Array; cdInf: Uint8Array },
) {
  const entries: Array<[string, Uint8Array]> = [
    ['resource.inf', fixture.inf],
    ['resource.tab', fixture.tab],
    ['cd.inf', fixture.cdInf],
    ...report.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
  ];
  const resources = await Sword2Resources.create(new MemoryDataSource('exported', entries));
  for (const name of resources.presentClusters) await resources.loadCluster(name, true);
  return importSword2Project(
    resources,
    identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu']),
  );
}

async function sword2Project(extra: readonly Sword2FixtureCluster[] = []): Promise<{
  fixture: ReturnType<typeof sword2Install>;
  project: Project;
  source: Parameters<typeof exportSword2Game>[0];
}> {
  const fixture = sword2Install(extra);
  const entries: Array<[string, Uint8Array]> = [
    ['resource.inf', fixture.inf],
    ['resource.tab', fixture.tab],
    ['cd.inf', fixture.cdInf],
  ];
  for (const [name, bytes] of fixture.clusters) entries.push([name, bytes]);
  const resources = await Sword2Resources.create(new MemoryDataSource('fixture', entries));
  for (const name of resources.presentClusters) await resources.loadCluster(name, true);
  const sword2 = importSword2Project(
    resources,
    identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu']),
  );

  return {
    fixture,
    project: {
      version: 6,
      target: { engine: 'sword2', release: 'cd', platform: 'dos' },
      name: 'fixture',
      start: { room: 0, x: 0, y: 0 },
      defaultResponse: '',
      screen: { textHeight: 0, verbTop: 0 },
      verbs: [],
      actors: [],
      rooms: [],
      scripts: [],
      audio: [],
      sword2,
    },
    source: {
      declared: new TextDecoder('latin1')
        .decode(fixture.inf)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      clusters: [...fixture.clusters].map(([name, data]) => ({ name, data })),
      resourceTab: fixture.tab,
    },
  };
}

describe('exporting Broken Sword II', () => {
  it('re-emits an untouched install byte-identically', async () => {
    // The same property Sword 1's export is held to, and the one that says an
    // exported install differs from the original by the author's changes and
    // nothing else. It failed four ways at once against the demo: the objects'
    // resource headers were rewritten, the text modules were rebuilt with their
    // wav ids zeroed and their offsets measured from the wrong place, the
    // clusters were laid out in index order from offset 4 rather than in the
    // order and at the offsets they were already in, and the text edits were
    // dropped entirely.
    const { project, source } = await sword2Project();
    const report = exportSword2Game(source, project.sword2!);
    for (const file of report.files) {
      const original = source.clusters.find((cluster) => cluster.name === file.name)?.data;
      expect(original, `no original for ${file.name}`).toBeDefined();
      expect(Array.from(file.data), file.name).toEqual(Array.from(original as Uint8Array));
    }
  });

  it('keeps a cluster’s own layout, gaps and order included', async () => {
    // The demo's clusters do not hold their resources in index order and do not
    // start at offset 4: Players.clu's first entry sits 456,313 bytes in, and
    // SCRIPTS.CLU has 137 entries whose offset is not where the previous one
    // ended. Rebuilding in index order produced a working game that shared
    // almost no bytes with the one it was made from.
    const { project, source } = await sword2Project();
    const shuffled = source.clusters.map((cluster) => {
      if (cluster.name !== 'general.clu') return cluster;
      // Push everything 16 bytes along and reverse the tail's order, which is
      // the shape the shipped clusters have and no fixture otherwise builds.
      const view = new DataView(cluster.data.buffer, cluster.data.byteOffset);
      const tableOffset = view.getUint32(0, true);
      const count = (cluster.data.length - tableOffset) / 8;
      const moved = new Uint8Array(cluster.data.length + 16);
      moved.set(cluster.data.subarray(0, 4), 0);
      moved.set(cluster.data.subarray(4, tableOffset), 20);
      const out = new DataView(moved.buffer);
      out.setUint32(0, tableOffset + 16, true);
      for (let index = 0; index < count; index++) {
        out.setUint32(
          tableOffset + 16 + index * 8,
          view.getUint32(tableOffset + index * 8, true) + 16,
          true,
        );
        out.setUint32(
          tableOffset + 16 + index * 8 + 4,
          view.getUint32(tableOffset + index * 8 + 4, true),
          true,
        );
      }
      return { name: cluster.name, data: moved };
    });
    const report = exportSword2Game({ ...source, clusters: shuffled }, project.sword2!);
    const rebuilt = report.files.find((file) => file.name === 'general.clu')!;
    const original = shuffled.find((cluster) => cluster.name === 'general.clu')!.data;
    expect(Array.from(rebuilt.data)).toEqual(Array.from(original));
  });

  it('names a cluster by its resource.inf line, not by where its file sits', async () => {
    // `resource.tab` addresses a cluster by its line number in `resource.inf`,
    // and the demo declares fourteen clusters and ships five. Matching by
    // position among the files that happen to be present read TEXT.CLU's
    // resources out of Docks.clu on every install short of a complete one.
    const { project, source } = await sword2Project();
    // Only the text, so the absent cluster holds nothing this export edits.
    const textOnly = {
      ...project.sword2!,
      objects: [],
      globals: { count: 0, bytesBase64: '' },
      runLists: [],
    };
    editSword2TextLine({ ...project, sword2: textOnly }, 9, 1, 'changed');
    const second = source.clusters.filter((cluster) => cluster.name === 'text.clu');
    const report = exportSword2Game({ ...source, clusters: second }, textOnly);
    expect(report.missing).toEqual(['general.clu']);
    expect(report.rewritten).toEqual([9]);
    const rebuilt = report.files.find((file) => file.name === 'text.clu')!;
    expect(Array.from(rebuilt.data)).not.toEqual(Array.from(second[0]!.data));
  });

  it('refuses an edit that lands in a cluster the folder does not hold', async () => {
    const { project, source } = await sword2Project();
    const second = source.clusters.filter((cluster) => cluster.name === 'text.clu');
    expect(() => exportSword2Game({ ...source, clusters: second }, project.sword2!)).toThrow(
      /no file for it/,
    );
  });

  it('rebuilds only the cluster tails, leaving resource.tab alone', async () => {
    const { project, source } = await sword2Project();
    const report = exportSword2Game(source, project.sword2!);
    // Two clusters, and nothing else: `resource.tab` and `cd.inf` say which
    // cluster and which index a resource is at, and an edit changes neither.
    expect(report.files.map((file) => file.name).sort()).toEqual(['general.clu', 'text.clu']);
  });

  it('re-imports what it exported, so the round trip closes', async () => {
    const { project, source } = await sword2Project();
    const report = exportSword2Game(source, project.sword2!);
    const fixture = sword2Install();
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
      ...report.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
    ];
    const resources = await Sword2Resources.create(new MemoryDataSource('exported', entries));
    for (const name of resources.presentClusters) await resources.loadCluster(name, true);
    const again = importSword2Project(
      resources,
      identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu']),
    );
    expect(again.editable.unrecovered).toBe(0);
    expect(again.objects.every((object) => object.roundTrips)).toBe(true);
    expect(again.text[0].lines).toEqual(['hello', 'again']);
    expect(again.runLists[0].objects).toEqual([8]);
  });

  it('recomputes an object’s checksum, so an edited script is still legal', async () => {
    const { project, source } = await sword2Project();
    const object = project.sword2!.objects[0];
    // Change an operand, which changes a code byte and therefore the byte sum.
    (object.instructions as unknown as Array<{ operands: number[] }>)[0].operands = [99];
    const report = exportSword2Game(source, project.sword2!);
    const fixture = sword2Install();
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
      ...report.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
    ];
    const resources = await Sword2Resources.create(new MemoryDataSource('exported', entries));
    for (const name of resources.presentClusters) await resources.loadCluster(name, true);
    const again = importSword2Project(
      resources,
      identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu']),
    );
    // A wrong checksum would leave `roundTrips` true and the *game* unhappy, so
    // this is checked by reading the rebuilt object back through the parser,
    // which is what validates the identifier and the sum.
    expect(again.objects[0].instructions[0].operands[0]).toBe(99);
  });

  it('carries an edited global and an edited line of text', async () => {
    const { project, source } = await sword2Project();
    editSword2Global(project, 3, 1234);
    editSword2TextLine(project, 9, 1, 'changed');
    const report = exportSword2Game(source, project.sword2!);
    const fixture = sword2Install();
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
      ...report.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
    ];
    const resources = await Sword2Resources.create(new MemoryDataSource('exported', entries));
    for (const name of resources.presentClusters) await resources.loadCluster(name, true);
    const again = importSword2Project(
      resources,
      identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu']),
    );
    const globals = new DataView(
      Uint8Array.from(atob(again.globals.bytesBase64), (c) => c.charCodeAt(0)).buffer,
    );
    expect(globals.getInt32(12, true)).toBe(1234);
    // And the line, which this exporter used to drop: `rebuildText` existed,
    // was exported for the editor's use, and was never called. An author saw
    // the new line in the editor and shipped the old one.
    expect(again.text[0].lines).toEqual(['hello', 'changed']);
  });

  it('keeps every wav id a text module names when a line beside it changes', async () => {
    const { project, source } = await sword2Project();
    editSword2TextLine(project, 9, 0, 'a much longer line than the one it replaces');
    const report = exportSword2Game(source, project.sword2!);
    const fixture = sword2Install();
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
      ...report.files.map((file) => [file.name, file.data] as [string, Uint8Array]),
    ];
    const resources = await Sword2Resources.create(new MemoryDataSource('exported', entries));
    for (const name of resources.presentClusters) await resources.loadCluster(name, true);
    const again = importSword2Project(
      resources,
      identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu']),
    );
    expect(again.text[0].wavIds).toEqual([3887, 3888]);
  });

  it('carries a repainted screen layer into the exported game', async () => {
    // The measurement this closes. `SWORD2_SURFACES.screens` said
    // `editable-not-writable`, and the reason was never the format —
    // `sword2Encode.ts` writes all three schemes and the sweep re-encodes 17 of
    // the demo's 17 parallax layers to the shipped bytes. The exporter simply
    // never carried a screen resource, so a repainted background could not
    // leave the editor.
    const { fixture, project, source } = await sword2Project([pictureCluster()]);
    const before = sword2ScreenLayerPixels(project.sword2!, 20, 2)!;
    const painted = Uint8Array.from(before.pixels);
    painted[before.width * 3 + 1] = 9;
    replaceSword2ScreenLayer(project, 20, 2, painted, before.width, before.height);

    const report = exportSword2Game(source, project.sword2!);
    expect(report.rewritten).toContain(20);
    const again = await reimportSword2(report, fixture);
    const written = sword2ScreenLayerPixels(again, 20, 2)!;
    expect(written.pixels[before.width * 3 + 1]).toBe(9);
    // And the hole is still a hole, which says the row forms both survived.
    expect(written.pixels[before.width * 1 + 2]).toBe(0);
  });

  it('carries an edited animation frame into the exported game', async () => {
    const { fixture, project, source } = await sword2Project([pictureCluster()]);
    replaceSword2AnimationFrame(project, 21, 1, Uint8Array.from([4, 5]), 2, 1);

    const report = exportSword2Game(source, project.sword2!);
    expect(report.rewritten).toContain(21);
    const again = await reimportSword2(report, fixture);
    const animation = again.animations.find((each) => each.resource === 21)!;
    expect([...sword2PicturePixels(animation, 1)!.pixels]).toEqual([4, 5]);
    // The frame beside it is untouched, so the CDT offsets were put back.
    expect([...sword2PicturePixels(animation, 0)!.pixels]).toEqual([7, 7, 7, 7]);
  });

  it('carries an edited palette colour into the exported game', async () => {
    // A palette is not its own resource here: it is a 1,024-byte block inside
    // the screen that owns it, so writing one means folding it back into that
    // screen's bytes. `SWORD2_SURFACES.palettes` said `editable` and the
    // exporter wrote no palette at all, which is a claim rather than a gap.
    const { fixture, project, source } = await sword2Project([pictureCluster()]);
    editSword2PaletteColour(project, 20, 5, 10, 20, 30);

    const report = exportSword2Game(source, project.sword2!);
    const again = await reimportSword2(report, fixture);
    const palette = again.palettes.find((each) => each.screen === 20)!;
    const bytes = Uint8Array.from(atob(palette.bytesBase64), (c) => c.charCodeAt(0));
    expect([bytes[20], bytes[21], bytes[22]]).toEqual([10, 20, 30]);
  });

  it('carries an edited run list into the exported game', async () => {
    // The same shape of claim: `runLists` said `editable` and no run list was
    // ever written. A session's run list is the set of objects that are alive
    // in it, so an export that drops the edit ships a different game from the
    // one the editor showed.
    const { fixture, project, source } = await sword2Project();
    editSword2RunList(project, 2, [12]);

    const report = exportSword2Game(source, project.sword2!);
    expect(report.rewritten).toContain(2);
    const again = await reimportSword2(report, fixture);
    expect(again.runLists[0].objects).toEqual([12]);
  });

  it('extends a run list past the resource it arrived in', async () => {
    // This was a refusal and the refusal was wrong. A cluster's tail table
    // carries a length per resource and the export rewrites it, so a run list
    // that gained an id is a resource that got longer and the index still
    // finds it. It matters because none of the demo's thirteen run lists has a
    // spare word: without this, an object appended to the game could never be
    // put in a session.
    const { fixture, project, source } = await sword2Project();
    editSword2RunList(project, 2, [12, 13, 14]);
    const report = exportSword2Game(source, project.sword2!);
    const again = await reimportSword2(report, fixture);
    expect(again.runLists[0].objects).toEqual([12, 13, 14]);
  });

  it('re-emits an install with screens and animations in it byte-identically', async () => {
    // Carrying them out must not cost the property the exporter exists for.
    const { project, source } = await sword2Project([pictureCluster()]);
    expect(project.sword2!.screens.length).toBeGreaterThan(0);
    expect(project.sword2!.animations.length).toBeGreaterThan(0);
    const report = exportSword2Game(source, project.sword2!);
    for (const file of report.files) {
      const original = source.clusters.find((cluster) => cluster.name === file.name)?.data;
      expect(original, `no original for ${file.name}`).toBeDefined();
      expect(Array.from(file.data), file.name).toEqual(Array.from(original as Uint8Array));
    }
  });

  it('refuses to write an object that did not round-trip on import', async () => {
    const { project, source } = await sword2Project();
    (project.sword2!.objects as unknown as Array<{ roundTrips: boolean }>)[0].roundTrips = false;
    expect(() => exportSword2Game(source, project.sword2!)).toThrow(Sword2ExportError);
  });

  it('carries a replaced effect into the cluster the resource lives in', async () => {
    // An effect is a `WAV_FILE` resource: the payload behind its id is a RIFF
    // WAVE and replacing one is substituting the payload behind the header,
    // which is the same sentence as every other edit in this family. This one
    // is provable on the demo — `npm run reexport:sword` runs it against the
    // real `general.clu`.
    const { project, source } = await sword2Project([effectCluster()]);
    const replacement = waveBytes([3, 2, 1]);
    const report = exportSword2Game(
      { ...source, effects: [{ id: 30, data: replacement }] },
      project.sword2!,
    );
    const again = await sword2ResourcesOf(report, sword2Install([effectCluster()]));
    const loaded = await again.loadStreamed(30);
    expect([...(loaded?.payload ?? [])]).toEqual([...replacement]);
    // And the header in front of it is the one the release wrote, name and
    // type unchanged, because the game reads both.
    expect(loaded?.bytes[0]).toBe(Sword2FileType.WAV_FILE);
  });

  it('refuses to substitute a payload behind a header that is not a sound', async () => {
    const { project, source } = await sword2Project([effectCluster()]);
    expect(() =>
      exportSword2Game({ ...source, effects: [{ id: 20, data: waveBytes([1]) }] }, project.sword2!),
    ).toThrow(Sword2ExportError);
  });

  it('writes a replaced recording into a sound container, unproven though it is', async () => {
    // Speech and music in a retail Broken Sword II are entries in
    // `SPEECH1.CLU` and `MUSIC1.CLU`, files `resource.inf` never names. No
    // install this project can reach ships one — both are the DOS demo — so
    // the container here is one this project's own writer built, and what this
    // proves is that the export path carries a replacement through the rebuild
    // and the index. It does not prove a retail disc reads it back.
    const { project, source } = await sword2Project();
    const lines = [Int16Array.from([0, 7, 14]), Int16Array.from([-8, -1, 6, 13])];
    const container = soundContainer(lines);
    const samples = [0, 7, 14, 21, 14, 7];
    const report = exportSword2Game(
      {
        ...source,
        sounds: [
          {
            name: 'speech1.clu',
            data: container,
            replacements: [{ index: 1, wav: waveBytes(samples) }],
          },
        ],
      },
      project.sword2!,
    );
    expect(report.sounds).toEqual([{ file: 'speech1.clu', replaced: ['speech1.clu entry 1'] }]);
    const written = report.files.find((file) => file.name === 'speech1.clu')!.data;
    const index = parseSword2CluIndex('speech1.clu', written)!;
    expect([...readSword2Sound(written, index.locate(1)!)]).toEqual(samples);
    // The line before it is where it was, with the bytes it had.
    expect([...readSword2Sound(written, index.locate(0)!)]).toEqual([...lines[0]!]);
    expect(index.locate(0)!.at).toBe(parseSword2CluIndex('speech1.clu', container)!.locate(0)!.at);
  });

  it('carries a container through byte-identically when nothing was replaced', async () => {
    const { project, source } = await sword2Project();
    const container = soundContainer([Int16Array.from([0, 7, 14])]);
    const report = exportSword2Game(
      { ...source, sounds: [{ name: 'music1.clu', data: container, replacements: [] }] },
      project.sword2!,
    );
    expect(report.sounds).toEqual([{ file: 'music1.clu', replaced: [] }]);
    const written = report.files.find((file) => file.name === 'music1.clu')!.data;
    expect([...written]).toEqual([...container]);
  });
});

describe('adding and removing a record', () => {
  /*
   * Row 12 of `docs/editor-parity.md`, which was a No for both families on one
   * sentence: a record that moves leaves every id that addresses it pointing
   * somewhere else. That is true of inserting and of growing, and it is not
   * true of appending — which is what these tests are for, and why the row now
   * says append and delete rather than add and remove.
   */

  it('appends a compact to a Sword 1 section without moving any id', async () => {
    const { project, source } = await sword1Project();
    const section = project.sword1!.sections[0]!;
    const before = {
      count: section.offsets.length,
      words: section.words,
      offsets: [...section.offsets],
      records: new Map(section.compacts.map((compact) => [compact.index, compact.wordsBase64])),
    };

    const index = appendSword1Compact(project, section.section, 0);
    expect(index).toBe(before.count);
    // The table gained one entry, so every record sits one word later and
    // every offset already in the table went up by one. That is the whole of
    // the arithmetic, and it is why no id changed meaning.
    expect(section.offsets.slice(0, before.count)).toEqual(
      before.offsets.map((offset) => offset + 1),
    );
    expect(section.offsets[index]).toBe(before.words + 1);

    const report = exportSword1Game(source, project.sword1!);
    const again = await reimportSword1(report);
    const back = again.sections.find((candidate) => candidate.section === section.section)!;
    expect(back.offsets.length).toBe(before.count + 1);
    for (const [at, bytes] of before.records) {
      expect(back.compacts.find((compact) => compact.index === at)?.wordsBase64).toBe(bytes);
    }
    expect(back.compacts.find((compact) => compact.index === index)?.wordsBase64).toBe(
      before.records.get(0),
    );
  });

  it('removes the last compact of a Sword 1 section and puts the resource back', async () => {
    const { project, source } = await sword1Project();
    const section = project.sword1!.sections[0]!;
    const before = {
      count: section.offsets.length,
      words: section.words,
      offsets: [...section.offsets],
    };
    const added = appendSword1Compact(project, section.section, 0);

    expect(sword1CompactDeleteRefusal(project, section.section, added)).toBeNull();
    deleteSword1Compact(project, section.section, added);
    expect(section.offsets).toEqual(before.offsets);
    expect(section.words).toBe(before.words);
    expect(section.compacts.length).toBe(before.count);

    // And the resource is the one the game shipped, byte for byte.
    const report = exportSword1Game(source, project.sword1!);
    for (const file of report.files) {
      const original = source.clusters.find((cluster) => cluster.name === file.name)?.data;
      if (!original) continue;
      expect(Array.from(file.data), file.name).toEqual(Array.from(original));
    }
  });

  it('refuses to remove a Sword 1 compact that is not the last of its section', async () => {
    const { project } = await sword1Project();
    const section = project.sword1!.sections[0]!;
    appendSword1Compact(project, section.section, 0);
    const refusal = sword1CompactDeleteRefusal(project, section.section, 0);
    expect(refusal).toMatch(/not the last/);
    expect(refusal).toMatch(/renumber/);
    expect(() => deleteSword1Compact(project, section.section, 0)).toThrow(/not the last/);
  });

  it('appends an object to Sword II, giving it the next id and its own scripts', async () => {
    const { fixture, project, source } = await sword2Project();
    const sword2 = project.sword2!;
    const template = sword2.objects.find((object) => object.roundTrips)!;
    const before = { count: sword2.resourceCount!, objects: sword2.objects.length };

    const id = appendSword2Object(project, template.id);
    expect(id).toBe(before.count);
    expect(sword2.resourceCount).toBe(before.count + 1);
    expect(sword2.objects.length).toBe(before.objects + 1);

    const report = exportSword2Game(source, sword2);
    const tab = report.files.find((file) => file.name === 'resource.tab')!;
    // `resource.tab` grew by exactly one entry and its existing bytes are the
    // bytes it arrived with: every id the game shipped still names what it did.
    expect(tab.data.length).toBe(source.resourceTab.length + 4);
    expect(Array.from(tab.data.subarray(0, source.resourceTab.length))).toEqual(
      Array.from(source.resourceTab),
    );

    const again = await reimportSword2(report, { ...fixture, tab: tab.data });
    const added = again.objects.find((object) => object.id === id)!;
    expect(added).toBeDefined();
    expect(added.roundTrips).toBe(true);
    // A copy, and its own object: the hub's script ids name the copy rather
    // than the original, so it runs its own code rather than being a second
    // name for one object.
    expect(added.instructions).toEqual(template.instructions);
    const hub = Uint8Array.from(atob(added.bytesBase64), (c) => c.charCodeAt(0));
    const hubView = new DataView(hub.buffer, hub.byteOffset, hub.byteLength);
    for (let level = 0; level < 3; level++) {
      const scriptId = hubView.getUint32(RES_HEADER_SIZE + 20 + level * 4, true);
      if (scriptId !== 0) expect(Math.floor(scriptId / 0x10000)).toBe(id);
    }
    // And every object the game shipped comes back as itself.
    for (const object of sword2.objects) {
      if (object.appendedFrom !== undefined) continue;
      expect(
        again.objects.find((candidate) => candidate.id === object.id)?.bytesBase64,
        `object ${object.id}`,
      ).toBe(object.bytesBase64);
    }
  });

  it('removes an appended Sword II object and leaves the install as it was', async () => {
    const { project, source } = await sword2Project();
    const sword2 = project.sword2!;
    const template = sword2.objects.find((object) => object.roundTrips)!;
    const id = appendSword2Object(project, template.id);

    expect(sword2ObjectDeleteRefusal(project, id)).toBeNull();
    deleteSword2Object(project, id);
    expect(sword2.resourceCount).toBe(id);

    const report = exportSword2Game(source, sword2);
    expect(report.files.some((file) => file.name === 'resource.tab')).toBe(false);
    for (const file of report.files) {
      const original = source.clusters.find((cluster) => cluster.name === file.name)?.data;
      expect(original, `no original for ${file.name}`).toBeDefined();
      expect(Array.from(file.data), file.name).toEqual(Array.from(original as Uint8Array));
    }
  });

  it('refuses to remove a Sword II object the game shipped', async () => {
    const { project } = await sword2Project();
    const shipped = project.sword2!.objects[0]!;
    const refusal = sword2ObjectDeleteRefusal(project, shipped.id);
    expect(refusal).toMatch(/renumber/);
    expect(() => deleteSword2Object(project, shipped.id)).toThrow(Sword2EditError);
  });

  it('refuses to remove an appended Sword II object a session still names', async () => {
    const { project } = await sword2Project();
    const sword2 = project.sword2!;
    const id = appendSword2Object(project, sword2.objects.find((object) => object.roundTrips)!.id);
    const list = sword2.runLists[0]!;
    editSword2RunList(project, list.resource, [...list.objects, id]);
    expect(sword2ObjectDeleteRefusal(project, id)).toMatch(/run list/);
  });

  it('carries an appended Sword II object into a session', async () => {
    // The run list is what makes an appended object a thing that runs rather
    // than a thing that exists, and none of the game's own lists has a spare
    // word — so this is also the test that the list may grow.
    const { fixture, project, source } = await sword2Project();
    const sword2 = project.sword2!;
    const id = appendSword2Object(project, sword2.objects.find((object) => object.roundTrips)!.id);
    const list = sword2.runLists[0]!;
    editSword2RunList(project, list.resource, [...list.objects, id]);

    const report = exportSword2Game(source, sword2);
    const tab = report.files.find((file) => file.name === 'resource.tab')!;
    const again = await reimportSword2(report, { ...fixture, tab: tab.data });
    expect(again.runLists.find((each) => each.resource === list.resource)?.objects).toContain(id);
  });
});
