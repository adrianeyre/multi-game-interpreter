/**
 * The SCI editing surface: the class graph, the Source view, two kinds of
 * Picture, and Messages.
 *
 * A whole-surface swap like `AgiEditor`, mounted from the one place the editor
 * branches on Engine family (#134). Nothing below that point asks which family
 * it is: a SCUMM project has no class graph, an AGI project has no Selectors,
 * and a SCI project has neither `Action`s nor Logic.
 *
 * ## What this surface is for, and what it deliberately is not
 *
 * ADR 0018 settles two things that decide the shape here.
 *
 * **Source is a view.** The stored form is the instruction list; source is
 * rendered from it on demand, edited, and parsed straight back. Storing source
 * would make every Script resource in every game permanently `Unrecovered`,
 * because reconstructing `if`/`while` from jumps and recompiling cannot
 * guarantee the original layout — and `Unrecovered` is an import-time check
 * with a target of zero. **Where control flow cannot be reconstructed with
 * certainty the view degrades to the instruction list**, and this surface shows
 * that rather than hiding it: a degraded line is marked, and the count is on
 * screen beside the method.
 *
 * **Vector and cel Pictures are two kinds, not one editor with a mode.** They
 * get two sections and two panels that share no editing operation, because a
 * vector drawing tool and a bitmap composition tool have none in common. One
 * editor with half its buttons greyed out by Version is the bag of flags ADR
 * 0007's test exists to prevent.
 *
 * ## And two things it says out loud
 *
 * **A game whose Version was only guessed is refused, with the reason on
 * screen** (ADR 0013, ADR 0020). SCI stamps its Version nowhere, so the set of
 * Versions that can be edited lags the set that can be played, and that gap is
 * a published number rather than a surprise in the editor.
 *
 * **Where this game keeps its words.** "Edit this game's words" names two
 * different places depending on Version — inline in the Script resource for
 * SCI0 and SCI1, in `MESSAGE` for SCI1.1 and later — and localisation is not
 * only text: translated wording gets baked into Views and Pictures, which this
 * surface cannot reach. It says so rather than implying completeness (#222).
 */

import type {
  Project,
  SciProject,
  SciProjectCelPicture,
  SciProjectMethod,
  SciProjectObject,
  SciProjectResource,
  SciProjectScript,
} from '../../authoring/project.js';
import { fromBase64, toBase64 } from '../../authoring/base64.js';
import {
  drawSciPicture,
  writeSciPicture,
  SCI_PICTURE_HEIGHT,
  SCI_PICTURE_WIDTH,
  type SciPictureCommand,
} from '../../engine/sci/gfx/SciPicture.js';
import {
  describeTextSurface,
  parseSciSource,
  renderSciSource,
} from '../../authoring/sci/sciSource.js';
import { describeSciRelinking, linkSciScript } from '../../authoring/sci/sciLinker.js';
import { describeSciCast, sciCast } from '../../authoring/sci/sciCast.js';
import { sciCastArt, sciCelStrip } from './SciCelStrip.js';
import {
  describeSciPolygons,
  sciPolygons,
  type SciPolygon,
  type SciPolygonsResult,
} from '../../authoring/sci/sciPolygons.js';
import { sciPropertyName, sciRooms, type SciRoom } from '../../authoring/sci/sciRooms.js';
import {
  SciRoomCanvas,
  sciRoomBackdrop,
  sciRoomImage,
  sciRoomPieces,
  type SciRoomPiece,
} from './SciRoomCanvas.js';
import {
  describeSciViewInPlace,
  describeUnwritableSciView,
  readSciView,
  writeSciView,
} from '../../engine/sci/gfx/SciView.js';
import { readSciFont, writeSciFont } from '../../engine/sci/gfx/SciFont.js';
import { readSciPalette, writeSciPalette } from '../../engine/sci/gfx/sciPalette.js';
import { describeSciVersion, SCI_VERSIONS, type SciVersion } from '../../engine/sci/sciVersion.js';
import {
  CURSOR_TRANSPARENT,
  readSciCursor,
  writeSciCursor,
} from '../../engine/sci/gfx/SciCursor.js';
import {
  readSciVocabulary,
  writeSciVocabulary,
  type SciWord,
} from '../../engine/sci/resource/sciVocabulary.js';
import { announce } from '../../ui/a11y.js';
import { decodeImageFile, pickImageFile, quantise } from '../importImage.js';
import { groupItem, rovingGroup } from '../a11yWidgets.js';
import { accordion, OpenSections } from '../shell.js';
import { STORAGE_KEYS } from '../../ui/storageKeys.js';
import type { AudioSection } from '../audioSection.js';
import { describeSciAudio36 } from '../../authoring/sci/audioList.js';
import { SCI_BASE_AUDIO_MAP } from '../../engine/sci/sound/sciAudio.js';
import { writePng, type RenderedImage } from '../imageExport.js';
import {
  renderSciCelPicture,
  renderSciCursorImage,
  renderSciFontSheet,
  renderSciVectorPicture,
  renderSciViewCel,
  sciImageFilename,
  sciViewColours,
} from './sciImages.js';

/** The kinds this surface shows, which are kinds and not one kind with modes. */
export type SciSurface =
  | 'room'
  | 'cast'
  | 'script'
  | 'vector-picture'
  | 'cel-picture'
  | 'message'
  | 'view'
  | 'font'
  | 'cursor'
  | 'palette'
  | 'vocabulary'
  | 'audio';

export interface SciEditorOptions {
  /** Applies a change to the project, going through the undo/autosave path. */
  update(mutate: (project: Project) => void): void;
  /** Re-reads the project, so the surface redraws from the source of truth. */
  project(): Project;
  /**
   * The re-supplied game folder's name, or null when none is open.
   *
   * Read live rather than passed once, because the shell owns the folder and
   * it can be opened from elsewhere in the session.
   */
  folderName?: () => string | null;
  /**
   * Opens the folder this game was imported from (ADR 0010, ADR 0034).
   *
   * Resolves to a refusal in words, or to null when a folder was accepted.
   * Absent on a surface with no shell behind it — the tests mount one — and
   * the bar then says why exporting and playing are out of reach rather than
   * offering a button that cannot work.
   */
  openGameFolder?: () => Promise<string | null>;
  /**
   * The shared Audio section, where the shell has one to lend.
   *
   * The same instance AGOS and both Broken Swords are handed (ADR 0036: the
   * families share a widget and never a record). A SCI recording is a number
   * and an offset into `RESOURCE.AUD`, which is nothing like a Sword II
   * resource id, and neither of them is in this section — it draws a project's
   * `audio` array, and that array is family-neutral.
   */
  audio?: AudioSection;
}

/**
 * The list's own section names, which are the keys the open state is kept
 * under. Written out rather than derived from the headings, because a heading
 * is prose and a storage key is a promise.
 */
type SciSectionName =
  | 'rooms'
  | 'cast'
  | 'scripts'
  | 'vector-pictures'
  | 'cel-pictures'
  | 'messages'
  | 'views'
  | 'fonts'
  | 'cursors'
  | 'palettes'
  | 'vocabulary'
  | 'carried'
  | 'audio';

interface SciSelection {
  surface: SciSurface;
  /** Script number, Picture number, or MESSAGE resource number. */
  number: number;
  /** Which object in the selected script, by index. */
  objectIndex: number;
  /** Which method on that object. */
  methodIndex: number;
  /** Whether the method is shown as source or as its instructions. */
  asSource: boolean;
  /** Which loop of the open View the frame strip is showing. */
  loop: number;
  /** Which cel of that loop is drawn. */
  cel: number;
}

export class SciEditor {
  readonly element = document.createElement('div');

  private readonly options: SciEditorOptions;
  private readonly list = document.createElement('div');
  private readonly detail = document.createElement('div');

  /** Which thing on the open room is selected, by index, or -1. */
  private roomSelection = -1;
  /** The live room canvas, kept so a re-render can hand the keyboard back. */
  private roomCanvas: SciRoomCanvas | null = null;

  private selection: SciSelection = {
    surface: 'script',
    number: -1,
    objectIndex: 0,
    methodIndex: 0,
    asSource: true,
    loop: 0,
    cel: 0,
  };

  /**
   * Stops the frame strip that is playing, if one is.
   *
   * A pane is rebuilt on every selection change, and a `setInterval` writing
   * into a canvas that has left the document is a leak per click. The strip
   * hands this back rather than finding its own teardown, because the pane is
   * what knows when it is being replaced.
   */
  private stopCelStrip: (() => void) | null = null;

  /** The last refusal from opening a folder, shown beside the button again. */
  private folderProblem: string | null = null;

  /**
   * Which list sections are open, remembered between sessions.
   *
   * `shell.ts`'s widget and this family's own key, which is the arrangement
   * every other family surface here already had and this one did not: the
   * sections were headings with their bodies always rendered, so a game with
   * 1,527 Views put every other section below a column no scroll bar could
   * make short. Scripts, Views and Cel Pictures start open because they are
   * the three a SCI game is mostly made of.
   */
  private readonly sections = new OpenSections<SciSectionName>(STORAGE_KEYS.editorSectionsSci, [
    'rooms',
    'scripts',
    'views',
    'cel-pictures',
  ]);

  constructor(options: SciEditorOptions) {
    this.options = options;
    this.element.className = 'sci-editor';
    this.list.className = 'sci-resource-list';
    this.detail.className = 'sci-resource-detail';
    this.element.append(this.list, this.detail);
    this.render();
  }

  private get sci(): SciProject | undefined {
    return this.options.project().sci;
  }

  /** Nothing ticks here, so nothing has to be stopped. Kept to match `AgiEditor`. */
  destroy(): void {}

  render(): void {
    // Asked before the rebuild and answered after it: the detail pane is
    // replaced wholesale on every change, so a thing moved with the arrow keys
    // would take the focus away with it on the first press.
    const hadRoomFocus = this.roomCanvas?.owns(document.activeElement) ?? false;
    this.renderList();
    this.renderDetail();
    if (hadRoomFocus) this.roomCanvas?.focus();
  }

  // ------------------------------------------------------------- the list --

  private renderList(): void {
    this.list.replaceChildren();
    const sci = this.sci;
    if (!sci) return;

    // The folder bar sits above the refusal rather than under it, and that is
    // not an exception to what the refusal is for. A guessed Version is refused
    // for *editing*; the same game still plays, Play packs what the folder says
    // to pack, and a bar hidden below the refusal would make the one thing
    // still allowed the one thing unreachable.
    this.list.appendChild(this.folderBar());

    // The refusal then replaces the resources, because a game identified only
    // to a bucket must not be edited at all (ADR 0013) — and an editor that
    // shows the resources and refuses at the save has already let somebody do
    // the work twice.
    const refusal = this.refusal(sci);
    if (refusal) {
      const notice = document.createElement('p');
      notice.className = 'sci-refusal';
      notice.setAttribute('role', 'status');
      notice.textContent = refusal;
      this.list.appendChild(notice);
      // The remedy ADR 0020 names, offered rather than only described. Until
      // this existed the refusal told an author the Version could be declared
      // and gave them nowhere to declare it.
      this.list.appendChild(this.declareBar(sci));
      return;
    }

    const unrecovered = sci.scripts.filter((script) => script.unrecovered).length;
    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    summary.textContent =
      unrecovered === 0
        ? `${sci.scripts.length} Script resources, all read as a class graph.`
        : `${unrecovered} of ${sci.scripts.length} Script resources are Unrecovered and open ` +
          `read-only.`;
    summary.classList.toggle('sci-summary-warning', unrecovered > 0);
    this.list.appendChild(summary);

    const provenance = document.createElement('p');
    provenance.className = 'sci-provenance';
    provenance.textContent = `Version: ${sci.identification.how}`;
    this.list.appendChild(provenance);

    // Where this game's words are, and what editing them does not reach.
    const words = document.createElement('p');
    words.className = 'sci-text-surface';
    words.textContent = `${describeTextSurface(sci.messages.length > 0)} Wording baked into Views and Pictures is artwork, and is not reachable from here.`;
    this.list.appendChild(words);

    if (sci.languages.length > 1) {
      // Named rather than counted: a release shipping four languages that
      // imports one has lost three, and by this project's own definitions that
      // is Unrecovered.
      const languages = document.createElement('p');
      languages.className = 'sci-languages';
      languages.textContent =
        `This release ships ${sci.languages.length} languages, all of them held: ` +
        sci.languages.map((one) => `${one.name} (${one.resourceCount})`).join(', ');
      this.list.appendChild(languages);
    }

    // Rooms first, because a room is what an author opens a game to look for,
    // and because a SCI room *is* one of the Scripts below it — the same
    // resource seen as a place rather than as a class graph (ADR 0037).
    const rooms = sciRooms(sci);
    this.list.appendChild(
      this.section('rooms', 'Rooms', rooms.length, (body) => {
        for (const room of rooms) {
          const note =
            room.things.length === 0 ? room.name : `${room.name} · ${room.things.length} placed`;
          body.appendChild(this.entryButton('room', room.script, note));
        }
      }),
    );

    // **Derived, because SCI is the one family here with no cast table.** SCUMM
    // has actors, a Sword 1 compact declares `o_type` MEGA, a Sword II object
    // calls a mega opcode; a SCI game declares nothing, and what plays an actor
    // is class membership. So this is the class graph asked a question rather
    // than a list read off the game, and the header says which classes the
    // answer came through so a reader can see why a row is here.
    //
    // A member opens the Script it is defined in, because that is what it is:
    // `docs/editor-parity.md` row 13, and ADR 0037's point one layer down — a
    // SCI cast member is an object in a Script seen as a character.
    const cast = sciCast(sci.scripts);
    this.list.appendChild(
      this.section('cast', 'Cast', cast.length, (body) => {
        const note = document.createElement('p');
        note.className = 'sci-languages';
        note.textContent = describeSciCast(sci.scripts, cast);
        body.appendChild(note);
        for (const [index, member] of cast.entries()) {
          // Keyed by the member's place in the derived list rather than by the
          // Script number: several of a room's cast are defined in one Script,
          // and a row keyed by the Script would open whichever of them came
          // first. The pane offers the Script itself as a button.
          body.appendChild(
            this.entryButton('cast', index, `${member.name} · via ${member.through}`),
          );
        }
      }),
    );

    this.list.appendChild(
      this.section('scripts', 'Scripts', sci.scripts.length, (body) => {
        for (const script of sci.scripts) {
          const note = script.unrecovered
            ? 'Unrecovered'
            : `${script.objects.length} object${script.objects.length === 1 ? '' : 's'}`;
          body.appendChild(this.entryButton('script', script.number, note));
        }
      }),
    );

    // Two sections, because they are two kinds. Nothing here offers to open a
    // cel Picture in the vector panel.
    this.list.appendChild(
      this.section('vector-pictures', 'Vector Pictures', sci.vectorPictures.length, (body) => {
        for (const picture of sci.vectorPictures) {
          body.appendChild(this.entryButton('vector-picture', picture.number, 'drawing'));
        }
      }),
    );
    this.list.appendChild(
      this.section('cel-pictures', 'Cel Pictures', sci.celPictures.length, (body) => {
        for (const picture of sci.celPictures) {
          body.appendChild(
            this.entryButton(
              'cel-picture',
              picture.number,
              picture.unrecovered ? 'Unrecovered' : `${picture.items.length} items`,
            ),
          );
        }
      }),
    );

    const messageResources = [...new Set(sci.messages.map((message) => message.resource))].sort(
      (a, b) => a - b,
    );
    this.list.appendChild(
      this.section('messages', 'Messages', messageResources.length, (body) => {
        for (const number of messageResources) {
          const count = sci.messages.filter((message) => message.resource === number).length;
          body.appendChild(this.entryButton('message', number, `${count} lines`));
        }
      }),
    );

    // Views, fonts, cursors and vocabularies each get a section of their own.
    // They used to share one headed "Carried through", which was honest and was
    // also the whole of #220's last unmet criterion.
    for (const [surface, type, title, name] of [
      ['view', 'view', 'Views', 'views'],
      ['font', 'font', 'Fonts', 'fonts'],
      ['cursor', 'cursor', 'Cursors', 'cursors'],
      ['palette', 'palette', 'Palettes', 'palettes'],
      ['vocabulary', 'vocab', 'Vocabulary', 'vocabulary'],
    ] as const) {
      const entries = sci.resources.filter(
        (resource) =>
          resource.type === type && (type !== 'vocab' || VOCABULARY_NUMBERS.has(resource.number)),
      );
      this.list.appendChild(
        this.section(name, title, entries.length, (body) => {
          for (const entry of entries) {
            body.appendChild(this.entryButton(surface, entry.number, ''));
          }
        }),
      );
    }

    // What is left really is carried through, and says so.
    const carried = sci.resources.filter(
      (resource) =>
        !['view', 'font', 'cursor'].includes(resource.type) &&
        !(resource.type === 'vocab' && VOCABULARY_NUMBERS.has(resource.number)),
    );
    this.list.appendChild(
      this.section('carried', 'Carried through', carried.length, (body) => {
        const kinds = new Map<string, number>();
        for (const resource of carried) {
          kinds.set(resource.type, (kinds.get(resource.type) ?? 0) + 1);
        }
        const note = document.createElement('p');
        note.className = 'sci-carried';
        note.textContent =
          kinds.size === 0
            ? 'Nothing. Every resource kind in this game has a surface.'
            : `${[...kinds]
                .sort()
                .map(([type, count]) => `${count} ${type}`)
                .join(', ')} — exported byte for byte, with no surface of their own. That is ` +
              `what keeps an untouched resource identical, not what makes a surface unnecessary.`;
        body.appendChild(note);
      }),
    );

    this.appendAudioSection();
  }

  /**
   * The Audio section in the list, as one row that opens the panel.
   *
   * A row rather than the rows themselves, for the reason both Broken Swords
   * give: this column is a column of names and a talkie holds thousands of
   * recordings, so the filter, the paging and the play buttons belong in the
   * detail pane where there is room for them.
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
      this.selection = { ...this.selection, surface: 'audio' };
      this.sections.open('audio');
    };
    this.list.appendChild(
      this.section('audio', 'Audio', audio.count, (body) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'sci-resource';
        button.textContent = `${audio.count} recordings`;
        button.setAttribute('aria-label', `audio, ${audio.count} recordings`);
        button.classList.toggle('selected', this.selection.surface === 'audio');
        if (this.selection.surface === 'audio') button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => {
          this.selection = { ...this.selection, surface: 'audio' };
          this.render();
        });
        body.appendChild(button);
      }),
    );
  }

  /**
   * The bar that names the re-supplied game folder, and asks for one.
   *
   * A SCI Project carries its class graph, its Pictures and its words, and
   * nothing whatever about the container they arrived in: which map structure
   * this install uses, what its files are called, and which audio and video
   * Volumes sit beside them are all facts about the folder (ADR 0010, ADR
   * 0034). `RESOURCE.AUD` on a talkie is hundreds of megabytes that are
   * carried byte for byte and never rebuilt (#227), so copying them into the
   * project to avoid asking would be copying a disc to save a click.
   *
   * That makes this bar the gate on two gestures rather than a convenience:
   * Save exports an install packed into the container the folder names, and
   * Play runs that install with the folder underneath it. Both say so when
   * pressed without one, and this is where the author fixes it.
   */
  private folderBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'sci-folder-bar';

    const title = document.createElement('h3');
    title.className = 'sci-folder-title';
    title.textContent = 'Game folder';
    bar.appendChild(title);

    const name = this.options.folderName?.() ?? null;

    const where = document.createElement('p');
    where.className = name === null ? 'sci-summary-warning' : 'sci-folder-name';
    where.textContent =
      name ??
      'None open. Exporting and playing both pack this project into the container the original ' +
        'install used — which map structure, which file names, and which audio Volumes to carry ' +
        'through unrebuilt — and all three are read from the folder rather than kept in the ' +
        'project (ADR 0010, ADR 0034).';
    bar.appendChild(where);

    if (this.folderProblem) {
      const why = document.createElement('p');
      why.className = 'sci-summary-warning';
      why.textContent = this.folderProblem;
      bar.appendChild(why);
    }

    const open = this.options.openGameFolder;
    if (!open) {
      const none = document.createElement('p');
      none.className = 'sci-note';
      none.textContent =
        'This surface was mounted without a way to open a folder, so the resources below can be ' +
        'edited and the result cannot be packed into an install.';
      bar.appendChild(none);
      return bar;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name === null ? 'Open game folder…' : 'Change folder…';
    button.title =
      name === null
        ? 'The container this project is packed into is read from the folder (ADR 0010)'
        : 'Pick a different folder, for one chosen by mistake';
    button.addEventListener('click', () => {
      void (async () => {
        // Disabled for the duration: a directory read is not instant, and a
        // second dialogue opened on top of the first is how two folders end up
        // racing to be the accepted one.
        button.disabled = true;
        try {
          this.folderProblem = (await open()) ?? null;
        } finally {
          button.disabled = false;
          this.render();
        }
      })();
    });
    bar.appendChild(button);

    return bar;
  }

  /**
   * Why this game may not be edited, or null.
   *
   * ADR 0013 refuses to edit on a guessed Version and ADR 0020 requires the
   * reason on screen rather than a disabled button. The evidence goes with it,
   * because "identified by guess" without the probes that were tried is a
   * verdict rather than a reason.
   */
  private refusal(sci: SciProject): string | null {
    if (!/guess/i.test(sci.identification.how)) return null;
    return (
      `This game's Version was only guessed (${sci.identification.how}), so it plays and is ` +
      `refused for editing. SCI stamps its Version nowhere, and an edit written against the ` +
      `wrong Version's object layout produces a game that loads and is not the one the scripts ` +
      `hold pointers to. What was tried: ${sci.identification.evidence.join('; ')}.`
    );
  }

  /**
   * Declaring the Version by hand, which is ADR 0020's escape from a guess.
   *
   * **Not a way round ADR 0013 — the other path it always had.** A *guess* is
   * the engine's, silent, and is refused. A *declaration* is the author's, made
   * deliberately against the warning above it, and is recorded in the Project
   * where a mistake stays visible. ADR 0020 says so in as many words: "someone
   * who knows their copy is SCI1 late says so and edits."
   *
   * **The choices are the Versions still standing, not all thirteen.** The
   * probes narrowed the game to a bucket; offering a Version the evidence has
   * already excluded would invite an author to contradict a measurement rather
   * than to settle what the measurement could not reach. King's Quest VII is
   * the case this was built for: its probes end at "SCI2.1 middle or late", and
   * `sciVersion.ts` says that seam is *asserted* — ScummVM distinguishes those
   * tiers "mainly by which builds ... belong to each", which is a statement
   * that the difference is not in the data and **no probe will ever settle
   * it**. A person with the box in their hand is the only instrument left.
   */
  private declareBar(sci: SciProject): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'sci-declare-bar';

    const label = document.createElement('label');
    label.textContent = 'If you know which this is, say so:';
    label.htmlFor = 'sci-declare-version';

    const picker = document.createElement('select');
    picker.id = 'sci-declare-version';
    for (const version of this.candidateVersions(sci)) {
      const option = document.createElement('option');
      option.value = version;
      option.textContent = describeSciVersion(version);
      picker.appendChild(option);
    }

    const declare = document.createElement('button');
    declare.type = 'button';
    declare.textContent = 'Declare this Version';
    declare.addEventListener('click', () => {
      const chosen = picker.value as SciVersion;
      this.options.update((project) => {
        const target = project.target;
        if (target.engine !== 'sci') return;
        target.version = chosen;
        target.identification = 'declared';
        const held = project.sci;
        if (held) {
          held.identification = {
            how: `declared as ${describeSciVersion(chosen)}`,
            // The evidence is kept rather than replaced: what the probes did
            // reach is still the record of why a person had to choose.
            evidence: [
              ...held.identification.evidence,
              `Declared by the author as ${describeSciVersion(chosen)}, against the warning ` +
                `that a wrong declaration is written into every resource this Project exports.`,
            ],
          };
        }
      });
      this.render();
    });

    const caution = document.createElement('p');
    caution.className = 'sci-note';
    caution.textContent =
      'A declaration is not a probe. Naming the wrong Version writes that misreading back ' +
      'into every resource this Project exports, and the round-trip check will pass while ' +
      'the structure is wrong — so declare only what you know.';

    bar.append(label, picker, declare, caution);
    return bar;
  }

  /**
   * The Versions the evidence still allows, which is what may be declared.
   *
   * Read from the bucket the probes ended on rather than from the whole axis.
   * The identification's own words name it — "narrowed to X, Y and no further"
   * — so the list is parsed back out of the sentence that produced it, and
   * falls back to the Version in the Target when nothing can be read, which is
   * the one that is certainly a candidate because it is the one being played.
   */
  private candidateVersions(sci: SciProject): SciVersion[] {
    const said = [sci.identification.how, ...sci.identification.evidence].join(' ');
    // Matched as whole names rather than as substrings: "SCI2" sits inside
    // "SCI2.1 middle", so a plain `includes` offers SCI2 for every SCI2.1 game
    // — a Version the evidence has already excluded.
    const standing = SCI_VERSIONS.filter((version) => {
      const name = describeSciVersion(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`${name}(?![\\w.])`).test(said);
    });
    const current = this.options.project().target;
    const playing = current.engine === 'sci' ? current.version : null;
    if (playing && !standing.includes(playing)) standing.unshift(playing);
    return standing.length > 0 ? standing : [...SCI_VERSIONS];
  }

  private section(
    name: SciSectionName,
    title: string,
    count: number,
    fill: (body: HTMLElement) => void,
  ): HTMLElement {
    return accordion({
      name,
      title,
      count,
      sections: this.sections,
      idPrefix: 'sci-accordion',
      fill: (body) => {
        body.classList.add('sci-section-body');
        fill(body);
      },
      onToggle: () => this.renderList(),
    });
  }

  /**
   * One "Export PNG", for artwork that is already rendered somewhere else.
   *
   * `produce` returns the pixels or says in words why there are none — a
   * Picture that stopped mid-read has some, and writing them out would be a
   * room with a piece missing and nothing on the file saying so. The encode and
   * the download are `writePng`, which is `downloadBlob`: the revoke in that
   * function runs on a timer because revoking in the same tick cancels the
   * download in some browsers, and this surface is not where a fourth copy of
   * that mistake gets made.
   */
  /** A thing's name as a filename stem, so two exports do not collide. */
  private static stem(name: string): string {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'thing'
    );
  }

  /**
   * "Import a PNG", for the two kinds of SCI artwork that have an encoder.
   *
   * `docs/editor-parity.md` row 17, whose No was two different sizes stacked
   * into one cell. A **V56 cel** has no encoder — `writeSciView` patches a
   * cel's origin in place and does not re-encode pixels at all — so importing
   * over one would need an encoder per SCI cel compression that nobody has
   * written. A **font glyph** and a **cursor** are the other end: `writeSciFont`
   * and `writeSciCursor` already exist and are what the pixel grids call, so
   * the only thing between them and an import was a file picker.
   *
   * `receive` is handed indices at exactly the target's size, quantised
   * against the palette this kind of artwork actually has — one bit for a
   * glyph, three states for a cursor — because "quantised to the game's
   * colours" is what the row asks for and a SCI font has two of them.
   */
  private importButton(
    label: string,
    size: { width: number; height: number },
    palette: readonly (readonly number[])[],
    receive: (pixels: Uint8Array, opaque: (index: number) => boolean) => void,
  ): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sci-export';
    button.textContent = `Import a PNG over ${label}`;
    button.addEventListener('click', () => {
      void (async () => {
        const file = await pickImageFile();
        if (!file) return;
        try {
          const decoded = await decodeImageFile(file, {
            width: size.width,
            height: size.height,
            // `contain`, so an image of the wrong shape is letterboxed rather
            // than stretched — a glyph squashed to fit reads as a bad import.
            fit: 'contain',
          });
          const indexed = quantise(decoded, {
            palette: palette.map((entry) => [...entry]),
            alphaThreshold: 128,
          });
          // The decoded alpha is handed over beside the indices, because
          // "transparent" and "index 0" are the same number and not the same
          // fact: a cursor's index 0 is black, and a caller that read
          // transparency off the index would turn every black pixel into a
          // hole.
          receive(Uint8Array.from(indexed.pixels), (at) => decoded.data[at * 4 + 3] > 128);
          this.render();
          announce(`${label} replaced from ${file.name}.`);
        } catch (error) {
          announce(`${label} could not be replaced: ${String(error)}`);
        }
      })();
    });
    return button;
  }

  private exportButton(
    label: string,
    stem: string,
    produce: () => RenderedImage | string | null,
  ): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sci-export';
    button.textContent = 'Export PNG';
    button.setAttribute('aria-label', `export ${label} as a PNG`);
    button.addEventListener('click', () => {
      void (async () => {
        button.disabled = true;
        try {
          const rendered = produce();
          if (rendered === null || typeof rendered === 'string') {
            announce(rendered ?? `${label} has no artwork to export.`);
            return;
          }
          await writePng(rendered, sciImageFilename(this.options.project().name, stem));
          announce(`${label} exported as a PNG.`);
        } catch (error) {
          announce(error instanceof Error ? error.message : String(error));
        } finally {
          button.disabled = false;
        }
      })();
    });
    return button;
  }

  private entryButton(surface: SciSurface, number: number, note: string): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sci-resource';
    button.textContent = note ? `${number} · ${note}` : String(number);
    const selected = this.selection.surface === surface && this.selection.number === number;
    button.classList.toggle('selected', selected);
    button.classList.toggle('sci-unrecovered', note === 'Unrecovered');
    // "210" on its own is not a name (4.1.2).
    button.setAttribute(
      'aria-label',
      `${surface.replace('-', ' ')} ${number}${note ? `, ${note}` : ''}`,
    );
    if (selected) button.setAttribute('aria-current', 'true');
    button.addEventListener('click', () => {
      // A thing's index means nothing in a different room, so it is dropped
      // rather than carried across and pointed at whatever is there.
      if (surface !== this.selection.surface || number !== this.selection.number) {
        this.roomSelection = -1;
      }
      this.selection = {
        ...this.selection,
        surface,
        number,
        objectIndex: 0,
        methodIndex: 0,
        loop: 0,
        cel: 0,
      };
      this.render();
    });
    return button;
  }

  // ----------------------------------------------------------- the detail --

  private renderDetail(): void {
    this.stopCelStrip?.();
    this.stopCelStrip = null;
    this.detail.replaceChildren();
    const sci = this.sci;
    if (!sci) return;
    if (this.refusal(sci)) return;

    switch (this.selection.surface) {
      case 'room':
        this.renderRoom(sci);
        return;
      case 'cast':
        this.renderCastMember(sci);
        return;
      case 'script':
        this.renderScript(sci);
        return;
      case 'vector-picture':
        this.renderVectorPicture(sci);
        return;
      case 'cel-picture':
        this.renderCelPicture(sci);
        return;
      case 'message':
        this.renderMessages(sci);
        return;
      case 'view':
        this.renderView(sci);
        return;
      case 'font':
        this.renderFont(sci);
        return;
      case 'cursor':
        this.renderCursor(sci);
        return;
      case 'palette':
        this.renderPalette(sci);
        return;
      case 'vocabulary':
        this.renderVocabulary(sci);
        return;
      case 'audio':
        this.renderAudio(sci);
    }
  }

  /**
   * The Audio panel: which folder is open, then every recording.
   *
   * The bar first and the rows under it, which is what both Broken Swords do
   * and for the same reason (`swordAudioPane.ts`): the rows are an index and
   * not a copy, so without the folder every one of them lists and none of them
   * plays — and the button that fixes that belongs above the rows it lights up.
   * It is the same bar the resource list shows, because it is the same folder
   * and the same gesture; opening it from either place lights up both.
   *
   * The section's two hooks are pointed at this surface rather than at the
   * shell's sidebar, because the rows are in this pane — a re-render that
   * redrew the shell's sidebar would leave them stale.
   */
  private renderAudio(sci: SciProject): void {
    const audio = this.options.audio;

    const heading = document.createElement('h2');
    heading.textContent = 'Audio';
    this.detail.appendChild(heading);

    if (!audio) {
      const none = document.createElement('p');
      none.className = 'sci-note';
      none.textContent =
        'This surface was mounted without the shared Audio section, so this game’s recordings ' +
        'are not listed here.';
      this.detail.appendChild(none);
      return;
    }

    const what = document.createElement('p');
    what.className = 'sci-note';
    what.textContent =
      `${audio.count} digital recordings, listed by the numbers this release’s own maps say. ` +
      `Their bytes stay in the game folder rather than in the project (ADR 0034), so playing ` +
      `and saving one both read from the folder named below. Music is not here: SCI’s is a ` +
      `sound resource played by the interpreter’s driver rather than a file, so there is ` +
      `nothing to hand a decoder.`;
    this.detail.appendChild(what);

    // Said here rather than discovered after an export. Replacing a recording
    // puts the new bytes in front of the old ones everywhere this editor plays
    // them, and an exported install still carries `RESOURCE.AUD` through byte
    // for byte (#227) — nothing in this project rebuilds one. The two Broken
    // Swords are in the same position, and a button that looked like it
    // changed the game would be the worse half of that.
    const replacing = document.createElement('p');
    replacing.className = 'sci-note';
    replacing.textContent =
      'Replacing a recording changes what plays here and what a save writes out of this ' +
      'project. It does not change the exported install: a game’s audio Volumes are copied ' +
      'through unrebuilt (#227), because nothing in a SCI Project could rebuild one.';
    this.detail.appendChild(replacing);

    // Named rather than left out silently. A talkie's per-room speech is the
    // larger half of what it holds, and an Audio panel that showed a base map's
    // rows and said nothing would read as though that were all there was.
    const omitted = describeSciAudio36(
      sci.resources.filter(
        (resource) => resource.type === 'map' && resource.number !== SCI_BASE_AUDIO_MAP,
      ).length,
    );
    if (omitted) {
      const note = document.createElement('p');
      note.className = 'sci-summary-warning';
      note.textContent = omitted;
      this.detail.appendChild(note);
    }

    this.detail.appendChild(this.folderBar());
    audio.render(this.detail);
  }

  /** The resource behind the current selection, of a given type. */
  private resource(sci: SciProject, type: string): SciProjectResource | undefined {
    return sci.resources.find((one) => one.type === type && one.number === this.selection.number);
  }

  // ------------------------------------------------- Views, fonts, cursors --

  /**
   * A View: loops of cels, edited as geometry rather than as pixels.
   *
   * A cel's *placement* — where its origin sits relative to the actor's feet —
   * is what makes an actor line up with the ground, and it is two signed bytes
   * in the cel's own header. Getting it wrong stands every actor half a cel to
   * one side, which reads as art that does not line up rather than as a fault,
   * so it is worth being able to correct without a pixel editor.
   *
   * **A V56 View is refused by name.** Its cel record carries scaling fields
   * this has no values for, and writing one back with invented ones produces a
   * View that loads and draws an actor the wrong size.
   */
  private renderView(sci: SciProject): void {
    const resource = this.resource(sci, 'view');
    if (!resource) {
      this.placeholder('Pick a View.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `View ${resource.number}`;
    this.detail.appendChild(heading);

    const view = readSciView(fromBase64(resource.bytes));
    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    summary.textContent =
      `${view.loops.length} loops, ` +
      `${view.loops.reduce((sum, loop) => sum + loop.cels.length, 0)} cels, ` +
      `${view.encoding.toUpperCase()} cels.`;
    this.detail.appendChild(summary);

    const refusal = describeUnwritableSciView(view);
    if (refusal) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent = refusal;
      this.detail.appendChild(why);
      return;
    }

    // A View that *is* writable may still be writable only in place, and
    // saying which is the difference between a surface an author can trust and
    // one where some of the fields quietly do nothing.
    const inPlace = describeSciViewInPlace(view);
    if (inPlace) {
      const note = document.createElement('p');
      note.className = 'sci-note';
      note.textContent = inPlace;
      this.detail.appendChild(note);
    }

    // A View carries no palette of its own — on screen its colours are
    // whatever room it last walked into — so the export chooses one and this
    // says which, rather than handing over a PNG in colours nothing explains.
    const colours = sciViewColours(sci);
    const palette = document.createElement('p');
    palette.className = 'sci-carried';
    palette.textContent =
      `Exported cels are coloured with ${colours.how}. A View holds indices and no colours, so ` +
      `this is a choice rather than a reading.`;
    this.detail.appendChild(palette);

    // **An import where there is an encoder, and a sentence where there is
    // not.** `writeSciView` re-encodes a SCI0 or SCI1 cel's run-length body
    // from its pixels, so those take a PNG; a V56 View is patched in place and
    // its bodies are never re-encoded, which `describeSciViewInPlace` has
    // already said above in its own words.
    const chosenLoop = Math.min(this.selection.loop, Math.max(0, view.loops.length - 1));
    const chosenCel = view.loops[chosenLoop]?.cels[this.selection.cel];
    if (!inPlace && chosenCel) {
      this.detail.appendChild(
        this.importButton(
          `loop ${chosenLoop} cel ${this.selection.cel}`,
          { width: chosenCel.width, height: chosenCel.height },
          colours.colours,
          (pixels, opaque) => {
            for (let index = 0; index < chosenCel.pixels.length; index++) {
              // The clear key is the cel's own, and transparency comes from the
              // source's alpha rather than from the index it quantised to —
              // a cel's clear key is a real colour everywhere else in the View.
              chosenCel.pixels[index] = opaque(index)
                ? (pixels[index] ?? chosenCel.clearKey)
                : chosenCel.clearKey;
            }
            this.options.update(() => {
              resource.bytes = toBase64(writeSciView(view));
            });
          },
        ),
      );
    }

    // **The frame strip, which rows 15 and 18 are.** Both used to be No for one
    // reason and it was not a fact about SCI: no artwork was ever drawn on this
    // surface at all, so there was no frame to pick and nothing to play.
    this.detail.appendChild(this.loopPicker(view.loops.length));
    const strip = sciCelStrip({
      id: `view-${resource.number}`,
      view,
      colours,
      loop: chosenLoop,
      cel: this.selection.cel,
      title: `View ${resource.number}`,
      onSelect: (loop, cel) => {
        this.selection = { ...this.selection, loop, cel };
      },
    });
    this.stopCelStrip = strip.stop;
    this.detail.appendChild(strip.element);

    const table = document.createElement('table');
    table.className = 'sci-cel-items';
    const head = table.createTHead().insertRow();
    for (const label of ['Loop', 'Cel', 'Size', 'Origin x', 'Origin y', 'Artwork']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.appendChild(cell);
    }
    const body = table.createTBody();
    for (const [loopIndex, loop] of view.loops.entries()) {
      for (const [celIndex, cel] of loop.cels.entries()) {
        const row = body.insertRow();
        const label = document.createElement('th');
        label.scope = 'row';
        label.textContent = loop.mirrored
          ? `${loopIndex} (mirrors ${loop.mirrorOf})`
          : `${loopIndex}`;
        row.appendChild(label);
        row.insertCell().textContent = String(celIndex);
        row.insertCell().textContent = `${cel.width}x${cel.height}`;
        for (const field of ['displaceX', 'displaceY'] as const) {
          const cell = row.insertCell();
          // A mirrored loop's cel has no record of its own — its pixels and its
          // origin are the other loop's, flipped. Shown and not offered, so
          // that "this number cannot be changed here" is visible rather than
          // being a change that silently moves the loop it mirrors.
          if (inPlace && cel.recordAt === undefined) {
            cell.textContent = String(cel[field]);
            cell.title = `mirrors loop ${loop.mirrorOf}, whose record holds this`;
            continue;
          }
          const input = document.createElement('input');
          input.type = 'number';
          input.className = 'sci-cel-field';
          input.value = String(cel[field]);
          input.setAttribute('aria-label', `loop ${loopIndex} cel ${celIndex} ${field}`);
          input.addEventListener('change', () => {
            const value = Number(input.value);
            if (!Number.isFinite(value)) return;
            cel[field] = value;
            this.options.update(() => {
              resource.bytes = toBase64(writeSciView(view));
            });
            announce(`loop ${loopIndex} cel ${celIndex} ${field} is ${value}`);
          });
          cell.appendChild(input);
        }
        // A mirrored loop's cels are the other loop's, flipped by the reader,
        // so exporting one gives the frame as it is drawn rather than the
        // bytes it is stored as.
        row
          .insertCell()
          .appendChild(
            this.exportButton(
              `View ${resource.number} loop ${loopIndex} cel ${celIndex}`,
              `view-${resource.number}-loop-${loopIndex}-cel-${celIndex}`,
              () => renderSciViewCel(view, loopIndex, celIndex, colours),
            ),
          );
      }
    }
    this.detail.appendChild(table);
  }

  /**
   * Which loop the frame strip is showing, as a row of radio buttons.
   *
   * A mirrored loop is offered like any other: the reader flips it, so picking
   * one shows the frames as they are drawn rather than the bytes they are
   * stored as. What a mirrored loop may not do is take an edit, and the table
   * below already says so per cel.
   */
  private loopPicker(loops: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sci-frame-strip sci-loop-picker';
    const chosen = Math.min(this.selection.loop, Math.max(0, loops - 1));
    for (let index = 0; index < loops; index++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sci-frame';
      button.textContent = `Loop ${index}`;
      groupItem(button, { role: 'radio', selected: index === chosen, label: `loop ${index}` });
      button.addEventListener('click', () => {
        this.selection = { ...this.selection, loop: index, cel: 0 };
        this.render();
        announce(`loop ${index}`);
      });
      row.appendChild(button);
    }
    rovingGroup(row, { role: 'radiogroup', label: 'loops', orientation: 'horizontal' });
    return row;
  }

  /**
   * One member of the cast: who they are, what they wear, and it drawn.
   *
   * `docs/editor-parity.md` row 14, which was a **No that followed row 13** —
   * "this is a character's pane, and there is no cast section to hang one on".
   * The cast section exists now, so the No was only ever about this pane not
   * being written.
   *
   * **What is drawn is the View the instance's own property word names**, not
   * a guess and not the room's. A SCI instance carries `view`, `loop` and
   * `cel` as three property words, and a great many of King's Quest VII's cast
   * ship 65535 in the first of them because their room assigns it in `init` —
   * so this either draws the art the file names or says, by name, that the file
   * names none. An empty pane and "this release has no art for them" are
   * different facts and must not look alike.
   */
  private renderCastMember(sci: SciProject): void {
    const cast = sciCast(sci.scripts);
    const member = cast[this.selection.number];
    if (!member) {
      this.placeholder('Pick a cast member.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = member.name;
    this.detail.appendChild(heading);

    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    summary.textContent =
      `An instance in Script ${member.script}, ${member.depth} ` +
      `${member.depth === 1 ? 'hop' : 'hops'} up its -super- chain from ${member.through}.`;
    this.detail.appendChild(summary);

    // The Script is what a cast member *is*, so the pane that edits it is one
    // button away rather than being duplicated here.
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'sci-button';
    open.textContent = `Open Script ${member.script}`;
    open.addEventListener('click', () => {
      this.selection = {
        ...this.selection,
        surface: 'script',
        number: member.script,
        objectIndex: Math.max(
          0,
          (sci.scripts.find((script) => script.number === member.script)?.objects ?? []).indexOf(
            member.object,
          ),
        ),
        methodIndex: 0,
      };
      this.render();
    });
    this.detail.appendChild(open);

    const worn = sciCastArt(member, sci);
    if (typeof worn === 'string') {
      const why = document.createElement('p');
      why.className = 'sci-note';
      why.textContent = worn;
      this.detail.appendChild(why);
      return;
    }

    const colours = sciViewColours(sci);
    const note = document.createElement('p');
    note.className = 'sci-carried';
    note.textContent =
      `View ${worn.number}, from this instance's own view property word. Coloured with ` +
      `${colours.how}, a View holding indices and no colours of its own.`;
    this.detail.appendChild(note);

    this.detail.appendChild(this.loopPicker(worn.view.loops.length));
    const strip = sciCelStrip({
      id: `cast-${this.selection.number}`,
      view: worn.view,
      colours,
      loop: Math.min(this.selection.loop, Math.max(0, worn.view.loops.length - 1)),
      cel: this.selection.cel,
      title: member.name,
      speed: worn.speed,
      onSelect: (loop, cel) => {
        this.selection = { ...this.selection, loop, cel };
      },
    });
    this.stopCelStrip = strip.stop;
    this.detail.appendChild(strip.element);
  }

  /**
   * A font: glyphs, edited a pixel at a time.
   *
   * The reason this exists rather than being carried through is #222's point
   * about localisation: accented characters need glyphs the shipped font does
   * not have, and a translator who can reach the Messages and not the font has
   * half a tool.
   */
  private renderFont(sci: SciProject): void {
    const resource = this.resource(sci, 'font');
    if (!resource) {
      this.placeholder('Pick a font.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Font ${resource.number}`;
    this.detail.appendChild(heading);

    const font = readSciFont(fromBase64(resource.bytes));
    if (font.unrecovered) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent = `This font could not be read whole: ${font.unrecovered}. It exports byte-identically.`;
      this.detail.appendChild(why);
      return;
    }

    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    summary.textContent = `${font.glyphs.length} characters, line height ${font.lineHeight}.`;
    this.detail.appendChild(summary);

    // The whole font on one sheet rather than one download per character: an
    // export is for handing to whoever is drawing the accented glyphs #222 is
    // about, and that is one image of the set, not 256 files.
    this.detail.appendChild(
      this.exportButton(`font ${resource.number}`, `font-${resource.number}`, () =>
        renderSciFontSheet(font),
      ),
    );

    const glyph = font.glyphs[this.selection.objectIndex] ?? font.glyphs[0];
    const picker = document.createElement('div');
    picker.className = 'sci-section-body';
    for (const [index, one] of font.glyphs.entries()) {
      if (one.width === 0) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sci-resource';
      // The printable range gets its character; everything else its number.
      button.textContent = index >= 32 && index < 127 ? String.fromCharCode(index) : String(index);
      button.classList.toggle('selected', font.glyphs[this.selection.objectIndex] === one);
      button.setAttribute('aria-label', `character ${index}, ${one.width} by ${one.height}`);
      button.addEventListener('click', () => {
        this.selection = { ...this.selection, objectIndex: index };
        this.render();
      });
      picker.appendChild(button);
    }
    this.detail.appendChild(picker);

    if (!glyph) return;

    // **One bit deep, so the palette an import quantises against has two
    // colours in it.** Index 0 is blank and index 1 is inked, which is what
    // the grid below writes and what `writeSciFont` encodes.
    this.detail.appendChild(
      this.importButton(
        `character ${this.selection.objectIndex}`,
        { width: glyph.width, height: glyph.height },
        [
          [0, 0, 0],
          [255, 255, 255],
        ],
        (pixels) => {
          glyph.pixels.set(pixels.subarray(0, glyph.pixels.length));
          this.options.update(() => {
            resource.bytes = toBase64(writeSciFont(font));
          });
        },
      ),
    );

    const grid = document.createElement('div');
    grid.className = 'sci-glyph-grid';
    grid.style.gridTemplateColumns = `repeat(${glyph.width}, 1fr)`;
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', `character bitmap, ${glyph.width} by ${glyph.height}`);
    for (let index = 0; index < glyph.width * glyph.height; index++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'sci-glyph-dot';
      dot.classList.toggle('inked', glyph.pixels[index] === 1);
      const x = index % glyph.width;
      const y = (index / glyph.width) | 0;
      dot.setAttribute('aria-label', `${x}, ${y}, ${glyph.pixels[index] ? 'inked' : 'blank'}`);
      dot.setAttribute('aria-pressed', glyph.pixels[index] ? 'true' : 'false');
      dot.addEventListener('click', () => {
        glyph.pixels[index] = glyph.pixels[index] ? 0 : 1;
        this.options.update(() => {
          resource.bytes = toBase64(writeSciFont(font));
        });
        this.render();
      });
      grid.appendChild(dot);
    }
    this.detail.appendChild(grid);
  }

  /** A cursor: a 16x16 bitmap over transparency, and a hotspot. */
  private renderCursor(sci: SciProject): void {
    const resource = this.resource(sci, 'cursor');
    if (!resource) {
      this.placeholder('Pick a cursor.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Cursor ${resource.number}`;
    this.detail.appendChild(heading);

    const cursor = readSciCursor(fromBase64(resource.bytes));
    if (!cursor) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent =
        'This resource is too short to be a SCI0 or SCI1 cursor. It exports byte-identically.';
      this.detail.appendChild(why);
      return;
    }

    const hotspot = document.createElement('p');
    hotspot.className = 'sci-summary';
    hotspot.textContent = `${cursor.width}x${cursor.height}, hotspot at ${cursor.hotspotX}, ${cursor.hotspotY}.`;
    this.detail.appendChild(hotspot);

    // Black and white both, over transparency: a SCI cursor is drawn in two
    // colours so it reads on a dark room and a light one, and a one-colour
    // export loses half of every pointer.
    this.detail.appendChild(
      this.exportButton(`cursor ${resource.number}`, `cursor-${resource.number}`, () =>
        renderSciCursorImage(cursor),
      ),
    );

    // **Three states and not 256**, which is what a SCI cursor has: black,
    // white and the transparency the pointer shows the room through. An import
    // quantises to the first two and takes alpha for the third, so a PNG drawn
    // with a transparent background arrives as a pointer rather than as a
    // square.
    this.detail.appendChild(
      this.importButton(
        `cursor ${resource.number}`,
        { width: cursor.width, height: cursor.height },
        [
          [0, 0, 0],
          [255, 255, 255],
        ],
        (pixels, opaque) => {
          for (let index = 0; index < cursor.pixels.length; index++) {
            cursor.pixels[index] = opaque(index) ? (pixels[index] ?? 0) : CURSOR_TRANSPARENT;
          }
          this.options.update(() => {
            resource.bytes = toBase64(writeSciCursor(cursor));
          });
        },
      ),
    );

    const grid = document.createElement('div');
    grid.className = 'sci-glyph-grid';
    grid.style.gridTemplateColumns = `repeat(${cursor.width}, 1fr)`;
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'cursor bitmap');
    for (let index = 0; index < cursor.pixels.length; index++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'sci-glyph-dot';
      const value = cursor.pixels[index];
      dot.classList.toggle('inked', value === 1);
      dot.classList.toggle('black', value === 0);
      const x = index % cursor.width;
      const y = (index / cursor.width) | 0;
      dot.setAttribute(
        'aria-label',
        `${x}, ${y}, ${value === 1 ? 'white' : value === 0 ? 'black' : 'transparent'}`,
      );
      dot.addEventListener('click', () => {
        // Three states, in the order a person draws in: transparent, white,
        // black. Two planes in the resource, one control here.
        cursor.pixels[index] = value === 1 ? 0 : value === 0 ? CURSOR_TRANSPARENT : 1;
        this.options.update(() => {
          resource.bytes = toBase64(writeSciCursor(cursor));
        });
        this.render();
      });
      grid.appendChild(dot);
    }
    this.detail.appendChild(grid);
  }

  /**
   * `vocab.000`: the words the parser matches, and their groups.
   *
   * A word's **group** is what `said` matches, not its spelling — so adding a
   * synonym means giving a new word an existing group, and that is the one
   * operation this surface has to make possible.
   */
  /**
   * A palette resource, colour by colour (`docs/editor-parity.md` row 24).
   *
   * The other three families answer this row Yes and SCI answered No, with its
   * palettes sitting unopened in **Carried through** — nine of them on King's
   * Quest VII, 2,224 colours between them. They are the game's colours: a View
   * carries its own palette and the room's Picture carries another, so this is
   * where an author changes what a scene is painted in.
   *
   * **Written by patching the three bytes each colour was read from.** The
   * header, the start index, the count, the used flags and every byte this
   * project does not understand survive untouched, so an unedited write is
   * byte-identical by construction — all nine of King's Quest VII's do.
   *
   * An entry Sierra marked *unused* is shown and is editable, and says so. The
   * flag governs whether her own `set` submits the colour, not whether the
   * colour is in the resource, and a surface that hid them would be hiding 88%
   * of what a SCI32 View declares.
   */
  private renderPalette(sci: SciProject): void {
    const resource = this.resource(sci, 'palette');
    if (!resource) {
      this.placeholder('Pick a palette.');
      return;
    }

    const bytes = fromBase64(resource.bytes);
    const entries = readSciPalette(bytes);

    const heading = document.createElement('h2');
    heading.textContent = `Palette ${resource.number}`;
    this.detail.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'sci-languages';
    note.textContent =
      entries.length === 0
        ? 'This resource holds no colour table this reader recognises.'
        : `${entries.length} colours, ${entries[0].index} to ${entries[entries.length - 1].index}. ` +
          `Each one writes back over the three bytes it was read from, so every other byte of ` +
          `the resource is left exactly as it arrived.`;
    this.detail.appendChild(note);

    const grid = document.createElement('div');
    grid.className = 'sci-palette-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', `palette ${resource.number}`);

    for (const entry of entries) {
      const swatch = document.createElement('label');
      swatch.className = 'sci-palette-swatch';

      const input = document.createElement('input');
      input.type = 'color';
      const hex = (value: number): string => value.toString(16).padStart(2, '0');
      input.value = `#${hex(entry.r)}${hex(entry.g)}${hex(entry.b)}`;
      // "index 75" on its own is not a name, and the colour is not readable by
      // a screen reader from the swatch — so the label carries both.
      input.setAttribute(
        'aria-label',
        `colour ${entry.index}, ${input.value}${entries.length ? '' : ''}`,
      );
      input.addEventListener('change', () => {
        const text = input.value;
        const read = (at: number): number => Number.parseInt(text.slice(at, at + 2), 16);
        this.options.update(() => {
          resource.bytes = toBase64(
            writeSciPalette(bytes, [{ index: entry.index, r: read(1), g: read(3), b: read(5) }]),
          );
        });
        this.render();
      });

      const caption = document.createElement('span');
      caption.className = 'sci-palette-index';
      caption.textContent = String(entry.index);

      swatch.append(input, caption);
      grid.appendChild(swatch);
    }
    this.detail.appendChild(grid);
  }

  private renderVocabulary(sci: SciProject): void {
    const resource = this.resource(sci, 'vocab');
    if (!resource) {
      this.placeholder('Pick a vocabulary.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Vocabulary ${resource.number}`;
    this.detail.appendChild(heading);

    const words = readSciVocabulary(fromBase64(resource.bytes));
    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    summary.textContent =
      `${words.length} words in ${new Set(words.map((word) => word.group)).size} groups. ` +
      `A group is what \u2018said\u2019 matches, so two words in one group are synonyms.`;
    this.detail.appendChild(summary);

    const save = (): void => {
      const { bytes, dropped } = writeSciVocabulary(words);
      this.options.update(() => {
        resource.bytes = toBase64(bytes);
      });
      announce(
        dropped.length === 0
          ? 'vocabulary updated'
          : `vocabulary updated; ${dropped.length} words start with something other than a letter and were dropped`,
      );
    };

    const table = document.createElement('table');
    table.className = 'sci-cel-items';
    const head = table.createTHead().insertRow();
    for (const label of ['Word', 'Class', 'Group']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.appendChild(cell);
    }
    const body = table.createTBody();
    // Bounded, because a vocabulary runs to thousands of words and a table of
    // all of them is a page nobody can use. The count above is the whole truth.
    for (const [index, word] of words.slice(0, 200).entries()) {
      body.appendChild(this.vocabularyRow(word, index, save));
    }
    this.detail.appendChild(table);

    if (words.length > 200) {
      const note = document.createElement('p');
      note.className = 'sci-carried';
      note.textContent = `Showing the first 200 of ${words.length}. All of them are exported.`;
      this.detail.appendChild(note);
    }
  }

  private vocabularyRow(word: SciWord, index: number, save: () => void): HTMLElement {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.scope = 'row';
    const text = document.createElement('input');
    text.type = 'text';
    text.className = 'sci-operand';
    text.value = word.word;
    text.setAttribute('aria-label', `word ${index}`);
    text.addEventListener('change', () => {
      word.word = text.value.trim().toLowerCase();
      save();
    });
    label.appendChild(text);
    row.appendChild(label);

    for (const field of ['wordClass', 'group'] as const) {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sci-cel-field';
      input.value = String(word[field]);
      input.setAttribute(
        'aria-label',
        `word ${index} ${field === 'wordClass' ? 'class' : 'group'}`,
      );
      input.addEventListener('change', () => {
        const value = Number(input.value);
        if (!Number.isFinite(value)) return;
        word[field] = value;
        save();
      });
      cell.appendChild(input);
      row.appendChild(cell);
    }
    return row;
  }

  // ------------------------------------------------------- the class graph --

  /**
   * A room: its Picture, the things it places, and a drag that moves them.
   *
   * Rows 5, 6 and 7 of `docs/editor-parity.md` for this family. ADR 0037
   * records why the room is keyed by its Script resource and assembled as a
   * view over two resources, rather than being a record invented to look like
   * a SCUMM room.
   *
   * The panel says three things before it draws anything, because all three
   * change what the drawing means: that these are the **authored** property
   * words rather than where the game puts the cast once `init` has run, which
   * Picture is underneath, and which things have no art to draw.
   */
  private renderRoom(sci: SciProject): void {
    const room = sciRooms(sci).find((one) => one.script === this.selection.number);
    if (!room) {
      this.placeholder('Pick a room.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Room ${room.script} · ${room.name}`;
    this.detail.appendChild(heading);

    const pieces = sciRoomPieces(sci, room);
    const backdrop = sciRoomBackdrop(sci, room);

    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    const drawn = pieces.filter((piece) => piece.image).length;
    summary.textContent =
      `${room.things.length} thing${room.things.length === 1 ? '' : 's'} placed, ` +
      `${drawn} with art this release holds. ` +
      (room.picture === null
        ? 'This room names no Picture.'
        : typeof backdrop === 'string'
          ? `Picture ${room.picture} could not be drawn.`
          : `Picture ${room.picture} underneath.`);
    this.detail.appendChild(summary);

    // The one thing an author must know before trusting a position on this
    // canvas. It is not a caveat on a failure — it is what the file says, and
    // the difference between the file and the running game is the whole of
    // what an editor can and cannot promise.
    const authored = document.createElement('p');
    authored.className = 'sci-note';
    authored.textContent =
      'These are the positions the resource ships, which is what an edit here writes back. ' +
      'A SCI room commonly places its cast in its own init instead, and where it does, the ' +
      'shipped default is what is drawn rather than where the thing ends up on screen.';
    this.detail.appendChild(authored);

    if (typeof backdrop === 'string') {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent = backdrop;
      this.detail.appendChild(why);
    }
    if (room.note) {
      const note = document.createElement('p');
      note.className = 'sci-note';
      note.textContent = room.note;
      this.detail.appendChild(note);
    }

    // **Two exports, because a room and a thing on it are two pictures.** Row
    // 16 answered Yes for a View's cels, fonts, cursors and both kinds of
    // Picture, and No for the one an author most wants out: the place, drawn,
    // with its cast standing in it. The second button follows the selection, so
    // an actor or an object on the canvas comes out on its own.
    const exports = document.createElement('div');
    exports.className = 'sci-room-exports';
    exports.appendChild(
      this.exportButton(
        `room ${room.script}`,
        `room-${room.script}`,
        () =>
          sciRoomImage(typeof backdrop === 'string' ? null : backdrop, pieces) ??
          'This room has no backdrop and nothing drawn on it, so there is no picture to save.',
      ),
    );

    const selected = pieces[this.roomSelection];
    if (selected) {
      const what = selected.thing.name || `thing ${this.roomSelection}`;
      exports.appendChild(
        this.exportButton(
          what,
          `room-${room.script}-${SciEditor.stem(what)}`,
          () =>
            selected.image ??
            selected.why ??
            `${what} has no art in this release, so there is nothing to save.`,
        ),
      );
    }
    this.detail.appendChild(exports);

    const canvas = new SciRoomCanvas({
      backdrop: typeof backdrop === 'string' ? null : backdrop,
      pieces,
      selected: this.roomSelection,
      onSelect: (index) => {
        this.roomSelection = index;
        this.render();
      },
      onMove: (index, x, y) => this.moveRoomThing(room, pieces[index], x, y),
      polygons: this.polygonsOf(sci, room.script),
    });
    this.roomCanvas?.destroy();
    this.roomCanvas = canvas;
    this.detail.appendChild(canvas.element);

    this.detail.appendChild(this.roomThingTable(room, pieces));
    this.detail.appendChild(this.walkAreaPanel(sci, room.script));
  }

  /**
   * Every walk polygon in this game, derived once and kept for the session.
   *
   * `sciPolygons` walks every instruction of every method — 369,174 of them on
   * King's Quest VII — and a room pane that re-derived on every render would
   * do that on every click.
   */
  private polygonCache: { sci: SciProject; result: SciPolygonsResult } | null = null;

  private polygonsFor(sci: SciProject): SciPolygonsResult {
    if (this.polygonCache?.sci !== sci) {
      this.polygonCache = { sci, result: sciPolygons(sci) };
    }
    return this.polygonCache.result;
  }

  private polygonsOf(sci: SciProject, script: number): SciPolygon[] {
    return this.polygonsFor(sci).polygons.filter((one) => one.script === script);
  }

  /**
   * The room's walk areas, point by point, as numbers an author can change.
   *
   * `docs/editor-parity.md` row 11. A SCI walkable area is not a resource — it
   * is either a colour in the Picture's control buffer, which is not a shape,
   * or a `Polygon` a room's own code builds. The second one is coordinates the
   * script pushes as literals, so what an edit writes is the **instruction's
   * own operand**: the same words row 21 edits, through the same linker, with
   * row 22's guarantee unchanged.
   *
   * The canvas above draws them and does not drag them, and the difference is
   * said rather than left to be discovered: a drag would have to decide which
   * of several polygons a click meant and which point of it, and a number field
   * per coordinate needs neither decision — nor a pointer (row 32).
   */
  private walkAreaPanel(sci: SciProject, script: number): HTMLElement {
    const panel = document.createElement('div');
    const derived = this.polygonsFor(sci);
    const mine = derived.polygons.filter((one) => one.script === script);

    const heading = document.createElement('h3');
    heading.textContent = 'Walk areas';
    panel.appendChild(heading);

    const note = document.createElement('p');
    note.className = 'sci-carried';
    note.textContent = describeSciPolygons(derived, script);
    panel.appendChild(note);

    const scriptResource = sci.scripts.find((one) => one.number === script);

    // **Row 22's guarantee, stated before an edit rather than at Apply.** A
    // coordinate that grows past a byte makes its `pushi` a word wider, which
    // is a method that changed length — the same thing the method panel says
    // this about, said in the place the edit is made.
    const relinking = scriptResource ? describeSciRelinking(scriptResource) : null;
    if (mine.length > 0 && relinking) {
      const refusal = document.createElement('p');
      refusal.className = 'sci-refusal';
      refusal.textContent = `Moving a point may make its push a byte wider, and ${relinking}`;
      panel.appendChild(refusal);
    }
    for (const [index, polygon] of mine.entries()) {
      const held = document.createElement('div');
      held.className = 'sci-section-body';
      const label = document.createElement('p');
      label.className = 'sci-note';
      label.textContent = `${polygon.owner} · ${polygon.typeName}`;
      held.appendChild(label);

      const method = scriptResource?.objects[polygon.objectIndex]?.methods?.[polygon.methodIndex];
      const table = document.createElement('table');
      table.className = 'sci-cel-items';
      const head = table.createTHead().insertRow();
      for (const column of ['Point', 'x', 'y']) {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = column;
        head.appendChild(cell);
      }
      const body = table.createTBody();
      for (const [pointIndex, point] of polygon.points.entries()) {
        const row = body.insertRow();
        const number = document.createElement('th');
        number.scope = 'row';
        number.textContent = String(pointIndex);
        row.appendChild(number);
        for (const axis of ['x', 'y'] as const) {
          const cell = row.insertCell();
          const field = document.createElement('input');
          field.type = 'number';
          field.className = 'sci-cel-field';
          field.value = String(point[axis]);
          field.setAttribute(
            'aria-label',
            `${polygon.owner} polygon ${index} point ${pointIndex} ${axis}`,
          );
          field.addEventListener('change', () => {
            const value = Number(field.value);
            if (!Number.isFinite(value) || !method) return;
            const at = axis === 'x' ? point.xInstruction : point.yInstruction;
            const instruction = method.instructions[at];
            // A point is only editable where its coordinate is a literal push,
            // which is what the derivation refused on. `push0`/`push1`/`push2`
            // carry no operand to write, so they are left rather than turned
            // into a `pushi` that would change the method's length.
            if (!instruction || instruction.operands.length === 0) {
              announce('That coordinate is not a number in the script, so it cannot be moved.');
              return;
            }
            this.options.update(() => {
              instruction.operands[0] = value & 0xffff;
            });
            point[axis] = value;
            this.polygonCache = null;
            this.render();
            announce(`${polygon.owner} point ${pointIndex} ${axis} is ${value}`);
          });
          cell.appendChild(field);
        }
      }
      held.appendChild(table);
      panel.appendChild(held);
    }
    return panel;
  }

  /**
   * The things as a table, which is the half of this surface a drag is not.
   *
   * Every row here edits the same property words the canvas drags, through the
   * same write — a number typed and a thing dragged must not be two paths to
   * one value, or they will disagree about what a word is.
   */
  private roomThingTable(room: SciRoom, pieces: readonly SciRoomPiece[]): HTMLElement {
    const wrapper = document.createElement('section');
    wrapper.className = 'sci-room-things';
    const heading = document.createElement('h3');
    heading.textContent = `Placed (${room.things.length})`;
    wrapper.appendChild(heading);

    if (pieces.length === 0) return wrapper;

    const table = document.createElement('table');
    table.className = 'sci-cel-items';
    const head = table.createTHead().insertRow();
    for (const label of ['Object', 'x', 'y', 'Walk-to x', 'Walk-to y', 'View', 'Art']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.appendChild(cell);
    }

    const body = table.createTBody();
    for (const [index, piece] of pieces.entries()) {
      const row = body.insertRow();
      row.classList.toggle('selected', index === this.roomSelection);

      const name = row.insertCell();
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'sci-room-pick';
      pick.textContent = piece.thing.name;
      pick.addEventListener('click', () => {
        this.roomSelection = index;
        this.render();
      });
      name.appendChild(pick);

      row.appendChild(this.roomCoordinateCell(room, piece, 'x'));
      row.appendChild(this.roomCoordinateCell(room, piece, 'y'));
      row.appendChild(this.roomApproachCell(room, piece, 'x'));
      row.appendChild(this.roomApproachCell(room, piece, 'y'));

      const view = row.insertCell();
      view.textContent = piece.thing.view === null ? '—' : String(piece.thing.view);

      const art = row.insertCell();
      art.textContent = piece.image
        ? `loop ${piece.thing.loop}, cel ${piece.thing.cel}`
        : (piece.why ?? '—');
    }
    wrapper.appendChild(table);
    return wrapper;
  }

  private roomCoordinateCell(room: SciRoom, piece: SciRoomPiece, axis: 'x' | 'y'): HTMLElement {
    const cell = document.createElement('td');
    if (!piece.thing.movable) {
      cell.textContent = String(piece.thing[axis]);
      return cell;
    }
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'sci-cel-field';
    input.value = String(piece.thing[axis]);
    input.setAttribute('aria-label', `${axis} of ${piece.thing.name} in room ${room.script}`);
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (!Number.isInteger(next)) return;
      const x = axis === 'x' ? next : piece.thing.x;
      const y = axis === 'y' ? next : piece.thing.y;
      this.moveRoomThing(room, piece, x, y);
    });
    cell.appendChild(input);
    return cell;
  }

  /**
   * One coordinate of a thing's walk-to point, as a number.
   *
   * `docs/editor-parity.md` row 8, which was a No that said only that a SCI
   * *room's* walkable area is a Polygon. That is true and is a different
   * question: a **thing's** walk-to point is where a script sends the ego
   * before acting on it, and SCI32 keeps it in two property words —
   * `approachX` and `approachY` — in the same place and of the same kind as
   * the `x` and `y` the canvas already drags.
   *
   * An em dash rather than a field where the object declares neither, because
   * "this thing has no walk-to point" and "its walk-to point is 0, 0" are
   * different facts and a zero in a box says the wrong one.
   */
  private roomApproachCell(room: SciRoom, piece: SciRoomPiece, axis: 'x' | 'y'): HTMLElement {
    const cell = document.createElement('td');
    const approach = piece.thing.approach;
    if (!approach || !piece.thing.movable) {
      cell.textContent = '—';
      cell.title = approach
        ? 'read without a home for its property words'
        : 'this object declares no approachX and approachY';
      return cell;
    }
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'sci-cel-field';
    input.value = String(approach[axis]);
    input.setAttribute(
      'aria-label',
      `walk-to ${axis} of ${piece.thing.name} in room ${room.script}`,
    );
    input.addEventListener('change', () => {
      const next = Number(input.value);
      if (!Number.isInteger(next) || next < -32768 || next > 32767) {
        announce(`${next} does not fit in a property word, which is sixteen bits.`);
        this.render();
        return;
      }
      const property = axis === 'x' ? approach.xProperty : approach.yProperty;
      this.options.update((project) => {
        const script = project.sci?.scripts.find((one) => one.number === room.script);
        const object = script?.objects[piece.thing.objectIndex];
        if (!object) return;
        object.variables[property] = next < 0 ? next + 0x10000 : next;
      });
      approach[axis] = next;
      announce(`${piece.thing.name} walk-to ${axis} is ${next}.`);
      this.render();
    });
    cell.appendChild(input);
    return cell;
  }

  /**
   * A thing moved, written to the two property words it came from.
   *
   * A coordinate is one 16-bit word wherever it lives, so a position off the
   * end of what a word can hold is refused on the spot rather than wrapped
   * into a room's far corner. Negative is ordinary — a thing part-way off the
   * left of the screen is how SCI walks somebody on — so the range is the
   * signed one and the word is written two's-complement, which is exactly what
   * the properties table already does.
   */
  private moveRoomThing(room: SciRoom, piece: SciRoomPiece, x: number, y: number): void {
    if (!piece.thing.movable) {
      announce(
        `${piece.thing.name} was read without a home for its property words, so it cannot be moved.`,
      );
      return;
    }
    if (x < -32768 || x > 32767 || y < -32768 || y > 32767) {
      announce(`${x}, ${y} does not fit in a property word, which is sixteen bits.`);
      this.render();
      return;
    }

    const word = (value: number): number => (value < 0 ? value + 0x10000 : value);
    this.options.update((project) => {
      const script = project.sci?.scripts.find((one) => one.number === room.script);
      const object = script?.objects[piece.thing.objectIndex];
      if (!object) return;
      object.variables[piece.thing.xProperty] = word(x);
      object.variables[piece.thing.yProperty] = word(y);
    });
    announce(`${piece.thing.name} moved to ${x}, ${y}.`);
    this.render();
  }

  private renderScript(sci: SciProject): void {
    const script = sci.scripts.find((one) => one.number === this.selection.number);
    if (!script) {
      this.placeholder('Pick a Script resource to see its class graph.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Script ${script.number}`;
    this.detail.appendChild(heading);

    if (script.unrecovered) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent = `Unrecovered: ${script.unrecovered}. It exports byte-identically and cannot be edited.`;
      this.detail.appendChild(why);
      return;
    }

    this.detail.appendChild(this.localsTable(script));

    // The graph, by name. Neither sibling family needed one, and it is what an
    // author navigates a SCI game by.
    const graph = document.createElement('div');
    graph.className = 'sci-class-graph';
    for (const [index, object] of script.objects.entries()) {
      graph.appendChild(this.objectButton(script, object, index, sci));
    }
    this.detail.appendChild(graph);

    const object = script.objects[this.selection.objectIndex];
    if (!object) return;

    this.detail.appendChild(this.objectSummary(object, sci));
    this.detail.appendChild(this.propertyTable(script, object, sci));

    const method = object.methods[this.selection.methodIndex];
    if (method) this.detail.appendChild(this.methodPanel(script, object, method));
  }

  /**
   * The object's own property words, named and editable.
   *
   * This is the other half of a SCI game, and it was a count on a line
   * ("56 properties") until now. A method body says what an object *does*; the
   * properties say what it **is** — the view an actor wears, the room a door
   * leads to, the priority a prop draws at, the x and y it starts at — and
   * those are the numbers an author reaches for first. Broken Sword's compacts
   * have been editable word by word since that surface existed; this is the
   * same capability in SCI's own terms (ADR 0013), and the terms differ in one
   * way worth saying on screen: a word here has a **name**, because the class
   * carries a Selector table for its properties and a compact carries nothing.
   *
   * There is no linker in this path and there does not need to be one. An
   * object's size is a word in its own header, every property is two bytes,
   * and nothing an author can do here moves any of them — which is why this
   * writes back for every Version while a method body that changed length
   * still writes back for none of the heap layouts.
   */
  private propertyTable(
    script: SciProjectScript,
    object: SciProjectObject,
    sci: SciProject,
  ): HTMLElement {
    const wrapper = document.createElement('section');
    wrapper.className = 'sci-properties';
    const heading = document.createElement('h4');
    heading.textContent = `Properties (${object.variables.length})`;
    wrapper.appendChild(heading);

    if (object.variables.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'This object declares none.';
      wrapper.appendChild(none);
      return wrapper;
    }

    // Where the words are is what makes them writable, so a graph that did not
    // record it says so instead of offering fields that go nowhere.
    if (!object.variablesAt) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent =
        'These values were read without recording where in the resource they came from, so ' +
        'they are shown and not edited.';
      wrapper.appendChild(why);
    }

    const table = document.createElement('table');
    table.className = 'sci-property-table';
    const head = document.createElement('tr');
    for (const label of ['#', 'Selector', 'Value']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.appendChild(head);

    for (const [index, value] of object.variables.entries()) {
      table.appendChild(this.propertyRow(script, object, index, value, sci));
    }
    wrapper.appendChild(table);

    const note = document.createElement('p');
    note.className = 'sci-property-note';
    note.textContent =
      object.variablesAt?.resource === 'heap'
        ? 'A word here is written back into this script’s heap resource, which is where ' +
          'SCI1.1 and later keep an object. The code resource is untouched by it.'
        : 'A word here is written back into the Script resource, in place.';
    wrapper.appendChild(note);
    return wrapper;
  }

  private propertyRow(
    script: SciProjectScript,
    object: SciProjectObject,
    index: number,
    value: number,
    sci: SciProject,
  ): HTMLElement {
    const row = document.createElement('tr');

    const number = document.createElement('td');
    number.textContent = String(index);
    row.appendChild(number);

    const name = document.createElement('td');
    name.textContent = this.propertyName(object, index, sci);
    row.appendChild(name);

    const cell = document.createElement('td');
    if (object.variablesAt) {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'sci-cel-field';
      input.value = String(value);
      // The Selector is the name of the thing, and "property 4" is not one.
      input.setAttribute(
        'aria-label',
        `${this.propertyName(object, index, sci)} on ${object.name}, property ${index}`,
      );
      input.addEventListener('change', () => {
        const next = Number(input.value);
        if (!Number.isInteger(next)) return;
        // A property is one 16-bit word wide wherever it lives, and a value
        // that does not fit is a value the file cannot hold. Refused on the
        // field rather than truncated into something the author did not type.
        if (next < -32768 || next > 65535) {
          announce(`${next} does not fit in a property word, which is sixteen bits.`);
          input.value = String(object.variables[index]);
          return;
        }
        this.options.update((project) => {
          const target = project.sci?.scripts.find((one) => one.number === script.number);
          const live = target?.objects.find((one) => one.name === object.name);
          if (live) live.variables[index] = next < 0 ? next + 0x10000 : next;
        });
        announce(`${this.propertyName(object, index, sci)} on ${object.name} set to ${next}.`);
        this.render();
      });
      cell.appendChild(input);
    } else {
      cell.textContent = String(value);
    }
    row.appendChild(cell);
    return row;
  }

  /**
   * What a property is called, deferred to the one place that decides it.
   *
   * This used to hold the rule itself, and the room surface needed the same
   * rule to find `x`, `y` and `picture` by name. Two copies of "which Selector
   * is this word" is how the surfaces come to disagree about what they are
   * editing, so the rule moved to `sciRooms.ts` and this reads it — which also
   * fixed it for SCI0 early, whose Selector IDs are doubled and were being
   * read raw here.
   */
  private propertyName(object: SciProjectObject, index: number, sci: SciProject): string {
    return sciPropertyName(object, index, sci);
  }

  /**
   * The script's local variables, as a table.
   *
   * Script 0's locals are this game's **globals**, which is the row Broken
   * Sword II answers with its `Globals` resource and SCUMM answers No to. A
   * SCI local has no name anywhere in the release — there is no Selector table
   * for them and the source Sierra compiled is not in the box — so they are
   * numbered, which is what the interpreter calls them too: `lag 42` is global
   * 42 in every disassembly on this surface.
   */
  private localsTable(script: SciProjectScript): HTMLElement {
    const wrapper = document.createElement('section');
    wrapper.className = 'sci-locals';
    const heading = document.createElement('h3');
    heading.textContent =
      script.number === 0
        ? `Globals (${script.locals.length})`
        : `Local variables (${script.locals.length})`;
    wrapper.appendChild(heading);

    if (script.locals.length === 0) {
      const none = document.createElement('p');
      none.textContent = 'This script declares none.';
      wrapper.appendChild(none);
      return wrapper;
    }

    if (script.number === 0) {
      const note = document.createElement('p');
      note.className = 'sci-locals-note';
      note.textContent =
        'Script 0’s locals are the game’s globals: every other script reads and writes them ' +
        'with `lag` and `sag`, and their starting values are here.';
      wrapper.appendChild(note);
    }

    const table = document.createElement('table');
    table.className = 'sci-property-table';
    const head = document.createElement('tr');
    for (const label of ['#', 'Value']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.appendChild(head);

    const kind = script.number === 0 ? 'global' : 'local';
    for (const [index, value] of script.locals.entries()) {
      const row = document.createElement('tr');
      const number = document.createElement('td');
      number.textContent = String(index);
      row.appendChild(number);

      const cell = document.createElement('td');
      if (script.localsAt) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'sci-cel-field';
        input.value = String(value);
        input.setAttribute('aria-label', `${kind} ${index} in script ${script.number}`);
        input.addEventListener('change', () => {
          const next = Number(input.value);
          if (!Number.isInteger(next)) return;
          if (next < -32768 || next > 65535) {
            announce(`${next} does not fit in a ${kind}, which is sixteen bits.`);
            input.value = String(script.locals[index]);
            return;
          }
          this.options.update((project) => {
            const target = project.sci?.scripts.find((one) => one.number === script.number);
            if (target) target.locals[index] = next < 0 ? next + 0x10000 : next;
          });
          announce(`${kind} ${index} set to ${next}.`);
          this.render();
        });
        cell.appendChild(input);
      } else {
        cell.textContent = String(value);
      }
      row.appendChild(cell);
      table.appendChild(row);
    }
    wrapper.appendChild(table);
    return wrapper;
  }

  private objectButton(
    script: SciProjectScript,
    object: SciProjectObject,
    index: number,
    sci: SciProject,
  ): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sci-object';
    button.textContent = `${object.isClass ? 'class' : 'instance'} ${object.name}`;
    const selected = this.selection.objectIndex === index;
    button.classList.toggle('selected', selected);
    if (selected) button.setAttribute('aria-current', 'true');
    button.setAttribute(
      'aria-label',
      `${object.isClass ? 'class' : 'instance'} ${object.name} in script ${script.number}, ` +
        `${object.methods.length} methods, superclass ${this.className(sci, object.superClass)}`,
    );
    button.addEventListener('click', () => {
      this.selection = { ...this.selection, objectIndex: index, methodIndex: 0 };
      this.render();
    });
    return button;
  }

  /** A class number as the script that defines it, where one does. */
  private className(sci: SciProject, number: number): string {
    if (number === 0xffff) return 'none';
    const entry = sci.classes.find((one) => one.number === number);
    return entry ? `${number} (script ${entry.script})` : String(number);
  }

  private objectSummary(object: SciProjectObject, sci: SciProject): HTMLElement {
    const wrapper = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = object.name;
    const detail = document.createElement('p');
    detail.textContent =
      `superclass ${this.className(sci, object.superClass)}, ` +
      `${object.variables.length} properties, ${object.methods.length} methods`;
    wrapper.append(heading, detail);

    const methods = document.createElement('div');
    methods.className = 'sci-method-list';
    for (const [index, method] of object.methods.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sci-method';
      button.textContent = method.selector;
      const selected = this.selection.methodIndex === index;
      button.classList.toggle('selected', selected);
      if (selected) button.setAttribute('aria-current', 'true');
      button.setAttribute(
        'aria-label',
        `method ${method.selector} on ${object.name}, ${method.instructions.length} instructions`,
      );
      button.addEventListener('click', () => {
        this.selection = { ...this.selection, methodIndex: index };
        this.render();
      });
      methods.appendChild(button);
    }
    wrapper.appendChild(methods);
    return wrapper;
  }

  /**
   * One method, as source or as instructions.
   *
   * The toggle is not a mode in ADR 0007's sense — both are views of the same
   * stored instruction list, and neither is a second representation. What makes
   * that safe is that `renderSciSource` and `parseSciSource` are inverses over
   * that list, so switching between them cannot lose anything.
   */
  private methodPanel(
    script: SciProjectScript,
    object: SciProjectObject,
    method: SciProjectMethod,
  ): HTMLElement {
    const wrapper = document.createElement('section');
    wrapper.className = 'sci-method-panel';

    const heading = document.createElement('h3');
    heading.textContent = `${object.name}::${method.selector}`;
    wrapper.appendChild(heading);

    if (method.unrecovered) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent = `This method could not be disassembled to its end: ${method.unrecovered}`;
      wrapper.appendChild(why);
      return wrapper;
    }

    // **The round trip, said before the edit rather than at Apply.** Which
    // bodies may change length is a fact about this script's layout, and an
    // author who has retyped a method only to be told at Apply that its
    // resource cannot be relaid has done the work twice.
    const relinking = describeSciRelinking(script);
    const guarantee = document.createElement('p');
    guarantee.className = relinking ? 'sci-note sci-summary-warning' : 'sci-note';
    guarantee.textContent = relinking
      ? `Same length only: ${relinking}`
      : 'This script is relaid out by the linker, so a body may change length.';
    wrapper.appendChild(guarantee);

    const view = renderSciSource(method);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'sci-toggle';
    toggle.textContent = this.selection.asSource ? 'Show instructions' : 'Show source';
    toggle.addEventListener('click', () => {
      this.selection = { ...this.selection, asSource: !this.selection.asSource };
      this.render();
    });
    wrapper.appendChild(toggle);

    // **The degradation is visible, not silent.** An author needs to know which
    // of what they are reading is a reconstruction and which is the bytes.
    const degraded = document.createElement('p');
    degraded.className = 'sci-degraded-count';
    degraded.textContent =
      view.degradedCount === 0
        ? `Control flow reconstructed for all ${method.instructions.length} instructions.`
        : `${view.degradedCount} of ${method.instructions.length} instructions are shown as ` +
          `themselves, because the branch around them does not land on an instruction boundary ` +
          `this list contains. Those lines are marked.`;
    degraded.classList.toggle('sci-summary-warning', view.degradedCount > 0);
    wrapper.appendChild(degraded);

    const editor = document.createElement('textarea');
    editor.className = 'sci-source';
    editor.rows = Math.min(30, Math.max(6, view.lines.length + 1));
    editor.spellcheck = false;
    editor.setAttribute(
      'aria-label',
      `${object.name} ${method.selector}, ${this.selection.asSource ? 'source' : 'instructions'}`,
    );
    editor.value = this.selection.asSource
      ? view.lines
          .map((line) => (line.degraded ? `${line.text}${DEGRADED_MARKER}` : line.text))
          .join('\n')
      : method.instructions
          .map((one) => `${one.name}${one.operands.length ? ` ${one.operands.join(', ')}` : ''}`)
          .join('\n');
    wrapper.appendChild(editor);

    const problems = document.createElement('p');
    problems.className = 'sci-problems';
    problems.setAttribute('role', 'status');
    wrapper.appendChild(problems);

    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'sci-apply';
    apply.textContent = 'Apply to the method';
    apply.addEventListener('click', () => {
      // The marker is a comment the view added, so it is stripped here rather
      // than being something the parser has to know about.
      const text = editor.value
        .split('\n')
        .map((line) => line.replace(DEGRADED_PATTERN, ''))
        .join('\n');
      const parsed = parseSciSource(text, method);
      if (parsed.problems.length > 0) {
        problems.textContent = parsed.problems.join(' ');
        problems.classList.add('sci-summary-warning');
        announce(`The method was not applied: ${parsed.problems[0]}`, 'assertive');
        return;
      }
      this.options.update(() => {
        method.instructions = parsed.instructions;
      });
      // Linked here rather than at export, so an author finds out now that a
      // method grew past what its dispatch table can hold, instead of at the
      // moment they try to write the game out.
      const linked = linkSciScript(script, this.sci?.version);
      problems.classList.toggle('sci-summary-warning', linked.refused !== undefined);
      problems.textContent =
        linked.refused ??
        `Applied. The script relinks to ${linked.bytes.length} bytes, ` +
          `${linked.moved} offset${linked.moved === 1 ? '' : 's'} moved.`;
      announce(problems.textContent);
      this.render();
    });
    wrapper.appendChild(apply);

    return wrapper;
  }

  // -------------------------------------------------------- the two kinds --

  /**
   * A vector Picture: drawing operations, edited as themselves.
   *
   * The operations *are* the resource — a SCI0 or SCI1 Picture is a list of
   * them and nothing else — so this edits the list rather than a rendering of
   * it. That is ADR 0005's model applied to artwork: the same reason a v6
   * script is edited as instructions.
   *
   * **No operation on this panel exists on the cel one and none of the cel
   * panel's exists here.** A cel Picture is an arrangement of bitmaps at
   * positions; this is a path of points and a set of colours. ADR 0018's claim
   * is that those two share no editing operation, and two panels that turned
   * out to want the same controls would be the evidence against it.
   */
  private renderVectorPicture(sci: SciProject): void {
    const picture = sci.vectorPictures.find((one) => one.number === this.selection.number);
    if (!picture) {
      this.placeholder('Pick a vector Picture.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Vector Picture ${picture.number}`;
    this.detail.appendChild(heading);

    // Colour depth is a property of the artwork rather than of the Version: a
    // game shipping `palette` resources draws in 256 colours whatever bucket it
    // landed in, and the extended opcodes are read differently either way.
    const vga = sci.resources.some((resource) => resource.type === 'palette');
    const bytes = fromBase64(picture.bytes);
    const drawn = drawSciPicture(bytes, {
      vga,
      width: SCI_PICTURE_WIDTH,
      height: SCI_PICTURE_HEIGHT,
    });

    const summary = document.createElement('p');
    summary.className = 'sci-summary';
    summary.textContent =
      `${drawn.commands.length} drawing operations into three buffers — visual, priority and ` +
      `control.` +
      (drawn.cels.length > 0
        ? ` Its background is an embedded cel, which is carried through untouched.`
        : '');
    this.detail.appendChild(summary);

    if (drawn.unknown) {
      // A Picture whose walk stopped is not editable: writing back a command
      // list that ends where the reader gave up would throw away everything
      // after it, silently and irreversibly.
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent =
        `This Picture stopped at byte ${drawn.unknown.at} on operation ` +
        `0x${drawn.unknown.op.toString(16)}, so only part of it was read. It is shown read-only ` +
        `and exports byte-identically: writing back a list that ends where the reader gave up ` +
        `would throw away everything after it.`;
      this.detail.appendChild(why);
      return;
    }

    this.detail.appendChild(
      this.exportButton(`vector Picture ${picture.number}`, `picture-${picture.number}`, () =>
        renderSciVectorPicture(drawn, vga),
      ),
    );

    const list = document.createElement('div');
    list.className = 'sci-command-list';
    for (const [index, command] of drawn.commands.entries()) {
      list.appendChild(this.commandRow(picture, drawn.commands, index, command, bytes));
    }
    this.detail.appendChild(list);

    const note = document.createElement('p');
    note.className = 'sci-carried';
    note.textContent =
      'A run of points is re-encoded on save, tightest encoding first — so moving a point out ' +
      'of a three-bit step\u2019s reach widens the run rather than refusing the edit. The ' +
      'palette and any embedded cel are copied through byte for byte.';
    this.detail.appendChild(note);
  }

  /** One drawing operation, with its operands editable in place. */
  private commandRow(
    picture: SciProjectResource,
    commands: SciPictureCommand[],
    index: number,
    command: SciPictureCommand,
    original: Uint8Array,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'sci-command';

    const name = document.createElement('span');
    name.className = 'sci-command-name';
    name.textContent = command.op;
    row.appendChild(name);

    // An extended operation is a payload rather than operands — a palette, a
    // background cel — and there is nothing here for an author to change.
    if (command.op === 'extended') {
      const payload = document.createElement('span');
      payload.className = 'sci-carried';
      payload.textContent = `${command.raw?.length ?? 0} bytes, carried through`;
      row.appendChild(payload);
      return row;
    }

    const editable = document.createElement('input');
    editable.type = 'text';
    editable.className = 'sci-operand';
    editable.value = command.args.join(', ');
    editable.setAttribute('aria-label', `${command.op} at ${index}, operands`);
    editable.addEventListener('change', () => {
      const parsed = editable.value
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value));
      commands[index] = { ...command, args: parsed };
      this.options.update(() => {
        picture.bytes = toBase64(writeSciPicture(commands, original));
      });
      announce(`${command.op} updated`);
      this.render();
    });
    row.appendChild(editable);
    return row;
  }

  /**
   * A cel Picture: an arrangement of items at positions and priorities.
   *
   * Editable, and cheaply: an item's position and priority are fixed-width
   * fields in the resource's own cel header, so moving one rewrites six bytes
   * rather than relaying the Picture out. That is the genuine difference from a
   * Script resource, where changing anything can move everything.
   */
  private renderCelPicture(sci: SciProject): void {
    const picture = sci.celPictures.find((one) => one.number === this.selection.number);
    if (!picture) {
      this.placeholder('Pick a cel Picture.');
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Cel Picture ${picture.number}`;
    this.detail.appendChild(heading);

    const note = document.createElement('p');
    note.textContent =
      `${picture.container === 'sci32' ? "SCI2's container" : "SCI1.1's container"}` +
      (picture.resolution
        ? `, ${picture.resolution.width}x${picture.resolution.height}`
        : ', no declared resolution') +
      (picture.hasVectors
        ? '. It also carries vector operations, which still paint the priority buffer its ' +
          'actors are tested against.'
        : '. It carries no vector operations, so its Plane occludes by ordering alone.');
    this.detail.appendChild(note);

    if (picture.unrecovered) {
      const why = document.createElement('p');
      why.className = 'sci-refusal';
      why.textContent = `Unrecovered: ${picture.unrecovered}`;
      this.detail.appendChild(why);
      return;
    }

    if (picture.items.length <= 1) {
      const single = document.createElement('p');
      single.textContent =
        'Before SCI2 a cel Picture has one item and it is the background, so there is no ' +
        'composition to rearrange.';
      this.detail.appendChild(single);
    }

    // Composed rather than exported item by item, because from SCI2 on the
    // composition *is* the room: the items, in their order, at their positions.
    this.detail.appendChild(
      this.exportButton(`cel Picture ${picture.number}`, `picture-${picture.number}`, () =>
        renderSciCelPicture(picture, sciViewColours(sci)),
      ),
    );

    this.detail.appendChild(this.celItemTable(picture));
    this.detail.appendChild(this.carriedNote());
  }

  private celItemTable(picture: SciProjectCelPicture): HTMLElement {
    const table = document.createElement('table');
    table.className = 'sci-cel-items';
    const head = table.createTHead().insertRow();
    for (const label of ['Item', 'Size', 'x', 'y', 'Priority']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.appendChild(cell);
    }
    const body = table.createTBody();
    for (const [index, item] of picture.items.entries()) {
      const row = body.insertRow();
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = String(index);
      row.appendChild(label);
      row.insertCell().textContent = `${item.width}x${item.height}`;
      for (const field of ['x', 'y', 'priority'] as const) {
        const cell = row.insertCell();
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'sci-cel-field';
        input.value = String(item[field]);
        input.setAttribute('aria-label', `item ${index} ${field}`);
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          this.options.update(() => {
            item[field] = value;
          });
          announce(`item ${index} ${field} is ${value}`);
        });
        cell.appendChild(input);
      }
    }
    return table;
  }

  private carriedNote(): HTMLElement {
    const note = document.createElement('p');
    note.className = 'sci-carried';
    note.textContent =
      'Moving an item rewrites its own header. Every other byte of this Picture — and every ' +
      'video and audio Volume in the game — is carried through untouched rather than rebuilt.';
    return note;
  }

  // -------------------------------------------------------------- Messages --

  /**
   * Messages, keyed by tuple, with their audio and mouth timing beside them.
   *
   * One authored item with three faces under one key, not three parallel tables
   * that happen to share one. A translation that updates the text and leaves
   * the `sync36` behind is a line whose mouth moves to the old words, and no
   * check anywhere would notice.
   */
  private renderMessages(sci: SciProject): void {
    const messages = sci.messages.filter((message) => message.resource === this.selection.number);
    if (messages.length === 0) {
      this.placeholder(
        sci.messages.length === 0
          ? describeTextSurface(false)
          : 'Pick a MESSAGE resource to see its lines.',
      );
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `Messages ${this.selection.number}`;
    this.detail.appendChild(heading);

    for (const message of messages) {
      const row = document.createElement('div');
      row.className = 'sci-message';

      const key = document.createElement('p');
      key.className = 'sci-message-key';
      key.textContent =
        `noun ${message.noun}, verb ${message.verb}, cond ${message.cond}, seq ${message.seq}` +
        (message.language ? ` · ${message.language}` : '') +
        ` · talker ${message.talker}`;
      row.appendChild(key);

      const text = document.createElement('textarea');
      text.className = 'sci-message-text';
      text.rows = 2;
      text.value = message.text;
      text.setAttribute(
        'aria-label',
        `message noun ${message.noun} verb ${message.verb} condition ${message.cond} ` +
          `sequence ${message.seq}`,
      );
      text.addEventListener('change', () => {
        this.options.update(() => {
          message.text = text.value;
        });
        announce('message updated');
      });
      row.appendChild(text);

      // The other two faces, named by the same key rather than by a parallel
      // index — which is the whole reason they are held here.
      const faces = document.createElement('p');
      faces.className = 'sci-message-faces';
      faces.textContent =
        `${
          message.audio === undefined ? 'no recorded speech' : `speech in audio36 ${message.audio}`
        }, ${
          message.sync === undefined ? 'no mouth timing' : `mouth timing in sync36 ${message.sync}`
        }. Both are keyed by this line, so editing the words does not silently leave them ` +
        `pointing at the old ones.`;
      row.appendChild(faces);

      this.detail.appendChild(row);
    }
  }

  private placeholder(text: string): void {
    const paragraph = document.createElement('p');
    paragraph.className = 'sci-placeholder';
    paragraph.textContent = text;
    this.detail.appendChild(paragraph);
  }
}

/** Appended to a line the Source view could not fold into a structure. */
const DEGRADED_MARKER = '    ; instruction';
const DEGRADED_PATTERN = /\s*;\s*instruction\s*$/;

/**
 * Which `vocab` resources are the parser's words.
 *
 * `vocab` is a resource *type*, and most of its numbers are tables the game
 * indexes rather than words a person edits — 996 is the class table, 997 the
 * Selectors, 999 the Kernel names. `vocab.000` is the parser's vocabulary and
 * is the one this editor offers; the rest are carried through, which is what
 * ADR 0018 means by editing a resource as itself rather than as bytes.
 */
const VOCABULARY_NUMBERS = new Set([0]);
