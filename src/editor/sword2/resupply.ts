/**
 * Opening a Broken Sword II folder again, so the editor can reach its sound.
 *
 * The same gesture Sword 1's `resupply.ts` describes, against a different
 * index, and a separate file for ADR 0036's reason: these two families share a
 * widget and a codec, never a record. Sword 1 is checked against a parsed
 * `swordres.rif` and a speech container that the index knows nothing about;
 * Sword II has one dense id space in `resource.tab` and three kinds of sound
 * told apart by which cluster holds them.
 *
 * ## The check
 *
 * The release first, because a different one addresses the same numbers
 * differently, and then the clusters the project was imported beside. The demo
 * ships fourteen clusters and neither `speech.clu` nor `music.clu`; a retail
 * install ships both. A folder holding fewer clusters than the project would
 * list recordings that answer nothing, which is worse than a refusal because
 * it looks like a working listing.
 */

import type { Project } from '../../authoring/project.js';
import { FileListDataSource, type DataSource } from '../../engine/resource/DataSource.js';
import { identifySword2 } from '../../engine/sword2/resource/sword2Detect.js';
import {
  Sword2Resources,
  Sword2ResourceError,
} from '../../engine/sword2/resource/Sword2Resources.js';
import { pickFolderFiles } from '../files.js';

/** A folder that was offered, checked, and accepted. */
export interface Sword2GameFolder {
  readonly name: string;
  readonly source: DataSource;
  /**
   * The index, opened but not made resident.
   *
   * `loadStreamed` is the only thing asked of it here, and that reads a
   * resource by range out of whichever cluster holds it — including the two
   * this family never holds whole.
   */
  readonly resources: Sword2Resources;
}

/** Asks for the folder and reads it, or says why it was refused. */
export async function openSword2GameFolder(project: Project): Promise<Sword2GameFolder | string> {
  const chosen = await pickFolderFiles();
  if (!chosen) return 'No folder was chosen.';
  return readSword2GameFolder(chosen.name, chosen.files, project);
}

/** The reading and the checking, without the picker. */
export async function readSword2GameFolder(
  name: string,
  files: readonly File[],
  project: Project,
): Promise<Sword2GameFolder | string> {
  const sword2 = project.sword2;
  if (!sword2) return 'This is not a Broken Sword II project.';

  const source = new FileListDataSource(files, name);
  const names = source.list();

  const detected = identifySword2(names);
  if (detected.release !== sword2.identification.release) {
    return (
      `${name} looks like the ${detected.release} release and this project was imported from ` +
      `the ${sword2.identification.release} one. Every sound in this family is addressed by a ` +
      `resource number, and the two releases number them differently — so its recordings ` +
      `would play under the wrong numbers rather than not play at all.`
    );
  }

  let resources: Sword2Resources;
  try {
    resources = await Sword2Resources.create(source);
  } catch (error) {
    return error instanceof Sword2ResourceError
      ? error.message
      : `${name} could not be read as a Broken Sword II install: ${
          error instanceof Error ? error.message : 'unknown reason'
        }.`;
  }

  const present = new Set(resources.presentClusters.map((each) => each.toLowerCase()));
  const short = sword2.clusters.present.filter((each) => !present.has(each.toLowerCase()));
  if (short.length > 0) {
    return (
      `${name} is missing ${short.join(', ')}, which this project was imported beside. A ` +
      `folder with fewer clusters than the project would list recordings that cannot be ` +
      `played rather than say so, so it is refused here instead.`
    );
  }

  return { name, source, resources };
}
