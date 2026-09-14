/**
 * Playing what an AGOS game asks for.
 *
 * Reading music and speech and *playing* them are separate pieces of work, and
 * this is the second. What it puts together already existed: the OPL2 core and
 * the AdLib driver that render a MIDI event list to samples, and the browser's
 * own decoder for the re-encoded speech ADR 0028 admits.
 *
 * ## Why rendering is separable from playing
 *
 * Every method that turns bytes into samples is a pure function here, and the
 * audio context is only touched when something is actually played. That is not
 * tidiness: it is what lets the interesting half be tested at all. There is no
 * `AudioContext` in a test runner, and a sound engine that decodes inside
 * `play` can only be checked by a person listening — which
 * `docs/processes/verifying-version-support.md` calls a Tier 2 claim, and Tier
 * 2 cannot be automated.
 *
 * So: `renderMusic` and `decodeSpeech` are testable; `playMusic` and
 * `playSpeech` are the thin part that is not.
 */

import type { EngineSound } from '../../AdventureEngine.js';
import { renderMidiToOpl2 } from '../../sound/renderMusic.js';
import { looksLikeGmf, looksLikeMidiBundle, readAgosMusic } from './music.js';
import { looksLikeXmidi } from './xmidi.js';
import { decodeVoc, decodeWav, speechKind, type DecodedSpeech } from './speech.js';

/** Samples ready to play, at the rate they were rendered for. */
export interface RenderedAudio {
  readonly sampleRate: number;
  readonly samples: Float32Array;
  readonly loop: boolean;
}

export class AgosSound implements EngineSound {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private enabled = true;
  private music: AudioBufferSourceNode | null = null;

  /** Resources whose format nothing here could read, reported once each. */
  readonly unsupported = new Set<string>();

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (this.gain) this.gain.gain.value = enabled ? 0.7 : 0;
    if (!enabled) this.stopMusic();
  }

  /**
   * Starts the audio context, which browsers only allow from a gesture.
   *
   * Tolerates having no `AudioContext` at all rather than throwing: a test
   * runner has none, and an engine that cannot be constructed outside a browser
   * cannot be tested outside one either.
   */
  async resume(): Promise<void> {
    if (typeof AudioContext === 'undefined') return;
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.gain.value = this.enabled ? 0.7 : 0;
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /**
   * Renders a music resource to samples.
   *
   * Returns null rather than throwing when the bytes are not music this reader
   * knows: a game asking for a track in a format nobody has written yet should
   * fall silent and be counted, not stop the game.
   */
  renderMusic(resource: Uint8Array, sampleRate = 44_100): RenderedAudio | null {
    // Any of the three formats AGOS shipped: Adventure Soft's own GMF, the
    // bundle of standard MIDI files the Windows releases replaced it with, or
    // the XMIDI Simon 2 uses. This gate listed two and Simon 2's music is the
    // third, so every one of its thirty-four tracks was refused here before
    // `readAgosMusic` was ever asked.
    if (!looksLikeGmf(resource) && !looksLikeMidiBundle(resource) && !looksLikeXmidi(resource)) {
      this.unsupported.add('music: neither GMF, a MIDI bundle, nor XMIDI');
      return null;
    }
    const music = readAgosMusic(resource);
    if (music.events.length === 0) return null;

    const rendered = renderMidiToOpl2(music, sampleRate);
    return { sampleRate, samples: rendered.samples, loop: music.loop };
  }

  /** Decodes a speech recording, or null when the browser has to do it. */
  decodeSpeech(resource: Uint8Array): DecodedSpeech | null {
    switch (speechKind(resource)) {
      case 'voc':
        return decodeVoc(resource);
      case 'wav':
        return decodeWav(resource);
      case 'browser':
        // MP3, Ogg and FLAC from ScummVM's tools. The browser decodes these,
        // asynchronously, which is why they are not this function's business.
        return null;
      default:
        this.unsupported.add('speech: unrecognised format');
        return null;
    }
  }

  /** Plays a music resource, replacing whatever was playing. */
  playMusic(resource: Uint8Array): boolean {
    const rendered = this.renderMusic(resource);
    if (!rendered) return false;
    return this.play(rendered);
  }

  /**
   * Whether a line of speech is still playing.
   *
   * Tracked because a VGA script can *wait* on it: `IF_SPEECH` branches on
   * whether a voice is still going, which is how a game holds an animation
   * until a character has finished talking. Without this the opcode had nothing
   * to ask and had to answer no, which runs the animation through the line.
   *
   * A count rather than a flag, because two lines can overlap — the decoded
   * path and the browser path both start their own source, and a boolean would
   * be cleared by whichever finished first.
   */
  private speaking = 0;

  /** Whether any speech source started here is still running. */
  get speechActive(): boolean {
    return this.speaking > 0;
  }

  /** Plays one line of speech. */
  async playSpeech(resource: Uint8Array): Promise<boolean> {
    const decoded = this.decodeSpeech(resource);
    if (decoded) {
      return this.play({ ...decoded, loop: false }, { speech: true });
    }

    if (!this.context || speechKind(resource) !== 'browser') return false;
    // `decodeAudioData` wants an ArrayBuffer of its own, not a view into one.
    const copy = resource.slice().buffer as ArrayBuffer;
    const buffer = await this.context.decodeAudioData(copy);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain ?? this.context.destination);
    this.trackSpeech(source);
    source.start();
    return true;
  }

  /**
   * Counts a speech source while it runs.
   *
   * `onended` fires when the buffer runs out *or* when the source is stopped,
   * so the count comes back down either way. A source that never ends would
   * leave `IF_SPEECH` permanently true, which is why this is attached at every
   * place a speech source is started rather than at one of them.
   */
  private trackSpeech(source: AudioBufferSourceNode): void {
    this.speaking += 1;
    this.speechSources.add(source);
    source.addEventListener('ended', () => {
      this.speaking = Math.max(0, this.speaking - 1);
      this.speechSources.delete(source);
    });
  }

  /**
   * The speech sources still running, so a player can cut a line short.
   *
   * Held only for {@link stopSpeech}: the count above answers "is anyone
   * talking", which needs no handles, and this needs the handles themselves.
   * Entries are removed by the same `ended` listener that decrements the count,
   * which fires on a stopped source as well as a finished one — so stopping
   * them leaves the set empty without a second bookkeeping path.
   */
  private readonly speechSources = new Set<AudioBufferSourceNode>();

  /**
   * Stops the line of speech that is playing.
   *
   * `Sound::stopVoice` in the reference, reached when a player asks to skip a
   * line or to leave a sequence. Silent when nothing is playing, which is the
   * normal case — a player pressing the button between two lines has not asked
   * for anything to be undone.
   */
  stopSpeech(): void {
    for (const source of [...this.speechSources]) {
      // A source already finished throws on `stop`, and a source stopped twice
      // does too. Neither is a fault worth propagating to a script.
      try {
        source.stop();
      } catch {
        this.speechSources.delete(source);
      }
    }
  }

  /**
   * Plays one numbered sound effect.
   *
   * Not routed through {@link playSpeech} despite both being VOC, and the
   * difference is `speechActive`: an effect must not make `IF_SPEECH` true, or
   * a script waiting for a character to finish talking would be held by a door
   * closing. So effects are played without being counted as speech.
   *
   * Not routed through {@link playMusic} either, which loops and replaces what
   * is playing — an effect is neither.
   */
  playEffect(resource: Uint8Array): boolean {
    const decoded = this.decodeSpeech(resource);
    if (!decoded) return false;
    return this.play({ ...decoded, loop: false });
  }

  /**
   * Plays a video's audio as it is decoded.
   *
   * Separate from `playMusic` because it must not replace what is looping: a
   * video's sound is a sequence of chunks arriving with its frames, and a
   * chunk that stopped the previous one would produce a cutscene that clicks
   * every frame. Nothing is queued ahead of the picture — Smacker carries each
   * frame's audio with that frame, so the picture is the clock (#288).
   */
  playVideoAudio(samples: Float32Array, sampleRate: number): boolean {
    if (samples.length === 0) return false;
    return this.play({ sampleRate, samples, loop: false });
  }

  stopMusic(): void {
    this.music?.stop();
    this.music = null;
  }

  private play(audio: RenderedAudio, options: { speech?: boolean } = {}): boolean {
    if (!this.context || !this.enabled) return false;
    const buffer = this.context.createBuffer(1, audio.samples.length, audio.sampleRate);
    // A copy, because `copyToChannel` insists on a Float32Array backed by a
    // plain ArrayBuffer and a rendered one may not be.
    buffer.copyToChannel(new Float32Array(audio.samples), 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = audio.loop;
    source.connect(this.gain ?? this.context.destination);
    if (options.speech) this.trackSpeech(source);
    source.start();
    if (audio.loop) {
      this.stopMusic();
      this.music = source;
    }
    return true;
  }
}
