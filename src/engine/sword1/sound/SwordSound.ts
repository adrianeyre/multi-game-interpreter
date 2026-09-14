/**
 * Broken Sword's sound: effects, music and recorded speech.
 *
 * ## Why this plays and Sky's does not
 *
 * `SkySound` is a toggle and a resume, and says so. This family can do better
 * for one reason: its audio is **RIFF/WAVE and a documented RLE** rather than
 * a bespoke mixer format, so `swordAudio.ts` decodes it in a few dozen lines
 * and WebAudio plays the result. There is no Adlib emulation, no XMIDI
 * sequencer and no sample bank to reconstruct.
 *
 * ## Where the awaiting happens
 *
 * `fnPlayFx` is synchronous and a browser's decode is not, so the same seam
 * `SwordResources` draws applies here: a play *requests* a sample, the request
 * is drained between cycles, and a sample that is not ready yet is simply not
 * heard. For a spot effect that is the right answer — a door closing a frame
 * late is worse than a door not heard — and for a loop it self-corrects on the
 * next cycle.
 *
 * Speech is different and is treated differently: a line of dialogue that does
 * not play would desynchronise the *script*, because `speechDriver` waits on
 * the sample. So when speech is unavailable the driver falls back to counting
 * down the subtitle's own `o_speech_time`, which is exactly what the original
 * does with speech turned off — and `CONTEXT.md`'s warning about pacing is
 * honoured rather than worked around.
 */

import type { EngineSound } from '../../AdventureEngine.js';
import type { SwordResources } from '../resource/SwordResources.js';
import { SWORD1_FX_COUNT, sword1SampleId, SWORD1_FX, Sword1FxType } from './fxTable.js';
import { sword1TuneName } from './tuneNames.js';
import {
  checkSpeechEndianness,
  parseWave,
  speechSample,
  SwordAudioError,
  type Sword1SpeechMode,
  type SwordSample,
} from './swordAudio.js';
import { sword1MusicFileIn, sword1SpeechFileIn } from './musicFiles.js';
import { readSword1SpeechIndex, type Sword1SpeechIndex } from './speechIndex.js';
import { readRangeFrom, type DataSource } from '../../resource/DataSource.js';

/**
 * Which of the two speech containers this is, from its name.
 *
 * The only thing that distinguishes them, and it is what the original uses
 * (`sound.cpp:784` sets `CowDemo` exactly when it opened `cows.mad`).
 */
function sword1SpeechModeFor(file: string): Sword1SpeechMode {
  return /(?:^|[/\\])cows\.mad$/i.test(file) ? 'demo' : 'wave';
}

/** A voice the mixer is playing, so it can be stopped by effect number. */
interface Voice {
  readonly fxNo: number;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

export class SwordSound implements EngineSound {
  private enabled = true;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;

  /** Decoded samples by resource id, so a looping effect decodes once. */
  private readonly samples = new Map<number, SwordSample | null>();
  private readonly voices: Voice[] = [];

  /** Effect numbers waiting on a decode, drained by `pump`. */
  private readonly wanted = new Set<number>();
  /** Music files this project could not find, so the log says so once. */
  private readonly missingMusic = new Set<number>();

  private speechVoice: AudioBufferSourceNode | null = null;
  private speechDone = true;
  private speechPending: { section: number; line: number } | null = null;
  private speechBigEndian: boolean | null = null;
  /**
   * The speech container, opened once and kept.
   *
   * `undefined` means "not looked for yet" and `null` means "this install has
   * none", which are different answers: the second stops the engine reopening
   * a 45 MB file once per line for a release that never shipped one.
   */
  private speechIndex: Sword1SpeechIndex | null | undefined = undefined;
  /** Where the container's bytes come from; absent until a source is attached. */
  private speechSource: DataSource | null = null;

  private musicVoice: AudioBufferSourceNode | null = null;
  private musicId = 0;

  readonly notes: string[] = [];

  constructor(
    private readonly resources: SwordResources,
    /** The install's file names: the tunes and the speech container are files. */
    private readonly musicNames: readonly string[] = [],
    private readonly readFile?: (name: string) => Promise<Uint8Array | null>,
    private readonly windowsDemo = false,
  ) {}

  /**
   * Points the speech reader at the install, for the one file that is not in a
   * cluster.
   *
   * A `DataSource` rather than a reader function, because a speech container
   * is 43.9 MB in the demo and 45.5 MB on a retail disc and every line is a
   * range inside it — `readRangeFrom` is how a line is read without the file.
   */
  attachSpeech(source: DataSource): void {
    this.speechSource = source;
    this.speechIndex = undefined;
    // Opened now rather than at the first line, because `startSpeech` has to
    // answer *synchronously* whether a line will play and the index is a read.
    // Boot to the first word of dialogue is many frames; the index is 19 KB.
    void this.openSpeech();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.master) this.master.gain.value = enabled ? 1 : 0;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async resume(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = this.enabled ? 1 : 0;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /**
   * `fnPlayFx`: queue an effect, returning what the script should see.
   *
   * Returns 1 when the sample is in hand and 0 otherwise, which is what the
   * original returns from its own queue insert — a script that tests it is
   * asking "did that start", and the honest answer while a decode is pending is
   * no.
   */
  playFx(fxNo: number): number {
    if (fxNo < 0 || fxNo >= SWORD1_FX_COUNT) return 0;
    const id = sword1SampleId(fxNo, this.windowsDemo);
    if (id === null) return 0;
    const sample = this.samples.get(id);
    if (sample === undefined) {
      this.wanted.add(fxNo);
      return 0;
    }
    if (sample === null) return 0;
    this.start(fxNo, sample, SWORD1_FX[fxNo].type === Sword1FxType.LOOP);
    return 1;
  }

  stopFx(fxNo: number): void {
    this.wanted.delete(fxNo);
    for (let at = this.voices.length - 1; at >= 0; at--) {
      if (this.voices[at].fxNo !== fxNo) continue;
      try {
        this.voices[at].source.stop();
      } catch {
        // A source that already ended throws; that is the state we wanted.
      }
      this.voices.splice(at, 1);
    }
  }

  stopAllFx(): void {
    for (const voice of [...this.voices]) this.stopFx(voice.fxNo);
  }

  /**
   * Starts a line of speech; true when a sample is actually playing.
   *
   * The return decides `speechDriver`'s timing path, so it has to be honest:
   * false makes the driver count the subtitle down instead, which keeps the
   * script's pacing right on an install with no speech container — and on a
   * line that container does not hold, which the demo has many of.
   *
   * Answered from the index rather than from the read, which is why the index
   * is opened at attach time: the driver asks this synchronously.
   */
  startSpeech(section: number, line: number): boolean {
    const entry = this.speechIndex?.locate(section, line) ?? null;
    if (!entry) {
      // No recording, so say so: the driver counts the subtitle down instead,
      // and claiming a sample that never arrives would cut the line short.
      this.speechDone = true;
      this.speechPending = null;
      return false;
    }
    this.speechDone = false;
    this.speechPending = { section, line };
    return true;
  }

  speechFinished(): boolean {
    return this.speechDone;
  }

  stopSpeech(): void {
    this.speechPending = null;
    this.speechDone = true;
    if (this.speechVoice) {
      try {
        this.speechVoice.stop();
      } catch {
        // Already finished.
      }
      this.speechVoice = null;
    }
  }

  playMusic(tuneId: number, looped: boolean): void {
    this.musicId = tuneId;
    void this.startMusic(tuneId, looped);
  }

  stopMusic(): void {
    this.musicId = 0;
    if (this.musicVoice) {
      try {
        this.musicVoice.stop();
      } catch {
        // Already finished.
      }
      this.musicVoice = null;
    }
  }

  /**
   * Does the asynchronous work one cycle's worth of requests created.
   *
   * Called by the engine between cycles, which is the only place a browser lets
   * an await happen without the logic seeing it.
   */
  async pump(): Promise<void> {
    for (const fxNo of [...this.wanted]) {
      this.wanted.delete(fxNo);
      const id = sword1SampleId(fxNo, this.windowsDemo);
      if (id === null) continue;
      if (this.samples.has(id)) continue;
      const resource = await this.resources.load(id);
      if (!resource) {
        this.samples.set(id, null);
        this.note(`effect ${fxNo}: ${this.resources.describeMissingResource(id)}`);
        continue;
      }
      try {
        this.samples.set(id, parseWave(resource.bytes));
      } catch (error) {
        this.samples.set(id, null);
        this.note(
          `effect ${fxNo}'s sample would not decode: ` +
            (error instanceof SwordAudioError ? error.message : String(error)),
        );
      }
    }

    if (this.speechPending) {
      const { section, line } = this.speechPending;
      this.speechPending = null;
      await this.loadSpeech(section, line);
    }
  }

  /**
   * Reads and plays one line out of the speech container.
   *
   * Not a cluster read, and that was the defect: this family keeps its speech
   * in one file beside the install with an index of its own, and `swordres.rif`
   * does not list it. Asking the resource system for a speech id therefore
   * found nothing in any release, so no line of Broken Sword had ever played
   * here — the driver silently fell through to counting the subtitle down,
   * which is the same thing it correctly does for an install with no speech at
   * all, which is why it read as working.
   *
   * A `section` is the screen the line belongs to and a `line` is its number
   * within that screen; both are what the compact carries.
   */
  private async loadSpeech(section: number, line: number): Promise<void> {
    const index = await this.openSpeech();
    const source = this.speechSource;
    if (!index || !source) {
      this.speechDone = true;
      return;
    }
    const entry = index.locate(section, line);
    if (!entry) {
      this.speechDone = true;
      return;
    }
    const bytes = await readRangeFrom(source, index.file, entry.at, entry.at + entry.length);
    if (!bytes || bytes.length === 0) {
      this.speechDone = true;
      return;
    }
    const mode = sword1SpeechModeFor(index.file);
    try {
      this.speechBigEndian ??= checkSpeechEndianness(bytes, mode);
      this.playSpeechSample(speechSample(bytes, this.speechBigEndian, mode));
    } catch (error) {
      this.note(
        `speech ${section}/${line} would not decode: ` +
          (error instanceof SwordAudioError ? error.message : String(error)),
      );
      this.speechDone = true;
    }
  }

  /** Opens the container once, and remembers that there was not one. */
  private async openSpeech(): Promise<Sword1SpeechIndex | null> {
    if (this.speechIndex !== undefined) return this.speechIndex;
    this.speechIndex = null;
    const source = this.speechSource;
    if (!source) return null;
    const file = sword1SpeechFileIn(this.musicNames);
    if (!file) {
      this.note('this install ships no speech container, so subtitles are timed instead');
      return null;
    }
    this.speechIndex = await readSword1SpeechIndex(source, file);
    if (!this.speechIndex) this.note(`${file} has no speech index, so subtitles are timed instead`);
    return this.speechIndex;
  }

  private playSpeechSample(sample: SwordSample): void {
    const buffer = this.buffer(sample);
    if (!buffer || !this.context || !this.master) {
      this.speechDone = true;
      return;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.master);
    source.onended = (): void => {
      this.speechDone = true;
      this.speechVoice = null;
    };
    source.start();
    this.speechVoice = source;
  }

  private async startMusic(tuneId: number, looped: boolean): Promise<void> {
    if (!this.readFile) return;
    // A tune is addressed by *name*, not by number: `fnPlayMusic 8` is
    // `MUSIC/1M10.WAV`, and the table that joins them is generated rather than
    // typed (`tuneNames.ts`, ADR 0029). Building `MUSIC/8.WAV` out of the
    // number instead — which is what this did — finds nothing in any release,
    // so no tune had ever played.
    const name = sword1MusicFileIn(this.musicNames, tuneId);
    if (!name) {
      if (!this.missingMusic.has(tuneId)) {
        this.missingMusic.add(tuneId);
        const stem = sword1TuneName(tuneId);
        this.note(
          stem
            ? `music ${tuneId}: no ${stem}.wav in this folder`
            : `music ${tuneId} is not a tune this release names`,
        );
      }
      return;
    }
    const bytes = await this.readFile(name);
    if (!bytes) return;
    let sample: SwordSample;
    try {
      sample = parseWave(bytes);
    } catch (error) {
      this.note(
        `music ${tuneId} would not decode: ` +
          (error instanceof SwordAudioError ? error.message : String(error)),
      );
      return;
    }
    const buffer = this.buffer(sample);
    if (!buffer || !this.context || !this.master) return;
    this.stopMusic();
    this.musicId = tuneId;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = looped;
    source.connect(this.master);
    source.start();
    this.musicVoice = source;
  }

  /** Starts one effect voice, panned by nothing: the room volumes are per-room. */
  private start(fxNo: number, sample: SwordSample, loop: boolean): void {
    const buffer = this.buffer(sample);
    if (!buffer || !this.context || !this.master) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    const gain = this.context.createGain();
    source.connect(gain);
    gain.connect(this.master);
    source.start();
    const voice: Voice = { fxNo, source, gain };
    this.voices.push(voice);
    source.onended = (): void => {
      const at = this.voices.indexOf(voice);
      if (at >= 0) this.voices.splice(at, 1);
    };
  }

  /** Sets an effect's volume for the room the player is in. */
  setRoomVolume(fxNo: number, room: number): void {
    const fx = SWORD1_FX[fxNo];
    if (!fx) return;
    const entry = fx.rooms.find((candidate) => candidate.room === room);
    // Volumes are 0..16 in the table, which is the original's scale.
    const level = entry ? (entry.leftVolume + entry.rightVolume) / 2 / 16 : 0;
    for (const voice of this.voices) {
      if (voice.fxNo === fxNo) voice.gain.gain.value = Math.max(0, Math.min(1, level));
    }
  }

  private buffer(sample: SwordSample): AudioBuffer | null {
    if (!this.context) return null;
    const buffer = this.context.createBuffer(sample.channels, sample.frames, sample.sampleRate);
    for (let channel = 0; channel < sample.channels; channel++) {
      const target = buffer.getChannelData(channel);
      for (let frame = 0; frame < sample.frames; frame++) {
        target[frame] = sample.data[frame * sample.channels + channel];
      }
    }
    return buffer;
  }

  private note(message: string): void {
    if (this.notes.length < 30 && !this.notes.includes(message)) this.notes.push(message);
  }

  /** A line for the stall report. */
  describe(): string {
    return (
      `sound: ${this.context ? 'started' : 'not started (needs a gesture)'}, ` +
      `${this.voices.length} effects playing` +
      (this.musicId ? `, music ${this.musicId}` : ', no music') +
      (this.notes.length > 0 ? `; ${this.notes.length} notes` : '')
    );
  }
}
