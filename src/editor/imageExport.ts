import { loadImage } from '../authoring/imageCodec.js';
import { defaultPalette } from '../authoring/palette.js';
import {
  poseCels,
  type PoseFacing,
  type ProjectActor,
  type ProjectObject,
  type ProjectRoom,
} from '../authoring/project.js';
import { downloadBlob } from './storage.js';

/**
 * Artwork out of the editor, on its own.
 *
 * The editing canvases draw walk boxes, object outlines, perspective guides,
 * grids and drag previews over the art, which is what makes them editors and
 * exactly what you do not want in a file. These render the pixels and nothing
 * else, at their true size, so an export is the artwork rather than a
 * screenshot of the tool.
 *
 * What counts as transparent differs by kind, which is the only real
 * complication: a room background is opaque throughout, object art reserves
 * index 255, and a costume reserves colour 0.
 */

export interface RenderedImage {
  width: number;
  height: number;
  /** Straight RGBA, four bytes per pixel. */
  rgba: Uint8ClampedArray;
}

/** Kept for the room background's own name. */
export type RenderedBackground = RenderedImage;

/**
 * Expands the stored indices into RGBA using the room's own colours.
 *
 * Separate from the canvas work so it can be tested without a DOM, and so the
 * same pixels could be written by something other than a browser.
 */
export function renderBackground(room: ProjectRoom): RenderedImage {
  const image = loadImage(room.background);
  const palette = room.palette ?? defaultPalette();
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);

  for (let i = 0, j = 0; i < image.pixels.length; i++, j += 4) {
    const entry = palette[image.pixels[i]] ?? [0, 0, 0];
    rgba[j] = entry[0];
    rgba[j + 1] = entry[1];
    rgba[j + 2] = entry[2];
    rgba[j + 3] = 255;
  }
  return { width: image.width, height: image.height, rgba };
}

/** Object art paints this index where the room should show through. */
const TRANSPARENT_OBJECT_INDEX = 255;

function slug(text: string): string {
  return text
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** "-front-door", or nothing when the name has no usable characters. */
function suffix(name: string): string {
  const safe = slug(name);
  return safe ? `-${safe}` : '';
}

/** A filename that says which game and room the image came from. */
export function backgroundFilename(room: ProjectRoom, gameName: string): string {
  return `${slug(gameName) || 'game'}-room-${room.id}${suffix(room.name)}.png`;
}

/** Writes the artwork to a PNG the browser downloads. */
export async function exportRoomBackground(room: ProjectRoom, gameName: string): Promise<void> {
  await writePng(renderBackground(room), backgroundFilename(room, gameName));
}

/**
 * Encodes RGBA as a PNG and hands it to the browser to save.
 *
 * Exported so the AGOS surfaces can use it: their canvases are their own but
 * the last two steps — encode, then download — are the same, and the download
 * in particular is a five-line dance with a browser quirk in it (see
 * `downloadBlob`). A fourth hand-written copy of that dance is how AGOS's art
 * export came to append no link and revoke its URL in the same tick, which
 * saves nothing at all.
 */
export async function writePng(
  { width, height, rgba }: RenderedImage,
  filename: string,
): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is unavailable');
  // Built through the context rather than `new ImageData`, which wants a buffer
  // type that varies between DOM library versions.
  const imageData = context.createImageData(width, height);
  imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not encode the image');

  downloadBlob(filename, blob, 'image/png');
}

/**
 * One state of an object's art, with its transparent pixels transparent.
 *
 * Object art stores game palette indices directly and uses 255 to mean "the
 * room shows through", so exporting it as opaque would paint whatever colour
 * happens to sit at index 255 across everything the object does not cover.
 */
export function renderObjectState(
  object: ProjectObject,
  stateIndex: number,
  gamePalette: number[][],
): RenderedImage | null {
  const stored = object.states[stateIndex];
  if (!stored) return null;

  const image = loadImage(stored);
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);

  for (let i = 0, j = 0; i < image.pixels.length; i++, j += 4) {
    const index = image.pixels[i];
    if (index === TRANSPARENT_OBJECT_INDEX) continue;
    const entry = gamePalette[index] ?? [0, 0, 0];
    rgba[j] = entry[0];
    rgba[j + 1] = entry[1];
    rgba[j + 2] = entry[2];
    rgba[j + 3] = 255;
  }
  return { width: image.width, height: image.height, rgba };
}

/**
 * One cel of an actor's pose.
 *
 * A costume stores its own small colour indices, which the actor's palette
 * maps onto the game's — the indirection that lets one costume be worn by
 * several characters in different clothes. Colour 0 is transparent.
 */
export function renderSpriteCel(
  actor: ProjectActor,
  poseIndex: number,
  celIndex: number,
  gamePalette: number[][],
  facing: PoseFacing = 'all',
): RenderedImage | null {
  const cel = poseCels(actor.poses[poseIndex], facing)[celIndex];
  if (!cel) return null;

  const image = loadImage(cel.image);
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);

  for (let i = 0, j = 0; i < image.pixels.length; i++, j += 4) {
    const costumeColor = image.pixels[i];
    if (costumeColor === 0) continue;
    const entry = gamePalette[actor.palette[costumeColor - 1] ?? 15] ?? [255, 255, 255];
    rgba[j] = entry[0];
    rgba[j + 1] = entry[1];
    rgba[j + 2] = entry[2];
    rgba[j + 3] = 255;
  }
  return { width: image.width, height: image.height, rgba };
}

export function objectFilename(object: ProjectObject, state: number, gameName: string): string {
  return `${slug(gameName) || 'game'}-object-${object.id}${suffix(object.name)}-state-${state + 1}.png`;
}

export function spriteFilename(
  actor: ProjectActor,
  pose: number,
  cel: number,
  gameName: string,
): string {
  return `${slug(gameName) || 'game'}-actor-${actor.id}${suffix(actor.name)}-pose-${pose}-cel-${cel + 1}.png`;
}

export async function exportObjectState(
  object: ProjectObject,
  stateIndex: number,
  gamePalette: number[][],
  gameName: string,
): Promise<void> {
  const rendered = renderObjectState(object, stateIndex, gamePalette);
  if (!rendered) throw new Error('That object has no art for this state');
  await writePng(rendered, objectFilename(object, stateIndex, gameName));
}

export async function exportSpriteCel(
  actor: ProjectActor,
  poseIndex: number,
  celIndex: number,
  gamePalette: number[][],
  gameName: string,
): Promise<void> {
  const rendered = renderSpriteCel(actor, poseIndex, celIndex, gamePalette);
  if (!rendered) throw new Error('That pose has no cel to export');
  await writePng(rendered, spriteFilename(actor, poseIndex, celIndex, gameName));
}
