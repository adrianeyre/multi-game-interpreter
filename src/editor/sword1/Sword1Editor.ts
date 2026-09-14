/**
 * The Broken Sword editing surface.
 *
 * The editor branches on Engine family exactly once, at the mount point in
 * `main.ts`, and this is the seventh arm of that branch.
 *
 * ## What this offers, measured against the SCUMM editor
 *
 * The SCUMM surface has rooms, actors, scripts as editable actions, an audio
 * library and image import. This one answers each of those in Broken Sword's own
 * terms, which is the standard ADR 0013 sets — the same *capabilities*, never a
 * pretend SCUMM room:
 *
 * | SCUMM surface | Here |
 * | --- | --- |
 * | Rooms with boxes and scale | **Screens**: size, layers, masks, palettes, parallax |
 * | Actors | **Compacts**: every object, with the fields the bytecode addresses |
 * | Scripts as actions | **Scripts**: decompiled instructions, operands editable |
 * | Strings | **Text**: every line in every language the release ships |
 * | Costumes and images | **Pictures**: sprites, backgrounds and parallax, with import and export |
 * | Audio library | **Effects**: the fx table, with each effect's rooms and volumes |
 *
 * One of those is narrower than SCUMM's and says so on the surface rather than
 * in a footnote: screens are editable-not-writable because the room table lived
 * in Revolution's interpreter rather than in the game's files, so there is
 * nowhere to write a change.
 *
 * Pictures used to be the second. They are not any more: `swordEncode.ts`
 * writes RLE7, RLE0 and Tony as well as reading them, and `npm run sweep:sword`
 * reports 7113 of the demo's 7113 sprite frames and 2 of 2 parallax layers
 * re-encoding to the bytes Revolution shipped. What is left of the limit is two
 * sentences under the Import button — HIF, which no PC release uses, and one
 * shape RLE7 cannot express, which is written uncompressed instead. A mask
 * layer used to be on that list as "not a picture at all"; it is one now,
 * composed through the Grid resource the importer carries beside it, and it
 * appears under the screen that uses it.
 *
 * `docs/editor-parity.md` holds the whole three-way table — this surface, the
 * Sword II one and SCUMM's, row by row — with every No named and explained.
 * The four this family has are: no brush on the screen canvas, no walk-grid
 * editing, no adding or deleting records, and no animation preview.
 */

import type { Project } from '../../authoring/project.js';
import type {
  Sword1Project,
  Sword1ProjectCompact,
  Sword1ProjectSection,
} from '../../authoring/sword1/project.js';
import {
  appendSword1Compact,
  deleteSword1Compact,
  deleteSword1WalkBar,
  editSword1CompactWord,
  editSword1StartPosition,
  sword1CompactDeleteRefusal,
  editSword1Operand,
  editSword1PaletteColour,
  editSword1TextLine,
  editSword1WalkBar,
  editSword1WalkNode,
} from '../../authoring/sword1/edits.js';
import {
  formatSword1Instruction,
  sword1CompactFieldName,
} from '../../authoring/sword1/disassemble.js';
import { fromBase64 } from '../../authoring/base64.js';
import { CPT } from '../../engine/sword1/resource/swordCompact.js';
import { createSceneCanvas, type SceneWalkSelection } from '../sceneCanvas.js';
import { sword1ScreenModel, sword1ScreenTrouble } from './screenScene.js';
import { sword1McodeName } from '../../engine/sword1/script/mcodeNames.js';
import { sword1VarLayout } from '../../engine/sword1/script/swordVarLayout.js';
import {
  sword1Calls,
  sword1CallsByWord,
  sword1ConsumedWords,
  type Sword1Call,
} from '../../authoring/sword1/calls.js';
import { operandField } from '../operandField.js';
import { walkGridPanel } from '../walkGridPanel.js';
import { sword1ArgumentField } from './callFields.js';
import { swordPictureView } from '../swordPictureView.js';
import { sword1SpritePlaybacks } from './playback.js';
import { accordion, OpenSections } from '../shell.js';
import { groupItem, rovingGroup } from '../a11yWidgets.js';
import { sword1Actors, type Sword1Actor } from './actors.js';
import { SwordType } from '../../engine/sword1/resource/swordDefs.js';
import { sword1AbsentPictureReason } from './absence.js';
import {
  sword1PictureFilename,
  sword1PictureFrames,
  sword1PictureImage,
  sword1PictureIsTransparent,
  sword1PicturePalette,
  sword1PicturePixels,
  sword1PictureRefusal,
} from './pictureFiles.js';
import { replaceSword1Picture } from '../../authoring/sword1/edits.js';
import type { AudioSection } from '../audioSection.js';
import { swordAudioPane } from '../swordAudioPane.js';
import { STORAGE_KEYS } from '../../ui/storageKeys.js';

export interface Sword1EditorOptions {
  project: () => Project;
  update: (mutate: (project: Project) => void) => void;
  /**
   * The Audio section, shared with every other family's surface.
   *
   * A widget and not a record, which is the crossing ADR 0036 allows: what it
   * draws is a list of recordings with a play button, and that is the same
   * list here as it is for AGOS. What is *in* it comes from
   * `authoring/sword1/audioList.ts`, which is this family's alone.
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
  | { kind: 'screen'; screen: number }
  | { kind: 'section'; section: number }
  | { kind: 'compact'; id: number }
  | { kind: 'script'; resource: number }
  | { kind: 'text'; resource: number }
  | { kind: 'palette'; resource: number }
  | { kind: 'picture'; resource: number }
  | { kind: 'walk-grid'; resource: number }
  | { kind: 'effects' }
  | { kind: 'start-positions' }
  | { kind: 'audio' };

/**
 * What is true of Broken Sword's picture formats whatever frame is open.
 *
 * Two limits and both are the format's rather than this project's, so they are
 * stated where an author is standing when they matter — under the Import
 * button — and not in a document's footnote.
 */
const SWORD1_PICTURE_NOTES: readonly string[] = [
  'HIF is the one scheme with no encoder here. It is LZ77 with a 4096-byte window, and an LZ ' +
    'match-finder chooses between equally good matches, so a re-encode would be different bytes ' +
    'for the same pixels. Only the PlayStation conversion uses it; no PC release carries a HIF ' +
    'frame.',
  'RLE7 has one shape it cannot express: a lone pixel whose colour is 1 to 127, because its ' +
    'literals are 0 and 128 to 255 and its runs are at least two long. No shipped frame contains ' +
    'one and imported artwork can, so such a frame is re-tagged NONE and written uncompressed ' +
    'rather than losing the pixel.',
  'An imported picture is stretched to the frame’s own size: the width and height are read from ' +
    'the frame header by the renderer and by the sprite’s placement both, so they cannot change ' +
    'here. Fully transparent pixels become colour 0, which is this family’s transparency, and ' +
    'every other pixel is matched against colours 1 to 255 of the palette shown.',
];

/** The compact fields worth showing first, in the order an author wants them. */
const HEADLINE_FIELDS: ReadonlyArray<{ name: string; offset: number }> = [
  { name: 'o_type', offset: CPT.TYPE },
  { name: 'o_status', offset: CPT.STATUS },
  { name: 'o_logic', offset: CPT.LOGIC },
  { name: 'o_screen', offset: CPT.SCREEN },
  { name: 'o_xcoord', offset: CPT.XCOORD },
  { name: 'o_ycoord', offset: CPT.YCOORD },
  { name: 'o_dir', offset: CPT.DIR },
  { name: 'o_place', offset: CPT.PLACE },
  { name: 'o_resource', offset: CPT.RESOURCE },
  { name: 'o_frame', offset: CPT.FRAME },
  { name: 'o_priority', offset: CPT.PRIORITY },
  { name: 'o_mouse_x1', offset: CPT.MOUSE_X1 },
  { name: 'o_mouse_y1', offset: CPT.MOUSE_Y1 },
  { name: 'o_mouse_x2', offset: CPT.MOUSE_X2 },
  { name: 'o_mouse_y2', offset: CPT.MOUSE_Y2 },
  { name: 'o_interact', offset: CPT.INTERACT },
  { name: 'o_get_to_script', offset: CPT.GET_TO_SCRIPT },
  { name: 'o_text_id', offset: CPT.TEXT_ID },
];

/** Where this surface's open sections are remembered, in the project's naming. */
const SECTIONS_KEY = STORAGE_KEYS.editorSectionsSword1;

export class Sword1Editor {
  readonly element = document.createElement('div');

  private readonly list = document.createElement('div');
  private readonly detail = document.createElement('div');
  private selection: Selection = { kind: 'effects' };
  /** The compact picked on the screen canvas, which is not the detail view. */
  private sceneSelection: number | null = null;
  /**
   * The bar or node picked in the walk overlay.
   *
   * Held here rather than in the canvas because the canvas is rebuilt from the
   * document on every render, and a selection inside it would be lost the first
   * time a bar moved — which is every arrow key press.
   */
  private walkSelection: SceneWalkSelection | null = null;
  /** The last folder refusal, shown beside the button that would try again. */
  private folderProblem: string | null = null;
  /** Which frame of a sprite is open. Reset whenever the selection changes. */
  private pictureFrame = 0;
  /**
   * The colour the brush is holding, kept on the surface rather than in the
   * panel so that it survives the re-render a frame change causes.
   */
  private brushColour = 1;
  /**
   * Which of a compact's two sprite words the Art panel is showing.
   *
   * A resource id rather than an index, so a compact that offers only one word
   * cannot inherit the other one's choice from the compact looked at before.
   */
  private compactArt = 0;
  /**
   * Which list sections are open, remembered between sessions.
   *
   * The same widget and the same storage the SCUMM sidebar uses, with this
   * family's own key: an author who collapsed Pictures here has not asked for
   * Rooms to close in a SCUMM game. Screens, Actors and Objects start open
   * because they are the three an author opens the editor to find.
   */
  private readonly sections = new OpenSections<string>(SECTIONS_KEY, [
    'screens',
    'actors',
    'objects',
  ]);

  constructor(private readonly options: Sword1EditorOptions) {
    this.element.className = 'sword-editor';
    this.list.className = 'sword-resource-list';
    this.detail.className = 'sword-resource-detail';
    this.element.append(this.list, this.detail);
    // Lead with the first screen: a person opening a game editor looks for the
    // rooms, which is what the SCUMM surface opens with too.
    const first = this.sword1?.rooms[0];
    if (first) this.selection = { kind: 'screen', screen: first.screen };
    this.render();
  }

  private get sword1(): Sword1Project | undefined {
    return this.options.project().sword1;
  }

  render(): void {
    this.renderList();
    this.renderDetail();
  }

  // ------------------------------------------------------------- the list --

  private renderList(): void {
    this.list.replaceChildren();
    const sword1 = this.sword1;
    if (!sword1) return;

    const summary = document.createElement('p');
    summary.className = 'sword-summary';
    const rounded = sword1.scripts.filter((script) => script.roundTrips).length;
    summary.textContent = sword1.editable.editable
      ? `${sword1.scripts.length} script modules (${rounded} re-emit byte-identically), ` +
        `${sword1.sections.length} sections. Unrecovered: ${sword1.editable.unrecovered} ` +
        `script words.`
      : `No editable surface: ${sword1.editable.reasons.join('; ')}.`;
    summary.classList.toggle('sword-summary-warning', !sword1.editable.editable);
    this.list.appendChild(summary);

    const provenance = document.createElement('p');
    provenance.className = 'sword-provenance';
    provenance.textContent =
      `Release: ${sword1.identification.release} (${sword1.identification.how}) — ` +
      `${sword1.identification.evidence}`;
    this.list.appendChild(provenance);

    if (sword1.clusters.absent.length > 0) {
      const absent = document.createElement('p');
      absent.className = 'sword-provenance';
      absent.textContent =
        `Not in this folder: ${sword1.clusters.absent.join(', ')} — on a retail install those ` +
        `are on the other disc, so their screens and text are absent rather than empty.`;
      this.list.appendChild(absent);
    }

    this.list.appendChild(
      this.section('screens', 'Screens', sword1.rooms.length, (body) => {
        for (const room of sword1.rooms) {
          body.appendChild(
            this.button(`Screen ${room.screen} (${room.width}x${room.height})`, {
              kind: 'screen',
              screen: room.screen,
            }),
          );
        }
      }),
    );

    if (sword1.startPositions && sword1.startPositions.length > 0) {
      this.list.appendChild(
        this.section('start-positions', 'Start positions', sword1.startPositions.length, (body) => {
          body.appendChild(
            this.button(`${sword1.startPositions!.length} placements`, {
              kind: 'start-positions',
            }),
          );
        }),
      );
    }

    const actors = sword1Actors(sword1);
    this.list.appendChild(
      this.section('actors', 'Actors', actors.length, (body) => {
        if (actors.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'sword-note';
          empty.textContent =
            'No compact in this project has o_type MEGA or PLAYER. On a demo install most ' +
            'sections are on the other disc, so the cast is absent rather than empty.';
          body.appendChild(empty);
          return;
        }
        for (const actor of actors) {
          body.appendChild(
            this.button(
              `${hex(actor.id)} — ${actor.isPlayer ? 'George (player)' : `mega on screen ${actor.screen}`}`,
              { kind: 'compact', id: actor.id },
            ),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('objects', 'Objects', sword1.sections.length, (body) => {
        for (const section of sword1.sections) {
          body.appendChild(
            this.button(`Section ${section.section} (${section.compacts.length})`, {
              kind: 'section',
              section: section.section,
            }),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('scripts', 'Scripts', sword1.scripts.length, (body) => {
        for (const script of sword1.scripts) {
          const label =
            `Module 0x${script.resource.toString(16).toUpperCase()} ` +
            `(${script.instructions.length} instructions${script.roundTrips ? '' : ', differs'})`;
          body.appendChild(this.button(label, { kind: 'script', resource: script.resource }));
        }
      }),
    );

    // Text, grouped by language: a translator works one language at a time, and
    // a flat list of 150 sections times seven languages is unusable.
    const byLanguage = new Map<string, number[]>();
    for (const entry of sword1.text) {
      const bucket = byLanguage.get(entry.language) ?? [];
      bucket.push(entry.resource);
      byLanguage.set(entry.language, bucket);
    }
    for (const language of [...byLanguage.keys()].sort()) {
      const resources = byLanguage.get(language) ?? [];
      this.list.appendChild(
        this.section(`text-${language}`, `Text — ${language}`, resources.length, (body) => {
          for (const resource of resources) {
            const entry = sword1.text.find(
              (candidate) => candidate.resource === resource && candidate.language === language,
            );
            body.appendChild(
              this.button(`Section ${entry?.section ?? '?'} (${entry?.lines.length ?? 0} lines)`, {
                kind: 'text',
                resource,
              }),
            );
          }
        }),
      );
    }

    this.list.appendChild(
      this.section('palettes', 'Palettes', sword1.palettes.length, (body) => {
        for (const palette of sword1.palettes) {
          body.appendChild(
            this.button(`Palette 0x${palette.resource.toString(16).toUpperCase()}`, {
              kind: 'palette',
              resource: palette.resource,
            }),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('pictures', 'Pictures', sword1.pictures.length, (body) => {
        for (const picture of sword1.pictures) {
          body.appendChild(
            this.button(
              `${picture.kind} 0x${picture.resource.toString(16).toUpperCase()} ` +
                `(${picture.width}x${picture.height})`,
              { kind: 'picture', resource: picture.resource },
            ),
          );
        }
      }),
    );

    const walkGrids = sword1.walkGrids ?? [];
    this.list.appendChild(
      this.section('walk-grids', 'Walk grids', walkGrids.length, (body) => {
        for (const grid of walkGrids) {
          body.appendChild(
            this.button(
              `Grid 0x${grid.resource.toString(16).toUpperCase()} ` +
                `(${grid.bars.length} bars, ${grid.nodes.length} nodes)`,
              { kind: 'walk-grid', resource: grid.resource },
            ),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('effects', 'Effects', sword1.effects.length, (body) => {
        body.appendChild(this.button(`${sword1.effects.length} effects`, { kind: 'effects' }));
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
      gameName: 'Broken Sword',
      whatIsInTheFolder:
        'its tunes are files in MUSIC/ and its speech is one container of every recorded line',
      onChanged: () => this.render(),
      onProblem: (message) => {
        this.folderProblem = message;
      },
    });
  }

  /**
   * One collapsible list section, which is the SCUMM sidebar's own widget.
   *
   * It used to be a heading with everything under it always drawn. On a retail
   * install that is 150 screens, 1,500 compacts and seven languages of text in
   * one unbroken column, so the sections a person wanted were below the fold of
   * the ones they did not — and there was no way to put one away. `accordion`
   * brings the count in the header, the remembered open state and the
   * disclosure semantics a screen reader navigates by, all of which the SCUMM
   * sidebar already had.
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
      idPrefix: 'sword1-accordion',
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
      this.render();
    });
    return button;
  }

  // ----------------------------------------------------------- the detail --

  private renderDetail(): void {
    this.detail.replaceChildren();
    const sword1 = this.sword1;
    if (!sword1) return;

    switch (this.selection.kind) {
      case 'screen':
        this.renderScreen(sword1, this.selection.screen);
        break;
      case 'section':
        this.renderSection(sword1, this.selection.section);
        break;
      case 'compact':
        this.renderCompact(sword1, this.selection.id);
        break;
      case 'script':
        this.renderScript(sword1, this.selection.resource);
        break;
      case 'text':
        this.renderText(sword1, this.selection.resource);
        break;
      case 'palette':
        this.renderPalette(sword1, this.selection.resource);
        break;
      case 'picture':
        this.renderPicture(sword1, this.selection.resource);
        break;
      case 'walk-grid':
        this.renderWalkGrid(sword1, this.selection.resource);
        break;
      case 'start-positions':
        this.renderStartPositions(sword1);
        break;
      case 'effects':
        this.renderEffects(sword1);
        break;
      case 'audio':
        this.renderAudio();
        break;
    }
  }

  /**
   * One walk grid as numbers, which is the same grid the screen canvas draws.
   *
   * Both ways in edit the same project: the canvas is where a bar is lined up
   * against the scenery it is meant to follow, and this is where an author
   * types the coordinate they already know — and the only way in for someone
   * who is not using a pointer at all.
   */
  private renderWalkGrid(sword1: Sword1Project, resource: number): void {
    const grid = (sword1.walkGrids ?? []).find((candidate) => candidate.resource === resource);
    if (!grid) return;
    this.heading(
      `Walk grid 0x${resource.toString(16).toUpperCase()}`,
      'Where a character may walk on the screens below. Editable and written back: an untouched ' +
        'grid leaves an export byte-identical, and a moved bar changes where the router lets a ' +
        'mega go.',
    );
    walkGridPanel(this.detail, {
      id: `sword1-walk-${resource.toString(16)}`,
      name: `Grid 0x${resource.toString(16).toUpperCase()}`,
      where:
        grid.screens.length === 0
          ? null
          : `Named by ${grid.floors.length} floor ${grid.floors.length === 1 ? 'compact' : 'compacts'} ` +
            `on ${grid.screens.length === 1 ? 'screen' : 'screens'} ` +
            `${[...grid.screens].sort((a, b) => a - b).join(', ')}.`,
      bars: grid.bars,
      nodes: grid.nodes,
      moveBar: (index, end, x, y) => {
        this.options.update((project) => {
          editSword1WalkBar(project, resource, index, { end, x, y });
        });
        this.render();
      },
      deleteBar: (index) => {
        this.options.update((project) => {
          deleteSword1WalkBar(project, resource, index);
        });
        this.render();
      },
      moveNode: (index, x, y) => {
        this.options.update((project) => {
          editSword1WalkNode(project, resource, index, x, y);
        });
        this.render();
      },
    });
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

  /**
   * Where the eight placements the demo’s scripts use put a character.
   *
   * Its own section rather than a row on a screen, because a placement does not
   * belong to a screen: it names a *compact*, and the executable writes four
   * words into that compact’s fields when a script sends someone there. The
   * numbers are the interpreter’s own — read out of `SWORD.EXE` — and an edit
   * goes back into that file.
   */
  private renderStartPositions(sword1: Sword1Project): void {
    const positions = sword1.startPositions ?? [];
    const from = sword1.interpreter?.startPositions ?? 'the interpreter';
    this.heading(
      'Start positions',
      `${positions.length} placements, read out of ${from} and written back into it on export. ` +
        `They are in no cluster and in no index: the interpreter sets them with four ` +
        `instructions each, so a row here is one of those runs and the object it places is ` +
        `shown beside it.`,
    );
    const table = document.createElement('table');
    table.className = 'sword-fields';
    const head = document.createElement('tr');
    for (const label of ['Placement', 'Object', 'x', 'y', 'Direction']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.appendChild(head);
    for (const position of positions) {
      const row = document.createElement('tr');
      const key = document.createElement('th');
      key.scope = 'row';
      key.textContent = String(position.index);
      const place = document.createElement('td');
      place.textContent = hex(position.place);
      row.append(key, place);
      const fields: Array<['x' | 'y' | 'direction', number, number, number]> = [
        ['x', position.x, -32768, 32767],
        ['y', position.y, -32768, 32767],
        ['direction', position.direction, 0, 7],
      ];
      for (const [name, value, min, max] of fields) {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.value = String(value);
        input.setAttribute('aria-label', `${name} of start position ${position.index}`);
        input.addEventListener('change', () => {
          const wanted = Number.parseInt(input.value, 10);
          if (!Number.isFinite(wanted)) return;
          this.options.update((project) => {
            editSword1StartPosition(project, position.index, { [name]: wanted });
          });
          this.render();
        });
        cell.appendChild(input);
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    this.detail.appendChild(table);
  }

  private renderScreen(sword1: Sword1Project, screen: number): void {
    const room = sword1.rooms.find((candidate) => candidate.screen === screen);
    if (!room) return;
    const writable = sword1.surfaces.rooms === 'editable';
    this.heading(
      `Screen ${screen}`,
      writable
        ? `Editable, and written back into ${sword1.interpreter?.rooms ?? 'the interpreter'} on ` +
            `export. Broken Sword’s room table is in no cluster and in no index — Revolution ` +
            `built it into the interpreter — and the interpreter ships beside the clusters, so ` +
            `an edit here has a file to go into.`
        : 'Editable here and not writable back into a game: Broken Sword’s room table is in the ' +
            'interpreter rather than in any cluster, and this project was opened from a folder ' +
            'with no executable in it. Editing it changes how this project draws the screen.',
    );

    this.renderScreenPicture(sword1, screen);
    this.renderScreenBackground(sword1, screen);
    this.renderScreenMasks(sword1, screen);

    const table = document.createElement('table');
    table.className = 'sword-fields';
    const rows: Array<[string, string]> = [
      ['Size', `${room.width} x ${room.height}`],
      ['Layers', `${room.totalLayers} (1 background + ${Math.max(0, room.totalLayers - 1)} masks)`],
      ['Grid width', `${room.gridWidth} blocks (off-screen edges included)`],
      ['Layer resources', room.layers.filter(Boolean).map(hex).join(', ') || 'none'],
      ['Mask grids', room.grids.filter(Boolean).map(hex).join(', ') || 'none'],
      ['Palettes', room.palettes.filter(Boolean).map(hex).join(', ') || 'none'],
      ['Parallax', room.parallax.filter(Boolean).map(hex).join(', ') || 'none'],
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
   * The screen itself, drawn.
   *
   * A screen is a picture, and a table of resource numbers is not one. The
   * canvas is the shared one from `sceneCanvas.ts` — the same painting,
   * hit-testing and keyboard cursor the SCUMM room canvas uses — reading a
   * model built from Broken Sword’s own records rather than a pretend room.
   *
   * When there is no 2D context, or no background in the project, the facts
   * table below still stands and a sentence says which of the two it was.
   */
  private renderScreenPicture(sword1: Sword1Project, screen: number): void {
    const trouble = sword1ScreenTrouble(sword1, screen);
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
      sword1ScreenModel(screen, {
        project: () => this.options.project(),
        update: (mutate) => this.options.update(mutate),
        selected: () => this.sceneSelection,
        select: (id) => {
          this.sceneSelection = id;
          this.describeChosen(chosen);
        },
        walkSelected: () => this.walkSelection,
        selectWalk: (selection) => {
          this.walkSelection = selection;
        },
      }),
      {
        id: `sword1-screen-${screen}-help`,
        onChange: (message) => {
          status.textContent = message;
        },
      },
    );

    if (!canvas) {
      const note = document.createElement('p');
      note.className = 'sword-note';
      note.textContent =
        'This browser has no 2D canvas, so the screen cannot be drawn here. Its facts are below.';
      this.detail.appendChild(note);
      return;
    }

    const figure = document.createElement('div');
    figure.className = 'sword-screen-canvas';
    figure.append(canvas.element, canvas.help);
    this.detail.append(figure, status, chosen);
    this.describeChosen(chosen);
  }

  /**
   * The screen's background as a file: Export writes it, Import replaces it.
   *
   * Beneath the drawn screen rather than in the Pictures list, because this is
   * the picture the author is looking at. Layer 0 is the background — the
   * asymmetry the interpreter carries, where only the mask layers begin past a
   * header — and its bytes *are* the pixels, so a replacement is a copy at the
   * room table's own size.
   */
  private renderScreenBackground(sword1: Sword1Project, screen: number): void {
    const room = sword1.rooms.find((candidate) => candidate.screen === screen);
    const resource = room?.layers[0] ?? 0;
    if (!resource) {
      this.pictureAbsence(
        `Screen ${screen} names no background layer in the room table, so there is no picture ` +
          `to export or replace.`,
      );
      return;
    }
    const panel = this.picturePanel(sword1, resource, `sword1-screen-${screen}-background`);
    if (!panel) {
      this.pictureAbsence(
        `Screen ${screen}'s background: ${sword1AbsentPictureReason(sword1, resource)}`,
      );
      return;
    }
    const label = document.createElement('h3');
    label.textContent = `Background — ${hex(resource)}`;
    this.detail.append(label, panel);
  }

  /**
   * The screen's mask layers, laid out by their grids and replaceable.
   *
   * Under the background for the same reason the background is under the
   * screen: this is where an author is looking when they want to change what
   * walks in front of what. A mask's bytes are blocks in storage order and the
   * grid resource says where each block goes, so the picture shown here is
   * composed rather than stored — and an import is taken apart the same way,
   * which is what makes "paint over the pillar" a thing an author can do.
   */
  private renderScreenMasks(sword1: Sword1Project, screen: number): void {
    const room = sword1.rooms.find((candidate) => candidate.screen === screen);
    if (!room) return;
    for (let layer = 1; layer < room.totalLayers; layer++) {
      const resource = room.layers[layer] ?? 0;
      if (!resource) continue;
      const panel = this.picturePanel(sword1, resource, `sword1-screen-${screen}-mask-${layer}`);
      const label = document.createElement('h3');
      label.textContent = `Mask layer ${layer} — ${hex(resource)}`;
      this.detail.appendChild(label);
      if (!panel) {
        this.pictureAbsence(`Mask layer ${layer}: ${sword1AbsentPictureReason(sword1, resource)}`);
        continue;
      }
      this.detail.appendChild(panel);
    }
  }

  /** Names the compact picked on the canvas, with a way into its fields. */
  private describeChosen(into: HTMLElement): void {
    into.replaceChildren();
    const id = this.sceneSelection;
    if (id === null) {
      into.textContent =
        'Nothing picked. Click an outlined object, or move the cursor with the arrow keys and ' +
        'press Enter. Alt with an arrow key moves what is picked.';
      return;
    }
    into.append(`Picked object ${hex(id)}. `);
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = `Open object ${hex(id)}`;
    open.addEventListener('click', () => {
      this.selection = { kind: 'compact', id };
      this.render();
    });
    into.appendChild(open);
  }

  private renderSection(sword1: Sword1Project, section: number): void {
    const entry = sword1.sections.find((candidate) => candidate.section === section);
    if (!entry) return;
    this.heading(
      `Section ${section}`,
      `${entry.compacts.length} objects from resource ${hex(entry.resource)}. A compact is 3,085 ` +
        `words and the bytecode addresses it by byte offset, which is why the fields below are ` +
        `named the way a script listing names them.`,
    );
    const body = document.createElement('div');
    body.className = 'sword-section-body';
    for (const compact of entry.compacts) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sword-resource';
      button.textContent = `Object ${compact.index} (${hex(compact.id)})`;
      button.addEventListener('click', () => {
        this.selection = { kind: 'compact', id: compact.id };
        this.render();
      });
      body.appendChild(button);
    }
    this.detail.appendChild(body);
    this.detail.appendChild(this.sectionRecordButtons(entry));
  }

  /*
   * Add and remove, which is row 12 of `docs/editor-parity.md` and reads as one
   * button because the arithmetic behind it is the whole of the page's §12a.
   *
   * Append only, and delete from the end only. A compact's *index* is its name
   * — a script pushes `section * 0x10000 + index` — so a record put in the
   * middle would rename every record after it. Put on the end, it renames
   * nothing: the section's table grows by one entry, every record shifts one
   * word later, every offset in the table goes up by one, and every id in the
   * game still resolves to the object it always did.
   */
  private sectionRecordButtons(entry: Sword1ProjectSection): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sword-section-buttons';

    const source = entry.compacts[entry.compacts.length - 1];
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+ Object';
    add.disabled = source === undefined;
    add.title = source
      ? `Adds a copy of object ${source.index} on the end of section ${entry.section}. A new ` +
        `compact is a copy of one this game ships, because a record of zeroes is not an empty ` +
        `object — its o_type, o_logic and o_tree all mean something the logic engine acts on.`
      : `Section ${entry.section} holds no object to copy.`;
    add.addEventListener('click', () => {
      if (!source) return;
      let added: number | undefined;
      this.options.update((project) => {
        added = appendSword1Compact(project, entry.section, source.index);
      });
      if (added !== undefined) {
        this.selection = { kind: 'compact', id: entry.section * 0x10000 + added };
      }
      this.render();
    });
    row.appendChild(add);

    const last = entry.offsets.length - 1;
    const refusal = sword1CompactDeleteRefusal(this.options.project(), entry.section, last);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = `Delete object ${last}`;
    remove.disabled = refusal !== null || last < 0;
    remove.title =
      refusal ??
      `Removes object ${last}, which is the last of section ${entry.section} by index and by ` +
        `offset, and which nothing in this project names.`;
    remove.addEventListener('click', () => {
      this.options.update((project) => {
        deleteSword1Compact(project, entry.section, last);
      });
      this.selection = { kind: 'section', section: entry.section };
      this.render();
    });
    row.appendChild(remove);
    return row;
  }

  private renderCompact(sword1: Sword1Project, id: number): void {
    let found: Sword1ProjectCompact | undefined;
    for (const section of sword1.sections) {
      found = section.compacts.find((candidate) => candidate.id === id);
      if (found) break;
    }
    if (!found) return;
    const words = new Int32Array(fromBase64(found.wordsBase64).buffer);
    const actor = sword1Actors(sword1).find((candidate) => candidate.id === id) ?? null;
    this.heading(
      actor
        ? `${actor.isPlayer ? 'George (player)' : 'Character'} ${hex(id)}`
        : `Object ${hex(id)}`,
      `Section ${found.section}, object ${found.index}. Every field is a 32-bit word; the ones ` +
        `below are the ones the scripts touch most. Editing one writes that word.` +
        (actor
          ? ` Its o_type is ${actor.type === SwordType.PLAYER ? 'PLAYER' : 'MEGA'}, which is what ` +
            `makes it a character rather than a door: the interpreter walks it, scales it and ` +
            `draws it from the sprite in o_walk_resource.`
          : ''),
    );

    this.renderCompactArt(sword1, found.id, words, actor);

    const table = document.createElement('table');
    table.className = 'sword-fields';
    for (const field of HEADLINE_FIELDS) {
      const row = document.createElement('tr');
      const key = document.createElement('th');
      key.scope = 'row';
      key.textContent = field.name;
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(words[field.offset >> 2] ?? 0);
      input.setAttribute('aria-label', `${field.name} of object ${hex(id)}`);
      input.addEventListener('change', () => {
        const value = Number.parseInt(input.value, 10);
        if (!Number.isFinite(value)) return;
        this.options.update((project) => {
          editSword1CompactWord(project, id, field.offset >> 2, value);
        });
        this.render();
      });
      cell.appendChild(input);
      row.append(key, cell);
      table.appendChild(row);
    }
    this.detail.appendChild(table);
  }

  /**
   * An object's art, on the object.
   *
   * `o_resource` is the sprite resource the interpreter is drawing this mega
   * from right now and `o_frame` is which frame of it, so those two words are
   * the answer to "what does this person look like?" \u2014 and until now an author
   * had to read the number off the field table and go hunting for it in a list
   * of 3,000. The panel is the same one the Pictures pane shows, which is what
   * makes Export and Import work here without a second code path.
   *
   * ## Why `o_resource` alone was not enough, measured
   *
   * It is 0 on every character in the demo\u2019s compacts, George included, because
   * it is *run-time* state: `Logic::logicArAnimate` and `Logic::fnStand` both
   * open with `o_resource = o_walk_resource`, so the shipped word holds only
   * whatever the last script left there, and a freshly imported project has
   * nothing in it at all. An Actors section where every actor says "nothing to
   * export" is the section the owner reported missing.
   *
   * **`o_walk_resource` is the standing and walking sprite**, not a walk grid,
   * and it *is* set in the compact the game ships. `fnMegaSet(cpt, id,
   * walk_data, spr)` writes `o_mega_resource = walk_data` and `o_walk_resource
   * = spr` \u2014 `spr`, a sprite file \u2014 and the two lines above are what draw
   * from it. On this demo George\u2019s is 0x4060000: 346 frames at 83x151, held,
   * exportable and importable. So a character offers both words where both are
   * set, and the durable one is offered first.
   *
   * `o_mega_resource` is named beside them and not drawn, and the reason is
   * narrower than this said before. It is not a table of animation resources:
   * `Router::setupWalkData` reads a walk-frame count, a turn-frame count and
   * then `dx`/`dy` deltas per direction out of it. It holds **no resource id at
   * all**, so there is nothing in it to draw.
   */
  private renderCompactArt(
    sword1: Sword1Project,
    id: number,
    words: Int32Array,
    actor: Sword1Actor | null,
  ): void {
    const resource = words[CPT.RESOURCE >> 2] ?? 0;
    const frame = words[CPT.FRAME >> 2] ?? 0;
    const walk = actor?.walkResource ?? 0;

    // Ordered: the word the game ships set comes first for a character, because
    // it is the one that is there on a project that has never been run.
    const choices: Array<{ resource: number; label: string }> = [];
    if (walk) choices.push({ resource: walk, label: `o_walk_resource ${hex(walk)}` });
    if (resource && resource !== walk) {
      choices.push({ resource, label: `o_resource ${hex(resource)}, frame ${frame}` });
    }

    const heading = document.createElement('h3');
    heading.textContent = 'Art';
    this.detail.appendChild(heading);

    if (choices.length === 0) {
      this.pictureAbsence(
        'This object\u2019s o_resource is 0 and it has no o_walk_resource, so the interpreter ' +
          'has not been told what to draw it from \u2014 a floor patch and a mouse-only ' +
          'hotspot never have one. Nothing to export.',
      );
    } else {
      const chosen =
        choices.find((candidate) => candidate.resource === this.compactArt) ?? choices[0]!;
      if (choices.length > 1) {
        /*
         * A radio group rather than two toggles, for the reason Sword II\u2019s
         * animation picker gives: only one of these is the picture on show,
         * which is what a radio group means, and it is one tab stop rather
         * than one per word.
         */
        const picker = document.createElement('div');
        picker.className = 'sword-frame-strip';
        for (const choice of choices) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'sword-resource';
          button.textContent = choice.label;
          groupItem(button, {
            role: 'radio',
            selected: choice.resource === chosen.resource,
            label: choice.label,
          });
          button.addEventListener('click', () => {
            this.compactArt = choice.resource;
            this.pictureFrame = 0;
            this.render();
          });
          picker.appendChild(button);
        }
        rovingGroup(picker, { role: 'radiogroup', label: `sprite words on object ${hex(id)}` });
        this.detail.appendChild(picker);
      }

      const panel = this.picturePanel(sword1, chosen.resource, `sword1-compact-${id}-art`);
      if (panel) this.detail.appendChild(panel);
      else this.pictureAbsence(sword1AbsentPictureReason(sword1, chosen.resource));
    }

    if (!actor) return;
    const where = document.createElement('p');
    where.className = 'sword-note';
    where.textContent =
      `Screen ${actor.screen} at (${actor.x}, ${actor.y}), facing direction ${actor.dir}. ` +
      `o_walk_resource ${actor.walkResource ? hex(actor.walkResource) : 'none'} is the sprite ` +
      `this character stands and walks in \u2014 fnStand and the walk animator both set ` +
      `o_resource from it, which is why o_resource is 0 until something has moved. ` +
      `o_mega_resource ${actor.megaResource ? hex(actor.megaResource) : 'none'} is walk ` +
      `geometry \u2014 frame counts and an x/y step per direction \u2014 and holds no resource ` +
      `id, so there is nothing in it to draw or replace.`;
    this.detail.appendChild(where);
  }

  private renderScript(sword1: Sword1Project, resource: number): void {
    const script = sword1.scripts.find((candidate) => candidate.resource === resource);
    if (!script) return;
    const grouped = sword1Calls(script.instructions, script.entries);
    this.heading(
      `Script module ${hex(resource)}`,
      `Sections ${script.sections.join(', ')}. ${script.instructions.length} instructions, ` +
        `${script.entries.length} scripts, ` +
        `${grouped.filter((call) => call.arguments.length > 0).length} of ${grouped.length} ` +
        `calls shown as named arguments. ` +
        `An argument is edited where it was pushed, so the mcode number and its argument count ` +
        `are not editable from a call row — changing either would renumber every argument. ` +
        (script.roundTrips
          ? 'This module re-emits byte-identically, so an edit here is a checked change.'
          : 'This module does NOT re-emit byte-identically, so editing it is refused on export.'),
    );

    if (script.unrecovered.length > 0) {
      const warning = document.createElement('p');
      warning.className = 'sword-summary-warning';
      warning.textContent =
        `${script.unrecovered.length} words could not be decoded: ` +
        script.unrecovered
          .slice(0, 5)
          .map((bad) => `${bad.at} (${bad.why})`)
          .join('; ');
      this.detail.appendChild(warning);
    }

    const entryAt = new Map<number, number[]>();
    script.entries.forEach((at, number) => {
      const list = entryAt.get(at) ?? [];
      list.push(number);
      entryAt.set(at, list);
    });

    // Grouped into calls before anything is drawn, because the grouping decides
    // which rows exist: the four pushes feeding an `fnWalk` are folded into the
    // call and are not rows of their own.
    const calls = grouped;

    const listing = document.createElement('ol');
    listing.className = 'sword-listing';
    // Capped: a module can hold tens of thousands of instructions and a DOM
    // node per instruction is what makes an editor unusable rather than slow.
    const shown = script.instructions.slice(0, 2000);
    // Only calls whose own row is on the page fold their pushes away: a push
    // inside the cap whose call is past it would otherwise vanish entirely.
    const last = shown[shown.length - 1]?.at ?? -1;
    const visible = calls.filter((call) => call.at <= last);
    const callAt = sword1CallsByWord(visible);
    const consumed = sword1ConsumedWords(visible);
    for (const instruction of shown) {
      for (const number of entryAt.get(instruction.at) ?? []) {
        const header = document.createElement('li');
        header.className = 'sword-listing-entry';
        header.textContent = `script ${number}:`;
        listing.appendChild(header);
      }
      const call = callAt.get(instruction.at);
      if (call && call.arguments.length > 0) {
        listing.appendChild(this.callItem(sword1, resource, call));
        continue;
      }
      // A push another row has already claimed as an argument. Folded away
      // rather than repeated, so a number appears in exactly one editor.
      if (consumed.has(instruction.at)) continue;

      const item = document.createElement('li');
      item.className = 'sword-listing-line';
      const label = document.createElement('span');
      label.textContent =
        `${instruction.at}: ` +
        `${formatSword1Instruction(instruction, sword1VarLayout(sword1.identification.release))}`;
      item.appendChild(label);
      if (call?.trouble) {
        const why = document.createElement('span');
        why.className = 'sword-note';
        why.textContent = `Arguments not shown by name: ${call.trouble}.`;
        item.appendChild(why);
      }
      instruction.operands.forEach((operand, index) => {
        const input = document.createElement('input');
        input.type = 'number';
        input.value = String(operand);
        input.className = 'sword-operand';
        input.setAttribute('aria-label', `operand ${index} at word ${instruction.at}`);
        input.addEventListener('change', () => {
          const value = Number.parseInt(input.value, 10);
          if (!Number.isFinite(value)) return;
          this.options.update((project) => {
            editSword1Operand(project, resource, instruction.at, index, value);
          });
          this.render();
        });
        item.appendChild(input);
      });
      listing.appendChild(item);
    }
    this.detail.appendChild(listing);
    if (script.instructions.length > shown.length) {
      const more = document.createElement('p');
      more.className = 'sword-note';
      more.textContent =
        `${script.instructions.length - shown.length} further instructions are not listed; ` +
        `the listing is capped so a large module does not build tens of thousands of DOM nodes.`;
      this.detail.appendChild(more);
    }
  }

  /**
   * One call as a row of named operands, the way an action reads.
   *
   * The edit is still `editSword1Operand` against the *pushing* instruction —
   * the call is a view over instructions and never a second representation, so
   * nothing here can drift from what re-emits.
   */
  private callItem(sword1: Sword1Project, resource: number, call: Sword1Call): HTMLElement {
    const item = document.createElement('li');
    item.className = 'sword-listing-line sword-call';

    const label = document.createElement('span');
    label.className = 'sword-call-name';
    label.textContent = `${call.at}: ${call.name}`;
    item.appendChild(label);

    const count = document.createElement('span');
    count.className = 'sword-call-count';
    count.textContent = `${call.count} argument${call.count === 1 ? '' : 's'}`;
    item.appendChild(count);

    const fields = document.createElement('div');
    fields.className = 'sword-call-fields';
    for (const argument of call.arguments) {
      const field = sword1ArgumentField(sword1, argument);
      fields.appendChild(
        operandField({
          id: `sword1-${resource}-${argument.at}`,
          label: field.label,
          value: argument.value,
          choices: field.choices,
          hint: field.hint,
          onChange: (value) => {
            this.options.update((project) => {
              editSword1Operand(project, resource, argument.at, 0, value);
            });
            this.render();
          },
        }),
      );
    }
    item.appendChild(fields);
    return item;
  }

  private renderText(sword1: Sword1Project, resource: number): void {
    const entry = sword1.text.find((candidate) => candidate.resource === resource);
    if (!entry) return;
    this.heading(
      `Text — ${entry.language}, section ${entry.section}`,
      `${entry.lines.length} lines. A line's number is what a script names, so lines cannot be ` +
        `added or removed — only changed.`,
    );
    const listing = document.createElement('ol');
    listing.className = 'sword-listing';
    entry.lines.forEach((line, index) => {
      const item = document.createElement('li');
      item.className = 'sword-listing-line';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = line;
      input.className = 'sword-text-line';
      input.setAttribute('aria-label', `line ${index} of section ${entry.section}`);
      input.addEventListener('change', () => {
        this.options.update((project) => {
          editSword1TextLine(project, resource, index, input.value);
        });
      });
      const number = document.createElement('span');
      number.textContent = `${index}`;
      item.append(number, input);
      listing.appendChild(item);
    });
    this.detail.appendChild(listing);
  }

  private renderPalette(sword1: Sword1Project, resource: number): void {
    const palette = sword1.palettes.find((candidate) => candidate.resource === resource);
    if (!palette) return;
    const bytes = fromBase64(palette.bytesBase64);
    this.heading(
      `Palette ${hex(resource)}`,
      `Used by screen${palette.screens.length === 1 ? '' : 's'} ` +
        `${palette.screens.join(', ') || '(none in the room table)'}. Six-bit VGA values, so an ` +
        `eight-bit colour settles to the nearest multiple of four when written.`,
    );
    const grid = document.createElement('div');
    grid.className = 'sword-palette';
    for (let index = 0; index * 3 + 2 < bytes.length; index++) {
      const red = bytes[index * 3] << 2;
      const green = bytes[index * 3 + 1] << 2;
      const blue = bytes[index * 3 + 2] << 2;
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
        // Cycling brightness is the one useful click-only edit: a full RGB
        // dialog belongs behind a selection, and the numeric route is below.
        this.options.update((project) => {
          editSword1PaletteColour(project, resource, index, red, green, blue);
        });
        this.render();
      });
      grid.appendChild(swatch);
    }
    this.detail.appendChild(grid);
  }

  /**
   * A picture, drawn, and replaceable where the format can be written.
   *
   * What stood here was a heading and two sentences of apology. The sentences
   * were also wrong by the time they were read: `swordEncode.ts` writes RLE7,
   * RLE0 and Tony, and the sweep reports every one of the demo's 7,113 sprite
   * frames re-encoding to the bytes Revolution shipped. So the picture is shown
   * and the Import button works — and where it cannot, the panel says which
   * format and why, in `sword1PictureRefusal`'s words, next to the button
   * rather than in a document nobody opens.
   */
  /**
   * The Import/Export panel for one picture resource, wherever it is used.
   *
   * Factored out of the Pictures pane so that a background can carry it on the
   * *screen* that draws it and a sprite on the *character* wearing it. That is
   * the whole of the difference an author noticed: the panel existed, and it
   * existed only in a list of resource numbers, so replacing a room's
   * background meant knowing which of 3,000 hexadecimal ids it was. A picture
   * is edited where it is used or it may as well not be editable.
   *
   * Null when the project does not hold the resource — the callers say why in
   * their own words, because "not in this project" means something different
   * for a background the importer's budget skipped than for a sprite a compact
   * names on a disc that is not in the drive.
   */
  private picturePanel(sword1: Sword1Project, resource: number, id: string): HTMLElement | null {
    const picture = sword1.pictures.find((candidate) => candidate.resource === resource);
    if (!picture) return null;
    const frames = sword1PictureFrames(picture);
    const frame = frames.find((candidate) => candidate.index === this.pictureFrame) ?? frames[0];
    const index = frame?.index ?? 0;
    const pixels = sword1PicturePixels(picture, index);
    const palette = sword1PicturePalette(sword1, picture);
    const transparentZero = sword1PictureIsTransparent(picture);
    const found = sword1SpritePlaybacks(sword1, resource);
    const playback = { playbacks: found.playbacks, playbackRefusal: found.refusal };
    return swordPictureView({
      id,
      title: `${picture.kind} ${hex(resource)}${frames.length > 1 ? `, frame ${index}` : ''}`,
      frames: frames.map((candidate) => ({ index: candidate.index, label: candidate.label })),
      selected: index,
      onSelect: (chosen) => {
        this.pictureFrame = chosen;
        this.render();
      },
      pixels,
      image: pixels ? sword1PictureImage(pixels, palette, { transparentZero }) : null,
      palette,
      transparentZero,
      refusal: sword1PictureRefusal(picture, index),
      filename: sword1PictureFilename(this.options.project().name, picture, index),
      onReplace: (imported, width, height) => {
        this.options.update((project) => {
          replaceSword1Picture(project, resource, index, imported, width, height);
        });
        this.render();
      },
      // Deliberately without `this.render()`: the canvas the stroke was drawn
      // on is this one, and rebuilding it would take the focus the next
      // keystroke needs with it.
      onPaint: (painted, width, height) => {
        this.options.update((project) => {
          replaceSword1Picture(project, resource, index, painted, width, height);
        });
      },
      colour: this.brushColour,
      onColour: (chosen) => {
        this.brushColour = chosen;
      },
      notes: SWORD1_PICTURE_NOTES,
      // Only a sprite is animated: a background, a parallax layer and a mask
      // are one frame each, and a Play button on them would be a control with
      // nothing to do. Row 18's refusal sentence belongs on the resources the
      // question is about.
      ...(picture.kind === 'sprite' ? playback : {}),
      frameImage: (chosen) => {
        const other = sword1PicturePixels(picture, chosen);
        return other ? sword1PictureImage(other, palette, { transparentZero }) : null;
      },
    });
  }

  /** A sentence where a panel would have been, naming what is missing. */
  private pictureAbsence(text: string): void {
    const note = document.createElement('p');
    note.className = 'sword-note';
    note.textContent = text;
    this.detail.appendChild(note);
  }

  private renderPicture(sword1: Sword1Project, resource: number): void {
    const picture = sword1.pictures.find((candidate) => candidate.resource === resource);
    if (!picture) return;
    const frames = sword1PictureFrames(picture);
    const frame = frames.find((candidate) => candidate.index === this.pictureFrame) ?? frames[0];
    const index = frame?.index ?? 0;

    this.heading(
      `${picture.kind} ${hex(resource)}`,
      `${picture.width}x${picture.height}, ${picture.frames} frame` +
        `${picture.frames === 1 ? '' : 's'}. Editable: this project both decodes and re-encodes ` +
        `Broken Sword’s RLE7, RLE0 and Tony compressions, and re-encoding an unmodified frame ` +
        `gives back the bytes the game shipped.`,
    );

    const panel = this.picturePanel(sword1, resource, `sword1-picture-${resource}`);
    if (panel) this.detail.appendChild(panel);

    const used = document.createElement('p');
    used.className = 'sword-note';
    used.textContent =
      picture.screens.length > 0
        ? `Used by screen${picture.screens.length === 1 ? '' : 's'} ${picture.screens.join(', ')}.`
        : 'No screen in the room table names this resource.';
    this.detail.appendChild(used);

    if (frame?.compression) {
      const format = document.createElement('p');
      format.className = 'sword-note';
      format.textContent =
        `Frame ${index} is ${frame.compression}, ${frame.width}x${frame.height}, drawn at ` +
        `(${frame.offsetX}, ${frame.offsetY}) from the compact’s coordinates.`;
      this.detail.appendChild(format);
    }
  }

  private renderEffects(sword1: Sword1Project): void {
    this.heading(
      'Sound effects',
      `${sword1.effects.length} effects the scripts can play by number. The rooms column is the ` +
        `part worth knowing: an effect is not simply "on" in one room — a river heard from the ` +
        `bank and from the bridge has two entries with different left and right volumes, which ` +
        `is how the original panned without positional audio.`,
    );
    const table = document.createElement('table');
    table.className = 'sword-fields';
    const header = document.createElement('tr');
    for (const label of ['Effect', 'Sample', 'Type', 'Delay', 'Rooms']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      header.appendChild(cell);
    }
    table.appendChild(header);
    for (const effect of sword1.effects.slice(0, 400)) {
      const row = document.createElement('tr');
      const cells = [
        String(effect.fxNo),
        effect.sample === null ? 'none' : hex(effect.sample),
        effect.type === 1 ? 'spot' : effect.type === 2 ? 'loop' : 'random',
        String(effect.delay),
        effect.rooms
          .map((room) => `${room.room} (${room.leftVolume}/${room.rightVolume})`)
          .join(', '),
      ];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    this.detail.appendChild(table);
  }

  /** Which mcode a number names, exported for a listing's tooltip. */
  static mcodeName(number: number): string {
    return sword1McodeName(number);
  }

  /** Which compact field a byte offset names. */
  static fieldName(offset: number): string {
    return sword1CompactFieldName(offset);
  }
}

function hex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}
