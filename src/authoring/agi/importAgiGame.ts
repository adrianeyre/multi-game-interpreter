/**
 * Turning a loaded AGI game into a Project the editor can open.
 *
 * The counterpart to `importGame.ts`, and much smaller — for a structural
 * reason rather than because it does less. A SCUMM import has to turn bitmaps
 * into images, costumes into poses, box matrices into walk boxes and scripts
 * into either actions or preserved bytes. An AGI import has one job per
 * resource type, and for Logic that job is a decompile with a round-trip check
 * behind it (ADR 0013).
 */

import { toBase64 } from '../base64.js';
import { createProject, type AgiProjectLogic, type Project } from '../project.js';
import { describeUneditableTarget } from '../target.js';
import type { EditableGame } from '../../engine/AdventureEngine.js';
import type { AgiResources } from '../../engine/agi/resource/AgiResources.js';
import type { DetectedAgiGame } from '../../engine/agi/resource/agiDetect.js';
import type { AgiObjectFile } from '../../engine/agi/resource/objects.js';
import type { AgiVocabulary } from '../../engine/agi/resource/words.js';
import { decompileLogic } from './decompileLogic.js';

export interface ImportAgiOptions {
  objectFile: AgiObjectFile;
  vocabulary: AgiVocabulary;
  onProgress?: (done: number, total: number, what: string) => void;
  onLog?: (message: string) => void;
}

/**
 * Imports every resource, decompiling the Logics and counting what did not.
 *
 * Refuses outright when the interpreter version was a guess, which is ADR
 * 0013's rule and is checked here as well as in the Engine: this function is
 * also reachable from the CLI, and a rule enforced in one entry point is a rule
 * with a way round it.
 */
export function importAgiGame(
  resources: AgiResources,
  game: DetectedAgiGame,
  options: ImportAgiOptions,
): EditableGame {
  const refusal = describeUneditableTarget(game.target);
  if (refusal) throw new Error(refusal);

  const log = options.onLog ?? (() => undefined);
  const notes: string[] = [];

  const project: Project = {
    ...createProject(game.id),
    target: game.target,
  };

  const logicNumbers = resources.list('logic');
  const logics: AgiProjectLogic[] = [];
  let unrecoveredCount = 0;

  for (const [index, number] of logicNumbers.entries()) {
    options.onProgress?.(index, logicNumbers.length, `Logic ${number}`);

    const bytes = resources.read('logic', number);
    const result = decompileLogic(bytes, game.target, {
      encryptedMessages: !resources.wasCompressed('logic', number),
    });

    const entry: AgiProjectLogic = { number, bytes: toBase64(bytes) };
    if (result.tree) {
      entry.tree = result.tree;
    } else {
      entry.unrecovered = result.unrecovered ?? 'This Logic could not be decompiled.';
      unrecoveredCount++;
      // Named individually rather than only counted, because the count's whole
      // purpose is to be driven to zero and that needs the construct that
      // caused each one.
      notes.push(`Logic ${number} is Unrecovered: ${entry.unrecovered}`);
    }
    logics.push(entry);
  }

  const carry = (type: 'picture' | 'view' | 'sound') =>
    resources.list(type).map((number) => ({
      number,
      bytes: toBase64(resources.read(type, number)),
    }));

  project.agi = {
    interpreter: {
      identification:
        game.target.engine === 'agi' ? (game.target.identification ?? 'fallback') : 'fallback',
      evidence: game.interpreterNote,
    },
    logics,
    pictures: carry('picture'),
    views: carry('view'),
    sounds: carry('sound'),
    words: [...options.vocabulary.words.entries()],
    inventory: {
      items: options.objectFile.items.map((item) => ({
        name: item.name,
        startRoom: item.startRoom,
      })),
      maxAnimatedObjects: options.objectFile.maxAnimatedObjects,
      encrypted: options.objectFile.encrypted,
    },
    unrecoveredCount,
  };

  // The count is reported with *how the interpreter version was established*,
  // because ADR 0013 is explicit that the number is meaningless without it: a
  // game decoded with the wrong table scores zero.
  const summary =
    `Decompiled ${logicNumbers.length - unrecoveredCount} of ${logicNumbers.length} ` +
    `Logic resources. Unrecovered: ${unrecoveredCount}. ` +
    `Interpreter version ${project.agi.interpreter.identification} — ${game.interpreterNote}.`;
  log(summary);
  notes.push(summary);

  return { project, notes };
}
