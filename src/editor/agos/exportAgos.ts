/**
 * Writing an edited AGOS game back out.
 *
 * ADR 0030 says what this has to be: `GAMEPC` is rebuilt **whole**, because the
 * file has no index and an edit is therefore a new value for the file rather
 * than a patch to a resource; and the resource archive beside it is rebuilt in
 * the same breath, because "a Subroutine moved between them, or a string index
 * that no longer resolves, is a game that loads and then misbehaves". Either
 * both files or neither.
 *
 * The arithmetic is all in `authoring/agos`. What is here is the seam: the
 * editor's serialised Project on one side, `exportAgosGame` on the other, and
 * the two refusals an author can actually meet in between.
 *
 * ## Why the archive is a parameter
 *
 * It is not in the Project and deliberately never will be. ADR 0010's threshold
 * refuses keeping a second copy of a talkie's resources in the browser, and
 * ADR 0034 takes the other road: the author offers the folder again. So the
 * bytes arrive from whatever the shell re-supplied, and an export with no
 * folder behind it is refused by name rather than by producing half a game.
 */

import { exportAgosGame } from '../../authoring/agos/archive.js';
import type { Project } from '../../authoring/project.js';
import { gamePcOf } from './gamePc.js';

export interface AgosExportFiles {
  files: Array<{ name: string; data: Uint8Array }>;
  errors: string[];
}

/**
 * The two files an AGOS export produces, or the reasons it produced neither.
 *
 * Named after the files the project came from, because that is what an AGOS
 * interpreter looks for: a rebuilt base file called anything else is a folder
 * the game does not start from.
 */
export function exportAgosFiles(
  project: Project,
  originalArchive: Uint8Array | undefined,
): AgosExportFiles {
  const agos = project.agos;
  if (!agos) return { files: [], errors: ['This is not an AGOS project.'] };

  if (!agos.editable.editable) {
    // The same gate ADR 0029 puts on every edit, at the last moment it can be
    // applied: writing an edit into a structure that was misread produces a
    // game that loads.
    return {
      files: [],
      errors: [
        `This game is not editable: ${agos.editable.reasons.join('; ')}. It is refused ` +
          `rather than written into a structure that was misread.`,
      ],
    };
  }

  const origin = project.origin;
  if (!origin) {
    return {
      files: [],
      errors: [
        'This project does not record which files it came from, so there is nothing to ' +
          'name the rebuilt game after.',
      ],
    };
  }

  if (!originalArchive) {
    return {
      files: [],
      errors: [
        `An AGOS export rebuilds ${origin.indexFile} and ${origin.dataFile} together or ` +
          `not at all (ADR 0030), and the archive is not in the project — it is far too ` +
          `large to keep a second copy of (ADR 0010). Open the game folder on the Art tab ` +
          `and export again.`,
      ],
    };
  }

  if (project.target.engine !== 'agos') {
    return { files: [], errors: ['This project is not tagged with an AGOS target.'] };
  }

  try {
    const built = exportAgosGame(
      {
        target: project.target,
        game: gamePcOf(agos),
        // The engine-side project's own view of these. `exportAgosGame` reads
        // only `game`, `target` and `editable`, and the last is the gate above
        // restated so the two cannot disagree about whether this may be written.
        items: [],
        strings: [],
        editable: {
          versionProbed: true,
          structurallyAgrees: true,
          roundTrips: true,
          editable: true,
          unrecovered: agos.editable.unrecovered,
          reasons: [],
        },
      },
      originalArchive,
      agos.paintedImages ?? [],
    );
    return {
      files: [
        { name: origin.indexFile, data: built.gamePc },
        { name: origin.dataFile, data: built.archive },
      ],
      errors: [],
    };
  } catch (error) {
    return {
      files: [],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
