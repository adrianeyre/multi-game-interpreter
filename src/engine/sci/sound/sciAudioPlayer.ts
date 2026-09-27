/**
 * `DoAudio`: the digital audio a SCI game plays — speech, and the samples it
 * plays beside its music — and the clock scripts read it back through.
 *
 * **What a script needs from this is mostly the clock.** A talker's mouth, a
 * narrator's line and a `PointsSound` all poll `DoAudio(Position)` and move on
 * when it answers -1, so an interpreter that answered nought to everything —
 * which this did — has a game whose every spoken line either never ends or
 * never began. The sound itself goes to the host's `AudioContext` when there
 * is one, and the clock runs the same with or without it.
 *
 * Two shapes, as ScummVM has them:
 *
 * - SCI16's `AudioPlayer` (`engines/sci/sound/audio.cpp`): one sample at a
 *   time, the play counter `PointsSound` watches, a language, a rate and a
 *   volume;
 * - SCI32's `Audio32` (`engines/sci/sound/audio32.cpp`): up to five channels
 *   mixed together, found by resource, each with its own pause, volume, loop
 *   and fade, and the global pause over all of them.
 *
 * One class serves both, with SCI16 limited to a single channel. Positions and
 * durations are in ticks, sixtieths of a second, from the sample's own length:
 * `1 + ms * 60 / 1000` as `Audio32::play` rounds it.
 *
 * Decoding is Sierra's SOL (`engines/sci/sound/decoders/sol.cpp`): raw 8-bit
 * unsigned or 16-bit signed, or DPCM in either width.
 */

import type { SciAudioSample } from './sciAudio.js';

// -------------------------------------------------------------- decoding ---

/** `tableDPCM16`, from `sol.cpp`. */
const DPCM16 = [
  0x0000, 0x0008, 0x0010, 0x0020, 0x0030, 0x0040, 0x0050, 0x0060, 0x0070, 0x0080, 0x0090, 0x00a0,
  0x00b0, 0x00c0, 0x00d0, 0x00e0, 0x00f0, 0x0100, 0x0110, 0x0120, 0x0130, 0x0140, 0x0150, 0x0160,
  0x0170, 0x0180, 0x0190, 0x01a0, 0x01b0, 0x01c0, 0x01d0, 0x01e0, 0x01f0, 0x0200, 0x0208, 0x0210,
  0x0218, 0x0220, 0x0228, 0x0230, 0x0238, 0x0240, 0x0248, 0x0250, 0x0258, 0x0260, 0x0268, 0x0270,
  0x0278, 0x0280, 0x0288, 0x0290, 0x0298, 0x02a0, 0x02a8, 0x02b0, 0x02b8, 0x02c0, 0x02c8, 0x02d0,
  0x02d8, 0x02e0, 0x02e8, 0x02f0, 0x02f8, 0x0300, 0x0308, 0x0310, 0x0318, 0x0320, 0x0328, 0x0330,
  0x0338, 0x0340, 0x0348, 0x0350, 0x0358, 0x0360, 0x0368, 0x0370, 0x0378, 0x0380, 0x0388, 0x0390,
  0x0398, 0x03a0, 0x03a8, 0x03b0, 0x03b8, 0x03c0, 0x03c8, 0x03d0, 0x03d8, 0x03e0, 0x03e8, 0x03f0,
  0x03f8, 0x0400, 0x0440, 0x0480, 0x04c0, 0x0500, 0x0540, 0x0580, 0x05c0, 0x0600, 0x0640, 0x0680,
  0x06c0, 0x0700, 0x0740, 0x0780, 0x07c0, 0x0800, 0x0900, 0x0a00, 0x0b00, 0x0c00, 0x0d00, 0x0e00,
  0x0f00, 0x1000, 0x1400, 0x1800, 0x1c00, 0x2000, 0x3000, 0x4000,
];

/** `tableDPCM8`, the first eight: nibbles 8 to 15 subtract. */
const DPCM8 = [0, 1, 2, 3, 6, 10, 15, 21];

/** A sample's PCM as signed 16-bit, at its own rate. */
export interface SciPcm {
  rate: number;
  samples: Int16Array;
}

/** Decodes a sample body under its header, as `SOLStream::readBuffer` does. */
export function decodeSciAudio(header: SciAudioSample, body: Uint8Array): SciPcm {
  const rate = header.sampleRate || 11025;
  if (header.compressed && header.sixteenBit) {
    const samples = new Int16Array(body.length);
    let sample = 0;
    for (let i = 0; i < body.length; i++) {
      const delta = body[i];
      let next = sample + (delta & 0x80 ? -DPCM16[delta & 0x7f] : DPCM16[delta]);
      // x86 16-bit register overflow, which Sierra's decoder had.
      if (next > 32767) next -= 65536;
      else if (next < -32768) next += 65536;
      samples[i] = sample = next;
    }
    return { rate, samples };
  }
  if (header.compressed) {
    const samples = new Int16Array(body.length * 2);
    let sample = 0x80;
    let at = 0;
    const nibble = (delta: number): void => {
      const last = sample;
      sample = (sample + (delta & 8 ? -DPCM8[delta & 7] : DPCM8[delta & 7])) & 0xff;
      samples[at++] = ((((last + sample) << 7) ^ 0x8000) << 16) >> 16;
    };
    for (const byte of body) {
      nibble(byte >> 4);
      nibble(byte & 0x0f);
    }
    return { rate, samples };
  }
  if (header.sixteenBit) {
    const samples = new Int16Array(body.length >> 1);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = ((body[i * 2] | (body[i * 2 + 1] << 8)) << 16) >> 16;
    }
    return { rate, samples };
  }
  const samples = new Int16Array(body.length);
  for (let i = 0; i < body.length; i++) samples[i] = (body[i] - 128) << 8;
  return { rate, samples };
}

/** A sample's length in ticks, rounded up as `Audio32::play` rounds it. */
export function sciAudioTicks(pcm: SciPcm): number {
  const ms = Math.floor((pcm.samples.length * 1000) / Math.max(1, pcm.rate));
  return Math.min(65534, 1 + Math.floor((ms * 60) / 1000));
}

// ------------------------------------------------------ the audio36 map ---

/** One entry of a per-room audio map: where the speech is, and its sync and rave. */
export interface SciAudio36Entry {
  noun: number;
  verb: number;
  cond: number;
  seq: number;
  /** Where the audio's own header starts, in `RESOURCE.AUD`. */
  offset: number;
  sync?: { offset: number; size: number };
  /** King's Quest VI's hi-res lip-sync data, appended to the sync. */
  rave?: { offset: number; size: number };
}

/**
 * `ResourceManager::readAudioMapSCI11`'s tuple maps, entry by entry.
 *
 * Two shapes. "Early" (EcoQuest CD, SQ4 CD) is fixed-width: the tuple, a
 * 32-bit offset and a 16-bit sync size. "Late" (King's Quest VI CD and every
 * SCI32 game) starts with a 32-bit base and gives each entry a 24-bit
 * **delta** from the last, with a sync size only when the tuple's seq byte
 * has 0x80 set and, for King's Quest VI, a rave size when it has 0x40. The
 * audio itself follows its sync and rave, which is why they are read first.
 *
 * `entrySize` is ScummVM's heuristic — the count of 0xFF bytes the map ends
 * with — which is 11 for the late shape; SCI32 is late by definition.
 */
export function readSciAudio36Index(map: Uint8Array, sci32 = false): SciAudio36Entry[] {
  let entrySize = 11;
  if (!sci32) {
    entrySize = 0;
    for (let i = map.length - 1; i >= 0 && map[i] === 0xff; i--) entrySize++;
  }
  const early = entrySize !== 11;
  const u16 = (at: number): number => (map[at] ?? 0) | ((map[at + 1] ?? 0) << 8);
  const entries: SciAudio36Entry[] = [];
  let at = 0;
  let offset = 0;
  if (!early) {
    offset = (u16(0) | (u16(2) << 16)) >>> 0;
    at = 4;
  }
  while (at + 4 <= map.length) {
    const seqByte = map[at + 3];
    if (seqByte === 0xff) break;
    const entry: SciAudio36Entry = {
      noun: map[at],
      verb: map[at + 1],
      cond: map[at + 2],
      seq: seqByte & 0x3f,
      offset: 0,
    };
    at += 4;
    if (early) {
      offset = (u16(at) | (u16(at + 2) << 16)) >>> 0;
      at += 4;
    } else {
      offset += map[at] | (map[at + 1] << 8) | (map[at + 2] << 16);
      at += 3;
    }
    let syncSize = 0;
    if (early || seqByte & 0x80) {
      syncSize = u16(at);
      at += 2;
      if (syncSize > 0) entry.sync = { offset, size: syncSize };
    }
    // King's Quest VI's rave data. ScummVM reads the flag for that game alone,
    // and never for SCI32, where 0x40 is not a rave and has no size after it.
    if (!early && !sci32 && seqByte & 0x40) {
      const raveSize = u16(at);
      at += 2;
      if (raveSize > 0) {
        entry.rave = { offset: offset + syncSize, size: raveSize };
        syncSize += raveSize;
      }
    }
    entry.offset = offset + syncSize;
    entries.push(entry);
  }
  return entries;
}

// -------------------------------------------------------------- channels ---

/** Where decoded audio goes to be heard, when anything can hear it. */
export interface SciAudioOutput {
  start(
    pcm: SciPcm,
    options: { volume: number; loop: boolean; fromTick: number },
  ): {
    stop(): void;
  } | null;
}

/** What a resource number or tuple resolves to, once read. */
export type SciAudioLookup = SciPcm | null | undefined;

interface Channel {
  id: string;
  pcm: SciPcm;
  duration: number;
  startedAt: number;
  pausedAt: number;
  volume: number;
  loop: boolean;
  fade: { from: number; to: number; startedAt: number; ticks: number; stopAfter: boolean } | null;
  voice: { stop(): void } | null;
}

/** Audio32's `kMaxVolume`, and SCI16's `AUDIO_VOLUME_MAX`. */
export const SCI_AUDIO_MAX_VOLUME = 127;

export class SciAudioChannels {
  /** How many channels may play at once: one for SCI16, five for SCI32. */
  readonly capacity: number;
  /** SCI16's play counter: every `Play`, which `PointsSound` compares. */
  playCounter = 0;
  rate = 11025;
  bitDepth = 8;
  outputChannels = 1;
  preload = 0;
  attenuatedMixing = true;
  volume = SCI_AUDIO_MAX_VOLUME;
  /** SCI1's audio language, -1 until a game sets one. */
  language = -1;

  private readonly channels: Channel[] = [];
  private globalPausedAt = 0;
  /** The channel `hasSignal` listens to, which a play's monitor flag chooses. */
  private monitored: string | null = null;
  private readonly now: () => number;
  private readonly output: SciAudioOutput | null;

  constructor(options: { capacity: number; now: () => number; output?: SciAudioOutput | null }) {
    this.capacity = options.capacity;
    this.now = options.now;
    this.output = options.output ?? null;
  }

  get active(): number {
    this.freeFinished();
    return this.channels.length;
  }

  /**
   * `play`: a channel for this sample, answering its length in ticks — or
   * resuming it when it is already there and paused. `autoPlay` false loads
   * it paused, which is `WPlay` and `WaitForPlay`.
   */
  play(
    id: string,
    pcm: SciPcm,
    options: { autoPlay?: boolean; loop?: boolean; volume?: number; monitor?: boolean } = {},
  ): number {
    this.freeFinished();
    const held = this.channels.find((channel) => channel.id === id);
    if (held) {
      if (held.pausedAt) this.resume(id);
      return held.duration;
    }
    if (this.channels.length >= this.capacity) return 0;
    const now = this.now();
    const volume = options.volume ?? SCI_AUDIO_MAX_VOLUME;
    const channel: Channel = {
      id,
      pcm,
      duration: sciAudioTicks(pcm),
      startedAt: now,
      pausedAt: options.autoPlay === false ? now : 0,
      volume: volume < 0 || volume > SCI_AUDIO_MAX_VOLUME ? SCI_AUDIO_MAX_VOLUME : volume,
      loop: options.loop ?? false,
      fade: null,
      voice: null,
    };
    this.channels.push(channel);
    if (options.monitor) this.monitored = id;
    if (!channel.pausedAt && !this.globalPausedAt) this.voice(channel);
    return channel.duration;
  }

  /** `stop`: one channel, or every one; answers how many were playing. */
  stop(id: string | null = null): number {
    this.freeFinished();
    const count = this.channels.length;
    for (let i = this.channels.length - 1; i >= 0; i--) {
      if (id === null || this.channels[i].id === id) {
        this.channels[i].voice?.stop();
        this.channels.splice(i, 1);
      }
    }
    return count;
  }

  /** `pause`: true when something was playing and now is not. */
  pause(id: string | null = null): boolean {
    const now = this.now();
    if (id === null) {
      if (this.globalPausedAt) return false;
      this.globalPausedAt = now;
      for (const channel of this.channels) this.silence(channel);
      return true;
    }
    const channel = this.find(id);
    if (!channel || channel.pausedAt) return false;
    channel.pausedAt = now;
    this.silence(channel);
    return true;
  }

  /** `resume`: the clock moves on by however long it was stopped. */
  resume(id: string | null = null): boolean {
    const now = this.now();
    if (id === null) {
      if (!this.globalPausedAt) return false;
      for (const channel of this.channels) {
        if (!channel.pausedAt) {
          channel.startedAt += now - this.globalPausedAt;
          this.voice(channel);
        }
      }
      this.globalPausedAt = 0;
      return true;
    }
    const channel = this.find(id);
    if (!channel || !channel.pausedAt) return false;
    channel.startedAt += now - channel.pausedAt;
    channel.pausedAt = 0;
    if (!this.globalPausedAt) this.voice(channel);
    return true;
  }

  /**
   * `getPosition`: ticks since the channel started, or -1 when nothing is
   * playing. With no id, SCI16's one sample or SCI32's first channel.
   */
  position(id: string | null = null): number {
    this.freeFinished();
    const channel = id === null ? this.channels[0] : this.find(id);
    if (!channel) return -1;
    const now = this.now();
    const until = channel.pausedAt || this.globalPausedAt || now;
    return until - channel.startedAt;
  }

  setVolume(id: string | null, volume: number): void {
    const clamped = Math.max(0, Math.min(SCI_AUDIO_MAX_VOLUME, volume));
    if (id === null) this.volume = clamped;
    for (const channel of this.channels)
      if (id === null || channel.id === id) channel.volume = clamped;
  }

  getVolume(id: string | null): number {
    return id === null ? this.volume : (this.find(id)?.volume ?? -1);
  }

  setLoop(id: string, loop: boolean): void {
    const channel = this.find(id);
    if (channel) channel.loop = loop;
  }

  /**
   * `fadeChannel`: toward `volume` over `steps` steps of `speed` ticks,
   * optionally stopping at the end. False when there is no such channel or
   * it is already at that volume.
   */
  fade(id: string, volume: number, speed: number, steps: number, stopAfter: boolean): boolean {
    const channel = this.find(id);
    if (!channel || channel.volume === volume) return false;
    channel.fade = {
      from: channel.volume,
      to: volume,
      startedAt: this.now(),
      ticks: Math.max(1, speed * steps),
      stopAfter,
    };
    return true;
  }

  /**
   * `hasSignal`: whether the *monitored* channel is loud right now — any
   * sample in the last tick's worth above 1280 either way. It is how a SCI32
   * talker without lip-sync data moves its mouth: open while the speech is
   * loud, shut while it is quiet.
   */
  hasSignal(): boolean {
    this.freeFinished();
    const channel = this.monitored === null ? undefined : this.find(this.monitored);
    if (!channel) return false;
    const ticks = Math.max(0, this.position(channel.id));
    const perTick = channel.pcm.rate / 60;
    const from = Math.floor(ticks * perTick);
    const to = Math.min(channel.pcm.samples.length, Math.floor((ticks + 1) * perTick));
    for (let i = from; i < to; i++) {
      const sample = channel.pcm.samples[i];
      if (sample > 1280 || sample < -1280) return true;
    }
    return false;
  }

  has(id: string): boolean {
    return this.find(id) !== undefined;
  }

  /** The first channel's id, for the calls that name none. */
  first(): string | null {
    this.freeFinished();
    return this.channels[0]?.id ?? null;
  }

  private find(id: string): Channel | undefined {
    this.freeFinished();
    return this.channels.find((channel) => channel.id === id);
  }

  /** Channels that have run their length, and fades that have finished, cleared. */
  private freeFinished(): void {
    const now = this.now();
    for (let i = this.channels.length - 1; i >= 0; i--) {
      const channel = this.channels[i];
      if (channel.fade) {
        const done = Math.min(1, (now - channel.fade.startedAt) / channel.fade.ticks);
        channel.volume = Math.round(
          channel.fade.from + (channel.fade.to - channel.fade.from) * done,
        );
        if (done >= 1) {
          const stop = channel.fade.stopAfter;
          channel.fade = null;
          if (stop) {
            channel.voice?.stop();
            this.channels.splice(i, 1);
            continue;
          }
        }
      }
      if (channel.loop || channel.pausedAt || this.globalPausedAt) continue;
      if (now - channel.startedAt >= channel.duration) {
        channel.voice?.stop();
        this.channels.splice(i, 1);
      }
    }
  }

  private voice(channel: Channel): void {
    channel.voice?.stop();
    channel.voice =
      this.output?.start(channel.pcm, {
        volume: (channel.volume * this.volume) / (SCI_AUDIO_MAX_VOLUME * SCI_AUDIO_MAX_VOLUME),
        loop: channel.loop,
        fromTick: this.now() - channel.startedAt,
      }) ?? null;
  }

  private silence(channel: Channel): void {
    channel.voice?.stop();
    channel.voice = null;
  }
}
