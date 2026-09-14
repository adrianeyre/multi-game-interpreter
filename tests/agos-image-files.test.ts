// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgosEditor } from '../src/editor/agos/AgosEditor.js';
import { agosImageFilename, renderAgosImage } from '../src/editor/agos/imageFiles.js';
import { greyPalette } from '../src/editor/agos/AgosImageCanvas.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import type { Project } from '../src/authoring/project.js';
import { readAgosArchive } from '../src/engine/agos/resource/gameArchive.js';
import { buildGamePc, buildGraphicsArchive } from './fixtureAgos.js';

/**
 * Saving a picture out of the AGOS surface.
 *
 * Two separable halves, and they failed for two different reasons, so they are
 * tested apart: the colours, which are arithmetic and need no browser, and the
 * download, which is five lines of DOM the old code got wrong in a way no
 * assertion about pixels would have caught.
 */

/** A palette that is nothing like a ramp of greys, which is the point. */
const COLOURED = [
  [0, 0, 0],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
] as const;

describe('an AGOS image as a file', () => {
  it('paints the zone’s colours rather than a ramp of greys', () => {
    const bitmap = { width: 2, height: 2, pixels: Uint8Array.of(0, 1, 2, 3) };
    const rendered = renderAgosImage(bitmap, COLOURED);

    expect([...rendered.rgba]).toEqual([
      0, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255,
    ]);

    // The failure this replaced, stated as the arithmetic it used: index 1
    // became 17 in all three channels, which is not red by any reading.
    const grey = Math.round((1 * 255) / 15);
    expect(rendered.rgba[4]).not.toBe(grey);
  });

  it('leaves index zero clear when the entry is not opaque', () => {
    const bitmap = { width: 2, height: 1, pixels: Uint8Array.of(0, 1) };
    const rendered = renderAgosImage(bitmap, COLOURED, { transparentZero: true });

    // Alpha zero rather than colour zero: an AGOS sprite is mostly index zero,
    // and writing it out opaque saves a rectangle of whatever sits there.
    expect(rendered.rgba[3]).toBe(0);
    expect(rendered.rgba[7]).toBe(255);
  });

  it('still renders when the zone has no palette to offer', () => {
    // Grey is the honest picture for a zone that is not open — `paletteFor`
    // says so — and it must render rather than refuse.
    const bitmap = { width: 1, height: 1, pixels: Uint8Array.of(15) };
    const rendered = renderAgosImage(bitmap, greyPalette());
    expect(rendered.rgba[3]).toBe(255);
  });

  it('names the file after the game, the zone and the image', () => {
    expect(agosImageFilename('Simon the Sorcerer', 2, 1)).toBe(
      'simon-the-sorcerer-zone2-image1.png',
    );
    // A name with nothing usable in it still has to produce a filename.
    expect(agosImageFilename('***', 0, 0)).toBe('game-zone0-image0.png');
  });
});

/** The zone from the editor fixture, holding one four-by-two image. */
function zoneWithOneImage(): Uint8Array {
  const bytes = new Uint8Array(64);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 32, false);
  bytes[12] = 0;
  bytes[13] = 2;
  view.setUint16(14, 4, false);
  bytes.set([0x12, 0x34, 0x56, 0x78], 32);
  return bytes;
}

async function agosProject(): Promise<Project> {
  const source = new MemoryDataSource('simon-export');
  source.set('GAMEPC', buildGamePc({ withSpeech: true }));
  source.set('SIMON.GME', buildGraphicsArchive());
  // Without a speech file the release reads as floppy, and the fixture's
  // bytecode is the talkie encoding — two extra operands the floppy table has
  // no room for.
  source.set('SIMON.VOC', Uint8Array.of(0));
  const engine = await loadAdventureEngine(source);
  const editable = await engine.toEditableGame({ progress: undefined as never });
  if (!editable) throw new Error('AGOS produced no editable game');
  return {
    ...editable.project,
    name: 'Simon',
    agos: {
      ...editable.project.agos!,
      art: {
        zones: [2],
        images: [{ zone: 2, id: 1, width: 4, height: 2, flags: 0 }],
        unreadableZones: [],
      },
    },
  };
}

/**
 * A canvas that records instead of drawing.
 *
 * jsdom has no 2D context and no PNG encoder, so the parts of the save that
 * are the browser's are stubbed and the parts that are ours are asserted: what
 * pixels were handed over, and what the page then did with the blob.
 */
function stubCanvas(): { rgba: () => Uint8ClampedArray | null } {
  let captured: Uint8ClampedArray | null = null;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
    this: HTMLCanvasElement,
  ) {
    return {
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: (image: { data: Uint8ClampedArray }) => {
        captured = image.data;
      },
    } as unknown as CanvasRenderingContext2D;
  } as never);
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback): void {
    callback(new Blob([Uint8Array.of(1)], { type: 'image/png' }));
  };
  return { rgba: () => captured };
}

describe('the AGOS art tab saves what it is showing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('appends the link, clicks it, and does not revoke the URL in the same tick', async () => {
    vi.useFakeTimers();
    stubCanvas();
    const created = vi.fn(() => 'blob:agos');
    const revoked = vi.fn();
    URL.createObjectURL = created as never;
    URL.revokeObjectURL = revoked as never;

    const links: HTMLAnchorElement[] = [];
    const clicked: string[] = [];
    const appended = vi.spyOn(document.body, 'appendChild');
    appended.mockImplementation(function (this: HTMLElement, node: Node) {
      if (node instanceof HTMLAnchorElement) {
        links.push(node);
        node.click = () => clicked.push(node.download);
      }
      return HTMLElement.prototype.appendChild.call(this, node) as never;
    } as never);

    const project = await agosProject();
    const editor = new AgosEditor({
      project: () => project,
      update: () => {},
      readZonePixels: () => zoneWithOneImage(),
    });
    document.body.appendChild(editor.element);
    clickButton(editor, 'Zone 2');
    editor.element.querySelector<HTMLButtonElement>('.agos-art-rows .agos-art-row')?.click();
    clickButton(editor, 'Save image');
    await vi.waitFor(() => expect(clicked.length).toBe(1));

    // The bug, as an assertion: the anchor reached the document and the URL
    // was still alive when it was clicked. Revoking in the same tick is what
    // made every save produce nothing at all.
    expect(links).toHaveLength(1);
    expect(clicked[0]).toBe('simon-zone2-image1.png');
    expect(created).toHaveBeenCalledTimes(1);
    expect(revoked).not.toHaveBeenCalled();

    // And it is cleaned up eventually, rather than leaked.
    vi.advanceTimersByTime(10_000);
    expect(revoked).toHaveBeenCalledTimes(1);
  });

  it('hands the encoder the zone’s colours, not a ramp of greys', async () => {
    const canvas = stubCanvas();
    URL.createObjectURL = (() => 'blob:agos') as never;
    URL.revokeObjectURL = (() => {}) as never;

    const project = await agosProject();
    const editor = new AgosEditor({
      project: () => project,
      update: () => {},
      readZonePixels: () => zoneWithOneImage(),
      readZoneScripts: () => paletteScripts(),
    });
    document.body.appendChild(editor.element);
    clickButton(editor, 'Zone 2');
    editor.element.querySelector<HTMLButtonElement>('.agos-art-rows .agos-art-row')?.click();
    clickButton(editor, 'Save image');
    await vi.waitFor(() => expect(canvas.rgba()).not.toBeNull());

    // The fixture's first pixel is index 1, and the bank below paints index 1
    // scarlet. The old code wrote 17,17,17 there.
    const rgba = canvas.rgba()!;
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([252, 0, 0]);
  });
});

/**
 * A zone script resource whose first palette bank is not grey.
 *
 * Simon's banks start at offset 6 and run up to the header block, whose
 * position is the word at offset 4 — so putting the header at 102 leaves room
 * for exactly one 96-byte bank, which is what `countVgaPaletteBanks` counts.
 * A colour is three six-bit bytes, widened by four.
 */
function paletteScripts(): Uint8Array {
  const bytes = new Uint8Array(256);
  new DataView(bytes.buffer).setUint16(4, 102, false);
  // Bank 0, half 0, entry 1: full red, which reads back as 252.
  bytes[6 + 3] = 63;
  return bytes;
}

/** A button in the surface, by the text it starts with. */
function clickButton(editor: AgosEditor, startsWith: string): void {
  const button = [...editor.element.querySelectorAll('button')].find((each) =>
    each.textContent?.startsWith(startsWith),
  );
  button?.click();
}

describe('the right-hand column offers one save', () => {
  it('says what it will write, at the top of the column', async () => {
    const project = await agosProject();
    const editor = new AgosEditor({
      project: () => project,
      update: () => {},
      readZonePixels: () => zoneWithOneImage(),
    });
    clickButton(editor, 'Zone 2');
    editor.element.querySelector<HTMLButtonElement>('.agos-art-rows .agos-art-row')?.click();

    const bar = editor.element.querySelector('.agos-save-bar')!;
    const button = bar.querySelector('button')!;
    expect(button.disabled).toBe(false);
    // The filename before the click, not after it.
    expect(bar.textContent).toContain('simon-zone2-image1.png');

    // Directly under the folder bar, which is what "where the reporter looked"
    // means — before the selection's own fields rather than three panes away
    // on the art toolbar.
    const panels = [...editor.element.querySelectorAll('.agos-folder-bar, .agos-save-bar')];
    expect(panels.map((each) => each.className)).toEqual(['agos-folder-bar', 'agos-save-bar']);
  });

  it('is disabled with a reason when the selection has no file', async () => {
    const project = await agosProject();
    const editor = new AgosEditor({ project: () => project, update: () => {} });

    const bar = editor.element.querySelector('.agos-save-bar')!;
    const button = bar.querySelector('button')!;
    expect(button.disabled).toBe(true);
    // A sentence rather than a greyed-out button on its own, and readable by a
    // screen reader that lands on the disabled control.
    const why = bar.querySelector(`#${button.getAttribute('aria-describedby')}`);
    expect(why?.textContent).toContain('no artwork of its own');
  });

  it('gives the folder as the reason when that is the reason', async () => {
    // The pixels live beside the game (ADR 0034), so an image with no folder
    // open cannot be saved — and saying "nothing to save" would send an author
    // looking in the wrong place.
    const project = await agosProject();
    const editor = new AgosEditor({ project: () => project, update: () => {} });
    clickButton(editor, 'Zone 2');
    editor.element.querySelector<HTMLButtonElement>('.agos-art-rows .agos-art-row')?.click();

    const bar = editor.element.querySelector('.agos-save-bar')!;
    expect(bar.querySelector('button')!.disabled).toBe(true);
    expect(bar.textContent).toContain('game folder');
  });
});

/**
 * What a room and an item save.
 *
 * Three of this surface's four sections had nothing to hand over, and two of
 * them do have a file: a room's backdrop is a picture the editor already draws,
 * and an item's icon is a real bitmap in `ICON.DAT`. The third answer — that an
 * item without the icon flag has no artwork of its own — is a fact about the
 * game rather than a gap, so it is asserted as words rather than as a silence.
 */
describe('a room and an item as files', () => {
  /** The fixture project, with its one room pointed at the fixture zone. */
  async function projectWithRoom(): Promise<Project> {
    const project = await agosProject();
    return {
      ...project,
      agos: {
        ...project.agos!,
        rooms: {
          rooms: [{ item: 2, subroutine: 42, exits: 0, picture: 1, zone: 0 }],
          unreadableSubroutines: [],
        },
      },
    };
  }

  /** The fixture archive's two halves, which hold one image and its script. */
  function zoneHalves(): { scripts: Uint8Array; pixels: Uint8Array } {
    const archive = readAgosArchive(buildGraphicsArchive());
    return { scripts: archive.read(0)!, pixels: archive.read(1)! };
  }

  it('offers the room’s backdrop, named after the item', async () => {
    const halves = zoneHalves();
    const editor = new AgosEditor({
      project: await projectWithRoom().then((each) => () => each),
      update: () => {},
      readZonePixels: () => halves.pixels,
      readZoneScripts: () => halves.scripts,
    });
    document.body.appendChild(editor.element);
    clickListRow(editor, 'item 2 ·');

    const bar = editor.element.querySelector('.agos-save-bar')!;
    expect(bar.querySelector('button')!.disabled).toBe(false);
    expect(bar.textContent).toContain('simon-room2.png');
  });

  it('gives the room’s own refusal rather than a second wording for it', async () => {
    // No folder open, so the picture under the room and the note under the
    // button have to say the same thing — an author reading one and acting on
    // the other is how a surface starts contradicting itself.
    const editor = new AgosEditor({
      project: await projectWithRoom().then((each) => () => each),
      update: () => {},
    });
    document.body.appendChild(editor.element);
    clickListRow(editor, 'item 2 ·');

    const bar = editor.element.querySelector('.agos-save-bar')!;
    expect(bar.querySelector('button')!.disabled).toBe(true);
    expect(bar.textContent).toContain('ADR 0034');
  });

  it('says an item has no artwork of its own instead of inventing one', async () => {
    // The fixture's item 3 is an object whose flag mask is bit 1 alone, so it
    // carries no icon — the position about half of each retail game's items
    // are in. Exporting icon 0 for it would be a confident picture of
    // something else.
    const project = await agosProject();
    const editor = new AgosEditor({ project: () => project, update: () => {} });
    document.body.appendChild(editor.element);

    const bar = editor.element.querySelector('.agos-save-bar')!;
    expect(bar.querySelector('button')!.disabled).toBe(true);
    expect(bar.textContent).toContain('no artwork of its own');
    // And in the properties too, not only on the disabled control.
    expect(editor.element.textContent).toContain('never drawn in the inventory');
  });

  it('offers the icon when the item has one and the folder is open', async () => {
    const project = await agosProject();
    // Item 2, which is the selection a surface opens on. Bit 4 is `kOFIcon`,
    // and bits 1 and 4 set means two values in order — so the icon number is
    // the second, which is what `itemIconNumber` counts to.
    const items = [...project.agos!.items];
    items[0] = {
      ...items[0]!,
      children: [{ type: 2, header: [0b0001_0010], values: [0x1234, 7] }],
    };
    const withIcon: Project = { ...project, agos: { ...project.agos!, items } };

    const editor = new AgosEditor({
      project: () => withIcon,
      update: () => {},
      // Simon 1's table is one LE16 offset per icon, so entry 7 is at byte 14
      // and points past the table at a stream of zeroes. Enough for the lookup
      // to succeed, which is what this is about — the decoding has its own
      // tests in `agos-item-icons.test.ts`.
      readIconFile: () => {
        const file = new Uint8Array(32);
        new DataView(file.buffer).setUint16(7 * 2, 16, true);
        return file;
      },
    });
    document.body.appendChild(editor.element);

    const bar = editor.element.querySelector('.agos-save-bar')!;
    expect(bar.textContent).toContain('simon-item2-icon7.png');
    // And the properties say which icon it is, beside the noun and adjective.
    expect(editor.element.textContent).toContain('Icon 7 in ICON.DAT');
  });
});

/** Clicks the sidebar row whose note or label contains the given text. */
function clickListRow(editor: AgosEditor, contains: string): void {
  const row = [...editor.element.querySelectorAll<HTMLButtonElement>('button')].find((each) =>
    (each.textContent ?? '').includes(contains),
  );
  row?.click();
}
