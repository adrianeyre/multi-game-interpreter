// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SkyEditor } from '../src/editor/sky/SkyEditor.js';
import {
  collectSkyDrawables,
  collectSkySprites,
  collectSkyCompactPalettes,
  deriveSkyPicturePalettes,
  SKY_LAYER_0_ID_OFFSET,
  type SkyResourceReader,
  type SkySpriteReader,
} from '../src/authoring/sky/pictures.js';
import { SKY_VAR } from '../src/engine/sky/SkyWorld.js';
import { SKY_MCODE, SKY_MCODE_STRIDE } from '../src/engine/sky/script/skyMcodes.js';
import { SKY_OPCODES } from '../src/engine/sky/script/skyOpcodes.js';
import { importSkyProject, toSkyProjectJson } from '../src/authoring/sky/project.js';
import { buildSkyCompactFixture } from './fixtureSkyCompacts.js';
import { fromBase64 } from '../src/authoring/base64.js';
import {
  SKY_GAME_AREA_BYTES,
  SKY_PALETTE_BYTES,
  SKY_SCREEN_BYTES,
  SKY_SPRITE_HEADER_BYTES,
} from '../src/engine/sky/gfx/skyGraphic.js';
import type { Project } from '../src/authoring/project.js';

/** A palette (all in the 6-bit range), a screen and a room, plus a non-picture. */
function drawableReader(): SkyResourceReader {
  const palette = new Uint8Array(SKY_PALETTE_BYTES);
  for (let i = 0; i < palette.length; i += 1) palette[i] = i % 0x40;
  const screen = new Uint8Array(SKY_SCREEN_BYTES);
  for (let i = 0; i < screen.length; i += 1) screen[i] = i % 256;
  const room = new Uint8Array(SKY_GAME_AREA_BYTES);
  for (let i = 0; i < room.length; i += 1) room[i] = (i * 3) % 256;
  const other = new Uint8Array(42);
  const map: Record<number, Uint8Array> = { 10: palette, 20: screen, 30: room, 40: other };
  return { ids: () => [10, 20, 30, 40], read: (id) => map[id] };
}

/**
 * A 4x2 sprite of three frames, with a transparent pixel in each.
 *
 * Stored unpacked and reported unpacked, because a fixture that carried RNC
 * bytes would be testing the decompressor rather than the surface — and the
 * decompressor has its own tests over the real game's 4,764 packed resources.
 */
const SPRITE_WIDTH = 4;
const SPRITE_HEIGHT = 2;
const SPRITE_FRAMES = 3;
const SPRITE_FRAME_BYTES = SPRITE_WIDTH * SPRITE_HEIGHT;

function spriteBytes(): Uint8Array {
  const bytes = new Uint8Array(SKY_SPRITE_HEADER_BYTES + SPRITE_FRAMES * SPRITE_FRAME_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, SPRITE_WIDTH, true);
  view.setUint16(8, SPRITE_HEIGHT, true);
  view.setUint16(10, SPRITE_FRAME_BYTES, true);
  view.setUint16(14, SPRITE_FRAMES, true);
  view.setInt16(16, -7, true);
  view.setInt16(18, 5, true);
  for (let frame = 0; frame < SPRITE_FRAMES; frame += 1) {
    for (let i = 0; i < SPRITE_FRAME_BYTES; i += 1) {
      // Pixel 0 of every frame is the transparent index; the rest identify the frame.
      bytes[SKY_SPRITE_HEADER_BYTES + frame * SPRITE_FRAME_BYTES + i] = i === 0 ? 0 : frame + 1;
    }
  }
  return bytes;
}

function spriteReader(): SkySpriteReader {
  const base = drawableReader();
  const sprite = spriteBytes();
  const read = (id: number): Uint8Array => (id === 50 ? sprite : base.read(id));
  return {
    ids: () => [...base.ids(), 50],
    read,
    rawBytes: read,
    // Stored, so nothing tries to unpack bytes that are already pixels. A
    // fixture carrying RNC bytes would be testing the decompressor, which has
    // its own tests over the real game's 4,764 packed resources.
    entry: () => ({ excludesHeader: false, stored: true }),
  };
}

function skyProject(): Project {
  const drawables = {
    ...collectSkyDrawables(drawableReader()),
    sprites: collectSkySprites(spriteReader()),
  };
  const auth = importSkyProject(
    buildSkyCompactFixture(),
    'cd',
    'dos',
    'the cd release',
    new Map(),
    drawables,
  );
  const sky = toSkyProjectJson(auth);
  return {
    version: 6,
    target: { engine: 'sky', release: 'cd', platform: 'dos' },
    name: 'sky',
    start: { room: 0, x: 0, y: 0 },
    defaultResponse: '',
    screen: { textHeight: 0, verbTop: 0 },
    verbs: [],
    actors: [],
    rooms: [],
    scripts: [],
    audio: [],
    sky,
  };
}

function editorFor(project: Project) {
  let current = project;
  const editor = new SkyEditor({
    project: () => current,
    update: (mutate) => {
      const next = structuredClone(current);
      mutate(next);
      current = next;
    },
  });
  return { editor, project: () => current };
}

describe('collecting Sky drawables (ADR 0025)', () => {
  it('sorts resources into palettes, screens and rooms, leaving the rest out', () => {
    const drawables = collectSkyDrawables(drawableReader());
    expect(drawables.palettes.map((p) => p.id)).toEqual([10]);
    expect(drawables.pictures.map((p) => `${p.kind} ${p.id}`)).toEqual(['screen 20', 'room 30']);
  });

  it('carries the resource bytes unchanged — a viewer over Preserved bytes', () => {
    const reader = drawableReader();
    const drawables = collectSkyDrawables(reader);
    // The round trip is a measurement: the bytes the project carries decode back
    // to exactly the bytes the reader gave, screen and room alike.
    for (const picture of drawables.pictures) {
      expect([...fromBase64(picture.bytesBase64)]).toEqual([...reader.read(picture.id)]);
    }
    expect([...fromBase64(drawables.palettes[0]!.bytesBase64)]).toEqual([...reader.read(10)]);
  });
});

describe('the Sky picture surface', () => {
  it('lists a Screens and a Rooms section', () => {
    const { editor } = editorFor(skyProject());
    const headings = [...editor.element.querySelectorAll('h3')].map((each) => each.textContent);
    expect(headings).toContain('Screens (1)');
    expect(headings).toContain('Rooms (1)');
  });

  it('shows a picture read-only with a palette picker when one is selected', () => {
    const { editor } = editorFor(skyProject());
    const roomButton = [...editor.element.querySelectorAll('button')].find(
      (each) => each.textContent === 'room 30',
    );
    expect(roomButton).toBeDefined();
    roomButton!.click();

    expect(editor.element.querySelector('h2')?.textContent).toBe('Room 30');
    expect(editor.element.textContent).toContain('read-only');
    const canvas = editor.element.querySelector('canvas.sky-picture-canvas');
    expect(canvas?.getAttribute('role')).toBe('img');
    // One option per palette the game holds — the pairing is not recorded, so
    // every palette is offered rather than a guessed one asserted.
    const options = editor.element.querySelectorAll('.sky-palette-picker option');
    expect(options).toHaveLength(1);
  });
});

describe('collecting Sky sprites', () => {
  it('types a sprite from its header and carries the container bytes', () => {
    const sprites = collectSkySprites(spriteReader());

    expect(sprites).toHaveLength(1);
    const [sprite] = sprites;
    expect(sprite.id).toBe(50);
    expect(sprite.width).toBe(SPRITE_WIDTH);
    expect(sprite.height).toBe(SPRITE_HEIGHT);
    expect(sprite.frames).toBe(SPRITE_FRAMES);
    expect(sprite.frameBytes).toBe(SPRITE_FRAME_BYTES);
    // Signed, and negative: a sprite is drawn at an offset from its Compact.
    expect(sprite.offsetX).toBe(-7);
    expect(sprite.offsetY).toBe(5);
    // Preserved bytes: what was carried is what the container held.
    expect(fromBase64(sprite.bytesBase64)).toEqual(spriteBytes());
    // Stored rather than packed, so nothing unpacks it. These are the index's
    // own two flags rather than a boolean guessed from the bytes: Sky packs
    // after the 22-byte prefix, so a marker test at offset 0 says nothing.
    expect(sprite.stored).toBe(true);
    expect(sprite.excludesHeader).toBe(false);
  });

  it('leaves screens, rooms and palettes out of the sprite surface', () => {
    // A 64,000-byte screen is long enough that a header read off its front can
    // describe a plausible sprite, so the classification excludes them by kind
    // rather than trusting the header test. A picture in both surfaces would be
    // the editor showing one resource twice under two names.
    const sprites = collectSkySprites(spriteReader());
    expect(sprites.map((sprite) => sprite.id)).toEqual([50]);

    const drawables = collectSkyDrawables(drawableReader());
    expect(drawables.pictures.map((picture) => picture.id)).toEqual([20, 30]);
  });
});

describe('the Sky sprite surface', () => {
  it('lists the sprites with their frame counts', () => {
    const { editor } = editorFor(skyProject());
    const headings = [...editor.element.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings.some((heading) => heading?.startsWith('Sprites'))).toBe(true);

    const buttons = [...editor.element.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('sprite 50 (3f)');
  });

  it('draws a frame, naming it, and offers a frame picker', () => {
    const { editor } = editorFor(skyProject());
    const button = [...editor.element.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'sprite 50 (3f)',
    );
    button?.click();

    const canvas = editor.element.querySelector('canvas.sky-sprite-canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toContain('frame 0 of 3');
    expect((canvas as HTMLCanvasElement).width).toBe(SPRITE_WIDTH);
    expect((canvas as HTMLCanvasElement).height).toBe(SPRITE_HEIGHT);

    // A sprite's frames are its poses, so a viewer stuck on frame 0 would hide
    // most of what is there.
    const selects = [...editor.element.querySelectorAll('select')];
    const frames = selects.find((select) => select.options.length === SPRITE_FRAMES);
    expect(frames).toBeDefined();
    expect([...(frames?.options ?? [])].map((option) => option.value)).toEqual(['0', '1', '2']);
  });

  it('says why there is nothing to show when a project predates the surface', () => {
    // The autosave makes this reachable rather than theoretical: a game imported
    // before the surface landed is restored from storage on every later visit,
    // and its pictures cannot be re-collected — they come from game files a
    // saved project does not carry. Rendering nothing looks exactly like the
    // surface not having been built.
    const project = skyProject();
    const older: Project = {
      ...project,
      sky: { ...project.sky!, pictures: [], palettes: [], sprites: [] },
    };
    const { editor } = editorFor(older);

    expect(editor.element.textContent).toContain('Import the game again');
  });
});

describe('which palette a picture is drawn with', () => {
  it('agrees with the engine about where LAYER_0_ID lives', () => {
    // 164 and not 41: a `pop_variable` operand is a byte offset, not a variable
    // index. Comparing against the index matched nothing and derived zero
    // pairings — a walk that ran, found nothing, and looked like a format with
    // no pairings rather than a unit error. This test is what keeps the two
    // numbers from drifting apart again.
    expect(SKY_LAYER_0_ID_OFFSET).toBe(SKY_VAR.layer0Id * 4);
  });

  it('pairs a background with the palette the script draws it with', () => {
    // The pattern the engine's own note names: LAYER_0_ID is set, then
    // fnDrawScreen is called with the palette.
    // Opcodes looked up by name rather than written as numbers, so the fixture
    // cannot drift from the table it is encoding — the first attempt at this
    // guessed 3 for push_number and 0 for the exit, and both were wrong.
    const op = (name: string): number => {
      const found = SKY_OPCODES.findIndex((spec) => spec?.name === name);
      if (found < 0) throw new Error(`no opcode named ${name}`);
      return found;
    };
    const words = new Uint16Array(64);
    let at = 0;
    const push = (value: number): void => {
      words[at++] = op('push_number');
      words[at++] = value;
    };
    push(64);
    words[at++] = op('pop_variable');
    words[at++] = SKY_VAR.layer0Id * 4;
    push(4316);
    words[at++] = op('call_mcode');
    words[at++] = 1;
    words[at++] = SKY_MCODE.fnDrawScreen * SKY_MCODE_STRIDE;
    words[at++] = op('script_exit');

    // A one-entry module table: entry 0 is its own length, entry 1 the script.
    const module = new Uint16Array(4 + words.length);
    module[0] = 2;
    module[1] = 4;
    module.set(words, 4);

    const pairs = deriveSkyPicturePalettes(new Map([[0, module]]));
    expect(pairs.get(64)).toEqual([4316]);
  });

  it('offers the Compact palettes, which are the ones a room uses', () => {
    // The bug this fixes: scanning resources finds palettes a room is never
    // drawn with, and a room's palette is a Compact. On the real CD release the
    // split is 83 compact against 29 resource, and the one screen 0 names —
    // 4316 — is a Compact.
    const palette = new Uint8Array(SKY_PALETTE_BYTES);
    for (let i = 0; i < palette.length; i += 1) palette[i] = i % 0x40;
    const words = new Uint16Array(palette.buffer, 0, palette.length / 2);

    const found = collectSkyCompactPalettes({ records: [{ id: 4316, words }] });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(4316);
    expect(found[0].source).toBe('compact');
  });
});
