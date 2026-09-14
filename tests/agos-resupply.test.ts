// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readAgosGameFolder } from '../src/editor/agos/resupply.js';
import { exportAgosFiles } from '../src/editor/agos/exportAgos.js';
import { fingerprintOf } from '../src/authoring/agos/fingerprint.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import type { DirectoryHandleLike } from '../src/editor/files.js';
import type { Project } from '../src/authoring/project.js';
import { buildGamePc, buildGraphicsArchive } from './fixtureAgos.js';

/**
 * A folder as the File System Access API shape, from a plain map.
 *
 * The interface the editor reads folders through is deliberately small — a name
 * and `getFileHandle` — precisely so a test can be a few objects rather than a
 * browser dialogue nothing can drive.
 */
function folderOf(name: string, files: Record<string, Uint8Array>): DirectoryHandleLike {
  return {
    name,
    getFileHandle: async (wanted: string) => {
      const data = files[wanted];
      if (!data) throw new Error(`no such file: ${wanted}`);
      return {
        name: wanted,
        createWritable: async () => ({ write: async () => {}, close: async () => {} }),
        getFile: async () => ({
          size: data.length,
          arrayBuffer: async () =>
            data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
        }),
      };
    },
  };
}

async function agosProject(): Promise<Project> {
  const source = new MemoryDataSource('simon-resupply');
  source.set('GAMEPC', buildGamePc({ withSpeech: true }));
  source.set('SIMON.GME', buildGraphicsArchive());
  source.set('SIMON.VOC', Uint8Array.of(0));
  const engine = await loadAdventureEngine(source);
  const editable = await engine.toEditableGame({ progress: undefined as never });
  if (!editable) throw new Error('AGOS produced no editable game');
  return editable.project;
}

describe('re-supplying an AGOS game folder', () => {
  it('accepts the folder the project was built from', async () => {
    const project = await agosProject();
    const result = await readAgosGameFolder(
      folderOf('simon', {
        [project.origin!.indexFile]: buildGamePc({ withSpeech: true }),
        [project.origin!.dataFile]: buildGraphicsArchive(),
      }),
      project,
    );

    expect(typeof result).not.toBe('string');
    if (typeof result === 'string') return;
    // The whole point of the gesture: the zone's pixels, which the Project does
    // not carry and never will (ADR 0010). Zone 0 because that is the zone the
    // project itself lists — the two sides address zones by the same
    // arithmetic, which is what stops a re-supplied folder drawing one image
    // where the project means another.
    const zone = project.agos!.art!.zones[0]!;
    expect(result.readZonePixels(zone)).toBeInstanceOf(Uint8Array);
  });

  it('refuses a base file of the wrong size, and says which way', async () => {
    // A different release does not fail to open: its resources are at different
    // offsets, so its art renders as plausible nonsense. That is why the check
    // has teeth rather than a name match (ADR 0034).
    const project = await agosProject();
    const short = buildGamePc({ withSpeech: true }).slice(0, 40);

    const result = await readAgosGameFolder(
      folderOf('other', {
        [project.origin!.indexFile]: short,
        [project.origin!.dataFile]: buildGraphicsArchive(),
      }),
      project,
    );

    expect(result).toContain('different release');
    expect(result).toContain(String(short.length));
  });

  it('refuses a base file of the right size that is not the same file', async () => {
    // The size alone is not teeth: two releases of one title can match on it.
    const project = await agosProject();
    const tampered = buildGamePc({ withSpeech: true });
    tampered[tampered.length - 1] ^= 0xff;

    const result = await readAgosGameFolder(
      folderOf('lookalike', {
        [project.origin!.indexFile]: tampered,
        [project.origin!.dataFile]: buildGraphicsArchive(),
      }),
      project,
    );

    expect(result).toContain('right size but not the same file');
  });

  it('refuses a folder holding one of the two files rather than half-accepting it', async () => {
    const project = await agosProject();
    const result = await readAgosGameFolder(
      folderOf('half', { [project.origin!.indexFile]: buildGamePc({ withSpeech: true }) }),
      project,
    );

    expect(result).toContain(project.origin!.dataFile);
    expect(result).toContain('Both are');
  });

  it('refuses an archive whose size does not match, even beside the right base file', async () => {
    const project = await agosProject();
    const result = await readAgosGameFolder(
      folderOf('swapped', {
        [project.origin!.indexFile]: buildGamePc({ withSpeech: true }),
        [project.origin!.dataFile]: new Uint8Array([...buildGraphicsArchive(), 0, 0, 0, 0]),
      }),
      project,
    );

    expect(result).toContain('one file swapped');
  });
});

describe('the base-file fingerprint', () => {
  it('is stable for the same bytes and different for a changed one', () => {
    const bytes = buildGamePc({ withSpeech: true });
    const changed = buildGamePc({ withSpeech: true });
    changed[10] ^= 0x01;

    expect(fingerprintOf(bytes)).toEqual(fingerprintOf(bytes.slice()));
    expect(fingerprintOf(changed).hash).not.toBe(fingerprintOf(bytes).hash);
  });

  it('is recorded on the project at import, not computed later from the edit', async () => {
    const project = await agosProject();

    expect(project.agos!.baseFingerprint).toEqual(fingerprintOf(buildGamePc({ withSpeech: true })));
  });
});

describe('exporting an AGOS project', () => {
  it('produces both files, named after the ones the project came from', async () => {
    const project = await agosProject();
    const built = exportAgosFiles(project, buildGraphicsArchive());

    expect(built.errors).toEqual([]);
    expect(built.files.map((file) => file.name)).toEqual([
      project.origin!.indexFile,
      project.origin!.dataFile,
    ]);
  });

  it('re-emits an unedited game byte for byte, trailing region included', async () => {
    // ADR 0035's Preserved bytes are carried on the Project now rather than
    // left in the engine, because an export is built from the Project — a
    // release whose trailing region stayed behind could only be byte-exact in
    // the session that imported it.
    const project = await agosProject();
    const built = exportAgosFiles(project, buildGraphicsArchive());

    expect(built.files[0]!.data).toEqual(buildGamePc({ withSpeech: true }));
  });

  it('refuses without the archive rather than writing half a game', async () => {
    // ADR 0030: both files or neither. A rebuilt base file beside a stale
    // archive is "a game that loads and then misbehaves".
    const project = await agosProject();
    const built = exportAgosFiles(project, undefined);

    expect(built.files).toEqual([]);
    expect(built.errors[0]).toContain('Open the game folder');
  });

  it('refuses a game that was not editable', async () => {
    const project = await agosProject();
    const refused = {
      ...project,
      agos: {
        ...project.agos!,
        editable: { editable: false, unrecovered: 1, reasons: ['it did not round-trip'] },
      },
    };

    const built = exportAgosFiles(refused, buildGraphicsArchive());
    expect(built.files).toEqual([]);
    expect(built.errors[0]).toContain('did not round-trip');
  });
});
