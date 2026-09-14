/**
 * The Lure of the Temptress editing surface.
 *
 * The editor branches on Engine family exactly once, at the mount point in
 * `main.ts`, and this is the sixth arm of that branch. ADR 0026 keeps Lure's
 * surface apart from Sky's on purpose — a shared shape is the first place a Steel
 * Sky object and a Temptress hotspot get confused for one — so this is Lure's
 * own, shaped around what Lure's readers can and cannot check:
 *
 * - **Palettes** are the editable surface. Lure ships them uncompressed in a
 *   six-bit VGA format and they round-trip byte-identically, so a colour edit is
 *   a checked change (ADR 0025's condition, on Lure's format). The list leads
 *   with them, grouped by the container they came from, and the detail is a grid
 *   of swatches with R/G/B inputs.
 * - **The object table** is *not* editable, and the surface says so rather than
 *   pretending. Lure's world state (resource 16398) cannot be typed without the
 *   executable's consuming routine read (ADR 0024); it is shown as read-only
 *   Preserved bytes, with the reason an author can act on.
 *
 * An eight-bit colour narrows to the six bits the DAC holds when written, which
 * the inputs make visible rather than hiding — editing 255 and reading back 255
 * is honest because 0x3f widens to 255, but an odd low bit will settle.
 */

import type {
  LureProject,
  LureProjectPalette,
  LureProjectPicture,
  Project,
} from '../../authoring/project.js';
import { editLurePalette, editLureHotspot } from '../../authoring/lure/project.js';
import { fromBase64 } from '../../authoring/base64.js';
import { decodeLurePicture } from '../../engine/lure/gfx/lureDecode.js';

export interface LureEditorOptions {
  project: () => Project;
  update: (mutate: (project: Project) => void) => void;
}

type Selection =
  | { kind: 'palette'; disk: number; id: number }
  | { kind: 'world' }
  | { kind: 'hotspots' }
  | { kind: 'scripts' }
  | { kind: 'picture'; disk: number; id: number };

export class LureEditor {
  readonly element = document.createElement('div');

  private readonly list = document.createElement('div');
  private readonly detail = document.createElement('div');
  private selection: Selection = { kind: 'world' };
  /** Which palette the picture surface draws with; null is the first available. */
  private paletteKey: { disk: number; id: number } | null = null;

  constructor(private readonly options: LureEditorOptions) {
    this.element.className = 'lure-editor';
    this.list.className = 'lure-resource-list';
    this.detail.className = 'lure-resource-detail';
    this.element.append(this.list, this.detail);
    // Lead with the first palette when there is one — it is the editable surface
    // (ADR 0025). With none, the world-state note is all there is to show.
    const first = this.lure?.palettes[0];
    if (first) this.selection = { kind: 'palette', disk: first.disk, id: first.id };
    this.render();
  }

  private get lure(): LureProject | undefined {
    return this.options.project().lure;
  }

  render(): void {
    this.renderList();
    this.renderDetail();
  }

  // ------------------------------------------------------------- the list --

  private renderList(): void {
    this.list.replaceChildren();
    const lure = this.lure;
    if (!lure) return;

    const summary = document.createElement('p');
    summary.className = 'lure-summary';
    summary.textContent = lure.editable.editable
      ? `${lure.palettes.length} palettes. Unrecovered: ${lure.editable.unrecovered} ` +
        `(over the object table).`
      : `No editable surface: ${lure.editable.reasons.join('; ')}.`;
    summary.classList.toggle('lure-summary-warning', !lure.editable.editable);
    this.list.appendChild(summary);

    const provenance = document.createElement('p');
    provenance.className = 'lure-provenance';
    provenance.textContent = `Release: ${lure.identification}`;
    this.list.appendChild(provenance);

    // The object table first, as a whole read-only surface and a single button —
    // an author should see it exists, and that it is not editable, before the
    // palettes.
    this.list.appendChild(
      this.section('Object table', 1, (body) => {
        body.appendChild(this.button('Read-only (Preserved bytes)', { kind: 'world' }));
      }),
    );

    // The hotspot positions: the typed half of the object table, and editable.
    // Beside the read-only half rather than under the palettes, because the two
    // halves of one table belong together — and the difference between them is
    // the whole of what this family can and cannot say about its own world.
    this.list.appendChild(
      this.section('Hotspot positions', lure.hotspots?.length ?? 0, (body) => {
        body.appendChild(
          this.button(
            lure.hotspots?.length
              ? `${lure.hotspots.length} positions, editable`
              : 'None — this install ships no executable',
            { kind: 'hotspots' },
          ),
        );
      }),
    );

    // Scripts, as a single read-only button that names why there is no listing
    // to open — the same "say so rather than be absent" the object table and
    // Sky's text surface follow. A SCUMM author reaches for the scripts here and
    // must find the reason (ADR 0033), not an empty pane or nothing at all.
    this.list.appendChild(
      this.section('Scripts', 0, (body) => {
        body.appendChild(this.button('No entry point (ADR 0033)', { kind: 'scripts' }));
      }),
    );

    // The palettes, grouped by the container they were read from.
    const byDisk = new Map<number, LureProjectPalette[]>();
    for (const palette of lure.palettes) {
      const bucket = byDisk.get(palette.disk) ?? [];
      bucket.push(palette);
      byDisk.set(palette.disk, bucket);
    }
    for (const disk of [...byDisk.keys()].sort((a, b) => a - b)) {
      const palettes = byDisk.get(disk)!;
      this.list.appendChild(
        this.section(`Disk ${disk}`, palettes.length, (body) => {
          for (const palette of palettes) {
            body.appendChild(
              this.button(`Palette ${palette.id}`, {
                kind: 'palette',
                disk: palette.disk,
                id: palette.id,
              }),
            );
          }
        }),
      );
    }

    // The room pictures — the thing a SCUMM editor opens with, and what the run
    // was pointed at. A read-only viewer (ADR 0025): which room uses which
    // picture is in the room table this project does not read, so this is every
    // game-area picture the containers hold, not a room-by-room map.
    const pictures = lure.pictures ?? [];
    if (pictures.length > 0) {
      this.list.appendChild(
        this.section('Room pictures', pictures.length, (body) => {
          for (const picture of pictures) {
            body.appendChild(
              this.button(`Picture ${picture.id} (disk ${picture.disk})`, {
                kind: 'picture',
                disk: picture.disk,
                id: picture.id,
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
    body.className = 'lure-section-body';
    fill(body);
    section.append(heading, body);
    return section;
  }

  private button(label: string, selection: Selection): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lure-resource';
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
    const lure = this.lure;
    if (!lure) return;

    if (this.selection.kind === 'world') {
      this.renderWorldState(lure);
      return;
    }
    if (this.selection.kind === 'hotspots') {
      this.renderHotspots(lure);
      return;
    }
    if (this.selection.kind === 'scripts') {
      this.renderScripts();
      return;
    }
    if (this.selection.kind === 'picture') {
      this.renderPicture(lure, this.selection.disk, this.selection.id);
      return;
    }
    this.renderPalette(lure, this.selection.disk, this.selection.id);
  }

  // ---------------------------------------------------------- the picture --

  /**
   * A room picture, drawn with a chosen palette. Read-only, and labelled so.
   *
   * ADR 0025 keeps this a viewer: Lure's pictures decode but this project holds
   * no re-encoder, so what is shown is a view over the compressed Preserved
   * bytes and nothing writes back. Which palette a picture shipped with is in
   * the room table this project does not read, so the picker offers every
   * palette the game holds rather than pretending to know the pairing.
   */
  private renderPicture(lure: LureProject, disk: number, id: number): void {
    const picture = (lure.pictures ?? []).find((each) => each.disk === disk && each.id === id);
    if (!picture) return;

    const heading = document.createElement('h2');
    heading.textContent = `Picture ${id} (disk ${disk})`;
    this.detail.appendChild(heading);

    const meta = document.createElement('p');
    meta.className = 'lure-provenance';
    meta.textContent =
      `${picture.width}x${picture.height}, read-only (a viewer over compressed Preserved bytes, ` +
      `decoded on display — ADR 0025). Which room uses it is not read.`;
    this.detail.appendChild(meta);

    const palettes = lure.palettes;
    if (palettes.length === 0) {
      const note = document.createElement('p');
      note.className = 'lure-reach';
      note.textContent = 'No palette was found to draw this with, so it cannot be shown in colour.';
      this.detail.appendChild(note);
      return;
    }

    // The palette picker. Default to the first the game holds; which one a
    // picture actually shipped with is in data this project does not read.
    const chosen =
      palettes.find(
        (palette) => palette.disk === this.paletteKey?.disk && palette.id === this.paletteKey?.id,
      ) ?? palettes[0]!;

    const picker = document.createElement('label');
    picker.className = 'lure-palette-picker';
    picker.textContent = 'Palette: ';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Palette to draw this picture with');
    for (const palette of palettes) {
      const option = document.createElement('option');
      option.value = `${palette.disk}:${palette.id}`;
      option.textContent = `Palette ${palette.id} (disk ${palette.disk})`;
      option.selected = palette.disk === chosen.disk && palette.id === chosen.id;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const [d, i] = select.value.split(':').map(Number);
      this.paletteKey = { disk: d!, id: i! };
      this.renderDetail();
    });
    picker.appendChild(select);
    this.detail.appendChild(picker);

    this.detail.appendChild(this.pictureCanvas(picture, chosen));
  }

  private pictureCanvas(picture: LureProjectPicture, palette: LureProjectPalette): HTMLElement {
    const canvas = document.createElement('canvas');
    canvas.width = picture.width;
    canvas.height = picture.height;
    canvas.className = 'lure-picture-canvas';
    // role="img": there is nothing operable here — the picture is a viewer, so
    // it is named rather than made a control that does nothing.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      `Picture ${picture.id} from disk ${picture.disk}, drawn with palette ${palette.id}`,
    );

    const context = canvas.getContext('2d');
    if (context) {
      const pixels = decodeLurePicture(
        fromBase64(picture.bytesBase64),
        picture.width * picture.height,
      );
      const image = context.createImageData(picture.width, picture.height);
      for (let i = 0; i < pixels.length; i += 1) {
        const colour = palette.colours[pixels[i]!] ?? { r: 0, g: 0, b: 0 };
        image.data[i * 4] = colour.r;
        image.data[i * 4 + 1] = colour.g;
        image.data[i * 4 + 2] = colour.b;
        image.data[i * 4 + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    }

    return canvas;
  }

  /**
   * The hotspot positions, as a table of numbers a person can change.
   *
   * Read from the game's executable, so a move here is a byte in `Lure.exe`
   * rather than in a container — which is exactly the export route ADR 0024
   * names, and exactly why export stays refused until something walks it.
   *
   * The ids and the count are shown and not editable: `writeLureWalkTo` refuses
   * a table that gained, lost or renumbered a record, because the terminator
   * and everything after it in the executable would move.
   */
  private renderHotspots(lure: LureProject): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Hotspot positions';
    this.detail.appendChild(heading);

    const hotspots = lure.hotspots ?? [];
    const note = document.createElement('p');
    note.className = 'lure-reach';
    note.textContent = hotspots.length
      ? `${hotspots.length} records read from the game's executable. Where each hotspot ` +
        `stands — the typed part of the object table. The id and the count are fixed; a move ` +
        `changes a coordinate in place.`
      : 'This install ships no executable, so there are no positions to read. Absent rather ' +
        'than empty.';
    this.detail.appendChild(note);
    if (hotspots.length === 0) return;

    const table = document.createElement('table');
    table.className = 'lure-hotspots';
    const head = document.createElement('tr');
    for (const label of ['Hotspot', 'x', 'y']) {
      const cell = document.createElement('th');
      cell.textContent = label;
      head.appendChild(cell);
    }
    table.appendChild(head);

    for (const hotspot of hotspots) {
      const row = document.createElement('tr');
      const id = document.createElement('th');
      id.scope = 'row';
      id.textContent = String(hotspot.id);
      row.appendChild(id);
      for (const axis of ['x', 'y'] as const) {
        const cell = document.createElement('td');
        const input = document.createElement('input');
        input.type = 'number';
        input.value = String(hotspot[axis]);
        input.setAttribute('aria-label', `Hotspot ${hotspot.id} ${axis}`);
        input.addEventListener('change', () => {
          const value = Number(input.value);
          if (!Number.isFinite(value)) return;
          this.options.update((project) => {
            const current = project.lure;
            if (!current?.hotspots) return project;
            return {
              ...project,
              lure: {
                ...current,
                hotspots: editLureHotspot(current.hotspots, hotspot.id, {
                  x: axis === 'x' ? value : hotspot.x,
                  y: axis === 'y' ? value : hotspot.y,
                }),
              },
            };
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

  /**
   * Why Lure has no script surface, stated rather than hidden.
   *
   * Sky's bytecode is a navigable read-only listing because a Sky script can be
   * disassembled from a known start; Lure's cannot, and the reason is ADR 0033.
   * Lure's script bytecode is addressed by ids (`0x3f0c`/`0x3f0d`) that exist
   * only in ScummVM's generated `lure.dat` and on none of the shipped disks, so
   * this project does not know where a script begins. A disassembler stands,
   * verified against a fixture, but there is nothing to point it at until that
   * directory is *derived* from the shipped bytes — reading the support file is
   * refused by name (ADR 0033), so this pane says so rather than showing a
   * listing that would be somebody else's numbering.
   */
  private renderScripts(): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Scripts';
    const note = document.createElement('p');
    note.className = 'lure-reach';
    note.textContent =
      "No editable surface and no listing, because Lure's script bytecode has no located entry " +
      "point. The ids that address it (0x3f0c/0x3f0d) exist only in a reimplementation's " +
      'generated support file, not on the disks Revolution shipped, so this project cannot say ' +
      'where a script begins (ADR 0033). A disassembler stands, verified against a fixture; it ' +
      'stays unpointed until that directory is derived from the shipped bytes rather than read ' +
      'from the support file. Behaviour is edited through the object table and hotspots instead ' +
      '(ADR 0025).';
    this.detail.append(heading, note);
  }

  private renderWorldState(lure: LureProject): void {
    const heading = document.createElement('h2');
    heading.textContent = 'Object table';
    const meta = document.createElement('p');
    meta.textContent =
      `Resource ${lure.worldState.resource}, ${lure.worldState.length} bytes, ` +
      `${lure.worldState.typed ? 'typed' : 'not typed'}.`;
    const note = document.createElement('p');
    note.className = 'lure-reach';
    note.textContent = lure.worldState.note;
    this.detail.append(heading, meta, note);
  }

  private renderPalette(lure: LureProject, disk: number, id: number): void {
    const palette = lure.palettes.find((each) => each.disk === disk && each.id === id);
    if (!palette) return;

    const heading = document.createElement('h2');
    heading.textContent = `Palette ${id} (disk ${disk})`;
    this.detail.appendChild(heading);

    const meta = document.createElement('p');
    meta.textContent =
      `${palette.colours.length} colours, six-bit VGA. Editing a colour narrows eight bits back ` +
      `to six — the low two the DAC never carried are lost.`;
    this.detail.appendChild(meta);

    const grid = document.createElement('div');
    grid.className = 'lure-swatch-grid';
    palette.colours.forEach((colour, index) => {
      grid.appendChild(this.swatch(disk, id, index, colour));
    });
    this.detail.appendChild(grid);
  }

  private swatch(
    disk: number,
    id: number,
    index: number,
    colour: { r: number; g: number; b: number },
  ): HTMLElement {
    const cell = document.createElement('div');
    cell.className = 'lure-swatch';

    const chip = document.createElement('div');
    chip.className = 'lure-swatch-chip';
    chip.style.backgroundColor = `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
    chip.setAttribute('aria-label', `colour ${index}: ${colour.r}, ${colour.g}, ${colour.b}`);
    cell.appendChild(chip);

    const channels: Array<'r' | 'g' | 'b'> = ['r', 'g', 'b'];
    for (const channel of channels) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '255';
      input.value = String(colour[channel]);
      input.setAttribute('aria-label', `${channel.toUpperCase()} of colour ${index}`);
      input.addEventListener('change', () => {
        const next = { ...colour, [channel]: clamp(Number(input.value)) };
        this.editColour(disk, id, index, next);
      });
      cell.appendChild(input);
    }
    return cell;
  }

  private editColour(
    disk: number,
    id: number,
    index: number,
    colour: { r: number; g: number; b: number },
  ): void {
    this.options.update((project) => {
      const palettes = project.lure?.palettes;
      const at = palettes?.findIndex((each) => each.disk === disk && each.id === id) ?? -1;
      if (palettes && at >= 0) palettes[at] = editLurePalette(palettes[at]!, index, colour);
    });
    this.render();
  }
}

/** Keeps a channel in the byte range, so a typo cannot write an invalid colour. */
function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}
