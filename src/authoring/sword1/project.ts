/**
 * The editable form of Broken Sword: The Shadow of the Templars.
 *
 * ## What is editable, and on what evidence
 *
 * ADR 0025's rule is that a surface is editable when a record a person never
 * touches **re-emits byte-identically**. Five surfaces clear that here, and
 * they are listed in the order of how strong the claim is:
 *
 * 1. **Scripts.** The strongest, and the one this family was chosen for.
 *    Broken Sword's bytecode is self-describing in instruction length, so it
 *    decompiles to an instruction list, edits as one, and reassembles to the
 *    same words (`disassemble.ts`, `roundTripsSword1Script`).
 * 2. **Compacts.** The objects: 3,085 words each, with named fields the
 *    bytecode itself addresses by offset. Held as Preserved words, so a record
 *    nobody edits round-trips by construction, and a field edit is one word.
 * 3. **Text.** Every language the release ships, as strings. A text resource is
 *    a count, an offset table and NUL-terminated strings, so it rebuilds
 *    exactly — and an edit here is the plainest useful change anybody would
 *    want to make.
 * 4. **Palettes.** Six-bit VGA triples, like Lure's and for the same reason
 *    editable: they round-trip trivially.
 * 5. **Room definitions.** Which layers, grids, palettes and parallax a screen
 *    uses, and how big it is. Editable as a *project* record — see the caveat.
 *
 * ## The caveat on room definitions, stated rather than buried
 *
 * The room table lived in Revolution's interpreter, not in the game's files
 * (`swordRooms.ts`). So editing it changes how *this* interpreter draws a
 * screen and cannot be written back into a Broken Sword install — there is
 * nowhere to write it. That is a real limit and it is marked on the surface
 * (`writable: false`) rather than left for someone to discover by exporting.
 *
 * ## What is read-only, and why
 *
 * **Sound effects and speech** are editable and writable, and were neither
 * when this was written. WAVE decodes, `compressSpeech` writes Revolution's
 * 16-bit speech RLE back — `npm run sweep:sword` reports 799 of the demo's 808
 * speech lines re-encoding to the shipped bytes, the other nine an encoder tie
 * the data itself does not settle — and the export now reaches all three of
 * the places a recording lives. Speech is rebuilt into `SPEECH/COWS.MAD` or
 * `SPEECH*.CLU` around the replaced line, with the index patched and every
 * other payload copied byte for byte; a tune is written as the file it is
 * (`MUSIC/1M2.WAV`, addressed by name, ADR 0029); an effect is an ordinary
 * cluster resource and is substituted whole. `npm run reexport:sword` replaces
 * one of each and reads all three back out of the installed folder.
 *
 * **Sprites, backgrounds and parallax** are editable and writable.
 * `swordEncode.ts` writes RLE7, RLE0 and Tony as well as reading them, and
 * `npm run sweep:sword` reports 7113 of the demo's 7113 sprite frames and 2 of
 * 2 parallax layers re-encoding to the bytes Revolution shipped, so a replaced
 * frame goes back into the resource in the format it came out of — and
 * `export.ts` now substitutes every picture resource, so a painted background
 * is in the exported cluster. `npm run reexport:sword` paints one pixel of
 * screen 1's background and reads that pixel back out of the rebuilt cluster.
 *
 * **Mask layers** are editable too, and were not when this was written. A mask
 * is a bag of 16x8 blocks whose placing grid lives in a second resource, so
 * without that grid nothing can say where a block goes; `Sword1ProjectGrid`
 * carries it, and the panel composes the room-sized picture the grid describes
 * and takes it apart again the same way. Fifteen of the demo's fifteen masks
 * round-trip identically.
 *
 * One limit is the format's own and stands whatever the exporter does, so it is
 * named here rather than counted as closed: **HIF**, the PlayStation LZ77 that
 * no PC release uses, has no encoder — and an LZ match-finder choosing between
 * equally good matches could not give the shipped bytes back even if it did.
 */

import type { Sword1Instruction } from './disassemble.js';
import type { SwordWalkBar, SwordWalkNode } from '../../engine/sword1/script/swordWalkGrid.js';
import type {
  Sword1Identification,
  Sword1Release,
} from '../../engine/sword1/resource/swordDetect.js';

/** How a surface stands: editable, preserved, or editable-but-unwritable. */
export type Sword1SurfaceKind =
  /** Edits round-trip and export writes them back into the game. */
  | 'editable'
  /**
   * Edits round-trip and export does not put them in a game.
   *
   * The room table is in it only for a folder that does not ship an
   * executable. It was called interpreter knowledge with nowhere to write it,
   * and that was an assumption rather than a search: the interpreter ships in
   * the box — `SWORD.EXE` sits beside the clusters — and it carries both the
   * room table and the start positions in its own bytes. A project built from
   * a folder that has one gets `rooms: 'editable'` and a `startPositions`
   * surface from {@link Sword1Project.surfaces}, and the export carries a
   * patched executable. A folder with only clusters still has nowhere to write
   * a room, so the standing there is still this one.
   */
  | 'editable-not-writable'
  /** Bytes carried exactly as shipped, with a decoder and no encoder. */
  | 'preserved';

/** One compact, as the editor talks about it. */
export interface Sword1ProjectCompact {
  /** `section * 0x10000 + index`, which is how a script names one. */
  readonly id: number;
  readonly section: number;
  readonly index: number;
  /**
   * Every word of the record, base64 of its little-endian bytes.
   *
   * Preserved words and the one source of truth: the named fields the editor
   * shows are a view over these. The count may not change — a compact that
   * grew would move every compact after it in its section's resource and
   * invalidate the offsets the section's own table holds. A section may still
   * gain a record or lose its last one: `appendSword1Compact` moves every
   * record and rewrites every offset to match, which is a different operation
   * from one record growing underneath the others.
   */
  readonly wordsBase64: string;
}

/** One section's compacts, as one resource's worth. */
export interface Sword1ProjectSection {
  readonly section: number;
  /** The resource id this section's compacts came from. */
  readonly resource: number;
  readonly compacts: readonly Sword1ProjectCompact[];
  /**
   * Word offset of every slot the section's own table declares, as read.
   *
   * Kept verbatim rather than recomputed, because they are not always what a
   * recomputation would produce. Section 16's four offsets are 5, 52, 30, 74 —
   * out of order — and three of the demo's ninety-six sections are like it. A
   * table rebuilt in index order would move two objects and leave every script
   * that addresses them pointing at the other one.
   *
   * One entry per declared slot, including slots `compacts` has no record for.
   */
  readonly offsets: readonly number[];
  /**
   * The payload's length in words, header excluded.
   *
   * The size of the resource to rebuild. It is not the sum of the compacts: a
   * section's last record may be followed by nothing at all or by a tail the
   * table does not address, and either way the game's own resource is this
   * long.
   */
  readonly words: number;
}

/** One script module: its instructions, and where its scripts start. */
export interface Sword1ProjectScript {
  /** The resource id — one module per section, holding all its scripts. */
  readonly resource: number;
  /** The sections whose scripts live in this module. */
  readonly sections: readonly number[];
  readonly instructions: readonly Sword1Instruction[];
  readonly entries: readonly number[];
  /**
   * Words the decompiler could not turn into instructions.
   *
   * `CONTEXT.md`'s Unrecovered, counted per module so a single bad module does
   * not make the whole game uneditable.
   */
  readonly unrecovered: readonly {
    readonly at: number;
    readonly word: number;
    readonly why: string;
  }[];
  /** Whether this module re-emitted to exactly the words it was read from. */
  readonly roundTrips: boolean;
}

/** One text resource: a section, a language, and its lines. */
export interface Sword1ProjectText {
  readonly section: number;
  /** `english`, `french`, … — the name, not the index. */
  readonly language: string;
  readonly resource: number;
  /** One entry per line, including the empty ones the table holds. */
  readonly lines: readonly string[];
}

/** One palette, as six-bit VGA triples. */
export interface Sword1ProjectPalette {
  readonly resource: number;
  /** The 768 six-bit bytes, base64'd; widened on display. */
  readonly bytesBase64: string;
  /** Which screens name this palette, so a picker can say where it is used. */
  readonly screens: readonly number[];
}

/**
 * The Grid that places a mask layer's blocks on the screen.
 *
 * Carried *with* the mask rather than beside it because a mask layer without
 * its grid is a bag of 16x8 blocks in storage order and cannot be drawn at all:
 * nothing in the mask resource says where anything goes. The 15 grids a demo
 * install ships cost 140.7 KB against the importer's 24 MB picture budget.
 */
export interface Sword1ProjectGrid {
  readonly resource: number;
  /** Cells per row — the room table's `gridWidth`, off-screen edges included. */
  readonly pitch: number;
  /** The bytes as the cluster holds them, cells and all. */
  readonly bytesBase64: string;
}

/** One drawable resource, carried as its shipped bytes. */
export interface Sword1ProjectPicture {
  readonly resource: number;
  readonly kind: 'background' | 'sprite' | 'parallax' | 'mask';
  readonly width: number;
  readonly height: number;
  /** How many frames a sprite resource holds. One for a background. */
  readonly frames: number;
  /** The bytes as the cluster holds them. Preserved; decoded on demand. */
  readonly bytesBase64: string;
  /** Screens that use it, where the room table says so. */
  readonly screens: readonly number[];
  /**
   * A `mask`'s grid. Absent for every other kind, and absent for a mask whose
   * grid resource is not in this install — which is a state the editor names
   * rather than one it draws around.
   */
  readonly grid?: Sword1ProjectGrid;
}

/**
 * One animation table — a `cdt` — as the frame order it names.
 *
 * A Sword 1 sprite resource is frames and nothing else: no order, no rate, no
 * timing at all. What turns it into an animation is a *second* resource, the
 * one a script's `fnAnim(cdt, spr)` names first, and the driver walks it one
 * entry a game cycle (`SwordLogic.animDriver`). So the table is the answer to
 * "in what order, and how many steps" and the sprite is the answer to "drawn
 * how", and the preview needs both.
 *
 * Only the frame column is carried. The table's other two columns are the
 * position each step puts the sprite at on a *screen*, and the picture panel
 * draws a sprite on its own rather than in a room — carrying them would be
 * carrying data no surface reads. The resource itself is untouched by this
 * project and travels through an export byte for byte, so nothing is lost by
 * keeping the derived column here; `docs/editor-parity.md` §18 has the counts.
 */
export interface Sword1ProjectAnimTable {
  readonly resource: number;
  /** The sprite frame each step shows, in the order the driver walks them. */
  readonly frames: readonly number[];
}

/**
 * One `AnimSet`: eight (table, sprite) pairs, indexed by a mega's direction.
 *
 * `fnAnim(cdt, 0)` means "animate me whichever way I am facing", and `cdt`
 * then names one of these rather than a table. Carried whole, all eight
 * entries, because which one plays depends on a direction that is decided at
 * run time — the editor offers every direction the set names rather than
 * picking one, which would be exactly the invented answer this row refuses.
 */
export interface Sword1ProjectAnimSet {
  readonly resource: number;
  /** Eight entries, direction 0 first. A pair of zeros is a direction unused. */
  readonly entries: readonly { readonly table: number; readonly sprite: number }[];
}

/**
 * One walk grid: the bars a mega may not cross and the nodes it routes between.
 *
 * A *different* resource from `Sword1ProjectGrid` above, which is a mask layer's
 * block map — the two are both called "grid" by the game and share nothing. This
 * one is what a FLOOR compact's `o_resource` names, and it is the whole of what
 * the router walks over.
 *
 * Carried as **segments**, not as the eleven fields the resource stores. A bar's
 * `xmin`/`ymin`/`xmax`/`ymax`/`dx`/`dy`/`co` are all derivable from its two
 * endpoints, and re-deriving every one of the demo's nine grids gives the
 * shipped bytes back exactly — so an editor that moves an endpoint has one thing
 * to move rather than eleven things to keep consistent. `swordWalkGrid.ts` owns
 * that derivation and the proof.
 *
 * The nine grids this demo ships cost 5,656 bytes, against the importer's 24 MB
 * picture budget — so they are carried unconditionally and displace no picture.
 */
export interface Sword1ProjectWalkGrid {
  readonly resource: number;
  /** Screens whose FLOOR compact names it. Usually one; sometimes eleven. */
  readonly screens: readonly number[];
  /** The FLOOR compacts that name it, so a panel can say who asked. */
  readonly floors: readonly number[];
  /** The scale ramp the floor's megas walk at, carried through untouched. */
  readonly scaleA: number;
  readonly scaleB: number;
  /**
   * The resource's own 20-byte header, base64'd.
   *
   * Kept rather than rebuilt for the reason `rewriteResource` keeps one: it
   * holds a type tag and a version this project does not model, and inventing
   * them is how an export stops being byte-identical.
   */
  readonly headerBase64: string;
  readonly bars: readonly SwordWalkBar[];
  readonly nodes: readonly SwordWalkNode[];
}

/**
 * One screen's definition.
 *
 * Writable back into a game when the project was built from a folder carrying
 * the executable that holds the table, and not otherwise; `surfaces.rooms`
 * says which.
 */
export interface Sword1ProjectRoom {
  readonly screen: number;
  readonly width: number;
  readonly height: number;
  readonly totalLayers: number;
  readonly gridWidth: number;
  readonly layers: readonly number[];
  readonly grids: readonly number[];
  readonly palettes: readonly number[];
  readonly parallax: readonly number[];
}

/**
 * Where a character stands when a script sends them to a place.
 *
 * Not a table in any file: the executable *writes* these, four `mov`
 * instructions to a fixed address per placement, so a row is addressed by its
 * ordinal among those runs rather than by an index into anything. `place` is
 * the compact id the run belongs to and is carried so an edit can be checked
 * against the file it is going into rather than trusted.
 */
export interface Sword1ProjectStartPosition {
  /** Ordinal among the placement runs in the executable, in file order. */
  readonly index: number;
  /** The compact id this placement is for, as the executable's own bytes say. */
  readonly place: number;
  readonly x: number;
  readonly y: number;
  readonly direction: number;
}

/** One sound effect, as the fx table defines it. */
export interface Sword1ProjectEffect {
  readonly fxNo: number;
  readonly sample: number | null;
  readonly type: number;
  readonly delay: number;
  readonly rooms: readonly {
    readonly room: number;
    readonly leftVolume: number;
    readonly rightVolume: number;
  }[];
}

export interface Sword1Project {
  /** The Release and how it was established, carried like every family's. */
  readonly identification: {
    readonly release: Sword1Release;
    readonly how: Sword1Identification;
    readonly evidence: string;
  };
  /**
   * Whether anything is editable, and what is not.
   *
   * `unrecovered` counts **script words**, which is the surface whose failure
   * would be silent: a compact that will not parse is a missing section and
   * visible, where a script word misread as an instruction is an edit that
   * writes nonsense.
   */
  readonly editable: {
    readonly editable: boolean;
    readonly unrecovered: number;
    readonly reasons: readonly string[];
  };
  /** What each surface's standing is, so the editor can say so per section. */
  readonly surfaces: Readonly<Record<string, Sword1SurfaceKind>>;
  readonly sections: readonly Sword1ProjectSection[];
  readonly scripts: readonly Sword1ProjectScript[];
  readonly text: readonly Sword1ProjectText[];
  readonly palettes: readonly Sword1ProjectPalette[];
  readonly pictures: readonly Sword1ProjectPicture[];
  readonly rooms: readonly Sword1ProjectRoom[];
  /**
   * Start positions, when the folder shipped the executable that holds them.
   *
   * Optional and absent rather than empty when no executable was read, because
   * an empty list and "this folder has no executable" are different facts and
   * the editor says different things about them.
   */
  readonly startPositions?: readonly Sword1ProjectStartPosition[];
  /**
   * Which executable each interpreter-held table was read out of.
   *
   * Carried because the two tables are not interchangeable between the files
   * that hold them: this demo's `SWORD.EXE` has 52 start placements and its
   * `WINSWORD.EXE` has 45, so placement 3 is a different place in each. An
   * edit goes back into the file it came out of and every other executable is
   * carried through untouched — which is also what keeps an export that
   * edited nothing byte-identical in all three.
   */
  readonly interpreter?: {
    readonly rooms: string | null;
    readonly startPositions: string | null;
  };
  /**
   * Walk grids, keyed by the resource a FLOOR compact names.
   *
   * Optional because a project saved before this existed has none, and a panel
   * that cannot find one says so rather than drawing an empty screen.
   */
  readonly walkGrids?: readonly Sword1ProjectWalkGrid[];
  /**
   * The animation tables and direction sets the demo's scripts name.
   *
   * Both optional for the reason `walkGrids` is: a project saved before they
   * existed has neither, and the preview says so rather than playing at a rate
   * it made up.
   */
  readonly animTables?: readonly Sword1ProjectAnimTable[];
  readonly animSets?: readonly Sword1ProjectAnimSet[];
  readonly effects: readonly Sword1ProjectEffect[];
  /** Cluster labels this install has, and the ones the index names and it lacks. */
  readonly clusters: {
    readonly present: readonly string[];
    readonly absent: readonly string[];
    /**
     * Cluster number to label, so a resource id can say where it lives.
     *
     * Optional because a project saved before this existed has none, and a
     * refusal that cannot name a cluster says so rather than guessing.
     */
    readonly labels?: Readonly<Record<number, string>>;
  };
}

/** The surfaces and their standing, stated once so nothing has to infer it. */
export const SWORD1_SURFACES: Readonly<Record<string, Sword1SurfaceKind>> = {
  scripts: 'editable',
  compacts: 'editable',
  text: 'editable',
  palettes: 'editable',
  /*
   * The standing for a folder of clusters and nothing else. A project built
   * from a folder that also ships `SWORD.EXE` overrides this to 'editable' and
   * adds a `startPositions` entry beside it, because that file is where both
   * tables live. See {@link Sword1SurfaceKind}.
   */
  rooms: 'editable-not-writable',
  pictures: 'editable',
  walkGrids: 'editable',
  effects: 'editable',
};
