import {
  audioByteLength,
  describeFormat,
  isPlayableFormat,
  whyUnplayable,
  type ProjectAudio,
} from '../authoring/audio.js';
import { decodeAudioBytes } from '../engine/sound/SoundEngine.js';
import { readAgosMusic } from '../engine/agos/sound/music.js';
import { renderMidiToOpl2 } from '../engine/sound/renderMusic.js';
import { missingBytesReason, readTrackBytes } from './audioBytes.js';

/**
 * Auditioning audio inside the editor.
 *
 * Separate from the engine's `SoundEngine` on purpose: that one exists to
 * serve scripts during play and is tied to a running game, whereas this exists
 * so an author can click a track and hear it while nothing is playing. They
 * share the decoder and nothing else.
 *
 * One track at a time. An author clicking down a list wants to compare tracks,
 * and overlapping them makes that impossible.
 */
export class AudioLibrary {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private playingId: number | null = null;
  /**
   * A track being decoded right now.
   *
   * Synthesised music is not decoded so much as performed: a couple of minutes
   * of it takes a couple of seconds to render. Without somewhere to say so, a
   * click on such a track looks like a button that does nothing until the
   * sound abruptly starts.
   */
  private preparingId: number | null = null;

  private readonly buffers = new Map<string, AudioBuffer | null>();
  private readonly listeners = new Set<() => void>();

  /**
   * Why a given track would not play, keyed by track id.
   *
   * Per track rather than one shared message, because a failure reported at
   * the bottom of the panel is a failure the author has to guess the owner of
   * — and a silent play button with an explanation somewhere else is barely
   * better than a silent play button.
   */
  private readonly failures = new Map<number, string>();

  failureFor(id: number): string | null {
    return this.failures.get(id) ?? null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get playing(): number | null {
    return this.playingId;
  }

  get preparing(): number | null {
    return this.preparingId;
  }

  /**
   * What the decoder made of each track: how long it turned out to be.
   *
   * Shown beside the track, because a duration is the one fact that separates
   * "this played and you heard it" from "this played and something else is
   * wrong" — and a track that decodes to two seconds when it should be four
   * minutes is a different problem from one that decodes to nothing.
   */
  private readonly durations = new Map<number, number>();

  durationOf(id: number): number | null {
    return this.durations.get(id) ?? null;
  }

  /**
   * Plays a track, stopping whatever was playing.
   *
   * Clicking the track that is already playing stops it, because that is what
   * a single play button in a list is expected to do.
   */
  async play(track: ProjectAudio): Promise<void> {
    if (this.playingId === track.id) {
      this.stop();
      return;
    }
    this.stop();
    this.failures.delete(track.id);

    const reason = whyUnplayable(track.format);
    if (reason) return this.fail(track, reason);

    const context = this.ensureContext();
    if (!context) return this.fail(track, 'This browser has no Web Audio support.');

    if (context.state === 'suspended') await context.resume();

    this.preparingId = track.id;
    this.notify();

    let buffer: AudioBuffer | null;
    try {
      const bytes = await readTrackBytes(track);
      if (!bytes) return this.fail(track, missingBytesReason(track));
      buffer = await this.decode(track, context, bytes);
    } finally {
      this.preparingId = null;
    }

    if (!buffer) {
      return this.fail(
        track,
        track.format === 'unknown'
          ? 'Not in a format this browser can decode.'
          : `Could not be decoded as ${describeFormat(track.format)}.`,
      );
    }

    if (buffer.length === 0) {
      // A zero-length buffer starts and ends in the same instant, which looks
      // exactly like a play button that does nothing.
      return this.fail(track, 'Decoded to no audio at all — the file may be truncated.');
    }

    // Checked again here, not only before the decode. Decoding a few minutes
    // of music takes a second or more, and a context can be suspended in that
    // time — by the tab being hidden, or by the browser deciding the gesture
    // that allowed it has expired. Starting a source into a suspended context
    // throws nothing and plays nothing, which is exactly the failure that
    // looks like a button doing nothing at all.
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        // Reported below, from the state rather than from the exception.
      }
    }
    if (context.state !== 'running') {
      return this.fail(
        track,
        'The browser is not letting this page play audio. Click the page and try again.',
      );
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      // Only clear if this source is still the current one: a track stopped in
      // order to start another must not clear the new one's state.
      if (this.source === source) {
        this.source = null;
        this.playingId = null;
        this.notify();
      }
    };
    source.start();
    this.durations.set(track.id, buffer.duration);
    this.source = source;
    this.playingId = track.id;
    this.notify();
  }

  private fail(track: ProjectAudio, reason: string): void {
    this.preparingId = null;
    this.failures.set(track.id, reason);
    this.notify();
  }

  stop(): void {
    if (this.source) {
      const source = this.source;
      this.source = null;
      try {
        source.stop();
      } catch {
        // Already ended; nothing to do.
      }
    }
    if (this.playingId !== null) {
      this.playingId = null;
      this.notify();
    }
  }

  /** Forgets a track's decoded audio, for when it is deleted or replaced. */
  forget(track: ProjectAudio): void {
    this.buffers.delete(cacheKey(track));
    this.failures.delete(track.id);
    if (this.playingId === track.id) this.stop();
  }

  private async decode(
    track: ProjectAudio,
    context: AudioContext,
    bytes: Uint8Array,
  ): Promise<AudioBuffer | null> {
    const key = cacheKey(track);
    const cached = this.buffers.get(key);
    if (cached !== undefined) {
      // Refresh its place in the insertion order, so the cache keeps what is
      // actually being listened to rather than what happened to arrive last.
      this.buffers.delete(key);
      this.buffers.set(key, cached);
      return cached;
    }

    const buffer =
      track.format === 'agos-music'
        ? renderAgosMusic(context, bytes)
        : await decodeAudioBytes(context, bytes);
    this.buffers.set(key, buffer);

    // Two minutes of rendered music is tens of megabytes, so unlike images
    // these cannot all be kept. Only one plays at a time, and an author
    // comparing tracks moves between a few, so a few is what is worth holding.
    while (this.buffers.size > AudioLibrary.CACHE_LIMIT) {
      const oldest = this.buffers.keys().next().value;
      if (oldest === undefined) break;
      this.buffers.delete(oldest);
    }

    return buffer;
  }

  /** Decoded tracks kept at once. */
  private static readonly CACHE_LIMIT = 4;

  private ensureContext(): AudioContext | null {
    if (this.context) return this.context;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.context = new Ctor();
    return this.context;
  }
}

/**
 * Keyed on the bytes, not the id.
 *
 * Re-importing over the same id has to produce the new sound, and an id alone
 * would serve the old one from the cache for the rest of the session.
 */
function cacheKey(track: ProjectAudio): string {
  if (track.storeKey) return `store:${track.storeKey}`;
  // A game's own recording has no bytes here to key on, so the address is the
  // key: two entries with the same kind, bank and number *are* the same
  // recording, and re-opening a different folder makes a new reader rather
  // than new entries — which is why the folder is not part of this.
  const resource = track.resource;
  if (resource) {
    return `agos:${resource.kind}:${resource.bank ?? ''}:${resource.number}`;
  }
  const data = track.data ?? '';
  return `${track.id}:${data.length}:${data.slice(0, 32)}`;
}

/**
 * Performs a piece of AGOS music, rather than decoding it.
 *
 * The same route the running Engine takes (`AgosSound.renderMusic`): these are
 * scores, so there is nothing for the browser's decoder to decode, and playing
 * them means rendering the events on an emulated OPL2. Synchronous and slow
 * enough to be worth the row saying "Rendering…" while it happens — a couple
 * of minutes of music takes a couple of seconds.
 */
function renderAgosMusic(context: BaseAudioContext, bytes: Uint8Array): AudioBuffer | null {
  const music = readAgosMusic(bytes);
  if (music.events.length === 0) return null;
  const rendered = renderMidiToOpl2(music, context.sampleRate);
  const buffer = context.createBuffer(1, rendered.samples.length, context.sampleRate);
  buffer.getChannelData(0).set(rendered.samples);
  return buffer;
}

/** "MP3 · 412 KB", the one-line summary shown under a track's name. */
export function describeTrack(track: ProjectAudio): string {
  const size = audioByteLength(track);
  const readable =
    size >= 1024 * 1024
      ? `${(size / (1024 * 1024)).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  const suffix = isPlayableFormat(track.format) ? '' : ' · silent';
  return `${describeFormat(track.format)} · ${readable}${suffix}`;
}
