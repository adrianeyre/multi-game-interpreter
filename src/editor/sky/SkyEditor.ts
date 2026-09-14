/**
 * The Sky editing surface.
 *
 * The editor branches on Engine family exactly once, at the mount point in
 * `main.ts`, and this is the fifth arm of that branch. A Sky project holds two
 * surfaces and neither is a SCUMM `Action`, an AGI Logic, a SCI class or an AGOS
 * item tree: the **Compact table** — named records with typed, named fields —
 * and **text**, its own surface (ADR 0025).
 *
 * ## What the surface is shaped around
 *
 * ADR 0025 is explicit that the Compact table is "the primary authoring surface
 * and the one the editor leads with", so the list is the records, grouped by the
 * nine lists the format keeps them in, and the detail is a record's fields as an
 * editable grid. A field is a word; an edit writes that word; the word count
 * never changes, because a record that grew would move every record after it and
 * break the ids the game's own scripts hold (ADR 0024).
 *
 * Text is the second surface and, for now, an empty one: Sky keeps its text
 * compressed with the tree in the executable and this project does not read it
 * yet. The surface says so rather than being absent — an author looking for it
 * should find the reason, not nothing.
 */

import type { Project, SkyProject } from '../../authoring/project.js';
import {
  compactWordName,
  disassembleSkyScript,
  formatSkyDisassemblyLine,
} from '../../authoring/sky/disassemble.js';
import { fromBase64 } from '../../authoring/base64.js';
import { compactWords, editCompactWord } from '../../authoring/sky/edits.js';
import {
  decodeSkyGameArea,
  parseSkyPalette,
  skyPixelsToRgb,
  SKY_SPRITE_HEADER_BYTES,
} from '../../engine/sky/gfx/skyGraphic.js';
import { unpackSkyResource } from '../../engine/sky/resource/SkyResources.js';

export interface SkyEditorOptions {
  project: () => Project;
  update: (mutate: (project: Project) => void) => void;
}

type Selection =
  | { kind: 'compact'; id: number }
  | { kind: 'text' }
  | { kind: 'script'; number: number }
  | { kind: 'picture'; id: number }
  | { kind: 'sprite'; id: number };

export class SkyEditor {
  readonly element = document.createElement('div');

  private readonly list = document.createElement('div');
  private readonly detail = document.createElement('div');
  private selection: Selection = { kind: 'text' };
  /** Which palette the picture surface draws with; null is the first available. */
  private paletteId: number | null = null;
  /** Which frame of the selected sprite is shown. */
  private frame = 0;

  constructor(private readonly options: SkyEditorOptions) {
    this.element.className = 'sky-editor';
    this.list.className = 'sky-resource-list';
    this.detail.className = 'sky-resource-detail';
    this.element.append(this.list, this.detail);
    // Start on the first record when there is one, so the surface leads with the
    // Compact table the way ADR 0025 says it should.
    const first = this.sky?.records[0];
    if (first) this.selection = { kind: 'compact', id: first.id };
    this.render();
  }

  private get sky(): SkyProject | undefined {
    return this.options.project().sky;
  }

  render(): void {
    this.renderList();
    this.renderDetail();
  }

  // ------------------------------------------------------- the disassembly --

  /**
   * The bytecode listing: read-only, and labelled as such.
   *
   * ADR 0025 keeps Sky's bytecode at **Disassembly** — "a listing, in the
   * editor, read-only" — until that encoding earns more, and this is that
   * listing. It is a separate pane from the Compact table on purpose: the
   * object table is the editable surface and the bytecode is not, and a UI that
   * put them side by side as though both took edits would be making the claim
   * the ADR refuses.
   *
   * Listed on demand rather than up front. The shipped game is 1,768 scripts
   * and 65,061 instructions; a person reads one.
   */
  private renderDisassembly(scriptNumber: number): HTMLElement {
    const pane = document.createElement('div');
    pane.className = 'sky-disassembly';

    const modules = this.sky?.scripts ?? [];
    const moduleNumber = scriptNumber >> 12;
    const held = modules.find((module) => module.number === moduleNumber);
    if (!held) {
      pane.textContent = `Module ${moduleNumber} is not in this project.`;
      return pane;
    }

    const bytes = fromBase64(held.wordsBase64);
    const words = new Uint16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));

    const heading = document.createElement('p');
    heading.className = 'sky-provenance';
    let listing;
    try {
      listing = disassembleSkyScript(words, scriptNumber);
    } catch (error) {
      pane.textContent = (error as Error).message;
      return pane;
    }

    heading.textContent =
      `Script ${listing.scriptNumber}, module ${listing.module}, from word ${listing.start} — ` +
      `${listing.lines.length} instructions, read-only (Disassembly, ADR 0025)` +
      (listing.stoppedBecause ? ` — the listing stopped: ${listing.stoppedBecause}` : '');
    pane.appendChild(heading);

    const body = document.createElement('pre');
    body.className = 'sky-listing';
    body.textContent = listing.lines.map(formatSkyDisassemblyLine).join('\n');
    pane.appendChild(body);
    return pane;
  }

  // ------------------------------------------------------------- the list --

  private renderList(): void {
    this.list.replaceChildren();
    const sky = this.sky;
    if (!sky) return;

    // The Unrecovered count, and how the Release was established beside it — the
    // count is over the object table (ADR 0025), so it means "records the reader
    // could not type", not "scripts left undone".
    const summary = document.createElement('p');
    summary.className = 'sky-summary';
    summary.textContent = sky.editable.editable
      ? `${sky.records.length} compacts. Unrecovered: ${sky.editable.unrecovered}.`
      : `Read-only: ${sky.editable.reasons.join('; ')}.`;
    summary.classList.toggle('sky-summary-warning', !sky.editable.editable);
    this.list.appendChild(summary);

    const provenance = document.createElement('p');
    provenance.className = 'sky-provenance';
    provenance.textContent = `Release: ${sky.identification}`;
    this.list.appendChild(provenance);

    // Text first, because it is a whole surface and a single button — an author
    // should see it exists before scrolling three thousand records.
    this.list.appendChild(
      this.section('Text', sky.text.languages.length, (body) => {
        body.appendChild(
          this.button(sky.text.read ? `${sky.text.languages.length} language(s)` : 'Not read yet', {
            kind: 'text',
          }),
        );
      }),
    );

    // The pictures — the thing a SCUMM editor opens with, and what the run was
    // pointed at. A read-only viewer (ADR 0025): screens and room backgrounds,
    // in two sections so a room is not hidden among the intro panels. Sprites
    // are not here — they are ~16 MB unpacked and want a side store the report
    // names; see authoring/sky/pictures.ts.
    const pictures = sky.pictures ?? [];
    const screens = pictures.filter((picture) => picture.kind === 'screen');
    const rooms = pictures.filter((picture) => picture.kind === 'room');
    if (screens.length > 0) {
      this.list.appendChild(
        this.section('Screens', screens.length, (body) => {
          for (const picture of screens) {
            body.appendChild(
              this.button(`screen ${picture.id}`, { kind: 'picture', id: picture.id }),
            );
          }
        }),
      );
    }
    if (rooms.length > 0) {
      this.list.appendChild(
        this.section('Rooms', rooms.length, (body) => {
          for (const picture of rooms) {
            body.appendChild(
              this.button(`room ${picture.id}`, { kind: 'picture', id: picture.id }),
            );
          }
        }),
      );
    }

    // The sprites — the player, the actors and the objects. Carried packed
    // (1.58 MB across 971 resources, against 15.50 MB unpacked) and unpacked one
    // at a time when one is opened, which is the only reason a surface this size
    // can live in the project document at all.
    const sprites = sky.sprites ?? [];
    if (sprites.length > 0) {
      this.list.appendChild(
        this.section('Sprites', sprites.length, (body) => {
          for (const sprite of sprites) {
            body.appendChild(
              this.button(`sprite ${sprite.id} (${sprite.frames}f)`, {
                kind: 'sprite',
                id: sprite.id,
              }),
            );
          }
        }),
      );
    }

    /*
     * A project written before the picture surface existed carries none of it,
     * and the editor used to answer that by rendering nothing — which looks
     * exactly like the surface not having been built. It has; the project is
     * older than it.
     *
     * The autosave is what makes this reachable rather than theoretical: a game
     * imported before the surface landed is restored from storage on every
     * later visit, and nothing in that stored project can be re-collected,
     * because the pictures come from game files the autosave does not hold. So
     * the only way out is to import the game again, and this says so — the same
     * "say so rather than be absent" the Scripts pane already does.
     */
    if (pictures.length === 0 && sprites.length === 0) {
      this.list.appendChild(
        this.section('Pictures', 0, (body) => {
          const note = document.createElement('p');
          note.className = 'sky-reach';
          note.textContent =
            'This project holds no screens, rooms or sprites. It was opened before ' +
            'the picture surface existed, and they cannot be added to it after the ' +
            'fact — they are read from the game files, which a saved project does ' +
            'not carry. Import the game again to get them.';
          body.appendChild(note);
        }),
      );
    }

    // The bytecode, as its own section and plainly labelled read-only. Separate
    // from the Compact table because the object table is the editable surface
    // and this is not, and a UI that mixed them would be making the claim ADR
    // 0025 refuses.
    for (const module of sky.scripts ?? []) {
      this.list.appendChild(
        this.section(`Module ${module.number} — listing`, module.scripts, (body) => {
          for (let index = 1; index <= module.scripts; index += 1) {
            const number = (module.number << 12) | index;
            body.appendChild(this.button(`script ${number}`, { kind: 'script', number }));
          }
        }),
      );
    }

    // The Compact table, grouped by the list each record lives in.
    const byList = new Map<number, SkyProject['records']>();
    for (const record of sky.records) {
      const bucket = byList.get(record.list) ?? [];
      bucket.push(record);
      byList.set(record.list, bucket);
    }
    for (const listNumber of [...byList.keys()].sort((a, b) => a - b)) {
      const records = byList.get(listNumber)!;
      this.list.appendChild(
        this.section(`List ${listNumber}`, records.length, (body) => {
          for (const record of records) {
            body.appendChild(
              this.button(record.name || `compact ${record.id.toString(16)}`, {
                kind: 'compact',
                id: record.id,
              }),
            );
          }
        }),
      );
    }
  }

  private section(title: string, count: number, fill: (body: HTMLElement) => void): HTMLElement {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = `${title} (${count})`;
    const body = document.createElement('div');
    body.className = 'sky-section-body';
    fill(body);
    section.append(heading, body);
    return section;
  }

  private button(label: string, selection: Selection): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sky-resource';
    button.textContent = label;
    button.setAttribute(
      'aria-pressed',
      String(JSON.stringify(selection) === JSON.stringify(this.selection)),
    );
    button.addEventListener('click', () => {
      this.selection = selection;
      this.render();
    });
    return button;
  }

  // ----------------------------------------------------------- the detail --

  private renderDetail(): void {
    this.detail.replaceChildren();
    const sky = this.sky;
    if (!sky) return;

    if (this.selection.kind === 'text') {
      this.renderText(sky);
      return;
    }
    if (this.selection.kind === 'script') {
      const heading = document.createElement('h2');
      heading.textContent = `Script ${this.selection.number}`;
      this.detail.append(heading, this.renderDisassembly(this.selection.number));
      return;
    }
    if (this.selection.kind === 'picture') {
      this.renderPicture(sky, this.selection.id);
      return;
    }
    if (this.selection.kind === 'sprite') {
      this.renderSprite(sky, this.selection.id);
      return;
    }
    this.renderCompact(sky, this.selection.id);
  }

  // ---------------------------------------------------------- the picture --

  /**
   * A picture, drawn with a chosen palette. Read-only, and labelled so.
   *
   * ADR 0025 keeps this a viewer: Sky's pictures decode but this project holds
   * no re-encoder, so what is shown is a view over Preserved bytes and nothing
   * writes back. A palette can be picked — which palette a screen shipped with
   * is not recorded with the picture, so the picker offers every one the game
   * holds rather than pretending to know the pairing.
   */
  private renderPicture(sky: SkyProject, id: number): void {
    const picture = (sky.pictures ?? []).find((each) => each.id === id);
    if (!picture) return;

    const heading = document.createElement('h2');
    heading.textContent = `${picture.kind === 'room' ? 'Room' : 'Screen'} ${picture.id}`;
    this.detail.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'sky-provenance';
    meta.textContent =
      `${picture.width}x${picture.height}, read-only (a viewer over Preserved bytes, ADR 0025)` +
      (picture.kind === 'room' ? ' — de-tiled from the game-area grid on display' : '');
    this.detail.appendChild(meta);

    const palettes = sky.palettes ?? [];
    if (palettes.length === 0) {
      const note = document.createElement('p');
      note.className = 'sky-reach';
      note.textContent = 'No palette was found to draw this with, so it cannot be shown in colour.';
      this.detail.appendChild(note);
      return;
    }

    /*
     * The palette picker, defaulting to one the game itself draws this
     * background with.
     *
     * It used to default to "the first palette the game holds", on the view that
     * which one a picture shipped with "is in data this project does not read".
     * That was wrong, and it is why every picture came out in the wrong colours:
     * the list it picked from held only the palettes found by scanning
     * *resources*, and a room's palette is a **Compact**. Screen 0's own
     * room-entry script names Compact 4316, which was not in the list at all.
     *
     * `picture.palettes` is now the palettes the shipped scripts pair with this
     * background, derived by walking every `fnDrawScreen` call (see
     * `deriveSkyPicturePalettes`). The first is the default; the others go in
     * the picker beside it, because a room gets re-lit and 16 backgrounds carry
     * more than one. Where nothing was derived the picker still offers
     * everything, and the note below says the colours are unverified rather than
     * letting a fallback look like a reading.
     */
    const paired = (picture.palettes ?? []).filter((id) =>
      palettes.some((palette) => palette.id === id),
    );
    const preferred = paired.length > 0 ? paired : palettes.map((palette) => palette.id);
    const defaultId = preferred[0]!;
    const chosen =
      palettes.find((palette) => palette.id === this.paletteId && preferred.includes(palette.id)) ??
      palettes.find((palette) => palette.id === defaultId)!;

    const provenance = document.createElement('p');
    provenance.className = 'sky-reach';
    provenance.textContent =
      paired.length > 0
        ? `The game's own scripts draw this with ${paired.length === 1 ? 'palette' : 'palettes'} ` +
          `${paired.join(', ')} — read from the ${paired.length === 1 ? 'call' : 'calls'} that ` +
          `draw it, not chosen here.`
        : 'No script was found drawing this picture, so no palette is established for it. ' +
          'Every palette the game holds is offered, and the colours are a guess until one is.';
    this.detail.appendChild(provenance);

    const picker = document.createElement('label');
    picker.className = 'sky-palette-picker';
    picker.textContent = 'Palette: ';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Palette to draw this picture with');
    // The paired ones first and marked, so the derived answer is the obvious
    // choice rather than one of a hundred and twelve.
    const ordered = [
      ...palettes.filter((palette) => paired.includes(palette.id)),
      ...palettes.filter((palette) => !paired.includes(palette.id)),
    ];
    for (const palette of ordered) {
      const option = document.createElement('option');
      option.value = String(palette.id);
      const where = palette.source === 'compact' ? 'compact' : 'resource';
      option.textContent = paired.includes(palette.id)
        ? `palette ${palette.id} (${where}, this room's)`
        : `palette ${palette.id} (${where})`;
      option.selected = palette.id === chosen.id;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this.paletteId = Number(select.value);
      this.renderDetail();
    });
    picker.appendChild(select);
    this.detail.appendChild(picker);

    this.detail.appendChild(this.pictureCanvas(picture, chosen));
  }

  private pictureCanvas(
    picture: NonNullable<SkyProject['pictures']>[number],
    palette: NonNullable<SkyProject['palettes']>[number],
  ): HTMLElement {
    const canvas = document.createElement('canvas');
    canvas.width = picture.width;
    canvas.height = picture.height;
    canvas.className = 'sky-picture-canvas';
    // role="img": there is nothing operable here — the picture is a viewer, so
    // it is named rather than made a control that does nothing.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      `${picture.kind === 'room' ? 'Room' : 'Screen'} ${picture.id}, drawn with palette ${palette.id}`,
    );

    const context = canvas.getContext('2d');
    if (context) {
      const raw = fromBase64(picture.bytesBase64);
      // A room's bytes are tiles; de-tile them. A screen's are pixels already.
      const pixels = picture.kind === 'room' ? decodeSkyGameArea(raw) : raw;
      const colours = parseSkyPalette(fromBase64(palette.bytesBase64));
      const rgb = skyPixelsToRgb(pixels, colours);
      const image = context.createImageData(picture.width, picture.height);
      for (let i = 0; i < pixels.length; i += 1) {
        image.data[i * 4] = rgb[i * 3];
        image.data[i * 4 + 1] = rgb[i * 3 + 1];
        image.data[i * 4 + 2] = rgb[i * 3 + 2];
        image.data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    }

    return canvas;
  }

  // ----------------------------------------------------------- the sprite --

  /**
   * A sprite frame, drawn with a chosen palette. Read-only, and labelled so.
   *
   * Two things differ from a picture and both are the sprite format's doing.
   *
   * **The bytes arrive packed**, because carrying 971 sprites unpacked would put
   * 15.50 MB in a document that is re-serialised on every edit, where packed
   * they are 1.58 MB. So one is unpacked here, when it is opened, and the
   * unpacked copy is not kept.
   *
   * **Colour 0 is transparent**, which is the whole reason a sprite is a sprite
   * and not a small picture. Drawing it opaque would put a black box round every
   * actor, so index 0 gets alpha 0 and the canvas is checkered behind by the
   * stylesheet — a person needs to see the difference between transparent and
   * black, and those are the same pixel otherwise.
   */
  private renderSprite(sky: SkyProject, id: number): void {
    const sprite = (sky.sprites ?? []).find((each) => each.id === id);
    if (!sprite) return;

    const heading = document.createElement('h2');
    heading.textContent = `Sprite ${sprite.id}`;
    this.detail.appendChild(heading);

    const facts = document.createElement('p');
    facts.className = 'sky-reach';
    facts.textContent =
      `${sprite.width}x${sprite.height}, ${sprite.frames} frame(s), ` +
      `drawn at an offset of (${sprite.offsetX}, ${sprite.offsetY}) from its ` +
      `Compact's coordinates. Read-only: Preserved bytes, with no re-encoder ` +
      `(ADR 0025).`;
    this.detail.appendChild(facts);

    const palettes = sky.palettes ?? [];
    if (palettes.length === 0) {
      const none = document.createElement('p');
      none.className = 'sky-reach';
      none.textContent = 'No palette was found to draw it with.';
      this.detail.appendChild(none);
      return;
    }
    const chosen = palettes.find((palette) => palette.id === this.paletteId) ?? palettes[0];

    // The frame picker. A sprite's frames are its poses — the reason an actor
    // looks like a person walking rather than a person standing — so a viewer
    // that only ever showed frame 0 would hide most of what is there.
    if (sprite.frames > 1) {
      const framePicker = document.createElement('label');
      framePicker.className = 'sky-palette-picker';
      framePicker.textContent = 'Frame ';
      const frames = document.createElement('select');
      for (let frame = 0; frame < sprite.frames; frame += 1) {
        const option = document.createElement('option');
        option.value = String(frame);
        option.textContent = String(frame);
        option.selected = frame === this.frame;
        frames.appendChild(option);
      }
      frames.addEventListener('change', () => {
        this.frame = Number(frames.value);
        this.renderDetail();
      });
      framePicker.appendChild(frames);
      this.detail.appendChild(framePicker);
    }

    const picker = document.createElement('label');
    picker.className = 'sky-palette-picker';
    picker.textContent = 'Palette ';
    const select = document.createElement('select');
    for (const palette of palettes) {
      const option = document.createElement('option');
      option.value = String(palette.id);
      option.textContent = String(palette.id);
      option.selected = palette.id === chosen.id;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this.paletteId = Number(select.value);
      this.renderDetail();
    });
    picker.appendChild(select);
    this.detail.appendChild(picker);

    this.detail.appendChild(this.spriteCanvas(sprite, chosen));
  }

  private spriteCanvas(
    sprite: NonNullable<SkyProject['sprites']>[number],
    palette: NonNullable<SkyProject['palettes']>[number],
  ): HTMLElement {
    const canvas = document.createElement('canvas');
    canvas.width = sprite.width;
    canvas.height = sprite.height;
    canvas.className = 'sky-sprite-canvas';
    canvas.setAttribute('role', 'img');
    const frame = Math.min(this.frame, Math.max(0, sprite.frames - 1));
    canvas.setAttribute(
      'aria-label',
      `Sprite ${sprite.id}, frame ${frame} of ${sprite.frames}, drawn with palette ${palette.id}`,
    );

    const context = canvas.getContext('2d');
    if (context) {
      const carried = fromBase64(sprite.bytesBase64);
      // Unpacked here rather than at collection: this is the one sprite that is
      // being looked at, and the other 970 stay packed.
      const bytes = unpackSkyResource(carried, {
        id: sprite.id,
        excludesHeader: sprite.excludesHeader,
        stored: sprite.stored,
      });
      const at = SKY_SPRITE_HEADER_BYTES + frame * sprite.frameBytes;
      const count = sprite.width * sprite.height;
      const pixels = bytes.subarray(at, at + count);
      const colours = parseSkyPalette(fromBase64(palette.bytesBase64));
      const rgb = skyPixelsToRgb(pixels, colours);
      const image = context.createImageData(sprite.width, sprite.height);
      for (let i = 0; i < count; i += 1) {
        image.data[i * 4] = rgb[i * 3];
        image.data[i * 4 + 1] = rgb[i * 3 + 1];
        image.data[i * 4 + 2] = rgb[i * 3 + 2];
        // Colour 0 is the transparent index, not a black pixel.
        image.data[i * 4 + 3] = pixels[i] === 0 ? 0 : 255;
      }
      context.putImageData(image, 0, 0);
    }

    return canvas;
  }

  private renderText(sky: SkyProject): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Text';
    const note = document.createElement('p');
    note.className = 'sky-reach';
    note.textContent = sky.text.note;
    this.detail.append(heading, note);

    if (sky.text.languages.length > 0) {
      const list = document.createElement('ul');
      for (const language of sky.text.languages) {
        const item = document.createElement('li');
        item.textContent = language;
        list.appendChild(item);
      }
      this.detail.appendChild(list);
    }
  }

  private renderCompact(sky: SkyProject, id: number): void {
    const record = sky.records.find((each) => each.id === id);
    if (!record) return;

    const heading = document.createElement('h2');
    heading.textContent = record.name || `Compact ${id.toString(16)}`;
    this.detail.appendChild(heading);

    const meta = document.createElement('p');
    const words = compactWords(record);
    meta.textContent =
      `${record.type}, id ${id.toString(16)} (list ${record.list}, index ${record.index}), ` +
      `${words.length} words`;
    this.detail.appendChild(meta);

    if (!sky.editable.editable) {
      const warning = document.createElement('p');
      warning.className = 'sky-reach';
      warning.textContent =
        'Read-only: the fields are shown but not editable because the table is not editable ' +
        `(${sky.editable.reasons.join('; ')}).`;
      this.detail.appendChild(warning);
    }

    // The field grid: one labelled input per word the record holds. The count is
    // exactly the record's length, so editing can only change values — a shape
    // change has no input to make it through.
    const grid = document.createElement('div');
    grid.className = 'sky-field-grid';
    words.forEach((value, index) => {
      const label = document.createElement('label');
      label.textContent = compactWordName(record, index);
      const input = document.createElement('input');
      input.type = 'number';
      input.value = String(value);
      input.disabled = !sky.editable.editable;
      input.setAttribute('aria-label', `${label.textContent} of ${record.name}`);
      input.addEventListener('change', () => {
        const next = Number(input.value);
        this.options.update((project) => {
          const records = project.sky?.records;
          const at = records?.findIndex((each) => each.id === id) ?? -1;
          if (records && at >= 0) records[at] = editCompactWord(records[at]!, index, next);
        });
        this.render();
      });
      label.appendChild(input);
      grid.appendChild(label);
    });
    this.detail.appendChild(grid);
  }
}
