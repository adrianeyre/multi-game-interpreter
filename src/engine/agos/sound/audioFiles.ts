/**
 * Which file beside a game holds which kind of sound.
 *
 * Three questions that used to be asked inline in `AgosEngine.create` and are
 * now asked in three places — the engine as it loads, the importer as it lists
 * what a game has, and the editor as it reads one back out of the folder. The
 * answers have to agree exactly: an editor that picked a different speech file
 * from the engine's would list a game's lines against one file and play them
 * out of another, and both would look right.
 *
 * Names only. Nothing here opens anything, so it can be asked of a folder
 * listing without reading tens of megabytes to find out what is in it.
 */

/** The last path segment, lower-cased, which is what every rule here is about. */
function leaf(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).toLowerCase();
}

/** The containers a release can put recorded audio in (ADR 0028). */
const AUDIO_EXTENSIONS = /\.(voc|wav|mp3|ogg|flac)$/i;

/** True for the effects resource, which shares its container with the speech. */
function isEffectsFile(name: string): boolean {
  return /^effects\.(voc|wav|mp3|ogg|flac)$/i.test(leaf(name));
}

/**
 * The talkie's speech file, where the folder has one.
 *
 * **The effects resource has to be excluded by name, and used to not be.** A
 * CD release ships `effects.voc` beside `simon.voc`, a listing is
 * alphabetical, and taking the first `.voc` found read the *effects* file as
 * the speech index — quietly, because both really are offset tables of VOC
 * clips, so the shape agreed and only the contents were wrong.
 *
 * The re-encoded formats count too: ADR 0028 admits GOG, Steam and 25th
 * Anniversary data, whose speech ScummVM's tools turned into MP3, Ogg or FLAC,
 * and Simon 1's Windows release keeps its speech in `SIMON.mp3`.
 */
export function speechFileIn(names: readonly string[]): string | undefined {
  return names.find((name) => AUDIO_EXTENSIONS.test(leaf(name)) && !isEffectsFile(name));
}

/** The one-file effects resource a CD release ships, where there is one. */
export function effectsFileIn(names: readonly string[]): string | undefined {
  return names.find((name) => AUDIO_EXTENSIONS.test(leaf(name)) && isEffectsFile(name));
}

/**
 * The loose effects bank belonging to one `TABLES` file, where there is one.
 *
 * Simon 1's Windows release ships `SFXXXX02` … `SFXXXX29`, one per table file,
 * and the reference swaps the open one as the game loads a new part of itself.
 * Matched against the listing rather than composed from the number because the
 * retail folder is not consistent about case — it holds `SFXXXX13` and
 * `sfxxxx15` side by side — and a composed name misses one of those on any
 * filesystem that cares.
 *
 * Undefined for a release that keeps its effects in the archive instead, which
 * is Simon 2 and is not a fault.
 */
export function effectsBankFileIn(names: readonly string[], bank: number): string | undefined {
  const wanted = `sfxxxx${String(bank).padStart(2, '0')}`;
  return names.find((name) => leaf(name) === wanted);
}
