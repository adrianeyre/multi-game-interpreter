import type { BoxMatrix } from '../room/BoxMatrix.js';
import { INVALID_BOX } from '../room/Room.js';
import { createCostumeData, type CostumeData } from '../gfx/Costume.js';

export const MF_NEW_LEG = 1;
export const MF_IN_LEG = 2;
export const MF_TURN = 4;
export const MF_LAST_LEG = 8;
export const MF_FROZEN = 0x80;

/** Default frame numbers; `actorOps` can point an actor at different ones. */
/**
 * The v7 value of `forceClip` that means "use the walkbox's own mask".
 *
 * v6 keeps two fields and treats a zero override as "no override". v7 keeps
 * one, so it needs a number that cannot be a plane to say the same thing, and
 * 100 is the one the original picked: every v7 actor starts with it, and the
 * renderer swaps it for the box's mask when it draws. Read as a plane number
 * it is past the end of every room's list, so the actor is masked against
 * nothing and walks in front of scenery it belongs behind.
 */
export const V7_CLIP_FROM_BOX = 100;

export const DEFAULT_INIT_FRAME = 1;
export const DEFAULT_WALK_FRAME = 2;
export const DEFAULT_STAND_FRAME = 3;
export const DEFAULT_TALK_START_FRAME = 4;
export const DEFAULT_TALK_STOP_FRAME = 5;

/**
 * How many private variables a v6 actor has.
 *
 * Sized to the widest index a v6 script can reach through `actorOps`, so an
 * out-of-range write is a script bug rather than a resize.
 */
export const ACTOR_ANIM_VARS = 27;

export interface WalkData {
  destX: number;
  destY: number;
  destBox: number;
  destDir: number;
  curBox: number;
  curX: number;
  curY: number;
  nextX: number;
  nextY: number;
  deltaXFactor: number;
  deltaYFactor: number;
  xfrac: number;
  yfrac: number;
}

function createWalkData(): WalkData {
  return {
    destX: 0,
    destY: 0,
    destBox: 0,
    destDir: 0,
    curBox: 0,
    curX: 0,
    curY: 0,
    nextX: 0,
    nextY: 0,
    deltaXFactor: 0,
    deltaYFactor: 0,
    xfrac: 0,
    yfrac: 0,
  };
}

/**
 * Snaps an arbitrary angle to one of eight compass directions.
 *
 * SCUMM stores facings in degrees but costumes only have four (or eight)
 * direction sets, so every angle the scripts supply is quantised here.
 */
export function toSimpleDir(eightWay: boolean, dir: number): number {
  if (eightWay) {
    const bounds = [22, 72, 107, 157, 202, 252, 287, 337];
    for (let i = 0; i < 7; i++) {
      if (dir >= bounds[i] && dir <= bounds[i + 1]) return i + 1;
    }
    return 0;
  }
  const bounds = [71, 109, 251, 289];
  for (let i = 0; i < 3; i++) {
    if (dir >= bounds[i] && dir <= bounds[i + 1]) return i + 1;
  }
  return 0;
}

export function fromSimpleDir(eightWay: boolean, dir: number): number {
  return eightWay ? dir * 45 : dir * 90;
}

export function normalizeAngle(angle: number): number {
  const temp = (((angle % 360) + 360) % 360) | 0;
  return toSimpleDir(true, temp) * 45;
}

/**
 * One character in the world.
 *
 * Actors own their position, facing, costume animation state and walk queue.
 * The engine drives them once per frame; scripts poke at them through
 * `actorOps`, `walkActorTo`, `animateActor` and friends.
 */
export class Actor {
  readonly number: number;

  name = '';
  costume = 0;
  room = 0;

  x = 0;
  y = 0;

  /** Facing in degrees; 0 is away from the camera, 90 is east. */
  facing = 180;
  targetFacing = 180;

  moving = 0;
  readonly walkdata: WalkData = createWalkData();

  speedX = 8;
  speedY = 2;

  elevation = 0;
  width = 24;
  /** Bottom of the actor's bounding box relative to its feet, for hit tests. */
  bottom = 0;
  top = 0;

  scaleX = 255;
  scaleY = 255;
  boxScale = 255;

  ignoreBoxes = false;
  neverZClip = 0;
  forceClip = 0;
  /**
   * What `forceClip` returns to on a reset.
   *
   * v6 wants zero, which it reads as "no override". v7 has no second field to
   * say that with, so it says it with `V7_CLIP_FROM_BOX` and starts every
   * actor there. Carried on the actor so a reset restores the right one
   * without having to know the version.
   */
  defaultForceClip = 0;

  walkbox: number = INVALID_BOX;

  /**
   * Per-colour overrides for the costume, 0xFF meaning "use the costume's own".
   *
   * 256 entries, not 32, because that is how many an AKOS costume can name: the
   * original sizes this array by version, filling 256 for the new costume
   * format and 32 for the old one, and v7's costumes really do carry 256-entry
   * palettes — 25 of the Dig demo's 50 costumes have more than 32 colours. A
   * 32-entry array leaves every colour above 31 unanswerable, and the answer
   * the renderer reads for a missing entry is not "no override" but zero, which
   * in a cel is transparent. The actors came out with holes in them.
   */
  readonly palette = new Uint8Array(256).fill(0xff);

  talkColor = 15;
  talkPosX = 0;
  talkPosY = -80;

  initFrame = DEFAULT_INIT_FRAME;
  walkFrame = DEFAULT_WALK_FRAME;
  standFrame = DEFAULT_STAND_FRAME;
  talkStartFrame = DEFAULT_TALK_START_FRAME;
  talkStopFrame = DEFAULT_TALK_STOP_FRAME;

  frame = 0;
  cost: CostumeData = createCostumeData();

  animProgress = 0;
  animSpeed = 0;
  /** Shadow palette selected by actorOps 23. Recorded, not yet rendered. */
  shadowMode = 0;
  /** Set while the actor is speaking, so the talk animation keeps running. */
  talking = false;

  visible = false;
  needRedraw = false;
  ignoreTurns = false;
  layer = 0;
  charset = 0;

  /**
   * The actor's own numbered variables, which only v6 scripts use.
   *
   * v6 gave each actor a private array a script can read and write by index
   * (`actorOps`'s "actor variable", and `getAnimateVariable`). DOTT's walk and
   * talk scripts keep their state here rather than in globals, so one actor's
   * animation state cannot be clobbered by another's — which is exactly why it
   * cannot be emulated with globals.
   */
  readonly animVars = new Int32Array(ACTOR_ANIM_VARS);

  /**
   * Scripts the engine runs for this actor while it walks and talks, from v6's
   * `actorOps`. Zero means "no script", which is the ordinary case.
   */
  walkScript = 0;
  talkScript = 0;

  /** Sound ids attached by v6's `actorOps` "sound" form, for footsteps. */
  readonly sounds: number[] = [];

  constructor(number: number) {
    this.number = number;
  }

  /**
   * The properties `actorOps`'s "default" form puts back, and nothing else.
   *
   * Where the actor is, what it is wearing and which way it faces are *not*
   * here, because the instruction that resets an actor's properties does not
   * move it. Day of the Tentacle's intro is the proof: it resets Purple
   * Tentacle mid-scene, sets his costume, colour and name again, and then has
   * him speak — never re-placing him, because the original leaves him standing
   * where he was. Clearing his room instead took him out of the room being
   * drawn, so the script waiting on his animation counter waited for an actor
   * nothing was animating, and the intro never ended.
   *
   * Split out rather than folded into `reset` so the three things a script can
   * ask for are three calls: properties only, properties and identity, or the
   * whole actor.
   */
  resetProperties(): void {
    this.targetFacing = this.facing;
    this.moving = 0;
    this.elevation = 0;
    this.width = 24;
    this.scaleX = 255;
    this.scaleY = 255;
    this.ignoreBoxes = false;
    this.forceClip = this.defaultForceClip;
    this.neverZClip = 0;
    this.talkColor = 15;
    this.talkPosX = 0;
    this.talkPosY = -80;
    this.charset = 0;
    this.layer = 0;
    this.initFrame = DEFAULT_INIT_FRAME;
    this.walkFrame = DEFAULT_WALK_FRAME;
    this.standFrame = DEFAULT_STAND_FRAME;
    this.talkStartFrame = DEFAULT_TALK_START_FRAME;
    this.talkStopFrame = DEFAULT_TALK_STOP_FRAME;
    this.speedX = 8;
    this.speedY = 2;
    this.animSpeed = 0;
    this.shadowMode = 0;
    this.walkScript = 0;
    this.talkScript = 0;
    this.sounds.length = 0;
  }

  /**
   * Who the actor is and where: costume, room, position and facing.
   *
   * The half of a reset a script gets only when it asks for the stronger form.
   */
  clearIdentity(): void {
    this.costume = 0;
    this.room = 0;
    this.x = 0;
    this.y = 0;
    this.facing = 180;
    this.targetFacing = 180;
  }

  /**
   * Everything, including the drawing and animation state.
   *
   * What a new game and a restart need: no costume loaded, no cel part-way
   * through, no counter a script could still be waiting on.
   */
  reset(): void {
    this.clearIdentity();
    this.resetProperties();
    this.walkbox = INVALID_BOX;
    this.palette.fill(0xff);
    this.cost = createCostumeData();
    this.visible = false;
    this.talking = false;
    this.animProgress = 0;
    this.animVars.fill(0);
  }

  isInCurrentRoom(currentRoom: number): boolean {
    return this.room === currentRoom;
  }

  stopMoving(): void {
    this.moving = 0;
  }

  /**
   * Scale for the actor's current position.
   *
   * Boxes carry the perspective information, so an actor that ignores boxes
   * (a floating object, a cutscene puppet) keeps whatever scale a script set.
   */
  getScale(boxes: BoxMatrix | null): number {
    if (this.ignoreBoxes || !boxes) return this.scaleX;
    if (this.walkbox === INVALID_BOX) return this.scaleX;
    return boxes.getScale(this.walkbox, this.x, this.y);
  }

  /** Records which box the actor stands in and refreshes its scale. */
  setBox(boxes: BoxMatrix | null, box: number): void {
    this.walkbox = box;
    if (!boxes || box === INVALID_BOX) return;
    const scale = boxes.getScale(box, this.x, this.y);
    this.boxScale = scale;
    if (!this.ignoreBoxes) {
      this.scaleX = scale;
      this.scaleY = scale;
    }
  }

  /**
   * Rotates one step toward `targetFacing`, taking the shorter way round.
   *
   * Turning is animated rather than instant because the costumes have distinct
   * frames per direction and snapping looks wrong.
   */
  updateActorDirection(): number {
    let from = toSimpleDir(false, this.facing);
    const to = toSimpleDir(false, this.targetFacing);
    const num = 4;

    let diff = to - from;
    if (Math.abs(diff) > num >> 1) diff = -diff;
    if (diff > 0) from++;
    else if (diff < 0) from--;

    from = ((from % num) + num) % num;
    return fromSimpleDir(false, from);
  }

  /**
   * Works out the per-frame movement for a leg of a walk.
   *
   * Movement is tracked in 16.16 fixed point so that diagonal walks accumulate
   * fractional pixels correctly instead of drifting off the intended line.
   */
  calcMovementFactor(nextX: number, nextY: number): boolean {
    if (this.x === nextX && this.y === nextY) return false;

    const diffX = nextX - this.x;
    const diffY = nextY - this.y;

    let deltaYFactor = this.speedY * 0x10000;
    if (diffY < 0) deltaYFactor = -deltaYFactor;

    let deltaXFactor = deltaYFactor * diffX;
    if (diffY !== 0) {
      deltaXFactor = Math.trunc(deltaXFactor / diffY);
    } else {
      deltaYFactor = 0;
    }

    if (Math.abs(Math.trunc(deltaXFactor / 0x10000)) > this.speedX) {
      deltaXFactor = this.speedX * 0x10000;
      if (diffX < 0) deltaXFactor = -deltaXFactor;

      deltaYFactor = deltaXFactor * diffY;
      if (diffX !== 0) {
        deltaYFactor = Math.trunc(deltaYFactor / diffX);
      } else {
        deltaXFactor = 0;
      }
    }

    const walk = this.walkdata;
    walk.xfrac = 0;
    walk.yfrac = 0;
    walk.curX = this.x;
    walk.curY = this.y;
    walk.nextX = nextX;
    walk.nextY = nextY;
    walk.deltaXFactor = deltaXFactor;
    walk.deltaYFactor = deltaYFactor;

    // Face along the dominant axis. The 3:1 bias makes actors prefer facing
    // the camera on shallow diagonals, which is what the artwork expects.
    this.targetFacing =
      Math.abs(diffY) * 3 > Math.abs(diffX)
        ? deltaYFactor > 0
          ? 180
          : 0
        : deltaXFactor > 0
          ? 90
          : 270;

    return true;
  }

  /** Advances one frame along the current leg. Returns false when it ends. */
  actorWalkStep(boxes: BoxMatrix | null): boolean {
    this.needRedraw = true;

    const walk = this.walkdata;

    if (this.walkbox !== walk.curBox && boxes && boxes.contains(walk.curBox, this.x, this.y)) {
      this.setBox(boxes, walk.curBox);
    }

    const distX = Math.abs(walk.nextX - walk.curX);
    const distY = Math.abs(walk.nextY - walk.curY);

    if (Math.abs(this.x - walk.curX) >= distX && Math.abs(this.y - walk.curY) >= distY) {
      this.moving &= ~MF_IN_LEG;
      return false;
    }

    const tmpX = this.x * 0x10000 + walk.xfrac + (walk.deltaXFactor >> 8) * this.scaleX;
    walk.xfrac = tmpX & 0xffff;
    this.x = Math.floor(tmpX / 0x10000);

    const tmpY = this.y * 0x10000 + walk.yfrac + (walk.deltaYFactor >> 8) * this.scaleY;
    walk.yfrac = tmpY & 0xffff;
    this.y = Math.floor(tmpY / 0x10000);

    if (Math.abs(this.x - walk.curX) > distX) this.x = walk.nextX;
    if (Math.abs(this.y - walk.curY) > distY) this.y = walk.nextY;

    if (this.x === walk.nextX && this.y === walk.nextY) {
      this.moving &= ~MF_IN_LEG;
      return false;
    }

    return true;
  }
}
