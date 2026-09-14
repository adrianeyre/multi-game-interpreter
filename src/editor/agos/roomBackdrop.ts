/**
 * A room's backdrop, drawn the way the game draws it.
 *
 * ## Why this is not a decode
 *
 * Every other picture this editor shows comes out of `decodeZoneImage`: a slot
 * in a zone's pixel table, unpacked into four-bit indices. A room backdrop is
 * not one of those. `o_picture(id, window)` reaches `setWindowImage`, which
 * looks the **whole id** up in the zone's *script* resource and runs the script
 * it finds — so the scene is *composed*, out of several images, in eight-bit
 * colour, against a palette the same script loads a bank at a time.
 *
 * So this runs that script. `VgaMachine` is the same interpreter the engine
 * uses, given a plain buffer to paint into instead of the screen, and what
 * comes back is what the game would have put up. Nothing here re-implements
 * drawing; if the engine draws a room correctly then so does this, and if it
 * does not then both are wrong together — which is the property worth having.
 *
 * ## What it costs, and what it cannot do
 *
 * Measured on the retail games: **90 of 92** Simon 1 rooms and **55 of 67**
 * Simon 2 rooms paint something. The rest come back blank, and the reason is
 * honest rather than a bug — about a third of a Version's VGA opcodes ask the
 * world questions ("is the lantern here?"), and a machine with no running game
 * behind it has to answer no. A script that draws its scene inside such a
 * branch draws nothing, and this says so instead of showing an empty room as
 * though the room were empty.
 *
 * It is also **read-only**, and that is the shape of the thing rather than a
 * gap. A backdrop is the output of a script that composes many images; there is
 * no single resource a paint could be written back to, so ADR 0030's "record
 * what the author meant" has nothing to record. The Art tab remains where an
 * image is edited.
 */

import { VgaMachine, type VgaTarget } from '../../engine/agos/gfx/VgaMachine.js';
import { readVgaFile } from '../../engine/agos/gfx/vgaFile.js';
import { RecordingVgaHost } from '../../engine/agos/gfx/vgaHost.js';
import type { AgosVersion } from '../../engine/agos/agosVersion.js';

/**
 * The buffer a room is drawn into.
 *
 * Wider and taller than a screen on purpose: Simon 2 stores a scrolling room as
 * one backdrop up to three screens across, and a buffer cut to 320 would clip
 * the room to the part of it the player starts in. 960 by 240 holds the widest
 * room either game has (960 pixels, measured) with the interface band's worth
 * of height to spare.
 */
const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 240;

/** Where a room's backdrop is put, which is the play area rather than the screen. */
const PLAY_AREA_WINDOW = 4;

/** A drawn room: eight-bit indices, and the colours the script chose for them. */
export interface RoomBackdrop {
  readonly width: number;
  readonly height: number;
  /** One byte per pixel, indexing {@link palette}. */
  readonly pixels: Uint8Array;
  /** 256 colours as RGB triples, as the script's palette loads left them. */
  readonly palette: Uint8Array;
  /** How many colours the picture actually uses, for a caller that wants to say. */
  readonly colours: number;
}

/** The VGA opcode table a Version's graphics scripts decode with. */
export function vgaTableFor(version: AgosVersion): string {
  switch (version) {
    case 'Elvira1':
      return 'elvira1';
    case 'Elvira2':
      return 'elvira2';
    case 'Waxworks':
      return 'waxworks';
    case 'Simon1':
      return 'simon1';
    case 'Simon2':
      return 'simon2';
    case 'Feeble':
      return 'feeblefiles';
    case 'PuzzlePack':
      return 'puzzlepack';
  }
}

/**
 * Runs one room's picture script, or says why it could not.
 *
 * A string rather than a throw, for the reason `resupply.ts` gives: every
 * failure here is something to show an author — a zone that is not in the
 * folder, an id the resource has no entry for, a script that drew nothing —
 * and none of them is a fault in the editor.
 */
export function renderRoomBackdrop(options: {
  scripts: Uint8Array;
  pixels: Uint8Array;
  /** The id `o_picture` was handed: its hundreds column is the zone. */
  picture: number;
  version: AgosVersion;
  agos2?: boolean;
}): RoomBackdrop | string {
  let file;
  try {
    file = readVgaFile(options.scripts, { agos2: options.agos2 });
  } catch (error) {
    return `This zone's graphics resource could not be read: ${reasonOf(error)}.`;
  }

  const entry = file.images.find((each) => each.id === options.picture);
  if (!entry) {
    return `This zone's resource holds no picture ${options.picture}, so the room's own script cannot be run.`;
  }

  const canvas = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);
  const palette = new Uint8Array(256 * 3);
  const target: VgaTarget = {
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    pixels: canvas,
    // A masked draw takes its colours from what is already behind. Shared with
    // `pixels` rather than a second buffer: this runs one script into an empty
    // field, so "behind" and "in front" are the same surface, and giving the
    // machine nothing would make a masked draw refuse instead of reveal.
    background: canvas,
    setPalette: (base, rgb) => {
      for (let index = 0; index * 3 < rgb.length; index += 1) {
        const at = (base + index) * 3;
        if (at + 2 >= palette.length) break;
        palette[at] = rgb[index * 3] ?? 0;
        palette[at + 1] = rgb[index * 3 + 1] ?? 0;
        palette[at + 2] = rgb[index * 3 + 2] ?? 0;
      }
    },
    windows: new Map(),
  };

  const machine = new VgaMachine(
    options.scripts,
    options.pixels,
    vgaTableFor(options.version),
    target,
    /*
     * The two questions a backdrop script asks that a recorder refuses.
     *
     * A scene routinely draws itself by asking for another image, so a host
     * that answers "no window sink" to `setWindowImage` leaves a composed room
     * half-drawn. Both route back into this same machine, which is what the
     * engine's own host does — see `AgosEngine.setWindowImage`. Everything
     * else the recorder answers, and answers "no", which is the whole reason
     * some rooms come back blank.
     */
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

  /*
   * The three things `AgosEngine.setWindowImage` does before it runs the script,
   * in its order — and each of them is load-bearing.
   *
   * - **The window is cleared to the entry's own colour.** `VgaEntry.colour` is
   *   the background a scene is composed over; without it the parts of a room
   *   its images do not cover keep whatever was in the buffer, which came out
   *   as vertical stripes of nothing behind the scenery.
   * - **`windowImageMode` is set.** It is what chooses the thirty-two colour
   *   decode, and a backdrop decoded as a sprite is the same picture with its
   *   rows interleaved — stripes again, this time through the scenery.
   * - **The draw window is the play area.** A room goes in window 4 so it does
   *   not paint over the interface, and the room's own script clips to it.
   */
  machine.clearWindow(PLAY_AREA_WINDOW, entry.colour ?? 0);
  machine.windowImageMode = true;
  machine.drawWindow = PLAY_AREA_WINDOW;
  try {
    machine.run(entry.scriptOffset);
  } catch (error) {
    return `This room's picture script stopped: ${reasonOf(error)}.`;
  } finally {
    machine.windowImageMode = false;
  }

  const used = new Set(canvas);
  if (used.size <= 1) {
    return (
      'This room’s script drew nothing. Its scene is inside a branch that asks about the ' +
      'running game — whether a character is present, say — and a picture drawn outside the ' +
      'game has to answer no.'
    );
  }

  return trimmed(canvas, palette, used.size);
}

/**
 * The drawn part of the buffer, rather than the whole of it.
 *
 * The buffer is sized for the widest room in either game, so all but that one
 * room would come back with a field of index zero around them — which reads as
 * a small picture in a large empty frame rather than as the room. So the rows
 * and columns that were painted are found and the rest is dropped.
 */
function trimmed(canvas: Uint8Array, palette: Uint8Array, colours: number): RoomBackdrop {
  let top = CANVAS_HEIGHT;
  let bottom = -1;
  let left = CANVAS_WIDTH;
  let right = -1;

  for (let y = 0; y < CANVAS_HEIGHT; y += 1) {
    for (let x = 0; x < CANVAS_WIDTH; x += 1) {
      if (canvas[y * CANVAS_WIDTH + x] === 0) continue;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }

  // Nothing but index zero cannot happen — the caller checked — but a bound
  // that never moved would give a negative size, so this stays honest anyway.
  if (bottom < 0 || right < 0) {
    return { width: 0, height: 0, pixels: new Uint8Array(0), palette, colours };
  }

  const width = right - left + 1;
  const height = bottom - top + 1;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    pixels.set(
      canvas.subarray((top + y) * CANVAS_WIDTH + left, (top + y) * CANVAS_WIDTH + left + width),
      y * width,
    );
  }
  return { width, height, pixels, palette, colours };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown reason';
}

/**
 * A drawn room as a data URL, or null where there is no canvas to make one.
 *
 * Null is the test environment, which has no 2D context. The caller then says
 * so rather than showing a broken image — the same fallback the Art tab's
 * thumbnails take, and for the same reason.
 */
export function roomBackdropUrl(shot: RoomBackdrop): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = shot.width;
  canvas.height = shot.height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  const image = context.createImageData(shot.width, shot.height);
  for (let at = 0; at < shot.width * shot.height; at += 1) {
    const colour = (shot.pixels[at] ?? 0) * 3;
    image.data[at * 4] = shot.palette[colour] ?? 0;
    image.data[at * 4 + 1] = shot.palette[colour + 1] ?? 0;
    image.data[at * 4 + 2] = shot.palette[colour + 2] ?? 0;
    image.data[at * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL();
}
