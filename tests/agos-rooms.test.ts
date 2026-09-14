import { describe, expect, it } from 'vitest';
import { readAgosRooms } from '../src/authoring/agos/rooms.js';
import { renderRoomBackdrop, vgaTableFor } from '../src/editor/agos/roomBackdrop.js';
import { ITEM_CHILD_TYPES, type AgosItem } from '../src/engine/agos/world/itemTree.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import type { AgosSubroutine } from '../src/engine/agos/script/subroutines.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import { readAgosArchive } from '../src/engine/agos/resource/gameArchive.js';
import { buildGraphicsArchive } from './fixtureAgos.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'floppy',
  platform: 'dos',
};

/**
 * Looked up rather than written down.
 *
 * The tables are generated from the reference (ADR 0029), so a number typed
 * here would be a second copy of one of their entries — and the wrong one the
 * day a table is regenerated.
 */
const PICTURE = OPCODE_NAMES.simon1!.indexOf('o_picture');

/** An item with nothing on it, which is what most items are. */
function plainItem(children: AgosItem['children'] = []): AgosItem {
  return {
    adjective: 0,
    noun: 0,
    state: 0,
    next: { raw: 0xffffffff },
    child: { raw: 0xffffffff },
    parent: { raw: 0xffffffff },
    trailing: [0],
    classFlags: 0,
    childrenLead: children.length > 0 ? 1 : 0,
    children,
  };
}

/** An item that is a room: a room record naming a Subroutine and its exits. */
function roomItem(subroutine: number, exitStates = 0): AgosItem {
  return plainItem([{ type: ITEM_CHILD_TYPES.room, header: [subroutine, exitStates], values: [] }]);
}

/** A Subroutine that puts one picture up, by literal id. */
function withPicture(id: number, picture: number): AgosSubroutine {
  return {
    id,
    endMarker: 0,
    lines: [
      {
        instructions: [{ opcode: PICTURE, operands: [{ kind: 'word', value: picture }] }],
      },
    ],
  } as AgosSubroutine;
}

describe('which items are rooms, and what each one draws', () => {
  it('finds a room by its sub-structure and its picture by reading its script', () => {
    // The two halves this file exists to join: a room is an item record, and
    // what it looks like is an `o_picture` in a Subroutine that usually lives
    // in a TABLES file rather than in GAMEPC.
    const found = readAgosRooms([roomItem(10101), plainItem()], SIMON1, (id) =>
      id === 10101 ? withPicture(id, 9600) : undefined,
    );

    expect(found.rooms).toEqual([
      { item: 2, subroutine: 10101, exits: 0, picture: 9600, zone: 96 },
    ]);
    expect(found.unreadableSubroutines).toEqual([]);
  });

  it('takes the zone from the picture id’s hundreds column, as the engine does', () => {
    // `setWindowImage` is `zone = Math.floor(image / 100)`, and this has to
    // agree with it or the editor reads a different zone than the game draws.
    const found = readAgosRooms([roomItem(1)], SIMON1, (id) => withPicture(id, 16000));

    expect(found.rooms[0]).toMatchObject({ picture: 16000, zone: 160 });
  });

  it('counts a room’s exits out of the same word that holds their states', () => {
    // Two bits per exit and six exits; a non-zero pair means the exit is there.
    // The mask is what sized the record's destination list, which is why it can
    // be counted rather than looked up. Read from the low pair up this is
    // 10, 00, 11, 00, 01, 00 — three exits present and three absent.
    const found = readAgosRooms([roomItem(1, 0b00_01_00_11_00_10)], SIMON1, (id) =>
      withPicture(id, 100),
    );

    expect(found.rooms[0]?.exits).toBe(3);
  });

  it('names a room whose picture is a variable rather than guessing one', () => {
    // What a variable holds is a fact about a running game. A room whose scene
    // is chosen as the game goes along is honestly a room this cannot name.
    const script: AgosSubroutine = {
      id: 1,
      endMarker: 0,
      lines: [
        {
          instructions: [{ opcode: PICTURE, operands: [{ kind: 'byte', value: 0, variable: 5 }] }],
        },
      ],
    } as AgosSubroutine;
    const found = readAgosRooms([roomItem(1)], SIMON1, () => script);

    expect(found.rooms[0]).toEqual({ item: 2, subroutine: 1, exits: 0 });
    expect(found.rooms[0]?.picture).toBeUndefined();
  });

  it('takes the first picture, because a script can put up several', () => {
    // A scene that changes as the game goes on names each version of itself.
    // The first is what an arriving player sees, so it is the one that stands
    // for the room; the run of them is not a list of rooms.
    const script: AgosSubroutine = {
      id: 1,
      endMarker: 0,
      lines: [
        { instructions: [{ opcode: PICTURE, operands: [{ kind: 'word', value: 4200 }] }] },
        { instructions: [{ opcode: PICTURE, operands: [{ kind: 'word', value: 4300 }] }] },
      ],
    } as AgosSubroutine;

    expect(readAgosRooms([roomItem(1)], SIMON1, () => script).rooms[0]?.picture).toBe(4200);
  });

  it('still lists a room whose Subroutine was not found, and says which', () => {
    // A missing Subroutine means the table files were not read — a packaging
    // fact an author can act on — where a runtime picture is the game being
    // itself. Worth telling apart, and neither is a reason to drop the room.
    const found = readAgosRooms([roomItem(10101)], SIMON1, () => undefined);

    expect(found.rooms).toEqual([{ item: 2, subroutine: 10101, exits: 0 }]);
    expect(found.unreadableSubroutines).toEqual([10101]);
  });

  it('lists no rooms for a game whose items carry no room record', () => {
    expect(readAgosRooms([plainItem(), plainItem()], SIMON1, () => undefined).rooms).toEqual([]);
  });
});

describe('drawing a room’s backdrop', () => {
  /** The fixture archive's two halves, which hold one image and its script. */
  function resources(): { scripts: Uint8Array; pixels: Uint8Array } {
    const archive = readAgosArchive(buildGraphicsArchive());
    return { scripts: archive.read(0)!, pixels: archive.read(1)! };
  }

  it('runs the picture’s own script rather than decoding a table slot', () => {
    // The whole point of this module. A backdrop is composed by a VGA script in
    // the *script* resource; the Art tab's `decodeZoneImage` reads the pixel
    // table, and reading a backdrop that way gives a different picture.
    const { scripts, pixels } = resources();
    const drawn = renderRoomBackdrop({ scripts, pixels, picture: 1, version: 'Simon1' });

    expect(typeof drawn).not.toBe('string');
    if (typeof drawn === 'string') return;
    // Trimmed to what the script painted rather than left at the buffer's own
    // 960 by 240 — which is what stops all but the widest room in either game
    // coming back as a small picture in a large empty frame.
    expect(drawn.width).toBe(4);
    expect(drawn.height).toBeGreaterThan(0);
    expect(drawn.width * drawn.height).toBe(drawn.pixels.length);
    // Real indices out of the fixture's pixel bytes, not a field of zero.
    expect(new Set(drawn.pixels).size).toBeGreaterThan(1);
    expect(drawn.colours).toBeGreaterThan(1);
  });

  it('says the resource holds no such picture instead of drawing something else', () => {
    // The failure this guards against is the one ADR 0034 is about: a wrong id
    // that happened to hit another entry would render plausible nonsense.
    const { scripts, pixels } = resources();
    const drawn = renderRoomBackdrop({ scripts, pixels, picture: 4700, version: 'Simon1' });

    expect(drawn).toContain('no picture 4700');
  });

  it('says a script drew nothing rather than showing an empty room', () => {
    // About a third of a Version's VGA opcodes ask the running game questions,
    // and a picture drawn outside the game has to answer no. A script whose
    // scene is inside such a branch paints nothing — measured on the retail
    // games at 2 of Simon 1's 92 rooms and 12 of Simon 2's 67.
    const { scripts, pixels } = resources();
    // A resource whose script table is intact and whose pixels are not: the
    // script runs, the draw finds nothing, and the buffer stays one colour.
    const drawn = renderRoomBackdrop({
      scripts,
      pixels: new Uint8Array(pixels.length),
      picture: 1,
      version: 'Simon1',
    });

    expect(drawn).toContain('drew nothing');
  });

  it('decodes each Version’s graphics scripts with its own table', () => {
    // The same seven-way split `AgosEngine.vgaTable` makes. Two games sharing a
    // table would decode one of them as the other, which is a script that runs
    // and draws the wrong thing.
    expect(vgaTableFor('Simon1')).toBe('simon1');
    expect(vgaTableFor('Simon2')).toBe('simon2');
    expect(vgaTableFor('Feeble')).toBe('feeblefiles');
  });
});
