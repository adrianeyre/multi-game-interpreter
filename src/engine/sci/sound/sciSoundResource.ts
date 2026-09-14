/**
 * A SCI sound resource, which is **not a track**.
 *
 * The mistake #219 exists to prevent, stated as a type: a sound resource
 * carries several **Device arrangements** — AdLib, MT-32, PC speaker, Amiga —
 * and the interpreter picks one at play time. It is the same split SCUMM ships
 * as separate `ADLIB.IMS` and `ROLAND.IMS` files, folded inside one resource,
 * and modelling a sound resource as having *a* body is what makes a game play
 * the wrong arrangement on every device it has one for.
 *
 * So this returns the arrangements and lets the caller choose. There is no
 * `body` field to reach for.
 */

/** A device a SCI sound resource may carry an arrangement for. */
export type SciSoundDevice =
  'adlib' | 'pc-speaker' | 'pcjr' | 'mt32' | 'gm' | 'cms' | 'amiga' | 'unknown';

/**
 * The device bits a SCI0 channel entry carries.
 *
 * Read from real resources as well as from the format: across the Space Quest
 * III, Leisure Suit Larry 2 and King's Quest IV demos, the bits that actually
 * appear are the ones named here, and the ones that never appear are left out
 * rather than guessed at.
 */
const SCI0_DEVICES: ReadonlyArray<[bit: number, device: SciSoundDevice]> = [
  [0x01, 'mt32'],
  [0x02, 'gm'],
  [0x04, 'cms'],
  [0x08, 'adlib'],
  [0x10, 'pcjr'],
  [0x20, 'pc-speaker'],
];

/** One device's view of a sound: which channels play for it. */
export interface SciSoundArrangement {
  device: SciSoundDevice;
  /** Channel numbers this device plays. */
  channels: number[];
}

export interface SciSoundResource {
  /** True when the resource carries a digital sample rather than only MIDI. */
  hasDigital: boolean;
  /** One entry per device the resource has an arrangement for. */
  arrangements: SciSoundArrangement[];
  /** Where the MIDI data starts, past the channel table. */
  dataOffset: number;
}

/**
 * Reads a SCI0 sound resource's header.
 *
 * A digital flag, then sixteen channel entries of two bytes each: the device
 * mask and the channel's voice count and priority. The mask is the whole point
 * — it is what says which device this channel belongs to, and therefore which
 * arrangement.
 */
export function readSci0Sound(resource: Uint8Array): SciSoundResource {
  if (resource.length < 33) {
    return { hasDigital: false, arrangements: [], dataOffset: 0 };
  }

  const hasDigital = resource[0] !== 0;
  const byDevice = new Map<SciSoundDevice, number[]>();

  for (let channel = 0; channel < 16; channel++) {
    const mask = resource[1 + channel * 2];
    if (mask === 0) continue;
    for (const [bit, device] of SCI0_DEVICES) {
      if ((mask & bit) === 0) continue;
      const channels = byDevice.get(device) ?? [];
      channels.push(channel);
      byDevice.set(device, channels);
    }
  }

  return {
    hasDigital,
    arrangements: [...byDevice].map(([device, channels]) => ({ device, channels })),
    dataOffset: 33,
  };
}

/**
 * Picks an arrangement for the device this project can synthesise.
 *
 * **Selected rather than assumed**, which is #219's own wording. A resource
 * with no arrangement for the wanted device answers null rather than falling
 * back to whichever arrangement happens to be first — a game playing MT-32
 * data through an AdLib synthesiser is noise at the right length, which passes
 * every check except listening.
 */
export function arrangementFor(
  sound: SciSoundResource,
  wanted: readonly SciSoundDevice[],
): SciSoundArrangement | null {
  for (const device of wanted) {
    const found = sound.arrangements.find((arrangement) => arrangement.device === device);
    if (found) return found;
  }
  return null;
}

/** What a resource offers, for the log and for the diagnostic. */
export function describeSound(sound: SciSoundResource): string {
  if (sound.arrangements.length === 0) return 'no device arrangements';
  return sound.arrangements
    .map((arrangement) => `${arrangement.device} (${arrangement.channels.length} channels)`)
    .join(', ');
}
