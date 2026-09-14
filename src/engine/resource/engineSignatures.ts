/**
 * Recognises game data belonging to engines that are not SCUMM.
 *
 * ScummVM supports around eighty engines, and its freeware download page offers
 * games for many of them — none of which are SCUMM. Dropping Beneath a Steel
 * Sky in here and getting "no index file found" is a bad experience: the files
 * are perfectly valid, they are just for a different interpreter. Naming the
 * engine turns a dead end into an answer.
 */

import { describeImplementedFamilies } from './families.js';

export interface EngineSignature {
  /** The engine's name, as ScummVM calls it. */
  engine: string;
  /** The game, when the files identify one specific title. */
  game?: string;
  /** Every file that must be present for the signature to match. */
  requires: string[];
  /** Any one of these is enough, when `requires` is empty. */
  anyOf?: string[];
}

/**
 * Engines this project does not implement, and how to recognise their data.
 *
 * **AGI is deliberately not here any more.** It was, with a message ending
 * "This project implements SCUMM only", and retiring that line is a structural
 * change rather than a string edit: AGI stopped being a *foreign* engine when
 * it gained an interpreter, so it routes to `looksLikeAgi` in
 * `src/engine/loadEngine.ts` and never reaches this table (#125).
 *
 * **AGOS is deliberately not here any more.** It was, as `Simon`, matching
 * `gamepc` / `simon.gme`, and it leaves for the same structural reason AGI and
 * SCI did: it stopped being a *foreign* engine when it gained an interpreter,
 * so it routes to `looksLikeAgos` in `src/engine/loadEngine.ts` and never
 * reaches this table (ADRs 0027-0030).
 *
 * What that engine can and cannot do is a separate question from which table it
 * belongs in, and the answer is on `AgosEngine` rather than here: it reads,
 * identifies, decompiles and saves, and it does not draw. A player is told that
 * by the status line rather than by a dead end.
 *
 * **Sky is deliberately not here any more**, and it is the fourth family to
 * leave by the same door. It was, matching `sky.dsk`, with the note that "a
 * decision is not an interpreter" and that it would leave "on the same bar the
 * other two cleared and not before". It has: `SkyEngine` reads the game, boots
 * it, and runs its scripts, so it routes to `looksLikeSky` in
 * `src/engine/loadEngine.ts` and never reaches this table (#255).
 *
 * What that engine can and cannot do is a separate question from which table it
 * belongs in — the same distinction AGOS's paragraph draws. It stops where a
 * script calls an mcode nothing implements, and says which one; a player is
 * told that by the status line rather than by a dead end. The bar for leaving
 * this table is having an interpreter, not having a finished one.
 *
 * **Lure is deliberately not here any more**, and it is the fifth family to
 * leave by the same door. It was, matching `disk1.vga`, with the note that "a
 * verified container reader is not an interpreter" and that it would clear the
 * bar the other four cleared and not before. It has: `LureEngine` reads the game
 * and its initial world state — resource 16398, the snapshot the executable
 * restores into a new game (ADR 0024) — so it routes to `looksLikeLure` in
 * `src/engine/loadEngine.ts` and never reaches this table (ADR 0026, #263).
 *
 * What that engine can and cannot do is a separate question from which table it
 * belongs in — the same distinction the paragraphs above draw. It runs no
 * scripts, because Lure's bytecode is a separate system this project does not
 * read yet; a player is told that by the status line rather than by a dead end.
 * The bar for leaving this table is having an interpreter's foundation, not
 * having a finished one.
 *
 * **Sword1 and Sword2 are deliberately not here any more**, and they are the
 * sixth and seventh families to leave by the same door. They were, matching
 * `swordres.rif` and `general.clu`, and they leave for the structural reason
 * the four above did: they stopped being *foreign* engines when they gained
 * interpreters, so they route to `looksLikeSword1` and `looksLikeSword2` in
 * `src/engine/loadEngine.ts` and never reach this table (ADR 0036).
 *
 * The `general.clu` entry is worth a sentence on its way out, because it was
 * **wrong** as well as obsolete: *both* Broken Swords ship a cluster with that
 * name, so a folder holding either game matched the Sword2 signature and a
 * folder holding both matched whichever entry came first. `looksLikeSword2`
 * keys on the two index files instead, which is evidence only that game has.
 *
 * What each engine can and cannot do is a separate question from which table it
 * belongs in — the same distinction the paragraphs above draw. Sword1 plays,
 * draws and edits and skips its cutscenes; Sword2 runs, draws and edits and
 * does not walk. A player is told that by the status line rather than by a dead
 * end.
 *
 * **SCI is deliberately not here any more either**, and for the same reason AGI
 * left. It was, with the comment "SCI stays, and stays refused. #115: a separate
 * decision, not a follow-on". That decision has now been taken (#211, ADRs
 * 0015-0021): SCI stopped being a *foreign* engine when it gained an
 * interpreter, so it routes to `looksLikeSci` in `src/engine/loadEngine.ts` and
 * never reaches this table (#216).
 */
const SIGNATURES: EngineSignature[] = [
  {
    engine: 'Queen',
    game: 'Flight of the Amazon Queen',
    requires: [],
    anyOf: ['queen.1', 'queen.1c'],
  },
  {
    engine: 'Drascula',
    game: 'Dráscula: The Vampire Strikes Back',
    requires: [],
    anyOf: ['packet.001'],
  },
  { engine: 'DreamWeb', game: 'DreamWeb', requires: [], anyOf: ['dreamweb.r00', 'dreamweb.exe'] },
  { engine: 'Sword25', game: 'Broken Sword 2.5', requires: [], anyOf: ['data.b25c'] },
  { engine: 'CGE', game: 'Sołtys', requires: ['vol.cat', 'vol.dat'] },
  { engine: 'CGE2', game: 'Sfinx', requires: [], anyOf: ['vol.cat'] },
  { engine: 'Parallaction', game: 'Nippon Safes, Inc.', requires: [], anyOf: ['disk0'] },
  { engine: 'Wintermute', requires: [], anyOf: ['data.dcp'] },
  { engine: 'SLUDGE', requires: [], anyOf: ['gamedata.slg'] },
  { engine: 'AGS', requires: [], anyOf: ['ac2game.dat', 'acsetup.cfg'] },
  { engine: 'Gob', requires: [], anyOf: ['intro.stk'] },
  { engine: 'Kyra', requires: [], anyOf: ['kyra.dat'] },
  { engine: 'Toon', requires: [], anyOf: ['local.pak'] },
  { engine: 'Grim (GrimE)', requires: [], anyOf: ['grim.tab', 'data000.lab'] },
];

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * Identifies the engine a set of files belongs to, if it is one we recognise
 * and it is not SCUMM.
 */
export function identifyForeignEngine(fileNames: string[]): EngineSignature | null {
  const present = new Set(fileNames.map(baseName));

  for (const signature of SIGNATURES) {
    if (signature.requires.length > 0) {
      if (signature.requires.every((name) => present.has(name))) return signature;
      continue;
    }
    if (signature.anyOf?.some((name) => present.has(name))) return signature;
  }

  return null;
}

/** The files present that made this signature match, for the message. */
function matchedFiles(signature: EngineSignature, fileNames: string[]): string[] {
  const present = new Set(fileNames.map(baseName));
  const candidates = signature.requires.length > 0 ? signature.requires : (signature.anyOf ?? []);
  return candidates.filter((name) => present.has(name));
}

/**
 * A message explaining why these files will not run, and what will.
 *
 * `fileNames` names the marker files the signature matched on. Worth saying
 * now that recognition runs ahead of index detection rather than as its
 * fallback: the verdict can override a file pair that looks like a SCUMM
 * index, so the evidence behind it should be on screen rather than implied.
 */
export function describeForeignEngine(
  signature: EngineSignature,
  fileNames: string[] = [],
): string {
  const families = describeImplementedFamilies();

  const what = signature.game
    ? `${signature.game} does not run here — it uses`
    : `These files do not run here — they belong to`;

  const matched = matchedFiles(signature, fileNames);
  const evidence = matched.length > 0 ? ` Recognised from ${matched.join(', ')}.` : '';

  return (
    `${what} ScummVM's "${signature.engine}" engine, which is a completely ` +
    `different interpreter with its own bytecode and file formats. This project ` +
    `implements ${families}.${evidence}\n\n` +
    `ScummVM's freeware page offers games for many engines, and most of them ` +
    `are none of the above. For something free that does run here, try the ` +
    `LucasArts demos at scummvm.org/demos — the Indiana Jones and the Fate of ` +
    `Atlantis DOS demo is SCUMM v5 — or Sierra's own freely distributed demos, ` +
    `which cover AGI and every SCI Version.`
  );
}
