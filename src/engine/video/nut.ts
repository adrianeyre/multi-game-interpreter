import { readFrameObject, readSmushFile, SmushCodec } from './smush.js';

/**
 * `.NUT` fonts: the glyphs a SMUSH sequence draws its subtitles with.
 *
 * Not the `CHAR` resource `gfx/Charset.ts` reads. That is a resource pulled
 * from the index with a documented chunk layout; a `.NUT` is a separate file
 * whose glyphs are compressed with SMUSH's own codecs — which is the argument
 * for it living here rather than beside `Charset`, and the argument holds all
 * the way down: a `.NUT` **is** a SMUSH animation. `ANIM` > `AHDR` > one `FRME`
 * per character, each holding a `FOBJ` with the same fourteen-byte header a
 * video frame has. So the container reader is reused rather than rewritten, and
 * a glyph is a frame object that happens to be letter-shaped.
 *
 * (`NutRenderer::loadFont`.)
 */

/**
 * Codec 21's own transparency, and everyone else's.
 *
 * A glyph is filled with its transparent colour before decoding, because these
 * codecs *skip* pixels rather than writing them — the runs say how far to jump
 * as well as what to copy. Without the fill, whatever the buffer held shows
 * through the gaps in a letter.
 */
const DEFAULT_TRANSPARENT = 0;
const CODEC44_TRANSPARENT = 2;

/** Codec 44 is codec 21's encoding under a second number. */
const NUT_CODEC_LINE_RUNS = 21;
const NUT_CODEC_LINE_RUNS_ALT = 44;

export interface NutGlyph {
  width: number;
  height: number;
  /** Where the glyph sits relative to the text cursor. */
  xOffset: number;
  yOffset: number;
  /** The colour that means "leave what is underneath". */
  transparency: number;
  /** One byte per pixel, row-major, `width * height` long. */
  pixels: Uint8Array;
}

export interface NutFont {
  glyphs: NutGlyph[];
  /** The tallest glyph, which is what a line of text advances by. */
  height: number;
}

/**
 * Reads a `.NUT` font.
 *
 * Returns null when the file is not one, rather than throwing: a missing font
 * is subtitles that do not draw, and naming it beats an exception from inside a
 * frame loop.
 */
export function readNutFont(bytes: Uint8Array): NutFont | null {
  const file = readSmushFile(bytes);
  if (!file) return null;

  const glyphs: NutGlyph[] = [];
  let height = 0;

  // `AHDR`'s frame count is the character count here; the frames are the
  // glyphs. Clamped to what the file actually holds, because a truncated font
  // should give the letters it has rather than nothing.
  for (const frame of file.frames.slice(0, file.header.frameCount)) {
    const fobj = frame.chunks.find((chunk) => chunk.tag === 'FOBJ');
    if (!fobj) break;

    const object = readFrameObject(fobj.data);
    if (!object) break;

    const transparency =
      object.codec === NUT_CODEC_LINE_RUNS_ALT ? CODEC44_TRANSPARENT : DEFAULT_TRANSPARENT;
    const pixels = new Uint8Array(object.width * object.height).fill(transparency);

    if (object.codec === SmushCodec.Rle) {
      decodeRleGlyph(object.data, pixels, object.width, object.height);
    } else if (object.codec === NUT_CODEC_LINE_RUNS || object.codec === NUT_CODEC_LINE_RUNS_ALT) {
      decodeLineRunGlyph(object.data, pixels, object.width, object.height);
    } else {
      // Left transparent rather than filled with noise. An undrawn letter is a
      // gap in a subtitle; a letter drawn from a misread stream is a block of
      // colour over the video.
      glyphs.push({
        width: object.width,
        height: object.height,
        xOffset: object.left,
        yOffset: object.top,
        transparency,
        pixels,
      });
      height = Math.max(height, object.height);
      continue;
    }

    glyphs.push({
      width: object.width,
      height: object.height,
      xOffset: object.left,
      yOffset: object.top,
      transparency,
      pixels,
    });
    height = Math.max(height, object.height);
  }

  if (glyphs.length === 0) return null;
  return { glyphs, height };
}

/** Codec 1: run-length lines, each behind its own 16-bit byte count. */
function decodeRleGlyph(source: Uint8Array, out: Uint8Array, width: number, height: number): void {
  let read = 0;
  for (let y = 0; y < height; y++) {
    if (read + 2 > source.length) return;
    const size = source[read] | (source[read + 1] << 8);
    let cursor = read + 2;
    let write = y * width;
    let remaining = width;

    while (remaining > 0 && cursor < source.length) {
      const code = source[cursor++];
      const count = Math.min((code >> 1) + 1, remaining);
      remaining -= count;
      if (code & 1) {
        out.fill(source[cursor++], write, write + count);
      } else {
        for (let i = 0; i < count; i++) out[write + i] = source[cursor + i];
        cursor += count;
      }
      write += count;
    }
    read += size + 2;
  }
}

/**
 * Codecs 21 and 44: alternating skips and runs, one line at a time.
 *
 * Each line is a 16-bit byte count, then pairs of "skip this many pixels" and
 * "copy this many, plus one". The skips are what make the fill above necessary:
 * a skipped pixel is never written, so the transparent colour has to already be
 * there.
 *
 * The plus-one on the copy length is not a detail to drop — a run is never zero
 * long, and reading it without the bias makes every glyph one pixel narrower
 * per run, which reads as a slightly wrong font rather than as a decode error.
 */
function decodeLineRunGlyph(
  source: Uint8Array,
  out: Uint8Array,
  width: number,
  height: number,
): void {
  let lineStart = 0;

  for (let y = 0; y < height; y++) {
    if (lineStart + 2 > source.length) return;
    const size = source[lineStart] | (source[lineStart + 1] << 8);
    let cursor = lineStart + 2;
    const nextLine = lineStart + 2 + size;

    let write = y * width;
    let remaining = width;

    while (remaining > 0 && cursor + 1 < source.length) {
      const skip = source[cursor] | (source[cursor + 1] << 8);
      cursor += 2;
      write += skip;
      remaining -= skip;
      if (remaining <= 0) break;

      if (cursor + 1 >= source.length) break;
      let run = (source[cursor] | (source[cursor + 1] << 8)) + 1;
      cursor += 2;
      remaining -= run;
      if (remaining < 0) run += remaining;
      if (run <= 0) break;

      for (let i = 0; i < run; i++) out[write + i] = source[cursor + i];
      cursor += run;
      write += run;
    }

    lineStart = nextLine;
  }
}
