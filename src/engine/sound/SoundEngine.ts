import { detectAudioFormat, isPlayableFormat, loadAudio } from '../../authoring/audio.js';
import type { ProjectAudio } from '../../authoring/audio.js';
import { findChunkDeep, readChunkHeader } from '../resource/Chunk.js';
import { renderScummMusic, secondsToTicks } from './renderMusic.js';
import { readScummMusic, readScummScore } from './scummAdl.js';
import { ImuseCommands } from './imuse.js';
import { ImusePlayer, readStartParameters, type SavedImusePlayer } from './ImusePlayer.js';
import { GlobalInstruments } from './imuseInstruments.js';
import { ImuseMixer } from './imuseMixer.js';
import type { SavedImuseCommands } from './imuse.js';
import { LiveMusicStream } from './liveMusic.js';
import { OPL2_RATE } from './opl2/Opl2.js';
import { findOldBundleSpeaker, findSpeakerBlock, SpeakerSequence } from './pcSpeaker.js';
import type { MidiFile } from './midi.js';
import { findSoundBlock } from './soundChunks.js';
import { DigitalImuse, type DigitalAudio } from './v7/digitalImuse';
import { MusicSequencer, type MusicSource } from './MusicSequencer.js';
import {
  BUNDLE_HEADER_BYTES,
  decompressSample,
  readBundle,
  readBundleFromParts,
  readBundleHeader,
  readSample,
  type Bundle,
} from './v7/bundle.js';
import { type DataSource } from '../resource/DataSource.js';
import { SourceVolumeReader } from '../resource/VolumeReader.js';
import type { ResourceManager } from '../resource/ResourceManager.js';
import { readTag, readU32BE } from '../util/ByteStream.js';
import { readSpeechSample, type SpeechSample } from './speech.js';

/**
 * Audio playback.
 *
 * SCUMM v5 ships each sound in several formats and the interpreter picks one
 * per sound card: `SBL ` holds digitised audio (a VOC stream), while `ADL`,
 * `ROL` and `SPK` hold sequenced music for AdLib, Roland MT-32 and the PC
 * speaker.
 *
 * Digitised sound is decoded and played through Web Audio. Music is sequenced
 * live (`ImusePlayer`) and streamed: an `ADL ` score through an emulated OPL2,
 * the chip it was written for; a Roland or General MIDI score through the same
 * OPL2 with a General MIDI bank, since no MT-32 is emulated; and a speaker
 * score — v5's `SPK `, or a v3/v4 `WA` block — through an emulated PC speaker.
 *
 * A resource with nothing playable in it is still tracked as playing for a
 * short while, so that scripts polling `isSoundRunning` see a plausible
 * answer. That matters: reporting a sound as playing for ever deadlocks any
 * script waiting for it to end — a logo or intro screen that never advances —
 * and reporting it finished immediately makes scripted timing collapse.
 */
/** Reads a slice of a bundle on demand, so its bytes are never held whole. */
export type BundleReader = (start: number, end: number) => Promise<Uint8Array | null>;

/** v7 bundle audio is 22050 Hz, as the format fixes it. */
const BUNDLE_SPEECH_RATE = 22050;

/** The iMUSE part of a save. */
export interface SavedImuse {
  players: SavedImusePlayer[];
  commands: SavedImuseCommands;
  globals: (number[] | null)[];
}

export class SoundEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  private readonly playing = new Map<number, AudioBufferSourceNode>();
  /**
   * Music resources we acknowledge but do not synthesise, and the frames left
   * before each is reported as finished.
   */
  private readonly pendingMusic = new Map<number, number>();

  /** Frames a piece of unsynthesised music counts as playing: about 2 seconds. */
  private static readonly PENDING_MUSIC_FRAMES = 120;
  private readonly decoded = new Map<number, AudioBuffer | null>();

  /**
   * Audio supplied by the project rather than found in the game container.
   *
   * Imported tracks are ordinary numbered sounds to every script, so they live
   * beside container sounds and take precedence: a project that imports a
   * track as sound 3 means that one, not whatever sound 3 was in the data it
   * was decompiled from.
   */
  private readonly registered = new Map<number, Uint8Array>();

  private resources: ResourceManager | null = null;
  private enabled = true;
  private volume = 0.7;

  /** Sounds whose format we could not decode, reported once each. */
  readonly unsupported = new Set<number>();

  attach(resources: ResourceManager): void {
    this.resources = resources;
  }

  /**
   * Takes the project's audio library.
   *
   * Decoding happens here rather than on first play because
   * `decodeAudioData` is asynchronous and `startSound` is not: a script that
   * starts a sound expects it to start, and awaiting a decoder inside an
   * opcode would either stall the interpreter or drop the sound entirely.
   * Doing the work up front costs a moment at load and makes playback exact.
   *
   * Must be called from a user gesture, because `resume` is.
   */
  async load(
    tracks: readonly ProjectAudio[],
    read: (track: ProjectAudio) => Promise<Uint8Array | null> = async (track) => loadAudio(track),
  ): Promise<void> {
    for (const track of tracks) {
      if (!isPlayableFormat(track.format)) continue;

      let bytes: Uint8Array | null = null;
      try {
        bytes = await read(track);
      } catch {
        // A track whose audio cannot be found is one silent sound, not a
        // reason to abandon the rest of the game's audio.
      }
      if (!bytes) continue;

      this.registered.set(track.id, bytes);
      // Drop any cached failure from before this track existed.
      this.decoded.delete(track.id);
      this.unsupported.delete(track.id);
    }
    if (this.registered.size > 0) await this.decodeRegistered();
  }

  private async decodeRegistered(): Promise<void> {
    await this.resume();
    if (!this.context) return;

    for (const [id, bytes] of this.registered) {
      if (this.decoded.has(id)) continue;
      const buffer = await decodeAudioBytes(this.context, bytes);
      if (!buffer) this.unsupported.add(id);
      this.decoded.set(id, buffer);
    }
  }

  /**
   * Creates the audio context.
   *
   * Must be called from a user gesture: browsers refuse to start audio
   * otherwise, and a suspended context silently drops everything.
   */
  async resume(): Promise<void> {
    if (!this.context) {
      // No `window` at all outside a browser — the diagnostic runner and the
      // tests both get here — and reaching through it would throw rather than
      // report "no audio".
      if (typeof window === 'undefined') return;
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = this.volume;
      this.masterGain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();

    // Whatever was asked for before a context existed. A browser will not
    // start audio outside a user gesture, and a game starts its title music
    // before the player has clicked anything — so the request arrived, found
    // no context, and was dropped. Atlantis's title sequence was silent for
    // exactly that reason, and stayed silent afterwards because the script had
    // already moved on and would not ask again.
    //
    // Only a score is picked back up. A sound effect from before the first
    // click belongs to a moment that has passed, and replaying it here would
    // fire it at the wrong one.
    const deferred = [...this.deferredMusic];
    this.deferredMusic.clear();
    for (const id of deferred) {
      if (this.scoreless.has(id)) continue;
      this.startSound(id);
    }
  }

  /** Sounds asked for while there was no audio context to play them on. */
  private readonly deferredMusic = new Set<number>();

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.stopAll();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.masterGain) this.masterGain.gain.value = this.volume;
  }

  /**
   * The talkie release's speech file, once it has been read.
   *
   * Held whole rather than indexed: a script asks for a byte offset into it, so
   * there is nothing to build an index of.
   */
  private speechFile: Uint8Array | null = null;

  attachSpeech(bytes: Uint8Array | null): void {
    this.speechFile = bytes;
  }

  /**
   * The v7 speech bundle and the bytes it was read from.
   *
   * Kept together because a bundle's directory holds offsets into its own file:
   * separating them is how you end up reading one release's table against
   * another's bytes.
   */
  private speechBundle: { bundle: Bundle; bytes: Uint8Array; read?: BundleReader } | null = null;

  /**
   * Attaches a v7 `.BUN` speech bundle.
   *
   * The successor to `MONSTER.SOU` and read the same way — asked for by name,
   * with nothing to enumerate at play time. Returns false when the file is not
   * a bundle, so the caller can say which file was wrong rather than leaving a
   * game silently mute.
   */
  attachSpeechBundle(bytes: Uint8Array, source: string): boolean {
    const bundle = readBundle(bytes, source);
    if (!bundle) return false;
    this.speechBundle = { bundle, bytes };
    return true;
  }

  /**
   * Plays one line of v7 speech by the name its script gives, and says how long
   * it runs.
   *
   * The duration is the point as much as the sound is, exactly as for a Talkie:
   * a script that waits on speech needs it, and a player with audio off still
   * needs the line to stay up for the right length of time. So the sample is
   * decompressed even when it will not be played.
   *
   * Returns null for a name the bundle does not hold or a codec this cannot
   * decode, and names the codec in the log — audio decoded with the wrong one
   * is noise at the right length, which passes every check except listening.
   */
  startBundleSpeech(name: string): { duration: number } | null {
    if (!this.speechBundle) return null;

    const { bundle } = this.speechBundle;
    const bytes = this.bundleBytesFor(this.speechBundle, name);
    if (!bytes) return null;

    const sample = readSample(bundle, bytes, name);
    if (!sample) return null;

    const { data, unsupportedCodec } = decompressSample(sample, bytes);
    if (unsupportedCodec !== null) {
      this.reportBundleCodec(unsupportedCodec, name);
      return null;
    }
    if (data.length === 0) return null;

    // Sixteen-bit signed, which is what the bundles carry. The length is known
    // before anything is played, so a wait can be right even with sound off.
    const frames = data.length >> 1;
    const duration = frames / BUNDLE_SPEECH_RATE;

    if (this.enabled && this.context && this.masterGain) {
      const buffer = this.context.createBuffer(1, frames, BUNDLE_SPEECH_RATE);
      const channel = buffer.getChannelData(0);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, false) / 32768;

      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.masterGain);
      this.speechSource?.stop();
      this.speechSource = source;
      source.onended = () => {
        if (this.speechSource === source) this.speechSource = null;
      };
      source.start();
    }

    return { duration };
  }

  /**
   * The v7 music bundle, which the sequencer plays states out of.
   *
   * The other half of ADR 0008's seam: v6 feeds the sequencer rendered OPL2
   * buffers and v7 feeds it decoded bundle streams, and the transition logic
   * above does not know which. Separate from the speech bundle because they are
   * separate files with separate directories — sharing one would mean reading
   * one release's table against another's bytes.
   */
  private musicBundle: { bundle: Bundle; bytes: Uint8Array; read?: BundleReader } | null = null;

  /**
   * Opens a bundle without reading it, where the source can range-read.
   *
   * Twelve bytes of header names where the directory is and how big it is, so a
   * bundle is opened in two range reads of a few kilobytes rather than by
   * loading several hundred megabytes (#114). The bytes of a *sample* are read
   * on demand, from the same source, when a script asks for one.
   *
   * A source with no range support falls back to reading whole, which is what
   * every v5 and v6 path already did.
   */
  static async openBundle(
    source: DataSource,
    name: string,
  ): Promise<{ bundle: Bundle; read: BundleReader } | null> {
    // Through ADR 0021's seam rather than around it: a `.BUN` is exactly the
    // offset-addressed bulk file `VolumeReader` names, and routing it here
    // means the browser gets `File.slice` and the tools get a file handle
    // without either of them being mentioned in this function.
    const volumes = new SourceVolumeReader(source);

    const header = await volumes.read(name, 0, BUNDLE_HEADER_BYTES);
    if (header.length === 0) return null;

    const parsed = readBundleHeader(header);
    if (!parsed) return null;

    const directory = await volumes.read(name, parsed.dirOffset, parsed.dirBytes);
    if (directory.length === 0) return null;

    const bundle = readBundleFromParts(header, directory, name);
    if (!bundle) return null;

    return {
      bundle,
      read: (start, end) => volumes.read(name, start, end - start),
    };
  }

  /**
   * Attaches a bundle opened by directory, with a reader for its samples.
   *
   * The bytes stay on disk. A sample is fetched when a script asks for it, from
   * the range the directory names — which is the whole of #114's saving for
   * these files, and why the reader is kept rather than the bytes.
   */
  attachOpenedSpeechBundle(bundle: Bundle, read: BundleReader): boolean {
    this.speechBundle = { bundle, bytes: new Uint8Array(0), read };
    return true;
  }

  attachOpenedMusicBundle(bundle: Bundle, read: BundleReader): boolean {
    this.musicBundle = { bundle, bytes: new Uint8Array(0), read };
    return true;
  }

  /** Attaches a v7 `.BUN` music bundle. False when the file is not one. */
  attachMusicBundle(bytes: Uint8Array, source: string): boolean {
    const bundle = readBundle(bytes, source);
    if (!bundle) return false;
    this.musicBundle = { bundle, bytes };
    return true;
  }

  /**
   * Decodes a bundle music cue into a buffer the sequencer can play.
   *
   * Cached, because a musical state is entered and left repeatedly — The Dig's
   * score returns to the same states as the player moves — and decoding a
   * minute of audio on every transition would be heard as a stall.
   */
  private readonly decodedMusic = new Map<string, AudioBuffer | null>();

  /**
   * Sample bytes fetched from a lazily-opened bundle, by cue name.
   *
   * A bundle opened by its directory keeps a reader rather than its bytes
   * (#114), so a sample has to be *fetched* before it can be decoded — and
   * fetching is asynchronous while both callers here are not: a script asks for
   * a musical state or a line of speech from inside an instruction.
   *
   * So the first request for a cue starts the fetch and reports nothing, and
   * every request after it is served from here. A musical state is entered
   * repeatedly, so that costs one seam. A line of speech gets its text-length
   * timing on the first play, which is what a release with no recordings does
   * — correct behaviour for a line with no audio rather than a wrong one.
   */
  private readonly fetchedSamples = new Map<string, Uint8Array | null>();
  private readonly fetching = new Set<string>();

  /**
   * The bytes a cue's sample needs, or null while they are still being fetched.
   *
   * `bytes` is empty when a bundle was opened by directory, which is what makes
   * the reader the only way in. Before #148 there was no reader and the bytes
   * were the whole file; between #148 and this, the reader was stored and never
   * called — so every lookup read an empty buffer, found nothing, and returned
   * silence with nothing said about it.
   */
  private bundleBytesFor(
    holder: { bundle: Bundle; bytes: Uint8Array; read?: BundleReader },
    name: string,
  ): Uint8Array | null {
    if (holder.bytes.length > 0) return holder.bytes;
    if (!holder.read) return null;

    const key = name.toUpperCase();
    const cached = this.fetchedSamples.get(key);
    if (cached !== undefined) return cached;
    if (this.fetching.has(key)) return null;

    // Uppercase, as the directory keys are and as `readSample` looks them up.
    // Matching case-sensitively here would miss every cue while `readSample`
    // found them, which reads as a bundle that has the sample and cannot
    // fetch it.
    const entry = holder.bundle.entries.get(name.toUpperCase());
    if (!entry) {
      this.fetchedSamples.set(key, null);
      return null;
    }

    this.fetching.add(key);
    void holder
      .read(entry.offset, entry.offset + entry.size)
      .then((bytes) => {
        // Held at the offset the directory names, so the same reader that
        // decodes a whole bundle can decode this without knowing the
        // difference: a sample's own header offsets are relative to it.
        if (!bytes) {
          this.fetchedSamples.set(key, null);
          return;
        }
        const framed = new Uint8Array(entry.offset + bytes.length);
        framed.set(bytes, entry.offset);
        this.fetchedSamples.set(key, framed);
      })
      .catch(() => this.fetchedSamples.set(key, null))
      .finally(() => this.fetching.delete(key));

    this.reportLateBundle(name);
    return null;
  }

  private reportedLateBundle = false;

  private reportLateBundle(name: string): void {
    if (this.reportedLateBundle) return;
    this.reportedLateBundle = true;
    this.onLog?.(
      `The audio bundles are read a sample at a time rather than held whole, so ` +
        `"${name}" and every other cue is fetched on first use and heard from the ` +
        `second. A musical state costs one seam; a line of speech is timed by its ` +
        `text the first time it plays.`,
    );
  }

  private bundleMusicBuffer(name: string): AudioBuffer | null {
    const cached = this.decodedMusic.get(name);
    if (cached !== undefined) return cached;

    let buffer: AudioBuffer | null = null;
    const bytes = this.musicBundle ? this.bundleBytesFor(this.musicBundle, name) : null;
    if (this.musicBundle && this.context && bytes) {
      const { bundle } = this.musicBundle;
      const sample = readSample(bundle, bytes, name);
      if (sample) {
        const { data, unsupportedCodec } = decompressSample(sample, bytes);
        if (unsupportedCodec !== null) {
          this.reportBundleCodec(unsupportedCodec, name);
        } else if (data.length > 1) {
          const frames = data.length >> 1;
          buffer = this.context.createBuffer(1, frames, BUNDLE_SPEECH_RATE);
          const channel = buffer.getChannelData(0);
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          for (let i = 0; i < frames; i++) channel[i] = view.getInt16(i * 2, false) / 32768;
        }
      }
    }

    // Only cached once there were bytes to try. Caching a null while the fetch
    // is still in flight would make the cue permanently silent — the second
    // request, the one that would have had its bytes, never gets to look.
    if (bytes) this.decodedMusic.set(name, buffer);
    return buffer;
  }

  /**
   * The name a v7 music cue is addressed by, from the index's `ANAM` table.
   *
   * A v7 script names music by number, and the index maps those numbers to
   * bundle entry names — which is what `ANAM` is for, and why reading it at
   * #97 mattered before there was anything to play.
   */
  private bundleCueName(id: number): string | null {
    const names = this.resources?.audioNames;
    if (!names || id < 0 || id >= names.length) return null;
    return names[id];
  }

  /** Said once per codec: a game asks for many lines encoded the same way. */
  private readonly reportedBundleCodecs = new Set<number>();

  private reportBundleCodec(codec: number, name: string): void {
    if (this.reportedBundleCodecs.has(codec)) return;
    this.reportedBundleCodecs.add(codec);
    this.onLog?.(
      `Bundle codec ${codec} is not implemented, so "${name}" and anything else ` +
        `encoded with it will have no audio. Its subtitles and timing are unaffected.`,
    );
  }

  get hasSpeech(): boolean {
    return this.speechFile !== null;
  }

  /**
   * Plays one line of recorded speech and says how long it runs.
   *
   * The duration is the point as much as the sound is: a script that waits for
   * speech needs it, and a player with audio disabled still needs the line to
   * stay up for the right length of time. So the sample is read even when it
   * will not be played.
   */
  startSpeech(offset: number, vctlSize: number): SpeechSample | null {
    if (!this.speechFile) return null;

    const sample = readSpeechSample(this.speechFile, offset, vctlSize);
    if (!sample) return null;

    if (this.enabled && this.context && this.masterGain) {
      const buffer = this.context.createBuffer(1, sample.pcm.samples.length, sample.pcm.sampleRate);
      buffer.getChannelData(0).set(sample.pcm.samples);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.masterGain);
      this.speechSource?.stop();
      this.speechSource = source;
      source.onended = () => {
        if (this.speechSource === source) this.speechSource = null;
      };
      source.start();
    }

    return sample;
  }

  /**
   * One `.voc` per line of dialogue, keyed `<room>/<line>`, and how to read one.
   *
   * The Dig's demo keeps its speech this way instead of in a `MONSTER.SOU` or a
   * `.BUN`: a folder per room named `<room name>.<room number>` — or with an
   * underscore, depending on the copy — holding one file per line number. The
   * two numbers come out of the message's control code 10, which every other
   * release uses for a byte offset and a size.
   *
   * The index is paths rather than bytes because the demo's recordings come to
   * 10.4 MB across 225 files, and a game that reads all of them before its logo
   * appears has paid for every line a player will never reach.
   */
  private voiceFiles: Map<string, string> | null = null;
  private readVoiceFile: ((path: string) => Promise<Uint8Array | null>) | null = null;

  attachVoiceFiles(
    files: Map<string, string>,
    read: (path: string) => Promise<Uint8Array | null>,
  ): void {
    this.voiceFiles = files.size > 0 ? files : null;
    this.readVoiceFile = read;
  }

  /** Whether this release keeps its speech as one file per line. */
  hasVoiceFiles(): boolean {
    return this.voiceFiles !== null;
  }

  /**
   * Plays one line held in its own `.voc`, and says how long it runs.
   *
   * Lazy for the reason the bundles are (#114): a script asks for a line from
   * inside an instruction and cannot wait, so the first ask starts the read and
   * reports nothing — the line gets text-length timing, which is what a copy
   * with no recordings does — and every ask after it is served from memory.
   *
   * No mouth-sync cues, because a bare `.voc` carries none: the sync stream is
   * part of `MONSTER.SOU`'s `VCTL` header and there is no such header here. An
   * empty list is honest; a fabricated one animates a mouth against nothing.
   */
  startVoiceFile(room: number, line: number): SpeechSample | null {
    const files = this.voiceFiles;
    const read = this.readVoiceFile;
    if (!files || !read) return null;

    const key = `${room}/${line}`;
    const path = files.get(key);
    if (!path) return null;

    const cached = this.fetchedVoice.get(key);
    if (cached === undefined) {
      if (!this.fetchingVoice.has(key)) {
        this.fetchingVoice.add(key);
        void read(path)
          .then((bytes) => this.fetchedVoice.set(key, bytes ? decodeVoc(bytes) : null))
          .catch(() => this.fetchedVoice.set(key, null))
          .finally(() => this.fetchingVoice.delete(key));
        this.reportLateVoice(path);
      }
      return null;
    }
    if (!cached || cached.samples.length === 0) return null;

    const sample: SpeechSample = {
      pcm: cached,
      syncTimes: [],
      duration: cached.samples.length / cached.sampleRate,
    };

    if (this.enabled && this.context && this.masterGain) {
      const buffer = this.context.createBuffer(1, cached.samples.length, cached.sampleRate);
      buffer.getChannelData(0).set(cached.samples);
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.masterGain);
      this.speechSource?.stop();
      this.speechSource = source;
      source.onended = () => {
        if (this.speechSource === source) this.speechSource = null;
      };
      source.start();
    }

    return sample;
  }

  private readonly fetchedVoice = new Map<string, DecodedPcm | null>();
  private readonly fetchingVoice = new Set<string>();
  private reportedLateVoice = false;

  private reportLateVoice(path: string): void {
    if (this.reportedLateVoice) return;
    this.reportedLateVoice = true;
    this.onLog?.(
      `This release keeps each line of speech in its own file, and they are read ` +
        `on demand rather than up front — 225 of them come to 10 MB. So "${path}" ` +
        `and every line after it is timed by its text the first time it is spoken ` +
        `and heard from the second.`,
    );
  }

  /**
   * Plays a decoded bundle cue, looping, as a musical state.
   *
   * Looping because a musical *state* lasts as long as the game is in it — the
   * piece is not a track that ends but a situation that holds until a
   * transition. Returns false when there is nothing to play, so the caller can
   * fall through to the rendered path.
   */
  private playBundleMusic(id: number, name: string): boolean {
    const buffer = this.bundleMusicBuffer(name);
    if (!buffer || !this.context || !this.masterGain) return false;

    this.stopSound(id);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    const gain = this.context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.masterGain);

    source.start();
    this.playing.set(id, source);
    this.gains.set(id, gain);
    return true;
  }

  /**
   * When the next block of a video's audio should start.
   *
   * A video hands over its audio in blocks as it decodes them, and each has to
   * begin exactly where the last ended. Scheduling each block at "now" instead
   * would leave a gap the length of a frame between every pair — which is a
   * cutscene that stutters in time with its own frame rate.
   */
  private videoAudioUntil = 0;

  /**
   * Queues one block of a video's audio, interleaved 16-bit stereo.
   *
   * Returns the moment the queue now runs until, which is what a caller
   * checking sync against the audio clock needs.
   */
  playVideoAudio(samples: Int16Array, sampleRate: number): number {
    if (!this.enabled || !this.context || !this.masterGain || samples.length < 2) {
      return this.videoAudioUntil;
    }

    const frames = samples.length >> 1;
    const buffer = this.context.createBuffer(2, frames, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      left[i] = samples[i * 2] / 0x8000;
      right[i] = samples[i * 2 + 1] / 0x8000;
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.masterGain);

    const startAt = Math.max(this.context.currentTime, this.videoAudioUntil);
    source.start(startAt);
    this.videoAudioUntil = startAt + frames / sampleRate;
    this.videoSources.push(source);
    source.onended = () => {
      const at = this.videoSources.indexOf(source);
      if (at >= 0) this.videoSources.splice(at, 1);
    };
    return this.videoAudioUntil;
  }

  private readonly videoSources: AudioBufferSourceNode[] = [];

  /**
   * How long a video's queued audio still has to run, in seconds.
   *
   * Zero when there is none, or when sound is off — a player with audio
   * disabled must not be held on a frame waiting for a queue that will never
   * drain.
   */
  videoAudioRemaining(): number {
    if (!this.context) return 0;
    return Math.max(0, this.videoAudioUntil - this.context.currentTime);
  }

  /** Cuts a video's audio off, for a cutscene that ended early. */
  stopVideoAudio(): void {
    for (const source of this.videoSources.splice(0)) {
      try {
        source.stop();
      } catch {
        // Already ended; stopping twice throws and means nothing.
      }
    }
    this.videoAudioUntil = 0;
  }

  /**
   * Plays a v7 sound effect from the bundles, once.
   *
   * v7 does not route `startSound` at a resource: it hands a number to iMUSE
   * Digital, and the index's `ANAM` table says which bundle cue that number
   * names. So the mapping is a fact about the *index* rather than about the
   * game — which is why this can be written at all without a game to try.
   *
   * Once, not looping: this is `startSfx`, and the looping path above is for a
   * musical *state*, which lasts as long as the game is in it. A sound effect
   * played on a loop is a door that never stops closing.
   *
   * Returns false when nothing was played, so the caller can name the number
   * rather than leave a silent instruction looking like a working one.
   */
  startBundleSound(id: number): boolean {
    const name = this.bundleCueName(id);
    if (!name) return false;

    const buffer = this.bundleMusicBuffer(name);
    // Null while the sample is still being fetched, which is the ordinary case
    // for a cue's first use. Reported as played: the alternative is a caller
    // that names every first use as a missing sound.
    if (!buffer) return true;
    if (!this.context || !this.masterGain) return true;

    this.stopSound(id);
    const source = this.context.createBufferSource();
    source.buffer = buffer;

    const gain = this.context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.masterGain);

    source.onended = () => {
      if (this.playing.get(id) === source) {
        this.playing.delete(id);
        this.gains.delete(id);
      }
    };
    source.start();
    this.playing.set(id, source);
    this.gains.set(id, gain);
    this.startedAt.set(id, this.context.currentTime);
    this.startedFrom.set(id, 0);
    return true;
  }

  /** Cuts speech off, for a line the player skipped. */
  stopSpeech(): void {
    try {
      this.speechSource?.stop();
    } catch {
      // Already ended; stopping twice throws and means nothing.
    }
    this.speechSource = null;
  }

  private speechSource: AudioBufferSourceNode | null = null;

  startSound(id: number): void {
    if (id === 0) return;
    // Sound turned off is a decision, not a delay: nothing is remembered.
    if (!this.enabled) {
      this.pendingMusic.set(id, SoundEngine.PENDING_MUSIC_FRAMES);
      return;
    }
    // No context yet means the player has not clicked, so this cannot be
    // played now. Remembered rather than dropped, and started by `resume`.
    if (!this.context) {
      this.pendingMusic.set(id, SoundEngine.PENDING_MUSIC_FRAMES);
      this.deferredMusic.add(id);
      return;
    }
    if (!this.resources) {
      this.pendingMusic.set(id, SoundEngine.PENDING_MUSIC_FRAMES);
      return;
    }

    // A score is sequenced live rather than rendered, so that the commands a
    // script sends while it plays can change it.
    if (this.startLive(id)) return;

    const buffer = this.getBuffer(id) ?? this.renderMusicBuffer(id);
    if (!buffer) {
      // A format with no decoder: remember it so `isSoundRunning` answers
      // truthfully enough for scripts that poll it.
      this.pendingMusic.set(id, SoundEngine.PENDING_MUSIC_FRAMES);
      return;
    }
    if (this.scores.has(id)) this.playingMusic = id;

    this.stopSound(id);
    if (!this.context || !this.masterGain) return;

    const source = this.context.createBufferSource();
    source.buffer = buffer;

    // Its own gain node between the source and the master. Music has to be able
    // to move independently of everything else for a crossfade to exist at all;
    // connecting straight to the master, as this did, means the only volumes
    // available are "everything" and "off".
    const gain = this.context.createGain();
    gain.gain.value = 1;
    source.connect(gain);
    gain.connect(this.masterGain);

    source.onended = () => {
      if (this.playing.get(id) === source) {
        this.playing.delete(id);
        this.gains.delete(id);
      }
    };
    source.start();
    this.playing.set(id, source);
    this.gains.set(id, gain);
    this.startedAt.set(id, this.context.currentTime);
    this.startedFrom.set(id, 0);
  }

  /**
   * When each sound started, and from what offset within its buffer.
   *
   * This pair is what gives the sequencer a *playing position* — the thing
   * render-up-front could not provide, and the reason jump, hook and queue had
   * to be served by re-rendering a score from a target tick rather than by
   * moving within the audio already playing.
   */
  private readonly startedAt = new Map<number, number>();
  private readonly startedFrom = new Map<number, number>();

  /** Where a playing sound has reached, in seconds, or null if it is not. */
  positionOf(id: number): number | null {
    const live = this.livePlayer(id);
    if (live) return live.playedSeconds;
    const started = this.startedAt.get(id);
    if (started === undefined || !this.context || !this.playing.has(id)) return null;
    return this.context.currentTime - started + (this.startedFrom.get(id) ?? 0);
  }

  /**
   * Moves a playing sound to a position within itself.
   *
   * A real seek: the decoded buffer is kept and a new source node starts at an
   * offset into it. That is what makes this a live sequencer rather than a
   * renderer — a jump costs a node, not a re-render of the whole score, so the
   * commands that need a playing position can be served at the moment they
   * arrive instead of after a pause.
   *
   * Returns false when there is nothing decoded to seek within, so the caller
   * can fall back to rendering from the target.
   */
  seekTo(id: number, seconds: number): boolean {
    const buffer = this.decoded.get(id);
    if (!buffer || !this.context || !this.masterGain) return false;
    if (seconds < 0 || seconds >= buffer.duration) return false;

    const level = this.gains.get(id)?.gain.value ?? 1;
    const looping = this.playing.get(id)?.loop ?? false;
    this.stopSound(id);

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = looping;

    const gain = this.context.createGain();
    gain.gain.value = level;
    source.connect(gain);
    gain.connect(this.masterGain);

    source.onended = () => {
      if (this.playing.get(id) === source) {
        this.playing.delete(id);
        this.gains.delete(id);
      }
    };
    source.start(0, seconds);

    this.playing.set(id, source);
    this.gains.set(id, gain);
    this.startedAt.set(id, this.context.currentTime);
    this.startedFrom.set(id, seconds);
    return true;
  }

  /** Per-sound gain, so the sequencer can fade one piece against another. */
  private readonly gains = new Map<number, GainNode>();

  /**
   * Sets one sound's level, 0..1, independently of the master volume.
   *
   * The `MusicSource` seam (ADR 0008): the sequencer asks for levels and knows
   * nothing about how the sound is produced.
   */
  setSoundLevel(id: number, level: number): void {
    // A live player shares the chip with the others, so its level is set in
    // the chip rather than on a gain node of its own.
    const player = this.livePlayer(id);
    if (player) {
      player.setOutputLevel(level);
      return;
    }
    const gain = this.gains.get(id);
    if (gain) gain.gain.value = Math.max(0, Math.min(1, level));
  }

  /**
   * Ramps one sound's level to a target over `seconds`.
   *
   * iMUSE Digital fades a sound's volume rather than stepping it, because a
   * step in the middle of a held note is audible as a click.
   */
  fadeSoundLevel(id: number, level: number, seconds: number): void {
    const player = this.livePlayer(id);
    if (player) {
      // Sixtieths of a second, which is what iMUSE's own faders count in.
      player.addParameterFader(1, Math.round(level * 127), Math.round(seconds * 60));
      return;
    }
    const gain = this.gains.get(id);
    if (!gain || !this.context) return;

    const target = Math.max(0, Math.min(1, level));
    const now = this.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    if (seconds <= 0) gain.gain.setValueAtTime(target, now);
    else gain.gain.linearRampToValueAtTime(target, now + seconds);
  }

  /**
   * Per-sound pan, inserted only for the sounds that ask to be panned.
   *
   * Spliced in on demand rather than built into every playback path: a panner
   * on each sound would be four more nodes in the graph for a parameter almost
   * nothing sets, and inserting it here means it works whichever path started
   * the sound.
   */
  private readonly panners = new Map<number, StereoPannerNode>();

  private pannerFor(id: number): StereoPannerNode | null {
    const existing = this.panners.get(id);
    if (existing) return existing;

    const gain = this.gains.get(id);
    if (!gain || !this.context || !this.masterGain) return null;
    // Not every implementation has one, and a missing panner should cost the
    // sound its pan rather than its playback.
    if (typeof this.context.createStereoPanner !== 'function') return null;

    const panner = this.context.createStereoPanner();
    gain.disconnect();
    gain.connect(panner);
    panner.connect(this.masterGain);
    this.panners.set(id, panner);
    return panner;
  }

  /** Sets one sound's pan, -1 (left) to 1 (right). */
  setSoundPan(id: number, pan: number): void {
    const panner = this.pannerFor(id);
    if (panner) panner.pan.value = Math.max(-1, Math.min(1, pan));
  }

  /** Ramps one sound's pan to a target over `seconds`. */
  fadeSoundPan(id: number, pan: number, seconds: number): void {
    const panner = this.pannerFor(id);
    if (!panner || !this.context) return;

    const target = Math.max(-1, Math.min(1, pan));
    const now = this.context.currentTime;
    panner.pan.cancelScheduledValues(now);
    panner.pan.setValueAtTime(panner.pan.value, now);
    if (seconds <= 0) panner.pan.setValueAtTime(target, now);
    else panner.pan.linearRampToValueAtTime(target, now + seconds);
  }

  stopSound(id: number): void {
    const player = this.players.get(id);
    if (player) {
      this.players.delete(id);
      // Clearing the player is what fires the triggers still hung on it. It
      // leaves the chip after, so its release reaches its own channels.
      player.clear();
      this.mixer.remove(player);
    }
    this.speakerSequence.stop(id);
    const source = this.playing.get(id);
    if (source) {
      try {
        source.stop();
      } catch {
        // Already stopped; nothing to do.
      }
      this.playing.delete(id);
    }
    this.gains.delete(id);
    this.panners.delete(id);
    this.startedAt.delete(id);
    this.startedFrom.delete(id);
    this.pendingMusic.delete(id);
  }

  stopAll(): void {
    // Each player's triggers fire as it stops, as `stopAllSounds_internal`
    // clearing every player does in the original.
    for (const id of [...this.players.keys(), ...this.playing.keys()]) this.stopSound(id);
    this.speakerSequence.stopAll();
    this.pendingMusic.clear();
  }

  isSoundRunning(id: number): boolean {
    return (
      this.playing.has(id) ||
      this.pendingMusic.has(id) ||
      this.livePlayer(id) !== null ||
      this.speakerSequence.isPlaying(id)
    );
  }

  /**
   * Ages the music we cannot play, once per engine frame.
   *
   * Without this the entries never expire and `isSoundRunning` answers "yes"
   * for the rest of the session.
   */
  step(secondsPerFrame = 1 / 60): void {
    // The sequencer advances on elapsed time rather than on frames, so a busy
    // scene lengthens the step instead of stretching the fade.
    //
    // The caller passes the *game's* cycle length, which is not a sixtieth:
    // told a sixtieth by a game running ten cycles a second, every crossfade
    // and every volume ramp took six times as long as the script asked for,
    // and a piece faded out under a scene that had already moved on.
    this.sequencer.step(secondsPerFrame);
    this.imuse.step(secondsPerFrame);
    this.mixerStream?.pump();
    this.speakerStream?.pump();

    // Aged in the same units, so an unplayable sound stops answering
    // "still running" after the length of time it was given rather than after
    // that many cycles.
    const frames = Math.max(1, Math.round(secondsPerFrame * 60));
    for (const [id, framesLeft] of this.pendingMusic) {
      if (framesLeft <= frames) this.pendingMusic.delete(id);
      else this.pendingMusic.set(id, framesLeft - frames);
    }
  }

  /**
   * How far into the playing music the game has got, in half-beats.
   *
   * This is what `VAR_MUSIC_TIMER` holds, and the unit is the original's:
   * `Player::getMusicTimer` is `tick * 2 / PPQN`, so a value of two is one
   * quarter note in. Zero when nothing is playing, which is the half that
   * matters most — a script watching for a piece to end is watching for this
   * to fall back to zero.
   *
   * A rendered-up-front score has no sequencer to ask, so the position of the
   * audio is converted back through the score's own tempo map. Same answer,
   * arrived at from the other end.
   */
  musicTimer(): number | null {
    // Null rather than zero, in every case where there is no position to
    // report. Zero is a *place in a piece of music* — the beginning — and a
    // caller told "the beginning" every cycle cannot tell that apart from a
    // piece that is genuinely sitting at its first beat. The distinction is
    // the whole of the caller's decision: `VAR_MUSIC_TIMER` is something
    // scripts wait on, and one told for ever that the music is at the
    // beginning waits for ever.
    if (this.context === null) return null;

    const id = this.playingMusic;
    if (id === null) return null;

    // A live player knows where it is, in its own ticks.
    const live = this.livePlayer(id);
    if (live) return live.musicTimer();

    const seconds = this.positionOf(id);
    if (seconds === null || seconds < 0) return null;

    const midi = this.scoreFor(id);
    if (!midi) return null;

    return Math.floor((secondsToTicks(seconds, midi) * 2) / midi.division);
  }

  /**
   * The parsed score behind a sound id, remembered rather than re-read.
   *
   * `musicTimer` asks for this every cycle, and parsing a MIDI file ten times
   * a second to answer a question about where it has got to would cost more
   * than the music does.
   */
  private scoreFor(id: number): MidiFile | null {
    const cached = this.scoreCache.get(id);
    if (cached !== undefined) return cached;

    const resource = this.resources?.getSound(id) ?? null;
    const midi = resource ? readScummMusic(resource) : null;
    this.scoreCache.set(id, midi);
    return midi;
  }

  private readonly scoreCache = new Map<number, MidiFile | null>();

  /**
   * An iMUSE command, as `soundKludge` delivers it, and its result.
   *
   * The first element is two bytes in one: the low byte is the command and the
   * high byte its scope. Scope 0 is the sound system — start this, stop that,
   * set the volume — and scope 1 addresses a *player*, the thing sequencing one
   * piece of music, to make it jump, loop, arm a hook, transpose or fade.
   *
   * Start, stop and master volume are served here, through the music
   * sequencer; everything that needs a player's state is `ImuseCommands`'.
   * The result is what the original leaves in `VAR_SOUNDRESULT`, which is how a
   * script reads a player parameter or the command queue back.
   *
   * Command numbering follows ScummVM's `IMuseInternal::doCommand`.
   */
  kludge(args: number[]): number {
    if (args.length === 0) return 0;

    // -1 is not a command: `Sound::soundKludge` takes it as "process the
    // queued commands now". Commands run as they arrive here, so there is
    // nothing left to process — Day of the Tentacle sends it constantly,
    // which is the "command 255 (scope 255)" it used to log.
    if (args[0] === -1 || (args[0] & 0xffff) === 0xffff) return this.lastResult;

    // The original reads fixed slots past the end of short lists as zero.
    const a = [...args, ...new Array<number>(16).fill(0)];
    const scope = (a[0] >> 8) & 0xff;
    const command = a[0] & 0xff;

    let result: number | undefined;
    if (scope === 1) result = this.imuse.playerCommand(command, a);
    else if (scope === 0) result = this.systemCommand(command, a);

    if (result === undefined) {
      this.unhandledKludge(scope, command, args);
      result = -1;
    }
    this.lastResult = result;
    return result;
  }

  /** What the last command returned, for the "process the queue" marker. */
  private lastResult = 0;

  private systemCommand(command: number, a: number[]): number | undefined {
    switch (command) {
      case 6: {
        // Master volume, 0-127 in the command's terms.
        const level = a[1];
        if (level < 0 || level > 127) return -1;
        this.setVolume(level / 127);
        return 0;
      }
      case 7:
        return Math.round(this.volume * 127);
      case 8:
        this.startScored(a[1]);
        return 0;
      case 9:
        this.stopScored(a[1]);
        return 0;
      case 10:
      case 11:
        this.stopAll();
        return 0;
      case 2:
      case 3:
        // Documented no-ops in the original too.
        return 0;
      default:
        return this.imuse.systemCommand(command, a);
    }
  }

  /**
   * Starts a piece through the sequencer rather than straight to playback:
   * asking for the piece already playing is not a restart, which is what stops
   * a room's music cutting back to its opening bar every time the player walks
   * through the door. A piece that has *finished* is started again, though —
   * the sequencer's state outlives the audio, and a script asking again for
   * music that has ended wants to hear it.
   */
  private startScored(id: number): void {
    this.playingMusic = id;
    if (this.sequencer.state?.id === id && !this.isSoundRunning(id)) this.sequencer.restore(null);
    this.sequencer.enter({ id, crossfadeSeconds: 0 });
  }

  private stopScored(id: number): void {
    if (this.sequencer.state?.id === id) this.sequencer.leave();
    else this.stopSound(id);
  }

  /**
   * The iMUSE command layer: player commands, the marker queue, triggers.
   *
   * Set to Sam & Max's numbering by `configureImuse`, because the same command
   * number means different things in the two systems.
   */
  readonly imuse: ImuseCommands = new ImuseCommands({
    player: (id) => this.livePlayer(id),
    run: (args) => this.kludge(args),
    status: (id) => this.isSoundRunning(id),
    stop: (id) => this.stopScored(id),
    log: (line) => this.onLog?.(line),
  });

  /** How far a transpose may reach: 12 for Day of the Tentacle, 24 otherwise. */
  private transposeLimit = 24;

  /**
   * Says which iMUSE a game has.
   *
   * Two facts about the *title* rather than the version, as ScummVM's
   * `_newSystem` (Sam & Max) and its Day of the Tentacle transpose limit are.
   */
  configureImuse(options: { newSystem?: boolean; transposeLimit?: number }): void {
    this.imuse.newSystem = options.newSystem ?? false;
    this.transposeLimit = options.transposeLimit ?? 24;
  }

  /**
   * Every live iMUSE player, all on one chip (`ImuseMixer`), streamed as one.
   *
   * One card for everything, as the original has: the nine OPL2 voices are
   * shared by priority between the music and any sound-effect score.
   */
  private readonly mixer = new ImuseMixer();
  private mixerStream: LiveMusicStream | null = null;
  private readonly players = new Map<number, ImusePlayer>();

  /** The global instrument slots, which every player's sysex 17 fills. */
  private readonly globals = new GlobalInstruments();

  /** v1-v4 speaker sounds, one at a time as `Player_V2` plays them. */
  private readonly speakerSequence = new SpeakerSequence(OPL2_RATE);
  private speakerStream: LiveMusicStream | null = null;

  /** Saved player states waiting for their sound to start (see `restoreImuse`). */
  private readonly pendingPlayerState = new Map<number, SavedImusePlayer>();

  /** A sound's live player while it is still playing, or null. */
  private livePlayer(id: number): ImusePlayer | null {
    const player = this.players.get(id);
    return player && player.active ? player : null;
  }

  /**
   * What a sound resource can be sequenced from, parsed once per id.
   *
   * `false` means "nothing to sequence" — a digitised effect, or data no card
   * here can play — so the decoded-sample path is taken instead.
   */
  private readonly liveCache = new Map<
    number,
    | { score: NonNullable<ReturnType<typeof readScummScore>>; resource: Uint8Array }
    | { speaker: Uint8Array; headerLength: number }
    | false
  >();

  private liveEntry(id: number) {
    let entry = this.liveCache.get(id);
    if (entry !== undefined) return entry;

    entry = false;
    const resource = this.resources?.getSound(id) ?? null;
    // A resource with digitised audio in it is a sample, whatever else it
    // carries: effects often ship a score beside their recording.
    if (resource && !decodeSoundResource(resource)) {
      const score = readScummScore(resource);
      if (score && score.midi.events.length > 0) entry = { score, resource };
      else {
        // v3/v4 tag their speaker block `WA` and give it a six-byte header;
        // v1/v2 do neither, and their header is four bytes.
        const tagged = findSpeakerBlock(resource);
        const version = this.resources?.game?.version ?? 5;
        const old = !tagged && version <= 3 ? findOldBundleSpeaker(resource) : null;
        if (tagged) entry = { speaker: tagged, headerLength: 6 };
        else if (old) entry = { speaker: old, headerLength: 4 };
      }
    }
    this.liveCache.set(id, entry);
    return entry;
  }

  private createPlayer(
    id: number,
    entry: { score: NonNullable<ReturnType<typeof readScummScore>>; resource: Uint8Array },
  ): ImusePlayer {
    const port = this.mixer.portFor(entry.score.kind);
    const player: ImusePlayer = new ImusePlayer(id, entry.score.midi, {
      kind: entry.score.kind,
      newSystem: this.imuse.newSystem,
      transposeLimit: this.transposeLimit,
      start: readStartParameters(entry.resource),
      synth: port,
      globals: this.globals,
      host: {
        marker: (sound, marker) => this.imuse.marker(sound, marker),
        triggerEvent: (sound, marker) => this.imuse.triggerEvent(sound, marker),
        ended: (sound) => {
          if (this.players.get(sound) === player) this.players.delete(sound);
          this.imuse.soundEnded(sound);
        },
      },
    });
    const channelVolume = this.imuse.channelVolumeFor(id);
    if (channelVolume !== 127) player.setChannelVolume(channelVolume);
    this.mixer.add(player, port);
    return player;
  }

  /**
   * Starts a sound as live-sequenced music, when it is a score.
   *
   * Imported audio keeps the rendered path: it was decoded when the project
   * loaded, and a project track is played as the author heard it in the
   * editor.
   */
  private startLive(id: number): boolean {
    if (!this.context || !this.masterGain || this.registered.has(id)) return false;
    const entry = this.liveEntry(id);
    if (!entry) return false;

    this.stopSound(id);
    if ('speaker' in entry) {
      this.speakerSequence.start({ id, data: entry.speaker, headerLength: entry.headerLength });
      this.speakerStream = this.ensureStream(this.speakerStream, this.speakerSequence, (s) => {
        if (this.speakerStream === s) this.speakerStream = null;
      });
      return true;
    }

    const player = this.createPlayer(id, entry);
    const saved = this.pendingPlayerState.get(id);
    if (saved) {
      this.pendingPlayerState.delete(id);
      player.restore(saved);
    }
    this.players.set(id, player);
    this.playingMusic = id;
    this.mixerStream = this.ensureStream(this.mixerStream, this.mixer, (s) => {
      if (this.mixerStream === s) this.mixerStream = null;
    });
    return true;
  }

  /** The stream for a shared source, started if it is not already running. */
  private ensureStream(
    stream: LiveMusicStream | null,
    source: ImuseMixer | SpeakerSequence,
    finished: (stream: LiveMusicStream) => void,
  ): LiveMusicStream {
    if (stream && !stream.finished) {
      stream.pump();
      return stream;
    }
    const created = new LiveMusicStream(
      this.context as AudioContext,
      this.masterGain as GainNode,
      source,
    );
    created.onFinished = () => finished(created);
    return created;
  }

  /**
   * The iMUSE state a save carries: every player, the command queue and
   * triggers, and the global instruments (`IMuseInternal::saveLoadIMuse`).
   */
  saveImuse(): SavedImuse {
    return {
      players: [...this.players.values()].filter((p) => p.active).map((p) => p.save()),
      commands: this.imuse.save(),
      globals: this.globals.save(),
    };
  }

  /**
   * Puts the iMUSE state back from a save. A save written before this existed
   * has none, and is loaded exactly as before — the music state alone.
   *
   * Each saved player is restarted and then laid over with its saved state;
   * with no audio context yet that happens when the context arrives, since the
   * state waits for its sound to start.
   */
  restoreImuse(saved: SavedImuse | undefined | null): void {
    if (!saved) return;
    for (const player of this.players.values()) {
      this.mixer.remove(player);
      player.halt();
    }
    this.players.clear();
    this.imuse.restore(saved.commands);
    this.globals.restore(saved.globals);
    for (const state of saved.players) {
      this.pendingPlayerState.set(state.id, state);
      this.startSound(state.id);
      if (this.livePlayer(state.id)) this.playingMusic = state.id;
    }
  }

  /** The music that is playing, for `VAR_MUSIC_TIMER`. */
  private playingMusic: number | null = null;

  /**
   * The live sequencer, driving music as state rather than as a track.
   *
   * v6 feeds it the live-sequenced scores this engine plays and v7 decoded
   * bundle streams; the transition logic above is the same for both (ADR
   * 0008). Sound *effects* do not go through it — only music moves onto the
   * sequencer, because only music has states to move between.
   */
  readonly sequencer: MusicSequencer = new MusicSequencer(this.musicSource(), (line) =>
    this.onLog?.(line),
  );

  /**
   * The audio side of the sequencer's seam, for v6.
   *
   * Deliberately thin: `play`, `stop` and `setLevel` are all the sequencer
   * needs, and keeping it to that is what lets v7 substitute a bundle stream
   * without the transition logic noticing.
   */
  private musicSource(): MusicSource {
    return {
      play: (id) => {
        // v7 first: a game with a music bundle plays states out of it, and one
        // without takes the rendered path. The sequencer above sees neither.
        const name = this.bundleCueName(id);
        if (name && this.playBundleMusic(id, name)) return;
        this.startSound(id);
      },
      stop: (id) => this.stopSound(id),
      setLevel: (id, level) => this.setSoundLevel(id, level),
      positionOf: (id) => this.positionOf(id),
    };
  }

  /**
   * v7's iMUSE Digital, which shares only the opcode with v6's iMUSE.
   *
   * A separate object rather than a branch inside `kludge` because the two
   * share no command numbering: v6 splits its first argument into a scope and a
   * command byte, v7's is a single sixteen-bit command, and running one
   * numbering through the other's decoder is what left The Dig reporting
   * "command 0, scope 16" for a command called `SetState`.
   */
  readonly digital: DigitalImuse = new DigitalImuse(this.digitalAudio(), (line) =>
    this.onLog?.(line),
  );

  /** The audio side of the digital dispatch's seam. */
  private digitalAudio(): DigitalAudio {
    return {
      playMusicCue: (id) => {
        const name = this.bundleCueName(id);
        return name !== null && this.playBundleMusic(id, name);
      },
      playStreamCue: (id) => this.startBundleSound(id),
      stop: (id) => this.stopSound(id),
      stopAll: () => this.stopAll(),
      setLevel: (id, level) => this.setSoundLevel(id, level),
      fadeLevel: (id, level, seconds) => this.fadeSoundLevel(id, level, seconds),
      setPan: (id, pan) => this.setSoundPan(id, pan),
      fadePan: (id, pan, seconds) => this.fadeSoundPan(id, pan, seconds),
    };
  }

  /** Said once per distinct command: a game polls, and a log that repeats buries itself. */
  private readonly reportedKludges = new Set<number>();

  private unhandledKludge(scope: number, command: number, args: number[]): void {
    const key = (scope << 8) | command;
    if (this.reportedKludges.has(key)) return;
    this.reportedKludges.add(key);
    this.onLog?.(
      `iMUSE command ${command} (scope ${scope}) is not implemented, so the music ` +
        `will not follow the game here. Arguments: ${args.slice(1).join(', ')}`,
    );
  }

  /** Where unimplemented-command notices go, when anyone is listening. */
  onLog: ((message: string) => void) | null = null;

  /** Sound ids whose buffer is a rendered score rather than a sample. */
  private readonly scores = new Set<number>();

  /** Sound ids that carry no score this chip can play, so not tried twice. */
  private readonly scoreless = new Set<number>();

  /**
   * Renders a music resource to a buffer, so plain `startSound` can play it.
   *
   * A v6 game starts its music through `soundKludge`, and that path has always
   * gone somewhere. A v5 game has no iMUSE command for it: `startSound 21` is
   * the whole instruction, and the resource behind it is a score rather than a
   * sample. With no branch for that here, every v5 game's music was filed under
   * "pending" — a bookkeeping entry so `isSoundRunning` could answer — and
   * nothing was ever heard. Atlantis is silent from its title screen on.
   *
   * Rendered once and cached beside the decoded samples, because rendering a
   * two-minute score through an OPL2 is not something to do on every room
   * change.
   */
  private renderMusicBuffer(id: number): AudioBuffer | null {
    if (!this.context || !this.resources) return null;
    // Not `unsupported`: that set means "no sample here", which is true of
    // every score and is how one reaches this method at all.
    if (this.scoreless.has(id)) return null;

    const resource = this.resources.getSound(id);
    if (!resource) return null;

    const rendered = renderScummMusic(resource, this.context.sampleRate);
    if (!rendered) {
      this.scoreless.add(id);
      return null;
    }

    const buffer = this.context.createBuffer(1, rendered.samples.length, rendered.sampleRate);
    buffer.getChannelData(0).set(rendered.samples);
    this.decoded.set(id, buffer);
    this.scores.add(id);
    return buffer;
  }

  private getBuffer(id: number): AudioBuffer | null {
    if (this.decoded.has(id)) return this.decoded.get(id) ?? null;

    // No context yet — the browser only allows one from a gesture, and the
    // game asks for its opening music before the player has made one. Nothing
    // is decided here, so nothing is remembered: caching the failure meant the
    // first sounds of every game were permanently silent, because the null
    // cached before the context existed was still cached after it did.
    if (!this.context) return null;

    let buffer: AudioBuffer | null = null;
    // Registered audio is decoded by `load`; reaching here with bytes still
    // registered means the decode has not finished, so fall through to the
    // container rather than reporting the sound as broken.
    const resource = this.resources?.getSound(id);
    if (resource) {
      const pcm = decodeSoundResource(resource);
      if (pcm) {
        buffer = this.context.createBuffer(1, pcm.samples.length, pcm.sampleRate);
        buffer.getChannelData(0).set(pcm.samples);
      } else {
        // Sequenced rather than sampled, which for some games is *everything*:
        // Day of the Tentacle's `SOUN` resources hold a score per sound card
        // and nothing digitised at all, so a decoder that only understands
        // samples finds nothing in any of them and the whole game is silent.
        // Rendering the score to samples is what the editor's own library
        // already did with imported music; the game's own resources went
        // through this path instead and were only ever recorded as pending.
        const rendered = renderScummMusic(resource, this.context.sampleRate);
        if (rendered) {
          buffer = this.context.createBuffer(1, rendered.samples.length, rendered.sampleRate);
          buffer.getChannelData(0).set(rendered.samples);
        } else {
          this.unsupported.add(id);
        }
      }
    }

    this.decoded.set(id, buffer);
    return buffer;
  }
}

/**
 * Turns imported bytes into something Web Audio can play.
 *
 * SCUMM's own containers are unwrapped here because no browser knows them; for
 * everything else the browser's decoder is both better and free, and it
 * quietly covers formats this code has never heard of. Returning `null` rather
 * than throwing keeps one undecodable track from taking down a whole library.
 */
export async function decodeAudioBytes(
  context: BaseAudioContext,
  bytes: Uint8Array,
): Promise<AudioBuffer | null> {
  const format = detectAudioFormat(bytes);

  if (format === 'scumm-music') {
    const music = renderScummMusic(bytes, context.sampleRate);
    if (!music) return null;
    const buffer = context.createBuffer(1, music.samples.length, context.sampleRate);
    buffer.getChannelData(0).set(music.samples);
    return buffer;
  }

  if (format === 'voc' || format === 'scumm-sound') {
    const pcm = format === 'voc' ? decodeVoc(bytes) : decodeSoundResource(bytes);
    if (pcm) {
      const buffer = context.createBuffer(1, pcm.samples.length, pcm.sampleRate);
      buffer.getChannelData(0).set(pcm.samples);
      return buffer;
    }
    // A SCUMM resource holding sequenced music has no samples to hand over.
    return null;
  }

  try {
    // `decodeAudioData` detaches the buffer it is given, so it gets a copy —
    // otherwise the caller's bytes would be emptied by playing them once.
    return await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
  } catch {
    return null;
  }
}

export interface DecodedPcm {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Extracts digitised audio from a `SOUN` resource.
 *
 * The `SBL ` variant wraps a Creative Voice File; other variants are sequenced
 * music and return `null`.
 */
export function decodeSoundResource(resource: Uint8Array): DecodedPcm | null {
  // `SOU ` blocks first, by their own sizing rule: a digitised effect stored
  // after the music arrangements is invisible to the ordinary chunk walker,
  // which stops at the first block.
  const block = findSoundBlock(resource, ['SBL ']);
  if (block) {
    const inner = findChunkDeep(resource, block.offset, 'AUdt', block.offset + block.size, 3);
    const start = inner ? inner.dataOffset : block.offset;
    const finish = inner ? inner.dataOffset + inner.dataSize : block.offset + block.size;
    return decodeVoc(resource.subarray(start, finish));
  }

  const root = readChunkHeader(resource, 0);
  const end = root.dataOffset + root.dataSize;

  const sbl = findChunkDeep(resource, root.dataOffset, 'SBL ', end, 3);
  if (!sbl) return null;

  const audioData = findChunkDeep(
    resource,
    sbl.dataOffset,
    'AUdt',
    sbl.dataOffset + sbl.dataSize,
    3,
  );
  const start = audioData ? audioData.dataOffset : sbl.dataOffset;
  const finish = audioData
    ? audioData.dataOffset + audioData.dataSize
    : sbl.dataOffset + sbl.dataSize;

  return decodeVoc(resource.subarray(start, finish));
}

/**
 * Decodes a Creative Voice File (`.VOC`).
 *
 * Only block type 1 (uncompressed 8 bit PCM) is handled, which is all the
 * SCUMM games use. The sample rate is stored as a divisor of 1 MHz.
 */
export function decodeVoc(data: Uint8Array): DecodedPcm | null {
  if (data.length < 0x1a) return null;

  let offset = 0;
  const header = String.fromCharCode(...data.subarray(0, 19));
  if (header === 'Creative Voice File') {
    // The header stores the offset of the first data block at byte 20.
    offset = data[20] | (data[21] << 8);
    if (offset < 0x1a || offset >= data.length) offset = 0x1a;
  }

  const chunks: Uint8Array[] = [];
  let sampleRate = 11025;

  while (offset < data.length) {
    const blockType = data[offset];
    if (blockType === 0) break; // terminator
    if (offset + 4 > data.length) break;

    const blockSize = data[offset + 1] | (data[offset + 2] << 8) | (data[offset + 3] << 16);
    const body = offset + 4;

    if (blockType === 1) {
      const divisor = data[body];
      const codec = data[body + 1];
      if (codec !== 0) return null; // compressed VOC; not used by SCUMM
      sampleRate = Math.round(1000000 / (256 - divisor));
      chunks.push(data.subarray(body + 2, body + blockSize));
    } else if (blockType === 9) {
      sampleRate =
        data[body] | (data[body + 1] << 8) | (data[body + 2] << 16) | (data[body + 3] << 24);
      chunks.push(data.subarray(body + 12, body + blockSize));
    }

    offset = body + blockSize;
  }

  if (chunks.length === 0) return null;

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const samples = new Float32Array(total);
  let index = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      // 8 bit VOC data is unsigned, centred on 128.
      samples[index++] = (chunk[i] - 128) / 128;
    }
  }

  return { samples, sampleRate };
}

/** True if a `SOUN` resource holds sequenced music rather than samples. */
export function isMusicResource(resource: Uint8Array): boolean {
  if (resource.length < 16) return false;
  const size = readU32BE(resource, 4);
  void size;
  const inner = readTag(resource, 8);
  return inner === 'ADL ' || inner === 'ROL ' || inner === 'SPK ' || inner === 'MIDI';
}
