import { ANIMATE_FRAME, VAR } from '../engine/constants.js';
import { fromBase64 } from './base64.js';
import type { Assembler } from './Assembler.js';
import { describeTarget, type Target } from './target.js';
import { global } from './values.js';

/**
 * The structured action vocabulary.
 *
 * Verb handlers in the visual editor are lists of these rather than code. The
 * set is deliberately small: it covers what adventure game logic actually does
 * — talk, change state, move, remember a fact, branch on one — and anything
 * beyond that drops to the `code` action rather than growing the vocabulary
 * until it becomes a bad programming language.
 *
 * Every action is plain JSON so a project can be saved, shared and diffed.
 */
export type Action =
  | { type: 'say'; actor: 'ego' | number; text: string }
  | { type: 'wait'; frames: number }
  | { type: 'waitForMessage' }
  | { type: 'walkTo'; x: number; y: number }
  | { type: 'walkToObject'; object: number }
  | { type: 'faceObject'; object: number }
  | { type: 'walkActorTo'; actor: number; x: number; y: number }
  | { type: 'putActorInRoom'; actor: number; room: number; x: number; y: number }
  | { type: 'faceActorAt'; actor: number; target: number }
  | { type: 'setState'; object: number; state: number }
  | { type: 'giveItem'; object: number }
  | { type: 'takeItem'; object: number }
  | { type: 'gotoRoom'; room: number; arriveAt?: number; x?: number; y?: number }
  | { type: 'setFlag'; flag: number; value: number }
  | { type: 'playSound'; sound: number }
  | { type: 'startScript'; script: number }
  | { type: 'animateActor'; actor: 'ego' | number; frame: number }
  | { type: 'if'; flag: number; equals: number; then: Action[]; else?: Action[] }
  | { type: 'code'; source: string }
  /**
   * Bytecode from an imported game that has no action to represent it.
   *
   * Carries both a reading of it and the bytes themselves. The reading is for
   * the author and may be incomplete; the bytes are what compiles, unchanged,
   * so a script the editor only partly understands still behaves exactly as it
   * did in the game it came from. That is the whole point: understanding a
   * script and preserving it are separate problems, and only the second one
   * has to be perfect.
   */
  | {
      type: 'raw';
      listing: string;
      bytes: string;
      note?: string;
      /**
       * Where these bytes came from in the published game.
       *
       * Recorded so an edit can be written back to the game it came out of.
       * Without it a changed script has no address: the exporter would know
       * what the new bytes are and not which of the game's scripts they
       * replace.
       */
      origin?: { room: number; chunkOffset: number; prefix: number };
    };

/** Human-readable labels, shared by the editor UI and error messages. */
export const ACTION_LABELS: Record<Action['type'], string> = {
  say: 'Say',
  wait: 'Wait',
  waitForMessage: 'Wait for speech to finish',
  walkTo: 'Walk to position',
  walkToObject: 'Walk to object',
  faceObject: 'Face object',
  walkActorTo: 'Walk an actor to…',
  putActorInRoom: 'Put an actor in a room',
  faceActorAt: 'Make an actor face…',
  setState: 'Set object state',
  giveItem: 'Give item to player',
  takeItem: 'Take item from player',
  gotoRoom: 'Go to room',
  setFlag: 'Set flag',
  playSound: 'Play sound',
  startScript: 'Run script',
  animateActor: 'Animate actor',
  if: 'If flag is…',
  code: 'Custom code',
  raw: 'Original game code',
};

/**
 * Flags live in a reserved block of globals.
 *
 * Starting at 300 keeps them clear of the engine's own variables (0-72) and of
 * the scratch globals the compiler generates (200-201), so an author numbering
 * flags from 0 can never collide with either.
 */
export const FLAG_BASE = 300;

/**
 * Turns an authored frame number into an `animateActor` argument.
 *
 * The argument is the frame, emitted as it is. Authored frames 1 to 5 name the
 * five standard poses, which go through the pseudo-frames the engine resolves
 * against the actor's own frame numbers — so an authored "animate to frame 3"
 * means the actor's stand pose whatever chore that is in its costume, rather
 * than chore 3.
 *
 * Only the last twelve arguments are reserved for commands, and no authored
 * frame reaches them.
 */
const STANDARD_POSES = [
  ANIMATE_FRAME.Init,
  ANIMATE_FRAME.Walk,
  ANIMATE_FRAME.Stand,
  ANIMATE_FRAME.TalkStart,
  ANIMATE_FRAME.TalkStop,
];

function animateArgument(frame: number): number {
  return STANDARD_POSES[frame - 1] ?? frame;
}

export function flagVar(flag: number) {
  return global(FLAG_BASE + flag);
}

/** How a `code` action's source is compiled. */
export interface CodeCompiler {
  /**
   * Turns a source string into something that emits into an assembler.
   *
   * Supplied by the caller rather than baked in, because compiling it means
   * evaluating the author's JavaScript — a decision the host should make
   * explicitly rather than inherit.
   */
  (source: string): (script: Assembler) => void;
}

export interface EmitContext {
  /** Compiles `code` actions, or throws if custom code is not permitted. */
  compileCode?: CodeCompiler;
  /** Collects problems instead of throwing, so one bad action is not fatal. */
  warnings?: string[];
  /**
   * The SCUMM version being emitted for, when it is not v5.
   *
   * Only the actions that cannot be expressed in the target need consult it;
   * everything else compiles the same way for all of them.
   */
  target?: Target;
}

function actorOperand(actor: 'ego' | number) {
  return actor === 'ego' ? global(VAR.EGO) : actor;
}

/** Emits one action's bytecode. */
export function emitAction(script: Assembler, action: Action, context: EmitContext = {}): void {
  switch (action.type) {
    case 'say':
      if (action.actor === 'ego') script.sayEgo(action.text);
      else script.say(action.actor, action.text);
      break;

    case 'wait':
      script.delay(action.frames);
      break;

    case 'waitForMessage':
      script.waitForMessage();
      break;

    case 'walkTo':
      script.walkActorTo(global(VAR.EGO), action.x, action.y);
      script.waitForActor(global(VAR.EGO));
      break;

    case 'walkToObject':
      script.walkActorToObject(global(VAR.EGO), action.object);
      script.waitForActor(global(VAR.EGO));
      break;

    case 'faceObject':
      script.faceActorTowards(global(VAR.EGO), action.object);
      break;

    case 'walkActorTo':
      script.walkActorTo(action.actor, action.x, action.y);
      break;

    case 'putActorInRoom':
      // Placed before the room, so the actor exists there when it is entered.
      script.putActorInRoom(action.actor, action.room);
      script.putActor(action.actor, action.x, action.y);
      break;

    case 'faceActorAt':
      script.faceActorTowards(action.actor, action.target);
      break;

    case 'setState':
      script.setState(action.object, action.state);
      break;

    case 'giveItem':
      script.pickupObject(action.object);
      break;

    case 'takeItem':
      script.setOwner(action.object, 0);
      break;

    case 'gotoRoom':
      // `loadRoomWithEgo` is the only safe way to change room from a script:
      // the room change kills the running script, so the actor placement has
      // to happen inside the opcode rather than in following instructions.
      script.loadRoomWithEgo(action.arriveAt ?? 0, action.room, action.x ?? -1, action.y ?? -1);
      break;

    case 'setFlag':
      script.move(flagVar(action.flag), action.value);
      break;

    case 'playSound':
      script.startSound(action.sound);
      break;

    case 'startScript':
      script.startScript(action.script);
      break;

    case 'animateActor':
      script.animateActor(actorOperand(action.actor), animateArgument(action.frame));
      break;

    case 'if': {
      const otherwise = action.else;
      if (otherwise && otherwise.length > 0) {
        script.ifElse(
          (s, target) => s.jumpUnlessEqual(flagVar(action.flag), action.equals, target),
          (s) => emitActions(s, action.then, context),
          (s) => emitActions(s, otherwise, context),
        );
      } else {
        script.ifEqual(flagVar(action.flag), action.equals, (s) =>
          emitActions(s, action.then, context),
        );
      }
      break;
    }

    case 'raw':
      script.raw(fromBase64(action.bytes));
      break;

    case 'code': {
      // `compile.ts` emits v5 bytecode and has no mode for anything else, so a
      // custom-code action in another Target's project would compile to
      // instructions the game's own interpreter cannot read. Refused where it
      // can be attributed, rather than mis-compiled (ADR 0004). An AGI project
      // has no `Action`s at all (ADR 0013), so it can only arrive here through
      // a hand-edited file — and the same refusal is the right answer.
      if (context.target && !(context.target.engine === 'scumm' && context.target.version === 5)) {
        const message =
          `A custom code action was skipped: custom code is not supported in a ` +
          `${describeTarget(context.target)} project yet`;
        if (context.warnings) context.warnings.push(message);
        else throw new Error(message);
        break;
      }
      if (!context.compileCode) {
        const message = 'A custom code action was skipped: code is not enabled here';
        if (context.warnings) context.warnings.push(message);
        else throw new Error(message);
        break;
      }
      context.compileCode(action.source)(script);
      break;
    }

    default: {
      // Exhaustiveness: adding a variant without handling it fails to compile.
      const unhandled: never = action;
      throw new Error(`Unknown action: ${JSON.stringify(unhandled)}`);
    }
  }
}

export function emitActions(script: Assembler, actions: Action[], context: EmitContext = {}): void {
  for (const action of actions) emitAction(script, action, context);
}

/** A one-line description of an action, for the editor's list view. */
export function describeAction(action: Action): string {
  switch (action.type) {
    case 'say':
      return `${action.actor === 'ego' ? 'Player' : `Actor ${action.actor}`} says "${truncate(action.text)}"`;
    case 'wait':
      return `Wait ${action.frames} frames`;
    case 'waitForMessage':
      return 'Wait for speech to finish';
    case 'walkTo':
      return `Walk to ${action.x}, ${action.y}`;
    case 'walkToObject':
      return `Walk to object ${action.object}`;
    case 'faceObject':
      return `Face object ${action.object}`;
    case 'walkActorTo':
      return `Actor ${action.actor} walks to ${action.x}, ${action.y}`;
    case 'putActorInRoom':
      return `Actor ${action.actor} → room ${action.room}`;
    case 'faceActorAt':
      return `Actor ${action.actor} faces ${action.target}`;
    case 'setState':
      return `Object ${action.object} → state ${action.state}`;
    case 'giveItem':
      return `Give object ${action.object} to the player`;
    case 'takeItem':
      return `Take object ${action.object} away`;
    case 'gotoRoom':
      return `Go to room ${action.room}`;
    case 'setFlag':
      return `Flag ${action.flag} = ${action.value}`;
    case 'playSound':
      return `Play sound ${action.sound}`;
    case 'startScript':
      return `Run script ${action.script}`;
    case 'animateActor':
      return `Animate ${action.actor === 'ego' ? 'player' : `actor ${action.actor}`} frame ${action.frame}`;
    case 'if':
      return `If flag ${action.flag} = ${action.equals}`;
    case 'code':
      return `Code: ${truncate(action.source.split('\n')[0] ?? '')}`;
    case 'raw': {
      const first = action.listing.split('\n')[0]?.trim() ?? '';
      return first ? `Game code: ${truncate(first)}` : 'Game code';
    }
    default:
      return 'Unknown action';
  }
}

function truncate(text: string, limit = 40): string {
  const single = text.replace(/\n/g, ' ');
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** True if any action anywhere in the tree is custom code. */
export function containsCode(actions: Action[]): boolean {
  return actions.some(
    (action) =>
      action.type === 'code' ||
      (action.type === 'if' && (containsCode(action.then) || containsCode(action.else ?? []))),
  );
}
