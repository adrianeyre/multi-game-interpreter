import { ObjectWhere, ScriptStatus } from '../constants.js';
import type { ScummEngine } from '../ScummEngine.js';
import type { CutSceneLevel, CutSceneOverride } from '../script/ScriptState.js';
import type { SavedScriptArray } from '../script/ScriptArrays.js';
import type { SavedGameEnvelope } from '../AdventureEngine.js';
import { describeTarget, parseTarget, type Target } from '../../authoring/target.js';

/**
 * Saved games.
 *
 * Neither Day of the Tentacle nor Sam & Max is finishable in one sitting, so
 * "completable" is not a claim this engine can make without saves. It had none:
 * a game was playable for exactly as long as the tab stayed open.
 *
 * The format is ours, not ScummVM's `.s01` (ADR 0002). Reading ScummVM's saves
 * would buy interoperability at the price of pinning our internal state layout
 * to the field order of another project's C++ structs, permanently, including
 * for the v5 games that already work. A save made here is for this interpreter,
 * and the UI should not pretend otherwise.
 *
 * It is plain JSON: no typed arrays, no class instances, nothing that needs a
 * custom serialiser. That is what lets a save go into local storage, into a
 * file, or into a test's `expect` without ceremony.
 *
 * **What is deliberately not stored:** anything derivable from the game files.
 * Room graphics, decoded costumes, box matrices and the parsed room are rebuilt
 * on load from the resources, because storing them would make a save both huge
 * and wrong the moment the game files it came from changed.
 */

/** Bumped when the shape changes incompatibly. Refused rather than guessed at. */
export const SAVE_FORMAT = 4;

export interface SavedActor {
  number: number;
  name: string;
  costume: number;
  room: number;
  x: number;
  y: number;
  facing: number;
  targetFacing: number;
  moving: number;
  elevation: number;
  width: number;
  scaleX: number;
  scaleY: number;
  boxScale: number;
  ignoreBoxes: boolean;
  neverZClip: number;
  forceClip: number;
  talkColor: number;
  talkPosX: number;
  talkPosY: number;
  initFrame: number;
  walkFrame: number;
  standFrame: number;
  talkStartFrame: number;
  talkStopFrame: number;
  frame: number;
  animProgress: number;
  animSpeed: number;
  shadowMode: number;
  talking: boolean;
  visible: boolean;
  ignoreTurns: boolean;
  layer: number;
  speedX: number;
  speedY: number;
  palette: number[];
  walkdata: Record<string, number>;
  /** v6 only: the actor's private variables and its walk and talk scripts. */
  animVars: number[];
  walkScript: number;
  talkScript: number;
  sounds: number[];
}

export interface SavedVerb {
  id: number;
  x: number;
  y: number;
  text: string;
  image: number;
  imageRoom: number;
  type: 'text' | 'image';
  color: number;
  hiColor: number;
  dimColor: number;
  bakColor: number;
  key: number;
  center: boolean;
  enabled: boolean;
  dim: boolean;
  saveId: number;
  savedEnabled: boolean;
}

export interface SavedPaintedString {
  text: string;
  x: number;
  y: number;
  color: number;
  charset: number;
}

export interface SavedSlot {
  /**
   * The script number, which is how its code is found again on load.
   *
   * A slot points at a `Uint8Array` while it runs, and that buffer cannot go
   * into a save: it is a window into the game files. The number and `where`
   * are enough to resolve it back, and resolving beats storing because the
   * bytes are the same bytes either way.
   */
  number: number;
  status: ScriptStatus;
  where: ObjectWhere;
  offset: number;
  base: number;
  delay: number;
  delayed: boolean;
  freezeCount: number;
  cutsceneOverride: number;
  recursive: boolean;
  freezeResistant: boolean;
  locals: number[];
}

export interface SavedGame extends SavedGameEnvelope {
  format: number;
  /**
   * The Target that wrote it (ADR 0012).
   *
   * A save is Target-tagged rather than version-tagged because a bare number
   * cannot say which *family* wrote it, and an AGI save restored into SCUMM is
   * not a near miss — it is 255 flags being read as a v6 variable array. Absent
   * in saves written before this field existed, which were all SCUMM and are
   * read as such from `scummVersion`.
   */
  target?: Target;
  /** Which SCUMM version wrote it: a v5 save is not a v6 save. */
  scummVersion: number;
  /** The game it belongs to, so a save cannot be loaded into another game. */
  gameId: string;

  /**
   * Which language bundle was loaded, or null when the game ships none.
   *
   * A v7 save restored into a differently localised release would display the
   * wrong lines for every tag in it — plausible text in the wrong language,
   * which reads as a translation bug rather than as a save that should have
   * been refused. Null is not "unknown": Full Throttle ships no bundle at all,
   * so null against null is a match.
   */
  languageBundle: string | null;

  /**
   * The musical state the game is in, or null for silence.
   *
   * Not the sound that is playing but the state the sequencer is in, which is
   * the distinction iMUSE is built on (ADR 0008): restoring a *track* resumes
   * the right piece from its opening bar, where restoring a *state* resumes the
   * scene. Written for every version, since there is one sequencer rather than
   * two, and null for a game with no music playing.
   */
  musicState: { id: number; crossfadeSeconds: number } | null;
  savedAt: number;
  /** A label for the UI. Never used to identify the save. */
  name: string;

  room: number;
  variables: number[];
  bitVariables: number[];
  objectState: number[];
  objectOwner: number[];
  objectClass: number[];
  objectNames: Array<[number, string]>;
  inventory: number[];
  strings: Array<[number, string]>;

  camera: {
    current: number;
    destination: number;
    min: number;
    max: number;
    /**
     * The second axis, which v7 uses and earlier versions leave at zero.
     *
     * Captured for every version because the camera has one model, not two
     * (ADR 0007). A v5 or v6 save writes zeros here and restores them, which is
     * exactly what it did before this field existed.
     */
    currentY: number;
    destinationY: number;
    minY: number;
    maxY: number;
    following: number;
    moving: boolean;
  };
  cursorState: number;
  userPutCount: number;
  currentCursor: number;
  currentCharsetId: number;

  sentenceQueue: Array<{
    verb: number;
    objectA: number;
    objectB: number;
    preposition: boolean;
    freezeCount: number;
  }>;
  sentenceFrozen: number;

  /**
   * The verb table, which no script rebuilds on its own.
   *
   * A verb is created by a script that has already run and will not run again
   * — Loom builds every piece of its distaff once, out of room 1, and the
   * player is somewhere else by the time they think to save. Left out of the
   * save, a restored game came back with an empty interface and no way to get
   * one: not a verb panel drawn wrongly, a verb panel that is not there.
   *
   * Optional, so a save written before they were kept still loads; it restores
   * with whatever the boot script has put back, which is what it did before.
   */
  verbs?: SavedVerb[];

  /**
   * Strings a script painted into the picture and left there.
   *
   * Pixels in the original, and nothing puts them back either. Loom's note
   * names sit under its distaff for the whole game, printed once when Bobbin
   * picks it up.
   */
  paintedStrings?: SavedPaintedString[];

  actors: SavedActor[];
  /**
   * Script arrays. Empty for v5, which has none, and the whole of a v6 game's
   * script storage — a save without them resumes with every array back at zero.
   */
  scriptArrays: SavedScriptArray[];
  scripts: {
    currentSlot: number;
    startingCutsceneSlot: number;
    cutSceneStack: CutSceneLevel[];
    /**
     * Skip points by cutscene depth. Optional so a save taken before they were
     * kept separately from the levels still loads, with nothing armed.
     */
    cutSceneOverrides?: CutSceneOverride[];
    slots: SavedSlot[];
  };
}

/**
 * Why a game cannot be saved right now, or null when it can.
 *
 * Only one reason so far, and it is deliberate rather than a limitation: the
 * original does not save mid-video, and a save that resumed into the middle of
 * a sequence would be a worse answer than one that declines.
 */
export function describeUnsaveableMoment(engine: ScummEngine): string | null {
  if (engine.videoPlaying) {
    return (
      `A video is playing. The original does not save during one, and a save that ` +
      `resumed into the middle of a sequence would restore into a state no script ` +
      `expects, so this is refused rather than written.`
    );
  }
  return null;
}

/** Everything a save has to put back, read straight off the engine. */
export function captureState(engine: ScummEngine, name = ''): SavedGame {
  const refusal = describeUnsaveableMoment(engine);
  if (refusal) throw new Error(refusal);

  return {
    format: SAVE_FORMAT,
    scummVersion: engine.resources.game.version,
    // Tagged with the Target as well as the version, so a save can be refused
    // for belonging to the other Engine family rather than only for belonging
    // to another SCUMM version (ADR 0012).
    target: engine.target,
    gameId: engine.resources.game.id,
    languageBundle: engine.languageBundle?.source ?? null,
    musicState: engine.sound.sequencer.state ? { ...engine.sound.sequencer.state } : null,
    savedAt: Date.now(),
    name,

    room: engine.currentRoom,
    variables: Array.from(engine.variables),
    bitVariables: Array.from(engine.bitVariables),
    objectState: Array.from(engine.objectState),
    objectOwner: Array.from(engine.objectOwner),
    objectClass: Array.from(engine.objectClass),
    objectNames: [...engine.objectNameOverrides.entries()],
    inventory: [...engine.inventory],
    strings: [...engine.strings.entries()],

    camera: { ...engine.camera },
    cursorState: engine.cursorState,
    userPutCount: engine.userPutCount,
    currentCursor: engine.currentCursor,
    currentCharsetId: engine.currentCharsetId,

    sentenceQueue: engine.sentenceQueue.map((sentence) => ({ ...sentence })),
    sentenceFrozen: engine.sentenceFrozen,

    // Bounds are left out: they are where the verb was last *drawn*, which the
    // next frame works out again from the picture it finds.
    verbs: engine.verbs.all.map((verb) => ({
      id: verb.id,
      x: verb.x,
      y: verb.y,
      text: verb.text,
      image: verb.image,
      imageRoom: verb.imageRoom,
      type: verb.type,
      color: verb.color,
      hiColor: verb.hiColor,
      dimColor: verb.dimColor,
      bakColor: verb.bakColor,
      key: verb.key,
      center: verb.center,
      enabled: verb.enabled,
      dim: verb.dim,
      saveId: verb.saveId,
      savedEnabled: verb.savedEnabled,
    })),

    paintedStrings: engine.paintedStringsForTest().map((line) => ({ ...line })),

    actors: engine.actors.map((actor) => ({
      number: actor.number,
      name: actor.name,
      costume: actor.costume,
      room: actor.room,
      x: actor.x,
      y: actor.y,
      facing: actor.facing,
      targetFacing: actor.targetFacing,
      moving: actor.moving,
      elevation: actor.elevation,
      width: actor.width,
      scaleX: actor.scaleX,
      scaleY: actor.scaleY,
      boxScale: actor.boxScale,
      ignoreBoxes: actor.ignoreBoxes,
      neverZClip: actor.neverZClip,
      forceClip: actor.forceClip,
      talkColor: actor.talkColor,
      talkPosX: actor.talkPosX,
      talkPosY: actor.talkPosY,
      initFrame: actor.initFrame,
      walkFrame: actor.walkFrame,
      standFrame: actor.standFrame,
      talkStartFrame: actor.talkStartFrame,
      talkStopFrame: actor.talkStopFrame,
      frame: actor.frame,
      animProgress: actor.animProgress,
      animSpeed: actor.animSpeed,
      shadowMode: actor.shadowMode,
      talking: actor.talking,
      visible: actor.visible,
      ignoreTurns: actor.ignoreTurns,
      layer: actor.layer,
      speedX: actor.speedX,
      speedY: actor.speedY,
      palette: Array.from(actor.palette),
      walkdata: { ...actor.walkdata } as unknown as Record<string, number>,
      animVars: Array.from(actor.animVars),
      walkScript: actor.walkScript,
      talkScript: actor.talkScript,
      sounds: [...actor.sounds],
    })),

    scriptArrays: engine.scriptState.arrays.capture(),

    scripts: {
      currentSlot: engine.scriptState.currentSlot,
      startingCutsceneSlot: engine.scriptState.startingCutsceneSlot,
      cutSceneStack: engine.scriptState.cutSceneStack.map((level) => ({ ...level })),
      cutSceneOverrides: engine.scriptState.cutSceneOverrides.map((entry) => ({ ...entry })),
      slots: engine.scriptState.slots.map((slot) => ({
        number: slot.number,
        status: slot.status,
        where: slot.where,
        offset: slot.offset,
        base: slot.base,
        delay: slot.delay,
        delayed: slot.delayed,
        freezeCount: slot.freezeCount,
        cutsceneOverride: slot.cutsceneOverride,
        recursive: slot.recursive,
        freezeResistant: slot.freezeResistant,
        locals: Array.from(slot.locals),
      })),
    },
  };
}

/** Why a save cannot be loaded, or null when it can. */
export function describeIncompatibleSave(engine: ScummEngine, saved: SavedGame): string | null {
  // Asked first, and about the *family* rather than the version. A save from
  // the other Engine family shares none of the fields below: its flags are not
  // this engine's bit variables and its room number indexes a different
  // resource space entirely. Checked before the format version because a
  // format number from another family means nothing here (ADR 0002, #131).
  const savedTarget = saved.target ? parseTarget(saved.target) : null;
  if (savedTarget && savedTarget.engine !== 'scumm') {
    return (
      `This save was made by ${describeTarget(savedTarget)} and this is a SCUMM ` +
      `game. The two engines share no state at all — the numbers in one mean ` +
      `nothing in the other — so it is refused rather than read as though they ` +
      `did.`
    );
  }
  if (saved.format !== SAVE_FORMAT) {
    return (
      `This save was written in format ${saved.format} and this version reads ` +
      `format ${SAVE_FORMAT}. Loading it would put the game into a state no ` +
      `script expects, so it is refused rather than half-read.`
    );
  }
  if (saved.gameId !== engine.resources.game.id) {
    return (
      `This save belongs to "${saved.gameId}" and the game loaded is ` +
      `"${engine.resources.game.id}". Object and script numbers mean different ` +
      `things in different games, so it cannot be loaded here.`
    );
  }
  if (saved.scummVersion !== engine.resources.game.version) {
    // The loaded game's actual version, not a guess between two. Written as
    // `saved.scummVersion === 5 ? 6 : 5` while there were only two versions,
    // which reported a v7 game as v5 the moment a third existed.
    return (
      `This save was made from a SCUMM v${saved.scummVersion} game and this one ` +
      `is v${engine.resources.game.version}. The two have different ` +
      `instruction sets, so a script offset from one means nothing in the other.`
    );
  }
  const loadedBundle = engine.languageBundle?.source ?? null;
  if ((saved.languageBundle ?? null) !== loadedBundle) {
    return (
      `This save was made against ${saved.languageBundle ?? 'no language bundle'} and ` +
      `this game has ${loadedBundle ?? 'none'}. The scripts name their lines by tag, ` +
      `so restoring it would show the wrong words rather than fail.`
    );
  }
  return null;
}

/**
 * Puts a saved game back.
 *
 * Order matters. The variables and object tables go back first, because the
 * room load reads them when it decides which objects to draw and in which
 * state. Then the room itself — through `enterRoomData`, which loads the room's
 * data *without* running its entry script, since that script already ran in the
 * session that saved. Then the actors, then the scripts, which are resumed
 * mid-instruction exactly where they were parked.
 */
export function restoreState(engine: ScummEngine, saved: SavedGame): void {
  const refusal = describeIncompatibleSave(engine, saved);
  if (refusal) throw new Error(refusal);

  // Restored, not entered: `restore` puts the state back without a transition,
  // because a crossfade into the music that was already playing is a fade from
  // silence — audible, and not what the player left.
  engine.sound.sequencer.restore(saved.musicState ?? null);

  engine.variables.set(saved.variables.slice(0, engine.variables.length));
  engine.bitVariables.set(saved.bitVariables.slice(0, engine.bitVariables.length));
  engine.objectState.set(saved.objectState.slice(0, engine.objectState.length));
  engine.objectOwner.set(saved.objectOwner.slice(0, engine.objectOwner.length));
  engine.objectClass.set(saved.objectClass.slice(0, engine.objectClass.length));

  engine.objectNameOverrides.clear();
  for (const [id, name] of saved.objectNames) engine.objectNameOverrides.set(id, name);

  engine.inventory = [...saved.inventory];

  engine.strings.clear();
  for (const [id, text] of saved.strings) engine.strings.set(id, text);

  engine.cursorState = saved.cursorState;
  engine.userPutCount = saved.userPutCount;
  engine.currentCursor = saved.currentCursor;
  engine.currentCharsetId = saved.currentCharsetId;

  engine.sentenceQueue.length = 0;
  engine.sentenceQueue.push(...saved.sentenceQueue.map((sentence) => ({ ...sentence })));
  engine.sentenceFrozen = saved.sentenceFrozen;

  // Rebuilds the room from the game files rather than from the save.
  engine.enterRoomData(saved.room);
  Object.assign(engine.camera, saved.camera);

  // After the room, because entering one drops the strings painted over it —
  // and a save's are the ones that were on screen when it was written.
  if (saved.verbs) {
    engine.verbs.reset();
    for (const savedVerb of saved.verbs)
      Object.assign(engine.verbs.getOrCreate(savedVerb.id), savedVerb);
  }
  if (saved.paintedStrings) engine.restorePaintedStrings(saved.paintedStrings);

  for (const savedActor of saved.actors) {
    const actor = engine.actors[savedActor.number];
    if (!actor) continue;
    restoreActor(actor, savedActor);
  }

  engine.scriptState.arrays.restore(saved.scriptArrays ?? []);

  restoreScripts(engine, saved);
}

/**
 * Fields a save cannot assign straight onto the actor.
 *
 * `number` identifies the actor rather than describing it, and the rest are
 * typed arrays or arrays: assigning a plain JS array over `animVars` would
 * replace an `Int32Array` with something that silently accepts out-of-range
 * values.
 */
const COPIED_BY_HAND = new Set(['number', 'palette', 'walkdata', 'animVars', 'sounds']);

function restoreActor(actor: ScummEngine['actors'][number], saved: SavedActor): void {
  const target = actor as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (COPIED_BY_HAND.has(key)) continue;
    target[key] = value;
  }
  // Filled first because a save written when this array was 32 entries long
  // only answers for the first 32, and the rest have to read as "no override"
  // rather than as whatever the actor happened to be wearing before the load.
  actor.palette.fill(0xff);
  actor.palette.set(saved.palette.slice(0, actor.palette.length));
  Object.assign(actor.walkdata, saved.walkdata);
  actor.animVars.fill(0);
  actor.animVars.set((saved.animVars ?? []).slice(0, actor.animVars.length));
  actor.sounds.length = 0;
  actor.sounds.push(...(saved.sounds ?? []));
}

/**
 * Puts the running scripts back, re-resolving each slot's code.
 *
 * A slot holds a reference into the game files while it runs, which cannot be
 * saved. The script number and `where` are enough to find the same bytes again
 * — and *must* be re-resolved rather than stored, because a room's script only
 * exists inside the room resource that is now loaded.
 *
 * A slot whose code cannot be found is dropped with a warning rather than left
 * pointing at nothing: a dead slot loses one script, a slot with a null buffer
 * stops the whole interpreter at its next turn.
 */
function restoreScripts(engine: ScummEngine, saved: SavedGame): void {
  const state = engine.scriptState;

  state.cutSceneStack.length = 0;
  state.cutSceneStack.push(...saved.scripts.cutSceneStack.map((level) => ({ ...level })));
  state.cutSceneOverrides.forEach((entry, depth) => {
    const stored = saved.scripts.cutSceneOverrides?.[depth];
    entry.slot = stored?.slot ?? -1;
    entry.pointer = stored?.pointer ?? -1;
  });
  state.startingCutsceneSlot = saved.scripts.startingCutsceneSlot;
  // Nothing is mid-instruction on load: whatever was running when the save was
  // taken resumes from its stored offset on the next frame, not from inside a
  // half-finished opcode.
  state.currentSlot = -1;

  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i];
    const savedSlot = saved.scripts.slots[i];
    slot.reset();
    if (!savedSlot || savedSlot.status === ScriptStatus.Dead) continue;

    const code = resolveScriptCode(engine, savedSlot);
    if (!code) {
      engine.warn(
        `Saved script ${savedSlot.number} could not be found in this game's files, ` +
          `so it was not resumed`,
      );
      continue;
    }

    slot.number = savedSlot.number;
    slot.status = savedSlot.status;
    slot.where = savedSlot.where;
    slot.data = code;
    slot.base = savedSlot.base;
    slot.offset = savedSlot.offset;
    slot.delay = savedSlot.delay;
    slot.delayed = savedSlot.delayed;
    slot.freezeCount = savedSlot.freezeCount;
    slot.cutsceneOverride = savedSlot.cutsceneOverride;
    slot.recursive = savedSlot.recursive;
    slot.freezeResistant = savedSlot.freezeResistant;
    slot.locals.set(savedSlot.locals.slice(0, slot.locals.length));
  }
}

function resolveScriptCode(engine: ScummEngine, slot: SavedSlot): Uint8Array | null {
  if (slot.where === ObjectWhere.Global) return engine.resources.getScript(slot.number);
  // Local and room scripts, including the inline ENCD/EXCD blocks, live inside
  // the room resource that `enterRoomData` has just loaded.
  return engine.currentRoomData?.data ?? null;
}
