import { findChunkDeep, readChunkHeader } from '../engine/resource/Chunk.js';
import { looksLikeGmf, looksLikeMidiBundle } from '../engine/agos/sound/music.js';
import { looksLikeXmidi } from '../engine/agos/sound/xmidi.js';
import { findMidiData } from '../engine/sound/scummAdl.js';
import { fromBase64, toBase64 } from './base64.js';

/**
 * Audio that belongs to a project.
 *
 * Sound in SCUMM is a numbered resource: a script says `startSound 3` and the
 * interpreter looks up sound 3. Imported audio keeps that model — each track
 * owns an id, and that id is what a `playSound` action refers to — so audio an
 * author dropped in and audio that came out of a published game are the same
 * kind of thing to everything downstream.
 *
 * Bytes live in the project as base64, exactly as room art does, so a project
 * stays one self-contained JSON file that can be exported, mailed and
 * compiled without a second folder of assets travelling beside it.
 */
export interface ProjectAudio {
  /** The id scripts use. Unique within the project. */
  id: number;
  /** Shown in the editor; defaults to the filename it was imported from. */
  name: string;
  /** What the bytes turned out to be — sniffed, not taken from the extension. */
  format: AudioFormat;
  /** Original filename, kept so an author can tell two imports apart. */
  filename: string;
  /**
   * Base64 of the file, for audio small enough to travel inside the project.
   *
   * Absent when the bytes were too large and live in the editor's audio store
   * instead; `storeKey` then says where. Exactly one of the two is set.
   */
  data?: string;
  /** Key into the audio store, for anything too large to inline. */
  storeKey?: string;
  /** Byte length of the audio itself, so size can be shown without loading it. */
  bytes?: number;
  /**
   * Where in the game's own files this recording is, for audio that is neither.
   *
   * The third form, and the one a published game gets. A talkie's speech is
   * tens of megabytes — Simon 1's is 47.7 MB and Simon 2's 69.2 MB — so
   * copying it into the project or into the audio store is what ADR 0010's
   * size threshold and ADR 0030 both refuse. What the project holds instead is
   * this: which recording, by the number the game itself uses. The bytes are
   * read out of the folder the author re-supplies (ADR 0034) at the moment one
   * is played or saved, and are never held by the document.
   */
  resource?: AudioResource;
}

/**
 * One recording, named the way its game names it.
 *
 * A number and not an offset, deliberately: an offset would be a fact about
 * one release's file and would address the wrong recording in the next, where
 * a number is what the game's own scripts say and what an author reads in the
 * editor. Resolving it back to bytes is the job of whatever has the folder
 * open, which is why nothing here holds a reader.
 */
export interface AudioResource {
  /**
   * Which family's packaging these numbers belong to.
   *
   * Four, and they are not interchangeable: the same `{kind, number}` pair
   * addresses a different recording in each, so whatever resolves one back to
   * bytes checks this first and answers nothing for a family it does not know.
   */
  readonly engine: 'agos' | 'sword1' | 'sword2' | 'sci';
  /**
   * Which of the three kinds of sound a game keeps.
   *
   * They are numbered independently — speech 12, effect 12 and music 12 are
   * three different sounds — so the kind is part of the address rather than a
   * label on it.
   */
  readonly kind: 'speech' | 'effects' | 'music';
  /** The number the game uses: a line of speech, an effect, a track. */
  readonly number: number;
  /**
   * The other half of a two-part address, where the family needs one.
   *
   * AGOS swaps a whole bank of effects as the game moves between parts of
   * itself — one bank per `TABLES` file — so "effect 12" is only an address
   * once you know which bank. Broken Sword 1 addresses a line of speech the
   * same way for a different reason: its container is indexed by room and then
   * by line within the room, so a line number alone names nothing. Absent
   * wherever the family numbers a kind game-wide, which is most of them, and
   * absent throughout Broken Sword II — that family gives every sound one
   * resource id and needs no second number at all.
   */
  readonly bank?: number;
  /**
   * The file beside the game the bytes come out of, where they come out of one.
   *
   * Simon 1 ships its effects as `SFXXXX02` … `SFXXXX29` and its speech as one
   * large file; Simon 2 keeps its effects and music inside the resource
   * archive instead, and those entries carry no name because there is no file
   * to name. So this being absent means "in the archive" rather than "not
   * known".
   */
  readonly file?: string;
}

/** True when a track's audio lives outside the project document. */
export function isExternal(track: ProjectAudio): boolean {
  return !track.data && typeof track.storeKey === 'string' && track.storeKey.length > 0;
}

/**
 * Formats the editor can tell apart.
 *
 * The list is deliberately wider than the list it can play. A file that turns
 * out to be a Roland ROM or a SMUSH font is not a failed import, it is a
 * different kind of file, and saying which one it is turns "this didn't work"
 * into something the author can act on.
 */
export type AudioFormat =
  | 'wav'
  | 'mp3'
  | 'ogg'
  | 'flac'
  | 'aiff'
  | 'mp4'
  | 'voc'
  | 'agos-music'
  | 'scumm-sound'
  | 'scumm-music'
  | 'scumm-other'
  | 'scumm-silent'
  | 'executable'
  | 'midi'
  | 'imuse'
  | 'smush'
  | 'mt32-rom'
  | 'unknown';

/** Whether the browser or our own decoder can turn this into sound. */
export function isPlayableFormat(format: AudioFormat): boolean {
  switch (format) {
    case 'wav':
    case 'mp3':
    case 'ogg':
    case 'flac':
    case 'aiff':
    case 'mp4':
    case 'voc':
    case 'agos-music':
    case 'scumm-sound':
    case 'scumm-music':
    case 'scumm-other':
      // `agos-music` and the last two are synthesised through an emulated OPL2
      // rather than decoded, but as far as anything upstream is concerned they
      // play. AGOS's is GMF, a bundle of standard MIDI files, or XMIDI —
      // sequenced rather than recorded, and performed the way the engine
      // performs it; sequenced is not the same as unplayable, which is why it
      // is here and `midi` below is not. `scumm-other` is a score written for
      // a chip that is not emulated: playing it on the OPL2 with substitute
      // instruments gives the right notes with the wrong timbre, which is
      // worth far more than refusing to play it.
      return true;
    // `unknown` is still worth handing to the browser: the sniffer only knows
    // the containers it was taught, and a decoder that recognises more is no
    // reason to refuse the file.
    case 'unknown':
      return true;
    default:
      return false;
  }
}

/** Plain-English label, for the editor and for import reports. */
export function describeFormat(format: AudioFormat): string {
  switch (format) {
    case 'wav':
      return 'WAV';
    case 'mp3':
      return 'MP3';
    case 'ogg':
      return 'Ogg';
    case 'flac':
      return 'FLAC';
    case 'aiff':
      return 'AIFF';
    case 'mp4':
      return 'MP4/AAC';
    case 'voc':
      return 'Creative VOC';
    case 'agos-music':
      return 'AGOS sequenced music';
    case 'scumm-sound':
      return 'SCUMM digitised sound';
    case 'scumm-music':
      return 'SCUMM AdLib music';
    case 'scumm-other':
      return 'SCUMM music, no AdLib version';
    case 'scumm-silent':
      return 'SCUMM resource with no score';
    case 'executable':
      return 'Sound driver program';
    case 'midi':
      return 'MIDI';
    case 'imuse':
      return 'iMUSE';
    case 'smush':
      return 'SMUSH';
    case 'mt32-rom':
      return 'Roland MT-32 ROM';
    default:
      return 'Unrecognised';
  }
}

/**
 * Why a recognised-but-unplayable file cannot be played.
 *
 * Sequenced music and synthesiser ROMs are not audio in the sense a browser
 * understands: they are instructions and instrument data for a synthesiser
 * this engine does not have. Returning `null` for playable formats keeps the
 * caller from having to know which is which.
 */
export function whyUnplayable(format: AudioFormat): string | null {
  switch (format) {
    case 'scumm-silent':
      return 'There is no score and no digitised audio in this resource — nothing to play.';
    case 'executable':
      return 'This is a program, not a recording: an iMUSE sound-card driver, which the game loaded to talk to whichever card you had. The music itself lives in the game data files.';
    case 'midi':
      return 'MIDI is a score, not a recording — playing it needs a synthesiser, which this engine does not have yet.';
    case 'imuse':
      return 'iMUSE music is sequenced, not sampled; it needs an iMUSE player and a synthesiser.';
    case 'smush':
      return 'This is a SMUSH animation or font file, not audio.';
    case 'mt32-rom':
      return 'This is Roland MT-32 instrument data — the ROM a synthesiser needs, not a piece of music.';
    default:
      return null;
  }
}

/** How far into a file to look for a synthesiser ROM's name. */
const MT32_SCAN_BYTES = 64 * 1024;

function tag(bytes: Uint8Array, offset: number): string {
  if (offset + 4 > bytes.length) return '';
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/**
 * Works out what a file is from its contents.
 *
 * Extensions are not evidence. The files people have to hand come out of
 * extraction tools that name things by where they were found rather than what
 * they are — `.fla`, `.ims`, `.nut`, `.rom` all say nothing a decoder can use
 * — so every decision here is made on bytes.
 */
export function detectAudioFormat(bytes: Uint8Array): AudioFormat {
  if (bytes.length < 4) return 'unknown';

  const head = tag(bytes, 0);

  if (head === 'RIFF') {
    const form = tag(bytes, 8);
    if (form === 'WAVE') return 'wav';
    // RIFF is a container; a RIFF that is not WAVE is not ours to play.
    return 'unknown';
  }
  // A program, not a recording. `.IMS` files are the giveaway: they are iMUSE
  // sound-card drivers — the code a SCUMM game loaded to talk to an AdLib or a
  // Roland — and they are full of chunk tags like `MDhd`, `MTrk` and `ROL `,
  // because recognising those is exactly what the driver does. Scanning such a
  // file for music finds the driver's own lookup table and reports a piece of
  // music that is not there, so executables are ruled out before any of that.
  if (head.startsWith('MZ')) return 'executable';
  if (head === '\x7fELF') return 'executable';

  if (head === 'OggS') return 'ogg';
  if (head === 'fLaC') return 'flac';
  if (head === 'FORM') {
    const form = tag(bytes, 8);
    if (form === 'AIFF' || form === 'AIFC') return 'aiff';
    // Simon 2's music. An IFF container like AIFF, holding XMIDI rather than
    // samples, which is why it is asked about here rather than beside the
    // other music formats below.
    if (looksLikeXmidi(bytes)) return 'agos-music';
    return 'unknown';
  }
  if (head === 'MThd') return 'midi';
  // AGOS's own two: Adventure Soft's GMF, and the count-byte-then-`MThd`
  // bundle the Windows releases replaced it with. Asked through the readers'
  // own predicates rather than by re-typing their magic numbers here, so there
  // is one description of each format rather than two that can disagree.
  if (looksLikeGmf(bytes) || looksLikeMidiBundle(bytes)) return 'agos-music';
  if (head === 'iMUS' || head === 'COMP' || head === 'MCMP') return 'imuse';
  if (head === 'ANIM' || head === 'AHDR') return 'smush';
  if (ascii(bytes, 0, 19) === 'Creative Voice File') return 'voc';

  // ID3v2-tagged MP3.
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3';

  // ISO base media (m4a/aac): a `ftyp` box at offset 4.
  if (tag(bytes, 4) === 'ftyp') return 'mp4';

  // SCUMM's own sound resources. Either the outer `SOU ` wrapper or one of the
  // per-sound-card variants on its own, depending on how it was extracted.
  if (
    head === 'SOU ' ||
    head === 'SOUN' ||
    head === 'SBL ' ||
    head === 'ADL ' ||
    head === 'ROL ' ||
    head === 'SPK ' ||
    head === 'SO  ' ||
    head === 'os  '
  ) {
    return classifyScummSound(bytes, head);
  }

  // Roland MT-32 control and PCM ROMs. There is no magic number, so this goes
  // on the name Roland put in the control ROM's own display strings — which
  // sits several kilobytes in, alongside the front panel's "Welcome!" and its
  // test-mode messages, not in a header. The window is wide enough to reach it
  // and bounded so importing a hundred-megabyte recording does not scan the
  // whole thing to answer a question the first bytes already settled.
  const opening = ascii(bytes, 0, Math.min(MT32_SCAN_BYTES, bytes.length));
  if (/(ROLAND|MT-32|MT32|CM-32L)/.test(opening.toUpperCase())) return 'mt32-rom';

  // A bare MPEG audio frame: 11 sync bits, and a version and layer that are
  // not the reserved values. Checked last because it is only two bytes and
  // would otherwise shadow formats with real magic numbers.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const version = (bytes[1] >> 3) & 0x03;
    const layer = (bytes[1] >> 1) & 0x03;
    if (version !== 1 && layer !== 0) return 'mp3';
  }

  return 'unknown';
}

/**
 * Tells a SCUMM sound resource's two halves apart.
 *
 * A `SOU ` resource is a bag of the same music rendered for each sound card
 * the game supported, and only the `SBL ` variant holds digitised samples.
 * Which ones are present varies per sound: effects usually have `SBL `, music
 * usually does not. Reading the tag alone therefore says nothing about whether
 * there is anything to hear, and calling every resource playable is what put
 * an enabled play button on tracks that can only ever be silent.
 */
function classifyScummSound(bytes: Uint8Array, head: string): AudioFormat {
  if (head === 'SBL ') return 'scumm-sound';
  if (head === 'ADL ') return 'scumm-music';

  try {
    const root = readChunkHeader(bytes, 0);
    const end = Math.min(bytes.length, root.dataOffset + Math.max(0, root.dataSize));

    if (findChunkDeep(bytes, root.dataOffset, 'SBL ', end, 3)) return 'scumm-sound';

    for (const tag of ['ADL ', 'GMD ', 'MIDI']) {
      if (findChunkDeep(bytes, root.dataOffset, tag, end, 3)) return 'scumm-music';
    }
  } catch {
    // Not a chunk tree, or a truncated one. That is not an answer yet.
  }

  // No AdLib block that the chunk tree admits to. That is not the same as no
  // music: extraction tools slice these resources at points the tree cannot be
  // walked from, so the last word belongs to the same search the renderer
  // uses. Classifying by a stricter rule than the one that actually plays the
  // file is how a playable score ends up labelled unplayable.
  return findMidiData(bytes) ? 'scumm-other' : 'scumm-silent';
}

/**
 * What a file is, using its name only where its contents say nothing.
 *
 * Extensions are not evidence and are never allowed to overrule the bytes.
 * But some files genuinely have no signature to read: an MT-32 PCM ROM is half
 * a megabyte of raw samples with no header, no strings and no structure, and
 * there is nothing in it to recognise. For those, and only after the bytes
 * have been given their chance, the name is better than nothing — and saying
 * "this looks like a synthesiser ROM" is far more use than "unrecognised".
 */
export function classifyImport(bytes: Uint8Array, filename: string): AudioFormat {
  const detected = detectAudioFormat(bytes);
  if (detected !== 'unknown') return detected;

  const extension = /\.([^.]+)$/.exec(filename)?.[1]?.toLowerCase();
  if (extension === 'rom') return 'mt32-rom';
  if (extension === 'exe' || extension === 'com' || extension === 'drv') return 'executable';

  return 'unknown';
}

/** Wraps imported bytes as a project track. */
export function storeAudio(
  id: number,
  filename: string,
  bytes: Uint8Array,
  name = filename.replace(/\.[^.]+$/, ''),
): ProjectAudio {
  return {
    id,
    name: name || filename,
    format: classifyImport(bytes, filename),
    filename,
    bytes: bytes.length,
    data: toBase64(bytes),
  };
}

/**
 * A track whose bytes live in the editor's audio store.
 *
 * Carries everything the library needs to list and label it — name, format,
 * size — so a project with two hundred megabytes of music is still a small
 * document that can be autosaved on every keystroke.
 */
export function referenceAudio(
  id: number,
  filename: string,
  bytes: Uint8Array,
  storeKey: string,
  name = filename.replace(/\.[^.]+$/, ''),
): ProjectAudio {
  return {
    id,
    name: name || filename,
    format: classifyImport(bytes, filename),
    filename,
    bytes: bytes.length,
    storeKey,
  };
}

/**
 * The bytes of a track held inside the project.
 *
 * Throws for a track whose audio is external, because there is nothing here to
 * return and silently handing back an empty buffer would play as silence.
 */
export function loadAudio(track: ProjectAudio): Uint8Array {
  if (!track.data) {
    throw new Error(`Audio for "${track.name}" is stored outside the project`);
  }
  return fromBase64(track.data);
}

/** Bytes a track occupies, without needing to load external audio to find out. */
export function audioByteLength(track: ProjectAudio): number {
  if (typeof track.bytes === 'number') return track.bytes;
  if (!track.data) return 0;
  const padding = track.data.endsWith('==') ? 2 : track.data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((track.data.length * 3) / 4) - padding);
}
