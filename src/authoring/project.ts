import type { Action } from './actions.js';
import type { SciVersion } from '../engine/sci/sciVersion.js';
import {
  parseTarget,
  type LurePlatform,
  type LureRelease,
  type ScummVersionTarget,
  type Target,
} from './target.js';
import type { AgosItem } from '../engine/agos/world/itemTree.js';
import type { AgosRooms } from './agos/rooms.js';
import type { AgosSubroutineBlock } from '../engine/agos/script/subroutines.js';
import type { AgosArt } from './agos/images.js';
import type { PaintedImage } from './agos/paint.js';
import type { SkyCompactType } from '../engine/sky/resource/skyCompacts.js';
import type { ProjectAudio } from './audio.js';
import type { StoredImage } from './imageCodec.js';
import type { Sword1Project } from './sword1/project.js';
import type { Sword2Project } from './sword2/project.js';
import { rectangleBox } from './GameBuilder.js';
import type { BoxDefinition, ScaleRamp } from './GameBuilder.js';

/**
 * The saved form of a game.
 *
 * Entirely JSON: no functions, no class instances. That is what lets a project
 * live in local storage, be exported to a file, be diffed, and be compiled
 * without the editor present — the CLI reads exactly this.
 */
export interface Project {
  /** Bumped when the shape changes incompatibly; `migrate` handles old files. */
  version: 6;
  /**
   * What this project is built for, and compiles to.
   *
   * A different thing from `version`, deliberately: that one is the *project
   * format*, which changes when the editor's own shape does, and this one is
   * the game format, which changes when an author imports a v6 game. Sharing
   * one field would break either migration or version selection, and in the end
   * both (ADR 0004).
   *
   * A pair rather than a number, because a second Engine family broke the
   * number twice over (ADR 0012). AGI has versions of its own and they are not
   * points on SCUMM's scale; and an AGI version is not enough to *decode* AGI,
   * because an instruction's argument count comes from a table outside the
   * bytecode that varies by interpreter build and platform. So the Target
   * carries everything that must be known before a byte can be read.
   *
   * Projects written before this carried `scummVersion` and are migrated by
   * the format-version path, which is what that path is for.
   */
  target: Target;

  /**
   * The published game this project was imported from, when it was.
   *
   * Present only for a project whose originals were too large to keep in the
   * browser (ADR 0010): export asks for the folder again, and this is what lets
   * it refuse the wrong one by name rather than writing a corrupt game. Absent
   * for a project authored from scratch and for any import small enough to
   * store, which is every v5 and v6 one.
   */
  /**
   * The game's displayable text, when it keeps it outside its scripts.
   *
   * The Dig only: Full Throttle ships no language bundle, so its words are the
   * fallbacks inside its instructions and are edited there (ADR 0005). Absent
   * for every other version and for a project authored from scratch.
   */
  strings?: {
    source: string;
    entries: Array<{ tag: string; text: string; original: string }>;
  };

  origin?: {
    indexFile: string;
    dataFile: string;
    indexBytes: number;
    dataBytes: number;
    engineVersion?: string;
    dataVersion?: string;
  };

  name: string;
  start: { room: number; x: number; y: number };
  defaultResponse: string;
  screen: { textHeight: number; verbTop: number };
  verbs: ProjectVerb[];
  actors: ProjectActor[];
  rooms: ProjectRoom[];
  scripts: ProjectScript[];
  /**
   * Imported sound, addressed by id the way SCUMM addresses everything.
   *
   * A `playSound` action names one of these ids, so a track an author drops in
   * is playable from a script the moment it is imported.
   */
  audio: ProjectAudio[];
  /**
   * Costumes carried exactly as the published game shipped them.
   *
   * A project can hold at most 19 actors, because ids below `ACTOR_ID_LIMIT`
   * have to be separable from object ids arithmetically — and a published game
   * has far more costumes than that. Its own scripts change costumes by
   * number, so the ones that cannot become editable actors still have to
   * exist, or every such script dresses an actor in nothing.
   *
   * They are kept as bytes rather than as poses for the same reason imported
   * scripts are kept as bytecode: the format they arrived in is already the
   * format the interpreter reads, so copying it through is both exact and
   * small. The trade is that they cannot be edited, only worn.
   */
  costumes?: Array<{ id: number; bytes: string }>;
  /** Present only in a project decompiled from a published game. */
  imported?: ImportedGame;

  /**
   * An AGI project's content, which shares nothing with the fields above.
   *
   * Present exactly when `target.engine` is `'agi'`, and the SCUMM fields are
   * then empty rather than meaningful — an AGI game has no actors, no verbs and
   * no walk boxes, and its rooms are Logic numbers rather than resources with
   * geometry.
   *
   * Kept as a section of `Project` rather than as a second project type,
   * because the plumbing around a project — the format version, the migration
   * path, local storage, export — is the same either way, and ADR 0013's
   * conclusion is that the split is *between project types* rather than inside
   * one: within an AGI project there is exactly one way behaviour is held, and
   * the Target already tells you which kind you have.
   */
  agi?: AgiProject;

  /**
   * The AGOS half of a project, present exactly when `target.engine` is
   * `'agos'`.
   *
   * A section rather than a second project type, for ADR 0013's reason — the
   * plumbing around a project is the same either way, and the split is between
   * project types rather than inside one. The SCUMM fields are empty and
   * meaningless here: an AGOS game has no walk boxes and no verb bar of the
   * kind those fields describe, and its behaviour hangs off an item tree rather
   * than off rooms.
   */
  agos?: AgosProject;
  /**
   * The editable form of a SCI game (ADR 0018).
   *
   * Present for a SCI project and absent for every other, exactly as `agi` is.
   */
  sci?: SciProject;

  /**
   * The Sky half of a project, present exactly when `target.engine` is `'sky'`.
   *
   * A section rather than a second project type, for ADR 0013's reason. The
   * SCUMM fields are empty and meaningless here: Beneath a Steel Sky has no walk
   * boxes and no verb bar, and its world is a Compact table rather than rooms of
   * resources. Distinct from any Lure equivalent by design — ADR 0025 rejects
   * one shared shape because a shared record type is the first place the two
   * engines would get confused for one.
   */
  sky?: SkyProject;

  /**
   * The Lure half of a project, present exactly when `target.engine` is
   * `'lure'`.
   *
   * A separate section from `sky`, and pointedly so: ADR 0026 forbids the two
   * families sharing a project shape, on the ground that a shared record type is
   * the first place a Steel Sky object and a Temptress hotspot get confused for
   * one. So Lure's editable surface is described in Lure's own terms — palettes
   * in its six-bit VGA format, and an object table this project holds as
   * Preserved bytes rather than typing (ADR 0024). The SCUMM fields are empty and
   * meaningless here, as they are for every non-SCUMM family.
   */
  lure?: LureProject;

  /**
   * The Broken Sword half of a project, present exactly when `target.engine`
   * is `'sword1'` (ADR 0036).
   *
   * A section rather than a second project type, for ADR 0013's reason, and a
   * section of its own rather than one shared with `sword2` for ADR 0026's:
   * a shared record type is the first place two families' objects get confused
   * for one, and these two families share less than Sky and Lure do — a Sword1
   * compact is 3,085 words of fixed layout and a Sword2 object is a header,
   * eight typed structures and a script block.
   *
   * The SCUMM fields are empty and meaningless here, as they are for every
   * non-SCUMM family.
   */
  sword1?: Sword1Project;

  /**
   * The Broken Sword II half of a project, present exactly when
   * `target.engine` is `'sword2'` (ADR 0036).
   */
  sword2?: Sword2Project;
}

/**
 * The editable form of a Sky game (ADR 0025).
 *
 * Two surfaces, kept apart because the ADR keeps them apart. The **Compact
 * table** is the primary one: named records with typed, named fields, held as
 * Preserved bytes so a record a person never touches re-emits byte-identically.
 * **Text** is its own surface, and holds every language it found — dropping one
 * is the silent data loss `CONTEXT.md` names as Unrecovered.
 *
 * Plain JSON throughout: each record carries its words as base64 of their
 * little-endian bytes, which is the one truth the fields are a view over.
 */
export interface SkyProject {
  /**
   * How the Release was established.
   *
   * Sky carries a Release rather than a Version (ADR 0023): the Release is not a
   * decoding decision the way a Version is, so this records which release the
   * Compacts were read from rather than a probe result.
   */
  identification: string;
  /**
   * Whether ADR 0025's conditions held, and what failed if not.
   *
   * `unrecovered` is a count **over the object table**, not over scripts (ADR
   * 0025) — a record the reader could not turn into typed fields, or that
   * re-emits differently than it arrived.
   */
  editable: { editable: boolean; unrecovered: number; reasons: string[] };
  /** The Compact records, the primary editable surface. */
  records: SkyProjectRecord[];
  /** Text, its own surface (ADR 0025). */
  text: SkyProjectText;
  /**
   * The bytecode as Preserved bytes, one entry per script module.
   *
   * A listing is produced from these on demand; ADR 0025 keeps Sky's bytecode
   * at Disassembly, so nothing here is editable and nothing claims to be.
   */
  readonly scripts?: readonly {
    readonly number: number;
    readonly scripts: number;
    readonly wordsBase64: string;
  }[];
  /**
   * Drawable resources — full screens and room backgrounds — as a read-only
   * picture surface.
   *
   * The pixels the game ships, carried as unpacked, decode-ready Preserved bytes
   * so the editor needs only the pure decoders (`skyGraphic.ts`) and no RNC. A
   * `screen` is 320x200 rows of indexed pixels drawn as-is; a `room` is a
   * 320x192 game area stored as tiles and de-tiled on display. This is a
   * *viewer* — Sky's pictures decode but this project holds no re-encoder, so
   * byte-identity here is preservation, not a decode/encode round trip, and the
   * surface says so.
   *
   * Held **outside the undo history** (`EditorState.snapshot`), like audio and
   * for the same reason: they are read-only bytes no edit changes, and versioning
   * several megabytes of them across sixty snapshots is the waste that exclusion
   * exists to prevent. Sprites — Sky's 961 object/actor graphics — are *not*
   * carried here: unpacked they are ~16 MB, which wants a resource side store
   * rather than the project document (see the run report).
   */
  readonly pictures?: readonly SkyProjectPicture[];
  /** Palettes for the picture surface's palette picker (six-bit VGA). */
  readonly palettes?: readonly SkyProjectPalette[];
  /**
   * The sprites — the player, the actors and the objects.
   *
   * Optional like `pictures`, and for the same reason: a project written before
   * the surface existed does not carry them, and the editor says so rather than
   * showing an empty section (see `SkyEditor`).
   */
  readonly sprites?: readonly SkyProjectSprite[];
}

/** One drawable resource the picture surface shows. */
export interface SkyProjectPicture {
  /** The resource id, as `sky.dnr` addresses it. */
  readonly id: number;
  /** `screen` is 320x200 rows; `room` is a 320x192 tiled game area. */
  readonly kind: 'screen' | 'room';
  readonly width: number;
  readonly height: number;
  /**
   * The unpacked resource bytes, base64'd. A `screen`'s bytes are its pixels
   * already; a `room`'s are tiles that `decodeSkyGameArea` de-tiles. Preserved
   * bytes: what the editor draws is a view over these, and nothing rewrites them.
   */
  readonly bytesBase64: string;
  /**
   * The palettes the game's own scripts draw this background with, in the order
   * they were found — so the first is a sound default and the rest belong in
   * the picker beside it.
   *
   * Derived rather than guessed, and checked: a room-entry script sets
   * `LAYER_0_ID` a few instructions before calling `fnDrawScreen` with the
   * palette, and walking every shipped script for that pattern pairs all 218
   * `fnDrawScreen` call sites with a background across 49 distinct backgrounds.
   * Background 64 pairs to palette 4316, which is exactly what the running
   * engine reports for screen 0 — a static walk of the bytecode and the live
   * engine agreeing independently is what makes this a reading.
   *
   * More than one is normal: 16 backgrounds carry several, because a room gets
   * re-lit. Empty means no script was found drawing this picture, which the
   * editor says rather than falling back silently.
   */
  readonly palettes?: readonly number[];
}

/**
 * One sprite the picture surface shows: an object, an actor, or the player.
 *
 * Carried **packed**, unlike a picture. The two are different because the
 * numbers are different: Sky's 971 sprite resources are 15.50 MB unpacked and
 * **1.58 MB packed**, across 11,480 frames. An earlier pass left sprites out on
 * the unpacked figure, which was the wrong one to measure — the project
 * document is re-serialised on every edit, so what matters is the carried size,
 * and packed it is the same order as Lure's 0.97 MB of compressed pictures.
 *
 * So the editor unpacks one on demand, the way Lure's surface decodes one
 * picture at a time. The trade is a decompressor in the editor bundle for
 * fourteen megabytes not held in memory or written to storage on every
 * keystroke.
 */
export interface SkyProjectSprite {
  /** The resource id, as `sky.dnr` addresses it. */
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** How many frames the header declares. A pose is one of these. */
  readonly frames: number;
  /** Bytes per frame, which is how a frame index becomes an offset. */
  readonly frameBytes: number;
  /** Added to a Compact's coordinates before drawing. Signed. */
  readonly offsetX: number;
  readonly offsetY: number;
  /**
   * The resource bytes, base64'd, **as the container holds them** — RNC-packed
   * for all but a few. Preserved bytes: the editor unpacks a copy to draw and
   * nothing rewrites these.
   */
  readonly bytesBase64: string;
  /**
   * The index's two flags, which is what deciding to unpack needs.
   *
   * Not a single `packed` boolean: Sky packs *after* the 22-byte prefix, and
   * whether the prefix belongs to the unpacked result is the index's call, not
   * something the bytes say. `unpackSkyResource` reads these; a first pass at
   * this carried one boolean derived from `looksRncPacked(bytes)` at offset 0,
   * which was false for all 971 sprites and would have drawn every one of them
   * from compressed bytes as though they were pixels.
   */
  readonly excludesHeader: boolean;
  readonly stored: boolean;
}

/** One palette the picture surface can be drawn with. */
export interface SkyProjectPalette {
  readonly id: number;
  /** The 768 six-bit VGA bytes, base64'd — widened to RGB on display. */
  readonly bytesBase64: string;
  /**
   * Where it was found, and this distinction was a bug.
   *
   * The surface first gathered palettes by scanning **resources** and found 29.
   * But `SkyEngine.paintPalette` resolves a palette out of the **Compact
   * table** first and only falls back to resources, and the table holds 83 more
   * — including 4316, which is the one screen 0's own room-entry script names.
   * So a picker offering only the resource palettes offered none that the game
   * uses for a room, and every picture was drawn in colours it never had.
   */
  readonly source: 'compact' | 'resource';
}

/** One Compact record as the editor talks about it. */
export interface SkyProjectRecord {
  /** `(list << 12) | index`, which is how a script names one. */
  id: number;
  list: number;
  index: number;
  name: string;
  type: SkyCompactType;
  /**
   * Every word of the record, base64 of its little-endian bytes.
   *
   * Preserved bytes and the one source of truth: the named fields are a view
   * over these, and an edit changes a word here. The count may not change — a
   * record that grew would move every record after it and invalidate the ids the
   * game's own scripts hold (ADR 0024).
   */
  wordsBase64: string;
}

/**
 * The text surface, holding every language found.
 *
 * Sky keeps its text compressed in its data file with the decompression tree in
 * the executable, and this project does not read it yet — so `languages` is
 * empty and `read` is false rather than a claim to hold text it does not. The
 * moment a reader lands, dropping any language it finds is Unrecovered (ADR
 * 0025); an empty surface drops nothing.
 */
export interface SkyProjectText {
  /** Languages whose text this project holds, by name. */
  languages: string[];
  /** Whether any text has been read at all. */
  read: boolean;
  /** What is missing, in terms an author can act on. */
  note: string;
}

/**
 * The editable form of a Lure of the Temptress game (ADR 0026).
 *
 * The same discipline as `SkyProject` against different formats, which is the
 * point of keeping the two apart: what a person can edit here is Lure's own, and
 * where Lure's readers stop is not where Sky's do. Two surfaces:
 *
 * - **Palettes** are the editable one. Lure ships them as an uncompressed
 *   six-bit VGA format (`lureDisk.ts`), 220 colours each, and they round-trip
 *   byte-identically — so editing a colour is a checked change, not a guess.
 * - **The object table** is *not* typed. Lure's world state is resource 16398,
 *   the 37,504-byte snapshot the executable restores into a save slot, and its
 *   records cannot be named without the executable's consuming routine read (ADR
 *   0024). It is carried here as Preserved bytes and marked read-only, never
 *   fitted with an invented shape.
 *
 * So `editable` reports the *palette* surface and can be true while `unrecovered`
 * is non-zero — unlike Sky, whose one editable surface *is* its object table.
 * Here they are different surfaces, and the count is honest about the one this
 * project cannot yet type.
 */
export interface LureProject {
  /**
   * Where each hotspot stands: the typed, editable part of Lure's object table.
   *
   * Read from the game's executable, which is ADR 0024's rule for a definition
   * — the world state below is the resource that ADR's third amendment found,
   * and the two are different things. Moving one of these is the plainest edit
   * ADR 0025 describes, and it is the reason this family has more than a
   * palette surface.
   */
  readonly hotspots?: readonly {
    readonly id: number;
    readonly x: number;
    readonly y: number;
    readonly yFlag: boolean;
  }[];
  /** How the Release was established (a Release, not a probed Version — ADR 0026). */
  identification: string;
  release: LureRelease;
  platform: LurePlatform;
  /**
   * Whether Lure exposes an editable surface, and the object-table count.
   *
   * `editable` is about the **palette** surface — true when every palette
   * re-emitted byte-identically. `unrecovered` is a count **over the object
   * table** (ADR 0025): 1 while the world state is held as Preserved bytes and
   * cannot be typed. The two coexist because they describe different surfaces;
   * `reasons` records anything that blocked the palette surface itself.
   */
  editable: { editable: boolean; unrecovered: number; reasons: string[] };
  /** Lure's palettes — the editable surface, in its own six-bit VGA format. */
  palettes: LureProjectPalette[];
  /** The object table, carried as read-only Preserved bytes (ADR 0024). */
  worldState: LureProjectWorldState;
  /**
   * The room pictures, as a read-only picture surface.
   *
   * Lure's game-area pictures — 99 of them decode to exactly the 320x192 game
   * area, the arithmetic that says the decompressor is right (`lureDecode.ts`).
   * Carried here as their *compressed* resource bytes, base64'd, so the document
   * stays small (~1 MB rather than the 6 MB the pixels would be); the editor
   * decodes each on demand with `decodeLurePicture`. A viewer, not an editor:
   * these bytes are Preserved and nothing re-encodes them.
   *
   * **Which** picture a room uses is not established — that is in the room table
   * this project does not read (see `LureEngine.render`) — so this is every
   * game-area picture the containers hold, not a room-by-room map, and the
   * surface says so. Held outside the undo history (`EditorState.snapshot`) like
   * audio: read-only bytes no edit changes.
   */
  readonly pictures?: readonly LureProjectPicture[];
}

/** One Lure room picture as the picture surface holds it. */
export interface LureProjectPicture {
  /** The container it was read from, one-based. */
  readonly disk: number;
  /** Its resource id within that container. */
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /**
   * The *compressed* resource bytes, base64'd — decoded on demand with
   * `decodeLurePicture`. Preserved bytes: the source of truth, never rewritten.
   */
  readonly bytesBase64: string;
}

/** One Lure palette as the editor talks about it. */
export interface LureProjectPalette {
  /** The container it was read from, one-based. */
  disk: number;
  /** Its resource id within that container. */
  id: number;
  /** The 220 colours, widened to 8-bit RGB — a view over `bytesBase64`. */
  colours: Array<{ r: number; g: number; b: number }>;
  /**
   * The raw six-bit resource bytes, base64'd. Preserved bytes and the source of
   * truth: `colours` is a view, and a palette nobody edits re-emits from these
   * unchanged.
   */
  bytesBase64: string;
}

/**
 * The object table as this project holds it: bytes, not fields.
 *
 * `typed` is false and stays false until the executable's consuming routine is
 * read; `note` says so in terms an author can act on, the way `SkyProjectText`
 * says why text is empty. The bytes are Preserved so nothing is lost while the
 * layout is unknown.
 */
export interface LureProjectWorldState {
  /** The resource id — 16398. */
  resource: number;
  /** Its length in bytes — the executable's save-slot size. */
  length: number;
  /** The whole snapshot, base64'd. Preserved bytes. */
  bytesBase64: string;
  /** Whether its records have been read into typed fields. False, for now. */
  typed: boolean;
  /** Why it is read-only, in terms an author can act on. */
  note: string;
}

/**
 * The editable form of a SCI game.
 *
 * ADR 0018, and it needed a third answer because a **Script resource** is
 * neither a bag of handlers (ADR 0005's v6 model) nor a self-contained script
 * (ADR 0013's AGI one). It is a linked unit: class definitions with their
 * Selector tables and method dispatch, object instances, code, locals, a
 * strings and `said` table, and a relocation list.
 *
 * **Method bodies are instruction lists**, which is ADR 0005's model and
 * applies cleanly here because SCI boundaries are derived from the opcode byte
 * — so Decompilation rather than mere Disassembly is available.
 *
 * **The class graph is new**, and neither sibling needed it. The cost lands in
 * one place: the assembler is a *linker*, not an emitter. Adding a Selector to
 * a class relays out every instance of it and every relocation entry; adding a
 * method changes the dispatch table; and a new Selector must extend the game's
 * own table **without renumbering the ones untouched Script resources still
 * index by number**.
 */
export interface SciProject {
  /** How the Version was established, and on what evidence (ADR 0020). */
  identification: { how: string; evidence: string[] };
  /**
   * The Version these instructions were decoded at, because emitting them
   * needs it too.
   *
   * **An operand's width is not always in the opcode's low bit.** From SCI2 on,
   * seven opcodes — `call`, `callk`, `callb`, `calle`, `send`, `self`, `super`
   * — take their parameter block as a *word* whatever that bit says, which is
   * ScummVM's `script_adjust_opcode_formats`. The decoder is given the Version
   * and applies it; the emitter was not, so it wrote every one of those
   * instructions a byte short. King's Quest VII's script 42 is where that
   * surfaced: `send 6` read as three bytes and re-emitted as two.
   *
   * Optional, and absent means byte blocks. That is the correct reading for
   * every project saved before this field existed: only SCI0 and SCI1 scripts
   * were ever turned into instructions, and neither has a word block.
   */
  version?: SciVersion;
  /**
   * The game's own Selector table, in order.
   *
   * Held whole rather than as the names actually used, because the *numbering*
   * is what untouched Script resources index by. A new Selector is appended;
   * nothing already in this list may move.
   */
  selectors: string[];
  /** Class number to the Script resource that defines it, from `vocab.996`. */
  classes: Array<{ number: number; script: number }>;
  scripts: SciProjectScript[];
  /** Views, Pictures, fonts, cursors and vocabularies, as bytes for now. */
  resources: SciProjectResource[];
  /**
   * Displayable text, where this game keeps it in `MESSAGE` resources.
   *
   * ADR 0009 applies unchanged: text that lives in its own resource is Project
   * content, edited as itself rather than as bytes inside an instruction. Empty
   * for SCI0 and SCI1, whose text is inline — and the editor says which
   * (`describeTextSurface`) rather than implying completeness.
   */
  messages: SciProjectMessage[];
  /**
   * Pictures held as their own kind, split by what they *are* (ADR 0018).
   *
   * Vector and cel Pictures are **two resource kinds that happen to share a
   * resource type number**, not one editor with a Version mode. A vector
   * drawing tool and a bitmap composition tool share no editing operation, and
   * one editor with half its buttons greyed out by Version is the bag of flags
   * ADR 0007's test exists to prevent.
   */
  vectorPictures: SciProjectResource[];
  /**
   * Cel Pictures, held as compositions rather than only as bytes.
   *
   * This is what "its own resource kind" means in practice (#222, #227). A
   * vector Picture is edited as drawing operations; a cel Picture is edited as
   * **an arrangement of items at positions and priorities** — move one, reorder
   * two, change what occludes what. Those two sets of operations do not
   * intersect, which is ADR 0018's whole argument, and holding the composition
   * here is what stops the second editor being the first one with its buttons
   * greyed out.
   *
   * From SCI2 a Picture's items carry their own position and priority, so a
   * room's authored composition is literally in the resource. Before SCI2 there
   * is one item and it is the background, and an editor says so.
   */
  celPictures: SciProjectCelPicture[];
  /**
   * Every language this release ships, by its resource-number offset.
   *
   * Some European SCI1.1 releases carry several languages in one game with a
   * runtime selection. Importing one and discarding the rest is silent data
   * loss, and by this project's own definitions that is `Unrecovered` — a
   * resource that did not come back as it arrived.
   */
  languages: SciProjectLanguage[];
  /**
   * Resources that did not come back as they arrived.
   *
   * `CONTEXT.md`'s `Unrecovered`, with a target of zero over untouched
   * resources. An edited resource must be *valid*, not identical.
   */
  unrecoveredCount: number;
}

/** One Script resource, held as its class graph rather than as bytes. */
export interface SciProjectScript {
  number: number;
  /** Objects and classes this script defines, by name where the game gave one. */
  objects: SciProjectObject[];
  /** Export offsets, which is how another script reaches into this one. */
  exports: number[];
  /** Local variables the script declares. */
  locals: number[];
  /**
   * Where those locals live, so a changed one can be written back.
   *
   * Script 0's locals are the game's **globals** — the SCI equivalent of
   * Broken Sword II's `Globals` resource — and every other script's are its
   * own state between rooms. Same two-resource question the objects have: a
   * block of the Script resource before SCI1.1 and again at SCI3, and in the
   * heap resource in between.
   */
  localsAt?: { resource: 'code' | 'heap'; offset: number };
  /**
   * The original bytes, kept so an untouched script exports byte-identically.
   *
   * ADR 0010's reasoning applied to a third family: a resource nobody edited
   * should come back exactly as it arrived, and the cheapest way to guarantee
   * that is not to rebuild it. The linker runs for the ones that changed.
   */
  bytes: string;
  /**
   * The heap resource's bytes, for a SCI1.1 script.
   *
   * Kept separately rather than as one combined buffer, because a round trip
   * writes back two resources and the word of alignment padding between them
   * belongs to neither — reconstructing the split would put it in the wrong
   * half for any script whose code is an odd number of bytes.
   */
  heapBytes?: string;
  /** Why this script could not be held as a graph, when it could not. */
  unrecovered?: string;
}

/** One object or class in the graph. */
export interface SciProjectObject {
  /** The name the game recorded, or a generated one. */
  name: string;
  /** True for a class definition, false for an instance. */
  isClass: boolean;
  species: number;
  superClass: number;
  /** Property values, in the order the class's Selector table declares them. */
  variables: number[];
  /** Which Selector each variable answers to, for a class. */
  variableSelectors: number[];
  /**
   * Where those property words live, so a changed one can be written back.
   *
   * A SCI object's properties are its state — the room a door leads to, the
   * view an actor wears, the priority a prop draws at — and they are the half
   * of the class graph that is not code. Holding the values without holding
   * where they came from makes them readable and not editable, which is the
   * shape ADR 0013 calls a gap rather than a capability.
   *
   * Which resource matters and is not derivable here. Before SCI1.1 the
   * objects are blocks inside the Script resource; from SCI1.1 they are in the
   * **heap** resource beside it, and the export writes two files. SCI3 puts
   * them back in the Script resource again.
   *
   * Absent where a script could not be read as a graph at all.
   */
  variablesAt?: { resource: 'code' | 'heap'; offset: number };
  /** Method bodies, as instruction lists (ADR 0005's model). */
  methods: SciProjectMethod[];
}

export interface SciProjectMethod {
  /** The Selector this method answers to, by name where one is known. */
  selector: string;
  selectorNumber: number;
  /** Where the body starts in the script, for the round trip. */
  offset: number;
  /** The body, disassembled. */
  instructions: SciProjectInstruction[];
  /** Set when the body could not be disassembled to its end. */
  unrecovered?: string;
}

export interface SciProjectInstruction {
  offset: number;
  name: string;
  operands: number[];
  /** The raw opcode byte, low bit included — the low bit is the operand width. */
  raw: number;
  /**
   * The source file name a `fileName` instruction carries, without its NUL.
   *
   * Sierra's debug builds record where each method came from, and the string
   * sits in the instruction stream rather than in a table. It is held here for
   * the same reason every other operand is: the instruction list is the script
   * (ADR 0018), and a list that drops the string re-emits the opcode alone —
   * which shortens the method and moves everything after it.
   */
  text?: string;
}

export interface SciProjectResource {
  type: string;
  number: number;
  bytes: string;
}

/**
 * A cel Picture: its bytes, and the composition an author edits.
 *
 * Both, for ADR 0010's reason applied a third time — a resource nobody touched
 * comes back exactly as it arrived, and the cheapest guarantee of that is not
 * to rebuild it. The composition is what an edit changes; the bytes are what an
 * untouched Picture exports.
 */
export interface SciProjectCelPicture extends SciProjectResource {
  /** `sci11` for the container SCI1.1 introduced, `sci32` for SCI2's. */
  container: 'sci11' | 'sci32';
  /** The display size the Picture declares, where it declares one. */
  resolution: { width: number; height: number } | null;
  items: SciProjectCelItem[];
  /** True when this Picture also carries vector operations, as SCI1.1's do. */
  hasVectors: boolean;
  /** Why the composition could not be read, when it could not. */
  unrecovered?: string;
}

/**
 * One item in a cel Picture's composition.
 *
 * Position and priority are the two things an author moves, and they are
 * **fixed-width fields in the resource's own cel header** — so moving an item
 * rewrites six bytes rather than relaying the Picture out. That is a genuine
 * difference from editing a Script resource, where changing anything can move
 * everything (ADR 0018's linker), and it is why this editor needs no linker.
 */
export interface SciProjectCelItem {
  /** Where the item's header sits, so an edit knows which bytes to write. */
  headerAt: number;
  width: number;
  height: number;
  x: number;
  y: number;
  priority: number;
}

/**
 * One Message: one authored item with three faces under one key.
 *
 * Text, recorded speech and mouth timing, keyed by the same (noun, verb,
 * condition, sequence) tuple. Three parallel tables that happen to share a key
 * is how a translation ends up with the right words and the wrong lip sync
 * (#222).
 */
export interface SciProjectMessage {
  /** The MESSAGE resource this came from, which is also its room. */
  resource: number;
  noun: number;
  verb: number;
  cond: number;
  seq: number;
  talker: number;
  text: string;
  /** The `audio36` resource number holding the recording, when one exists. */
  audio?: number;
  /** The `sync36` resource number holding the mouth timing. */
  sync?: number;
  /** Which language this line is in, for a multilingual release. */
  language?: string;
}

/** One language a multilingual release ships. */
export interface SciProjectLanguage {
  /** Sierra's own number, which offsets the resource numbers of its text. */
  number: number;
  name: string;
  /** How many resources belong to it, so nothing is silently dropped. */
  resourceCount: number;
}

/**
 * The editable form of an AGI game.
 *
 * ADR 0013: **one representation.** A Logic is held as a decompiled tree, and
 * that tree is the truth for both halves of the editor — what was imported and
 * what an author writes from nothing. There is no `Action` set here and no
 * Preserved bytes: a Logic that could not be decompiled is **Unrecovered**,
 * held as its original bytes, shown read-only, and counted.
 */
export interface AgiProject {
  /**
   * How the interpreter version was established, and by what evidence.
   *
   * Recorded alongside the Unrecovered count because the count is meaningless
   * without it: a game decoded with the wrong arity table scores zero (ADR
   * 0013). A project whose identification is a fallback should not exist —
   * editing is refused before import — so this is the receipt rather than a
   * caveat.
   */
  interpreter: { identification: string; evidence: string };

  logics: AgiProjectLogic[];
  pictures: AgiProjectResource[];
  views: AgiProjectResource[];
  sounds: AgiProjectResource[];

  /** `WORDS.TOK`, as word-to-group pairs so the project stays plain JSON. */
  words: Array<[string, number]>;
  /** The `OBJECT` file's inventory items. */
  inventory: {
    items: Array<{ name: string; startRoom: number }>;
    maxAnimatedObjects: number;
    /** Whether the file was obfuscated, so a re-emit matches byte for byte. */
    encrypted: boolean;
  };

  /**
   * Logic resources that could not be decompiled or did not re-emit exactly.
   *
   * A published number with a target of zero, not an escape hatch. `CONTEXT.md`
   * is explicit that the fix is a better decompiler, never a wider fallback.
   */
  unrecoveredCount: number;
}

/**
 * The AGOS half of a project (ADR 0025).
 *
 * Three things: Subroutines as instruction lists, the item tree by name, and
 * the pooled strings by index. Plain JSON throughout — the one field that is
 * not a number or a string is the string pool, which is carried as base64
 * because splitting and rejoining it is not always the identity and ADR 0026
 * rebuilds `GAMEPC` whole from exactly these bytes.
 */
export interface AgosProject {
  /**
   * How the Version was established.
   *
   * Recorded for the reason AGI's is: the Unrecovered count means nothing
   * without it. A game decoded under a wrong Version can still score zero, and
   * `narrowed` is the value that says editing should never have been offered.
   */
  identification: string;
  /** Whether ADR 0025's three conditions held, and what failed if not. */
  editable: { editable: boolean; unrecovered: number; reasons: string[] };
  /** The four header words, as they were read. */
  header: {
    itemArraySize: number;
    version: number;
    itemArrayInited: number;
    stringTableNum: number;
  };
  /** The pooled strings, base64, exactly as they sat in the file. */
  textBase64: string;
  /**
   * Whatever the release appended after the runtime database, base64.
   *
   * ADR 0035's Preserved bytes. The interpreter never reads a byte of it, but
   * an export that drops it is not the file it came from — the retail Windows
   * release of Simon 1 carries 7,909 bytes of symbol table here — and byte
   * identity for an unedited game is the property ADR 0030 rests on. It is
   * carried on the Project because the Project is what an export is built from;
   * leaving it in the engine would mean an export could only ever be byte-exact
   * in the session that imported it.
   */
  trailingBase64: string;
  /**
   * A fingerprint of the base file this project was built from.
   *
   * ADR 0034 asks for a same-game check "with teeth" before the editor accepts
   * a re-supplied folder, because a different game's zones render as plausible
   * nonsense — which is worse than an error. The length alone is not teeth: two
   * releases of one title can match on it. So a hash goes with it, computed
   * over the bytes at import and again over whatever folder is offered later.
   *
   * FNV-1a rather than SHA-256 because this is a mix-up check and not a
   * security one, and because it is synchronous: `crypto.subtle` is async, and
   * an async fingerprint would make every caller that only wants to *compare*
   * two files asynchronous with it.
   */
  baseFingerprint: { bytes: number; hash: number };
  /** Items from number 2 upward, each with its links and typed sub-structures. */
  items: AgosItem[];
  /** The Subroutine block, as instruction lists. */
  subroutines: AgosSubroutineBlock;
  /**
   * The game's art, listed rather than carried.
   *
   * Absent when the project was built without a `ZoneSource` — the pixels are
   * not in `GAMEPC`, so a caller holding only the base file has no art to
   * offer, which is the normal case for a test. Metadata only, deliberately:
   * see `agos/images.ts` for why decoded bitmaps do not live in a Project.
   */
  art?: AgosArt;
  /**
   * The rooms, and the picture each one's own script puts up.
   *
   * Always present for a project read by `importAgosProject`, because a room is
   * an item with a room sub-structure and the item tree is in `GAMEPC`. The
   * *pictures* are not: they are named by `o_picture` inside each room's
   * Subroutine, which usually lives in a `TABLES` file — so a room with no
   * `picture` is one whose script was not available or whose picture is chosen
   * at runtime, and both are still rooms. See `authoring/agos/rooms.ts`.
   */
  rooms?: AgosRooms;
  /**
   * Images an author has painted, as intent rather than as bytes.
   *
   * ADR 0030's shape: the Project holds what the author meant and export
   * applies it to the folder the player supplies again. Affordable because the
   * unit is a sprite and not a zone — see `agos/paint.ts`.
   */
  paintedImages?: PaintedImage[];
}

export interface AgiProjectLogic {
  number: number;
  /**
   * The decompiled tree, absent when this Logic is Unrecovered.
   *
   * Typed as `unknown` here and narrowed by `src/authoring/agi` rather than
   * imported, because `project.ts` is the shape a JSON file has and pulling the
   * AGI tree's types in would make every consumer of a SCUMM project depend on
   * the AGI decompiler.
   */
  tree?: unknown;
  /** The original bytes, base64. Always present, tree or not. */
  bytes: string;
  /** Why this Logic is Unrecovered, when it is. Shown to the author verbatim. */
  unrecovered?: string;
}

export interface AgiProjectResource {
  number: number;
  /** Base64 of the resource as it arrived, which is also how it is re-emitted. */
  bytes: string;
}

/**
 * What came out of a published game that the project cannot hold as itself.
 *
 * Art and geometry become ordinary project data and need no record. Behaviour
 * does not: scripts are bytecode, the editor stores actions, and no importer
 * turns one into the other. Listing them keeps an author from assuming an
 * imported game is complete when its behaviour is not.
 */
export interface ImportedGame {
  game: string;
  importedAt: number;
  scripts: ImportedScript[];
  /** Costumes found, including any beyond the actor id range. */
  costumes: Array<{ id: number; poses: number; limbs: number }>;
  /** Objects whose id had to move out of the actor range, and where to. */
  renumberedObjects: Array<{ from: number; to: number }>;
}

export interface ImportedScript {
  kind: 'global' | 'local' | 'entry' | 'exit' | 'object';
  id: number;
  room?: number;
  verb?: number;
  size: number;
}

export interface ProjectVerb {
  id: number;
  text: string;
  x: number;
  y: number;
  color: number;
  hiColor: number;
  key: string;
}

/** One drawn cel of a pose, and how long it stays on screen. */
export interface SpriteCel {
  image: StoredImage;
  /** Engine ticks to hold it. Higher is slower. */
  hold: number;
}

/**
 * Which way an actor is facing, for artwork that differs by direction.
 *
 * `all` is the artwork used for any direction with none of its own, which is
 * what a hand-drawn character usually wants: one walk cycle, mirrored by the
 * engine. A costume out of a published game normally does have four, because
 * a character seen from behind is not a character seen from the front.
 */
export type PoseFacing = 'all' | 'north' | 'east' | 'south' | 'west';

/** The four real directions, in the order a costume stores them. */
export const POSE_DIRECTIONS = ['west', 'east', 'south', 'north'] as const;

/**
 * One pose, which may look different depending on the way the actor faces.
 *
 * Shaped to match the costume builder's own frame definition, so compiling is
 * a copy rather than a translation.
 */
export interface SpritePose {
  all?: SpriteCel[];
  north?: SpriteCel[];
  east?: SpriteCel[];
  south?: SpriteCel[];
  west?: SpriteCel[];
}

/** The cels to draw for a facing, falling back to the shared artwork. */
export function poseCels(pose: SpritePose | undefined, facing: PoseFacing): SpriteCel[] {
  if (!pose) return [];
  if (facing === 'all') return pose.all ?? [];
  return pose[facing] ?? pose.all ?? [];
}

/** True when a pose has artwork for any facing at all. */
export function poseHasArt(pose: SpritePose | undefined): boolean {
  if (!pose) return false;
  return (['all', ...POSE_DIRECTIONS] as PoseFacing[]).some(
    (facing) => (pose[facing as keyof SpritePose]?.length ?? 0) > 0,
  );
}

/**
 * Whatever artwork a pose has, under whichever facing it is stored.
 *
 * `poseCels(pose, 'all')` answers a narrower question — "is there a shared
 * drawing?" — and for a costume imported from a published game the answer is
 * no: its four views genuinely differ, so every direction is filled and the
 * shared slot is empty. Code that wants "what does this character look like"
 * has to accept any of them, or it concludes that a fully drawn character has
 * no artwork at all and substitutes a placeholder for it.
 *
 * Shared artwork still wins, because `definedFacings` lists it first.
 */
export function anyPoseCels(pose: SpritePose | undefined): SpriteCel[] {
  const facing = definedFacings(pose)[0];
  return facing ? poseCels(pose, facing) : [];
}

/** Every facing a pose actually defines its own artwork for. */
export function definedFacings(pose: SpritePose | undefined): PoseFacing[] {
  if (!pose) return [];
  return (['all', ...POSE_DIRECTIONS] as PoseFacing[]).filter(
    (facing) => (pose[facing as keyof SpritePose]?.length ?? 0) > 0,
  );
}

export interface ProjectActor {
  id: number;
  name: string;
  talkColor: number;
  /**
   * Where this actor starts, if anywhere.
   *
   * Actor 1 is the player and always starts at the game's start position.
   * Anyone else has to be placed, or they exist but are never in a room.
   */
  start?: { room: number; x: number; y: number };
  /** Verb handlers, exactly as objects have — this is what makes an NPC. */
  handlers: ProjectHandler[];
  /** Runs for any verb without a handler. */
  otherwise: Action[];
  walkSpeed: { x: number; y: number };
  /**
   * The resource id this actor's costume is compiled under, when it matters.
   *
   * Only an imported game sets it. Its scripts change costumes by the numbers
   * the published game used, so those numbers have to survive the round trip
   * or every such script dresses an actor in a costume that is not there.
   */
  costumeId?: number;
  /** Costume colours 1..15; index 0 is always transparent. */
  palette: number[];
  /**
   * Poses, indexed by SCUMM frame number, so 0 is unused.
   *
   * Each is a sequence of cels the engine cycles through, which is what makes
   * a walk look like walking rather than sliding.
   */
  poses: SpritePose[];
}

export interface ProjectRoom {
  id: number;
  name: string;
  width: number;
  height: number;
  background: StoredImage;
  /**
   * Where this room's picture came from, so an edit can be written back to it.
   *
   * Recorded for the pre-v5 layouts, whose `BM` block *is* the strip table and
   * can therefore be replaced whole. Absent at v5 and later, where the picture
   * is a `SMAP` inside an `IM00` inside an `RMIM` and writing one back is a
   * rebuild of the nesting rather than a substitution — a separate piece of
   * work, and one no issue in the v2–v8 widening asks for.
   */
  artOrigin?: ArtOrigin;
  /**
   * Colours this room's pixels index, when it does not use the game's.
   *
   * A published game gives each room its own table, so without this an imported
   * background is drawn with the wrong colours entirely — the indices are
   * right and mean something else. Absent means the default palette, which is
   * what an authored room uses.
   */
  palette?: number[][];
  /** One entry per z-plane; masks are stored the same way as images. */
  zPlanes: StoredImage[];
  boxes: BoxDefinition[];
  /** Perspective for boxes that opt in. Absent means no scaling. */
  perspective?: ScaleRamp;
  objects: ProjectObject[];
  onEnter: Action[];
  onExit: Action[];
  /**
   * Scripts that belong to this room, started by id from inside it.
   *
   * SCUMM keeps these in the room resource so they load and unload with it,
   * and a room's entry script routinely starts one to set the scene up. A room
   * imported without them enters, starts a script that is not there, and sets
   * nothing up at all.
   */
  localScripts?: ProjectScript[];
}

export interface ProjectObject {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  walkTo: { x: number; y: number };
  facing: 'north' | 'east' | 'south' | 'west';
  initialState: number;
  classes: number[];
  /** One image per state; state 1 draws `states[0]`. */
  states: StoredImage[];
  /** Where the picture came from, for the layouts an edit can be written to. */
  artOrigin?: ArtOrigin;
  handlers: ProjectHandler[];
  /** Runs for any verb without a handler. */
  otherwise: Action[];
}

/**
 * A picture's address in the game it was imported from.
 *
 * The same shape as a script's origin and for the same reason: an export
 * rewrites the original files, so what it needs is where a resource sat rather
 * than what it meant.
 */
export interface ArtOrigin {
  room: number;
  /** Offset of the `BM` or `OI` block within the room's own resource. */
  chunkOffset: number;
  /**
   * Sixteen colours rather than 256, which is a different strip table.
   *
   * Recorded here rather than worked out from the room's palette at export
   * time, because `paletteFromClut` pads a sixteen-colour table out to 256
   * entries — so the palette a project carries cannot tell the two apart, and
   * a guess from its length says "256" for every room in an EGA game.
   */
  sixteenColour: boolean;
}

export interface ProjectHandler {
  verbId: number;
  actions: Action[];
}

export interface ProjectScript {
  id: number;
  name: string;
  actions: Action[];
}

export const PROJECT_VERSION = 6;

/** The first *screen* row the verbs occupy. */
export const DEFAULT_VERB_TOP = 144;

/** Screen rows above the room view, where some games put dialogue. */
export const DEFAULT_TEXT_HEIGHT = 16;

/**
 * How many rows of a room the player can see.
 *
 * Not `verbTop`. The room view starts below the text band and ends where the
 * verbs begin, so it is `verbTop - textHeight` rows tall and room row R is
 * drawn at screen row `R + textHeight`. Actors are clipped to that view, so an
 * actor standing at or below this row is not merely low but absent.
 *
 * Reading `verbTop` as a room row is off by the height of the text band — with
 * the usual 16, sixteen rows of somewhere to stand that nothing is drawn in.
 * Anywhere that decides where to *put* an actor needs the real number, so it is
 * worked out here rather than at each of them.
 */
export function visibleRoomRows(screen?: { textHeight: number; verbTop: number }): number {
  const verbTop = screen?.verbTop ?? DEFAULT_VERB_TOP;
  const textHeight = screen?.textHeight ?? DEFAULT_TEXT_HEIGHT;
  return Math.max(1, verbTop - textHeight);
}

/**
 * The SCUMM version a project targets, or null when it is not a SCUMM project.
 *
 * Every call site that used to read a bare `scummVersion` reads this instead,
 * so "which assembler" is answered from the Target rather than from a number
 * that might belong to the other family. Returning null rather than a default
 * is the point: an AGI project has no SCUMM version, and treating it as v5 is
 * exactly the silent mis-tag ADR 0012 was written against.
 */
export function scummVersionOf(target: Target): ScummVersionTarget | null {
  return target.engine === 'scumm' ? target.version : null;
}

/** A new, empty-but-playable project: one room, one actor, the usual verbs. */
export function createProject(name = 'Untitled'): Project {
  return {
    version: PROJECT_VERSION,
    target: { engine: 'scumm', version: 5 },
    name,
    start: { room: 1, x: 100, y: 120 },
    defaultResponse: "That doesn't seem to work.",
    screen: { textHeight: 16, verbTop: DEFAULT_VERB_TOP },
    verbs: [
      { id: 1, text: 'Look at', x: 12, y: 152, color: 15, hiColor: 14, key: 'l' },
      { id: 2, text: 'Pick up', x: 12, y: 164, color: 15, hiColor: 14, key: 'p' },
      { id: 3, text: 'Open', x: 12, y: 176, color: 15, hiColor: 14, key: 'o' },
      { id: 4, text: 'Talk to', x: 120, y: 152, color: 15, hiColor: 14, key: 't' },
      { id: 5, text: 'Use', x: 120, y: 164, color: 15, hiColor: 14, key: 'u' },
    ],
    actors: [
      {
        id: 1,
        name: 'Player',
        talkColor: 11,
        walkSpeed: { x: 5, y: 2 },
        // Skin and hair tones, clothing, then a grey ramp — a starting set
        // that covers a character without anyone having to pick colours first.
        palette: [
          6, 14, 2, 1, 8, 4, 12, 15, 7, 3, 5, 10, 11, 13, 9, 16, 52, 88, 124, 160, 196, 232, 238,
          244, 250, 34, 70, 106, 142, 178, 214,
        ],
        poses: [],
        handlers: [],
        otherwise: [],
      },
    ],
    rooms: [],
    scripts: [],
    audio: [],
  };
}

/** Next free id in a list, so the editor never has to ask the author. */
export function nextId(used: number[], from = 1): number {
  const taken = new Set(used);
  let candidate = from;
  while (taken.has(candidate)) candidate++;
  return candidate;
}

/**
 * Ids below this are actors; at or above, objects.
 *
 * The sentence script has only a number to work with when the player clicks
 * something, so the two id spaces have to be separable arithmetically.
 */
export const ACTOR_ID_LIMIT = 20;

export function allObjectIds(project: Project): number[] {
  return project.rooms.flatMap((room) => room.objects.map((object) => object.id));
}

/**
 * Validates a parsed project.
 *
 * Returns problems rather than throwing, so the editor can show all of them at
 * once and still open a partly-broken file rather than refusing it.
 */
export function validateProject(project: Project): string[] {
  const problems: string[] = [];

  if (project.rooms.length === 0) problems.push('The game has no rooms');

  if (!project.rooms.some((room) => room.id === project.start.room)) {
    problems.push(`The starting room (${project.start.room}) does not exist`);
  }

  if (project.actors.length === 0) problems.push('The game has no actors');

  for (const actor of project.actors) {
    if (actor.id < 1 || actor.id >= ACTOR_ID_LIMIT) {
      problems.push(`Actor id ${actor.id} is out of range; actors are 1-${ACTOR_ID_LIMIT - 1}`);
    }
  }
  const actorIds = project.actors.map((actor) => actor.id);
  for (const id of new Set(actorIds.filter((id, i) => actorIds.indexOf(id) !== i))) {
    problems.push(`Actor id ${id} is used more than once`);
  }

  const objectIds = allObjectIds(project);
  for (const id of objectIds) {
    if (id < ACTOR_ID_LIMIT) {
      problems.push(`Object id ${id} clashes with the actor id range (1-${ACTOR_ID_LIMIT - 1})`);
    }
  }
  const duplicates = objectIds.filter((id, index) => objectIds.indexOf(id) !== index);
  for (const id of new Set(duplicates)) {
    problems.push(`Object id ${id} is used more than once; ids must be unique across all rooms`);
  }

  const roomIds = project.rooms.map((room) => room.id);
  for (const id of new Set(roomIds.filter((id, i) => roomIds.indexOf(id) !== i))) {
    problems.push(`Room id ${id} is used more than once`);
  }

  const roomIdSet = new Set(project.rooms.map((room) => room.id));
  for (const actor of project.actors) {
    if (actor.start && !roomIdSet.has(actor.start.room)) {
      problems.push(
        `Actor ${actor.id} ("${actor.name}") starts in room ${actor.start.room}, ` +
          `which does not exist`,
      );
    }
  }

  // A "go to room" step aimed at a deleted room compiles but strands the
  // player, so it is worth catching here rather than in play.
  for (const [where, actions] of collectActionLists(project)) {
    for (const room of gotoRoomTargets(actions)) {
      if (!roomIdSet.has(room)) {
        problems.push(`${where} goes to room ${room}, which does not exist`);
      }
    }
  }

  for (const room of project.rooms) {
    if (room.boxes.length === 0) {
      problems.push(`Room ${room.id} ("${room.name}") has no walk boxes, so nobody can move`);
    }
  }

  return problems;
}

/** Every action list in the project, labelled with where it came from. */
function collectActionLists(project: Project): Array<[string, Action[]]> {
  const lists: Array<[string, Action[]]> = [];

  for (const room of project.rooms) {
    lists.push([`Room ${room.id} entry`, room.onEnter]);
    lists.push([`Room ${room.id} exit`, room.onExit]);
    for (const object of room.objects) {
      lists.push([`Object ${object.id} ("${object.name}") default`, object.otherwise]);
      for (const handler of object.handlers) {
        lists.push([
          `Object ${object.id} ("${object.name}") verb ${handler.verbId}`,
          handler.actions,
        ]);
      }
    }
  }
  for (const actor of project.actors) {
    lists.push([`Actor ${actor.id} ("${actor.name}") default`, actor.otherwise]);
    for (const handler of actor.handlers) {
      lists.push([`Actor ${actor.id} ("${actor.name}") verb ${handler.verbId}`, handler.actions]);
    }
  }
  for (const script of project.scripts) {
    lists.push([`Script ${script.id}`, script.actions]);
  }
  return lists;
}

/** Rooms a list of actions sends the player to, including inside branches. */
function gotoRoomTargets(actions: Action[]): number[] {
  const rooms: number[] = [];
  for (const action of actions) {
    if (action.type === 'gotoRoom') rooms.push(action.room);
    if (action.type === 'if') {
      rooms.push(...gotoRoomTargets(action.then), ...gotoRoomTargets(action.else ?? []));
    }
  }
  return rooms;
}

/** Reads a project from JSON, upgrading older versions where possible. */
export function migrate(raw: unknown): Project {
  if (typeof raw !== 'object' || raw === null) throw new Error('Not a project file');
  const candidate = raw as Partial<Project>;

  if (typeof candidate.version !== 'number') {
    throw new Error('Not a project file (no version)');
  }
  if (candidate.version > PROJECT_VERSION) {
    throw new Error(
      `This project was saved by a newer version of the editor ` +
        `(format ${candidate.version}, this build understands ${PROJECT_VERSION})`,
    );
  }

  const base = createProject(candidate.name ?? 'Untitled');
  const actors = (candidate.actors ?? base.actors).map(upgradeActor);
  const rooms = (candidate.rooms ?? []).map(upgradeRoom);

  // Fill in anything a hand-edited file might be missing rather than failing.
  return {
    ...base,
    ...candidate,
    version: PROJECT_VERSION,
    target: migrateTarget(raw as Record<string, unknown>),
    // Absent before v7 support and absent for any import small enough to store
    // its originals, so undefined is the normal case rather than a loss.
    origin: candidate.origin,
    strings: candidate.strings,
    screen: candidate.screen ?? base.screen,
    verbs: candidate.verbs ?? base.verbs,
    actors,
    rooms,
    scripts: candidate.scripts ?? [],
    // Absent before version 4, and an empty library is the correct reading of
    // a project saved before the editor could hold any audio at all.
    audio: (candidate.audio ?? []).filter(isAudioTrack),
  };
}

/**
 * Works out what a project file is built for, or refuses to guess.
 *
 * Three cases, and the third is the one with history in it.
 *
 * A `target` already present is read back and validated. A `scummVersion` of
 * 5, 6 or 7 becomes `{engine: 'scumm', version: n}` — the whole of what those
 * files meant. **Neither field present at all** means a project written before
 * targets existed, which was v5, and that is preserved.
 *
 * Anything else throws. `src/authoring/project.ts` carried
 * `=== 6 ? 6 : 5` while there were two targets, which silently retagged a v7
 * project as v5 — a project holding v7 instructions built with the v5
 * assembler, which loaded fine and compiled wrong. Widening the target set to a
 * second Engine family widens that hazard much further: `{engine: 'scumm',
 * version: 5}` is a plausible-looking wrong answer for an AGI project in
 * precisely the way `5` was for a v7 one. So a value that is *present and
 * unrecognised* is a refusal rather than a default, because the alternative is
 * a project that opens and builds against the wrong assembler (#123).
 */
export function migrateTarget(raw: Record<string, unknown>): Target {
  if (raw.target !== undefined) {
    const parsed = parseTarget(raw.target);
    if (parsed) return parsed;
    throw new Error(
      `This project's target is not one this build recognises ` +
        `(${JSON.stringify(raw.target)}). Opening it would mean guessing which ` +
        `engine and instruction encoding it was written for, and a wrong guess ` +
        `compiles against the wrong assembler rather than failing.`,
    );
  }

  const legacy = raw.scummVersion;
  if (legacy === undefined) {
    // No target of any kind: written before v6 support, and it was v5.
    return { engine: 'scumm', version: 5 };
  }

  const parsed = parseTarget({ engine: 'scumm', version: legacy });
  if (parsed) return parsed;

  throw new Error(
    `This project is tagged SCUMM v${String(legacy)}, which this build has no ` +
      `assembler for. It is refused rather than opened as another version: a ` +
      `project built with the wrong assembler loads fine and produces a game ` +
      `that does not run.`,
  );
}

/**
 * Rejects audio entries a hand-edited or truncated file might carry.
 *
 * A track with no bytes would sit in the library looking playable and fail
 * every time it was clicked, which is worse than not being listed.
 */
function isAudioTrack(track: ProjectAudio): boolean {
  if (typeof track?.id !== 'number') return false;
  // Three places bytes can be, and a track has to name one of them. A track
  // naming none would sit in the library looking playable and fail every time
  // it was clicked.
  const inline = typeof track.data === 'string' && track.data.length > 0;
  const external = typeof track.storeKey === 'string' && track.storeKey.length > 0;
  // The third is the game's own files, which is where a published game's
  // speech stays: too large to inline and too large to copy into the store
  // (ADR 0010), so the project records the number and the folder supplies the
  // bytes (ADR 0034). Checked to the same depth as the other two — an address
  // with no kind or no number is as useless as an empty `data`.
  const resource =
    typeof track.resource?.number === 'number' &&
    (track.resource.kind === 'speech' ||
      track.resource.kind === 'effects' ||
      track.resource.kind === 'music');
  return inline || external || resource;
}

/**
 * Brings a room forward from versions 1 and 2.
 *
 * Version 2 stored walk boxes as rectangles and had no perspective at all.
 * Rectangles become quadrilaterals with the same corners, which is exactly
 * equivalent.
 *
 * Perspective is added where the field is absent, because before version 3 it
 * was not a setting anybody could turn off — its absence means "never had the
 * option", not "deliberately flat". A room that should stay flat can be
 * switched off in one click, whereas a silently flat room is the thing that
 * looks broken.
 */
function upgradeRoom(room: ProjectRoom): ProjectRoom {
  const boxes = room.boxes.map((box) => {
    const legacy = box as unknown as { x?: number; y?: number; width?: number; height?: number };
    if (legacy.x === undefined || legacy.width === undefined) return box;

    return rectangleBox(legacy.x, legacy.y ?? 0, legacy.width, legacy.height ?? 1, {
      scale: box.scale,
      mask: box.mask,
      blocked: box.blocked,
      // Opt every migrated box in, so the new ramp actually applies.
      perspective: box.perspective ?? true,
    });
  });

  if (room.perspective !== undefined) return { ...room, boxes };

  return {
    ...room,
    boxes,
    perspective: {
      farY: Math.round(room.height * 0.7),
      farScale: 160,
      nearY: room.height - 1,
      nearScale: 255,
    },
  };
}

/**
 * Brings a version 1 actor forward.
 *
 * Version 1 stored one image per pose (`frames`); version 2 stores a sequence
 * of cels (`poses`), so each old image becomes a one-cel pose. The result looks
 * identical — a one-cel animation is a still frame — so upgrading is lossless.
 */
function upgradeActor(actor: ProjectActor & { frames?: Array<StoredImage | null> }): ProjectActor {
  if (Array.isArray(actor.poses)) {
    return {
      ...actor,
      poses: actor.poses.map(upgradePose),
      handlers: actor.handlers ?? [],
      otherwise: actor.otherwise ?? [],
    };
  }

  const poses: SpritePose[] = [];
  for (const [index, image] of (actor.frames ?? []).entries()) {
    poses[index] = image ? { all: [{ image, hold: 6 }] } : {};
  }

  const { frames: _discarded, ...rest } = actor;
  return { ...rest, poses, handlers: actor.handlers ?? [], otherwise: actor.otherwise ?? [] };
}

/**
 * Brings a version 4 pose forward.
 *
 * Version 4 held one list of cels per pose, drawn whichever way the character
 * faced. That becomes the shared `all` artwork, which is exactly what it
 * already meant — so the upgrade is lossless, and a hand-drawn character keeps
 * behaving as it did while gaining somewhere to put per-direction art.
 */
function upgradePose(pose: SpritePose | SpriteCel[] | null | undefined): SpritePose {
  if (!pose) return {};
  if (Array.isArray(pose)) return pose.length > 0 ? { all: pose } : {};
  return pose;
}
