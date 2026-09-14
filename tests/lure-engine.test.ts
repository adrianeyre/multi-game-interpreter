import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { LureEngine } from '../src/engine/lure/LureEngine.js';
import {
  LURE_HEADER_BYTES,
  LURE_OFFSET_UNIT,
  LURE_PALETTE_BYTES,
  parseLurePalette,
} from '../src/engine/lure/resource/lureDisk.js';
import {
  LURE_WORLD_STATE_ID,
  LURE_SAVE_SLOT_BYTES,
} from '../src/engine/lure/resource/lureWorldState.js';
import { fromBase64 } from '../src/authoring/base64.js';
import { editLurePaletteColour } from '../src/authoring/lure/project.js';
import type { LureProject } from '../src/authoring/project.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';

interface Entry {
  id: number;
  size: number;
  offset: number;
  /** The resource's own bytes, written at its offset. */
  data?: Uint8Array;
}

/** A container built from the format, the way `lure-disk.test.ts` does. */
function buildDisk(diskNumber: number, entries: Entry[], totalBytes: number): Uint8Array {
  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 6; i += 1) out[i] = 'heywow'.charCodeAt(i);
  out[7] = diskNumber;
  entries.forEach((e, i) => {
    const at = 8 + i * 8;
    view.setUint16(at, e.id, true);
    out[at + 2] = 0xff;
    out[at + 3] = 0; // on this disk
    view.setUint16(at + 4, e.size, true);
    view.setUint16(at + 6, e.offset / LURE_OFFSET_UNIT, true);
    if (e.data) out.set(e.data, e.offset);
  });
  return out;
}

/** A palette resource: 660 bytes, every one within the 6-bit VGA range. */
function palette(seed: number): Uint8Array {
  const bytes = new Uint8Array(LURE_PALETTE_BYTES);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed + i) % 0x40; // 0..0x3f
  return bytes;
}

const PALETTE_ID = 1000;

/**
 * A minimal but valid Lure install: disk 1 holding a palette (the editable
 * surface), and disk 2 holding the world state (resource 16398) at exactly the
 * save-slot length. The world-state bytes carry a marker so a save round-trip has
 * something to check.
 */
function lureSource(): MemoryDataSource {
  const source = new MemoryDataSource('lure-fixture');

  const disk1 = buildDisk(
    1,
    [{ id: PALETTE_ID, size: LURE_PALETTE_BYTES, offset: LURE_HEADER_BYTES, data: palette(3) }],
    LURE_HEADER_BYTES + LURE_PALETTE_BYTES,
  );

  const total = LURE_HEADER_BYTES + LURE_SAVE_SLOT_BYTES;
  const world = new Uint8Array(LURE_SAVE_SLOT_BYTES);
  world[0] = 0xab;
  world[world.length - 1] = 0xcd;
  const disk2 = buildDisk(
    2,
    [
      {
        id: LURE_WORLD_STATE_ID,
        size: LURE_SAVE_SLOT_BYTES,
        offset: LURE_HEADER_BYTES,
        data: world,
      },
    ],
    total,
  );

  source.set('disk1.vga', disk1);
  source.set('disk2.vga', disk2);
  return source;
}

/** The options `toEditableGame` needs, with a throwaway progress tracker. */
function editOptions() {
  return { progress: new LoadProgressTracker(() => {}) };
}

describe('LureEngine (ADR 0026)', () => {
  it('loads the game and reads its initial world state', async () => {
    const engine = await LureEngine.create(lureSource());
    expect(engine.gameId).toBe('lure-demo'); // no disk 3/4 in the fixture
    expect(engine.targetName).toContain('Lure');
    engine.boot();
    // It reaches a loaded, booted-but-scriptless state: frame never advances,
    // which is how the playthrough harness keeps it at `loaded` rather than
    // claiming `booted`.
    engine.step();
    engine.step();
    expect(engine.frame).toBe(0);
    expect(engine.currentRoom).toBe(0);
    expect(engine.roomName()).toBeUndefined();
  });

  it('says honestly that it runs no scripts and does not type the object table', async () => {
    const engine = await LureEngine.create(lureSource());
    engine.boot();
    const status = engine.describeStatus()!;
    expect(status).toMatch(/no script interpreter/);
    expect(status).toMatch(/not typed/);
    const stall = engine.describeStall().join('\n');
    expect(stall).toMatch(/world state: resource 16398/);
    expect(stall).toMatch(/no script interpreter/);
  });

  it('saves and restores its world state, and refuses another game’s save', async () => {
    const engine = await LureEngine.create(lureSource());
    engine.boot();
    const saved = engine.saveState('slot');
    expect(saved.gameId).toBe('lure-demo');
    // Round-trips through the engine's own guard.
    engine.loadState(saved);
    // A save tagged for another game is refused, not half-applied (ADR 0012).
    expect(() => engine.loadState({ ...saved, gameId: 'monkey2' })).toThrow(/refused/);
  });

  it('refuses a folder with no disk 2, by name', async () => {
    const source = new MemoryDataSource('partial');
    source.set(
      'disk1.vga',
      buildDisk(1, [{ id: 1, size: 16, offset: LURE_HEADER_BYTES }], LURE_HEADER_BYTES + 32),
    );
    await expect(LureEngine.create(source)).rejects.toThrow(/no disk 2/);
  });
});

describe('LureEngine editable surface (ADR 0025/0026)', () => {
  it('opens palettes as its editable surface, and does not refuse editing', async () => {
    const engine = await LureEngine.create(lureSource());
    // A palette surface exists and round-trips, so editing is not refused.
    expect(engine.describeEditRefusal()).toBeNull();

    const editable = (await engine.toEditableGame(editOptions()))!;
    expect(editable.project.target.engine).toBe('lure');
    const lure = editable.project.lure as LureProject;
    expect(lure.palettes).toHaveLength(1);
    expect(lure.palettes[0].id).toBe(PALETTE_ID);
    expect(lure.palettes[0].colours).toHaveLength(220);
    expect(lure.editable.editable).toBe(true);
  });

  it('keeps the object table as read-only Preserved bytes, counted as Unrecovered', async () => {
    const engine = await LureEngine.create(lureSource());
    const lure = (await engine.toEditableGame(editOptions()))!.project.lure as LureProject;

    expect(lure.worldState.resource).toBe(LURE_WORLD_STATE_ID);
    expect(lure.worldState.length).toBe(LURE_SAVE_SLOT_BYTES);
    expect(lure.worldState.typed).toBe(false);
    // One over the object table, which the notes explain is not editable yet.
    expect(lure.editable.unrecovered).toBe(1);
    expect(lure.worldState.note).toMatch(/Preserved bytes/);
    // The whole snapshot is carried, so nothing is lost while it is untyped.
    expect(fromBase64(lure.worldState.bytesBase64)).toHaveLength(LURE_SAVE_SLOT_BYTES);
  });

  it('re-emits an untouched palette byte-identically, and narrows an edited colour', async () => {
    const engine = await LureEngine.create(lureSource());
    const lure = (await engine.toEditableGame(editOptions()))!.project.lure as LureProject;
    const original = palette(3);

    // The colours read back are a view; the stored bytes are the source of truth
    // and match the resource exactly (Preserved bytes).
    expect([...fromBase64(lure.palettes[0].bytesBase64)]).toEqual([...original]);

    // Editing colour 0 to white changes exactly its three bytes, narrowing 8-bit
    // to the 6 bits a VGA palette holds; every other byte is untouched.
    const edited = editLurePaletteColour(lure.palettes[0], 0, { r: 255, g: 255, b: 255 });
    expect([...edited.slice(0, 3)]).toEqual([0x3f, 0x3f, 0x3f]);
    expect([...edited.slice(3)]).toEqual([...original.slice(3)]);

    // And the widened view of the edited bytes reads back as full white.
    expect(parseLurePalette(edited)[0]).toEqual({ r: 255, g: 255, b: 255 });
  });

  it('refuses editing when there is no palette surface to offer', async () => {
    // A disk 1 with no palette, so the only surface would be the untyped object
    // table — and editing is refused, by the reason, not a blank.
    const source = new MemoryDataSource('no-palette');
    source.set(
      'disk1.vga',
      buildDisk(1, [{ id: 1, size: 16, offset: LURE_HEADER_BYTES }], LURE_HEADER_BYTES + 32),
    );
    const total = LURE_HEADER_BYTES + LURE_SAVE_SLOT_BYTES;
    source.set(
      'disk2.vga',
      buildDisk(
        2,
        [{ id: LURE_WORLD_STATE_ID, size: LURE_SAVE_SLOT_BYTES, offset: LURE_HEADER_BYTES }],
        total,
      ),
    );

    const engine = await LureEngine.create(source);
    expect(engine.describeEditRefusal()).toMatch(/refused: no palettes/);
  });
});
