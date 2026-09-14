/**
 * Progress reporting for the load path.
 *
 * Loading a game is several seconds of work on a slow machine — reading 6-10 MB
 * off disk, XORing all of it, then walking the container — and none of it says
 * anything to the player. Each step reports itself here so the UI can name what
 * it is doing and how far along it is, rather than showing one opaque
 * "Loading…" that turns into "Running".
 */

export type LoadStage =
  | 'reading-archive'
  | 'detecting'
  | 'reading-index'
  | 'parsing-index'
  | 'reading-data'
  | 'decrypting'
  | 'parsing-container'
  | 'preparing'
  | 'booting'
  | 'ready';

export interface LoadProgress {
  readonly stage: LoadStage;
  /** A sentence for the player: "Reading MONKEY.001 (5.4 MB)…". */
  readonly message: string;
  /** Overall completion, 0-1. Never goes backwards within one load. */
  readonly fraction: number;
}

export type ProgressReporter = (progress: LoadProgress) => void;

/**
 * Share of the bar each stage gets.
 *
 * Rough measurements on a v5 game, not equal slices: reading the data file
 * dominates, and parsing the index is trivial next to walking the container.
 * Being approximately right keeps the bar from stalling at one number and then
 * jumping.
 */
const STAGE_WEIGHTS: ReadonlyArray<readonly [LoadStage, number]> = [
  ['reading-archive', 4],
  ['detecting', 4],
  ['reading-index', 6],
  ['parsing-index', 6],
  ['reading-data', 40],
  ['decrypting', 20],
  ['parsing-container', 16],
  ['preparing', 2],
  ['booting', 2],
  ['ready', 0],
];

const TOTAL_WEIGHT = STAGE_WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

/** Weight completed before each stage starts, so a stage maps to a span. */
function stageStarts(): Map<LoadStage, number> {
  const starts = new Map<LoadStage, number>();
  let completed = 0;
  for (const [stage, weight] of STAGE_WEIGHTS) {
    starts.set(stage, completed);
    completed += weight;
  }
  return starts;
}

const STAGE_START = stageStarts();
const STAGE_WEIGHT = new Map<LoadStage, number>(STAGE_WEIGHTS);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** "1 room", "2 rooms" — status text is read by people, so it agrees. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "5.4 MB", for messages that name a file size. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Turns stage reports into a monotonic 0-1 fraction, and yields to the browser
 * between steps.
 *
 * The yielding is the half that makes the bar visible at all: the load is one
 * long run of synchronous array work, so without handing control back the
 * browser never repaints and the player sees the final state only.
 *
 * Yields happen only when someone is listening, so tests and the CLI keep the
 * straight-line synchronous path.
 */
export class LoadProgressTracker {
  private readonly reporter: ProgressReporter | undefined;
  private highest = 0;

  constructor(reporter?: ProgressReporter) {
    this.reporter = reporter;
  }

  /** True when a listener is attached and yielding is worth the latency. */
  get enabled(): boolean {
    return this.reporter !== undefined;
  }

  /**
   * Reports a stage, optionally part-way through it.
   *
   * `within` is progress inside this stage (0-1) for the stages that can
   * measure themselves, such as reading a file by chunks.
   */
  report(stage: LoadStage, message: string, within = 1): void {
    if (!this.reporter) return;
    const start = STAGE_START.get(stage) ?? 0;
    const weight = STAGE_WEIGHT.get(stage) ?? 0;
    const fraction = (start + weight * clamp01(within)) / TOTAL_WEIGHT;
    this.highest = Math.max(this.highest, fraction);
    this.reporter({ stage, message, fraction: this.highest });
  }

  /** Reports the final state at a full bar. */
  finish(message: string): void {
    if (!this.reporter) return;
    this.highest = 1;
    this.reporter({ stage: 'ready', message, fraction: 1 });
  }

  /** Lets the browser paint. A no-op when nobody is watching. */
  async yieldToUi(): Promise<void> {
    if (!this.reporter) return;
    await nextPaint();
  }
}

/**
 * Resolves once the browser has actually put the last change on screen.
 *
 * An animation frame callback runs *before* the frame is painted, and so do
 * the microtasks it queues — an `await` among them included. Resolving there
 * hands the thread back while the change is still invisible, and the caller
 * then blocks for seconds on a screen that never showed it. A task queued from
 * inside the frame is the first thing that runs after the pixels land.
 */
function nextPaint(): Promise<void> {
  if (typeof requestAnimationFrame === 'function') {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
