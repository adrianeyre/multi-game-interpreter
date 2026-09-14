import { ScummEngine } from '../engine/ScummEngine.js';
import type { AdventureEngine, InputSurface } from '../engine/AdventureEngine.js';
import { SCREEN_HEIGHT, SCREEN_WIDTH } from '../engine/gfx/Screen.js';
import { MemoryDataSource } from '../engine/resource/DataSource.js';
import { LoadProgressTracker } from '../engine/resource/progress.js';
import { buildProject } from '../authoring/projectToGame.js';
import type { Project } from '../authoring/project.js';
import { readTrackBytes } from './audioBytes.js';
import { keepPlayerVisible } from './playFrom.js';
import { trapFocus, type FocusTrap } from '../ui/a11y.js';

/** Kept because a chatty game would otherwise grow one text node without limit. */
const LOG_LIMIT = 500;

/**
 * How many frames to let the game settle before judging whether it started.
 *
 * The boot script places the player and turns input on, but a room's own entry
 * script runs too, and a real game's opening room may legitimately spend a
 * moment in a cutscene before handing over. Half a second is long enough that
 * a working game has finished and short enough that a stuck one is called out
 * while the author is still looking at it.
 */
const SETTLE_FRAMES = 30;

/**
 * How long Play keeps watching that the player is somewhere visible.
 *
 * Checking once, when the game has settled, was checking too early: a real
 * opening room can spend many seconds on its own sequence, and the script that
 * moves the player out of sight may not run until well past the half second
 * the settle check waits. Ten seconds covers an opening without Play arguing
 * with the game for the rest of the session.
 */
const RESCUE_FRAMES = 600;

/**
 * Plays the project without leaving the editor.
 *
 * The compiler produces byte arrays and the engine loads from memory, so this
 * is the real compiled game running in the real interpreter — not a preview
 * with different behaviour. That is the whole value of it: what you test is
 * what ships.
 *
 * Which means it has to be *diagnosable*. The interpreter reports everything it
 * cannot do — an opcode it has not implemented, a script it thinks is stuck —
 * through the log callback its host supplies, and that report is the only thing
 * standing between "the room is drawn and nothing responds" and a bug that
 * cannot be investigated at all. So the log is kept in full, in a panel that
 * scrolls, and mirrored to the console: a freeze inside the engine means the
 * page never repaints, and console lines written before the freeze survive in
 * DevTools when the panel is frozen with it.
 */
export class PlayOverlay {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly status: HTMLElement;
  private readonly logElement: HTMLPreElement;
  private readonly logLines: string[] = [];

  /**
   * The running game, whichever family it belongs to.
   *
   * Typed as the family-neutral interface because this overlay now starts two
   * kinds of game: a SCUMM project it compiles itself, and an AGOS game rebuilt
   * from its own files. Everything the loop needs — `boot`, `step`, `render`,
   * `present`, `input`, `sound` — is on that interface, which is what makes one
   * loop honest rather than a SCUMM loop with an AGOS branch in it.
   */
  private engine: AdventureEngine | null = null;

  /**
   * The same engine when it is a SCUMM one, and null otherwise.
   *
   * The diagnostics and the keep-the-player-in-sight rescue below are about
   * actors, walk boxes and a `userPut` gate — SCUMM's nouns, not a family's in
   * general — so they ask for this rather than reaching through the interface
   * and finding the methods absent at run time.
   */
  private scumm: ScummEngine | null = null;
  /** The loaded game's script space, or 320x200 while there is no game. */
  private script = { width: SCREEN_WIDTH, height: SCREEN_HEIGHT };
  private running = false;
  private frameHandle = 0;
  private framesRun = 0;
  private settled = false;
  /** Where Play decided the player should stand in the room being played. */
  private startPoint: Project['start'] | null = null;
  private rescues = 0;
  /** The Stop button, which is where focus lands when the overlay opens. */
  private closeButton!: HTMLButtonElement;
  /** Keeps Tab inside the overlay and the editor behind it inert while it is up. */
  private trap: FocusTrap | null = null;

  constructor() {
    this.element = document.createElement('div');
    this.element.className = 'play-overlay';
    this.element.hidden = true;

    const panel = document.createElement('div');
    panel.className = 'play-panel';
    // It covers the editor and takes the keyboard, so it is a modal dialog and
    // now says so. Before this it was a `<div>` over the page with the whole
    // editor still tabbable behind it — and the editor's own Ctrl+Z and Ctrl+S
    // still live underneath a running game.
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');

    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.id = 'play-overlay-title';
    title.textContent = 'Playing';
    panel.setAttribute('aria-labelledby', title.id);

    // Asking the engine what it is waiting for, without a reload. The reports
    // it can give are exactly the questions a stuck room raises: who is where,
    // what is in it, what is running, and why nothing responds.
    const diagnose = document.createElement('button');
    diagnose.type = 'button';
    diagnose.textContent = 'Diagnostics';
    diagnose.title = 'Ask the engine what it is doing, and write it to the log';
    diagnose.addEventListener('click', () => this.logDiagnostics());

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Stop';
    close.title = 'Stop the game and go back to the editor';
    close.addEventListener('click', () => this.stop());
    header.append(title, diagnose, close);
    this.closeButton = close;

    this.canvas = document.createElement('canvas');
    // The default until a game says otherwise: this overlay only ever plays a
    // SCUMM project, which is 320x200 in both spaces, and it resizes from
    // `engine.resolution` on load so that stops being an assumption (#213).
    this.canvas.width = SCREEN_WIDTH;
    this.canvas.height = SCREEN_HEIGHT;
    this.canvas.className = 'play-canvas';
    /*
     * The picture the compiled game draws.
     *
     * Named and operable, and honest about the rest: what is *in* it is a
     * running game redrawn sixty times a second, and no text alternative can
     * describe that. The log below is the closest thing there is, which is why
     * it is always present rather than behind a disclosure.
     */
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'application');
    this.canvas.setAttribute('aria-label', 'Game preview');
    this.canvas.setAttribute('aria-describedby', 'play-canvas-help');

    const canvasHelp = document.createElement('p');
    canvasHelp.id = 'play-canvas-help';
    canvasHelp.className = 'visually-hidden';
    canvasHelp.textContent =
      'A preview of the room you are editing. Click in it to give the game a command, and ' +
      'use the keys the game itself asks for. Escape stops the preview and returns to the ' +
      'editor. The engine log below reports what the game is doing.';

    const context = this.canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;

    this.status = document.createElement('p');
    this.status.className = 'play-status muted';
    // Whether the game started, and why it did not. It appears without taking
    // focus, which is what makes it a status message (4.1.3).
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');

    this.logElement = document.createElement('pre');
    this.logElement.className = 'play-log';
    // Scrollable, so it needs a tab stop or it cannot be scrolled by keyboard
    // (2.1.1). `role="log"` rather than a live region: it is appended to
    // constantly and reading every line aloud would drown everything else.
    this.logElement.tabIndex = 0;
    this.logElement.setAttribute('role', 'log');
    this.logElement.setAttribute('aria-label', 'Engine log');

    panel.append(header, this.canvas, canvasHelp, this.status, this.logElement);
    this.element.appendChild(panel);

    this.attachInput();
    // Clicking the backdrop stops playing, but clicks inside must not.
    this.element.addEventListener('click', (event) => {
      if (event.target === this.element) this.stop();
    });
  }

  /**
   * Records one line from the engine.
   *
   * Both destinations matter. The panel is what an author reads; the console is
   * what survives a freeze, and a freeze is the case this exists for.
   */
  private log(message: string): void {
    this.logLines.push(message);
    if (this.logLines.length > LOG_LIMIT) {
      this.logLines.splice(0, this.logLines.length - LOG_LIMIT);
    }
    this.logElement.textContent = `${this.logLines.join('\n')}\n`;
    this.logElement.scrollTop = this.logElement.scrollHeight;
    console.info(`[scumm] ${message}`);
  }

  /** The engine's own account of itself, in the log where it can be copied. */
  private logDiagnostics(): void {
    if (this.engine && !this.scumm) {
      // An AGOS game has no actor table and no verb-strip gate to report on, so
      // this says what the engine itself will answer rather than nothing.
      this.log(`Frame ${this.engine.frame}, room ${this.engine.currentRoom}.`);
      for (const line of this.engine.describeStall()) this.log(line);
      return;
    }
    if (!this.scumm) {
      this.log('Not running, so there is nothing to report.');
      return;
    }
    this.log(`Input: ${this.scumm.describeInputState()}`);
    this.log(`Actors:\n${this.scumm.describeActorState()}`);
    // Objects belong here for the same reason actors do. A played room that
    // draws its background and nothing else raises the question of whether its
    // objects were never imported, never placed, sitting in a state that draws
    // nothing, or failing to decode — and until this line was here, the report
    // covered input, actors and scripts and said nothing at all about them, so
    // the question could only be guessed at from outside.
    this.log(`Objects:\n${this.scumm.describeObjectState()}`);
    this.log(`Scripts:\n${this.scumm.describeScriptState()}`);
  }

  /**
   * Whether the game actually started, and what to say if it did not.
   *
   * "The room is drawn and nothing responds" has two causes that look identical
   * from the outside: a game deliberately holding input during an opening
   * cutscene, and a game that began one and never ended it. Telling the author
   * which one they are looking at is the difference between a bug they can
   * report and a bug they cannot.
   *
   * So the two are reported differently. A missing player is *wrong* whatever
   * else is true — the boot script places it before it hands over, so if it is
   * not here the hand-over never happened. Input being held is only *possibly*
   * wrong, because that is exactly what an opening cutscene looks like a
   * half-second in; it is stated rather than alarmed about, and the log carries
   * the detail either way. Crying wolf over a working cutscene would train the
   * author to ignore the one line that matters.
   */
  private assessStart(): void {
    const engine = this.scumm;
    if (!engine) return;

    const ego = engine.actors[engine.variables[engine.vars.EGO]];
    const broken: string[] = [];

    if (!ego) {
      broken.push('there is no player actor');
    } else if (!ego.isInCurrentRoom(engine.currentRoom)) {
      broken.push(`the player is in room ${ego.room}, not room ${engine.currentRoom}`);
    } else if (!ego.visible) {
      broken.push('the player is hidden');
    }

    const cutsceneDepth = engine.scriptState.cutSceneStack.length;
    const held: string[] = [];
    if (!engine.userPut) held.push('input is off');
    if (cutsceneDepth > 0) held.push(`a cutscene is running (depth ${cutsceneDepth})`);

    if (broken.length === 0 && held.length === 0) {
      this.status.classList.remove('play-problem');
      this.status.textContent = 'Click to interact. Escape or Stop to return to the editor.';
      return;
    }

    if (broken.length > 0) {
      this.status.classList.add('play-problem');
      this.status.textContent =
        `The room is drawn but the game has not started: ${broken.join(', ')}. ` +
        `See the log below.`;
      this.log(`The game did not finish starting: ${broken.join(', ')}.`);
    } else {
      this.status.classList.remove('play-problem');
      this.status.textContent =
        `Playing, but not yet yours: ${held.join(', ')}. ` +
        `If it stays this way, the opening never handed over.`;
      this.log(`Started, with control still held: ${held.join(', ')}.`);
    }

    this.logDiagnostics();
  }

  /**
   * Puts the player back in sight, saying so the first time and once more if
   * the room will not leave them there.
   *
   * Silent after that: a room determined to hide the player would otherwise
   * write a line every frame and bury the log that explains why.
   */
  private keepPlayerInSight(): void {
    if (!this.scumm || !this.startPoint) return;
    const moved = keepPlayerVisible(this.scumm, this.startPoint);
    if (!moved) return;

    this.rescues++;
    if (this.rescues === 1) this.log(moved);
    else if (this.rescues === 2) {
      this.log('The room keeps moving the player out of sight; Play keeps putting them back.');
    }
  }

  private attachInput(): void {
    const toScreen = (event: MouseEvent): { x: number; y: number } => {
      const bounds = this.canvas.getBoundingClientRect();
      return {
        // The script space, which is what the game's own coordinates are in.
        x: Math.floor(((event.clientX - bounds.left) / bounds.width) * this.script.width),
        y: Math.floor(((event.clientY - bounds.top) / bounds.height) * this.script.height),
      };
    };

    this.canvas.addEventListener('mousemove', (event) => {
      if (!this.scumm) return;
      const { x, y } = toScreen(event);
      this.scumm.setMousePosition(x, y);
    });

    // Input is reported on the press, in one call, exactly as the shell does
    // it (`ScummEngine.pressButton`): the verb-strip hit test and the
    // `userPut` gate live in the engine, so an overlay cannot drift from it.
    this.canvas.addEventListener('mousedown', (event) => {
      if (!this.scumm) return;
      void this.scumm.sound.resume();
      const { x, y } = toScreen(event);

      // A click the engine is going to discard is worth saying out loud: it is
      // the symptom an author reports as "clicking does nothing".
      if (!this.scumm.userPut) {
        this.log(`Click at ${x},${y} ignored: ${this.scumm.describeInputState()}`);
        return;
      }
      this.scumm.pressButton(event.button === 2 ? 2 : 1, x, y);
    });

    this.canvas.addEventListener('mouseup', () => this.scumm?.releaseButton());
    this.canvas.addEventListener('mouseleave', () => this.scumm?.releaseButton());
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());

    window.addEventListener('keydown', (event) => {
      if (!this.running || !this.engine) return;
      if (event.key === 'Escape') {
        this.stop();
        return;
      }
      if (event.key.length === 1) this.scumm?.pressKey(event.key.charCodeAt(0));
    });
  }

  /** Compiles and starts. Returns problems rather than throwing. */
  async start(project: Project, allowCode: boolean): Promise<string[]> {
    this.logLines.length = 0;
    this.logElement.textContent = '';
    this.framesRun = 0;
    this.settled = false;
    this.rescues = 0;
    this.startPoint = project.start;
    this.status.classList.remove('play-problem');

    const built = buildProject(project, { allowCode });
    if (built.errors.length > 0) return built.errors;

    // What is actually being played, before anything can go wrong with it. A
    // room that draws with nobody in it raises the question of whether there
    // was anybody to draw, and the compiler already knows: it counts what it
    // wrote and warns about what it could not. Both were being thrown away
    // here, so an actor compiled without a costume — which is exactly a
    // character that cannot appear — was never mentioned to anyone.
    this.log(
      `Playing room ${project.start.room} from ${built.stats.rooms} rooms, with ` +
        `${project.actors.length} actors, ${built.stats.objects} objects and ` +
        `${built.stats.costumes} costumes. The player starts at ` +
        `${project.start.x},${project.start.y}.`,
    );
    for (const warning of built.warnings) this.log(warning);

    const source = new MemoryDataSource('preview');
    source.set('PREVIEW.000', built.index);
    source.set('PREVIEW.001', built.data);

    // The preview is small enough to load in a blink, but saying which step is
    // running still beats a blank pause when a project has grown large.
    const progress = new LoadProgressTracker((update) => {
      this.status.textContent = `${update.message} (${Math.round(update.fraction * 100)}%)`;
    });

    try {
      this.scumm = await ScummEngine.create(source, {
        onLog: (message) => this.log(message),
        onActivity: (activity) => console.debug(`[scumm] ${activity}`),
        progress,
      });
      this.engine = this.scumm;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message);
      return [message];
    }

    window.scumm = this.scumm;

    // Sized from the game rather than from a constant (#213). SCUMM answers
    // 320x200 for both halves, so nothing moves here today; what changes is
    // that a family with two coordinate spaces would not need this file edited
    // again.
    const { script, display } = this.engine.resolution;
    this.script = script;
    this.canvas.width = display.width;
    this.canvas.height = display.height;

    // Imported audio is handed over before the boot script runs, so a sound
    // started by the very first script has already been decoded. `start` is
    // called from the Play button, so the user gesture Web Audio needs is
    // still live at this point.
    if (project.audio.length > 0) {
      try {
        await this.scumm.sound.load(project.audio, readTrackBytes);
      } catch {
        // Audio failing is not a reason to refuse to run the game.
      }
    }

    progress.report('booting', 'Running the boot script…', 0.2);

    // A boot script that throws used to reject out of here with the overlay
    // still hidden, so the author saw nothing happen at all.
    try {
      const startedAt = performance.now();
      this.scumm.boot(0);
      this.log(`Boot script finished in ${Math.round(performance.now() - startedAt)} ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(message);
      this.show();
      this.status.textContent = `The boot script stopped: ${message}`;
      return [message];
    }

    this.show();
    this.running = true;
    this.status.textContent = 'Starting…';

    let last = 0;
    let accumulator = 0;
    const step = 1000 / 60;

    const loop = (now: number): void => {
      if (!this.running || !this.engine) return;
      if (last === 0) last = now;
      accumulator += Math.min(250, now - last);
      last = now;

      let steps = 0;
      while (accumulator >= step && steps < 4) {
        this.engine.step();
        accumulator -= step;
        steps++;
      }
      this.engine.render();
      // Through the family-neutral `present` rather than reaching for a SCUMM
      // screen and palette: the two families paint through different pipelines
      // and the interface exists precisely so this loop does not have to know
      // which one it is driving.
      this.engine.present(this.context);

      this.framesRun++;
      // Undo a room that hid the player, for as long as its opening might
      // still be running. Doing this only at the settle check meant a script
      // that parked the player a few seconds in was never noticed, and the
      // author was left looking at a room with nobody in it.
      if (this.framesRun <= RESCUE_FRAMES) this.keepPlayerInSight();

      if (!this.settled && this.framesRun >= SETTLE_FRAMES) {
        this.settled = true;
        this.assessStart();
      }

      this.frameHandle = requestAnimationFrame(loop);
    };

    this.frameHandle = requestAnimationFrame(loop);
    return [];
  }

  /**
   * Starts a game that is already built, whichever family it belongs to.
   *
   * The other entry point compiles a SCUMM project and then runs it. An AGOS
   * game is not compiled from intent — ADR 0030 rebuilds its two files whole —
   * so by the time it reaches here it *is* a game, and the only thing left to
   * do is what the loop below does for both.
   *
   * Input goes through `engine.input.attach` rather than the pointer handlers
   * this overlay wired for SCUMM. Those handlers know about a verb strip and a
   * `userPut` gate, which are SCUMM's; the interface is how the app shell drives
   * every family, and using it here is what keeps the preview's behaviour the
   * same as the player's rather than a second approximation of it.
   */
  async startEngine(engine: AdventureEngine, notes: readonly string[] = []): Promise<string[]> {
    this.logLines.length = 0;
    this.logElement.textContent = '';
    this.framesRun = 0;
    this.settled = false;
    this.rescues = 0;
    // No rescue for a non-SCUMM game: `keepPlayerVisible` is about actors and
    // walk boxes, and a game with neither must not have a start point invented
    // for it.
    this.startPoint = null;
    this.status.classList.remove('play-problem');

    this.engine = engine;
    this.scumm = null;
    for (const note of notes) this.log(note);
    this.log(`Playing ${engine.targetName} (${engine.gameId}).`);

    const { script, display } = engine.resolution;
    this.script = script;
    this.canvas.width = display.width;
    this.canvas.height = display.height;

    engine.input.attach(this.inputSurface());

    try {
      const startedAt = performance.now();
      engine.boot();
      this.log(`Boot finished in ${Math.round(performance.now() - startedAt)} ms`);
    } catch (error) {
      // Shown rather than rejected out of here: a boot that throws with the
      // overlay still hidden looks to the author like a button that did nothing.
      const message = error instanceof Error ? error.message : String(error);
      this.log(message);
      this.show();
      this.status.textContent = `The game stopped while starting: ${message}`;
      return [message];
    }

    this.show();
    this.running = true;
    this.status.textContent = 'Running';
    this.runLoop();
    return [];
  }

  /** The surface an Engine's own input object reads the screen and events from. */
  private inputSurface(): InputSurface {
    return {
      canvas: this.canvas,
      // The window, so a keystroke reaches the game without the canvas having
      // to hold focus — the same choice the app shell makes.
      keys: window,
      overlay: this.element,
      toScreen: (client) => {
        const bounds = this.canvas.getBoundingClientRect();
        return {
          // Through the *script* space, not the display one: a game that draws
          // larger than it thinks would otherwise get every click at twice the
          // coordinate its scripts test against, and miss every hotspot with
          // nothing reporting a fault.
          x: Math.floor(((client.clientX - bounds.left) / bounds.width) * this.script.width),
          y: Math.floor(((client.clientY - bounds.top) / bounds.height) * this.script.height),
        };
      },
      resumeSound: () => void this.engine?.sound.resume(),
    };
  }

  /**
   * The frame loop, for a game with no SCUMM rescue attached to it.
   *
   * A fixed step with a bounded catch-up, the same as the SCUMM path's: a tab
   * that was in the background for a minute must not try to run a minute of
   * game in one frame.
   */
  private runLoop(): void {
    let last = 0;
    let accumulator = 0;
    const step = 1000 / 60;

    const loop = (now: number): void => {
      if (!this.running || !this.engine) return;
      if (last === 0) last = now;
      accumulator += Math.min(250, now - last);
      last = now;

      let steps = 0;
      while (accumulator >= step && steps < 4) {
        this.engine.step();
        accumulator -= step;
        steps++;
      }
      this.engine.render();
      this.engine.present(this.context);
      this.framesRun++;

      const stalled = this.engine.describeStatus();
      if (stalled) this.status.textContent = stalled;

      this.frameHandle = requestAnimationFrame(loop);
    };

    this.frameHandle = requestAnimationFrame(loop);
  }

  /**
   * Raises the overlay and takes the keyboard with it.
   *
   * Focus goes to Stop rather than to the canvas: the overlay may have opened
   * to report that the game did not start, and in that case the one thing there
   * is to do is leave. A game that did start is played with the same keys
   * whether or not the canvas holds focus — the engine listens on the window —
   * so nothing is lost by starting at the way out.
   */
  private show(): void {
    if (!this.element.hidden) return;
    this.element.hidden = false;
    this.trap = trapFocus(this.element, { onEscape: () => this.stop() });
    this.closeButton.focus();
  }

  stop(): void {
    this.running = false;
    if (this.frameHandle) cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    this.scumm?.sound.stopAll();
    this.engine?.input.detach();
    this.engine = null;
    this.scumm = null;
    delete window.scumm;
    this.element.hidden = true;
    // Releases the editor behind it and hands focus back to the Play button.
    this.trap?.release();
    this.trap = null;
  }

  get isRunning(): boolean {
    return this.running;
  }
}
