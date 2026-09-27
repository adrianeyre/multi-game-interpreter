/**
 * The calls that were still answering a constant when every missing call had
 * been written: collision (`CanBeHere`, `CantBeHere`, `DoAvoider`), jumping
 * (`SetJump`), digital audio (`DoAudio`), the restart pair, a control's
 * highlight, resource and memory bookkeeping, the platform question, and the
 * debug map `Show` puts on screen.
 *
 * Every one of them does something in ScummVM, cited per handler
 * (`engines/sci/engine/kgraphics.cpp`, `kmovement.cpp`, `ksound.cpp`,
 * `kmisc.cpp`, `kfile.cpp`, `kscripts.cpp`, `graphics/compare.cpp`,
 * `sound/audio32.cpp`, fetched 2026-09-27). The ones that *stayed* in the
 * constant column are the ones ScummVM also answers with a constant, and
 * `SciKernel.ts` says so beside each.
 *
 * A factory over `SciKernel.ts`'s helpers, like `sciKernelRemaining.ts`, so
 * neither module needs the other loaded first.
 */

import { isNull, KERNEL_RETRY, NULL_REG, reg, type Reg, type SciObject } from './PMachine.js';
import type { SciKernelWorld } from './SciKernel.js';
import type { SciKernelHelpers } from './sciKernelRemaining.js';
import { before } from '../sciVersion.js';
import { SCI_SCREEN_MASK } from '../gfx/sciPaint16.js';
import { SCI_AUDIO_MAX_VOLUME } from '../sound/sciAudioPlayer.js';

type Handler = (world: SciKernelWorld, args: Reg[]) => Reg;

const int = (value: number): Reg => reg(0, value & 0xffff);
const signed = (value: Reg | undefined): number => {
  const word = (value?.offset ?? 0) & 0xffff;
  return word >= 0x8000 ? word - 0x10000 : word;
};

/** `SIGNAL_REG`: offset 0xFFFF, which several of these answer. */
const SIGNAL = int(0xffff);

/** The animation signal bits, from ScummVM's `graphics/animate.h`. */
const SIGNAL_HIDDEN = 0x0008;
const SIGNAL_NO_UPDATE = 0x0004;
const SIGNAL_REMOVE_VIEW = 0x0080;
const SIGNAL_IGNORE_ACTOR = 0x4000;

/** `kSciPlatform*`: DOS 1, Windows 2, Macintosh 3. */
const SCI_PLATFORM = { dos: 1, windows: 2, mac: 3 } as const;

/** `kSciAudio*`, SCI16's `DoAudio` sub-functions (`sound/audio.h`). */
export const SCI_AUDIO_OP = {
  wPlay: 1,
  play: 2,
  stop: 3,
  pause: 4,
  resume: 5,
  position: 6,
  rate: 7,
  volume: 8,
  language: 9,
  cd: 10,
} as const;

/** `EngineState::kMemorySegmentMax`: a block that survives restarts and restores. */
const MEMORY_SEGMENT_MAX = 256;
const memorySegments = new WeakMap<object, Uint8Array>();

/** The resource type `UnLoad` frees a hunk for: `kResourceTypeMemory`. */
const RESOURCE_MEMORY = 5;

export function createLeftoverKernel(helpers: SciKernelHelpers): Record<string, Handler> {
  const { readString, readProperty, setProperty, reportOnce } = helpers;
  const prop = (world: SciKernelWorld, object: SciObject, name: string): number =>
    signed(int(readProperty(world, object, name)));

  /**
   * `canBeHereCheckRectList`: the first object on the list, other than this
   * one and not excused by `flags`, whose base rectangle overlaps. Strictly —
   * a rectangle is never inside itself, which KQ4 early depends on.
   */
  const blocker = (
    world: SciKernelWorld,
    self: Reg,
    rect: { left: number; top: number; right: number; bottom: number },
    list: Reg,
    flags: number,
  ): Reg => {
    const found = world.heap.list(list);
    if (!found) return NULL_REG;
    for (let at = found.first, guard = 0; !isNull(at) && guard < 1024; guard++) {
      const node = world.heap.node(at);
      if (!node) break;
      const value = node.value;
      const other = world.machine.object(value);
      if (other && (value.segment !== self.segment || value.offset !== self.offset)) {
        if ((readProperty(world, other, 'signal') & flags) === 0) {
          const left = prop(world, other, 'brLeft');
          const top = prop(world, other, 'brTop');
          const right = prop(world, other, 'brRight');
          const bottom = prop(world, other, 'brBottom');
          if (right > rect.left && left < rect.right && bottom > rect.top && top < rect.bottom) {
            return value;
          }
        }
      }
      at = node.next;
    }
    return NULL_REG;
  };

  /**
   * `GfxCompare::kernelCanBeHere`: the control colours under the base that
   * the actor's `illegalBits` forbid, or — if none — the first actor on the
   * list in the way. Nought means it can be there.
   */
  const canBeHere16 = (world: SciKernelWorld, args: Reg[]): Reg => {
    const self = args[0] ?? NULL_REG;
    const object = world.machine.object(self);
    if (!object) return NULL_REG;
    const rect = {
      left: prop(world, object, 'brLeft'),
      top: prop(world, object, 'brTop'),
      right: prop(world, object, 'brRight'),
      bottom: prop(world, object, 'brBottom'),
    };
    // An inverted rectangle "can be here", which ScummVM keeps as a hack for
    // ICEMAN and Mother Goose.
    if (rect.right < rect.left || rect.bottom < rect.top) return NULL_REG;
    const illegal = readProperty(world, object, 'illegalBits');
    const onControl = world.graph16?.onControl(SCI_SCREEN_MASK.control, rect) ?? 0;
    const result = onControl & illegal;
    const signal = readProperty(world, object, 'signal');
    if (result === 0 && (signal & (SIGNAL_IGNORE_ACTOR | SIGNAL_REMOVE_VIEW)) === 0) {
      return blocker(
        world,
        self,
        rect,
        args[1] ?? NULL_REG,
        SIGNAL_IGNORE_ACTOR | SIGNAL_REMOVE_VIEW | SIGNAL_NO_UPDATE,
      );
    }
    return int(result);
  };

  /** Which channel a SCI32 `DoAudio` names: a number, or five parts of a tuple. */
  const audio32Id = (args: Reg[], start: number): string | null => {
    const count = args.length - start;
    if (count <= 0) return null;
    if (count < 5) return `65535:${args[start]?.offset ?? 0}`;
    const parts = [0, 1, 2, 3, 4].map((i) => args[start + i]?.offset ?? 0);
    return `${parts[0]}:${parts[1] & 0xff}:${parts[2] & 0xff}:${parts[3] & 0xff}:${parts[4] & 0xff}`;
  };

  /**
   * Starts a clip, or asks to be called again when it is still being read.
   *
   * Sierra's play read the sample off the disc inside the call and answered its
   * length; here the read is asynchronous, so the call is retried once it has
   * landed — which is the same answer, a cycle later.
   */
  const startClip = (
    world: SciKernelWorld,
    id: string,
    options: { autoPlay: boolean; loop: boolean; volume: number; monitor: boolean },
  ): Reg => {
    const audio = world.audio;
    if (!audio) return NULL_REG;
    if (audio.has(id)) return int(audio.play(id, { rate: 1, samples: new Int16Array(0) }, options));
    const clip = world.audioClip?.(id);
    if (clip === undefined) return world.audioClip ? KERNEL_RETRY : NULL_REG;
    if (clip === null) {
      reportOnce(
        world,
        `DoAudio.${id}`,
        `DoAudio asked for audio ${id}, which this game does not have.`,
      );
      return NULL_REG;
    }
    return int(audio.play(id, clip, options));
  };

  return {
    // --------------------------------------------------------- collision ---
    /** `kCanBeHere`: one when nothing is in the way, the inverse of the answer below. */
    CanBeHere: (world, args) => int(isNull(canBeHere16(world, args)) ? 1 : 0),
    /**
     * `kCantBeHere`: what is in the way. SCI32's `kernelCantBeHere32` looks
     * only at other actors, with no control buffer to consult.
     */
    CantBeHere: (world, args) => {
      if (before(world.machine.version, 'sci2')) return canBeHere16(world, args);
      const self = args[0] ?? NULL_REG;
      const object = world.machine.object(self);
      if (!object) return int(0);
      const rect = {
        left: prop(world, object, 'brLeft'),
        top: prop(world, object, 'brTop'),
        right: prop(world, object, 'brRight'),
        bottom: prop(world, object, 'brBottom'),
      };
      if (rect.right < rect.left || rect.bottom < rect.top) return int(0);
      if (readProperty(world, object, 'signal') & (SIGNAL_IGNORE_ACTOR | SIGNAL_HIDDEN))
        return int(0);
      const found = blocker(
        world,
        self,
        rect,
        args[1] ?? NULL_REG,
        SIGNAL_IGNORE_ACTOR | SIGNAL_HIDDEN,
      );
      return int(isNull(found) ? 0 : 1);
    },

    /**
     * `kSetJump(object, dx, dy, gy)`: the x and y steps of a parabolic jump
     * that lands `dx`, `dy` away under gravity `gy`. ScummVM's derivation,
     * integer truncations and all, written into `xStep` and `yStep`.
     */
    SetJump: (world, args) => {
      const object = world.machine.object(args[0] ?? NULL_REG);
      let dx = signed(args[1]);
      const dy = signed(args[2]);
      const gy = Math.max(0, signed(args[3]));
      const negative = dx < 0;
      dx = Math.abs(dx);
      let c: number;
      if (dx === 0) c = 1;
      else if (dx + dy < 0) c = Math.trunc((2 * Math.abs(dy)) / dx);
      else c = Math.max(1, Math.trunc((Math.trunc((dx * 3) / 2) - dy) / dx));
      const tmp = c * dx + dy;
      let vx = tmp !== 0 && dx !== 0 ? Math.trunc(dx * Math.sqrt(gy / (2 * tmp))) : 0;
      if (Number.isNaN(vx)) vx = 0;
      // (int16) of the float, as Sierra's truncated it.
      vx = (vx << 16) >> 16;
      if (negative) vx = -vx;
      let vy = dy < 0 && vx === 0 ? Math.trunc(Math.sqrt(gy * Math.abs(2 * dy))) + 1 : c * vx;
      vy = -Math.abs(vy);
      setProperty(world, object, 'xStep', vx);
      setProperty(world, object, 'yStep', vy);
      return world.machine.acc;
    },

    /**
     * `kDoAvoider(avoider[, timesStep])`: SCI0's obstacle avoidance. Moves the
     * client with its mover; when it is blocked, tries each heading 45 degrees
     * round from where it is facing — the direction round chosen at random and
     * kept — until `canBeHere` says yes, and answers that heading, or
     * `SIGNAL_REG` when nothing works or nothing is in the way.
     */
    DoAvoider: (world, args) => {
      const avoiderRef = args[0] ?? NULL_REG;
      const avoider = world.machine.object(avoiderRef);
      const selector = (name: string) => world.machine.selectorNumbers?.get(name);
      if (!avoider) return SIGNAL;
      const times = args.length > 1 ? (args[1]?.offset ?? 1) : 1;
      const clientRef = helpers.readPropertyReg(world, avoider, 'client');
      const client = world.machine.object(clientRef);
      if (!client) return SIGNAL;
      const moverOf = () => world.machine.object(helpers.readPropertyReg(world, client, 'mover'));
      let mover = moverOf();
      if (!mover) return SIGNAL;
      const doit = selector('doit');
      if (doit !== undefined) world.machine.invoke(mover.id, doit, args);
      mover = moverOf();
      if (!mover) return SIGNAL;

      const clientX = prop(world, client, 'x');
      const clientY = prop(world, client, 'y');
      const moverX = prop(world, mover, 'x');
      const moverY = prop(world, mover, 'y');
      let heading = prop(world, avoider, 'heading');
      const isBlocked = selector('isBlocked');
      const blocked =
        isBlocked === undefined ? null : world.machine.invoke(clientRef, isBlocked, args);

      if (!blocked || isNull(blocked)) {
        if (heading === -1) return SIGNAL;
        const angle = helpers.kernel('GetAngle')(world, [
          int(clientX),
          int(clientY),
          int(moverX),
          int(moverY),
        ]);
        const looper = helpers.readPropertyReg(world, client, 'looper');
        if (isNull(looper) || doit === undefined)
          helpers.kernel('DirLoop')(world, [clientRef, angle]);
        else world.machine.invoke(looper, doit, [angle, clientRef]);
        return SIGNAL;
      }

      if (heading === -1) heading = world.random() < 0.5 ? 45 : -45;
      const clientHeading = Math.trunc(prop(world, client, 'heading') / 45) * 45;
      const xStep = prop(world, client, 'xStep') * times;
      const yStep = prop(world, client, 'yStep') * times;
      const canBeHere = selector('canBeHere');
      let next = clientHeading;
      for (let guard = 0; guard < 16; guard++) {
        let x = clientX;
        let y = clientY;
        if (next === 45 || next === 90 || next === 135) x += xStep;
        else if (next === 225 || next === 270 || next === 315) x -= xStep;
        if (next === 0 || next === 45 || next === 315) y -= yStep;
        else if (next === 135 || next === 180 || next === 225) y += yStep;
        setProperty(world, client, 'x', x);
        setProperty(world, client, 'y', y);
        const here =
          canBeHere === undefined ? null : world.machine.invoke(clientRef, canBeHere, args);
        if (here && !isNull(here)) return int(next);
        next += heading;
        if (next >= 360) next -= 360;
        if (next < 0) next += 360;
        if (next === clientHeading) break;
      }
      // Tried everything: back where it was.
      setProperty(world, client, 'x', clientX);
      setProperty(world, client, 'y', clientY);
      return SIGNAL;
    },

    // ------------------------------------------------------------- audio ---
    /**
     * `kDoAudio(sub, ...)` — SCI16's ten sub-functions and three of Freddy
     * Pharkas's, or SCI32's twenty-one (`kDoAudio_subops`), over one
     * `SciAudioChannels` the engine owns.
     */
    DoAudio: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      const audio = world.audio;
      const rest = args.slice(1);
      if (!before(world.machine.version, 'sci2')) {
        switch (sub) {
          case 0: // Init
            return int(0);
          case 1: // WaitForPlay: load paused, or with no arguments the channel count
          case 2: {
            // Play
            if (rest.length === 0) return int(audio?.active ?? 0);
            const id = audio32Id(rest, 0);
            if (!id) return NULL_REG;
            const tuple = rest.length >= 5;
            const loopArg = tuple ? rest[5] : rest[1];
            const volumeArg = tuple ? rest[6] : rest[2];
            const sci3 = world.machine.version === 'sci3';
            const loop = loopArg !== undefined && signed(loopArg) !== 1 && signed(loopArg) !== 0;
            let volume = SCI_AUDIO_MAX_VOLUME;
            let monitor = false;
            if (volumeArg !== undefined) {
              const v = signed(volumeArg);
              if (sci3) {
                volume = v & SCI_AUDIO_MAX_VOLUME;
                monitor = (v & 0x80) !== 0;
              } else if (v < 0 || v > SCI_AUDIO_MAX_VOLUME) monitor = true;
              else volume = v;
            }
            return startClip(world, id, { autoPlay: sub === 2, loop, volume, monitor });
          }
          case 3: // Stop
            return int(audio?.stop(audio32Id(rest, 0)) ?? 0);
          case 4: // Pause
            return int(audio?.pause(audio32Id(rest, 0)) ? 1 : 0);
          case 5: // Resume
            return int(audio?.resume(audio32Id(rest, 0)) ? 1 : 0);
          case 6: // Position
            return int(audio?.position(audio32Id(rest, 0)) ?? -1);
          case 7: // Rate
            if (audio && rest.length > 0 && rest[0].offset !== 0) audio.rate = rest[0].offset;
            return int(audio?.rate ?? 0);
          case 8: {
            // Volume(volume[, channel...])
            const volume = rest.length > 0 ? signed(rest[0]) : -1;
            const id =
              world.machine.version === 'sci3' && rest.length < 2 ? null : audio32Id(rest, 1);
            if (volume !== -1) audio?.setVolume(id, volume);
            return int(audio?.getVolume(id) ?? 0);
          }
          case 9: // GetCapability
            return int(1);
          case 10: // BitDepth
            if (audio && rest.length > 0 && rest[0].offset !== 0) audio.bitDepth = rest[0].offset;
            return int(audio?.bitDepth ?? 0);
          case 12: // Mixing
            if (audio && rest.length > 0) audio.attenuatedMixing = rest[0].offset !== 0;
            return int(audio?.attenuatedMixing ? 1 : 0);
          case 13: // Channels (SCI2's SetBufferSize is `MAP_EMPTY`)
            if (world.machine.version === 'sci2') return world.machine.acc;
            if (audio && rest.length > 0 && signed(rest[0]) !== 0)
              audio.outputChannels = signed(rest[0]);
            return int(audio?.outputChannels ?? 1);
          case 14: // Preload
            if (audio && rest.length > 0) audio.preload = rest[0].offset;
            return int(audio?.preload ?? 0);
          case 15: {
            // Fade(channel..., volume, speed, steps[, stopAfter])
            if (rest.length < 4 || !audio) return int(0);
            // `findChannelByArgs(s, 2, ...)`: the channel is the first argument alone.
            const id = audio32Id(rest.slice(0, 1), 0) ?? audio.first();
            if (!id) return int(0);
            return int(
              audio.fade(
                id,
                signed(rest[1]),
                signed(rest[2]),
                signed(rest[3]),
                (rest[4]?.offset ?? 0) !== 0,
              )
                ? 1
                : 0,
            );
          }
          case 17: // HasSignal
            return int(audio?.hasSignal() ? 1 : 0);
          case 18: // Critical, `MAP_EMPTY`
            return world.machine.acc;
          case 19: {
            // SetLoop(loop, channel...)
            const id = audio32Id(rest, 1);
            const loop = signed(rest[0]) !== 0 && signed(rest[0]) !== 1;
            if (id) audio?.setLoop(id, loop);
            return world.machine.acc;
          }
          case 20: // Pan
          case 21: // PanOff
            // Stereo placement. The output here is one mixed voice per channel
            // without a panner, so the call is accepted and changes nothing
            // that can be heard; ScummVM's `setPan` changes only the mix.
            return world.machine.acc;
          default:
            // 11 (Distort) and 16 (Fade36) are `MAP_DUMMY` in ScummVM's table.
            reportOnce(
              world,
              `DoAudio32.${sub}`,
              `DoAudio sub-function ${sub} is a dummy in ScummVM's table.`,
            );
            return world.machine.acc;
        }
      }

      switch (sub) {
        case SCI_AUDIO_OP.wPlay:
        case SCI_AUDIO_OP.play: {
          let id: string;
          if (args.length === 2) id = `65535:${args[1]?.offset ?? 0}`;
          else if (args.length === 6 || args.length === 8) {
            const [n, v, c, s] = [2, 3, 4, 5].map((i) => (args[i]?.offset ?? 0) & 0xff);
            id = `${args[1]?.offset ?? 0}:${n}:${v}:${c}:${s}`;
          } else {
            reportOnce(
              world,
              'DoAudio.play',
              `DoAudio play with ${args.length} arguments is not a form ScummVM reads.`,
            );
            return NULL_REG;
          }
          // One sample at a time, and a new one stops the last.
          if (!audio?.has(id)) audio?.stop();
          const answer = startClip(world, id, {
            autoPlay: sub === SCI_AUDIO_OP.play,
            loop: false,
            volume: SCI_AUDIO_MAX_VOLUME,
            monitor: false,
          });
          if (answer !== KERNEL_RETRY && sub === SCI_AUDIO_OP.play && audio) audio.playCounter++;
          return answer;
        }
        case SCI_AUDIO_OP.stop:
          audio?.stop();
          return world.machine.acc;
        case SCI_AUDIO_OP.pause:
          audio?.pause();
          return world.machine.acc;
        case SCI_AUDIO_OP.resume:
          audio?.resume();
          return world.machine.acc;
        case SCI_AUDIO_OP.position:
          return int(audio?.position() ?? -1);
        case SCI_AUDIO_OP.rate:
          if (audio) audio.rate = args[1]?.offset ?? audio.rate;
          return world.machine.acc;
        case SCI_AUDIO_OP.volume:
          audio?.setVolume(null, args[1]?.offset ?? SCI_AUDIO_MAX_VOLUME);
          return world.machine.acc;
        case SCI_AUDIO_OP.language: {
          // SCI1.1 asks whether there is digital audio at all; SCI1 sets or
          // reads the speech language, with -1 meaning "read, and default to
          // English (1) if unset".
          if (world.machine.version === 'sci1-1') return int(1);
          if (!audio) return int(1);
          const wanted = signed(args[1]);
          if (wanted === -1) {
            if (audio.language === -1) audio.language = 1;
            return int(audio.language);
          }
          audio.language = wanted;
          return int(wanted);
        }
        case SCI_AUDIO_OP.cd:
          // CD audio: Red Book tracks, which the two games that use them play
          // through `kDoCdAudio`. No CD drive is reachable from here.
          reportOnce(
            world,
            'DoAudio.cd',
            'DoAudio asked for CD audio, which there is no drive to play.',
          );
          return world.machine.acc;
        case 12:
          // Freddy Pharkas's read-jitter check, which ScummVM answers true.
          return int(1);
        case 13:
          return int(audio?.playCounter ?? 0);
        default:
          reportOnce(
            world,
            `DoAudio.${sub}`,
            `DoAudio sub-function ${sub} is not in ScummVM's table.`,
          );
          return world.machine.acc;
      }
    },

    // -------------------------------------------------------- restarting ---
    /**
     * `kRestartGame16`: the game starts over from its own `play`, with the
     * restarting flag up so its scripts can tell. SCI32's is `MAP_EMPTY`.
     */
    RestartGame: (world) => {
      if (!before(world.machine.version, 'sci2')) return world.machine.acc;
      world.restartGame?.();
      return NULL_REG;
    },
    /** `kGameIsRestarting([0])`: the flag, cleared when a game passes nought. */
    GameIsRestarting: (world, args) => {
      const previous = world.restarting?.flag() ?? 0;
      if (args.length > 0 && args[0].offset === 0) world.restarting?.clear();
      return int(previous);
    },

    // ----------------------------------------------------------- controls ---
    /**
     * `kHiliteControl(control)`: `_k_GenericDrawControl` with `hilite` set,
     * which for every kind of control inverts its rectangle — pen and back
     * swapped — rather than drawing it again.
     */
    HiliteControl: (world, args) => {
      const object = world.machine.object(args[0] ?? NULL_REG);
      if (!object) return world.machine.acc;
      const top = prop(world, object, 'nsTop');
      const left = prop(world, object, 'nsLeft');
      const bottom = prop(world, object, 'nsBottom');
      const right = prop(world, object, 'nsRight');
      // `kControlCreateRect`: an upside-down rectangle keeps its top left.
      world.graph16?.invertRect({
        left,
        top,
        right: Math.max(left, right),
        bottom: Math.max(top, bottom),
      });
      return world.machine.acc;
    },

    // ------------------------------------------------- memory, resources ---
    /**
     * `kMemoryInfo(sub)`: what memory is free. ScummVM answers 0x7fea for
     * every question but the largest heap block, which is two less, so that
     * no game decides its memory is fragmented.
     */
    MemoryInfo: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      if (sub === 0) return int(0x7fea - 2);
      if (sub >= 1 && sub <= 4) return int(0x7fea);
      reportOnce(
        world,
        `MemoryInfo.${sub}`,
        `MemoryInfo sub-function ${sub} is not one ScummVM knows.`,
      );
      return NULL_REG;
    },
    /**
     * `kMemorySegment(sub, buffer[, size])`: 256 bytes that survive a restart
     * and a restore. 0 saves `size` bytes (a string's length when nought),
     * 1 copies them back; both answer the buffer.
     */
    MemorySegment: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      const buffer = args[1] ?? NULL_REG;
      const bytes = helpers.bytesAt(world, buffer);
      const key = world.machine;
      if (sub === 0) {
        let size = args[2]?.offset ?? 0;
        if (size === 0) size = readString(world, buffer, true).length + 1;
        if (size > MEMORY_SEGMENT_MAX) {
          reportOnce(
            world,
            'MemorySegment.size',
            `MemorySegment was asked to keep ${size} bytes; it holds 256.`,
          );
          size = MEMORY_SEGMENT_MAX;
        }
        const kept = new Uint8Array(size);
        for (let i = 0; i < size && bytes && i < bytes.length; i++) kept[i] = bytes.get(i);
        memorySegments.set(key, kept);
      } else if (sub === 1) {
        const kept = memorySegments.get(key);
        if (kept && bytes)
          for (let i = 0; i < kept.length && i < bytes.length; i++) bytes.set(i, kept[i]);
      }
      return buffer;
    },
    /**
     * `kUnLoad(type, number)`: a resource the game has finished with. Only a
     * `memory` block is anything to free — the heap block a script allocated
     * — and ScummVM frees exactly that; everything else is the resource
     * manager's cache, which does not hold what this engine has read.
     */
    UnLoad: (world, args) => {
      if (((args[0]?.offset ?? 0) & 0x7f) === RESOURCE_MEMORY) world.heap.free(args[1] ?? NULL_REG);
      return world.machine.acc;
    },
    /**
     * `kLock(type, number[, lock])`: to lock is to load, which is what a game
     * calls it for — to have a resource in hand before it needs it. Here that
     * is a read begun between cycles. Unlocking frees nothing that is held.
     */
    Lock: (world, args) => {
      const lock = args.length > 2 ? (args[2]?.offset ?? 0) !== 0 : true;
      if (lock) world.preloadResource?.((args[0]?.offset ?? 0) & 0x7f, args[1]?.offset ?? 0);
      return world.machine.acc;
    },
    /**
     * `kDisposeScript(script[, value])`: answers `value` when given one and
     * the accumulator otherwise, which is the part a script reads. The script
     * itself stays loaded: SCI's reason to unload one was memory, and every
     * script here is read at boot because `ScriptID` cannot wait for one.
     */
    DisposeScript: (world, args) => (args.length === 2 ? (args[1] ?? NULL_REG) : world.machine.acc),

    /**
     * `kDeviceInfo(sub, ...)`: drives and paths. There is one device, `/`,
     * which is what ScummVM answers; paths compare as a wildcard match; no
     * device is a floppy; and deleting a save by its file name — Sierra's way,
     * through sub-function 8 — deletes the save the game named.
     */
    DeviceInfo: (world, args) => {
      const sub = args[0]?.offset ?? 0;
      switch (sub) {
        case 0:
          helpers.putString(world, args[2] ?? NULL_REG, '/');
          return world.machine.acc;
        case 1:
          helpers.putString(world, args[1] ?? NULL_REG, '/');
          return world.machine.acc;
        case 2: {
          const path1 = readString(world, args[1] ?? NULL_REG, true);
          const path2 = readString(world, args[2] ?? NULL_REG, true);
          const pattern = new RegExp(
            `^${path1
              .toLowerCase()
              .replace(/[.+^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.')}$`,
          );
          return int(pattern.test(path2.toLowerCase()) ? 1 : 0);
        }
        case 3:
        case 5:
          return NULL_REG;
        case 7:
          helpers.putString(world, args[1] ?? NULL_REG, '__throwaway');
          return world.machine.acc;
        case 8:
          helpers.putString(world, args[1] ?? NULL_REG, '__throwaway');
          world.deleteSave?.(args[3]?.offset ?? 0);
          return world.machine.acc;
        default:
          reportOnce(
            world,
            `DeviceInfo.${sub}`,
            `DeviceInfo sub-function ${sub} is not one ScummVM knows.`,
          );
          return world.machine.acc;
      }
    },

    /**
     * `kPlatform(sub)`, or SCI32's `kPlatform32`: which machine this is. DOS
     * unless the release says Windows or Macintosh; this display is never a
     * hi-res driver, so it is always the "small window".
     */
    Platform: (world, args) => {
      const platform = world.platform?.() ?? 'dos';
      const code = SCI_PLATFORM[platform];
      if (!before(world.machine.version, 'sci2')) {
        const middle = !before(world.machine.version, 'sci2-1-middle');
        const op = args.length > 0 ? signed(args[0]) : 0;
        if (!middle && op !== 0) return NULL_REG;
        switch (op) {
          case 0:
            // SCI32 Macintosh claims to be DOS, which GK1's slideshows need.
            return int(platform === 'mac' ? SCI_PLATFORM.dos : code);
          case 1:
            return int(4);
          case 2:
            return int(2);
          default:
            return NULL_REG;
        }
      }
      if (args.length === 0) return NULL_REG;
      const windows = platform === 'windows';
      switch (args[0].offset) {
        case 0:
        case 4:
          return int(code);
        case 5:
          return int(1);
        case 6:
        case 7:
          return int(windows ? 1 : 0);
        default:
          reportOnce(
            world,
            `Platform.${args[0].offset}`,
            `Platform sub-function ${args[0].offset} is not one ScummVM knows.`,
          );
          return NULL_REG;
      }
    },

    /**
     * `kShow(map)`: Sierra's debugger view of one of the room's three screens
     * — 1 visual, 2 priority, 3 and 4 control — put on the display until the
     * next frame repaints it.
     */
    Show: (world, args) => {
      const map = args[0]?.offset ?? 0;
      if (map === 1) world.showMap?.('visual');
      else if (map === 2) world.showMap?.('priority');
      else if (map === 3 || map === 4) world.showMap?.('control');
      else
        reportOnce(
          world,
          `Show.${map}`,
          `Show was asked for map ${map}, which is not one of the three.`,
        );
      return world.machine.acc;
    },
  };
}
