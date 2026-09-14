/**
 * iMUSE Digital's script commands, as v7's `soundKludge` delivers them.
 *
 * v7 shares v6's `soundKludge` opcode and nothing else about it. v6's first
 * argument packs two bytes: a *scope* in the high one and a command in the low
 * one, and the commands address a MIDI sequencer — start this player, jump that
 * one to a marker. v7's first argument is a single sixteen-bit command number
 * addressed at iMUSE **Digital**, which streams recorded audio and has no
 * sequencer to talk to.
 *
 * Reading a v7 command through v6's split is how The Dig's `0x1000` — "set the
 * musical state" — arrived as "command 0, scope 16" and was reported
 * unimplemented: the number was never a scope and a command, so no amount of
 * work on a scope-16 branch would ever have found it.
 *
 * (`IMuseDigital::parseScriptCmds`.)
 */
export const DIGITAL_COMMAND = {
  StopAllSounds: 10,
  SetParam: 12,
  FadeParam: 14,
  /** Begins a sound as a stream. The Dig's demo uses it for its first state. */
  StartStream: 25,
  SwitchStream: 26,
  SetState: 0x1000,
  SetSequence: 0x1001,
  SetCuePoint: 0x1002,
  SetAttribute: 0x1003,
  SetSfxGroupVolume: 0x2000,
  SetVoiceGroupVolume: 0x2001,
  SetMusicGroupVolume: 0x2002,
} as const;

/**
 * The parameters `SetParam` and `FadeParam` address, by their own numbering.
 *
 * The low byte is always zero, which is why a param arrives as 1536 rather
 * than 6 and reads as nonsense in a log that does not name it.
 */
export const DIGITAL_PARAM = {
  Group: 0x400,
  Priority: 0x500,
  Volume: 0x600,
  Pan: 0x700,
  Detune: 0x800,
  Transpose: 0x900,
  Mailbox: 0xa00,
} as const;

/** The mixer groups a sound can belong to. Group 0 is the master. */
export const DIGITAL_GROUP = {
  Master: 0,
  Sfx: 1,
  Speech: 2,
  Music: 3,
  MusicEffects: 4,
} as const;

/** As many groups as the original allocates, and the reason 16 is the bound. */
const GROUP_COUNT = 16;

/** Every volume in iMUSE Digital is 0..127, group volumes included. */
const MAX_VOLUME = 127;

/** Pan is 0..127 with 64 at the centre, so the two halves are not symmetric. */
const PAN_CENTRE = 64;

/** Fades are counted by the 60 Hz timer the fade handler runs on. */
const FADE_HZ = 60;

/**
 * The audio side of iMUSE Digital, kept to what the dispatch actually asks for.
 *
 * The same seam idea as `MusicSource` (ADR 0008): the command dispatch is a
 * pile of numbering and precedence rules that can be read against the reference
 * and tested without an `AudioContext`, and the part that cannot be tested that
 * way is these seven methods.
 */
export interface DigitalAudio {
  /** Plays a cue as a looping musical state. False when there is no cue. */
  playMusicCue(id: number): boolean;
  /** Plays a cue once, as a sound effect. False when there is no cue. */
  playStreamCue(id: number): boolean;
  stop(id: number): void;
  stopAll(): void;
  /** Sets one sound's level, 0..1. */
  setLevel(id: number, level: number): void;
  /** Ramps one sound's level to a target over `seconds`. */
  fadeLevel(id: number, level: number, seconds: number): void;
  /** Sets one sound's pan, -1 (left) to 1 (right). */
  setPan(id: number, pan: number): void;
  /** Ramps one sound's pan to a target over `seconds`. */
  fadePan(id: number, pan: number, seconds: number): void;
}

/**
 * iMUSE Digital's script-command dispatch, and the mixer state it keeps.
 *
 * Two things live here that look like they belong lower down. Group volumes do,
 * because a sound's audible level is the product of its own volume and its
 * group's and the master's, so nothing can set a level correctly without all
 * three. Musical state and sequence do, because they are a *precedence* rule —
 * a sequence overrides a state until it ends — rather than anything to do with
 * audio.
 */
export class DigitalImuse {
  constructor(
    private readonly audio: DigitalAudio,
    private readonly onLog: (message: string) => void,
  ) {}

  /**
   * A group's own volume, 0..127. All start at full, as the original's do.
   *
   * Index 0 is the master rather than a group of its own, which is why setting
   * it has to recompute every other entry.
   */
  private readonly groupVolumes = new Uint8Array(GROUP_COUNT).fill(MAX_VOLUME);

  /** A group's volume once the master has been applied to it. */
  private readonly effectiveGroupVolumes = new Uint8Array(GROUP_COUNT).fill(MAX_VOLUME);

  /** A sound's own volume, 0..127, for the ones a script has set. */
  private readonly volumes = new Map<number, number>();

  /** Which group a sound mixes in. Unset means the master. */
  private readonly groups = new Map<number, number>();

  /**
   * A sound's priority, which is recorded and not acted on.
   *
   * Priority decides which sound loses its channel when the original runs out
   * of them; Web Audio has no such limit, so there is nothing to decide. Kept
   * because a script sets it and `GetParam` reads it back.
   */
  private readonly priorities = new Map<number, number>();

  /**
   * The Dig's music attributes, which its state table reads.
   *
   * A map rather than an array because the original's size (188 entries, split
   * between states and sequences) is a fact about The Dig's table, and that
   * table is not here yet — see `reportMissingMusicTable`. Full Throttle sets
   * one attribute at start-up and never reads it.
   */
  private readonly attributes = new Map<number, number>();

  /** The musical state the game has asked for, and the sequence over it. */
  private state = 0;
  private sequence = 0;
  private cuePoint = 0;

  /** The cue currently playing as music, so entering a new state can stop it. */
  private playingCue: number | null = null;

  /** Acts on one command. The first argument is the command number itself. */
  command(args: number[]): void {
    if (args.length === 0) return;

    switch (args[0]) {
      case DIGITAL_COMMAND.StopAllSounds:
        this.playingCue = null;
        this.audio.stopAll();
        return;
      case DIGITAL_COMMAND.SetParam:
        this.setParam(args[1] ?? 0, args[2] ?? 0, args[3] ?? 0);
        return;
      case DIGITAL_COMMAND.FadeParam:
        this.fadeParam(args[1] ?? 0, args[2] ?? 0, args[3] ?? 0, args[4] ?? 0);
        return;
      case DIGITAL_COMMAND.StartStream:
        this.startStream(args[1] ?? 0);
        return;
      case DIGITAL_COMMAND.SwitchStream:
        this.switchStream(args[1] ?? 0, args[2] ?? 0);
        return;
      case DIGITAL_COMMAND.SetState:
        this.setState(args[1] ?? 0);
        return;
      case DIGITAL_COMMAND.SetSequence:
        this.setSequence(args[1] ?? 0);
        return;
      case DIGITAL_COMMAND.SetCuePoint:
        this.setCuePoint(args[1] ?? 0);
        return;
      case DIGITAL_COMMAND.SetAttribute:
        // Index then value, unlike every other command here, whose second
        // argument is a sound number.
        this.attributes.set(args[1] ?? 0, args[2] ?? 0);
        return;
      case DIGITAL_COMMAND.SetSfxGroupVolume:
        this.setGroupVolume(DIGITAL_GROUP.Sfx, args[1] ?? 0);
        return;
      case DIGITAL_COMMAND.SetVoiceGroupVolume:
        this.setGroupVolume(DIGITAL_GROUP.Speech, args[1] ?? 0);
        return;
      case DIGITAL_COMMAND.SetMusicGroupVolume:
        this.setGroupVolume(DIGITAL_GROUP.Music, args[1] ?? 0);
        return;
      default:
        this.reportUnhandled(args);
    }
  }

  /** What a script last set an attribute to, or 0. The Dig's table reads it. */
  attribute(index: number): number {
    return this.attributes.get(index) ?? 0;
  }

  /** The state, sequence and cue point a script has asked for. */
  get musicState(): { state: number; sequence: number; cuePoint: number } {
    return { state: this.state, sequence: this.sequence, cuePoint: this.cuePoint };
  }

  /** A group's volume once the master has been applied, 0..127. */
  groupVolume(group: number): number {
    if (group < 0 || group >= GROUP_COUNT) return 0;
    return this.effectiveGroupVolumes[group];
  }

  /**
   * Sets a group's volume, and recomputes what depends on it.
   *
   * The master is group 0 and is not a group: setting it rescales every other
   * group rather than mixing alongside them.
   */
  setGroupVolume(group: number, volume: number): void {
    if (group < 0 || group >= GROUP_COUNT) return;
    if (volume < 0 || volume > MAX_VOLUME) return;

    this.groupVolumes[group] = volume;
    if (group === DIGITAL_GROUP.Master) {
      this.effectiveGroupVolumes[0] = volume;
      for (let i = 1; i < GROUP_COUNT; i++) {
        this.effectiveGroupVolumes[i] = (volume * (this.groupVolumes[i] + 1)) >> 7;
      }
    } else {
      this.effectiveGroupVolumes[group] = (this.groupVolumes[0] * (volume + 1)) >> 7;
    }

    // Every sound in the group is now at the wrong level, including the ones a
    // script never set a volume on: their group moved under them.
    for (const id of this.soundsInGroup(group)) this.audio.setLevel(id, this.levelOf(id));
  }

  private soundsInGroup(group: number): number[] {
    const known = new Set([...this.volumes.keys(), ...this.groups.keys()]);
    if (group === DIGITAL_GROUP.Master) return [...known];
    return [...known].filter((id) => (this.groups.get(id) ?? DIGITAL_GROUP.Master) === group);
  }

  /**
   * A sound's audible level, 0..1.
   *
   * The product of its own volume and its group's effective one, in the
   * original's arithmetic: `(vol + 1) * groupVol / 128`. The `+ 1` is why a
   * sound at volume 127 in a group at 127 comes out at 127 rather than 126.
   */
  private levelOf(id: number): number {
    const volume = this.volumes.get(id) ?? MAX_VOLUME;
    const group = this.groups.get(id) ?? DIGITAL_GROUP.Master;
    const effective = ((volume + 1) * this.effectiveGroupVolumes[group]) >> 7;
    return Math.min(1, effective / MAX_VOLUME);
  }

  private setParam(id: number, param: number, value: number): void {
    switch (param) {
      case DIGITAL_PARAM.Group:
        if (value < 0 || value >= GROUP_COUNT) return;
        this.groups.set(id, value);
        this.audio.setLevel(id, this.levelOf(id));
        return;
      case DIGITAL_PARAM.Volume:
        if (value < 0 || value > MAX_VOLUME) return;
        this.volumes.set(id, value);
        this.audio.setLevel(id, this.levelOf(id));
        return;
      case DIGITAL_PARAM.Pan:
        if (value < 0 || value > MAX_VOLUME) return;
        this.audio.setPan(id, DigitalImuse.panOf(value));
        return;
      case DIGITAL_PARAM.Priority:
        if (value < 0 || value > MAX_VOLUME) return;
        this.priorities.set(id, value);
        return;
      default:
        this.reportUnhandledParam(param, id, value);
    }
  }

  /**
   * Pan as Web Audio wants it, -1 to 1, from iMUSE's 0..127 with 64 centred.
   *
   * Dividing by 64 rather than by 63 on the right keeps the centre where the
   * original puts it; the cost is that hard right is 63/64 rather than 1, which
   * is the same asymmetry the original's own table has.
   */
  private static panOf(value: number): number {
    return Math.max(-1, Math.min(1, (value - PAN_CENTRE) / PAN_CENTRE));
  }

  /**
   * Ramps a parameter to a value over `length` sixtieths of a second.
   *
   * A zero length is a set rather than a fade, and a zero-length fade of the
   * volume *to* zero stops the sound outright — which is how a script ends a
   * piece of music, so treating it as "set the volume to nothing" would leave
   * the sound running silently and `isSoundRunning` answering yes forever.
   */
  private fadeParam(id: number, param: number, value: number, length: number): void {
    if (id === 0 || length < 0) return;

    const fadeable =
      param === DIGITAL_PARAM.Volume ||
      param === DIGITAL_PARAM.Pan ||
      param === DIGITAL_PARAM.Priority ||
      param === DIGITAL_PARAM.Detune;
    if (!fadeable) {
      this.reportUnhandledParam(param, id, value);
      return;
    }

    if (length === 0) {
      if (param === DIGITAL_PARAM.Volume && value === 0) {
        if (this.playingCue === id) this.playingCue = null;
        this.audio.stop(id);
      } else {
        this.setParam(id, param, value);
      }
      return;
    }

    const seconds = length / FADE_HZ;
    if (param === DIGITAL_PARAM.Volume) {
      if (value < 0 || value > MAX_VOLUME) return;
      this.volumes.set(id, value);
      this.audio.fadeLevel(id, this.levelOf(id), seconds);
      return;
    }
    if (param === DIGITAL_PARAM.Pan) {
      if (value < 0 || value > MAX_VOLUME) return;
      this.audio.fadePan(id, DigitalImuse.panOf(value), seconds);
      return;
    }

    // Priority and detune have nowhere to ramp to: neither changes anything
    // audible here, so the fade's destination is all there is to record.
    this.setParam(id, param, value);
  }

  /**
   * Begins a sound as a music stream.
   *
   * The Dig's demo uses this in place of its first `SetState`, which is why it
   * is worth having before the music tables are: the demo names the cue
   * outright rather than through a state.
   *
   * Full Throttle instead opens a fixed cue by *name* — `kstand` — and ignores
   * the number, which needs a name-to-number lookup this has no way to check
   * against a release that ships no bundles.
   */
  private startStream(id: number): void {
    if (id === 0) return;
    if (this.audio.playMusicCue(id)) {
      this.playingCue = id;
      this.audio.setLevel(id, this.levelOf(id));
      return;
    }
    this.reportMissingCue('startStream', id);
  }

  /**
   * Replaces one music stream with another.
   *
   * The original crossfades through a buffer it carries for the purpose; this
   * cuts, because the buffer is a property of its streaming mixer rather than
   * of the command.
   */
  private switchStream(from: number, to: number): void {
    if (from !== 0) this.audio.stop(from);
    if (this.playingCue === from) this.playingCue = null;
    if (to === 0) return;
    this.startStream(to);
  }

  /**
   * Enters a musical state.
   *
   * A state lasts as long as the game is in it, so re-entering the one already
   * playing has to do nothing — restarting the piece from the top on every
   * script that re-asserts the state is heard as a stutter. And a *sequence*
   * overrides a state while it runs: the state is recorded and takes effect
   * when the sequence ends.
   */
  private setState(id: number): void {
    if (id === this.state) return;
    this.state = id;
    if (this.sequence !== 0) return;
    this.enter(id, 'state');
  }

  /**
   * Starts or ends a musical sequence, which overrides the state while it runs.
   *
   * Sequence 0 is "no sequence": it returns to whatever state the game is in,
   * which is why the state has to have been recorded rather than acted on.
   */
  private setSequence(id: number): void {
    if (id === this.sequence) return;
    this.sequence = id;
    this.cuePoint = 0;
    this.enter(id !== 0 ? id : this.state, id !== 0 ? 'sequence' : 'state');
  }

  /**
   * Moves within a sequence, for the four cue points each one has.
   *
   * Which piece a cue point names comes out of the per-game sequence table, so
   * this records the cue and says once that the table is missing rather than
   * playing the wrong quarter of it.
   */
  private setCuePoint(id: number): void {
    if (id > 3) return;
    if (id === this.cuePoint) return;
    this.cuePoint = id;
    if (this.sequence === 0) return;
    this.reportMissingMusicTable('cue point', id);
  }

  /** Stops what is playing and starts the cue a state or sequence names. */
  private enter(id: number, kind: 'state' | 'sequence'): void {
    if (this.playingCue !== null && this.playingCue !== id) {
      this.audio.stop(this.playingCue);
      this.playingCue = null;
    }
    if (id === 0) return;

    // The index's audio-name table may happen to name a cue for the number, in
    // which case there is nothing to look up: a state whose number is a cue
    // number plays without a table.
    if (this.audio.playMusicCue(id)) {
      this.playingCue = id;
      this.audio.setLevel(id, this.levelOf(id));
      return;
    }
    this.reportMissingMusicTable(kind, id);
  }

  private readonly reported = new Set<string>();

  /** Said once per distinct thing: a game re-asserts a state every frame. */
  private sayOnce(key: string, message: string): void {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.onLog(message);
  }

  private reportMissingMusicTable(kind: string, id: number): void {
    this.sayOnce(
      `table:${kind}`,
      `A script asked iMUSE Digital for music ${kind} ${id}, and the index names no ` +
        `bundle cue for that number. Which recording a ${kind} plays comes out of a ` +
        `table built into the original interpreter, one per game, and those tables are ` +
        `not here yet — so the command was recorded and no music changed.`,
    );
  }

  private reportMissingCue(command: string, id: number): void {
    this.sayOnce(
      `cue:${command}`,
      `iMUSE Digital's ${command} asked for sound ${id}, and the index names no bundle ` +
        `cue for that number, so nothing played. A release that ships no audio bundles — ` +
        `a demo, or an incomplete copy — has nothing here to play.`,
    );
  }

  private reportUnhandledParam(param: number, id: number, value: number): void {
    this.sayOnce(
      `param:${param}`,
      `iMUSE Digital parameter 0x${param.toString(16)} is not implemented, so sound ${id} ` +
        `will not follow the game here. Wanted value: ${value}`,
    );
  }

  private reportUnhandled(args: number[]): void {
    this.sayOnce(
      `command:${args[0]}`,
      `iMUSE Digital command ${args[0]} (0x${args[0].toString(16)}) is not implemented, ` +
        `so the music will not follow the game here. Arguments: ${args.slice(1).join(', ')}`,
    );
  }
}
