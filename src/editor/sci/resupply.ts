/**
 * Opening a SCI game folder again, so an export has something to pack into.
 *
 * The same gesture the two Broken Swords and AGOS make (ADR 0034), for a
 * reason that is this family's own. A SCI Project holds a class graph, its
 * Selectors, its Pictures and its Messages — and **nothing about the container
 * those arrived in**. There is no map version on the Target and there could not
 * honestly be one: ADR 0020 says the Version is probed out of the resources and
 * a map structure is read out of the map's own bytes, and the two are separate
 * facts. `detectMapVersion` never guesses; a Target's `version` sometimes is a
 * guess. Deriving one from the other would be inventing the container.
 *
 * So the folder is asked for again, and it answers two questions at once:
 *
 * - **Which container to write.** `game.mapVersion` and `game.layout` come
 *   straight off the bytes the project was imported from, so a packed install
 *   is the shape the game was rather than the shape its Version suggests. Space
 *   Quest 6 is a SCI2.1 game whose map is called `RESOURCE.MAP`, and only the
 *   folder knows that.
 * - **What to carry.** A game's audio and video Volumes are not resources this
 *   editor holds (#227) — nothing in a Project references their contents — so
 *   an export copies them byte for byte, and the bytes are here.
 *
 * ## What it refuses, and what it does not
 *
 * It refuses a folder whose **map structure cannot hold the project's
 * Version** — a SCI1.1 project against a flat SCI0 map is not the game it was
 * imported from, and packing it would write an install that loads and serves
 * the wrong resources. It checks the structure rather than the Version itself,
 * because `VERSIONS_FOR_MAP` is the whole of what a map can say: refusing on
 * an exact Version match would refuse the declared-Version path ADR 0020
 * leaves open, where a person names a Version the probes could only bucket.
 *
 * It does **not** check that the folder is the same *release*, because nothing
 * in a SCI install says so. A resource count is written into the refusal's
 * reasoning nowhere and reported instead, which is the honest shape: the editor
 * says what it opened and lets the author see it is what they meant.
 */

import type { Project } from '../../authoring/project.js';
import { FileListDataSource, type DataSource } from '../../engine/resource/DataSource.js';
import { detectSciGame } from '../../engine/sci/resource/detectSciGame.js';
import { VERSIONS_FOR_MAP, type DetectedSciGame } from '../../engine/sci/resource/sciDetect.js';
import type { SciResources } from '../../engine/sci/resource/SciResources.js';
import { CARRIED_VOLUMES } from '../../authoring/sci/exportSciGame.js';
import { describeSciVersion } from '../../engine/sci/sciVersion.js';
import { pickFolderFiles } from '../files.js';

/** A folder that was offered, read, and accepted. */
export interface SciGameFolder {
  readonly name: string;
  readonly source: DataSource;
  /** The container and the Version, as the folder's own bytes report them. */
  readonly game: DetectedSciGame;
  /** The reader, kept open rather than made resident (ADR 0021). */
  readonly resources: SciResources;
  /**
   * The Volumes an export copies rather than rebuilds, as this folder holds
   * them.
   *
   * Names only, because a talkie's `RESOURCE.AUD` is hundreds of megabytes and
   * reading one to find out it exists is the copy ADR 0010 refuses. The bytes
   * are fetched at the moment an export needs them, by `carriedVolumes` below.
   */
  readonly carriedNames: readonly string[];
}

/** Asks for the folder and reads it, or says why it was refused. */
export async function openSciGameFolder(project: Project): Promise<SciGameFolder | string> {
  const chosen = await pickFolderFiles();
  if (!chosen) return 'No folder was chosen.';
  return readSciGameFolder(chosen.name, chosen.files, project);
}

/** The reading and the checking, without the picker. */
export async function readSciGameFolder(
  name: string,
  files: readonly File[],
  project: Project,
): Promise<SciGameFolder | string> {
  if (project.target.engine !== 'sci' || !project.sci) return 'This is not a SCI project.';
  const wanted = project.target.version;

  const source = new FileListDataSource(files, name);

  let detected: { game: DetectedSciGame; resources: SciResources };
  try {
    detected = await detectSciGame(source, { onLog: () => undefined });
  } catch (error) {
    return error instanceof Error ? error.message : `${name} could not be read as a SCI install.`;
  }

  const bucket = VERSIONS_FOR_MAP[detected.game.mapVersion];
  if (!bucket.includes(wanted)) {
    return (
      `${name} holds a ${detected.game.mapVersion} resource map, and that container never ` +
      `carried a ${describeSciVersion(wanted)} game — it holds ` +
      `${bucket.map(describeSciVersion).join(', ')}. This project would be packed into a map ` +
      `whose entries address its resources at the wrong widths, which is an install that ` +
      `loads and serves the wrong bytes rather than one that fails.`
    );
  }

  const present = new Set(source.list().map((file) => baseName(file).toUpperCase()));
  const carriedNames = CARRIED_VOLUMES.filter((volume) => present.has(volume));

  return { name, source, game: detected.game, resources: detected.resources, carriedNames };
}

/**
 * The carried Volumes' bytes, read at the moment an export needs them.
 *
 * Late rather than at open, because this is where the size is. Every other
 * thing the folder answers is a map read — under four kilobytes for every
 * release checked — and reading `RESOURCE.AUD` at open would make the gesture
 * that lights up the Audio rows cost a talkie's whole speech container.
 */
export async function carriedVolumes(
  folder: SciGameFolder,
): Promise<Array<{ name: string; data: Uint8Array }>> {
  const carried: Array<{ name: string; data: Uint8Array }> = [];
  for (const name of folder.carriedNames) {
    const data = await folder.source.read(name);
    // A Volume the folder lists and cannot hand over is left out rather than
    // written empty: an export that wrote a zero-byte `RESOURCE.AUD` would
    // produce an install that looks complete and has no speech in it.
    if (data) carried.push({ name, data });
  }
  return carried;
}

function baseName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}
