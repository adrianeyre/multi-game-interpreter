import { buildProject } from '../authoring/projectToGame.js';
import { exportEditedFiles, type EditedArt, type ExportedFile } from '../authoring/exportEdits.js';
import { loadImage } from '../authoring/imageCodec.js';
import type { EditedScript } from '../authoring/exportGame.js';
import { XOR_NONE } from '../engine/resource/xor.js';
import { fromBase64 } from '../authoring/base64.js';
import { getImportedSource } from './importedStorage.js';
import { exportAgosFiles } from './agos/exportAgos.js';
import { canSaveInPlace as canPickFolder, pickReadableFolder } from './files.js';
import { resupplyFrom } from './resupply.js';
import { writeDigLanguageBundle } from '../authoring/languageStrings.js';
import type { Action } from '../authoring/actions.js';
import { scummVersionOf, type Project } from '../authoring/project.js';
import { isExternal } from '../authoring/audio.js';
import { readTrackBytes } from './audioBytes.js';
import {
  canSaveInPlace,
  createZip,
  type ZipFile,
  download,
  ensureWritable,
  pickFolder,
  writeInto,
  type DirectoryHandleLike,
} from './files.js';
import type { Sword1ExportSource } from '../authoring/sword1/export.js';
import type { Sword2ExportSource } from '../authoring/sword2/export.js';
import { markExported } from './storage.js';
import { describeTarget } from '../authoring/target.js';
import type { SciMapVersion } from '../engine/sci/resource/resourceMap.js';
import type { SciLayout } from '../engine/sci/resource/sciDetect.js';

/** An 8.3 stem shared by the index and data files, as real releases use. */
export function gameStem(project: Project): string {
  const cleaned = project.name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.slice(0, 8) || 'GAME';
}

export function projectFileName(project: Project): string {
  const safe = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'game';
  return `${safe}.scummproj.json`;
}

/**
 * What a save needs that the Project does not carry.
 *
 * One field today and shaped as a record anyway, because the thing it carries
 * is the shape of the problem rather than an AGOS quirk: ADR 0010 keeps large
 * originals out of the Project, so any family whose export is "original plus
 * diff" will want to hand its originals in here too.
 */
export interface SaveOptions {
  /**
   * The AGOS resource archive as the author's folder holds it.
   *
   * An AGOS export rewrites this rather than emitting it, so without it there
   * is no export — and saying so beats writing a rebuilt `GAMEPC` beside an
   * archive it no longer agrees with, which is the mismatch ADR 0030 exists to
   * prevent.
   */
  agosArchive?: Uint8Array;
  /**
   * The Broken Sword install the project was imported from, re-supplied.
   *
   * Both Broken Sword families export by rebuilding their clusters, and a
   * project does not carry them — an install is hundreds of megabytes and ADR
   * 0010's rule is to ask for the folder again rather than keep two copies of
   * it in the browser. So without this there is no export, and saying so beats
   * writing an index that promises resources no cluster holds.
   */
  swordSource?: {
    /** Sword 1 only: where `swordres.rif` was found, and its bytes. */
    indexFile: string;
    index: Uint8Array;
    clusters: Array<{ name: string; label: string; data: Uint8Array }>;
    /**
     * Sword 1 only: the speech container, when a line in it was replaced.
     *
     * Absent whenever no line was, and that is a size decision rather than a
     * preference: the container is 43.9 MB in the demo, and reading it in to
     * write it back out unchanged would make every save forty megabytes
     * heavier for nothing.
     */
    speech?: Sword1ExportSource['speech'];
    /**
     * Sword 1 only: tunes and effects an author replaced.
     *
     * Unlike the speech container these cost nothing to carry — a tune is its
     * own file and an effect is a resource the cluster loop was relaying
     * anyway — so they are here whenever there are any, and absent rather than
     * empty when there are none.
     */
    music?: Sword1ExportSource['music'];
    /**
     * Effects an author replaced, which both families spell the same way.
     *
     * One field rather than two because the destination is the same shape in
     * both — a resource id and the bytes that become its payload — and the two
     * exporters put them in the same place: inside the cluster that already had
     * to be relaid.
     */
    effects?: Sword1ExportSource['effects'];
    /** Sword II only: `resource.tab`, copied through the export unchanged. */
    resourceTab?: Uint8Array;
    /**
     * Sword II only: every cluster `resource.inf` names, in the order it names
     * them.
     *
     * Not the same list as `clusters`, and the difference is the bug it exists
     * to prevent: `resource.tab` says which cluster a resource is in by that
     * **line number**, so matching a resource to a file by its position among
     * the files that happen to be present reads `TEXT.CLU`'s resources out of
     * `Docks.clu` on any install short of a complete one.
     */
    declared?: readonly string[];
    /**
     * Sword II only: the streamed containers, when a recording in one was
     * replaced.
     *
     * Absent whenever none was, for the same size reason Sword 1's `speech` is:
     * a retail `SPEECH1.CLU` is hundreds of megabytes. Absent on every install
     * reachable from this repository for a different reason — neither demo
     * ships one — which `docs/editor-parity.md` §27a states rather than hides.
     */
    sounds?: Sword2ExportSource['sounds'];
  };
  /**
   * The SCI install the project was imported from, re-supplied.
   *
   * Two things a SCI Project does not carry and could not honestly carry. The
   * **container** — which map structure to write, and what its files are called
   * — is read out of the folder's own bytes by `detectMapVersion`, which never
   * guesses, where a Target's Version is probed and sometimes only bucketed
   * (ADR 0020). Deriving the first from the second would be inventing the
   * container. And the **carried Volumes**: a game's audio and video are not
   * resources this editor holds (#227), so an export copies them and the bytes
   * are in the folder (ADR 0010, ADR 0034).
   *
   * Without it there is no SCI export, and saying so beats packing the
   * resources into a container of this code's choosing — an install that loads
   * and serves the wrong bytes rather than one that fails.
   */
  sciSource?: {
    /** The folder's own name, for the sentence that says where this came from. */
    folderName: string;
    mapVersion: SciMapVersion;
    layout: SciLayout;
    /** `RESOURCE.AUD` and its siblings, as this folder holds them. */
    carried: ReadonlyArray<{ name: string; data: Uint8Array }>;
  };
}

export interface SaveResult {
  files: string[];
  /** Where it went, for the status line. */
  destination: string;
  errors: string[];
  warnings: string[];
}

/**
 * The set of files a project produces.
 *
 * The project JSON is the source of truth and always written. The compiled pair
 * is the playable output, and `manifest.json` is what lets the player load the
 * folder over HTTP without a directory listing.
 */
async function buildFileSet(
  project: Project,
  allowCode: boolean,
  options: SaveOptions = {},
): Promise<{
  files: Array<{ name: string; data: Uint8Array }>;
  errors: string[];
  warnings: string[];
}> {
  const encoder = new TextEncoder();
  const files: Array<{ name: string; data: Uint8Array }> = [
    {
      name: projectFileName(project),
      data: encoder.encode(JSON.stringify(project, null, 2)),
    },
  ];

  /*
   * AGOS, before the SCUMM builder is asked.
   *
   * Not a special case so much as a second exporter: ADR 0030 rebuilds `GAMEPC`
   * whole and its archive beside it, which shares nothing with emitting SCUMM
   * v5 resources — `projectToGame` says as much and refuses. Falling through to
   * that refusal is what used to happen, so Save on an AGOS project wrote the
   * project JSON, reported that the game did not compile, and left the author
   * with no route at all to a playable folder.
   */
  if (project.target.engine === 'agos') {
    const built = exportAgosFiles(project, options.agosArchive);
    // The project file is still worth writing: an author should not lose work
    // because the game cannot currently be rebuilt.
    return { files: [...files, ...built.files], errors: built.errors, warnings: [] };
  }

  /*
   * SCI, for the reason the AGOS arm above gives, arriving at the other door.
   *
   * Save and Export game have to agree about whether a SCI game can be
   * written. `exportGameOnly` packs the install through `packSciGame`; with no
   * arm here Save wrote the project JSON beside a refusal naming SCUMM v5
   * resources, so one project was exportable through one button and broken
   * through the other — the same wrong message the AGOS arm exists to stop.
   *
   * The project file is still written when the pack is refused, for the reason
   * the AGOS arm gives: an author should not lose work because the game cannot
   * currently be rebuilt.
   */
  if (project.target.engine === 'sci') {
    const sci = project.sci;
    if (!sci) {
      return {
        files,
        errors: ['This project is tagged as SCI and holds no SCI game.'],
        warnings: [],
      };
    }

    const source = options.sciSource;
    if (!source) {
      return {
        files,
        errors: [
          'Open the game folder first. A SCI project holds its class graph and its ' +
            'resources and nothing about the container they arrived in — which map ' +
            'structure, what its files are called, and the audio Volumes an export copies ' +
            'rather than rebuilds are all read from the folder (ADR 0010, ADR 0034).',
        ],
        warnings: [],
      };
    }

    const { exportSciGame } = await import('../authoring/sci/exportSciGame.js');
    const { packSciGame } = await import('../authoring/sci/packSciGame.js');

    const built = exportSciGame(sci);
    if (built.problems.length > 0) return { files, errors: built.problems, warnings: [] };

    const packed = packSciGame(built.resources, {
      mapVersion: source.mapVersion,
      layout: source.layout,
      carried: source.carried,
    });
    if (packed.refused.length > 0) {
      return {
        files,
        errors: [
          'The game was not written, because these could not be packed as themselves:',
          ...packed.refused,
        ],
        warnings: [],
      };
    }

    return {
      files: [...files, ...packed.files.map((file) => ({ name: file.name, data: file.data }))],
      errors: [],
      warnings: [
        `${packed.resourceCount} resources packed into ${packed.volumeFile} ` +
          `(${packed.volumeBytes} bytes), every one uncompressed.`,
        ...(packed.carried.length > 0
          ? [`Carried through unrebuilt from ${source.folderName}: ${packed.carried.join(', ')}.`]
          : []),
      ],
    };
  }

  const built = buildProject(project, { allowCode });
  if (built.errors.length > 0) {
    // The project file is still worth writing: the author should not lose work
    // because the game does not currently compile.
    return { files, errors: built.errors, warnings: built.warnings };
  }

  const stem = gameStem(project);
  files.push(
    { name: `${stem}.000`, data: built.index },
    { name: `${stem}.001`, data: built.data },
    {
      name: 'manifest.json',
      data: encoder.encode(
        `${JSON.stringify({ name: project.name, files: [`${stem}.000`, `${stem}.001`] }, null, 2)}\n`,
      ),
    },
  );

  return { files, errors: [], warnings: built.warnings };
}

/**
 * Writes every file into a chosen folder, without a download dialog.
 *
 * Only available where the File System Access API is; `saveWithDownloads` is
 * the fallback.
 */
export async function saveToFolder(
  project: Project,
  folder: DirectoryHandleLike,
  allowCode: boolean,
  options: SaveOptions = {},
): Promise<SaveResult> {
  if (!(await ensureWritable(folder))) {
    return {
      files: [],
      destination: folder.name,
      errors: ['Permission to write to that folder was declined'],
      warnings: [],
    };
  }

  const { files, errors, warnings } = await buildFileSet(project, allowCode, options);
  for (const file of files) await writeInto(folder, file.name, file.data);
  if (errors.length === 0) markExported();

  return { files: files.map((file) => file.name), destination: folder.name, errors, warnings };
}

/** Fallback: one zip download containing everything. */
export async function saveWithDownloads(
  project: Project,
  allowCode: boolean,
  options: SaveOptions = {},
): Promise<SaveResult> {
  const { files, errors, warnings } = await buildFileSet(project, allowCode, options);

  const zip = await createZip(files);
  const safe = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'game';
  download(`${safe}.zip`, zip as BlobPart, 'application/zip');
  if (errors.length === 0) markExported();

  return {
    files: files.map((file) => file.name),
    destination: 'your downloads folder',
    errors,
    warnings,
  };
}

/** Prompts for a folder the first time, then reuses it. */
export async function chooseFolder(): Promise<DirectoryHandleLike | null> {
  if (!canSaveInPlace()) return null;
  return pickFolder();
}

/** Saves everything, in place if a folder is held and by download otherwise. */
export async function save(
  project: Project,
  folder: DirectoryHandleLike | null,
  allowCode: boolean,
  options: SaveOptions = {},
): Promise<SaveResult> {
  return folder
    ? saveToFolder(project, folder, allowCode, options)
    : saveWithDownloads(project, allowCode, options);
}

/**
 * The project, as a file you can keep.
 *
 * A plain `.json` while everything fits inside it, which keeps a small project
 * diffable and easy to hand around. Once audio has been moved to the audio
 * store — because it was too large to inline — the JSON alone is no longer the
 * project: it would open on another machine with every track present in the
 * list and silent. So the export becomes a zip carrying the document and the
 * audio beside it, and stays one thing an author can copy.
 */
export async function exportProjectOnly(project: Project): Promise<void> {
  const external = project.audio.filter(isExternal);

  if (external.length === 0) {
    download(projectFileName(project), JSON.stringify(project, null, 2), 'application/json');
    markExported();
    return;
  }

  const files: ZipFile[] = [
    {
      name: projectFileName(project),
      data: new TextEncoder().encode(`${JSON.stringify(project, null, 2)}\n`),
    },
  ];

  for (const track of external) {
    const bytes = await readTrackBytes(track);
    // A track whose bytes are missing is left out rather than written empty:
    // an empty file in the archive would reimport as a track that exists and
    // plays nothing, which is harder to notice than one that is absent.
    if (bytes) files.push({ name: `${AUDIO_FOLDER}/${track.storeKey}`, data: bytes });
  }

  const safe = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'game';
  download(`${safe}.scummproj.zip`, (await createZip(files)) as BlobPart, 'application/zip');
  markExported();
}

/** Where audio sits inside an exported project archive. */
export const AUDIO_FOLDER = 'audio';

/** Just the playable container, for handing to someone else. */
/**
 * Every imported script the author changed, with where it came from.
 *
 * Scripts with no origin were written in the editor rather than imported, and
 * are not exported: they compile to v5 bytecode, and putting that inside a v6
 * game would produce something no interpreter can run.
 */
function editedScripts(project: Project): EditedScript[] {
  const edits: EditedScript[] = [];

  const collect = (actions: Action[]) => {
    for (const action of actions) {
      if (action.type !== 'raw' || !action.origin) continue;
      edits.push({ ...action.origin, code: fromBase64(action.bytes) });
    }
  };

  for (const room of project.rooms) {
    collect(room.onEnter);
    collect(room.onExit);
    for (const script of room.localScripts ?? []) collect(script.actions);
  }

  return edits;
}

/**
 * Writes an imported game back out with the author's script edits in it.
 *
 * Not a compile. The original files are rewritten, so everything the project
 * cannot describe — art, sound, the resources no importer understands — comes
 * out exactly as it went in. Which is why it needs those files, and returns an
 * explanation rather than a game when they are not there.
 */
/**
 * Every picture the project can address back to the game it came from.
 *
 * Offered whole rather than filtered: whether a picture actually changed is
 * decided by the writer, which has the original bytes to decode and compare
 * against. The editor knows what the pixels are now and nothing about what
 * they were, so deciding it here would mean keeping a second copy of every
 * room's artwork for the length of the session.
 */
function editedArt(project: Project): EditedArt[] {
  const art: EditedArt[] = [];

  for (const room of project.rooms) {
    if (room.artOrigin) {
      art.push({ ...room.artOrigin, image: loadImage(room.background) });
    }
    for (const object of room.objects) {
      const first = object.states[0];
      if (!object.artOrigin || !first) continue;
      art.push({ ...object.artOrigin, image: loadImage(first) });
    }
  }

  return art;
}

export async function exportEditedImport(project: Project): Promise<SaveResult> {
  let source = await getImportedSource();

  // Above the size threshold the originals were never stored, so ask for the
  // folder they came from. Refused by name before anything is written if it is
  // the wrong one — a different release of the same title has its resources at
  // different offsets, and writing into it produces a game that loads and is
  // wrong (ADR 0010).
  if (!source && project.origin && canPickFolder()) {
    const folder = await pickReadableFolder();
    if (folder) {
      const resupplied = await resupplyFrom(folder, project.origin, XOR_NONE);
      if (!resupplied.ok) {
        return { files: [], destination: '', errors: [resupplied.error], warnings: [] };
      }
      source = resupplied.source;
    }
  }

  if (!source) {
    // Two different situations behind one missing source, and telling them
    // apart is the difference between a useful message and a dead end. A
    // project that recorded its origin never stored the files on purpose,
    // because the game was too large to keep a second copy of (ADR 0010); one
    // that did not has lost them.
    return {
      files: [],
      destination: '',
      errors: [
        project.origin
          ? `This game was too large to keep a copy of in the browser, so exporting ` +
            `it needs the original folder again. Supply the folder holding ` +
            `${project.origin.indexFile} and ${project.origin.dataFile}.`
          : 'The original game files are not in this browser, so there is nothing ' +
            'to write the edits back over. Import the game again from the player ' +
            'and the files will be kept alongside the project.',
      ],
      warnings: [],
    };
  }

  // The Version comes from the project rather than from the handoff: the
  // handoff is bytes and a layout, and which opcode table those bytes are is
  // the Target's business (ADR 0012). A handoff written by an older build
  // carries no version at all.
  const version = scummVersionOf(project.target) ?? source.version;
  let written: ExportedFile[];
  try {
    written = exportEditedFiles({ ...source, version }, editedScripts(project), editedArt(project));
  } catch (error) {
    // The `LFL` writer refuses a room that grew past a sixteen bit offset, by
    // name, rather than truncating one — so the refusal is the message.
    return {
      files: [],
      destination: '',
      errors: [(error as Error).message],
      warnings: [],
    };
  }
  const stem = gameStem(project);

  // The language bundle is written beside the container, not inside it. ADR
  // 0009 names this as the worse of the two export failures: a bundle that
  // fails to write is a game full of missing dialogue rather than one that
  // fails to load — so it is built before anything is offered for download, and
  // a failure fails the export.
  let languageFile: { name: string; data: Uint8Array } | null = null;
  if (project.strings) {
    try {
      languageFile = {
        name: project.strings.source,
        data: writeDigLanguageBundle(project.strings),
      };
    } catch (error) {
      return {
        files: [],
        destination: '',
        errors: [
          `The game's text could not be written back: ${(error as Error).message} ` +
            `Nothing has been exported, because a game with the edits and without ` +
            `its dialogue is worse than one that did not export.`,
        ],
        warnings: [],
      };
    }
  }

  // Named the way the layout names them, and encrypted the way it encrypts
  // them — both decided by the writer rather than here, because "the index is
  // in the clear and the containers are not" is a fact about v4 and not about
  // this button. A container game keeps the stem the project was given; the
  // pre-v5 layouts have fixed names (`000.LFL`, `DISK01.LEC`, `01.LFL`) and a
  // renamed one is an install no interpreter finds.
  const named =
    source.layout === 'lecf-container'
      ? written.map((file, i) => ({ ...file, name: i === 0 ? `${stem}.000` : `${stem}.001` }))
      : written;

  const files = named.map((file) => file.name);
  if (languageFile) files.push(languageFile.name);

  const zip = await createZip([
    ...named,
    ...(languageFile ? [{ name: languageFile.name, data: languageFile.data }] : []),
    {
      name: 'manifest.json',
      data: new TextEncoder().encode(`${JSON.stringify({ name: project.name, files }, null, 2)}\n`),
    },
  ]);

  const safe = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'game';
  download(`${safe}-game.zip`, zip as BlobPart, 'application/zip');

  return {
    files: [...files, 'manifest.json'],
    destination: 'your downloads folder',
    errors: [],
    warnings: [],
  };
}

export async function exportGameOnly(
  project: Project,
  allowCode: boolean,
  options: SaveOptions = {},
): Promise<SaveResult> {
  /*
   * An AGOS project is rebuilt rather than compiled, and as a pair.
   *
   * ADR 0030: `GAMEPC` whole because the file has no index, and the archive
   * beside it in the same operation because a base file rebuilt against a stale
   * archive is "a game that loads and then misbehaves". Downloaded as a zip
   * rather than written in place, the way the AGI export below is — the two
   * files are the game, and handing them over together is what keeps them
   * together.
   */
  if (project.target.engine === 'agos') {
    const built = exportAgosFiles(project, options.agosArchive);
    if (built.errors.length > 0) {
      return { files: [], destination: '', errors: built.errors, warnings: [] };
    }
    const zip = await createZip(built.files);
    const name = `${gameStem(project)}-agos.zip`;
    download(name, zip as BlobPart, 'application/zip');
    markExported();
    return {
      files: built.files.map((file) => file.name),
      destination: name,
      errors: [],
      warnings: [],
    };
  }

  /*
   * Both Broken Swords export by rebuilding their clusters, and they do not
   * rebuild the *same* things — which is one more reason they are two families
   * (ADR 0036). Sword1 rewrites `swordres.rif` because it holds every offset;
   * Sword2 leaves `resource.tab` alone because it holds none, and rebuilds each
   * cluster's own tail index instead.
   *
   * Both need the original clusters, which a project does not carry (ADR 0010):
   * an install is hundreds of megabytes, so the folder is asked for again. A
   * missing re-supply is an error rather than a partial write, because half an
   * exported game is worse than none.
   */
  if (project.target.engine === 'sword1' || project.target.engine === 'sword2') {
    const supplied = options.swordSource;
    if (!supplied) {
      return {
        files: [],
        destination: '',
        errors: [
          `Exporting ${describeTarget(project.target)} rebuilds the game's clusters, and this ` +
            `project does not carry them — an install is far too large to keep in the browser ` +
            `(ADR 0010). Open the game folder again and export from there.`,
        ],
        warnings: [],
      };
    }

    try {
      let built: Array<{ name: string; data: Uint8Array }>;
      let rewritten: readonly number[];
      if (project.target.engine === 'sword1') {
        const { exportSword1Game } = await import('../authoring/sword1/export.js');
        if (!project.sword1) throw new Error('This project holds no Broken Sword section.');
        const report = exportSword1Game(
          {
            indexFile: supplied.indexFile,
            index: supplied.index,
            clusters: supplied.clusters,
            speech: supplied.speech,
            music: supplied.music,
            effects: supplied.effects,
          },
          project.sword1,
        );
        built = report.files.map((file) => ({ name: file.name, data: file.data }));
        rewritten = report.rewritten;
      } else {
        const { exportSword2Game } = await import('../authoring/sword2/export.js');
        if (!project.sword2) throw new Error('This project holds no Broken Sword II section.');
        if (!supplied.resourceTab || !supplied.declared) {
          throw new Error(
            "Broken Sword II's export needs resource.inf and resource.tab, which say which " +
              'cluster each resource is in and in what order. Open the whole game folder again.',
          );
        }
        const report = exportSword2Game(
          {
            declared: supplied.declared,
            clusters: supplied.clusters,
            resourceTab: supplied.resourceTab,
            effects: supplied.effects,
            sounds: supplied.sounds,
          },
          project.sword2,
        );
        built = report.files.map((file) => ({ name: file.name, data: file.data }));
        rewritten = report.rewritten;
      }

      const zip = await createZip(built);
      const name = `${gameStem(project)}-${project.target.engine}.zip`;
      download(name, zip as BlobPart, 'application/zip');
      markExported();
      return {
        files: built.map((file) => file.name),
        destination: name,
        errors: [],
        warnings:
          rewritten.length === 0
            ? ['Nothing was edited, so the exported game is byte-identical to the one imported.']
            : [],
      };
    } catch (error) {
      return {
        files: [],
        destination: '',
        errors: [error instanceof Error ? error.message : String(error)],
        warnings: [],
      };
    }
  }

  // An AGI project is exported by re-emitting its own resources into its own
  // volumes, which shares no step with the SCUMM path — there is no index/data
  // pair to build and no bytecode to assemble (ADR 0013).
  if (project.target.engine === 'agi') {
    const { exportAgiGame } = await import('../authoring/agi/exportAgiGame.js');
    const result = exportAgiGame(project);
    if (result.errors.length > 0) {
      return { files: [], destination: '', errors: result.errors, warnings: result.warnings };
    }

    const zip = await createZip(result.files.map((file) => ({ name: file.name, data: file.data })));
    download(`${gameStem(project)}-agi.zip`, zip as BlobPart, 'application/zip');
    return {
      files: result.files.map((file) => file.name),
      destination: `${gameStem(project)}-agi.zip`,
      errors: [],
      warnings: result.warnings,
    };
  }

  /*
   * A SCI project is exported by packing its resources into the container the
   * game arrived in.
   *
   * The step that was missing. `exportSciGame` has always returned a map of
   * resources — every Script, View, Picture, font, cursor and vocabulary, with
   * an untouched one carried through byte for byte (ADR 0018) — and nothing
   * turned that map into files, so a SCI project fell through to the SCUMM
   * builder and was told its game did not compile. `packSciGame` writes the
   * `RESOURCE.MAP` and the Volume; this is where the two meet.
   *
   * The container comes from the folder rather than from the Target, and that
   * is not a shortcut around ADR 0020 — it is the one thing about a SCI install
   * that is never a guess. A Version is probed out of the resources and may
   * end as a bucket; a map structure is read out of the map's own bytes and
   * `detectMapVersion` returns null rather than guessing. So Space Quest 6
   * packs back into the `RESOURCE.MAP` it shipped under rather than into the
   * `RESMAP.000` its Version would suggest.
   *
   * Nothing is written when anything was refused, the rule the AGOS and SCUMM
   * arms already apply: `packSciGame` refuses a value too wide for the field it
   * would go in **by name**, because the alternative is an install that loads
   * and serves the wrong resource.
   */
  if (project.target.engine === 'sci') {
    const sci = project.sci;
    if (!sci) {
      return {
        files: [],
        destination: '',
        errors: ['This project is tagged as SCI and holds no SCI game.'],
        warnings: [],
      };
    }

    const source = options.sciSource;
    if (!source) {
      return {
        files: [],
        destination: '',
        errors: [
          'Open the game folder first. A SCI project holds its class graph and its ' +
            'resources and nothing about the container they arrived in — which map ' +
            'structure, what its files are called, and the audio Volumes an export copies ' +
            'rather than rebuilds are all read from the folder (ADR 0010, ADR 0034).',
        ],
        warnings: [],
      };
    }

    const { exportSciGame } = await import('../authoring/sci/exportSciGame.js');
    const { packSciGame } = await import('../authoring/sci/packSciGame.js');

    const built = exportSciGame(sci);
    if (built.problems.length > 0) {
      return { files: [], destination: '', errors: built.problems, warnings: [] };
    }

    const packed = packSciGame(built.resources, {
      mapVersion: source.mapVersion,
      layout: source.layout,
      carried: source.carried,
    });
    if (packed.refused.length > 0) {
      return {
        files: [],
        destination: '',
        errors: [
          'Nothing was written, because these could not be packed as themselves:',
          ...packed.refused,
        ],
        warnings: [],
      };
    }

    const zip = await createZip(packed.files.map((file) => ({ name: file.name, data: file.data })));
    const name = `${gameStem(project)}-sci.zip`;
    download(name, zip as BlobPart, 'application/zip');
    markExported();

    return {
      files: packed.files.map((file) => file.name),
      destination: name,
      warnings: [
        `${packed.resourceCount} resources packed into ${packed.volumeFile} ` +
          `(${packed.volumeBytes} bytes), every one uncompressed — SCI's readers all accept ` +
          `that and a game Sierra shipped compressed comes back larger.`,
        ...(packed.carried.length > 0
          ? [`Carried through unrebuilt from ${source.folderName}: ${packed.carried.join(', ')}.`]
          : []),
        ...(built.rebuilt.length > 0
          ? [`Scripts rebuilt by the linker: ${built.rebuilt.join(', ')}.`]
          : ['Nothing was edited, so every resource was carried through as it arrived.']),
      ],
      errors: [],
    };
  }

  // A project imported from a published game is rewritten rather than
  // compiled: there is no assembler for authored actions outside v5, and the
  // parts of the game the project cannot describe only exist in the original
  // files. v5 is the exception in both directions — it has an assembler, so a
  // project *built* from intent is a v5 game, and a v5 game imported from
  // files still goes back through the rewriter.
  const scummVersion = scummVersionOf(project.target);
  if (scummVersion !== null && scummVersion !== 5) {
    return exportEditedImport(project);
  }

  const built = buildProject(project, { allowCode });
  if (built.errors.length > 0) {
    return { files: [], destination: '', errors: built.errors, warnings: built.warnings };
  }

  const stem = gameStem(project);
  const zip = await createZip([
    { name: `${stem}.000`, data: built.index },
    { name: `${stem}.001`, data: built.data },
    {
      name: 'manifest.json',
      data: new TextEncoder().encode(
        `${JSON.stringify({ name: project.name, files: [`${stem}.000`, `${stem}.001`] }, null, 2)}\n`,
      ),
    },
  ]);

  const safe = project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'game';
  download(`${safe}-game.zip`, zip as BlobPart, 'application/zip');

  return {
    files: [`${stem}.000`, `${stem}.001`, 'manifest.json'],
    destination: 'your downloads folder',
    errors: [],
    warnings: built.warnings,
  };
}
