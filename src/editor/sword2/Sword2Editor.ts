/**
 * The Broken Sword II editing surface.
 *
 * The eighth arm of the editor's one family branch, and a separate class from
 * `Sword1Editor` for ADR 0026's reason: the two families' documents share no
 * record type, so a shared editor would be a class with two modes and a flag,
 * which is the shape this project avoids.
 *
 * ## What this offers, measured against the SCUMM editor
 *
 * | SCUMM surface | Here |
 * | --- | --- |
 * | Rooms with boxes and scale | **Screens**: size, layers, palette, four parallax slots, each layer replaceable |
 * | Actors | **Objects**: every game object, with its structures and its locals |
 * | Scripts as actions | **Scripts**: decompiled instructions, operands and strings editable |
 * | Global variables | **Globals**: the game's own variable block, editable |
 * | Strings | **Text**: every module's lines |
 * | Costumes and images | **Animations**: every frame, with import and export |
 * | — | **Run lists**: which objects are alive in each session, editable |
 *
 * Run lists are the one surface with no SCUMM analogue, and they are the most
 * interesting thing to edit in this game: a session *is* a run list, so adding
 * an object to one puts it in the room.
 *
 * The pictures were read-only until `sword2Encode.ts` was written. They are not
 * now: `npm run sweep:sword` reports 14085 of the demo's 14088 animation frames
 * and 17 of 17 parallax layers re-encoding to the bytes the game shipped, and
 * the three exceptions are ties the format allows — they decode identically.
 * What limits remain are stated under the Import button rather than here.
 *
 * `docs/editor-parity.md` holds the whole three-way table — this surface, the
 * Sword 1 one and SCUMM's, row by row — with every No named and explained. The
 * five this family has are: nothing on a screen can be dragged (a position
 * lives in an object's own locals, at an offset only its code knows), no brush
 * on the screen canvas, no walk-grid editing, no adding or deleting records,
 * and no animation preview.
 */

import type { Project } from '../../authoring/project.js';
import type { Sword2Project, Sword2ProjectObject } from '../../authoring/sword2/project.js';
import {
  appendSword2Object,
  deleteSword2Object,
  editSword2Global,
  editSword2Operand,
  editSword2PaletteColour,
  editSword2RunList,
  editSword2String,
  editSword2TextLine,
  sword2ObjectDeleteRefusal,
} from '../../authoring/sword2/edits.js';
import { formatSword2Instruction } from '../../authoring/sword2/disassemble.js';
import { fromBase64 } from '../../authoring/base64.js';
import { CP } from '../../engine/sword2/script/sword2Tokens.js';
import { createSceneCanvas, type SceneWalkSelection } from '../sceneCanvas.js';
import {
  sword2ScreenBox,
  sword2ScreenDragNote,
  sword2ScreenModel,
  sword2ScreenRefusals,
  sword2ScreenStandbyRefusals,
  sword2ScreenTrouble,
} from './screenScene.js';
import {
  sword2Calls,
  sword2CallsByByte,
  sword2ConsumedBytes,
  type Sword2Call,
} from '../../authoring/sword2/calls.js';
import { operandField } from '../operandField.js';
import { walkGridPanel } from '../walkGridPanel.js';
import { sword2ArgumentField } from './callFields.js';
import { swordPictureView } from '../swordPictureView.js';
import { sword2AnimationPlaybacks } from './playback.js';
import { accordion, OpenSections } from '../shell.js';
import { sword2Actors, sword2ObjectAnimations, type Sword2Actor } from './actors.js';
import {
  compressionName,
  sword2AnimationFilename,
  sword2FrameColours,
  sword2PictureFrames,
  sword2PictureImage,
  sword2PicturePalette,
  sword2PicturePixels,
  sword2PictureRefusal,
  sword2ScreenFilename,
  sword2ScreenLayerPixels,
} from './pictureFiles.js';
import {
  deleteSword2WalkBar,
  editSword2WalkBar,
  editSword2WalkNode,
  replaceSword2AnimationFrame,
  replaceSword2ScreenLayer,
} from '../../authoring/sword2/edits.js';
import { SWORD2_LAYER_SLOTS } from '../../engine/sword2/resource/sword2Headers.js';
import { sword2ScreenPalette } from './screenScene.js';
import type { AudioSection } from '../audioSection.js';
import { swordAudioPane } from '../swordAudioPane.js';
import { groupItem, rovingGroup } from '../a11yWidgets.js';
import { STORAGE_KEYS } from '../../ui/storageKeys.js';

export interface Sword2EditorOptions {
  project: () => Project;
  update: (mutate: (project: Project) => void) => void;
  /**
   * The Audio section, shared with every other family's surface.
   *
   * A widget and not a record, which is the crossing ADR 0036 allows: what it
   * draws is a list of recordings with a play button, and that is the same
   * list here as it is for AGOS. What is *in* it comes from
   * `authoring/sword2/audioList.ts`, which is this family's alone.
   *
   * Optional because a surface can be mounted without one — the tests do —
   * and the section simply does not appear.
   */
  audio?: AudioSection;
  /**
   * The re-supplied game folder's name, or null when none is open.
   *
   * Read live rather than passed once, because the shell owns the folder and
   * it can be opened from elsewhere in the session.
   */
  folderName?: () => string | null;
  /**
   * Opens the folder the recordings are read from (ADR 0034).
   *
   * Resolves to a refusal in words, or to null when a folder was accepted.
   * Absent on a surface with no shell behind it, and the Audio section then
   * says why its rows cannot play rather than offering a button that cannot.
   */
  openGameFolder?: () => Promise<string | null>;
}

type Selection =
  | { kind: 'object'; id: number }
  | { kind: 'script'; id: number }
  | { kind: 'globals' }
  | { kind: 'text'; resource: number }
  | { kind: 'screen'; resource: number }
  | { kind: 'palette'; screen: number }
  | { kind: 'animation'; resource: number }
  | { kind: 'runList'; resource: number }
  | { kind: 'walk-grid'; resource: number }
  | { kind: 'audio' };

/** Slot 2 of five: the background, which is what an author means by "the screen". */
const SWORD2_BACKGROUND_SLOT = 2;

/**
 * What is true of this family's picture formats whatever frame is open.
 *
 * Under the Import button, where an author is standing when it matters. Both
 * sentences are about the format rather than about this project, and the second
 * is the one with a cost in it: a screen is nine things in one resource, so a
 * layer that re-encodes to a different length moves everything after it.
 */
const SWORD2_PICTURE_NOTES: readonly string[] = [
  'An imported picture is stretched to the frame’s own size: width and height are read from the ' +
    'frame header by the renderer and by the placement both, so they cannot change here. Fully ' +
    'transparent pixels become colour 0, which is this family’s transparency, and every other ' +
    'pixel is matched against colours 1 to 255 of the palette shown.',
  'An RLE16 animation draws through a sixteen-entry colour table that sits in the resource, so a ' +
    'replaced frame is quantised against those sixteen colours and not against the screen ' +
    'palette. A colour the table does not hold is refused rather than written as a wrong pixel.',
];

/** What is true of a screen's layers however many of the five a screen has. */
const SWORD2_LAYER_NOTES: readonly string[] = [
  'A screen’s five picture layers share one resource behind a table of offsets, so a layer that ' +
    're-encodes to a different length moves every block after it — the palette, the palette ' +
    'match table and the mask data included. Those offsets are rewritten with it; the layer’s ' +
    'width and height are not, because the renderer and the scroll limits both read them from ' +
    'the layer’s own header.',
  'A parallax row is a start column and alternating runs of pixels and gaps, so colour 0 is a ' +
    'hole the layer behind shows through. An imported picture’s transparent pixels become those ' +
    'holes, and every other pixel is matched against colours 1 to 255 of this screen’s palette.',
];

/** Where this surface's open sections are remembered, in the project's naming. */
const SECTIONS_KEY = STORAGE_KEYS.editorSectionsSword2;

export class Sword2Editor {
  readonly element = document.createElement('div');

  private readonly list = document.createElement('div');
  private readonly detail = document.createElement('div');
  private selection: Selection = { kind: 'globals' };
  /** The last folder refusal, shown beside the button that would try again. */
  private folderProblem: string | null = null;
  /**
   * The bar or node picked in the walk overlay.
   *
   * Outside the canvas for the reason Sword 1's is: the canvas is rebuilt from
   * the document on every render, so a selection held inside it would not
   * survive the first arrow key that moved a bar.
   */
  private walkSelection: SceneWalkSelection | null = null;
  /**
   * The object picked on the screen canvas, held for the canvas's lifetime.
   *
   * Outside the canvas for `walkSelection`'s reason, and held at all for a
   * second one: the anchor — Sword II's standby point — is drawn for the picked
   * object and has a handle of its own, and a surface that forgot what was
   * picked drew neither. Sword 1's screen view has kept one since it was
   * written; this one passed `() => null` and so never showed a standby point
   * on a real screen at all.
   */
  private sceneSelection: number | null = null;
  /** Which animation frame is open, and which of a screen's five layer slots. */
  private pictureFrame = 0;
  private layerSlot = SWORD2_BACKGROUND_SLOT;
  /**
   * The colour the brush is holding, kept on the surface rather than in the
   * panel so that it survives the re-render a frame change causes.
   */
  private brushColour = 1;
  /** Which of an object's own animations its art panel is showing. */
  private objectAnimation = 0;
  /**
   * Which list sections are open, remembered between sessions.
   *
   * The SCUMM sidebar's widget and storage, under this family's own key —
   * Broken Sword II's sections are not Broken Sword's and neither is a SCUMM
   * game's, so three surfaces remember three sidebars. Screens, Actors and
   * Objects start open.
   */
  private readonly sections = new OpenSections<string>(SECTIONS_KEY, [
    'screens',
    'actors',
    'objects',
  ]);

  constructor(private readonly options: Sword2EditorOptions) {
    this.element.className = 'sword-editor';
    this.list.className = 'sword-resource-list';
    this.detail.className = 'sword-resource-detail';
    this.element.append(this.list, this.detail);
    const first = this.sword2?.screens[0];
    if (first) this.selection = { kind: 'screen', resource: first.resource };
    this.render();
  }

  private get sword2(): Sword2Project | undefined {
    return this.options.project().sword2;
  }

  render(): void {
    this.renderList();
    this.renderDetail();
  }

  private renderList(): void {
    this.list.replaceChildren();
    const sword2 = this.sword2;
    if (!sword2) return;

    const summary = document.createElement('p');
    summary.className = 'sword-summary';
    const rounded = sword2.objects.filter((object) => object.roundTrips).length;
    summary.textContent = sword2.editable.editable
      ? `${sword2.objects.length} objects (${rounded} re-emit byte-identically), ` +
        `${sword2.globals.count} globals. Unrecovered: ${sword2.editable.unrecovered} script bytes.`
      : `No editable surface: ${sword2.editable.reasons.join('; ')}.`;
    summary.classList.toggle('sword-summary-warning', !sword2.editable.editable);
    this.list.appendChild(summary);

    const provenance = document.createElement('p');
    provenance.className = 'sword-provenance';
    provenance.textContent =
      `Release: ${sword2.identification.release} (${sword2.identification.how}) — ` +
      `${sword2.identification.evidence}`;
    this.list.appendChild(provenance);

    if (sword2.clusters.absent.length > 0) {
      const absent = document.createElement('p');
      absent.className = 'sword-provenance';
      absent.textContent = `Not in this folder: ${sword2.clusters.absent.join(', ')}.`;
      this.list.appendChild(absent);
    }

    this.list.appendChild(
      this.section('screens', 'Screens', sword2.screens.length, (body) => {
        for (const screen of sword2.screens) {
          body.appendChild(
            this.button(`Screen ${screen.resource} (${screen.width}x${screen.height})`, {
              kind: 'screen',
              resource: screen.resource,
            }),
          );
        }
      }),
    );

    const actors = sword2Actors(sword2);
    this.list.appendChild(
      this.section('actors', 'Actors', actors.length, (body) => {
        const how = document.createElement('p');
        how.className = 'sword-note';
        how.textContent =
          'Objects whose own code calls a mega opcode — fnWalk, fnStandAt, fnMegaTableAnim and ' +
          'their neighbours, which take a pointer to an ObjectMega and can be pointed at ' +
          'nothing else. Broken Sword II has no type word to read, so this is the evidence ' +
          'there is. A mega driven entirely by another object\u2019s script is not in this list.';
        body.appendChild(how);
        for (const actor of actors) {
          body.appendChild(
            this.button(
              `${actor.name || `object ${actor.id}`} (${actor.id})` +
                (actor.isPlayer ? ' \u2014 player' : ''),
              { kind: 'object', id: actor.id },
            ),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('runlists', 'Run lists', sword2.runLists.length, (body) => {
        for (const runList of sword2.runLists) {
          body.appendChild(
            this.button(`Session ${runList.resource} (${runList.objects.length} objects)`, {
              kind: 'runList',
              resource: runList.resource,
            }),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('objects', 'Objects', sword2.objects.length, (body) => {
        // Capped: a retail install has well over a thousand objects and a
        // button each is what makes a list unusable rather than long.
        for (const object of sword2.objects.slice(0, 500)) {
          body.appendChild(
            this.button(`${object.name || `object ${object.id}`} (${object.id})`, {
              kind: 'object',
              id: object.id,
            }),
          );
        }
        if (sword2.objects.length > 500) {
          const note = document.createElement('p');
          note.className = 'sword-note';
          note.textContent = `${sword2.objects.length - 500} further objects are not listed.`;
          body.appendChild(note);
        }
        body.appendChild(this.objectRecordButtons(sword2));
      }),
    );

    this.list.appendChild(
      this.section('globals', 'Globals', 1, (body) => {
        body.appendChild(this.button(`${sword2.globals.count} variables`, { kind: 'globals' }));
      }),
    );

    this.list.appendChild(
      this.section('text', 'Text', sword2.text.length, (body) => {
        for (const entry of sword2.text.slice(0, 300)) {
          body.appendChild(
            this.button(`Module ${entry.resource} (${entry.lines.length} lines)`, {
              kind: 'text',
              resource: entry.resource,
            }),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('palettes', 'Palettes', sword2.palettes.length, (body) => {
        for (const palette of sword2.palettes) {
          body.appendChild(
            this.button(`Screen ${palette.screen}`, { kind: 'palette', screen: palette.screen }),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('animations', 'Animations', sword2.animations.length, (body) => {
        for (const animation of sword2.animations.slice(0, 500)) {
          body.appendChild(
            this.button(
              `${animation.name || `anim ${animation.resource}`} (${animation.frames} frames)`,
              { kind: 'animation', resource: animation.resource },
            ),
          );
        }
      }),
    );

    const walkGrids = sword2.walkGrids ?? [];
    this.list.appendChild(
      this.section('walk-grids', 'Walk grids', walkGrids.length, (body) => {
        for (const grid of walkGrids) {
          body.appendChild(
            this.button(
              `${grid.name || `grid ${grid.resource}`} ` +
                `(${grid.bars.length} bars, ${grid.nodes.length} nodes)`,
              { kind: 'walk-grid', resource: grid.resource },
            ),
          );
        }
      }),
    );

    this.appendAudioSection();
  }

  /**
   * The Audio section in the list, as one row that opens the panel.
   *
   * A row rather than the rows themselves, for the reason the Effects section
   * is one too: the list column is a column of names and this release has
   * hundreds of recordings, so the browsing — the filter, the paging, the play
   * buttons — belongs in the detail pane where there is room for it.
   */
  private appendAudioSection(): void {
    const audio = this.options.audio;
    if (!audio) return;
    // Re-pointed on every render rather than once at construction, because the
    // section is one shared instance and whichever family's surface is mounted
    // owns it. A stale `onChanged` redraws a sidebar this surface does not
    // have, which looks exactly like a play button that does nothing.
    audio.onChanged = () => this.render();
    audio.onReveal = () => {
      this.selection = { kind: 'audio' };
    };
    this.list.appendChild(
      this.section('audio', 'Audio', audio.count, (body) => {
        body.appendChild(this.button(`${audio.count} recordings`, { kind: 'audio' }));
      }),
    );
  }

  /**
   * The Audio panel: which folder is open, then every recording.
   *
   * The section's two hooks are pointed here rather than at the shell's
   * sidebar, because on this surface the rows are in the detail pane — a
   * re-render that redrew the shell's sidebar would leave them stale, and an
   * import that revealed a sidebar section would reveal one this surface does
   * not have.
   */
  private renderAudio(): void {
    const audio = this.options.audio;
    if (!audio) return;
    this.heading(
      'Audio',
      `${audio.count} recordings this release holds, listed by the numbers its own scripts ` +
        `say. Their bytes stay in the game folder rather than in the project (ADR 0034), so ` +
        `playing, saving and replacing one all read from the folder named below.`,
    );
    swordAudioPane(this.detail, {
      audio,
      folderName: this.options.folderName?.() ?? null,
      openFolder: this.options.openGameFolder,
      problem: this.folderProblem,
      gameName: 'Broken Sword II',
      whatIsInTheFolder:
        'every sound is a resource inside a cluster, and a retail install streams its speech and music out of two more',
      note: this.audioNote(),
      onChanged: () => this.render(),
      onProblem: (message) => {
        this.folderProblem = message;
      },
    });
  }

  /**
   * What an export will and will not have been shown to do with these rows.
   *
   * Said here rather than only in `docs/editor-parity.md` §27a, because the
   * author who needs it is the one about to press Replace. The two halves are
   * genuinely different claims and the surface says which is which: an effect
   * is a resource, an export substitutes it and the cluster is relaid, and that
   * is measured on the install open here. Speech and music are entries in
   * containers `resource.inf` never names, and **no install this project can
   * reach ships one** — both Broken Sword II builds available to it are the
   * demo — so that path is written against the format and has never been read
   * back out of a real container.
   */
  private audioNote(): string {
    const streamed = this.options
      .project()
      .audio.filter((track) => track.resource?.engine === 'sword2' && track.resource.file);
    const files = [...new Set(streamed.map((track) => track.resource?.file ?? ''))];
    if (files.length === 0) {
      return (
        'Every recording here is an effect: a WAV_FILE resource inside a cluster, which an ' +
        'export substitutes and relays the cluster around — measured on this install. This one ' +
        'ships no speech or music container (a retail disc keeps those in SPEECH1.CLU and ' +
        'MUSIC1.CLU, which resource.inf never names), so there are no speech or music rows to ' +
        'replace.'
      );
    }
    return (
      `Effects are resources, and a replaced one is written into the cluster it came from — ` +
      `measured. Speech and music are entries in ${files.join(' and ')}, and replacing one is ` +
      `written but unverified: no Broken Sword II install this project can reach ships a ` +
      `container, so the write path has never been read back out of a real one. What has been ` +
      `measured is the compression itself, encoded and decoded again over real recordings.`
    );
  }

  /**
   * One collapsible list section — the widget the SCUMM sidebar uses.
   *
   * The demo holds 973 objects and a retail install many more, all of which
   * were drawn at once under a heading that could not be closed. `accordion`
   * brings the count in the header, the remembered open state and the
   * disclosure semantics a screen reader navigates by.
   */
  private section(
    name: string,
    title: string,
    count: number,
    fill: (body: HTMLElement) => void,
  ): HTMLElement {
    return accordion({
      name,
      title,
      count,
      sections: this.sections,
      idPrefix: 'sword2-accordion',
      fill: (body) => {
        body.classList.add('sword-section-body');
        fill(body);
      },
      onToggle: () => this.renderList(),
    });
  }

  private button(label: string, selection: Selection): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sword-resource';
    button.textContent = label;
    button.setAttribute(
      'aria-pressed',
      String(JSON.stringify(selection) === JSON.stringify(this.selection)),
    );
    button.addEventListener('click', () => {
      this.selection = selection;
      this.pictureFrame = 0;
      this.layerSlot = SWORD2_BACKGROUND_SLOT;
      this.render();
    });
    return button;
  }

  private heading(text: string, note?: string): void {
    const heading = document.createElement('h2');
    heading.textContent = text;
    this.detail.appendChild(heading);
    if (note) {
      const paragraph = document.createElement('p');
      paragraph.className = 'sword-note';
      paragraph.textContent = note;
      this.detail.appendChild(paragraph);
    }
  }

  private renderDetail(): void {
    this.detail.replaceChildren();
    const sword2 = this.sword2;
    if (!sword2) return;

    switch (this.selection.kind) {
      case 'object':
      case 'script':
        this.renderObject(sword2, this.selection.id);
        break;
      case 'globals':
        this.renderGlobals(sword2);
        break;
      case 'text':
        this.renderText(sword2, this.selection.resource);
        break;
      case 'screen':
        this.renderScreen(sword2, this.selection.resource);
        break;
      case 'palette':
        this.renderPalette(sword2, this.selection.screen);
        break;
      case 'animation':
        this.renderAnimation(sword2, this.selection.resource);
        break;
      case 'runList':
        this.renderRunList(sword2, this.selection.resource);
        break;
      case 'walk-grid':
        this.renderWalkGrid(sword2, this.selection.resource);
        break;
      case 'audio':
        this.renderAudio();
        break;
    }
  }

  /**
   * One walk grid as numbers, the same grid the screen canvas draws over the
   * background. The canvas is for lining a bar up against the scenery; this is
   * for typing a coordinate, and it is the way in for an author with no
   * pointer.
   */
  private renderWalkGrid(sword2: Sword2Project, resource: number): void {
    const grid = (sword2.walkGrids ?? []).find((candidate) => candidate.resource === resource);
    if (!grid) return;
    this.heading(
      grid.name || `Walk grid ${resource}`,
      `Resource ${resource}: where a character may walk. Editable and written back — an ` +
        `untouched grid leaves an export byte-identical, and a moved bar changes where this ` +
        `family's router lets a mega go.`,
    );
    walkGridPanel(this.detail, {
      id: `sword2-walk-${resource}`,
      name: grid.name || `Grid ${resource}`,
      where:
        grid.screens.length === 0
          ? null
          : `Registered by ${grid.objects.length} ` +
            `${grid.objects.length === 1 ? 'object' : 'objects'} on ` +
            `${grid.screens.length === 1 ? 'screen' : 'screens'} ` +
            `${[...grid.screens].sort((a, b) => a - b).join(', ')}.`,
      bars: grid.bars,
      nodes: grid.nodes,
      moveBar: (index, end, x, y) => {
        this.options.update((project) => {
          editSword2WalkBar(project, resource, index, { end, x, y });
        });
        this.render();
      },
      deleteBar: (index) => {
        this.options.update((project) => {
          deleteSword2WalkBar(project, resource, index);
        });
        this.render();
      },
      moveNode: (index, x, y) => {
        this.options.update((project) => {
          editSword2WalkNode(project, resource, index, x, y);
        });
        this.render();
      },
    });
  }

  /*
   * Add and remove, which is row 12 of `docs/editor-parity.md`.
   *
   * Append only, and delete only what was appended, and both of those are the
   * index's doing rather than a choice. `resource.tab` is a flat array indexed
   * by resource id and every cluster's tail table is indexed by position within
   * that cluster, so a resource added on the end of both takes an id nothing
   * has ever named and moves nothing — while one taken out of the middle would
   * renumber every resource after it in its cluster. Of the 973 objects this
   * game ships, exactly one is the last of its cluster and a run list names it,
   * so none of them can go; one appended here is the last entry of both tables
   * by construction, and can.
   *
   * The copy is of whichever object is on screen, because that is the one the
   * author is looking at and a copy has to be a copy of *something*: the
   * format has no such thing as a blank object.
   */
  private objectRecordButtons(sword2: Sword2Project): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sword-section-buttons';
    const chosen = this.selection;
    const selected =
      chosen.kind === 'object'
        ? sword2.objects.find((candidate) => candidate.id === chosen.id)
        : undefined;
    const source = selected ?? sword2.objects.find((candidate) => candidate.roundTrips);

    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+ Object';
    add.disabled = source === undefined || sword2.resourceCount === undefined;
    add.title =
      sword2.resourceCount === undefined
        ? 'This project does not record how many resource ids the index declares, so there is ' +
          'no id a new object could take. Reimport the game and it will be there.'
        : source
          ? `Adds a copy of ${source.name || `object ${source.id}`} as resource ` +
            `${sword2.resourceCount}, on the end of resource.tab and on the end of its ` +
            `cluster. The copy's hub script ids are rewritten to its own, so it runs its own ` +
            `code rather than being a second name for the original.`
          : 'This project holds no object to copy.';
    add.addEventListener('click', () => {
      if (!source) return;
      let added: number | undefined;
      this.options.update((project) => {
        added = appendSword2Object(project, source.id);
      });
      if (added !== undefined) this.selection = { kind: 'object', id: added };
      this.render();
    });
    row.appendChild(add);

    const refusal = selected
      ? sword2ObjectDeleteRefusal(this.options.project(), selected.id)
      : 'Open an object to remove it.';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = selected ? `Delete ${selected.name || `object ${selected.id}`}` : 'Delete';
    remove.disabled = refusal !== null;
    remove.title = refusal ?? `Removes object ${selected?.id}, which this editor appended.`;
    remove.addEventListener('click', () => {
      if (!selected) return;
      this.options.update((project) => {
        deleteSword2Object(project, selected.id);
      });
      this.selection = { kind: 'globals' };
      this.render();
    });
    row.appendChild(remove);
    return row;
  }

  private renderObject(sword2: Sword2Project, id: number): void {
    const object = sword2.objects.find((candidate) => candidate.id === id);
    if (!object) return;
    const calls = sword2Calls(object.instructions, object.entries);
    this.heading(
      `${object.name || `Object ${id}`}`,
      `Resource ${id}. ${object.instructions.length} instructions across ` +
        `${object.entries.length} scripts; its locals are ${object.layout.localsBytes} bytes at ` +
        `${object.layout.localsAt} and its code is ${object.layout.codeBytes} bytes at ` +
        `${object.layout.codeAt}. ` +
        `${calls.filter((call) => call.arguments.length > 0).length} of ${calls.length} calls are ` +
        `shown as named parameters, from the \`// params:\` blocks Revolution wrote. ` +
        (object.roundTrips
          ? 'Its code re-emits byte-identically, so an edit here is a checked change.'
          : 'Its code does NOT re-emit byte-identically, so editing it is refused on export.'),
    );

    this.renderObjectArt(
      sword2,
      object,
      calls,
      sword2Actors(sword2).find((candidate) => candidate.id === id) ?? null,
    );

    if (object.unrecovered.length > 0) {
      const warning = document.createElement('p');
      warning.className = 'sword-summary-warning';
      warning.textContent =
        `${object.unrecovered.length} bytes could not be decoded: ` +
        object.unrecovered
          .slice(0, 5)
          .map((bad) => `${bad.at} (${bad.why})`)
          .join('; ');
      this.detail.appendChild(warning);
    }

    const entryAt = new Map<number, number[]>();
    object.entries.forEach((at, number) => {
      const list = entryAt.get(at) ?? [];
      list.push(number);
      entryAt.set(at, list);
    });

    const listing = document.createElement('ol');
    listing.className = 'sword-listing';
    const shown = object.instructions.slice(0, 2000);
    // Only calls whose own row is on the page fold their pushes away, so a push
    // inside the cap whose call is past it still gets a row of its own.
    const last = shown[shown.length - 1]?.at ?? -1;
    const visible = calls.filter((call) => call.at <= last);
    const callAt = sword2CallsByByte(visible);
    const consumed = sword2ConsumedBytes(visible);
    for (const instruction of shown) {
      for (const number of entryAt.get(instruction.at) ?? []) {
        const header = document.createElement('li');
        header.className = 'sword-listing-entry';
        header.textContent = `script ${number}:`;
        listing.appendChild(header);
      }
      const call = callAt.get(instruction.at);
      if (call && call.arguments.length > 0) {
        listing.appendChild(this.callItem(sword2, id, call));
        continue;
      }
      if (consumed.has(instruction.at)) continue;

      const item = document.createElement('li');
      item.className = 'sword-listing-line';
      const label = document.createElement('span');
      label.textContent = `${instruction.at}: ${formatSword2Instruction(instruction)}`;
      item.appendChild(label);
      if (call?.trouble) {
        const why = document.createElement('span');
        why.className = 'sword-note';
        why.textContent = `Parameters not shown by name: ${call.trouble}.`;
        item.appendChild(why);
      }

      if (instruction.token === CP.PUSH_STRING) {
        const input = document.createElement('input');
        input.type = 'text';
        input.value = instruction.text ?? '';
        input.className = 'sword-text-line';
        input.setAttribute('aria-label', `string at byte ${instruction.at}`);
        input.addEventListener('change', () => {
          this.options.update((project) => {
            editSword2String(project, id, instruction.at, input.value);
          });
          this.render();
        });
        item.appendChild(input);
      } else {
        instruction.operands.forEach((operand, index) => {
          const input = document.createElement('input');
          input.type = 'number';
          input.value = String(operand);
          input.className = 'sword-operand';
          input.setAttribute('aria-label', `operand ${index} at byte ${instruction.at}`);
          input.addEventListener('change', () => {
            const value = Number.parseInt(input.value, 10);
            if (!Number.isFinite(value)) return;
            this.options.update((project) => {
              editSword2Operand(project, id, instruction.at, index, value);
            });
            this.render();
          });
          item.appendChild(input);
        });
      }
      listing.appendChild(item);
    }
    this.detail.appendChild(listing);
  }

  /**
   * One call as a row of named parameters.
   *
   * A `CP_PUSH_STRING` parameter is a text box rather than a number, because
   * that is what it pushes — and it is written through `editSword2String`,
   * which refuses a longer string rather than moving every instruction after
   * it.
   */
  private callItem(sword2: Sword2Project, id: number, call: Sword2Call): HTMLElement {
    const item = document.createElement('li');
    item.className = 'sword-listing-line sword-call';

    const label = document.createElement('span');
    label.className = 'sword-call-name';
    label.textContent = `${call.at}: ${call.name}`;
    item.appendChild(label);

    const count = document.createElement('span');
    count.className = 'sword-call-count';
    count.textContent = `${call.count} parameter${call.count === 1 ? '' : 's'}`;
    item.appendChild(count);

    const fields = document.createElement('div');
    fields.className = 'sword-call-fields';
    for (const argument of call.arguments) {
      const field = sword2ArgumentField(sword2, argument);
      if (argument.push === 'string') {
        const wrapper = document.createElement('label');
        wrapper.className = 'field operand-field';
        const text = document.createElement('span');
        text.textContent = field.label;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = argument.text ?? '';
        input.addEventListener('change', () => {
          this.options.update((project) => {
            editSword2String(project, id, argument.at, input.value);
          });
          this.render();
        });
        wrapper.append(text, input);
        fields.appendChild(wrapper);
        continue;
      }
      fields.appendChild(
        operandField({
          id: `sword2-${id}-${argument.at}`,
          label: field.label,
          value: argument.value,
          choices: field.choices,
          hint: field.hint,
          onChange: (value) => {
            this.options.update((project) => {
              editSword2Operand(project, id, argument.at, 0, value);
            });
            this.render();
          },
        }),
      );
    }
    item.appendChild(fields);
    return item;
  }

  private renderGlobals(sword2: Sword2Project): void {
    this.heading(
      'Script variables',
      `${sword2.globals.count} of them, read from the game's own global variable file (resource ` +
        `1) rather than from a table this project carries — which is why the count cannot be ` +
        `widened. The first hundred are listed; the rest are reachable by number.`,
    );
    const bytes = fromBase64(sword2.globals.bytesBase64);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const table = document.createElement('table');
    table.className = 'sword-fields';
    for (let number = 0; number < Math.min(100, sword2.globals.count); number++) {
      const row = document.createElement('tr');
      const key = document.createElement('th');
      key.scope = 'row';
      key.textContent = String(number);
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(view.getInt32(number * 4, true));
      input.setAttribute('aria-label', `script variable ${number}`);
      input.addEventListener('change', () => {
        const value = Number.parseInt(input.value, 10);
        if (!Number.isFinite(value)) return;
        this.options.update((project) => {
          editSword2Global(project, number, value);
        });
      });
      cell.appendChild(input);
      row.append(key, cell);
      table.appendChild(row);
    }
    this.detail.appendChild(table);
  }

  private renderText(sword2: Sword2Project, resource: number): void {
    const entry = sword2.text.find((candidate) => candidate.resource === resource);
    if (!entry) return;
    this.heading(
      `Text module ${resource}`,
      `${entry.lines.length} lines. Each line's first two bytes are a wav id the original strips ` +
        `before displaying, which is why the text shown starts past them.`,
    );
    const listing = document.createElement('ol');
    listing.className = 'sword-listing';
    entry.lines.forEach((line, index) => {
      const item = document.createElement('li');
      item.className = 'sword-listing-line';
      const number = document.createElement('span');
      number.textContent = `${index}`;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = line;
      input.className = 'sword-text-line';
      input.setAttribute('aria-label', `line ${index} of module ${resource}`);
      input.addEventListener('change', () => {
        this.options.update((project) => {
          editSword2TextLine(project, resource, index, input.value);
        });
      });
      item.append(number, input);
      listing.appendChild(item);
    });
    this.detail.appendChild(listing);
  }

  private renderScreen(sword2: Sword2Project, resource: number): void {
    const screen = sword2.screens.find((candidate) => candidate.resource === resource);
    if (!screen) return;
    this.heading(
      `Screen ${resource}`,
      'One resource holding nine things: two background parallax layers, the background, two ' +
        'foreground parallax layers, the mask table, the palette, the palette match table and ' +
        'the mask data. Editable: each of the five picture layers decodes and re-encodes, and ' +
        'an unmodified layer comes back byte-identical.',
    );

    this.renderScreenPicture(sword2, resource);
    this.renderScreenLayers(sword2, resource);

    const table = document.createElement('table');
    table.className = 'sword-fields';
    const rows: Array<[string, string]> = [
      ['Size', `${screen.width} x ${screen.height}`],
      ['Mask layers', String(screen.layers)],
      ['Palette', screen.hasPalette ? 'present' : 'none (the previous one stands)'],
      [
        'Parallax',
        ['background 0', 'background 1', 'foreground 0', 'foreground 1']
          .filter((_, at) => screen.parallax[at])
          .join(', ') || 'none',
      ],
    ];
    for (const [label, value] of rows) {
      const row = document.createElement('tr');
      const key = document.createElement('th');
      key.scope = 'row';
      key.textContent = label;
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(key, cell);
      table.appendChild(row);
    }
    this.detail.appendChild(table);
  }

  /**
   * The screen itself, drawn, with the objects standing on it outlined.
   *
   * The same canvas the Broken Sword and SCUMM room views use, reading a model
   * built from Sword II's own records. What can be dragged is stated as a count
   * under the picture, and every object that cannot is named with its reason —
   * an author reading "10 of 24" learns something true about the screen, where
   * a silent refusal taught them nothing.
   */
  private renderScreenPicture(sword2: Sword2Project, resource: number): void {
    const trouble = sword2ScreenTrouble(sword2, resource);
    if (trouble) {
      const note = document.createElement('p');
      note.className = 'sword-note';
      note.textContent = trouble;
      this.detail.appendChild(note);
      return;
    }

    const status = document.createElement('p');
    status.className = 'sword-note';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const chosen = document.createElement('p');
    chosen.className = 'sword-note';

    const canvas = createSceneCanvas(
      sword2ScreenModel(resource, {
        project: () => this.options.project().sword2,
        update: (mutate) => this.options.update(mutate),
        selected: () => this.sceneSelection,
        select: (id) => {
          this.sceneSelection = id;
          this.describeChosen(sword2, resource, chosen);
        },
        walkSelected: () => this.walkSelection,
        selectWalk: (selection) => {
          this.walkSelection = selection;
        },
      }),
      {
        id: `sword2-screen-${resource}-help`,
        onChange: (message) => {
          status.textContent = message;
        },
      },
    );

    // Said whether or not there is a canvas to say it under: which objects a
    // screen holds, and which of them state a rectangle, are facts about the
    // game's data and not about this browser.
    const drag = document.createElement('p');
    drag.className = 'sword-note';
    drag.textContent = sword2ScreenDragNote(sword2, resource);

    // Two lists, because an object can be in both: its rectangle may drag
    // while its standby point is refused, and collapsing the two would tell an
    // author their door cannot be moved when only the stand-here point cannot.
    const refusals = sword2ScreenRefusals(sword2, resource);
    const refused = this.refusalList(refusals);
    const standby = sword2ScreenStandbyRefusals(sword2, resource);
    const standbyRefused = this.refusalList(standby);

    this.describeChosen(sword2, resource, chosen);

    if (!canvas) {
      const note = document.createElement('p');
      note.className = 'sword-note';
      note.textContent =
        'This browser has no 2D canvas, so the screen cannot be drawn here. Its facts are below.';
      this.detail.append(note, drag);
      if (refusals.length > 0) this.detail.appendChild(refused);
      if (standby.length > 0) this.detail.appendChild(standbyRefused);
      return;
    }

    const figure = document.createElement('div');
    figure.className = 'sword-screen-canvas';
    figure.append(canvas.element, canvas.help);
    this.detail.append(figure, status, chosen, drag);
    if (refusals.length > 0) this.detail.appendChild(refused);
    if (standby.length > 0) this.detail.appendChild(standbyRefused);
  }

  /** A refusal list, each object named with the sentence saying why. */
  private refusalList(refusals: readonly { id: number; name: string; why: string }[]): HTMLElement {
    const list = document.createElement('ul');
    list.className = 'sword-notes';
    for (const refusal of refusals) {
      const row = document.createElement('li');
      row.textContent = `${refusal.name || `object ${refusal.id}`} ${refusal.why}.`;
      list.appendChild(row);
    }
    return list;
  }

  /**
   * Names the object picked on the canvas, and says what its handles do.
   *
   * The same note Sword 1's screen view carries, with the standby point added:
   * a picked object that sets one has two handles, and which one the arrows are
   * aimed at is a thing the author has to be able to read rather than guess.
   */
  private describeChosen(sword2: Sword2Project, resource: number, into: HTMLElement): void {
    into.replaceChildren();
    const id = this.sceneSelection;
    // Read back off this screen rather than trusted: the pick outlives the
    // screen it was made on, and an object named here that this screen does not
    // hold would be a note about somewhere else.
    const box = id === null ? null : sword2ScreenBox(sword2, resource, id);
    if (id === null || !box) {
      into.textContent =
        'Nothing picked. Click an outlined object, or move the cursor with the arrow keys and ' +
        'press Enter. Alt with an arrow key moves what is picked.';
      return;
    }
    const object = sword2.objects.find((candidate) => candidate.id === id);
    into.append(`Picked ${object?.name || `object ${id}`}. `);
    if (box.anchor) {
      into.append(
        `Its standby point is at ${box.anchor.x.value}, ${box.anchor.y.value}: press Enter over ` +
          `that handle to pick it, and Alt with an arrow moves it on its own. `,
      );
    } else if (box.anchorWhy) {
      into.append(`Its standby point ${box.anchorWhy}. `);
    }
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = `Open ${object?.name || `object ${id}`}`;
    open.addEventListener('click', () => {
      this.selection = { kind: 'object', id };
      this.render();
    });
    into.appendChild(open);
  }

  /**
   * The five picture layers, one at a time, with Import and Export on each.
   *
   * The composed picture above is the screen as the game draws it; this is the
   * screen as it is *stored*, which is what an author replacing art needs — the
   * background alone, without the two parallax layers in front of it.
   *
   * The cost worth naming is length. All five live in one resource behind a
   * table of offsets, so a layer that re-encodes longer or shorter moves every
   * block after it, and `replaceSword2ScreenLayer` rewrites the multi-screen
   * header and the mask table's offsets to match. A layer's *size* cannot
   * change: the renderer and the scroll limits both read it from the layer's own
   * two-word header.
   */
  private renderScreenLayers(sword2: Sword2Project, resource: number): void {
    const present = SWORD2_LAYER_SLOTS.map((_, slot) =>
      sword2ScreenLayerPixels(sword2, resource, slot),
    );
    if (present.every((layer) => layer === null)) return;

    const slot = present[this.layerSlot]
      ? this.layerSlot
      : present.findIndex((layer) => layer !== null);
    const layer = present[slot];
    if (!layer) return;

    const palette = sword2ScreenPalette(sword2, resource);
    this.detail.appendChild(
      swordPictureView({
        id: `sword2-screen-${resource}-layers`,
        title: `screen ${resource}, ${SWORD2_LAYER_SLOTS[slot]}`,
        frames: present.flatMap((candidate, at) =>
          candidate
            ? [
                {
                  index: at,
                  label: `${SWORD2_LAYER_SLOTS[at]} — ${candidate.width}x${candidate.height}`,
                },
              ]
            : [],
        ),
        selected: slot,
        onSelect: (chosen) => {
          this.layerSlot = chosen;
          this.render();
        },
        pixels: { width: layer.width, height: layer.height, pixels: layer.pixels },
        image: sword2PictureImage(
          { width: layer.width, height: layer.height, pixels: layer.pixels },
          palette,
          // The background covers the screen and its colour 0 is a hole in it,
          // which is worth seeing as a hole rather than as black.
          { transparentZero: true },
        ),
        palette,
        refusal: null,
        filename: sword2ScreenFilename(this.options.project().name, resource, slot),
        onReplace: (imported, width, height) => {
          this.options.update((project) => {
            replaceSword2ScreenLayer(project, resource, slot, imported, width, height);
          });
          this.render();
        },
        // No re-render, for the reason the picture panel gives: this canvas is
        // the one being painted on.
        onPaint: (painted, width, height) => {
          this.options.update((project) => {
            replaceSword2ScreenLayer(project, resource, slot, painted, width, height);
          });
        },
        colour: this.brushColour,
        onColour: (chosen) => {
          this.brushColour = chosen;
        },
        notes: SWORD2_LAYER_NOTES,
      }),
    );
  }

  private renderPalette(sword2: Sword2Project, screen: number): void {
    const palette = sword2.palettes.find((candidate) => candidate.screen === screen);
    if (!palette) return;
    const bytes = fromBase64(palette.bytesBase64);
    this.heading(
      `Palette — screen ${screen}`,
      'Four bytes an entry, not three: the fourth is unused by the renderer and is left alone ' +
        'when a colour is edited.',
    );
    const grid = document.createElement('div');
    grid.className = 'sword-palette';
    for (let index = 0; index * 4 + 2 < bytes.length; index++) {
      const red = bytes[index * 4];
      const green = bytes[index * 4 + 1];
      const blue = bytes[index * 4 + 2];
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'sword-swatch';
      swatch.style.backgroundColor = `rgb(${red},${green},${blue})`;
      swatch.title = `${index}: ${red},${green},${blue}`;
      swatch.setAttribute(
        'aria-label',
        `colour ${index}: red ${red}, green ${green}, blue ${blue}`,
      );
      swatch.addEventListener('click', () => {
        this.options.update((project) => {
          editSword2PaletteColour(project, screen, index, red, green, blue);
        });
        this.render();
      });
      grid.appendChild(swatch);
    }
    this.detail.appendChild(grid);
  }

  /**
   * One animation, frame by frame, with Import and Export on the open frame.
   *
   * "Preserved bytes, decoded on demand" is what stood here, and it stopped
   * being true when `sword2Encode.ts` was written: the sweep reports 14085 of
   * the demo's 14088 frames re-encoding to the bytes the game shipped, and the
   * three that do not are ties in the format that decode to the same pixels.
   *
   * The colours are a stated guess rather than a silent one. An animation
   * carries no palette — which screen a mega is drawn on is decided at run time
   * by whichever script placed it — so the project's first screen is used and
   * the sentence under the picture says so.
   */
  /**
   * The Import/Export panel for one animation, wherever it is used.
   *
   * Factored out of the Animations pane so that an object can carry it, which
   * is the difference an author noticed: the panel was there, and it was there
   * only in a list of resource numbers. A picture is edited where it is used or
   * it may as well not be editable.
   *
   * Null when the project holds the animation's row but not its bytes — the
   * importer takes the largest resources until a budget runs out — and the
   * callers say so in their own words.
   */
  private animationPanel(sword2: Sword2Project, resource: number, id: string): HTMLElement | null {
    const animation = sword2.animations.find((candidate) => candidate.resource === resource);
    if (!animation) return null;
    const frames = sword2PictureFrames(animation);
    if (frames.length === 0) return null;
    const frame = frames.find((candidate) => candidate.index === this.pictureFrame) ?? frames[0];
    const index = frame?.index ?? 0;
    const pixels = sword2PicturePixels(animation, index);
    const palette = sword2PicturePalette(sword2);
    const table = sword2FrameColours(animation, index);
    const found = sword2AnimationPlaybacks(sword2, resource);
    return swordPictureView({
      id,
      title: `${animation.name || `animation ${resource}`}, frame ${index}`,
      frames: frames.map((candidate) => ({ index: candidate.index, label: candidate.label })),
      selected: index,
      onSelect: (chosen) => {
        this.pictureFrame = chosen;
        this.render();
      },
      pixels,
      image: pixels ? sword2PictureImage(pixels, palette) : null,
      palette,
      allowed: table ?? undefined,
      // An RLE16 frame whose table has no zero cannot hold a transparent
      // pixel, so an import must not make one and the panel must not pretend.
      transparentZero: table === null || table.includes(0),
      refusal: sword2PictureRefusal(animation, index),
      filename: sword2AnimationFilename(this.options.project().name, resource, index),
      onReplace: (imported, width, height) => {
        this.options.update((project) => {
          replaceSword2AnimationFrame(project, resource, index, imported, width, height);
        });
        this.render();
      },
      onPaint: (painted, width, height) => {
        this.options.update((project) => {
          replaceSword2AnimationFrame(project, resource, index, painted, width, height);
        });
      },
      colour: this.brushColour,
      onColour: (chosen) => {
        this.brushColour = chosen;
      },
      notes: SWORD2_PICTURE_NOTES,
      playbacks: found.playbacks,
      playbackRefusal: found.refusal,
      frameImage: (chosen) => {
        const other = sword2PicturePixels(animation, chosen);
        return other ? sword2PictureImage(other, palette) : null;
      },
    });
  }

  /**
   * An object's own art, on the object.
   *
   * Which animations belong to an object is not written down anywhere: Sword II
   * keeps no table of "this object's sprites". What it does have is the
   * object's code, which names the animation resources it plays — and
   * `sword2Calls` already reads a call's parameters by the `// params:` blocks
   * Revolution wrote, so an argument the table calls a resource id, pushed as a
   * literal, and matching an animation this project holds, is this object's
   * art on the game's own evidence.
   *
   * A character's *megaset* is the one case those blocks do not name — the
   * block calls `fnSetValue`'s argument "value to set it to" — and it is the
   * case the player character is made of. `sword2ObjectAnimations` follows it
   * for the reason set out there.
   *
   * A resource picked out of a variable at run time is deliberately not
   * followed. Reading a variable's *number* as a resource id would put some
   * other character's walk cycle on this object's page, which is worse than
   * showing nothing.
   */
  private renderObjectArt(
    sword2: Sword2Project,
    object: Sword2ProjectObject,
    calls: readonly Sword2Call[],
    actor: Sword2Actor | null,
  ): void {
    const animations = sword2ObjectAnimations(sword2, object, calls);
    const heading = document.createElement('h3');
    heading.textContent = 'Art';
    this.detail.appendChild(heading);

    if (animations.length === 0) {
      const note = document.createElement('p');
      note.className = 'sword-note';
      note.textContent = actor
        ? `This object walks — its code calls ${actor.evidence.join(', ')} — but every ` +
          `animation it plays is chosen at run time, or its bytes are not in this project, so ` +
          `there is no frame here to export or replace. A mega whose megaset is set for it by ` +
          `another object’s script is this case.`
        : 'This object\u2019s code names no animation resource this project holds, so there is ' +
          'nothing here to export or replace. A background object with a mouse area and no ' +
          'sprite is the ordinary case.';
      this.detail.appendChild(note);
      return;
    }

    const chosen = animations.includes(this.objectAnimation)
      ? this.objectAnimation
      : (animations[0] ?? 0);

    if (animations.length > 1) {
      /*
       * A radio group rather than a row of toggles.
       *
       * Only one of these can be the animation on show, which is what a radio
       * group means and what a set of `aria-pressed` buttons does not: a
       * screen reader announces "2 of 3" here, and arrow keys move between
       * them on one tab stop. It is the same widget the frame strip below it
       * uses, for the same reason — an object with eleven animations would
       * otherwise be eleven tab stops before the picture.
       */
      const picker = document.createElement('div');
      picker.className = 'sword-frame-strip';
      for (const resource of animations) {
        const animation = sword2.animations.find((candidate) => candidate.resource === resource);
        const label = `${animation?.name || `animation ${resource}`} (${resource})`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sword-resource';
        button.textContent = label;
        groupItem(button, { role: 'radio', selected: resource === chosen, label });
        button.addEventListener('click', () => {
          this.objectAnimation = resource;
          this.pictureFrame = 0;
          this.render();
        });
        picker.appendChild(button);
      }
      rovingGroup(picker, {
        role: 'radiogroup',
        label: `animations named by ${object.name || `object ${object.id}`}`,
      });
      this.detail.appendChild(picker);
    }

    const panel = this.animationPanel(sword2, chosen, `sword2-object-${object.id}-art`);
    if (panel) {
      this.detail.appendChild(panel);
    } else {
      const note = document.createElement('p');
      note.className = 'sword-note';
      note.textContent =
        `Animation ${chosen}\u2019s bytes are not in this project \u2014 importing takes the ` +
        `largest resources until a budget runs out \u2014 so there is no frame to draw or ` +
        `replace. It is still in the game\u2019s cluster.`;
      this.detail.appendChild(note);
    }

    const said = document.createElement('p');
    said.className = 'sword-note';
    said.textContent =
      `${animations.length} animation${animations.length === 1 ? '' : 's'} named by this ` +
      `object\u2019s own code: ${animations.join(', ')}.` +
      (actor ? ` It is a character: its code calls ${actor.evidence.join(', ')}.` : '');
    this.detail.appendChild(said);
  }

  private renderAnimation(sword2: Sword2Project, resource: number): void {
    const animation = sword2.animations.find((candidate) => candidate.resource === resource);
    if (!animation) return;
    const frames = sword2PictureFrames(animation);
    const frame = frames.find((candidate) => candidate.index === this.pictureFrame) ?? frames[0];
    const index = frame?.index ?? 0;

    this.heading(
      `${animation.name || `Animation ${resource}`}`,
      `${animation.frames} frames, ${compressionName(animation.compression)}. Editable: this ` +
        `project re-encodes all three of the family’s schemes, and an unmodified frame comes ` +
        `back as the bytes the game shipped.` +
        (animation.compression === 2
          ? ' RLE16 packs two pixels a byte through a sixteen-entry colour table that sits ' +
            'between the frame table and the frames.'
          : ''),
    );

    if (frames.length === 0) {
      const note = document.createElement('p');
      note.className = 'sword-note';
      note.textContent =
        'This animation’s bytes are not in this project — importing takes the largest ' +
        'resources until a budget runs out — so there is no frame to draw or replace.';
      this.detail.appendChild(note);
      return;
    }

    const panel = this.animationPanel(sword2, resource, `sword2-animation-${resource}`);
    if (panel) this.detail.appendChild(panel);

    if (frame) {
      const facts = document.createElement('p');
      facts.className = 'sword-note';
      facts.textContent =
        `Frame ${index} is ${frame.width}x${frame.height}, ${compressionName(frame.compression)}, ` +
        `placed at (${frame.x}, ${frame.y}). Shown in screen ` +
        `${sword2.screens[0]?.resource ?? '—'}’s palette, which is a guess: an animation carries ` +
        `no palette of its own and the script decides which screen it is drawn on.`;
      this.detail.appendChild(facts);
    }
  }

  private renderRunList(sword2: Sword2Project, resource: number): void {
    const runList = sword2.runLists.find((candidate) => candidate.resource === resource);
    if (!runList) return;
    this.heading(
      `Session ${resource}`,
      `${runList.objects.length} objects. A session *is* a run list in this game — changing room ` +
        `is one opcode replacing this resource id — so adding an object here puts it in the ` +
        `room, which is the most direct edit this family has.`,
    );
    const input = document.createElement('textarea');
    input.className = 'sword-run-list';
    input.value = runList.objects.join('\n');
    input.setAttribute('aria-label', `object ids in session ${resource}, one per line`);
    input.addEventListener('change', () => {
      const ids = input.value
        .split(/\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((value) => Number.isFinite(value) && value > 0);
      this.options.update((project) => {
        editSword2RunList(project, resource, ids);
      });
      this.render();
    });
    this.detail.appendChild(input);

    const names = document.createElement('ul');
    names.className = 'sword-listing';
    for (const id of runList.objects) {
      const object = sword2.objects.find((candidate) => candidate.id === id);
      const item = document.createElement('li');
      item.textContent = `${id}: ${object?.name ?? '(not in this install)'}`;
      names.appendChild(item);
    }
    this.detail.appendChild(names);
  }
}
