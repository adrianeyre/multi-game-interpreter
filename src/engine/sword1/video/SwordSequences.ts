/**
 * Broken Sword's cutscenes: the Smacker files under `smackshi/` and `video/`.
 *
 * ## One reader, two families, and it was already here
 *
 * `fnPlaySequence` names a sequence and the file is `smackshi/<name>.smk` — or
 * `video/<name>.smk` on some releases. The decoder is AGOS's
 * (`src/engine/agos/video/smacker.ts`), because the format is **Smacker's** and
 * not Adventure Soft's: sharing a codec across families is the same standing on
 * which they share `Palette` and `Screen`, and a second Smacker reader would be
 * the duplication ADR 0011 warns about rather than the separation it asks for.
 *
 * Both Broken Swords use this module, for the same reason.
 *
 * ## How a sequence plays inside a synchronous `step`
 *
 * A cutscene is not a frame of the game: it takes the screen for a few hundred
 * frames and gives it back. So it is a **state on the engine** rather than a
 * call that blocks — `openSequence` starts one, `advanceSequence` draws one
 * frame a tick and answers null when it is over, and the engine skips its logic
 * cycle while one is running. The original does the same: its `fnPlaySequence`
 * does not return until the player has seen the film.
 *
 * The palette needs care. A Smacker carries its own 256 colours, so a cutscene
 * destroys the room's — the engine snapshots the palette before the sequence
 * and restores it after.
 */

import { looksLikeSmacker, Smacker, type SmackerFrame } from '../../agos/video/smacker.js';

/** The folders a release keeps its sequences in, in the order to look. */
export const SWORD_VIDEO_FOLDERS = ['smackshi', 'video', 'smacks'] as const;

/** A sequence being played: the decoder, and where it is up to. */
export interface SwordSequence {
  readonly name: string;
  readonly smacker: Smacker;
  /** Frames drawn so far. */
  frame: number;
}

/**
 * Every file that could be a sequence's film, best candidate first.
 *
 * By *base name* rather than by path, because releases disagree about the
 * folder and about case — and a name in two folders is the same film either
 * way. A file inside a folder the game keeps films in wins, so a stray
 * `intro.smk` in the root does not shadow the real one.
 *
 * ## Why this returns a list, and why the extension is not the last word
 *
 * Revolution's own interpreters know exactly one filename: `game.exe` in the
 * Broken Sword II demo holds a single format string, `%s.smk`, and ScummVM's
 * `makeMoviePlayer` tries `.smk`, `.dxa` and `.mp2`. So `<name>.smk` is and
 * stays the first thing looked for.
 *
 * It is not the only thing, because a shipped folder can disagree with the
 * interpreter about a name. That demo folder holds `demo.smdk`, and its own
 * `files.txt` — a directory listing captured with the download — names the
 * same 289,700 bytes at the same 21/08/1997 09:31 as **`demo.smk`**. The film
 * is the one the scripts ask for; the extension is a typo that happened to the
 * file after Revolution shipped it, and refusing on it means refusing the
 * demo's own opening.
 *
 * Guessing from a name would be the wrong cure — so nothing here guesses. This
 * returns candidates and the caller opens them in order: {@link openSequence}
 * reads the Smacker signature and answers null for anything else, so what
 * decides is the file's own first four bytes. A `demo.txt` sitting beside the
 * film costs one rejected read.
 */
export function findSequenceFiles(names: readonly string[], sequence: string): string[] {
  const wanted = sequence.toLowerCase();
  const base = (name: string): string =>
    (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
  const stem = (name: string): string => base(name).replace(/\.[^.]*$/, '');
  const inVideoFolder = (name: string): boolean =>
    SWORD_VIDEO_FOLDERS.some((folder) => name.toLowerCase().includes(`${folder}/`));

  // Four tiers, and every one of them is "the right name": the extension and
  // the folder only order them. Deduplicated, because a name can qualify twice.
  const tiers: Array<(name: string) => boolean> = [
    (name) => base(name) === `${wanted}.smk` && inVideoFolder(name),
    (name) => base(name) === `${wanted}.smk`,
    (name) => stem(name) === wanted && inVideoFolder(name),
    (name) => stem(name) === wanted,
  ];
  const found: string[] = [];
  for (const matches of tiers) {
    for (const name of names) {
      if (matches(name) && !found.includes(name)) found.push(name);
    }
  }
  return found;
}

/** The best candidate alone, for a caller that only wants to know if one exists. */
export function findSequenceFile(names: readonly string[], sequence: string): string | null {
  return findSequenceFiles(names, sequence)[0] ?? null;
}

/** Opens a sequence, or null when the bytes are not a Smacker this reads. */
export function openSequence(name: string, bytes: Uint8Array): SwordSequence | null {
  if (!looksLikeSmacker(bytes)) return null;
  const smacker = Smacker.open(bytes);
  return smacker ? { name, smacker, frame: 0 } : null;
}

/**
 * Opens the first of {@link findSequenceFiles}' candidates whose bytes are a
 * Smacker, and says which file that was.
 *
 * Shared by both families' engines because the loop is the whole of the
 * decision and writing it twice is how the two would come to disagree about
 * which candidate wins. ADR 0036's line is intact: this is the codec's own
 * lookup, and it has never heard of a compact or a run list.
 */
export async function openFirstSequence(
  names: readonly string[],
  sequence: string,
  read: (file: string) => Promise<Uint8Array | null | undefined>,
): Promise<{ readonly sequence: SwordSequence; readonly file: string } | null> {
  for (const file of findSequenceFiles(names, sequence)) {
    const bytes = await read(file);
    const opened = bytes ? openSequence(sequence, bytes) : null;
    if (opened) return { sequence: opened, file };
  }
  return null;
}

/**
 * Draws the next frame of a sequence into a screen-sized framebuffer.
 *
 * Returns the frame when one was drawn and null when the sequence has ended.
 * The film is centred rather than stretched: a Smacker is authored at its own
 * size and scaling it would be a decision this project has no reason to make.
 */
export function advanceSequence(
  sequence: SwordSequence,
  out: Uint8Array,
  screenWidth: number,
  screenHeight: number,
): SmackerFrame | null {
  if (sequence.frame >= sequence.smacker.info.frameCount) return null;

  const frame = sequence.smacker.nextFrame();
  sequence.frame++;
  if (!frame) return null;

  const { width, height, displayHeight } = sequence.smacker.info;
  const left = Math.max(0, Math.floor((screenWidth - width) / 2));
  const top = Math.max(0, Math.floor((screenHeight - displayHeight) / 2));
  // `displayHeight` and not `height`: a Smacker may declare that each decoded
  // row is shown twice, and drawing `height` rows leaves the bottom half of the
  // screen holding whatever was there before.
  const doubled = displayHeight === height * 2;

  out.fill(0);
  for (let row = 0; row < displayHeight; row++) {
    const sourceRow = doubled ? row >> 1 : row;
    const destY = top + row;
    if (destY < 0 || destY >= screenHeight) continue;
    const from = sourceRow * width;
    const to = destY * screenWidth + left;
    const take = Math.min(width, screenWidth - left);
    if (take <= 0) continue;
    out.set(frame.pixels.subarray(from, from + take), to);
  }
  return frame;
}
