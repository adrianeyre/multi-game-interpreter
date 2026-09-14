/**
 * Re-exports an AGOS game through the editor's own path, and checks the result.
 *
 *   npm run reexport:agos -- <game folder>
 *
 * A sibling of `reexport:agi` and `reexport:sci`, and the piece of evidence the
 * AGOS export path most needs. ADR 0030 rebuilds `GAMEPC` whole and its archive
 * beside it, together or not at all, and rests the whole design on an unedited
 * game coming back **byte for byte** — a claim a fixture cannot make, because a
 * fixture is our reading of the format rather than a game's.
 *
 * Two faults were found by running exactly this against Simon 1 and by nothing
 * else. The Project was dropping ADR 0035's 7,909-byte trailing region, so the
 * retail Windows release could not re-emit. And the archive aliases — six pairs
 * of entry numbers share an offset — which the reader cannot express, so the
 * writer emitted both copies and grew the file by 9,436 bytes.
 *
 * It then paints one image and loads the result, because identity only proves
 * the exporter leaves alone what it was not asked to change.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openGame } from '../src/hosting/openGame.js';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import { exportAgosFiles } from '../src/editor/agos/exportAgos.js';
import { fingerprintOf } from '../src/authoring/agos/fingerprint.js';
import { stringsOf } from '../src/editor/agos/gamePc.js';

const folder = process.argv[2]!;
const source = await openGame(folder);
const engine = await AgosEngine.create(source, { onLog: () => undefined });
const editable = await engine.toEditableGame({ progress: undefined as never });
if (!editable) throw new Error('no editable game');
const project = editable.project;
const agos = project.agos!;

console.log('target      ', JSON.stringify(project.target));
console.log('origin      ', JSON.stringify(project.origin));
console.log('editable    ', agos.editable.editable, agos.editable.reasons.join('; '));
console.log('items       ', agos.items.length);
console.log('strings     ', stringsOf(agos).length);
console.log('subroutines ', agos.subroutines.subroutines.length);
console.log('zones       ', agos.art?.zones.length, 'images', agos.art?.images.length);
console.log('trailing    ', atob(agos.trailingBase64).length, 'bytes');
console.log('fingerprint ', JSON.stringify(agos.baseFingerprint));

const gamePcOnDisk = new Uint8Array(await readFile(resolve(folder, project.origin!.indexFile)));
const archiveOnDisk = new Uint8Array(await readFile(resolve(folder, project.origin!.dataFile)));
console.log(
  'fingerprint matches the file on disk:',
  JSON.stringify(fingerprintOf(gamePcOnDisk)) === JSON.stringify(agos.baseFingerprint),
);

const built = exportAgosFiles(project, archiveOnDisk);
if (built.errors.length > 0) {
  console.log('EXPORT REFUSED:', built.errors.join(' | '));
  process.exit(1);
}
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, at) => value === b[at]);
console.log(
  'GAMEPC  bytes',
  built.files[0]!.data.length,
  'identical:',
  same(built.files[0]!.data, gamePcOnDisk),
);
console.log(
  'archive bytes',
  built.files[1]!.data.length,
  'identical:',
  same(built.files[1]!.data, archiveOnDisk),
);

// ---------------------------------------------------------------- painting --

/*
 * One painted image, exported, and the result loaded again.
 *
 * The identity check above proves the exporter does not disturb a game it was
 * not asked to change. This proves the other half: that a change lands, that it
 * lands only where it was asked to, and that what comes out is still a game the
 * engine opens.
 */
const target = agos.art!.images.find((each) => each.width > 0 && each.height > 0)!;
const painted = {
  zone: target.zone,
  id: target.id,
  width: target.width,
  height: target.height,
  pixels: btoa(String.fromCharCode(...new Uint8Array(target.width * target.height).fill(15))),
};
const edited = exportAgosFiles(
  { ...project, agos: { ...agos, paintedImages: [painted] } },
  archiveOnDisk,
);
if (edited.errors.length > 0) {
  console.log('PAINTED EXPORT REFUSED:', edited.errors.join(' | '));
  process.exit(1);
}
const before = archiveOnDisk;
const after = edited.files[1]!.data;
let differing = 0;
for (let at = 0; at < Math.max(before.length, after.length); at += 1) {
  if (before[at] !== after[at]) differing += 1;
}
console.log(
  `painted zone ${target.zone} image ${target.id} (${target.width}x${target.height}):`,
  `archive ${before.length} -> ${after.length},`,
  `${differing} bytes differ`,
);

const { readAgosGameFolder } = await import('../src/editor/agos/resupply.js');
const { agosPreviewSource } = await import('../src/editor/agos/previewSource.js');
const { readdir } = await import('node:fs/promises');

// A folder handle over the real directory, which is all `readAgosGameFolder`
// asks for: a name and `getFileHandle`.
const names = await readdir(folder);
const handle = {
  name: folder,
  listNames: async () => names,
  getFileHandle: async (wanted: string) => {
    const actual = names.find((each) => each.toLowerCase() === wanted.toLowerCase());
    if (!actual) throw new Error('no such file');
    return {
      name: actual,
      createWritable: async () => ({ write: async () => {}, close: async () => {} }),
      getFile: async () => {
        const data = new Uint8Array(await readFile(resolve(folder, actual)));
        return { size: data.length, arrayBuffer: async () => data.buffer as ArrayBuffer };
      },
    };
  },
};
const supplied = await readAgosGameFolder(handle, project);
if (typeof supplied === 'string') {
  console.log('RESUPPLY REFUSED:', supplied);
  process.exit(1);
}
console.log('resupply accepted; speech listed:', supplied.speechNames.join(', ') || '(none)');
console.log('interpreters found:', supplied.support.map(([name]) => name).join(', ') || '(none)');

const preview = agosPreviewSource({
  inMemory: edited.files,
  support: supplied.support,
  lazyNames: supplied.speechNames,
  read: (name) => supplied.read(name),
});
const reloaded = await AgosEngine.create(preview, { onLog: () => undefined });
console.log('the painted game reloads:', reloaded.targetName, `room ${reloaded.currentRoom}`);
