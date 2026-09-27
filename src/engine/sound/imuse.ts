import type { ImusePlayer } from './ImusePlayer.js';

/**
 * iMUSE's command layer: what a script's `soundKludge` asks of the players.
 *
 * A port of the parts of ScummVM's `IMuseInternal::doCommand_internal`
 * (engines/scumm/imuse/imuse.cpp) that need a live sequencer — everything
 * addressed to a player (scope 1), the command queue that waits on score
 * markers, Sam & Max's triggers and deferred commands. The scope-0 commands
 * the sound engine already served itself (start, stop, master volume) stay
 * there; this is the half that was only ever logged.
 *
 * Every command returns a number because the original's does: the result lands
 * in `VAR_SOUNDRESULT`, and some commands exist only to be read back — a
 * player parameter, the queue's trigger count.
 */

/** What the command layer needs of the engine around it. */
export interface ImuseHost {
  /** The playing player for a sound, or null (`findActivePlayer`). */
  player(sound: number): ImusePlayer | null;
  /** Runs a whole command, scope byte and all, as a script would have. */
  run(args: number[]): number;
  /** Whether a sound is playing (`getSoundStatus`). */
  status(sound: number): boolean;
  /** Stops a sound (`stopSound_internal`). */
  stop(sound: number): void;
  log(message: string): void;
}

const QUEUE_SIZE = 64;
const TRIGGER_ID = 0;
const COMMAND_ID = 1;

/** A Sam & Max trigger (`ImTrigger`): a command waiting on a sound's marker. */
interface Trigger {
  sound: number;
  id: number;
  expire: number;
  command: number[];
}

interface Deferred {
  microseconds: number;
  command: number[];
}

/** Microseconds per `step` tick of the deferred-command clock. */
const MICROSECONDS_PER_SECOND = 1_000_000;

/** The command layer's part of a save. */
export interface SavedImuseCommands {
  queue: number[][];
  queuePos: number;
  queueEnd: number;
  queueAdding: boolean;
  queueCleared: boolean;
  queueSound: number;
  queueMarker: number;
  triggerCount: number;
  triggers: Trigger[];
  triggerIndex: number;
  deferred: Deferred[];
  channelVolumes: number[];
  volumeChannels: [number, number][];
}

export class ImuseCommands {
  /**
   * Sam & Max's iMUSE, which renumbers some commands. Set per game; the old
   * system is the default because it is what every other iMUSE title uses.
   */
  newSystem = false;

  private readonly queue: number[][] = Array.from({ length: QUEUE_SIZE }, () =>
    new Array(8).fill(0),
  );
  private queuePos = 0;
  private queueEnd = 0;
  private queueAdding = false;
  private queueCleared = false;
  private queueSound = 0;
  private queueMarker = 0;
  private triggerCount = 0;

  private readonly triggers: Trigger[] = Array.from({ length: 16 }, () => ({
    sound: 0,
    id: 0,
    expire: 0,
    command: [],
  }));
  private triggerIndex = 0;

  private readonly deferred: Deferred[] = [];

  /** Volume channels 0-7 (`_channel_volume`), and which one each sound is on. */
  private readonly channelVolumes = new Array<number>(8).fill(127);
  private readonly volumeChannels = new Map<number, number>();

  constructor(private readonly host: ImuseHost) {}

  // --- scope 0 ------------------------------------------------------------------

  /**
   * The scope-0 commands that belong to the sequencer layer.
   *
   * Returns undefined for a command this layer does not own, so the caller
   * can handle it or name it.
   */
  systemCommand(command: number, a: number[]): number | undefined {
    switch (command) {
      case 12: {
        // Sam & Max: player-scope sub-commands; only 6, volume, exists.
        const player = this.host.player(a[1]);
        if (!player) return -1;
        return a[3] === 6 ? player.setVolume(a[4]) : -1;
      }
      case 13:
        return this.host.status(a[1]) ? 1 : 0;
      case 14: {
        const player = this.host.player(a[1]);
        return player ? player.addParameterFader(a[3], a[4], a[5]) : -1;
      }
      case 15: {
        // Sam & Max: arm the jump hook for a "maybe" jump.
        const player = this.host.player(a[1]);
        if (!player) return -1;
        player.setHook(0, a[3], 0);
        return 0;
      }
      case 16:
        return this.setVolumeChannel(a[1], a[2]);
      case 17:
        if (!this.newSystem) return this.setChannelVolume(a[1], a[2]);
        return a[4] ? this.setTrigger(a[1], a[3], a.slice(4, 12)) : this.clearTrigger(a[1], a[3]);
      case 18:
        // Sam & Max counts triggers; the old system's volume-channel limits
        // table only caps how many players share a channel, which this
        // engine never needs to refuse.
        return this.newSystem ? this.countTriggers(a[1], a[3]) : 0;
      case 19:
        return this.clearTrigger(a[1], a[3]);
      case 20:
        this.defer(a[1], a.slice(2, 8));
        return 0;
      default:
        return undefined;
    }
  }

  // --- scope 1 ------------------------------------------------------------------

  /**
   * A command aimed at the player sequencing one sound.
   *
   * The bitmask is the original's: commands 0-13 and 19-22 need a player and
   * fail with -1 when the sound is not playing; the queue commands do not.
   * Returns undefined for a command number the original does not have.
   */
  playerCommand(command: number, a: number[]): number | undefined {
    const needsPlayer = ((1 << command) & 0x783fff) !== 0;
    const player = needsPlayer ? this.host.player(a[1]) : null;
    if (needsPlayer && !player) return -1;
    const p = player as ImusePlayer;

    switch (command) {
      case 0:
        if (this.newSystem) {
          if (a[3] === 1) return ((p.beatIndex - 1) >> 2) + 1;
          if (a[3] === 2) return p.beatIndex;
          return -1;
        }
        return p.getParam(a[2], a[3]);
      case 1:
        if (this.newSystem) {
          // Sam & Max's jump: measure, beat, tick and a quarter-beat fraction.
          p.jump(a[3] - 1, (a[4] - 1) * 4 + a[5], a[6] + ((a[7] * p.midi.division) >> 2));
        } else {
          p.setPriority(a[2]);
        }
        return 0;
      case 2:
        return p.setVolume(a[2]);
      case 3:
        if (this.newSystem) p.setSpeed(a[3]);
        else p.setPan(a[2]);
        return 0;
      case 4:
        return p.setTranspose(a[2], a[3]);
      case 5:
        // Sam & Max's is a part's volume sensitivity, which a card with no
        // velocity curves here has nothing to apply to.
        if (!this.newSystem) p.setDetune(a[2]);
        return 0;
      case 6:
        p.setSpeed(a[2]);
        return 0;
      case 7:
        return p.jump(a[2], a[3], a[4]) ? 0 : -1;
      case 8:
        return p.scan(a[2], a[3], a[4]);
      case 9:
        return p.setLoop(a[2], a[3], a[4], a[5], a[6]) ? 0 : -1;
      case 10:
        p.clearLoop();
        return 0;
      case 11:
        p.setPartOn(a[2] & 0x0f, a[3] !== 0);
        return 0;
      case 12:
      case 20:
        return p.setHook(a[2], a[3], a[4]);
      case 13:
        return p.addParameterFader(1, a[2], a[3]);
      case 14:
        return this.enqueueTrigger(a[1], a[2]);
      case 15:
        return this.enqueueCommand(a.slice(1, 8));
      case 16:
        return this.clearQueue();
      case 19:
        return p.getParam(a[2], a[3]);
      case 21:
        return -1;
      case 22:
        p.setPartVolume(a[2] & 0x0f, a[3]);
        return 0;
      case 23:
        return this.queryQueue(a[1]);
      case 24:
        return 0;
      default:
        return undefined;
    }
  }

  // --- the queue ----------------------------------------------------------------

  /**
   * `enqueue_trigger`: the queue's next entries wait for a marker.
   *
   * A script queues a trigger and then the commands to run when the music
   * reaches it; `handle_marker` runs them in order when it does. This is how a
   * game lines a transition up with a phrase ending rather than cutting the
   * phrase off.
   */
  private enqueueTrigger(sound: number, marker: number): number {
    const slot = this.queue[this.queuePos];
    slot[0] = TRIGGER_ID;
    slot[1] = sound;
    slot[2] = marker;

    const pos = (this.queuePos + 1) % QUEUE_SIZE;
    if (this.queueEnd === pos) return -1;
    this.queuePos = pos;
    this.queueAdding = true;
    this.queueSound = sound;
    this.queueMarker = marker;
    return 0;
  }

  /** `enqueue_command`: `-1` closes the list the last trigger started. */
  private enqueueCommand(command: number[]): number {
    if (this.queuePos === this.queueEnd) return -1;
    if (command[0] === -1) {
      this.queueAdding = false;
      this.triggerCount++;
      return 0;
    }
    const slot = this.queue[this.queuePos];
    slot[0] = COMMAND_ID;
    for (let i = 0; i < 7; i++) slot[i + 1] = command[i] ?? 0;

    const pos = (this.queuePos + 1) % QUEUE_SIZE;
    if (this.queueEnd === pos) return -1;
    this.queuePos = pos;
    return 0;
  }

  private clearQueue(): number {
    this.queueAdding = false;
    this.queueCleared = true;
    this.queuePos = 0;
    this.queueEnd = 0;
    this.triggerCount = 0;
    return 0;
  }

  private queryQueue(param: number): number {
    switch (param) {
      case 0:
        return this.triggerCount;
      case 1:
        return this.queueEnd === this.queuePos ? -1 : this.queue[this.queueEnd][1];
      case 2:
        return this.queueEnd === this.queuePos ? 0xff : this.queue[this.queueEnd][2];
      default:
        return -1;
    }
  }

  /**
   * A player reached a marker (`handle_marker`).
   *
   * Only the trigger at the head of the queue is considered, and only once the
   * script has finished queueing its commands — a marker passed while the
   * list is still being written would run half of it.
   */
  marker(sound: number, marker: number): void {
    if (this.queueEnd === this.queuePos) return;
    if (this.queueAdding && this.queueSound === sound && marker === this.queueMarker) return;

    const head = this.queue[this.queueEnd];
    if (head[0] !== TRIGGER_ID || head[1] !== sound || head[2] !== marker) return;

    this.triggerCount--;
    this.queueCleared = false;
    this.queueEnd = (this.queueEnd + 1) % QUEUE_SIZE;

    while (
      this.queueEnd !== this.queuePos &&
      this.queue[this.queueEnd][0] === COMMAND_ID &&
      !this.queueCleared
    ) {
      const command = this.queue[this.queueEnd].slice(1, 8);
      this.queueEnd = (this.queueEnd + 1) % QUEUE_SIZE;
      this.host.run(command);
    }
  }

  // --- Sam & Max triggers --------------------------------------------------------

  /**
   * `ImSetTrigger`: run a command when a sound reaches a marker.
   *
   * Sixteen slots, the oldest recycled when they run out. A trigger that
   * starts a sound stops that sound first if both are playing — the fix
   * ScummVM carries for the carnival music.
   */
  private setTrigger(sound: number, id: number, command: number[]): number {
    let slot = this.triggers.find(
      (trigger) =>
        !trigger.id ||
        (trigger.id === id && trigger.sound === sound && trigger.command[0] === command[0]),
    );
    if (!slot) {
      let oldest: Trigger | null = null;
      let age = -1;
      for (const trigger of this.triggers) {
        const diff = (this.triggerIndex - trigger.expire) & 0xffff;
        if (diff > age) {
          age = diff;
          oldest = trigger;
        }
      }
      if (!oldest) return -1;
      slot = oldest;
    }

    slot.id = id;
    slot.sound = sound;
    slot.expire = ++this.triggerIndex & 0xffff;
    slot.command = [...command, 0, 0, 0, 0, 0, 0, 0, 0].slice(0, 8);

    if (slot.command[0] === 8 && this.host.status(slot.command[1]) && this.host.status(sound)) {
      this.host.stop(slot.command[1]);
    }
    return 0;
  }

  private clearTrigger(sound: number, id: number): number {
    let count = 0;
    for (const trigger of this.triggers) {
      if (
        (sound === -1 || trigger.sound === sound) &&
        trigger.id &&
        (id === -1 || trigger.id === id)
      ) {
        trigger.sound = 0;
        trigger.id = 0;
        count++;
      }
    }
    return count > 0 ? 0 : -1;
  }

  private countTriggers(sound: number, id: number): number {
    return this.triggers.filter(
      (trigger) => trigger.sound === sound && trigger.id && (id === -1 || trigger.id === id),
    ).length;
  }

  /** Sam & Max's trigger event (sysex 0): the first matching trigger fires. */
  triggerEvent(sound: number, id: number): void {
    const trigger = this.triggers.find((t) => t.sound === sound && t.id === id);
    if (!trigger) return;
    trigger.sound = 0;
    trigger.id = 0;
    this.host.run(trigger.command);
  }

  /**
   * A sound stopped (`ImFireAllTriggers`): its remaining triggers fire.
   *
   * A trigger hung on a marker the music never reached still means "when this
   * is over", so stopping is when it runs — not a reason to drop it.
   */
  soundEnded(sound: number): void {
    if (!sound) return;
    const due = this.triggers.filter((trigger) => trigger.sound === sound);
    for (const trigger of due) {
      trigger.sound = 0;
      trigger.id = 0;
    }
    for (const trigger of due) this.host.run(trigger.command);
  }

  // --- deferred commands -----------------------------------------------------------

  /**
   * `addDeferredCommand`: run a command after `time` hundredths of a second.
   *
   * Four slots, as the original has; a fifth, or a time of zero — which the
   * original stores as an empty slot — is dropped.
   */
  private defer(time: number, command: number[]): void {
    if (this.deferred.length >= 4 || time <= 0) return;
    this.deferred.push({ microseconds: time * 10_000, command });
  }

  /** Advances the deferred-command clock by one frame's worth of time. */
  step(seconds: number): void {
    if (this.deferred.length === 0) return;
    const elapsed = seconds * MICROSECONDS_PER_SECOND;
    const due: Deferred[] = [];
    for (const entry of this.deferred) {
      entry.microseconds -= elapsed;
      if (entry.microseconds <= 0) due.push(entry);
    }
    for (const entry of due) this.deferred.splice(this.deferred.indexOf(entry), 1);
    for (const entry of due) this.host.run(entry.command);
  }

  // --- volume channels --------------------------------------------------------------

  /** `set_channel_volume`: the old system's eight volume channels. */
  private setChannelVolume(channel: number, volume: number): number {
    if (channel >= 8 || channel < 0 || volume > 127 || volume < 0) return -1;
    this.channelVolumes[channel] = volume;
    for (const [sound, assigned] of this.volumeChannels) {
      if (assigned === channel) this.host.player(sound)?.setChannelVolume(volume);
    }
    return 0;
  }

  /** `set_volchan`: puts a sound on a volume channel, or back on the master. */
  private setVolumeChannel(sound: number, channel: number): number {
    const player = this.host.player(sound);
    if (channel >= 8 || channel < 0) {
      this.volumeChannels.delete(sound);
      player?.setChannelVolume(127);
      return 0;
    }
    this.volumeChannels.set(sound, channel);
    player?.setChannelVolume(this.channelVolumes[channel]);
    return 0;
  }

  /** Everything the layer holds, as plain data (`saveLoadIMuse`'s share). */
  save(): SavedImuseCommands {
    return {
      queue: this.queue.map((entry) => [...entry]),
      queuePos: this.queuePos,
      queueEnd: this.queueEnd,
      queueAdding: this.queueAdding,
      queueCleared: this.queueCleared,
      queueSound: this.queueSound,
      queueMarker: this.queueMarker,
      triggerCount: this.triggerCount,
      triggers: this.triggers.map((trigger) => ({ ...trigger, command: [...trigger.command] })),
      triggerIndex: this.triggerIndex,
      deferred: this.deferred.map((entry) => ({ ...entry, command: [...entry.command] })),
      channelVolumes: [...this.channelVolumes],
      volumeChannels: [...this.volumeChannels],
    };
  }

  restore(saved: SavedImuseCommands | undefined): void {
    if (!saved) return;
    saved.queue.forEach((entry, i) => {
      if (this.queue[i]) this.queue[i] = [...entry];
    });
    this.queuePos = saved.queuePos;
    this.queueEnd = saved.queueEnd;
    this.queueAdding = saved.queueAdding;
    this.queueCleared = saved.queueCleared;
    this.queueSound = saved.queueSound;
    this.queueMarker = saved.queueMarker;
    this.triggerCount = saved.triggerCount;
    saved.triggers.forEach((trigger, i) => {
      if (this.triggers[i]) this.triggers[i] = { ...trigger, command: [...trigger.command] };
    });
    this.triggerIndex = saved.triggerIndex;
    this.deferred.splice(
      0,
      this.deferred.length,
      ...saved.deferred.map((entry) => ({ ...entry, command: [...entry.command] })),
    );
    saved.channelVolumes.forEach((volume, i) => (this.channelVolumes[i] = volume));
    this.volumeChannels.clear();
    for (const [sound, channel] of saved.volumeChannels) this.volumeChannels.set(sound, channel);
  }

  /** The volume channel level a newly started sound should take. */
  channelVolumeFor(sound: number): number {
    const channel = this.volumeChannels.get(sound);
    return channel === undefined ? 127 : this.channelVolumes[channel];
  }
}
