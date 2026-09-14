import { describe, expect, it } from 'vitest';

import type { Action } from '../src/authoring/actions.js';
import { fromBase64, toBase64 } from '../src/authoring/base64.js';
import {
  exportEditedFiles,
  type EditedArt,
  type ExportedFile,
} from '../src/authoring/exportEdits.js';
import { loadImage, storeImage } from '../src/authoring/imageCodec.js';
import type { EditedScript } from '../src/authoring/exportGame.js';
import type { Project } from '../src/authoring/project.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { buildClassicFixture } from './fixtureClassic.js';
import { buildFixture } from './fixture.js';
import { buildV8Fixture } from './fixtureV8.js';

/**
 * Exporting an edited game, once per Resource layout.
 *
 * Three writers existed and the editor could reach one of them, so a v4, v3 or
 * v2 game imported, decompiled, edited — and then had nowhere to go. What is
 * asserted here is the two halves of the promise `CONTEXT.md` makes:
 *
 * - **Byte-identity is a property of unmodified resources.** An export with no
 *   edits in it produces the files it was given, file for file.
 * - **An edit is written where it was read from.** The bytes come back changed
 *   at exactly the offset the importer recorded, and nowhere else.
 *
 * The second is the one that catches a wrong chunk-header width: a pre-v5
 * header is six bytes where v5's is eight, and an edit written two bytes out
 * lands on the tail of the block header in front of it — which produces a file
 * that loads and hands out nonsense rather than one that fails.
 */

/** Every raw action in a project that the importer recorded an origin for. */
function editableScripts(project: Project): Array<{ action: Action & { type: 'raw' } }> {
  const found: Array<{ action: Action & { type: 'raw' } }> = [];
  const walk = (actions: Action[] | undefined) => {
    for (const action of actions ?? []) {
      if (action.type === 'raw' && action.origin) found.push({ action });
    }
  };
  for (const room of project.rooms) {
    walk(room.onEnter);
    walk(room.onExit);
    for (const script of room.localScripts ?? []) walk(script.actions);
  }
  return found;
}

function edits(project: Project): EditedScript[] {
  return editableScripts(project).map(({ action }) => ({
    ...action.origin!,
    code: fromBase64(action.bytes),
  }));
}

async function importGameFrom(files: Array<[string, Uint8Array]>, label: string) {
  const source = new MemoryDataSource(label, files);
  const engine = await ScummEngine.create(source);
  const editable = await engine.toEditableGame({ progress: new LoadProgressTracker() });
  return { engine, editable, originals: editable.originals! };
}

const LAYOUTS = [
  { name: 'v2 — an index and one file per room', build: () => buildClassicFixture({ version: 2 }) },
  { name: 'v3 — an index and one file per room', build: () => buildClassicFixture({ version: 3 }) },
  { name: 'v4 — an index and disk containers', build: () => buildClassicFixture({ version: 4 }) },
  {
    name: 'v5 — one container',
    build: () => {
      const fixture = buildFixture();
      return {
        files: [
          [fixture.indexName, fixture.index],
          [fixture.dataName, fixture.data],
        ] as Array<[string, Uint8Array]>,
      };
    },
  },
  { name: 'v8 — one container, 32 bits wide', build: () => buildV8Fixture() },
] as const;

describe.each(LAYOUTS)('exporting a $name game', ({ name, build }) => {
  it('writes back every file it was given', async () => {
    const fixture = build();
    const { originals } = await importGameFrom(fixture.files, name);

    const written = exportEditedFiles(originals, []);

    // The index, every data file, every charset kept beside them — and
    // nothing invented.
    expect(written.map((file) => file.name)).toEqual([
      originals.indexFile,
      ...originals.dataFiles.map((file) => file.name),
      ...(originals.charsetFiles ?? []).map((file) => file.name),
    ]);
  });

  /**
   * The stronger version of the same claim, and the one that was false.
   *
   * A v4 install is an index, its disks *and* `901.LFL`–`904.LFL`; the writer
   * produced the first two and stopped. The result loaded — nothing addresses
   * a charset by offset, so no directory was wrong — and then could not draw a
   * letter, because the files holding its letters had not been written. Found
   * by `npm run reexport -- games/loom --sweep`, which reported the exported
   * game asking for a charset that was not there.
   */
  it('writes an install, not a subset of one', async () => {
    const fixture = build();
    const { originals } = await importGameFrom(fixture.files, name);

    const written = exportEditedFiles(originals, []);

    const given = new Set(fixture.files.map(([fileName]) => fileName));
    for (const fileName of given) {
      expect(
        written.some((file) => file.name === fileName),
        `${fileName} was given and not written back`,
      ).toBe(true);
    }
  });

  it('is byte-identical when nothing was edited', async () => {
    const fixture = build();
    const { originals } = await importGameFrom(fixture.files, name);
    const before = new Map(fixture.files);

    for (const file of exportEditedFiles(originals, [])) {
      const original = before.get(file.name);
      expect(original, `${file.name} was not in the input`).toBeDefined();
      expect(Array.from(file.data), `${file.name} came back different`).toEqual(
        Array.from(original!),
      );
    }
  });

  it('writes an edited script back where it was read from', async () => {
    const fixture = build();
    const { editable, originals } = await importGameFrom(fixture.files, name);

    const scripts = editableScripts(editable.project);
    expect(scripts.length, 'the fixture has no editable script').toBeGreaterThan(0);

    // The same length, so nothing moves and the comparison is about the bytes
    // rather than about the rebuild. A different length is the other half of
    // the writer's job and the layout tests above cover it.
    const original = fromBase64(scripts[0].action.bytes);
    const changed = new Uint8Array(original);
    changed[0] = changed[0] ^ 0xff;
    scripts[0].action.bytes = toBase64(changed);

    const written = exportEditedFiles(originals, edits(editable.project));
    const before = new Map(fixture.files);

    const differing = written.filter(
      (file) => !equal(file.data, before.get(file.name) ?? new Uint8Array(0)),
    );
    expect(differing.length, 'the edit reached no file').toBeGreaterThan(0);
    // Exactly the byte that changed, in exactly one file, and no other.
    for (const file of differing) {
      const was = before.get(file.name)!;
      expect(file.data).toHaveLength(was.length);
      const changedBytes = [...file.data].filter((byte, i) => byte !== was[i]);
      expect(changedBytes).toHaveLength(1);
    }
  });
});

/**
 * Editing a pre-v5 room's artwork, which is one block and can be swapped.
 *
 * The two halves of #200, #202 and #204's art criterion, and the second is the
 * one that needed a design rather than a call: an encoder that is *correct*
 * does not reproduce Lucasfilm's compressor, so re-encoding every picture on
 * every export would make an unedited export differ from its input in every
 * room. The writer therefore decodes what is already there and compares
 * pixels — an image that decodes to what it decoded to before is copied, not
 * re-encoded.
 */
describe.each([2, 3, 4] as const)("editing a SCUMM v%i room's artwork", (version) => {
  async function imported() {
    const fixture = buildClassicFixture({ version });
    const { editable, originals } = await importGameFrom(fixture.files, `v${version}`);
    return { fixture, project: editable.project, originals };
  }

  it('records where the room and its object got their pictures', async () => {
    const { project } = await imported();
    const room = project.rooms[0];

    expect(room.artOrigin).toBeDefined();
    expect(room.objects[0].artOrigin).toBeDefined();
  });

  it('leaves an unedited picture as the bytes it arrived as', async () => {
    const { fixture, project, originals } = await imported();
    const before = new Map(fixture.files);

    // Every picture offered to the writer, none of them touched.
    for (const file of exportEditedFiles(originals, [], artOf(project))) {
      expect(Array.from(file.data), `${file.name} came back re-encoded`).toEqual(
        Array.from(before.get(file.name)!),
      );
    }
  });

  it('writes an edited background back, and only that block', async () => {
    const { fixture, project, originals } = await imported();
    const room = project.rooms[0];

    const painted = loadImage(room.background);
    painted.pixels.fill(5);
    room.background = storeImage(painted);

    const written = exportEditedFiles(originals, [], artOf(project));
    const before = new Map(fixture.files);
    const changed = written.filter((file) => !equal(file.data, before.get(file.name)!));
    expect(changed.length).toBeGreaterThan(0);

    // And it decodes back to what was painted, which is the assertion that
    // survives a wrong strip table: a picture can be written, be a different
    // length, and still decode to noise.
    const reread = await reimport(written, `v${version}`);
    expect(Array.from(loadImage(reread.rooms[0].background).pixels)).toEqual(
      Array.from(painted.pixels),
    );
  });
});

/** Every picture in a project, addressed the way the exporter wants them. */
function artOf(project: Project): EditedArt[] {
  const art: EditedArt[] = [];
  for (const room of project.rooms) {
    if (room.artOrigin) art.push({ ...room.artOrigin, image: loadImage(room.background) });
    for (const object of room.objects) {
      if (object.artOrigin && object.states[0]) {
        art.push({ ...object.artOrigin, image: loadImage(object.states[0]) });
      }
    }
  }
  return art;
}

/** Loads an exported set of files back as a project, which is the real check. */
async function reimport(files: ExportedFile[], label: string): Promise<Project> {
  const source = new MemoryDataSource(
    label,
    files.map((file) => [file.name, file.data] as [string, Uint8Array]),
  );
  const engine = await ScummEngine.create(source);
  const editable = await engine.toEditableGame({ progress: new LoadProgressTracker() });
  return editable.project;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
