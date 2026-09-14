/**
 * Broken Sword's logic engine: the cycle, the drivers, and the hundred mcodes.
 *
 * ## The cycle
 *
 * Every cycle walks all 150 sections, skips the dead ones, and for each live
 * object that wants processing calls `processLogic`. `processLogic` is a loop
 * rather than a switch, and that is the design: a driver may change the
 * object's `o_logic` and return 1 to mean "run me again this cycle in the new
 * mode", so an object can go idle -> script -> animate in one cycle. Revolution's
 * own comment calls this "a radical change from S2.0 where once a script
 * finished there was no more processing for that object on that cycle", and it
 * is why a script's `fnAnim` takes effect immediately rather than next frame.
 *
 * After the logic, the same walk registers what to draw: an object whose
 * `o_screen` is the current one is added to the foreground, sorted or
 * background list, and to the mouse list if it wants clicks. So the draw lists
 * are rebuilt from scratch every cycle and are never stale — which is what lets
 * `fnNoSprite` work by clearing two bits.
 *
 * ## What "not implemented" means here
 *
 * All hundred mcodes are present and all hundred are *named*. The ones that
 * drive the world — logic modes, animation, the mega system, the walk router,
 * events, speech text, inventory, palettes, the draw lists — are implemented.
 * The ones that need a subsystem this family does not have yet are recorded by
 * name in `unimplemented` and return `SCRIPT_CONT` so the calling script
 * carries on rather than stopping.
 *
 * That is AGOS's precedent applied here: "implements the common opcodes and
 * names the rest", with the status line saying which. The distinction that
 * matters is that a *named, counted, continued* mcode leaves a game playable
 * with something missing, where an unknown one leaves it stopped — and the
 * report says which mcodes a particular playthrough actually reached, rather
 * than which exist.
 */

import { CPT, type SwordCompact } from '../resource/swordCompact.js';
import {
  SWORD1_GEO_TLK_TABLE,
  SWORD1_ITM_PER_SEC,
  SWORD1_PLAYER,
  SWORD1_STAND,
  SWORD1_TOTAL_SECTIONS,
  SwordLogicMode,
  SwordStatus,
  SwordType,
} from '../resource/swordDefs.js';
import { SWORD1_SECTION_SCRIPTS, SWORD1_SECTIONS } from '../resource/swordSections.js';
import type { SwordObjects } from '../resource/SwordObjects.js';
import type { SwordResources } from '../resource/SwordResources.js';
import { formatResourceId } from '../resource/rif.js';
import { SWORD1_NUM_SCRIPT_VARS, SWORD1_SCRIPT_VAR_INIT } from './scriptVars.js';
import {
  Sword1HelperScript,
  Sword1StartOpcode,
  SWORD1_HELPER_DATA,
  SWORD1_MAX_START_POSITION,
  SWORD1_START_DATA,
} from './startPositions.js';
import { sword1McodeName, SWORD1_MCODE_COUNT } from './mcodeNames.js';
import { SV } from './swordVarIndex.js';
import { SCRIPT_CONT, SCRIPT_STOP, SwordEvents } from './SwordEvents.js';
import { RouteResult, SwordRouter, whatTarget } from './SwordRouter.js';
import {
  checkSword1ScriptModule,
  interpretSword1Script,
  type SwordScriptHost,
} from './SwordInterpreter.js';
import { parseSword1ScriptModule, type Sword1ScriptModule } from './swordTokens.js';
import {
  SWORD1_RETAIL_VAR_LAYOUT,
  sword1VarLayout,
  type SwordVarLayout,
} from './swordVarLayout.js';

// `swordDefs.ts` and the generated `swordSections.ts` both state the section
// count, from different sources — the game's own header and the table's own
// length. They agreeing is a cheap check that the generator ran against the
// right reference, so it is asserted rather than assumed.
if (SWORD1_SECTIONS !== SWORD1_TOTAL_SECTIONS) {
  throw new Error('the section count disagrees between swordDefs and the generated table');
}

/** `LAST_FRAME` — `fnSetFrame`'s "the last one, whatever that is". */
const LAST_FRAME = 999;

/** What the logic engine needs from the rest of the engine. */
export interface SwordLogicHost {
  /** Adds an object to the foreground (0), sorted (1) or background (2) list. */
  addToGraphicList(list: 0 | 1 | 2, id: number): void;
  /** Adds an object to this cycle's mouse-hit list. */
  addToMouseList(id: number, compact: SwordCompact): void;
  /** Starts a palette fade. Negative speed fades down. */
  fadePalette(speed: number, up: boolean): void;
  /** True while a fade is still running, which `fnCheckFade` returns. */
  stillFading(): number;
  /** Sets a palette range from a resource. */
  setPalette(start: number, length: number, resourceId: number): void;
  setFadeTargetPalette(start: number, length: number, resourceId: number): void;
  /** A one-frame screen flash or border colour. */
  flash(colour: number): void;
  /** Sets a screen's parallax layer. */
  setParallax(screen: number, resourceId: number): void;
  /** Queues a sound effect; returns whatever the script should see. */
  playFx(fxNo: number): number;
  stopFx(fxNo: number): void;
  playMusic(tuneId: number, looped: boolean): void;
  stopMusic(): void;
  /** Starts a speech line, and says whether recorded speech is actually playing. */
  startSpeech(section: number, line: number): boolean;
  /** True when the current speech sample has finished. */
  speechFinished(): boolean;
  stopSpeech(): void;
  /** Builds a text sprite and returns the text compact's id, or 0. */
  makeTextSprite(textId: number, width: number, pen: number): number;
  /** Drops a text sprite the speech driver has finished with. */
  releaseText(textCompactId: number): void;
  /** The text sprite's size, for placing it above a speaker's head. */
  textSpriteSize(textCompactId: number): { width: number; height: number } | null;
  /** How long the text should stay up, from the line's own length. */
  textDuration(textId: number): number;
  /** Mouse state the engine owns: pointer, luggage, and the on/off counters. */
  mouse: {
    noHuman(): void;
    addHuman(): void;
    blank(): void;
    normal(): void;
    lock(): void;
    unlock(): void;
    setPointer(tag: number, rate: number): void;
    setLuggage(tag: number, rate: number): void;
    /** Which buttons went down this cycle, so speech can be clicked through. */
    testEvent(): number;
  };
  /** The conversation menus, which are their own subsystem. */
  menu: {
    startMenu(): void;
    endMenu(): void;
    releaseMenu(): void;
    addSubject(subject: number): void;
    startChooser(compact: SwordCompact): void;
    endChooser(): void;
    /** Runs one cycle of the chooser; the return is `processLogic`'s. */
    logicChooser(compact: SwordCompact): number;
    refreshTop(): void;
  };
  /** Plays a cutscene. Returns false when this project cannot play it. */
  playSequence(sequenceId: number): boolean;
  /** The game asked to quit, restart, or show its death screen. */
  requestQuit(reason: 'quit' | 'restart' | 'death' | 'the-end'): void;
  /** A random integer in `[min, max]`. Injectable so a test is deterministic. */
  random(min: number, max: number): number;
  /** Asks for a resource to be made resident; `fnPreload`'s whole job. */
  preload(resourceId: number): void;
  /** Notes something worth a log line. */
  log?(message: string): void;
}

/** One text line waiting to be drawn, as the speech driver leaves it. */
export interface SwordSpeechState {
  running: number;
  finished: boolean;
  textRunning: boolean;
  textNumber: number;
}

export class SwordLogic implements SwordScriptHost {
  /** The globals. One array, shared by every script, exactly as in the original. */
  readonly scriptVars = new Int32Array(SWORD1_NUM_SCRIPT_VARS);

  readonly events = new SwordEvents();
  readonly router: SwordRouter;

  /** Mcode number -> how many times a script called one this project skips. */
  readonly unimplemented = new Map<number, number>();
  /** Faults the interpreter reported, newest last, capped. */
  readonly faults: string[] = [];

  readonly speech: SwordSpeechState = {
    running: 0,
    finished: true,
    textRunning: false,
    textNumber: 0,
  };

  /** Cycles left before a click can cut speech short. */
  private speechClickDelay = 0;
  /** `fnNewScript`'s argument, read by the `LOGIC_new_script` driver. */
  private newScript = 0;
  /** Script modules, cached by resource id — parsing is not free and is pure. */
  private readonly modules = new Map<number, Sword1ScriptModule>();

  /** Cycles run, for the stall report. */
  cycles = 0;

  /**
   * Which global a script's variable number means on this Release.
   *
   * Retail numbering until `initialise` says otherwise, because that is what a
   * test with no install behind it is running.
   */
  private varLayout: SwordVarLayout = SWORD1_RETAIL_VAR_LAYOUT;

  constructor(
    private readonly objects: SwordObjects,
    private readonly resources: SwordResources,
    private readonly host: SwordLogicHost,
  ) {
    this.router = new SwordRouter(objects, resources);
  }

  /**
   * `IT_PUSHVARIABLE 909` is a slot in the Release's enum, not a name.
   *
   * The globals here are always retail-numbered so that `SV.SCREEN` means one
   * thing and a saved game has one shape; this is where a Release that numbers
   * them differently is translated. `swordVarLayout.ts` has the measurement.
   */
  scriptVarIndex(number: number): number {
    return this.varLayout.toRetail[number] ?? number;
  }

  /** The game's own starting world: 95 non-zero globals out of 1,179. */
  initialise(demo: boolean): void {
    this.varLayout = sword1VarLayout(demo ? 'demo' : 'retail');
    this.scriptVars.fill(0);
    for (const [variable, value] of SWORD1_SCRIPT_VAR_INIT) {
      if (variable < this.scriptVars.length) this.scriptVars[variable] = value;
    }
    if (demo) this.scriptVars[SV.PLAYINGDEMO] = 1;
    this.speech.running = 0;
    this.speech.finished = true;
    this.speech.textRunning = false;
  }

  getVar(number: number): number {
    return this.scriptVars[number] ?? 0;
  }

  setVar(number: number, value: number): void {
    if (number >= 0 && number < this.scriptVars.length) this.scriptVars[number] = value | 0;
  }

  onFault(message: string): void {
    // Capped, because a script faulting once usually faults every cycle and an
    // unbounded list is a memory leak with a log attached.
    if (this.faults.length < 50 && !this.faults.includes(message)) this.faults.push(message);
  }

  /**
   * Set for the rest of the cycle when a film was started in it.
   *
   * ScummVM's `fnPlaySequence` *blocks*: `player->play()` runs the film to its
   * end inside the mcode, and every object the cycle has not reached yet is
   * reached only afterwards. A film here is drawn across frames by the host
   * instead, so the objects after the one that asked for it would otherwise run
   * underneath a film that has not appeared — which is how the demo's ending
   * was lost: the sewer chamber's script plays `enddemo` and a later object in
   * the same cycle calls `fnQuitGame`, and `step` returns on `hasQuit` before
   * it has drawn a frame. Holding the rest of the cycle back until the film has
   * been drawn puts those objects where the original puts them: after it.
   */
  private filmTaken = false;

  /**
   * A whole logic cycle: events, then every live object, then the draw lists.
   *
   * The screen number is passed in rather than read from `SCREEN`, because the
   * engine sets `SCREEN` from `NEW_SCREEN` at the top of its own outer loop and
   * this function is the inner one.
   */
  engine(): void {
    this.cycles++;
    this.filmTaken = false;
    this.events.serviceGlobalEventList();
    const screen = this.scriptVars[SV.SCREEN];

    for (let section = 0; section < SWORD1_TOTAL_SECTIONS; section++) {
      if (!this.objects.isAlive(section)) continue;
      const count = this.objects.objectCount(section);
      for (let index = 0; index < count; index++) {
        const id = section * SWORD1_ITM_PER_SEC + index;
        const compact = this.objects.fetch(id);
        if (!compact) continue;

        if (compact.status & SwordStatus.LOGIC && !this.filmTaken) {
          if (compact.status & SwordStatus.EVENTS) {
            const mode = compact.logic;
            if (
              mode === SwordLogicMode.PAUSE_FOR_EVENT ||
              mode === SwordLogicMode.IDLE ||
              mode === SwordLogicMode.AR_ANIMATE
            ) {
              this.events.checkForEvent(compact);
            }
          }
          this.processLogic(compact, id);
          // Syncs last one cycle only. Clearing it here rather than where it is
          // read is what makes `fnSendSync` a fire-and-forget.
          compact.sync = 0;
        }

        if (compact.screen === screen) {
          if (compact.status & SwordStatus.FORE) this.host.addToGraphicList(0, id);
          if (compact.status & SwordStatus.SORT) this.host.addToGraphicList(1, id);
          if (compact.status & SwordStatus.BACK) this.host.addToGraphicList(2, id);
          if (compact.status & SwordStatus.MOUSE) this.host.addToMouseList(id, compact);
        }
      }
    }
  }

  /**
   * Runs one object's current logic mode, repeatedly while a driver asks.
   *
   * The `while (logicRet)` is the mechanism described at the top of this file:
   * a driver returning 1 has changed the mode and wants the new one run now.
   * A cap is added that the original does not have, for the same reason the
   * interpreter has a step cap: a mode pair that flips back and forth would
   * otherwise hang the tab rather than report itself.
   */
  private processLogic(compact: SwordCompact, id: number): void {
    let passes = 0;
    let again = true;
    while (again) {
      if (++passes > 64) {
        this.onFault(
          `compact ${id} changed logic mode ${passes} times in one cycle without settling, so ` +
            `the cycle was cut short rather than hanging`,
        );
        return;
      }
      // `!this.filmTaken` is the blocking `fnPlaySequence` again: ScummVM's
      // returns `SCRIPT_CONT` and gets away with it because the film has
      // already finished by the time the next instruction runs, and its
      // `scriptManager` always answers 1 — so a stop that does not also change
      // the logic mode is re-entered immediately, in this loop, and the
      // instruction after the film runs underneath it. See {@link filmTaken}.
      again = this.runLogicMode(compact, id) !== 0 && !this.filmTaken;
    }
  }

  private runLogicMode(compact: SwordCompact, id: number): number {
    switch (compact.logic) {
      case SwordLogicMode.IDLE:
        return 0;

      case SwordLogicMode.PAUSE:
      case SwordLogicMode.PAUSE_FOR_EVENT:
        if (compact.pause) {
          compact.pause = compact.pause - 1;
          return 0;
        }
        compact.logic = SwordLogicMode.SCRIPT;
        return 1;

      case SwordLogicMode.QUIT:
        compact.logic = SwordLogicMode.SCRIPT;
        return 0;

      case SwordLogicMode.WAIT_FOR_SYNC:
        if (compact.sync) {
          compact.logic = SwordLogicMode.SCRIPT;
          return 1;
        }
        return 0;

      case SwordLogicMode.CHOOSE:
        this.scriptVars[SV.CUR_ID] = id;
        return this.host.menu.logicChooser(compact);

      case SwordLogicMode.WAIT_FOR_TALK:
        return this.logicWaitTalk(compact);

      case SwordLogicMode.START_TALK:
        return this.logicStartTalk(compact);

      case SwordLogicMode.SCRIPT:
        this.scriptVars[SV.CUR_ID] = id;
        return this.scriptManager(compact, id);

      case SwordLogicMode.NEW_SCRIPT: {
        const level = compact.scriptLevel;
        compact.setScriptPc(level, this.newScript);
        compact.setScriptId(level, this.newScript);
        compact.logic = SwordLogicMode.SCRIPT;
        return 1;
      }

      case SwordLogicMode.AR_ANIMATE:
        return this.logicArAnimate(compact, id);

      case SwordLogicMode.RESTART: {
        const level = compact.scriptLevel;
        compact.setScriptPc(level, compact.scriptId(level));
        compact.logic = SwordLogicMode.SCRIPT;
        return 1;
      }

      case SwordLogicMode.BOOKMARK:
        compact.copyTree(CPT.BOOKMARK, CPT.TREE);
        compact.logic = SwordLogicMode.SCRIPT;
        return 1;

      case SwordLogicMode.SPEECH:
        return this.speechDriver(compact);

      case SwordLogicMode.FULL_ANIM:
        return this.fullAnimDriver(compact);

      case SwordLogicMode.ANIM:
        return this.animDriver(compact);

      default:
        this.onFault(`compact ${id} is in logic mode ${compact.logic}, which does not exist`);
        compact.logic = SwordLogicMode.IDLE;
        return 0;
    }
  }

  /**
   * Runs the object's script stack until one level of it stops.
   *
   * The `while (!ret)` pops a level each time a script ends, so a script that
   * returns falls back into the one that called it *within the same cycle*. The
   * base level ending is an error in the original; here it is reported and the
   * object goes idle, because an object with no script is a dead object rather
   * than a dead game.
   */
  private scriptManager(compact: SwordCompact, id: number): number {
    for (let guard = 0; guard < 32; guard++) {
      const level = compact.scriptLevel;
      const script = compact.scriptId(level);
      const module = this.lockScript(script);
      if (!module) {
        compact.logic = SwordLogicMode.IDLE;
        return 0;
      }
      const result = interpretSword1Script(
        module,
        this,
        compact,
        id,
        script,
        compact.scriptPc(level) & 0xffff,
      );
      if (result.pc === 0) {
        if (compact.scriptLevel > 0) {
          compact.scriptLevel = compact.scriptLevel - 1;
        } else {
          this.onFault(
            `compact ${id}'s base script ${script} ended. A base script is not allowed to ` +
              `return in Broken Sword, so this object is being left idle rather than run again ` +
              `from nowhere`,
          );
          compact.logic = SwordLogicMode.IDLE;
          return 0;
        }
      } else {
        compact.setScriptPc(level, result.pc);
        return 1;
      }
    }
    this.onFault(`compact ${id} popped 32 script levels in one cycle`);
    compact.logic = SwordLogicMode.IDLE;
    return 0;
  }

  /**
   * The script module a script id lives in, parsed and cached.
   *
   * A script id's *section* selects the resource, which is why one module holds
   * every script of a room: `SWORD1_SECTION_SCRIPTS[section]`.
   */
  private lockScript(scriptId: number): Sword1ScriptModule | null {
    const section = Math.floor(scriptId / SWORD1_ITM_PER_SEC);
    const resourceId = SWORD1_SECTION_SCRIPTS[section] ?? 0;
    if (resourceId === 0) {
      this.onFault(`there is no script resource for section ${section} (script ${scriptId})`);
      return null;
    }
    const cached = this.modules.get(resourceId);
    if (cached) return cached;

    const resource = this.resources.fetch(resourceId);
    if (!resource) {
      this.onFault(`script ${scriptId}: ${this.resources.describeMissingResource(resourceId)}`);
      return null;
    }
    try {
      checkSword1ScriptModule(resource.header.type, resource.header.version);
      const module = parseSword1ScriptModule(resource.payload, this.resources.bigEndian);
      this.modules.set(resourceId, module);
      return module;
    } catch (error) {
      this.onFault(
        `script resource ${formatResourceId(resourceId)}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // The logic drivers
  // -------------------------------------------------------------------------

  private logicWaitTalk(compact: SwordCompact): number {
    const target = this.objects.fetch(compact.get(CPT.DOWN_FLAG));
    if (target && target.status & SwordStatus.TALK_WAIT) {
      compact.logic = SwordLogicMode.SCRIPT;
      return 1;
    }
    return 0;
  }

  private logicStartTalk(compact: SwordCompact): number {
    const waitingFor = compact.get(CPT.DOWN_FLAG);
    const target = this.objects.fetch(waitingFor);
    if (target && target.status & SwordStatus.TALK_WAIT) {
      compact.logic = SwordLogicMode.SCRIPT;
      return SCRIPT_CONT;
    }
    if (this.events.eventValid(waitingFor)) return SCRIPT_STOP;
    // The event expired: the partner is gone, so back to the script with the
    // error code the script tests for.
    compact.set(CPT.DOWN_FLAG, 0);
    compact.logic = SwordLogicMode.SCRIPT;
    return SCRIPT_CONT;
  }

  /**
   * Walks one node of the router's output.
   *
   * `GEORGE_WALKING` is a three-state flag the scripts drive: 1 while walking,
   * 2 for "stop at the end of this step", 3 for "stop now". The odd-looking
   * condition is what makes George finish a step before stopping, which is why
   * he does not freeze mid-stride when a script interrupts a walk.
   */
  private logicArAnimate(compact: SwordCompact, id: number): number {
    if (this.scriptVars[SV.GEORGE_WALKING] === 0 && id === SWORD1_PLAYER) {
      this.scriptVars[SV.GEORGE_WALKING] = 1;
    }

    compact.resource = compact.get(CPT.WALK_RESOURCE);
    compact.status = compact.status | SwordStatus.SHRINK;

    const node = (at: number, field: number): number =>
      compact.get(CPT.ROUTE + at * 20 + field * 4);
    const setNode = (at: number, field: number, value: number): void => {
      compact.set(CPT.ROUTE + at * 20 + field * 4, value);
    };

    let walkPc = compact.get(CPT.WALK_PC);
    compact.frame = node(walkPc, 0);
    compact.x = node(walkPc, 1);
    compact.y = node(walkPc, 2);
    compact.dir = node(walkPc, 4);
    compact.set(CPT.ANIM_X, compact.x);
    compact.set(CPT.ANIM_Y, compact.y);

    const walking = this.scriptVars[SV.GEORGE_WALKING];
    const stopNow =
      (walking === 2 &&
        walkPc > 5 &&
        id === SWORD1_PLAYER &&
        node(walkPc - 1, 3) === 5 &&
        node(walkPc, 3) === 0) ||
      (walking === 3 && id === SWORD1_PLAYER);

    if (stopNow) {
      compact.frame = 96 + compact.dir;
      // On verticals and diagonals stand where George already is, so a stop
      // never shifts him sideways.
      if (compact.dir !== 2 && compact.dir !== 6) {
        compact.x = node(walkPc - 1, 1);
        compact.y = node(walkPc - 1, 2);
        compact.set(CPT.ANIM_X, compact.x);
        compact.set(CPT.ANIM_Y, compact.y);
      }
      compact.logic = SwordLogicMode.SCRIPT;
      compact.set(CPT.DOWN_FLAG, 0);
      this.scriptVars[SV.GEORGE_WALKING] = 0;
      setNode(walkPc + 1, 0, 512);
      if (this.scriptVars[SV.MEGA_ON_GRID] === 2) this.scriptVars[SV.MEGA_ON_GRID] = 0;
    }

    walkPc += 1;
    compact.set(CPT.WALK_PC, walkPc);

    if (node(walkPc, 0) === 512) {
      compact.logic = SwordLogicMode.SCRIPT;
      const stillWalking = this.scriptVars[SV.GEORGE_WALKING];
      if ((stillWalking === 2 || stillWalking === 1) && id === SWORD1_PLAYER) {
        this.scriptVars[SV.GEORGE_WALKING] = 0;
        if (this.scriptVars[SV.MEGA_ON_GRID] === 2) this.scriptVars[SV.MEGA_ON_GRID] = 0;
      }
    }
    return 0;
  }

  /** The animation table a driver steps through: a count then (x, y, frame) triples. */
  private animUnit(
    resourceId: number,
    frameNo: number,
  ): { x: number; y: number; frame: number; frames: number } | null {
    const resource = this.resources.fetch(resourceId);
    if (!resource) {
      this.onFault(
        `animation table ${formatResourceId(resourceId)}: ` +
          this.resources.describeMissingResource(resourceId),
      );
      return null;
    }
    const big = this.resources.bigEndian;
    const view = new DataView(
      resource.payload.buffer,
      resource.payload.byteOffset,
      resource.payload.byteLength,
    );
    if (resource.payload.length < 4) return null;
    const frames = view.getUint32(0, !big);
    const wanted = frameNo === LAST_FRAME ? frames - 1 : frameNo;
    const at = 4 + wanted * 12;
    if (wanted < 0 || at + 12 > resource.payload.length) return null;
    return {
      x: view.getInt32(at, !big),
      y: view.getInt32(at + 4, !big),
      frame: view.getInt32(at + 8, !big),
      frames,
    };
  }

  private fullAnimDriver(compact: SwordCompact): number {
    if (compact.sync) {
      compact.logic = SwordLogicMode.SCRIPT;
      return 1;
    }
    const unit = this.animUnit(compact.get(CPT.ANIM_RESOURCE), compact.get(CPT.ANIM_PC));
    if (!unit) {
      compact.logic = SwordLogicMode.SCRIPT;
      return 1;
    }
    // A full anim moves the object itself, not just its sprite: `o_xcoord` as
    // well as `o_anim_x`. That is the difference from `animDriver` below, and it
    // is why a cutscene animation can walk a mega across a room.
    compact.set(CPT.ANIM_X, unit.x);
    compact.x = unit.x;
    compact.set(CPT.ANIM_Y, unit.y);
    compact.y = unit.y;
    compact.frame = unit.frame;
    compact.set(CPT.ANIM_PC, compact.get(CPT.ANIM_PC) + 1);
    if (compact.get(CPT.ANIM_PC) === unit.frames) compact.logic = SwordLogicMode.SCRIPT;
    return 0;
  }

  private animDriver(compact: SwordCompact): number {
    if (compact.sync) {
      compact.logic = SwordLogicMode.SCRIPT;
      return 1;
    }
    const unit = this.animUnit(compact.get(CPT.ANIM_RESOURCE), compact.get(CPT.ANIM_PC));
    if (!unit) {
      compact.logic = SwordLogicMode.SCRIPT;
      return 1;
    }
    // A shrinking (boxed) anim keeps its own coordinates: the sprite's offsets
    // are relative to the mega's feet, so overwriting them would put it at the
    // table's absolute position instead.
    if (!(compact.status & SwordStatus.SHRINK)) {
      compact.set(CPT.ANIM_X, unit.x);
      compact.set(CPT.ANIM_Y, unit.y);
    }
    compact.frame = unit.frame;
    compact.set(CPT.ANIM_PC, compact.get(CPT.ANIM_PC) + 1);
    if (compact.get(CPT.ANIM_PC) === unit.frames) compact.logic = SwordLogicMode.SCRIPT;
    return 0;
  }

  /**
   * Speech: the sample, the subtitle's countdown, and the talking mouth.
   *
   * Three timing paths in one driver, which is why it reads oddly. `running >= 2`
   * is a deliberate delay before the sample starts so it lands in sync with the
   * text; `running === 1` waits on the sample; and with no sample at all the
   * subtitle's own `o_speech_time` counts down instead. All three end by
   * setting `finished`, and only then does the mouth stop.
   */
  private speechDriver(compact: SwordCompact): number {
    if (!this.speechClickDelay && this.host.mouse.testEvent() !== 0) {
      this.speech.finished = true;
    }
    if (this.speechClickDelay) this.speechClickDelay--;

    if (this.speech.running >= 2) {
      this.speech.running--;
    } else if (this.speech.running === 1) {
      if (this.host.speechFinished()) this.speech.finished = true;
      if (this.speech.finished) this.host.stopSpeech();
    } else {
      const time = compact.get(CPT.SPEECH_TIME);
      if (!time) this.speech.finished = true;
      else compact.set(CPT.SPEECH_TIME, time - 1);
    }

    if (this.speech.finished) {
      compact.logic = SwordLogicMode.SCRIPT;
      if (this.speech.textRunning) {
        const textId = compact.get(CPT.TEXT_ID);
        this.host.releaseText(textId);
        const textCompact = this.objects.fetch(textId);
        if (textCompact) textCompact.status = 0;
      }
      this.speech.running = 0;
      this.speech.textRunning = false;
      this.speech.finished = true;
    }

    const animResource = compact.get(CPT.ANIM_RESOURCE);
    if (animResource) {
      let animPc = compact.get(CPT.ANIM_PC) + 1;
      const first = this.animUnit(animResource, 0);
      const frames = first?.frames ?? 0;
      // Frame 0 is the closed mouth, and it is where the mouth returns the
      // moment the line ends or the table runs out.
      if (this.speech.finished || animPc >= frames) animPc = 0;
      compact.set(CPT.ANIM_PC, animPc);
      const unit = this.animUnit(animResource, animPc);
      if (unit) {
        if (!(compact.status & SwordStatus.SHRINK)) {
          compact.set(CPT.ANIM_X, unit.x);
          compact.set(CPT.ANIM_Y, unit.y);
        }
        compact.frame = unit.frame;
      }
    }
    return 0;
  }

  // -------------------------------------------------------------------------
  // The mcode table
  // -------------------------------------------------------------------------

  /**
   * Dispatches one mcode call.
   *
   * A number above the table is a decoding fault and is reported as one. A
   * number inside the table that this project does not implement is counted by
   * name and continued, which is the distinction the file header draws.
   */
  callMcode(number: number, args: number[], compact: SwordCompact, id: number): number {
    if (number < 0 || number >= SWORD1_MCODE_COUNT) {
      this.onFault(
        `compact ${id}'s script called mcode ${number} and Broken Sword has ` +
          `${SWORD1_MCODE_COUNT}. The program counter is not on an instruction boundary`,
      );
      return SCRIPT_STOP;
    }
    const a = args[0] ?? 0;
    const b = args[1] ?? 0;
    const c = args[2] ?? 0;
    const d = args[3] ?? 0;
    const e = args[4] ?? 0;

    switch (number) {
      // --- the draw lists -------------------------------------------------
      case 0: // fnBackground
        compact.status =
          (compact.status & ~(SwordStatus.FORE | SwordStatus.SORT)) | SwordStatus.BACK;
        return SCRIPT_CONT;
      case 1: // fnForeground
        compact.status =
          (compact.status & ~(SwordStatus.BACK | SwordStatus.SORT)) | SwordStatus.FORE;
        return SCRIPT_CONT;
      case 2: // fnSort
        compact.status =
          (compact.status & ~(SwordStatus.BACK | SwordStatus.FORE)) | SwordStatus.SORT;
        return SCRIPT_CONT;
      case 3: // fnNoSprite
        compact.status = compact.status & ~(SwordStatus.BACK | SwordStatus.FORE | SwordStatus.SORT);
        return SCRIPT_CONT;

      // --- the mega system ------------------------------------------------
      case 4: // fnMegaSet
        compact.set(CPT.MEGA_RESOURCE, a);
        compact.set(CPT.WALK_RESOURCE, b);
        return SCRIPT_CONT;

      case 5: // fnAnim
        return this.fnAnim(compact, id, a, b);
      case 6: // fnSetFrame
        return this.fnSetFrame(compact, a, b, c);
      case 7: // fnFullAnim
        compact.logic = SwordLogicMode.FULL_ANIM;
        compact.set(CPT.ANIM_PC, 0);
        compact.set(CPT.ANIM_RESOURCE, a);
        compact.resource = b;
        compact.status = compact.status & ~SwordStatus.SHRINK;
        compact.sync = 0;
        return SCRIPT_STOP;
      case 8: // fnFullSetFrame
        return this.fnFullSetFrame(compact, a, b, c);

      // --- palette and fades ----------------------------------------------
      case 9: // fnFadeDown
        this.host.fadePalette(a, false);
        return SCRIPT_CONT;
      case 10: // fnFadeUp
        this.host.fadePalette(a, true);
        return SCRIPT_CONT;
      case 11: // fnCheckFade
        this.scriptVars[SV.RETURN_VALUE] = this.host.stillFading();
        return SCRIPT_CONT;
      case 12: // fnSetSpritePalette — the sprite half is 184..255
        this.host.setPalette(184, 72, a);
        return SCRIPT_CONT;
      case 13: // fnSetWholePalette
        this.host.setPalette(0, 256, a);
        return SCRIPT_CONT;
      case 14: // fnSetFadeTargetPalette
        this.host.setFadeTargetPalette(0, 184, a);
        return SCRIPT_CONT;
      case 15: // fnSetPaletteToFade
        this.wantFade = true;
        return SCRIPT_CONT;
      case 16: // fnSetPaletteToCut
        this.wantFade = false;
        return SCRIPT_CONT;

      case 17: // fnPlaySequence
        // `SCRIPT_STOP` where ScummVM returns `SCRIPT_CONT`, and the two mean
        // the same thing for different reasons: ScummVM's `fnPlaySequence`
        // *blocks* — `player->play()` runs the whole film before the opcode
        // returns (`sword1/logic.cpp`) — while a film here is loaded and drawn
        // across frames by the host. Stopping the script for the cycle is what
        // makes the rest of it wait for the film in the same way, and it is
        // the difference between the demo ending on `ENDDEMO.SMK` and ending
        // on the line after it: the sewer chamber's script plays sequence 18
        // and then calls `fnQuit`, and a quit taken in the same cycle stops
        // `step` before it has drawn a frame of the film.
        if (!this.host.playSequence(a)) {
          this.note(number);
          return SCRIPT_CONT;
        }
        this.filmTaken = true;
        return SCRIPT_STOP;

      // --- logic modes ----------------------------------------------------
      case 18: // fnIdle
        compact.scriptLevel = 0;
        // George never idles; he runs his rest-animation script instead. The
        // special case is on the *player id* rather than on a flag, which is
        // Revolution's, and it is why a second mega in the room does idle.
        if (id === SWORD1_PLAYER) {
          this.newScript = 1; // SCR_george_rest_anim_script: section 0, script 1
          compact.logic = SwordLogicMode.NEW_SCRIPT;
        } else {
          compact.logic = SwordLogicMode.IDLE;
        }
        return SCRIPT_STOP;
      case 19: // fnPause
        compact.pause = a;
        compact.logic = SwordLogicMode.PAUSE;
        return SCRIPT_STOP;
      case 20: // fnPauseSeconds — 12 cycles a second, as the original counts
        compact.pause = a * 12;
        compact.logic = SwordLogicMode.PAUSE;
        return SCRIPT_STOP;
      case 21: // fnQuit
        compact.logic = SwordLogicMode.QUIT;
        return SCRIPT_STOP;
      case 22: {
        // fnKillId
        const target = this.objects.fetch(a);
        if (target) target.status = 0;
        return SCRIPT_CONT;
      }
      case 23: // fnSuicide
        compact.status = 0;
        compact.logic = SwordLogicMode.QUIT;
        return SCRIPT_STOP;
      case 24: // fnNewScript
        compact.logic = SwordLogicMode.NEW_SCRIPT;
        this.newScript = a;
        return SCRIPT_STOP;
      case 25: {
        // fnSubScript
        const level = compact.scriptLevel + 1;
        if (level >= 5) {
          this.onFault(`compact ${id} exceeded its five script levels in fnSubScript`);
          return SCRIPT_STOP;
        }
        compact.scriptLevel = level;
        compact.setScriptPc(level, a);
        compact.setScriptId(level, a);
        return SCRIPT_STOP;
      }
      case 26: // fnRestartScript
        compact.logic = SwordLogicMode.RESTART;
        return SCRIPT_STOP;
      case 27: // fnSetBookmark
        compact.copyTree(CPT.TREE, CPT.BOOKMARK);
        return SCRIPT_CONT;
      case 28: // fnGotoBookmark
        compact.logic = SwordLogicMode.BOOKMARK;
        return SCRIPT_STOP;
      case 29: {
        // fnSendSync
        const target = this.objects.fetch(a);
        if (target) target.sync = b;
        return SCRIPT_CONT;
      }
      case 30: // fnWaitSync
        compact.logic = SwordLogicMode.WAIT_FOR_SYNC;
        return SCRIPT_STOP;

      // --- the control-panel forms of three script setters -----------------
      case 31: {
        // cfnClickInteract — always acts on the player, not on `compact`
        const target = this.objects.fetch(a);
        const player = this.objects.fetch(SWORD1_PLAYER);
        if (!target || !player) return SCRIPT_STOP;
        player.scriptLevel = 0;
        player.setScriptPc(0, target.get(CPT.INTERACT));
        player.setScriptId(0, target.get(CPT.INTERACT));
        player.logic = SwordLogicMode.SCRIPT;
        return SCRIPT_STOP;
      }
      case 32: {
        // cfnSetScript
        const target = this.objects.fetch(a);
        if (!target) return SCRIPT_CONT;
        target.scriptLevel = 0;
        target.setScriptPc(0, b);
        target.setScriptId(0, b);
        target.logic = SwordLogicMode.SCRIPT;
        return SCRIPT_CONT;
      }
      case 33: {
        // cfnPresetScript — sets the script but only wakes an idle object
        const target = this.objects.fetch(a);
        if (!target) return SCRIPT_CONT;
        target.scriptLevel = 0;
        target.setScriptPc(0, b);
        target.setScriptId(0, b);
        if (target.logic === SwordLogicMode.IDLE) target.logic = SwordLogicMode.SCRIPT;
        return SCRIPT_CONT;
      }
      case 34: {
        // fnInteract — inherit the target's floor and scale, then push its script
        const target = this.objects.fetch(a);
        if (!target) return SCRIPT_STOP;
        compact.set(CPT.PLACE, target.get(CPT.PLACE));
        const floor = this.objects.fetch(target.get(CPT.PLACE));
        if (floor) {
          compact.set(CPT.SCALE_A, floor.get(CPT.SCALE_A));
          compact.set(CPT.SCALE_B, floor.get(CPT.SCALE_B));
        }
        const level = compact.scriptLevel + 1;
        if (level >= 5) {
          this.onFault(`compact ${id} exceeded its five script levels in fnInteract`);
          return SCRIPT_STOP;
        }
        compact.scriptLevel = level;
        compact.setScriptPc(level, target.get(CPT.INTERACT));
        compact.setScriptId(level, target.get(CPT.INTERACT));
        return SCRIPT_STOP;
      }

      // --- events ---------------------------------------------------------
      case 35: // fnIssueEvent
        this.events.fnIssueEvent(a, b);
        return SCRIPT_CONT;
      case 36: // fnCheckForEvent
        return this.events.fnCheckForEvent(compact, a);

      case 37: // fnWipeHands
        this.scriptVars[SV.OBJECT_HELD] = 0;
        this.host.mouse.setLuggage(0, 0);
        this.host.menu.refreshTop();
        return SCRIPT_CONT;

      // --- speech ---------------------------------------------------------
      case 38: // fnISpeak
        return this.fnISpeak(compact, id, a, b, c);
      case 39: // fnTheyDo
        return this.fnTheyDo(a, b, c, d, e, false);
      case 40: // fnTheyDoWeWait
        return this.fnTheyDo(a, b, c, d, e, true, compact);
      case 41: {
        // fnWeWait
        const target = this.objects.fetch(a);
        if (target) target.status = target.status & ~SwordStatus.TALK_WAIT;
        compact.logic = SwordLogicMode.WAIT_FOR_TALK;
        compact.set(CPT.DOWN_FLAG, a);
        return SCRIPT_STOP;
      }
      case 42: {
        // fnChangeSpeechText
        const target = this.objects.fetch(a);
        if (target) {
          target.set(CPT.SPEECH_WIDTH, b);
          target.set(CPT.SPEECH_PEN, c);
        }
        return SCRIPT_STOP;
      }
      case 43: // fnTalkError — fatal in the original; a fault here
        this.onFault(
          `fnTalkError for compact ${id}, instruction ${compact.get(CPT.DOWN_FLAG)}: a mega was ` +
            `told to do something its talk handler does not know`,
        );
        return SCRIPT_STOP;
      case 44: // fnStartTalk
        compact.set(CPT.DOWN_FLAG, a);
        compact.logic = SwordLogicMode.START_TALK;
        return SCRIPT_STOP;
      case 45: // fnCheckForTextLine
        this.scriptVars[SV.RETURN_VALUE] = this.host.textDuration(id) > 0 ? 1 : 0;
        return SCRIPT_CONT;
      case 46: // fnAddTalkWaitStatusBit
        compact.status = compact.status | SwordStatus.TALK_WAIT;
        return SCRIPT_CONT;
      case 47: // fnRemoveTalkWaitStatusBit
        compact.status = compact.status & ~SwordStatus.TALK_WAIT;
        return SCRIPT_CONT;

      // --- the mouse ------------------------------------------------------
      case 48: // fnNoHuman
        this.host.mouse.noHuman();
        return SCRIPT_CONT;
      case 49: // fnAddHuman
        this.host.mouse.addHuman();
        return SCRIPT_CONT;
      case 50: // fnBlankMouse
        this.host.mouse.blank();
        return SCRIPT_CONT;
      case 51: // fnNormalMouse
        this.host.mouse.normal();
        return SCRIPT_CONT;
      case 52: // fnLockMouse
        this.host.mouse.lock();
        return SCRIPT_CONT;
      case 53: // fnUnlockMouse
        this.host.mouse.unlock();
        return SCRIPT_CONT;
      case 54: // fnSetMousePointer
        this.host.mouse.setPointer(a, b);
        return SCRIPT_CONT;
      case 55: // fnSetMouseLuggage
        this.host.mouse.setLuggage(a, b);
        return SCRIPT_CONT;
      case 56: // fnMouseOn
        compact.status = compact.status | SwordStatus.MOUSE;
        return SCRIPT_CONT;
      case 57: // fnMouseOff
        compact.status = compact.status & ~SwordStatus.MOUSE;
        return SCRIPT_CONT;

      // --- menus ----------------------------------------------------------
      case 58: // fnChooser
        this.host.menu.startChooser(compact);
        return SCRIPT_STOP;
      case 59: // fnEndChooser
        this.host.menu.endChooser();
        return SCRIPT_CONT;
      case 60: // fnStartMenu
        this.host.menu.startMenu();
        return SCRIPT_CONT;
      case 61: // fnEndMenu
        this.host.menu.endMenu();
        return SCRIPT_CONT;
      case 62: // cfnReleaseMenu
        this.host.menu.releaseMenu();
        return SCRIPT_STOP;
      case 63: // fnAddSubject
        this.host.menu.addSubject(a);
        return SCRIPT_CONT;

      // --- inventory ------------------------------------------------------
      case 64: // fnAddObject — the pockets are 52 consecutive globals
        this.setPocket(a, 1);
        return SCRIPT_CONT;
      case 65: // fnRemoveObject
        this.setPocket(a, 0);
        return SCRIPT_CONT;

      // --- sections and floors --------------------------------------------
      case 66: {
        // fnEnterSection
        if (a >= SWORD1_TOTAL_SECTIONS) {
          this.onFault(`compact ${id} tried entering section ${a}, which does not exist`);
          return SCRIPT_CONT;
        }
        if (compact.type === SwordType.PLAYER) this.scriptVars[SV.NEW_SCREEN] = a;
        else compact.screen = a;
        this.objects.megaEntering(a);
        return SCRIPT_CONT;
      }
      case 67: // fnLeaveSection
        if (a >= SWORD1_TOTAL_SECTIONS) {
          this.onFault(`compact ${id} tried leaving section ${a}, which does not exist`);
          return SCRIPT_CONT;
        }
        this.objects.megaLeaving(a, id);
        return SCRIPT_CONT;
      case 68: {
        // fnChangeFloor
        compact.set(CPT.PLACE, a);
        const floor = this.objects.fetch(a);
        if (floor) {
          compact.set(CPT.SCALE_A, floor.get(CPT.SCALE_A));
          compact.set(CPT.SCALE_B, floor.get(CPT.SCALE_B));
        }
        return SCRIPT_CONT;
      }

      // --- walking --------------------------------------------------------
      case 69: // fnWalk
        return this.fnWalk(compact, id, a, b, c, d);
      case 70: // fnTurn
        return this.fnTurn(compact, id, a, b);
      case 71: // fnStand
        return this.fnStand(compact, a);
      case 72: // fnStandAt
        if (c < 0 || c > 8) {
          this.onFault(`fnStandAt was given direction ${c}, which is not one of the nine`);
          return SCRIPT_CONT;
        }
        compact.x = a;
        compact.y = b;
        return this.fnStand(compact, c);
      case 73: {
        // fnFace
        const target = this.objects.fetch(a);
        if (!target) return SCRIPT_STOP;
        const point = this.aimPoint(target);
        return this.fnTurn(compact, id, whatTarget(compact.x, compact.y, point.x, point.y), 0);
      }
      case 74: // fnFaceXy
        return this.fnTurn(compact, id, whatTarget(compact.x, compact.y, a, b), 0);
      case 75: {
        // fnIsFacing
        const target = this.objects.fetch(a);
        if (!target || (target.type !== SwordType.MEGA && target.type !== SwordType.PLAYER)) {
          this.onFault(`fnIsFacing was given object ${a}, which is not a mega`);
          return SCRIPT_STOP;
        }
        let lookDir = whatTarget(target.x, target.y, compact.x, compact.y) - target.dir;
        lookDir = Math.abs(lookDir);
        if (lookDir > 4) lookDir = 8 - lookDir;
        this.scriptVars[SV.RETURN_VALUE] = lookDir;
        return SCRIPT_STOP;
      }
      case 76: {
        // fnGetTo — push the floor's get-to script
        const place = this.objects.fetch(compact.get(CPT.PLACE));
        if (!place) return SCRIPT_STOP;
        const level = compact.scriptLevel + 1;
        if (level >= 5) {
          this.onFault(`compact ${id} exceeded its five script levels in fnGetTo`);
          return SCRIPT_STOP;
        }
        compact.scriptLevel = level;
        compact.setScriptPc(level, place.get(CPT.GET_TO_SCRIPT));
        compact.setScriptId(level, place.get(CPT.GET_TO_SCRIPT));
        return SCRIPT_STOP;
      }
      case 77: // fnGetToError — a debug line in the original
        this.host.log?.(
          `fnGetToError: compact ${id} at place ${compact.get(CPT.PLACE)} has no get-to for ` +
            `target ${compact.get(CPT.TARGET)}`,
        );
        return SCRIPT_CONT;
      case 78:
        return this.fnGetPos(a);

      case 79: // fnGetGamepadXy — PlayStation only, and a no-op everywhere else
        return SCRIPT_CONT;

      // --- sound ----------------------------------------------------------
      case 80: // fnPlayFx
        this.scriptVars[SV.RETURN_VALUE] = this.host.playFx(a);
        return SCRIPT_CONT;
      case 81: // fnStopFx
        this.host.stopFx(a);
        return SCRIPT_CONT;
      case 82: // fnPlayMusic — a looped tune is remembered so a save restores it
        this.scriptVars[SV.CURRENT_MUSIC] = b === 1 ? a : 0;
        this.host.playMusic(a, b === 1);
        return SCRIPT_CONT;
      case 83: // fnStopMusic
        this.scriptVars[SV.CURRENT_MUSIC] = 0;
        this.host.stopMusic();
        return SCRIPT_CONT;

      case 84: // fnInnerSpace — "not working" in the original too
        this.note(number);
        return SCRIPT_STOP;

      case 85: // fnRandom
        this.scriptVars[SV.RETURN_VALUE] = this.host.random(a, b);
        return SCRIPT_CONT;
      case 86: {
        // fnSetScreen
        const target = this.objects.fetch(a);
        if (target) target.screen = b;
        return SCRIPT_CONT;
      }
      case 87: // fnPreload
        this.host.preload(a);
        return SCRIPT_CONT;
      case 88: // fnCheckCD — a dummy in the original; the check is in the loop
        return SCRIPT_CONT;
      case 89: // fnRestartGame
        this.host.requestQuit('restart');
        compact.logic = SwordLogicMode.QUIT;
        return SCRIPT_STOP;
      case 90: // fnQuitGame
        this.host.requestQuit('quit');
        compact.logic = SwordLogicMode.QUIT;
        return SCRIPT_STOP;
      case 91: // fnDeathScreen
        this.host.requestQuit(this.scriptVars[SV.FINALE_OPTION_FLAG] === 4 ? 'the-end' : 'death');
        compact.logic = SwordLogicMode.QUIT;
        return SCRIPT_STOP;
      case 92: // fnSetParallax
        this.host.setParallax(a, b);
        return SCRIPT_CONT;
      case 93: // fnTdebug
        this.host.log?.(`script TDebug: compact ${id}, ${a}, ${b}`);
        return SCRIPT_CONT;

      // --- flashes and borders --------------------------------------------
      case 94: // fnRedFlash
      case 95: // fnBlueFlash
      case 96: // fnYellow
      case 97: // fnGreen
      case 98: // fnPurple
      case 99: // fnBlack
        this.host.flash(number - 94);
        return SCRIPT_CONT;

      default:
        this.note(number);
        return SCRIPT_CONT;
    }
  }

  /** Whether the next palette change fades or cuts. `fnSetPaletteToFade`'s flag. */
  wantFade = true;

  // -----------------------------------------------------------------------
  // Start positions
  // -----------------------------------------------------------------------

  /**
   * Where a new game begins, and the reason one draws anything at all.
   *
   * `initialise` above sets the 95 non-zero globals and stops. That is not a
   * started game: `SCREEN` and `NEW_SCREEN` are both still zero, which is not a
   * screen number but the uninitialised value, so the first cycle enters
   * nothing, no region cluster is ever asked for, and the framebuffer stays the
   * colour it was cleared to. Measured before this existed: 0 non-black pixels
   * out of 307,200.
   *
   * What starts a game is Revolution's start-position table — a second, much
   * smaller bytecode whose whole job is to place George, set the flags that say
   * how far through the story he is, and hand the player their pockets. It is
   * generated into `startPositions.ts` (ADR 0029: it lived in the interpreter,
   * so it is ours and it is generated rather than typed).
   *
   * `pos` is the original's `boot_param`, which is 0 for a new game. Entry 0
   * plays the opening sequence and stands George in the café; **then the game
   * enters section 1**, because the table's own rule is that starting at 0 ends
   * up in 1. That is what makes `PARIS1.CLU` resident, which is the one region
   * cluster the demo ships.
   *
   * Returns null when the game started, or a sentence saying why it did not.
   */
  startPositions(pos: number): string | null {
    // 956..962 are Spain revisited: the same seven sections with one extra
    // helper program run over the top. The original subtracts 900 rather than
    // giving them entries of their own.
    let position = pos;
    let spainVisit2 = false;
    if (position >= 956 && position <= 962) {
      spainVisit2 = true;
      position -= 900;
    }
    if (position < 0 || position > SWORD1_MAX_START_POSITION) {
      return (
        `Broken Sword cannot start in section ${pos}: the start-position table runs to ` +
        `${SWORD1_MAX_START_POSITION}, with 956..962 naming Spain revisited.`
      );
    }
    const program = SWORD1_START_DATA[position];
    if (!program) {
      return (
        `Broken Sword has no start position for section ${position}. ` +
        `${SWORD1_START_DATA.filter((entry) => entry !== null).length} of ` +
        `${SWORD1_START_DATA.length} sections can be started in; the rest are reached by ` +
        `playing to them.`
      );
    }

    this.scriptVars[SV.CHANGE_STANCE] = SWORD1_STAND;
    this.scriptVars[SV.GEORGE_CDT_FLAG] = SWORD1_GEO_TLK_TABLE;

    this.runStartScript(program, `start position ${position}`);
    if (spainVisit2) {
      const helper = SWORD1_HELPER_DATA[Sword1HelperScript.HELP_SPAIN2];
      if (helper) this.runStartScript(helper, 'the Spain-revisited helper');
    }

    // Entry 0 is the opening and section 0 is not a place; the original walks
    // the player into section 1 from it, which is Paris.
    if (position === 0) position = 1;
    const player = this.objects.fetch(SWORD1_PLAYER);
    if (!player) {
      return (
        `Broken Sword's start position ran, but the player compact ` +
        `(${SWORD1_PLAYER}) is not in this install, so there is nobody to enter section ` +
        `${position} with.`
      );
    }
    // Through the mcode rather than beside it: `fnEnterSection` is what a
    // script calls to change section, and this is the same call with the same
    // consequences — `NEW_SCREEN` set, the section's compacts opened.
    this.callMcode(66, [position], player, SWORD1_PLAYER);
    this.wantFade = true;
    return null;
  }

  /**
   * Runs one start-position program.
   *
   * A faithful reading of `runStartScript`, with two differences, both of which
   * are bounds the original does not have:
   *
   * - It stops at the end of the array. The original loops on
   *   `while (*data != opcSeqEnd)` with no bound, so an array with no
   *   terminator walks into whichever array the linker placed next —
   *   `SWORD1_UNTERMINATED_START_DATA` names the one that does this.
   * - An operand that would read past the end is a fault rather than a read.
   *
   * `opcRunStart` and `opcRunHelper` are **tail jumps**: the original assigns
   * to its data pointer and does not return, so the rest of the program after
   * one is unreachable and is not run here either.
   */
  private runStartScript(data: readonly number[], where: string): void {
    let program = data;
    let at = 0;
    // A jump budget, not an instruction budget: `opcRunStart` can point at a
    // program that points back, and seven helpers plus eighty-one positions is
    // the whole graph.
    let jumps = 0;

    const need = (count: number): boolean => {
      if (at + count <= program.length) return true;
      this.onFault(
        `${where} ends mid-instruction: ${count} more byte(s) were wanted at offset ${at} of ` +
          `${program.length}. The start-position table is generated, so this is a table that ` +
          `was written with the wrong operand widths rather than a game file that is short.`,
      );
      return false;
    };
    const u16 = (from: number): number => (program[from] ?? 0) | ((program[from + 1] ?? 0) << 8);
    const u24 = (from: number): number => u16(from) | ((program[from + 2] ?? 0) << 16);
    const u32 = (from: number): number => (u24(from) | ((program[from + 3] ?? 0) << 24)) >>> 0;

    while (at < program.length) {
      const opcode = program[at++] as number;
      if (opcode === Sword1StartOpcode.opcSeqEnd) return;
      switch (opcode) {
        case Sword1StartOpcode.opcCallFn: {
          if (!need(2)) return;
          this.startPosCallFn(program[at] as number, program[at + 1] as number, 0, 0, where);
          at += 2;
          break;
        }
        case Sword1StartOpcode.opcCallFnLong: {
          if (!need(13)) return;
          this.startPosCallFn(program[at] as number, u32(at + 1), u32(at + 5), u32(at + 9), where);
          at += 13;
          break;
        }
        case Sword1StartOpcode.opcSetVar8: {
          if (!need(3)) return;
          this.setVar(u16(at), program[at + 2] as number);
          at += 3;
          break;
        }
        case Sword1StartOpcode.opcSetVar16: {
          if (!need(4)) return;
          this.setVar(u16(at), u16(at + 2));
          at += 4;
          break;
        }
        case Sword1StartOpcode.opcSetVar32: {
          if (!need(6)) return;
          this.setVar(u16(at), u32(at + 2));
          at += 6;
          break;
        }
        case Sword1StartOpcode.opcGeorge: {
          if (!need(8)) return;
          this.scriptVars[SV.CHANGE_X] = u16(at);
          this.scriptVars[SV.CHANGE_Y] = u16(at + 2);
          this.scriptVars[SV.CHANGE_DIR] = program[at + 4] as number;
          this.scriptVars[SV.CHANGE_PLACE] = u24(at + 5);
          at += 8;
          break;
        }
        case Sword1StartOpcode.opcRunStart:
        case Sword1StartOpcode.opcRunHelper: {
          if (!need(1)) return;
          const index = program[at] as number;
          const next =
            opcode === Sword1StartOpcode.opcRunStart
              ? SWORD1_START_DATA[index]
              : SWORD1_HELPER_DATA[index];
          if (!next) {
            this.onFault(`${where} jumps to start program ${index}, which the table does not have`);
            return;
          }
          if (++jumps > SWORD1_START_DATA.length + SWORD1_HELPER_DATA.length) {
            this.onFault(`${where} jumps between start programs without ever ending`);
            return;
          }
          program = next;
          at = 0;
          break;
        }
        default: {
          this.onFault(
            `${where} reached start-position opcode ${opcode} at offset ${at - 1}, and there ` +
              `are ${Object.keys(Sword1StartOpcode).length} of them`,
          );
          return;
        }
      }
    }
    // Reached only by a program with no terminator. The original would carry on
    // reading the next array in memory; saying so is better than imitating it.
    this.onFault(
      `${where} ran off the end of its ${program.length}-byte program without an ` +
        `INIT_SEQ_END. The generated table records which of Revolution's arrays do this.`,
    );
  }

  /**
   * `opcCallFn`'s five function ids, each of which is also an mcode.
   *
   * The two that act on an object go through `callMcode`, so they cannot drift
   * from the versions a script reaches. The other three do not, and the reason
   * is the signature rather than laziness: the original passes `nullptr` for
   * the compact there, and `callMcode` has no way to say that. Handing it the
   * player's compact instead would make `fnPlaySequence` conditional on a
   * compact it never reads — so the opening sequence would silently not play on
   * an install whose player section is missing, which is a worse lie than two
   * duplicated lines.
   */
  private startPosCallFn(
    fnId: number,
    param1: number,
    param2: number,
    param3: number,
    where: string,
  ): void {
    switch (fnId) {
      case Sword1StartOpcode.opcPlaySequence:
        if (!this.host.playSequence(param1)) this.note(17);
        break;
      case Sword1StartOpcode.opcAddObject:
        this.setPocket(param1, 1);
        break;
      case Sword1StartOpcode.opcRemoveObject:
        this.setPocket(param1, 0);
        break;
      case Sword1StartOpcode.opcMegaSet:
      case Sword1StartOpcode.opcNoSprite: {
        const target = this.objects.fetch(param1);
        if (!target) {
          this.onFault(`${where} names object ${param1}, whose section is not in this install`);
          return;
        }
        this.callMcode(
          fnId === Sword1StartOpcode.opcMegaSet ? 4 : 3,
          [param2, param3],
          target,
          param1,
        );
        break;
      }
      default:
        this.onFault(`${where} calls start-position function ${fnId}, and there are five`);
    }
  }

  /** Records that a script reached an mcode this project does not implement. */
  private note(number: number): void {
    this.unimplemented.set(number, (this.unimplemented.get(number) ?? 0) + 1);
  }

  /** The 52 inventory globals, which are consecutive from `POCKET_1`. */
  private setPocket(objectNo: number, value: number): void {
    const at = SV.POCKET_1 + objectNo - 1;
    if (objectNo < 1 || objectNo > 52 || at >= this.scriptVars.length) {
      this.onFault(`an inventory mcode named object ${objectNo}; there are 52 pockets`);
      return;
    }
    this.scriptVars[at] = value;
  }

  /** Where to aim at an object: a mega's feet, or a non-mega's bottom centre. */
  private aimPoint(target: SwordCompact): { x: number; y: number } {
    if (target.type === SwordType.MEGA || target.type === SwordType.PLAYER) {
      return { x: target.x, y: target.y };
    }
    return {
      x: Math.trunc((target.get(CPT.MOUSE_X1) + target.get(CPT.MOUSE_X2)) / 2),
      y: target.get(CPT.MOUSE_Y2),
    };
  }

  /**
   * `fnAnim`: start an animation, resolving an anim *table* if given one.
   *
   * The `cdt && !spr` case is the one worth knowing: with a table and no
   * sprite, `cdt` names an eight-entry set indexed by the mega's *current
   * direction*, so one script line animates a mega whichever way it is facing.
   */
  private fnAnim(compact: SwordCompact, id: number, cdt: number, spr: number): number {
    if (cdt && !spr) {
      const set = this.animSet(cdt, compact.dir);
      if (!set) return SCRIPT_CONT;
      compact.set(CPT.ANIM_RESOURCE, set.cdt);
      compact.resource = set.spr;
    } else {
      compact.set(CPT.ANIM_RESOURCE, cdt);
      compact.resource = spr;
    }
    if (compact.get(CPT.ANIM_RESOURCE) === 0 || compact.resource === 0) {
      this.onFault(
        `fnAnim on compact ${id} was called with (${cdt}, ${spr}) and resolved to ` +
          `(${compact.get(CPT.ANIM_RESOURCE)}, ${compact.resource}); neither may be zero`,
      );
      return SCRIPT_CONT;
    }
    // A boxed mega anim is one whose first frame carries an offset: its sprite
    // is placed relative to the mega's feet and scaled, so the shrink bit goes
    // on and the anim coordinates are pinned to the feet once.
    const offsets = this.frameOffsets(compact.resource, 0);
    if (offsets && (offsets.offsetX || offsets.offsetY)) {
      compact.status = compact.status | SwordStatus.SHRINK;
      compact.set(CPT.ANIM_X, compact.x);
      compact.set(CPT.ANIM_Y, compact.y);
    } else {
      compact.status = compact.status & ~SwordStatus.SHRINK;
    }
    compact.logic = SwordLogicMode.ANIM;
    compact.set(CPT.ANIM_PC, 0);
    compact.sync = 0;
    return SCRIPT_STOP;
  }

  private fnSetFrame(compact: SwordCompact, cdt: number, spr: number, frameNo: number): number {
    const unit = this.animUnit(cdt, frameNo);
    if (!unit) return SCRIPT_CONT;
    compact.set(CPT.ANIM_X, unit.x);
    compact.set(CPT.ANIM_Y, unit.y);
    compact.frame = unit.frame;
    compact.resource = spr;
    compact.status = compact.status & ~SwordStatus.SHRINK;
    return SCRIPT_CONT;
  }

  /** Like `fnSetFrame` but moves the object itself, not only its sprite. */
  private fnFullSetFrame(compact: SwordCompact, cdt: number, spr: number, frameNo: number): number {
    const unit = this.animUnit(cdt, frameNo);
    if (!unit) return SCRIPT_CONT;
    compact.set(CPT.ANIM_X, unit.x);
    compact.x = unit.x;
    compact.set(CPT.ANIM_Y, unit.y);
    compact.y = unit.y;
    compact.frame = unit.frame;
    compact.resource = spr;
    compact.status = compact.status & ~SwordStatus.SHRINK;
    return SCRIPT_CONT;
  }

  /** An `AnimSet`: eight (cdt, spr) pairs, indexed by direction. */
  private animSet(resourceId: number, direction: number): { cdt: number; spr: number } | null {
    const resource = this.resources.fetch(resourceId);
    if (!resource) {
      this.onFault(
        `animation set ${formatResourceId(resourceId)}: ` +
          this.resources.describeMissingResource(resourceId),
      );
      return null;
    }
    const big = this.resources.bigEndian;
    const view = new DataView(
      resource.payload.buffer,
      resource.payload.byteOffset,
      resource.payload.byteLength,
    );
    const at = direction * 8;
    if (at + 8 > resource.payload.length) return null;
    return { cdt: view.getUint32(at, !big), spr: view.getUint32(at + 4, !big) };
  }

  /** A frame's offsets, which is how a boxed mega anim identifies itself. */
  private frameOffsets(
    resourceId: number,
    frameNo: number,
  ): { offsetX: number; offsetY: number } | null {
    const resource = this.resources.fetch(resourceId);
    if (!resource) return null;
    const big = this.resources.bigEndian;
    const view = new DataView(
      resource.bytes.buffer,
      resource.bytes.byteOffset,
      resource.bytes.byteLength,
    );
    // A sprite resource is a header, a frame count, then a frame offset table.
    if (resource.bytes.length < 28) return null;
    const frames = view.getUint32(20, !big);
    if (frameNo >= frames) return null;
    const frameAt = view.getUint32(20 + (frameNo + 1) * 4, !big);
    if (frameAt + 16 > resource.bytes.length) return null;
    return {
      offsetX: view.getInt16(frameAt + 12, !big),
      offsetY: view.getInt16(frameAt + 14, !big),
    };
  }

  private fnISpeak(
    compact: SwordCompact,
    id: number,
    cdt: number,
    textNo: number,
    spr: number,
  ): number {
    this.speechClickDelay = 3;
    compact.logic = SwordLogicMode.SPEECH;
    this.speech.textNumber = textNo;

    if (cdt && !spr) {
      const set = this.animSet(cdt, compact.dir);
      if (set) {
        compact.set(CPT.ANIM_RESOURCE, set.cdt);
        if (set.cdt) compact.resource = set.spr;
      }
    } else {
      compact.set(CPT.ANIM_RESOURCE, cdt);
      if (cdt) compact.resource = spr;
    }
    compact.set(CPT.ANIM_PC, 0);

    if (compact.get(CPT.ANIM_RESOURCE)) {
      const offsets = this.frameOffsets(compact.resource, 0);
      // `&&` and not `||` here, unlike `fnAnim`. That asymmetry is Revolution's
      // and is kept: a talking sprite with only one offset set is treated as
      // unboxed.
      if (offsets && offsets.offsetX && offsets.offsetY) {
        compact.status = compact.status | SwordStatus.SHRINK;
        compact.set(CPT.ANIM_X, compact.x);
        compact.set(CPT.ANIM_Y, compact.y);
      } else {
        compact.status = compact.status & ~SwordStatus.SHRINK;
      }
    }

    this.speech.running = this.host.startSpeech(textNo >>> 16, textNo & 0xffff) ? 2 : 0;
    this.speech.finished = false;

    // Subtitles: always when there is no recorded speech, which is also what
    // makes a silent install playable.
    const duration = this.host.textDuration(textNo);
    if (duration > 0) {
      this.speech.textRunning = true;
      compact.set(CPT.SPEECH_TIME, duration);
      const textCompactId = this.host.makeTextSprite(
        textNo,
        compact.get(CPT.SPEECH_WIDTH),
        compact.get(CPT.SPEECH_PEN),
      );
      const textCompact = textCompactId ? this.objects.fetch(textCompactId) : null;
      if (textCompact) {
        textCompact.screen = compact.screen;
        textCompact.set(CPT.TARGET, textCompactId);
        compact.set(CPT.TEXT_ID, textCompactId);
        this.placeTextSprite(compact, id, textCompact, textCompactId);
      }
    }
    return SCRIPT_STOP;
  }

  /**
   * Puts a subtitle above the speaker's head, then inside the screen.
   *
   * The clamp is not cosmetic: without it a mega talking at the edge of a
   * scrolling room draws its text off-screen, which reads as speech with no
   * subtitle at all. George's voice-over case is centred at the bottom instead,
   * which is how the game distinguishes narration from dialogue.
   */
  private placeTextSprite(
    speaker: SwordCompact,
    id: number,
    textCompact: SwordCompact,
    textCompactId: number,
  ): void {
    const size = this.host.textSpriteSize(textCompactId);
    if (!size) return;
    const scrollX = this.scriptVars[SV.SCROLL_OFFSET_X];
    const scrollY = this.scriptVars[SV.SCROLL_OFFSET_Y];
    const margin = 3;
    const aboveHead = 20;

    let textX: number;
    let textY: number;
    if (id === SWORD1_PLAYER && !speaker.get(CPT.ANIM_RESOURCE)) {
      textX = scrollX + 128 + Math.trunc(640 / 2) - Math.trunc(size.width / 2);
      textY = scrollY + 128 + 400;
    } else {
      textX =
        Math.trunc((speaker.get(CPT.MOUSE_X1) + speaker.get(CPT.MOUSE_X2)) / 2) -
        Math.trunc(size.width / 2);
      textY = speaker.get(CPT.MOUSE_Y1) - size.height - aboveHead;
    }

    const left = 128 + margin + scrollX;
    const right = 128 + 640 - 1 - margin + scrollX - size.width;
    const top = 128 + margin + scrollY;
    const bottom = 128 + 400 - 1 - margin + scrollY - size.height;

    const clampedX = Math.max(left, Math.min(textX, Math.max(left, right)));
    const clampedY = Math.max(top, Math.min(textY, Math.max(top, bottom)));
    textCompact.set(CPT.ANIM_X, clampedX);
    textCompact.x = clampedX;
    textCompact.set(CPT.ANIM_Y, clampedY);
    textCompact.y = clampedY;
  }

  /** `fnTheyDo` and `fnTheyDoWeWait`: hand a mega an instruction. */
  private fnTheyDo(
    targetId: number,
    instruction: number,
    param1: number,
    param2: number,
    param3: number,
    wait: boolean,
    compact?: SwordCompact,
  ): number {
    const target = this.objects.fetch(targetId);
    if (!target) return wait ? SCRIPT_STOP : SCRIPT_CONT;
    target.set(CPT.DOWN_FLAG, instruction);
    target.set(CPT.INS1, param1);
    target.set(CPT.INS2, param2);
    target.set(CPT.INS3, param3);
    if (!wait || !compact) return SCRIPT_CONT;
    target.status = target.status & ~SwordStatus.TALK_WAIT;
    compact.logic = SwordLogicMode.WAIT_FOR_TALK;
    compact.set(CPT.DOWN_FLAG, targetId);
    return SCRIPT_STOP;
  }

  private fnWalk(
    compact: SwordCompact,
    id: number,
    x: number,
    y: number,
    dirIn: number,
    stance: number,
  ): number {
    // A non-zero stance means "end facing whatever, we are going into an
    // animation", which is direction 9 to the router.
    const dir = stance > 0 ? 9 : dirIn;
    compact.set(CPT.WALK_PC, 0);
    // Mark node 1 as the end before routing, so a failed route leaves a walk
    // that stops immediately rather than replaying the last one.
    compact.set(CPT.ROUTE + 20, 512);
    if (id === SWORD1_PLAYER) this.router.setPlayerTarget(x, y, dir, stance);

    const result = this.router.routeFinder(id, compact, x, y, dir);
    if (
      id === SWORD1_PLAYER &&
      (result === RouteResult.FOUND || result === RouteResult.ALREADY_THERE)
    ) {
      this.scriptVars[SV.MEGA_ON_GRID] = 0;
      this.scriptVars[SV.REROUTE_GEORGE] = 0;
    }
    if (result === RouteResult.FOUND || result === RouteResult.ALREADY_THERE) {
      compact.set(CPT.DOWN_FLAG, 1);
      compact.logic = SwordLogicMode.AR_ANIMATE;
      return SCRIPT_STOP;
    }
    // A route that failed because the target sat on a bar is reported to the
    // script as success, which is Revolution's own choice: the mega is close
    // enough and a script that retried would loop.
    compact.set(CPT.DOWN_FLAG, 0);
    return SCRIPT_CONT;
  }

  private fnTurn(compact: SwordCompact, id: number, dirIn: number, stance = 0): number {
    const dir = stance > 0 ? 9 : dirIn;
    const result = this.router.routeFinder(id, compact, compact.x, compact.y, dir);
    compact.set(CPT.DOWN_FLAG, result ? 1 : 0);
    compact.logic = SwordLogicMode.AR_ANIMATE;
    compact.set(CPT.WALK_PC, 0);
    return SCRIPT_STOP;
  }

  private fnStand(compact: SwordCompact, dirIn: number): number {
    if (dirIn < 0 || dirIn > 8) {
      this.onFault(`fnStand was given direction ${dirIn}, which is not one of the nine`);
      return SCRIPT_CONT;
    }
    // 8 means "keep facing the way you are", which is not the same as 0 (up).
    const dir = dirIn === 8 ? compact.dir : dirIn;
    compact.resource = compact.get(CPT.WALK_RESOURCE);
    compact.status = compact.status | SwordStatus.SHRINK;
    compact.set(CPT.ANIM_X, compact.x);
    compact.set(CPT.ANIM_Y, compact.y);
    compact.frame = 96 + dir;
    compact.dir = dir;
    return SCRIPT_STOP;
  }

  /**
   * `fnGetPos`: where a target is, and how far away to stand from it.
   *
   * The separations are per-character and measured at full scale: Duane is
   * seventy pixels, Benoir sixty-one, everybody else forty-two. Scaled by the
   * target's own ramp when it shrinks, so two megas stand the same apparent
   * distance apart at the back of a room as at the front.
   */
  private fnGetPos(targetId: number): number {
    const target = this.objects.fetch(targetId);
    if (!target) return SCRIPT_CONT;
    const point = this.aimPoint(target);
    this.scriptVars[SV.RETURN_VALUE] = point.x;
    this.scriptVars[SV.RETURN_VALUE_2] = point.y;
    this.scriptVars[SV.RETURN_VALUE_3] = target.dir;

    const DUANE = 8781824;
    const BENOIR = 8585216;
    const separation = targetId === DUANE ? 70 : targetId === BENOIR ? 61 : 42;

    if (target.status & SwordStatus.SHRINK) {
      const scale = Math.trunc(
        (target.get(CPT.SCALE_A) * target.y + target.get(CPT.SCALE_B)) / 256,
      );
      this.scriptVars[SV.RETURN_VALUE_4] = Math.trunc((separation * scale) / 256);
    } else {
      this.scriptVars[SV.RETURN_VALUE_4] = separation;
    }
    return SCRIPT_CONT;
  }

  /** A line for the stall report: which mcodes a playthrough skipped. */
  describeUnimplemented(): string | undefined {
    if (this.unimplemented.size === 0) return undefined;
    const named = [...this.unimplemented.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([number, count]) => `${sword1McodeName(number)} (${count}x)`);
    return `mcodes this project does not implement that the scripts reached: ${named.join(', ')}`;
  }
}
