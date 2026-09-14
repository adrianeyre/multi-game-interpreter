/**
 * Identifying a SCI game: the map's bucket, then the probes.
 *
 * Two steps rather than one, and keeping them apart is the point. The map's own
 * structure is strong evidence and narrow — it separates five buckets and no
 * more — and the probes are what turn a bucket into a Version (ADR 0020). A
 * function that mixed them would be a function nobody could say the confidence
 * of, and the confidence is what ADR 0013's editing refusal turns on.
 */

import type { DataSource } from '../../resource/DataSource.js';
import { describeSciVersion } from '../sciVersion.js';
import { SciResources, type SciLoadOptions } from './SciResources.js';
import { detectSciMap, sciLayout, VERSIONS_FOR_MAP, type DetectedSciGame } from './sciDetect.js';
import { decideVersion, runSciProbes } from './sciProbes.js';

function gameIdFor(source: DataSource, mapFile: string): string {
  // The folder the map came from, when there is one — a release's own name is
  // not in its data anywhere this early, and the folder is what a person will
  // recognise in a save list. Falls back to the label.
  const path = mapFile.replace(/\\/g, '/');
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const name = folder.split('/').pop() || source.label.split('/').pop() || 'sci';
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'sci'
  );
}

/**
 * Loads a SCI game's resource layer and works out its Target.
 *
 * Returns the reader as well as the identification, because the probes need to
 * read resources to decide the Version and there is no sense reading them
 * twice. The reader's `version` is corrected once the probes have run, which is
 * the only thing that changes underneath it — the map, the entries and the
 * offsets are all Version-independent.
 */
export async function detectSciGame(
  source: DataSource,
  options: SciLoadOptions = {},
): Promise<{ game: DetectedSciGame; resources: SciResources }> {
  const log = options.onLog ?? ((): void => undefined);

  const layout = sciLayout(source.list());
  if (!layout) {
    throw new Error(
      `No SCI game data found in ${source.label}. A SCI install is a resource map ` +
        `(RESOURCE.MAP, or RESMAP.000 and up) beside at least one numbered volume ` +
        `(RESOURCE.000, or RESSCI.000 and up).`,
    );
  }

  const { map, mapVersion } = await detectSciMap(source, layout);
  const candidates = VERSIONS_FOR_MAP[mapVersion];

  // Built on the bucket's earliest Version. Nothing the probes read depends on
  // it: method numbers 1 and 2 are the only thing the Version changes down
  // here, and `probeCompressionEra` reads those as raw numbers on purpose.
  const resources = await SciResources.load(
    source,
    layout,
    mapVersion,
    candidates[0],
    map,
    options,
  );

  const probes = await runSciProbes(resources);
  const decided = decideVersion(candidates, probes);
  resources.version = decided.version;

  const notes = [
    `${layout.mapFile} is a ${mapVersion} map, which narrows this to ` +
      `${candidates.map(describeSciVersion).join(', ')}`,
    ...probes.map((probe) => `probe "${probe.name}": ${probe.evidence}`),
    decided.why,
  ];
  for (const note of notes) log(note);

  return {
    game: {
      layout,
      mapVersion,
      version: decided.version,
      platform: 'dos',
      identification: decided.identification,
      id: gameIdFor(source, layout.mapFile),
      notes,
    },
    resources,
  };
}
