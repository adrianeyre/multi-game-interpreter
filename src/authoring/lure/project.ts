/**
 * The authoring layer over a Lure of the Temptress game (ADR 0026).
 *
 * The analogue of `authoring/sky/project.ts`, held apart from it on purpose:
 * ADR 0026 refuses one shared shape for the two Virtual Theatre families, so
 * what a person edits here is Lure's own format and where Lure's readers stop is
 * not where Sky's do. This module does two things:
 *
 * 1. builds the **palette** surface — Lure's own six-bit VGA palettes, which
 *    round-trip byte-identically and are therefore a checked editable surface,
 *    not a guess (ADR 0025's condition, applied to Lure's format).
 * 2. carries the **object table** as read-only Preserved bytes, and says why —
 *    Lure's world state (resource 16398) is not reachable by data-side analysis
 *    and cannot be typed without the executable's consuming routine (ADR 0024).
 *    Fitting an invented record shape over it is the guess this family refuses.
 *
 * Importing never fails on the editability check: a game whose object table
 * cannot be typed can still have its palettes read and edited, and saying which
 * surface is which is more useful than refusing to open it.
 */

import { fromBase64, toBase64 } from '../base64.js';
import {
  parseLurePalette,
  writeLurePalette,
  type LureColour,
} from '../../engine/lure/resource/lureDisk.js';
import {
  writeLureWorldState,
  LURE_WORLD_STATE_ID,
  type LureWorldState,
} from '../../engine/lure/resource/lureWorldState.js';
import type { LureWalkTo } from '../../engine/lure/resource/lureHotspots.js';
import type { LurePlatform, LureRelease } from '../target.js';
import type {
  LureProject,
  LureProjectPalette,
  LureProjectPicture,
  LureProjectWorldState,
} from '../project.js';

/** A palette resource as read from a container, before it becomes JSON. */
export interface LurePaletteResource {
  readonly disk: number;
  readonly id: number;
  /** The raw six-bit resource bytes, exactly as the container held them. */
  readonly bytes: Uint8Array;
}

/**
 * A game-area picture as read from a container, before it becomes JSON.
 *
 * The bytes are the resource's *compressed* form — what the container held,
 * decoded on demand by the editor, not the unpacked pixels. Carrying them packed
 * keeps the document small; see `LureProject.pictures`.
 */
export interface LurePictureResource {
  readonly disk: number;
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** The compressed resource bytes, exactly as the container held them. */
  readonly bytes: Uint8Array;
}

/** Why the object table is read-only, said once so notes and JSON agree. */
export const LURE_WORLD_STATE_NOTE =
  `Lure keeps its world in resource ${LURE_WORLD_STATE_ID}, the snapshot the executable restores ` +
  'into a save slot. Its records — hotspots, rooms, events, flags — are not reachable by ' +
  'data-side analysis and cannot be typed without the executable’s consuming routine read (ADR ' +
  '0024). It is held here as Preserved bytes and is read-only; nothing is lost while the layout ' +
  'is unknown, and no shape is invented over it.';

/**
 * Reads a Lure game's palettes and world state into a Project.
 *
 * The editability the result reports is the **palette** surface's: every palette
 * must re-emit byte-identically, which is the check that makes editing a colour a
 * change to a understood format rather than to a misread one. The object table is
 * carried as Preserved bytes and counted as one Unrecovered — a count over the
 * object table (ADR 0025), never widened to hide it.
 */
export function importLureProject(
  world: LureWorldState,
  palettes: readonly LurePaletteResource[],
  release: LureRelease,
  platform: LurePlatform,
  identification: string,
  hotspots: readonly LureWalkTo[] = [],
  pictures: readonly LurePictureResource[] = [],
): LureProject {
  const jsonPalettes: LureProjectPalette[] = [];
  let allRoundTrip = true;

  for (const palette of palettes) {
    const colours = parseLurePalette(palette.bytes);
    // The round-trip ADR 0025 makes a precondition, on Lure's own format: with
    // nothing edited, narrowing the widened colours back must reproduce the
    // resource. A palette that does not is one the reader misunderstood.
    const rewritten = writeLurePalette(colours);
    const roundTrips =
      rewritten.length === palette.bytes.length &&
      rewritten.every((b, i) => b === palette.bytes[i]);
    if (!roundTrips) allRoundTrip = false;

    jsonPalettes.push({
      disk: palette.disk,
      id: palette.id,
      colours: colours.map((c) => ({ r: c.r, g: c.g, b: c.b })),
      bytesBase64: toBase64(palette.bytes),
    });
  }

  const reasons: string[] = [];
  if (palettes.length === 0) {
    reasons.push('no palettes were found to edit');
  }
  if (!allRoundTrip) {
    reasons.push('a palette did not re-emit byte for byte, so it is not offered for editing');
  }

  const worldState: LureProjectWorldState = {
    resource: LURE_WORLD_STATE_ID,
    length: world.bytes.length,
    bytesBase64: toBase64(writeLureWorldState(world)),
    typed: false,
    note: LURE_WORLD_STATE_NOTE,
  };

  return {
    identification,
    release,
    platform,
    editable: {
      // The palette surface is editable when there is at least one and they all
      // round-trip. This is not a claim about the object table: that is the
      // `unrecovered` count below, a different surface (see `LureProject`).
      editable: palettes.length > 0 && allRoundTrip,
      // One over the object table, and it stays one while the world state is
      // Preserved bytes. The hotspot positions being typed does not discharge
      // it: they are the definitions, and the count is over the *state* record
      // that no reader has taken apart yet (ADR 0025's count is over this
      // table). Two surfaces, one still unrecovered.
      unrecovered: 1,
      reasons,
    },
    palettes: jsonPalettes,
    /**
     * The object table's typed part: where each hotspot stands.
     *
     * Editable, and the plainest edit ADR 0025 describes — "move that". Read
     * from the game's executable rather than from a container, which is ADR
     * 0024's rule for a definition; the *live* world state below is the
     * resource its third amendment found, and the two are different things.
     */
    hotspots: hotspots.map((record) => ({ ...record })),
    worldState,
    // The room pictures, as their compressed bytes — a read-only viewer the
    // editor decodes on demand (see `LureProject.pictures`). Preserved bytes.
    pictures: pictures.map((picture): LureProjectPicture => ({
      disk: picture.disk,
      id: picture.id,
      width: picture.width,
      height: picture.height,
      bytesBase64: toBase64(picture.bytes),
    })),
  };
}

/**
 * Edits one colour of one palette, returning the resource bytes to write back.
 *
 * The source of truth is the palette's own six-bit bytes; this decodes them,
 * replaces one colour (narrowing eight bits to six, losing the two the VGA DAC
 * never had), and re-emits. An index outside the palette is refused rather than
 * silently ignored.
 */
export function editLurePaletteColour(
  palette: LureProjectPalette,
  index: number,
  colour: LureColour,
): Uint8Array {
  const colours = parseLurePalette(fromBase64(palette.bytesBase64));
  if (index < 0 || index >= colours.length) {
    throw new RangeError(
      `Palette ${palette.id} has ${colours.length} colours and colour ${index} was asked for.`,
    );
  }
  colours[index] = { r: colour.r, g: colour.g, b: colour.b };
  return writeLurePalette(colours);
}

/**
 * Applies a colour edit and returns the updated project palette.
 *
 * Both halves stay in step: `bytesBase64` (the source of truth) gets the narrowed
 * bytes, and `colours` (the view) is re-derived from them, so what the editor
 * shows is exactly what a rewrite would put back — the two cannot drift.
 */
export function editLurePalette(
  palette: LureProjectPalette,
  index: number,
  colour: LureColour,
): LureProjectPalette {
  const bytes = editLurePaletteColour(palette, index, colour);
  return {
    ...palette,
    colours: parseLurePalette(bytes).map((c) => ({ r: c.r, g: c.g, b: c.b })),
    bytesBase64: toBase64(bytes),
  };
}

/**
 * Moves a hotspot, returning the table with that one record changed.
 *
 * The plainest edit ADR 0025 describes — "move that" — and the narrowest thing
 * this surface allows. The count and the ids are fixed, because
 * `writeLureWalkTo` refuses a table that gained, lost or renumbered a record:
 * the terminator and everything after it in the executable would move, and the
 * game holds offsets into that. So a hotspot can be moved and cannot be added.
 *
 * `yFlag` is carried through untouched. Its meaning is not established, and
 * choosing a value for it would be the guess this family's readers refuse.
 */
export function editLureHotspot(
  hotspots: readonly LureWalkTo[],
  id: number,
  position: { readonly x: number; readonly y: number },
): LureWalkTo[] {
  const index = hotspots.findIndex((record) => record.id === id);
  if (index < 0) {
    throw new RangeError(
      `This table holds no hotspot ${id}, so there is nothing to move. It carries ` +
        `${hotspots.length} records and an edit cannot add one.`,
    );
  }
  const next = hotspots.map((record) => ({ ...record }));
  next[index] = { ...next[index], x: position.x, y: position.y };
  return next;
}
