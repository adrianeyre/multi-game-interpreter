/**
 * `SkyEngine` — Beneath a Steel Sky as an `AdventureEngine`.
 *
 * ## The seam, tested a fourth time
 *
 * ADR 0011 set a ceiling on `AdventureEngine`: "if it grows past roughly thirty
 * the seam is in the wrong place". ADR 0023 predicted Sky would need no new
 * member. **It did not.** 320x200 in 256 colours, so `resolution` reports the
 * degenerate pair; its own `EngineInput`, so the shell interprets nothing; its
 * own `saveFormat` and `saveNote`. The interface is the same seventeen members
 * it was, which is the fourth family to leave it alone and the finding ADR 0023
 * asked for.
 *
 * ## What this engine does, and what it stops on
 *
 * It boots — reads the Compacts, applies the starting state for its Release,
 * and runs the logic list — and it runs scripts through `SkyInterpreter` until
 * one calls an mcode that is not implemented, at which point **it stops and
 * says which one, on which Compact, at which word offset**.
 *
 * That is not a placeholder for a renderer; it is the rule `CONTEXT.md` sets
 * and the reason this engine is worth having before there is one. AGOS is the
 * precedent: an Engine that reads, identifies and saves, and does not draw, and
 * whose status line says so rather than leaving a player to infer it from a
 * black screen.
 *
 * Where it does stop is described by `describeStall`, by name and by word
 * offset. The busiest mcodes in the shipped bytecode are character movement and
 * routing — `fnSetToStand`, `fnTurnTo`, `fnAr` — so the first script a room
 * runs usually reaches one. That ordering is measured rather than guessed;
 * `npm run sweep:vt` prints it.
 *
 * ## What it deliberately does not do
 *
 * Play anything (#257) or edit (#259). It draws: the room's background, and the
 * sprites over it in the game's own three passes, restored from a clean copy
 * every frame so a walking mega does not paint itself into the room.
 */

import {
  type AdventureEngine,
  type EditableGame,
  type EditableGameOptions,
  type SavedGameEnvelope,
} from '../AdventureEngine.js';
import type { DataSource } from '../resource/DataSource.js';
import { Screen } from '../gfx/Screen.js';
import { Palette } from '../gfx/Palette.js';
import { SkyResources } from './resource/SkyResources.js';
import { SkyGrids, TOT_NO_GRIDS } from './resource/SkyGrid.js';
import {
  parseSkyCompacts,
  describeMissingCompacts,
  type SkyCompacts,
} from './resource/skyCompacts.js';
import { importSkyProject, toSkyProjectJson } from '../../authoring/sky/project.js';
import {
  collectSkyDrawables,
  collectSkySprites,
  collectSkyCompactPalettes,
  deriveSkyPicturePalettes,
} from '../../authoring/sky/pictures.js';
import type { Target } from '../../authoring/target.js';
import {
  parseSkyWorldState,
  writeSkyWorldState,
  describeSkyStateRefusal,
  type SkyWorldState,
} from './save/skyWorldState.js';
import { SkyInterpreter } from './script/SkyInterpreter.js';
import { skyScriptOffset, SKY_MODULE_0 } from './script/skyOpcodes.js';
import {
  SkyWorld,
  SKY_VAR,
  SKY_STATUS,
  SKY_MOUSE_STATUS,
  SKY_TOP_LEFT_X,
  SKY_TOP_LEFT_Y,
  SKY_LOGIC_NAMES,
  SKY_LOGIC,
  skyVariableName,
} from './SkyWorld.js';
import { SkyInput } from './SkyInput.js';
import { SkySound } from './sound/SkySound.js';
import {
  isSkyScreen,
  isSkyGameArea,
  decodeSkyGameArea,
  isSkyPalette,
  parseSkyPalette,
  SKY_SCREEN_WIDTH,
  SKY_SCREEN_HEIGHT,
  SKY_SCREEN_BYTES,
  SKY_GAME_AREA_BYTES,
  SKY_GAME_AREA_HEIGHT,
  parseSkySpriteHeader,
  blitSkySprite,
  type SkySpriteHeader,
} from './gfx/skyGraphic.js';

/** This family's save payload version. Independent of every other family's. */
export const SKY_SAVE_FORMAT = 1;

/**
 * Milliseconds between logic cycles: the game's own `gameSpeed`.
 *
 * `sky.cpp:406` sets it to 80 and `sky.cpp:285` uses it as the delay at the
 * foot of the main loop, so one `step()` here is one turn of that loop.
 */
export const SKY_GAME_SPEED_MS = 80;

/**
 * The same rate in the unit the shell paces engines by: sixtieths of a second.
 *
 * 4.8, and deliberately not rounded. `src/main.ts` multiplies this by a tick to
 * get the milliseconds between steps, so a fraction costs nothing there and
 * rounding to 5 would run the game 4% fast while rounding to 12 — which is what
 * this was — runs it at 40% speed.
 */
export const SKY_TICKS_PER_STEP = SKY_GAME_SPEED_MS / (1000 / 60);

/**
 * How many script modules a Sky release has.
 *
 * Seven, measured rather than assumed: `npm run sweep:vt` lists 1,768 scripts
 * across seven modules on both freeware releases. A module that is not there is
 * skipped rather than failing, because a Release with fewer is a smaller
 * Project and not a broken one.
 */
const SKY_SCRIPT_MODULES = 8;

export interface SkyEngineOptions {
  onLog?: (message: string) => void;
}

/**
 * A hotspot the pointer engine finds on the current screen.
 *
 * `x`/`y` are a screen point the pointer reports the hotspot at, in the game's
 * 0-based screen space — the point `runMouse` expects on `input`, so a harness
 * can click a hotspot by name without knowing where the game put it.
 */
export interface SkyHotspot {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  readonly y: number;
}

/** A Sky save: the envelope every family shares, plus this family's state. */
interface SkySavedGame extends SavedGameEnvelope {
  readonly build: number;
  /** The world state, in the game's own format, as bytes. */
  readonly state: number[];
}

export class SkyEngine implements AdventureEngine {
  readonly screen = new Screen(SKY_SCREEN_WIDTH, SKY_SCREEN_HEIGHT);
  readonly palette = new Palette();
  readonly saveFormat = SKY_SAVE_FORMAT;
  readonly saveNote =
    'Sky saves are this interpreter’s own format and are not readable by ScummVM, or by ' +
    'this project’s SCUMM, AGI, SCI or Lure saves.';
  readonly resolution = {
    script: { width: SKY_SCREEN_WIDTH, height: SKY_SCREEN_HEIGHT },
    display: { width: SKY_SCREEN_WIDTH, height: SKY_SCREEN_HEIGHT },
  };

  frame = 0;
  hasQuit = false;

  readonly sound = new SkySound();
  readonly input = new SkyInput();

  private readonly world: SkyWorld;
  private readonly interpreter: SkyInterpreter;
  private readonly modules = new Map<number, Uint16Array>();
  private booted = false;
  /** What stopped the last tick, if anything did. */
  private stalled: string | null = null;
  private ticks = 0;
  private scriptsRun = 0;
  private paintedScreen: number | null = null;
  /** The room's pixels as decoded, kept so every frame can start from them. */
  private backgroundPixels: Uint8Array | null = null;
  private paintedPalette: number | null = null;
  /** Clicks the mouse engine has already acted on. */
  private handledClicks = 0;
  /** Sprites composited on the last frame, and ones that could not be. */
  private spritesDrawn = 0;
  private spritesUnreadable = 0;
  /**
   * How many ticks the world has looked the same for.
   *
   * A game that runs thousands of scripts and never changes screen is not
   * "slow", and `describeStatus` exists precisely so a player is not left to
   * guess which of the two they have. Nothing unimplemented being reported is
   * not the same as the game getting anywhere, and this is what tells them
   * apart.
   */
  private unchangedTicks = 0;
  private lastShape = '';

  private constructor(
    private readonly resources: SkyResources,
    private readonly compacts: SkyCompacts,
    /** The bytes `sky.cpt` was read from, kept for the editable surface's round-trip. */
    private readonly compactBytes: Uint8Array,
    private readonly startingState: SkyWorldState,
    private readonly log?: (message: string) => void,
  ) {
    this.world = new SkyWorld(compacts, SkyGrids.load(resources));
    this.interpreter = new SkyInterpreter(this.world);
  }

  /**
   * Opens a game, or refuses with something a person can act on.
   *
   * The Compact table is the one thing a Sky game cannot start without, so its
   * absence is refused here by name rather than discovered by a black screen
   * (ADR 0024). The freeware floppy release ships neither `sky.cpt` nor
   * `SKY.EXE` and is refused for that reason, with the message saying which
   * release does work.
   */
  static async create(source: DataSource, options: SkyEngineOptions = {}): Promise<SkyEngine> {
    const names = source.list();
    const find = (base: string): string | null =>
      names.find((name) => name.toLowerCase().endsWith(base)) ?? null;

    const read = async (name: string | null, what: string): Promise<Uint8Array> => {
      if (!name) throw new Error(`Beneath a Steel Sky needs ${what}, and this folder has none.`);
      const bytes = await source.read(name);
      if (!bytes) throw new Error(`${name} could not be read from ${source.label}.`);
      return bytes;
    };

    const resources = SkyResources.open(
      await read(find('sky.dnr'), 'sky.dnr'),
      await read(find('sky.dsk'), 'sky.dsk'),
    );

    const missing = describeMissingCompacts(names);
    if (missing) throw new Error(missing);

    const compactBytes = await read(find('sky.cpt'), 'sky.cpt');
    const compacts = parseSkyCompacts(compactBytes);

    // The starting state for *this* Release. The file carries seven and picking
    // the wrong one puts every object where a different build left it.
    const build = resources.releaseInfo.build;
    const reset =
      compacts.resetStates.find((state) => state.build === build) ??
      // The three CD builds share a layout and the shipped states say so: the
      // ones for 365, 368 and 372 all declare 368.
      compacts.resetStates.find((state) => build >= 365 && state.build >= 365);
    if (!reset) {
      throw new Error(
        `sky.cpt carries starting states for ${compacts.resetStates
          .map((state) => `v0.0${state.build}`)
          .join(', ')} and this release is v0.0${build}. Refused rather than started from ` +
          `another build's world.`,
      );
    }
    const startingState = parseSkyWorldState(
      new Uint8Array(reset.words.buffer, reset.words.byteOffset, reset.words.byteLength),
      compacts,
    );

    options.onLog?.(
      `Beneath a Steel Sky, ${resources.releaseInfo.description} (v0.0${build}), ` +
        `${compacts.records.length} compacts, starting state v0.0${startingState.build}`,
    );

    return new SkyEngine(resources, compacts, compactBytes, startingState, options.onLog);
  }

  get gameId(): string {
    return `sky-${this.resources.releaseInfo.release}`;
  }

  get targetName(): string {
    return `Sky (${this.resources.releaseInfo.release})`;
  }

  get currentRoom(): number {
    return this.world.variables[SKY_VAR.screen];
  }

  /**
   * Sixtieths of a second between ticks.
   *
   * **Eighty milliseconds**, which is 4.8 sixtieths and twelve and a half
   * cycles a second. Not a round number of sixtieths, and that is the point:
   * Sky's loop is paced in milliseconds by `_systemVars->gameSpeed`, set to 80
   * at startup (`sky.cpp:406`) and used as the delay at the bottom of the main
   * loop (`sky.cpp:285`). Rounding it to a whole sixtieth is what a shell
   * counting in ticks wants and not what the game does.
   *
   * This read twelve, which is five cycles a second — two and a half times too
   * slow, and it showed up exactly where a rate error shows up: in the walk.
   * Sky moves a mega by one entry of its walk table per logic cycle
   * (`Logic::mainAnim`, `logic.cpp:388-400`), so the cycle rate *is* the
   * walking speed, and Foster crossed 132 pixels of screen 0 in 7.2 seconds
   * instead of 2.9. Nothing in the routing was wrong; there was simply less
   * than half as much of it per second.
   *
   * Fixed rather than read from a variable because, unlike SCUMM, nothing in a
   * Sky script writes a rate: the game's loop is the rate. The original's
   * control panel has a speed slider that writes `gameSpeed`, which is a
   * preference rather than something the game data decides.
   */
  get ticksPerStep(): number {
    return SKY_TICKS_PER_STEP;
  }

  boot(): void {
    if (this.booted) return;
    this.applyState(this.startingState);
    this.booted = true;
    this.log?.(
      `booted at screen ${this.world.variables[SKY_VAR.screen]}, ` +
        `logic list ${this.world.variables[SKY_VAR.logicListNumber]}, ` +
        `section ${this.world.enteredSection}`,
    );
  }

  /**
   * Applies a state and enters the section it names.
   *
   * One method for both callers on purpose. Starting a new game and restoring a
   * save are the same operation in this game — `boot` applies the Release's
   * starting state, `loadState` applies a saved one — and ScummVM does both
   * through `Logic::parseSaveData`, which copies the variables and then calls
   * `fnEnterSection` for the section the state names.
   *
   * Splitting them is how the section step goes missing from one of the two,
   * which is a bug that only shows up on whichever path nobody tried.
   */
  private applyState(state: SkyWorldState): void {
    this.world.apply(state);
    this.world.enterSection(this.world.variables[SKY_VAR.currentSection]);
    // The state carries the palette the world was on, the way it carries the
    // background through `LAYER_0_ID`. Both are what a room looked like when
    // the snapshot was taken, so both belong here rather than waiting for a
    // script to announce them again.
    this.world.chosenPalette = state.palette;
    this.paintedScreen = null;
    this.paintedPalette = null;
  }

  /**
   * One tick: run every Compact in the logic list.
   *
   * The list is itself a Compact — a list of ids ending in zero, which may
   * hand off to another list with 0xffff. That is the game's own structure and
   * it is why a room change is a variable assignment rather than a call: a
   * script sets `logicListNumber` and the next tick runs a different world.
   */
  step(): void {
    if (!this.booted) this.boot();
    if (this.hasQuit) return;
    this.frame += 1;
    this.ticks += 1;
    this.stalled = null;

    let listId = this.world.variables[SKY_VAR.logicListNumber];
    let list = this.world.words(listId);
    let at = 0;
    let guard = 0;

    while (list && guard < 4096) {
      guard += 1;
      const id = list[at];
      at += 1;
      if (id === 0) break;
      if (id === 0xffff) {
        // The list hands off to another list, which is how the game keeps one
        // list per section without copying entries between them.
        listId = list[at];
        list = this.world.words(listId);
        at = 0;
        continue;
      }

      this.world.variables[SKY_VAR.currentId] = id;
      this.world.current = id;

      // `CUR_ID` is set before this check and not after, because the game sets
      // it before this check too: a Compact that is skipped is still the one
      // the world last looked at.
      if (!this.world.wantsLogic(id)) continue;

      this.runLogic(id);

      // "a sync sent to the compact is available for one cycle only. that cycle
      // has just ended so remove the sync" — the game's own comment, and the
      // reason this is here rather than wherever a sync is read: a sync that
      // outlives its tick wakes a Compact that is waiting for the next one.
      this.world.setField(id, 'sync', 0);

      if (this.world.quit) {
        this.hasQuit = true;
        return;
      }
    }

    this.runMouse();

    const shape =
      `${this.world.variables[SKY_VAR.screen]}/${listId}/${this.world.drawnScreen}` +
      `/${this.world.variables[SKY_VAR.specialItem]}`;
    if (shape === this.lastShape) this.unchangedTicks += 1;
    else {
      this.unchangedTicks = 0;
      this.lastShape = shape;
    }
  }

  /**
   * The mouse engine, run after the logic list the way the game runs it.
   *
   * Two gates before anything happens, both the game's: `MOUSE_STOP` must be
   * clear, and `MOUSE_STATUS` must say the pointer is live — which is what
   * `fnAddHuman` sets and what a booted game sits polling for. The pointer's
   * position is offset by the screen's origin, because a Compact's `xcood` and
   * `ycood` are in that space.
   *
   * What it does with a hit is what the game does: remember it in
   * `SPECIAL_ITEM`, run the previous item's `GET_OFF` script, take the new
   * item's `mouseOff` as the next `GET_OFF`, and run its `mouseOn`. A click
   * runs `mouseClick`. Those are ordinary scripts, so they go through the same
   * interpreter the logic list uses rather than a second path.
   */
  private runMouse(): void {
    if (this.world.variables[SKY_VAR.mouseStop] !== 0) return;
    const status = this.world.variables[SKY_VAR.mouseStatus];
    if ((status & SKY_MOUSE_STATUS.mouse) === 0) return;

    const x = this.input.x + SKY_TOP_LEFT_X;
    const y = this.input.y + SKY_TOP_LEFT_Y;
    // The live pointer, kept on the world for `fnSaveCoods` to freeze. It is
    // *not* SAFEX/SAFEY: those are the frozen copy a click's own script takes,
    // and writing them every tick here would mean the walk headed for wherever
    // the pointer drifted while its route was being built rather than for where
    // it was clicked.
    this.world.pointerX = x;
    this.world.pointerY = y;

    const over = this.world.pointerOver(x, y);
    const previous = this.world.variables[SKY_VAR.specialItem];

    if (over !== previous) {
      const getOff = this.world.variables[SKY_VAR.getOff];
      if (getOff !== 0) this.runMouseScript(over || previous, getOff);
      this.world.variables[SKY_VAR.specialItem] = over;
      this.world.variables[SKY_VAR.getOff] = over === 0 ? 0 : this.world.field(over, 'mouseOff');
      if (over !== 0) {
        const on = this.world.field(over, 'mouseOn');
        if (on !== 0) this.runMouseScript(over, on);
      }
    }

    if ((status & SKY_MOUSE_STATUS.buttons) === 0) return;
    if (this.input.clicks === this.handledClicks) return;
    this.handledClicks = this.input.clicks;
    if (over === 0) return;

    this.world.variables[SKY_VAR.button] = 3;
    const click = this.world.field(over, 'mouseClick');
    if (click !== 0) this.runMouseScript(over, click);
  }

  /**
   * Runs one of a Compact's mouse scripts to completion or to its first pause.
   *
   * The game runs these against the *item* rather than against whatever the
   * logic list was on, so the running Compact is swapped for the call and put
   * back afterwards — otherwise a `push_offset` inside a mouse script reads the
   * wrong object's fields.
   *
   * A `stopped` report is propagated here exactly as `runScript` propagates it,
   * and that is not a tidiness: it is the same `CONTEXT.md` rule, on the path a
   * player's own click takes. Discarding the report — which this used to do —
   * meant a mouse script that reached an unimplemented mcode recorded it
   * *nowhere*: `this.stalled` stayed null and the interpreter's tally never
   * reached `world.unimplemented`, so the stall report said "every mcode reached
   * is implemented" while a floor-click was being swallowed on `fnSaveCoods`.
   * The first thing a player cannot do is walk, and it was invisible because the
   * one path that reaches it was the one path that hid its own stops.
   */
  private runMouseScript(id: number, script: number): void {
    const module = this.moduleFor(script & 0xffff);
    if (!module) return;
    const previous = this.world.current;
    this.world.current = id;
    try {
      const from = script >>> 16 || skyScriptOffset(module, script & 0xffff);
      const report = this.interpreter.run(module, from);
      this.scriptsRun += 1;
      if (report.outcome.kind === 'stopped') {
        for (const [name, count] of this.interpreter.unimplemented) {
          this.world.unimplemented.set(name, count);
        }
        this.stalled ??= `${this.world.name(id)}'s mouse script: ${report.outcome.reason.split('.')[0]}`;
      }
    } catch (error) {
      this.stalled ??= `${this.world.name(id)}'s mouse script: ${(error as Error).message}`;
    } finally {
      this.world.current = previous;
    }
  }

  /** Runs whatever logic a Compact is on, or reports that it cannot. */
  private runLogic(id: number): void {
    const logic = this.world.field(id, 'logic');
    if (logic === 0) return;

    if (logic === 14) {
      // Counting down. The one non-script logic worth implementing here: it is
      // pure state, it is what `fnPause` sets, and leaving it out would stall
      // every script that pauses.
      const remaining = this.world.field(id, 'flag');
      if (remaining > 0) this.world.setField(id, 'flag', remaining - 1);
      else this.world.setField(id, 'logic', 1);
      return;
    }

    if (logic === 15) {
      // Waiting for another Compact to hand this one a sync, which is how two
      // characters take turns. Pure state, and the commonest thing a booted
      // game sits on — so leaving it out stalls everything behind it.
      if (this.world.field(id, 'sync') !== 0) this.world.setField(id, 'logic', 1);
      return;
    }

    if (logic === 6) {
      // An animation with coordinates. When its program runs out the Compact
      // goes back to its script, and running that in the same tick is what the
      // game does — an animation ending is not a reason to lose a frame.
      if (!this.world.stepAnimation(id)) this.runScript(id);
      return;
    }

    if (logic === 7) {
      // Turning. Ends the same way an animation does: back to the script, in
      // the same tick.
      if (!this.world.stepTurn(id)) this.runScript(id);
      return;
    }

    if (logic === SKY_LOGIC.makeRoute) {
      // Making a route. The Compact has a target and nothing else; this decides
      // whether there is anywhere to go and, if there is, hands it to the logic
      // that follows one — in the same tick, because a route built and not
      // started costs a frame the game does not lose.
      if (!this.world.startRoute(id)) {
        this.world.stepRoute(id);
        this.runScript(id);
        return;
      }
      this.world.setField(id, 'logic', SKY_LOGIC.followRoute);
      this.runLogic(id);
      return;
    }

    if (logic === SKY_LOGIC.followRoute) {
      // Following one. A change of leg turns first — with the frames the mega's
      // own turn table names — and steps on the tick after, which is what keeps
      // a corner from being a mega sliding sideways.
      const turn = this.world.routeTurn(id);
      if (turn !== null) {
        if (this.world.startRouteTurn(id, turn)) {
          this.world.setField(id, 'logic', SKY_LOGIC.turnAround);
          this.world.stepTurn(id);
          return;
        }
      }
      // Arriving puts the Compact back on its script, and running it here is
      // the same "an animation ending is not a reason to lose a frame" the
      // animation logics above make.
      if (!this.world.stepRoute(id)) this.runScript(id);
      return;
    }

    if (logic === SKY_LOGIC.turnAround) {
      // Turning mid-route. `stepTurn` ends a turn by putting the Compact back
      // on its script, which is right for `fnTurnTo` and wrong here — the walk
      // is not over — so the route takes it back.
      if (!this.world.stepTurn(id)) {
        this.world.setField(id, 'logic', SKY_LOGIC.followRoute);
        this.runLogic(id);
      }
      return;
    }

    if (logic === 16) {
      // An animation that ignores coordinates, stepped one frame a tick. Pure
      // state — the program is another Compact's words — so it belongs here
      // rather than waiting for a renderer.
      //
      // Ends the way the two above it do: a program that has run out puts the
      // Compact back on its script and that script runs in the same tick. It is
      // the same "an animation ending is not a reason to lose a frame" — and on
      // this logic it is also the difference between a click that walks the
      // mega and a click that walks the mega and then does the thing, because
      // `fnSetToStand` leaves every arriving walk sitting here.
      if (!this.world.stepSimpleAnimation(id)) this.runScript(id);
      return;
    }

    if (logic !== 1) {
      const name = SKY_LOGIC_NAMES[logic] ?? `logic ${logic}`;
      this.world.unimplementedLogic.set(name, (this.world.unimplementedLogic.get(name) ?? 0) + 1);
      this.stalled ??= `${this.world.name(id)} is on "${name}", which is not implemented`;
      return;
    }

    this.runScript(id);
  }

  /**
   * Runs a Compact's current script until it exits, pauses or stops.
   *
   * A script that exits drops `mode` back by four, which returns to whichever
   * script called it — so this loops rather than returning, and stops when the
   * mode it started on is the mode it is still on.
   */
  private runScript(id: number): void {
    for (let depth = 0; depth < 16; depth += 1) {
      const mode = this.world.field(id, 'mode');
      const scriptNumber = this.world.getSub(id, mode);
      const offset = this.world.getSub(id, mode + 2);
      if (scriptNumber === 0) return;

      const module = this.moduleFor(scriptNumber);
      if (!module) return;

      let from: number;
      try {
        from = offset !== 0 ? offset : skyScriptOffset(module, scriptNumber);
      } catch (error) {
        this.stalled ??= `${this.world.name(id)}: ${(error as Error).message}`;
        return;
      }

      const report = this.interpreter.run(module, from);
      this.scriptsRun += 1;

      if (report.outcome.kind === 'stopped') {
        for (const [name, count] of this.interpreter.unimplemented) {
          this.world.unimplemented.set(name, count);
        }
        this.stalled ??= `${this.world.name(id)}: ${report.outcome.reason.split('.')[0]}`;
        return;
      }

      if (report.outcome.kind === 'paused') {
        this.world.setSub(id, mode + 2, report.outcome.offset);
        return;
      }

      // Finished: drop back to whatever called this script.
      this.world.setSub(id, mode + 2, 0);
      if (mode === 0) {
        this.world.setField(id, 'logic', 0);
        return;
      }
      this.world.setField(id, 'mode', mode - 4);
    }
  }

  /** A script module's words, loaded once and kept. */
  private moduleFor(scriptNumber: number): Uint16Array | null {
    const number = scriptNumber >> 12;
    const cached = this.modules.get(number);
    if (cached) return cached;
    try {
      const bytes = this.resources.read(SKY_MODULE_0 + number);
      const words = new Uint16Array(Math.floor(bytes.length / 2));
      for (let i = 0; i < words.length; i += 1) words[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8);
      this.modules.set(number, words);
      return words;
    } catch (error) {
      this.stalled ??= `script module ${number} could not be read: ${(error as Error).message}`;
      return null;
    }
  }

  /**
   * Draws whatever there is to draw, which is a background and no sprites.
   *
   * Compositing sprites needs the routing the engine stops on, so a room is
   * never complete here. What is drawn is drawn correctly — the pixel layer is
   * checked against the shipped game — and `describeStatus` says the rest is
   * missing rather than leaving a player to read an empty screen.
   */
  render(): void {
    this.paintBackground();
    this.paintSprites();
    this.paintPalette();
  }

  /**
   * Composites the sprites standing in the room.
   *
   * Three passes, the game's own: the background layer, then the sortable
   * sprites in back-to-front order, then the foreground layer. The middle pass
   * is what draws the *people* — Foster's `status` has the sort bit and neither
   * of the flat layers, so a compositor with only two passes draws a room with
   * scenery in it and nobody home, which is exactly what this looked like.
   *
   * The draw lists are found the way the game finds them: `DRAW_LIST_NO` and
   * the variables *after* it, each holding a list Compact, until one is zero.
   * That is a run of script variables rather than one list, and reading only
   * the first would quietly lose whole layers.
   *
   * A sprite's pixels are resource `frame >> 6` and its frame within that
   * resource is `frame & 0x3f`. This reads the resource on demand rather than
   * from what `fnCacheChip` recorded, because a starting state is a snapshot
   * taken after some room's entry script already cached what it needed — so
   * the record of *asking* is empty on a restored world while the resources
   * themselves are perfectly readable.
   */
  private paintSprites(): void {
    if (this.paintedScreen === null) return;
    this.spritesDrawn = 0;
    this.spritesUnreadable = 0;

    for (const layer of [SKY_STATUS.background, SKY_STATUS.foreground] as const) {
      if (layer === SKY_STATUS.foreground) this.paintSortedSprites();
      for (const id of this.drawListIds()) {
        if ((this.world.field(id, 'status') & layer) === 0) continue;
        this.paintSprite(id);
      }
    }
  }

  /**
   * The sortable sprites, drawn back to front by the foot of each sprite.
   *
   * `ycood + offsetY + height` is the game's own key — the bottom of the
   * sprite, not its top — so a character standing further down the screen is
   * drawn later and therefore in front. Sorting on the Compact's `ycood` alone
   * puts a tall character behind a short one standing at the same feet.
   */
  private paintSortedSprites(): void {
    const sortable: Array<{ id: number; foot: number }> = [];
    for (const id of this.drawListIds()) {
      if ((this.world.field(id, 'status') & SKY_STATUS.sort) === 0) continue;
      const sprite = this.spriteFor(id);
      if (!sprite) continue;
      sortable.push({
        id,
        foot: this.world.field(id, 'ycood') + sprite.header.offsetY + sprite.header.height,
      });
    }
    sortable.sort((a, b) => a.foot - b.foot);
    for (const entry of sortable) this.paintSprite(entry.id);
  }

  /** Every Compact the draw lists name, on this screen, in list order. */
  private drawListIds(): number[] {
    const ids: number[] = [];
    const screen = this.world.variables[SKY_VAR.screen];

    for (let variable = SKY_VAR.drawListNumber; variable < SKY_VAR.drawListNumber + 8; variable++) {
      let listId = this.world.variables[variable];
      if (listId === 0) break;
      let list = this.world.words(listId);
      let at = 0;
      let guard = 0;
      while (list && guard < 4096) {
        guard += 1;
        const id = list[at];
        at += 1;
        if (id === 0) break;
        if (id === 0xffff) {
          listId = list[at];
          list = this.world.words(listId);
          at = 0;
          continue;
        }
        if (this.world.field(id, 'screen') === screen) ids.push(id);
      }
    }
    return ids;
  }

  /** A Compact's sprite resource and header, or null when it has none. */
  private spriteFor(id: number): { bytes: Uint8Array; header: SkySpriteHeader } | null {
    const frame = this.world.field(id, 'frame');
    const resource = frame >> 6;
    if (resource === 0) return null;
    let bytes: Uint8Array;
    try {
      bytes = this.resources.read(resource);
    } catch {
      this.spritesUnreadable += 1;
      return null;
    }
    const header = parseSkySpriteHeader(bytes);
    if (!header) {
      this.spritesUnreadable += 1;
      return null;
    }
    return { bytes, header };
  }

  private paintSprite(id: number): void {
    const sprite = this.spriteFor(id);
    if (!sprite) return;
    const drawn = blitSkySprite(
      this.screen.pixels,
      sprite.bytes,
      sprite.header,
      this.world.field(id, 'frame') & 0x3f,
      this.world.field(id, 'xcood'),
      this.world.field(id, 'ycood'),
      SKY_TOP_LEFT_X,
      SKY_TOP_LEFT_Y,
    );
    if (drawn) this.spritesDrawn += 1;
  }

  /**
   * Draws the room's background, which the world names rather than a script.
   *
   * `LAYER_0_ID` is the resource `Screen::recreate` builds the picture from,
   * and a room-entry script sets it a few instructions before it calls
   * `fnDrawScreen`. Reading it every frame rather than only when a script
   * announces one is what makes a *restored* world draw: a starting state is a
   * snapshot taken after some room's entry script ran, so it already names the
   * background, and an engine that waits to be told will wait forever.
   *
   * That is exactly what this engine did. The freeware CD release's starting
   * state carries `LAYER_0_ID` of 64 — 61,440 bytes, the game area exactly —
   * and the report said "no script has asked for a background yet", which was
   * true and beside the point.
   */
  private paintBackground(): void {
    const wanted = this.world.variables[SKY_VAR.layer0Id] || this.world.drawnScreen;
    if (!wanted) return;

    // Restore rather than skip. The background is laid down **every frame**,
    // from a decoded copy kept for the purpose, because the sprites go on top
    // of it and nothing else erases them. Returning early when the room had not
    // changed — which this used to do — meant a walking mega painted itself
    // into the room at every step, and a walk across a screen left a row of
    // Fosters behind it. The copy is what makes redrawing cheap: the decode
    // happens once per room, the `set` once per frame.
    if (wanted === this.paintedScreen && this.backgroundPixels) {
      this.screen.pixels.set(this.backgroundPixels);
      return;
    }

    try {
      const bytes = this.resources.read(wanted);
      // A room covers the game area and leaves the panel's eight rows alone; a
      // full-screen still covers everything. Both are drawn from the top, so
      // the difference is only how far down they reach.
      if (isSkyGameArea(bytes) || isSkyScreen(bytes)) {
        // A room arrives as grid cells and a full-screen still arrives as rows;
        // both land at the top left, so only the unpacking differs.
        this.backgroundPixels = isSkyGameArea(bytes) ? decodeSkyGameArea(bytes) : bytes;
        this.screen.pixels.set(this.backgroundPixels);
        this.paintedScreen = wanted;
        this.world.drawnScreen = wanted;
      } else {
        this.stalled ??=
          `background ${wanted} is ${bytes.length} bytes, which is neither a room's ` +
          `${SKY_GAME_AREA_BYTES} nor a full screen's ${SKY_SCREEN_BYTES}`;
      }
    } catch {
      // A background this reader could not produce is a finding for the stall
      // report rather than a reason to stop the tick.
      this.stalled ??= `background ${wanted} could not be read`;
    }
  }

  /**
   * Applies the palette the world is on.
   *
   * **A palette is a Compact before it is a resource.** ScummVM fetches the
   * current one with `fetchCpt`, and screen 0's entry script passes 4316 to
   * `fnDrawScreen` — a `miscBinary` record of 768 bytes whose every byte is
   * within the 6-bit VGA range. Reading it out of `sky.dsk` instead finds
   * nothing, because that number is not a resource id. The resource path is
   * kept as a fallback rather than dropped: not every palette this engine will
   * meet has been checked yet, and failing over is cheaper than being wrong.
   */
  private paintPalette(): void {
    const paletteId = this.world.chosenPalette;
    if (paletteId === null || paletteId === this.paintedPalette) return;

    const words = this.world.words(paletteId);
    const fromCompact = words
      ? new Uint8Array(words.buffer, words.byteOffset, words.byteLength)
      : null;

    let bytes: Uint8Array | null = fromCompact;
    if (!bytes || !isSkyPalette(bytes)) {
      try {
        bytes = this.resources.read(paletteId);
      } catch {
        this.stalled ??= `palette ${paletteId} is neither a Compact nor a resource here`;
        return;
      }
    }

    if (!isSkyPalette(bytes)) {
      this.stalled ??= `palette ${paletteId} is not a 256-colour six-bit palette`;
      return;
    }

    const colours = parseSkyPalette(bytes);
    const clut = new Uint8Array(colours.length * 3);
    colours.forEach((colour, i) => {
      clut[i * 3] = colour.r;
      clut[i * 3 + 1] = colour.g;
      clut[i * 3 + 2] = colour.b;
    });
    this.palette.setFromClut(clut);
    this.paintedPalette = paletteId;
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.palette);
  }

  saveState(name: string): SavedGameEnvelope {
    const state = this.world.capture(this.startingState);
    const bytes = writeSkyWorldState(state, this.compacts);
    const saved: SkySavedGame = {
      format: SKY_SAVE_FORMAT,
      gameId: this.gameId,
      savedAt: Date.now(),
      name,
      room: this.currentRoom,
      build: this.resources.releaseInfo.build,
      state: Array.from(bytes),
    };
    return saved;
  }

  /**
   * Restores a save, or refuses without touching the world.
   *
   * Every check happens before a single word is written, which is
   * `AdventureEngine`'s rule and matters more here than anywhere: the world
   * state *is* the world, so a half-applied restore is objects from two
   * different games.
   */
  loadState(saved: SavedGameEnvelope): void {
    const candidate = saved as SkySavedGame;
    if (candidate.format !== SKY_SAVE_FORMAT) {
      throw new Error(
        `This save is format ${candidate.format} and this engine writes ${SKY_SAVE_FORMAT}.`,
      );
    }
    if (candidate.gameId !== this.gameId) {
      throw new Error(
        `This save is for "${candidate.gameId}" and this game is "${this.gameId}". A save is ` +
          `tagged with the Target that wrote it (ADR 0012), so it is refused rather than ` +
          `half-applied.`,
      );
    }
    if (!Array.isArray(candidate.state)) {
      throw new Error(`This save carries no Sky world state, so there is nothing to restore.`);
    }

    const state = parseSkyWorldState(Uint8Array.from(candidate.state), this.compacts);
    const refusal = describeSkyStateRefusal(state, this.resources.releaseInfo.build);
    if (refusal) throw new Error(refusal);

    this.applyState(state);
    this.booted = true;
    this.paintedScreen = null;
  }

  /**
   * The room on screen with the player in control, or null when there is none.
   *
   * Three things have to hold together and each is checkable, which is why this
   * is a method rather than a flag somebody sets:
   *
   * - a background is drawn, so there is something to be in;
   * - `MOUSE_STATUS` says the pointer is live, which only `fnAddHuman` sets and
   *   which is the game's own way of saying a person has control;
   * - the pointer engine finds at least one hotspot on this screen, so that
   *   control reaches something.
   *
   * The third is what stops a black room with a live cursor counting. It is a
   * sweep of the screen rather than a claim, and the count goes in the string,
   * because `verifying-version-support.md` wants a number rather than a word.
   *
   * **Deliberately not a member of `AdventureEngine`.** ADR 0011 caps that
   * interface and five families have now left it alone; a Stage above `booted`
   * is one family's question today, so `bin/vt-playthrough.ts` narrows to this
   * engine to ask it. If a second family needs the same question, that is when
   * it earns a place on the seam.
   */
  describeRoom(): string | null {
    if (this.world.drawnScreen === null) return null;
    if ((this.world.variables[SKY_VAR.mouseStatus] & SKY_MOUSE_STATUS.mouse) === 0) return null;

    const screen = this.world.variables[SKY_VAR.screen];
    const spots = this.hotspots();
    if (spots.length === 0) return null;

    const named = spots.map((spot) => spot.name).slice(0, 6);
    return (
      `screen ${screen}, background ${this.world.drawnScreen}, palette ` +
      `${this.world.chosenPalette}, ${spots.length} hotspots the pointer finds ` +
      `(${named.join(', ')}${spots.length > named.length ? ', …' : ''}), player in control`
    );
  }

  /**
   * Every hotspot the pointer engine finds on the current screen, each with a
   * point it was found at.
   *
   * The same sweep `describeRoom` counts, returning the coordinates rather than
   * a count — so `bin/vt-playthrough.ts` can do the first thing a player does in
   * a room, which is click somewhere to go there. A click needs a place to land,
   * and the pointer engine is the only thing that knows where the game put its
   * hotspots, so the harness asks it rather than guessing pixels.
   *
   * One point per hotspot, the first cell the sweep lands on it, which is enough
   * to click it. Deliberately not a member of `AdventureEngine`: like
   * `describeRoom`, this is one family's question and stays off the seam ADR
   * 0011 caps until a second family needs it.
   */
  hotspots(): SkyHotspot[] {
    const found = new Map<number, SkyHotspot>();
    for (let y = 0; y < SKY_GAME_AREA_HEIGHT; y += 4) {
      for (let x = 0; x < SKY_SCREEN_WIDTH; x += 4) {
        const id = this.world.pointerOver(x + SKY_TOP_LEFT_X, y + SKY_TOP_LEFT_Y);
        if (id !== 0 && !found.has(id)) {
          found.set(id, { id, name: this.world.name(id), x, y });
        }
      }
    }
    return [...found.values()];
  }

  /**
   * Where the player character is standing, or null when there is no answer.
   *
   * Sky keeps a mega's position in its own Compact, so this is `foster`'s
   * `xcood`/`ycood` — the Compact found by the name the shipped name pool gives
   * it rather than by a hard-coded id (see `SkyWorld.idNamed`).
   *
   * The one measurement that settles "does clicking the floor walk him": a
   * screen that changed and a script that did not stop are both consistent with
   * a walk that never started, and a pair of coordinates is not.
   *
   * Off the `AdventureEngine` seam for the reason {@link hotspots} gives.
   */
  playerAt(): { x: number; y: number } | null {
    const foster = this.world.idNamed('foster');
    if (foster === null) return null;
    return { x: this.world.field(foster, 'xcood'), y: this.world.field(foster, 'ycood') };
  }

  /**
   * What the most recent tick stopped on, or null if nothing did.
   *
   * `describeStall` folds this into a line; this exposes it alone so a harness
   * that drives one player action — a click — can read what that action stopped
   * on without parsing a report. Reset at the top of every `step`, so it is the
   * last tick's stop and not an older one.
   */
  get lastStop(): string | null {
    return this.stalled;
  }

  /** A Compact's own name, which is what Sky has instead of a room name. */
  roomName(room: number): string | undefined {
    const name = this.world.name(room);
    return name.startsWith('compact ') ? undefined : name;
  }

  describeStatus(): string | undefined {
    if (this.hasQuit) return 'The game asked to quit.';
    if (!this.booted) return undefined;

    // **A room awaiting input is not a stall.** Sky's opening room *is* screen
    // 0, and an adventure game stands still until somebody moves the pointer,
    // so a world that has not changed is the normal resting state rather than a
    // complaint. Reported as a problem it produced "Still in room 0 after 10s"
    // on a game that was working — the shell infers a stall from an unchanged
    // room number, and this is the engine telling it not to.
    //
    // Checked before the notes below on purpose: a section's unloaded music is
    // a real gap and not a reason to call a playable room broken.
    if (this.stalled === null && this.describeRoom() !== null) return undefined;

    const missing = this.world.notes();
    if (missing.length > 0) {
      const worst = missing[0];
      return (
        `Sky runs its scripts and stops where they call out of the interpreter: ` +
        `${worst.what} (${worst.count} times). Nothing is skipped, so the game does not ` +
        `progress past it.`
      );
    }

    // Nothing unimplemented and nothing happening are different complaints, and
    // a player reporting one usually cannot tell which they have.
    if (this.unchangedTicks > 120) {
      const polled = this.pollingOn();
      // The mouse's own variable earns a sentence the others do not, because an
      // engine with no input loop can never write it and that is a different
      // kind of wait from a script waiting on another script. Said only when
      // the polled variable actually is that one: the first version of this
      // asserted it unconditionally, and read as a confident explanation of
      // the wrong variable once the spinning Compacts stopped drowning it out.
      const isMouse = polled?.index === SKY_VAR.mouseStatus;
      const waitingOn = polled
        ? `waiting on ${skyVariableName(polled.index)} (script variable ${polled.index}), which ` +
          `the scripts read ${polled.reads} times and nothing on this side ever writes — so the ` +
          `loop reading it cannot end` +
          (isMouse
            ? `. That variable is the mouse's, and the game is idle with the player nominally ` +
              `in control, polling for the pointer input this engine has no input loop to ` +
              `deliver`
            : ``)
        : `waiting for something this engine does not yet provide`;
      return (
        `Sky is running its scripts — ${this.scriptsRun} so far — and the world has not ` +
        `changed for ${this.unchangedTicks} ticks. Nothing is unimplemented; the game is ` +
        `${waitingOn}.`
      );
    }
    return undefined;
  }

  /**
   * The busiest script variable that is read and never written, if any.
   *
   * A poll loop's cause: a variable read thousands of times with zero writes is
   * one the scripts spinning on it are waiting to change. It named Bug 2 — until
   * #268 the top such variable was MOUSE_STATUS, which the game polls and
   * nothing here set, and piece 1's mouse engine now writes it. What tops the
   * list on the CD release after that is variable 111, and it is a different
   * animal: the game's *own* scripts write it (five `pop_variable 444` sites in
   * script module 1, the section that holds `lazer_s4`), but only inside a
   * branch a booted-but-unplayable run never reaches — a dormant state machine,
   * cycling 0→1→2→0 when the opening laser fires, not an engine gap. The line
   * below states only the measured fact, read against written; which of the two
   * a given variable is, the report says.
   *
   * Re-measured on the freeware CD release after the walk landed, because a
   * variable at the top of this list looks like the thing stopping the game and
   * here is not: across 1,200 ticks variable 111 has exactly **one** reader,
   * the `lazer_s4` Compact, reading it once a tick and finding 0. One scenery
   * script idling is not a player unable to move — the click walks Foster with
   * that same read happening every tick — so the line below deliberately stops
   * short of calling a poll a fault.
   */
  private pollingOn(): { index: number; reads: number } | null {
    for (const traffic of this.interpreter.variableTraffic()) {
      if (traffic.writes === 0 && traffic.reads > 0) {
        return { index: traffic.index, reads: traffic.reads };
      }
    }
    return null;
  }

  /** One line naming what the scripts poll, for the stall report. */
  private describePolling(): string {
    const traffic = this.interpreter.variableTraffic();
    if (traffic.length === 0) return 'no script has read a variable yet';
    const busiest = traffic[0];
    const polled = this.pollingOn();
    const spun = polled
      ? `${skyVariableName(polled.index)} is read ${polled.reads} times this run and ` +
        `never written this run — a script is waiting on a state nothing has entered, ` +
        `which is an engine gap only if this engine is what should have written it`
      : `nothing is read without also being written`;
    return (
      `most-read variable: ${skyVariableName(busiest.index)} (${busiest.reads} reads, ` +
      `${busiest.writes} writes); ${spun}`
    );
  }

  /**
   * The walk grids, as a report clause. States what ships and is checked, and
   * — the part that matters for not over-claiming — that the router does not
   * read them: megas walk, in straight lines, because the table naming which
   * grid a screen uses is refused under ADR 0033 (`SkyGrid.ts`).
   */
  private describeGrids(): string {
    const grids = this.world.grids;
    if (!grids) return 'and the walk grids were not loaded';
    const verdict = grids.verify();
    const shape = verdict.complete
      ? `the ${TOT_NO_GRIDS} walk grids ship (resources ${60000}–${60000 + TOT_NO_GRIDS - 1}) ` +
        `and are read and verified`
      : `the walk grids are malformed (${verdict.present} present, sizes ${verdict.sizes.join('/')})`;
    return (
      `but ${shape} — and nothing reads them: fnAr routes in a straight line ` +
      `because which grid a screen uses is refused (ADR 0033), so a mega walks ` +
      `through scenery rather than around it`
    );
  }

  describeStall(): string[] {
    const notes = this.world.notes();
    const recent = this.interpreter.recentInstructions();
    return [
      `Sky (${this.resources.releaseInfo.description}, v0.0${this.resources.releaseInfo.build})`,
      `booted: ${this.booted}, ticks: ${this.ticks}, scripts run: ${this.scriptsRun}`,
      `screen ${this.world.variables[SKY_VAR.screen]}, ` +
        `logic list ${this.world.variables[SKY_VAR.logicListNumber]}, ` +
        `${this.world.cached.size} resources scripts asked to have loaded`,
      this.world.enteredSection === null
        ? 'no section has been entered, so nothing loaded a room'
        : `section ${this.world.enteredSection} entered (${this.world.sectionsEntered} in all); ` +
          `its music and sound effects are stubbed, ${this.describeGrids()}`,
      this.stalled ? `stopped on: ${this.stalled}` : 'nothing stopped this tick',
      this.unchangedTicks > 0
        ? `the world has looked the same for ${this.unchangedTicks} ticks`
        : 'the world changed this tick',
      notes.length === 0
        ? 'every mcode reached so far is implemented'
        : `not implemented, most-reached first: ${notes
            .slice(0, 6)
            .map((note) => `${note.what} x${note.count}`)
            .join(', ')}`,
      recent.length === 0
        ? 'no instructions have run'
        : `last instructions: ${recent
            .slice(-4)
            .map((instruction) => `${instruction.at}:${instruction.name}`)
            .join(' ')}`,
      this.describePolling(),
      // The last frame actually composited, which is not the same as the
      // current one: applying a state clears what is painted and nothing
      // repaints until the next render, so a report taken straight after a
      // restore would say nothing had ever been drawn.
      this.spritesDrawn === 0
        ? 'no sprites composited'
        : `${this.spritesDrawn} sprites composited on the last frame drawn` +
          (this.spritesUnreadable > 0
            ? `, ${this.spritesUnreadable} whose pixels could not be read`
            : ''),
      this.world.drawnScreen === null
        ? 'no script has asked for a background yet'
        : `background ${this.world.drawnScreen}, palette ${this.world.chosenPalette ?? 'none'}`,
    ];
  }

  /**
   * How the Release was established, for the editable project.
   *
   * Sky carries a Release rather than a Version (ADR 0023), so this names the
   * release the Compacts were read from rather than a probe result.
   */
  private get skyIdentification(): string {
    return `the ${this.resources.releaseInfo.release} release, v0.0${this.resources.releaseInfo.build}`;
  }

  /** The Target this game compiles to, though the SCUMM builder refuses it (ADR 0024). */
  private get target(): Target {
    return { engine: 'sky', release: this.resources.releaseInfo.release, platform: 'dos' };
  }

  /**
   * Why this game may not be edited, or null when it may.
   *
   * ADR 0025's conditions over the Compact table — it round-trips byte-identical
   * and nothing is Unrecovered — asked before the work rather than discovered by
   * attempting it, and deliberately the same string `toEditableGame` throws so
   * the two cannot drift.
   */
  describeEditRefusal(): string | null {
    const project = importSkyProject(
      this.compactBytes,
      this.resources.releaseInfo.release,
      'dos',
      this.skyIdentification,
    );
    if (project.editable.editable) return null;
    return `Editing Beneath a Steel Sky is refused: ${project.editable.reasons.join('; ')}.`;
  }

  async toEditableGame(options: EditableGameOptions): Promise<EditableGame | null> {
    // The Compact table is the primary editable surface (ADR 0025); text is its
    // own surface and, for now, an empty one this project does not read yet.
    // Every module, so the Project carries the bytecode as Preserved bytes and
    // the editor can list it. Loaded here rather than lazily because a Project
    // that holds only the modules a playthrough happened to touch is a
    // different artefact depending on when it was taken.
    const modules = new Map<number, Uint16Array>();
    for (let number = 0; number < SKY_SCRIPT_MODULES; number += 1) {
      const words = this.moduleFor(number << 12);
      if (words) modules.set(number, words);
    }

    // The drawable resources for the picture surface — screens, room backgrounds
    // and palettes unpacked, sprites packed, all Preserved bytes (ADR 0025).
    // The split is a size decision and pictures.ts explains it.
    const scanned = collectSkyDrawables(this.resources);
    // Which palettes a room is drawn with, from the game's own scripts. Without
    // this the picker offered only the 29 palettes that are *resources* — and a
    // room's palette is a **Compact**, so it offered none that a room uses and
    // every picture came out in colours it never had.
    const pairings = deriveSkyPicturePalettes(modules);
    const drawables = {
      ...scanned,
      pictures: scanned.pictures.map((picture) => ({
        ...picture,
        palettes: pairings.get(picture.id) ?? [],
      })),
      palettes: [...collectSkyCompactPalettes(this.compacts), ...scanned.palettes],
      // The player, the actors and the objects. Carried packed — 1.58 MB across
      // 971 resources, against 15.50 MB unpacked — and unpacked one at a time
      // by the editor, which is why they can be here at all.
      sprites: collectSkySprites(this.resources),
    };

    const project = importSkyProject(
      this.compactBytes,
      this.resources.releaseInfo.release,
      'dos',
      this.skyIdentification,
      modules,
      drawables,
    );
    options.onProgress?.(1, 1, 'Sky project');

    const notes = [
      `Beneath a Steel Sky, ${this.resources.releaseInfo.description} (v0.0${this.resources.releaseInfo.build})`,
      `${project.records.length} compacts, Unrecovered: ${project.editable.unrecovered} ` +
        `(a count over the object table, not over scripts — ADR 0025)`,
      project.editable.editable
        ? 'the Compact table round-trips byte-identically; editing changes field values in place'
        : `read-only: ${project.editable.reasons.join('; ')}`,
      'text is its own surface and is not read yet — Sky keeps it compressed with the tree in ' +
        'the executable (ADR 0025)',
      `${project.scripts.length} script modules held as Preserved bytes, ` +
        `${project.scripts.reduce((total, module) => total + module.numbers.length, 0)} scripts ` +
        `listed read-only — Disassembly, not Decompilation (ADR 0025)`,
      'export stays refused: a Sky game is rebuilt by rewriting its resources and patching its ' +
        'object table into the executable, which the SCUMM builder does not do (ADR 0024)',
    ];

    return {
      project: {
        version: 6,
        target: this.target,
        name: this.gameId,
        start: { room: this.currentRoom, x: 0, y: 0 },
        defaultResponse: '',
        screen: { textHeight: 0, verbTop: 0 },
        verbs: [],
        actors: [],
        rooms: [],
        scripts: [],
        audio: [],
        sky: toSkyProjectJson(project),
      },
      notes,
    };
  }
}
