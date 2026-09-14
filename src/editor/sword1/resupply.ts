/**
 * Opening a Broken Sword folder again, so the editor can reach its sound.
 *
 * ADR 0034's route, taken for the third family. The reason is the one AGOS's
 * `resupply.ts` states and this install makes louder: the demo's speech
 * container alone is 43.9 MB against a project document of a few megabytes, so
 * the recordings are listed by number and their bytes are read from the folder
 * an author re-supplies for the session.
 *
 * ## Files rather than a directory handle
 *
 * AGOS asks for a `DirectoryHandleLike` and names the two files it wants. That
 * cannot work here. Broken Sword keeps its clusters in `CLUSTERS/`, its tunes
 * in `MUSIC/` and its speech in `SPEECH/COWS.MAD`, and the handle interface has
 * `getFileHandle` and no `getDirectoryHandle` — so every one of those is
 * unreachable through it. `pickFolderFiles` hands back the whole tree with each
 * file's relative path, which is what `FileListDataSource` takes, and that
 * source does real range reads through `File.slice`: a two-second line comes
 * out of a 43.9 MB container without reading the container.
 *
 * ## The check, and why it is not a formality
 *
 * The same teeth AGOS's has, against the two facts this family records. A
 * different **release** has its fx table addressed through the other column of
 * `SWORD1_FX` and a speech container indexed differently, so its recordings
 * would play under the wrong numbers — plausible nonsense rather than a
 * failure. And a folder missing clusters the project was imported from would
 * answer nothing for the effects that live in them, which is a silent half of
 * a listing. Both are refused in words.
 */

import type { Project } from '../../authoring/project.js';
import { FileListDataSource, type DataSource } from '../../engine/resource/DataSource.js';
import { identifySword1 } from '../../engine/sword1/resource/swordDetect.js';
import { parseRif, type RifIndex } from '../../engine/sword1/resource/rif.js';
import { sword1SpeechFileIn } from '../../engine/sword1/sound/musicFiles.js';
import {
  readSword1SpeechIndex,
  type Sword1SpeechIndex,
} from '../../engine/sword1/sound/speechIndex.js';
import { pickFolderFiles } from '../files.js';

/** A folder that was offered, checked, and accepted. */
export interface Sword1GameFolder {
  readonly name: string;
  /** Lazy, range-capable, and the only thing that reads a byte. */
  readonly source: DataSource;
  /** Where `swordres.rif` was found, with its real case and directory. */
  readonly indexFile: string;
  /** `swordres.rif`, parsed once: where every effect's sample sits. */
  readonly index: RifIndex;
  /** Cluster label, upper case, to the file in the folder that holds it. */
  readonly clusterFiles: ReadonlyMap<string, string>;
  /** The speech container's index, or null where this release ships none. */
  readonly speech: Sword1SpeechIndex | null;
  /** Whether the fx table's Windows-demo column is the one that addresses it. */
  readonly windowsDemo: boolean;
}

/** Asks for the folder and reads it, or says why it was refused. */
export async function openSword1GameFolder(project: Project): Promise<Sword1GameFolder | string> {
  const chosen = await pickFolderFiles();
  if (!chosen) return 'No folder was chosen.';
  return readSword1GameFolder(chosen.name, chosen.files, project);
}

/**
 * The reading and the checking, without the picker.
 *
 * Separate so it can be tested against a handful of files rather than a
 * browser dialogue nothing can drive.
 */
export async function readSword1GameFolder(
  name: string,
  files: readonly File[],
  project: Project,
): Promise<Sword1GameFolder | string> {
  const sword1 = project.sword1;
  if (!sword1) return 'This is not a Broken Sword project.';

  const source = new FileListDataSource(files, name);
  const names = source.list();

  const rifName = names.find((each) => /(?:^|[/\\])swordres\.rif$/i.test(each));
  if (!rifName) {
    return (
      `${name} holds no swordres.rif. That file is Broken Sword's cluster index, and without ` +
      `it there is no way to find a single resource in the folder — on a retail disc it is ` +
      `inside "clusters".`
    );
  }

  const detected = identifySword1(names);
  if (detected.release !== sword1.identification.release) {
    return (
      `${name} looks like the ${detected.release} release and this project was imported from ` +
      `the ${sword1.identification.release} one. Its effects are addressed through a different ` +
      `column of the fx table and its speech is indexed differently, so its recordings would ` +
      `play under the wrong numbers rather than not play at all.`
    );
  }

  const rifBytes = await source.read(rifName);
  if (!rifBytes) return `${rifName} is in ${name} but could not be read.`;

  let index: RifIndex;
  try {
    index = parseRif(rifBytes);
  } catch (error) {
    return `${rifName} could not be read as a cluster index: ${
      error instanceof Error ? error.message : 'unknown reason'
    }.`;
  }

  // Clusters are matched the way the engine matches them, so the editor and
  // the interpreter cannot disagree about which file a label names.
  const clusterFiles = new Map<string, string>();
  for (const cluster of index.clusters) {
    const label = cluster.label.toUpperCase();
    const wanted = new RegExp(
      `(?:^|[/\\\\])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(clu|clm)$`,
      'i',
    );
    const file = names.find((each) => wanted.test(each));
    if (file) clusterFiles.set(label, file);
  }

  const short = sword1.clusters.present.filter((label) => !clusterFiles.has(label.toUpperCase()));
  if (short.length > 0) {
    return (
      `${name} is missing ${short.join(', ')}, which this project was imported beside. A ` +
      `folder with fewer clusters than the project would list effects that cannot be played ` +
      `rather than say so, so it is refused here instead.`
    );
  }

  const speechFile = sword1SpeechFileIn(names);
  const speech = speechFile ? await readSword1SpeechIndex(source, speechFile) : null;

  return {
    name,
    source,
    indexFile: rifName,
    index,
    clusterFiles,
    speech,
    windowsDemo: sword1.identification.release === 'demo',
  };
}
