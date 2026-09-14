import type { AdventureEngine, InputSurface } from './engine/AdventureEngine.js';
import { loadAdventureEngine } from './engine/loadEngine.js';
import type { DeclaredInterpreter } from './engine/agi/resource/agiDetect.js';
import {
  AGI_PLATFORMS,
  DECLARABLE_INTERPRETERS,
  DEFAULT_AGI_INTERPRETER,
  formatInterpreterVersion,
  type AgiPlatform,
} from './authoring/target.js';
import {
  FileListDataSource,
  HttpDataSource,
  type PathedFile,
} from './engine/resource/DataSource.js';
import { filesFromDropEntries, readDropEntries } from './ui/droppedFiles.js';
import type { DataSource } from './engine/resource/DataSource.js';
import { isZip, readZip } from './engine/resource/zip.js';
import { LoadProgressTracker, formatBytes, type LoadProgress } from './engine/resource/progress.js';
import { shouldStoreOriginals } from './editor/importOrigin.js';
import {
  putImportedProject,
  putImportedSource,
  isHandoffAvailable,
} from './editor/importedStorage.js';
import { createBusyOverlay } from './ui/busy.js';
import { createNotice } from './ui/notice.js';
import { createCredit } from './ui/credit.js';
import { mountConsent } from './ui/consent.js';
import { mountAccessibilityStatement } from './ui/accessibility.js';
import { SaveStore, SAVE_LOCATION_NOTE, listSavedGames } from './engine/save/SaveStore.js';
import { createSaveMenu, describeSavedGame, slotsFrom, type SavedGameView } from './ui/saveMenu.js';
import {
  describeEntry,
  entryBaseUrl,
  entrySubtitle,
  entryTitle,
  fetchEntryReadme,
  listGamesFolder,
  sourceFromGamesFolderEntry,
  type GamesFolderEntry,
} from './ui/gamesFolder.js';
import { createGameDetails } from './ui/gameDetails.js';
import { createReleases } from './ui/releases.js';
import { migrateLegacyStorage } from './ui/storageKeys.js';
import { playIcon } from './ui/icons.js';
import { announce } from './ui/a11y.js';

const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
const context = canvas.getContext('2d', { alpha: false })!;
const dropzone = document.querySelector<HTMLElement>('#dropzone')!;
const stage = document.querySelector<HTMLElement>('#stage')!;
const statusEl = document.querySelector<HTMLElement>('#status')!;
const fpsEl = document.querySelector<HTMLElement>('#fps')!;

/*
 * The credit row, filled in rather than written out.
 *
 * A row of its own under the status bar, and the editor's arrangement for the
 * same reason: the status text beside it is a sentence of unbounded length —
 * a load stage, a save note, a refusal — and at any real length it takes the
 * row and leaves the credit nowhere to be. Pinned to the bottom of the window
 * by `.creditbar`, so who made this and what is stored are readable without
 * scrolling to the end of the page.
 */
const creditBar = document.querySelector<HTMLElement>('#creditbar')!;
creditBar.appendChild(createCredit());
// Before anything reads a key: this build writes `mgi-web:…` and an earlier
// one wrote `scumm-web:…`, and the move happens once, at startup, rather than
// being a fallback every reader has to remember.
migrateLegacyStorage();
mountConsent(creditBar);
// Beside the cookie link, because it is the same kind of promise about the site
// and a reader looking for one will look where the other is.
mountAccessibilityStatement(creditBar);
const logEl = document.querySelector<HTMLPreElement>('#log')!;
const releasesButton = document.querySelector<HTMLButtonElement>('#releases-button')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause-button')!;
const soundToggle = document.querySelector<HTMLInputElement>('#sound-toggle')!;
const scaleSelect = document.querySelector<HTMLSelectElement>('#scale-select')!;
const progressEl = document.querySelector<HTMLElement>('#progress')!;
const editButton = document.querySelector<HTMLButtonElement>('#edit-game')!;
const busy = createBusyOverlay();
const notice = createNotice();
const gameDetails = createGameDetails();
const releases = createReleases();
const fullscreenButton = document.querySelector<HTMLButtonElement>('#fullscreen-button')!;
const progressFill = document.querySelector<HTMLElement>('#progress-fill')!;
const saveButton = document.querySelector<HTMLButtonElement>('#save-game')!;
const loadButton = document.querySelector<HTMLButtonElement>('#load-game')!;
/**
 * The show/hide toggle, which used to be called Load.
 *
 * Renamed rather than moved: it is the same control doing the same job, and the
 * name it had belonged to reading saves back. A player looking for their saved
 * games pressed "Load" and watched the file section vanish, which is the one
 * outcome that made the button look broken.
 */
const bootButton = document.querySelector<HTMLButtonElement>('#boot-game')!;
const saveMenu = createSaveMenu();

/**
 * The loaded game, as the shell sees it.
 *
 * An `AdventureEngine` rather than a `ScummEngine` (ADR 0011): everything below
 * is the app shell — loading, the games folder, progress, pause, fps, stall
 * detection, saving, the editor handoff — and none of it is SCUMM's business.
 */
let engine: AdventureEngine | null = null;
/**
 * The files the running game came from, and any interpreter version declared
 * for it.
 *
 * Kept because declaring a version means loading the game again: the arity
 * table it selects decides how every Logic decodes, so it has to be in hand
 * before the first resource is read rather than applied to an engine that has
 * already read them (ADR 0013).
 */
let loadedSource: DataSource | null = null;
let declaredInterpreter: DeclaredInterpreter | undefined;
let saves: SaveStore | null = null;

/**
 * The save store for a game, or null when this browser will not keep saves.
 *
 * Reading `localStorage` can throw outright — a private window, or site data
 * blocked — so it is probed here rather than at the first save, where the
 * failure would arrive as a lost save instead of a disabled button.
 */
function openSaveStore(gameId: string, formatCeiling: number): SaveStore | null {
  const storage = browserStorage();
  if (!storage) {
    setStatus('Saving is unavailable: this browser is not letting the page store data.');
    return null;
  }
  return new SaveStore(storage, gameId, formatCeiling);
}

/**
 * The browser's key/value store, or null when it will not have us.
 *
 * Probed with a read rather than assumed present: a private window and blocked
 * site data both throw on the *first touch* of `localStorage` rather than
 * returning null, so the failure has to be caught here — where it disables a
 * button — instead of at the first save, where it arrives as a lost game.
 *
 * Wanted by the Load menu as well as by a save store, and the Load menu has no
 * game to open a store for: it asks what this browser holds across every game,
 * which is a question about the storage itself.
 */
function browserStorage(): Storage | null {
  try {
    window.localStorage.getItem('mgi.probe');
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Where the running game came from, so a save can be named and found again.
 *
 * A `gameId` is `monkey2`; a menu listing games the player has not opened this
 * visit needs a title, and resuming one of them needs to know which folder the
 * files were in. Neither is anything the engine knows — both are facts about
 * how the shell was asked to load it — so they are carried here and written
 * beside the saves at save time.
 */
interface GameOrigin {
  title?: string;
  /** The games folder entry, or the `?game=` id, that this was loaded from. */
  sourceId?: string;
}

let loadedOrigin: GameOrigin = {};
/**
 * What the next load is coming from, set by whichever route is about to start.
 *
 * A field rather than an argument threaded through `startWithSource`, because
 * three routes reach it — the folder card, the file picker, a drop — and only
 * one of them knows anything worth carrying. The other two clear it by leaving
 * it empty, which is the honest answer for a pile of files nobody named.
 */
let nextOrigin: GameOrigin = {};

/**
 * A save waiting for its game to be opened.
 *
 * The Load menu lists every game this browser holds saves for, and most of them
 * are not loaded: game data is not kept between visits — it is far too big, and
 * this project never copies it anywhere — so a save for a game that is not
 * running and not in the games folder cannot be applied yet. Rather than refuse
 * the click, the intent is remembered and applied the moment those files
 * arrive, by whichever route brings them.
 */
let pendingRestore: { gameId: string; slot: number; title: string } | null = null;
let running = false;
let paused = false;
/** Verb the next room click applies; set by clicking the verb panel. */

/** Lines kept in the log panel. Older ones are dropped. */
const LOG_LIMIT = 500;
const logLines: string[] = [];

function log(message: string): void {
  logLines.push(message);
  // Capped because a chatty game would otherwise grow one DOM text node
  // without limit for as long as the tab is open.
  if (logLines.length > LOG_LIMIT) logLines.splice(0, logLines.length - LOG_LIMIT);
  logEl.textContent = `${logLines.join('\n')}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/**
 * The last thing announced, so the once-a-second refresh is not read aloud.
 *
 * The status line is rewritten every second with the same sentence — the room
 * the game is in, its frame rate's neighbour — and a live region would read
 * that sentence out sixty times a minute, burying every message that matters
 * under a message that has not changed.
 */
let lastAnnounced = '';

/**
 * Writes the status line, and says it once when it is news.
 *
 * 4.1.3, Status Messages: a load stage, a save, a refusal and "the game asked
 * to quit" all have to reach a screen reader without taking focus. They do it
 * through the shared polite region rather than by making this element live,
 * because this element is also the once-a-second heartbeat above.
 */
function setStatus(message: string, options: { announce?: boolean } = {}): void {
  statusEl.textContent = message;
  if (options.announce === false) return;
  if (message === lastAnnounced) return;
  lastAnnounced = message;
  announce(message);
}

// -------------------------------------------------------------- progress ---

/** Stage whose message was last written to the log, to log each stage once. */
let loggedStage = '';

/**
 * The engine's last reported activity, and whether to mirror it to the console.
 *
 * A freeze inside the engine means the page never repaints, so the log panel
 * below is frozen with it — but console lines written before the freeze survive
 * in DevTools. `?trace=1` turns that on; it is off by default because it is one
 * line per room change and costume.
 */
const tracing = new URLSearchParams(window.location.search).has('trace');

let lastActivity = 'idle';

/**
 * Shows what the loader is doing, in the status line and the bar beside it.
 *
 * Loading a game is several seconds of file reading, decryption and parsing.
 * Naming the current step is most of the value — a bar alone cannot tell a slow
 * disk from a stuck parse — so the message is the status text and the bar is
 * just the shape of it.
 */
function showProgress(update: LoadProgress): void {
  const percent = Math.round(update.fraction * 100);
  const measurable = update.stage !== 'reading-archive';
  // The number goes in the text, not only in the bar: it is the part a player
  // can read out, and the bar is 6px of colour with no label of its own.
  // Announced on a change of stage rather than on every percentage tick: a
  // screen reader reading "37%… 38%… 39%" says nothing a progress bar's own
  // value does not already say, and drowns the stage name that does.
  setStatus(measurable ? `${update.message} — ${percent}%` : update.message, {
    announce: update.stage !== loggedStage,
  });

  if (update.stage !== loggedStage) {
    loggedStage = update.stage;
    log(update.message);
  }

  // Harmless while the overlay is hidden, which is most of the time: it only
  // darkens the screen for the decompile, and this keeps its wording in step
  // with the status line rather than in a second place that can disagree.
  busy.setMessage(update.message);

  progressEl.hidden = false;
  // Unzipping cannot measure itself, so it sweeps rather than fills.
  progressEl.classList.toggle('indeterminate', !measurable);
  progressEl.setAttribute('aria-valuenow', String(percent));
  // What the bar means, not only what it measures — and the only thing there is
  // to say while a stage cannot measure itself.
  progressEl.setAttribute(
    'aria-valuetext',
    measurable ? `${update.message} — ${percent}%` : update.message,
  );
  progressEl.title = `${percent}%`;
  progressFill.style.width = `${percent}%`;
}

function hideProgress(): void {
  progressEl.hidden = true;
  progressEl.classList.remove('indeterminate');
  progressEl.setAttribute('aria-valuenow', '0');
  progressEl.removeAttribute('aria-valuetext');
  progressFill.style.width = '0%';
  loggedStage = '';
}

/**
 * How long the game may sit in one room before the script state is dumped.
 *
 * A game that is waiting for something the engine never provides looks exactly
 * like a game that is working: no error, no stall, scripts yielding politely
 * every frame. Ten seconds in the same room is not proof of a problem — a logo
 * screen or a long cutscene can legitimately hold — but it is the point where
 * knowing what the scripts are parked on is worth a line in the log.
 */
const ROOM_PATIENCE_MS = 10_000;

/** The room the game is in, and when it arrived there. */
let watchedRoom = -1;
let watchedRoomSince = 0;
/** The room a stall was last reported for, so each stall is reported once. */
let reportedStallRoom = -1;

/**
 * Logs what the scripts are waiting on when the game stops getting anywhere.
 *
 * Any room, not just the first one. Anchoring this on the room the game booted
 * into meant a game that advanced once and *then* wedged was never reported: the
 * room no longer matched, so the check returned early for the rest of the
 * session and the log stayed silent through exactly the failure it exists to
 * describe. Fate of Atlantis reaches its first playable room and stops there,
 * which is the shape this could not see.
 *
 * Once per room rather than once per session, so a game that stalls, is nudged
 * along and stalls again reports both.
 */
function reportNoProgress(): void {
  if (!engine) return;
  // Paused time is not the game failing to progress, and it would otherwise
  // accumulate into a report the moment play resumed.
  if (paused) {
    watchedRoomSince = performance.now();
    return;
  }

  const room = engine.currentRoom;
  if (room !== watchedRoom) {
    watchedRoom = room;
    watchedRoomSince = performance.now();
    return;
  }

  if (reportedStallRoom === room) return;
  if (performance.now() - watchedRoomSince < ROOM_PATIENCE_MS) return;

  // The engine gets the last word on whether standing still is a fault. An
  // unchanged room number is not evidence of one: an adventure game waits for
  // the player, and one family's opening room is literally room 0, so this
  // reported "Still in room 0" on a game that was drawing and taking clicks.
  // A family with nothing to complain about says so by answering nothing.
  const status = engine.describeStatus();
  if (status === undefined) {
    reportedStallRoom = room;
    return;
  }

  reportedStallRoom = room;
  log(`Still in room ${room} after ${Math.round(ROOM_PATIENCE_MS / 1000)}s.`);
  // What the engine says it is waiting on. Several lines rather than one,
  // because a stalled game and an empty-looking room are different complaints
  // and a player reporting one usually cannot tell which they have — but which
  // lines those are is the family's business, not the shell's.
  for (const line of engine.describeStall()) log(line);
}

/** Frames slower than this are worth naming, with what the engine was doing. */
const SLOW_FRAME_MS = 250;
let reportedSlowFrame = false;

/**
 * Names a frame that took long enough for the page to visibly stall.
 *
 * Reported once: a permanently slow game would otherwise fill the log with it,
 * and one line is enough to say where to look.
 */
function reportSlowFrame(elapsedMs: number): void {
  if (reportedSlowFrame || elapsedMs < SLOW_FRAME_MS) return;
  reportedSlowFrame = true;
  log(
    `A frame took ${Math.round(elapsedMs)} ms while ${lastActivity}. ` +
      `Reload with ?trace=1 to log every engine step to the browser console.`,
  );
  // **And what it was doing, which the engine already knows.** A slow frame
  // sent a reader to the trace — tens of thousands of lines — for an answer
  // the stall report gives in a dozen: which frames are on the stack, which
  // method each is in, and what the engine has and has not reached. That
  // report existed and this was the one place asking about a stall that did
  // not print it.
  for (const line of engine?.describeStall() ?? []) log(`  ${line}`);
}

/** "Running · monkey2 · SCUMM v5 · room 12 “bridge”" — the game is alive. */
function describeRunning(): string {
  if (!engine) return paused ? 'Paused' : 'Running';

  const parts = [paused ? 'Paused' : 'Running', engine.gameId, engine.targetName];
  const room = engine.currentRoom;
  const name = engine.roomName(room);
  parts.push(name ? `room ${room} “${name}”` : `room ${room}`);

  // Whatever the engine thinks is worth a player's attention — a stopped script
  // is the difference between "slow game" and "engine bug".
  const note = engine.describeStatus();
  if (note) parts.push(note);
  return parts.join(' · ');
}

// --------------------------------------------------------------- loading ---

/**
 * Turns whatever the user picked into a data source.
 *
 * A single `.zip` is unwrapped in the browser, since that is how games are
 * distributed and asking the user to extract it first is a step we can spare
 * them.
 */
async function sourceFromFiles(
  entries: (File | PathedFile)[],
  progress: LoadProgressTracker,
): Promise<DataSource> {
  const files = entries.map((entry) => ('file' in entry ? entry.file : entry));
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    // The signature first, and the file only if it is one (ADR 0021). A `.zip`
    // that is not a zip used to cost a whole read before anything looked at it,
    // and a zip has to be read whole anyway — its directory is at the end — so
    // this buys nothing for the archives and everything for the mis-named file
    // that would otherwise be buffered before being handed on unchanged.
    const signature = new Uint8Array(await files[0].slice(0, 8).arrayBuffer());
    if (isZip(signature)) {
      const bytes = new Uint8Array(await files[0].arrayBuffer());
      progress.report('reading-archive', `Unpacking ${files[0].name}…`, 0.5);
      await progress.yieldToUi();
      return readZip(bytes, files[0].name);
    }
  }
  progress.report('reading-archive', `Reading ${files.length} file(s)…`);
  return new FileListDataSource(entries, files[0]?.name ?? 'selected files');
}

/**
 * Shows either the game or the file section, never both.
 *
 * One function rather than two assignments at each call site, because the
 * title bar's Boot button reflects this and reads it back: setting the two
 * sections directly is how the button ends up claiming the opposite of what is
 * on screen.
 */
function showGame(showing: boolean): void {
  stage.hidden = !showing;
  dropzone.hidden = showing;
  bootButton.setAttribute('aria-pressed', String(showing));
  bootButton.title = showing
    ? 'Show the file section again'
    : 'Show the game, hiding the file section';
  // Which of the two halves of the page is on screen is not visible to anyone
  // who cannot see the page, and the button that swapped them is a toggle whose
  // label does not change.
  announce(showing ? 'Showing the game.' : 'Showing the file section.');
}

/** Whether the game is the section currently on screen. */
function gameIsShowing(): boolean {
  return !stage.hidden;
}

// Toggles between the two. Deliberately not disabled while no game is loaded:
// the stage is simply empty, and getting the file section back is the same
// click that hid it.
bootButton.addEventListener('click', () => showGame(!gameIsShowing()));

releasesButton.addEventListener('click', () => releases.show());

/** Puts a failed load back on the dropzone, saying why. */
function failLoad(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  hideProgress();
  setStatus(message.split('\n')[0]);
  log(message);
  showGame(false);
}

async function startWithSource(
  source: DataSource,
  progress = new LoadProgressTracker(showProgress),
): Promise<void> {
  running = false;
  // A declaration belongs to the game it was made for. Loading different files
  // clears it, or the version stated for King's Quest III would silently be
  // applied to the next game dropped on the page.
  if (source !== loadedSource) declaredInterpreter = undefined;
  loadedSource = source;
  // Claimed rather than copied: whatever route set this owns it for exactly one
  // load, and the next game to arrive by a route that names nothing must not
  // inherit the last one's title.
  loadedOrigin = nextOrigin;
  nextOrigin = {};

  try {
    engine = await loadAdventureEngine(source, {
      onLog: log,
      progress,
      declaredInterpreter,
      onActivity: (activity) => {
        lastActivity = activity;
        if (tracing) console.debug(`[scumm] ${activity}`);
      },
    });
  } catch (error) {
    failLoad(error);
    return;
  }

  if (tracing) window.scumm = engine;

  engine.sound.setEnabled(soundToggle.checked);

  // Started here, not on the first click *inside* the game. Whatever brought
  // the player to this point — the folder card's play button, the file picker,
  // a drop — was a gesture, which is all a browser asks for, and a game's
  // opening music is asked for before the player has any reason to click the
  // picture. Waiting meant the whole of an intro played silent.
  void engine.sound.resume();

  // Reported part-way through the stage: a full bar should mean playable, not
  // "about to run a script that may take a moment".
  progress.report('booting', 'Running the boot script…', 0.2);
  await progress.yieldToUi();

  try {
    const startedAt = performance.now();
    engine.boot();
    const bootMs = Math.round(performance.now() - startedAt);
    log(`Boot script finished in ${bootMs} ms`);
  } catch (error) {
    failLoad(error);
    return;
  }

  // The canvas is named for the game that is in it. "Game screen" is the right
  // name for an empty stage and the wrong one once Monkey Island is running:
  // the name is the only place a screen reader learns which game it reached.
  canvas.setAttribute('aria-label', `${engine.gameId} — ${engine.targetName} game screen`);
  stage.setAttribute('aria-label', `${engine.gameId} game screen`);

  // The file section goes away by itself once there is a game to show, whether
  // it came from the picker, a drop, a zip or the games folder — they all
  // arrive here.
  showGame(true);
  pauseButton.disabled = false;
  saves = openSaveStore(engine.gameId, engine.saveFormat);
  saveButton.disabled = saves === null;
  /*
   * The game's own way of asking to save, wired to the shell's own dialogs.
   *
   * Broken Sword II's system menu, Broken Sword's F5 and AGI's `save.game`
   * all end up here, and all three used to end nowhere: the engines carried
   * the request and nothing collected it. Set on every engine that offers the
   * seam rather than branching on which family this is — that is the whole
   * point of it being in `AdventureEngine` (ADR 0011).
   *
   * Left null when there is no store, because an engine that knows nobody is
   * listening says so in its own idiom: Broken Sword II greys the icon.
   */
  engine.onSaveRequested = saves ? (): void => void openSaveMenu() : null;
  engine.onRestoreRequested = (): void => void openLoadMenu();
  /*
   * A save chosen from the Load menu before its game had been opened.
   *
   * Applied here rather than by the route that opened it, because every route
   * lands here and only here knows the game booted — and applied *before* the
   * frame loop starts, so the first frame drawn is the restored room rather
   * than the game's opening one replaced a moment later.
   */
  let restored = false;
  if (pendingRestore && saves && pendingRestore.gameId === engine.gameId) {
    const waiting = pendingRestore;
    pendingRestore = null;
    restored = applyRestore(saves, waiting.slot, waiting.title);
  }
  // Whether this game can be edited is a property of its Target and is known
  // now, so it is said now — on the button itself. Finding out only after a
  // click has raised and dropped a spinner is what made a refusal look like a
  // button that does nothing (ADR 0013).
  editRefusal = engine.describeEditRefusal();
  editButton.disabled = !isHandoffAvailable();
  editButton.title = editRefusal
    ? 'This game cannot be edited — click to see why'
    : 'Decompile this game and open it in the editor';
  if (editRefusal) log(editRefusal);
  fullscreenButton.disabled = !stage.requestFullscreen;
  applyScale();

  // The engine's own input object, fed from device events by the shell. A
  // unified pointer/key pair was rejected on ADR 0007's grounds read the other
  // way: there is no model that holds both a verb bar and a typed parser
  // without becoming a bag of flags (ADR 0011).
  engine.input.attach(inputSurface);

  running = true;
  // Through the setter, so the title bar's button agrees. Assigning the flag
  // directly left a game loaded after a paused one running under a button that
  // still said "Resume" — and the save menu, which pauses while it is up, makes
  // that state far easier to arrive in.
  setPaused(false);
  watchedRoom = engine.currentRoom;
  watchedRoomSince = performance.now();
  reportedStallRoom = -1;
  progress.finish('Ready');
  // A full bar is worth a moment on screen: it tells the player the load
  // finished rather than the bar having been thrown away mid-way.
  setTimeout(() => {
    hideProgress();
    // Left alone after a restore: "Resumed from slot 3" is the answer to what
    // was just clicked, and replacing it a moment later with the ordinary
    // running line reads as the restore having been undone.
    if (running && !restored) setStatus(describeRunning());
  }, 400);

  requestAnimationFrame(frame);
}

/** Loads files the user picked, reporting from the first byte read. */
function startWithFiles(files: (File | PathedFile)[]): void {
  const progress = new LoadProgressTracker(showProgress);
  void sourceFromFiles(files, progress)
    .then((source) => startWithSource(source, progress))
    .catch(failLoad);
}

// ------------------------------------------------------ saving and loading --

/**
 * What to call the running game.
 *
 * The folder's own title when it came from one — a README says "The Secret of
 * Monkey Island" where the engine says `monkey` — and the id otherwise, which
 * is not a title but is at least the game's own name for itself.
 */
function currentGameTitle(): string {
  return loadedOrigin.title ?? engine?.gameId ?? 'This game';
}

/** "SCUMM v5 · room 12 “bridge”" — the line under the title in the save menu. */
function currentGameSubtitle(): string {
  if (!engine) return '';
  const room = engine.currentRoom;
  const name = engine.roomName(room);
  return `${engine.targetName} · ${name ? `room ${room} “${name}”` : `room ${room}`}`;
}

/** A room, said the way the status line says it, for a slot's default name. */
function describeCurrentRoom(): string {
  if (!engine) return 'a saved game';
  const name = engine.roomName(engine.currentRoom);
  return name ?? `room ${engine.currentRoom}`;
}

/**
 * Saving: pause, choose a slot, name it, write it, carry on.
 *
 * Paused for the whole of it, and put back exactly as it was found. A save menu
 * over a running game is a game still walking, still cutting scenes and still
 * moving the player somewhere else while they read the list — so the moment
 * they meant to save is not the moment that gets written. Restoring the
 * previous state rather than simply resuming matters for the player who paused
 * deliberately first: unpausing them would be the dialog undoing a decision it
 * was never asked about.
 */
async function openSaveMenu(): Promise<void> {
  if (!engine || !saves) return;

  const wasPaused = paused;
  setPaused(true);

  try {
    const chosen = await saveMenu.save({
      title: currentGameTitle(),
      subtitle: currentGameSubtitle(),
      suggestedName: describeCurrentRoom(),
      slots: slotsFrom(saves.list(), (room) => engine?.roomName(room)),
      note: SAVE_LOCATION_NOTE,
    });
    if (!chosen) return;

    try {
      saves.write(chosen.slot, engine.saveState(chosen.name));
      // Beside the save rather than inside it, so the Load menu can name this
      // game before any of its files have been opened again.
      saves.writeMeta({
        title: currentGameTitle(),
        targetName: engine.targetName,
        ...(loadedOrigin.sourceId ? { sourceId: loadedOrigin.sourceId } : {}),
      });
      setStatus(`Saved to slot ${chosen.slot}: “${chosen.name}”. ${engine.saveNote}`);
      announce(`Saved to slot ${chosen.slot}, ${chosen.name}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message.split('\n')[0]);
      // A failed save is the one thing here a player cannot discover for
      // themselves — the game carries on looking exactly as it did — so it is
      // said in a dialog rather than in a line at the bottom of the page.
      notice.show('The game could not be saved', message);
    }
  } finally {
    setPaused(wasPaused);
  }
}

saveButton.addEventListener('click', () => void openSaveMenu());

/**
 * Loading: which game, then which of its ten saves.
 *
 * Two steps, because the saves on a machine belong to several games and a flat
 * list of them mixes two games' room numbers into one column where neither
 * means anything.
 */
async function openLoadMenu(): Promise<void> {
  const storage = browserStorage();
  if (!storage) {
    notice.show(
      'Saved games are unavailable',
      'This browser is not letting the page store data, so there is nowhere for ' +
        'saved games to be kept or read from. A private window, or site data ' +
        'blocked for this site, are the usual reasons.',
    );
    return;
  }

  const games = listSavedGames(storage);
  if (games.length === 0) {
    notice.show(
      'No saved games yet',
      'Nothing has been saved in this browser. Open a game, play to somewhere ' +
        'worth coming back to, and press Save — you get ten slots per game, and ' +
        'they show up here.\n\n' +
        SAVE_LOCATION_NOTE,
    );
    return;
  }

  const wasPaused = paused;
  setPaused(true);

  const chosen = await saveMenu.load({
    games: games.map((game): SavedGameView => ({
      gameId: game.gameId,
      title: game.title,
      subtitle: describeSavedGame(game.targetName, game.saves.length),
      // The room names are the running game's to give, and this list spans
      // games that are not running: a number is what there is.
      slots: slotsFrom(game.saves),
    })),
    note: SAVE_LOCATION_NOTE,
  });

  if (!chosen) {
    setPaused(wasPaused);
    return;
  }

  const game = games.find((entry) => entry.gameId === chosen.gameId);
  if (!game) {
    setPaused(wasPaused);
    return;
  }

  // A restore resumes the game itself; anything else — a refused save, a game
  // whose files are not here yet — leaves whatever was running exactly as this
  // menu found it, rather than frozen behind a dialog it has dismissed.
  if (!(await resumeSave(game.gameId, game.title, game.sourceId, chosen.slot))) {
    setPaused(wasPaused);
  }
}

loadButton.addEventListener('click', () => void openLoadMenu());

/**
 * Puts a chosen save back into its game, fetching the game first if it must.
 *
 * Three cases, and they are genuinely different rather than three spellings of
 * one. The game may already be running, in which case the save goes straight
 * in. It may be one the games folder can supply, in which case it is loaded and
 * then the save goes in. Or it may be a game whose files this page has no way
 * to reach — dropped in from a folder on disk in some earlier visit — and then
 * the only honest answer is to say which game to open and to hold the intent
 * until it is opened.
 */
async function resumeSave(
  gameId: string,
  title: string,
  sourceId: string | undefined,
  slot: number,
): Promise<boolean> {
  if (engine && saves && engine.gameId === gameId) {
    return applyRestore(saves, slot, title);
  }

  if (sourceId) {
    // Remembered before the load starts, so the restore happens inside
    // `startWithSource` the moment the game is bootable — the same path the
    // "open the files yourself" case below goes down.
    pendingRestore = { gameId, slot, title };
    setStatus(`Loading ${title} to restore slot ${slot}…`);
    if (await startWithGameId(sourceId)) {
      // Restored inside the load, by the same path the case below waits for —
      // unless the files turned out to be a different game, in which case the
      // intent is still pending and the game is simply running.
      return pendingRestore === null;
    }

    pendingRestore = null;
    notice.show(
      `${title} could not be loaded`,
      `Slot ${slot} is still here, but the game's files are not: "${sourceId}" is ` +
        `no longer in the games folder, or is no longer readable.\n\n` +
        `Open ${title} again with "Open game folder…" or "Open files…" and the ` +
        `save will still be waiting.`,
    );
    return false;
  }

  pendingRestore = { gameId, slot, title };
  showGame(false);
  setStatus(`Open ${title} and slot ${slot} will be restored.`);
  notice.show(
    `Open ${title} to resume`,
    `Slot ${slot} is saved and ready, but the game's own files are not kept in ` +
      `your browser — they are far too big, and this interpreter never copies ` +
      `them anywhere.\n\n` +
      `Open ${title} with "Open game folder…", "Open files…" or by dropping its ` +
      `files on the page, and this save is restored as soon as it boots.`,
  );
  return false;
}

/**
 * Reads a slot and hands it to the running engine.
 *
 * Every refusal here is one the player has to be told about in words: a save
 * from a newer build reads as an empty slot, and a save the engine rejects is a
 * game that carries on exactly as it was. Both look, from the outside, like a
 * click that did nothing.
 */
function applyRestore(store: SaveStore, slot: number, title: string): boolean {
  if (!engine) return false;

  const saved = store.read(slot);
  if (!saved) {
    notice.show(
      `Slot ${slot} could not be read`,
      `The save in slot ${slot} of ${title} is either damaged or was written by a ` +
        `newer version of this interpreter than the one running now. Nothing has ` +
        `been changed — the game is exactly as it was.`,
    );
    return false;
  }

  try {
    engine.loadState(saved);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    notice.show(`Slot ${slot} was refused`, message);
    return false;
  }

  showGame(true);
  // Resumed rather than left paused: the click asked to carry on from here, and
  // a restored game sitting frozen looks like the restore failed.
  setPaused(false);
  setStatus(`Resumed ${title} from slot ${slot}: “${saved.name}”.`);
  announce(`Resumed from slot ${slot}, ${saved.name}.`);
  log(`Restored slot ${slot} of ${saved.gameId} — “${saved.name}”, room ${saved.room}.`);
  return true;
}

document.querySelector<HTMLButtonElement>('#pick-folder')!.addEventListener('click', () => {
  document.querySelector<HTMLInputElement>('#file-input')!.click();
});
document.querySelector<HTMLButtonElement>('#pick-files')!.addEventListener('click', () => {
  document.querySelector<HTMLInputElement>('#file-input-flat')!.click();
});

for (const id of ['#file-input', '#file-input-flat']) {
  document.querySelector<HTMLInputElement>(id)!.addEventListener('change', (event) => {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    startWithFiles([...input.files]);
  });
}

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragover');
  const transfer = event.dataTransfer;
  if (!transfer) return;

  // Read the items synchronously: a `DataTransferItemList` is emptied once the
  // event handler returns, so a walk that awaits first finds nothing.
  const entries = readDropEntries(transfer);
  const plainFiles = [...transfer.files];

  if (entries.length === 0) {
    // No entry API — every dropped item is whatever `files` holds, which is
    // right for loose files and is all there is to go on.
    if (plainFiles.length > 0) startWithFiles(plainFiles);
    return;
  }

  void (async () => {
    const progress = new LoadProgressTracker(showProgress);
    try {
      progress.report('reading-archive', 'Looking through the dropped folder…');
      const found = await filesFromDropEntries(entries);
      if (found.length === 0) {
        // A folder the browser would not let us walk. Said plainly, because the
        // alternative is the index-pair message about a file that is a folder.
        throw new Error(
          `Nothing readable was found in what was dropped. If that was a folder, ` +
            `use “Open game folder…” instead — some browsers only let a page read a ` +
            `dropped folder's contents through the picker.`,
        );
      }
      const source = await sourceFromFiles(found, progress);
      await startWithSource(source, progress);
    } catch (error) {
      failLoad(error);
    }
  })();
});

// -------------------------------------------------------- the games folder --

/**
 * What the dev server found in `games/`, so `?game=` can resolve against it.
 *
 * Fetched once. Empty in a static build, where there is no server to list a
 * directory and the file picker is the only route.
 */
let gamesFolderEntries: GamesFolderEntry[] = [];

/**
 * Lists the games folder under the drop zone, one button each.
 *
 * The drop zone stays exactly as it was. This is an addition for the case the
 * picker handles badly: game data is big — a talkie is thirteen megabytes — and
 * choosing it again on every reload is what stops you testing.
 */
async function showGamesFolder(): Promise<void> {
  const panel = document.querySelector<HTMLElement>('#games-folder')!;
  const list = document.querySelector<HTMLUListElement>('#games-folder-list')!;
  const note = document.querySelector<HTMLElement>('#games-folder-note')!;

  const listing = await listGamesFolder();
  gamesFolderEntries = listing.entries;

  if (listing.entries.length === 0) {
    panel.hidden = true;
    return;
  }

  list.replaceChildren();
  for (const entry of listing.entries) {
    const item = document.createElement('li');
    item.className = 'games-folder-item';
    const title = entryTitle(entry);

    // The row: what the game is. Clicking it opens the README rather than
    // loading anything, which is the click someone makes when they do not yet
    // know which release the folder holds.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'games-folder-entry';
    open.setAttribute('aria-haspopup', 'dialog');

    const name = document.createElement('span');
    name.className = 'games-folder-name';
    name.textContent = title;

    open.append(name);

    // What it runs on, from the README's second line. Beside the name rather
    // than in the line of detail with the file count, because "SCUMM v6" is
    // the part that says whether this game is on the version that has been
    // played end to end — and because it is the author's claim about the
    // folder, not something measured from it.
    if (entry.engine) {
      const engine = document.createElement('span');
      engine.className = 'games-folder-engine';
      engine.textContent = entry.engine;
      open.append(engine);
    }

    const detail = document.createElement('span');
    detail.className = 'games-folder-detail';
    detail.textContent = describeEntry(entry);

    open.append(detail);
    open.addEventListener('click', () => {
      gameDetails.show({
        title,
        subtitle: entrySubtitle(entry),
        ...(entry.engine ? { engine: entry.engine } : {}),
        base: entryBaseUrl(entry),
        readme: fetchEntryReadme(entry),
        onPlay: () => void startWithFolderEntry(entry),
      });
    });

    // The square beside it: load the game. Labelled with the game's name,
    // because "Play" repeated down a list says nothing on its own.
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'games-folder-play';
    play.setAttribute('aria-label', `Play ${title}`);
    play.title = `Play ${title}`;
    play.appendChild(playIcon());
    play.addEventListener('click', () => void startWithFolderEntry(entry));

    item.append(open, play);
    list.appendChild(item);
  }

  // Naming the path is what makes the feature discoverable: someone who wants
  // to add a game needs to know where, and the answer is a real path on their
  // own machine rather than a relative one they have to work out. The README
  // is said here for the same reason — nothing else on the page would tell you
  // that a file in the folder is what names the game in this list.
  note.textContent = listing.root
    ? `Read from ${listing.root}. Add a folder or a .zip there and reload. A README.md in a game's folder names it here, and opens when you click it.`
    : 'Add a folder or a .zip to the games folder and reload.';
  panel.hidden = false;
}

async function startWithFolderEntry(entry: GamesFolderEntry): Promise<void> {
  const progress = new LoadProgressTracker(showProgress);
  try {
    const source = await sourceFromGamesFolderEntry(entry, progress);
    // The one route that knows what the game is called and where it came from.
    // Both are written beside the first save this game gets, which is what lets
    // the Load menu name it and find it again in a later visit.
    nextOrigin = { title: entryTitle(entry), sourceId: entry.id };
    await startWithSource(source, progress);
  } catch (error) {
    failLoad(error);
  }
}

/**
 * Loads a game by the id the games folder or `?game=` knows it by.
 *
 * Both routes to a game the page can fetch for itself, in one place: the URL
 * parameter on load, and the Load menu resuming a save whose game is not
 * running. Answers whether it found anything, because the caller's next move
 * differs — a missing `?game=` is a log line, and a missing game under a save
 * the player just clicked is a dialog explaining where their save went.
 */
async function startWithGameId(id: string): Promise<boolean> {
  const progress = new LoadProgressTracker(showProgress);
  try {
    const fromFolder = gamesFolderEntries.find((entry) => entry.id === id);
    if (fromFolder) {
      const source = await sourceFromGamesFolderEntry(fromFolder, progress);
      nextOrigin = { title: entryTitle(fromFolder), sourceId: fromFolder.id };
      await startWithSource(source, progress);
      return true;
    }

    // The only route a static build has: there is no server there to list a
    // directory, so a game is named by a manifest under `public/games/<id>/`.
    progress.report('reading-archive', `Fetching the file list for "${id}"…`, 0.5);
    const source = await HttpDataSource.fromManifest(`games/${id}/`);
    nextOrigin = { sourceId: id };
    await startWithSource(source, progress);
    return true;
  } catch (error) {
    hideProgress();
    log(`Loading "${id}" failed: ${String(error)}`);
    return false;
  }
}

/**
 * Loads a game named by the URL, so a reload comes straight back to it.
 *
 * Resolved against the games folder's listing first, and against a
 * `manifest.json` under `public/games/<id>/` second — which is the only route a
 * static build has, there being no server there to list a directory.
 */
async function tryAutoLoad(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const game = params.get('game');
  if (!game) return;

  await startWithGameId(game);
}

// ------------------------------------------------------------- frame loop --

let lastFrameTime = 0;
let frameAccumulator = 0;
let fpsCounter = 0;
let fpsTime = 0;

/** One tick is a sixtieth of a second, which is the unit every game counts in. */
const TICK_MS = 1000 / 60;

function frame(now: number): void {
  if (!running || !engine) return;

  if (lastFrameTime === 0) lastFrameTime = now;
  const elapsed = Math.min(250, now - lastFrameTime);
  lastFrameTime = now;

  if (!paused) {
    frameAccumulator += elapsed;
    // Cap catch-up so a backgrounded tab does not run hundreds of steps at
    // once when it regains focus.
    let steps = 0;
    const startedAt = performance.now();
    // The interval is the game's, not the shell's, and it is read again every
    // time round: a game changes its own cycle rate, and a cutscene often runs
    // at a different one from the room it interrupts.
    for (let stepMs = engine.ticksPerStep * TICK_MS; frameAccumulator >= stepMs;) {
      engine.step();
      frameAccumulator -= stepMs;
      if (++steps >= 4) break;
      stepMs = engine.ticksPerStep * TICK_MS;
    }
    reportSlowFrame(performance.now() - startedAt);
    engine.render();
    engine.present(context);
  }

  fpsCounter++;
  if (now - fpsTime >= 1000) {
    fpsEl.textContent = `${fpsCounter} fps · frame ${engine.frame}`;
    fpsCounter = 0;
    fpsTime = now;
    // Refreshed once a second so the room the game moved to is visible without
    // opening the log.
    if (progressEl.hidden) setStatus(describeRunning(), { announce: false });
    reportNoProgress();
  }

  if (engine.hasQuit) {
    running = false;
    setStatus('The game asked to quit.');
    return;
  }

  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ input --

/**
 * Where the engine's input object finds the screen, and nothing more.
 *
 * The shell owns the canvas and knows how it is scaled; the engine owns what a
 * click or a keystroke *means*. This is the whole of what crosses between them,
 * which is why the verb-bar hit test and `VAR.CUTSCENEEXIT_KEY` are in
 * `ScummInput` rather than here (ADR 0011).
 */
const inputSurface: InputSurface = {
  canvas,
  // The window, so a keystroke reaches the game without the canvas having to
  // hold focus.
  keys: window,
  // Somewhere a family may mount its own DOM. AGI needs it for the visually
  // hidden `<input>` that owns the Parser input line's text; SCUMM mounts
  // nothing and this stays empty.
  overlay: stage,
  toScreen(client) {
    const rect = canvas.getBoundingClientRect();
    return {
      // Through the *script* space, not the display one (#213). A SCI2 game
      // draws at 640x480 and thinks at 320x200, so a click mapped through the
      // display size lands at twice the coordinate the scripts test against —
      // which misses every hotspot without anything reporting a fault.
      x: Math.floor(((client.clientX - rect.left) / rect.width) * scriptSize().width),
      y: Math.floor(((client.clientY - rect.top) / rect.height) * scriptSize().height),
    };
  },
  resumeSound() {
    // Here rather than in each engine's handlers: browsers only allow the audio
    // context to start from a user gesture, and every gesture arrives through
    // this surface whichever family is listening.
    void engine?.sound.resume();
  },
};

// ---------------------------------------------------------------- controls --

/**
 * Pauses or resumes, and keeps the button telling the truth about it.
 *
 * One function rather than an assignment at each call site, because the save
 * menu pauses too: three places setting `paused` directly is how the flag ends
 * up saying one thing while the button in the title bar says the other.
 *
 * Quiet when nothing changes — opening the save menu over an already-paused
 * game must not announce "Paused" to someone who paused it themselves a minute
 * ago.
 */
function setPaused(next: boolean): void {
  if (paused === next) return;
  paused = next;
  pauseButton.textContent = paused ? 'Resume' : 'Pause';
  // The label already changes, so the state is not carried by `aria-pressed`
  // as well — a button that is both "Resume" and "pressed" reads as two
  // contradictory facts. What is announced is what happened.
  announce(paused ? 'Paused.' : 'Resumed.');
  setStatus(describeRunning(), { announce: false });
}

pauseButton.addEventListener('click', () => setPaused(!paused));

/**
 * Decompiles the loaded game and hands it to the editor.
 *
 * Runs here rather than in the editor because this is where the game data
 * already is: the editor would otherwise need its own loader, its own file
 * picker and its own copy of the resource layer.
 *
 * The work is synchronous and takes seconds on a full-size game, so the room
 * loop yields to let the progress bar move — the same reason loading does.
 */
/** Why the loaded game may not be edited, asked once when it loads. */
let editRefusal: string | null = null;

/**
 * Offers to take the interpreter version from the person instead of the game.
 *
 * ADR 0013 refuses to edit on a version the engine *guessed*. A version the
 * author *states* is a different thing and is recorded as one: many dumps in
 * circulation carry only the resources and no interpreter at all, so for those
 * there is no evidence to read and never will be, and without this they are
 * permanently uneditable however much their owner knows about them.
 *
 * Accepting reloads the game rather than re-targeting the running one, because
 * the arity table the version selects decides how every Logic decodes — an
 * engine that has already read them under the assumed table would be carrying
 * exactly the misreading the ADR is about.
 *
 * **It is offered to AGI and to nothing else**, and it used to be offered to
 * every family. ADR 0013's route exists because an AGI dump can be missing the
 * evidence entirely; ADR 0029 records that AGOS deliberately has no such route,
 * "because an AGOS game's bytes say which game they are, so a declaration would
 * only let someone assert past a check that can actually be run". Showing an
 * AGOS owner a list of Sierra interpreter builds asked them to answer a
 * question about the wrong engine, and the honest answer to it was that no
 * choice on the list could have helped.
 */
async function offerToDeclareInterpreter(refusal: string): Promise<void> {
  if (!loadedSource || !engine?.editRefusalIsDeclarable) {
    notice.show('This game cannot be edited', refusal);
    return;
  }

  const answer = await notice.ask(
    'This game cannot be edited',
    `${refusal}\n\nIf you know which interpreter this release shipped with, you can say so ` +
      `and edit on that. It is recorded in the project as declared rather than read, so a ` +
      `wrong answer here is visible afterwards — but it is still a wrong answer, and every ` +
      `Logic will be decoded with the table you pick.`,
    [
      {
        name: 'interpreter',
        label: 'Interpreter',
        options: DECLARABLE_INTERPRETERS.map((version) => ({
          value: String(version),
          label: formatInterpreterVersion(version),
        })),
        // Starts on the build that was assumed, so the control opens showing
        // what is already in force rather than an unrelated default.
        value: String(DEFAULT_AGI_INTERPRETER),
      },
      {
        name: 'platform',
        label: 'Platform',
        options: AGI_PLATFORMS.map((platform) => ({ value: platform, label: platform })),
        value: 'dos',
      },
    ],
    'Use this version',
  );
  if (!answer) return;

  declaredInterpreter = {
    interpreter: Number(answer.interpreter),
    platform: answer.platform as AgiPlatform,
  };
  log(
    `Reloading with interpreter ${formatInterpreterVersion(declaredInterpreter.interpreter)} on ` +
      `${declaredInterpreter.platform}, declared rather than read from the game.`,
  );
  await startWithSource(loadedSource);
}

async function editLoadedGame(): Promise<void> {
  if (!engine) return;

  // Refused before any work starts. The reason is several paragraphs — what
  // would go wrong, and which file would settle it — so it goes to a notice the
  // reader dismisses rather than to a status line that shows its first clause.
  if (editRefusal) {
    log(editRefusal);
    await offerToDeclareInterpreter(editRefusal);
    return;
  }

  const wasPaused = paused;
  paused = true;
  editButton.disabled = true;
  busy.show(
    'Decompiling the game…',
    'This takes a few seconds on a full-size game. The page cannot respond while it runs.',
  );

  const progress = new LoadProgressTracker(showProgress);
  try {
    progress.report('parsing-container', 'Decompiling the game…', 0);
    await progress.yieldToUi();

    // The engine decompiles its own resources — it is the half that knows the
    // format — and the shell stores the result, which is the half that knows
    // where a handoff is kept. Splitting it there keeps `src/engine` from
    // importing the editor's storage, which would be the coupling the wrong way
    // round (ADR 0011).
    const editable = await engine.toEditableGame({
      progress,
      onProgress: (doneRooms, totalRooms, what) => {
        progress.report(
          'parsing-container',
          `Decompiling ${what} (${doneRooms + 1} of ${totalRooms})`,
          totalRooms === 0 ? 1 : doneRooms / totalRooms,
        );
      },
    });

    if (!editable) {
      throw new Error('This game cannot be opened in the editor.');
    }

    progress.report('preparing', 'Saving the project for the editor…');
    await progress.yieldToUi();

    await putImportedProject(editable.project);

    // The project describes what an author can change; the originals are what
    // an export rewrites, and everything the project cannot describe lives only
    // in them. Above the threshold they are not stored at all: an edited Full
    // Throttle would want roughly two copies of a CD in IndexedDB, and quota is
    // a browser policy rather than a machine specification. Export asks for the
    // folder again instead (ADR 0010).
    const originals = editable.originals;
    const sourceBytes = originals
      ? originals.index.length +
        originals.dataFiles.reduce((total, file) => total + file.data.length, 0)
      : 0;
    if (originals && shouldStoreOriginals(sourceBytes)) {
      await putImportedSource(originals);
    } else if (originals) {
      log(
        `${formatBytes(sourceBytes)} of game files is too much to keep a second copy ` +
          `of in the browser, so they have not been stored. Exporting your edits will ` +
          `ask for the game's folder again.`,
      );
    }

    for (const note of editable.notes) log(note);
    log(
      `Decompiled ${editable.project.rooms.length} rooms and ` +
        `${editable.project.actors.length} costumes into an editable project.`,
    );

    // Left up on the way out: the editor is a fresh page load with a project to
    // rebuild, and a screen that brightened here only to go blank there would
    // read as the click having failed at the last moment.
    progress.finish('Opening the editor…');
    window.location.href = './editor.html?imported=1';
  } catch (error) {
    busy.hide();
    hideProgress();
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`Could not decompile: ${message.split('\n')[0]}`);
    log(`Decompiling failed: ${message}`);
    // Shown, not merely logged: this is the answer to a click, and a click
    // whose answer is only in a scrolled panel is a click that did nothing.
    notice.show('Could not decompile this game', message);
    editButton.disabled = false;
    paused = wasPaused;
  }
}

editButton.addEventListener('click', () => void editLoadedGame());

soundToggle.addEventListener('change', () => {
  engine?.sound.setEnabled(soundToggle.checked);
  if (soundToggle.checked) void engine?.sound.resume();
});

scaleSelect.addEventListener('change', applyScale);
window.addEventListener('resize', applyScale);

function isFullscreen(): boolean {
  return document.fullscreenElement === stage;
}

/**
 * The size to make the picture, and the size to think in.
 *
 * Both come from the loaded game (ADR 0015). The fallback is the size every
 * Version before SCI ran at, which is what the canvas is marked up as and what
 * an empty stage should stay — a shell with no game has no display to size.
 */
const DEFAULT_RESOLUTION = { width: 320, height: 200 };

function displaySize(): { width: number; height: number } {
  return engine?.resolution.display ?? DEFAULT_RESOLUTION;
}

function scriptSize(): { width: number; height: number } {
  return engine?.resolution.script ?? DEFAULT_RESOLUTION;
}

/**
 * Sizes the canvas: a fixed integer multiple, or the largest that fits.
 *
 * Fullscreen always fits, whatever the scale box says. Someone who asked for
 * the whole screen wants the picture to fill it, not a 2x window centred in
 * black — and the scale they picked for a window is still there when they come
 * back out.
 */
function applyScale(): void {
  const display = displaySize();
  // The canvas' own backing store is the display space, so a game that
  // composites 640x480 gets 640x480 pixels rather than a 320x200 picture
  // stretched over them. Set here rather than in the markup because it is the
  // loaded game that knows, and it changes when a different one is loaded.
  if (canvas.width !== display.width) canvas.width = display.width;
  if (canvas.height !== display.height) canvas.height = display.height;

  const full = isFullscreen();
  const requested = full ? 0 : Number(scaleSelect.value);
  let scale = requested;

  if (requested === 0) {
    const available = stage.getBoundingClientRect();
    // No margin in fullscreen: the black around the picture is the letterbox
    // the aspect ratio demands, not padding.
    const margin = full ? 0 : 32;
    const byWidth = (available.width - margin) / display.width;
    const byHeight = (available.height - margin) / display.height;
    scale = Math.max(1, Math.min(byWidth, byHeight));
  }

  canvas.style.width = `${display.width * scale}px`;
  canvas.style.height = `${display.height * scale}px`;
}

/**
 * Fills the screen with the game.
 *
 * The stage goes fullscreen rather than the canvas itself, so the browser
 * letterboxes against the stage's background instead of stretching the canvas
 * to the screen's aspect ratio and distorting 320x200 art.
 */
async function toggleFullscreen(): Promise<void> {
  try {
    if (isFullscreen()) await document.exitFullscreen();
    else await stage.requestFullscreen();
  } catch (error) {
    // Refused by the browser — no user gesture, or a permissions policy. There
    // is nothing to retry, so say so rather than leaving the button dead.
    setStatus(`Fullscreen was refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}

fullscreenButton.addEventListener('click', () => void toggleFullscreen());

document.addEventListener('fullscreenchange', () => {
  fullscreenButton.textContent = isFullscreen() ? 'Leave fullscreen' : 'Fullscreen';
  fullscreenButton.setAttribute('aria-pressed', String(isFullscreen()));
  // The stage only becomes screen-sized once the change has happened, so the
  // canvas is resized here rather than when the request was made.
  applyScale();
});

// The listing is fetched first, so `?game=` can name a folder entry rather than
// only a `public/games/<id>/` with a manifest.
void showGamesFolder().then(() => tryAutoLoad());
