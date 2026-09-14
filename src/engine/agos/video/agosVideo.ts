/**
 * Which video a file is, and what to say about the ones this project does not
 * decode.
 *
 * The Feeble Files and the Puzzle Pack are the only AGOS games with full-motion
 * video, and the files beside them are not all the same thing:
 *
 * - **Smacker** (`SMK2`, `SMK4`) is what Adventure Soft shipped. Decoded here.
 * - **DXA** (`DEXA`) is ScummVM's re-encode of those same videos, made for its
 *   ports and distributed with them. Recognised by name and **not decoded**,
 *   because ADR 0024 settled that this project reads what the publisher shipped
 *   rather than another implementation's derivation of it. A player who has
 *   these has a re-encode, and being told so is more use than a black screen.
 * - Anything else is unknown, and says so.
 *
 * The distinction matters more than it looks. A folder holding DXA files and no
 * Smacker ones is a complete, playable ScummVM install, and a person who put it
 * here has done nothing wrong — so the message names the file, names the
 * format, and says where the originals would be, rather than reporting a fault.
 */

import { looksLikeSmacker } from './smacker.js';

export type AgosVideoFormat = 'smacker' | 'dxa' | 'unknown';

export interface AgosVideoIdentity {
  readonly format: AgosVideoFormat;
  /** Whether this project decodes it, which is not the same as recognising it. */
  readonly decodable: boolean;
}

/** What a video file is, from its opening bytes. */
export function identifyAgosVideo(data: Uint8Array): AgosVideoIdentity {
  if (looksLikeSmacker(data)) return { format: 'smacker', decodable: true };
  if (
    data.length > 4 &&
    data[0] === 0x44 &&
    data[1] === 0x45 &&
    data[2] === 0x58 &&
    data[3] === 0x41
  ) {
    return { format: 'dxa', decodable: false };
  }
  return { format: 'unknown', decodable: false };
}

/**
 * The named gap a video this project cannot play leaves behind.
 *
 * A sentence rather than a code, because it is read by a person deciding what
 * to do next, and the two cases want different things done: a DXA has an
 * original somewhere, and an unrecognised file probably is not a video at all.
 */
export function describeUndecodableVideo(name: string, identity: AgosVideoIdentity): string {
  if (identity.format === 'dxa') {
    return (
      `${name} is a DXA — ScummVM's re-encode of this game's video rather than the ` +
      `file Adventure Soft shipped, which this project does not read. The sequence ` +
      `is skipped and the game carries on. The original .smk beside a disc install ` +
      `would play.`
    );
  }
  return (
    `${name} is not a video format this project decodes, so the sequence is skipped ` +
    `and the game carries on.`
  );
}

/**
 * The file a `off_loadVideo` operand names, as it is spelled on disc.
 *
 * The games name videos without an extension in some places and with one in
 * others, so a caller is given the candidates in the order worth trying rather
 * than a single guess that is right most of the time.
 */
export function videoFileCandidates(name: string): string[] {
  const trimmed = name.trim().replace(/\0+$/, '');
  if (trimmed === '') return [];
  if (/\.[a-z0-9]+$/i.test(trimmed)) return [trimmed];
  return [`${trimmed}.smk`, `${trimmed}.dxa`, trimmed];
}
