/**
 * An AGOS game's art, as something the editor can list.
 *
 * The last gap on the editability half. Items, strings and Subroutines have
 * been in the Project since ADR 0029; the pixels have not, because they are not
 * in `GAMEPC` — they live in the `.gme` archive or in loose `.VGA` files, which
 * `ZoneSource` reads. So `importAgosProject`, which takes only the base file's
 * bytes, had nothing to hand a canvas.
 *
 * ## Metadata, and deliberately not pixels
 *
 * What this produces is a list: which zones a game has, which images each zone
 * holds, and how big each one is. It does **not** carry the decoded bitmaps.
 *
 * That is a size decision rather than a shortcut. A Project is a plain data
 * object that gets serialised, and Simon 1's art runs to megabytes — putting
 * every decoded bitmap in it would make saving a project a copy of the game.
 * The zone's pixel bytes stay where they are and a surface that wants to draw
 * one reads it through the same `readVgaImageEntry` and sprite decoders the
 * renderer uses.
 *
 * So this is the foundation a canvas sits on rather than the canvas: it makes a
 * game's art **listed and inspectable**, which is the same step Lure's object
 * table took before anything could edit it. Painting is not here, and
 * `docs/released-games.md` says so rather than implying a list is a paint
 * surface.
 *
 * ## Zones are probed, because nothing enumerates them
 *
 * `ZoneSource.zone` answers by number and there is no index of which numbers
 * exist — a zone is present or it is not. So this walks a range and keeps what
 * answers. The range is a parameter with a stated default rather than a magic
 * number, because "how many zones can a game have" is a property of the
 * packaging and not of this reader.
 *
 * ## Images come from the pixel table, and used to come from the wrong one
 *
 * A zone has two resources, and each has a table of its own. The **script**
 * resource lists entries whose `id` is the number a game asks for — 300, 401,
 * 600 in Simon 1, which are global and sparse. The **pixel** resource has an
 * eight-byte entry per image at `id * 8`, and those ids are small and dense,
 * chosen by the VGA script that draws them.
 *
 * They are different numbering spaces, and this used to read one with the
 * other: it took the script table's ids and looked each up in the pixel table.
 * On Simon 1 that reads entry 300 of a table with a hundred entries, which is
 * whatever pixel data happens to be at byte 2400 — so the list came out with
 * sizes like 43370x181 and flags like `0xd6`, and every one of them decoded to
 * a black rectangle. Nothing failed; the editor simply showed a game's art as
 * squares of nothing.
 *
 * The pixel table is walked directly now. It has no count either, and the
 * bound is arithmetic rather than a field: entries start at zero and the first
 * image's pixels begin where the table ends, so the lowest offset any entry
 * names is also the table's length.
 */

import { readVgaFile } from '../../engine/agos/gfx/vgaFile.js';
import { readVgaImageEntry } from '../../engine/agos/gfx/vgaImages.js';
import type { ZoneSource } from '../../engine/agos/resource/zoneSource.js';

/**
 * How many entries a zone's pixel table has.
 *
 * There is no count anywhere. The table starts at offset zero and the images'
 * pixels follow it, so the **lowest offset any entry names is where the table
 * ends** — which makes the bound arithmetic rather than a guess at a maximum.
 *
 * Refined as it goes rather than in two passes: every entry read lowers the
 * limit, and the loop condition uses the limit, so it stops as soon as the
 * table's real end has been seen. A resource whose entries are all zero has no
 * images and falls out with a limit of its own length, which is the honest
 * answer for a zone that holds something other than sprites.
 */
function imageTableLength(pixels: Uint8Array, options: { agos2?: boolean }): number {
  let limit = pixels.length;
  for (let id = 1; id * 8 + 8 <= limit; id += 1) {
    let entry;
    try {
      entry = readVgaImageEntry(pixels, id, { agos2: options.agos2 });
    } catch {
      break;
    }
    if (entry && entry.offset > 0 && entry.offset < limit) limit = entry.offset;
  }
  return Math.floor(limit / 8);
}

/** One image a zone holds. */
export interface AgosImage {
  readonly zone: number;
  /** The number a script draws it by. */
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /**
   * The draw flags on its entry.
   *
   * Kept because they decide *how* it decodes — compressed, flipped, used as a
   * mask — and a surface that ignored them would draw a compressed image as
   * noise. Held raw rather than split into booleans, so the one place that
   * interprets them stays `DRAW_FLAGS` in the renderer.
   */
  readonly flags: number;
}

/** What a game's art amounts to, for a surface to show. */
export interface AgosArt {
  readonly zones: readonly number[];
  readonly images: readonly AgosImage[];
  /**
   * Zones that answered but whose graphics resource could not be read.
   *
   * Named rather than skipped. A zone present in the archive and unreadable is
   * either a packaging we read wrongly or a game we have not seen, and both are
   * worth showing — a silently shorter list looks like a game with less art.
   */
  readonly unreadableZones: readonly number[];
}

/**
 * How many zone numbers to try when nothing bounds them.
 *
 * Simon 1 numbers its zones in the low hundreds and an image's zone is its own
 * number's hundreds column, so a few hundred covers the games this family
 * runs. Reached only for the layouts that cannot walk off the end anyway — the
 * loose-bundle and AGOS 2 sources answer `zone(n)` for present zones alone. The
 * packed sources, which answer by arithmetic and *can* run off the end, carry
 * their own {@link ZoneSource.highestGraphicsZone} and stop there.
 */
const DEFAULT_MAX_ZONE = 1000;

export function readAgosArt(
  zones: ZoneSource,
  options: { agos2?: boolean; maxZone?: number } = {},
): AgosArt {
  // The packaging's own bound comes first: a packed archive knows where its
  // graphics stop, and past that point `zone(n)` returns a music track or a
  // sound bank read as a table of images — which is how one call took ten
  // minutes and reported four hundred thousand images that are not there. A
  // caller's `maxZone` is only a fallback for the layouts that state no bound.
  const maxZone = zones.highestGraphicsZone ?? options.maxZone ?? DEFAULT_MAX_ZONE;
  const present: number[] = [];
  const images: AgosImage[] = [];
  const unreadable: number[] = [];

  for (let zone = 0; zone <= maxZone; zone += 1) {
    const resources = zones.zone(zone);
    if (!resources) continue;
    present.push(zone);

    // The script resource is still read, and only to decide whether the zone is
    // readable at all: a zone whose script half will not parse is one this
    // project has misread rather than one with no art, and the two are worth
    // telling apart.
    try {
      readVgaFile(resources.scripts, { agos2: options.agos2 });
    } catch {
      unreadable.push(zone);
      continue;
    }

    for (let id = 1; id < imageTableLength(resources.pixels, options); id += 1) {
      try {
        const measured = readVgaImageEntry(resources.pixels, id, { agos2: options.agos2 });
        // A slot with no offset is a hole in the table rather than an image;
        // one with no size is an entry the format never filled in.
        if (!measured || measured.offset === 0) continue;
        if (measured.width === 0 || measured.height === 0) continue;
        images.push({
          zone,
          id,
          width: measured.width,
          height: measured.height,
          flags: measured.flags,
        });
      } catch {
        // One unmeasurable image is not an unreadable zone: the rest of the
        // zone's art is still listable, which is why this continues rather
        // than marking the zone.
        continue;
      }
    }
  }

  return { zones: present, images, unreadableZones: unreadable };
}
