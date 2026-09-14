/**
 * An item's inventory icon, out of `ICON.DAT`.
 *
 * The Items tab lists a game's world, and until this existed the answer to
 * "can I have a picture of this thing" was no — an item is a record of numbers,
 * and none of them is a picture. But two of the Versions here do give some
 * items a picture: Simon 1 and Simon 2 both draw an inventory of *icons*, and
 * an icon is a real 24x24 or 20x20 bitmap in a file beside the game.
 *
 * ## Which items have one, and why that is not a guess
 *
 * The mapping is the reference's, transcribed twice over: this repository
 * already carries it in `AgosEngine.drawIcons`, from
 * `AGOSEngine_Elvira2::itemGetIconNumber` (`items.cpp:58`), which Waxworks,
 * Simon 1 and Simon 2 all inherit without overriding. An item has an icon when
 * its **object** sub-structure carries `kOFIcon` — bit 4, `0x10` — and the icon
 * number is that object's value for the same bit.
 *
 * Measured on the two retail games, which is what makes it safe to hand an
 * author a file: Simon 1 flags **90 of its 192 items**, numbering them 1..95,
 * and Simon 2 flags **96 of 172**, numbering them 1..99. Every one of those 186
 * decodes to a drawn icon — none blank, none out of range. `ICON.DAT`'s own
 * table bound, derived from entry 0's first offset, is 97 for Simon 1 and 102
 * for Simon 2: each sits just above the highest number the items actually use,
 * which is what a correct mapping looks like from the file's side too.
 *
 * **An item with no object sub-structure, or one without the flag, has no
 * picture of its own** — and that is said rather than papered over. Roughly
 * half of each game's items are in that position: a room, a hidden marker, a
 * chain. Drawing icon 0 for them, or the icon of the item next door, would hand
 * an author a confident picture of the wrong thing.
 *
 * ## The two geometries
 *
 * Both games read `ICON.DAT` whole with no header and index a table at the
 * front of it, but they index it differently, and this is why the export is
 * gated to the two Versions whose layout has been read rather than offered for
 * the family:
 *
 * - **Simon 1** (`AGOSEngine_Simon1::drawIcon`, `icons.cpp:235`): one
 *   little-endian 16-bit offset at `icon * 2`, one pass, `decompressIcon` at
 *   24 columns by 12 — which is a 24x24 cell — at colour base 224.
 * - **Simon 2** (`AGOSEngine_Simon2::drawIcon`, `icons.cpp:209`): two offsets
 *   at `icon * 4`, two passes over one 20x20 cell, at bases 224 then 208.
 *
 * `decompressIcon` is the engine's, not a copy: the RLE walks *down* columns
 * and getting that wrong produces a smear of the right length, so there is one
 * transcription of it and both callers use it.
 *
 * ## Where the colours come from
 *
 * A nibble is ORed with the base, so an icon only ever uses palette entries
 * 208..239 — and those are not in the icon file, nor in the zone the item's
 * room belongs to. They are loaded by **zone 0's own image scripts**, which run
 * once when the game starts and set up the interface's colours for the session.
 *
 * That was established rather than assumed. Running zone 0's image scripts
 * through `VgaMachine` — the same route `roomBackdrop.ts` takes — and capturing
 * what they hand `setPalette` reproduces the *running engine's* entries 208-239
 * exactly on both games: 0 of 96 channels differ, in Simon 1 and in Simon 2.
 * The two games put the ranges at different bank numbers and in the opposite
 * order, which is why this runs the scripts instead of computing an offset.
 */

import { VgaMachine, type VgaTarget } from '../../engine/agos/gfx/VgaMachine.js';
import { decompressIcon } from '../../engine/agos/gfx/icons.js';
import { readVgaFile } from '../../engine/agos/gfx/vgaFile.js';
import { RecordingVgaHost } from '../../engine/agos/gfx/vgaHost.js';
import { vgaTableFor } from './roomBackdrop.js';
import { ITEM_CHILD_TYPES, type AgosItem } from '../../engine/agos/world/itemTree.js';
import type { AgosVersion } from '../../engine/agos/agosVersion.js';

/**
 * `kOFIcon`: the object flag that says an item is drawn in the inventory, and
 * the same bit whose value is the icon number (`items.cpp:49-67`).
 */
const ICON_FLAG_BIT = 4;

/** The zone whose scripts set up the interface palette, entries 208 upward. */
const INTERFACE_ZONE = 0;

/** An icon as indices, against the interface palette entries 208..239. */
export interface ItemIcon {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel. Zero is transparent, as `decompressIcon` leaves it. */
  readonly pixels: Uint8Array;
}

/**
 * The icon number an item carries, or null where it carries none.
 *
 * Null rather than zero: icon 0 is a real entry in the table, so "no icon" and
 * "icon zero" have to be different answers or half the item tree would export
 * whatever picture happens to sit first in the file.
 */
export function itemIconNumber(item: AgosItem): number | null {
  const child = item.children.find((each) => each.type === ITEM_CHILD_TYPES.object);
  if (!child) return null;

  const mask = child.header?.[0] ?? 0;
  if ((mask & (1 << ICON_FLAG_BIT)) === 0) return null;

  // The values are the ones the mask sized, in order, so the index is a count
  // of set bits below this one — the same counting `AgosState.objectValue`
  // does, and the reference's `offs`.
  let index = 0;
  for (let bit = 0; bit < 16; bit += 1) {
    if ((mask & (1 << bit)) === 0) continue;
    if (bit === ICON_FLAG_BIT) return child.values[index] ?? null;
    index += 1;
  }
  return null;
}

/** Whether this Version's icon layout has been read, and can be drawn here. */
export function iconsAreKnownFor(version: AgosVersion): version is 'Simon1' | 'Simon2' {
  return version === 'Simon1' || version === 'Simon2';
}

/**
 * Decodes one icon, or says why it could not be decoded.
 *
 * A string rather than a throw, for the reason the rest of this surface gives:
 * every refusal here is something to show an author — a Version whose layout
 * has not been read, a number past the end of the table — and none of them is
 * a fault in the editor.
 */
export function decodeItemIcon(
  iconFile: Uint8Array,
  icon: number,
  version: AgosVersion,
): ItemIcon | string {
  if (!iconsAreKnownFor(version)) {
    return (
      `Only Simon 1 and Simon 2 have had their icon layout read here, so an icon cannot be ` +
      `drawn for ${version}.`
    );
  }

  const stride = version === 'Simon2' ? 4 : 2;
  const at = icon * stride;
  if (at + stride > iconFile.length) {
    return `ICON.DAT has no entry ${icon}: its table ends before that number.`;
  }

  const width = version === 'Simon2' ? 20 : 24;
  // `decompressIcon` takes half the pixel height, because it writes two pixels
  // per step down a column. Both games' cells are square.
  const halfHeight = width / 2;
  const pixels = new Uint8Array(width * width);

  const first = iconFile[at]! | (iconFile[at + 1]! << 8);
  decompressIcon(pixels, 0, iconFile, first, width, halfHeight, 224, width);
  if (version === 'Simon2') {
    const second = iconFile[at + 2]! | (iconFile[at + 3]! << 8);
    decompressIcon(pixels, 0, iconFile, second, width, halfHeight, 208, width);
  }

  return { width, height: width, pixels };
}

/**
 * The interface palette, by running zone 0's image scripts and watching what
 * they load.
 *
 * Only entries 208..239 have been checked against the running engine, and they
 * are the only ones an icon can use — a nibble ORed with base 208 or 224 — so
 * the whole 256-entry table is returned but the icons only ever read that
 * window of it.
 */
export function interfacePalette(options: {
  scripts: Uint8Array;
  pixels: Uint8Array;
  version: AgosVersion;
  agos2?: boolean;
}): Uint8Array | string {
  let file;
  try {
    file = readVgaFile(options.scripts, { agos2: options.agos2 });
  } catch (error) {
    return `Zone ${INTERFACE_ZONE}'s graphics resource could not be read: ${reasonOf(error)}.`;
  }

  const palette = new Uint8Array(256 * 3);
  // A canvas the scripts can paint into and then be ignored: what is wanted is
  // the palette loads, not the picture, but a machine with nowhere to draw
  // would refuse the draws that sit between them.
  const canvas = new Uint8Array(320 * 200);
  const target: VgaTarget = {
    width: 320,
    height: 200,
    pixels: canvas,
    background: canvas,
    setPalette: (base, rgb) => {
      for (let index = 0; index * 3 < rgb.length; index += 1) {
        const to = (base + index) * 3;
        if (to + 2 >= palette.length) break;
        palette[to] = rgb[index * 3] ?? 0;
        palette[to + 1] = rgb[index * 3 + 1] ?? 0;
        palette[to + 2] = rgb[index * 3 + 2] ?? 0;
      }
    },
    windows: new Map(),
  };

  let loaded = false;
  for (const entry of file.images) {
    const machine: VgaMachine = new VgaMachine(
      options.scripts,
      options.pixels,
      vgaTableFor(options.version),
      target,
      Object.assign(new RecordingVgaHost(), {
        animationScriptOffset: (id: number) =>
          file.animations.find((each) => each.id === id)?.scriptOffset ?? null,
        loadImage: (id: number) => {
          const inner = file.images.find((each) => each.id === id);
          if (inner) machine.run(inner.scriptOffset);
        },
        setWindowImage: (_window: number, id: number) => {
          const inner = file.images.find((each) => each.id === id);
          if (inner) machine.run(inner.scriptOffset);
        },
      }),
      options.agos2 ? 'agos2' : 'simon',
    );
    try {
      machine.run(entry.scriptOffset);
      loaded = true;
    } catch {
      // A script that stops is the ordinary case here — a third of the VGA
      // opcodes ask the running game questions — and the next one may still
      // load the bank. Only all of them failing is worth reporting.
    }
  }

  if (!loaded) {
    return `None of zone ${INTERFACE_ZONE}'s scripts ran, so the icon colours are not known.`;
  }
  return palette;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown reason';
}
