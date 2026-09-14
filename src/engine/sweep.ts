/**
 * Every verb handler on every object in every room, run from a settled game.
 *
 * The tier between a synthetic fixture and a person playing the game.
 * `docs/processes/verifying-version-support.md` describes the gap this fills:
 * Tier 1's trap is that a fixture encodes our reading of the format, so the
 * fixture and the engine agree with each other and disagree with the game;
 * Tier 2 is a person and is not automatable. This is neither. It is the
 * bytecode a player triggers, run without having to solve the puzzles that
 * reach it.
 *
 * It lives here rather than in `bin/scumm-sweep.ts` — which is now a CLI over
 * it — for one reason, and it is #205's criterion rather than tidiness. "It
 * works for every supported Target, not just v5" was true and was evidenced
 * only by somebody running it by hand against seven fixture installs written
 * to a temporary folder. That is a claim which decays silently: a Version's
 * reader can stop being reachable by the sweep without any test noticing,
 * because no test could reach the sweep at all while it was a top-level
 * script. Extracted, `tests/sweep.test.ts` points it at every Target in CI.
 *
 * Sweeping a *real game* still cannot run in CI, for the reason nothing with
 * real data can: `games/` is gitignored and stays that way. The fixtures are
 * synthetic and prove a weaker thing — that the tool reaches each Target, not
 * that each Target reads its game correctly. Both are worth having, and they
 * are not the same claim.
 */
import type { ScummEngine } from './ScummEngine.js';

export interface SweepOptions {
  /**
   * Frames of boot before the sweep starts.
   *
   * A game's handlers assume a settled world: variables the boot script sets,
   * the ego in a room, the verb panel built. Sweeping from frame zero reports
   * the boot script's own unfinished business as a fault in every handler.
   */
  readonly settleFrames?: number;
  /** Frames each handler is given to run before the next one starts. */
  readonly handlerFrames?: number;
  /** Sweep one room only, for chasing a finding back to its handler. */
  readonly onlyRoom?: number;
  /** Count a script that spun as a finding rather than as expected. */
  readonly strict?: boolean;
  /** A line per room and per handler, for following a sweep as it runs. */
  readonly onProgress?: (line: string) => void;
}

export interface SweepReport {
  /** The room the game had settled into before any handler was run. */
  readonly settledInRoom: number;
  readonly rooms: number;
  readonly objects: number;
  readonly handlers: number;
  /**
   * What the sweep found, each line ready to print.
   *
   * Empty is the passing state, and it is what the exit code is read from.
   */
  readonly findings: readonly string[];
  /**
   * Scripts still running when the sweep ended, which is usually not a fault.
   *
   * Reported apart from `findings` because a cold entry causes it: a handler
   * that waits for the ego to walk somewhere waits forever when the sweep has
   * dropped into the room with the ego already standing there. `strict` moves
   * these into `findings`.
   */
  readonly spinning: readonly number[];
}

/**
 * Runs the sweep, mutating the engine as it goes.
 *
 * `log` must be the live array the engine's `onLog` appends to — the sweep
 * reads its length before starting so that a fault the *boot* produced is not
 * counted again against a handler that had nothing to do with it.
 */
export function sweepGame(
  engine: ScummEngine,
  log: readonly string[],
  options: SweepOptions = {},
): SweepReport {
  const settleFrames = options.settleFrames ?? 12 * 60;
  const handlerFrames = options.handlerFrames ?? 6;
  const onlyRoom = options.onlyRoom ?? 0;
  const strict = options.strict ?? false;
  const progress = options.onProgress ?? (() => {});

  engine.boot();
  for (let frame = 0; frame < settleFrames; frame += engine.ticksPerStep) engine.step();
  const settledInRoom = engine.currentRoom;

  /** What the engine had already reported before the sweep started. */
  const beforeOpcodes = new Set(engine.unknownOpcodes.keys());
  const beforeStuck = new Set(engine.stuckScripts);
  const beforeUnresolved = new Set(engine.resources.unresolved);
  const beforeLog = log.length;

  const rooms = engine.resources.listRooms().filter((room) => onlyRoom === 0 || room === onlyRoom);

  let objectCount = 0;
  let handlerCount = 0;
  let roomCount = 0;

  /** Rooms that could not be entered at all, which is a finding of its own. */
  const unenterable: number[] = [];

  /**
   * Handlers that threw out of the engine rather than running.
   *
   * Collected rather than only printed. This used to go straight to the
   * console and nowhere else, so a game whose every handler threw still ended
   * on "No findings." and exit 0 — the sweep's own report contradicting the
   * lines above it, which is the failure mode the tool exists to prevent.
   */
  const threw: string[] = [];

  for (const room of rooms) {
    try {
      engine.startScene(room, null, 0);
    } catch (error) {
      unenterable.push(room);
      progress(`[room ${room}] could not be entered: ${String(error)}`);
      continue;
    }

    // A few frames for the entry script, which is what puts the room's objects
    // into the state its handlers expect to find them in.
    for (let frame = 0; frame < handlerFrames; frame++) engine.step();

    roomCount++;
    const objects = engine.currentRoomData?.objects ?? [];

    for (const object of objects) {
      if (object.verbs.size === 0) continue;
      objectCount++;

      for (const entry of object.verbs.keys()) {
        handlerCount++;
        progress(`[room ${room}] object ${object.id} verb ${entry}`);
        try {
          engine.scripts.runObjectScript(object.id, entry, false, false, []);
          for (let frame = 0; frame < handlerFrames; frame++) engine.step();
        } catch (error) {
          threw.push(`room ${room} object ${object.id} verb ${entry}: ${String(error)}`);
        }
      }
    }
  }

  /** Anything the engine reported that it had not reported before the sweep. */
  const newOpcodes = [...engine.unknownOpcodes.entries()].filter(
    ([code]) => !beforeOpcodes.has(code),
  );
  const newUnresolved = [...engine.resources.unresolved].filter(
    (resource) => !beforeUnresolved.has(resource),
  );
  const newLog = log.slice(beforeLog);

  const subOpcodes = newLog.filter(
    (line) => line.startsWith('Unimplemented ') && line.includes(' sub-opcode '),
  );

  /**
   * The two ways a script ends up in `stuckScripts`, told apart by what was
   * said about it.
   *
   * They mean opposite things and the whole value of this report is in not
   * conflating them. A script that **read past the end of its code** consumed
   * the wrong number of operands somewhere upstream: that is the engine
   * misreading the game, and it is a finding whatever else is true. A script
   * that **ran without yielding** is spinning, and spinning is what a cold
   * entry causes.
   */
  const overrun = newLog
    .filter((line) => line.includes('read past the end of its code'))
    .map((line) => Number(line.split(' ')[1]));

  const spinning = [...engine.stuckScripts].filter(
    (script) => !beforeStuck.has(script) && !overrun.includes(script),
  );

  const findings: string[] = [];
  if (newOpcodes.length > 0) {
    findings.push(
      `Unimplemented instructions (${newOpcodes.length}): ` +
        newOpcodes
          .map(([code, script]) => `0x${code.toString(16).padStart(2, '0')} in script ${script}`)
          .join(', '),
    );
  }
  if (subOpcodes.length > 0) {
    findings.push(
      `Unimplemented sub-opcodes (${subOpcodes.length}):`,
      ...subOpcodes.map((line) => `  ${line}`),
    );
  }
  if (overrun.length > 0) {
    findings.push(
      `Scripts that read past the end of their code (${overrun.length}): ${overrun.join(', ')}`,
    );
  }
  if (newUnresolved.length > 0) {
    findings.push(
      `Resources that could not be found (${newUnresolved.length}): ` +
        newUnresolved.slice(0, 40).join(', ') +
        (newUnresolved.length > 40 ? `, and ${newUnresolved.length - 40} more` : ''),
    );
  }
  if (unenterable.length > 0) {
    findings.push(
      `Rooms that could not be entered (${unenterable.length}): ${unenterable.join(', ')}`,
    );
  }
  if (threw.length > 0) {
    findings.push(`Handlers that threw (${threw.length}):`, ...threw.map((line) => `  ${line}`));
  }
  if (strict && spinning.length > 0) {
    findings.push(`Scripts that spun (${spinning.length}): ${spinning.join(', ')}`);
  }

  return {
    settledInRoom,
    rooms: roomCount,
    objects: objectCount,
    handlers: handlerCount,
    findings,
    spinning,
  };
}

/** The report as a person reads it, which is what the CLI prints. */
export function formatSweepReport(report: SweepReport, strict = false): string {
  return [
    '',
    `Swept ${report.handlers} verb handlers across ${report.objects} objects in ` +
      `${report.rooms} rooms.`,
    '',
    report.findings.length === 0 ? 'No findings.' : report.findings.join('\n'),
    '',
    report.spinning.length === 0 || strict
      ? ''
      : `Spun rather than finished, which is the sweep's own doing rather than a ` +
        `finding: script ${report.spinning.join(', ')}. A handler that waits for the ego ` +
        `to walk somewhere waits forever when the sweep has dropped into the room ` +
        `cold with the ego already standing there. Fate of Atlantis ends on two of ` +
        `these and has done since the pseudo-room fault was fixed. Pass --strict to ` +
        `count them as findings.`,
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}
