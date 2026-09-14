/**
 * Collects Beneath a Steel Sky's drawable resources for the editor's picture
 * surface (ADR 0025).
 *
 * The Compact table is the primary authoring surface, and the bytecode is a
 * read-only listing — but the person the run was pointed at was looking for the
 * thing a SCUMM editor opens with: a picture. Sky already decodes its screens
 * and room backgrounds (`skyGraphic.ts`); this walks the resources and gathers
 * the drawable ones so the editor can show them without reaching back into the
 * engine's reader.
 *
 * ## What is gathered, and what is not
 *
 * - **Full screens** (320x200) — the intro and menu panels, whose bytes are
 *   already indexed pixels.
 * - **Room backgrounds** (320x192 game areas) — stored as tiles, de-tiled on
 *   display. These are the rooms.
 * - **Palettes** — six-bit VGA, so a screen or room can be drawn with one and
 *   the picker can offer the others.
 *
 * - **Sprites** — the player, the actors and the objects, gathered by
 *   {@link collectSkySprites} and carried **packed**.
 *
 * That last one reverses an earlier decision, and the reason is that the
 * earlier decision measured the wrong number. It left sprites out because
 * unpacked they are ~16 MB, "too much to carry in the project document, which
 * is re-serialised on every edit" — but the size that gets re-serialised is the
 * **carried** size, and packed the same 971 resources are **1.58 MB**, the same
 * order as Lure's 0.97 MB of compressed pictures. So they are carried the way
 * Lure's are: packed, and unpacked one at a time on display.
 *
 * The bytes are carried **unpacked**: `SkyResources.read` already resolves the
 * RNC packing, and carrying the result means the editor needs only the pure
 * pixel decoders and no decompressor. They are Preserved bytes — a viewer, since
 * this project holds no re-encoder for a Sky picture.
 */

import { toBase64 } from '../base64.js';
import {
  listSkyScript,
  skyScriptCount,
  skyScriptOffset,
} from '../../engine/sky/script/skyOpcodes.js';
import { SKY_MCODE, SKY_MCODE_STRIDE } from '../../engine/sky/script/skyMcodes.js';

/**
 * Where `pop_variable` writes the background a room is about to draw.
 *
 * `SKY_VAR.layer0Id` is 41, and this is **164**, because a `pop_variable`
 * operand is a **byte offset** rather than a variable index — the same reason
 * the stall report calls variable 111 "byte offset 444". Comparing against 41
 * matched nothing and silently derived zero pairings, which is the quiet kind of
 * wrong this codebase keeps warning about: the walk ran, found nothing, and
 * looked like a format that had no pairings rather than a unit error.
 *
 * Named here rather than imported from the engine's world, because pulling
 * `SkyWorld` into the authoring layer for one number would couple the two the
 * wrong way round. A test asserts the two still agree.
 */
export const SKY_LAYER_0_ID_OFFSET = 41 * 4;
import {
  isSkyGameArea,
  isSkyPalette,
  isSkyScreen,
  parseSkySpriteHeader,
  SKY_GAME_AREA_HEIGHT,
  SKY_SCREEN_HEIGHT,
  SKY_SCREEN_WIDTH,
} from '../../engine/sky/gfx/skyGraphic.js';
import type { SkyProjectPalette, SkyProjectPicture, SkyProjectSprite } from '../project.js';

/** The least a collector needs of a `SkyResources`, so a fixture can stand in. */
export interface SkyResourceReader {
  ids(): number[];
  read(id: number): Uint8Array;
}

/**
 * What {@link collectSkySprites} needs on top: the bytes *before* unpacking.
 *
 * Held as a second interface rather than folded into the first because a
 * fixture for the picture surface has no reason to implement it, and the
 * picture collector must keep working against one that does not.
 */
export interface SkySpriteReader extends SkyResourceReader {
  rawBytes(id: number): Uint8Array;
  /** The index entry, for the two flags `unpackSkyResource` needs. */
  entry(
    id: number,
  ): { readonly excludesHeader: boolean; readonly stored: boolean } | null | undefined;
}

/** The drawable resources for the picture surface, ready to become JSON. */
export interface SkyDrawables {
  readonly pictures: SkyProjectPicture[];
  readonly palettes: SkyProjectPalette[];
  /** The player, the actors and the objects — packed; see {@link collectSkySprites}. */
  readonly sprites: SkyProjectSprite[];
}

/**
 * Walks every resource and keeps the screens, room backgrounds and palettes.
 *
 * A resource that will not read is skipped rather than fatal — most of `sky.dsk`
 * is not a picture, and a game still opens without one of its screens. The
 * classification is the same arithmetic the shot tool and the engine use, so a
 * resource lands in exactly one bucket or none.
 */
export function collectSkyDrawables(resources: SkyResourceReader): SkyDrawables {
  const pictures: SkyProjectPicture[] = [];
  const palettes: SkyProjectPalette[] = [];

  for (const id of resources.ids()) {
    let bytes: Uint8Array;
    try {
      bytes = resources.read(id);
    } catch {
      continue;
    }

    if (isSkyPalette(bytes)) {
      palettes.push({ id, bytesBase64: toBase64(bytes), source: 'resource' });
      continue;
    }
    if (isSkyScreen(bytes)) {
      pictures.push({
        id,
        kind: 'screen',
        width: SKY_SCREEN_WIDTH,
        height: SKY_SCREEN_HEIGHT,
        bytesBase64: toBase64(bytes),
      });
      continue;
    }
    if (isSkyGameArea(bytes)) {
      pictures.push({
        id,
        kind: 'room',
        width: SKY_SCREEN_WIDTH,
        height: SKY_GAME_AREA_HEIGHT,
        bytesBase64: toBase64(bytes),
      });
    }
    // Everything else — sprites and the great majority that are not graphics at
    // all — is left out; see this file's header for why sprites are not carried.
  }

  // Sprites are gathered separately, because they need `rawBytes` and this
  // collector must keep working against a reader that has only `read`.
  return { pictures, palettes, sprites: [] };
}

/**
 * Walks every resource and keeps the sprites, packed.
 *
 * A resource is a sprite when {@link parseSkySpriteHeader} accepts its
 * *unpacked* bytes — which is the engine's own test, so the editor and the
 * renderer agree about what a sprite is. The header has to be read unpacked to
 * be read at all; what gets carried is the packed original beside it.
 *
 * Screens, room backgrounds and palettes are skipped explicitly rather than
 * left to the header test. A 64,000-byte screen is not 22 bytes of header and
 * pixels, but it is long enough that a header read off the front of it can
 * describe a plausible sprite, and a screen appearing in both surfaces would be
 * a picture the editor shows twice under two names.
 */
export function collectSkySprites(resources: SkySpriteReader): SkyProjectSprite[] {
  const sprites: SkyProjectSprite[] = [];

  for (const id of resources.ids()) {
    let bytes: Uint8Array;
    try {
      bytes = resources.read(id);
    } catch {
      continue;
    }

    if (isSkyPalette(bytes) || isSkyScreen(bytes) || isSkyGameArea(bytes)) continue;

    const header = parseSkySpriteHeader(bytes);
    if (!header) continue;

    // The container's own bytes, and the index's own flags. Both are needed:
    // Sky packs after the 22-byte prefix, so whether these bytes are compressed
    // is not a question the first two bytes answer on their own.
    const { carried, excludesHeader, stored } = carry(resources, id, bytes);

    sprites.push({
      id,
      width: header.width,
      height: header.height,
      frames: header.frames,
      frameBytes: header.frameBytes,
      offsetX: header.offsetX,
      offsetY: header.offsetY,
      bytesBase64: toBase64(carried),
      excludesHeader,
      stored,
    });
  }

  return sprites;
}

/**
 * The container's own bytes for one resource, with the index's two flags.
 *
 * Both halves are needed and neither is derivable from the other: Sky packs
 * *after* the 22-byte prefix, so whether the bytes are compressed is not a
 * question the first two bytes answer, and whether the prefix belongs to the
 * unpacked result is the index's call. A reader that cannot produce the packed
 * original falls back to the unpacked bytes marked `stored`, so nothing
 * downstream tries to unpack what is already pixels.
 */
function carry(
  resources: SkySpriteReader,
  id: number,
  unpacked: Uint8Array,
): { carried: Uint8Array; excludesHeader: boolean; stored: boolean } {
  try {
    const entry = resources.entry(id);
    return {
      carried: resources.rawBytes(id),
      excludesHeader: entry?.excludesHeader ?? false,
      stored: entry?.stored ?? true,
    };
  } catch {
    return { carried: unpacked, excludesHeader: false, stored: true };
  }
}

/**
 * The palettes in the **Compact table**, which is where a room's palette lives.
 *
 * `collectSkyDrawables` scans resources and finds 29. This finds 83 more, and
 * they are the ones that matter: `SkyEngine.paintPalette` resolves a palette out
 * of the Compact table first and only falls back to resources, and screen 0's
 * own room-entry script names Compact **4316**. A picker built from the resource
 * palettes alone offered nothing a room is actually drawn with, which is why
 * every picture came out in the wrong colours.
 *
 * The test is the same one the engine and the renderer use — `isSkyPalette` over
 * the record's bytes — so a record lands here exactly when the renderer would
 * accept it as a palette.
 */
export function collectSkyCompactPalettes(compacts: {
  records: readonly { readonly id: number; readonly words: Uint16Array }[];
}): SkyProjectPalette[] {
  const palettes: SkyProjectPalette[] = [];
  for (const record of compacts.records) {
    const bytes = new Uint8Array(
      record.words.buffer,
      record.words.byteOffset,
      record.words.byteLength,
    );
    if (!isSkyPalette(bytes)) continue;
    palettes.push({ id: record.id, bytesBase64: toBase64(bytes), source: 'compact' });
  }
  return palettes;
}

/**
 * Which palettes the game's own scripts draw each background with.
 *
 * The engine's note on `fnDrawScreen` names the pattern: the mcode takes one
 * argument and it is the palette, while the background is `LAYER_0_ID`, which
 * the script sets a few instructions earlier. So walking a script and keeping
 * the last value written to that variable pairs a background with a palette at
 * every call.
 *
 * Measured over the shipped CD release: **218 `fnDrawScreen` call sites, all 218
 * paired**, across **49 distinct backgrounds** — and background 64 pairs to
 * palette 4316, which is what the running engine reports for screen 0. A static
 * walk and the live engine agreeing independently is the check that makes this a
 * reading rather than a fitted answer.
 *
 * One-to-many on purpose: 16 backgrounds carry several palettes because a room
 * gets re-lit, and flattening that to one would throw away the alternatives an
 * author would want in the picker.
 *
 * ## An unresolved disagreement this exposed, recorded rather than smoothed over
 *
 * The scripts name **49** backgrounds. {@link collectSkyDrawables} classifies
 * **79** resources as rooms. **Five ids appear in both.**
 *
 * So most of what the game draws is not in the picture surface, and most of
 * what the picture surface holds is not something a script was found drawing.
 * The ids the scripts push are small — 14, 20, 31, 47, 63, 67 — and the one
 * overlap that is confirmed from two directions is background **64**, which
 * `play:vt` also reports for screen 0 and which renders as a recognisable
 * interior. So the derivation is right about the pairs it finds; what is not
 * established is why the two id sets barely meet.
 *
 * Two readings, and neither is checked: the size tests
 * (`isSkyGameArea`/`isSkyScreen`) may be admitting resources that are not room
 * backgrounds and missing ones that are, or `LAYER_0_ID` may not hold a plain
 * resource id for every room. **Until one is established, a picture with no
 * derived palette says so** rather than defaulting quietly, because a
 * confident-looking colour on a picture nobody has tied to a script is the
 * failure this whole surface was corrected for once already.
 */
export function deriveSkyPicturePalettes(
  modules: ReadonlyMap<number, Uint16Array>,
): Map<number, number[]> {
  const pairs = new Map<number, number[]>();

  for (const words of modules.values()) {
    for (let index = 1; index < skyScriptCount(words); index += 1) {
      const offset = skyScriptOffset(words, index);
      if (offset === 0 || offset >= words.length) continue;

      let lastPushed: number | null = null;
      let background: number | null = null;
      for (const instruction of listSkyScript(words, offset).instructions) {
        if (instruction.name === 'push_number') lastPushed = instruction.operands[0] ?? null;
        if (
          instruction.name === 'pop_variable' &&
          instruction.operands[0] === SKY_LAYER_0_ID_OFFSET
        ) {
          background = lastPushed;
        }
        if (instruction.name !== 'call_mcode') continue;
        if ((instruction.operands[1] ?? -1) / SKY_MCODE_STRIDE !== SKY_MCODE.fnDrawScreen) continue;
        if (background === null || lastPushed === null) continue;
        const found = pairs.get(background) ?? [];
        if (!found.includes(lastPushed)) found.push(lastPushed);
        pairs.set(background, found);
      }
    }
  }

  return pairs;
}
