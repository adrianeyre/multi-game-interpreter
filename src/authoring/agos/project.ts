/**
 * The editable form of an AGOS game.
 *
 * ADR 0029 settles what this holds, and it is three things rather than one:
 *
 * 1. **Subroutines as instruction lists**, edited at that level — ADR 0005's
 *    model, which applies here for the same reason it applied to v6
 * 2. **The item tree, by name**, because an instruction says *item 217* and
 *    nothing else in the game says what 217 is
 * 3. **Pooled strings by index**, which is ADR 0009's shape and not AGI's: many
 *    Subroutines point at one table, so an edit's reach is real and the editor
 *    has to be able to show it
 *
 * ## Editing is offered only when three things are true
 *
 * The opcode table an AGOS game decodes with is this project's rather than the
 * game's, so ADR 0029 sets a bar that is higher than "it parsed":
 *
 * - the Version was **probed**, not assumed
 * - **Structural agreement** holds over the whole game
 * - the game **re-emits byte for byte**
 *
 * There is deliberately no declared-by-the-author route past that, unlike AGI's
 * (ADR 0013). AGI needs one because a dump can be missing the evidence
 * entirely; an AGOS game's bytes say which game they are, so a declaration
 * would only let someone assert past a check that can actually be run.
 *
 * ## What "Unrecovered" means here, and why it is coarse
 *
 * `GAMEPC` has no index. Every other family in this repo can mark one script
 * `Unrecovered` and carry on, because the container addresses its resources
 * separately. AGOS cannot: ADR 0030 rebuilds the file whole, so a region that
 * will not re-emit takes the game with it. The count below is therefore per
 * game rather than per Subroutine, and that coarseness is a property of the
 * format rather than a shortcut.
 */

import { readsWholeGame, type AgosDetection } from '../../engine/agos/resource/agosDetect.js';
import { readGamePc, writeGamePc, type AgosGamePc } from '../../engine/agos/resource/gamePc.js';
import { checkStructuralAgreement } from '../../engine/agos/script/structuralAgreement.js';
import { writeSubroutineBlock } from '../../engine/agos/script/subroutines.js';
import type { AgosTarget } from '../../engine/agos/agosVersion.js';
import type { ZoneSource } from '../../engine/agos/resource/zoneSource.js';
import { readAgosArt, type AgosArt } from './images.js';
import { readAgosRooms, type AgosRooms } from './rooms.js';
import type { AgosSubroutine } from '../../engine/agos/script/subroutines.js';
import {
  childrenOf,
  itemIdOf,
  type AgosItem,
  type AgosItemTree,
} from '../../engine/agos/world/itemTree.js';
import type { Target } from '../target.js';

/** An item as the editor talks about it: a number, a name, and where it sits. */
export interface NamedItem {
  readonly id: number;
  /**
   * A name for a person to read.
   *
   * AGOS items carry no name of their own in the Versions that matter, so this
   * is derived from the item's own fields — its noun and adjective index the
   * string pool. Derived rather than stored, because storing it would make it a
   * second source of truth that export would have to reconcile.
   */
  readonly name: string;
  readonly parent: number;
  readonly children: readonly number[];
  readonly item: AgosItem;
}

export interface AgosProject {
  readonly target: Target & { engine: 'agos' };
  readonly game: AgosGamePc;
  /** The item tree, addressable the way the editor talks about it. */
  readonly items: readonly NamedItem[];
  /** The pooled strings, by the index a Subroutine's operand carries. */
  readonly strings: readonly string[];
  /** Whether ADR 0029's three conditions hold. */
  readonly editable: EditabilityReport;
  /**
   * The game's art, listed rather than carried, when a `ZoneSource` was given.
   *
   * Undefined when it was not: a caller with no zones and a game with no art
   * are different facts, and an empty list would state the second.
   */
  readonly art?: AgosArt;
  /**
   * The rooms, and what each one's own script draws behind itself.
   *
   * Set by `importAgosProject` for every game it reads — a room is an item with
   * a room sub-structure, and the item tree is in the base file. Optional only
   * for the stub projects the export path builds, which carry a `GAMEPC` and
   * nothing else because that is all `exportAgosGame` reads.
   *
   * What is conditional within it is each room's `picture` — see `rooms.ts` for
   * why that lives in a Subroutine in another file entirely.
   */
  readonly rooms?: AgosRooms;
}

export interface EditabilityReport {
  readonly versionProbed: boolean;
  readonly structurallyAgrees: boolean;
  readonly roundTrips: boolean;
  /** True only when all three hold. */
  readonly editable: boolean;
  /**
   * Games whose bytes could not be recovered into editable structure.
   *
   * Zero or one, because `GAMEPC` is all or nothing (ADR 0030). Published as a
   * number with a target of zero, and never widened into a fallback.
   */
  readonly unrecovered: number;
  readonly reasons: readonly string[];
}

/** How a Subroutine's operands reach the string pool, so the editor can show reach. */
export function stringReferences(project: AgosProject): Map<number, number[]> {
  const byString = new Map<number, number[]>();
  for (const subroutine of project.game.subroutines.subroutines) {
    for (const line of subroutine.lines) {
      for (const instruction of line.instructions) {
        for (const operand of instruction.operands) {
          if (operand.kind !== 'string' || operand.id === undefined) continue;
          const users = byString.get(operand.id) ?? [];
          if (!users.includes(subroutine.id)) users.push(subroutine.id);
          byString.set(operand.id, users);
        }
      }
    }
  }
  return byString;
}

function nameOf(item: AgosItem, strings: readonly string[]): string {
  const noun = strings[item.noun];
  const adjective = strings[item.adjective];
  if (noun && adjective) return `${adjective} ${noun}`;
  if (noun) return noun;
  return `item`;
}

/**
 * Reads a game into a Project, and works out whether it may be edited.
 *
 * Importing never fails on the editability check: a game that cannot be edited
 * can still be read, and saying so is more useful than refusing to open it.
 * What the check governs is whether the editor offers to change anything.
 */
export function importAgosProject(
  data: Uint8Array,
  detection: AgosDetection,
  agosTarget: AgosTarget = detection.target,
  /**
   * Where the art is, when the caller has it.
   *
   * Optional because the pixels are not in `GAMEPC`: a caller holding only the
   * base file — every test here, and `describeEditRefusal`, which only wants to
   * know whether editing is allowed — has no zones to offer and gets a project
   * with no art rather than an error.
   */
  art: {
    zones?: ZoneSource;
    agos2?: boolean;
    /**
     * How to find a Subroutine by number, for the room list.
     *
     * A lookup rather than a block, because a room's Subroutine is almost never
     * in `GAMEPC` — Simon 1 keeps them in `TABLES01` and up — and this function
     * is handed the base file alone. A caller with no table reader gets a room
     * list whose entries name no picture, which is honest: the rooms are still
     * there and what they draw is in a file that was not read.
     */
    subroutineFor?: (id: number) => AgosSubroutine | undefined;
  } = {},
): AgosProject {
  const game = readGamePc(data, agosTarget);

  const bytecode = writeSubroutineBlock(game.subroutines, agosTarget);
  const agreement = checkStructuralAgreement(
    [{ source: detection.baseFile, data: bytecode }],
    agosTarget,
  );
  const roundTrips = readsWholeGame(data, agosTarget);
  const versionProbed = detection.identification !== 'narrowed';

  const reasons: string[] = [];
  if (!versionProbed) {
    reasons.push(
      `the Version is narrowed to ${detection.candidates.join(' or ')} rather than identified`,
    );
  }
  if (!agreement.agrees) {
    reasons.push(`structural agreement found ${agreement.findings.length} disagreement(s)`);
  }
  if (!roundTrips) reasons.push('the game did not re-emit byte for byte');

  const editable = versionProbed && agreement.agrees && roundTrips;
  const items: NamedItem[] = [];
  // Items 0 and 1 are predefined and not in the file, so the first record is 2.
  for (const [index, item] of game.items.entries()) {
    const id = index + 2;
    items.push({
      id,
      name: nameOf(item, game.strings),
      parent: itemIdOf(item.parent),
      children: [],
      item,
    });
  }
  // The tree is indexed by item number, and numbering starts at 2 — the first
  // two items are predefined and never appear in the file. The two holes are
  // deliberate: shifting the array instead would make every operand in every
  // Subroutine point two items to the left.
  const byNumber: AgosItem[] = [];
  byNumber.length = 2;
  byNumber.push(...game.items);
  const tree: AgosItemTree = {
    items: byNumber,
    initedCount: game.header.itemArrayInited,
    arraySize: game.header.itemArraySize,
  };
  const withChildren = items.map((named) => ({
    ...named,
    children: childrenOf(tree, named.id),
  }));

  return {
    target: {
      engine: 'agos',
      version: agosTarget.version,
      releaseKind: agosTarget.releaseKind,
      platform: agosTarget.platform,
      identification: detection.identification,
    },
    game,
    items: withChildren,
    strings: game.strings,
    editable: {
      versionProbed,
      structurallyAgrees: agreement.agrees,
      roundTrips,
      editable,
      unrecovered: editable ? 0 : 1,
      reasons,
    },
    // Undefined rather than an empty list when no zones were supplied: a
    // caller with no art and a game with no art are different facts, and a
    // surface that showed "0 images" for the first would be lying about the
    // game.
    art: art.zones ? readAgosArt(art.zones, { agos2: art.agos2 }) : undefined,
    /*
     * The rooms, always — with or without a way to read their scripts.
     *
     * A room is an item with a room sub-structure, so the list itself comes out
     * of the base file and needs nothing else. Only the *picture* each room
     * draws is in a Subroutine that usually lives elsewhere, which is why the
     * lookup is optional and its absence costs the pictures rather than the
     * rooms.
     */
    rooms: readAgosRooms(
      game.items,
      agosTarget,
      (id) =>
        art.subroutineFor?.(id) ?? game.subroutines.subroutines.find((each) => each.id === id),
    ),
  };
}

/**
 * Writes a Project back out as a `GAMEPC`.
 *
 * Whole, because the file has no index (ADR 0030), and refused outright when
 * the game was not editable — writing an edit into a structure that was misread
 * is the failure this whole chain exists to prevent, and it produces a game
 * that loads.
 */
export function exportAgosProject(project: AgosProject): Uint8Array {
  if (!project.editable.editable) {
    throw new Error(
      `This game is not editable: ${project.editable.reasons.join('; ')}. ` +
        'ADR 0029 refuses the export rather than writing an edit into a structure that was misread.',
    );
  }
  return writeGamePc(project.game, {
    family: 'AGOS',
    version: project.target.version,
    releaseKind: project.target.releaseKind,
    platform: project.target.platform,
  });
}
