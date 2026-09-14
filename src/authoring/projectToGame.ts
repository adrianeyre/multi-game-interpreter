import { emitActions, type EmitContext } from './actions.js';
import type { Assembler } from './Assembler.js';
import { ACTOR_SCRIPT_BASE, compileGame, type CompiledGame } from './compile.js';
import { defineGame, type GameBuilder } from './GameBuilder.js';
import { fromBase64 } from './base64.js';
import { loadImage, loadMask } from './imageCodec.js';
import { createImage } from './ImageEncoder.js';
import { global, local } from './values.js';

/** Records whether an actor's verb dispatch matched, for the fallback. */
const HANDLED = global(203);
import {
  anyPoseCels,
  poseCels,
  poseHasArt,
  POSE_DIRECTIONS,
  validateProject,
  type Project,
  type ProjectObject,
  type SpriteCel,
} from './project.js';
import type { CostumeFrame } from './CostumeBuilder.js';
import { describeTarget } from './target.js';

export interface BuildOptions {
  /**
   * Permits `code` actions to be compiled, which means evaluating the
   * project's JavaScript.
   *
   * Off by default. A project is data, and data that arrives from elsewhere —
   * a shared file, a URL — must not execute simply because it was opened. The
   * host turns this on only for a project the author has chosen to trust.
   */
  allowCode?: boolean;
  /** Collects non-fatal problems rather than throwing on the first one. */
  warnings?: string[];
}

/**
 * Compiles the author's JavaScript for a `code` action.
 *
 * The body runs against `s`, the assembler, exactly as a handler written in a
 * `.ts` game file would. `new Function` rather than `eval` keeps it out of the
 * enclosing scope, so a snippet cannot reach the editor's own state.
 */
function makeCodeCompiler(): (source: string) => (script: Assembler) => void {
  return (source: string) => {
    let compiled: (script: Assembler) => void;
    try {
      compiled = new Function('s', `"use strict";\n${source}`) as (script: Assembler) => void;
    } catch (error) {
      throw new Error(
        `Custom code failed to parse: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return compiled;
  };
}

function emitContext(options: BuildOptions): EmitContext {
  return {
    warnings: options.warnings,
    compileCode: options.allowCode ? makeCodeCompiler() : undefined,
  };
}

/** Turns a saved project into the builder the compiler consumes. */
export function projectToGame(project: Project, options: BuildOptions = {}): GameBuilder {
  const context = emitContext(options);

  const game = defineGame({
    name: project.name,
    start: project.start,
    screen: project.screen,
    defaultResponse: project.defaultResponse,
  });

  for (const verb of project.verbs) {
    game.verb({
      id: verb.id,
      text: verb.text,
      x: verb.x,
      y: verb.y,
      color: verb.color,
      hiColor: verb.hiColor,
      key: verb.key || undefined,
    });
  }

  for (const actor of project.actors) {
    // A costume needs poses 1-5 present; an empty one falls back to the first
    // pose that has artwork, so a half-drawn character still walks and talks
    // rather than vanishing.
    //
    // Any facing of it, not the shared drawing and then south. A costume out
    // of a published game stores four genuinely different views, so its shared
    // slot is empty by construction and south is only filled if that view
    // happened to be imported. Asking those two questions of a fully drawn
    // character answered "no artwork", and every pose the import did not reach
    // became the 8x16 block below: a game whose cast was small coloured
    // rectangles, which on a busy background reads as nobody being there.
    const fallback = anyPoseCels(actor.poses.find(poseHasArt));
    const placeholder =
      fallback.length > 0
        ? { image: loadImage(fallback[0].image), hold: fallback[0].hold }
        : { image: createImage(8, 16, 1), hold: 6 };

    const build = (cels: SpriteCel[]) =>
      cels.map((cel) => ({ image: loadImage(cel.image), hold: cel.hold }));

    const poseAt = (index: number): CostumeFrame => {
      const pose = actor.poses[index];
      if (!poseHasArt(pose)) return { all: [placeholder] };

      // Only the facings that actually have their own artwork are written
      // out. The builder falls back to `all` for the rest, and a costume that
      // repeated the same cels four times would be four times the size for
      // nothing.
      const frame: CostumeFrame = {};
      const shared = poseCels(pose, 'all');
      if (shared.length > 0) frame.all = build(shared);

      for (const direction of POSE_DIRECTIONS) {
        const own = pose?.[direction];
        if (own && own.length > 0) frame[direction] = build(own);
      }

      // A pose with per-direction art but no shared art still needs something
      // for any direction it missed, or the actor vanishes when it turns.
      if (!frame.all) {
        frame.all = frame.south ?? frame.west ?? frame.east ?? frame.north ?? [placeholder];
      }
      return frame;
    };

    game.actor({
      id: actor.id,
      name: actor.name,
      talkColor: actor.talkColor,
      walkSpeed: actor.walkSpeed,
      start: actor.start,
      costumeId: actor.costumeId,
      costume: {
        colors: 32,
        palette: [0, ...actor.palette],
        frames: [{}, poseAt(1), poseAt(2), poseAt(3), poseAt(4), poseAt(5)],
      },
    });
  }

  // Costumes the project holds as the published game's own bytes. Written out
  // before anything asks for an id, since theirs are fixed.
  for (const costume of project.costumes ?? []) {
    game.rawCostume(costume.id, fromBase64(costume.bytes));
  }

  for (const room of project.rooms) {
    const builder = game.room({
      id: room.id,
      name: room.name,
      width: room.width,
      height: room.height,
      background: loadImage(room.background),
      zPlanes: room.zPlanes.map(loadMask),
      boxes: room.boxes,
      perspective: room.perspective,
      // An imported room's pixels index its own table, so compiling without it
      // would produce a game whose art is the right shape in the wrong colours.
      palette: room.palette,
    });

    if (room.onEnter.length > 0) {
      builder.onEnter((s) => emitActions(s, room.onEnter, context));
    }
    if (room.onExit.length > 0) {
      builder.onExit((s) => emitActions(s, room.onExit, context));
    }

    for (const local of room.localScripts ?? []) {
      builder.localScript(local.id, (s) => emitActions(s, local.actions, context));
    }

    for (const object of room.objects) {
      addObject(builder, object, context);
    }
  }

  for (const script of project.scripts) {
    game.script(script.id, (s) => emitActions(s, script.actions, context));
  }

  // One verb dispatch script per actor that has anything to say. Objects carry
  // their verb code inside their own chunk; actors have nowhere to put it, so
  // it becomes a global script the sentence script calls by computed id.
  for (const actor of project.actors) {
    if (actor.handlers.length === 0 && actor.otherwise.length === 0) continue;

    game.script(ACTOR_SCRIPT_BASE + actor.id, (s) => {
      const verb = local(0);
      // A flag rather than a jump chain, so "nothing matched" is answerable
      // after the handlers have run.
      s.move(HANDLED, 0);

      for (const handler of actor.handlers) {
        if (handler.actions.length === 0) continue;
        s.ifEqual(verb, handler.verbId, (body) => {
          emitActions(body, handler.actions, context);
          body.move(HANDLED, 1);
        });
      }

      if (actor.otherwise.length > 0) {
        s.ifEqual(HANDLED, 0, (body) => emitActions(body, actor.otherwise, context));
      }
    });
  }

  return game;
}

function addObject(
  room: ReturnType<GameBuilder['room']>,
  object: ProjectObject,
  context: EmitContext,
): void {
  const builder = room.object({
    id: object.id,
    name: object.name,
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    walkTo: object.walkTo,
    facing: object.facing,
    initialState: object.initialState,
    classes: object.classes,
    states: object.states.map(loadImage),
  });

  for (const handler of object.handlers) {
    if (handler.actions.length === 0) continue;
    builder.on(handler.verbId, (s) => emitActions(s, handler.actions, context));
  }
  if (object.otherwise.length > 0) {
    builder.otherwise((s) => emitActions(s, object.otherwise, context));
  }
}

export interface BuildResult extends CompiledGame {
  /** Problems that stopped the build, if any. */
  errors: string[];
}

/**
 * Validates and compiles a project in one step.
 *
 * Validation runs first so the author gets "room 3 has no walk boxes" rather
 * than a failure from deep inside the container writer.
 */
/**
 * Why a project cannot be compiled at all, or null when it can.
 *
 * There is one assembler and it emits v5 bytecode. A v6 project's preserved
 * instructions are v6 and its authored actions would come out v5, in the same
 * script, which is not a game — so the refusal is explicit rather than a build
 * that produces something no interpreter can run (ADR 0004).
 */
export function describeUnbuildableTarget(project: Project): string | null {
  const { target } = project;

  // An AGI project holds no `Action`s and no SCUMM resources, so there is
  // nothing here for this builder to emit. It exports through the Logic
  // emitter instead, which rewrites its volumes (ADR 0013) — so this is a
  // refusal naming the right route, not a missing feature.
  if (target.engine === 'agi') {
    return (
      `This is an ${describeTarget(target)} project, and this builder emits SCUMM ` +
      `v5 resources. An AGI project is exported by re-emitting its Logic, ` +
      `Picture and View resources into its own volumes, which is a different ` +
      `path entirely.`
    );
  }

  // Sky and Lure, refused the way AGI is above: by naming the route that does
  // work rather than by failing later with something about resources.
  //
  // These two need saying separately from AGI because their export is not a
  // resource rewrite at all. ADR 0024 reads each game's object table out of its
  // DOS executable, so exporting one means patching that binary in place at the
  // offsets it was read from *and* rewriting the resource files — and neither
  // half is anything this builder emits.
  if (target.engine === 'sky' || target.engine === 'lure') {
    return (
      `This is a ${describeTarget(target)} project, and this builder emits SCUMM ` +
      `v5 resources. A Virtual Theatre project is exported by rewriting its own ` +
      `resource files and patching its object table back into the game's ` +
      `executable, which is a different path entirely (ADR 0024).`
    );
  }

  // The two Broken Swords, refused the way the families above are: by naming
  // the route that does work rather than failing later with something about
  // resources.
  //
  // Their export is a *cluster* rewrite, and the two are not even the same
  // rewrite. A Sword1 export rebuilds `swordres.rif` and the clusters it
  // indexes; a Sword2 export rebuilds `resource.tab` and each cluster's own
  // tail index. Neither is anything this builder emits, and neither is the
  // other's path either — which is one more reason they are two families
  // (ADR 0036).
  //
  // Worth saying that this is a *builder* refusal and not an editing one, and
  // that the two writers it points at are finished rather than planned:
  // `npm run reexport:sword` re-exports either demo through the editor's own
  // path and diffs every file against the original, and both come back
  // byte-identical — seven of seven for Broken Sword 1, five of five for
  // Broken Sword II — and boot to the room the original boots to after a
  // script edit. This comment used to end "what is missing is a writer", which
  // was the stale half of a contradiction: the writers were both there and had
  // simply never been run against a game.
  if (target.engine === 'sword1' || target.engine === 'sword2') {
    return (
      `This is a ${describeTarget(target)} project, and this builder emits SCUMM ` +
      `v5 resources. A Broken Sword project is exported by rebuilding its own ` +
      `cluster index and the clusters it addresses — which the editor's export ` +
      `does, through \`sword1/export.ts\` or \`sword2/export.ts\`. The two ` +
      `Broken Swords do not share even that path with each other (ADR 0036).`
    );
  }

  // AGOS, refused the way its four predecessors are: by naming the route that
  // works. ADR 0030 exports an AGOS game by rebuilding `GAMEPC` whole and
  // rebuilding the resource archive beside it — "one operation that either
  // produces both or produces neither" — which shares nothing with emitting
  // SCUMM resources.
  //
  // **Its absence was not a missing feature but a wrong message.** With no arm
  // here an AGOS project fell through to the SCUMM Version check below, whose
  // text interpolates `target.version` — and an AGOS Version is a *title*
  // (ADR 0027). So somebody editing Simon the Sorcerer was told their project
  // "targets SCUMM vSimon1", which names the wrong engine, the wrong axis and a
  // Version that does not exist, and offers no route at all.
  if (target.engine === 'agos') {
    return (
      `This is an ${describeTarget(target)} project, and this builder emits SCUMM ` +
      `v5 resources. An AGOS project is exported by rebuilding its \`GAMEPC\` ` +
      `whole and rebuilding its resource archive beside it, together or not at ` +
      `all, which is a different path entirely (ADR 0030).`
    );
  }

  // SCI, the seventh family to reach this line and the last one to be told
  // about a game it does not have.
  //
  // **Its absence was the AGOS fault again, and worse.** With no arm here a SCI
  // project fell past this refusal into `validateProject`, whose errors are
  // SCUMM's own — so somebody editing King's Quest IV was told "The game has no
  // rooms" and "The starting room (1) does not exist". A SCI project has no
  // rooms to have: its world is a class graph, and a room is a Script resource
  // the game's own scripts enter. Two sentences about a concept the family does
  // not own, and no route at all.
  //
  // It names a route that works rather than a missing feature: `packSciGame`
  // writes the `RESOURCE.MAP` and the Volume, and the editor's export goes
  // through it. This line is now only reachable by a caller that asks the SCUMM
  // builder for a SCI game directly.
  if (target.engine === 'sci') {
    return (
      `This is a ${describeTarget(target)} project, and this builder emits SCUMM ` +
      `v5 resources. A SCI project is exported by packing its resources into the ` +
      `container the game arrived in — \`RESOURCE.MAP\` and a Volume, written in ` +
      `the map structure read from the folder rather than guessed from the ` +
      `Version (ADR 0020) — which the editor's export does, through ` +
      `\`packSciGame.ts\`. A SCI project has no rooms, actors or verbs for this ` +
      `builder to emit.`
    );
  }

  // Every SCUMM Version but v5. The compiler emits v5 bytecode and v5
  // containers, which is a fact about the compiler rather than about the
  // Version being refused: a v2 script and a v8 script are as unmixable with v5
  // instructions as a v6 one is, and a v4 project compiled into a `LECF`
  // container is an install no v4 interpreter opens.
  //
  // Written as "not 5" rather than as a list, because the list was v6 and v7
  // while those were the only other Versions and quietly compiled a v4 project
  // into v5 bytecode the moment v4 arrived.
  //
  // **Guarded on the family**, because the message names one: every arm above
  // exists because a family that is not SCUMM reached this line and was told
  // about a SCUMM Version it does not have. The guard is what stops the next
  // family doing it again.
  if (target.engine === 'scumm' && target.version !== 5) {
    return (
      `This project targets SCUMM v${target.version}, and the compiler emits ` +
      `v5 bytecode. Its imported scripts are v${target.version} instructions ` +
      `and cannot be mixed with v5 ones, so it is refused rather than built into ` +
      `something no interpreter can run. An imported game of this version is ` +
      `exported by rewriting its original files rather than by compiling.`
    );
  }
  return null;
}

export function buildProject(project: Project, options: BuildOptions = {}): BuildResult {
  const unbuildable = describeUnbuildableTarget(project);
  if (unbuildable) {
    return {
      errors: [unbuildable],
      warnings: [],
      index: new Uint8Array(0),
      data: new Uint8Array(0),
      stats: { rooms: 0, objects: 0, scripts: 0, costumes: 0, dataBytes: 0 },
    };
  }

  const errors = validateProject(project);
  if (errors.length > 0) {
    return {
      errors,
      warnings: [],
      index: new Uint8Array(0),
      data: new Uint8Array(0),
      stats: { rooms: 0, objects: 0, scripts: 0, costumes: 0, dataBytes: 0 },
    };
  }

  const warnings: string[] = options.warnings ?? [];

  try {
    const game = projectToGame(project, { ...options, warnings });
    const compiled = compileGame(game);
    return { ...compiled, warnings: [...warnings, ...compiled.warnings], errors: [] };
  } catch (error) {
    // A project the compiler cannot build is a problem to report, not an
    // exception to escape with. This is called on every render to keep the
    // status bar honest, so a throw here does not fail one build — it takes
    // the whole editor down, on a project the author then cannot even open to
    // fix.
    return {
      errors: [error instanceof Error ? error.message : String(error)],
      warnings,
      index: new Uint8Array(0),
      data: new Uint8Array(0),
      stats: { rooms: 0, objects: 0, scripts: 0, costumes: 0, dataBytes: 0 },
    };
  }
}
