import { containsCode } from '../authoring/actions.js';
import { defaultPalette, paletteChoices } from '../authoring/palette.js';
import { boxBounds, isConvexBox } from '../authoring/GameBuilder.js';
import {
  ACTOR_ID_LIMIT,
  definedFacings,
  migrate,
  poseCels,
  POSE_DIRECTIONS,
  type PoseFacing,
  type Project,
} from '../authoring/project.js';
import { buildProject } from '../authoring/projectToGame.js';
import { describeTarget } from '../authoring/target.js';
import { ActionEditor, numberField, selectField, textField } from './ActionEditor.js';
import { canSaveInPlace, type DirectoryHandleLike } from './files.js';
import { PlayOverlay } from './PlayOverlay.js';
import { RoomCanvas, type Tool } from './RoomCanvas.js';
import { COSTUME_COLORS, SPRITE_FRAMES, SpriteCanvas } from './SpriteCanvas.js';
import { ObjectArtCanvas } from './ObjectArtCanvas.js';
import { importCostumeCel, importImage, pickImageFile, type FitMode } from './importImage.js';
import { TRANSPARENT_INDEX } from '../authoring/ImageEncoder.js';
import { storeImage } from '../authoring/imageCodec.js';
import { chooseFolder, exportGameOnly, exportProjectOnly, save, type SaveOptions } from './save.js';
import { createCredit } from '../ui/credit.js';
import { AgiEditor } from './agi/AgiEditor.js';
import { AgosEditor } from './agos/AgosEditor.js';
import { openAgosGameFolder, type AgosGameFolder } from './agos/resupply.js';
import { agosAudioReader } from './agos/audioResources.js';
import { openSword1GameFolder, type Sword1GameFolder } from './sword1/resupply.js';
import { sword1AudioReader } from './sword1/audioResources.js';
import { openSword2GameFolder, type Sword2GameFolder } from './sword2/resupply.js';
import { sword2AudioReader } from './sword2/audioResources.js';
import { sword2AudioReplacements } from './sword2/audioExport.js';
import type { Sword2SoundReplacement } from '../authoring/sword2/soundContainer.js';
import { setAudioResourceReader } from './audioBytes.js';
import { exportAgosFiles } from './agos/exportAgos.js';
import { exportSciGame } from '../authoring/sci/exportSciGame.js';
import { packSciGame } from '../authoring/sci/packSciGame.js';
import { loadAdventureEngine } from '../engine/loadEngine.js';
import { agosPreviewSource } from './agos/previewSource.js';
import { overlaySource } from '../engine/resource/overlaySource.js';
import { exportSword1Game, type Sword1ExportSource } from '../authoring/sword1/export.js';
import { sword1AudioReplacements } from './sword1/audioExport.js';
import { exportSword2Game } from '../authoring/sword2/export.js';
import { stringsOf } from './agos/gamePc.js';
import { SciEditor } from './sci/SciEditor.js';
import { carriedVolumes, openSciGameFolder, type SciGameFolder } from './sci/resupply.js';
import { sciAudioReader } from './sci/audioResources.js';
import { SkyEditor } from './sky/SkyEditor.js';
import { LureEditor } from './lure/LureEditor.js';
import { Sword1Editor } from './sword1/Sword1Editor.js';
import { Sword2Editor } from './sword2/Sword2Editor.js';
import { mountConsent } from '../ui/consent.js';
import { mountAccessibilityStatement } from '../ui/accessibility.js';
import { migrateLegacyStorage, STORAGE_KEYS } from '../ui/storageKeys.js';
import { EditorState } from './state.js';
import { exportObjectState, exportRoomBackground, exportSpriteCel } from './imageExport.js';
import { getAutosave, takeImportedProject } from './importedStorage.js';
import { playableStart } from './playFrom.js';
import { loadLocal } from './storage.js';
import { hasUnexportedChanges, isStorageAvailable } from './storage.js';
import { announce, describeColour } from '../ui/a11y.js';
import { groupItem, rovingGroup } from './a11yWidgets.js';
import { accordion, listRow, OpenSections } from './shell.js';
import { AudioSection } from './audioSection.js';
import { alert as showAlert, confirm as showConfirm } from './dialog.js';

// Before anything below reads a key: this build writes `mgi-web:…` where an
// earlier one wrote `scumm-web:…`, and the move happens once, here, rather
// than being a fallback every reader has to remember.
migrateLegacyStorage();

const state = new EditorState();

/**
 * A game decompiled in the player arrives through IndexedDB.
 *
 * Asynchronously, because that is the only way IndexedDB comes: the editor
 * opens on whatever it had, and the import replaces it a moment later. A
 * project too big for local storage also autosaves there, so it is the second
 * place to look when local storage has nothing.
 */
void (async () => {
  try {
    const imported = await takeImportedProject();
    if (imported) {
      state.replaceProject(imported);
      showImportSummary(imported);
      return;
    }
    if (!loadLocal()) {
      const large = await getAutosave();
      if (large) state.replaceProject(large);
    }
  } finally {
    dismissBootOverlay();
  }
})();

/**
 * Removes the spinner `editor.html` shows while this page is arriving.
 *
 * In a `finally`, because the point of the overlay is to cover the wait and an
 * import that fails still ends it — a spinner left turning over a working
 * editor would be a worse lie than no spinner at all.
 */
function dismissBootOverlay(): void {
  document.getElementById('boot-busy')?.remove();

  // The flag has been acted on, so it is dropped from the address bar: left
  // there, a later reload of the editor would raise a spinner for an import
  // that already happened.
  const url = new URL(window.location.href);
  if (url.searchParams.has('imported')) {
    url.searchParams.delete('imported');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
}
const canvas = new RoomCanvas(state);
const sprite = new SpriteCanvas(state);
const objectArt = new ObjectArtCanvas(state);

/** Which editor the centre column shows. */
type Mode = 'room' | 'sprite' | 'object';
let mode: Mode = 'room';

/** Import settings, remembered between imports. */
let importDither = true;
let importFit: FitMode = 'contain';
const play = new PlayOverlay();
const palette = defaultPalette();

/**
 * Whether custom code actions may be compiled.
 *
 * A project the author built in this browser is theirs, so code is enabled. An
 * imported file is data from elsewhere, and data must not execute because it
 * was opened — importing one containing code asks first.
 */
let allowCode = true;

let folder: DirectoryHandleLike | null = null;

const root = document.querySelector<HTMLDivElement>('#editor')!;

// ------------------------------------------------------------------ layout --

/*
 * The editor's chrome, and its landmarks.
 *
 * The structure was right for CSS and wrong for anything reading the page: two
 * `<footer>` elements both claim `contentinfo`, an `<aside>` with no name is an
 * unnamed complementary region, and there was no `<main>` at all — so "skip to
 * the content" had nowhere to go. The tags below are the same boxes with the
 * roles they were already playing.
 */
const header = document.createElement('header');
header.className = 'topbar';
header.setAttribute('role', 'banner');
const main = document.createElement('div');
main.className = 'workspace';
const sidebar = document.createElement('aside');
sidebar.className = 'sidebar';
sidebar.setAttribute('aria-label', 'Project contents');
const centre = document.createElement('main');
centre.className = 'centre';
centre.id = 'editor-canvas-area';
// The skip link's target, so focus lands here rather than only the scroll.
centre.tabIndex = -1;
centre.setAttribute('aria-label', 'Editing area');
const inspector = document.createElement('aside');
inspector.className = 'inspector';
inspector.setAttribute('aria-label', 'Properties');
// A region rather than a second `contentinfo`: the credit bar below is the
// page's one of those, and the counts and autosave state here are a status.
const statusBar = document.createElement('div');
statusBar.className = 'statusbar';
statusBar.setAttribute('role', 'region');
statusBar.setAttribute('aria-label', 'Project status');

/*
 * The credit and the storage notice sit on a bar of their own, below the
 * status bar. They are not about the project, and the status text beside them
 * is a sentence of unbounded length — a room count, an autosave state, a
 * compile error — which on any real project takes the whole row and leaves
 * them nowhere to be. Their own row is also built once rather than on every
 * status render, because neither of them ever changes.
 */
const creditBar = document.createElement('footer');
creditBar.className = 'creditbar';
creditBar.appendChild(createCredit());
mountConsent(creditBar);
mountAccessibilityStatement(creditBar);

main.append(sidebar, centre, inspector);
root.append(header, main, statusBar, creditBar, play.element);

/**
 * The AGI editing surface, mounted instead of the SCUMM one for an AGI project.
 *
 * **This is the one place the editor branches on Engine family** (#134), and it
 * is a whole-surface swap rather than a mode. An AGI project has no actors, no
 * verbs, no walk boxes and no `Action`s; a SCUMM project has no Logic. Sharing
 * a surface between them would mean a panel per family behind a flag, and the
 * flag would spread — which is the shape ADR 0013 rejects one level down when
 * it refuses two ways of holding behaviour inside one project.
 *
 * Created lazily, because a SCUMM session should not pay for the AGI decompiler
 * being in the bundle at all.
 */
let agiEditor: AgiEditor | null = null;
let sciEditor: SciEditor | null = null;
let agosEditor: AgosEditor | null = null;
let skyEditor: SkyEditor | null = null;
let lureEditor: LureEditor | null = null;
let sword1Editor: Sword1Editor | null = null;
let sword2Editor: Sword2Editor | null = null;

/**
 * The non-SCUMM surface for this project, or null when it is a SCUMM one.
 *
 * **The one place the editor branches on Engine family** (#134), and it is a
 * `switch` on the Target rather than a chain of predicates so that adding a
 * third family adds a case here and nothing anywhere else. It grew a second arm
 * for SCI, which is exactly the moment a chain of `isAgiProject()`-shaped
 * questions would have started spreading through `renderAll`.
 */
interface FamilySurface {
  /** Draws the surface into whichever panes it uses. */
  mount: () => void;
  /**
   * What the status bar says this project holds, in this family's own nouns.
   *
   * Here rather than in `renderStatus`, so the one branch on Engine family
   * stays one branch. It also fixes a standing falsehood: the status line asked
   * the SCUMM builder for its counts, and the SCUMM builder answers a non-SCUMM
   * project with a refusal — so every AGOS session ran with a warning triangle
   * and a sentence about emitting SCUMM v5 resources permanently on screen,
   * describing a build nobody had asked for.
   */
  describe: () => string;
  /**
   * Runs this family's game, when the editor can build one.
   *
   * On the record rather than as a branch inside `doPlay`, because the branch
   * on Engine family is allowed to happen exactly once and this is that once.
   * Absent for a family whose export path is not built, and Play then says so
   * by name rather than starting something else.
   */
  play?: () => Promise<string[]>;
}

function familySurface(): FamilySurface | null {
  switch (state.current.target.engine) {
    case 'agi':
      return { mount: mountAgiSurface, describe: describeAgi };
    case 'sci':
      return { mount: mountSciSurface, describe: describeSci, play: playSci };
    case 'agos':
      return { mount: mountAgosSurface, describe: describeAgos, play: playAgos };
    case 'sky':
      return { mount: mountSkySurface, describe: () => 'Sky project' };
    case 'lure':
      return { mount: mountLureSurface, describe: () => 'Lure project' };
    case 'sword1':
      return { mount: mountSword1Surface, describe: describeSword1, play: playSword1 };
    case 'sword2':
      return { mount: mountSword2Surface, describe: describeSword2, play: playSword2 };
    default:
      return null;
  }
}

/** Items, strings and Subroutines: what an AGOS project is made of (ADR 0029). */
function describeAgos(): string {
  const agos = state.current.agos;
  if (!agos) return 'AGOS project';
  const strings = agos.textBase64 ? stringsOf(agos).length : 0;
  const painted = agos.paintedImages?.length ?? 0;
  const parts = [
    `${agos.items.length} items`,
    `${strings} strings`,
    `${agos.subroutines.subroutines.length} subroutines`,
  ];
  if (agos.art) parts.push(`${agos.art.zones.length} zones`);
  if (painted > 0) parts.push(`${painted} painted`);
  return parts.join(' · ');
}

function describeAgi(): string {
  const agi = state.current.agi;
  if (!agi) return 'AGI project';
  return `${agi.logics.length} logics · ${agi.pictures.length} pictures`;
}

function describeSci(): string {
  const sci = state.current.sci;
  if (!sci) return 'SCI project';
  return `${sci.classes.length} classes · ${sci.scripts.length} scripts`;
}

/**
 * The Sky editing surface, the fifth arm of that one branch.
 *
 * A Sky project holds a Compact table and a text surface (ADR 0025), and neither
 * is a SCUMM `Action`, an AGI Logic, a SCI class or an AGOS item tree — so this
 * is the same whole-surface swap the others are. Created lazily, like its
 * siblings: a SCUMM session should not pay for it.
 */
/**
 * Empties the panes a family surface does not fill.
 *
 * The whole SCUMM surface — tabs, sidebar, canvases, inspector — is about
 * rooms, actors and verbs, which most of the other families do not have.
 * Rendering it over one of their projects would show a dozen panels of nothing.
 *
 * Called by the surfaces that use the middle pane only, rather than by
 * `renderAll` for everybody, and that is not tidiness: emptying a pane a
 * surface *does* fill would detach its contents on every render, which takes
 * focus off whatever was in it and puts the scroll position back to the top.
 */
function clearSidePanes(): void {
  sidebar.replaceChildren();
  inspector.replaceChildren();
}

function mountSkySurface(): void {
  clearSidePanes();
  skyEditor ??= new SkyEditor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
  });
  if (skyEditor.element.parentElement !== centre) {
    centre.replaceChildren(skyEditor.element);
  }
  skyEditor.render();
}

/**
 * The AGOS editing surface, the third arm of that one branch.
 *
 * An AGOS project holds Subroutines as instruction lists, an item tree and a
 * pool of shared strings (ADR 0029). None of those is a SCUMM `Action`, an AGI
 * Logic or a SCI class, so this is the same whole-surface swap the other two
 * are rather than a mode inside either.
 *
 * Created lazily like its siblings: a SCUMM session should not pay for it.
 */
function mountAgosSurface(): void {
  agosEditor ??= new AgosEditor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
    // All three panes, not just the middle one. The sidebar, the tabs and the
    // properties pane are how *this editor* works rather than facts about
    // rooms and actors, so an AGOS project gets them too — see the surface's
    // own note for what each holds.
    sidebar,
    inspector,
    audio,
    readZonePixels: (zone) => agosFolder?.readZonePixels(zone),
    readZoneScripts: (zone) => agosFolder?.readZoneScripts(zone),
    // An item's picture, on the same terms as its rooms' (ADR 0034): read out
    // of the folder rather than carried, and absent for the games that ship no
    // such file at all.
    readIconFile: () => agosFolder?.icons ?? null,
    // Read live rather than passed once: this folder is also the one an export
    // re-supplies, so one opened elsewhere in the shell has to show up in the
    // editor's folder bar without the editor being told.
    folderName: () => agosFolder?.name ?? null,
    openGameFolder: async () => {
      const result = await openAgosGameFolder(state.current);
      if (typeof result === 'string') return result;
      agosFolder = result;
      // The Audio section's rows are numbers until something can turn one back
      // into bytes, and this folder is that something (ADR 0034). Re-made per
      // folder rather than pointed at a variable, so the reader's cache of a
      // seventy-megabyte speech file cannot outlive the folder it came from.
      setAudioResourceReader(agosAudioReader(result));
      renderStatus();
      // Both halves: the pixels are the picture and the scripts hold the
      // palette banks, so a surface given only the first can draw a game's art
      // only in greys.
      return {
        pixels: result.readZonePixels,
        scripts: result.readZoneScripts,
        name: result.name,
        icons: result.icons,
      };
    },
  });
  if (agosEditor.element.parentElement !== centre) {
    centre.replaceChildren(agosEditor.element);
  }
  agosEditor.render();
}

/**
 * The game folder an author re-supplied this session (ADR 0034).
 *
 * Session-scoped and deliberately not persisted: a directory handle is not
 * serialisable, and storing the bytes it leads to is the thing ADR 0010's
 * threshold refuses. Losing it on reload costs one gesture; keeping a copy of
 * a talkie's archive in IndexedDB costs the quota.
 */
let agosFolder: AgosGameFolder | null = null;

/**
 * The same, for the two Broken Sword families.
 *
 * Three variables rather than one, because they hold three different things —
 * a rebuilt AGOS pair, a parsed `swordres.rif` beside a speech index, and a
 * Sword II resource table — and ADR 0036 is the reason they are not one union
 * with a tag on it.
 */
let sword1Folder: Sword1GameFolder | null = null;
let sword2Folder: Sword2GameFolder | null = null;

/**
 * The same again, for SCI — and this one is needed by more than the sound.
 *
 * AGOS and the two Swords open a folder so that recordings can be played. A
 * SCI project needs one to be *exported at all*: the container it packs back
 * into is read from the folder's own map (ADR 0020 — a Version is probed and a
 * map structure is read, and they are separate facts), and the audio Volumes an
 * export carries rather than rebuilds are in there too (#227).
 */
let sciFolder: SciGameFolder | null = null;

/**
 * The Lure editing surface, the sixth arm of that one branch.
 *
 * A Lure project holds a palette surface (its editable one) and an object table
 * carried as read-only Preserved bytes (ADR 0026). Neither is a SCUMM `Action`,
 * an AGI Logic, a SCI class or an AGOS item tree, so this is the same
 * whole-surface swap the others are. Created lazily, like its siblings.
 */
function mountLureSurface(): void {
  clearSidePanes();
  lureEditor ??= new LureEditor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
  });
  if (lureEditor.element.parentElement !== centre) {
    centre.replaceChildren(lureEditor.element);
  }
  lureEditor.render();
}

/**
 * The Broken Sword editing surface, the seventh arm of that one branch.
 *
 * A Sword1 project holds screens, compacts, decompiled scripts, text in every
 * language the release ships, palettes and pictures (ADR 0036). None of those is
 * a SCUMM `Action`, an AGI Logic, a SCI class or an AGOS item tree, so this is
 * the same whole-surface swap the others are. Created lazily, like its siblings.
 */
function mountSword1Surface(): void {
  clearSidePanes();
  sword1Editor ??= new Sword1Editor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
    audio,
    folderName: () => sword1Folder?.name ?? null,
    openGameFolder: async () => {
      const result = await openSword1GameFolder(state.current);
      if (typeof result === 'string') return result;
      sword1Folder = result;
      // Re-made per folder rather than pointed at a variable, so a reader
      // holding a 43.9 MB container's index cannot outlive the folder it came
      // from — the same rule the AGOS mount states.
      setAudioResourceReader(sword1AudioReader(result));
      renderStatus();
      return null;
    },
  });
  if (sword1Editor.element.parentElement !== centre) {
    centre.replaceChildren(sword1Editor.element);
  }
  sword1Editor.render();
}

/**
 * The Broken Sword II editing surface, the eighth arm.
 *
 * Separate from Sword1's for ADR 0026's reason: the two families' documents
 * share no record type, so a shared editor would be a class with two modes and
 * a flag.
 */
function mountSword2Surface(): void {
  clearSidePanes();
  sword2Editor ??= new Sword2Editor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
    audio,
    folderName: () => sword2Folder?.name ?? null,
    openGameFolder: async () => {
      const result = await openSword2GameFolder(state.current);
      if (typeof result === 'string') return result;
      sword2Folder = result;
      setAudioResourceReader(sword2AudioReader(result));
      renderStatus();
      return null;
    },
  });
  if (sword2Editor.element.parentElement !== centre) {
    centre.replaceChildren(sword2Editor.element);
  }
  sword2Editor.render();
}

/** Screens, compacts and scripts: what a Broken Sword project is made of. */
function describeSword1(): string {
  const sword1 = state.current.sword1;
  if (!sword1) return 'Broken Sword project';
  const compacts = sword1.sections.reduce((total, section) => total + section.compacts.length, 0);
  const instructions = sword1.scripts.reduce(
    (total, script) => total + script.instructions.length,
    0,
  );
  return [
    `${sword1.rooms.length} screens`,
    `${compacts} objects`,
    `${instructions} instructions`,
    `${sword1.text.length} text resources`,
  ].join(', ');
}

/** Objects, globals and run lists: what a Broken Sword II project is made of. */
function describeSword2(): string {
  const sword2 = state.current.sword2;
  if (!sword2) return 'Broken Sword II project';
  const instructions = sword2.objects.reduce(
    (total, object) => total + object.instructions.length,
    0,
  );
  return [
    `${sword2.objects.length} objects`,
    `${instructions} instructions`,
    `${sword2.globals.count} variables`,
    `${sword2.runLists.length} run lists`,
  ].join(', ');
}

function mountAgiSurface(): void {
  clearSidePanes();
  agiEditor ??= new AgiEditor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
  });
  if (agiEditor.element.parentElement !== centre) {
    centre.replaceChildren(agiEditor.element);
  }
  agiEditor.render();
}

/**
 * The SCI editing surface, the second arm of that one branch.
 *
 * A SCI project has a class graph, Selectors, two kinds of Picture and — from
 * SCI1.1 — Messages. None of those is a SCUMM `Action` or an AGI Logic, and a
 * SCUMM project has no class graph, so this is the same whole-surface swap
 * rather than a third mode inside either of the others.
 *
 * Created lazily, for the same reason `AgiEditor` is: a SCUMM session should
 * not pay for the SCI linker being in the bundle at all.
 */
function mountSciSurface(): void {
  clearSidePanes();
  sciEditor ??= new SciEditor({
    project: () => state.current,
    update: (mutate) => state.update(mutate),
    audio,
    folderName: () => sciFolder?.name ?? null,
    openGameFolder: async () => {
      const result = await openSciGameFolder(state.current);
      if (typeof result === 'string') return result;
      sciFolder = result;
      // Re-made per folder rather than pointed at a variable, so a reader
      // holding one install's audio map cannot outlive the folder it came
      // from — the same rule both Broken Sword mounts state.
      setAudioResourceReader(sciAudioReader(result));
      renderStatus();
      return null;
    },
  });
  if (sciEditor.element.parentElement !== centre) {
    centre.replaceChildren(sciEditor.element);
  }
  sciEditor.render();
}

const actionEditor = new ActionEditor({
  objects: [],
  rooms: [],
  actors: [],
  audio: [],
  onChange: () => {
    // The editor mutates the project's own arrays, so the change is already
    // applied; this records it for undo and autosave.
    state.update(() => undefined);
  },
});

// ------------------------------------------------------------------- header --

function button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = label;
  if (title) element.title = title;
  element.addEventListener('click', onClick);
  return element;
}

/*
 * The title bar keeps its `banner` role, and the project name gets a label.
 *
 * Not `role="toolbar"`: it would replace the banner landmark on the same
 * element, and it promises a keyboard model — arrow keys across one composite
 * widget — that a row of a text field and seven unrelated buttons does not
 * implement. The label on the field is the real fix here; it was a bare
 * `<input>` whose only clue was the text already in it, which says nothing at
 * all once it has been cleared (3.3.2).
 */
header.setAttribute('aria-label', 'Editor actions');

const projectName = document.createElement('input');
projectName.className = 'project-name';
projectName.id = 'project-name';
projectName.setAttribute('aria-label', 'Project name');
projectName.value = state.current.name;
projectName.addEventListener('change', () => {
  state.update((project) => {
    project.name = projectName.value.trim() || 'Untitled';
  });
});

const saveButton = button('Save', () => void doSave(), 'Write the project and the compiled game');
const undoButton = button('Undo', () => state.undo());
const redoButton = button('Redo', () => state.redo());
const playButton = button('▶ Play', () => void doPlay(), 'Plays the room you are editing');
playButton.className = 'primary';

const importInput = document.createElement('input');
importInput.type = 'file';
importInput.accept = '.json,application/json';
importInput.className = 'visually-hidden';
// Out of the tab order and out of the accessibility tree: the button beside it
// is the control, and a focusable `aria-hidden` element is a contradiction.
importInput.tabIndex = -1;
importInput.setAttribute('aria-hidden', 'true');
importInput.addEventListener('change', () => void doImport());

header.append(
  projectName,
  spacer(),
  undoButton,
  redoButton,
  button('Export project', () => exportProjectOnly(state.current), 'Just the .json'),
  button('Export game', () => void doExportGame(), 'A zip you can hand to someone'),
  button('Import…', () => importInput.click()),
  importInput,
  saveButton,
  playButton,
);

/**
 * A button whose visible content is a symbol, and whose name is words.
 *
 * A glyph as text content becomes the button's accessible name, and the name a
 * screen reader then reads is the Unicode character's own — "black
 * right-pointing triangle" for a play button, "heavy multiplication x" for a
 * close. The glyph is hidden and the name is written out instead (4.1.2), with
 * the same words in `title` so a pointer user gets them too.
 */
function glyphButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  const inner = document.createElement('span');
  inner.setAttribute('aria-hidden', 'true');
  inner.textContent = glyph;
  element.appendChild(inner);
  element.setAttribute('aria-label', label);
  element.title = label;
  element.addEventListener('click', onClick);
  return element;
}

function spacer(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'spacer';
  return element;
}

// ------------------------------------------------------------------ sidebar --

/** The four things a game is made of, in the order the sidebar lists them. */
type SectionName = 'rooms' | 'actors' | 'objects' | 'audio';

/**
 * Which sidebar sections are open, for the SCUMM surface.
 *
 * The mechanics are `shell.ts`'s, because the AGOS surface wants the same ones.
 * What stays here is the section list and the storage key: they are this
 * surface's, and an author who collapsed Rooms has not asked for an AGOS game's
 * Subroutines to close.
 */
const openSections = new OpenSections<SectionName>(STORAGE_KEYS.editorSections, [
  'rooms',
  'actors',
  'objects',
  'audio',
]);

function section(
  name: SectionName,
  title: string,
  count: number,
  fill: (body: HTMLElement) => void,
): HTMLElement {
  return accordion({ name, title, count, sections: openSections, fill, onToggle: renderSidebar });
}

function renderSidebar(): void {
  sidebar.replaceChildren();

  // Re-pointed here rather than once at construction: the Audio section is one
  // instance shared with whichever family surface is mounted, and an AGOS
  // project points it at its own sidebar. Setting it on every render is what
  // brings it back when a SCUMM project is opened next.
  audio.onChanged = () => renderSidebar();
  audio.onReveal = () => openSections.open('audio');

  const room = state.currentRoom;

  sidebar.appendChild(
    section('rooms', 'Rooms', state.current.rooms.length, (body) => {
      const roomList = document.createElement('ul');
      roomList.className = 'list';
      for (const entry of state.current.rooms) {
        roomList.appendChild(
          listRow({
            label: `${entry.id} — ${entry.name}`,
            selected: entry.id === state.selected.roomId,
            onSelect: () => {
              state.select({ roomId: entry.id, objectId: null, boxIndex: null });
              // Picking something from the sidebar means wanting to look at it,
              // so the view follows the selection rather than leaving the author
              // to find the tab that shows what they just clicked.
              mode = 'room';
              renderAll();
              announce(`Room ${entry.id}, ${entry.name}.`);
            },
          }),
        );
      }
      body.appendChild(roomList);
      body.appendChild(button('+ Room', () => state.addRoom()));
    }),
  );

  sidebar.appendChild(
    section('actors', 'Actors', state.current.actors.length, (body) => {
      const actorList = document.createElement('ul');
      actorList.className = 'list';
      for (const actor of state.current.actors) {
        actorList.appendChild(
          listRow({
            // Actor 1 is the player; saying so avoids a second "which one am
            // I?" moment.
            label: `${actor.id} — ${actor.name}${actor.id === 1 ? ' (player)' : ''}`,
            selected: actor.id === state.selected.actorId,
            onSelect: () => {
              state.select({ actorId: actor.id });
              mode = 'sprite';
              renderAll();
              announce(`Actor ${actor.id}, ${actor.name}.`);
            },
          }),
        );
      }
      body.appendChild(actorList);

      const addActor = button('+ Actor', () => {
        if (!state.addActor()) {
          void showAlert(`A game can have at most ${ACTOR_ID_LIMIT - 1} actors.`, {
            title: 'No room for another actor',
          });
          return;
        }
        mode = 'sprite';
        renderAll();
      });
      addActor.disabled = state.current.actors.length >= ACTOR_ID_LIMIT - 1;
      body.appendChild(addActor);
    }),
  );

  sidebar.appendChild(
    section('objects', 'Objects', room?.objects.length ?? 0, (body) => {
      if (!room) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'Objects belong to a room. Pick one above to see its objects.';
        body.appendChild(empty);
        return;
      }

      const objectList = document.createElement('ul');
      objectList.className = 'list';
      for (const object of room.objects) {
        objectList.appendChild(
          listRow({
            label: `${object.id} — ${object.name}`,
            selected: object.id === state.selected.objectId,
            onSelect: () => {
              state.select({ objectId: object.id, boxIndex: null });
              mode = 'object';
              renderAll();
              announce(`Object ${object.id}, ${object.name}.`);
            },
          }),
        );
      }
      body.appendChild(objectList);

      const hint = document.createElement('p');
      hint.className = 'muted';
      hint.textContent = 'Pick the Object tool and click the room to add one.';
      body.appendChild(hint);
    }),
  );

  sidebar.appendChild(section('audio', 'Audio', audio.count, (body) => audio.render(body)));
}

// -------------------------------------------------------------------- audio --

/**
 * The Audio section, whose surface lives in `audioSection.ts`.
 *
 * Moved there when AGOS wanted the same one. What stays here is the wiring: the
 * project's audio array, this surface's undo-aware mutators, and which sidebar
 * section an import should open.
 */
const audio = new AudioSection({
  tracks: () => state.current.audio,
  add: (name, bytes) => state.addAudio(name, bytes),
  remove: (id) => state.deleteAudio(id),
  rename: (id, name) => state.renameAudio(id, name),
  replace: (id, filename, bytes) => state.replaceAudio(id, filename, bytes),
});

/**
 * Which way the character is facing, for the pose being drawn.
 *
 * "All" is one drawing used whichever way the character turns, which is what a
 * hand-drawn sprite wants and what the engine will mirror. A costume out of a
 * published game has four genuinely different views — a character walking away
 * is drawn from behind, not flipped — so each is editable on its own.
 *
 * A direction that has no artwork of its own is marked, because otherwise
 * there is no way to tell "this direction looks the same" from "this direction
 * has its own drawing that happens to be similar".
 */
function facingSelector(actor: { poses: Project['actors'][number]['poses'] } | undefined) {
  const pose = actor?.poses[sprite.frameIndex];
  const own = new Set(definedFacings(pose));

  const choices: Array<[string, string]> = [
    ['all', own.has('all') || own.size === 0 ? 'All' : 'All (none)'],
    ...POSE_DIRECTIONS.map(
      (direction) =>
        [
          direction,
          own.has(direction)
            ? `${direction[0].toUpperCase()}${direction.slice(1)}`
            : `${direction[0].toUpperCase()}${direction.slice(1)} (shared)`,
        ] as [string, string],
    ),
  ];

  return selectField('Facing', sprite.facing, choices, (value) => {
    sprite.facing = value as PoseFacing;
    sprite.selectCel(0);
    renderAll();
  });
}

// ------------------------------------------------------------------- centre --

const tabs = document.createElement('div');
tabs.className = 'tabs';
const toolbar = document.createElement('div');
toolbar.className = 'toolbar';
const paletteStrip = document.createElement('div');
paletteStrip.className = 'palette';
const canvasWrap = document.createElement('div');
canvasWrap.className = 'canvas-wrap';
// The canvas and the description it points at with `aria-describedby`. The
// description has to be in the document for the reference to resolve, and it is
// visually hidden because a paragraph of key bindings under the artwork is
// noise for everyone who is not looking for it.
canvasWrap.append(canvas.element, canvas.help);

const spriteToolbar = document.createElement('div');
spriteToolbar.className = 'toolbar';
const spritePalette = document.createElement('div');
spritePalette.className = 'palette';
const spriteWrap = document.createElement('div');
spriteWrap.className = 'canvas-wrap';
spriteWrap.append(sprite.element, sprite.help);
const spriteStrip = document.createElement('div');
spriteStrip.className = 'frame-strip';

const objectToolbar = document.createElement('div');
objectToolbar.className = 'toolbar';
const objectPalette = document.createElement('div');
objectPalette.className = 'palette';
const objectWrap = document.createElement('div');
objectWrap.className = 'canvas-wrap';
objectWrap.append(objectArt.element, objectArt.help);
const objectStrip = document.createElement('div');
objectStrip.className = 'frame-strip';

centre.append(
  tabs,
  toolbar,
  paletteStrip,
  canvasWrap,
  spriteToolbar,
  spritePalette,
  spriteWrap,
  spriteStrip,
  objectToolbar,
  objectPalette,
  objectWrap,
  objectStrip,
);

function renderTabs(): void {
  tabs.replaceChildren();
  for (const [value, label] of [
    ['room', 'Room'],
    ['sprite', 'Player sprite'],
    ['object', 'Object art'],
  ] as Array<[Mode, string]>) {
    const element = button(label, () => {
      mode = value;
      renderAll();
      announce(`${label} tab.`);
    });
    element.className = mode === value ? 'tab selected' : 'tab';
    // They looked like tabs and behaved like tabs and were three loose buttons
    // to anything reading the page: no `tablist`, no selected state, and Tab
    // walking through all three rather than the arrow keys moving between them.
    groupItem(element, {
      role: 'tab',
      selected: mode === value,
      label,
      controls: 'editor-canvas-area',
    });
    // Object art needs an object; the tab says so rather than showing a blank
    // canvas and leaving the author to work out why.
    if (value === 'object' && !state.currentObject) {
      element.disabled = true;
      element.title = 'Select an object first';
      // `title` is not a reliable accessible description, and the reason a tab
      // is unavailable is exactly the thing a reader needs.
      element.setAttribute('aria-label', `${label} — select an object first`);
    }
    tabs.appendChild(element);
  }
  rovingGroup(tabs, {
    role: 'tablist',
    label: 'Editor view',
    orientation: 'horizontal',
  });
}

function applyMode(): void {
  // Falling back keeps the view valid when the selected object is deleted.
  if (mode === 'object' && !state.currentObject) mode = 'room';
  sprite.actorId = state.selected.actorId;

  const show = (elements: HTMLElement[], visible: boolean): void => {
    for (const element of elements) element.hidden = !visible;
  };

  show([toolbar, paletteStrip, canvasWrap], mode === 'room');
  show([spriteToolbar, spritePalette, spriteWrap, spriteStrip], mode === 'sprite');
  show([objectToolbar, objectPalette, objectWrap, objectStrip], mode === 'object');
}

/** Shared import controls, used by both the room and object toolbars. */
function importControls(onImport: () => void, label: string): HTMLElement[] {
  const dither = document.createElement('label');
  dither.className = 'toggle';
  const ditherCheck = document.createElement('input');
  ditherCheck.type = 'checkbox';
  ditherCheck.checked = importDither;
  ditherCheck.addEventListener('change', () => {
    importDither = ditherCheck.checked;
  });
  dither.append(ditherCheck, document.createTextNode('Dither'));

  return [
    button(label, onImport, 'Import a PNG, JPEG or GIF and map it to the palette'),
    selectField(
      'Fit',
      importFit,
      [
        ['contain', 'Fit inside'],
        ['cover', 'Fill'],
        ['stretch', 'Stretch'],
        ['none', 'Original size'],
      ],
      (value) => {
        importFit = value as FitMode;
      },
    ),
    dither,
  ];
}

/**
 * Imports a picture as the current room's background.
 *
 * Quantising to 256 colours loses information no matter what, so the choice on
 * offer is which kind of loss: banding, or a dither that trades it for stipple.
 */
async function doImportBackground(): Promise<void> {
  const room = state.currentRoom;
  if (!room) return;

  const file = await pickImageFile();
  if (!file) return;

  try {
    const image = await importImage(file, {
      width: room.width,
      height: room.height,
      fit: importFit,
      dither: importDither,
    });
    state.update((project) => {
      const target = project.rooms.find((r) => r.id === room.id);
      if (target) target.background = storeImage(image);
    });
  } catch (error) {
    await showAlert(
      `Could not import that image: ${error instanceof Error ? error.message : error}`,
      { title: 'Could not import that image' },
    );
  }
}

/** Imports a picture as the current object's artwork, keeping transparency. */
async function doImportObjectArt(): Promise<void> {
  if (!state.currentObject) return;

  const file = await pickImageFile();
  if (!file) return;

  try {
    const image = await importImage(file, {
      fit: 'none',
      dither: importDither,
      // Anything meaningfully see-through becomes the transparent index, so a
      // cut-out PNG stays a cut-out rather than gaining a black box.
      alphaThreshold: 128,
    });
    objectArt.replaceWith(image);
  } catch (error) {
    await showAlert(
      `Could not import that image: ${error instanceof Error ? error.message : error}`,
      { title: 'Could not import that image' },
    );
  }
}

function renderObjectToolbar(): void {
  objectToolbar.replaceChildren();

  const object = state.currentObject;
  if (!object) return;

  const name = document.createElement('span');
  name.className = 'muted strip-label';
  name.textContent = `${object.id} — ${object.name}`;
  objectToolbar.appendChild(name);

  objectToolbar.appendChild(spacer());

  const size = objectArt.size;
  objectToolbar.appendChild(
    numberField('Width', size.width, (value) => {
      objectArt.resize(value, objectArt.size.height);
      renderAll();
    }),
  );
  objectToolbar.appendChild(
    numberField('Height', size.height, (value) => {
      objectArt.resize(objectArt.size.width, value);
      renderAll();
    }),
  );
  objectToolbar.appendChild(
    selectField(
      'Zoom',
      String(objectArt.zoom),
      [
        ['4', '4×'],
        ['8', '8×'],
        ['12', '12×'],
        ['16', '16×'],
      ],
      (value) => {
        objectArt.zoom = Number(value);
        renderAll();
      },
    ),
  );

  for (const control of importControls(() => void doImportObjectArt().then(renderAll), 'Import…')) {
    objectToolbar.appendChild(control);
  }

  objectToolbar.appendChild(
    button('Clear', () => {
      objectArt.clear();
      renderAll();
    }),
  );
}

function renderObjectPalette(): void {
  objectPalette.replaceChildren();

  const eraser = document.createElement('button');
  eraser.type = 'button';
  eraser.className =
    objectArt.color === TRANSPARENT_INDEX ? 'swatch transparent selected' : 'swatch transparent';
  eraser.title = 'Transparent (right-click also erases)';
  groupItem(eraser, {
    role: 'radio',
    selected: objectArt.color === TRANSPARENT_INDEX,
    label: 'Transparent',
  });
  eraser.addEventListener('click', () => {
    objectArt.color = TRANSPARENT_INDEX;
    renderAll();
  });
  objectPalette.appendChild(eraser);

  // Bounded by the room's own palette, which is sixteen entries for a
  // sixteen-colour release and 256 for everything else. Offering 256 on a v2,
  // v3 or EGA v4 room is not a cosmetic surplus: the encoder writes a colour
  // index into four bits, so a colour picked above fifteen is written back as
  // a *different* colour, silently and only in the exported game.
  const roomPalette = state.currentRoom?.palette;
  for (const index of paletteChoices(roomPalette?.length ?? 256)) {
    // The room's own colours where it has them, so a sixteen-colour room shows
    // the sixteen it actually uses rather than the editor's defaults.
    const entry = roomPalette?.[index] ?? palette[index] ?? [0, 0, 0];
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = objectArt.color === index ? 'swatch selected' : 'swatch';
    swatch.style.background = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
    swatch.title = `Colour ${index}`;
    // 1.4.1: a swatch is a square of colour and nothing else, so colour is the
    // only thing carrying its meaning. The name says the index the format
    // stores and the values the square shows.
    groupItem(swatch, {
      role: 'radio',
      selected: objectArt.color === index,
      label: describeColour(index, entry),
    });
    swatch.addEventListener('click', () => {
      objectArt.color = index;
      renderAll();
    });
    objectPalette.appendChild(swatch);
  }

  rovingGroup(objectPalette, { role: 'radiogroup', label: 'Object colour' });
}

/**
 * The state strip.
 *
 * States are how a SCUMM object changes appearance — a closed door and an open
 * one — and scripts switch between them with the "Set object state" action.
 */
function renderObjectStrip(): void {
  objectStrip.replaceChildren();

  const object = state.currentObject;
  if (!object) return;

  const label = document.createElement('span');
  label.className = 'muted strip-label';
  label.textContent = object.states.length <= 1 ? 'One state' : `${object.states.length} states`;
  objectStrip.appendChild(label);

  object.states.forEach((_, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = index === objectArt.stateIndex ? 'cel selected' : 'cel';
    item.title = `State ${index + 1}`;
    groupItem(item, {
      role: 'radio',
      selected: index === objectArt.stateIndex,
      label: `State ${index + 1} of ${object.states.length}`,
    });

    const image = document.createElement('img');
    image.src = objectArt.thumbnail(index);
    // The button is already named for the state, so a thumbnail with its own
    // name would be read twice. Empty `alt` is what marks it as decoration —
    // and a missing `alt` would be read as the data URL.
    image.alt = '';
    item.appendChild(image);

    const number = document.createElement('span');
    number.className = 'cel-hold';
    number.textContent = String(index + 1);
    number.setAttribute('aria-hidden', 'true');
    item.appendChild(number);

    item.addEventListener('click', () => {
      objectArt.stateIndex = index;
      renderAll();
    });
    objectStrip.appendChild(item);
  });

  rovingGroup(objectStrip, {
    role: 'radiogroup',
    label: 'Object state',
    orientation: 'horizontal',
  });

  const controls = document.createElement('div');
  controls.className = 'strip-controls';
  controls.appendChild(
    button(
      '+ State',
      () => {
        objectArt.addState();
        renderAll();
      },
      'Add a state, copied from this one',
    ),
  );

  const remove = button('Delete state', () => {
    objectArt.removeState();
    renderAll();
  });
  remove.disabled = object.states.length <= 1;
  controls.appendChild(remove);
  objectStrip.appendChild(controls);
}

/**
 * The cel strip for the current pose.
 *
 * A walk is a sequence, so the strip is the primary control: it shows the order,
 * which cel is being drawn, and how long each is held.
 */
function renderSpriteStrip(): void {
  spriteStrip.replaceChildren();

  const cels = sprite.cels;
  const pose = SPRITE_FRAMES.find((frame) => frame.index === sprite.frameIndex);
  const poseName = pose?.label ?? `Frame ${sprite.frameIndex}`;

  // Naming the pose here is not decoration. Cels are added to whichever pose is
  // selected, and the editor opens on Standing — so a walk cycle drawn without
  // switching pose first animates while idle and stays still while walking.
  const label = document.createElement('span');
  label.className = 'strip-label';
  label.textContent =
    cels.length <= 1 ? `${poseName} — 1 cel` : `${poseName} — ${cels.length} cels`;
  spriteStrip.appendChild(label);

  // Only the walking pose is expected to have several cels. Anything else with
  // more than one animates continuously, which is occasionally wanted (a blink,
  // a flag in the wind) and usually a mistake.
  if (cels.length > 1 && sprite.frameIndex !== 2) {
    const warning = document.createElement('span');
    warning.className = 'strip-warning';
    // The symbol is decoration on a sentence that already says everything; read
    // out it is "warning sign" in front of the words that carry the warning.
    const warningMark = document.createElement('span');
    warningMark.setAttribute('aria-hidden', 'true');
    warningMark.textContent = '⚠ ';
    warning.append(warningMark, `${poseName} will animate constantly. Did you mean Walking?`);
    warning.title =
      'A pose with several cels cycles whenever it is shown. Only the walking ' +
      'pose is shown while the character moves.';
    spriteStrip.appendChild(warning);
  }

  cels.forEach((cel, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = index === sprite.celIndex ? 'cel selected' : 'cel';
    item.title = `Cel ${index + 1}, held ${cel.hold} ticks`;
    groupItem(item, {
      role: 'radio',
      selected: index === sprite.celIndex,
      label: `Cel ${index + 1} of ${cels.length}, held ${cel.hold} ticks`,
    });

    const image = document.createElement('img');
    image.src = sprite.thumbnail(cel);
    // Decorative: the button around it is already named for the cel.
    image.alt = '';
    item.appendChild(image);

    const hold = document.createElement('span');
    hold.className = 'cel-hold';
    hold.textContent = String(cel.hold);
    hold.setAttribute('aria-hidden', 'true');
    item.appendChild(hold);

    item.addEventListener('click', () => {
      sprite.selectCel(index);
      renderAll();
    });
    spriteStrip.appendChild(item);
  });

  rovingGroup(spriteStrip, {
    role: 'radiogroup',
    label: `${poseName} cels`,
    orientation: 'horizontal',
  });

  const controls = document.createElement('div');
  controls.className = 'strip-controls';

  controls.appendChild(
    button(
      '+ Cel',
      () => {
        sprite.addCel();
        renderAll();
      },
      `Add a cel to the ${poseName.toLowerCase()} pose, copied from this one`,
    ),
  );
  // The glyphs were the buttons' whole text, and their accessible names were
  // "black left-pointing pointer" and its mirror. `glyphButton` keeps the arrow
  // on screen and gives the button a name that says what it does.
  controls.appendChild(
    glyphButton('◀', 'Move this cel earlier', () => {
      sprite.moveCel(-1);
      renderAll();
    }),
  );
  controls.appendChild(
    glyphButton('▶', 'Move this cel later', () => {
      sprite.moveCel(1);
      renderAll();
    }),
  );

  const remove = button('Delete cel', () => {
    sprite.removeCel();
    renderAll();
  });
  remove.disabled = cels.length <= 1;
  controls.appendChild(remove);

  const current = cels[sprite.celIndex];
  if (current) {
    controls.appendChild(
      numberField('Hold', current.hold, (value) => {
        sprite.setHold(value);
        renderAll();
      }),
    );
  }

  const preview = button(
    sprite.previewing ? '■ Stop' : '▶ Preview',
    () => {
      sprite.previewing = !sprite.previewing;
      renderAll();
      if (sprite.previewing) requestAnimationFrame(previewLoop);
    },
    'Play the pose at its real speed',
  );
  preview.className = sprite.previewing ? 'primary' : '';
  controls.appendChild(preview);

  spriteStrip.appendChild(controls);
}

/**
 * Drives the preview.
 *
 * Ticks at the engine's own 60 Hz so the timing shown is the timing that
 * ships, and stops on its own when preview is switched off or the sprite tab
 * is left.
 */
function previewLoop(): void {
  if (!sprite.previewing || mode !== 'sprite') {
    sprite.previewing = false;
    return;
  }
  if (sprite.tickPreview()) {
    sprite.render();
    renderSpriteStrip();
  }
  requestAnimationFrame(previewLoop);
}

/**
 * The sprite tools: which pose, how big, and the costume's own palette.
 *
 * A costume stores colour indices 1-15, not game colours. The palette row maps
 * each of those onto a game palette entry, which is what lets the same artwork
 * be recoloured for a different character.
 */
async function doImportSpriteCel(): Promise<void> {
  const file = await pickImageFile();
  if (!file) return;

  try {
    // A costume carries its own colour table, so the import chooses the
    // colours as well as the pixels, and the actor's palette follows.
    const { image, palette: chosen } = await importCostumeCel(file, {
      dither: importDither,
      fit: 'none',
      maxColors: COSTUME_COLORS,
    });
    sprite.replaceCel(image, chosen);
  } catch (error) {
    await showAlert(
      `Could not import that image: ${error instanceof Error ? error.message : error}`,
      { title: 'Could not import that image' },
    );
  }
}

function renderSpriteToolbar(): void {
  spriteToolbar.replaceChildren();

  const who = state.current.actors.find((candidate) => candidate.id === state.selected.actorId);
  const label = document.createElement('span');
  label.className = 'strip-label';
  label.textContent = who ? who.name : 'No actor';
  spriteToolbar.appendChild(label);

  const spriteActor = state.current.actors.find((candidate) => candidate.id === sprite.actorId);

  for (const frame of SPRITE_FRAMES) {
    // The cel count on the button makes it obvious where the animation lives,
    // without clicking through every pose to find it.
    const count = poseCels(spriteActor?.poses[frame.index], sprite.facing).length;
    const element = button(
      count > 1 ? `${frame.label} (${count})` : frame.label,
      () => {
        sprite.frameIndex = frame.index;
        sprite.selectCel(0);
        renderAll();
      },
      frame.hint,
    );
    element.className = sprite.frameIndex === frame.index ? 'tool selected' : 'tool';
    element.setAttribute('aria-pressed', String(sprite.frameIndex === frame.index));
    element.setAttribute(
      'aria-label',
      `${frame.label} pose, ${count} ${count === 1 ? 'cel' : 'cels'}`,
    );
    spriteToolbar.appendChild(element);
  }

  spriteToolbar.appendChild(facingSelector(spriteActor));
  spriteToolbar.appendChild(spacer());

  const size = sprite.frameSize;
  spriteToolbar.appendChild(
    numberField('Width', size.width, (value) => {
      sprite.resize(value, sprite.frameSize.height);
      renderAll();
    }),
  );
  spriteToolbar.appendChild(
    numberField('Height', size.height, (value) => {
      sprite.resize(sprite.frameSize.width, value);
      renderAll();
    }),
  );
  spriteToolbar.appendChild(
    selectField(
      'Zoom',
      String(sprite.zoom),
      [
        ['6', '6×'],
        ['10', '10×'],
        ['16', '16×'],
        ['24', '24×'],
      ],
      (value) => {
        sprite.zoom = Number(value);
        renderAll();
      },
    ),
  );

  spriteToolbar.appendChild(
    button(
      'Copy from standing',
      () => {
        sprite.copyFromStanding();
        renderAll();
      },
      'Start this pose from the standing artwork',
    ),
  );
  for (const control of importControls(
    () => void doImportSpriteCel().then(renderAll),
    'Import cel...',
  )) {
    spriteToolbar.appendChild(control);
  }

  spriteToolbar.appendChild(
    button('Clear', () => {
      void (async () => {
        const sure = await showConfirm('Erase this frame?', {
          title: 'Clear frame',
          acceptLabel: 'Erase',
          defaultButton: 'cancel',
        });
        if (!sure) return;
        sprite.clear();
        renderAll();
      })();
    }),
  );
}

/** Whether the full game palette is open for reassigning a costume slot. */
let pickingSpriteColour = false;

function renderSpritePalette(): void {
  spritePalette.replaceChildren();

  const actor = state.current.actors.find((candidate) => candidate.id === sprite.actorId);
  if (!actor) return;

  const swatches = document.createElement('div');
  swatches.className = 'swatch-row';

  // The eraser: costume colour 0 is always transparent.
  const eraser = document.createElement('button');
  eraser.type = 'button';
  eraser.className = sprite.color === 0 ? 'swatch transparent selected' : 'swatch transparent';
  eraser.title = 'Transparent (right-click also erases)';
  groupItem(eraser, { role: 'radio', selected: sprite.color === 0, label: 'Transparent' });
  eraser.addEventListener('click', () => {
    sprite.color = 0;
    renderAll();
  });
  swatches.appendChild(eraser);

  for (let index = 1; index <= COSTUME_COLORS; index++) {
    const paletteIndex = actor.palette[index - 1] ?? 15;
    const entry = palette[paletteIndex] ?? [0, 0, 0];

    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = sprite.color === index ? 'swatch selected' : 'swatch';
    swatch.style.background = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
    swatch.title = `Costume colour ${index} (palette ${paletteIndex})`;
    groupItem(swatch, {
      role: 'radio',
      selected: sprite.color === index,
      label: `Costume slot ${index}. ${describeColour(paletteIndex, entry)}`,
    });
    swatch.addEventListener('click', () => {
      sprite.color = index;
      renderAll();
    });
    swatches.appendChild(swatch);
  }
  rovingGroup(swatches, { role: 'radiogroup', label: 'Costume colour' });
  spritePalette.appendChild(swatches);

  const controls = document.createElement('div');
  controls.className = 'palette-controls';

  const change = button(
    pickingSpriteColour ? 'Done' : 'Change this colour...',
    () => {
      pickingSpriteColour = !pickingSpriteColour;
      renderAll();
    },
    'Pick which of the 256 game colours this slot uses',
  );
  change.disabled = sprite.color === 0;
  if (pickingSpriteColour) change.className = 'primary';
  controls.appendChild(change);

  const hint = document.createElement('span');
  hint.className = 'muted';
  hint.textContent =
    sprite.color === 0
      ? 'Transparent - the background shows through'
      : `Slot ${sprite.color} of ${COSTUME_COLORS} - alt-click the canvas to pick`;
  controls.appendChild(hint);
  spritePalette.appendChild(controls);

  if (!pickingSpriteColour || sprite.color === 0) return;

  // The full game palette, as a grid rather than a text prompt: choosing a
  // colour by typing its index is not choosing a colour.
  const grid = document.createElement('div');
  grid.className = 'palette-grid';

  const current = actor.palette[sprite.color - 1] ?? 15;
  for (let index = 0; index < 256; index++) {
    const entry = palette[index] ?? [0, 0, 0];
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = index === current ? 'swatch selected' : 'swatch';
    cell.style.background = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
    cell.title = `Palette ${index}`;
    groupItem(cell, {
      role: 'radio',
      selected: index === current,
      label: describeColour(index, entry),
    });
    cell.addEventListener('click', () => {
      const slot = sprite.color;
      state.update((project) => {
        const target = project.actors.find((candidate) => candidate.id === sprite.actorId);
        if (!target) return;
        while (target.palette.length < slot) target.palette.push(15);
        target.palette[slot - 1] = index;
      });
    });
    grid.appendChild(cell);
  }
  rovingGroup(grid, { role: 'radiogroup', label: `Game colour for costume slot ${sprite.color}` });
  spritePalette.appendChild(grid);
}

const TOOLS: Array<[Tool, string, string]> = [
  ['select', 'Select', 'Move objects and walk boxes'],
  ['paint', 'Paint', 'Freehand pixels'],
  ['rectangle', 'Rectangle', 'Drag a filled rectangle'],
  ['object', 'Object', 'Click to place a new object'],
  ['walkbox', 'Walk box', 'Drag the area the player may walk in'],
  ['walkto', 'Walk-to', 'Set where the player stands for the selected object'],
];

function renderToolbar(): void {
  toolbar.replaceChildren();

  for (const [tool, label, title] of TOOLS) {
    const element = button(
      label,
      () => {
        canvas.tool = tool;
        renderAll();
        announce(`${label} tool. ${title}.`);
      },
      title,
    );
    element.className = canvas.tool === tool ? 'tool selected' : 'tool';
    // Which tool is armed was shown by a background colour and nothing else,
    // which is 1.4.1 and 4.1.2 at once: no state in the accessibility tree, and
    // colour as the only channel on screen.
    element.setAttribute('aria-pressed', String(canvas.tool === tool));
    // `title` is not a dependable accessible description; the name carries what
    // the tool does, because a tool called "Walk-to" explains nothing on its own.
    element.setAttribute('aria-label', `${label} tool — ${title}`);
    toolbar.appendChild(element);
  }

  const dropper = document.createElement('span');
  dropper.className = 'muted';
  dropper.textContent = 'Right-click picks a colour';
  toolbar.appendChild(dropper);

  toolbar.appendChild(spacer());

  toolbar.appendChild(
    numberField('Brush', canvas.brushSize, (value) => {
      canvas.brushSize = Math.max(1, Math.min(64, value));
      renderAll();
    }),
  );
  toolbar.appendChild(
    selectField(
      'Zoom',
      String(canvas.scale),
      [
        ['1', '1×'],
        ['2', '2×'],
        ['3', '3×'],
        ['4', '4×'],
      ],
      (value) => {
        canvas.scale = Number(value);
        canvas.applyScale();
      },
    ),
  );

  for (const control of importControls(
    () => void doImportBackground().then(renderAll),
    'Import background…',
  )) {
    toolbar.appendChild(control);
  }

  const boxToggle = document.createElement('label');
  boxToggle.className = 'toggle';
  const boxCheck = document.createElement('input');
  boxCheck.type = 'checkbox';
  boxCheck.checked = canvas.showBoxes;
  boxCheck.addEventListener('change', () => {
    canvas.showBoxes = boxCheck.checked;
    canvas.render();
  });
  boxToggle.append(boxCheck, document.createTextNode('Walk boxes'));
  toolbar.appendChild(boxToggle);

  // Each overlay switches off on its own. Together they are the difference
  // between an editing view and the artwork as the player sees it.
  for (const [label, get, set] of [
    ['Objects', () => canvas.showObjects, (on: boolean) => (canvas.showObjects = on)],
    ['Walk-to', () => canvas.showWalkTo, (on: boolean) => (canvas.showWalkTo = on)],
    ['Guides', () => canvas.showGuides, (on: boolean) => (canvas.showGuides = on)],
  ] as Array<[string, () => boolean, (on: boolean) => void]>) {
    const toggle = document.createElement('label');
    toggle.className = 'toggle';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = get();
    check.addEventListener('change', () => {
      set(check.checked);
      canvas.render();
    });
    toggle.append(check, document.createTextNode(label));
    toolbar.appendChild(toggle);
  }
}

function renderPalette(): void {
  paletteStrip.replaceChildren();
  // The first 16 entries are the named EGA-ish colours plus a slice of the
  // cube; showing all 256 would be a wall of swatches nobody scans.
  // Bounded by the room's own palette, which is sixteen entries for a
  // sixteen-colour release and 256 for everything else. Offering 256 on a v2,
  // v3 or EGA v4 room is not a cosmetic surplus: the encoder writes a colour
  // index into four bits, so a colour picked above fifteen is written back as
  // a *different* colour, silently and only in the exported game.
  const roomPalette = state.currentRoom?.palette;
  for (const index of paletteChoices(roomPalette?.length ?? 256)) {
    // The room's own colours where it has them, so a sixteen-colour room shows
    // the sixteen it actually uses rather than the editor's defaults.
    const entry = roomPalette?.[index] ?? palette[index] ?? [0, 0, 0];
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = index === canvas.color ? 'swatch selected' : 'swatch';
    swatch.style.background = `rgb(${entry[0]}, ${entry[1]}, ${entry[2]})`;
    swatch.title = `Colour ${index}`;
    groupItem(swatch, {
      role: 'radio',
      selected: index === canvas.color,
      label: describeColour(index, entry),
    });
    swatch.addEventListener('click', () => {
      canvas.color = index;
      renderPalette();
    });
    paletteStrip.appendChild(swatch);
  }

  rovingGroup(paletteStrip, { role: 'radiogroup', label: 'Paint colour' });
}

// ---------------------------------------------------------------- inspector --

function renderInspector(): void {
  inspector.replaceChildren();

  // The sprite tab is about an actor, so the inspector follows it there.
  if (mode === 'sprite') {
    renderActorInspector();
    return;
  }

  const room = state.currentRoom;
  if (!room) {
    inspector.appendChild(paragraph('No room selected.'));
    return;
  }

  const object = state.currentObject;

  if (!object) {
    // The game's start position lives here because it is a property of the
    // room you are looking at as often as not, and because without it there was
    // no way at all to change the start room — deleting room 1 left the project
    // unplayable with nothing in the editor to repair it.
    inspector.appendChild(heading('Game start'));

    const startsHere = state.current.start.room === room.id;
    const startToggle = document.createElement('label');
    startToggle.className = 'toggle';
    const startCheck = document.createElement('input');
    startCheck.type = 'checkbox';
    startCheck.checked = startsHere;
    startCheck.disabled = startsHere;
    startCheck.title = startsHere
      ? 'The game already starts in this room'
      : 'Start the game in this room';
    startCheck.addEventListener('change', () =>
      state.update((project) => {
        project.start = { room: room.id, x: project.start.x, y: project.start.y };
      }),
    );
    startToggle.append(
      startCheck,
      document.createTextNode(startsHere ? 'The game starts here' : 'Start the game in this room'),
    );
    inspector.appendChild(startToggle);

    if (startsHere) {
      inspector.appendChild(
        numberField('Start x', state.current.start.x, (value) =>
          state.update((project) => {
            project.start.x = value;
          }),
        ),
      );
      inspector.appendChild(
        numberField('Start y', state.current.start.y, (value) =>
          state.update((project) => {
            project.start.y = value;
          }),
        ),
      );
    }

    inspector.appendChild(heading('Room'));
    inspector.appendChild(
      textField('Name', room.name, (value) =>
        state.update(() => {
          room.name = value;
        }),
      ),
    );

    // Perspective: the thing that stops a room reading flat. Without it the
    // character is the same size at the back of a corridor as at the front.
    inspector.appendChild(heading('Perspective'));

    const perspectiveToggle = document.createElement('label');
    perspectiveToggle.className = 'toggle';
    const perspectiveCheck = document.createElement('input');
    perspectiveCheck.type = 'checkbox';
    perspectiveCheck.checked = room.perspective !== undefined;
    perspectiveCheck.addEventListener('change', () => {
      state.update((project) => {
        const target = project.rooms.find((r) => r.id === room.id);
        if (!target) return;
        target.perspective = perspectiveCheck.checked
          ? {
              farY: Math.round(room.height * 0.7),
              farScale: 160,
              nearY: room.height - 1,
              nearScale: 255,
            }
          : undefined;
        // Boxes follow the room: switching perspective off should not leave
        // them pointing at a ramp that no longer exists.
        for (const box of target.boxes) box.perspective = perspectiveCheck.checked;
      });
    });
    perspectiveToggle.append(
      perspectiveCheck,
      document.createTextNode('Characters shrink with distance'),
    );
    inspector.appendChild(perspectiveToggle);

    const ramp = room.perspective;
    if (ramp) {
      const rampField = (
        label: string,
        key: 'farY' | 'farScale' | 'nearY' | 'nearScale',
      ): HTMLElement =>
        numberField(label, ramp[key], (value) =>
          state.update(() => {
            ramp[key] = value;
          }),
        );

      inspector.appendChild(rampField('Far row', 'farY'));
      inspector.appendChild(rampField('Size there', 'farScale'));
      inspector.appendChild(rampField('Near row', 'nearY'));
      inspector.appendChild(rampField('Size there', 'nearScale'));

      inspector.appendChild(
        paragraph(
          'Sizes are 1-255, where 255 is the artwork at full size. The dashed ' +
            'lines on the canvas show the two rows.',
        ),
      );
    }

    // Listed rather than only selectable on the canvas: a box hidden under an
    // object could not be clicked, so it could not be deleted.
    inspector.appendChild(heading(`Walk boxes (${room.boxes.length})`));

    if (room.boxes.length === 0) {
      inspector.appendChild(paragraph('None yet — nobody can walk here. Use the Walk box tool.'));
    }

    const boxList = document.createElement('ul');
    boxList.className = 'list';
    room.boxes.forEach((box, index) => {
      const item = document.createElement('li');
      item.className = state.selected.boxIndex === index ? 'selected row' : 'row';

      const bounds = boxBounds(box);
      const convex = isConvexBox(box);
      // The warning was a bare "⚠", which is read as "warning sign" and is
      // otherwise colour and a symbol carrying the whole message (1.4.1).
      const shape = convex ? '' : ' ⚠ concave';
      const description =
        `${index}: ${bounds.width}×${bounds.height} at ${bounds.x}, ${bounds.y}` +
        (convex ? '' : ' — concave, part of it is unwalkable');

      // A button, not a `<span>` with a click handler: selecting a walk box was
      // pointer-only, and the list exists precisely for the boxes that cannot
      // be reached on the canvas (2.1.1).
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'list-button';
      label.textContent = `${index}: ${bounds.width}×${bounds.height} at ${bounds.x}, ${bounds.y}${shape}`;
      label.setAttribute('aria-label', description);
      if (state.selected.boxIndex === index) label.setAttribute('aria-current', 'true');
      label.addEventListener('click', () => state.select({ boxIndex: index, objectId: null }));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button';
      const removeGlyph = document.createElement('span');
      removeGlyph.setAttribute('aria-hidden', 'true');
      removeGlyph.textContent = '✕';
      remove.appendChild(removeGlyph);
      remove.setAttribute('aria-label', `Delete walk box ${index}`);
      remove.title = 'Delete this walk box';
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        state.update((project) => {
          const target = project.rooms.find((r) => r.id === room.id);
          target?.boxes.splice(index, 1);
        });
        state.select({ boxIndex: null });
        announce(`Deleted walk box ${index}.`);
      });

      item.append(label, remove);
      boxList.appendChild(item);
    });
    inspector.appendChild(boxList);

    if (state.selected.boxIndex !== null) {
      const box = room.boxes[state.selected.boxIndex];
      if (box) {
        // Corner-by-corner, because a walk box is a quadrilateral: a receding
        // corridor is a trapezoid, not a rectangle. Dragging on the canvas is
        // the usual route; these are for exact values.
        for (const corner of ['ul', 'ur', 'lr', 'll'] as const) {
          const labels = { ul: 'Top left', ur: 'Top right', lr: 'Bottom right', ll: 'Bottom left' };
          inspector.appendChild(
            numberField(`${labels[corner]} x`, box[corner].x, (value) =>
              state.update(() => {
                box[corner].x = value;
              }),
            ),
          );
          inspector.appendChild(
            numberField(`${labels[corner]} y`, box[corner].y, (value) =>
              state.update(() => {
                box[corner].y = value;
              }),
            ),
          );
        }

        if (!isConvexBox(box)) {
          inspector.appendChild(
            paragraph(
              'This box is concave, so the engine treats part of it as ' +
                'unwalkable. Split it into two boxes instead.',
            ),
          );
        }

        if (room.perspective) {
          const boxToggle = document.createElement('label');
          boxToggle.className = 'toggle';
          const boxCheck = document.createElement('input');
          boxCheck.type = 'checkbox';
          boxCheck.checked = box.perspective ?? false;
          boxCheck.addEventListener('change', () =>
            state.update(() => {
              box.perspective = boxCheck.checked;
            }),
          );
          boxToggle.append(boxCheck, document.createTextNode('Use perspective here'));
          inspector.appendChild(boxToggle);

          if (!box.perspective) {
            inspector.appendChild(
              numberField('Fixed size', box.scale ?? 255, (value) =>
                state.update(() => {
                  box.scale = value;
                }),
              ),
            );
          }
        }
      }
    }

    inspector.appendChild(heading('When the player enters'));
    actionEditor.setOptions({
      objects: room.objects.map((o) => ({ id: o.id, name: o.name })),
      rooms: state.current.rooms.map((r) => ({ id: r.id, name: r.name })),
      actors: state.current.actors.map((a) => ({ id: a.id, name: a.name })),
      audio: state.current.audio.map((t) => ({ id: t.id, name: t.name })),
      target: state.current.target,
    });
    actionEditor.bind(room.onEnter);
    inspector.appendChild(actionEditor.element);

    inspector.appendChild(
      button(
        'Export background',
        () => void exportRoomBackground(room, state.current.name),
        'A PNG of the artwork alone — no boxes, outlines or guides',
      ),
    );

    if (state.current.rooms.length > 1) {
      inspector.appendChild(button('Delete room', () => state.deleteRoom(room.id)));
    }
    return;
  }

  inspector.appendChild(heading('Object'));
  inspector.appendChild(
    textField('Name', object.name, (value) =>
      state.update(() => {
        object.name = value;
      }),
    ),
  );
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    inspector.appendChild(
      numberField(key, object[key], (value) =>
        state.update(() => {
          object[key] = value;
        }),
      ),
    );
  }
  inspector.appendChild(
    numberField('Walk-to X', object.walkTo.x, (value) =>
      state.update(() => {
        object.walkTo.x = value;
      }),
    ),
  );
  inspector.appendChild(
    numberField('Walk-to Y', object.walkTo.y, (value) =>
      state.update(() => {
        object.walkTo.y = value;
      }),
    ),
  );
  inspector.appendChild(
    selectField(
      'Faces',
      object.facing,
      [
        ['north', 'North'],
        ['east', 'East'],
        ['south', 'South'],
        ['west', 'West'],
      ],
      (value) =>
        state.update(() => {
          object.facing = value as typeof object.facing;
        }),
    ),
  );

  inspector.appendChild(
    button(
      'Edit artwork →',
      () => {
        mode = 'object';
        objectArt.stateIndex = 0;
        renderAll();
      },
      'Draw this object, or import a picture',
    ),
  );

  inspector.appendChild(heading('When the player uses a verb'));

  const verbSelect = document.createElement('select');
  // A bare `<select>` under a heading is not a labelled control: the heading is
  // not its label, and a screen reader announcing it says only its value (3.3.2).
  verbSelect.setAttribute('aria-label', 'Verb this behaviour belongs to');
  for (const verb of state.current.verbs) {
    const option = document.createElement('option');
    option.value = String(verb.id);
    option.textContent = verb.text;
    verbSelect.appendChild(option);
  }
  const anyOption = document.createElement('option');
  anyOption.value = 'any';
  anyOption.textContent = 'Anything else';
  verbSelect.appendChild(anyOption);
  verbSelect.value = selectedVerb;
  verbSelect.addEventListener('change', () => {
    selectedVerb = verbSelect.value;
    renderInspector();
  });
  inspector.appendChild(verbSelect);

  actionEditor.setOptions({
    objects: room.objects.map((o) => ({ id: o.id, name: o.name })),
    rooms: state.current.rooms.map((r) => ({ id: r.id, name: r.name })),
    actors: state.current.actors.map((a) => ({ id: a.id, name: a.name })),
    audio: state.current.audio.map((t) => ({ id: t.id, name: t.name })),
    target: state.current.target,
  });

  if (selectedVerb === 'any') {
    actionEditor.bind(object.otherwise);
  } else {
    const verbId = Number(selectedVerb);
    let handler = object.handlers.find((entry) => entry.verbId === verbId);
    if (!handler) {
      handler = { verbId, actions: [] };
      object.handlers.push(handler);
    }
    actionEditor.bind(handler.actions);
  }
  inspector.appendChild(actionEditor.element);

  inspector.appendChild(
    button(
      'Export art',
      () =>
        void exportObjectState(
          object,
          objectArt.stateIndex,
          gamePalette(),
          state.current.name,
        ).catch(reportExportFailure),
      'A PNG of the state on screen, with its transparent pixels transparent',
    ),
  );
  inspector.appendChild(button('Delete object', () => state.deleteObject(object.id)));
}

let selectedVerb = '1';
let selectedActorVerb = '4';

/**
 * Properties and behaviour for the selected actor.
 *
 * Actors get verb handlers exactly as objects do — that is what turns a figure
 * that walks around into someone the player can talk to.
 */
function renderActorInspector(): void {
  const actor = state.currentActor;
  if (!actor) {
    inspector.appendChild(paragraph('No actor selected.'));
    return;
  }

  inspector.appendChild(heading(actor.id === 1 ? 'Player' : 'Actor'));
  inspector.appendChild(
    textField('Name', actor.name, (value) =>
      state.update(() => {
        actor.name = value;
      }),
    ),
  );
  inspector.appendChild(
    numberField('Talk colour', actor.talkColor, (value) =>
      state.update(() => {
        actor.talkColor = value;
      }),
    ),
  );
  inspector.appendChild(
    numberField('Speed x', actor.walkSpeed.x, (value) =>
      state.update(() => {
        actor.walkSpeed.x = value;
      }),
    ),
  );
  inspector.appendChild(
    numberField('Speed y', actor.walkSpeed.y, (value) =>
      state.update(() => {
        actor.walkSpeed.y = value;
      }),
    ),
  );

  if (actor.id === 1) {
    inspector.appendChild(
      paragraph('The player starts wherever the game does, set on the room tab.'),
    );
  } else {
    inspector.appendChild(heading('Starts in'));

    const placed = document.createElement('label');
    placed.className = 'toggle';
    const placedCheck = document.createElement('input');
    placedCheck.type = 'checkbox';
    placedCheck.checked = actor.start !== undefined;
    placedCheck.addEventListener('change', () =>
      state.update(() => {
        actor.start = placedCheck.checked
          ? { room: state.selected.roomId ?? 1, x: 160, y: 120 }
          : undefined;
      }),
    );
    placed.append(placedCheck, document.createTextNode('Place this actor in a room'));
    inspector.appendChild(placed);

    if (actor.start) {
      const start = actor.start;
      inspector.appendChild(
        selectField(
          'Room',
          String(start.room),
          state.current.rooms.map((room) => [String(room.id), `${room.id} — ${room.name}`]),
          (value) =>
            state.update(() => {
              start.room = Number(value);
            }),
        ),
      );
      inspector.appendChild(
        numberField('X', start.x, (value) =>
          state.update(() => {
            start.x = value;
          }),
        ),
      );
      inspector.appendChild(
        numberField('Y', start.y, (value) =>
          state.update(() => {
            start.y = value;
          }),
        ),
      );
    } else {
      inspector.appendChild(
        paragraph('Unplaced actors exist but are never on screen. Scripts can place them later.'),
      );
    }
  }

  inspector.appendChild(heading('When the player uses a verb'));

  const verbSelect = document.createElement('select');
  // A bare `<select>` under a heading is not a labelled control: the heading is
  // not its label, and a screen reader announcing it says only its value (3.3.2).
  verbSelect.setAttribute('aria-label', 'Verb this behaviour belongs to');
  for (const verb of state.current.verbs) {
    const option = document.createElement('option');
    option.value = String(verb.id);
    option.textContent = verb.text;
    verbSelect.appendChild(option);
  }
  const anyOption = document.createElement('option');
  anyOption.value = 'any';
  anyOption.textContent = 'Anything else';
  verbSelect.appendChild(anyOption);
  verbSelect.value = selectedActorVerb;
  verbSelect.addEventListener('change', () => {
    selectedActorVerb = verbSelect.value;
    renderInspector();
  });
  inspector.appendChild(verbSelect);

  actionEditor.setOptions({
    objects: (state.currentRoom?.objects ?? []).map((o) => ({ id: o.id, name: o.name })),
    rooms: state.current.rooms.map((r) => ({ id: r.id, name: r.name })),
    actors: state.current.actors.map((a) => ({ id: a.id, name: a.name })),
    audio: state.current.audio.map((t) => ({ id: t.id, name: t.name })),
    target: state.current.target,
  });

  if (selectedActorVerb === 'any') {
    actionEditor.bind(actor.otherwise);
  } else {
    const verbId = Number(selectedActorVerb);
    let handler = actor.handlers.find((entry) => entry.verbId === verbId);
    if (!handler) {
      handler = { verbId, actions: [] };
      actor.handlers.push(handler);
    }
    actionEditor.bind(handler.actions);
  }
  inspector.appendChild(actionEditor.element);

  inspector.appendChild(
    button(
      'Export sprite',
      () =>
        void exportSpriteCel(
          actor,
          sprite.frameIndex,
          sprite.celIndex,
          gamePalette(),
          state.current.name,
        ).catch(reportExportFailure),
      'A PNG of the cel on screen, with its transparent pixels transparent',
    ),
  );

  // Only the deletion below is restricted: the player cannot be removed, but
  // its sprite is the one most worth exporting.
  if (actor.id !== 1) {
    inspector.appendChild(button('Delete actor', () => state.deleteActor(actor.id)));
  }
}

function heading(text: string): HTMLElement {
  const element = document.createElement('h3');
  element.textContent = text;
  return element;
}

function paragraph(text: string): HTMLElement {
  const element = document.createElement('p');
  element.className = 'muted';
  element.textContent = text;
  return element;
}

// --------------------------------------------------------------- status bar --

/** Room coordinate under the cursor, shown in the status bar. */
let hoverPosition: { x: number; y: number } | null = null;

// The palette has to follow the eyedropper, or the picked colour is invisible.
canvas.onColorPicked = () => renderAll();
sprite.onColorPicked = () => renderAll();
objectArt.onColorPicked = () => renderAll();

/*
 * What the canvases say when a key does something.
 *
 * The canvas is a picture, so the result of a keystroke on it is invisible to
 * anyone not looking at it: a painted pixel, a placed object, a corner
 * anchored. Each of those goes to the shared polite region, which is the only
 * channel this work has (4.1.3).
 */
canvas.onKeyboardChange = (message) => announce(message);
sprite.onKeyboardChange = (message) => announce(message);
objectArt.onKeyboardChange = (message) => announce(message);

canvas.onHover = (position) => {
  hoverPosition = position;
  // Only the one label is rewritten: a full re-render on every mouse move
  // would rebuild the inspector and lose focus from whatever is being typed in.
  if (hoverLabel) {
    hoverLabel.textContent = position ? `${position.x}, ${position.y}` : '';
  }
};

let hoverLabel: HTMLElement | null = null;

/**
 * Says what a decompiled game brought with it, and what it did not.
 *
 * Rooms, art, boxes and objects arrive as ordinary editable data, so an author
 * opening one sees a complete-looking game. Its behaviour is not there: scripts
 * are bytecode and this editor stores actions. Saying so on arrival is the
 * difference between a known limitation and an hour spent looking for the verb
 * handlers.
 */
function showImportSummary(project: Project): void {
  const summary = project.imported;
  if (!summary) return;

  const banner = document.createElement('div');
  banner.className = 'import-banner';
  // It appears without taking focus and says what did and did not survive the
  // decompile, which is the definition of a status message (4.1.3).
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const text = document.createElement('p');
  const objects = project.rooms.reduce((total, room) => total + room.objects.length, 0);
  const renumbered = summary.renumberedObjects?.length ?? 0;

  // Room entry and exit scripts and object verb scripts now come across as the
  // game's own code, so the behaviour is here — readable, and preserved
  // exactly — even though it is not yet editable step by step.
  const behaviour = project.rooms.reduce(
    (total, room) =>
      total +
      (room.onEnter.length > 0 ? 1 : 0) +
      (room.onExit.length > 0 ? 1 : 0) +
      room.objects.reduce((count, object) => count + object.handlers.length, 0),
    0,
  );

  text.textContent =
    `Decompiled "${summary.game}": ${project.rooms.length} rooms, ${objects} objects, ` +
    `${project.actors.length} costumes as actors. ` +
    (behaviour > 0
      ? `${behaviour} room and object scripts came across as the game's own code: ` +
        `you can read them and they still run, but they are not editable step by step yet. `
      : '') +
    `${summary.scripts.length} global scripts are listed but not imported.` +
    (renumbered > 0
      ? ` ${renumbered} objects were renumbered: ids below 20 belong to actors here.`
      : '');

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Got it';
  dismiss.setAttribute('aria-label', 'Got it — hide this summary');
  dismiss.addEventListener('click', () => {
    banner.remove();
    // Focus was inside the thing that just left the document; without this it
    // falls back to the body and a keyboard user restarts at the top (2.4.3).
    document.querySelector<HTMLElement>('#editor-canvas-area')?.focus();
  });

  banner.append(text, dismiss);
  document.body.prepend(banner);
}

/**
 * The compiled game behind the status bar's counts, cached per revision.
 *
 * The status line renders on every selection, hover and keystroke, and
 * compiling a game is not cheap — for a decompiled one it is the whole
 * container, megabytes of it, which made simply clicking a room in the sidebar
 * rebuild the entire game. The project only changes when its revision does.
 */
let lastStatusBuild: { revision: number; built: ReturnType<typeof buildProject> } | null = null;

function statusBuild(): ReturnType<typeof buildProject> {
  if (lastStatusBuild?.revision === state.revision) return lastStatusBuild.built;

  const built = buildProject(state.current, { allowCode });
  lastStatusBuild = { revision: state.revision, built };
  return built;
}

/**
 * The colours an export should use.
 *
 * Object art and actor palettes both hold game palette indices, so they mean
 * whatever the open room's table means — the editor's defaults only for a room
 * that has none of its own.
 */
function gamePalette(): number[][] {
  return state.currentRoom?.palette ?? palette;
}

/** An export that fails should say so rather than producing no file quietly. */
function reportExportFailure(error: unknown): void {
  state.lastError = error instanceof Error ? error.message : String(error);
  renderStatus();
}

/** The last status sentence announced, so a re-render does not repeat it. */
let lastStatusSaid = '';

function renderStatus(): void {
  statusBar.replaceChildren();

  const parts: string[] = [];
  if (!isStorageAvailable()) {
    parts.push('Autosave unavailable in this browser — export often');
  } else if (state.lastError) {
    parts.push(state.lastError);
  } else {
    parts.push('Autosaved');
  }

  if (hasUnexportedChanges()) parts.push('unexported changes');

  const family = familySurface();
  if (family) {
    // Not asked to build. The SCUMM builder is the only one here, and asking it
    // about a project it does not build produces a refusal rather than a count.
    parts.push(family.describe());
  } else {
    const built = statusBuild();
    if (built.errors.length > 0) {
      // "Problem:" rather than a bare warning triangle. The symbol read aloud is
      // "warning sign", and on screen it was the only thing marking the line as a
      // failure rather than a count (1.4.1).
      parts.push(
        built.errors.length === 1
          ? `⚠ Problem: ${built.errors[0]}`
          : `⚠ ${built.errors.length} problems — ${built.errors[0]}`,
      );
    } else {
      parts.push(
        `${built.stats.rooms} rooms · ${built.stats.objects} objects · ` +
          `${state.current.actors.length} actors`,
      );
    }
  }

  const text = document.createElement('span');
  text.className = 'status-end';
  text.textContent = parts.join(' · ');
  statusBar.appendChild(text);

  // Said once when it changes, rather than on every render: this function runs
  // on every selection, hover and keystroke, and a live region here would read
  // the same sentence back continuously.
  const summary = parts.join('. ');
  if (summary !== lastStatusSaid) {
    lastStatusSaid = summary;
    announce(summary);
  }

  hoverLabel = document.createElement('span');
  hoverLabel.className = 'coords';
  hoverLabel.textContent = hoverPosition ? `${hoverPosition.x}, ${hoverPosition.y}` : '';
  // A pointer read-out that changes on every mouse move. Announced it would be
  // a stream of numbers with no beginning or end; the canvas says the cursor's
  // position on demand instead, when a key moves it.
  hoverLabel.setAttribute('aria-hidden', 'true');
  statusBar.appendChild(hoverLabel);

  const where = document.createElement('span');
  where.className = 'muted status-end';
  where.textContent = folder
    ? `Saving to ${folder.name}`
    : canSaveInPlace()
      ? 'Save will ask for a folder'
      : 'Save downloads a zip';
  statusBar.appendChild(where);
}

// ------------------------------------------------------------------ actions --

/**
 * What a save needs that the Project does not carry.
 *
 * The AGOS archive, when the author has opened the folder, and either Broken
 * Sword's clusters when they have opened one of those. ADR 0010 keeps all of
 * them out of the Project and ADR 0034 asks for the folder again here, so this
 * is where the two meet — and when it is absent the exporter says so by name
 * rather than writing half a game.
 *
 * Asynchronous because the Sword folders are read lazily: the re-supply keeps a
 * `DataSource` over the picked files and nothing has read a 20 MB cluster out of
 * it yet. An export is the moment that becomes worth doing, and the one place
 * it is done.
 */
async function saveOptions(): Promise<SaveOptions> {
  return {
    agosArchive: agosFolder?.archive,
    swordSource: (await sword1ExportSource()) ?? (await sword2ExportSource()),
    sciSource: await sciExportSource(),
  };
}

/**
 * SCI's container and its carried Volumes, out of the re-supplied folder.
 *
 * The map structure and the file names come from `detectSciGame`, which read
 * them out of the folder's own bytes when it was opened; only the carried
 * Volumes are read here, and that is where the size is — a talkie's
 * `RESOURCE.AUD` is hundreds of megabytes, and an export is the one moment
 * copying it is the point rather than a waste.
 */
async function sciExportSource(): Promise<SaveOptions['sciSource']> {
  const open = sciFolder;
  if (!open) return undefined;
  return {
    folderName: open.name,
    mapVersion: open.game.mapVersion,
    layout: open.game.layout,
    carried: await carriedVolumes(open),
  };
}

/** Sword 1's clusters and its `swordres.rif`, read out of the re-supplied folder. */
async function sword1ExportSource(): Promise<SaveOptions['swordSource']> {
  const open = sword1Folder;
  if (!open) return undefined;
  const index = await open.source.read(open.indexFile);
  if (!index) return undefined;

  /*
   * Every replaced recording, sorted into the three things an export does with
   * one: rebuild the speech container, write a tune's file, substitute an fx
   * resource. Resolved before a cluster is read, because two of the three can
   * refuse and a refusal is worth more before 143 MB has been walked.
   */
  const replaced = await sword1AudioReplacements(state.current, open);

  /*
   * The speech container, and only when there is a line to put in it.
   *
   * Read whole rather than by range, because rebuilding it means writing it
   * whole — and read *not at all* when nothing was replaced, because it is
   * 43.9 MB in the demo and every export that did not touch speech would
   * otherwise carry a copy of it.
   */
  const lines = replaced.speech;
  let speech: Sword1ExportSource['speech'];
  if (lines.length > 0) {
    if (!open.speech) {
      throw new Error(
        `${lines.length} line${lines.length === 1 ? '' : 's'} of speech ` +
          `${lines.length === 1 ? 'has' : 'have'} been replaced, and ${open.name} holds ` +
          `no speech container to write ${lines.length === 1 ? 'it' : 'them'} into. ` +
          `Broken Sword keeps its speech outside the clusters — SPEECH/COWS.MAD in the demo — ` +
          `so open the folder that has it and the replacements will be written.`,
      );
    }
    const data = await open.source.read(open.speech.file);
    if (!data) {
      throw new Error(
        `${open.speech.file} is in ${open.name} and could not be read, so the replaced speech ` +
          `has nowhere to go. The export is refused rather than made without it.`,
      );
    }
    speech = { name: open.speech.file, data, replacements: lines };
  }
  const clusters: Array<{ name: string; label: string; data: Uint8Array }> = [];
  for (const [label, file] of open.clusterFiles) {
    const data = await open.source.read(file);
    // A cluster the folder lists but cannot hand over is left out rather than
    // written empty: the exporter carries an absent cluster's index entries
    // through unchanged, and writing a zero-byte file in its place would make
    // an install that looks complete and holds nothing.
    if (!data) continue;
    clusters.push({ name: file.split(/[/\\]/).pop() ?? file, label, data });
  }
  return {
    indexFile: open.indexFile,
    index,
    clusters,
    speech,
    music: replaced.music.map((tune) => ({ file: tune.file, data: tune.data })),
    effects: replaced.effects.map((effect) => ({ id: effect.id, data: effect.data })),
  };
}

/** Sword II's clusters and its `resource.tab`, in `resource.inf`'s own order. */
async function sword2ExportSource(): Promise<SaveOptions['swordSource']> {
  const open = sword2Folder;
  if (!open) return undefined;
  const resourceTab = await open.source.read(open.resources.indexFiles.tab);
  if (!resourceTab) return undefined;

  /*
   * Every replaced recording, sorted into the two things an export does with
   * one: substitute an effect's resource, or rebuild the container a line of
   * speech lives in. Resolved before a cluster is read, because both can refuse
   * and a refusal is worth more before 40 MB has been walked.
   */
  const replaced = await sword2AudioReplacements(state.current, open);

  /*
   * The containers, and only the ones with something to put in them.
   *
   * Read whole rather than by range, because rebuilding one means writing it
   * whole — and read *not at all* when nothing in it was replaced, for the
   * reason Sword 1's speech container is: a retail `SPEECH1.CLU` is hundreds of
   * megabytes and every export that did not touch speech would carry a copy.
   */
  const sounds: Array<{ name: string; data: Uint8Array; replacements: Sword2SoundReplacement[] }> =
    [];
  for (const container of replaced.sounds) {
    const data = await open.source.read(container.file);
    if (!data) {
      throw new Error(
        `${container.file} is in ${open.name} and could not be read, so the ` +
          `${container.replacements.length} replaced recording` +
          `${container.replacements.length === 1 ? '' : 's'} in it ` +
          `${container.replacements.length === 1 ? 'has' : 'have'} nowhere to go. The export is ` +
          `refused rather than made without them.`,
      );
    }
    sounds.push({
      name: container.file.split(/[/\\]/).pop() ?? container.file,
      data,
      replacements: [...container.replacements],
    });
  }

  const declared: string[] = [];
  const clusters: Array<{ name: string; label: string; data: Uint8Array }> = [];
  for (const cluster of open.resources.clusterFiles) {
    declared.push(cluster.name);
    if (!cluster.file) continue;
    const data = await open.source.read(cluster.file);
    if (!data) continue;
    clusters.push({ name: cluster.name, label: cluster.name, data });
  }
  return {
    indexFile: open.resources.indexFiles.inf,
    index: resourceTab,
    clusters,
    resourceTab,
    declared,
    effects: replaced.effects,
    ...(sounds.length > 0 ? { sounds } : {}),
  };
}

async function doSave(): Promise<void> {
  if (!folder && canSaveInPlace()) folder = await chooseFolder();

  saveButton.disabled = true;
  try {
    const result = await save(state.current, folder, allowCode, await saveOptions());
    if (result.errors.length > 0) {
      await showAlert(
        `The project was saved, but the game did not compile:\n\n${result.errors.join('\n')}`,
        { title: 'Saved, but it did not compile' },
      );
    }
  } catch (error) {
    await showAlert(error instanceof Error ? error.message : String(error), {
      title: 'Could not save',
    });
  } finally {
    saveButton.disabled = false;
    renderStatus();
  }
}

async function doExportGame(): Promise<void> {
  const result = await exportGameOnly(state.current, allowCode, await saveOptions());
  if (result.errors.length > 0) {
    await showAlert(`Cannot export yet:\n\n${result.errors.join('\n')}`, {
      title: 'Cannot export yet',
    });
  }
}

async function doPlay(): Promise<void> {
  const family = familySurface();
  if (family) {
    const problems = family.play
      ? await family.play()
      : [`Playing a ${describeTarget(state.current.target)} project from the editor is not built.`];
    if (problems.length > 0) {
      await showAlert(`Cannot play yet:\n\n${problems.join('\n')}`, { title: 'Cannot play yet' });
    }
    return;
  }

  // The room on screen, not the game's start room: pressing Play in an editor
  // means "show me this".
  const problems = await play.start(playableStart(state.current, state.currentRoom), allowCode);
  if (problems.length > 0) {
    await showAlert(`Cannot play yet:\n\n${problems.join('\n')}`, { title: 'Cannot play yet' });
  }
}

/**
 * Plays the AGOS game the project currently describes.
 *
 * Rebuilt and then loaded, rather than compiled: ADR 0030's export *is* the
 * build for this family, so Play runs exactly the pair of files Save would
 * write — which is what makes the preview evidence about the game rather than
 * about a second code path.
 *
 * It starts where the game starts. The SCUMM Play button starts in the room on
 * screen because an editor's Play means "show me this", and that trick needs a
 * room list and a walk box to stand in; an AGOS project has neither, and
 * inventing a start would be Play fighting the game rather than starting it.
 */
async function playAgos(): Promise<string[]> {
  const built = exportAgosFiles(state.current, agosFolder?.archive);
  if (built.errors.length > 0) return built.errors;

  /*
   * The rebuilt pair in memory, the interpreter beside it, and the speech
   * listed rather than copied.
   *
   * The interpreter is why the preview draws the game's own words at all: AGOS
   * keeps its font in the executable rather than in the data (ADR 0032). The
   * speech names are why it runs as the release it is: `agosDetect` reads the
   * release kind off the file names, and a preview with none of them runs
   * Simon 1's talkie as the floppy game.
   */
  const source = agosPreviewSource({
    inMemory: built.files,
    support: agosFolder?.support ?? [],
    lazyNames: agosFolder?.speechNames ?? [],
    read: (name) => agosFolder?.read(name) ?? Promise.resolve(null),
  });

  try {
    const engine = await loadAdventureEngine(source, {
      onLog: (message) => console.debug(`[agos] ${message}`),
    });
    return play.startEngine(engine, [
      `Rebuilt ${built.files.map((file) => file.name).join(' and ')} from the project.`,
    ]);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Plays the Broken Sword game the project currently describes.
 *
 * Built and then loaded, the way `playAgos` is and for the same reason: this
 * family's export *is* its build, so Play runs exactly the install Save would
 * write. A preview assembled any other way is evidence about a second code
 * path rather than about the game.
 *
 * The rebuilt clusters go in front of the re-supplied folder rather than
 * replacing it (`overlaySource`), because an install is more than the files an
 * export rewrites: the films are still in the folder, still read by range, and
 * still never copied (ADR 0010) — as are the tunes and the speech container an
 * author did not replace anything in, which is all of them in the usual case.
 *
 * It starts where the game starts. The SCUMM Play button opens on the room on
 * screen because an editor's Play means "show me this", and that needs a room
 * list and somewhere to stand; Broken Sword's rooms are entered by its own
 * scripts through a compact nobody here may invent, so starting one would be
 * Play fighting the game.
 */
async function playSword1(): Promise<string[]> {
  const open = sword1Folder;
  const sword1 = state.current.sword1;
  if (!open || !sword1) {
    return [
      'Open the game folder first — Play runs the install this project exports, and the ' +
        'clusters it is built from are read from the folder rather than kept in the project ' +
        '(ADR 0010).',
    ];
  }
  try {
    // Inside the try, because gathering the source is now a step that can
    // refuse: a replaced line of speech with no container to write it into is
    // a sentence to show rather than an exception to escape.
    const source = await sword1ExportSource();
    if (!source) return [`No \`swordres.rif\` could be read out of ${open.name}.`];

    const built = exportSword1Game(source, sword1);
    const engine = await loadAdventureEngine(overlaySource(open.source, built.files), {
      onLog: (message) => console.debug(`[sword1] ${message}`),
    });
    return play.startEngine(engine, [
      `Rebuilt ${built.files.length} files from the project: ` +
        `${built.rewritten.length} resources rewritten, ${built.copied} copied.`,
      ...(built.speech && built.speech.replaced.length > 0
        ? [`${built.speech.file}: ${built.speech.replaced.length} speech line(s) rewritten.`]
        : []),
      ...(built.music.length > 0 ? [`Tunes rewritten: ${built.music.join(', ')}.`] : []),
      ...(built.missing.length > 0
        ? [`Carried through unchanged: ${built.missing.join(', ')} — not in this folder.`]
        : []),
    ]);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/**
 * Plays the SCI game the project currently describes.
 *
 * Packed and then loaded, the way `playAgos` and both Broken Swords are, and
 * for the same reason: this family's export *is* its build, so Play runs
 * exactly the install Save would write. A preview assembled any other way is
 * evidence about a second code path rather than about the game.
 *
 * The packed map and Volume go in front of the re-supplied folder
 * (`overlaySource`) rather than replacing it, because an install is more than
 * the files an export rewrites — the speech, the music and the films are still
 * in the folder, still read by offset, and still never copied (ADR 0010, ADR
 * 0021).
 *
 * **It starts where the game starts.** The SCUMM Play button opens on the room
 * on screen because an editor's Play means "show me this", and that trick needs
 * a room list and somewhere to stand. A SCI room is entered by the game's own
 * scripts — `RoomObj`'s `newRoom` running against state those scripts built —
 * so there is no room number this could hand the interpreter that would mean
 * anything, and inventing one would be Play fighting the game rather than
 * starting it. That is the argument `playSword1` already makes, against a
 * different mechanism for the same conclusion.
 */
async function playSci(): Promise<string[]> {
  const open = sciFolder;
  const sci = state.current.sci;
  if (!open || !sci) {
    return [
      'Open the game folder first — Play runs the install this project exports, and which ' +
        'container that install is packed into is read from the folder rather than kept in ' +
        'the project (ADR 0010, ADR 0020).',
    ];
  }

  const built = exportSciGame(sci);
  if (built.problems.length > 0) return built.problems;

  // The carried Volumes are named and not copied here, which is the one place
  // Play and Save differ. Save writes a zip an author takes away, so it has to
  // contain the speech; Play reads it out of the folder underneath the overlay,
  // where it already is.
  const packed = packSciGame(built.resources, {
    mapVersion: open.game.mapVersion,
    layout: open.game.layout,
  });
  if (packed.refused.length > 0) return [...packed.refused];

  try {
    const engine = await loadAdventureEngine(overlaySource(open.source, packed.files), {
      onLog: (message) => console.debug(`[sci] ${message}`),
    });
    return play.startEngine(engine, [
      `Packed ${packed.resourceCount} resources into ${packed.mapFile} and ` +
        `${packed.volumeFile}: ${built.rebuilt.length} scripts rebuilt, ` +
        `${built.recomposed.length} Pictures recomposed.`,
      `Read from ${open.name} underneath: ${open.carriedNames.join(', ') || 'no audio Volumes'}.`,
    ]);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

/** The same for Broken Sword II, against its own index and its own clusters. */
async function playSword2(): Promise<string[]> {
  const open = sword2Folder;
  const sword2 = state.current.sword2;
  if (!open || !sword2) {
    return [
      'Open the game folder first — Play runs the install this project exports, and the ' +
        'clusters it is built from are read from the folder rather than kept in the project ' +
        '(ADR 0010).',
    ];
  }
  const source = await sword2ExportSource();
  if (!source?.resourceTab || !source.declared) {
    return [`No \`resource.tab\` could be read out of ${open.name}.`];
  }

  try {
    const built = exportSword2Game(
      { declared: source.declared, clusters: source.clusters, resourceTab: source.resourceTab },
      sword2,
    );
    const engine = await loadAdventureEngine(overlaySource(open.source, built.files), {
      onLog: (message) => console.debug(`[sword2] ${message}`),
    });
    return play.startEngine(engine, [
      `Rebuilt ${built.files.length} clusters from the project: ` +
        `${built.rewritten.length} resources rewritten, ${built.copied} copied.`,
      ...(built.missing.length > 0
        ? [`Declared and not in this folder: ${built.missing.join(', ')}.`]
        : []),
    ]);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

async function doImport(): Promise<void> {
  const file = importInput.files?.[0];
  if (!file) return;
  importInput.value = '';

  try {
    const project = migrate(JSON.parse(await file.text()));

    // Custom code in an imported project is somebody else's JavaScript. It runs
    // only if the author says so, after being told what it means.
    const hasCode =
      project.rooms.some(
        (room) =>
          containsCode(room.onEnter) ||
          containsCode(room.onExit) ||
          room.objects.some(
            (object) =>
              containsCode(object.otherwise) ||
              object.handlers.some((handler) => containsCode(handler.actions)),
          ),
      ) || project.scripts.some((script) => containsCode(script.actions));

    if (hasCode) {
      allowCode = await showConfirm(
        'This project contains custom code actions, which are JavaScript written ' +
          'by whoever made it. Running them gives that code the same access as ' +
          'the editor itself.\n\nOnly allow this if you trust the source.\n\n' +
          'Allow custom code to run?',
        {
          title: 'This project contains custom code',
          acceptLabel: 'Allow custom code',
          cancelLabel: 'Open without it',
          // The one dialog where the wrong press hands somebody else's
          // JavaScript the editor's own access, so it opens on the refusal.
          defaultButton: 'cancel',
        },
      );
    } else {
      allowCode = true;
    }

    state.replaceProject(project);
    projectName.value = project.name;
  } catch (error) {
    await showAlert(`Could not open that file: ${error instanceof Error ? error.message : error}`, {
      title: 'Could not open that file',
    });
  }
}

// --------------------------------------------------------------------- wire --

function renderAll(): void {
  undoButton.disabled = !state.canUndo;
  redoButton.disabled = !state.canRedo;
  if (projectName.value !== state.current.name) projectName.value = state.current.name;

  const surface = familySurface();
  if (surface) {
    surface.mount();
    renderStatus();
    return;
  }

  renderTabs();
  applyMode();
  renderSidebar();

  if (mode === 'room') {
    renderToolbar();
    renderPalette();
    canvas.render();
  } else if (mode === 'sprite') {
    renderSpriteToolbar();
    renderSpritePalette();
    renderSpriteStrip();
    sprite.render();
  } else {
    renderObjectToolbar();
    renderObjectPalette();
    renderObjectStrip();
    objectArt.render();
  }

  renderInspector();
  renderStatus();
}

state.subscribe(renderAll);

window.addEventListener('keydown', (event) => {
  if (play.isRunning) return;
  const meta = event.ctrlKey || event.metaKey;
  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) state.redo();
    else state.undo();
  }
  if (meta && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void doSave();
  }
});

// Best-effort flush; browsers do not guarantee async work during unload.
window.addEventListener('beforeunload', (event) => {
  state.flush();
  if (hasUnexportedChanges()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

renderAll();
