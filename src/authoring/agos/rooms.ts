/**
 * Which of a game's items are rooms, and what each one draws behind itself.
 *
 * ## A room is an item, and its picture is in a script
 *
 * AGOS has no room table. `AgosEngine.currentRoom` is `parentOf(me)` — where
 * the player is *is* an item — and an item counts as a room when it carries a
 * sub-structure of type {@link ITEM_CHILD_TYPES.room}. That record holds a
 * Subroutine number and an exit mask, and **not** a backdrop: nothing in
 * `GAMEPC` says what a room looks like.
 *
 * The backdrop is in the Subroutine. `oe2_doTable item:special(9)` runs the
 * room's own Subroutine when the player arrives, and that Subroutine puts the
 * scene up with `o_picture`. So finding a room's picture means reading its
 * script, which is why this file exists rather than the room record being read
 * directly into a field.
 *
 * Measured on the retail games: **92 of 92** Simon 1 rooms and **65 of 67**
 * Simon 2 rooms carry a literal `o_picture`. The two that do not are rooms
 * whose picture is chosen at runtime, and they are reported as rooms with no
 * picture rather than left out — a room the editor cannot draw is still a room.
 *
 * ## Why the Subroutines have to be handed in
 *
 * A room's Subroutine is almost never in `GAMEPC`. Simon 1 keeps them in
 * `TABLES01` and up, reached through `resource/tableSource.ts` — the same
 * reason `AgosEngine` needs that reader to run a single line of the game. So
 * this takes a lookup rather than a block: the caller is the one holding both
 * halves, and `importAgosProject` is handed only the base file.
 *
 * ## The picture id is not an image number
 *
 * `o_picture(id, window)` reaches `setWindowImage`, and there the zone is the
 * id's hundreds column while the **whole id** keys an entry in that zone's
 * *script* resource. That entry is a VGA script rather than a pixel table slot,
 * so a room's backdrop is something a script paints and not something a decoder
 * unpacks — which is why {@link AgosRoom} carries the id and the zone and stops
 * there. Drawing it is `editor/agos/roomBackdrop.ts`.
 */

import { ITEM_CHILD_TYPES, type AgosItem } from '../../engine/agos/world/itemTree.js';
import { opcodeTableFor, type AgosTarget } from '../../engine/agos/agosVersion.js';
import { opcodeName } from '../../engine/agos/script/opcodeNames.js';
import type { AgosSubroutine } from '../../engine/agos/script/subroutines.js';

/** One room: the item it is, and the picture its own script puts up. */
export interface AgosRoom {
  /** The item number, which is what a room is in AGOS. */
  readonly item: number;
  /** The Subroutine `oe2_doTable` runs on arrival — usually in a `TABLES` file. */
  readonly subroutine: number;
  /**
   * The id its script hands `o_picture`, where it hands one a literal.
   *
   * Absent for a room whose picture is a variable, and absent for a room whose
   * Subroutine was not found. Both mean "this editor cannot say what this room
   * looks like", which is worth showing as a room without a picture.
   */
  readonly picture?: number;
  /** The zone that picture is in: the id's hundreds column, as everywhere. */
  readonly zone?: number;
  /** How many exits the record's mask says the room has. */
  readonly exits: number;
}

/** What a room list amounts to, and what it could not answer. */
export interface AgosRooms {
  readonly rooms: readonly AgosRoom[];
  /**
   * Rooms whose Subroutine the lookup did not have.
   *
   * Named rather than folded into "no picture": a Subroutine that is missing
   * means the table files were not read, which is a packaging problem the
   * author can act on, while a picture chosen at runtime is the game being
   * itself.
   */
  readonly unreadableSubroutines: readonly number[];
}

/**
 * Reads the room list off the item tree.
 *
 * `items` is indexed from item 2, the way `AgosProject.items` is: the first two
 * item numbers are predefined and are not in the file.
 */
export function readAgosRooms(
  items: readonly AgosItem[],
  target: AgosTarget,
  subroutineFor: (id: number) => AgosSubroutine | undefined,
): AgosRooms {
  // Names come per game; lengths come per game and release kind, and only the
  // names are wanted here — the same trim `disassemble.ts` makes.
  const table = opcodeTableFor(target).replace(/talkie|dos$/, '');
  const rooms: AgosRoom[] = [];
  const unreadable: number[] = [];

  for (const [index, item] of items.entries()) {
    const record = item.children.find((child) => child.type === ITEM_CHILD_TYPES.room);
    if (!record) continue;

    const subroutine = record.header?.[0] ?? 0;
    const exits = countExits(record.header?.[1] ?? 0);
    const script = subroutineFor(subroutine);
    if (!script) {
      unreadable.push(subroutine);
      rooms.push({ item: index + 2, subroutine, exits });
      continue;
    }

    const picture = pictureIn(script, table);
    rooms.push({
      item: index + 2,
      subroutine,
      exits,
      ...(picture === undefined ? {} : { picture, zone: Math.floor(picture / 100) }),
    });
  }

  return { rooms, unreadableSubroutines: unreadable };
}

/**
 * The first picture the Subroutine puts up.
 *
 * The *first*, because a room's script can put up more than one — a scene that
 * changes as the game goes on names each version, and the run of them is not a
 * list of rooms. The first is the one an arriving player sees, so it is the one
 * that stands for the room.
 *
 * A variable operand is skipped rather than resolved. What a variable holds is
 * a fact about a running game, and this reads a file; a room whose picture is
 * computed is honestly a room this cannot name.
 */
function pictureIn(script: AgosSubroutine, table: string): number | undefined {
  for (const line of script.lines) {
    for (const instruction of line.instructions) {
      if (opcodeName(table, instruction.opcode) !== 'o_picture') continue;
      const first = instruction.operands[0];
      if (!first) continue;
      if (first.kind === 'byte' && first.variable !== undefined) continue;
      if (first.kind === 'word' || first.kind === 'byte' || first.kind === 'raw') {
        return first.value;
      }
    }
  }
  return undefined;
}

/**
 * How many exits a room has, from the word that also holds their states.
 *
 * Two bits per exit and six exits: a non-zero pair means that exit is present.
 * The same counting `AgosInterpreter.exitOf` does, and for the same reason —
 * the mask is what sized the record's list of destinations.
 */
function countExits(states: number): number {
  let found = 0;
  for (let index = 0, bits = states; index !== 6; index += 1, bits >>= 2) {
    if (bits & 3) found += 1;
  }
  return found;
}
