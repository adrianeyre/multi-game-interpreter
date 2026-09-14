/**
 * The AGOS editing surface.
 *
 * The editor branches on Engine family exactly once, at the mount point in
 * `main.ts`, and this is one arm of that branch. An AGOS project holds four
 * things and none of them is a SCUMM `Action`, an AGI Logic or a SCI class:
 * **Subroutines** as instruction lists, the **item tree**, the **pooled
 * strings** every Subroutine indexes into (ADR 0029), and the **art** that
 * lives in the zones beside `GAMEPC` rather than in it.
 *
 * ## It is the SCUMM editor's shape, over AGOS's nouns
 *
 * This used to be a list beside a detail pane, mounted into the middle of a
 * shell whose other two panes were emptied for it. That was a smaller surface
 * than the SCUMM one in ways that had nothing to do with AGOS: no collapsible
 * counted sidebar, no tabs, no properties pane, no tools, no keyboard on the
 * canvas, and no announcements. None of those are about rooms and actors — they
 * are how this editor works — so the surface now fills all three panes and
 * offers the same affordances the SCUMM one does, over items, strings,
 * Subroutines and zone art.
 *
 * The pieces that are literally the same are literally shared: `shell.ts` for
 * the accordion and the list row, `audioSection.ts` for Audio, `a11yWidgets.ts`
 * for the tablist, `canvasKeyboard.ts` for the drawing cursor. A second copy of
 * any of them would be a second set of ARIA decisions to keep in step.
 *
 * ## What the surface is still shaped around
 *
 * The string pool is the reason this differs from its siblings where it does.
 * An AGI Logic carries its own messages, so an edit's reach is visible by
 * construction; an AGOS string is shared, so the editor has to *show* the reach
 * before the edit rather than after. Every string in the list carries the count
 * of Subroutines that would change with it, and the properties pane names them.
 *
 * The other is where the pixels are. An AGOS image is not in `GAMEPC`, so the
 * art tab can only draw once the game folder has been offered again — ADR 0034's
 * re-supply, with ADR 0034's teeth. Until it has, the tab says so rather than
 * showing an empty canvas, which reads as a game with no art.
 */

import type { AgosProject, Project } from '../../authoring/project.js';
import { formatSubroutineBlock } from '../../authoring/agos/disassemble.js';
import {
  addString,
  editItemChildValue,
  editString,
  operandWithValue,
  renameItem,
  reparentItem,
  setItemState,
} from '../../authoring/agos/edits.js';
import type { AgosImage } from '../../authoring/agos/images.js';
import { bitmapOf, paintedFrom, type PaintedImage } from '../../authoring/agos/paint.js';
import type { IndexedBitmap } from '../../engine/agos/gfx/agosImage.js';
import { encodeSpriteRefusal } from '../../engine/agos/gfx/agosImage.js';
import { DRAW_FLAGS } from '../../engine/agos/gfx/vgaImages.js';
import {
  defaultOperandsFor,
  type AgosInstruction,
  type AgosOperand,
} from '../../engine/agos/script/subroutines.js';
import { OPCODE_ARG_TABLES } from '../../engine/agos/script/opcodeArgTables.js';
import { hasWideOpcodes, opcodeTableFor } from '../../engine/agos/agosVersion.js';
import type { AgosTarget, AgosVersion } from '../../engine/agos/agosVersion.js';
import { itemIdOf } from '../../engine/agos/world/itemTree.js';
import { announce, describeColour } from '../../ui/a11y.js';
import { groupItem, rovingGroup } from '../a11yWidgets.js';
import { accordion, listOf, listRow, OpenSections } from '../shell.js';
import type { AudioSection } from '../audioSection.js';
import { alert as showAlert, ask } from '../dialog.js';
import { decodeImageFile, pickImageFile, quantise } from '../importImage.js';
import {
  AGOS_TOOLS,
  AgosImageCanvas,
  cssFor,
  greyPalette,
  inkFor,
  paintBitmap,
  type AgosPalette,
} from './AgosImageCanvas.js';
import { writePng } from '../imageExport.js';
import {
  agosImageFilename,
  agosItemIconFilename,
  agosRoomFilename,
  renderAgosImage,
  renderIndexedImage,
} from './imageFiles.js';
import { readVgaFile } from '../../engine/agos/gfx/vgaFile.js';
import { countVgaPaletteBanks, readVgaPaletteHalf } from '../../engine/agos/gfx/vgaPalette.js';
import { editGamePc, stringsOf } from './gamePc.js';
import { decodeZoneImage, describeZoneAccess, type ZoneReader } from './zonePixels.js';
import { renderRoomBackdrop, roomBackdropUrl, type RoomBackdrop } from './roomBackdrop.js';
import {
  decodeItemIcon,
  iconsAreKnownFor,
  interfacePalette,
  itemIconNumber,
  type ItemIcon,
} from './itemIcons.js';
import type { AgosRoom } from '../../authoring/agos/rooms.js';
import { zoneLayoutFor } from '../../engine/agos/resource/zoneSource.js';
import { STORAGE_KEYS } from '../../ui/storageKeys.js';

/** Distinguishes one surface's ids from another's, for two on a page. */
let surfaceCount = 0;

/**
 * What the right-hand column's one save control is offering.
 *
 * A refusal is a sentence rather than a boolean because the control shows it:
 * "there is nothing to save" and "the folder this needs is not open" are
 * different problems with different fixes, and a disabled button that says
 * neither is the state that was reported.
 */
type SaveOffer =
  | { readonly what: string; readonly filename: string; run(): Promise<void> }
  | { readonly why: string };

export interface AgosEditorOptions {
  project: () => Project;
  update: (mutate: (project: Project) => void) => void;
  /**
   * A zone's pixel bytes, fetched when an image is opened.
   *
   * A callback rather than a field on the Project, and the reason is the one
   * `authoring/agos/images.ts` gives for the Project carrying metadata only: a
   * Project is serialised, and a game's art runs to megabytes, so embedding
   * every zone would make saving a project a copy of the game.
   *
   * So the Project says *what* art exists and this says *where the bytes are*.
   * Optional, because a surface can list a game's art without ever being asked
   * to draw one — and when it is absent the art tab says so, and offers
   * `openGameFolder` (ADR 0034), rather than showing an empty canvas that reads
   * as an image that is blank.
   */
  readZonePixels?: ZoneReader;
  /**
   * A zone's *script* bytes, which is where its colours are.
   *
   * A separate reader from the pixels because they are separate resources, and
   * the surface wants them for different reasons: the pixels are the picture
   * and the scripts hold the palette banks at offset 6. Optional on the same
   * terms — a surface with no folder behind it shows an image in greys, which
   * is honest rather than a guessed palette.
   */
  readZoneScripts?: ZoneReader;
  /**
   * Offers the author the game folder again, and returns a reader when they
   * give it.
   *
   * ADR 0034's route, as a callback for the same reason `readZonePixels` is
   * one: the shell hands this editor a Project through IndexedDB, so nothing
   * live crosses the boundary and the surface cannot open a folder for itself
   * without knowing about the shell's file plumbing.
   */
  openGameFolder?: () => Promise<
    { pixels: ZoneReader; scripts: ZoneReader; name?: string; icons?: Uint8Array | null } | string
  >;
  /**
   * `ICON.DAT` out of the open folder, where the folder has one.
   *
   * A third reader beside the two zone ones, on the same terms and for the same
   * reason (ADR 0034): an item's picture lives beside the game rather than in
   * the Project, so the Project says which items have one and this says where
   * the bytes are. Read live rather than passed once, so a folder opened
   * elsewhere in the shell reaches this surface without it being told.
   *
   * Null or undefined is the ordinary case rather than an error — Elvira and
   * Waxworks ship no such file, and a folder that lost it is a folder whose
   * items simply have no pictures to offer.
   */
  readIconFile?: () => Uint8Array | null | undefined;
  /**
   * What the open game folder is called, when anything knows.
   *
   * The right column names the folder its art is being read out of, because
   * "navigate to the folder where the files are kept" is a gesture an author
   * can get wrong — and a surface that then draws a game's art without saying
   * *which* folder it came from gives them nothing to check it against.
   *
   * A live accessor rather than a string, because the shell owns the folder:
   * the same folder is opened for an export as for the art tab, so one opened
   * elsewhere in the shell has to show up here without this surface being
   * told. Undefined where nothing knows — a bare mount in a test — and the
   * name `openGameFolder` returned is used then.
   *
   * A **name**, not a path: the File System Access API deliberately never
   * reveals where on the disk a chosen folder sits, so the folder's own name is
   * the whole of what a browser will say, and the bar says as much rather than
   * implying a truncated path.
   */
  folderName?: () => string | null | undefined;
  /**
   * Whether painting is offered.
   *
   * Painting needs the *read* callback to show an image and nothing else: an
   * edit is recorded into the Project as intent (ADR 0030), so there is no
   * second channel to supply. This exists only so a surface can be mounted
   * deliberately read-only — a viewer rather than an editor.
   */
  allowPainting?: boolean;
  /**
   * The shell's sidebar, when this is mounted in the app.
   *
   * Absent in a test, where the whole surface is one element to query. When it
   * is absent the panes stay inside `element`, which is why a test can find a
   * sidebar row without the app's chrome around it.
   */
  sidebar?: HTMLElement;
  /** The shell's properties pane, on the same terms as `sidebar`. */
  inspector?: HTMLElement;
  /**
   * The Audio section, which is the shell's rather than this surface's.
   *
   * A project's `audio` array is family-neutral — a list of sound files an
   * author brought in, not a SCUMM resource — so the surface over it is shared
   * and the shell owns the one instance. Absent in a test for the same reason
   * the panes are.
   */
  audio?: AudioSection;
}

/** Which centre view is showing. The AGOS answer to the SCUMM editor's tabs. */
/**
 * How many images the right column lists at once.
 *
 * A page rather than the lot, and the reason is a count taken from the retail
 * games: Simon 1's zone 8 holds 1,092 images and Simon 2's zone 73 holds 1,828.
 * A row each, with a decoded thumbnail in it, is thousands of elements and
 * thousands of PNG encodes built again on every selection change. Forty-eight
 * is about two screens of scrolling in a side column, and the rest is a click.
 */
const IMAGES_PER_PAGE = 48;

/**
 * Which control in the image list the keyboard was in before a rebuild.
 *
 * `null` is "neither", which is the case that must not steal focus from
 * wherever else on the page it actually is.
 */
type StripFocus = 'row' | 'page' | null;

/**
 * The zooms offered, and why they run so high.
 *
 * An AGOS image is small: the median entry is 32 by 18 pixels in Simon 1 and
 * 32 by 17 in Simon 2. So 16× — the old ceiling — is a 512-pixel box for a
 * typical sprite, and the steps above it are the difference between seeing an
 * image and seeing that there is one.
 */
const ZOOMS = [1, 2, 4, 8, 12, 16, 24, 32] as const;

/** The zoom a surface starts at, and falls back to when there is no layout. */
const DEFAULT_ZOOM = 8;

/** The canvas column's own padding, which "Fit" must not try to draw into. */
const FIT_PADDING = 32;

type Tab = 'items' | 'rooms' | 'art' | 'script' | 'text';

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ['items', 'Items'],
  ['rooms', 'Rooms'],
  ['art', 'Art'],
  ['script', 'Script'],
  ['text', 'Text'],
];

type Selection =
  | { kind: 'item'; id: number }
  | { kind: 'string'; index: number }
  | { kind: 'subroutine'; id: number }
  | { kind: 'zone'; zone: number }
  | { kind: 'image'; zone: number; id: number }
  | { kind: 'room'; item: number };

type SectionName = 'items' | 'strings' | 'rooms' | 'art' | 'subroutines' | 'audio';

/**
 * Which sidebar sections are open, remembered separately from the SCUMM one.
 *
 * Its own key because they are its own sections: an author who collapsed
 * Subroutines while editing Simon has not asked for Rooms to close in a SCUMM
 * game they open next.
 */
const SECTIONS_KEY = STORAGE_KEYS.editorSectionsAgos;

export class AgosEditor {
  /**
   * The surface's own root.
   *
   * Holds whichever panes the shell did not take. Mounted in the app it holds
   * the centre alone; constructed bare — which is what a test does — it holds
   * all three, so the whole surface is one element to query.
   */
  readonly element = document.createElement('div');

  private readonly sidebarPane = document.createElement('div');
  private readonly centrePane = document.createElement('div');
  private readonly inspectorPane = document.createElement('div');

  private readonly tabs = document.createElement('div');
  private readonly toolbar = document.createElement('div');
  private readonly palette = document.createElement('div');
  private readonly canvasWrap = document.createElement('div');
  private readonly strip = document.createElement('div');
  private readonly listing = document.createElement('div');
  /**
   * Where a room's backdrop is shown.
   *
   * An `<img>` in a box of its own rather than the art canvas, and that is the
   * shape of the thing rather than a shortcut. A backdrop is eight-bit pixels
   * against a 256-colour palette its own script loads, where the Art tab's
   * canvas holds four-bit indices; and it is script *output* composed from
   * several images, so there is no one resource a paint could be written back
   * to. A viewer is what a room actually is here — see `roomBackdrop.ts`.
   */
  private readonly roomWrap = document.createElement('div');
  private readonly roomShot = document.createElement('img');
  private readonly roomNote = document.createElement('p');

  private readonly sections = new OpenSections<SectionName>(SECTIONS_KEY, [
    'items',
    'strings',
    'rooms',
    'art',
    'subroutines',
  ]);

  /** This surface's number, so the ids it mints are its own. */
  private readonly instance = (surfaceCount += 1);

  private selection: Selection = { kind: 'item', id: 2 };
  private tab: Tab = 'items';

  /** The art canvas, built once: it holds a working bitmap and a cursor. */
  private readonly canvas: AgosImageCanvas;

  /** A reader offered by the shell, or one the author opened a folder for. */
  private zones: ZoneReader | undefined;
  /** The same folder's script resources, which is where a zone's colours are. */
  private zoneScripts: ZoneReader | undefined;
  /**
   * `ICON.DAT` from a folder this surface opened for itself.
   *
   * The option's accessor wins where there is one, for the reason
   * `currentFolderName` gives: the shell owns the folder, and it can change
   * without this surface opening anything.
   */
  private openedIconFile: Uint8Array | null = null;
  /**
   * Which of the open zone's palette banks the art is shown in.
   *
   * A person's choice rather than a fact the editor can look up: a bank is
   * chosen by the script that draws an image, and this surface has no script to
   * ask. Bank 0's first half is the default because that is what a room's own
   * `SET_PALETTE` loads at index zero, so a backdrop is right without touching
   * anything — and it is a *default* rather than an answer, which is why the
   * chooser is on the toolbar beside the tools.
   *
   * Kept per zone, because a bank number means nothing across two of them.
   */
  private paletteBank = new Map<number, { bank: number; half: 0 | 1 }>();
  /** Why the last attempt to open a folder failed, shown on the art tab. */
  private folderProblem: string | null = null;
  /**
   * The folder this surface opened for itself, for a mount whose shell has no
   * `folderName` to ask. The accessor wins where there is one, because the
   * shell's folder can change without this surface opening anything.
   */
  private openedFolderName: string | null = null;
  /**
   * Which page of a zone's images the right column is showing, and of which
   * zone.
   *
   * Paged rather than listed whole, and the reason is a count: Simon 1's zone 8
   * holds 1,092 images and Simon 2's zone 73 holds 1,828. One row each, with a
   * decoded thumbnail in it, is thousands of elements and thousands of PNG
   * encodes on every selection change — so a page is what gets built and the
   * rest is a click away.
   *
   * The zone is kept beside the page because a page number means nothing across
   * two zones: opening zone 3 at page 20 would show an empty list for a zone
   * that has plenty of art.
   */
  private stripPage = 0;
  private stripZone: number | null = null;
  /**
   * The zoom a person asked for, which is not always a number.
   *
   * "Fit" is a function of the image and the space the canvas column has, so it
   * cannot be stored as a scale — it is recomputed each time an image is drawn.
   * Kept here rather than on the canvas because the canvas holds the scale it
   * was last given and has no idea one of them was a request.
   */
  private zoomChoice: number | 'fit' = DEFAULT_ZOOM;
  /** The status line under the canvas, for what a gesture just did. */
  private readonly canvasStatus = document.createElement('p');
  /** Where the pointer is on the image, which is a different kind of fact. */
  private readonly canvasCoords = document.createElement('span');

  constructor(private readonly options: AgosEditorOptions) {
    this.element.className = 'agos-editor';
    this.sidebarPane.className = 'agos-sidebar';
    this.centrePane.className = 'agos-centre';
    this.inspectorPane.className = 'agos-inspector';

    this.tabs.className = 'tabs';
    this.toolbar.className = 'toolbar';
    this.palette.className = 'palette';
    this.canvasWrap.className = 'canvas-wrap';
    // A vertical list in the right column rather than the SCUMM surface's
    // horizontal strip under the canvas. See `renderStrip` for the measurement
    // that moved it.
    this.strip.className = 'agos-art-list';
    this.listing.className = 'agos-listing-pane';
    this.roomWrap.className = 'agos-room-wrap';
    this.roomShot.className = 'agos-room-shot';
    this.roomShot.alt = '';
    this.roomNote.className = 'agos-paint-note';
    this.roomNote.setAttribute('role', 'status');
    this.roomWrap.append(this.roomShot, this.roomNote);
    this.canvasStatus.className = 'agos-paint-note';
    this.canvasStatus.setAttribute('role', 'status');
    this.canvasCoords.className = 'coords';
    // A read-out that changes on every mouse move. Announced it would be a
    // stream of numbers with no beginning or end; the keyboard cursor says its
    // position on demand instead, which is the half a screen reader can use.
    this.canvasCoords.setAttribute('aria-hidden', 'true');

    this.zones = options.readZonePixels;
    this.zoneScripts = options.readZoneScripts;

    this.canvas = new AgosImageCanvas({
      onEdit: (bitmap) => this.recordPaint(bitmap),
      onColourPicked: () => this.renderPalette(),
      onHover: (where) => {
        this.canvasCoords.textContent = where;
      },
      onSay: (message) => {
        this.canvasStatus.textContent = message;
        announce(message);
      },
    });
    // The description the canvas points at with `aria-describedby` has to be in
    // the document for the reference to resolve, and it is visually hidden
    // because a paragraph of key bindings under the artwork is noise for
    // everyone who is not looking for it.
    this.canvasWrap.append(
      this.canvas.element,
      this.canvas.help,
      this.canvasCoords,
      this.canvasStatus,
    );

    this.centrePane.append(
      this.tabs,
      this.toolbar,
      this.palette,
      this.canvasWrap,
      this.roomWrap,
      this.listing,
    );

    this.render();
  }

  private get agos(): AgosProject | undefined {
    return this.options.project().agos;
  }

  render(): void {
    this.mountPanes();
    this.renderSidebar();
    this.renderTabs();
    this.applyTab();
    this.renderInspector();
  }

  /**
   * Puts each pane where it belongs, once.
   *
   * Checked rather than done unconditionally: `replaceChildren` on the shell's
   * sidebar would discard whatever else the shell put there, and re-parenting a
   * pane on every render would move the element out from under a focused
   * control inside it.
   */
  private mountPanes(): void {
    const sidebarHost = this.options.sidebar ?? this.element;
    if (this.sidebarPane.parentElement !== sidebarHost) {
      // Replace rather than append: coming from a SCUMM project the shell's
      // sidebar still holds Rooms and Actors, and appending under them would
      // show one project's contents beneath another's.
      if (sidebarHost === this.element) sidebarHost.appendChild(this.sidebarPane);
      else sidebarHost.replaceChildren(this.sidebarPane);
    }

    if (this.centrePane.parentElement !== this.element) this.element.appendChild(this.centrePane);

    const inspectorHost = this.options.inspector ?? this.element;
    if (this.inspectorPane.parentElement !== inspectorHost) {
      if (inspectorHost === this.element) inspectorHost.appendChild(this.inspectorPane);
      else inspectorHost.replaceChildren(this.inspectorPane);
    }
  }

  /** Selecting anything brings the view that shows it, the way the SCUMM
   * sidebar does: picking something means wanting to look at it. */
  private select(selection: Selection, tab: Tab, said: string): void {
    this.selection = selection;
    this.tab = tab;
    this.showPageFor(selection);
    this.render();
    announce(said);
  }

  /**
   * Keeps the image list on the page holding whatever was just picked.
   *
   * Done here, where a selection changes, rather than while rendering: a render
   * that corrected the page would undo the pager the moment it was used,
   * because turning a page is itself a render.
   */
  private showPageFor(selection: Selection): void {
    const zone = selection.kind === 'zone' || selection.kind === 'image' ? selection.zone : null;
    if (zone !== this.stripZone) {
      this.stripZone = zone;
      this.stripPage = 0;
    }
    if (selection.kind !== 'image') return;
    // An image can be opened from the zone's own table as well as from this
    // list, and landing on page one of forty with the open image nowhere on it
    // reads as a list that has lost track of the selection.
    const images = this.agos?.art?.images.filter((each) => each.zone === selection.zone) ?? [];
    const at = images.findIndex((each) => each.id === selection.id);
    if (at >= 0) this.stripPage = Math.floor(at / IMAGES_PER_PAGE);
  }

  // ------------------------------------------------------------- sidebar --

  private renderSidebar(): void {
    this.sidebarPane.replaceChildren();
    const agos = this.agos;
    if (!agos) return;

    // The Unrecovered count, and how the Version was established beside it —
    // ADR 0029 is explicit that the count means nothing without the second,
    // because a game decoded under the wrong Version can still score zero.
    const summary = document.createElement('p');
    summary.className = 'agos-summary';
    summary.textContent = agos.editable.editable
      ? `${agos.items.length} items, ${agos.subroutines.subroutines.length} subroutines. ` +
        `Unrecovered: ${agos.editable.unrecovered}.`
      : `Read-only: ${agos.editable.reasons.join('; ')}.`;
    summary.classList.toggle('agos-summary-warning', !agos.editable.editable);
    this.sidebarPane.appendChild(summary);

    const provenance = document.createElement('p');
    provenance.className = 'agos-provenance';
    provenance.textContent = `Version identified by ${agos.identification}`;
    this.sidebarPane.appendChild(provenance);

    this.sidebarPane.appendChild(
      this.section('items', 'Items', agos.items.length, (body) => this.fillItems(agos, body)),
    );

    const strings = this.strings();
    this.sidebarPane.appendChild(
      this.section('strings', 'Strings', strings.length, (body) => this.fillStrings(strings, body)),
    );

    // Before Art, because a room is what an author is looking for and a zone is
    // where it happens to be kept: "Rooms" is the game's own noun and "Zone 96"
    // is the archive's.
    const rooms = agos.rooms?.rooms ?? [];
    this.sidebarPane.appendChild(
      this.section('rooms', 'Rooms', rooms.length, (body) => this.fillRooms(agos, body)),
    );

    const art = agos.art;
    this.sidebarPane.appendChild(
      this.section('art', 'Art', art?.zones.length ?? 0, (body) => this.fillArt(agos, body)),
    );

    this.sidebarPane.appendChild(
      this.section('subroutines', 'Subroutines', agos.subroutines.subroutines.length, (body) =>
        this.fillSubroutines(agos, body),
      ),
    );

    const audio = this.options.audio;
    if (audio) {
      // The shell's section, wired to this surface's sidebar rather than the
      // SCUMM one's: an import made here should open the section it landed in.
      audio.onChanged = () => this.renderSidebar();
      audio.onReveal = () => this.sections.open('audio');
      this.sidebarPane.appendChild(
        this.section('audio', 'Audio', audio.count, (body) => audio.render(body)),
      );
    }
  }

  private section(
    name: SectionName,
    title: string,
    count: number,
    fill: (body: HTMLElement) => void,
  ): HTMLElement {
    return accordion({
      name,
      title,
      count,
      sections: this.sections,
      idPrefix: 'agos-accordion',
      fill,
      onToggle: () => this.renderSidebar(),
    });
  }

  private fillItems(agos: AgosProject, body: HTMLElement): void {
    const rows = agos.items.map((item, index) => {
      const id = index + 2;
      const noun = this.strings()[item.noun];
      return listRow({
        label: noun ? `${id} — ${noun}` : `Item ${id}`,
        selected: this.selection.kind === 'item' && this.selection.id === id,
        onSelect: () => this.select({ kind: 'item', id }, 'items', `Item ${id}.`),
      });
    });
    body.appendChild(listOf(rows));

    const hint = document.createElement('p');
    hint.className = 'muted';
    // Said rather than offered as a button: an item's number is its address in
    // the file, so adding one relays every item after it and every operand that
    // pointed at one — which is a different operation from the ones here.
    hint.textContent =
      'An item’s number is its place in the file, so items are moved and renamed rather ' +
      'than added or removed. Moving one to item 0 is how a game destroys something.';
    body.appendChild(hint);
  }

  private fillStrings(strings: readonly string[], body: HTMLElement): void {
    const rows = strings.map((text, index) => {
      const users = this.usersOf(index).length;
      return listRow({
        label: `${index}: ${text}`,
        // The reach, in the list rather than only in the properties pane: an
        // author choosing what to edit should see it before choosing.
        note: users === 0 ? undefined : `${users} subroutine${users === 1 ? '' : 's'}`,
        selected: this.selection.kind === 'string' && this.selection.index === index,
        onSelect: () => this.select({ kind: 'string', index }, 'text', `String ${index}.`),
      });
    });
    body.appendChild(listOf(rows));
    body.appendChild(
      this.button('+ String', () => void this.doAddString(), 'Append a string to the pool'),
    );
  }

  private fillArt(agos: AgosProject, body: HTMLElement): void {
    const art = agos.art;
    if (!art) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'This project was built without the game’s resource archive.';
      body.appendChild(none);
      return;
    }

    const rows = art.zones.map((zone) => {
      const count = art.images.filter((each) => each.zone === zone).length;
      const unreadable = art.unreadableZones.includes(zone);
      return listRow({
        label: `Zone ${zone}`,
        note: unreadable ? 'unreadable' : `${count} image${count === 1 ? '' : 's'}`,
        selected:
          (this.selection.kind === 'zone' || this.selection.kind === 'image') &&
          this.selection.zone === zone,
        onSelect: () => this.select({ kind: 'zone', zone }, 'art', `Zone ${zone}.`),
      });
    });
    body.appendChild(listOf(rows));
  }

  /**
   * The rooms, by the name the game gives them.
   *
   * A room is an item, so it has a noun in the string pool and that is what an
   * author knows it by — "Zone 96" is where its picture is kept. The item
   * number goes in the note beside it, because two rooms can share a word.
   */
  private fillRooms(agos: AgosProject, body: HTMLElement): void {
    const rooms = agos.rooms?.rooms ?? [];
    if (rooms.length === 0) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = 'This game has no items carrying a room record.';
      body.appendChild(none);
      return;
    }

    const strings = this.strings();
    const rows = rooms.map((room) => {
      const item = agos.items[room.item - 2];
      const name = (item && strings[item.noun]) || `Item ${room.item}`;
      return listRow({
        label: name,
        /*
         * The item number, and where its picture is.
         *
         * The number always, because two rooms can share a word — the games
         * have several "corridor"s — and the name alone would make them one
         * row repeated. The zone after it is what the editor can say about the
         * room without drawing it, or that there is no picture to find.
         */
        note: `item ${room.item} · ${room.zone === undefined ? 'no picture' : `zone ${room.zone}`}`,
        selected: this.selection.kind === 'room' && this.selection.item === room.item,
        onSelect: () => this.select({ kind: 'room', item: room.item }, 'rooms', `${name}.`),
      });
    });
    body.appendChild(listOf(rows));
  }

  private fillSubroutines(agos: AgosProject, body: HTMLElement): void {
    const rows = agos.subroutines.subroutines.map((subroutine) => {
      const lines = subroutine.lines.length;
      const label = subroutine.id === 0 ? 'Verb table' : `Subroutine ${subroutine.id}`;
      return listRow({
        label,
        note: `${lines} line${lines === 1 ? '' : 's'}`,
        selected: this.selection.kind === 'subroutine' && this.selection.id === subroutine.id,
        onSelect: () =>
          this.select({ kind: 'subroutine', id: subroutine.id }, 'script', `${label}.`),
      });
    });
    body.appendChild(listOf(rows));
  }

  // ---------------------------------------------------------------- tabs --

  private renderTabs(): void {
    this.tabs.replaceChildren();
    for (const [value, label] of TABS) {
      const element = this.button(label, () => {
        this.tab = value;
        this.render();
        announce(`${label} tab.`);
      });
      element.className = this.tab === value ? 'tab selected' : 'tab';
      // They look like tabs and behave like tabs; without this they are four
      // loose buttons to anything reading the page — no `tablist`, no selected
      // state, and Tab walking through all four rather than the arrows moving
      // between them.
      groupItem(element, {
        role: 'tab',
        selected: this.tab === value,
        label,
        controls: 'agos-centre-area',
      });
      if (value === 'art' && !this.currentZone()) {
        // Art needs a zone; the tab says so rather than showing a blank canvas
        // and leaving the author to work out why.
        element.disabled = true;
        element.setAttribute('aria-label', `${label} — select a zone first`);
      }
      if (value === 'rooms' && this.currentRoom() === null) {
        element.disabled = true;
        element.setAttribute('aria-label', `${label} — select a room first`);
      }
      this.tabs.appendChild(element);
    }
    rovingGroup(this.tabs, { role: 'tablist', label: 'AGOS view', orientation: 'horizontal' });
  }

  private applyTab(): void {
    // Falling back keeps the view valid when the selection has no art behind it.
    if (this.tab === 'art' && !this.currentZone()) this.tab = 'items';
    if (this.tab === 'rooms' && this.currentRoom() === null) this.tab = 'items';
    this.centrePane.id = 'agos-centre-area';

    const art = this.tab === 'art';
    const rooms = this.tab === 'rooms';
    this.toolbar.hidden = !art;
    this.palette.hidden = !art;
    this.canvasWrap.hidden = !art;
    this.roomWrap.hidden = !rooms;
    this.listing.hidden = art || rooms;

    if (art) {
      this.renderArt();
      return;
    }
    if (rooms) {
      this.renderRoom();
      return;
    }
    this.renderListing();
  }

  // -------------------------------------------------------------- listing --

  /** The centre, for every tab that is not art: a reading view of the thing
   * selected, with the editing in the properties pane beside it — which is
   * where the SCUMM editor puts a script too. */
  private renderListing(): void {
    this.listing.replaceChildren();
    const agos = this.agos;
    if (!agos) return;

    switch (this.tab) {
      case 'items':
        this.renderItemTree(agos);
        return;
      case 'script':
        this.renderScript(agos);
        return;
      case 'text':
        this.renderTextTable();
    }
  }

  private renderItemTree(agos: AgosProject): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Item tree';
    this.listing.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      'Where every item sits, and what it is called. Moving an item is the only structural ' +
      'change an AGOS world has — it is how the games themselves make anything happen.';
    this.listing.appendChild(note);

    const table = document.createElement('table');
    table.className = 'agos-art';
    const header = document.createElement('tr');
    for (const label of ['Item', 'Name', 'Parent', 'State', 'Children']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      header.appendChild(cell);
    }
    table.appendChild(header);

    const strings = this.strings();
    const childrenOf = new Map<number, number[]>();
    for (const [index, item] of agos.items.entries()) {
      const parent = itemIdOf(item.parent);
      const kept = childrenOf.get(parent) ?? [];
      kept.push(index + 2);
      childrenOf.set(parent, kept);
    }

    for (const [index, item] of agos.items.entries()) {
      const id = index + 2;
      const row = document.createElement('tr');
      if (this.selection.kind === 'item' && this.selection.id === id) row.className = 'selected';

      const idCell = document.createElement('td');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'agos-open-image';
      open.textContent = String(id);
      open.setAttribute('aria-label', `Open item ${id}`);
      if (this.selection.kind === 'item' && this.selection.id === id) {
        open.setAttribute('aria-current', 'true');
      }
      open.addEventListener('click', () =>
        this.select({ kind: 'item', id }, 'items', `Item ${id}.`),
      );
      idCell.appendChild(open);
      row.appendChild(idCell);

      for (const value of [
        strings[item.noun] ?? '—',
        String(itemIdOf(item.parent)),
        String(item.state),
        (childrenOf.get(id) ?? []).join(', ') || '—',
      ]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    this.listing.appendChild(table);
  }

  private renderScript(agos: AgosProject): void {
    if (this.selection.kind !== 'subroutine') {
      this.listing.appendChild(this.paragraph('Pick a Subroutine to read its listing.'));
      return;
    }
    const id = this.selection.id;
    const subroutine = agos.subroutines.subroutines.find((each) => each.id === id);
    if (!subroutine) return;

    const heading = document.createElement('h2');
    heading.textContent = id === 0 ? 'Verb table' : `Subroutine ${id}`;

    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      'AGOS has no control flow inside a line — a line runs until one of its conditions ' +
      'fails — so this is a listing rather than a reconstruction. Operand values are ' +
      'editable in the properties pane, and instructions can be added and removed: the ' +
      'game bytecode refers to nothing by offset, so nothing has to be renumbered when a ' +
      'line changes length.';

    const listing = document.createElement('pre');
    listing.className = 'agos-listing';
    listing.textContent = formatSubroutineBlock(
      { subroutines: [subroutine], endMarker: agos.subroutines.endMarker },
      this.target(),
    );

    this.listing.append(heading, note, listing);
  }

  private renderTextTable(): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Strings';
    this.listing.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      'One pool, shared. Every Subroutine and every item name indexes into it, so the ' +
      'count beside a string is how many Subroutines an edit would reach.';
    this.listing.appendChild(note);

    const table = document.createElement('table');
    table.className = 'agos-art';
    const header = document.createElement('tr');
    for (const label of ['Index', 'Text', 'Used by']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      header.appendChild(cell);
    }
    table.appendChild(header);

    for (const [index, text] of this.strings().entries()) {
      const users = this.usersOf(index);
      const row = document.createElement('tr');
      if (this.selection.kind === 'string' && this.selection.index === index) {
        row.className = 'selected';
      }

      const idCell = document.createElement('td');
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'agos-open-image';
      open.textContent = String(index);
      open.setAttribute('aria-label', `Open string ${index}`);
      open.addEventListener('click', () =>
        this.select({ kind: 'string', index }, 'text', `String ${index}.`),
      );
      idCell.appendChild(open);
      row.appendChild(idCell);

      for (const value of [text, users.length === 0 ? '—' : users.join(', ')]) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    this.listing.appendChild(table);
  }

  // ---------------------------------------------------------------- rooms --

  /** The room the Rooms tab is showing, or null when nothing is selected. */
  private currentRoom(): AgosRoom | null {
    // The selection is read into a local because narrowing does not survive the
    // closure below — `this.selection` is a mutable field.
    const selection = this.selection;
    if (selection.kind !== 'room') return null;
    return this.agos?.rooms?.rooms.find((each) => each.item === selection.item) ?? null;
  }

  /**
   * The selected room's backdrop, or the sentence that says why there is none.
   *
   * Split out of {@link renderRoom} because there are now two callers and one
   * of them writes a file: the picture under the room and the PNG the save
   * control offers have to be the same drawing, or an author would be handed
   * something other than what they are looking at. So the drawing happens once,
   * here, and both callers take what it returns — including its refusals,
   * which is why they are strings rather than throws.
   */
  private currentBackdrop(): RoomBackdrop | string {
    const room = this.currentRoom();
    if (!room) return 'Pick a room from the sidebar.';

    if (room.picture === undefined || room.zone === undefined) {
      return (
        'This room’s own script does not name a picture outright — it chooses one as the ' +
        'game runs — so there is nothing to draw without playing it.'
      );
    }

    const version = this.agosVersion();
    if (!version) {
      return 'This project has no AGOS Version, so its zones cannot be addressed.';
    }

    const scripts = this.zoneScripts?.(room.zone);
    const pixels = this.zones?.(room.zone);
    if (!scripts || !pixels) {
      return (
        this.folderProblem ??
        `Zone ${room.zone} holds this room’s picture, and it has not been read. AGOS art ` +
          `lives beside the game rather than in the project — open the game folder at the ` +
          `top of the properties column (ADR 0034).`
      );
    }

    return renderRoomBackdrop({
      scripts,
      pixels,
      picture: room.picture,
      version,
      // The zone layout the Version packages its graphics in, which is the
      // same question `readVgaFile` asks — Simon's two releases pack, Feeble
      // and Puzzle Pack do not.
      agos2: zoneLayoutFor(version) === 'agos2',
    });
  }

  /**
   * The selected room's backdrop, as the game would paint it.
   *
   * Every refusal ends up in the same place — the note under the picture — and
   * they are worth telling apart, so each one says which of them it is: no
   * picture named, no folder open, the zone missing from the archive, or a
   * script that drew nothing because it asked the running game a question. The
   * last is the interesting one and the commonest: measured on the retail
   * games, 90 of Simon 1's 92 rooms and 55 of Simon 2's 67 do paint.
   */
  private renderRoom(): void {
    const room = this.currentRoom();
    const drawn = this.currentBackdrop();
    if (typeof drawn === 'string' || !room) {
      this.showRoomProblem(typeof drawn === 'string' ? drawn : 'Pick a room from the sidebar.');
      return;
    }

    const source = roomBackdropUrl(drawn);
    if (!source) {
      this.showRoomProblem(
        'This room drew, but there is no 2D canvas here to turn it into a picture.',
      );
      return;
    }

    this.roomShot.hidden = false;
    this.roomShot.src = source;
    this.roomShot.alt = `Room ${room.item}, ${drawn.width} by ${drawn.height} pixels`;
    this.roomNote.className = 'agos-paint-note';
    this.roomNote.textContent =
      `${drawn.width} × ${drawn.height} pixels, ${drawn.colours} colours, drawn by picture ` +
      `${room.picture} in zone ${room.zone}. This is the room's own script run as the game ` +
      `would run it, so it is a view rather than something to paint — the Art tab is where an ` +
      `image is edited.`;
  }

  /** Says why there is no room picture, in place of one. */
  private showRoomProblem(why: string): void {
    this.roomShot.hidden = true;
    this.roomShot.removeAttribute('src');
    this.roomNote.className = 'agos-summary-warning';
    this.roomNote.textContent = why;
  }

  /** The Version this project is tagged with, which addresses its zones. */
  private agosVersion(): AgosVersion | undefined {
    const target = this.options.project().target;
    return target.engine === 'agos' ? target.version : undefined;
  }

  // ------------------------------------------------------------------ art --

  /** The zone the art tab is showing, or null when the selection has none. */
  private currentZone(): number | null {
    if (this.selection.kind === 'zone' || this.selection.kind === 'image') {
      return this.selection.zone;
    }
    return null;
  }

  private renderArt(): void {
    this.renderArtToolbar();
    this.renderPalette();
    this.drawCurrentImage();
  }

  private renderArtToolbar(): void {
    this.toolbar.replaceChildren();
    const writable = this.imageIsWritable();

    for (const [tool, label, title] of AGOS_TOOLS) {
      const element = this.button(
        label,
        () => {
          this.canvas.tool = tool;
          this.renderArtToolbar();
          announce(`${label} tool. ${title}.`);
        },
        title,
      );
      element.className = this.canvas.tool === tool ? 'tool selected' : 'tool';
      // Which tool is armed was a background colour and nothing else on the
      // SCUMM toolbar before it was fixed, which is 1.4.1 and 4.1.2 at once.
      // This one starts where that one ended up.
      element.setAttribute('aria-pressed', String(this.canvas.tool === tool));
      element.setAttribute('aria-label', `${label} tool — ${title}`);
      element.disabled = !writable;
      this.toolbar.appendChild(element);
    }

    const dropper = document.createElement('span');
    dropper.className = 'muted';
    dropper.textContent = 'Right-click picks a colour index';
    this.toolbar.appendChild(dropper);

    this.toolbar.appendChild(this.paletteControl());
    this.toolbar.appendChild(this.zoomControl());
    this.toolbar.appendChild(
      this.button(
        'Import image…',
        () => void this.doImportImage(),
        'Redraw this image from a file',
      ),
    );
    // No "Export PNG" here either, for the same reason: the save is at the top
    // of the right column, where a person looks for one and where it can say
    // what it will write. A second copy on this toolbar would be a control
    // that appears only when the Art tab is open and an image is selected —
    // which is how the first one came to be reported as missing.

    // No "open game folder" here. It is at the top of the right column now,
    // beside the name of the folder in use, so the gesture and the fact it
    // changes are in one place rather than one on the toolbar and the other
    // nowhere.
  }

  /**
   * Which palette bank the art is shown in.
   *
   * The one control on this toolbar that is a question rather than a tool. A
   * bank is chosen by the script that draws an image and this surface has no
   * script to ask, so the zone's banks are offered and a person picks — which
   * is the difference between showing a game's colours and inventing some.
   *
   * Each bank is listed twice because a table bank holds thirty-two colours and
   * a four-bit pixel indexes sixteen: `SET_PALETTE`'s group 0 loads both halves
   * at once, and which half a sprite lands in depends on the group its script
   * asked for. Offering both beats guessing, and the labels say which is which
   * rather than leaving two identical entries.
   */
  private paletteControl(): HTMLElement {
    const zone = this.currentZone();
    const banks = zone === null ? 0 : this.banksOf(zone);

    const label = document.createElement('label');
    label.className = 'field';
    label.append(document.createTextNode('Colours'));

    if (banks === 0 || zone === null) {
      const none = document.createElement('span');
      none.className = 'muted';
      // Said rather than shown as an empty picker: greys are what this zone can
      // honestly be drawn in, and an author should know that is why.
      none.textContent = 'greys — this zone’s colours are in the game folder';
      label.appendChild(none);
      return label;
    }

    const chosen = this.chosenBank(zone);
    const select = document.createElement('select');
    for (let bank = 0; bank < banks; bank += 1) {
      for (const half of [0, 1] as const) {
        const option = document.createElement('option');
        option.value = `${bank}:${half}`;
        option.textContent = `Bank ${bank}, ${half === 0 ? 'first' : 'second'} 16`;
        option.selected = chosen.bank === bank && chosen.half === half;
        select.appendChild(option);
      }
    }
    select.addEventListener('change', () => {
      const [bank, half] = select.value.split(':').map(Number);
      this.paletteBank.set(zone, { bank: bank ?? 0, half: half === 1 ? 1 : 0 });
      this.render();
      announce(`Bank ${bank}, ${half === 1 ? 'second' : 'first'} sixteen colours.`);
    });
    label.appendChild(select);
    return label;
  }

  /**
   * How large the open image is drawn.
   *
   * "Fit" is the entry that matters and the one that was missing. An AGOS image
   * is thirty-odd pixels across, so an author who wants to *see* one wants it
   * as large as the column allows — and picking that by hand out of a list of
   * multipliers is arithmetic nobody should be doing about their own screen.
   *
   * It is recomputed whenever an image is drawn rather than watched for: a
   * render follows every selection, tool and palette change, so the fit tracks
   * the layout without this surface holding a resize listener it would then
   * have to tear down. A window resized while nothing else happens leaves the
   * previous fit standing until the next gesture.
   */
  private zoomControl(): HTMLElement {
    const label = document.createElement('label');
    label.className = 'field';
    label.append(document.createTextNode('Zoom'));
    const select = document.createElement('select');

    const fit = document.createElement('option');
    fit.value = 'fit';
    fit.textContent = 'Fit';
    fit.selected = this.zoomChoice === 'fit';
    select.appendChild(fit);

    for (const value of ZOOMS) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = `${value}×`;
      option.selected = this.zoomChoice === value;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this.zoomChoice = select.value === 'fit' ? 'fit' : Number(select.value);
      // The image and not the toolbar: rebuilding the toolbar would replace
      // this select out from under the focus that just changed it.
      this.drawCurrentImage();
      announce(
        this.zoomChoice === 'fit'
          ? `Fitted to the column, ${this.canvas.zoom} times actual size.`
          : `${this.zoomChoice} times actual size.`,
      );
    });
    label.appendChild(select);
    return label;
  }

  /**
   * The largest whole multiple of this image that the canvas column can hold.
   *
   * Whole numbers only: a fractional scale on pixel art puts some source pixels
   * in two screen columns and some in one, which is a ripple through a picture
   * that does not have one. Falls back to the default where there is no layout
   * to measure — a test environment reports every box as zero, and a zoom
   * computed from that would be a canvas of nothing.
   */
  private fitZoom(bitmap: IndexedBitmap): number {
    const width = this.canvasWrap.clientWidth - FIT_PADDING;
    const height = this.canvasWrap.clientHeight - FIT_PADDING;
    if (width <= 0 || height <= 0) return DEFAULT_ZOOM;
    return Math.max(1, Math.floor(Math.min(width / bitmap.width, height / bitmap.height)));
  }

  /**
   * Sixteen indices, because a pixel is four bits.
   *
   * In the chosen bank's own colours, which is what an author is painting with.
   * They used to be sixteen grey levels on the argument that a bank is a
   * script's choice — true, and the wrong conclusion: the choice is offered on
   * the toolbar now, so the strip can show the colours the choice produces.
   * A zone that is not open still gets greys, because there is no bank to read.
   *
   * The number stays written on each swatch, because which index a colour is
   * must not be carried by the colour alone (1.4.1), and the ink flips with the
   * swatch's luminance so it stays readable on a real palette.
   */
  private renderPalette(): void {
    this.palette.replaceChildren();
    const writable = this.imageIsWritable();
    const colours = this.paletteFor(this.currentZone());

    for (let index = 0; index < 16; index += 1) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = this.canvas.colour === index ? 'swatch selected' : 'swatch';
      swatch.style.background = cssFor(colours, index);
      swatch.style.color = inkFor(colours, index);
      swatch.textContent = String(index);
      swatch.title = `Colour index ${index}`;
      // A radio in a radiogroup, exactly as the SCUMM palette is: these are
      // options one of which is chosen, and `aria-checked` is what the shared
      // stylesheet keys the chosen ring off too.
      groupItem(swatch, {
        role: 'radio',
        selected: this.canvas.colour === index,
        label: describeColour(index, colours[index]),
      });
      swatch.disabled = !writable;
      swatch.addEventListener('click', () => {
        this.canvas.colour = index;
        this.renderPalette();
        announce(`Colour index ${index}.`);
      });
      this.palette.appendChild(swatch);
    }
    rovingGroup(this.palette, {
      role: 'radiogroup',
      label: 'Colour index',
      orientation: 'horizontal',
    });
  }

  /**
   * A page of the zone's images, one per row, in the right column.
   *
   * This was a wrapping strip of 48-pixel cels under the canvas, and the layout
   * had a measurement against it. `.frame-strip` does not shrink and
   * `.canvas-wrap` had no floor, so a busy zone's cels pushed the canvas to
   * nothing: Simon 1's zone 8 holds 1,092 images, which wraps to some eighty
   * rows and four thousand pixels of thumbnails; Simon 2's zone 73 holds 1,828
   * and comes to seven thousand. The one thing with no room left was the
   * picture an author opened the tab to look at.
   *
   * So the thumbnails go down the right column, where a list has somewhere to
   * scroll, and the centre column belongs to the open image. One per row buys
   * each thumbnail a label as well, which matters at these counts: a wall of
   * unlabelled squares is not something a person can find an image in, and a
   * row can say its number and its size.
   *
   * `had` is passed by the caller that cannot see it. A page turn rebuilds the
   * list while it is still in the document, so the default reads the truth;
   * `renderInspector` empties the column first, and a browser moves focus to
   * the body the moment the element holding it leaves the document — so that
   * caller has to look before it clears and say what it saw.
   */
  private renderStrip(had: StripFocus = this.stripFocus()): void {
    this.strip.replaceChildren();

    const agos = this.agos;
    const zone = this.currentZone();
    if (!agos?.art || zone === null) return;

    const images = agos.art.images.filter((each) => each.zone === zone);
    this.strip.appendChild(this.heading(`Zone ${zone} images`));
    if (images.length === 0) {
      this.strip.appendChild(this.paragraph(`Zone ${zone} holds no measurable images.`));
      return;
    }

    const pages = Math.ceil(images.length / IMAGES_PER_PAGE);
    // Clamped rather than trusted: a project reloaded with a smaller zone under
    // the same number would otherwise show a page that is off the end.
    const page = Math.min(Math.max(this.stripPage, 0), pages - 1);
    this.stripPage = page;
    const from = page * IMAGES_PER_PAGE;
    const shown = images.slice(from, from + IMAGES_PER_PAGE);

    const rows = document.createElement('div');
    rows.className = 'agos-art-rows';
    for (const image of shown) rows.appendChild(this.artRow(zone, image));
    // One tab stop for the list and arrow keys inside it, which is the pattern
    // the palette and the tabs already use — forty-eight tab stops per page is
    // reachable and unusable, and at 1,828 images it is neither.
    rovingGroup(rows, { role: 'radiogroup', label: `Zone ${zone} images` });
    this.strip.appendChild(rows);

    if (pages > 1) {
      this.strip.appendChild(this.artPager(images.length, from, shown.length, page, pages));
    }

    if (had === 'page') {
      // Straight back into the field. Typing a page number rebuilds the pager
      // holding the field, so without this an author who jumps to page 20 is
      // dropped out of the list they were navigating — and a second jump means
      // finding the field again.
      const input = this.strip.querySelector<HTMLElement>('.agos-art-page-input');
      if (input) {
        input.focus();
        return;
      }
    }
    if (had === null) return;
    const chosen = rows.querySelector<HTMLElement>('[aria-checked="true"]');
    (chosen ?? (rows.firstElementChild as HTMLElement | null))?.focus();
  }

  /**
   * Which of the list's controls the keyboard is in, if either.
   *
   * Two of them and not one, because they are put back differently: a rebuilt
   * row list takes focus on the open image, while the page field has to take it
   * back itself — restoring a row after a jump would move the author out of the
   * control they were using.
   */
  private stripFocus(): StripFocus {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !this.strip.contains(active)) return null;
    return active.classList.contains('agos-art-page-input') ? 'page' : 'row';
  }

  /** One image, as a row: its picture, its number and its size. */
  private artRow(zone: number, image: AgosImage): HTMLButtonElement {
    const row = document.createElement('button');
    row.type = 'button';
    const chosen =
      this.selection.kind === 'image' &&
      this.selection.zone === zone &&
      this.selection.id === image.id;
    row.className = chosen ? 'agos-art-row selected' : 'agos-art-row';
    // A radio in a radiogroup, exactly as the palette's swatches are: these are
    // options one of which is open. The label carries what the picture cannot.
    groupItem(row, {
      role: 'radio',
      selected: chosen,
      label:
        `Image ${image.id}, ${image.width} by ${image.height} pixels, ` +
        `flags 0x${image.flags.toString(16)}`,
    });
    if (chosen) row.setAttribute('aria-current', 'true');

    /*
     * The picture, where there is one.
     *
     * The box has a dark background and is meant to hold an image, so a list
     * with only labels in it reads as a column of black squares — which is
     * exactly how a game's whole art collection looked before the thumbnails
     * decoded. Where one cannot be drawn the size goes in instead, which is a
     * fact the Project carries without the folder.
     */
    const thumb = document.createElement('span');
    thumb.className = 'agos-art-thumb';
    const source = this.thumbnailFor(zone, image.id);
    if (source) {
      const picture = document.createElement('img');
      picture.src = source;
      picture.alt = '';
      thumb.appendChild(picture);
    } else {
      const size = document.createElement('span');
      size.className = 'agos-cel-size';
      size.textContent = `${image.width}×${image.height}`;
      thumb.appendChild(size);
    }
    row.appendChild(thumb);

    const text = document.createElement('span');
    text.className = 'agos-art-text';
    const name = document.createElement('span');
    name.className = 'agos-art-name';
    name.textContent = `Image ${image.id}`;
    const meta = document.createElement('span');
    meta.className = 'agos-art-meta';
    meta.textContent = `${image.width} × ${image.height}`;
    text.append(name, meta);
    row.appendChild(text);

    row.addEventListener('click', () =>
      this.select({ kind: 'image', zone, id: image.id }, 'art', `Image ${image.id}.`),
    );
    return row;
  }

  /**
   * Which images of the zone's are on screen, and the way to the rest.
   *
   * The count is said in full rather than as a page number, because "1 to 48 of
   * 1,828" is the fact an author needs about a zone this size and "page 1 of
   * 39" is not.
   */
  private artPager(
    total: number,
    from: number,
    count: number,
    page: number,
    pages: number,
  ): HTMLElement {
    const pager = document.createElement('div');
    pager.className = 'agos-art-pager';

    const turn = document.createElement('div');
    turn.className = 'agos-art-turn';
    const step = (to: number, label: string, title: string): void => {
      const button = this.button(label, () => this.turnToPage(to, pages), title);
      button.disabled = to < 0 || to >= pages;
      turn.appendChild(button);
    };

    step(page - 1, '‹ Previous', 'The previous page of this zone’s images');
    const where = document.createElement('span');
    where.className = 'agos-art-count';
    where.textContent = `${from + 1}–${from + count} of ${total}`;
    turn.appendChild(where);
    step(page + 1, 'Next ›', 'The next page of this zone’s images');
    pager.appendChild(turn);

    pager.appendChild(this.artPageJump(page, pages));
    return pager;
  }

  /**
   * A page number to go to, typed.
   *
   * Previous and Next are the whole of what a pager needs at four pages and
   * useless at thirty-nine: Simon 2's zone 73 runs to 1,828 images, and
   * reaching the last of them is thirty-eight clicks. So the page is a field as
   * well as a pair of steps, which is how every long list is navigated.
   *
   * `type="number"` with a `min` and a `max`, so a browser offers its own
   * spinner and a phone offers a numeric keypad — and the value is clamped
   * anyway, because the attributes are a hint to the control rather than a
   * guarantee about what arrives. It commits on `change`, which covers Enter
   * and tabbing away both; Enter is also caught directly, because a `change`
   * only fires when the value actually differs and an author who retypes the
   * page they are on should still get an answer.
   */
  private artPageJump(page: number, pages: number): HTMLElement {
    const jump = document.createElement('label');
    jump.className = 'agos-art-jump';

    const caption = document.createElement('span');
    caption.textContent = 'Page';
    jump.appendChild(caption);

    const input = document.createElement('input');
    input.className = 'agos-art-page-input';
    input.type = 'number';
    input.min = '1';
    input.max = String(pages);
    input.step = '1';
    input.value = String(page + 1);
    // The visible caption says "Page" and the count beside it says of how many,
    // but a screen reader reaching this field on its own gets neither.
    input.setAttribute('aria-label', `Page number, 1 to ${pages}`);
    jump.appendChild(input);

    const of = document.createElement('span');
    of.className = 'agos-art-of';
    of.textContent = `of ${pages}`;
    jump.appendChild(of);

    const go = (): void => {
      const asked = Number.parseInt(input.value, 10);
      if (!Number.isFinite(asked)) {
        // Nothing usable was typed. The rebuild puts the current page back in
        // the field, which says what happened better than a message would.
        this.renderStrip();
        return;
      }
      this.turnToPage(asked - 1, pages);
    };
    input.addEventListener('change', go);
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      // Not a form, so Enter has nothing to submit and would otherwise do
      // nothing at all in the one place a person most expects it to work.
      event.preventDefault();
      go();
    });

    return jump;
  }

  /**
   * Goes to a page, or to the nearest one that exists.
   *
   * Clamped rather than refused: "page 400 of 39" is a typed number rather than
   * a request worth arguing with, and the end of the list is what was meant.
   * The clamp is said out loud, so an author who asked for 400 and got 39 knows
   * which of the two they are looking at.
   */
  private turnToPage(to: number, pages: number): void {
    const page = Math.min(Math.max(to, 0), pages - 1);
    this.stripPage = page;
    this.renderStrip();
    announce(
      page === to
        ? `Images page ${page + 1} of ${pages}.`
        : `Page ${to + 1} does not exist. Showing page ${page + 1} of ${pages}.`,
    );
  }

  /**
   * One image as a data URL, or null when there is nothing to draw.
   *
   * Null covers three cases that all mean the same thing to the strip: no
   * folder has been offered, this zone's pixels are missing, or the entry does
   * not decode. The cel then shows the size instead, which is a fact the
   * Project does carry.
   *
   * Not cached. A strip is redrawn when the selection changes and a zone holds
   * a few dozen images of a few thousand pixels each; a cache would be a second
   * thing to invalidate when a paint lands, for a decode that is already
   * cheaper than the render around it.
   */
  private thumbnailFor(zone: number, id: number): string | null {
    const agos = this.agos;
    if (!agos) return null;

    let bitmap: IndexedBitmap;
    const painted = agos.paintedImages?.find((each) => each.zone === zone && each.id === id);
    if (painted) {
      bitmap = bitmapOf(painted);
    } else {
      const pixels = this.zones?.(zone);
      if (!pixels) return null;
      try {
        bitmap = decodeZoneImage(pixels, id);
      } catch {
        return null;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    // Absent in a test environment, which has no 2D canvas. The cel falls back
    // to its size label rather than to a broken image.
    if (!context) return null;
    const data = context.createImageData(bitmap.width, bitmap.height);
    paintBitmap(data.data, bitmap, {
      transparentZero: this.transparentZeroFor(id),
      palette: this.paletteFor(zone),
    });
    context.putImageData(data, 0, 0);
    return canvas.toDataURL();
  }

  /**
   * The zone's palette banks, or an empty list when there are none to read.
   *
   * They sit at offset 6 of the *script* resource — the pixels have no colours
   * of their own — and run up to the header block the resource points at, which
   * is what bounds them since nothing counts them.
   */
  private banksOf(zone: number): number {
    const pixels = this.zones?.(zone);
    const scripts = this.zoneScripts?.(zone);
    if (!pixels || !scripts) return 0;
    try {
      return countVgaPaletteBanks(readVgaFile(scripts).headerAt);
    } catch {
      return 0;
    }
  }

  /** Which bank and half the open zone is being shown in. */
  private chosenBank(zone: number): { bank: number; half: 0 | 1 } {
    return this.paletteBank.get(zone) ?? { bank: 0, half: 0 };
  }

  /**
   * The sixteen colours the art is painted with.
   *
   * Grey when the zone is not open, which is the honest picture rather than a
   * guess: an image whose bytes cannot be read has no bank to be shown in
   * either.
   */
  private paletteFor(zone: number | null): AgosPalette {
    if (zone === null) return greyPalette();
    const scripts = this.zoneScripts?.(zone);
    if (!scripts || this.banksOf(zone) === 0) return greyPalette();
    const chosen = this.chosenBank(zone);
    try {
      return readVgaPaletteHalf(scripts, chosen.bank, chosen.half);
    } catch {
      return greyPalette();
    }
  }

  /**
   * Whether index 0 means "nothing here" for one image.
   *
   * The entry's `opaque` flag decides it: set, and colour zero is a colour the
   * renderer draws; clear, and it skips it. Following the flag is what stops a
   * mostly-transparent sprite — which is what an AGOS sprite mostly is — from
   * being shown as a solid black rectangle.
   */
  private transparentZeroFor(id: number): boolean {
    const zone = this.currentZone();
    const listed = this.agos?.art?.images.find((each) => each.zone === zone && each.id === id);
    return ((listed?.flags ?? 0) & DRAW_FLAGS.opaque) === 0;
  }

  /**
   * The bitmap currently open, from paint intent if there is any and from the
   * zone otherwise.
   *
   * Intent first, deliberately: ADR 0030 has the Project record what the author
   * meant, so a painted image must come back as the author left it and not as
   * the folder still holds it.
   */
  private currentBitmap(): IndexedBitmap | { problem: string } {
    const agos = this.agos;
    if (!agos) return { problem: 'No AGOS project is open.' };
    if (this.selection.kind !== 'image') {
      return { problem: 'Pick an image from the list in the right column.' };
    }
    const { zone, id } = this.selection;

    const painted = agos.paintedImages?.find((each) => each.zone === zone && each.id === id);
    if (painted) return bitmapOf(painted);

    const problem = describeZoneAccess(this.zones, zone);
    if (problem) return { problem };

    const pixels = this.zones?.(zone);
    if (!pixels) return { problem: `Zone ${zone}’s pixels could not be read.` };

    try {
      return decodeZoneImage(pixels, id);
    } catch (error) {
      return {
        problem: `This image could not be decoded: ${
          error instanceof Error ? error.message : 'unknown reason'
        }.`,
      };
    }
  }

  /**
   * Whether the open image may be painted at all.
   *
   * Four separate refusals, and the order matters only in that the cheapest go
   * first — decoding the image to find out whether it is there is the expensive
   * one. `encodeSpriteRefusal` is the interesting one: the compressed forms
   * have many valid encodings of one picture, so repacking one that had merely
   * been opened would break the byte identity ADR 0030 rests on.
   */
  private imageIsWritable(): boolean {
    if (this.options.allowPainting === false) return false;
    if (this.selection.kind !== 'image') return false;
    const listed = this.listedImage();
    if (!listed || encodeSpriteRefusal(listed.flags)) return false;
    return !('problem' in this.currentBitmap());
  }

  private listedImage():
    { zone: number; id: number; width: number; height: number; flags: number } | undefined {
    if (this.selection.kind !== 'image') return undefined;
    const { zone, id } = this.selection;
    return this.agos?.art?.images.find((each) => each.zone === zone && each.id === id);
  }

  private drawCurrentImage(): void {
    const result = this.currentBitmap();

    if ('problem' in result) {
      this.canvas.element.hidden = true;
      this.canvasStatus.className = 'agos-summary-warning';
      this.canvasStatus.textContent = this.folderProblem ?? result.problem;
      return;
    }

    this.canvas.element.hidden = false;
    if (this.selection.kind === 'image') {
      this.canvas.transparentZero = this.transparentZeroFor(this.selection.id);
    }
    this.canvas.palette = this.paletteFor(this.currentZone());
    // Before `show`, which applies whatever scale the canvas is holding: "Fit"
    // is a function of this bitmap and the column's size, so it can only be
    // worked out once both are known.
    this.canvas.zoom = this.zoomChoice === 'fit' ? this.fitZoom(result) : this.zoomChoice;
    this.canvas.show(result);

    const listed = this.listedImage();
    const refusal = listed ? encodeSpriteRefusal(listed.flags) : null;
    if (refusal) {
      // Stated rather than discovered: the compressed forms have many valid
      // encodings of one picture, so repacking one that had merely been opened
      // would break ADR 0030's byte-identity guarantee.
      this.canvasStatus.className = 'agos-summary-warning';
      this.canvasStatus.textContent = `Not writable: ${refusal}.`;
      return;
    }
    if (this.options.allowPainting === false) {
      this.canvasStatus.className = 'agos-summary-warning';
      this.canvasStatus.textContent = 'Writable, but this surface was mounted read-only.';
      return;
    }
    this.canvasStatus.className = 'agos-paint-note';
    const zone = this.currentZone();
    this.canvasStatus.textContent =
      zone !== null && this.banksOf(zone) > 0
        ? 'Writable. The colours are this zone’s own palette — pick the bank on the toolbar, ' +
          'because which one an image is drawn with is a script’s choice. The checkerboard is ' +
          'colour index zero, which the game draws as transparent.'
        : 'Writable. This zone carries no palette of its own, so the art is shown in greys — ' +
          'its colours come from a bank another zone loads.';
  }

  /**
   * Records a gesture as paint intent.
   *
   * The bytes the canvas produced are thrown away and the *bitmap* is kept, for
   * ADR 0030's reason: the Project holds what the author meant and export
   * replays it onto the folder the player supplies again.
   */
  private recordPaint(bitmap: IndexedBitmap): void {
    if (this.selection.kind !== 'image') return;
    if (!this.imageIsWritable()) return;
    const { zone, id } = this.selection;

    this.options.update((project) => {
      if (!project.agos) return;
      const kept: PaintedImage[] = [...(project.agos.paintedImages ?? [])].filter(
        (each) => !(each.zone === zone && each.id === id),
      );
      kept.push(paintedFrom(zone, id, bitmap));
      project.agos.paintedImages = kept;
    });
  }

  // ----------------------------------------------------------- properties --

  /**
   * The properties pane.
   *
   * Everything editable is here, which is where the SCUMM editor puts it — an
   * object's fields and its script are both in the inspector, with the canvas
   * left to show the thing rather than to carry its form.
   */
  private renderInspector(): void {
    // Looked at before the column is emptied. A click on an image rebuilds this
    // pane, and a radio group *selects* as the arrow keys move through it — so
    // without putting focus back a keyboard walk down the list would end on the
    // first press.
    const listHadFocus = this.stripFocus();
    this.inspectorPane.replaceChildren();
    const agos = this.agos;
    if (!agos) {
      this.inspectorPane.appendChild(this.paragraph('No AGOS project is open.'));
      return;
    }

    // Above everything, including the read-only notice: which folder the art is
    // being read out of is the fact the rest of this column depends on, and an
    // author who picked the wrong one needs to find that out before they read
    // any of it.
    this.renderFolderBar();

    if (!agos.editable.editable) {
      const why = document.createElement('p');
      why.className = 'agos-summary-warning';
      // The gate is ADR 0029's, and the whole pane obeys it — an edit on a game
      // decoded under the wrong Version writes a plausible number into the
      // wrong field.
      why.textContent = `Read-only: ${agos.editable.reasons.join('; ')}.`;
      this.inspectorPane.appendChild(why);
    }

    // Above the per-selection fields, because it is about the selection as a
    // whole and because it is where the reporter looked for it: the SCUMM
    // surface puts its download at the top of this column too. It used to be
    // on the art *toolbar*, three panes away, and inert unless an image was
    // already open — which is a download nobody found.
    this.renderSaveBar();

    this.renderProperties(agos);

    // The zone's thumbnails, under its properties. Only on the art tab, because
    // that is the only tab an image is opened from — see `renderStrip` for why
    // they are here rather than under the canvas.
    if (this.tab === 'art' && this.currentZone() !== null) {
      // Appended before the rows are built, so the focus this puts back lands
      // on an element that is in the document and can actually hold it.
      this.inspectorPane.appendChild(this.strip);
      this.renderStrip(listHadFocus);
    }
  }

  /** Whatever is selected, as its fields. */
  private renderProperties(agos: AgosProject): void {
    switch (this.selection.kind) {
      case 'item':
        this.inspectItem(agos, this.selection.id);
        return;
      case 'string':
        this.inspectString(this.selection.index);
        return;
      case 'subroutine':
        this.inspectSubroutine(agos, this.selection.id);
        return;
      case 'zone':
        this.inspectZone(agos, this.selection.zone);
        return;
      case 'image':
        this.inspectImage(agos, this.selection.zone, this.selection.id);
        return;
      case 'room':
        this.inspectRoom(agos, this.selection.item);
    }
  }

  /**
   * A room's own facts: the item it is, the script it runs, what it draws.
   *
   * All read-only, and that is the room record rather than a choice made here.
   * Its Subroutine number and its exit mask are the same word twice over — the
   * mask sized the list of destinations that follows it — so neither can be
   * changed without rewriting the record, which is why `AgosInterpreter` notes
   * that a script cannot add a door. The room's *name* is its item's noun, and
   * that is editable where it belongs, on the item.
   */
  private inspectRoom(agos: AgosProject, item: number): void {
    const room = agos.rooms?.rooms.find((each) => each.item === item);
    if (!room) return;

    const strings = this.strings();
    const listed = agos.items[item - 2];
    const name = (listed && strings[listed.noun]) || `Item ${item}`;
    this.inspectorPane.appendChild(this.heading(name));

    this.inspectorPane.appendChild(
      this.paragraph(
        `Item ${item}. A room is an item in AGOS — where the player is *is* an item — so this ` +
          `is the same item the Items tab lists, seen by the room record hanging off it.`,
      ),
    );
    this.inspectorPane.appendChild(
      this.paragraph(
        `Runs Subroutine ${room.subroutine} on arrival, and has ` +
          `${room.exits} exit${room.exits === 1 ? '' : 's'}.`,
      ),
    );

    if (room.picture === undefined) {
      const why = document.createElement('p');
      why.className = 'agos-summary-warning';
      why.textContent =
        'Its script names no picture outright, so what this room looks like is decided as the ' +
        'game runs.';
      this.inspectorPane.appendChild(why);
    } else {
      this.inspectorPane.appendChild(
        this.paragraph(`Draws picture ${room.picture}, which is in zone ${room.zone}.`),
      );
      // Straight to the zone, because "which images is this room made of" is
      // the next question an author asks and the Art tab is where it lives.
      this.inspectorPane.appendChild(
        this.button(
          `Open zone ${room.zone} art`,
          () =>
            this.select(
              { kind: 'zone', zone: room.zone! },
              'art',
              `Zone ${room.zone}, this room's art.`,
            ),
          'The images this room’s picture is composed from',
        ),
      );
    }

    if ((agos.rooms?.unreadableSubroutines.length ?? 0) === 0) return;
    if (!agos.rooms?.unreadableSubroutines.includes(room.subroutine)) return;
    const missing = document.createElement('p');
    missing.className = 'agos-summary-warning';
    // Worth telling apart from "no picture named": a Subroutine that is not
    // there means the table files beside the game were not read, which is a
    // packaging fact rather than the game being itself.
    missing.textContent =
      `Subroutine ${room.subroutine} was not found. A room's script normally lives in a ` +
      `TABLES file beside the game rather than in GAMEPC, so this project was built without ` +
      `those files.`;
    this.inspectorPane.appendChild(missing);
  }

  /**
   * What the selection would save, or why it would not.
   *
   * One control rather than one per surface, and it names the file it will
   * write before it writes it. The reason is what was reported: the Art tab's
   * export lived on the art toolbar, was inert unless an image was already
   * open, and said nothing about either — so the answer to "can I get this
   * out" was an unlabelled button that did nothing, which reads as a surface
   * that downloads nothing.
   *
   * Disabled with the reason showing rather than hidden, for the same reason
   * the room note says which of its four refusals it hit: a control that
   * vanishes when it cannot act leaves an author unable to tell "not here"
   * from "not possible".
   */
  private renderSaveBar(): void {
    const bar = document.createElement('div');
    bar.className = 'agos-save-bar';

    const title = document.createElement('h3');
    title.className = 'agos-folder-title';
    title.textContent = 'Save';
    bar.appendChild(title);

    const offer = this.saveable();
    const ready = 'what' in offer;

    const save = this.button(
      ready ? `Save ${offer.what}…` : 'Save…',
      () => {
        if ('what' in offer) void offer.run();
      },
      ready ? `Writes ${offer.filename}` : offer.why,
    );
    save.disabled = !ready;
    bar.appendChild(save);

    const note = document.createElement('p');
    note.className = ready ? 'muted' : 'agos-summary-warning';
    note.textContent = ready ? `Writes ${offer.filename}.` : offer.why;
    // Tied to the button rather than left floating, so a screen reader reading
    // a disabled control is told why it is disabled.
    note.id = `agos-save-why-${this.instance}`;
    save.setAttribute('aria-describedby', note.id);
    bar.appendChild(note);

    this.inspectorPane.appendChild(bar);
  }

  /**
   * The file the current selection would write.
   *
   * Every surface that has a file answers here, so the control above is one
   * control and the question "what does this selection save" has one answer.
   * A selection with nothing to offer says so in words that name the thing it
   * cannot save rather than in a generic refusal.
   */
  private saveable(): SaveOffer {
    switch (this.selection.kind) {
      case 'image':
        return this.imageOffer(this.selection.zone, this.selection.id);
      case 'room':
        return this.roomOffer(this.selection.item);
      case 'item':
        return this.itemOffer(this.selection.id);
      default:
        return {
          why:
            'A string and a Subroutine are text rather than files. Pick an item, a room or an ' +
            'image to save one.',
        };
    }
  }

  /** The open image as a PNG, or why it cannot be one. */
  private imageOffer(zone: number, id: number): SaveOffer {
    const current = this.currentBitmap();
    if ('problem' in current) return { why: this.folderProblem ?? current.problem };
    const filename = agosImageFilename(this.options.project().name, zone, id);
    return {
      what: `image ${id} as a PNG`,
      filename,
      run: () => this.doExportImage(),
    };
  }

  /**
   * The room's backdrop as it is drawn, or the same sentence the picture is
   * showing.
   *
   * The refusal is `currentBackdrop`'s own rather than a second wording, so the
   * note under the picture and the note under the button never disagree about
   * why a room did not draw — and the four reasons it tells apart (no picture
   * named, no folder, no such entry, a script that asked the running game a
   * question) stay told apart here.
   */
  private roomOffer(item: number): SaveOffer {
    const drawn = this.currentBackdrop();
    if (typeof drawn === 'string') return { why: drawn };
    return {
      what: `room ${item} as a PNG`,
      filename: agosRoomFilename(this.options.project().name, item),
      run: () => this.doExportRoom(item, drawn),
    };
  }

  /**
   * The item's inventory icon, or the reason it has none — which is usually
   * that it has none.
   *
   * About half of each game's items carry no icon at all (measured: 90 of
   * Simon 1's 192 do, 96 of Simon 2's 172), and that is a fact about the game
   * rather than a failure here. It is said in those words, with the item's
   * number in it, because the alternative — exporting icon 0, or the icon of
   * some neighbouring item — hands an author a confident picture of the wrong
   * thing with nothing to notice it by.
   */
  private itemOffer(id: number): SaveOffer {
    const item = this.agos?.items[id - 2];
    if (!item) return { why: `There is no item ${id} in this project.` };

    const version = this.agosVersion();
    if (!version) {
      return { why: 'This project has no AGOS Version, so its icon layout is not known.' };
    }
    if (!iconsAreKnownFor(version)) {
      return {
        why:
          `Items carry pictures in Simon 1 and Simon 2, whose icon files have been read here. ` +
          `${version} has not, so nothing can be drawn for item ${id}.`,
      };
    }

    const icon = itemIconNumber(item);
    if (icon === null) {
      return {
        why:
          `Item ${id} has no artwork of its own. An AGOS item only has a picture when its ` +
          `object sub-structure carries the icon flag, and about half of this game's items — ` +
          `rooms, markers, things never held — do not.`,
      };
    }

    const iconFile = this.iconFile();
    if (!iconFile) {
      return {
        why:
          this.folderProblem ??
          `Item ${id} is drawn as icon ${icon}, which lives in ICON.DAT beside the game rather ` +
            `than in the project. Open the game folder above (ADR 0034).`,
      };
    }

    const bitmap = decodeItemIcon(iconFile, icon, version);
    if (typeof bitmap === 'string') return { why: bitmap };

    return {
      what: `item ${id}’s icon as a PNG`,
      filename: agosItemIconFilename(this.options.project().name, id, icon),
      run: () => this.doExportItemIcon(id, icon, bitmap),
    };
  }

  /** `ICON.DAT`, from the shell's folder if it has one and from ours otherwise. */
  private iconFile(): Uint8Array | null {
    return this.options.readIconFile?.() ?? this.openedIconFile;
  }

  /**
   * Which game folder the art is coming out of, at the top of the column.
   *
   * ADR 0034 has an author navigate to the folder the game's files are kept in,
   * and a gesture like that is easy to get wrong — the wrong release, the CD
   * rather than the install, a folder one level up. Nothing afterwards said
   * which folder had been accepted: the art either drew or it did not, and a
   * folder chosen by mistake could only be corrected by reloading the editor.
   * So the folder is named where its art is, and the same control changes it.
   *
   * It is a folder **name** and says so. The File System Access API never
   * reveals where on the disk a chosen folder sits — by design, not by
   * omission — so the folder's own name is the whole of what a browser will
   * give, and a fuller path printed here would be invented. The two files this
   * project was imported from are named beside it instead, because those are
   * what the folder was matched against and they are the half of a path that
   * would have told an author anything.
   */
  private renderFolderBar(): void {
    const bar = document.createElement('div');
    bar.className = 'agos-folder-bar';

    const title = document.createElement('h3');
    title.className = 'agos-folder-title';
    title.textContent = 'Game folder';
    bar.appendChild(title);

    const open = Boolean(this.zones);
    const name = this.currentFolderName();

    const where = document.createElement('p');
    where.className = open ? 'agos-folder-name' : 'agos-summary-warning';
    if (open) {
      where.textContent = name ?? 'Open. This surface was not told its name.';
      where.title = 'A browser gives a chosen folder’s own name, not where it sits on the disk.';
    } else {
      where.textContent =
        'None open. AGOS art lives beside the game rather than in the project, so the Art ' +
        'tab needs the folder this game was imported from (ADR 0034).';
    }
    bar.appendChild(where);

    const origin = this.options.project().origin;
    if (open && origin) {
      bar.appendChild(
        this.paragraph(`Matched against ${origin.indexFile} and ${origin.dataFile} inside it.`),
      );
    }

    // The last refusal, next to the button that would try again. A folder is
    // refused in words — the wrong release, a missing file — and those words
    // are about the gesture this button repeats.
    if (this.folderProblem) {
      const why = document.createElement('p');
      why.className = 'agos-summary-warning';
      why.textContent = this.folderProblem;
      bar.appendChild(why);
    }

    bar.appendChild(
      this.button(
        open ? 'Change folder…' : 'Open game folder…',
        () => void this.doOpenFolder(),
        open
          ? 'Pick a different folder, for one chosen by mistake'
          : 'AGOS art lives beside the game rather than in the project (ADR 0034)',
      ),
    );
    this.inspectorPane.appendChild(bar);
  }

  /**
   * What the open folder is called, or null when nothing knows.
   *
   * The shell's accessor wins where there is one, because the shell owns the
   * folder and it can change without this surface opening anything — the same
   * folder is re-supplied for an export. The name this surface opened for
   * itself is the fallback, for a mount that was given readers directly.
   */
  private currentFolderName(): string | null {
    return this.options.folderName?.() ?? this.openedFolderName;
  }

  private inspectItem(agos: AgosProject, id: number): void {
    const item = agos.items[id - 2];
    if (!item) return;
    const editable = agos.editable.editable;

    this.inspectorPane.appendChild(this.heading(`Item ${id}`));

    const strings = this.strings();
    /*
     * The name, as a name.
     *
     * `renameItem` appends a string and repoints this item's noun at it rather
     * than editing the string in place, which is the whole difference between
     * renaming *this* item and renaming everything that happened to share its
     * word. The reach of the in-place edit is offered separately, on the string
     * itself, where the count of what it would change is visible.
     */
    this.inspectorPane.appendChild(
      this.textField('Name', strings[item.noun] ?? '', editable, (value) => {
        this.options.update((project) => {
          if (project.agos) editGamePc(project.agos, (game) => renameItem(game, id, value));
        });
        announce(`Item ${id} renamed to ${value}.`);
      }),
    );

    const shared = this.usersOfNoun(item.noun);
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent =
      shared.length <= 1
        ? 'Renaming points this item at a new string. Nothing else uses its current one.'
        : `Renaming points this item at a new string; ${shared.length - 1} other item` +
          `${shared.length === 2 ? '' : 's'} keep the old one.`;
    this.inspectorPane.appendChild(note);

    this.inspectorPane.appendChild(
      this.numberField('Parent item', itemIdOf(item.parent), editable, (value) => {
        // Moving an item is the only structural change an AGOS world has: it is
        // how the games themselves make anything happen.
        this.options.update((project) => {
          if (project.agos) editGamePc(project.agos, (game) => reparentItem(game, id, value));
        });
        announce(`Item ${id} moved to parent ${value}.`);
      }),
    );
    this.inspectorPane.appendChild(
      this.paragraph('Parent 0 means nowhere, which is how a game destroys something.'),
    );

    this.inspectorPane.appendChild(
      this.numberField('State', item.state, editable, (value) => {
        this.options.update((project) => {
          if (project.agos) editGamePc(project.agos, (game) => setItemState(game, id, value));
        });
      }),
    );

    const names = document.createElement('p');
    names.className = 'muted';
    names.textContent = `noun: ${item.noun}, adjective: ${item.adjective}`;
    this.inspectorPane.appendChild(names);

    /*
     * Whether this item has a picture, said in the properties as well as on the
     * save control.
     *
     * "This item has no artwork of its own" is a fact about the game worth
     * reading without reaching for the download — about half of each game's
     * items are in that position — and a properties pane that stays silent
     * about it leaves the disabled button looking like a limitation of the
     * editor rather than a property of the item.
     */
    const icon = itemIconNumber(item);
    this.inspectorPane.appendChild(
      this.paragraph(
        icon === null
          ? 'No icon: this item is never drawn in the inventory, so it has no artwork of its own.'
          : `Icon ${icon} in ICON.DAT, which is the picture the inventory draws for it.`,
      ),
    );

    this.inspectItemChildren(id, item, editable);
  }

  /**
   * The typed sub-structures hanging off an item.
   *
   * A room's exits, an object's flag values, a container's volume. The values
   * are a list beside the mask that sized them, because the layouts differ per
   * Version in ways that are *counted* rather than fixed — so a value may be
   * edited and the count may not. Changing the count would mean changing the
   * mask, which relays the record; `editItemChildValue` is the authoring
   * layer's guard on exactly that, and it is used rather than reimplemented.
   */
  private inspectItemChildren(
    id: number,
    item: AgosProject['items'][number],
    editable: boolean,
  ): void {
    const children = item.children;
    if (children.length === 0) return;

    this.inspectorPane.appendChild(this.heading('Sub-structures'));

    for (const [childIndex, child] of children.entries()) {
      const block = document.createElement('div');
      block.className = 'agos-line';
      const label = document.createElement('h4');
      label.textContent = `${childIndex}: type ${child.type}`;
      block.appendChild(label);

      const values = child.values;
      for (const [valueIndex, value] of values.entries()) {
        block.appendChild(
          this.numberField(`Value ${valueIndex}`, value, editable, (wanted) => {
            this.options.update((project) => {
              if (!project.agos) return;
              editGamePc(project.agos, (game) =>
                editItemChildValue(game, id, childIndex, valueIndex, wanted),
              );
            });
          }),
        );
      }
      if (values.length === 0) {
        block.appendChild(this.paragraph('This sub-structure carries no editable values.'));
      }
      this.inspectorPane.appendChild(block);
    }
  }

  private inspectString(index: number): void {
    this.inspectorPane.appendChild(this.heading(`String ${index}`));

    const users = this.usersOf(index);
    // The whole reason this surface differs from AGI's: a pooled string is
    // shared, so the reach is stated before the edit rather than discovered.
    const reach = document.createElement('p');
    reach.className = 'agos-reach';
    reach.textContent =
      users.length === 0
        ? 'No subroutine refers to this string.'
        : `Editing this changes it for ${users.length} subroutine` +
          `${users.length === 1 ? '' : 's'}: ${users.join(', ')}.`;
    this.inspectorPane.appendChild(reach);

    const field = document.createElement('textarea');
    field.value = this.strings()[index] ?? '';
    field.disabled = !this.agos?.editable.editable;
    field.setAttribute('aria-label', `Text of string ${index}`);
    field.addEventListener('change', () => {
      const text = field.value;
      this.options.update((project) => {
        if (project.agos) editGamePc(project.agos, (game) => editString(game, index, text));
      });
      this.render();
      announce(`String ${index} changed.`);
    });
    this.inspectorPane.appendChild(field);
  }

  private inspectZone(agos: AgosProject, zone: number): void {
    this.inspectorPane.appendChild(this.heading(`Zone ${zone}`));

    if (agos.art?.unreadableZones.includes(zone)) {
      const why = document.createElement('p');
      why.className = 'agos-summary-warning';
      // Named rather than shown as empty: a zone present in the archive and
      // unreadable is either a packaging we read wrongly or a game we have not
      // seen, and both are worth showing.
      why.textContent = 'This zone is present but its graphics resource could not be read.';
      this.inspectorPane.appendChild(why);
      return;
    }

    const images = agos.art?.images.filter((each) => each.zone === zone) ?? [];
    this.inspectorPane.appendChild(
      this.paragraph(
        `${images.length} image${images.length === 1 ? '' : 's'}. Pick one from the list ` +
          `below to open it.`,
      ),
    );

    const problem = describeZoneAccess(this.zones, zone);
    if (!problem) return;
    const why = document.createElement('p');
    why.className = 'agos-summary-warning';
    // The folder bar at the top of this column carries the button that fixes
    // this, so the reason is stated here and not repeated with one beside it.
    why.textContent = this.folderProblem ?? problem;
    this.inspectorPane.appendChild(why);
  }

  private inspectImage(agos: AgosProject, zone: number, id: number): void {
    this.inspectorPane.appendChild(this.heading(`Zone ${zone}, image ${id}`));

    const listed = agos.art?.images.find((each) => each.zone === zone && each.id === id);
    if (!listed) return;

    this.inspectorPane.appendChild(
      this.paragraph(
        `${listed.width} × ${listed.height} pixels, flags 0x${listed.flags.toString(16)}.`,
      ),
    );

    const refusal = encodeSpriteRefusal(listed.flags);
    const state = document.createElement('p');
    state.className = refusal ? 'agos-summary-warning' : 'agos-paint-note';
    state.textContent = refusal
      ? `Not writable: ${refusal}.`
      : 'Writable. Painting is recorded as intent and applied to the folder at export ' +
        '(ADR 0030), so the project stays a document rather than a copy of the game.';
    this.inspectorPane.appendChild(state);

    const painted = agos.paintedImages?.some((each) => each.zone === zone && each.id === id);
    if (!painted) return;

    this.inspectorPane.appendChild(this.paragraph('You have painted this image.'));
    this.inspectorPane.appendChild(
      this.button('Revert to the original', () => {
        this.options.update((project) => {
          if (!project.agos) return;
          project.agos.paintedImages = (project.agos.paintedImages ?? []).filter(
            (each) => !(each.zone === zone && each.id === id),
          );
        });
        this.render();
        announce(`Image ${id} reverted.`);
      }),
    );
  }
  /**
   * The operand values of a Subroutine, as fields.
   *
   * ## Why values and not instructions
   *
   * ADR 0029 stores instructions, so an operand is already a number in a tree
   * and editing one is not a re-parse. What is *not* offered is inserting,
   * deleting or retyping an instruction, and the reason is width rather than
   * effort: an AGOS operand's encoded size depends on what it carried on disk —
   * a `T` is one word alone and three with a 32-bit id behind it — so any edit
   * that changed a size would move every instruction after it while every jump
   * target stayed put. Nothing here renumbers jumps, so nothing here may move
   * an instruction.
   *
   * The width rule itself is `operandWithValue` from the authoring layer rather
   * than a copy: a second implementation would eventually disagree with the
   * first, and the editor is the one that would end up permissive.
   *
   * ## Why a rejected edit puts the old value back
   *
   * A number field that keeps a refused value looks like it was accepted. The
   * field is reset from the model and the reason is announced, so what is on
   * screen is always what is in the game.
   */
  private inspectSubroutine(agos: AgosProject, id: number): void {
    this.inspectorPane.appendChild(this.operandEditors(agos, id));
  }

  private operandEditors(agos: AgosProject, id: number): HTMLElement {
    const section = document.createElement('section');
    section.className = 'agos-operands';
    const subroutine = agos.subroutines.subroutines.find((each) => each.id === id);
    if (!subroutine) return section;

    const heading = document.createElement('h3');
    heading.textContent = 'Instructions';
    section.appendChild(heading);

    if (!agos.editable.editable) {
      const why = document.createElement('p');
      why.className = 'agos-summary-warning';
      // The gate is ADR 0029's, and it is the same gate the rest of the surface
      // obeys — an operand edit on a game we decoded under the wrong Version
      // would write a plausible number into the wrong field.
      why.textContent = `Read-only: ${agos.editable.reasons.join('; ')}.`;
      section.appendChild(why);
      return section;
    }

    for (const [lineIndex, line] of subroutine.lines.entries()) {
      const block = document.createElement('div');
      block.className = 'agos-line';
      const lineHeading = document.createElement('h4');
      // A line is the unit a verb-table guard points at, so it is the unit an
      // author edits within — which is why instructions are grouped under one
      // rather than listed flat.
      lineHeading.textContent = `Line ${lineIndex}`;
      block.appendChild(lineHeading);

      for (const [instructionIndex, instruction] of line.instructions.entries()) {
        const row = document.createElement('div');
        row.className = 'agos-instruction';
        const label = document.createElement('span');
        label.textContent = `${instructionIndex}: opcode ${instruction.opcode}`;
        row.append(label, this.deleteButton(id, lineIndex, instructionIndex));

        for (const [operandIndex, operand] of instruction.operands.entries()) {
          row.appendChild(
            this.operandField(id, lineIndex, instructionIndex, operandIndex, instruction, operand),
          );
        }
        block.appendChild(row);
      }

      // Appending at the end rather than an insert-before per row: one control
      // per line is enough to build a line up, and a row of insert buttons
      // makes the position an author is choosing harder to see rather than
      // easier.
      block.appendChild(this.insertControl(id, lineIndex, line.instructions.length));
      section.appendChild(block);
    }

    if (subroutine.lines.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'This subroutine has no lines.';
      section.appendChild(none);
    }
    return section;
  }

  /**
   * Removes one instruction.
   *
   * Safe because AGOS's game bytecode refers to nothing by offset — the
   * `insertInstruction` note in `authoring/agos/edits.ts` has the correction
   * that established that, and it is the reason this control exists at all.
   */
  private deleteButton(subroutineId: number, lineIndex: number, at: number): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agos-delete-instruction';
    button.textContent = 'Delete';
    button.setAttribute('aria-label', `Delete instruction ${at} of line ${lineIndex}`);
    button.addEventListener('click', () => {
      this.options.update((project) => {
        const block = project.agos?.subroutines;
        const target = block?.subroutines.find((each) => each.id === subroutineId);
        const line = target?.lines[lineIndex];
        if (!block || !target || !line) return;
        const instructions = [...line.instructions];
        if (at < 0 || at >= instructions.length) return;
        instructions.splice(at, 1);
        this.writeLine(project, block, target, lineIndex, instructions);
      });
      this.render();
    });
    return button;
  }

  /**
   * Adds an instruction at the end of a line.
   *
   * The opcode is typed as a number rather than chosen from a list of names,
   * and that is a limit worth stating: the name a Version gives an opcode comes
   * from a generated table, and a picker over it belongs with a surface that
   * can also say what each one *does*. A number is what the model stores, so a
   * number is what this asks for until then.
   */
  private insertControl(subroutineId: number, lineIndex: number, at: number): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'agos-insert-instruction';

    const label = document.createElement('label');
    label.textContent = 'Add opcode';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.value = '';
    label.appendChild(input);

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Insert';
    button.setAttribute('aria-label', `Insert an instruction at the end of line ${lineIndex}`);

    const message = document.createElement('p');
    message.className = 'agos-summary-warning';
    message.setAttribute('role', 'status');
    message.hidden = true;

    button.addEventListener('click', () => {
      const opcode = Number(input.value);
      const target = this.target();
      const letters = OPCODE_ARG_TABLES[opcodeTableFor(target)][opcode];
      if (
        input.value === '' ||
        !Number.isInteger(opcode) ||
        letters === null ||
        letters === undefined
      ) {
        // Refused before anything is written. An opcode the Version has no
        // entry for would decode as whatever follows it, which is the failure
        // that makes a whole line unreadable rather than one instruction wrong.
        message.textContent = `Opcode ${input.value || '(none)'} is not in ${target.version}'s table.`;
        message.hidden = false;
        return;
      }
      message.hidden = true;

      const operands = defaultOperandsFor(letters, hasWideOpcodes(target.version));
      this.options.update((project) => {
        const block = project.agos?.subroutines;
        const subroutine = block?.subroutines.find((each) => each.id === subroutineId);
        const line = subroutine?.lines[lineIndex];
        if (!block || !subroutine || !line) return;
        const instructions = [...line.instructions];
        instructions.splice(Math.min(at, instructions.length), 0, { opcode, operands });
        this.writeLine(project, block, subroutine, lineIndex, instructions);
      });
      this.render();
    });

    wrapper.append(label, button, message);
    return wrapper;
  }

  /**
   * Puts a changed line back, rebuilding the tree above it.
   *
   * Shared by the two structural edits and the operand one for the reason
   * `renderItem` gives: ADR 0030 rebuilds the whole file from this tree, so a
   * half-mutated line is a file nothing corresponds to. The block is the
   * mutable field on the project — its `subroutines` array is readonly — so a
   * new block is assigned there rather than one element written into the old.
   */
  private writeLine(
    project: Project,
    block: AgosProject['subroutines'],
    subroutine: AgosProject['subroutines']['subroutines'][number],
    lineIndex: number,
    instructions: AgosInstruction[],
  ): void {
    const lines = [...subroutine.lines];
    lines[lineIndex] = { ...lines[lineIndex]!, instructions };
    const subroutines = block.subroutines.map((each) =>
      each.id === subroutine.id ? { ...subroutine, lines } : each,
    );
    if (project.agos) project.agos.subroutines = { ...block, subroutines };
  }

  private operandField(
    subroutineId: number,
    lineIndex: number,
    instructionIndex: number,
    operandIndex: number,
    instruction: { readonly opcode: number },
    operand: AgosOperand,
  ): HTMLElement {
    const label = document.createElement('label');
    label.className = 'agos-operand';
    // Located by where it is rather than by a name, because an operand has no
    // name: the argument table gives it a letter and the opcode gives it a
    // meaning. Line, instruction and index are what an author can find again.
    const caption = document.createElement('span');
    caption.textContent =
      `Line ${lineIndex}, instruction ${instructionIndex} ` +
      `(opcode ${instruction.opcode}), operand ${operandIndex} — ${describeOperand(operand)}`;

    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(valueOf(operand));
    input.addEventListener('change', () => {
      const wanted = Number(input.value);
      try {
        const replacement = operandWithValue(operand, wanted);
        this.options.update((project) => {
          const block = project.agos?.subroutines;
          const target = block?.subroutines.find((each) => each.id === subroutineId);
          const targetLine = target?.lines[lineIndex];
          const targetInstruction = targetLine?.instructions[instructionIndex];
          if (!block || !target || !targetLine || !targetInstruction) return;
          // Replaced rather than mutated all the way up, for the reason
          // `renderItem` gives: ADR 0030 rebuilds the whole file from this
          // tree, so a half-mutated instruction is a file nothing corresponds
          // to. The block itself is the mutable field on the project — its
          // `subroutines` array is readonly — so the new block is assigned
          // there rather than one element being written into the old one.
          const operands = [...targetInstruction.operands];
          operands[operandIndex] = replacement;
          const instructions = [...targetLine.instructions];
          instructions[instructionIndex] = { ...targetInstruction, operands };
          const lines = [...target.lines];
          lines[lineIndex] = { ...targetLine, instructions };
          const subroutines = block.subroutines.map((each) =>
            each.id === subroutineId ? { ...target, lines } : each,
          );
          project.agos!.subroutines = { ...block, subroutines };
        });
        this.render();
      } catch (error) {
        // Put the model's value back, so the field never shows a number the
        // game does not hold.
        input.value = String(valueOf(operand));
        const message = document.createElement('p');
        message.className = 'agos-summary-warning';
        message.setAttribute('role', 'status');
        message.textContent = error instanceof Error ? error.message : 'that value was refused';
        label.appendChild(message);
      }
    });

    label.append(caption, input);
    return label;
  }

  // ------------------------------------------------------------- actions --

  /**
   * Appends a string to the pool.
   *
   * Through `addString` rather than by splicing the pool, because the header's
   * string count has to move with it: a pool with one more string in it and an
   * unchanged count silently loses the new one on reload.
   */
  private async doAddString(): Promise<void> {
    const text = await ask('What should the new string say?', '', {
      title: 'Add a string',
      label: 'Text',
      acceptLabel: 'Add',
    });
    if (text === null) return;

    let index = -1;
    this.options.update((project) => {
      if (!project.agos) return;
      editGamePc(project.agos, (game) => {
        const result = addString(game, text);
        index = result.index;
        return result.game;
      });
    });
    if (index >= 0) this.selection = { kind: 'string', index };
    this.tab = 'text';
    this.render();
    announce(`Added string ${index}.`);
  }

  /**
   * Opens the game folder again, so the art tab has pixels (ADR 0034).
   *
   * The refusal is shown rather than thrown, because the author chose that
   * folder on purpose and "that is not this game" with no evidence reads as the
   * editor being broken.
   */
  private async doOpenFolder(): Promise<void> {
    const open = this.options.openGameFolder;
    if (!open) {
      await showAlert(
        'This surface was mounted without a way to open a folder, so the game’s art ' +
          'cannot be read here.',
        { title: 'No folder picker' },
      );
      return;
    }

    const result = await open();
    if (typeof result === 'string') {
      this.folderProblem = result;
      this.render();
      announce(result);
      return;
    }
    this.zones = result.pixels;
    this.zoneScripts = result.scripts;
    this.openedIconFile = result.icons ?? null;
    this.openedFolderName = result.name ?? null;
    this.folderProblem = null;
    this.render();
    announce(
      result.name
        ? `Game folder ${result.name} opened. The art tab can draw now.`
        : 'Game folder opened. The art tab can draw now.',
    );
  }

  /**
   * Replaces the open image from a picture on disk.
   *
   * Quantised to sixteen levels rather than to a palette, because that is what
   * four bits of AGOS index are: the importer's nearest-colour search runs over
   * a ramp of sixteen greys, so what comes back is already index values.
   */
  private async doImportImage(): Promise<void> {
    if (!this.imageIsWritable()) {
      await showAlert('This image cannot be painted, so it cannot be replaced either.', {
        title: 'Not writable',
      });
      return;
    }
    const current = this.currentBitmap();
    if ('problem' in current) return;

    const file = await pickImageFile();
    if (!file) return;

    try {
      const source = await decodeImageFile(file, {
        width: current.width,
        height: current.height,
        fit: 'contain',
      });
      const indexed = quantise(source, {
        // The ramp AGOS's four bits describe, so a "nearest colour" is a
        // nearest *index* and the import needs no second mapping after it.
        palette: Array.from({ length: 16 }, (_, index) => {
          const level = Math.round((index * 255) / 15);
          return [level, level, level];
        }),
        dither: true,
      });

      const pixels = new Uint8Array(current.width * current.height);
      for (let y = 0; y < current.height; y += 1) {
        for (let x = 0; x < current.width; x += 1) {
          const from = y * indexed.width + x;
          pixels[y * current.width + x] = (indexed.pixels[from] ?? 0) & 0x0f;
        }
      }
      const bitmap = { width: current.width, height: current.height, pixels };
      this.canvas.show(bitmap);
      this.recordPaint(bitmap);
      this.render();
      announce(`Imported ${file.name} into the open image.`);
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), {
        title: 'Could not import that image',
      });
    }
  }

  /**
   * The open image as a PNG, in the colours it is being shown in.
   *
   * The download itself is `writePng`, which is `downloadBlob`, and that is the
   * point: what stood here appended no link to the document and revoked the
   * object URL in the same tick, so every browser cancelled the save before it
   * started. `downloadBlob` carries the comment about the revoke, and a fourth
   * hand-written copy of those five lines is how this one came to be wrong.
   *
   * The colours are the second half of it. This wrote `index * 255 / 15` into
   * all three channels, so a saved picture was a ramp of greys whatever the
   * canvas above it was showing — measured over 400 of Simon 1's images, 5,606
   * of 6,384 palette entries are not grey and the mean worst channel is 214 out
   * of 255. `paletteFor` is the same call `drawCurrentImage` makes, so the file
   * and the canvas now agree by construction.
   */
  private async doExportImage(): Promise<void> {
    const current = this.currentBitmap();
    if ('problem' in current) {
      await showAlert(current.problem, { title: 'Nothing to save' });
      return;
    }
    if (this.selection.kind !== 'image') return;

    const { zone, id } = this.selection;
    const name = agosImageFilename(this.options.project().name, zone, id);
    try {
      await writePng(
        renderAgosImage(current, this.paletteFor(zone), {
          transparentZero: this.transparentZeroFor(id),
        }),
        name,
      );
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), {
        title: 'Could not save that image',
      });
      return;
    }
    announce(`Saved ${name}.`);
  }

  /**
   * The room's backdrop as a PNG, at the size it was drawn.
   *
   * The backdrop is handed in rather than drawn again, so the file is the
   * picture on screen: running the script twice would be two runs of an
   * interpreter over a scene composed of several images, and a scene that
   * drew differently the second time would be a save an author could not
   * account for.
   *
   * Opaque, unlike a sprite. Index zero in a room is the colour the entry's own
   * `VgaEntry.colour` cleared the window to — the background the scene is
   * composed over — rather than "nothing here", and a transparent save would
   * punch holes in every part of the room its images do not cover.
   */
  private async doExportRoom(item: number, drawn: RoomBackdrop): Promise<void> {
    const name = agosRoomFilename(this.options.project().name, item);
    try {
      await writePng(renderIndexedImage(drawn, drawn.palette), name);
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), {
        title: 'Could not save that room',
      });
      return;
    }
    announce(`Saved ${name}.`);
  }

  /**
   * An item's icon as a PNG, in the colours the game shows it in.
   *
   * The palette is the one zone 0's scripts load rather than a bank chosen on
   * a toolbar, because an icon's colours are not a choice: `decompressIcon`
   * ORs each nibble with a base of 208 or 224, so an icon can only ever use
   * palette entries 208..239, and those are set up once by the interface's own
   * scripts. See `itemIcons.ts` for how that was checked against the running
   * engine.
   *
   * Transparent at index zero, which is what the decompressor means by it: an
   * icon is drawn over the inventory panel and the pixels it leaves alone are
   * the panel showing through, not black.
   */
  private async doExportItemIcon(id: number, icon: number, bitmap: ItemIcon): Promise<void> {
    const version = this.agosVersion();
    const scripts = version && this.zoneScripts?.(0);
    const pixels = version && this.zones?.(0);
    if (!version || !scripts || !pixels) {
      await showAlert(
        'An icon’s colours are loaded by zone 0’s own scripts, and that zone has not been ' +
          'read. Open the game folder at the top of the properties column (ADR 0034).',
        { title: 'Nothing to save' },
      );
      return;
    }

    const palette = interfacePalette({
      scripts,
      pixels,
      version,
      agos2: zoneLayoutFor(version) === 'agos2',
    });
    if (typeof palette === 'string') {
      await showAlert(palette, { title: 'Could not save that icon' });
      return;
    }

    const name = agosItemIconFilename(this.options.project().name, id, icon);
    try {
      await writePng(renderIndexedImage(bitmap, palette, { transparentZero: true }), name);
    } catch (error) {
      await showAlert(error instanceof Error ? error.message : String(error), {
        title: 'Could not save that icon',
      });
      return;
    }
    announce(`Saved ${name}.`);
  }

  // -------------------------------------------------------------- widgets --

  private button(label: string, onClick: () => void, title?: string): HTMLButtonElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (title) element.title = title;
    element.addEventListener('click', onClick);
    return element;
  }

  private heading(text: string): HTMLElement {
    const element = document.createElement('h3');
    element.textContent = text;
    return element;
  }

  private paragraph(text: string): HTMLElement {
    const element = document.createElement('p');
    element.className = 'muted';
    element.textContent = text;
    return element;
  }

  private textField(
    label: string,
    value: string,
    enabled: boolean,
    onChange: (value: string) => void,
  ): HTMLElement {
    const field = document.createElement('label');
    field.className = 'field';
    field.append(document.createTextNode(label));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    input.disabled = !enabled;
    input.addEventListener('change', () => {
      onChange(input.value);
      this.render();
    });
    field.appendChild(input);
    return field;
  }

  private numberField(
    label: string,
    value: number,
    enabled: boolean,
    onChange: (value: number) => void,
  ): HTMLElement {
    const field = document.createElement('label');
    field.className = 'field';
    field.append(document.createTextNode(label));
    const input = document.createElement('input');
    input.type = 'number';
    input.value = String(value);
    input.disabled = !enabled;
    input.addEventListener('change', () => {
      const wanted = Number(input.value);
      if (!Number.isFinite(wanted)) {
        input.value = String(value);
        return;
      }
      try {
        onChange(wanted);
        this.render();
      } catch (error) {
        // Put the model's value back, so the field never shows a number the
        // game does not hold. A field that keeps a refused value looks like it
        // was accepted.
        input.value = String(value);
        const message = document.createElement('p');
        message.className = 'agos-summary-warning';
        message.setAttribute('role', 'status');
        message.textContent = error instanceof Error ? error.message : 'that value was refused';
        field.appendChild(message);
      }
    });
    field.appendChild(input);
    return field;
  }

  // -------------------------------------------------------------- helpers --

  private target(): AgosTarget {
    const target = this.options.project().target;
    if (target.engine !== 'agos') {
      throw new Error('AgosEditor mounted on a project that is not AGOS');
    }
    return {
      family: 'AGOS',
      version: target.version,
      releaseKind: target.releaseKind,
      platform: target.platform,
    };
  }

  private strings(): string[] {
    const agos = this.agos;
    return agos ? stringsOf(agos) : [];
  }

  /** Which Subroutines refer to a string, which is what makes reach showable. */
  private usersOf(index: number): number[] {
    const agos = this.agos;
    if (!agos) return [];
    const users: number[] = [];
    for (const subroutine of agos.subroutines.subroutines) {
      for (const line of subroutine.lines) {
        for (const instruction of line.instructions) {
          for (const operand of instruction.operands) {
            if (
              operand.kind === 'string' &&
              operand.id === index &&
              !users.includes(subroutine.id)
            ) {
              users.push(subroutine.id);
            }
          }
        }
      }
    }
    return users;
  }

  /** Which items share a noun, which is what makes a rename's scope showable. */
  private usersOfNoun(noun: number): number[] {
    const agos = this.agos;
    if (!agos) return [];
    return agos.items
      .map((item, index) => (item.noun === noun ? index + 2 : -1))
      .filter((id) => id >= 0);
  }
}

/**
 * Which field of an operand an edit changes, and what it is called.
 *
 * The two lead-carrying kinds are why this exists: an `I` or `T` that arrived
 * as a bare lead is edited *as* its lead, and one that arrived with a 32-bit id
 * behind it is edited as that id. Showing which is which is the difference
 * between an author editing the number they meant and editing the one that
 * happens to be first.
 */
function describeOperand(operand: AgosOperand): string {
  switch (operand.kind) {
    case 'word':
      return 'word';
    case 'raw':
      return 'condition word';
    case 'byte':
      return operand.variable === undefined ? 'byte' : `byte, variable ${operand.variable}`;
    case 'item':
      return operand.id === undefined ? 'item lead' : 'item id (32-bit)';
    case 'string':
      return operand.id === undefined ? 'string lead' : 'string id (32-bit)';
  }
}

/** The number an operand's field currently holds. */
function valueOf(operand: AgosOperand): number {
  switch (operand.kind) {
    case 'word':
    case 'raw':
    case 'byte':
      return operand.value;
    case 'item':
    case 'string':
      return operand.id ?? operand.lead;
  }
}
