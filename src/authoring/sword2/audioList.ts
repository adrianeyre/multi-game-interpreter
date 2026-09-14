/**
 * What Broken Sword II has to listen to, listed rather than copied.
 *
 * A separate file from Sword 1's and not a shared one, which ADR 0036 asks for
 * and which the two listings then justify on their own: Sword 1 addresses its
 * effects through a table that lived in its interpreter, its music by a
 * filename that table also holds, and its speech by room and line inside a
 * container the resource index knows nothing about.
 *
 * ## An effect is a resource; a line and a tune are not
 *
 * This listing used to say all three were resources, and that was a guess that
 * no install here could contradict. An **effect** is one and the id is all
 * there is — `fnPlayFx` takes a `WAV_FILE`'s id and `resource.tab` says which
 * cluster holds it. **Speech and music are not in the index at all.** A retail
 * disc ships `SPEECH1.CLU` and `MUSIC1.CLU` beside the install, opened by name
 * and indexed by their own table, and `resource.inf` names neither: ScummVM's
 * `Sound::playCompSpeech` opens the file itself and looks the line up by the
 * text id the script already carries. The two layouts exclude each other — a
 * cluster's first word is the offset of its tail table and a container's is
 * the number of entries in its index — so this is a correction rather than a
 * preference (`src/engine/sword2/sound/sword2Clu.ts`).
 *
 * ## So what distinguishes the three kinds is where the recording lives
 *
 * An entry in `speech*.clu` is a line, one in `music*.clu` is a tune, and a
 * resource anywhere else is an effect. The demo ships neither container, so
 * its whole audio surface is forty-eight effects.
 *
 * ## Names come from the game
 *
 * A Sword II resource carries its own name in its header — `Wav fxfoghorn`,
 * `Wav fxDog12JM` — so unlike every other family's listing this one has
 * something better than a number to show, and shows it.
 */

import type { ProjectAudio } from '../audio.js';

/** One sound the game holds, as the listing needs to describe it. */
export interface Sword2AudioEntry {
  readonly id: number;
  /** The resource header's own name, which is usually `Wav <something>`. */
  readonly name: string;
  /** The whole resource's length, header included. */
  readonly bytes: number;
  /** The cluster it lives in, which is what decides the kind. */
  readonly cluster: string;
  /**
   * The streamed container it lives in, for the two kinds that are not
   * resources.
   *
   * Present only for speech and music on a retail install, where the recording
   * is an entry in `SPEECH1.CLU` or `MUSIC1.CLU` rather than a resource — `id`
   * is then its index in that container's own table, which is the id a script
   * plays it by, and not a `resource.tab` id at all. Absent for an effect,
   * which is a resource and is read through the resource index.
   */
  readonly file?: string;
}

export interface Sword2AudioSources {
  readonly entries: readonly Sword2AudioEntry[];
}

/** Which of the three kinds a cluster's or a container's contents are. */
export function sword2AudioKind(cluster: string): 'speech' | 'music' | 'effects' {
  if (/^speech\d*\.clu$/i.test(cluster)) return 'speech';
  if (/^music\d*\.clu$/i.test(cluster)) return 'music';
  return 'effects';
}

/**
 * Every sound resource, as numbered rows with no bytes in them.
 *
 * Project ids are positional as they are in the other two families, and here
 * the reason is weaker but still real: a resource id is unique, so it *could*
 * be the project id — but `ProjectAudio.id` is the number an author's imported
 * file would also take, and letting the two number spaces meet is how an
 * import silently shadows resource 719.
 *
 * Music first, then effects, then speech, for AGOS's reason: a retail install
 * has tens of tunes and thousands of lines.
 */
export function listSword2Audio(sources: Sword2AudioSources): ProjectAudio[] {
  const order = { music: 0, effects: 1, speech: 2 } as const;
  const sorted = [...sources.entries].sort((left, right) => {
    const byKind = order[sword2AudioKind(left.cluster)] - order[sword2AudioKind(right.cluster)];
    return byKind !== 0 ? byKind : left.id - right.id;
  });

  return sorted.map((entry, index) => {
    const kind = sword2AudioKind(entry.cluster);
    return {
      id: index + 1,
      // The game's own name where it has one, and the id either way: two of the
      // demo's effects are called `fxDog12JMx` and `fxDog12JMy`, which is not
      // enough on its own to tell an author which resource they are looking at.
      name: entry.name ? `${entry.name} (${entry.id})` : `${label(kind)} ${entry.id}`,
      // Every sound in this family is a whole RIFF file inside the resource
      // payload, speech included — there is no second encoding here the way
      // there is in Sword 1.
      format: 'wav',
      filename: entry.file ?? entry.cluster,
      bytes: entry.bytes,
      resource: {
        engine: 'sword2',
        kind,
        number: entry.id,
        // Which container, where there is one. It is the difference between two
        // addresses that look identical: entry 719 of `SPEECH1.CLU` and
        // resource 719 are different recordings, and whatever resolves one back
        // to bytes has to be told which it has.
        ...(entry.file === undefined ? {} : { file: entry.file }),
      },
    };
  });
}

function label(kind: 'speech' | 'music' | 'effects'): string {
  return kind === 'speech' ? 'Speech' : kind === 'music' ? 'Music' : 'Effect';
}
