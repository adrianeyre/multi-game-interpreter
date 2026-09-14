/**
 * Broken Sword II's sound: effects, music and speech, all WAVE.
 *
 * Simpler than Sword1's, and for a good reason: Sword2 keeps its samples as
 * ordinary `WAV_FILE` resources inside its clusters, and its speech is a WAVE
 * whose data chunk holds the same 16-bit RLE Sword1 uses. So the decoders are
 * shared (`sword1/sound/swordAudio.ts`) rather than duplicated — the *format*
 * is genuinely the same even though nothing else about the two engines is, and
 * pretending otherwise would mean two copies of one RLE.
 *
 * That is the only thing the two families share in this project, and it is
 * shared at the level of a pure decoder rather than at the level of an engine.
 */

import type { EngineSound } from '../../AdventureEngine.js';
import {
  parseWave,
  speechSample,
  SwordAudioError,
  type SwordSample,
} from '../../sword1/sound/swordAudio.js';
import type { Sword2Resources } from '../resource/Sword2Resources.js';
import { Sword2FileType } from '../resource/sword2Headers.js';

interface Voice {
  readonly resource: number;
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

export class Sword2Sound implements EngineSound {
  private enabled = true;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;

  private readonly samples = new Map<number, SwordSample | null>();
  private readonly voices: Voice[] = [];
  private readonly wanted = new Set<number>();

  private speechDone = true;
  private speechPending: number | null = null;
  private speechVoice: AudioBufferSourceNode | null = null;

  private musicVoice: AudioBufferSourceNode | null = null;
  private musicResource = 0;
  private musicLooping = false;

  readonly notes: string[] = [];

  constructor(private readonly resources: Sword2Resources) {}

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
   * `fnPlayFx`: queue an effect. Returns what the script should see.
   *
   * `volume` and `pan` are the script's own 0..16 and -16..16, which is why
   * they are scaled here rather than passed through: a gain of 16 would be
   * sixteen times too loud.
   */
  playFx(resource: number, volume: number, pan: number, type: number): number {
    const sample = this.samples.get(resource);
    if (sample === undefined) {
      this.wanted.add(resource);
      return 0;
    }
    if (sample === null) return 0;
    this.start(resource, sample, type === 1, volume, pan);
    return 1;
  }

  stopFx(slot: number): void {
    // The script's slot is an index into its own queue, which this project does
    // not model — so a stop with a slot stops everything a spot effect started,
    // which is the behaviour a player notices and the slot is not.
    void slot;
    for (const voice of [...this.voices]) {
      try {
        voice.source.stop();
      } catch {
        // Already finished.
      }
    }
    this.voices.length = 0;
  }

  playMusic(resource: number, looped: boolean): void {
    this.musicResource = resource;
    this.musicLooping = looped;
    void this.startMusic(resource, looped);
  }

  /**
   * The music a save should record, which is the looping music and not any
   * music.
   *
   * ScummVM keeps `_loopingMusicId` apart from what is playing for the same
   * reason (`sound.cpp`): a one-shot cue is a moment, and a restored room
   * should come back playing the room's music rather than replaying a moment
   * that happened to be sounding when the player pressed save.
   */
  get loopingMusic(): number {
    return this.musicLooping ? this.musicResource : 0;
  }

  stopMusic(): void {
    this.musicResource = 0;
    this.musicLooping = false;
    if (this.musicVoice) {
      try {
        this.musicVoice.stop();
      } catch {
        // Already finished.
      }
      this.musicVoice = null;
    }
  }

  /** Requests a line of speech. False means the driver counts it down instead. */
  requestSpeech(textId: number): boolean {
    this.speechDone = false;
    this.speechPending = textId;
    return false;
  }

  speechFinished(): boolean {
    return this.speechDone;
  }

  /** Cuts the current line short, which is what a click does. */
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

  /** The asynchronous half: decodes what a cycle asked for. */
  async pump(): Promise<void> {
    for (const resource of [...this.wanted]) {
      this.wanted.delete(resource);
      if (this.samples.has(resource)) continue;
      const loaded = await this.resources.load(resource);
      if (!loaded) {
        this.samples.set(resource, null);
        this.note(`effect ${resource}: ${this.resources.describeMissingResource(resource)}`);
        continue;
      }
      try {
        // A `WAV_FILE` resource's payload is a whole RIFF file, header and all.
        this.samples.set(resource, parseWave(loaded.payload));
      } catch (error) {
        this.samples.set(resource, null);
        this.note(
          `effect ${resource} would not decode: ` +
            (error instanceof SwordAudioError ? error.message : String(error)),
        );
      }
    }

    if (this.speechPending !== null) {
      const textId = this.speechPending;
      this.speechPending = null;
      await this.loadSpeech(textId);
    }
  }

  /**
   * Reads and plays one speech line from a speech cluster.
   *
   * The line's resource id *is* its text id, which is the tidiest thing about
   * this format: a script asks for text 1234 and the sample is resource 1234 in
   * a speech cluster. Read by range, because a speech cluster is ~100 MB.
   */
  private async loadSpeech(textId: number): Promise<void> {
    const resource = await this.resources.loadStreamed(textId);
    if (!resource) {
      this.speechDone = true;
      return;
    }
    if (resource.header.fileType !== Sword2FileType.WAV_FILE) {
      this.speechDone = true;
      return;
    }
    try {
      const sample = speechSample(resource.payload);
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
    } catch (error) {
      this.note(
        `speech ${textId} would not decode: ` +
          (error instanceof SwordAudioError ? error.message : String(error)),
      );
      this.speechDone = true;
    }
  }

  private async startMusic(resource: number, looped: boolean): Promise<void> {
    const loaded = await this.resources.loadStreamed(resource);
    if (!loaded) return;
    let sample: SwordSample;
    try {
      sample = parseWave(loaded.payload);
    } catch {
      // Music in the retail release is a compressed stream this project does
      // not decode, so a failure here is expected and is a note rather than a
      // fault.
      this.note(`music ${resource} is not plain WAVE, so it is not played`);
      return;
    }
    const buffer = this.buffer(sample);
    if (!buffer || !this.context || !this.master) return;
    this.stopMusic();
    this.musicResource = resource;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = looped;
    source.connect(this.master);
    source.start();
    this.musicVoice = source;
  }

  private start(
    resource: number,
    sample: SwordSample,
    loop: boolean,
    volume: number,
    pan: number,
  ): void {
    const buffer = this.buffer(sample);
    if (!buffer || !this.context || !this.master) return;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = loop;
    const gain = this.context.createGain();
    gain.gain.value = Math.max(0, Math.min(1, volume / 16));
    if (typeof this.context.createStereoPanner === 'function') {
      const panner = this.context.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan / 16));
      source.connect(gain);
      gain.connect(panner);
      panner.connect(this.master);
    } else {
      source.connect(gain);
      gain.connect(this.master);
    }
    source.start();
    const voice: Voice = { resource, source, gain };
    this.voices.push(voice);
    source.onended = (): void => {
      const at = this.voices.indexOf(voice);
      if (at >= 0) this.voices.splice(at, 1);
    };
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

  describe(): string {
    return (
      `sound: ${this.context ? 'started' : 'not started (needs a gesture)'}, ` +
      `${this.voices.length} effects playing` +
      (this.musicResource ? `, music ${this.musicResource}` : ', no music') +
      (this.notes.length > 0 ? `; ${this.notes.length} notes` : '')
    );
  }
}
