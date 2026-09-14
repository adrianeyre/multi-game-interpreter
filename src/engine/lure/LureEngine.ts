/**
 * `LureEngine` — Lure of the Temptress as an `AdventureEngine`.
 *
 * ## The seam, tested a fifth time
 *
 * ADR 0011 set a ceiling on `AdventureEngine`: "if it grows past roughly thirty
 * the seam is in the wrong place". ADR 0026 predicted Lure would force no new
 * member, on the ground that what the families do not share is the renderer and
 * the bytecode, not the shell. It does not: 320x200, so `resolution` reports the
 * degenerate pair; its own `EngineInput`, so the shell interprets nothing; its
 * own `saveFormat` and `saveNote`. The same seventeen members, a fifth time.
 *
 * ## What this engine does, and where it stops
 *
 * It reads Lure's disk containers with the verified reader (`lureDisk.ts`) and
 * reads its **initial world state** — resource 16398, the snapshot the
 * executable restores into a new game's save slot (`lureWorldState.ts`, ADR 0024
 * third amendment). That is the whole of the game's shipped starting point, and
 * reading it is what moves Lure off `refused`: a family with a reader that
 * reaches the world state has an interpreter's foundation, which a container
 * reader alone was not (#263).
 *
 * It **runs no scripts**, and says so rather than pretending to. Lure's bytecode
 * is a separate system from Sky's (ADR 0026) and this project does not read it
 * yet; there is no logic list to walk and no mcode to call. So `boot` reads the
 * world state, `step` does nothing, and `describeStatus` names the honest state
 * — the analogue of AGOS reading, identifying and saving without drawing, and
 * saying so on its status line instead of behind a black screen.
 *
 * It does not type the world state's fields either, for the reason
 * `lureWorldState.ts` gives at length: the 37,504-byte snapshot is not
 * data-side derivable, and naming its records would be the guess this project
 * refuses. So `currentRoom` is 0 and `roomName` is undefined — not because the
 * game has no rooms, but because reading which one it starts in needs the
 * executable's consuming routine, which is later work.
 *
 * ## What it does and does not open to the editor
 *
 * It **does** open Lure's palettes — its own six-bit VGA format, which round-trips
 * byte-identically, so editing a colour is a checked change (ADR 0025). It does
 * **not** open the object table: the world state stays Preserved bytes, read-only
 * and marked Unrecovered, until its layout can be *checked* rather than fitted
 * (ADR 0024). So `toEditableGame` returns a project with an editable palette
 * surface and a read-only object table, and `describeEditRefusal` refuses only
 * when there is no palette surface to offer.
 *
 * It still does not **draw** (there is no renderer), **play** (no sound without
 * scripts), or **export** (rebuilding a Lure game is refused for both families).
 */

import {
  type AdventureEngine,
  type EditableGame,
  type EditableGameOptions,
  type SavedGameEnvelope,
} from '../AdventureEngine.js';
import type { DataSource } from '../resource/DataSource.js';
import { Screen } from '../gfx/Screen.js';
import { Palette } from '../gfx/Palette.js';
import type { LureRelease, Target } from '../../authoring/target.js';
import {
  importLureProject,
  type LurePaletteResource,
  type LurePictureResource,
} from '../../authoring/lure/project.js';
import { LureInput } from './LureInput.js';
import { LureSound } from './LureSound.js';
import {
  parseLureDisk,
  lureDiskNumberFor,
  readLureResource,
  isLurePalette,
  LureDiskError,
  parseLurePalette,
  type LureColour,
} from './resource/lureDisk.js';
import {
  parseLureWorldState,
  describeLureWorldState,
  LURE_WORLD_STATE_ID,
  type LureWorldState,
} from './resource/lureWorldState.js';
import { decodeLurePicture } from './gfx/lureDecode.js';
import { parseLureWalkTo, describeLureWalkTo, type LureWalkTo } from './resource/lureHotspots.js';

/** This family's save payload version. Independent of every other family's. */
export const LURE_SAVE_FORMAT = 1;

/** Lure is 320x200, like both other Virtual Theatre-adjacent families. */
const LURE_SCREEN_WIDTH = 320;
const LURE_SCREEN_HEIGHT = 200;

/**
 * A room picture covers the game area, not the whole display.
 *
 * 320x192, the same split Sky has — the bottom eight rows are the panel. It is
 * not assumed: 99 resources across the shipped VGA containers decode to exactly
 * this many bytes, which is what identifies them as pictures at all.
 */
const LURE_GAME_AREA_HEIGHT = 192;
const LURE_GAME_AREA_BYTES = LURE_SCREEN_WIDTH * LURE_GAME_AREA_HEIGHT;

export interface LureEngineOptions {
  onLog?: (message: string) => void;
}

/** A Lure save: the envelope every family shares, plus this family's state. */
interface LureSavedGame extends SavedGameEnvelope {
  /** The world state, in the game's own format, as bytes. */
  readonly state: number[];
}

/** The executable's hotspot table, kept whole so an edit can be written back. */
export interface LureHotspotTable {
  readonly file: string;
  readonly bytes: Uint8Array;
  readonly records: readonly LureWalkTo[];
}

/**
 * A decoded picture and the palette it is shown with.
 *
 * "First" is literal and is the honest word: it is the first game-area picture
 * the containers hold, not the one the game would put on screen, because the
 * room table that would say which is which has not been read.
 */
export interface LureFirstPicture {
  readonly disk: number;
  readonly id: number;
  readonly pixels: Uint8Array;
  readonly colours: readonly LureColour[];
  /** How many game-area pictures were found, for the status line. */
  readonly found: number;
}

export class LureEngine implements AdventureEngine {
  readonly screen = new Screen(LURE_SCREEN_WIDTH, LURE_SCREEN_HEIGHT);
  readonly palette = new Palette();
  readonly saveFormat = LURE_SAVE_FORMAT;
  readonly saveNote =
    'Lure saves are this interpreter’s own format and are not readable by ScummVM, or by ' +
    'this project’s SCUMM, AGI, SCI or Sky saves.';
  readonly resolution = {
    script: { width: LURE_SCREEN_WIDTH, height: LURE_SCREEN_HEIGHT },
    display: { width: LURE_SCREEN_WIDTH, height: LURE_SCREEN_HEIGHT },
  };

  frame = 0;
  hasQuit = false;

  readonly sound = new LureSound();
  readonly input = new LureInput();

  private booted = false;
  /** Whether the picture has been put on the framebuffer. */
  private painted = false;

  private constructor(
    private readonly release: LureRelease,
    private readonly containerCount: number,
    private readonly world: LureWorldState,
    private readonly palettes: readonly LurePaletteResource[],
    private readonly hotspots: LureHotspotTable | null,
    private readonly picture: LureFirstPicture | null,
    private readonly pictures: readonly LurePictureResource[],
    private readonly log?: (message: string) => void,
  ) {}

  /**
   * Opens a game, or refuses with something a person can act on.
   *
   * The one thing a Lure game cannot start without here is its world state, so
   * its absence is refused by name rather than discovered by a blank screen: the
   * snapshot lives in `Disk2.vga` (or `disk2.ega`) as resource 16398, and a
   * folder missing that disk is missing the game's starting point.
   */
  static async create(source: DataSource, options: LureEngineOptions = {}): Promise<LureEngine> {
    const names = source.list();
    const containers = names.filter((name) => /disk\d\.(vga|ega)$/i.test(name));

    const disk2 =
      names.find((name) => /disk2\.vga$/i.test(name)) ??
      names.find((name) => /disk2\.ega$/i.test(name)) ??
      null;
    if (!disk2) {
      throw new Error(
        `Lure of the Temptress keeps its initial world state in Disk2.vga (resource ` +
          `${LURE_WORLD_STATE_ID}), and this folder has no disk 2. It cannot start without it.`,
      );
    }

    const bytes = await source.read(disk2);
    if (!bytes) throw new Error(`${disk2} could not be read from ${source.label}.`);

    let worldBytes: Uint8Array | null;
    try {
      const disk = parseLureDisk(bytes, lureDiskNumberFor(disk2) ?? undefined);
      worldBytes = readLureResource(bytes, disk, LURE_WORLD_STATE_ID);
    } catch (error) {
      if (error instanceof LureDiskError) throw new Error(error.message, { cause: error });
      throw error;
    }
    if (!worldBytes) {
      throw new Error(
        `${disk2} does not hold resource ${LURE_WORLD_STATE_ID}, so this project cannot read ` +
          `Lure's initial world state. The disk may be the wrong one or a partial extraction.`,
      );
    }

    const world = parseLureWorldState(worldBytes);
    // The floppy release ships four VGA and four EGA containers; the demo ships
    // fewer. A disk beyond the second is present only in the full release, so it
    // is the honest signal for which one this is without a second detector.
    const release: LureRelease = names.some((name) => /disk[34]\.(vga|ega)$/i.test(name))
      ? 'floppy'
      : 'demo';

    // The editable surface's raw material, read now so `describeEditRefusal` can
    // answer without I/O (its contract is synchronous). Palettes live in the VGA
    // containers — `isLurePalette` is what tells one from any other resource — so
    // only those are scanned, and a container that will not parse is skipped
    // rather than fatal: a game still loads without its palette surface.
    const palettes = await LureEngine.collectPalettes(source, names);

    // The hotspot positions, which are the first *typed* part of Lure's object
    // table this project reads. They are in the executable rather than in a
    // container (ADR 0024's original rule, which its third amendment narrowed
    // for the live world state and never retracted for the definitions), so a
    // release without one has no such surface and says so rather than failing.
    const hotspots = await LureEngine.collectHotspots(source, names);

    // A picture, so the game shows something rather than a black screen. Which
    // picture a room uses is not established, so this is the first game-area
    // one the containers hold and the status line says so.
    const picture = await LureEngine.collectFirstPicture(source, names);

    // Every game-area picture, for the editor's picture surface — carried as
    // their compressed bytes so the document stays small, decoded on demand.
    // The player only needs one; the editor shows them all (ADR 0025).
    const pictures = await LureEngine.collectPictures(source, names);

    options.onLog?.(
      `Lure of the Temptress (${release} release), ${containers.length} containers, ` +
        `world state ${world.bytes.length} bytes, ${palettes.length} palettes, ` +
        `${hotspots ? `${hotspots.records.length} hotspot positions` : 'no executable to read positions from'}`,
    );

    return new LureEngine(
      release,
      containers.length,
      world,
      palettes,
      hotspots,
      picture,
      pictures,
      options.onLog,
    );
  }

  /**
   * Reads the hotspot positions from the game's executable, or null.
   *
   * Null rather than throwing when the file is absent or the table is not where
   * this release keeps it: a Lure install still loads, still reads its world
   * state and still edits its palettes without it. `parseLureWalkTo` refuses on
   * the table's *content*, so a null here means "not read" and never "read
   * wrongly".
   */
  private static async collectHotspots(
    source: DataSource,
    names: readonly string[],
  ): Promise<LureHotspotTable | null> {
    const executable = names.find((name) => /(?:^|[/\\])lure\.exe$/i.test(name));
    if (!executable) return null;
    const bytes = await source.read(executable);
    if (!bytes) return null;
    try {
      return { file: executable, bytes, records: parseLureWalkTo(bytes) };
    } catch {
      return null;
    }
  }

  /**
   * Finds the first game-area picture and a palette to show it with.
   *
   * Best effort and null when there is none: a resource that will not decode is
   * simply not a picture, which is the ordinary case for most of them, and a
   * Lure install still loads and edits without one.
   *
   * The palette is the first the same container holds. That pairing is a
   * *guess* and the only one in this file — which picture goes with which
   * palette is in the room table, unread — so a caller is told the count and
   * the ids rather than being left to assume the colours are authoritative.
   */
  private static async collectFirstPicture(
    source: DataSource,
    names: readonly string[],
  ): Promise<LureFirstPicture | null> {
    let first: LureFirstPicture | null = null;
    let found = 0;

    // Lowest-numbered container first, and deterministically. The directory
    // order a `DataSource` reports is not sorted, and taking whichever came
    // first meant the picture and the palette came from disk 4 on one run and
    // disk 1 on another — with visibly different colours, since the pairing is
    // a guess either way. A guess that changes between runs is worse than a
    // guess: this one is at least the same one every time, and it is the one
    // that has been looked at.
    const containers = names
      .filter((candidate) => /disk\d\.vga$/i.test(candidate))
      .sort((a, b) => (lureDiskNumberFor(a) ?? 0) - (lureDiskNumberFor(b) ?? 0));

    for (const name of containers) {
      const bytes = await source.read(name);
      if (!bytes) continue;
      let disk;
      try {
        disk = parseLureDisk(bytes, lureDiskNumberFor(name) ?? undefined);
      } catch {
        continue;
      }

      const colours: LureColour[] = [];
      const pictures: Array<{ id: number; pixels: Uint8Array }> = [];
      for (const resource of disk.resources) {
        const data = readLureResource(bytes, disk, resource.id);
        if (!data) continue;
        if (isLurePalette(data)) {
          if (colours.length === 0) colours.push(...parseLurePalette(data));
          continue;
        }
        try {
          const pixels = decodeLurePicture(data, LURE_GAME_AREA_BYTES);
          if (pixels.length === LURE_GAME_AREA_BYTES) pictures.push({ id: resource.id, pixels });
        } catch {
          // Not a picture. Most resources are not.
        }
      }

      found += pictures.length;
      if (!first && pictures.length > 0 && colours.length > 0) {
        first = {
          disk: disk.diskNumber,
          id: pictures[0].id,
          pixels: pictures[0].pixels,
          colours,
          found: 0,
        };
      }
    }

    return first ? { ...first, found } : null;
  }

  /**
   * Reads every game-area picture from the containers, for the picture surface.
   *
   * Best effort, and the compressed bytes are what is kept — the same `data`
   * `collectFirstPicture` decodes to validate, but held packed so the project
   * document stays small (the editor decodes each on demand). A resource that
   * decodes to exactly the game area is a picture; anything else is skipped, the
   * ordinary case for most resources. Which room uses which is not read here
   * (that is the room table, unread), so this is every picture, not a map.
   */
  private static async collectPictures(
    source: DataSource,
    names: readonly string[],
  ): Promise<LurePictureResource[]> {
    const pictures: LurePictureResource[] = [];
    const containers = names
      .filter((candidate) => /disk\d\.vga$/i.test(candidate))
      .sort((a, b) => (lureDiskNumberFor(a) ?? 0) - (lureDiskNumberFor(b) ?? 0));

    for (const name of containers) {
      const bytes = await source.read(name);
      if (!bytes) continue;
      let disk;
      try {
        disk = parseLureDisk(bytes, lureDiskNumberFor(name) ?? undefined);
      } catch {
        continue;
      }

      for (const resource of disk.resources) {
        const data = readLureResource(bytes, disk, resource.id);
        if (!data || isLurePalette(data)) continue;
        try {
          const pixels = decodeLurePicture(data, LURE_GAME_AREA_BYTES);
          if (pixels.length === LURE_GAME_AREA_BYTES) {
            pictures.push({
              disk: disk.diskNumber,
              id: resource.id,
              width: LURE_SCREEN_WIDTH,
              height: LURE_GAME_AREA_HEIGHT,
              bytes: data,
            });
          }
        } catch {
          // Not a picture. Most resources are not.
        }
      }
    }

    return pictures;
  }

  /** Reads every palette resource from the VGA containers, best effort. */
  private static async collectPalettes(
    source: DataSource,
    names: readonly string[],
  ): Promise<LurePaletteResource[]> {
    const palettes: LurePaletteResource[] = [];
    const vgaContainers = names.filter((name) => /disk\d\.vga$/i.test(name));
    for (const name of vgaContainers) {
      const bytes = await source.read(name);
      if (!bytes) continue;
      let disk;
      try {
        disk = parseLureDisk(bytes, lureDiskNumberFor(name) ?? undefined);
      } catch {
        continue;
      }
      for (const resource of disk.resources) {
        const data = readLureResource(bytes, disk, resource.id);
        if (data && isLurePalette(data)) {
          palettes.push({ disk: disk.diskNumber, id: resource.id, bytes: data });
        }
      }
    }
    return palettes;
  }

  get gameId(): string {
    return `lure-${this.release}`;
  }

  get targetName(): string {
    return `Lure (${this.release} release, DOS)`;
  }

  /**
   * The room the game starts in.
   *
   * Zero, and honestly so: it lives inside the world-state snapshot, whose
   * fields this project does not type yet (`lureWorldState.ts`). Not "room 0",
   * but "the room is not read" — `describeStatus` says which.
   */
  get currentRoom(): number {
    return 0;
  }

  /**
   * Sixtieths of a second between ticks.
   *
   * Not measured. Lure's loop rate is not established and nothing steps on it
   * yet — `step` runs no scripts — so this is a placeholder the moment a script
   * interpreter lands, not a claim about the game's cadence. Twelve mirrors
   * Sky's rather than inventing a Lure-specific number this project has not
   * checked.
   */
  get ticksPerStep(): number {
    return 12;
  }

  /** Reads the world state into place. There is no opening script to run. */
  boot(): void {
    if (this.booted) return;
    this.booted = true;
    this.log?.(
      `Lure loaded its world state (${this.world.bytes.length} bytes); it has no script ` +
        `interpreter, so nothing runs`,
    );
  }

  /** One tick, which does nothing: there are no scripts to advance (ADR 0026). */
  step(): void {
    if (!this.booted) this.boot();
    // Intentionally empty. `frame` stays 0, which is how the playthrough harness
    // tells a loaded engine that runs nothing from one that has booted scripts.
  }

  /** Nothing is drawn: there is no renderer for this family yet. */
  /**
   * Draws the picture this engine has, which is not yet a picture a script chose.
   *
   * Lure's pictures are compressed and `lureDecode.ts` reads them; 99 resources
   * across the shipped VGA containers decode to exactly 61,440 bytes, the
   * 320x192 game area, which is the arithmetic that says the decompressor is
   * right — a wrong one desynchronises and stops at scattered lengths.
   *
   * **Which picture belongs to which room is not established**, because that
   * comes from the room table and this project has not read it. So what is
   * drawn is the first game-area picture the containers offer, and the status
   * line says exactly that rather than implying the game chose it. A picture on
   * screen is not the same claim as a game running, and this file has been
   * careful about that distinction from the start.
   *
   * The game-area pictures fall into two id classes, a shape a person can
   * confirm against the container directory: most (the room and scene
   * backgrounds) carry ids with a non-zero high byte in `room << 8 | layer`
   * form, while a small handful on disk 1 carry small ids (< 0x100). The first
   * picture found — resource 24 (0x18) — is in the small-id class, so it is not
   * even the class of picture a room shows. Reading which of the room-id
   * pictures the startup selects needs the room table (`create_lure`'s offset is
   * not in this repository) or typing the world-state snapshot (which ADR 0024
   * declines without the executable routine that consumes it); neither derives
   * here, so the drawn picture stays a labelled guess rather than a wrong claim.
   */
  render(): void {
    if (this.painted || !this.picture) return;
    this.screen.pixels.fill(0);
    this.screen.pixels.set(this.picture.pixels);

    const clut = new Uint8Array(this.picture.colours.length * 3);
    this.picture.colours.forEach((colour, index) => {
      clut[index * 3] = colour.r;
      clut[index * 3 + 1] = colour.g;
      clut[index * 3 + 2] = colour.b;
    });
    this.palette.setFromClut(clut);
    this.painted = true;
  }

  present(context: CanvasRenderingContext2D): void {
    this.screen.present(context, this.palette);
  }

  saveState(name: string): SavedGameEnvelope {
    const saved: LureSavedGame = {
      format: LURE_SAVE_FORMAT,
      gameId: this.gameId,
      savedAt: Date.now(),
      name,
      room: this.currentRoom,
      state: Array.from(this.world.bytes),
    };
    return saved;
  }

  /**
   * Restores a save, or refuses without touching anything.
   *
   * Every check runs before a byte is applied, which is `AdventureEngine`'s rule
   * and matters here for the same reason it does in Sky: the world state *is* the
   * world, so a half-applied restore is two games' objects at once.
   */
  loadState(saved: SavedGameEnvelope): void {
    const candidate = saved as LureSavedGame;
    if (candidate.format !== LURE_SAVE_FORMAT) {
      throw new Error(
        `This save is format ${candidate.format} and this engine writes ${LURE_SAVE_FORMAT}.`,
      );
    }
    if (candidate.gameId !== this.gameId) {
      throw new Error(
        `This save is for "${candidate.gameId}" and this game is "${this.gameId}". A save is ` +
          `tagged with the Target that wrote it (ADR 0012), so it is refused rather than ` +
          `half-applied.`,
      );
    }
    if (!Array.isArray(candidate.state)) {
      throw new Error(`This save carries no Lure world state, so there is nothing to restore.`);
    }
    // Read through the same validator that read the shipped snapshot, so a save
    // of the wrong length is refused rather than half-applied.
    parseLureWorldState(Uint8Array.from(candidate.state));
    this.booted = true;
  }

  /** Lure has room names in its data, but reading which one needs the untyped table. */
  roomName(): string | undefined {
    return undefined;
  }

  describeStatus(): string | undefined {
    if (this.hasQuit) return 'The game asked to quit.';
    if (!this.booted) return undefined;
    return (
      `Lure reads its resources and its initial world state (resource ${LURE_WORLD_STATE_ID}), ` +
      `and has no script interpreter yet, so it does not run. Its object table is Preserved ` +
      `bytes — the fields are not typed, because that needs the executable's consuming routine ` +
      `read (ADR 0024). This is Disassembly's foundation, not a stalled playthrough.`
    );
  }

  describeStall(): string[] {
    return [
      `Lure of the Temptress (${this.release} release, DOS)`,
      `booted: ${this.booted}, containers read: ${this.containerCount}`,
      describeLureWorldState(this.world),
      'no script interpreter yet: Lure and Sky share no bytecode (ADR 0026), and this project ' +
        'reads neither Lure script system yet',
      this.picture
        ? `a picture is drawn: resource ${this.picture.id} from disk ${this.picture.disk}, one of ` +
          `${this.picture.found} that decode to the 320x192 game area. **Which** picture a room ` +
          `uses is not established, so this is the first the containers hold rather than one the ` +
          `game chose — and the palette beside it is a guess for the same reason. Its id ` +
          `(0x${this.picture.id.toString(16)}) is ${
            this.picture.id >= 0x100
              ? 'a room id (room<<8|layer)'
              : 'a small id (< 0x100), a class apart from the room backgrounds whose ids are ' +
                'room<<8|layer — so it is not even the class of picture a room shows'
          }`
        : 'nothing is drawn: no resource decoded to a game-area picture',
      'no sound yet, and no animation — both wait on the scripts that would drive them',
    ];
  }

  /**
   * Why this game may not be edited, or null when it may.
   *
   * Lure has an editable surface — its palettes, which round-trip byte-identically
   * (ADR 0025's condition applied to Lure's own format) — so this returns null
   * once at least one palette is present and all of them re-emit. What is *not*
   * editable is the object table, and that is said inside the project rather than
   * as a whole-game refusal: `toEditableGame` marks the world state read-only
   * Preserved bytes (ADR 0024). Asked before the work rather than discovered by
   * it, and built from the same import `toEditableGame` uses so the two agree.
   */
  describeEditRefusal(): string | null {
    const project = this.buildProject();
    if (project.editable.editable) return null;
    return `Editing Lure of the Temptress is refused: ${project.editable.reasons.join('; ')}.`;
  }

  async toEditableGame(options: EditableGameOptions): Promise<EditableGame | null> {
    // The palettes are the editable surface (ADR 0025); the object table is
    // carried as read-only Preserved bytes, not typed (ADR 0024). Both are read
    // already — palettes at load, so no work happens here beyond the report.
    const project = this.buildProject();
    options.onProgress?.(1, 1, 'Lure project');

    const notes = [
      `Lure of the Temptress (${this.release} release, DOS)`,
      `${project.palettes.length} palettes, an editable surface — Lure's own six-bit VGA format, ` +
        `round-tripping byte-identically`,
      this.hotspots
        ? `${describeLureWalkTo(this.hotspots.records)} — the typed part of the object table, ` +
          `and editable: moving one is ADR 0025's plainest edit`
        : `no hotspot positions: this install ships no executable to read them from, so that ` +
          `surface is absent rather than empty`,
      project.editable.editable
        ? 'editing changes a palette colour or a hotspot position in place'
        : `no editable surface: ${project.editable.reasons.join('; ')}`,
      `object table: resource ${LURE_WORLD_STATE_ID}, ${project.worldState.length} bytes, held as ` +
        `read-only Preserved bytes — Unrecovered ${project.editable.unrecovered}, a count over the ` +
        `object table (ADR 0025), because its records cannot be typed without the executable's ` +
        `consuming routine read (ADR 0024)`,
      `${project.pictures?.length ?? 0} room pictures, a read-only viewer carried as compressed ` +
        `Preserved bytes and decoded on demand — which room uses which is in the room table, unread`,
      'export stays refused: rebuilding a Lure game rewrites its containers and patches its ' +
        'object table, which no SCUMM builder does (ADR 0024)',
    ];

    return {
      project: {
        version: 6,
        target: this.target,
        name: this.gameId,
        start: { room: this.currentRoom, x: 0, y: 0 },
        defaultResponse: '',
        screen: { textHeight: 0, verbTop: 0 },
        verbs: [],
        actors: [],
        rooms: [],
        scripts: [],
        audio: [],
        lure: project,
      },
      notes,
    };
  }

  /** The Target this game presents to the editor and its saves. */
  private get target(): Target {
    return { engine: 'lure', release: this.release, platform: 'dos' };
  }

  /** Builds the editable project, the one source both edit methods read from. */
  private buildProject(): ReturnType<typeof importLureProject> {
    return importLureProject(
      this.world,
      this.palettes,
      this.release,
      'dos',
      `the ${this.release} release, DOS`,
      this.hotspots?.records ?? [],
      this.pictures,
    );
  }
}
