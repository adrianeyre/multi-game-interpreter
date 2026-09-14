/**
 * What a resource type number means.
 *
 * SCI packs the type into the map entry — the top five bits of a 16-bit id at
 * SCI0, a byte of its own from SCI1 — and the numbering is stable across the
 * SCI16 half of the family. SCI2.1 renumbers part of it, which lands with #225
 * rather than here; until then an unrecognised number reports itself by number
 * rather than being read as the type that happens to sit at that index.
 */

export const SCI_RESOURCE_TYPES = [
  'view',
  'pic',
  'script',
  'text',
  'sound',
  'memory',
  'vocab',
  'font',
  'cursor',
  'patch',
  'bitmap',
  'palette',
  'cdaudio',
  'audio',
  'sync',
  'message',
  'map',
  'heap',
  'audio36',
  'sync36',
  'translation',
] as const;

export type SciResourceType = (typeof SCI_RESOURCE_TYPES)[number];

/**
 * The type a raw number names, or null when nothing does.
 *
 * Bit 7 is masked because SCI1's map ORs it into the directory's type byte —
 * `detectMapVersion` uses the presence of that bit to separate a SCI1 late map
 * from SCI32's, so it is signal at the map level and noise at this one.
 */
export function sciResourceType(raw: number): SciResourceType | null {
  return SCI_RESOURCE_TYPES[raw & 0x7f] ?? null;
}

/** The file extension Sierra's own tools give a patch of this type. */
export function sciResourceExtension(type: SciResourceType): string {
  const numbers: Record<SciResourceType, number> = {
    view: 0,
    pic: 1,
    script: 2,
    text: 3,
    sound: 4,
    memory: 5,
    vocab: 6,
    font: 7,
    cursor: 8,
    patch: 9,
    bitmap: 10,
    palette: 11,
    cdaudio: 12,
    audio: 13,
    sync: 14,
    message: 15,
    map: 16,
    heap: 17,
    audio36: 18,
    sync36: 19,
    translation: 20,
  };
  return numbers[type].toString().padStart(3, '0');
}
