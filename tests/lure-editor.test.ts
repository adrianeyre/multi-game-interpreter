// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LureEditor } from '../src/editor/lure/LureEditor.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { LureEngine } from '../src/engine/lure/LureEngine.js';
import {
  LURE_HEADER_BYTES,
  LURE_OFFSET_UNIT,
  LURE_PALETTE_BYTES,
} from '../src/engine/lure/resource/lureDisk.js';
import {
  LURE_WORLD_STATE_ID,
  LURE_SAVE_SLOT_BYTES,
} from '../src/engine/lure/resource/lureWorldState.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { fromBase64 } from '../src/authoring/base64.js';
import type { Project } from '../src/authoring/project.js';

interface Entry {
  id: number;
  size: number;
  offset: number;
  data?: Uint8Array;
}

function buildDisk(diskNumber: number, entries: Entry[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 6; i += 1) out[i] = 'heywow'.charCodeAt(i);
  out[7] = diskNumber;
  entries.forEach((e, i) => {
    const at = 8 + i * 8;
    view.setUint16(at, e.id, true);
    out[at + 2] = 0xff;
    out[at + 3] = 0;
    view.setUint16(at + 4, e.size, true);
    view.setUint16(at + 6, e.offset / LURE_OFFSET_UNIT, true);
    if (e.data) out.set(e.data, e.offset);
  });
  return out;
}

const PALETTE_ID = 1000;
const PICTURE_ID = 2000;
const LURE_GAME_AREA_BYTES = 320 * 192;

/**
 * A minimal but genuine compressed Lure picture that decodes to a solid fill.
 *
 * Every bit-stream code is "01" — the run-or-end branch of the decoder — so the
 * outer literal writes one byte and a series of runs fill the rest, terminated
 * by a zero count and a zero marker. It is the encoder Lure ships no equivalent
 * of; here it exists only to give the reader a real resource to preserve, so the
 * round-trip the test measures is a round-trip and not a fixture matching itself.
 */
function buildLurePicture(fill: number, length: number): Uint8Array {
  const counts: number[] = [];
  let remaining = length - 1;
  while (remaining > 0) {
    const count = Math.min(255, remaining);
    counts.push(count);
    remaining -= count;
  }
  const literals = [fill & 0xff, ...counts, 0, 0];
  const codeCount = counts.length + 1;
  const bitBytes = new Uint8Array(Math.ceil((codeCount * 2) / 8));
  let bitPos = 0;
  const putBit = (bit: number): void => {
    if (bit) bitBytes[bitPos >> 3] |= 0x80 >> (bitPos & 7);
    bitPos += 1;
  };
  for (let i = 0; i < codeCount; i += 1) {
    putBit(0);
    putBit(1);
  }
  const literalStart = 0x404 + bitBytes.length;
  const out = new Uint8Array(literalStart + literals.length);
  new DataView(out.buffer).setUint32(0x400, literalStart, true);
  out.set(bitBytes, 0x404);
  out.set(Uint8Array.from(literals), literalStart);
  return out;
}

async function lureProject(): Promise<Project> {
  const source = new MemoryDataSource('lure-editor');
  const pal = new Uint8Array(LURE_PALETTE_BYTES);
  for (let i = 0; i < pal.length; i += 1) pal[i] = (i + 3) % 0x40;
  const picture = buildLurePicture(7, LURE_GAME_AREA_BYTES);
  // The picture sits after the palette, on a 32-byte-aligned offset.
  const pictureOffset =
    LURE_HEADER_BYTES +
    LURE_PALETTE_BYTES +
    (LURE_OFFSET_UNIT - (LURE_PALETTE_BYTES % LURE_OFFSET_UNIT));
  source.set(
    'disk1.vga',
    buildDisk(
      1,
      [
        { id: PALETTE_ID, size: LURE_PALETTE_BYTES, offset: LURE_HEADER_BYTES, data: pal },
        { id: PICTURE_ID, size: picture.length, offset: pictureOffset, data: picture },
      ],
      pictureOffset + picture.length,
    ),
  );
  source.set(
    'disk2.vga',
    buildDisk(
      2,
      [{ id: LURE_WORLD_STATE_ID, size: LURE_SAVE_SLOT_BYTES, offset: LURE_HEADER_BYTES }],
      LURE_HEADER_BYTES + LURE_SAVE_SLOT_BYTES,
    ),
  );
  const engine = await LureEngine.create(source);
  const editable = await engine.toEditableGame({ progress: new LoadProgressTracker(() => {}) });
  if (!editable) throw new Error('Lure produced no editable game');
  return editable.project;
}

function editorFor(project: Project) {
  let current = project;
  const editor = new LureEditor({
    project: () => current,
    update: (mutate) => {
      // A copy, the way the editor's own state store works.
      const next = structuredClone(current);
      mutate(next);
      current = next;
    },
  });
  return { editor, project: () => current };
}

describe('the Lure editing surface', () => {
  it('lists both halves of the object table, then the palettes by container', async () => {
    // Two halves, and the order says which is which: the read-only world state,
    // then the typed positions, then the palettes. This fixture ships no
    // executable, so the positions section is present with a count of zero —
    // absent rather than empty is the distinction the pane draws.
    const { editor } = editorFor(await lureProject());
    const headings = [...editor.element.querySelectorAll('h3')].map((each) => each.textContent);
    expect(headings).toEqual([
      'Object table (1)',
      'Hotspot positions (0)',
      'Scripts (0)',
      'Disk 1 (1)',
      'Room pictures (1)',
    ]);
  });

  it('names why there is no script surface rather than showing nothing (ADR 0033)', async () => {
    // A SCUMM author reaches for the scripts here. Lure's have no located entry
    // point — the ids that address them live only in a reimplementation's
    // support file (ADR 0033) — so the pane says so rather than being absent.
    const { editor } = editorFor(await lureProject());
    const scriptsButton = [...editor.element.querySelectorAll('button')].find(
      (each) => each.textContent === 'No entry point (ADR 0033)',
    );
    expect(scriptsButton).toBeDefined();
    scriptsButton!.click();
    expect(editor.element.querySelector('h2')?.textContent).toBe('Scripts');
    expect(editor.element.textContent).toContain('no located entry point');
    expect(editor.element.textContent).toContain('ADR 0033');
  });

  it('shows the Release and the Unrecovered count over the object table', async () => {
    const { editor } = editorFor(await lureProject());
    expect(editor.element.textContent).toContain('Release:');
    expect(editor.element.textContent).toContain('Unrecovered: 1');
  });

  it('shows the object table as read-only Preserved bytes when selected', async () => {
    const { editor } = editorFor(await lureProject());
    const worldButton = [...editor.element.querySelectorAll('button')].find((each) =>
      each.textContent?.includes('Read-only'),
    );
    worldButton?.click();
    expect(editor.element.textContent).toContain('not typed');
    expect(editor.element.textContent).toContain('Preserved bytes');
  });

  it('edits a palette colour and writes the narrowed byte back into the project', async () => {
    const { editor, project } = editorFor(await lureProject());
    // Select the palette, then set colour 0's red channel to full.
    const paletteButton = [...editor.element.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith('Palette'),
    );
    paletteButton?.click();

    const redInput = editor.element.querySelector<HTMLInputElement>('.lure-swatch input');
    expect(redInput).not.toBeNull();
    redInput!.value = '255';
    redInput!.dispatchEvent(new Event('change'));

    // The project's palette bytes now hold the narrowed six-bit value (255 -> 0x3f)
    // in the first byte, and the view reads back as full red.
    const palette = project().lure!.palettes[0];
    expect(fromBase64(palette.bytesBase64)[0]).toBe(0x3f);
    expect(palette.colours[0].r).toBe(255);
  });

  it('carries the room picture as its compressed Preserved bytes', async () => {
    const project = await lureProject();
    const pictures = project.lure!.pictures ?? [];
    expect(pictures).toHaveLength(1);
    // The round trip is a measurement: the compressed bytes the project carries
    // are exactly the resource the container held, and they decode.
    const expected = buildLurePicture(7, LURE_GAME_AREA_BYTES);
    expect([...fromBase64(pictures[0].bytesBase64)]).toEqual([...expected]);
    expect(pictures[0].width * pictures[0].height).toBe(LURE_GAME_AREA_BYTES);
  });

  it('shows a room picture read-only with a palette picker when selected', async () => {
    const { editor } = editorFor(await lureProject());
    const pictureButton = [...editor.element.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith('Picture'),
    );
    expect(pictureButton).toBeDefined();
    pictureButton!.click();

    expect(editor.element.querySelector('h2')?.textContent).toContain('Picture');
    expect(editor.element.textContent).toContain('read-only');
    const canvas = editor.element.querySelector('canvas.lure-picture-canvas');
    expect(canvas?.getAttribute('role')).toBe('img');
    const options = editor.element.querySelectorAll('.lure-palette-picker option');
    expect(options).toHaveLength(1);
  });
});
