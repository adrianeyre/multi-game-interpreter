/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { Sword1Editor } from '../src/editor/sword1/Sword1Editor.js';
import { sword1CompactDeleteRefusal } from '../src/authoring/sword1/edits.js';
import { Sword2Editor } from '../src/editor/sword2/Sword2Editor.js';
import {
  editSword1CompactWord,
  editSword1Operand,
  editSword1PaletteColour,
  editSword1Room,
  editSword1TextLine,
  Sword1EditError,
} from '../src/authoring/sword1/edits.js';
import {
  editSword2Global,
  editSword2Operand,
  editSword2RunList,
  editSword2String,
  Sword2EditError,
} from '../src/authoring/sword2/edits.js';
import type { Project } from '../src/authoring/project.js';
import { toBase64, fromBase64 } from '../src/authoring/base64.js';
import { CPT, SWORD1_COMPACT_WORDS } from '../src/engine/sword1/resource/swordCompact.js';
import { IT, parseSword1ScriptModule } from '../src/engine/sword1/script/swordTokens.js';
import { CP } from '../src/engine/sword2/script/sword2Tokens.js';
import { SWORD1_SURFACES, type Sword1ProjectPicture } from '../src/authoring/sword1/project.js';
import { SWORD2_SURFACES } from '../src/authoring/sword2/project.js';
import {
  dragScenePoint,
  paintScene,
  sceneAnchorAt,
  sceneAnchorLabel,
  sceneAnchorNudge,
  sceneItemAt,
  describeScenePoint,
  type SceneItem,
  type SceneModel,
} from '../src/editor/sceneCanvas.js';
import {
  SWORD1_SCENE_GRID,
  moveSword1Compact,
  sword1ScreenItems,
  sword1ScreenPicture,
  sword1ScreenTrouble,
} from '../src/editor/sword1/screenScene.js';
import {
  SWORD2_IMMOVABLE,
  sword2ScreenBox,
  sword2ScreenDragNote,
  sword2ScreenItems,
  sword2ScreenModel,
  sword2ScreenPicture,
  sword2ScreenRefusals,
  sword2ScreenStandbyRefusals,
  sword2ScreenTrouble,
} from '../src/editor/sword2/screenScene.js';
import {
  SWORD2_BOX_REFUSALS,
  SWORD2_STANDBY_REFUSALS,
  moveSword2Box,
  moveSword2Standby,
  sword2ObjectBox,
} from '../src/editor/sword2/screenBoxes.js';
import {
  sword1ArgumentKind,
  sword1Calls,
  sword1CallsByWord,
  sword1ConsumedWords,
} from '../src/authoring/sword1/calls.js';
import {
  sword2ArgumentKind,
  sword2Calls,
  sword2CallsByByte,
  sword2ConsumedBytes,
} from '../src/authoring/sword2/calls.js';
import { OPERAND_CHOICE_LIMIT, operandField } from '../src/editor/operandField.js';
import { sword1ArgumentField, sword1TextLine } from '../src/editor/sword1/callFields.js';
import { sword2ArgumentField, sword2TextLine } from '../src/editor/sword2/callFields.js';
import {
  disassembleSword1Script,
  reassembleSword1Script,
  roundTripsSword1Script,
} from '../src/authoring/sword1/disassemble.js';
import {
  disassembleSword2Object,
  reassembleSword2Code,
  roundTripsSword2Object,
} from '../src/authoring/sword2/disassemble.js';
import { parseSword2Object } from '../src/engine/sword2/script/Sword2Interpreter.js';
import {
  SWORD1_HEADER_SIZE,
  SWORD1_PLAYER,
  SwordType,
} from '../src/engine/sword1/resource/swordDefs.js';
import { sword1Actors } from '../src/editor/sword1/actors.js';
import { sword2Actors, sword2ObjectAnimations } from '../src/editor/sword2/actors.js';
import type { Sword2ProjectObject } from '../src/authoring/sword2/project.js';
import { STORAGE_KEYS } from '../src/ui/storageKeys.js';
import {
  buildScriptResource,
  buildSpriteResource,
  buildSword2Anim,
  buildSword2Object,
  buildSword2Screen,
} from './fixtureSword.js';
import { swordImportPixels } from '../src/editor/swordPictureView.js';
import type { RgbaImage } from '../src/editor/importImage.js';
import { replaceSword1Picture } from '../src/authoring/sword1/edits.js';
import {
  replaceSword2AnimationFrame,
  replaceSword2ScreenLayer,
} from '../src/authoring/sword2/edits.js';
import { sword1PicturePixels, sword1PictureRefusal } from '../src/editor/sword1/pictureFiles.js';
import { sword2ScreenLayerPixels } from '../src/editor/sword2/pictureFiles.js';
import { sword1SpriteFrames } from '../src/engine/sword1/resource/swordDefs.js';
import {
  RES_HEADER_SIZE,
  readSword2LayerHeader,
  readSword2MultiScreenHeader,
  sword2Animation,
} from '../src/engine/sword2/resource/sword2Headers.js';
import { decompressRLE256 } from '../src/engine/sword2/gfx/sword2Decode.js';

function baseProject(): Project {
  return {
    version: 6,
    target: { engine: 'sword1', release: 'cd', platform: 'dos' },
    name: 'test',
    start: { room: 1, x: 0, y: 0 },
    defaultResponse: '',
    screen: { textHeight: 40, verbTop: 0 },
    verbs: [],
    actors: [],
    rooms: [],
    scripts: [],
    audio: [],
  };
}

function sword1Project(): Project {
  const words = new Int32Array(SWORD1_COMPACT_WORDS);
  words[CPT.YCOORD >> 2] = 100;
  return {
    ...baseProject(),
    sword1: {
      identification: { release: 'cd', how: 'shipped-files', evidence: 'paris2.clu' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD1_SURFACES,
      sections: [
        {
          section: 1,
          resource: 0x02030000,
          compacts: [
            {
              id: 0x10000,
              section: 1,
              index: 0,
              wordsBase64: toBase64(new Uint8Array(words.buffer)),
            },
          ],
          offsets: [0],
          words: SWORD1_COMPACT_WORDS,
        },
      ],
      scripts: [
        {
          resource: 0x01030000,
          sections: [1],
          instructions: [
            { at: 3, token: IT.PUSHNUMBER, operands: [7], words: 2 },
            { at: 5, token: IT.SCRIPTEND, operands: [], words: 1 },
          ],
          entries: [3],
          unrecovered: [],
          roundTrips: true,
        },
      ],
      text: [{ section: 1, language: 'english', resource: 0x03000001, lines: ['one', 'two'] }],
      palettes: [
        { resource: 0x06010000, bytesBase64: toBase64(new Uint8Array(768)), screens: [1] },
      ],
      pictures: [],
      rooms: [
        {
          screen: 1,
          width: 784,
          height: 400,
          totalLayers: 3,
          gridWidth: 65,
          layers: [1, 2, 3, 0],
          grids: [4, 5, 0],
          palettes: [6, 7],
          parallax: [8, 0],
        },
      ],
      effects: [{ fxNo: 1, sample: 0x0c000007, type: 1, delay: 7, rooms: [] }],
      clusters: {
        present: ['GENERAL', 'SCRIPTS'],
        absent: ['SYRIA'],
        // Cluster numbers as `swordres.rif` gives them, which is what lets a
        // refusal say *which* disc a resource is on. The top byte of an id is
        // the cluster *plus one*, so 0x04050000 is cluster 3 and 0x05050000 is
        // cluster 4 — the off-by-one `clusterOf` exists for.
        labels: { 0: 'scripts', 3: 'general', 4: 'syria' },
      },
    },
  };
}

function sword2Project(): Project {
  return {
    ...baseProject(),
    target: { engine: 'sword2', release: 'cd', platform: 'dos' },
    sword2: {
      identification: { release: 'cd', how: 'shipped-files', evidence: 'speech2.clu' },
      editable: { editable: true, unrecovered: 0, reasons: [] },
      surfaces: SWORD2_SURFACES,
      objects: [
        {
          id: 8,
          name: 'george',
          bytesBase64: toBase64(new Uint8Array(200)),
          instructions: [
            { at: 0, token: CP.PUSH_INT32, operands: [5], bytes: 5 },
            { at: 5, token: CP.PUSH_STRING, operands: [5], bytes: 8, text: 'hello' },
            { at: 13, token: CP.END_SCRIPT, operands: [], bytes: 1 },
          ],
          entries: [0],
          unrecovered: [],
          roundTrips: true,
          layout: { localsAt: 92, localsBytes: 16, codeAt: 140, codeBytes: 14 },
        },
      ],
      globals: { count: 8, bytesBase64: toBase64(new Uint8Array(32)) },
      resourceCount: 32,
      text: [{ resource: 9, lines: ['a', 'b'], wavIds: [0, 0] }],
      screens: [
        {
          resource: 20,
          width: 640,
          height: 480,
          layers: 2,
          hasPalette: true,
          parallax: [true, false, true, false],
          bytesBase64: '',
        },
      ],
      palettes: [{ screen: 20, bytesBase64: toBase64(new Uint8Array(1024)) }],
      animations: [{ resource: 30, name: 'walk', frames: 12, compression: 2, bytesBase64: '' }],
      runLists: [{ resource: 2, objects: [8] }],
      clusters: { present: ['general.clu'], absent: [] },
    },
  };
}

describe('Broken Sword edits', () => {
  it('writes one word of a compact and refuses one outside it', () => {
    const project = sword1Project();
    editSword1CompactWord(project, 0x10000, CPT.YCOORD >> 2, 250);
    const words = new Int32Array(
      fromBase64(project.sword1!.sections[0].compacts[0].wordsBase64).buffer,
    );
    expect(words[CPT.YCOORD >> 2]).toBe(250);
    expect(() => editSword1CompactWord(project, 0x10000, 99999, 1)).toThrow(/fixed/);
  });

  it('changes an operand and refuses one that does not exist', () => {
    const project = sword1Project();
    editSword1Operand(project, 0x01030000, 3, 0, 42);
    expect(project.sword1!.scripts[0].instructions[0].operands[0]).toBe(42);
    expect(() => editSword1Operand(project, 0x01030000, 3, 5, 1)).toThrow(Sword1EditError);
  });

  it('changes a line of text and refuses to add one', () => {
    const project = sword1Project();
    editSword1TextLine(project, 0x03000001, 1, 'deux');
    expect(project.sword1!.text[0].lines[1]).toBe('deux');
    expect(() => editSword1TextLine(project, 0x03000001, 9, 'x')).toThrow(/renumber/);
  });

  it('narrows a palette colour to the six bits the DAC holds', () => {
    const project = sword1Project();
    editSword1PaletteColour(project, 0x06010000, 0, 255, 128, 3);
    const bytes = fromBase64(project.sword1!.palettes[0].bytesBase64);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([63, 32, 0]);
  });

  it('refuses a room size the mask grid cannot index', () => {
    const project = sword1Project();
    expect(() => editSword1Room(project, 1, { width: 785 })).toThrow(/multiple of 16/);
    expect(() => editSword1Room(project, 1, { height: 401 })).toThrow(/multiple of 8/);
    editSword1Room(project, 1, { width: 800 });
    expect(project.sword1!.rooms[0].width).toBe(800);
  });

  it('refuses to edit a project that is not this family’s', () => {
    expect(() => editSword1TextLine(baseProject(), 1, 0, 'x')).toThrow(/no Broken Sword section/);
  });
});

describe('Broken Sword II edits', () => {
  it('changes an operand and a pushed string', () => {
    const project = sword2Project();
    editSword2Operand(project, 8, 0, 0, 9);
    expect(project.sword2!.objects[0].instructions[0].operands[0]).toBe(9);
    editSword2String(project, 8, 5, 'byee');
    expect(project.sword2!.objects[0].instructions[1].text).toBe('byee');
  });

  it('refuses a string longer than the one it replaces', () => {
    const project = sword2Project();
    expect(() => editSword2String(project, 8, 5, 'far too long')).toThrow(/refused/);
  });

  it('changes a global inside the count the game declares', () => {
    const project = sword2Project();
    editSword2Global(project, 3, 77);
    const bytes = fromBase64(project.sword2!.globals.bytesBase64);
    expect(new DataView(bytes.buffer).getInt32(12, true)).toBe(77);
    expect(() => editSword2Global(project, 99, 1)).toThrow(/cannot be widened/);
  });

  it('edits a run list, which is how a session changes what is in the room', () => {
    const project = sword2Project();
    editSword2RunList(project, 2, [8, 9, 10]);
    expect(project.sword2!.runLists[0].objects).toEqual([8, 9, 10]);
    expect(() => editSword2RunList(project, 2, [0])).toThrow(Sword2EditError);
  });
});

/**
 * A project with a screen small enough to assert pixel by pixel.
 *
 * Built rather than imported: the demos are 143 MB of game data that never
 * enters this repository, and what these tests check — that layer 0's bytes are
 * the pixels and that six-bit colour is widened by two — is checkable on
 * thirty-two by sixteen.
 */
function sword1SceneProject(withPicture = true): Project {
  const base = sword1Project();

  const pixels = new Uint8Array(32 * 16);
  pixels[0] = 1;
  pixels[1] = 184;

  const background = new Uint8Array(768);
  // Colour 1, as six-bit channels. 63 is the value that tells the widening
  // apart: shifted it is 252, scaled by 255/63 it would be 255.
  background[3] = 63;
  background[4] = 20;
  background[5] = 30;
  // Colour 0 is forced black however the file spells it.
  background[0] = 63;
  background[1] = 63;
  background[2] = 63;

  const sprite = new Uint8Array(768);
  // The second palette's first entry is colour 184, not colour 0.
  sprite[0] = 8;
  sprite[1] = 16;
  sprite[2] = 32;

  const words = (fill: Record<number, number>): string => {
    const array = new Int32Array(SWORD1_COMPACT_WORDS);
    for (const [index, value] of Object.entries(fill)) array[Number(index)] = value;
    return toBase64(new Uint8Array(array.buffer));
  };

  return {
    ...base,
    sword1: {
      ...base.sword1!,
      rooms: [
        {
          screen: 5,
          width: 32,
          height: 16,
          totalLayers: 1,
          gridWidth: 2,
          layers: [0x04050000, 0, 0, 0],
          grids: [0, 0, 0],
          palettes: [0x06050000, 0x06050001],
          parallax: [0, 0],
        },
      ],
      pictures: withPicture
        ? [
            {
              resource: 0x04050000,
              kind: 'background',
              width: 32,
              height: 16,
              frames: 1,
              bytesBase64: toBase64(pixels),
              screens: [5],
            },
          ]
        : [],
      palettes: [
        { resource: 0x06050000, bytesBase64: toBase64(background), screens: [5] },
        { resource: 0x06050001, bytesBase64: toBase64(sprite), screens: [5] },
      ],
      sections: [
        {
          section: 1,
          resource: 0x02050000,
          compacts: [
            {
              id: 0x10000,
              section: 1,
              index: 0,
              wordsBase64: words({
                [CPT.SCREEN >> 2]: 5,
                [CPT.XCOORD >> 2]: 12,
                [CPT.YCOORD >> 2]: 14,
                [CPT.MOUSE_X1 >> 2]: 10,
                [CPT.MOUSE_Y1 >> 2]: 4,
                [CPT.MOUSE_X2 >> 2]: 18,
                [CPT.MOUSE_Y2 >> 2]: 12,
              }),
            },
            // A mega: a position and no mouse area at all.
            {
              id: 0x10001,
              section: 1,
              index: 1,
              wordsBase64: words({
                [CPT.SCREEN >> 2]: 5,
                [CPT.XCOORD >> 2]: 20,
                [CPT.YCOORD >> 2]: 9,
              }),
            },
            // Somewhere else entirely.
            {
              id: 0x10002,
              section: 1,
              index: 2,
              wordsBase64: words({
                [CPT.SCREEN >> 2]: 6,
                [CPT.XCOORD >> 2]: 3,
                [CPT.YCOORD >> 2]: 3,
                [CPT.MOUSE_X1 >> 2]: 1,
                [CPT.MOUSE_Y1 >> 2]: 1,
                [CPT.MOUSE_X2 >> 2]: 5,
                [CPT.MOUSE_Y2 >> 2]: 5,
              }),
            },
          ],
          offsets: [0, SWORD1_COMPACT_WORDS, SWORD1_COMPACT_WORDS * 2],
          words: SWORD1_COMPACT_WORDS * 3,
        },
      ],
    },
  };
}

/**
 * A Broken Sword II screen resource, four pixels by two.
 *
 * The background is a parallax layer like the other four, so the fixture has to
 * be a real one: a row of raw pixels and a row that was never drawn on, which
 * is the interior gap a foreground layer is mostly made of.
 */
function sword2ScreenResource(): Uint8Array {
  const bytes = new Uint8Array(106);
  const view = new DataView(bytes.buffer);
  // MultiScreenHeader, at the resource header's end; its offsets are from its
  // own start. Only `screen` is used here.
  view.setUint32(44 + 12, 36, true);
  // ScreenHeader: four by two, no mask layers.
  view.setUint16(80, 4, true);
  view.setUint16(82, 2, true);
  view.setUint16(84, 0, true);
  // The background parallax: four by two, row 0 raw, row 1 never drawn on.
  view.setUint16(86, 4, true);
  view.setUint16(88, 2, true);
  view.setUint32(90, 12, true);
  view.setUint32(94, 0, true);
  view.setUint16(98, 0, true);
  view.setUint16(100, 0, true);
  bytes.set([1, 2, 3, 4], 102);
  return bytes;
}

function sword2SceneProject(withBytes = true): Project {
  const base = sword2Project();
  const palette = new Uint8Array(1024);
  // Four bytes an entry, not three: colour 1 is bytes 4..6.
  palette.set([11, 22, 33], 4);
  palette.set([44, 55, 66], 8);

  return {
    ...base,
    sword2: {
      ...base.sword2!,
      screens: [
        {
          resource: 20,
          width: 4,
          height: 2,
          layers: 0,
          hasPalette: true,
          parallax: [false, false, false, false],
          bytesBase64: withBytes ? toBase64(sword2ScreenResource()) : '',
        },
      ],
      palettes: [{ screen: 20, bytesBase64: toBase64(palette) }],
    },
  };
}

describe('the scene canvas both room views share', () => {
  it('expands indexed pixels through a palette, and draws black for a colour it has not got', () => {
    const out = new Uint8ClampedArray(3 * 4);
    paintScene(out, {
      width: 3,
      height: 1,
      pixels: Uint8Array.from([0, 1, 9]),
      palette: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    expect([...out]).toEqual([1, 2, 3, 255, 4, 5, 6, 255, 0, 0, 0, 255]);
  });

  it('hit-tests topmost first, which is what the author sees', () => {
    const items: SceneItem[] = [
      { id: 1, name: 'under', x: 0, y: 0, width: 10, height: 10 },
      { id: 2, name: 'over', x: 4, y: 4, width: 4, height: 4 },
    ];
    expect(sceneItemAt(items, 5, 5)?.id).toBe(2);
    expect(sceneItemAt(items, 1, 1)?.id).toBe(1);
    // Half-open: the right and bottom edges belong to the next pixel.
    expect(sceneItemAt(items, 10, 10)).toBeNull();
  });

  it('keeps a dragged corner on the picture', () => {
    const picture = { width: 32, height: 16, pixels: new Uint8Array(512), palette: [] };
    expect(dragScenePoint(picture, -5, 200)).toEqual({ x: 0, y: 15 });
    expect(dragScenePoint(picture, 7, 7)).toEqual({ x: 7, y: 7 });
  });

  it('says where the cursor is in the terms the family measures in', () => {
    const model: SceneModel = {
      label: 'Screen 5',
      help: '',
      picture: () => null,
      items: () => [{ id: 3, name: 'object 0x00010000', x: 0, y: 0, width: 20, height: 20 }],
      grid: () => SWORD1_SCENE_GRID,
      selected: () => null,
      select: () => {},
    };
    expect(describeScenePoint(model, 17, 9)).toBe('17, 9 — object 0x00010000 — mask block 1, 1');
  });
});

describe('a Broken Sword screen as a picture', () => {
  it('draws layer 0’s bytes as the pixels, with both palettes widened by two', () => {
    const picture = sword1ScreenPicture(sword1SceneProject().sword1!, 5)!;
    expect(picture).not.toBeNull();
    expect([picture.width, picture.height]).toEqual([32, 16]);
    expect(picture.pixels[0]).toBe(1);
    // Six bits shifted up by two, which is what the interpreter's DAC does.
    expect(picture.palette[1]).toEqual([252, 80, 120]);
    // The second palette starts at 184, not at 0.
    expect(picture.palette[184]).toEqual([32, 64, 128]);
    // Colour 0 is black however the file spells it.
    expect(picture.palette[0]).toEqual([0, 0, 0]);
  });

  it('says why there is no picture rather than showing an empty frame', () => {
    // Which cause it is, not both hedged together: 0x04050000 is in cluster 3,
    // which this install has, so the budget passed it over — and an author
    // told "SYRIA is absent" about a picture in GENERAL would go looking for a
    // disc that would not help.
    const missing = sword1ScreenTrouble(sword1SceneProject(false).sword1!, 5)!;
    expect(missing).toMatch(/budget/);
    expect(missing).toMatch(/lives in the GENERAL cluster, which this install does have/);
    expect(missing).not.toMatch(/SYRIA/);
    expect(sword1ScreenTrouble(sword1SceneProject().sword1!, 5)).toBeNull();
    expect(sword1ScreenTrouble(sword1SceneProject().sword1!, 99)).toMatch(/no screen 99/);
  });

  it('says it cannot name the cluster when the project predates the labels', () => {
    // A project saved before `clusters.labels` existed has none, and the
    // sentence says that rather than guessing a cluster from the id.
    const project = sword1SceneProject(false).sword1!;
    const older = { ...project, clusters: { present: [], absent: ['SYRIA'] } };
    const missing = sword1ScreenTrouble(older, 5)!;
    expect(missing).toMatch(/does not carry the index's cluster names/);
    expect(missing).toMatch(/largest-first/);
  });

  it('outlines every compact standing on the screen, and only those', () => {
    const items = sword1ScreenItems(sword1SceneProject().sword1!, 5);
    expect(items.map((item) => item.id)).toEqual([0x10000, 0x10001]);
    // The box is the mouse area, because that is what the game tests a click
    // against.
    expect(items[0]).toMatchObject({ x: 10, y: 4, width: 8, height: 8 });
    expect(items[0].anchor).toEqual({ x: 12, y: 14 });
    // A mega has no mouse area, so it is a marker on its own coordinates.
    expect(items[1]).toMatchObject({ x: 16, y: 5, width: 8, height: 8 });
  });

  it('moves a compact’s mouse area and its position by the same delta', () => {
    const project = sword1SceneProject();
    const items = sword1ScreenItems(project.sword1!, 5);
    moveSword1Compact(project, items, 0x10000, 20, 4);

    const words = new Int32Array(
      fromBase64(project.sword1!.sections[0].compacts[0].wordsBase64).buffer,
    );
    expect(words[CPT.MOUSE_X1 >> 2]).toBe(20);
    expect(words[CPT.MOUSE_X2 >> 2]).toBe(28);
    expect(words[CPT.MOUSE_Y1 >> 2]).toBe(4);
    expect(words[CPT.MOUSE_Y2 >> 2]).toBe(12);
    // The position moved with it: a click target left behind is a broken game.
    expect(words[CPT.XCOORD >> 2]).toBe(22);
    expect(words[CPT.YCOORD >> 2]).toBe(14);
  });

  it('does not give a mega a mouse area by dragging it', () => {
    const project = sword1SceneProject();
    const items = sword1ScreenItems(project.sword1!, 5);
    moveSword1Compact(project, items, 0x10001, 16, 9);

    const words = new Int32Array(
      fromBase64(project.sword1!.sections[0].compacts[1].wordsBase64).buffer,
    );
    expect(words[CPT.MOUSE_X1 >> 2]).toBe(0);
    expect(words[CPT.MOUSE_X2 >> 2]).toBe(0);
    expect(words[CPT.XCOORD >> 2]).toBe(20);
    expect(words[CPT.YCOORD >> 2]).toBe(13);
  });
});

describe('a Broken Sword II screen as a picture', () => {
  it('decodes the background as the parallax layer it is, with a four-byte palette', () => {
    const picture = sword2ScreenPicture(sword2SceneProject().sword2!, 20)!;
    expect(picture).not.toBeNull();
    expect([picture.width, picture.height]).toEqual([4, 2]);
    expect([...picture.pixels]).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    expect(picture.palette[1]).toEqual([11, 22, 33]);
    expect(picture.palette[2]).toEqual([44, 55, 66]);
    expect(picture.palette[0]).toEqual([0, 0, 0]);
  });

  it('says why the screen is not there rather than showing an empty frame', () => {
    expect(sword2ScreenTrouble(sword2SceneProject().sword2!, 20)).toBeNull();
    expect(sword2ScreenTrouble(sword2SceneProject(false).sword2!, 20)).toMatch(/budget/);
    expect(sword2ScreenTrouble(sword2SceneProject().sword2!, 99)).toMatch(/no screen 99/);
  });
});

describe('the editors', () => {
  it('build a Broken Sword surface with every section a SCUMM author looks for', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const text = editor.element.textContent ?? '';
    for (const heading of ['Screens', 'Objects', 'Scripts', 'Palettes', 'Pictures', 'Effects']) {
      expect(text).toContain(heading);
    }
    expect(text).toMatch(/Text — english/);
    expect(text).toMatch(/re-emit byte-identically/);
  });

  it('says which clusters are absent rather than showing an empty section', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    expect(editor.element.textContent).toContain('SYRIA');
  });

  it('edits a compact field through the surface', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    // Select the section, then the object, then change a field.
    const buttons = () => [...editor.element.querySelectorAll('button')];
    buttons()
      .find((button) => button.textContent?.startsWith('Section 1'))
      ?.click();
    buttons()
      .find((button) => button.textContent?.startsWith('Object 0'))
      ?.click();
    const input = [...editor.element.querySelectorAll('input')].find((candidate) =>
      candidate.getAttribute('aria-label')?.startsWith('o_ycoord'),
    );
    expect(input).toBeDefined();
    input!.value = '321';
    input!.dispatchEvent(new Event('change'));
    const words = new Int32Array(
      fromBase64(project.sword1!.sections[0].compacts[0].wordsBase64).buffer,
    );
    expect(words[CPT.YCOORD >> 2]).toBe(321);
  });

  it('builds a Broken Sword II surface including the run lists', () => {
    const project = sword2Project();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const text = editor.element.textContent ?? '';
    for (const heading of ['Screens', 'Run lists', 'Objects', 'Globals', 'Text', 'Palettes']) {
      expect(text).toContain(heading);
    }
  });

  it('shows a Broken Sword II object’s decompiled script with its string', () => {
    const project = sword2Project();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const buttons = () => [...editor.element.querySelectorAll('button')];
    buttons()
      .find((button) => button.textContent?.startsWith('george'))
      ?.click();
    expect(editor.element.textContent).toMatch(/CP_PUSH_STRING "hello"/);
  });

  it('shows a Broken Sword screen as a picture, or says what stands in the way', () => {
    const project = sword1SceneProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Screen 5'))
      ?.click();
    // jsdom has no 2D context, so the surface takes the honest fallback: it
    // says so and keeps the facts, rather than throwing or drawing nothing.
    const text = editor.element.textContent ?? '';
    expect(text).toMatch(/no 2D canvas/);
    expect(text).toContain('Grid width');

    const budgeted = sword1SceneProject(false);
    const second = new Sword1Editor({
      project: () => budgeted,
      update: (mutate) => mutate(budgeted),
    });
    [...second.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Screen 5'))
      ?.click();
    expect(second.element.textContent).toMatch(/budget/);
  });

  it('says on the Broken Sword II surface which of a screen’s objects can be dragged', () => {
    const project = sword2BoxProject();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Screen 20'))
      ?.click();
    const text = editor.element.textContent ?? '';
    expect(text).toMatch(/no 2D canvas/);
    // The count, not a claim — and the refusals named one by one underneath,
    // which is the shape every other Sword refusal on this surface takes.
    expect(text).toContain('2 of the 4 objects in this screen’s session can be dragged');
    expect(text).toContain(`scenery ${SWORD2_BOX_REFUSALS.noMouse}`);
    expect(text).toContain(`shifty ${SWORD2_BOX_REFUSALS.fromVariable}`);
    // A read-only view still says the old sentence, because it has nowhere to
    // write: the refusal there is the surface's, not the object's.
    expect(SWORD2_IMMOVABLE).toMatch(/does not write/);
  });

  it('says so, rather than outlining nothing, when no run list names the screen', () => {
    const project = sword2SceneProject();
    expect(sword2ScreenDragNote(project.sword2!, 20)).toMatch(/No run list in this project/);
    expect(sword2ScreenItems(project.sword2!, 20)).toEqual([]);
  });

  it('names each surface’s standing, so nothing has to be inferred', () => {
    expect(SWORD1_SURFACES.scripts).toBe('editable');
    expect(SWORD1_SURFACES.rooms).toBe('editable-not-writable');
    // Pictures were 'preserved' while there were decoders and no encoders,
    // then 'editable-not-writable' while the encoders existed and the exporter
    // never called them. The exporter substitutes every picture resource now,
    // so a painted background is in the exported cluster and the standing is
    // the full one. `rooms` above stays short of it for its own reason: the
    // room table is interpreter knowledge with no file to write it to.
    expect(SWORD1_SURFACES.pictures).toBe('editable');
    // And the same story for audio: the speech RLE encoder existed with no
    // container to write into, so this said 'preserved'. The export rebuilds
    // the speech container, writes a replaced tune as its own file and
    // substitutes a replaced effect's resource, so it is the full standing.
    expect(SWORD1_SURFACES.effects).toBe('editable');
    expect(SWORD2_SURFACES.runLists).toBe('editable');
    // And the same for Broken Sword II's two: the encoders were there, the
    // exporter never called them, and it does now.
    expect(SWORD2_SURFACES.animations).toBe('editable');
    expect(SWORD2_SURFACES.screens).toBe('editable');
  });
});

// ---------------------------------------------------------------------------
// Scripts edited as calls
// ---------------------------------------------------------------------------

/**
 * A module built from real bytecode rather than from hand-written records.
 *
 * The grouping is read *from* the encoding — an mcode's argument count and the
 * pushes before it — so a fixture of invented `at` values would prove nothing
 * about the thing being tested. These go through the assembler and the
 * disassembler the shipped data goes through.
 */
function sword1Module(scripts: number[][]) {
  return parseSword1ScriptModule(buildScriptResource(scripts).subarray(SWORD1_HEADER_SIZE));
}

/** `fnWalk(384, 216, 3, 0)`, then `fnISpeak`, then `fnEnterSection(1)`. */
const CALL_SCRIPT = [
  IT.PUSHNUMBER,
  384,
  IT.PUSHNUMBER,
  216,
  IT.PUSHNUMBER,
  3,
  IT.PUSHNUMBER,
  0,
  IT.MCODE,
  69,
  4,
  IT.PUSHNUMBER,
  0x04050000,
  IT.PUSHNUMBER,
  0x10001,
  IT.PUSHNUMBER,
  0x04050001,
  IT.MCODE,
  38,
  3,
  IT.PUSHNUMBER,
  1,
  IT.MCODE,
  66,
  1,
  IT.SCRIPTEND,
];

/**
 * The same `fnWalk`, with a `IT_SKIP` landing on its third push.
 *
 * The delta is five because a skip's destination is `at + 1 + delta` and the
 * third push is five words past the skip's own word — so a script can arrive
 * with two of the four arguments never pushed.
 */
const JUMPED_SCRIPT = [
  IT.SKIP,
  5,
  IT.PUSHNUMBER,
  384,
  IT.PUSHNUMBER,
  216,
  IT.PUSHNUMBER,
  3,
  IT.PUSHNUMBER,
  0,
  IT.MCODE,
  69,
  4,
  IT.SCRIPTEND,
];

/** `fnWalk` with its direction read out of a script variable. */
const VARIABLE_SCRIPT = [
  IT.PUSHNUMBER,
  100,
  IT.PUSHNUMBER,
  200,
  IT.PUSHVARIABLE,
  909,
  IT.PUSHNUMBER,
  0,
  IT.MCODE,
  69,
  4,
  IT.SCRIPTEND,
];

/** Two calls and three pushes: the second wants two and only one is free. */
const TWO_CALL_SCRIPT = [
  IT.PUSHNUMBER,
  1,
  IT.PUSHNUMBER,
  2,
  IT.MCODE,
  69,
  2,
  IT.PUSHNUMBER,
  3,
  IT.MCODE,
  70,
  2,
  IT.SCRIPTEND,
];

/** A conditional, so an edit inside it has a jump to keep correct. */
const BRANCH_SCRIPT = [
  IT.PUSHVARIABLE,
  909,
  IT.PUSHNUMBER,
  12,
  IT.ISEQUAL,
  IT.SKIPONFALSE,
  6,
  IT.PUSHNUMBER,
  1,
  IT.MCODE,
  69,
  1,
  IT.SCRIPTEND,
];

function sword1CallProject(scripts: number[][] = [CALL_SCRIPT, BRANCH_SCRIPT]): Project {
  const parsed = sword1Module(scripts);
  const disassembly = disassembleSword1Script(parsed);
  const base = sword1Project();
  return {
    ...base,
    sword1: {
      ...base.sword1!,
      scripts: [
        {
          resource: 0x01030000,
          sections: [1],
          instructions: disassembly.instructions,
          entries: disassembly.entries,
          unrecovered: [],
          roundTrips: true,
        },
      ],
    },
  };
}

describe('Broken Sword scripts as calls', () => {
  it('groups an mcode with the pushes that fed it, and names them', () => {
    const disassembly = disassembleSword1Script(sword1Module([CALL_SCRIPT]));
    const calls = sword1Calls(disassembly.instructions, disassembly.entries);
    expect(calls.map((call) => call.name)).toEqual(['fnWalk', 'fnISpeak', 'fnEnterSection']);

    const walk = calls[0];
    expect(walk.count).toBe(4);
    expect(walk.arguments.map((argument) => argument.label)).toEqual(['x', 'y', 'dir', 'stance']);
    expect(walk.arguments.map((argument) => argument.value)).toEqual([384, 216, 3, 0]);
    expect(walk.arguments.map((argument) => argument.kind)).toEqual([
      'coordinate',
      'coordinate',
      'direction',
      'number',
    ]);
    // Each argument is written where it was pushed, which is two words apart
    // for a `IT_PUSHNUMBER` and never at the mcode itself.
    expect(walk.arguments.map((argument) => argument.at)).toEqual(
      disassembly.instructions.slice(0, 4).map((instruction) => instruction.at),
    );
    expect(walk.consumes).toEqual(walk.arguments.map((argument) => argument.at));
    expect(sword1ConsumedWords(calls).has(walk.arguments[0].at)).toBe(true);
    expect(sword1CallsByWord(calls).get(walk.at)?.name).toBe('fnWalk');
  });

  it('says why it cannot name arguments rather than naming them wrongly', () => {
    const computed = sword1Calls(
      disassembleSword1Script(
        sword1Module([
          [IT.PUSHNUMBER, 1, IT.PUSHNUMBER, 2, IT.PLUS, IT.MCODE, 80, 1, IT.SCRIPTEND],
        ]),
      ).instructions,
    );
    expect(computed[0].arguments).toHaveLength(0);
    expect(computed[0].trouble).toMatch(/argument 0 is computed at run time/);

    // A jump landing inside the run of pushes: arriving at word `target`
    // without running what precedes it means those pushes never happened, so
    // attributing them to this call would be a lie the editor tells.
    const jumped = sword1Calls(disassembleSword1Script(sword1Module([JUMPED_SCRIPT])).instructions);
    expect(jumped[0].arguments).toHaveLength(0);
    expect(jumped[0].trouble).toMatch(/can be jumped to/);
  });

  it('never takes a push an earlier call already claimed', () => {
    // Two mcodes, three pushes: the second wants two and only one is free. The
    // first call is what stops the walk — an `IT_MCODE` is not a push — which
    // is why no bookkeeping is needed to keep a push out of two calls.
    const calls = sword1Calls(
      disassembleSword1Script(sword1Module([TWO_CALL_SCRIPT])).instructions,
    );
    expect(calls[0].arguments.map((argument) => argument.value)).toEqual([1, 2]);
    expect(calls[1].arguments).toHaveLength(0);
    expect(calls[1].trouble).toMatch(/argument 0 is computed at run time/);
    expect(sword1ConsumedWords(calls).size).toBe(2);
  });

  it('names Broken Sword II parameters from Revolution’s own comment blocks', () => {
    const layout = parseSword2Object(buildSword2Object('george', [SWORD2_CALL_CODE], 8, 3, 8));
    const disassembly = disassembleSword2Object(layout);
    const calls = sword2Calls(disassembly.instructions, disassembly.entries);
    expect(calls.map((call) => call.name)).toEqual([
      'fnSetStandbyCoords',
      'fnDisplayMsg',
      'fnRegisterStartPoint',
      'fnAddSubject',
    ]);

    expect(calls[0].arguments.map((argument) => argument.label)).toEqual([
      'x-coord',
      'y-coord',
      'direction (0..7)',
    ]);
    expect(calls[0].arguments.map((argument) => argument.kind)).toEqual([
      'coordinate',
      'coordinate',
      'direction',
    ]);

    // What the bytecode did outranks what the comment says it means: parameter
    // 0 is documented as a script id and pushed as a local address, and
    // parameter 1 is documented as a pointer and pushed as a string.
    const register = calls[2];
    expect(register.arguments.map((argument) => argument.push)).toEqual(['localAddr', 'string']);
    expect(register.arguments.map((argument) => argument.kind)).toEqual(['pointer', 'string']);
    expect(register.arguments[1].text).toBe('hello');
    expect(sword2ConsumedBytes(calls).has(register.arguments[1].at)).toBe(true);
    expect(sword2CallsByByte(calls).get(register.at)?.name).toBe('fnRegisterStartPoint');
  });

  it('says why a Broken Sword II call’s parameters are not named', () => {
    const layout = parseSword2Object(
      buildSword2Object(
        'george',
        [
          [
            CP.PUSH_INT32,
            ...le32(1),
            CP.PUSH_INT32,
            ...le32(2),
            CP.OP_PLUS,
            CP.CALL_MCODE,
            ...le16(10),
            2,
            CP.END_SCRIPT,
          ],
        ],
        8,
        3,
        8,
      ),
    );
    const calls = sword2Calls(disassembleSword2Object(layout).instructions);
    expect(calls[0].name).toBe('fnRandom');
    expect(calls[0].arguments).toHaveLength(0);
    expect(calls[0].trouble).toMatch(/parameter 1 is computed at run time/);
  });

  it('falls back to a plain number for a name with no rule', () => {
    expect(sword1ArgumentKind(null)).toBe('number');
    expect(sword1ArgumentKind('stance')).toBe('number');
    expect(sword1ArgumentKind('dir')).toBe('direction');
    expect(sword2ArgumentKind(null)).toBe('number');
    expect(sword2ArgumentKind('daves reference number')).toBe('number');
    // Ordered rules: both of these say "id of", and only one is a resource.
    expect(sword2ArgumentKind('id of walkgrid resource')).toBe('resource');
    expect(sword2ArgumentKind('id of target to catch the event')).toBe('object');
  });
});

describe('the operand field', () => {
  it('is a number when there is nothing to pick from, and reports a change', () => {
    const seen: number[] = [];
    const field = operandField({
      id: 'test',
      label: 'x',
      value: 12,
      onChange: (value) => seen.push(value),
    });
    const input = field.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('number');
    expect(input.value).toBe('12');
    input.value = '40';
    input.dispatchEvent(new Event('change'));
    expect(seen).toEqual([40]);
  });

  it('keeps a value the project does not know rather than snapping it', () => {
    const field = operandField({
      id: 'test',
      label: 'screen',
      value: 71,
      choices: [
        { value: 1, label: '1 — a room' },
        { value: 2, label: '2 — another' },
      ],
      onChange: () => {},
    });
    const select = field.querySelector('select') as HTMLSelectElement;
    // The bug this guards: a `<select>` whose value is not among its options
    // reports the first option, so rendering the page would rewrite the script.
    expect(select.value).toBe('71');
    expect(select.options[0].textContent).toMatch(/not in this project/);
    expect(select.options).toHaveLength(3);
  });

  it('wires a hint to the control so it is read with it, not beside it', () => {
    const field = operandField({
      id: 'test',
      label: 'textNo',
      value: 1,
      hint: '“two”',
      onChange: () => {},
    });
    const hint = field.querySelector('.operand-hint') as HTMLElement;
    const input = field.querySelector('input') as HTMLInputElement;
    expect(hint.textContent).toBe('“two”');
    expect(input.getAttribute('aria-describedby')).toBe(hint.id);
    expect(hint.id).not.toBe('');
  });

  it('does not offer a picker longer than a person can use', () => {
    expect(OPERAND_CHOICE_LIMIT).toBeGreaterThan(0);
    const project = sword1Project();
    const many = {
      ...project.sword1!,
      effects: Array.from({ length: OPERAND_CHOICE_LIMIT + 1 }, (_, at) => ({
        fxNo: at,
        sample: at,
        type: 1,
        delay: 0,
        rooms: [],
      })),
    };
    const argument = {
      index: 0,
      name: 'fxNo',
      label: 'fxNo',
      kind: 'sound' as const,
      at: 3,
      push: 'number' as const,
      value: 1,
    };
    expect(sword1ArgumentField(many, argument).choices).toBeNull();
    expect(sword1ArgumentField(project.sword1!, argument).choices).toHaveLength(1);
  });
});

describe('what a call’s operand may be', () => {
  it('offers the screen list for a screen and the eight names for a direction', () => {
    const sword1 = sword1Project().sword1!;
    const calls = sword1Calls(disassembleSword1Script(sword1Module([CALL_SCRIPT])).instructions);
    const screen = sword1ArgumentField(sword1, calls[2].arguments[0]);
    expect(screen.choices).toEqual([{ value: 1, label: '1 — 784×400' }]);

    const direction = sword1ArgumentField(sword1, calls[0].arguments[2]);
    expect(direction.choices).toHaveLength(8);
    expect(direction.choices?.[3]).toEqual({ value: 3, label: '3 — down-right' });
  });

  it('shows the line a text id names, and says so when it names none', () => {
    const sword1 = sword1Project().sword1!;
    expect(sword1TextLine(sword1, 0x10001)).toBe('two');
    expect(sword1TextLine(sword1, 0x10009)).toBeNull();
    const calls = sword1Calls(disassembleSword1Script(sword1Module([CALL_SCRIPT])).instructions);
    expect(sword1ArgumentField(sword1, calls[1].arguments[1]).hint).toBe('“two”');
    // A resource argument says what the id is, and says plainly when the
    // project never imported it rather than showing a bare number.
    expect(sword1ArgumentField(sword1, calls[1].arguments[0]).hint).toMatch(/not a resource/);
    const withPicture = sword1SceneProject().sword1!;
    expect(sword1ArgumentField(withPicture, calls[1].arguments[0]).hint).toMatch(/a picture/);

    const sword2 = sword2Project().sword2!;
    expect(sword2TextLine(sword2, 0x00090001)).toBe('b');
    expect(sword2TextLine(sword2, 0x00090009)).toBeNull();
  });

  it('lets the push outrank the name, so a variable is never a picker', () => {
    const sword1 = sword1Project().sword1!;
    const calls = sword1Calls(
      disassembleSword1Script(sword1Module([VARIABLE_SCRIPT])).instructions,
    );
    const direction = sword1ArgumentField(sword1, calls[0].arguments[2]);
    // Named `dir`, but pushed from a variable: offering the direction list
    // would write a direction number into a variable index.
    expect(direction.choices).toBeNull();
    expect(direction.label).toBe('dir (variable)');
    expect(direction.hint).toBe('SCREEN');
  });

  it('says what a Broken Sword II pointer and object parameter are', () => {
    const sword2 = sword2Project().sword2!;
    const layout = parseSword2Object(buildSword2Object('george', [SWORD2_CALL_CODE], 8, 3, 8));
    const calls = sword2Calls(disassembleSword2Object(layout).instructions);

    const pointer = sword2ArgumentField(sword2, calls[2].arguments[0]);
    expect(pointer.choices).toBeNull();
    expect(pointer.label).toMatch(/\(address\)$/);
    expect(pointer.hint).toMatch(/local variables/);

    const subject = sword2ArgumentField(sword2, calls[3].arguments[0]);
    expect(subject.choices).toEqual([{ value: 8, label: '8 — george' }]);
    expect(subject.hint).toBe('george');

    const message = sword2ArgumentField(sword2, calls[1].arguments[0]);
    expect(message.hint).toBe('“b”');
  });
});

describe('editing a script as calls', () => {
  it('draws a call as named fields and folds its pushes into it', () => {
    const project = sword1CallProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Scripts');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Module 0x1030000'))
      ?.click();

    const calls = [...editor.element.querySelectorAll('.sword-call')];
    expect(calls).toHaveLength(4);
    expect(calls[0].querySelector('.sword-call-name')?.textContent).toMatch(/fnWalk$/);
    expect(calls[0].querySelectorAll('.operand-field')).toHaveLength(4);
    expect(
      [...calls[0].querySelectorAll('.operand-field > span:first-child')].map(
        (span) => span.textContent,
      ),
    ).toEqual(['x', 'y', 'dir', 'stance']);
    // The four pushes are the call's fields and not four rows of their own.
    expect(editor.element.textContent).not.toMatch(/IT_PUSHNUMBER 384/);
    expect(editor.element.textContent).toMatch(/4 of 4 calls shown as named arguments/);
  });

  it('writes an edited field to the instruction that pushed it', () => {
    const project = sword1CallProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Scripts');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Module 0x1030000'))
      ?.click();

    const calls = sword1Calls(
      project.sword1!.scripts[0].instructions,
      project.sword1!.scripts[0].entries,
    );
    const x = calls[0].arguments[0];
    const input = editor.element.querySelector(
      '.sword-call .operand-field input[type="number"]',
    ) as HTMLInputElement;
    input.value = '512';
    input.dispatchEvent(new Event('change'));

    const written = project.sword1!.scripts[0].instructions.find(
      (instruction) => instruction.at === x.at,
    );
    expect(written?.operands[0]).toBe(512);
    // And the mcode itself is untouched: an editor that renumbered the
    // argument count would renumber every argument with it.
    const mcode = project.sword1!.scripts[0].instructions.find(
      (instruction) => instruction.at === calls[0].at,
    );
    expect(mcode?.operands).toEqual([69, 4]);
  });

  it('draws a Broken Sword II call, with a pushed string as text', () => {
    const project = sword2CallProject(SWORD2_CALL_CODE);
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('george'))
      ?.click();

    const calls = [...editor.element.querySelectorAll('.sword-call')];
    expect(calls[0].querySelector('.sword-call-name')?.textContent).toMatch(/fnSetStandbyCoords$/);
    const register = calls.find((call) =>
      call.querySelector('.sword-call-name')?.textContent?.endsWith('fnRegisterStartPoint'),
    ) as HTMLElement;
    const text = register.querySelector('input[type="text"]') as HTMLInputElement;
    expect(text.value).toBe('hello');
    text.value = 'byee';
    text.dispatchEvent(new Event('change'));
    expect(
      project.sword2!.objects[0].instructions.find(
        (instruction) => instruction.token === CP.PUSH_STRING,
      )?.text,
    ).toBe('byee');
  });
});

describe('an edited script still re-emits', () => {
  it('changes exactly the word the field named, and nothing else', () => {
    const parsed = sword1Module([CALL_SCRIPT, BRANCH_SCRIPT]);
    const before = Int32Array.from(parsed.code);
    const project = sword1CallProject();
    const script = project.sword1!.scripts[0];
    const calls = sword1Calls(script.instructions, script.entries);

    // The `x` of the `fnWalk` inside the conditional, which is the argument
    // with a jump across it — the case an edit could break silently.
    expect(calls).toHaveLength(4);
    const branch = calls[3];
    expect(branch.name).toBe('fnWalk');
    editSword1Operand(project, 0x01030000, branch.arguments[0].at, 0, 42);

    const rebuilt = reassembleSword1Script(script.instructions, script.entries);
    const differ: number[] = [];
    for (let at = 0; at < Math.max(rebuilt.length, before.length); at++) {
      if ((rebuilt[at] ?? 0) !== (before[at] ?? 0)) differ.push(at);
    }
    expect(differ).toEqual([branch.arguments[0].at + 1]);
    expect(rebuilt[branch.arguments[0].at + 1]).toBe(42);

    // And the edited module is still a module: read back, it re-emits to
    // exactly itself, which is what proves every jump still resolves.
    const reparsed = {
      code: rebuilt,
      scriptCount: script.entries.length,
      offsets: script.entries.map((_entry, index) => rebuilt[index + 1]),
    };
    expect(roundTripsSword1Script(reparsed)).toEqual({ ok: true });
    const again = disassembleSword1Script(reparsed);
    expect(again.unrecovered).toHaveLength(0);
    expect(sword1Calls(again.instructions, again.entries).at(-1)?.arguments[0]?.value).toBe(42);
  });

  it('re-emits an edited Broken Sword II object to the bytes it changed', () => {
    const project = sword2CallProject(SWORD2_BRANCH_CODE);
    const object = project.sword2!.objects[0];
    const before = fromBase64(object.bytesBase64).slice(
      object.layout.codeAt,
      object.layout.codeAt + object.layout.codeBytes,
    );
    const calls = sword2Calls(object.instructions, object.entries);
    expect(calls[0].name).toBe('fnSetStandbyCoords');

    const x = calls[0].arguments[0];
    // 300 rather than 99, so the value spans two bytes: an assertion that only
    // one byte moved would pass for the wrong reason on a value under 256.
    editSword2Operand(project, 8, x.at, 0, 300);

    const rebuilt = reassembleSword2Code(object.instructions, object.entries);
    const differ: number[] = [];
    for (let at = 0; at < Math.max(rebuilt.code.length, before.length); at++) {
      if ((rebuilt.code[at] ?? 0) !== (before[at] ?? 0)) differ.push(at);
    }
    // A `CP_PUSH_INT32`'s value is the four bytes after its token, and the
    // `CP_SKIPONFALSE` across it re-derives to the same delta because nothing
    // moved — a jump that had to change would have thrown rather than written.
    expect(differ).toEqual([x.at + 1, x.at + 2]);
    expect(new DataView(rebuilt.code.buffer).getInt32(x.at + 1, true)).toBe(300);
    expect(rebuilt.entries).toEqual([...object.entries]);

    const layout = parseSword2Object(buildSword2Object('george', [[...rebuilt.code]], 8, 3, 8));
    expect(roundTripsSword2Object(layout)).toEqual({ ok: true });
    expect(sword2Calls(disassembleSword2Object(layout).instructions)[0].arguments[0].value).toBe(
      300,
    );
  });
});

/** Little-endian operands, so a fixture reads like the encoding it exercises. */
function le16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}
function le32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Four Broken Sword II calls, one per thing a parameter can be.
 *
 * `fnSetStandbyCoords` takes plain numbers, `fnDisplayMsg` a text id,
 * `fnRegisterStartPoint` an address and a pushed string, and `fnAddSubject` an
 * object id — which is the whole of the kind rules in forty-odd bytes.
 */
const SWORD2_CALL_CODE = [
  CP.PUSH_INT32,
  ...le32(50),
  CP.PUSH_INT32,
  ...le32(60),
  CP.PUSH_INT32,
  ...le32(3),
  CP.CALL_MCODE,
  ...le16(66),
  3,
  CP.PUSH_INT32,
  ...le32(0x00090001),
  CP.CALL_MCODE,
  ...le16(92),
  1,
  CP.PUSH_LOCAL_ADDR,
  ...le16(8),
  CP.PUSH_STRING,
  5,
  0x68,
  0x65,
  0x6c,
  0x6c,
  0x6f,
  0,
  CP.CALL_MCODE,
  ...le16(2),
  2,
  CP.PUSH_INT32,
  ...le32(8),
  CP.PUSH_INT32,
  ...le32(1),
  CP.CALL_MCODE,
  ...le16(12),
  2,
  CP.END_SCRIPT,
];

/** The same call behind a `CP_SKIPONFALSE`, so an edit has a jump to keep. */
const SWORD2_BRANCH_CODE = [
  CP.PUSH_INT32,
  ...le32(1),
  CP.SKIPONFALSE,
  ...le32(23),
  CP.PUSH_INT32,
  ...le32(50),
  CP.PUSH_INT32,
  ...le32(60),
  CP.PUSH_INT32,
  ...le32(3),
  CP.CALL_MCODE,
  ...le16(66),
  3,
  CP.END_SCRIPT,
];

function sword2CallProject(code: number[]): Project {
  const bytes = buildSword2Object('george', [code], 8, 3, 8);
  const layout = parseSword2Object(bytes);
  const disassembly = disassembleSword2Object(layout);
  const base = sword2Project();
  return {
    ...base,
    sword2: {
      ...base.sword2!,
      objects: [
        {
          id: 8,
          name: 'george',
          bytesBase64: toBase64(bytes),
          instructions: disassembly.instructions,
          entries: disassembly.entries,
          unrecovered: disassembly.unrecovered,
          roundTrips: roundTripsSword2Object(layout, disassembly).ok,
          layout: {
            localsAt: layout.localsAt,
            localsBytes: layout.localsBytes,
            codeAt: layout.codeAt,
            codeBytes: layout.codeBytes,
          },
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Pictures, drawn and replaced
// ---------------------------------------------------------------------------

/** A project holding one sprite, one mask and one background. */
function sword1PictureProject(): Project {
  const project = sword1Project();
  const sprite = buildSpriteResource([
    { width: 2, height: 2, pixels: Uint8Array.from([1, 2, 3, 4]) },
    { width: 3, height: 1, pixels: Uint8Array.from([9, 0, 9]) },
  ]);
  (project.sword1 as { pictures: unknown }).pictures = [
    {
      resource: 0x01010001,
      kind: 'sprite',
      width: 3,
      height: 2,
      frames: 2,
      bytesBase64: toBase64(sprite),
      screens: [1],
    },
    {
      resource: 0x01010002,
      kind: 'mask',
      width: 16,
      height: 8,
      frames: 1,
      bytesBase64: toBase64(new Uint8Array(128)),
      screens: [1],
    },
  ];
  return project;
}

/**
 * Opens a collapsed list section, the way a person would.
 *
 * Both Sword sidebars are accordions now — the SCUMM sidebar's own widget, for
 * the SCUMM sidebar's own reason: a retail install has 150 screens and 1,500
 * compacts, and a column that draws all of them at once and cannot be closed
 * puts the section you want below the fold of the ones you do not. So a test
 * that wants a row opens the section holding it first. `aria-expanded` is read
 * rather than assumed, because the open set is remembered in `localStorage` and
 * jsdom keeps one of those across a whole file.
 */
function openSection(root: HTMLElement, title: string): void {
  const head = [...root.querySelectorAll<HTMLButtonElement>('.accordion-head')].find(
    (button) => button.querySelector('.accordion-title')?.textContent === title,
  );
  if (head?.getAttribute('aria-expanded') === 'false') head.click();
}

/** The buttons in a panel, by their visible label. */
function buttonNamed(root: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((button) => button.textContent === label);
}

describe('importing artwork into a Broken Sword picture', () => {
  /** A one-row image, given as (r, g, b, a) quads. */
  function source(quads: readonly (readonly number[])[]): RgbaImage {
    const data = new Uint8ClampedArray(quads.length * 4);
    quads.forEach((quad, at) => data.set(quad, at * 4));
    return { width: quads.length, height: 1, data };
  }

  /** A palette whose entry 0 is white, so a wrong answer is visible. */
  const PALETTE = [
    [255, 255, 255],
    [0, 0, 0],
    [255, 0, 0],
    [0, 0, 255],
  ];

  it('gives a transparent pixel colour 0 and never gives an opaque one colour 0', () => {
    // The trap this exists for: `importImage.ts` writes 255 for transparency,
    // which is SCUMM's index. Broken Sword's is 0 — in both families and in
    // every one of their formats — so a sprite imported the SCUMM way would
    // paint colour 255 through every hole and stamp colour 0, which the game
    // never draws, over the picture.
    const pixels = swordImportPixels(
      source([
        [255, 255, 255, 0],
        [255, 255, 255, 255],
        [250, 0, 0, 255],
      ]),
      PALETTE,
      { dither: false },
    );
    expect(pixels[0]).toBe(0);
    // White is entry 0 and entry 0 is not on offer, so the nearest *available*
    // colour wins rather than the nearest colour.
    expect(pixels[1]).not.toBe(0);
    expect(pixels[2]).toBe(2);
  });

  it('keeps every pixel opaque when the picture has no transparency', () => {
    const pixels = swordImportPixels(source([[255, 255, 255, 0]]), PALETTE, {
      dither: false,
      transparentZero: false,
    });
    expect(pixels[0]).not.toBe(0);
  });

  it('quantises against only the colours it is allowed, and maps them back', () => {
    // An RLE16 frame draws through a sixteen-entry table in its own resource,
    // so a colour outside the table cannot be written at all. Handing the table
    // to the quantiser turns a refusal into a nearest-colour choice.
    const pixels = swordImportPixels(
      source([
        [250, 0, 0, 255],
        [0, 0, 250, 255],
      ]),
      PALETTE,
      { dither: false, allowed: [0, 3] },
    );
    expect([...pixels]).toEqual([3, 3]);
  });
});

describe('a Broken Sword picture as something writable', () => {
  it('offers a frame apiece and replaces the one that is open', () => {
    const project = sword1PictureProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Pictures');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('sprite 0x1010001'))
      ?.click();

    const strip = editor.element.querySelector('[role="radiogroup"]');
    expect(strip?.querySelectorAll('[role="radio"]').length).toBe(2);
    // The panel says the surface is editable, and Import is live rather than
    // disabled with no sentence next to it.
    expect(editor.element.textContent).toMatch(/Editable/);
    expect(buttonNamed(editor.element, 'Import PNG')?.disabled).toBe(false);
    expect(buttonNamed(editor.element, 'Export PNG')?.disabled).toBe(false);
  });

  it('refuses a mask layer in the words that say why, next to the dead button', () => {
    const project = sword1PictureProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Pictures');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('mask 0x1010002'))
      ?.click();

    const importButton = buttonNamed(editor.element, 'Import PNG');
    expect(importButton?.disabled).toBe(true);
    // Not "unsupported": the sentence names the Grid resource, which is the
    // thing that is missing and the reason there is no rectangle to draw.
    const described = importButton?.getAttribute('aria-describedby') ?? '';
    expect(editor.element.querySelector(`#${described}`)?.textContent).toMatch(/Grid resource/);
  });

  it('writes a frame back and leaves the rest of the sprite byte-identical', () => {
    const project = sword1PictureProject();
    const before = fromBase64(project.sword1!.pictures[0].bytesBase64);
    replaceSword1Picture(project, 0x01010001, 1, Uint8Array.from([7, 8, 7]), 3, 1);
    const after = fromBase64(project.sword1!.pictures[0].bytesBase64);

    const was = sword1SpriteFrames(before);
    const now = sword1SpriteFrames(after);
    expect([...now[1].data]).toEqual([7, 8, 7]);
    expect([...now[0].data]).toEqual([...was[0].data]);
    expect(now[0].header.width).toBe(was[0].header.width);
  });

  it('rebuilds a sprite byte-identically when the pixels have not changed', () => {
    // The bar item 3 is held to: a re-encode of unmodified input is the
    // original bytes. The frame table is `count` offsets and not `count + 1`,
    // and writing the extra one made all 438 of the demo's sprites four bytes
    // too long — which every decoder still read, and no test saw.
    const project = sword1PictureProject();
    const before = project.sword1!.pictures[0].bytesBase64;
    const frame = sword1PicturePixels(project.sword1!.pictures[0], 0)!;
    replaceSword1Picture(project, 0x01010001, 0, frame.pixels, frame.width, frame.height);
    expect(project.sword1!.pictures[0].bytesBase64).toBe(before);
  });
});

describe('a Broken Sword II picture as something writable', () => {
  /** A project holding one animation and one screen with a mask layer. */
  function project(): Project {
    const base = sword2Project();
    const animation = buildSword2Anim('walk', [
      { x: 1, y: 2, width: 2, height: 2, colour: 7 },
      { x: 3, y: 4, width: 2, height: 1, colour: 8 },
    ]);
    (base.sword2 as { animations: unknown }).animations = [
      {
        resource: 30,
        name: 'walk',
        frames: 2,
        compression: 0,
        bytesBase64: toBase64(animation),
      },
    ];
    const screen = buildSword2Screen(
      'lobby',
      8,
      4,
      3,
      { x: 2, y: 1, width: 3, height: 2 },
      { x: 0, y: 0, width: 4, height: 2, colour: 5 },
    );
    (base.sword2 as { screens: unknown }).screens = [
      {
        resource: 20,
        width: 8,
        height: 4,
        layers: 1,
        hasPalette: true,
        parallax: [false, false, false, false],
        bytesBase64: toBase64(screen),
      },
    ];
    return base;
  }

  it('draws an animation frame by frame and replaces the one that is open', () => {
    const opened = project();
    const editor = new Sword2Editor({
      project: () => opened,
      update: (mutate) => mutate(opened),
    });
    openSection(editor.element, 'Animations');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('walk'))
      ?.click();
    expect(editor.element.querySelectorAll('[role="radio"]').length).toBe(2);
    expect(buttonNamed(editor.element, 'Import PNG')?.disabled).toBe(false);

    replaceSword2AnimationFrame(opened, 30, 1, Uint8Array.from([4, 5]), 2, 1);
    const walked = sword2Animation(fromBase64(opened.sword2!.animations[0].bytesBase64))!;
    expect([...walked.frames[1].data]).toEqual([4, 5]);
    // The frame that was not touched keeps its own bytes and its own placement.
    expect([...walked.frames[0].data]).toEqual([7, 7, 7, 7]);
    expect(walked.frames[0].cdt.x).toBe(1);
  });

  it('rebuilds an animation byte-identically when the pixels have not changed', () => {
    const opened = project();
    const before = opened.sword2!.animations[0].bytesBase64;
    replaceSword2AnimationFrame(opened, 30, 0, Uint8Array.from([7, 7, 7, 7]), 2, 2);
    expect(opened.sword2!.animations[0].bytesBase64).toBe(before);
  });

  it('rewrites a screen byte-identically when a layer has not changed', () => {
    const opened = project();
    const before = opened.sword2!.screens[0].bytesBase64;
    const layer = sword2ScreenLayerPixels(opened.sword2!, 20, 2)!;
    replaceSword2ScreenLayer(opened, 20, 2, layer.pixels, layer.width, layer.height);
    expect(opened.sword2!.screens[0].bytesBase64).toBe(before);
  });

  it('moves a mask layer’s own offset when the layer in front of it changes length', () => {
    // `LayerHeader.offset` is measured from the end of the resource header, the
    // same as every offset in the multi-screen header — `file +
    // ResHeader::size() + layer_head.offset` (`screen.cpp:528`). Read as
    // absolute it compares 44 bytes low against the edited layer's position,
    // and a mask that sits within 44 bytes of that layer is left pointing at
    // where it used to be. This screen is sized so that it does: one row, so
    // the whole background is 28 bytes, which is exactly the 44 of the resource
    // header less the 16 of the layer header.
    const opened = sword2Project();
    const screen = buildSword2Screen('strip', 16, 1, 3, undefined, {
      x: 0,
      y: 0,
      width: 2,
      height: 1,
      colour: 5,
    });
    (opened.sword2 as { screens: unknown }).screens = [
      {
        resource: 21,
        width: 16,
        height: 1,
        layers: 1,
        hasPalette: true,
        parallax: [false, false, false, false],
        bytesBase64: toBase64(screen),
      },
    ];

    // Punching holes makes the row a packet rather than a raw strip, which is
    // one byte shorter — enough to move everything behind it.
    const holed = Uint8Array.from({ length: 16 }, (_, at) => (at % 4 < 2 ? 0 : 3));
    replaceSword2ScreenLayer(opened, 21, 2, holed, 16, 1);
    expect([...sword2ScreenLayerPixels(opened.sword2!, 21, 2)!.pixels]).toEqual([...holed]);

    const bytes = fromBase64(opened.sword2!.screens[0].bytesBase64);
    const multi = readSword2MultiScreenHeader(bytes, RES_HEADER_SIZE);
    const header = readSword2LayerHeader(bytes, RES_HEADER_SIZE + multi.layers);
    const mask = new Uint8Array(header.width * header.height);
    const at = RES_HEADER_SIZE + header.offset;
    expect(decompressRLE256(bytes.subarray(at, at + header.maskSize), mask, mask.length).ok).toBe(
      true,
    );
    expect([...new Set(mask)]).toEqual([5]);
  });
});

/**
 * A project whose cast is worth deriving: a player, a mega, and a door.
 *
 * Built on the scene fixture because a character has to be somewhere — the
 * Actors section names the screen it is standing on, and a cast list whose
 * every member is on screen 0 would pass a test that reads nothing.
 */
function sword1ActorProject(): Project {
  const project = sword1SceneProject();
  const sword1 = project.sword1!;
  const words = (fill: Record<number, number>): string => {
    const array = new Int32Array(SWORD1_COMPACT_WORDS);
    for (const [index, value] of Object.entries(fill)) array[Number(index)] = value;
    return toBase64(new Uint8Array(array.buffer));
  };
  const section = sword1.sections[0]!;
  const compacts = [
    // Neither sprite word: a floor patch, which is the case the bare refusal
    // is written for.
    {
      id: 0x10003,
      section: 1,
      index: 4,
      wordsBase64: words({
        [CPT.TYPE >> 2]: SwordType.NON_MEGA,
        [CPT.SCREEN >> 2]: 5,
      }),
    },
    // A door: NON_MEGA, and art of its own, so the art panel is not a test of
    // "actors have pictures" by accident.
    {
      id: 0x10000,
      section: 1,
      index: 0,
      wordsBase64: words({
        [CPT.TYPE >> 2]: SwordType.NON_MEGA,
        [CPT.SCREEN >> 2]: 5,
        [CPT.RESOURCE >> 2]: 0x04050000,
        [CPT.FRAME >> 2]: 0,
      }),
    },
    // An extra who walks, whose walking sprite is on the other disc. This is
    // the shape a demo install actually ships: o_walk_resource set, and its
    // frames not in the project.
    {
      id: 0x10001,
      section: 1,
      index: 1,
      wordsBase64: words({
        [CPT.TYPE >> 2]: SwordType.MEGA,
        [CPT.SCREEN >> 2]: 5,
        [CPT.XCOORD >> 2]: 20,
        [CPT.YCOORD >> 2]: 9,
        [CPT.DIR >> 2]: 3,
        [CPT.MEGA_RESOURCE >> 2]: 0x07050000,
        [CPT.WALK_RESOURCE >> 2]: 0x05050000,
      }),
    },
    // A mega the scripts have moved: both sprite words set, and set to
    // different resources, which is the only case that offers a choice.
    {
      id: 0x10002,
      section: 1,
      index: 3,
      wordsBase64: words({
        [CPT.TYPE >> 2]: SwordType.MEGA,
        [CPT.SCREEN >> 2]: 5,
        [CPT.RESOURCE >> 2]: 0x04050000,
        [CPT.FRAME >> 2]: 0,
        [CPT.WALK_RESOURCE >> 2]: 0x05050000,
      }),
    },
    // George, last in the file and first in the list.
    //
    // His o_resource is **0**, which is what the game ships: it is run-time
    // state that `fnStand` fills in from o_walk_resource. Measured on the
    // demo, every one of its five megas is like this, George included, so a
    // fixture that set o_resource would have been testing a project state that
    // never occurs.
    {
      id: SWORD1_PLAYER,
      section: 1,
      index: 2,
      wordsBase64: words({
        [CPT.TYPE >> 2]: SwordType.PLAYER,
        [CPT.SCREEN >> 2]: 5,
        [CPT.XCOORD >> 2]: 100,
        [CPT.YCOORD >> 2]: 200,
        [CPT.WALK_RESOURCE >> 2]: 0x04050000,
      }),
    },
  ];
  (sword1 as { sections: unknown }).sections = [
    {
      ...section,
      compacts,
      offsets: compacts.map((_, index) => SWORD1_COMPACT_WORDS * index),
      words: SWORD1_COMPACT_WORDS * compacts.length,
    },
  ];
  return project;
}

describe('the cast a Broken Sword project has', () => {
  it('reads the characters off o_type and puts the player first', () => {
    const actors = sword1Actors(sword1ActorProject().sword1!);

    // The door is not here: it is NON_MEGA, which the interpreter neither
    // walks nor scales, and a cast list it appeared in would be the object
    // list with extra steps.
    expect(actors.map((actor) => actor.id)).toEqual([SWORD1_PLAYER, 0x10001, 0x10002]);
    expect(actors[0]!.isPlayer).toBe(true);
    expect(actors[0]!.type).toBe(SwordType.PLAYER);
    expect(actors[1]!.isPlayer).toBe(false);
    // The walking fields come with it, so the section can say where someone is
    // without the author opening them one at a time.
    expect(actors[1]!.screen).toBe(5);
    expect(actors[1]!.dir).toBe(3);
    expect(actors[1]!.megaResource).toBe(0x07050000);
    expect(actors[1]!.walkResource).toBe(0x05050000);
  });

  it('lists them in their own sidebar section, marked', () => {
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });

    const heads = [...editor.element.querySelectorAll('.accordion-head')];
    const actors = heads.find(
      (head) => head.querySelector('.accordion-title')?.textContent === 'Actors',
    );
    expect(actors).toBeTruthy();
    expect(actors?.querySelector('.accordion-count')?.textContent).toBe('3');

    openSection(editor.element, 'Actors');
    const rows = [
      ...(actors?.parentElement?.parentElement?.querySelectorAll('.accordion-body button') ?? []),
    ].map((button) => button.textContent);
    expect(rows[0]).toMatch(/George \(player\)/);
    expect(rows[1]).toMatch(/mega on screen 5/);
  });

  /**
   * The owner's complaint, as a test.
   *
   * "I do not have the ability to save player images." George's o_resource is
   * 0 on a project nothing has run, so a panel keyed to o_resource offered him
   * nothing at all. o_walk_resource is the word the game ships set and the
   * word `fnStand` draws him from, so it is the one the panel opens on.
   */
  it('draws the player from o_walk_resource, which is the word the game ships', () => {
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('George (player)'))
      ?.click();

    expect(editor.element.textContent).toMatch(/George \(player\)/);
    // Export is live, which is the whole of the ask: there is a picture under
    // it rather than a sentence about there not being one.
    expect(buttonNamed(editor.element, 'Export PNG')?.disabled).toBe(false);
    expect(buttonNamed(editor.element, 'Import PNG')?.disabled).toBe(false);
    expect(editor.element.textContent).toMatch(/o_walk_resource 0x04050000 is the sprite/);
    // And the old sentence is gone: o_mega_resource holds walk geometry, and
    // calling it a table of animation resources was wrong.
    expect(editor.element.textContent).toMatch(/o_mega_resource none is walk geometry/);
    expect(editor.element.textContent).not.toMatch(/table of animation resources/);
    expect(editor.element.textContent).toMatch(/Screen 5 at \(100, 200\)/);
  });

  it('offers both sprite words, o_walk_resource first, when they differ', () => {
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('0x00010002'))
      ?.click();

    const picker = editor.element.querySelector('[role="radiogroup"]');
    expect(picker).toBeTruthy();
    const labels = [...(picker?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(labels).toEqual(['o_walk_resource 0x05050000', 'o_resource 0x04050000, frame 0']);
    // One tab stop, not two: the roving group is what keeps a compact with
    // two sprite words from costing two stops between sidebar and picture.
    expect(
      [...(picker?.querySelectorAll('button') ?? [])].filter((b) => b.tabIndex === 0),
    ).toHaveLength(1);

    // The first is not in this project, so the panel refuses by name; picking
    // the second draws it.
    expect(editor.element.textContent).toMatch(/0x05050000 lives in the SYRIA cluster/);
    [...(picker?.querySelectorAll('button') ?? [])][1]?.click();
    expect(buttonNamed(editor.element, 'Export PNG')?.disabled).toBe(false);
  });

  it('names the resource when a character\u2019s sprite is on the other disc', () => {
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('mega on screen 5'))
      ?.click();

    // Which disc, by name, and what a retail install would show instead — the
    // difference between "this project is short of a cluster" and "this
    // picture cannot be drawn", which read the same before.
    expect(editor.element.textContent).toMatch(
      /0x05050000 lives in the SYRIA cluster, which swordres\.rif names and this install does not ship/,
    );
    expect(editor.element.textContent).toMatch(/A retail install has that cluster/);
    // The refusal is where the button would be, not in a doc: there is no
    // live Export sitting above a picture that was never drawn.
    expect(buttonNamed(editor.element, 'Export PNG')).toBeUndefined();
  });

  it('says an object with neither sprite word has nothing to export', () => {
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    // The floor patch has neither word, which is what this refusal is for.
    // The door beside it has o_resource and no o_walk_resource, so it keeps
    // the single panel and no picker.
    openSection(editor.element, 'Objects');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Section 1'))
      ?.click();
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('0x00010003'))
      ?.click();

    expect(editor.element.textContent).toMatch(/o_resource is 0 and it has no o_walk_resource/);
    expect(buttonNamed(editor.element, 'Export PNG')).toBeUndefined();
  });
});

describe('a Broken Sword screen background, from the screen', () => {
  it('offers the background layer as a file under the drawn screen', () => {
    const project = sword1SceneProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Screens');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Screen 5'))
      ?.click();

    expect(editor.element.textContent).toMatch(/Background — 0x04050000/);
    expect(buttonNamed(editor.element, 'Export PNG')?.disabled).toBe(false);
    expect(buttonNamed(editor.element, 'Import PNG')?.disabled).toBe(false);
  });

  it('names the missing resource where the button would be', () => {
    const project = sword1SceneProject(false);
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Screens');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Screen 5'))
      ?.click();

    // Cluster 4 is `general`, which this install *has*, so the sentence is the
    // other one: the budget passed the resource over and a retail install
    // would be no different.
    expect(editor.element.textContent).toMatch(
      /Screen 5's background: 0x04050000 lives in the GENERAL cluster, which this install does have/,
    );
    expect(editor.element.textContent).toMatch(/largest-first until the budget runs out/);
    expect(buttonNamed(editor.element, 'Export PNG')).toBeUndefined();
  });
});

/** `fnWalk`, which can only be pointed at an ObjectMega. */
const SWORD2_WALK_CODE = [
  ...[0, 0, 0, 0, 10, 20, 3].flatMap((value) => [CP.PUSH_INT32, ...le32(value)]),
  CP.CALL_MCODE,
  ...le16(15),
  7,
];

/** `fnAnim`, whose third parameter Revolution's own comment calls a resource. */
const sword2AnimCode = (resource: number): number[] => [
  ...[0, 0, resource].flatMap((value) => [CP.PUSH_INT32, ...le32(value)]),
  CP.CALL_MCODE,
  ...le16(9),
  3,
];

/**
 * `fnSetValue`, whose second parameter is a megaset resource.
 *
 * Revolution's own `// params:` block calls it "value to set it to", so the
 * generated table reads it as a plain number and only `sword2/actors.ts` knows
 * better. Real bytes here for the same reason the rest of this fixture uses
 * them: the claim is that the derivation reads the *code*.
 */
const sword2SetValueCode = (megaset: number): number[] => [
  ...[0, megaset].flatMap((value) => [CP.PUSH_INT32, ...le32(value)]),
  CP.CALL_MCODE,
  ...le16(58),
  2,
];

/**
 * A Broken Sword II project whose objects show their hands.
 *
 * Real bytecode rather than hand-built instruction records, because the whole
 * claim being tested is that the *code* is the evidence: an object is a
 * character because `fnWalk` can be pointed at nothing but an ObjectMega, and
 * a number is its art because `fnAnim`'s third parameter is a resource id.
 * Both of those are read back out of bytes here, not asserted into a fixture.
 *
 * One object walks and plays an animation this project holds; one walks and
 * names none; one does neither. Those are the three answers the Actors section
 * and the Art panel have to give.
 */
function sword2ActorProject(): Project {
  const base = sword2Project();
  const object = (id: number, name: string, code: number[]): Sword2ProjectObject => {
    const bytes = buildSword2Object(name, [[...code, CP.END_SCRIPT]], 8, 3, id);
    const layout = parseSword2Object(bytes);
    const disassembly = disassembleSword2Object(layout);
    return {
      id,
      name,
      bytesBase64: toBase64(bytes),
      instructions: disassembly.instructions,
      entries: disassembly.entries,
      unrecovered: disassembly.unrecovered,
      roundTrips: roundTripsSword2Object(layout, disassembly).ok,
      layout: {
        localsAt: layout.localsAt,
        localsBytes: layout.localsBytes,
        codeAt: layout.codeAt,
        codeBytes: layout.codeBytes,
      },
    };
  };

  return {
    ...base,
    sword2: {
      ...base.sword2!,
      animations: [
        ...base.sword2!.animations,
        // Real frames, because George's panel is the one place the ask was
        // "I cannot save a player image": a fixture with no bytes would prove
        // the derivation and leave Export disabled, which is the half that
        // was already working.
        {
          resource: 31,
          name: 'run',
          frames: 2,
          compression: 0,
          bytesBase64: toBase64(
            buildSword2Anim('run', [
              { x: 1, y: 2, width: 2, height: 2, colour: 7 },
              { x: 3, y: 4, width: 2, height: 1, colour: 8 },
            ]),
          ),
        },
      ],
      objects: [
        // A door: it pushes and ends, and calls no mega opcode at all.
        object(12, 'door', [CP.PUSH_INT32, ...le32(1)]),
        // An extra who walks and plays two animations this project holds, so
        // the object's page has a choice on it rather than one picture.
        object(14, 'pedestrian', [
          ...sword2AnimCode(30),
          ...sword2AnimCode(31),
          ...SWORD2_WALK_CODE,
        ]),
        // George: walks, and wears his megaset. This is the shipped shape —
        // measured on the demo, all 52 fnSetValue calls push a literal and
        // every one of them names an animation the project holds.
        object(8, 'george', [...SWORD2_WALK_CODE, ...sword2SetValueCode(31)]),
        // A mega whose megaset another object's script sets for it: it walks
        // and names nothing, which is the case the refusal is written for.
        object(9, 'ghost', [...SWORD2_WALK_CODE]),
      ],
    },
  };
}

describe('the cast a Broken Sword II project has', () => {
  it('reads the characters off the opcodes only a mega can be passed to', () => {
    const actors = sword2Actors(sword2ActorProject().sword2!);

    // The door is not here, and not because of its name: it calls nothing
    // that takes an ObjectMega, which is the only evidence this family has.
    expect(actors.map((actor) => actor.id)).toEqual([8, 14, 9]);
    expect(actors[0]!.isPlayer).toBe(true);
    expect(actors[0]!.evidence).toContain('fnWalk');
    expect(actors[1]!.name).toBe('pedestrian');
    expect(actors[1]!.animations).toEqual([30, 31]);
    // `fnSetValue` stays out of the evidence list: it is what dresses a mega,
    // not what proves one. The ScreenManagers that set George's megaset for
    // him would otherwise be in the cast.
    expect(actors[0]!.evidence).not.toContain('fnSetValue');
    // A mega whose megaset is set elsewhere still names nothing.
    expect(actors[2]!.name).toBe('ghost');
    expect(actors[2]!.animations).toEqual([]);
  });

  /**
   * The owner's complaint, as a test.
   *
   * "I do not have the ability to save player images." George's art is his
   * megaset, `fnSetValue` is the only opcode that sets one, and its parameter
   * is described as a bare value — so the resource rule walked straight past
   * the one object the ask was about. Measured on the demo: 1,730 frames of
   * George and Nico were in the project and unreachable from his page.
   */
  it('draws the player from the megaset fnSetValue hands him', () => {
    const project = sword2ActorProject();
    const actors = sword2Actors(project.sword2!);
    expect(actors[0]!.isPlayer).toBe(true);
    expect(actors[0]!.animations).toEqual([31]);

    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('george'))
      ?.click();

    expect(editor.element.textContent).toMatch(/1 animation named by this object’s own code: 31/);
    // Export and Import are both live on the player's own page, which is the
    // sentence the owner could not make true.
    expect(buttonNamed(editor.element, 'Export PNG')?.disabled).toBe(false);
    expect(buttonNamed(editor.element, 'Import PNG')?.disabled).toBe(false);
    // And the sentence that said his megaset was computed is gone.
    expect(editor.element.textContent).not.toMatch(/resource number the script computes/);
  });

  it('does not read a megaset pushed from a variable', () => {
    const project = sword2ActorProject();
    const george = project.sword2!.objects.find((object) => object.id === 8)!;
    // The same call with the value pushed from a local instead of as a
    // literal: a variable's *number* is not a resource id, and reading it as
    // one would put whichever animation shares that number on his page.
    const swapped: Sword2ProjectObject = {
      ...george,
      instructions: george.instructions.map((instruction) =>
        instruction.token === CP.PUSH_INT32 && instruction.operands[0] === 31
          ? { ...instruction, token: CP.PUSH_LOCAL_VAR32 }
          : instruction,
      ),
    };
    expect(sword2ObjectAnimations(project.sword2!, swapped)).toEqual([]);
  });

  it('draws an object from the animation its own code names', () => {
    const project = sword2ActorProject();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('pedestrian'))
      ?.click();

    expect(editor.element.textContent).toMatch(
      /2 animations named by this object’s own code: 30, 31/,
    );
  });

  it('offers the choice between them on one tab stop, as a radio group', () => {
    const project = sword2ActorProject();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('pedestrian'))
      ?.click();

    const picker = [...editor.element.querySelectorAll('[role="radiogroup"]')].find((group) =>
      group.getAttribute('aria-label')?.startsWith('animations named by'),
    );
    const options = [...(picker?.querySelectorAll('[role="radio"]') ?? [])];
    expect(options.map((option) => option.textContent)).toEqual(['walk (30)', 'run (31)']);
    // One tab stop for the group, arrows inside it: eleven animations must not
    // be eleven stops between the sidebar and the picture.
    expect(options.map((option) => option.getAttribute('tabindex'))).toEqual(['0', '-1']);
    expect(options[0]?.getAttribute('aria-checked')).toBe('true');

    (options[1] as HTMLButtonElement).click();
    const after = [...editor.element.querySelectorAll('[role="radiogroup"]')]
      .find((group) => group.getAttribute('aria-label')?.startsWith('animations named by'))
      ?.querySelectorAll('[role="radio"]');
    expect(after?.[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('says on the object why a walking mega has no frame to export', () => {
    const project = sword2ActorProject();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Actors');
    // `ghost` rather than George: George wears a megaset now, and the case
    // this sentence is for is a mega whose megaset another script sets.
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('ghost'))
      ?.click();

    expect(editor.element.textContent).toMatch(/This object walks — its code calls fnWalk/);
    expect(editor.element.textContent).toMatch(/megaset is set for it by another object’s script/);
    expect(buttonNamed(editor.element, 'Export PNG')).toBeUndefined();
  });

  it('keeps a resource read out of a variable off the object’s page', () => {
    const project = sword2ActorProject();
    const object = project.sword2!.objects.find((candidate) => candidate.id === 14)!;
    // The same number, pushed from a variable rather than as a literal. A
    // variable *numbered* 30 is not animation 30, and following it would put
    // some other character's art here.
    const swapped = {
      ...object,
      instructions: object.instructions.map((instruction) =>
        instruction.token === CP.PUSH_INT32
          ? { ...instruction, token: CP.PUSH_LOCAL_VAR32 }
          : instruction,
      ),
    };

    expect(sword2ObjectAnimations(project.sword2!, swapped)).toEqual([]);
  });
});

describe('both Sword sidebars as accordions', () => {
  /**
   * Forgets which sections were left open.
   *
   * The open set is deliberately sticky, and jsdom keeps one `localStorage`
   * for a whole file — so a test of what an author sees the *first* time has
   * to say that it means the first time, or it is really testing whichever
   * test above it clicked last.
   */
  function forgetSections(key: string): void {
    globalThis.localStorage?.removeItem(key);
  }

  it('opens the three sections an author starts in and folds the rest', () => {
    forgetSections(STORAGE_KEYS.editorSectionsSword1);
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });

    const open = [...editor.element.querySelectorAll('.accordion-head')]
      .filter((head) => head.getAttribute('aria-expanded') === 'true')
      .map((head) => head.querySelector('.accordion-title')?.textContent);
    expect(open).toEqual(['Screens', 'Actors', 'Objects']);
  });

  it('remembers what was opened, so a reopened editor is where it was left', () => {
    const project = sword2ActorProject();
    const first = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(first.element, 'Animations');

    const second = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const head = [...second.element.querySelectorAll('.accordion-head')].find(
      (button) => button.querySelector('.accordion-title')?.textContent === 'Animations',
    );
    expect(head?.getAttribute('aria-expanded')).toBe('true');
  });

  it('says how much is inside a section it has closed', () => {
    forgetSections(STORAGE_KEYS.editorSectionsSword1);
    const project = sword1ActorProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const heads = [...editor.element.querySelectorAll('.accordion-head')];
    const scripts = heads.find(
      (head) => head.querySelector('.accordion-title')?.textContent === 'Scripts',
    );
    expect(scripts?.getAttribute('aria-expanded')).toBe('false');
    // Closed and still counted: folding a section hides the detail, never the
    // fact that there is some.
    expect(scripts?.querySelector('.accordion-count')?.textContent).toBe('1');
    expect(scripts?.getAttribute('aria-controls')).toBe('sword1-accordion-scripts');
  });
});

/**
 * A mask layer, drawn through its grid and written back through it.
 *
 * What stood here was a refusal: the importer carried a mask's blocks and not
 * the Grid that places them, so the only honest thing the panel could say was
 * that there was no rectangle to draw. The grids are 140.7 KB for a whole demo
 * install against a 24 MB budget, so they are carried now and the mask is a
 * picture like any other — composed on the way out, taken apart on the way in.
 */
describe('a Broken Sword mask layer, laid out by its grid', () => {
  const WIDTH = 32;
  const HEIGHT = 16;
  const PITCH = WIDTH / 16 + 16;
  const HOME = 8 + 16 * PITCH;
  const MASK = 0x04050001;
  const GRID = 0x04050002;

  /** Two blocks of flat colour behind a 20-byte header. */
  function maskResource(): Uint8Array {
    const bytes = new Uint8Array(20 + 2 * 128);
    bytes.fill(11, 20, 20 + 128);
    bytes.fill(22, 20 + 128);
    return bytes;
  }

  /** A grid resource whose cells start 28 bytes in, as the format has them. */
  function gridResource(cells: Readonly<Record<number, number>>): Uint8Array {
    const bytes = new Uint8Array(28 + PITCH * (HEIGHT / 8 + 32) * 2);
    const view = new DataView(bytes.buffer);
    for (const [cell, value] of Object.entries(cells)) {
      view.setUint16(28 + Number(cell) * 2, value, true);
    }
    return bytes;
  }

  /** Screen 5, with a mask layer over its background and a grid to place it. */
  function maskProject(cells: Readonly<Record<number, number>> = { [HOME]: 1, [HOME + 1]: 2 }): {
    project: Project;
    picture: () => Sword1ProjectPicture;
  } {
    const base = sword1SceneProject();
    const room = base.sword1!.rooms[0];
    const project: Project = {
      ...base,
      sword1: {
        ...base.sword1!,
        rooms: [
          {
            ...room,
            totalLayers: 2,
            gridWidth: PITCH,
            layers: [room.layers[0], MASK, 0, 0],
            grids: [GRID, 0, 0],
          },
        ],
        pictures: [
          ...base.sword1!.pictures,
          {
            resource: MASK,
            kind: 'mask',
            width: WIDTH,
            height: HEIGHT,
            frames: 1,
            bytesBase64: toBase64(maskResource()),
            screens: [5],
            grid: { resource: GRID, pitch: PITCH, bytesBase64: toBase64(gridResource(cells)) },
          },
        ],
      },
    };
    return {
      project,
      picture: () => project.sword1!.pictures.find((one) => one.resource === MASK)!,
    };
  }

  it('offers the mask under the screen that uses it, with Import live', () => {
    const { project } = maskProject();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    openSection(editor.element, 'Screens');
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Screen 5'))
      ?.click();

    expect(editor.element.textContent).toMatch(/Mask layer 1 — 0x04050001/);
    // Two panels on the screen now — the background and the mask — and both
    // of them can be written.
    const imports = [...editor.element.querySelectorAll('button')].filter(
      (button) => button.textContent === 'Import PNG',
    );
    expect(imports.length).toBe(2);
    expect(imports.every((button) => !(button as HTMLButtonElement).disabled)).toBe(true);
  });

  it('draws the blocks where the grid puts them', () => {
    const { picture } = maskProject();
    const pixels = sword1PicturePixels(picture())!;
    expect(pixels.width).toBe(WIDTH);
    expect(pixels.height).toBe(HEIGHT);
    expect(pixels.pixels[0]).toBe(11);
    expect(pixels.pixels[16]).toBe(22);
    expect(sword1PictureRefusal(picture())).toBe(null);
  });

  it('writes an unchanged mask back byte-identically', () => {
    const { project, picture } = maskProject();
    const before = picture().bytesBase64;
    const pixels = sword1PicturePixels(picture())!;
    replaceSword1Picture(project, MASK, 0, pixels.pixels, pixels.width, pixels.height);
    expect(picture().bytesBase64).toBe(before);
  });

  it('puts edited pixels into the block the cell names, and leaves the header alone', () => {
    const { project, picture } = maskProject();
    const pixels = sword1PicturePixels(picture())!;
    const edited = new Uint8Array(pixels.pixels);
    edited[0] = 99;
    replaceSword1Picture(project, MASK, 0, edited, pixels.width, pixels.height);

    const bytes = fromBase64(picture().bytesBase64);
    expect(bytes.length).toBe(20 + 2 * 128);
    expect([...bytes.subarray(0, 20)]).toEqual(Array.from({ length: 20 }, () => 0));
    expect(bytes[20]).toBe(99);
    expect(bytes[21]).toBe(11);
    // The other block is untouched.
    expect(bytes[20 + 128]).toBe(22);
  });

  it('refuses to give one shared block two different contents, and names it', () => {
    // Both cells point at block 1, which Broken Sword stores once: painting
    // the left half differently from the right half is a thing the format
    // cannot hold, so it is refused rather than half-written.
    const { project, picture } = maskProject({ [HOME]: 1, [HOME + 1]: 1 });
    const pixels = sword1PicturePixels(picture())!;
    const edited = new Uint8Array(pixels.pixels);
    edited[0] = 99;
    expect(() =>
      replaceSword1Picture(project, MASK, 0, edited, pixels.width, pixels.height),
    ).toThrow(/shared by more than one place/);
  });

  it('refuses a size the room does not have', () => {
    const { project } = maskProject();
    expect(() => replaceSword1Picture(project, MASK, 0, new Uint8Array(4), 2, 2)).toThrow(
      /laid out by its grid/,
    );
  });
});

/**
 * `mouse.x1…y2 = box; fnRegisterMouse(&mouse)` — an object stating its rectangle.
 *
 * Real bytes, assembled and disassembled again, because the claim row 7 rests
 * on is that the rectangle is *in the code*: a fixture that asserted the
 * instructions into place would prove the reader and not the reading.
 */
const sword2MouseCode = (
  offset: number,
  box: readonly [number, number, number, number],
): number[] => [
  ...box.flatMap((value, index) => [
    CP.PUSH_INT32,
    ...le32(value),
    CP.POP_LOCAL_VAR32,
    ...le16(offset + index * 4),
  ]),
  CP.PUSH_LOCAL_ADDR,
  ...le16(offset),
  CP.CALL_MCODE,
  ...le16(8),
  1,
];

/** `fnSetStandbyCoords(x, y, 2)` — the router global, not a field of the box. */
const sword2StandbyCode = (x: number, y: number): number[] => [
  ...[x, y, 2].flatMap((value) => [CP.PUSH_INT32, ...le32(value)]),
  CP.CALL_MCODE,
  ...le16(66),
  3,
];

/** `fnRegisterFrame(&mouse, 0, 0)`: "write the sprite's own shape to the list". */
const sword2SpriteShapeCode = (offset: number): number[] => [
  CP.PUSH_LOCAL_ADDR,
  ...le16(offset),
  ...[0, 0].flatMap((value) => [CP.PUSH_INT32, ...le32(value)]),
  CP.CALL_MCODE,
  ...le16(28),
  3,
];

/** One object, built from real bytes and read back the way the editor reads it. */
function sword2CodeObject(id: number, name: string, code: readonly number[]): Sword2ProjectObject {
  const bytes = buildSword2Object(name, [[...code, CP.END_SCRIPT]], 16, 3, id);
  const layout = parseSword2Object(bytes);
  const disassembly = disassembleSword2Object(layout);
  return {
    id,
    name,
    bytesBase64: toBase64(bytes),
    instructions: disassembly.instructions,
    entries: disassembly.entries,
    unrecovered: disassembly.unrecovered,
    roundTrips: roundTripsSword2Object(layout, disassembly).ok,
    layout: {
      localsAt: layout.localsAt,
      localsBytes: layout.localsBytes,
      codeAt: layout.codeAt,
      codeBytes: layout.codeBytes,
    },
  };
}

/**
 * A screen whose session holds two movable objects and two refused ones.
 *
 * The run list carries `screen: 20`, which is the join the import makes by
 * name ("Run list for 11", "Screen 11") and the only thing in the data that
 * says which objects stand on a screen.
 */
function sword2BoxProject(): Project {
  const base = sword2SceneProject();
  return {
    ...base,
    sword2: {
      ...base.sword2!,
      objects: [
        // A door: a rectangle and the standby point its own script sets.
        sword2CodeObject(20, 'door', [
          ...sword2MouseCode(0, [100, 50, 140, 200]),
          ...sword2StandbyCode(160, 210),
        ]),
        // A sign: a rectangle and no standby point at all.
        sword2CodeObject(21, 'sign', [...sword2MouseCode(16, [300, 20, 330, 45])]),
        // Scenery: it walks and registers no mouse area.
        sword2CodeObject(22, 'scenery', [...SWORD2_WALK_CODE]),
        // An object whose mouse pointer arrives from a variable, which is the
        // rule commit 0600015 set: that number is decided at run time.
        sword2CodeObject(23, 'shifty', [
          CP.PUSH_LOCAL_VAR32,
          ...le16(0),
          CP.CALL_MCODE,
          ...le16(8),
          1,
        ]),
      ],
      runLists: [{ resource: 2, objects: [20, 21, 22, 23], screen: 20 }],
    },
  };
}

/**
 * Row 7 of `docs/editor-parity.md`, which used to be a No.
 *
 * §7a said a drag "would have to guess an offset per object". Measured over
 * the demo's 973 objects, nothing is guessed: the object pushes the offset
 * itself, as the `CP_PUSH_LOCAL_ADDR` operand of its own `fnRegisterMouse`.
 * 268 of the 973 state a rectangle that way; the other 705 are refused by
 * name, in five kinds, and those five are what the rest of this block pins.
 */
describe('a Broken Sword II object’s rectangle, read out of its own code', () => {
  const objectNamed = (name: string): Sword2ProjectObject =>
    sword2BoxProject().sword2!.objects.find((object) => object.name === name)!;

  it('reads the four coordinates the object writes, and where each is written', () => {
    const { box, why } = sword2ObjectBox(objectNamed('door'));
    expect(why).toBeNull();
    expect(box!.offset).toBe(0);
    expect([box!.x1.value, box!.y1.value, box!.x2.value, box!.y2.value]).toEqual([
      100, 50, 140, 200,
    ]);
    // Every coordinate names the instruction that writes it, because that is
    // what an edit is written through.
    expect(box!.x1.at).toHaveLength(1);
    expect(box!.anchor).toEqual({
      x: { value: 160, at: [box!.anchor!.x.at[0]] },
      y: { value: 210, at: [box!.anchor!.y.at[0]] },
    });
    expect(sword2ObjectBox(objectNamed('sign')).box!.anchor).toBeNull();
  });

  it('refuses, by name, every object whose rectangle its code does not state', () => {
    expect(sword2ObjectBox(objectNamed('scenery')).why).toBe(SWORD2_BOX_REFUSALS.noMouse);
    expect(sword2ObjectBox(objectNamed('shifty')).why).toBe(SWORD2_BOX_REFUSALS.fromVariable);

    // A literal 0 is Revolution's own "no write to mouse list", so it is the
    // no-rectangle refusal and not the variable one.
    const zero = sword2CodeObject(30, 'silent', [
      CP.PUSH_INT32,
      ...le32(0),
      CP.CALL_MCODE,
      ...le16(8),
      1,
    ]);
    expect(sword2ObjectBox(zero).why).toBe(SWORD2_BOX_REFUSALS.noMouse);

    const two = sword2CodeObject(31, 'twofold', [
      ...sword2MouseCode(0, [1, 2, 3, 4]),
      ...sword2MouseCode(16, [5, 6, 7, 8]),
    ]);
    expect(sword2ObjectBox(two).why).toBe(SWORD2_BOX_REFUSALS.manyStructures);

    // The same structure handed to fnRegisterFrame means "write the sprite's
    // shape here every cycle", so the four words would be overwritten.
    const shaped = sword2CodeObject(32, 'flag', [
      ...sword2MouseCode(0, [1, 2, 3, 4]),
      ...sword2SpriteShapeCode(0),
    ]);
    expect(sword2ObjectBox(shaped).why).toBe(SWORD2_BOX_REFUSALS.spriteShape);

    // Three coordinates as constants and one computed: no number to change.
    const partial = sword2CodeObject(33, 'half', [
      ...sword2MouseCode(0, [1, 2, 3, 4]).filter((_, index) => index >= 9),
    ]);
    expect(sword2ObjectBox(partial).why).toBe(SWORD2_BOX_REFUSALS.notLiteral);

    const branched = sword2CodeObject(34, 'either', [
      ...sword2MouseCode(0, [1, 2, 3, 4]),
      CP.PUSH_INT32,
      ...le32(99),
      CP.POP_LOCAL_VAR32,
      ...le16(0),
    ]);
    expect(sword2ObjectBox(branched).why).toBe(SWORD2_BOX_REFUSALS.manyValues);
  });

  it('moves the rectangle by rewriting the operands that state it', () => {
    const project = sword2BoxProject();
    const door = sword2ScreenBox(project.sword2!, 20, 20)!;
    moveSword2Box(project, door, 110, 40);

    const moved = sword2ScreenBox(project.sword2!, 20, 20)!;
    expect([moved.x1.value, moved.y1.value, moved.x2.value, moved.y2.value]).toEqual([
      110, 40, 150, 190,
    ]);
    // The width and height are untouched: a drag moves a rectangle, it does
    // not resize one.
    expect(moved.x2.value - moved.x1.value).toBe(40);
    // And the standby point stays where the script put it. It is the router's
    // global stand-here target (`walker.cpp`), set by this object before its
    // own walk or stand call — measured over the demo, 49 of the 57 movable
    // objects that set one put it inside the rectangle or within 100px, and 8
    // put it as far as 636px away, so nothing in the data ties it to the box.
    expect(moved.anchor!.x.value).toBe(160);
    expect(moved.anchor!.y.value).toBe(210);
  });

  it('outlines the movable objects and names the refused ones, per screen', () => {
    const sword2 = sword2BoxProject().sword2!;
    const items = sword2ScreenItems(sword2, 20);
    expect(items.map((item) => item.name)).toEqual(['door', 'sign']);
    expect(items[0]).toMatchObject({
      id: 20,
      x: 100,
      y: 50,
      width: 40,
      height: 150,
      anchor: { x: 160, y: 210 },
    });
    expect(items[1]!.anchor).toBeNull();

    expect(sword2ScreenRefusals(sword2, 20).map((refusal) => refusal.name)).toEqual([
      'scenery',
      'shifty',
    ]);
    expect(sword2ScreenDragNote(sword2, 20)).toContain('2 of the 4 objects');
    expect(sword2ScreenDragNote(sword2, 20)).toContain('1 of them also set a standby point');
  });

  it('leaves a read-only view of a screen without a move at all', () => {
    const project = sword2BoxProject();
    const readOnly = sword2ScreenModel(20, {
      project: () => project.sword2!,
      selected: () => null,
      select: () => {},
    });
    expect(readOnly.move).toBeUndefined();
    expect(readOnly.immovable).toBe(SWORD2_IMMOVABLE);

    const writable = sword2ScreenModel(20, {
      project: () => project.sword2!,
      selected: () => null,
      select: () => {},
      update: (mutate) => mutate(project),
    });
    writable.move!(20, 200, 100);
    expect(sword2ScreenBox(project.sword2!, 20, 20)!.x1.value).toBe(200);
    // An id this screen has no rectangle for is a no-op, not a throw: the
    // canvas can only offer what `items` listed, and a refused object must
    // stay refused if one ever reaches here.
    writable.move!(22, 10, 10);
    expect(sword2ScreenBox(project.sword2!, 20, 22)).toBeNull();
  });
});

/** `fnSetStandbyCoords(globalVar a, globalVar b, 2)` — commit 0600015's case. */
const sword2StandbyFromGlobals = (x: number, y: number): number[] => [
  CP.PUSH_GLOBAL_VAR32,
  ...le16(x),
  CP.PUSH_GLOBAL_VAR32,
  ...le16(y),
  CP.PUSH_INT32,
  ...le32(2),
  CP.CALL_MCODE,
  ...le16(66),
  3,
];

/**
 * Row 8 of `docs/editor-parity.md`, which was a No for two reasons and had
 * measured only one of them.
 *
 * The measured one holds and is kept: of the demo's 57 movable objects that set
 * one literal standby point, 49 put it within 100px of their rectangle on both
 * axes and 8 put it as far as 636px away, so a box drag must not shift it. What
 * was never proved is the second claim the row rested on — that the point could
 * therefore not be edited at all. `fnSetStandbyCoords(x, y, dir)` is Sword II's
 * own way of saying "stand here to use this", its x and y are two
 * `CP_PUSH_INT32`s in the object's own code, and they are written by the same
 * `editSword2Operand` route row 7's four coordinates go through. So the point
 * has a handle of its own, and the box drag still leaves it alone.
 */
describe('a Broken Sword II standby point, moved on a handle of its own', () => {
  const screen = (extra: readonly Sword2ProjectObject[] = []): Project => {
    const project = sword2BoxProject();
    const sword2 = project.sword2!;
    return {
      ...project,
      sword2: {
        ...sword2,
        objects: [...sword2.objects, ...extra],
        runLists: [
          {
            resource: 2,
            objects: [...sword2.runLists[0].objects, ...extra.map((o) => o.id)],
            screen: 20,
          },
        ],
      },
    };
  };

  it('reads the point out of every fnSetStandbyCoords the object makes', () => {
    const project = sword2BoxProject();
    const door = sword2ScreenBox(project.sword2!, 20, 20)!;
    expect(door.anchor!.x.value).toBe(160);
    expect(door.anchor!.y.value).toBe(210);
    expect(door.anchorWhy).toBeNull();

    // An object that sets the same point twice is one point, and both writes
    // are named, so moving it keeps the two branches in step.
    const twice = sword2CodeObject(40, 'twice', [
      ...sword2MouseCode(0, [10, 10, 20, 20]),
      ...sword2StandbyCode(60, 70),
      ...sword2StandbyCode(60, 70),
    ]);
    const box = sword2ObjectBox(twice).box!;
    expect(box.anchor!.x.at).toHaveLength(2);
    expect(box.anchor!.y.at).toHaveLength(2);

    // No call at all is not a refusal: it is an object with nothing to say
    // about where you stand, and 183 of the demo's 268 movable objects are one.
    const sign = sword2ObjectBox(
      sword2BoxProject().sword2!.objects.find((object) => object.name === 'sign')!,
    ).box!;
    expect(sign.anchor).toBeNull();
    expect(sign.anchorWhy).toBeNull();
  });

  it('refuses, by name, a point it would otherwise have to guess at', () => {
    // Two different points: the old reader took the first and passed over the
    // second, which would have drawn a handle that moved one of an object's two
    // answers and silently left the other behind.
    const branched = sword2CodeObject(41, 'branched', [
      ...sword2MouseCode(0, [10, 10, 20, 20]),
      ...sword2StandbyCode(60, 70),
      ...sword2StandbyCode(300, 90),
    ]);
    const many = sword2ObjectBox(branched).box!;
    expect(many.anchor).toBeNull();
    expect(many.anchorWhy).toBe(SWORD2_STANDBY_REFUSALS.manyPoints);

    // Commit 0600015's rule, on a coordinate rather than on a pointer: never
    // follow a value pushed from a variable. One object on the demo does this
    // (`passing_train_72`, from globals 141 and 142) and it registers no mouse
    // area, so the rule is written before it is ever reached on a canvas.
    const global = sword2CodeObject(42, 'train', [
      ...sword2MouseCode(0, [10, 10, 20, 20]),
      ...sword2StandbyFromGlobals(141, 142),
    ]);
    expect(sword2ObjectBox(global).box!.anchorWhy).toBe(SWORD2_STANDBY_REFUSALS.fromVariable);

    // A coordinate the script computes is a coordinate with no number in it:
    // `OP_PLUS` leaves the x on the stack and leaves nothing in the code to
    // change.
    const computed = sword2CodeObject(43, 'computed', [
      ...sword2MouseCode(0, [10, 10, 20, 20]),
      CP.PUSH_INT32,
      ...le32(50),
      CP.PUSH_INT32,
      ...le32(10),
      CP.OP_PLUS,
      CP.PUSH_INT32,
      ...le32(70),
      CP.PUSH_INT32,
      ...le32(2),
      CP.CALL_MCODE,
      ...le16(66),
      3,
    ]);
    expect(sword2ObjectBox(computed).box!.anchorWhy).toBe(SWORD2_STANDBY_REFUSALS.notLiteral);

    // And a refused point is drawn nowhere rather than drawn at one of its
    // several places.
    const items = sword2ScreenItems(screen([branched]).sword2!, 20);
    expect(items.find((item) => item.name === 'branched')!.anchor).toBeNull();
  });

  it('writes the two operands, and leaves the rectangle exactly where it was', () => {
    const project = sword2BoxProject();
    moveSword2Standby(project, sword2ScreenBox(project.sword2!, 20, 20)!, 300, 250);

    const moved = sword2ScreenBox(project.sword2!, 20, 20)!;
    expect([moved.anchor!.x.value, moved.anchor!.y.value]).toEqual([300, 250]);
    // The rectangle is untouched, which is the other half of the same claim.
    expect([moved.x1.value, moved.y1.value, moved.x2.value, moved.y2.value]).toEqual([
      100, 50, 140, 200,
    ]);
    // The edit is an ordinary script edit, so the object still re-emits.
    expect(project.sword2!.objects.find((object) => object.id === 20)!.roundTrips).toBe(true);

    // Every call is rewritten, not only the first: an object that sets the same
    // point in two branches keeps both of them in step.
    const twice = screen([
      sword2CodeObject(40, 'twice', [
        ...sword2MouseCode(0, [10, 10, 20, 20]),
        ...sword2StandbyCode(60, 70),
        ...sword2StandbyCode(60, 70),
      ]),
    ]);
    moveSword2Standby(twice, sword2ScreenBox(twice.sword2!, 20, 40)!, 11, 12);
    const after = sword2ScreenBox(twice.sword2!, 20, 40)!;
    expect([after.anchor!.x.value, after.anchor!.y.value]).toEqual([11, 12]);
    expect(after.anchor!.x.at).toHaveLength(2);
  });

  it('still leaves the point alone when the box is dragged, and says why', () => {
    // §8a's measurement, which is the reason and which stays the reason: on the
    // demo 8 of the 57 points sit hundreds of pixels from their own rectangle,
    // so a delta applied to both would be right about most and quietly wrong
    // about the rest.
    const project = sword2BoxProject();
    moveSword2Box(project, sword2ScreenBox(project.sword2!, 20, 20)!, 110, 40);
    const moved = sword2ScreenBox(project.sword2!, 20, 20)!;
    expect([moved.anchor!.x.value, moved.anchor!.y.value]).toEqual([160, 210]);
  });

  it('gives the point a handle of its own on the canvas, pointer and keyboard', () => {
    const project = sword2BoxProject();
    const model: SceneModel = {
      ...sword2ScreenModel(20, {
        project: () => project.sword2!,
        selected: () => 20,
        select: () => {},
        update: (mutate) => mutate(project),
      }),
      // A screen the size of a real one: the fixture's own bytes decode to 4x2,
      // and `sceneAnchorNudge` clamps to the picture.
      picture: () => ({
        width: 640,
        height: 400,
        pixels: new Uint8Array(640 * 400),
        palette: [[0, 0, 0]],
      }),
    };

    // The family's own word for it, which is ADR 0013's standard: a Sword II
    // author told "walk-to point" would go looking for a field the format has
    // never had.
    expect(sceneAnchorLabel(model)).toBe('standby point');

    // The handle is found before the rectangle it belongs to, and only within a
    // few pixels of where it is drawn.
    expect(sceneAnchorAt(model, 161, 211)!.id).toBe(20);
    expect(sceneAnchorAt(model, 200, 211)).toBeNull();
    // Only the picked object's: the handle is drawn for that one alone, and a
    // handle grabbable where nothing is drawn moves something invisible.
    expect(sceneAnchorAt({ ...model, selected: () => 21 }, 160, 210)).toBeNull();
    // And it is announced under the cursor, because a four-pixel dot is not
    // something a keyboard author can find by looking.
    expect(describeScenePoint(model, 160, 210)).toContain('door’s standby point');

    // Alt with an arrow is the drag, one pixel or eight.
    expect(sceneAnchorNudge(model, 20, 'ArrowRight', 8)).toEqual({
      kind: 'move',
      id: 20,
      x: 168,
      y: 210,
    });
    model.moveAnchor!(20, 168, 210);
    expect(sword2ScreenBox(project.sword2!, 20, 20)!.anchor!.x.value).toBe(168);
  });

  it('offers no handle at all on a view that cannot write, or where there is no point', () => {
    const project = sword2BoxProject();
    const readOnly = sword2ScreenModel(20, {
      project: () => project.sword2!,
      selected: () => 20,
      select: () => {},
    });
    expect(readOnly.moveAnchor).toBeUndefined();
    expect(sceneAnchorAt(readOnly, 160, 210)).toBeNull();
    expect(sceneAnchorNudge(readOnly, 20, 'ArrowRight', 1)).toEqual({
      kind: 'refuse',
      message: 'This standby point cannot be moved.',
    });

    // `sign` sets none, so there is nothing to grab where it stands.
    const writable = sword2ScreenModel(20, {
      project: () => project.sword2!,
      selected: () => 21,
      select: () => {},
      update: (mutate) => mutate(project),
    });
    expect(sceneAnchorAt(writable, 300, 20)).toBeNull();
    expect(sceneAnchorNudge(writable, 21, 'ArrowRight', 1)).toEqual({
      kind: 'refuse',
      message: 'There is no standby point selected to move.',
    });
  });

  it('counts the points on the screen and names the ones it will not move', () => {
    const branched = sword2CodeObject(41, 'branched', [
      ...sword2MouseCode(0, [10, 10, 20, 20]),
      ...sword2StandbyCode(60, 70),
      ...sword2StandbyCode(300, 90),
    ]);
    const sword2 = screen([branched]).sword2!;
    const note = sword2ScreenDragNote(sword2, 20);
    expect(note).toContain('1 of them also set a standby point');
    expect(note).toContain('handle of its own');
    expect(note).toContain('1 other sets a standby point this editor will not move');

    // And the editor surface says the same thing, in two lists rather than
    // one: `branched`'s rectangle drags while its standby point does not, and
    // one list would have told its author the door cannot be moved.
    const project = screen([branched]);
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent?.startsWith('Screen 20'))
      ?.click();
    const text = editor.element.textContent ?? '';
    expect(text).toContain(`branched ${SWORD2_STANDBY_REFUSALS.manyPoints}`);
    expect(text).toContain(`shifty ${SWORD2_BOX_REFUSALS.fromVariable}`);

    const refused = sword2ScreenStandbyRefusals(sword2, 20);
    expect(refused.map((entry) => entry.name)).toEqual(['branched']);
    expect(refused[0].why).toBe(SWORD2_STANDBY_REFUSALS.manyPoints);
    // And it is a different list from row 7's: `branched`'s rectangle drags.
    expect(sword2ScreenRefusals(sword2, 20).map((entry) => entry.name)).not.toContain('branched');
  });
});

describe('adding and removing a record through the surface', () => {
  /*
   * Row 12 of `docs/editor-parity.md` reaching the left column, which is what
   * the SCUMM surface's `+ Room` and `+ Actor` are and what parity means here.
   * The refusals are on the buttons' titles rather than in an alert, so the
   * reason is readable before the click rather than after it.
   */

  it('adds a compact to a Sword 1 section and then takes it away again', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const buttons = () => [...editor.element.querySelectorAll('button')];
    buttons()
      .find((button) => button.textContent?.startsWith('Section 1'))
      ?.click();

    const before = project.sword1!.sections[0].compacts.length;
    buttons()
      .find((button) => button.textContent === '+ Object')
      ?.click();
    expect(project.sword1!.sections[0].compacts.length).toBe(before + 1);
    // The new object is selected, which is what an author wants next.
    expect(editor.element.textContent).toContain('Object 0x00010001');

    buttons()
      .find((button) => button.textContent?.startsWith('Section 1'))
      ?.click();
    const remove = buttons().find((button) => button.textContent === 'Delete object 1');
    expect(remove?.disabled).toBe(false);
    remove?.click();
    expect(project.sword1!.sections[0].compacts.length).toBe(before);
  });

  it('offers only the last Sword 1 compact, and says why on the button', () => {
    const project = sword1Project();
    const editor = new Sword1Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const buttons = () => [...editor.element.querySelectorAll('button')];
    buttons()
      .find((button) => button.textContent?.startsWith('Section 1'))
      ?.click();
    buttons()
      .find((button) => button.textContent === '+ Object')
      ?.click();
    buttons()
      .find((button) => button.textContent?.startsWith('Section 1'))
      ?.click();
    // The button names the last record and nothing else, and asking for object
    // 0 says why: its index is its name, and renumbering is the refusal.
    expect(buttons().some((button) => button.textContent === 'Delete object 0')).toBe(false);
    expect(sword1CompactDeleteRefusal(project, 1, 0)).toMatch(/not the last/);
  });

  it('copies a Sword II object onto the end of the index and removes it again', () => {
    const project = sword2Project();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const buttons = () => [...editor.element.querySelectorAll('button')];
    buttons()
      .find((button) => button.textContent?.startsWith('george'))
      ?.click();
    buttons()
      .find((button) => button.textContent === '+ Object')
      ?.click();
    expect(project.sword2!.objects.length).toBe(2);
    expect(project.sword2!.objects[1].id).toBe(32);
    expect(project.sword2!.objects[1].appendedFrom).toBe(8);
    expect(project.sword2!.resourceCount).toBe(33);

    const remove = buttons().find((button) => button.textContent?.startsWith('Delete george_COPY'));
    expect(remove?.disabled).toBe(false);
    remove?.click();
    expect(project.sword2!.objects.length).toBe(1);
    expect(project.sword2!.resourceCount).toBe(32);
  });

  it('says on the button why a Sword II object the game shipped cannot go', () => {
    const project = sword2Project();
    const editor = new Sword2Editor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    const buttons = () => [...editor.element.querySelectorAll('button')];
    buttons()
      .find((button) => button.textContent?.startsWith('george'))
      ?.click();
    const remove = buttons().find((button) => button.textContent?.startsWith('Delete george'));
    expect(remove?.disabled).toBe(true);
    expect(remove?.title).toMatch(/renumber/);
  });
});
