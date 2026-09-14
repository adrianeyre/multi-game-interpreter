/**
 * The Audio sidebar section.
 *
 * Lifted out of `main.ts` whole, because a second Engine family wants exactly
 * the same one. A project's `audio` array is family-neutral — it is a list of
 * sound files an author brought in, not a SCUMM resource — so the surface over
 * it should not be either, and a second copy of it would be a second set of
 * decisions about naming, removal and what a silent track says about itself.
 *
 * What was `state` is now four callbacks. That is the whole of the change: the
 * accessibility notes, the wording and the shapes below are the originals.
 */

import { AudioLibrary, describeTrack } from './AudioLibrary.js';
import { describeFormat, isPlayableFormat, whyUnplayable } from '../authoring/audio.js';
import { missingBytesReason, readTrackBytes } from './audioBytes.js';
import { audioFileName, audioMimeType } from './audioSave.js';
import { downloadBlob } from './storage.js';
import { ask, confirm as showConfirm } from './dialog.js';
import { announce } from '../ui/a11y.js';
import type { ProjectAudio } from '../authoring/audio.js';

export interface AudioSectionOptions {
  /** The tracks to show, read afresh on every render. */
  tracks: () => readonly ProjectAudio[];
  add: (name: string, bytes: Uint8Array) => Promise<ProjectAudio>;
  remove: (id: number) => void;
  rename: (id: number, name: string) => void;
  /**
   * Puts new bytes behind an existing track, keeping its id.
   *
   * Optional, and the rows say which it is: a surface that cannot write a
   * replacement back into a game has no business offering the button, and a
   * button that imports a file into a void is worse than no button. Where it
   * is given, replacing keeps the track's `resource` — which recording of the
   * game's this one stands in for — so an export knows where to put it, and
   * `readTrackBytes` prefers the new bytes over the original.
   */
  replace?: (id: number, filename: string, bytes: Uint8Array) => Promise<ProjectAudio | null>;
  /**
   * Something to put above the rows, for a surface that needs a control there.
   *
   * Both Broken Swords do: their recordings are read out of a folder the
   * author re-supplies for the session (ADR 0034), and the button that opens
   * it belongs where the rows it lights up are rather than in another pane.
   */
  header?: (body: HTMLElement) => void;
}

/**
 * The section, and the library behind it.
 *
 * One per surface rather than one per render: the library holds decoded audio
 * and which track is playing, and rebuilding it every render would stop the
 * sound.
 */
export class AudioSection {
  readonly library = new AudioLibrary();

  private readonly input = document.createElement('input');

  /**
   * A second file input, for replacing one track rather than adding new ones.
   *
   * Separate from the import one because the two answer different questions —
   * "which files would you like to add" takes many, "what should this row
   * become" takes exactly one — and because a single input would have to be
   * re-pointed between two `change` handlers on every click, which is the kind
   * of shared mutable state that fires the wrong one.
   */
  private readonly replaceInput = document.createElement('input');

  /** Which row the replace dialogue was opened from. */
  private replacing: ProjectAudio | null = null;

  /** What the last import found, so the author learns what their files were. */
  private report: string[] = [];

  /**
   * Which page of a long list is showing, and what it is narrowed to.
   *
   * A project holding an author's own imports has a handful of tracks and
   * neither of these ever appears. A published AGOS game has thousands — the
   * two Simons list 7,073 and 15,603 recordings — and a row per track is tens
   * of thousands of elements, which is a page that stops responding rather
   * than a long list. So a long list is paged, and the filter is how an author
   * reaches a number instead of scrolling to it.
   */
  private page = 0;
  private filter = '';

  /**
   * Whether the last thing that happened was a keystroke in the filter box.
   *
   * Typing changes the list, changing the list re-renders the section, and a
   * re-render replaces the box the author is typing into — so focus has to be
   * put back or the second character goes nowhere (2.4.3). One re-focus per
   * keystroke, consumed when it is used, so pressing Play afterwards does not
   * pull the caret back here.
   */
  private refocusFilter = false;

  /** Why a save did not produce a file, on the row that was pressed. */
  private saveFailures = new Map<number, string>();

  /**
   * Re-render, after an import or a decode has changed the list.
   *
   * The section cannot re-render itself: it draws into a body its caller owns,
   * and that body is replaced wholesale on every sidebar render. Settable
   * rather than a constructor argument because *which* sidebar owns the body
   * depends on which family surface is mounted, and that changes when a project
   * is replaced — one shared instance, re-pointed on mount.
   */
  onChanged: () => void = () => undefined;

  /** Opens the section, so an import is not filed into something collapsed. */
  onReveal: () => void = () => undefined;

  constructor(private readonly options: AudioSectionOptions) {
    this.library.subscribe(() => this.onChanged());

    const input = this.input;
    input.type = 'file';
    input.multiple = true;
    input.className = 'visually-hidden';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    // Deliberately wide. Files pulled out of a game are named by whatever tool
    // extracted them, so the extension says nothing useful and refusing
    // unfamiliar ones would refuse exactly the files an author most needs
    // identified.
    input.accept =
      'audio/*,.mp3,.wav,.ogg,.flac,.fla,.aif,.aiff,.m4a,.voc,.mid,.midi,.ims,.nut,.rom,.sou,.snd';
    input.addEventListener('change', () => void this.doImport());

    const replaceInput = this.replaceInput;
    replaceInput.type = 'file';
    replaceInput.className = 'visually-hidden';
    replaceInput.tabIndex = -1;
    replaceInput.setAttribute('aria-hidden', 'true');
    replaceInput.accept = input.accept;
    replaceInput.addEventListener('change', () => void this.doReplace());
  }

  /** How many tracks there are, for the section's count badge. */
  get count(): number {
    return this.options.tracks().length;
  }

  render(body: HTMLElement): void {
    this.options.header?.(body);

    const all = this.options.tracks();
    const matching = this.filter ? all.filter((track) => matches(track, this.filter)) : all;
    const paged = all.length > PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(matching.length / PAGE_SIZE));
    this.page = Math.min(Math.max(0, this.page), pages - 1);
    const tracks = paged
      ? matching.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE)
      : matching;

    if (all.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent =
        'No audio yet. Import a file and a script can play it with the “Play sound” action.';
      body.appendChild(empty);
    }

    if (paged) {
      const field = this.filterField(all.length, matching.length);
      body.appendChild(field);
      if (this.refocusFilter) {
        this.refocusFilter = false;
        const box = field.querySelector('input');
        box?.focus();
        box?.setSelectionRange(box.value.length, box.value.length);
      }
    }

    if (all.length > 0 && matching.length === 0) {
      const none = document.createElement('p');
      none.className = 'muted';
      none.textContent = `Nothing here is called “${this.filter}”. Clear the box to see all ${all.length} again.`;
      body.appendChild(none);
    }

    const list = document.createElement('ul');
    list.className = 'list audio-list';

    for (const track of tracks) {
      const item = document.createElement('li');
      item.className = 'audio-item';

      const playable = isPlayableFormat(track.format);
      const isPlaying = this.library.playing === track.id;
      const isPreparing = this.library.preparing === track.id;

      const playButton = document.createElement('button');
      playButton.type = 'button';
      playButton.className = 'audio-play';
      const glyph = document.createElement('span');
      // The glyph was the button's whole text content, so its accessible name was
      // "black right-pointing triangle". Hidden here and replaced by a name that
      // says which track and what pressing it does (4.1.2, 2.4.6).
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = isPreparing ? '…' : isPlaying ? '■' : '▶';
      playButton.appendChild(glyph);
      playButton.disabled = !playable || isPreparing;
      const playLabel = playable
        ? isPreparing
          ? `Rendering ${track.name}`
          : isPlaying
            ? `Stop ${track.name}`
            : `Play ${track.name}`
        : `${track.name} cannot be played — ${whyUnplayable(track.format) ?? 'unsupported format'}`;
      playButton.setAttribute('aria-label', playLabel);
      playButton.title = playLabel;
      playButton.addEventListener('click', () => void this.library.play(track));

      const text = document.createElement('span');
      text.className = 'audio-text';

      const name = document.createElement('span');
      name.className = 'audio-name';
      // The id leads for an imported track because that is the number a
      // `playSound` action says. A game's own recording carries its number in
      // its name instead — speech 1204, effect 12 of bank 3 — and the id is
      // only this editor's handle for it, so showing it would put a second,
      // meaningless number in front of the meaningful one.
      name.textContent = track.resource ? track.name : `${track.id} — ${track.name}`;
      name.title = track.filename;

      /*
       * Renaming, as a button rather than only as a double-click.
       *
       * A double-click has no keyboard equivalent at all — there is no key that
       * means "double-click" — so renaming a track was pointer-only (2.1.1). The
       * double-click stays because it is the quick way; the button is the one
       * that always works.
       */
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'audio-rename';
      const renameGlyph = document.createElement('span');
      renameGlyph.setAttribute('aria-hidden', 'true');
      renameGlyph.textContent = '✎';
      rename.appendChild(renameGlyph);
      rename.setAttribute('aria-label', `Rename ${track.name}`);
      rename.title = `Rename ${track.name}`;
      const doRename = async (): Promise<void> => {
        const renamed = await ask('What should this track be called?', track.name, {
          title: 'Rename track',
          label: 'Track name',
          acceptLabel: 'Rename',
        });
        if (renamed !== null) this.options.rename(track.id, renamed);
      };
      rename.addEventListener('click', () => void doRename());
      name.addEventListener('dblclick', () => void doRename());

      const meta = document.createElement('span');
      meta.className = 'audio-meta';
      // Synthesised music takes a moment to render, and saying so beats a button
      // that appears to have been ignored.
      // The duration is the one fact that separates "this played and you heard
      // it" from "this played and something else is wrong".
      const duration = this.library.durationOf(track.id);
      meta.textContent = isPreparing
        ? 'Rendering…'
        : duration === null
          ? describeTrack(track)
          : `${describeTrack(track)} · ${formatDuration(duration)}`;

      text.append(name, meta);

      // Why this track is silent, said on the track itself. A reason shown
      // anywhere else leaves the author matching an explanation to a row.
      const reason =
        this.saveFailures.get(track.id) ??
        this.library.failureFor(track.id) ??
        whyUnplayable(track.format);
      if (reason) {
        item.classList.add('audio-silent');
        const note = document.createElement('span');
        note.className = 'audio-reason';
        note.textContent = reason;
        text.appendChild(note);
      }

      /*
       * Saving, which is the whole of what was missing.
       *
       * On every row rather than only on a game's own recordings: an author
       * who imported a file into a project last month and no longer has it on
       * disk is in exactly the same position as one looking at a recording
       * that is still inside a talkie. Both have a track in front of them and
       * no way to get a file out of it.
       */
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'audio-save';
      const saveGlyph = document.createElement('span');
      saveGlyph.setAttribute('aria-hidden', 'true');
      saveGlyph.textContent = '⬇';
      save.appendChild(saveGlyph);
      const saveName = audioFileName(track);
      save.setAttribute('aria-label', `Save ${track.name} as ${saveName}`);
      save.title = `Save as ${saveName}`;
      save.addEventListener('click', () => void this.doSave(track));

      /*
       * Replacing, which is what makes a listing an editing surface.
       *
       * Only where the surface can do something with the result. A project
       * whose audio is the author's own imports has no notion of "the
       * recording this stands in for", so there is nothing to replace — the
       * remove-and-import pair already covers it, and an extra button that did
       * the same thing in one step would be a third way to do it.
       */
      const replace = this.options.replace ? document.createElement('button') : null;
      if (replace) {
        replace.type = 'button';
        replace.className = 'audio-replace';
        const replaceGlyph = document.createElement('span');
        replaceGlyph.setAttribute('aria-hidden', 'true');
        replaceGlyph.textContent = '⇄';
        replace.appendChild(replaceGlyph);
        const replaceLabel = `Replace the audio of ${track.name} with a file`;
        replace.setAttribute('aria-label', replaceLabel);
        replace.title = replaceLabel;
        replace.addEventListener('click', () => {
          this.replacing = track;
          this.replaceInput.click();
        });
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'audio-remove';
      const removeGlyph = document.createElement('span');
      removeGlyph.setAttribute('aria-hidden', 'true');
      removeGlyph.textContent = '✕';
      remove.appendChild(removeGlyph);
      // Deleting audio is not undoable — the undo stack deliberately does not
      // carry megabytes of it — so this is the one place that asks first.
      remove.setAttribute('aria-label', `Remove ${track.name} — cannot be undone`);
      remove.title = 'Remove this track (cannot be undone)';
      remove.addEventListener('click', () => {
        void (async () => {
          const sure = await showConfirm(`Remove “${track.name}”? This cannot be undone.`, {
            title: 'Remove track',
            acceptLabel: 'Remove',
            // Not undoable, so it does not open with Remove under the cursor.
            defaultButton: 'cancel',
          });
          if (!sure) return;
          this.library.forget(track);
          this.options.remove(track.id);
        })();
      });

      item.append(playButton, text, save, rename);
      if (replace) item.appendChild(replace);
      item.appendChild(remove);
      list.appendChild(item);
    }

    body.appendChild(list);
    if (paged) body.appendChild(this.pager(matching.length, pages));
    body.appendChild(importButton(() => this.input.click()));
    body.appendChild(this.input);
    body.appendChild(this.replaceInput);

    for (const line of this.report) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = line;
      body.appendChild(note);
    }
  }

  /**
   * Hands one track over as a file.
   *
   * Through `readTrackBytes`, so it makes no difference whether the bytes are
   * in the project, in the editor's audio store, or still inside the game —
   * and through `downloadBlob`, which is the only way a browser page can write
   * a file at all. A track whose bytes cannot be reached says so on its own
   * row rather than silently doing nothing, which is what a button that reads
   * a folder that has not been opened would otherwise look like.
   */
  private async doSave(track: ProjectAudio): Promise<void> {
    this.saveFailures.delete(track.id);
    const bytes = await readTrackBytes(track);
    if (!bytes || bytes.length === 0) {
      this.saveFailures.set(track.id, missingBytesReason(track));
      this.onChanged();
      announce(`${track.name} could not be saved. ${missingBytesReason(track)}`);
      return;
    }
    const filename = audioFileName(track);
    // Copied into its own buffer because a `Uint8Array` may be a view onto a
    // shared one, which a Blob will not take.
    downloadBlob(
      filename,
      new Uint8Array(bytes).buffer as ArrayBuffer,
      audioMimeType(track.format),
    );
    announce(`Saved ${track.name} as ${filename}.`);
  }

  /**
   * Puts a chosen file behind the row the button was pressed on.
   *
   * The track's decoded audio is forgotten first, because the library caches
   * by track and a replacement that played the old bytes back would look
   * exactly like a replacement that did not happen.
   */
  private async doReplace(): Promise<void> {
    const track = this.replacing;
    const file = this.replaceInput.files?.[0] ?? null;
    this.replaceInput.value = '';
    this.replacing = null;
    const replace = this.options.replace;
    if (!track || !file || !replace) return;

    this.saveFailures.delete(track.id);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const replaced = await replace(track.id, file.name, bytes);
      this.library.forget(track);
      this.report = replaced
        ? [
            `${track.name}: replaced with ${file.name} (${describeFormat(replaced.format)}, ` +
              `${bytes.length} bytes).`,
          ]
        : [`${track.name}: could not be replaced.`];
    } catch (error) {
      this.report = [`${file.name}: could not be read — ${String(error)}`];
    }
    this.onReveal();
    this.onChanged();
    announce(this.report.join('. '));
  }

  /** Narrowing a list of thousands to the one an author is looking for. */
  private filterField(total: number, matching: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'audio-filter';

    const label = document.createElement('label');
    const id = `audio-filter-${filterFields++}`;
    label.htmlFor = id;
    label.textContent = 'Find';

    const input = document.createElement('input');
    input.type = 'search';
    input.id = id;
    input.value = this.filter;
    input.placeholder = 'speech 1204';
    input.addEventListener('input', () => {
      this.filter = input.value.trim();
      this.page = 0;
      this.refocusFilter = true;
      this.onChanged();
    });

    const count = document.createElement('span');
    count.className = 'muted';
    count.textContent =
      this.filter && matching !== total ? `${matching} of ${total}` : `${total} tracks`;

    wrap.append(label, input, count);
    return wrap;
  }

  /** Previous and next, for a list too long to put on the page at once. */
  private pager(matching: number, pages: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'audio-pager';

    const step = (by: number, text: string): HTMLButtonElement => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.disabled = this.page + by < 0 || this.page + by >= pages;
      button.addEventListener('click', () => {
        this.page += by;
        this.onChanged();
      });
      return button;
    };

    const where = document.createElement('span');
    where.className = 'muted';
    const first = matching === 0 ? 0 : this.page * PAGE_SIZE + 1;
    where.textContent = `${first}\u2013${Math.min(matching, (this.page + 1) * PAGE_SIZE)} of ${matching}`;

    wrap.append(step(-1, '\u2039 Previous'), where, step(1, 'Next \u203a'));
    return wrap;
  }

  /**
   * Imports the chosen files.
   *
   * Every file is accepted and identified rather than filtered by extension:
   * telling an author that their `.ims` is sequenced music they cannot play yet
   * is a useful answer, and silently skipping it is not.
   */
  private async doImport(): Promise<void> {
    const files = [...(this.input.files ?? [])];
    this.input.value = '';
    if (files.length === 0) return;

    const report: string[] = [];
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const track = await this.options.add(file.name, bytes);
        const reason = whyUnplayable(track.format);
        report.push(
          reason
            ? `${file.name}: ${describeFormat(track.format)} — ${reason}`
            : `${file.name}: imported as ${describeFormat(track.format)} (sound ${track.id})`,
        );
      } catch (error) {
        report.push(`${file.name}: could not be read — ${String(error)}`);
      }
    }

    this.report = report;
    this.onReveal();
    this.onChanged();
    // 4.1.3: the report appears in a panel without taking focus, so a screen
    // reader would otherwise never learn that the import happened, let alone what
    // it found.
    announce(report.join('. '));
  }
}

/** How many rows go on one page of a long list. */
const PAGE_SIZE = 100;

/** Distinguishes one section's filter field from another's, for two on a page. */
let filterFields = 0;

/**
 * Whether a track answers to what was typed.
 *
 * Over the name and the filename rather than the id, because the number an
 * author has in mind is a game's own — "speech 1204", "bank 3" — and that is
 * in the name. Every word has to match, so "effect 12 bank 3" narrows to one
 * row rather than to every effect numbered 12.
 */
function matches(track: ProjectAudio, query: string): boolean {
  const haystack = `${track.id} ${track.name} ${track.filename}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => haystack.includes(word));
}

/** "3:42", for a decoded track's length. */
function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** The one button in this section that is not attached to a track. */
function importButton(onClick: () => void): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.textContent = '+ Audio…';
  element.title = 'Import sound or music files';
  element.addEventListener('click', onClick);
  return element;
}
