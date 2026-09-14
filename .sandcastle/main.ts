/**
 * The Sandcastle entrypoint for this repository.
 *
 *   npx tsx .sandcastle/main.ts <name>
 *   npx tsx .sandcastle/main.ts <name> --setup=freeware
 *
 * A run's name is the whole of its configuration: it resolves to a gitignored
 * `prompt-<name>.md`, the branch `sandcastle/<name>` and the report
 * `<name>.md`. Only `--setup` is separate, because which files the sandbox
 * needs before the agent starts is a property of the games a job reads rather
 * than of its name.
 *
 * `docs/processes/running-sandcastle.md` is the prose; this is the wiring, and
 * the five things it wires that the blank template does not are the reason that
 * file has a section each: game data arrives as a read-only mount rather than
 * in the image, the two freeware games are fetched inside the sandbox instead,
 * a private CA is forwarded when the host is using one, the commits land on a
 * named branch rather than in the working directory, and a prompt is a local
 * file rather than a tracked record.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { run, claudeCode } from '@ai-hero/sandcastle';
import { docker } from '@ai-hero/sandcastle/sandboxes/docker';
import type { MountConfig } from '@ai-hero/sandcastle';

/**
 * Game data is mounted, never copied and never baked in.
 *
 * Every sweep, diagnose, reexport and shot script reads the files of a game
 * somebody owns, and this repository ships none of them, so a sandbox with no
 * mount can only reach the synthetic fixtures. Each folder named here is
 * offered read-only at `/home/agent/games/<name>`, which is the path the
 * prompt quotes; a folder that is not on this machine is skipped rather than
 * failing the run, because the set of games a person owns is theirs.
 *
 * Every run gets every folder rather than the ones its own family needs. A
 * SCUMM run with King's Quest III mounted ignores it, and the alternative — a
 * per-run mount list — is a second place for a path to be wrong, in exchange
 * for nothing: a read-only bind mount the agent never opens costs a line of
 * `docker run`.
 */
const GAME_FOLDERS = [
  'dott',
  'fate',
  'kq3',
  'kq4',
  // King's Quest VII, SCI2.1 middle: the first SCI32 release read here, and the
  // only one that can settle a SCI32 question. Every fault the SCI32 compositor
  // work has turned up so far — a list node keyed with nought, a screen item
  // that was never removed, a View drawn in the last Picture's colours, two
  // resolutions read as one — was invisible to the 4,897 tests and the 25
  // demos, because each is a bookkeeping error a game only pays for once it is
  // doing several things at once.
  'kq7',
  'loom',
  'simon1',
  'simon2',
  'sky',
  'sword1',
  'sword2',
] as const;

/**
 * A second place a mount name may be found, per name.
 *
 * `temp/<name>` is looked for first and stays the documented convention. These
 * are the full game names an operator is likelier to have on disk already, and
 * they exist because a run that cannot see Loom cannot be asked whether Loom
 * plays: the `playable-five` job needed all five of these at once, and the
 * alternative was asking a person to duplicate several hundred megabytes of
 * game data to satisfy a naming convention.
 *
 * **This is run configuration, not engine code.** Nothing under `src/`,
 * `tests/` or `bin/` may name a folder like this — a game reaches those through
 * a path argument or a mount, which is what keeps a Target independent of where
 * one machine keeps its files. The mount name is what a prompt quotes, and it
 * stays `/home/agent/games/loom` whichever candidate answered, so no prompt and
 * no tool learns which of the two this machine used.
 */
const GAME_FOLDER_ALIASES: Readonly<Record<string, readonly string[]>> = {
  dott: ['g/dott'],
  loom: ['g/loom'],
  simon1: ['g/simon-the-sorcerer'],
  simon2: ['g/simon-the-sorcerer-2'],
  sky: ['g/beneath-a-steel-sky'],
};

/** The first candidate for a name that is on this machine, or null when none is. */
function findGameFolder(name: string): string | null {
  const candidates = [
    resolve('temp', name),
    ...(GAME_FOLDER_ALIASES[name] ?? []).map((candidate) => resolve(candidate)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const gameMounts: MountConfig[] = GAME_FOLDERS.map((name) => ({
  name,
  hostPath: findGameFolder(name),
}))
  .filter((found): found is { name: string; hostPath: string } => found.hostPath !== null)
  .map(({ name, hostPath }) => ({
    hostPath,
    sandboxPath: `/home/agent/games/${name}`,
    readonly: true,
  }));

/**
 * Held apart from `gameMounts` so the summary line can name the games.
 *
 * One list would print the CA certificate as though it were a game, which is
 * the first thing a person checks when a row says fixture and they own the
 * game — so the line has to be trustworthy about exactly that.
 */
const mounts: MountConfig[] = [...gameMounts];

/**
 * A ScummVM checkout, read-only, when the host has one at `temp/scummvm`.
 *
 * `README.md` names ScummVM as "the reference implementation this project
 * checks itself against", and `bin/agos-gen-tables.ts` already takes a checkout
 * as an argument — "it is not vendored into this repository", for the same
 * reason game data never is. This mount is that argument, made available to an
 * agent instead of to a script.
 *
 * **It is a reference for meaning, never a source to copy tables from.** ADR
 * 0029 says the opcode tables are generated by `npm run gen:agos-tables` and
 * hand-editing the output is the one thing forbidden; what a checkout answers
 * is the question generation cannot — what an opcode *does*. The AGOS Simon 2
 * work is the case that made this worth wiring: `os2_animate`'s six operands,
 * the `_marks` bitmask, and `vc73_setMark` reading **one word** where the
 * debugger's own table prints it as `bb`, are all facts a run would otherwise
 * have had to guess, and ADR 0024 already allows engine control-flow to be
 * transcribed from it.
 *
 * Outside the workspace, like the games and for the same reason: nothing under
 * `/home/agent/workspace` is safe from a `git add -A`. Absent on this machine
 * is skipped rather than fatal, so a run still starts — and the prompt has to
 * say what it got, which the summary line below prints.
 */
const scummvmMount: MountConfig | undefined = existsSync(resolve('temp', 'scummvm'))
  ? { hostPath: resolve('temp', 'scummvm'), sandboxPath: '/home/agent/scummvm', readonly: true }
  : undefined;

if (scummvmMount) mounts.push(scummvmMount);

/**
 * Where a run's report goes, and the one mount that is writable.
 *
 * **An iteration boundary recreates the worktree.** The first AGI/SCI run wrote
 * its report to `.sandcastle/agi-sci-version-matrix.md` inside the workspace,
 * finished the whole matrix, and then did not emit
 * `<promise>COMPLETE</promise>` — so Sandcastle started iteration 2, set the
 * worktree up again, and the report was gone. Every measurement in it survived
 * only because the log had scrolled past on the host.
 *
 * A gitignored file is safe from `git add`; it is not safe from the directory
 * being rebuilt. So the report is written outside the worktree, to a host
 * folder that no iteration owns, and the prompt names `/home/agent/reports`
 * rather than a path under the workspace.
 *
 * This is the only mount that is not read-only, and it is deliberately not the
 * worktree: writable-and-outside-git is exactly the combination a report wants
 * and exactly the wrong one for game data.
 */
const REPORTS_DIR = resolve('.sandcastle', 'reports');
mkdirSync(REPORTS_DIR, { recursive: true });
mounts.push({
  hostPath: REPORTS_DIR,
  sandboxPath: '/home/agent/reports',
  readonly: false,
});

/**
 * A private CA, when the host is talking to Anthropic through one.
 *
 * `NODE_EXTRA_CA_CERTS` on the host names a certificate the container cannot
 * see, so the file is mounted and the variable is re-pointed at where it
 * landed. Without this the agent's first request fails to verify and the run
 * dies before the prompt is read.
 */
const hostCaCert = process.env.NODE_EXTRA_CA_CERTS;
const caCertInSandbox = '/home/agent/ca-certificates.pem';
const forwardCaCert = Boolean(hostCaCert && existsSync(hostCaCert));

if (forwardCaCert && hostCaCert) {
  mounts.push({ hostPath: hostCaCert, sandboxPath: caCertInSandbox, readonly: true });
}

/**
 * One command an `onSandboxReady` hook runs.
 *
 * Declared here rather than imported: the package types the hook inline and
 * exports no name for the element, so a local alias is what lets a run carry
 * its own list instead of every run sharing one.
 */
type SandboxCommand = { readonly command: string; readonly timeoutMs?: number };

/** What every run needs before the agent starts, and all most runs need. */
const INSTALL: SandboxCommand = { command: 'npm ci', timeoutMs: 600_000 };

/**
 * The Virtual Theatre releases, fetched inside the sandbox rather than mounted.
 *
 * These are the only complete commercial games in `docs/released-games.md`
 * whose data a build machine may lawfully fetch — Revolution released both
 * their adventures as freeware in 2003 — and
 * `docs/processes/verifying-version-support.md` calls that "the one place CI
 * can check a game". Spending it is what keeps this matrix reproducible on a
 * machine that owns nothing, where the SCUMM and AGI/SCI runs have to report a
 * fixture row for every game the operator happens not to have.
 *
 * **The URLs live here and not in `bin/fetch-vt.ts`.** That file refuses to
 * ship a catalogue, and gives the reason: "a rotted link in a tool like this
 * fails at the moment somebody is trying to diagnose something else". The
 * reasoning does not carry to a run configuration, because the failure lands
 * somewhere else — an `onSandboxReady` hook fails the run before the agent is
 * started, naming the URL, rather than surfacing halfway through a diagnosis.
 * The licence still travels with the link, so stating it is still the act of
 * having checked it.
 *
 * Four entries and five rows. `LURE_RELEASES` names `demo`, and no DOS Lure
 * demo is fetchable: ScummVM's mirror carries one Lure demo and it is an Atari
 * ST floppy image, which `.out-of-scope/virtual-theatre-non-dos-releases.md`
 * puts out of scope. The prompt is told to report that Release as having no
 * in-scope data rather than to go looking for it.
 */
const VT_RELEASES = [
  {
    id: 'lure-floppy',
    url: 'https://downloads.scummvm.org/frs/extras/Lure%20of%20the%20Temptress/lure-1.1.zip',
    licence: 'Freeware, released by Revolution Software in 2003 via ScummVM',
  },
  {
    id: 'sky-floppy',
    url: 'https://downloads.scummvm.org/frs/extras/Beneath%20a%20Steel%20Sky/BASS-Floppy-1.3.zip',
    licence: 'Freeware, released by Revolution Software in 2003 via ScummVM',
  },
  {
    id: 'sky-cd',
    url: 'https://downloads.scummvm.org/frs/extras/Beneath%20a%20Steel%20Sky/bass-cd-1.2.zip',
    licence: 'Freeware, released by Revolution Software in 2003 via ScummVM',
  },
  {
    id: 'sky-demo',
    url: 'https://downloads.scummvm.org/frs/demos/sky/sky-dos-v0267-demo-en.zip',
    licence: 'Freeware demo, distributed by ScummVM with Revolution Software’s blessing',
  },
] as const;

/**
 * `npm ci` and the fetches, chained into one hook rather than listed as five.
 *
 * **`onSandboxReady` hooks run in parallel** — Sandcastle runs the list with
 * `concurrency: "unbounded"` — so a hook that needs `node_modules` cannot be a
 * sibling of the hook that installs it. Listed separately, the four fetches
 * raced `npm ci` and the run died on `sh: 1: vite-node: not found`, which names
 * the symptom and not the cause. Chaining with `&&` is what orders them.
 *
 * The consequence is one timeout covering install and roughly 80 MB of
 * download, so it is a budget for the pair rather than for either.
 */
/**
 * Above The Waves, fetched inside the sandbox rather than mounted.
 *
 * SLUDGE's games are freeware, which is the whole reason this family was built
 * before the other 119 (`docs/scummvm-parity-roadmap.md`). So this run needs no
 * mount and reports no fixture rows: the evidence is a real shipped game on a
 * machine that owns nothing, which is the property only Sky, Lure and SLUDGE
 * have here.
 *
 * The zip lands in `games/`, which is gitignored — the prompt says the fetched
 * data must not reach anything tracked, and this is the half of that promise
 * the configuration keeps.
 */
const ATW_URL = 'https://downloads.scummvm.org/frs/extras/SLUDGE/atw.zip';

/**
 * Every freeware release this repository knows how to fetch, in one setup.
 *
 * The `finish-six` run's own report named this as the thing it lacked. Four of
 * the six families could not be advanced because no game data was mounted, so
 * they could only have been worked at Tier 1 — "the reading that agrees with
 * itself" — and the run declined to touch code blind against a fixture, which
 * was the right call and the reason to fix the setup rather than the prompt.
 *
 * Three of those four are reachable without owning anything. Revolution
 * released both their adventures as freeware, and Adventure Soft's demos are
 * freely redistributable, so Sky, Lure and AGOS can each be met as a real
 * shipped game on a build machine. SCUMM v7 cannot: Full Throttle and The Dig
 * are neither freeware nor demoed, so that row stays at whatever a mount
 * provides.
 *
 * An AGOS demo is a subset and the honest weaker claim — a demo Simon 1 has 68
 * Subroutines where the retail game has several hundred, so an opcode no demo
 * reaches is one this says nothing about. It is still a real game's bytes
 * rather than ours.
 */
const AGOS_DEMOS = [
  {
    id: 'simon1-demo',
    url: 'https://downloads.scummvm.org/frs/demos/agos/simon1-dos-floppy-demo-en.zip',
    licence: 'Freely redistributable demo, distributed by ScummVM',
  },
] as const;

const INSTALL_AND_FETCH_FREEWARE: SandboxCommand = {
  command: [
    INSTALL.command,
    ...VT_RELEASES.map(
      (release) =>
        `npm run fetch:vt -- ${release.url} ${release.id} ${JSON.stringify(release.licence)}`,
    ),
    ...AGOS_DEMOS.map(
      (demo) => `npm run fetch:agos -- ${demo.url} ${demo.id} ${JSON.stringify(demo.licence)}`,
    ),
  ].join(' && '),
  timeoutMs: 2_700_000,
};

const INSTALL_AND_FETCH_SLUDGE: SandboxCommand = {
  command: [INSTALL.command, 'mkdir -p games', `curl -sSL -o games/atw.zip ${ATW_URL}`].join(
    ' && ',
  ),
  timeoutMs: 1_800_000,
};

const INSTALL_AND_FETCH_VT: SandboxCommand = {
  command: [
    INSTALL.command,
    ...VT_RELEASES.map(
      (release) =>
        `npm run fetch:vt -- ${release.url} ${release.id} ${JSON.stringify(release.licence)}`,
    ),
  ].join(' && '),
  timeoutMs: 1_800_000,
};

/**
 * The setups a run can ask for, by the name you pass to `--setup=`.
 *
 * This is all that is left of what used to be a table of named runs. That
 * table paired a name with a prompt file, a branch, a report and a setup, and
 * carried a paragraph of history for each — nineteen prompt files tracked in
 * git, every one of them the record of a job that had already shipped.
 *
 * A prompt is now a **local file**, `prompt-<name>.md`, gitignored beside
 * `prompt.md`, and everything else is derived from the name. What could not be
 * derived is which files the sandbox needs before the agent starts, because
 * that is a property of the games a job reads rather than of its name — so it
 * stays, as four choices with `install` the default.
 */
const SETUPS = {
  install: INSTALL,
  freeware: INSTALL_AND_FETCH_FREEWARE,
  vt: INSTALL_AND_FETCH_VT,
  sludge: INSTALL_AND_FETCH_SLUDGE,
} as const;

type SetupName = keyof typeof SETUPS;

function flag(name: string): string | undefined {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

/**
 * Which prompt a name resolves to.
 *
 * `prompt-<name>.md` when the operator has written one, and `prompt.md`
 * otherwise. Both are looked for rather than one being required, because
 * `prompt.md` is the worked example of what a prompt here has to contain —
 * a run launched against it directly is reading the example, which is a
 * mistake worth making cheaply rather than a usage error.
 */
const requested = process.argv[2] ?? 'default';
if (requested.startsWith('--')) {
  console.error('usage: npx tsx .sandcastle/main.ts <name> [--setup=install|freeware|vt|sludge]');
  process.exit(1);
}

const named = resolve('.sandcastle', `prompt-${requested}.md`);
const promptFile = existsSync(named) ? named : resolve('.sandcastle', 'prompt.md');
const usingExample = promptFile.endsWith('prompt.md');

const setupName = (flag('setup') ?? 'install') as SetupName;
if (!(setupName in SETUPS)) {
  console.error(`Unknown setup "${setupName}". Choose one of: ${Object.keys(SETUPS).join(', ')}`);
  process.exit(1);
}

const branch = `sandcastle/${requested}`;
const report = `${requested}.md`;

console.log(`Sandcastle run "${requested}"`);
console.log(`  prompt   ${promptFile}${usingExample ? '  ← the worked example, not a job' : ''}`);
console.log(`  branch   ${branch}`);
console.log(`  setup    ${setupName}`);
console.log(
  `  games    ${
    gameMounts.length
      ? gameMounts.map((mount) => mount.sandboxPath).join(', ')
      : 'none on this machine'
  }`,
);
console.log(`  scummvm  ${scummvmMount ? scummvmMount.sandboxPath : 'not on this machine'}`);
console.log(`  report   ${REPORTS_DIR}/${report}`);

if (usingExample) {
  console.log('');
  console.log(`  No .sandcastle/prompt-${requested}.md here, so this run would read the`);
  console.log('  example. Write that file first — prompt.md says what it has to contain.');
}

await run({
  agent: claudeCode('claude-opus-5'),
  sandbox: docker({
    mounts,
    env: forwardCaCert ? { NODE_EXTRA_CA_CERTS: caCertInSandbox } : {},
  }),
  promptFile,
  /**
   * A named branch, **cut from `main`** rather than from whatever is checked out.
   *
   * `baseBranch` defaults to `HEAD`, which makes a run's starting point a
   * property of the branch the operator happened to be standing on — so two
   * runs of the same name a week apart can be built on different code, and a
   * run launched from a feature branch carries that feature's unreviewed work
   * into its own diff. Naming `main` makes the base the same every time and
   * makes the pull request at the end reviewable as itself.
   *
   * **It is ignored when the branch already exists**, which is the behaviour to
   * know rather than to work around: re-running a name continues that branch.
   * To re-cut one from `main`, remove the worktree and delete the branch first
   * (`docs/processes/running-sandcastle.md`).
   */
  branchStrategy: { type: 'branch', branch, baseBranch: 'main' },
  maxIterations: 4,
  idleTimeoutSeconds: 1_800,
  hooks: {
    sandbox: {
      onSandboxReady: [SETUPS[setupName]],
    },
  },
});
