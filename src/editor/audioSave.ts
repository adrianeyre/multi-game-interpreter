import type { AudioFormat, ProjectAudio } from '../authoring/audio.js';

/**
 * What a saved track should be called, and what it should be labelled as.
 *
 * Two small rules kept away from the section that draws the rows, because the
 * name a file gets is a decision and not a detail: get it wrong and an author
 * ends up with a folder of `download.bin`, or with a VOC named `.wav` that
 * nothing will open.
 */

/**
 * The extension that matches what the bytes actually are.
 *
 * Off the sniffed format rather than off the imported filename, because the
 * sniffed format is the one that was checked. A file that arrived called
 * `theme.wav` and turned out to be an MP3 is saved as an MP3, and a game's own
 * recording — which never had a filename of its own — gets one that says what
 * it is.
 */
function extensionFor(format: AudioFormat): string {
  switch (format) {
    case 'wav':
      return '.wav';
    case 'mp3':
      return '.mp3';
    case 'ogg':
      return '.ogg';
    case 'flac':
      return '.flac';
    case 'aiff':
      return '.aiff';
    case 'mp4':
      return '.m4a';
    case 'voc':
      return '.voc';
    case 'midi':
      return '.mid';
    // The three AGOS music shapes and every SCUMM resource are containers no
    // other program reads, so there is no extension that would make one open.
    // `.bin` is honest about that, where `.mid` on a GMF would not be.
    default:
      return '.bin';
  }
}

/**
 * A filename made from the track's own name.
 *
 * The name is what the author is looking at — "Speech 1204", or whatever they
 * renamed an import to — so it is what the file should be called. Reduced to
 * characters every filesystem accepts, since a name is free text and Windows
 * refuses half of it.
 */
export function audioFileName(track: ProjectAudio): string {
  const base = track.name
    .trim()
    .replace(/[^A-Za-z0-9 ._-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 64);
  return `${base.length > 0 ? base : `audio-${track.id}`}${extensionFor(track.format)}`;
}

/**
 * The type to hand the browser, for the formats browsers have a name for.
 *
 * `application/octet-stream` for the rest, which is what a download of bytes
 * no browser plays should say it is — and which stops one from opening a VOC
 * in a tab instead of saving it.
 */
export function audioMimeType(format: AudioFormat): string {
  switch (format) {
    case 'wav':
      return 'audio/wav';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
      return 'audio/ogg';
    case 'flac':
      return 'audio/flac';
    case 'aiff':
      return 'audio/aiff';
    case 'mp4':
      return 'audio/mp4';
    case 'midi':
      return 'audio/midi';
    default:
      return 'application/octet-stream';
  }
}
