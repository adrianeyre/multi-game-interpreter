/**
 * The editable form of Broken Sword II: The Smoking Mirror.
 *
 * A separate shape from `Sword1Project`, and ADR 0026's reason is the one that
 * matters: "a shared record type is the first place two families' objects get
 * confused for one". These two share less than Sky and Lure do. A Sword1
 * compact is 3,085 fixed words; a Sword2 object is a header, a hub, a variable
 * block, an offset table and a code block, with eight typed structures the
 * scripts address by offset. There is no field either family could hold in the
 * other's record.
 *
 * ## What is editable, and on what evidence
 *
 * 1. **Scripts.** Every object carries its own, and they decompile to an
 *    instruction list that re-emits byte-identically (`disassemble.ts`).
 * 2. **Objects.** Held as Preserved bytes with the structure boundaries named,
 *    so a record nobody edits round-trips by construction.
 * 3. **Globals.** Read from the game's own `GLOBAL_VAR_FILE`, so there is
 *    nothing to reconstruct — the count and the values are both the game's.
 * 4. **Text.** Every line of every module, as strings, each with the wav id
 *    the resource names beside it — see `Sword2ProjectText.wavIds`.
 * 5. **Palettes.** Read out of the screen resources they belong to.
 *
 * ## What is read-only
 *
 * **Sound** is Preserved bytes: it decodes and there is no encoder here.
 *
 * **Screens and animations** are editable and writable. `sword2Encode.ts`
 * writes all three of the family's schemes, and `npm run sweep:sword` reports
 * 14085 of the demo's 14088 animation frames and 17 of 17 parallax layers
 * re-encoding to the bytes the game shipped — the three exceptions are ties the
 * format allows and decode identically. `export.ts` carries both surfaces out
 * now, so a repainted background is in the exported cluster, and
 * `npm run reexport:sword` repaints one pixel of a screen and reads that pixel
 * back out of the rebuilt cluster.
 *
 * The one limit left is the picture budget's rather than the format's: a screen
 * or an animation too big to fit in the project on import is named in
 * `editable.reasons` and copied through untouched, which is right rather than
 * lossy.
 */

import type { Sword2Instruction } from './disassemble.js';
import type {
  Sword2Identification,
  Sword2Release,
} from '../../engine/sword2/resource/sword2Detect.js';
import type { Sword1SurfaceKind } from '../sword1/project.js';
import type { SwordWalkBar, SwordWalkNode } from '../../engine/sword1/script/swordWalkGrid.js';

/** One object: its scripts, its bytes, and where its structures begin. */
export interface Sword2ProjectObject {
  /** The resource id, which is also how a script id names it. */
  readonly id: number;
  readonly name: string;
  /** The object's whole resource, base64'd. Preserved bytes. */
  readonly bytesBase64: string;
  readonly instructions: readonly Sword2Instruction[];
  readonly entries: readonly number[];
  readonly unrecovered: readonly {
    readonly at: number;
    readonly byte: number;
    readonly why: string;
  }[];
  readonly roundTrips: boolean;
  /**
   * The id this object was copied from, when the editor appended it.
   *
   * Absent for every object the game shipped, which is what makes it the
   * exporter's signal: an appended object has no entry in `resource.tab` and no
   * entry in its cluster's tail table, and this says which cluster to put both
   * in. A copy is placed in the cluster its source lives in — a resource id's
   * cluster is a fact about the index, not about the resource, and putting the
   * copy beside the original keeps the one cluster that has to be rewritten the
   * one that was going to be rewritten anyway.
   */
  readonly appendedFrom?: number;
  /**
   * Byte offsets of the object's parts, so an editor can show its structures.
   *
   * Derived from the resource rather than assumed: the variable block's length
   * is a word inside it, so where the code starts differs per object.
   */
  readonly layout: {
    readonly localsAt: number;
    readonly localsBytes: number;
    readonly codeAt: number;
    readonly codeBytes: number;
  };
}

/** One text module: its lines, in the language the release ships. */
export interface Sword2ProjectText {
  readonly resource: number;
  readonly lines: readonly string[];
  /**
   * The speech each line names, one per line, parallel to `lines`.
   *
   * Two bytes sit in front of every string in the resource and `fnISpeak` plays
   * a line's recording by that number. They are carried beside the line rather
   * than inside it so that editing a sentence leaves its voice alone — and
   * carried at all because an export that zeroed them would ship a game with
   * subtitles and no speech, which is a fault nothing in the editor would show.
   */
  readonly wavIds: readonly number[];
}

/** One screen resource, as a read-only picture. */
export interface Sword2ProjectScreen {
  readonly resource: number;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  /** Whether it carries a palette, two background and two foreground layers. */
  readonly hasPalette: boolean;
  readonly parallax: readonly boolean[];
  readonly bytesBase64: string;
}

/** One palette, read out of the screen resource it belongs to. */
export interface Sword2ProjectPalette {
  readonly screen: number;
  /** 256 RGBA quads, base64'd — four bytes an entry, not three. */
  readonly bytesBase64: string;
}

/** One animation resource, as a read-only sprite surface. */
export interface Sword2ProjectAnimation {
  readonly resource: number;
  readonly name: string;
  readonly frames: number;
  /** 0 none, 1 RLE256, 2 RLE16. */
  readonly compression: number;
  readonly bytesBase64: string;
}

/**
 * One walk grid, as `fnAddWalkGrid` registers it.
 *
 * The bar and node records are the ones Broken Sword used, byte for byte:
 * Revolution carried the router across and the resource with it. What did not
 * cross is everything around them — a 44-byte header instead of 20, no scale
 * ramp, and a *session* holding as many grids as its scripts register rather
 * than a screen holding one. `sword2WalkGrid.ts` says which is which.
 *
 * The four grids this demo ships cost 1,120 bytes, against the importer's 24 MB
 * picture budget — so they are carried unconditionally and displace no screen.
 */
export interface Sword2ProjectWalkGrid {
  readonly resource: number;
  /** The resource's own name, which is how the demo's four are told apart. */
  readonly name: string;
  /**
   * Screens that reach it, found the only way this data allows.
   *
   * There is no table. A screen's run list names the objects alive in that
   * session, and one of them is a floor whose script calls `fnAddWalkGrid` with
   * this resource as a constant — so the link is *through the scripts*, and a
   * grid a script reaches with a computed id has no screen here and says so.
   */
  readonly screens: readonly number[];
  /** The objects whose scripts register it. */
  readonly objects: readonly number[];
  /** The resource's own 44-byte header, base64'd. Kept, never invented. */
  readonly headerBase64: string;
  readonly bars: readonly SwordWalkBar[];
  readonly nodes: readonly SwordWalkNode[];
}

export interface Sword2Project {
  readonly identification: {
    readonly release: Sword2Release;
    readonly how: Sword2Identification;
    readonly evidence: string;
  };
  readonly editable: {
    readonly editable: boolean;
    readonly unrecovered: number;
    readonly reasons: readonly string[];
  };
  readonly surfaces: Readonly<Record<string, Sword1SurfaceKind>>;
  readonly objects: readonly Sword2ProjectObject[];
  /**
   * The globals, as the game's own variable block.
   *
   * Bytes rather than numbers, and the count is theirs: Sword2 keeps its
   * globals in resource 1, so this project carries what the game carries and
   * invents no table (see `sword2Vars.ts`).
   */
  readonly globals: { readonly count: number; readonly bytesBase64: string };
  readonly text: readonly Sword2ProjectText[];
  readonly screens: readonly Sword2ProjectScreen[];
  readonly palettes: readonly Sword2ProjectPalette[];
  readonly animations: readonly Sword2ProjectAnimation[];
  /**
   * Walk grids. Optional for the reason Sword1's are: a project saved before
   * this existed has none, and the panel names that rather than drawing empty.
   */
  readonly walkGrids?: readonly Sword2ProjectWalkGrid[];
  /** Run lists: the object ids alive in each session. */
  readonly runLists: readonly {
    readonly resource: number;
    readonly objects: readonly number[];
    /**
     * The screen this session draws, where the names join up.
     *
     * The same best-effort join `Sword2ProjectWalkGrid.screens` documents and
     * for the same reason: nothing in the data says which screen a run list
     * belongs to, and "Run list for 11" and "Screen 11" are the only thing
     * linking them. Absent rather than guessed where the names do not match,
     * and optional so a project saved before this existed still loads.
     */
    readonly screen?: number;
  }[];
  readonly clusters: { readonly present: readonly string[]; readonly absent: readonly string[] };
  /**
   * How many ids `resource.tab` declares, which is the next id a copy can take.
   *
   * Optional because projects saved before objects could be appended do not
   * carry it, and an append is refused rather than guessed when it is missing:
   * `resource.tab` is a flat array indexed by id, so the next free id is its
   * length and nothing else — the highest id in `objects` is not it, because
   * 20 of the demo's 4,147 ids are `0xffff` and hold nothing.
   */
  readonly resourceCount?: number;
}

/** The surfaces and their standing, stated once so nothing has to infer it. */
export const SWORD2_SURFACES: Readonly<Record<string, Sword1SurfaceKind>> = {
  scripts: 'editable',
  objects: 'editable',
  globals: 'editable',
  text: 'editable',
  palettes: 'editable',
  runLists: 'editable',
  screens: 'editable',
  animations: 'editable',
  walkGrids: 'editable',
};
