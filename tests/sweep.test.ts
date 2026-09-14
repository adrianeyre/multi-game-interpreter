import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { formatSweepReport, sweepGame } from '../src/engine/sweep.js';
import { buildClassicFixture } from './fixtureClassic.js';
import { buildFixture } from './fixture.js';
import { buildV6Fixture } from './fixtureV6.js';
import { buildV7Fixture } from './fixtureV7.js';
import { buildV8Fixture } from './fixtureV8.js';

/**
 * The standing sweep, pointed at every supported Target (#205).
 *
 * The criterion this file exists for is "it works for every supported Target,
 * not just v5", and it was previously evidenced by somebody writing seven
 * fixture installs to a temporary folder and running `npm run sweep` at each
 * of them. That is a true claim which decays without saying so: nothing here
 * could reach the sweep at all while it was a top-level script in `bin/`, so a
 * Version could stop being reachable by it and every test would still pass.
 *
 * **What this does and does not prove.** It proves the tool reaches each
 * Target — boots it, enumerates its rooms, finds objects with verb tables and
 * runs their handlers. It does not prove any Target reads its *game*
 * correctly: these are synthetic installs, and Tier 1's trap is exactly that a
 * fixture encodes this project's reading of the format, so the fixture and the
 * engine agree with each other. Sweeping a real game is still a local command
 * against data that is gitignored and stays that way.
 *
 * That distinction is not academic here. Pointing the sweep at the fixtures for
 * the first time is what found a pre-v5 verb table whose offsets counted from
 * the wrong byte, so the fixture decoded an object's own id and position as
 * instructions.
 */

interface SweepTarget {
  readonly name: string;
  readonly files: Array<[string, Uint8Array]>;
}

function pair(fixture: {
  indexName: string;
  index: Uint8Array;
  dataName: string;
  data: Uint8Array;
}): Array<[string, Uint8Array]> {
  return [
    [fixture.indexName, fixture.index],
    [fixture.dataName, fixture.data],
  ];
}

const TARGETS: readonly SweepTarget[] = [
  { name: 'v2', files: [...buildClassicFixture({ version: 2 }).files] },
  { name: 'v3', files: [...buildClassicFixture({ version: 3 }).files] },
  { name: 'v4', files: [...buildClassicFixture({ version: 4 }).files] },
  { name: 'v5', files: pair(buildFixture()) },
  { name: 'v6', files: pair(buildV6Fixture()) },
  { name: 'v7', files: pair(buildV7Fixture()) },
  { name: 'v8', files: [...buildV8Fixture().files] },
];

/**
 * Settle and handler frames small enough to keep the suite quick.
 *
 * A fixture has one room and one boot script, so it does not need the twelve
 * seconds a shipped game's boot takes to put an ego somewhere and build a verb
 * panel.
 */
const SETTLE = 20;
const FRAMES = 4;

async function sweep(target: SweepTarget) {
  const log: string[] = [];
  const engine = await ScummEngine.create(new MemoryDataSource(target.name, target.files), {
    onLog: (message) => log.push(message),
  });
  return sweepGame(engine, log, { settleFrames: SETTLE, handlerFrames: FRAMES });
}

describe.each(TARGETS)('sweeping a SCUMM $name game', (target) => {
  it('reaches a room, an object and a verb handler', async () => {
    const report = await sweep(target);

    // The assertion that matters. A sweep which entered nothing reports no
    // findings, and "no findings" from a tool that ran nothing is the one
    // result worse than a failure — so the counts are checked before them.
    expect(report.rooms, 'entered no room').toBeGreaterThan(0);
    expect(report.objects, 'found no object with a verb table').toBeGreaterThan(0);
    expect(report.handlers, 'ran no verb handler').toBeGreaterThan(0);
  });

  it('reports no findings against its own fixture', async () => {
    const report = await sweep(target);

    expect(report.findings.join('\n')).toBe('');
  });
});

describe('what the sweep reports', () => {
  it('says so when it ran nothing, rather than only that it found nothing', async () => {
    // A room number no fixture has, so the sweep enters nothing at all. The
    // report has to be readable as "ran nothing" rather than as a pass.
    const log: string[] = [];
    const engine = await ScummEngine.create(new MemoryDataSource('v5', pair(buildFixture())), {
      onLog: (message) => log.push(message),
    });
    const report = sweepGame(engine, log, {
      settleFrames: SETTLE,
      handlerFrames: FRAMES,
      onlyRoom: 9999,
    });

    expect(report.handlers).toBe(0);
    expect(formatSweepReport(report)).toContain(
      'Swept 0 verb handlers across 0 objects in 0 rooms',
    );
  });

  it('counts a handler that threw as a finding, rather than printing it and passing', async () => {
    const log: string[] = [];
    const engine = await ScummEngine.create(new MemoryDataSource('v5', pair(buildFixture())), {
      onLog: (message) => log.push(message),
    });

    // The failure mode this replaced: a throw went to the console and never
    // reached `findings`, so the sweep printed the throw and then exited 0
    // saying "No findings."
    const scripts = engine.scripts as unknown as {
      runObjectScript: (...args: never[]) => void;
    };
    scripts.runObjectScript = () => {
      throw new Error('handler exploded');
    };

    const report = sweepGame(engine, log, { settleFrames: SETTLE, handlerFrames: FRAMES });

    expect(report.handlers).toBeGreaterThan(0);
    expect(report.findings.join('\n')).toContain('Handlers that threw');
    expect(formatSweepReport(report)).not.toContain('No findings.');
  });
});
