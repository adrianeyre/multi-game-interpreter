/**
 * The PMachine: one Script engine for the whole SCI family (ADR 0017).
 *
 * `CONTEXT.md` defines a Script engine as one per instruction *encoding*, and
 * an encoding by how instruction length is determined. By that test SCI has
 * one — every Version takes length from the low bit of the opcode byte — and
 * #214 checked the part of that claim that was an assumption. So there is one
 * of these, with a per-Version delta table rather than a subclass per Version.
 *
 * ## What makes this different from both siblings
 *
 * **Sends, not calls.** Nothing in the bytecode says which code will run: a
 * `send` names a Selector and the receiving object's class decides. Both a
 * method call and a property read are sends, which is why the one word covers
 * both and why the dispatch below has to look at what it found before deciding
 * whether it is calling or reading.
 *
 * **Clones.** A `kClone` makes an object at runtime by copying a class, with no
 * backing in any Script resource. ADR 0019 makes this the distinction that
 * decides whether a save is correct — a static object restores by reloading its
 * script and re-applying changed properties, a Clone has to be recreated whole
 * along with every reference into it — so they are tracked apart here rather
 * than being told apart later by whether an offset resolves.
 *
 * **An unknown Kernel number is loud.** SCI's characteristic failure is a
 * Kernel table off by one, which produces a game that runs and does the wrong
 * things. Nothing here returns zero quietly.
 */

import { selectorIdCarriesReadWriteBit, type SciVersion } from '../sciVersion.js';
import { decodeSciInstruction, formatSciInstruction, type SciInstruction } from './opcodes.js';
import { describeUnknownKernel, kernelNamesFor } from './kernel.js';

/**
 * A value in the machine: a number, or a reference to something in a segment.
 *
 * SCI's own `reg_t` is a segment and an offset, and the segment being part of
 * the *value* rather than of the variable is what lets the same slot hold an
 * integer now and an object later. Kept as a pair here for the same reason ADR
 * 0019 needs it in a save: a reference written as a number is a reference that
 * cannot be restored.
 */
export interface Reg {
  segment: number;
  offset: number;
}

export const NULL_REG: Reg = { segment: 0, offset: 0 };

export function reg(segment: number, offset: number): Reg {
  return { segment, offset };
}

export function isNull(value: Reg): boolean {
  return value.segment === 0 && value.offset === 0;
}

/** The segment every plain integer lives in, which is none. */
export const INTEGER_SEGMENT = 0;

/**
 * Where a variable's *address* lives: one segment per bank, from `lea`.
 *
 * Above any script number a game ships, so an address can never collide with a
 * real object's `script:offset`. That is what makes a misuse of one halt by
 * name rather than read whatever is at that offset in some script.
 */
export const VARIABLE_SEGMENT = 0x10000;

/**
 * Where a *local* variable's address lives: one segment per script.
 *
 * **A `lea` address has to outlive the frame that took it**, and the bank a
 * kind names does not. `lea` on the local bank means "script N's locals", and
 * which script that is depends on the frame — so an address recorded as
 * "kind 1" and read back two frames later resolves against the wrong script's
 * bank entirely. King's Quest IV's dialog is exactly that: its `DText` holds
 * `lea` of a temporary and `DrawControl` reads it from another frame, so a
 * label that is there came back empty.
 *
 * Resolved at the moment `lea` runs and encoded into the segment instead,
 * which is what makes an address a value rather than a coordinate.
 */
export const LOCALS_SEGMENT = 0x20000;

/**
 * Where a temporary's or a parameter's address lives, as an absolute stack
 * index.
 *
 * Same reasoning as `LOCALS_SEGMENT` and the same fix: a temporary is a window
 * onto the stack at a frame's own base, so the base is added at `lea` time and
 * the address means one slot for as long as the stack holds it.
 */
export const STACK_SEGMENT = 0x30000;

/**
 * What a variable's address counts from, so it reads as an address.
 *
 * **A SCI script tells a pointer from a small number by its magnitude.** The
 * idiom is Sierra's own: King's Quest IV's `GetFarText` wrapper opens
 * `if (param1 < 1000) GetFarText(param1, ...)` — "if this is a text resource
 * number rather than a pointer to a string" — and every SCI game has calls
 * shaped that way, because a real heap address is a byte offset in the
 * thousands and a resource number is not.
 *
 * A `lea` that answered a bare *index* — global 300 as `300` — failed that test
 * in the wrong direction: the wrapper took the resource branch, asked for text
 * resource 300, and got nothing. So an address is a byte offset from a base
 * above the range those tests use, which is what makes `%s` on a formatted
 * buffer resolve to the buffer rather than to a resource that does not exist.
 *
 * Byte offsets also make the arithmetic uniform: `StrEnd` advances by a
 * string's length in every space, rather than by a length in one and half a
 * length in another.
 */
export const ADDRESS_BASE = 0x1000;

/**
 * How far past a heap object's header its properties start.
 *
 * The magic word and the size word. An object's identity is its properties'
 * address, so an address that names the header has to be moved on by this to
 * name the object.
 */
const OBJECT_VARIABLES_AT = 4;

/**
 * The largest variable index any SCI bank has.
 *
 * Globals run to a few hundred, a script's locals to a few dozen, and
 * temporaries and parameters to a handful. Four thousand is far above all of
 * them and far below the sixty-five thousand a stale accumulator produces, so
 * it separates a real index from a corrupted one without needing to know which
 * bank is being addressed.
 */
const VARIABLE_BANK_LIMIT = 0x1000;

/**
 * The property-access opcodes, `pToa` through `dpTos`.
 *
 * Named rather than written as a magic range, because the range being wrong by
 * accident is what stopped every SCI game booting — and a named constant beside
 * the table that generates them is harder to get out of step with it.
 */
const FIRST_PROPERTY_OPCODE = 0x31;
const LAST_PROPERTY_OPCODE = 0x38;

/**
 * An object the machine can send to.
 *
 * `clone` is the ADR 0019 distinction, carried on the object rather than
 * derived: a Clone's `script` is the script its class came from, which is not
 * where *it* came from, so asking "does this offset resolve in a script" gives
 * the wrong answer for exactly the objects that matter.
 */
/** Byte access to whatever a reference names, for the Kernel's string calls. */
export interface SciByteView {
  readonly length: number;
  get(index: number): number;
  set(index: number, byte: number): void;
}

export interface SciObject {
  /** Where this object lives, which is also its identity in a save. */
  id: Reg;
  /** The class it is, or was cloned from. */
  species: number;
  superClass: number;
  /**
   * How many words of header sit before this object's properties.
   *
   * A property opcode's operand is a byte offset measured from the object's
   * *start*, and where an object starts differs by layout: an inline SCI0 or
   * SCI1 object's properties begin immediately, and a heap object's begin two
   * words in, past the magic word and the size word. So `pToa 20` on a heap
   * object with ten properties means the ninth, not an eleventh that is not
   * there.
   *
   * Carried on the object because the reader knows the layout and the machine
   * should not have to ask — the same reason `-info-` is a field.
   */
  propertyBias: number;
  /**
   * The `-info-` property's value, which says whether this object is a class.
   *
   * Kept as a field rather than read out of `variables` on demand, because
   * *where* it sits is a Version question — index 2 at SCI0 and SCI1, index 5
   * at SCI1.1, which drops the three leading Selectors. The reader that already
   * knows the layout records it, and the machine never has to ask.
   */
  info: number;
  /**
   * Property values, indexed as the object's own variables.
   *
   * **Registers, not numbers.** SCI's `reg_t` is a segment and an offset, and a
   * property holds one — an object pointer, a variable's address from `lea`, or
   * a plain integer in segment zero. Holding these as 16-bit numbers meant a
   * property could carry the *offset* of an object and never the segment, so
   * anything stored and read back was an integer whatever it had been.
   */
  variables: Reg[];
  /** Selector to code offset, for the methods this object defines itself. */
  methods: Map<number, number>;
  /** Which Selector each variable answers to, for a class. */
  variableSelectors: number[];
  /** The Script resource this object's code lives in. */
  script: number;
  /** True when `kClone` made it, false when a Script resource holds it. */
  clone: boolean;
  /** The object's name, where the game recorded one. */
  name?: string;
  /**
   * Marked by `kDisposeClone`, and collected by nothing yet.
   *
   * Sierra's interpreter frees a Clone at the next garbage collection rather
   * than at the call, and scripts rely on the gap — see `disposeClone`. There
   * is no collector here, so this records the mark and nothing acts on it: a
   * report can say how many Clones are waiting, which is the measurement a
   * collector would eventually be written against.
   */
  freed?: boolean;
}

/** One frame of the execution stack. */
export interface SciFrame {
  /** The object the frame is running on behalf of, which `self` resolves to. */
  self: Reg;
  /** The object whose method is running, which differs from `self` after a super. */
  object: Reg;
  script: number;
  /** Where in that script's code the program counter is. */
  pc: number;
  /** Base of this frame's parameters on the stack. */
  paramBase: number;
  /** Base of this frame's temporaries. */
  tempBase: number;
  /** For the trace: the Selector that started this frame. */
  selector: number;
  /**
   * The rest of a send's parameter block, when one instruction carried several.
   *
   * A `send` may name several Selectors in one go — `(obj foo: 1 bar: 2)` is
   * one instruction — and each runs after the one before it returns. Holding
   * the remainder on the frame is what lets `ret` pick the sequence up: a
   * machine that dispatched the first and dropped the rest runs a game whose
   * actors move and never speak, with nothing reporting a fault.
   */
  pending?: { receiver: Reg; self: Reg; block: Reg[]; at: number };
}

/** What the machine needs from the world around it. */
export interface PMachineHost {
  /** Dispatches a Kernel call; returns the value to leave in the accumulator. */
  callKernel(number: number, args: Reg[]): Reg | null;
  /** The bytes of a Script resource's code, already loaded. */
  scriptCode(script: number): Uint8Array | null;
  /**
   * Where a script's numbered export begins, or null.
   *
   * `callb` and `calle` name a procedure by export number rather than by
   * address, which is the only way a script can reach code in another one. The
   * machine cannot resolve that itself: it holds no scripts, only their bytes.
   */
  exportOffset(script: number, index: number): number | null;
  /**
   * Where a script's heap begins, or 0 when it has none.
   *
   * `lofs` needs it: at SCI1.1 the operand is measured from the heap's start.
   */
  heapStart(script: number): number;
  /** Reports something a person should see. */
  log(message: string): void;
}

/**
 * How many recently executed instructions to remember.
 *
 * `docs/processes/verifying-version-support.md` says "Every script engine keeps
 * a ring buffer of recently executed opcodes", and #217's triage found that no
 * engine in this project does — the sentence described an intention. So this is
 * the first one, and the sentence becomes true rather than being deleted.
 *
 * Sixty-four because the useful question is "what ran just before this went
 * wrong", and a send plus its arguments is a dozen instructions; sixty-four
 * covers several sends without holding a frame's worth of history per tick.
 */
const TRACE_RING = 64;

/** `-info-` bit 15: this object is a class rather than an instance. */
const CLASS_BIT = 0x8000;
/** `-info-` bit 0: this object was made by `kClone`. */
const CLONE_BIT = 0x0001;
/** `-info-` index 2 for an inline SCI0 or SCI1 object, 5 for a heap one. */
const INLINE_INFO_INDEX = 2;
const HEAP_INFO_INDEX = 5;

/**
 * How many freed Clones are allowed to pile up before a collection.
 *
 * A bound rather than a period: collecting on a timer runs when nothing has
 * changed and skips the cycle that allocated a thousand. ScummVM counts down
 * from `scriptGCInterval` on the same reasoning.
 */
const COLLECT_AFTER = 256;

/**
 * How many sends to a non-object a run will step over before it gives up.
 *
 * High enough that a game with one broken path still reaches the rest of its
 * boot, low enough that a machine executing rubble stops saying so a thousand
 * times. A number rather than a policy: if a real game is found that legitimately
 * exceeds it, the finding is the game and not this constant.
 */
/**
 * Which property holds `-super-`, which moves once across the family.
 *
 * SCI0 and SCI1 keep `species`, `superClass` and `-info-` as the first three
 * properties; SCI1.1 drops them from the Selector table and the object's own
 * header carries them at three, four and five instead.
 */
const SUPER_PROPERTY_INDEX: Partial<Record<SciVersion, number>> = {
  'sci0-early': 1,
  'sci0-late': 1,
  sci01: 1,
  'sci1-ega-only': 1,
  'sci1-early': 1,
  'sci1-middle': 1,
  'sci1-late': 1,
};

const MAX_BAD_SENDS = 64;

export class PMachine {
  readonly version: SciVersion;
  private readonly host: PMachineHost;
  private readonly kernelNames: Array<string | undefined>;

  /** Every object the machine knows, static and Clone alike, by segment:offset. */
  readonly objects = new Map<string, SciObject>();
  /**
   * Clones, kept apart from the static objects rather than filtered out of
   * them (ADR 0019).
   *
   * The set is the save's own worklist: static objects are restored by
   * reloading their scripts, and these are the ones that have to be written
   * out whole.
   */
  readonly clones = new Set<string>();

  /** The accumulator, which is where a send's result and most values land. */
  acc: Reg = NULL_REG;
  /** The previous accumulator, which `pprev` pushes. */
  prev: Reg = NULL_REG;

  readonly stack: Reg[] = [];
  readonly frames: SciFrame[] = [];

  /**
   * The global variables, which are script 0's locals and not a bank of their
   * own.
   *
   * This is not a shortcut, it is what SCI is: a `lag 5` and script 0's own
   * `lal 5` address the same word, and every game relies on it — script 0
   * declares the globals in its `locals` block and every other script reads
   * them through the global bank. Giving globals an array of their own reads
   * correctly right up until script 0 writes one, after which every other
   * script sees the value it had at load.
   *
   * Found by running the demos: with separate banks, a send would resolve
   * against a global that was still zero and halt with "send to 0:0, which is
   * not an object" — the game's own `gEgo` never arriving.
   */
  get globals(): Reg[] {
    const existing = this.locals.get(0);
    if (existing) return existing;
    const created: Reg[] = [];
    this.locals.set(0, created);
    return created;
  }

  /** Set when execution stopped for a reason a person should hear about. */
  halted: string | null = null;

  /**
   * How many words `&rest` has pushed for the next call or send.
   *
   * A parameter block is sized when the script is assembled and `&rest` is a
   * runtime quantity, so the count has to travel between the two instructions.
   * Cleared by whichever consumes it, exactly as ScummVM clears `r_rest`.
   */
  private restAdjust = 0;

  /**
   * A trace hook, matching `ScummEngine.trace`/`traceScripts`.
   *
   * Tier 3's whole method is comparing this against ScummVM's own trace, so it
   * exists before there is anything to compare — an engine that gains a trace
   * after it is written is an engine whose first bug was found without one.
   */
  trace: ((line: string) => void) | null = null;

  private readonly ring: string[] = [];
  private nextCloneOffset = 1;
  /** Kernel numbers already reported, so a loop does not report ten thousand. */
  private readonly reportedKernels = new Set<number>();

  /**
   * The last Kernel call that answered nought, so a bad send can name it.
   *
   * Cleared by any call answering something else, so it is the *most recent*
   * nought rather than the first one — which is what a receiver a few
   * instructions later actually came from.
   */
  private lastNullKernel: number | null = null;

  /** Bad sends already reported, so a loop says each one once. */
  private readonly reportedBadSends = new Set<string>();

  /**
   * How deep the Kernel has re-entered the machine, and what it re-entered for.
   *
   * `invoke` is the one re-entrant door (see its comment), and every step it
   * takes can reach another Kernel call that opens the same door again. That
   * nesting is legitimate — `Sort` inside an `EachElementDo` is ordinary SCI —
   * but it is nesting on the **JavaScript** stack rather than on the machine's
   * own, so a script that re-enters without bound does not halt the game, it
   * kills the process with a `RangeError` that names nothing.
   *
   * King's Quest VII's boot is what showed this: it died inside
   * `List::EachElementDo` with a stack trace whose ten visible frames were all
   * engine and none of them the reason. The cap turns that into a halt with a
   * chain, which is a place to look.
   */
  private readonly invokeChain: string[] = [];

  /**
   * The deepest legitimate nesting seen in any game read here is single digits.
   * Sixty-four leaves a wide margin over that and still stops perhaps a
   * hundredth of the way into Node's own limit, so the chain survives to be
   * printed.
   */
  private static readonly MAX_INVOKE_DEPTH = 64;

  /** How many sends went to something that was not an object. */
  badSends = 0;

  /** Selector numbers back to names, built the first time a send fails. */
  private selectorNamesByNumber: Map<number, string> | null = null;

  constructor(version: SciVersion, host: PMachineHost) {
    this.version = version;
    this.host = host;
    this.kernelNames = kernelNamesFor(version);
  }

  /** The segment Clones live in, which nothing else uses. */
  static readonly CLONE_SEGMENT = 0x8000;

  private key(value: Reg): string {
    return `${value.segment}:${value.offset}`;
  }

  object(value: Reg): SciObject | null {
    return this.objects.get(this.key(value)) ?? null;
  }

  /** Registers an object a Script resource defines. */
  addObject(object: SciObject): void {
    this.objects.set(this.key(object.id), object);
    if (object.clone) this.clones.add(this.key(object.id));
  }

  /**
   * `kClone`: a new object copied from a class, with no backing in a resource.
   *
   * The copy is of the *variables*, and the methods stay shared with the class
   * — which is what makes a Clone cheap and is also why a save cannot restore
   * one by reloading a script.
   */
  clone(source: Reg): Reg | null {
    const original = this.object(source);
    if (!original) return null;

    const id = reg(PMachine.CLONE_SEGMENT, this.nextCloneOffset++);
    const variables = original.variables.map((value) => ({ ...value }));

    // **A Clone is not a class, and `-info-` has to say so.**
    //
    // ScummVM's `kClone` clears `kInfoFlagClass` and sets `kInfoFlagClone`, and
    // it matters because the games *ask*: Sierra's own `new` method tests
    // `(self -info-) & 0x8000` and clones itself when the answer is yes. A
    // Clone that inherited its class's bit answers yes for ever, so `new` on a
    // Clone makes another Clone and calls `new` on that.
    //
    // Torin's Passage does exactly that. Its stack reaches **21,819 frames** of
    // alternating `new` and `copyToFrom`, each with a fresh Clone as `self`,
    // and the engine reports it as a game that is running because nothing has
    // halted. It is the same shape as the instruction counts this project has
    // had to withdraw twice: a number going up is not progress.
    const info = (original.info & ~CLASS_BIT) | CLONE_BIT;

    // Written back into the property table as well as onto the field, because
    // a script reads it as a property — `pTos 14` — and not through anything
    // this engine owns. Where `-info-` sits is the layout's: index 2 for an
    // inline SCI0 or SCI1 object, index 5 for a heap one, which is exactly the
    // difference `propertyBias` already records.
    const infoIndex = original.propertyBias === 0 ? INLINE_INFO_INDEX : HEAP_INFO_INDEX;
    if (variables[infoIndex]) variables[infoIndex] = reg(0, info);

    this.addObject({
      ...original,
      id,
      info,
      variables,
      // A Clone's superclass is the class it came from, so a send that finds
      // nothing on the Clone still walks into the class's methods.
      superClass: original.info & CLASS_BIT ? original.species : original.superClass,
      clone: true,
    });
    return id;
  }

  /**
   * `kDisposeClone`: forgotten, and forgotten as a Clone.
   *
   * **A static object is left alone.** SCI's scripts call `DisposeClone` on
   * whatever a `dispose:` method was handed, and that is routinely an object a
   * Script resource defines rather than one `kClone` made — Sierra's own
   * interpreter checks the Clone bit and returns. Deleting by key regardless
   * removed a *static* object from the machine, and nothing said so until a
   * later send to it reported an offset that "is not an object".
   *
   * That is what stopped King's Quest IV, King's Quest I, Leisure Suit Larry 2
   * and Space Quest III: each halted on `send to 994:N`, where N is an object
   * that had been registered at load and disposed out of existence in between.
   * The object was in the machine after boot and gone by the halt, which is how
   * it was found — a resource that parsed correctly and then stopped existing.
   */
  disposeClone(value: Reg): void {
    const key = this.key(value);
    const object = this.objects.get(key);
    if (!object || !this.clones.has(key)) return;

    // **Deleting it is what Sierra's interpreter does not do, and King's Quest
    // IV is the game that proves it.** `kDisposeClone` marks a Clone for the
    // garbage collector and frees nothing; the memory stays valid until a
    // collection, so a script may — and does — keep writing to a Clone it has
    // just disposed. Script 989's `dispose` reads `-info-`, ORs 2 into it,
    // sends `dispose` to itself, calls `DisposeClone`, and *then* writes the
    // saved `-info-` back: `989:47 lat 0 · aTop 4`. Deleting on the call made
    // that write land on nothing, and the engine halted — correctly, and three
    // instructions after the real fault.
    //
    // **And the second bit of `-info-` says do not free it at all.** ScummVM's
    // `kDisposeClone` frees only when `(-info- & 3) == kInfoFlagClone`, with a
    // comment naming this game: "At least kq4early relies on this behavior. The
    // scripts clone Sound, then set bit 1 manually and call kDisposeClone
    // later. In that case we may not free it, otherwise we will run into issues
    // later, because kIsObject would then return false and Sound object
    // wouldn't get checked."
    //
    // Read from the property table rather than from the field, because setting
    // it is what the script just did and the field is a snapshot from `kClone`.
    const infoIndex = object.propertyBias === 0 ? INLINE_INFO_INDEX : HEAP_INFO_INDEX;
    const info = object.variables[infoIndex]?.offset ?? object.info;
    if ((info & 3) !== CLONE_BIT) return;

    // Marked, not removed. Every reference a script still holds keeps working,
    // which is the behaviour the games were written against — and a collection
    // reclaims it later, once nothing can reach it.
    object.freed = true;
    this.freedClones++;
    if (this.freedClones >= COLLECT_AFTER) this.collectClones();
  }

  /**
   * Every Clone gone, now, which is what replacing the world means.
   *
   * Separate from `disposeClone` because they are different acts. That one is
   * a *script* saying it is finished with an object, and SCI defers the free
   * so a script may keep writing to it; this is the *interpreter* discarding a
   * run, and there is nothing left to defer for. Restoring a save through the
   * deferred path left the previous run's Clones marked and alive, which is
   * exactly the "object the restored graph does not know about" ADR 0019 warns
   * against.
   */
  dropClones(): void {
    for (const key of this.clones) this.objects.delete(key);
    this.clones.clear();
    this.freedClones = 0;
  }

  /** Freed Clones waiting for a collection, so one is only run when it pays. */
  private freedClones = 0;

  /**
   * Mark and sweep over the Clones `kDisposeClone` marked.
   *
   * **Deferring the free is not optional and neither is collecting later.**
   * Sierra's interpreter frees a Clone at its next garbage collection rather
   * than at the call, and King's Quest IV writes to a Clone it has just
   * disposed — so a collection at the call breaks the game. But the game also
   * clones something every cycle: without a collection it reached **50,121
   * live Clones in twenty seconds**, which is a leak with a stopwatch on it.
   *
   * The roots are everything a running SCI world can reach a reference
   * *through*: the accumulator, the whole stack, every frame's `self` and
   * method owner, every variable bank, and every object that is not itself a
   * collectable Clone. Marking is transitive, because a Clone's own properties
   * hold references to other Clones.
   *
   * Only *marked* Clones are ever swept. An unmarked one is live by
   * definition — the game has not said it is done with it — so this can never
   * collect something a script merely happens not to be holding this cycle,
   * which is the failure mode a reachability-only collector would have.
   */
  collectClones(): void {
    this.freedClones = 0;
    const collectable = new Set<string>();
    for (const key of this.clones) {
      if (this.objects.get(key)?.freed) collectable.add(key);
    }
    if (collectable.size === 0) return;

    const reachable = new Set<string>();
    const worklist: Reg[] = [this.acc, this.prev, ...this.stack];
    for (const frame of this.frames) {
      worklist.push(frame.self, frame.object);
      if (frame.pending) worklist.push(frame.pending.receiver, frame.pending.self);
    }
    for (const bank of this.locals.values()) worklist.push(...bank);
    // Anything that is not up for collection is a root in its own right: a
    // static object's property may hold the only reference to a Clone.
    for (const [key, object] of this.objects) {
      if (!collectable.has(key)) worklist.push(...object.variables);
    }

    while (worklist.length > 0) {
      const value = worklist.pop();
      // **The stack can have holes**, and a variable bank can too: something
      // wrote past its end, which the send path already reports by name. A
      // collector that dereferenced one would throw out of the interpreter
      // entirely, which is the one outcome worse than a halt.
      if (!value) continue;
      const key = this.key(value);
      if (!collectable.has(key) || reachable.has(key)) continue;
      reachable.add(key);
      const object = this.objects.get(key);
      if (object) worklist.push(...object.variables);
    }

    for (const key of collectable) {
      if (reachable.has(key)) continue;
      this.objects.delete(key);
      this.clones.delete(key);
    }
  }

  /**
   * A script's own bytes, for a reference that points into one.
   *
   * A SCI script passes its own buffers by address — `TextSize` is handed a
   * four-word rect to fill in, `Format` a line to write into — and in SCI0
   * those are locals in the calling script rather than anything the
   * interpreter allocated. Exposed here because the PMachine already owns the
   * script accessor and a second route to the same bytes is a second thing to
   * keep in step.
   */
  scriptBytes(script: number): Uint8Array | null {
    return this.host.scriptCode(script);
  }

  /**
   * The bytes a reference addresses, whichever of SCI's spaces it names.
   *
   * **A SCI string is wherever the script put it**, and there are three
   * places. The interpreter's own memory, from `kNewString` and friends. A
   * script's own data, which is where every literal lives — King's Quest IV's
   * "Yes" and "No" buttons are at `699:1748` and `699:1752`. And a *variable
   * bank*: `lea` hands out the address of a local or a temporary, and a string
   * built at runtime — the line the player is typing, a `Format` result — is
   * packed two characters to a word inside one.
   *
   * A reader that knows only the first answers `""` for all of the others, and
   * that is why every window in King's Quest IV was an empty box: `TextSize`
   * measured nothing, so a control's rect stayed 4,4,4,4, and `DrawControl`
   * had nothing to draw. `StrCmp` compared two empty strings and found them
   * equal, which is a different wrong answer from the same cause.
   *
   * A view rather than a `Uint8Array`, because a bank is an array of registers
   * and no byte array can alias one. The two writers this has —
   * `TextSize`'s rect and `writeString` — need it to be writable, so it is.
   */
  byteViewAt(value: Reg): SciByteView | null {
    if (isNull(value)) return null;

    if (value.segment >= LOCALS_SEGMENT) {
      // Created on demand, the way `bankFor` does: a script writing a string
      // into its own locals before it has read one is ordinary, and answering
      // null there loses the write.
      let bank: Reg[] | undefined;
      if (value.segment >= STACK_SEGMENT) bank = this.stack;
      else {
        const script = value.segment - LOCALS_SEGMENT;
        bank = this.locals.get(script);
        if (!bank) {
          bank = [];
          this.locals.set(script, bank);
        }
      }
      if (!bank) return null;
      // The address is a byte offset from `ADDRESS_BASE`, so a string that
      // starts mid-word — which `StrEnd` produces — still reads correctly.
      const byte = value.offset - ADDRESS_BASE;
      if (byte < 0) return null;
      const base = byte >> 1;
      const skew = byte & 1;
      return {
        /**
         * The bank's *capacity*, not its current length.
         *
         * A JS array grows on write and a SCI bank is a fixed allocation the
         * script sized, so a write past the end is a write into a slot that
         * exists — and bounding this by `bank.length` meant a `Format` into a
         * buffer at index 300 of a 300-long bank had nowhere to go and wrote
         * nothing. King's Quest IV formats its copy-protection question into
         * exactly such a buffer, so the question was produced correctly and
         * then discarded. Reads terminate on the first zero, which past the
         * end is what an unwritten slot answers.
         */
        get length(): number {
          return Math.max(0, (VARIABLE_BANK_LIMIT - base) * 2 - skew);
        },
        get(index: number): number {
          const offset = index + skew;
          const word = bank[base + (offset >> 1)]?.offset ?? 0;
          return (offset & 1) === 0 ? word & 0xff : (word >> 8) & 0xff;
        },
        set(index: number, value: number): void {
          const offset = index + skew;
          const at = base + (offset >> 1);
          const word = bank[at]?.offset ?? 0;
          bank[at] = reg(
            0,
            (offset & 1) === 0
              ? (word & 0xff00) | (value & 0xff)
              : (word & 0x00ff) | ((value & 0xff) << 8),
          );
        },
      };
    }

    // A script's own data. Never an *object*, which lives at the same kind of
    // address and would read back as a run of letters out of a property table.
    if (value.segment === 0 || this.objects.has(this.key(value))) return null;
    const script = this.host.scriptCode(value.segment);
    if (!script || value.offset >= script.length) return null;
    const base = value.offset;
    return {
      length: script.length - base,
      get: (index: number): number => script[base + index] ?? 0,
      set: (index: number, byte: number): void => {
        if (base + index < script.length) script[base + index] = byte & 0xff;
      },
    };
  }

  /**
   * The Selector number a lookup should use, which is not always the one sent.
   *
   * **SCI0 early spends the low bit of a Selector ID on a read/write toggle**,
   * so the same Selector arrives as `n * 2` when a script reads it and
   * `n * 2 + 1` when it writes it, while the class dictionaries hold only the
   * even form. ScummVM masks it off in `lookupSelector` with the comment
   * "Early SCI versions used the LSB in the selector ID as a read/write
   * toggle, meaning that we must remove it for selector lookup", and this is
   * the same mask in the same place: every lookup, method and property alike,
   * rather than at one call site that would leave the others wrong.
   *
   * King's Quest IV's script 994 is what named it — `pushi 413`, `push0`,
   * `class 44`, `send 4`, against a class whose dictionary lists 412. Reported
   * honestly, as "Selector 413 is neither a method nor a property", and
   * unfixable anywhere but here.
   *
   * The raw number stays in the halt message: what the script sent is the fact
   * a reader needs, and the masked one is an implementation detail of the
   * lookup.
   */
  normaliseSelector(selector: number): number {
    return selectorIdCarriesReadWriteBit(this.version) ? selector & ~1 : selector;
  }

  /**
   * Resolves a Selector on an object, walking up the class graph.
   *
   * The walk is the whole of SCI's dispatch: an object's own methods first,
   * then its superclass's, and a Selector that resolves to nothing is a
   * property read on an object that has no such property — which SCI's own
   * interpreter treats as an error and this reports rather than answering zero.
   */
  resolveMethod(object: SciObject, selector: number): { object: SciObject; offset: number } | null {
    const wanted = this.normaliseSelector(selector);
    let current: SciObject | null = object;
    const seen = new Set<SciObject>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const offset = current.methods.get(wanted);
      if (offset !== undefined) return { object: current, offset };
      current = this.classByNumber(current.superClass);
    }
    return null;
  }

  /**
   * Which variable of an object a Selector names, or -1.
   *
   * An *instance* does not carry the Selector each of its variables answers to
   * — only a class does — so this walks up to the class. That asymmetry is the
   * whole reason a property send is a graph walk rather than an index: the
   * layout is the class's and the values are the instance's.
   *
   * Getting it wrong is not subtle in its cause and is very subtle in its
   * symptom. Reading only the object's own list made every property send on an
   * instance resolve to nothing, and the halt said "Selector 27 is neither a
   * method nor a property of object 5" — which is true of the instance and
   * false of the class it is one of.
   */
  resolveProperty(object: SciObject, selector: number): number {
    const wanted = this.normaliseSelector(selector);
    let current: SciObject | null = object;
    const seen = new Set<SciObject>();
    while (current && !seen.has(current)) {
      seen.add(current);
      if (current.variableSelectors.length > 0) {
        const index = current.variableSelectors.indexOf(wanted);
        if (index >= 0) return index;
      }
      // **Climb by `superClass`, which is what a chain is made of.**
      //
      // A class's own `species` is itself, so preferring `species` here made
      // the walk step from a class back to that same class, `seen` stopped it,
      // and the chain ended at the *first* class every time — an instance's
      // own class and no further. Every property a game inherits from a
      // grandparent resolved to nothing.
      //
      // King's Quest VI is where it showed: an instance with twelve properties
      // and superclass 9, class 9 declaring twelve Selectors and `client` not
      // among them, and class 9's own parent never asked. `resolveMethod` had
      // always climbed `superClass` alone and was right to; this is the same
      // walk over the other half of the object.
      //
      // `species` stays as the fallback for an object whose `superClass` names
      // a class this game does not ship — a demo drops classes, and half a
      // chain is better than none.
      const here: SciObject = current;
      const parent = this.classByNumber(here.superClass) ?? this.classByNumber(here.species);
      current = parent === here ? null : parent;
    }
    return -1;
  }

  /**
   * The game's Selector names to numbers, for the Kernel.
   *
   * On the machine rather than passed to each call, because a Kernel handler
   * that wants to write a property has to go through the game's own table —
   * which property number `type` is differs per game, and a hardcoded index
   * writes into whatever that game put there instead.
   */
  selectorNumbers: Map<string, number> | null = null;

  /**
   * Which script the game's own class table says each class lives in.
   *
   * For the message above and nothing else. A class miss is common in a demo
   * and rare in a full game, and being able to say which is which is the
   * difference between a bug report and a shrug.
   */
  classScripts: Map<number, number> | null = null;

  /** Classes by their number in `vocab.996`, filled in as scripts load. */
  readonly classes = new Map<number, SciObject>();

  classByNumber(species: number): SciObject | null {
    return this.classes.get(species) ?? null;
  }

  private remember(line: string): void {
    this.ring.push(line);
    if (this.ring.length > TRACE_RING) this.ring.shift();
    this.trace?.(line);
  }

  /**
   * The last instructions executed, oldest first.
   *
   * For the diagnostic. What this answers that a stack trace does not is "how
   * did it get here" for a machine whose control flow is decided by an object
   * at the moment of a send — the frames say which method is running and the
   * ring says which sends chose it.
   */
  recentOpcodes(): string[] {
    return [...this.ring];
  }

  /** Runs at most `budget` instructions, and says how many it ran. */
  run(budget: number, until?: () => boolean): number {
    let executed = 0;
    while (executed < budget && this.frames.length > 0 && !this.halted) {
      if (!this.stepOnce()) break;
      executed++;
      // **A budget is a runaway guard, not a frame boundary.** A SCI game's
      // main loop never returns — `Game::play` loops until the game quits — so
      // running to the budget runs as many of the game's own frames as fit in
      // it. King's Quest VII fits 206, which is 206 `FrameOut`s, 206
      // `GetEvent`s and a tenth of a second of work for one animation cycle.
      // `until` is how a caller says where the game's frame ends.
      if (until?.()) break;
    }
    return executed;
  }

  /**
   * One instruction.
   *
   * Returns false when the machine stopped, whether because it ran out of
   * frames or because something was wrong — `halted` says which.
   */
  stepOnce(): boolean {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return false;

    const code = this.host.scriptCode(frame.script);
    if (!code) {
      this.halt(`Script ${frame.script} is not loaded, and a frame is running in it.`);
      return false;
    }

    const instruction = decodeSciInstruction(code, frame.pc, this.version);
    if (!instruction) {
      this.halt(
        `Opcode 0x${(code[frame.pc] ?? 0).toString(16)} at ${frame.script}:${frame.pc} is one ` +
          `Sierra left unused, which means the decode desynchronised earlier. ` +
          `Recently: ${this.recentOpcodes().slice(-8).join(' · ')}`,
      );
      return false;
    }

    this.remember(`${frame.script}:${frame.pc} ${formatSciInstruction(instruction)}`);
    frame.pc += instruction.length;
    this.execute(frame, instruction);
    return !this.halted;
  }

  private halt(why: string): void {
    this.halted = why;
    this.host.log(why);
  }

  private push(value: Reg): void {
    this.stack.push(value);
  }

  private pop(): Reg {
    return this.stack.pop() ?? NULL_REG;
  }

  private integer(value: number): Reg {
    return reg(INTEGER_SEGMENT, value & 0xffff);
  }

  private signed(value: Reg): number {
    return value.offset > 0x7fff ? value.offset - 0x10000 : value.offset;
  }

  /**
   * Executes one decoded instruction.
   *
   * The arithmetic and stack half is written out; the send, call and Kernel
   * half is where SCI stops resembling anything else and each case says why.
   */
  private execute(frame: SciFrame, instruction: SciInstruction): void {
    const { name, operands } = instruction;

    switch (name) {
      // ---- arithmetic, all on the stack, accumulator as the second operand.
      case 'add':
        this.acc = this.integer(this.signed(this.pop()) + this.signed(this.acc));
        return;
      case 'sub':
        this.acc = this.integer(this.signed(this.pop()) - this.signed(this.acc));
        return;
      case 'mul':
        this.acc = this.integer(this.signed(this.pop()) * this.signed(this.acc));
        return;
      case 'div': {
        const divisor = this.signed(this.acc);
        // Sierra's own interpreter answers zero rather than trapping, and a
        // script relies on it: a division guard that throws would stop a game
        // that Sierra's ran.
        this.acc = this.integer(divisor === 0 ? 0 : Math.trunc(this.signed(this.pop()) / divisor));
        return;
      }
      case 'mod': {
        const divisor = this.signed(this.acc);
        this.acc = this.integer(divisor === 0 ? 0 : this.signed(this.pop()) % divisor);
        return;
      }
      case 'shr':
        this.acc = this.integer(this.pop().offset >>> this.acc.offset);
        return;
      case 'shl':
        this.acc = this.integer(this.pop().offset << this.acc.offset);
        return;
      case 'xor':
        this.acc = this.integer(this.pop().offset ^ this.acc.offset);
        return;
      case 'and':
        this.acc = this.integer(this.pop().offset & this.acc.offset);
        return;
      case 'or':
        this.acc = this.integer(this.pop().offset | this.acc.offset);
        return;
      case 'neg':
        this.acc = this.integer(-this.signed(this.acc));
        return;
      case 'not':
        this.acc = this.integer(isNull(this.acc) ? 1 : 0);
        return;
      case 'bnot':
        this.acc = this.integer(~this.acc.offset);
        return;

      // ---- comparisons. Signed and unsigned are separate opcodes because SCI
      // compares references as unsigned and numbers as signed, and using one
      // for the other reorders a list of objects rather than erroring.
      case 'eq?':
        this.prev = this.acc;
        this.acc = this.integer(this.pop().offset === this.acc.offset ? 1 : 0);
        return;
      case 'ne?':
        this.prev = this.acc;
        this.acc = this.integer(this.pop().offset !== this.acc.offset ? 1 : 0);
        return;
      case 'gt?':
        this.prev = this.acc;
        this.acc = this.integer(this.signed(this.pop()) > this.signed(this.acc) ? 1 : 0);
        return;
      case 'ge?':
        this.prev = this.acc;
        this.acc = this.integer(this.signed(this.pop()) >= this.signed(this.acc) ? 1 : 0);
        return;
      case 'lt?':
        this.prev = this.acc;
        this.acc = this.integer(this.signed(this.pop()) < this.signed(this.acc) ? 1 : 0);
        return;
      case 'le?':
        this.prev = this.acc;
        this.acc = this.integer(this.signed(this.pop()) <= this.signed(this.acc) ? 1 : 0);
        return;
      case 'ugt?':
        this.prev = this.acc;
        this.acc = this.integer(this.pop().offset > this.acc.offset ? 1 : 0);
        return;
      case 'uge?':
        this.prev = this.acc;
        this.acc = this.integer(this.pop().offset >= this.acc.offset ? 1 : 0);
        return;
      case 'ult?':
        this.prev = this.acc;
        this.acc = this.integer(this.pop().offset < this.acc.offset ? 1 : 0);
        return;
      case 'ule?':
        this.prev = this.acc;
        this.acc = this.integer(this.pop().offset <= this.acc.offset ? 1 : 0);
        return;

      // ---- control flow. Displacements are from the byte *after* the whole
      // instruction, which is the off-by-two this project has already shipped
      // once in SCUMM v6 and ADR 0017 cites as the reason to be careful here.
      case 'bt':
        if (!isNull(this.acc)) frame.pc += operands[0];
        return;
      case 'bnt':
        if (isNull(this.acc)) frame.pc += operands[0];
        return;
      case 'jmp':
        frame.pc += operands[0];
        return;

      // ---- immediates and the stack.
      case 'ldi':
        this.acc = this.integer(operands[0]);
        return;
      case 'push':
        this.push(this.acc);
        return;
      case 'pushi':
        this.push(this.integer(operands[0]));
        return;
      case 'push0':
        this.push(this.integer(0));
        return;
      case 'push1':
        this.push(this.integer(1));
        return;
      case 'push2':
        this.push(this.integer(2));
        return;
      case 'pushSelf':
        this.push(frame.self);
        return;
      case 'toss':
        this.pop();
        return;
      case 'dup': {
        const top = this.stack[this.stack.length - 1] ?? NULL_REG;
        this.push(top);
        return;
      }
      case 'pprev':
        this.push(this.prev);
        return;
      case 'link':
        // Room for this frame's temporaries, which `lat`/`sat` then address.
        for (let i = 0; i < operands[0]; i++) this.push(NULL_REG);
        return;
      case 'selfID':
        this.acc = frame.self;
        return;
      case 'fileName':
        // The source file each method came from, which SCI2.1's debug builds
        // record after `line`. Consumed and ignored exactly as `line` is —
        // decoded rather than skipped, because its length is the string's and a
        // machine that treated it as a one-byte `pushSelf` walked into the name
        // and executed it. Torin ran into `"system.sc"` and halted three
        // instructions later on a property offset that was really a letter.
        return;
      case 'line':
        // A line number for Sierra's own debugger. Consumed and ignored, but
        // decoded rather than skipped, because its operand is sized by the low
        // bit like everything else.
        return;

      case 'ret': {
        this.frames.pop();
        // The frame's temporaries and parameters go with it. Leaving them is
        // how a stack drifts upward over a few thousand sends and starts
        // reading a caller's locals as its own.
        this.stack.length = Math.min(this.stack.length, frame.paramBase);

        // And the send that started it may have had more Selectors in its
        // block. Picking them up here is the only place it can happen, because
        // the next one cannot start until this one has finished.
        const caller = this.frames[this.frames.length - 1];
        if (caller?.pending) {
          const pending = caller.pending;
          caller.pending = undefined;
          this.dispatchBlock(pending.receiver, pending.self, pending.block, pending.at);
        }
        return;
      }

      // The three sends differ in *two* things — where the method is looked up
      // and what `self` is inside it — and only `super` decouples them.
      //
      // `send` runs the method **on the receiver**, so the receiver is the new
      // `self`. Passing the caller's `self` here is the fault that stopped
      // every SCI16 game a few hundred instructions in: a method found on
      // another object ran with `self` still pointing at the caller, and its
      // own `self` send then looked for a Selector on the wrong class. Space
      // Quest 1, Leisure Suit Larry 1 and Conquests of the Longbow all halted
      // on "Selector 115 is neither a method nor a property of object 62" —
      // true of the caller and irrelevant to the object the method belonged to.
      // `&rest`: hand this method's own remaining arguments to the next call.
      //
      // Two halves and both are needed. The arguments are pushed so the callee
      // can see them, and the *count* is remembered because a call's parameter
      // block is sized when the script is assembled and `&rest` is a runtime
      // quantity. ScummVM carries the same adjustment in `r_rest`.
      case 'rest': {
        // **The frame's own extent, not the word it was handed.** A frame's
        // arguments occupy the stack between its parameter base and its
        // temporaries, so their count is exact and needs no trusting. Reading
        // the stored count instead let Castle of Dr. Brain hand `&rest` a
        // 65,535 that is really a -1: it pushed sixty-five thousand words, the
        // call that followed entered a script at its header rather than its
        // code, and the machine decoded padding as instructions until it hit an
        // opcode Sierra never used.
        const argc = Math.max(0, frame.tempBase - frame.paramBase - 1);
        for (let index = operands[0]; index <= argc; index++) {
          this.push(this.stack[frame.paramBase + index] ?? NULL_REG);
          this.restAdjust++;
        }
        return;
      }

      /**
       * A near call: a procedure in this same script, at a relative offset.
       *
       * `frame.pc` has already been advanced past this instruction, which is
       * what the displacement is measured from — the same convention the
       * branches above use, and reading it from the instruction's own start
       * lands three bytes early on every call in every game.
       */
      case 'call':
        this.doCall(frame.script, frame.pc + operands[0], operands[1], frame);
        return;

      /** A call to an exported procedure of script 0, by export number. */
      case 'callb': {
        const target = this.host.exportOffset(0, operands[0]);
        if (target === null) {
          this.halt(`callb ${operands[0]}, which script 0 does not export.`);
          return;
        }
        this.doCall(0, target, operands[1], frame);
        return;
      }

      /** A call to an exported procedure of another script, by script and export. */
      case 'calle': {
        const target = this.host.exportOffset(operands[0], operands[1]);
        if (target === null) {
          this.halt(
            `calle ${operands[1]} in script ${operands[0]}, which is not loaded or does not ` +
              `export it.`,
          );
          return;
        }
        this.doCall(operands[0], target, operands[2], frame);
        return;
      }

      /**
       * `lea`: the *address* of a variable, which SCI writes as `&temp0`.
       *
       * The first operand picks the bank the same way the variable grid does
       * and its bit 4 says "add the accumulator"; the second is the index.
       *
       * **An address is a register with a bank for its segment.** That is only
       * expressible because a property now holds a register: this instruction's
       * result is almost always stored with `aTop` and used later, and while
       * properties were 16-bit numbers the bank was thrown away the moment it
       * was written. So the two changes are one change.
       *
       * A bank segment is far above any script number a game ships, so an
       * address can never be mistaken for an object's `script:offset` — a
       * script that sends to one gets the existing "which is not an object"
       * halt, by name, instead of reading whatever lives at that offset.
       */
      case 'lea': {
        const kind = (operands[0] >> 1) & 3;
        const indexed = (operands[0] & 0x10) !== 0;
        const index = operands[1] + (indexed ? this.acc.offset : 0);
        // **Resolved here, not where it is used.** Which bank a kind names
        // depends on the frame, and a `lea` address is routinely stored in an
        // object and read back from another frame — a control's `text` is
        // exactly that. So the frame's own answer is baked into the segment:
        // globals and locals become the script whose bank it is, and a
        // temporary or a parameter becomes an absolute index into the stack.
        const address = (slot: number): number => ADDRESS_BASE + slot * 2;
        if (kind === 0) this.acc = reg(LOCALS_SEGMENT, address(index));
        else if (kind === 1) this.acc = reg(LOCALS_SEGMENT + frame.script, address(index));
        else if (kind === 2) this.acc = reg(STACK_SEGMENT, address(frame.tempBase + index));
        else this.acc = reg(STACK_SEGMENT, address(frame.paramBase + index));
        return;
      }

      /** `&info?`: the receiving object's `-info-`, whose bit 15 means "class". */
      case 'info': {
        const object = this.object(frame.self);
        if (!object) {
          this.halt(`info on ${frame.self.segment}:${frame.self.offset}, which is not an object.`);
          return;
        }
        this.acc = this.integer(object.info);
        return;
      }

      /** `&super?`: the receiving object's superclass number. */
      case 'superP': {
        const object = this.object(frame.self);
        if (!object) {
          this.halt(
            `superP on ${frame.self.segment}:${frame.self.offset}, which is not an object.`,
          );
          return;
        }
        this.acc = this.integer(object.superClass);
        return;
      }

      case 'send':
        this.doSend(this.acc, operands[0], this.acc);
        return;
      // `self` is the degenerate case: receiver and `self` are the same object.
      case 'self':
        this.doSend(frame.self, operands[0], frame.self);
        return;
      // `super` is the one that separates them, and that is its whole purpose:
      // start the lookup at the superclass, keep `self` as the instance, so an
      // overridden method can call the one it overrode without the callee
      // thinking it is running on the class.
      case 'super': {
        const superClass = this.classByNumber(operands[0]);
        if (!superClass) {
          this.halt(`super to class ${operands[0]}, which is not in the class table.`);
          return;
        }
        this.doSend(superClass.id, operands[1], frame.self);
        return;
      }

      case 'callk': {
        const argBytes = operands[1];
        // **A Kernel call consumes `&rest` too — from SCI0 late on.** Every
        // consumer of a parameter block has to, and this one was missed: `rest`
        // set the adjustment, the Kernel call popped only the arguments its own
        // byte count named, and the leftover word plus the stale adjustment
        // shifted the *next* send by one. Castle of Dr. Brain reported "299
        // arguments" for a send of three words — 298 read out of the wrong
        // place, plus the adjustment that should have been spent here.
        //
        // **SCI0 early is the exception, and it is Sierra's own.** ScummVM's
        // `op_callk` guards all three of these lines with `if
        // (!oldScriptHeader)`, so in that Version a `&rest` survives a Kernel
        // call and is spent by the send that follows it. King's Quest IV's
        // `firstTrue` is built on exactly that: `push0`, `rest 2`, `push1`,
        // `lats 0`, `callk NodeValue`, `send 4` — the `&rest` is for the
        // `send`, and spending it at the `callk` handed `NodeValue` the word
        // `&rest` had pushed instead of the node. It halted on "send to 0:0",
        // three instructions downstream of the fault.
        const spendsRest = !selectorIdCarriesReadWriteBit(this.version);
        const count = argBytes / 2 + (spendsRest ? this.restAdjust : 0);
        if (spendsRest) this.restAdjust = 0;
        const args: Reg[] = [];
        // The argument count itself is on the stack under the arguments, which
        // is why this reads `count` and then pops one more.
        for (let i = 0; i < count; i++) args.unshift(this.pop());
        this.pop();
        const result = this.host.callKernel(operands[0], args);
        if (result === null) {
          if (!this.reportedKernels.has(operands[0])) {
            this.reportedKernels.add(operands[0]);
            this.host.log(describeUnknownKernel(operands[0], this.version, this.kernelNames));
          }
          this.acc = NULL_REG;
          this.lastNullKernel = operands[0];
          return;
        }
        // **Remembered when it is nought, whether or not the call was
        // implemented.** A Kernel call that answers zero and a Kernel call that
        // is missing look identical to the script that uses the answer as a
        // receiver, and the halt that follows — "send to 0:0" — names neither.
        // This is the single fact that turns that halt from a mystery into a
        // sentence, and the constant column is why it is needed: an absent call
        // reports itself, and a call answering a constant is silent.
        this.lastNullKernel = result.segment === 0 && result.offset === 0 ? operands[0] : null;
        this.acc = result;
        return;
      }

      case 'class': {
        const found = this.classByNumber(operands[0]);
        if (!found) {
          // Named with where the game's own class table says it should be,
          // because the common cause is not a reading fault: a demo ships a
          // subset of the full game's scripts and keeps the full game's class
          // table, so a class it names may simply not be in the files. That is
          // a fact about the release and reads completely differently from a
          // class graph read wrongly — and the message has to let a person tell
          // them apart.
          const script = this.classScripts?.get(operands[0]);
          this.halt(
            script === undefined
              ? `class ${operands[0]} is not in this game's class table at all.`
              : `class ${operands[0]} should be defined in script ${script}, which this ` +
                  `release does not ship. A demo keeps the full game's class table and a ` +
                  `subset of its scripts, so this is usually the release rather than a ` +
                  `misread class graph.`,
          );
          return;
        }
        this.acc = found.id;
        return;
      }

      case 'lofsa':
      case 'lofss': {
        const code = this.host.scriptCode(frame.script);
        const value = reg(frame.script, this.resolveLofs(instruction, frame, code?.length ?? 0));
        if (instruction.name === 'lofsa') this.acc = value;
        else this.push(value);
        return;
      }

      default:
        this.executeVariable(frame, instruction);
    }
  }

  /**
   * The 0x40-0x7f grid: load, store, increment and decrement over four
   * variable kinds.
   *
   * Written as arithmetic on the opcode rather than sixty-four cases, for the
   * same reason the table is generated: they *are* a grid, and sixty-four
   * hand-written cases is sixty-four chances for one of them to name the wrong
   * bank.
   */
  private executeVariable(frame: SciFrame, instruction: SciInstruction): void {
    const { opcode, operands, name } = instruction;

    // Property access: `pToa` and friends, which read and write the receiving
    // object's own variables. `opcodes.ts` puts them at **0x31 to 0x38**, and
    // this asked `opcode < 0x20` — a range they are not in and never were.
    //
    // The consequence was not a halt where it happened. `pToa` fell through to
    // the variable grid below, where `family` is `(0x31 - 0x40) >> 4` — minus
    // one — which reaches the grid's `default` arm and *decrements* a slot in
    // whichever bank `kind` picked. So every property read in every SCI game
    // executed as a decrement of an unrelated variable, and a property holding
    // zero read back as `(0 - 1) & 0xffff`.
    //
    // That is where every game's boot died: King's Quest IV's `pToa 8` on the
    // game object put 0xffff in the accumulator, the `bnt` after it declined to
    // branch because 0xffff is not zero, and the `send` that followed addressed
    // 0:65535. The halt was correct and three instructions downstream of the
    // fault, which is why reading the trace backwards from it found a receiver
    // whose property table did not explain the value in the accumulator.
    if (opcode >= FIRST_PROPERTY_OPCODE && opcode <= LAST_PROPERTY_OPCODE) {
      const object = this.object(frame.self);
      if (!object) {
        this.halt(`${name} on ${frame.self.segment}:${frame.self.offset}, which is not an object.`);
        return;
      }
      // A byte offset into the property table, which is what SCI encodes, so
      // the index is half of it. An odd operand is not a property at all and
      // would index between two of them; refused rather than rounded, because
      // `variables[4.5]` is `undefined` and reads back as a quiet zero.
      if (operands[0] % 2 !== 0) {
        this.halt(`${name} ${operands[0]} is not an even property offset.`);
        return;
      }
      const index = operands[0] / 2 - object.propertyBias;
      if (index < 0) {
        this.halt(
          `${name} ${operands[0]} points into this object's header rather than at a property.`,
        );
        return;
      }
      switch (name) {
        case 'pToa':
          this.acc = object.variables[index] ?? NULL_REG;
          return;
        case 'aTop':
          object.variables[index] = this.acc;
          return;
        case 'pTos':
          this.push(object.variables[index] ?? NULL_REG);
          return;
        case 'sTop':
          object.variables[index] = this.pop();
          return;
        case 'ipToa':
          object.variables[index] = this.integer(
            ((object.variables[index] ?? NULL_REG).offset + 1) & 0xffff,
          );
          this.acc = object.variables[index];
          return;
        case 'dpToa':
          object.variables[index] = this.integer(
            ((object.variables[index] ?? NULL_REG).offset - 1) & 0xffff,
          );
          this.acc = object.variables[index];
          return;
        case 'ipTos':
          object.variables[index] = this.integer(
            ((object.variables[index] ?? NULL_REG).offset + 1) & 0xffff,
          );
          this.push(object.variables[index]);
          return;
        case 'dpTos':
          object.variables[index] = this.integer(
            ((object.variables[index] ?? NULL_REG).offset - 1) & 0xffff,
          );
          this.push(object.variables[index]);
          return;
        default:
          this.halt(`${name} is decoded but not executed.`);
          return;
      }
    }

    // **The variable grid is opcodes 0x40 to 0x7f and nothing else.** Reaching
    // it with anything below 0x40 computes a negative `family`, which lands on
    // the switch's `default` arm and *decrements a variable* — and, for some
    // operand shapes, pushes the result. So an opcode with no case here did
    // something plausible instead of nothing, silently.
    //
    // Four opcodes were in exactly that position: `call`, `callb`, `calle` and
    // `rest`. `rest` was corrupting a variable and pushing a word before every
    // send that used `&rest`, which is why six SCI16 games halted reporting
    // parameter blocks of 300 to 65,535 arguments — the block was one word out.
    //
    // Refused loudly, because `docs/processes/verifying-version-support.md` is
    // explicit that a machine doing something plausible with an instruction it
    // does not implement is worse than one that stops.
    if (opcode < 0x40 || opcode > 0x7f) {
      this.halt(
        `${name} (opcode 0x${opcode.toString(16)}) is decoded but not executed. It is not a ` +
          `variable opcode either, so there is nothing sensible to do with it.`,
      );
      return;
    }

    const family = (opcode - 0x40) >> 4;
    const variant = ((opcode - 0x40) >> 2) & 3;
    const kind = (opcode - 0x40) & 3;
    const indexed = variant >= 2;
    let index = operands[0];
    if (indexed) index += this.acc.offset;

    // **No variable bank is this large.** An indexed access adds the
    // accumulator to the operand, so a stale 65535 addresses a slot sixty-five
    // thousand words out — and writing one extends the stack by that much, with
    // a hole in the middle. Castle of Dr. Brain did exactly that at `+apsi 0`:
    // the stack went from a few dozen entries to 65,539, and the machine then
    // spent thousands of instructions decoding padding before anything said so.
    //
    // Refused with the index named, so the fault is reported where it happens
    // rather than wherever the corrupted stack is next read.
    if (index < 0 || index >= VARIABLE_BANK_LIMIT) {
      this.halt(
        `${name} addresses variable ${index}, and no SCI variable bank is that large — the ` +
          `accumulator was ${this.acc.offset} when it was added to the operand.`,
      );
      return;
    }

    const bank = this.bankFor(kind, frame);
    if (!bank) {
      this.halt(`${name} addresses a variable bank that is not set up.`);
      return;
    }

    const stackVariant = variant === 1 || variant === 3;
    switch (family) {
      case 0:
        // Load.
        if (stackVariant) this.push(bank[index] ?? NULL_REG);
        else this.acc = bank[index] ?? NULL_REG;
        return;
      case 1:
        // Store.
        //
        // **An indexed store takes its value from the stack, always.** The
        // accumulator is the *index* for variants 2 and 3, so it cannot also be
        // the value — Sierra's compiler pushes the value first and the
        // interpreter pops it, which is why a `sati` is preceded by a `push`
        // and then by the `lat` that loads the index.
        //
        // Storing the accumulator instead wrote the index into the variable
        // and left the value on the stack, so the variable held a small integer
        // where an object belonged and every frame after it was one word out.
        // Castle of Dr. Brain halted on `send to 0:0` reading a temporary that
        // a `sati` three instructions earlier had filled with an index.
        bank[index] = variant >= 1 ? this.pop() : this.acc;
        // **An indexed store leaves what it stored in the accumulator.**
        //
        // Because an assignment is an *expression*, and Sierra's compiler
        // chains onto its value: `(send (= temps[i] (Class new:)) init: x
        // draw:)` emits the `new:` send, a `push` of the object, the load that
        // puts `i` in the accumulator, the indexed store, and then a `send`
        // whose receiver is the accumulator. If the store leaves the *index*
        // there, that send goes to a small integer.
        //
        // Castle of Dr. Brain is exactly that, at 255:5223: `push · lat 19 ·
        // sati 12 · send 16`, where temp19 is an array index and temp12 is the
        // base of an array of dialog items. The plain `sat` needs no such rule
        // because its value is already the accumulator.
        if (variant >= 2) this.acc = bank[index];
        return;
      case 2:
        bank[index] = this.integer(((bank[index] ?? NULL_REG).offset + 1) & 0xffff);
        if (stackVariant) this.push(bank[index]);
        else this.acc = bank[index];
        return;
      default:
        bank[index] = this.integer(((bank[index] ?? NULL_REG).offset - 1) & 0xffff);
        if (stackVariant) this.push(bank[index]);
        else this.acc = bank[index];
        return;
    }
  }

  /**
   * How a `lofs` operand resolves, decided from the game's own bytes.
   *
   * ADR 0020's method applied inside the machine, and it has to be: ScummVM
   * does not key this on the Version either, it calls `autoDetectLofsType` and
   * bounds-checks the operand both ways. The seams the Version *would* give are
   * absolute below SCI1 middle and relative from it, and the freely distributed
   * demos disagree with that in both directions — Space Quest III is bucketed
   * SCI0 early and its script 994 does `lofsa 65008`, which is 0xfdf0: past the
   * end of the script read absolutely and a displacement of -528 read
   * relatively, landing on an object.
   *
   * So the first `lofs` a game executes decides, and the answer holds for the
   * game. That is stronger than the Version, because the Version for most SCI
   * releases is a guess (ADR 0013) and this is a fact about the bytes.
   */
  lofsType: 'absolute' | 'relative' | null = null;

  private resolveLofs(instruction: SciInstruction, frame: SciFrame, scriptSize: number): number {
    // **SCI1.1 measures a `lofs` operand from the heap.** A code-and-heap
    // script's objects all live past `heapAt`, so an operand of 4 means the
    // fifth byte of the heap and not of the code. Decided by the script having
    // a heap at all rather than by the Version, which is the same test the
    // reader makes — and without it every `lofsa` in a SCI1.1 game addressed
    // the code, which is why King's Quest VI, Gabriel Knight and Freddy
    // Pharkas all halted on "send to 994:4".
    const heapAt = this.host.heapStart(frame.script);
    if (heapAt > 0) {
      const inHeap = instruction.operands[0] + heapAt;
      // A heap address points at an object's *header*, and an object's identity
      // is its properties — four bytes further on, past the magic word and the
      // size word. The same translation the export table needs, and for the
      // same reason.
      //
      // Preferred only when it lands on a known object, because `lofsa` also
      // addresses strings and `said` blocks, which are not objects and must not
      // be shifted. Asymmetric evidence again: landing on one is proof, and not
      // landing on one proves nothing either way.
      const asObject = inHeap + OBJECT_VARIABLES_AT;
      if (this.objects.has(`${frame.script}:${asObject}`)) return asObject;
      return inHeap;
    }

    const raw = instruction.operands[0];
    const narrow = (instruction.raw & 1) !== 0;
    const displacement = narrow
      ? raw > 0x7f
        ? raw - 0x100
        : raw
      : raw > 0x7fff
        ? raw - 0x10000
        : raw;
    const relative = frame.pc + displacement;

    if (this.lofsType === null) {
      // Absolute is preferred where it is in bounds, because a relative
      // reading of a small positive operand is also in bounds and the two
      // disagree — so the test has to be the one that can fail.
      const absoluteFits = raw >= 0 && raw < scriptSize;
      const relativeFits = relative >= 0 && relative < scriptSize;
      if (absoluteFits && !relativeFits) this.lofsType = 'absolute';
      else if (relativeFits && !absoluteFits) this.lofsType = 'relative';
      else if (absoluteFits) {
        // Both fit. The one that lands on an object is the right one; if
        // neither does, absolute is assumed and the send that follows will say
        // so by name rather than this guessing quietly.
        const onObject = (offset: number): boolean => this.objects.has(`${frame.script}:${offset}`);
        this.lofsType = onObject(relative) && !onObject(raw) ? 'relative' : 'absolute';
      } else {
        this.lofsType = 'relative';
      }
    }

    return this.lofsType === 'absolute' ? raw : relative;
  }

  /** Locals per script, which a script's own `locals` block sizes. */
  readonly locals = new Map<number, Reg[]>();

  bankFor(kind: number, frame: SciFrame): Reg[] | null {
    switch (kind) {
      case 0:
        return this.globals;
      case 1: {
        const existing = this.locals.get(frame.script);
        if (existing) return existing;
        const created: Reg[] = [];
        this.locals.set(frame.script, created);
        return created;
      }
      case 2:
        // Temporaries live on the stack above this frame's base, so the bank is
        // a window onto it rather than a separate array.
        return new StackWindow(this.stack, frame.tempBase) as unknown as Reg[];
      default:
        return new StackWindow(this.stack, frame.paramBase) as unknown as Reg[];
    }
  }

  /**
   * A send: the moment the object decides what runs.
   *
   * The parameter block on the stack is a run of `(selector, argc, ...args)`
   * triples, and one `send` instruction may carry several — which is why this
   * loops rather than handling one. A reader expecting one send per instruction
   * silently drops every selector after the first, and the game's symptoms are
   * an actor that moves and never speaks.
   */
  /**
   * Enters a procedure, which is a frame without a receiver.
   *
   * The difference from a send is entirely that nothing is resolved: a call
   * names its target directly, so `self` and the owning object carry through
   * from the caller unchanged. Getting that wrong makes every property access
   * inside a called procedure address the wrong object.
   */
  private doCall(script: number, pc: number, argBytes: number, frame: SciFrame): void {
    // `&rest`'s words are on the stack above the arguments the instruction
    // counted, and its count belongs to this call.
    const adjust = this.restAdjust;
    this.restAdjust = 0;
    const words = argBytes / 2 + adjust;
    if (words + 1 > this.stack.length) {
      this.halt(
        `A call asked for ${words} words of parameters with ${this.stack.length} on the stack.`,
      );
      return;
    }

    // The argument count sits under the arguments, and `&rest` adds to it.
    const paramBase = this.stack.length - words - 1;
    if (adjust > 0) {
      this.stack[paramBase] = this.integer((this.stack[paramBase] ?? NULL_REG).offset + adjust);
    }

    this.frames.push({
      self: frame.self,
      object: frame.object,
      script,
      pc,
      paramBase,
      tempBase: this.stack.length,
      selector: -1,
    });
  }

  private doSend(receiver: Reg, argBytes: number, self: Reg): void {
    const object = this.object(receiver);
    if (!object) {
      // **Reported and stepped over rather than halted**, which is the same
      // decision `callk` already makes for a Kernel call it cannot answer, for
      // the same reason: halting here ends the run at the first fault and loses
      // every later one. King's Quest VII stopped on a single send of
      // `isKindOf` to the number 82 with sixty per cent of its boot still
      // unexamined, and nothing after that line could be learned at all.
      //
      // The send is abandoned, not faked: the parameter block is dropped, the
      // accumulator answers nought, and the script carries on to whatever it
      // does with that. A game doing the wrong thing quietly is the cost, and
      // it is the cost this engine already accepts one layer down — with the
      // difference that both are counted and reported rather than silent.
      const where =
        `send to ${receiver.segment}:${receiver.offset}, which is not an object` +
        `${this.describeSentSelector(argBytes)}${this.describeCurrentMethod()}.`;
      if (!this.reportedBadSends.has(where)) {
        this.reportedBadSends.add(where);
        // **The instructions that produced the receiver, which is the one thing
        // that identifies where a number came from.** Everything else here is
        // inference — the Kernel blame is a suspicion and the Selector says
        // only what was wanted. The opcodes say what actually happened: a `lag`
        // is a global that was never set, a `pTos` is a property, a `callk` is
        // a call that answered wrongly. Without them a reader with the game in
        // front of them still cannot tell which.
        const recently = this.recentOpcodes().slice(-8).join(' · ');
        this.host.log(
          `${where}${this.blameLastKernel(receiver)} Stepped over.` +
            (recently ? ` Recently: ${recently}` : ''),
        );
      }

      this.badSends++;
      if (this.badSends > MAX_BAD_SENDS) {
        this.halt(
          `${this.badSends} sends to things that are not objects. Stepping over one is a ` +
            `finding; this many means the machine is running on rubble, so it is stopping ` +
            `rather than reporting a thousand more.`,
        );
        return;
      }

      // Drop what the send would have consumed, so the stack is where the next
      // instruction expects it rather than one block deep.
      const words = argBytes / 2 + this.restAdjust;
      this.restAdjust = 0;
      if (Number.isInteger(words) && words > 0 && words <= this.stack.length) {
        this.stack.length -= words;
      }
      this.acc = NULL_REG;
      return;
    }

    // Whatever `&rest` pushed belongs to this block, even though the
    // instruction's own byte count was fixed before `&rest` ran.
    const adjust = this.restAdjust;
    this.restAdjust = 0;
    const words = argBytes / 2 + adjust;
    if (words > this.stack.length) {
      // The parameter block claims more words than the stack holds, which
      // means the frame was entered with the wrong base or an earlier
      // instruction consumed something it should not have. Reported rather
      // than clamped: a short block read as a whole one sends a selector made
      // of whatever was underneath, and the resulting method runs.
      this.halt(
        `A send asked for ${words} words of parameters with ${this.stack.length} on the stack.`,
      );
      return;
    }
    const block = this.stack.splice(this.stack.length - words, words);
    this.dispatchBlock(receiver, self, block, 0, adjust);
  }

  /**
   * Runs one send's parameter block from `at`, and remembers where it got to.
   *
   * A property read or write finishes immediately and the loop continues; a
   * method dispatch cannot, because the method has to run first. So the
   * remainder is parked on the *calling* frame and `ret` resumes it.
   */
  private dispatchBlock(
    receiver: Reg,
    self: Reg,
    block: Reg[],
    from: number,
    restAdjust = 0,
  ): void {
    const object = this.object(receiver);
    if (!object) {
      this.halt(
        `send to ${receiver.segment}:${receiver.offset}, which is not an object.` +
          this.blameLastKernel(receiver),
      );
      return;
    }

    let at = from;
    while (at + 1 < block.length) {
      // A hole in the block means the stack had one — something wrote past its
      // end — and reading `.offset` off it throws out of the interpreter
      // entirely. An uncaught exception is the one outcome worse than a halt:
      // it takes the trace and the ring buffer with it. Conquests of the
      // Longbow did exactly that while an experimental `lea` was in place.
      if (!block[at] || !block[at + 1]) {
        this.halt(
          `A send's parameter block has a hole at word ${at}, so something wrote past the end ` +
            `of the stack before it.`,
        );
        return;
      }
      const selector = block[at].offset;
      // `&rest`'s arguments belong to the Selector it was written before, which
      // is the first in the block — a script meaning them for a later one would
      // have had to write `&rest` after it, and cannot.
      const argc = block[at + 1].offset + (at === from ? restAdjust : 0);
      if (at + 2 + argc > block.length) {
        this.halt(
          `A send declared ${argc} arguments with ${block.length - at - 2} left in its ` +
            `parameter block, so the block is being read at the wrong place.`,
        );
        return;
      }
      const args = block.slice(at + 2, at + 2 + argc);
      at += 2 + argc;

      const method = this.resolveMethod(object, selector);
      if (method) {
        // The rest of the block waits on the frame that is doing the sending,
        // not on the one about to run — that one will be gone by the time the
        // remainder is due.
        const caller = this.frames[this.frames.length - 1];
        if (caller && at < block.length) {
          caller.pending = { receiver, self, block, at };
        }

        const paramBase = this.stack.length;
        this.push(this.integer(argc));
        for (const argument of args) this.push(argument);
        this.frames.push({
          self,
          object: method.object.id,
          script: method.object.script,
          pc: method.offset,
          paramBase,
          tempBase: this.stack.length,
          selector,
        });
        return;
      }

      const property = this.resolveProperty(object, selector);
      if (property < 0) {
        this.halt(
          `Selector ${selector} is neither a method nor a property of ` +
            `${object.name ?? `object ${object.species}`}. A send that resolves to nothing is ` +
            `a class graph read wrongly, not a missing feature.`,
        );
        return;
      }
      if (argc === 0) this.acc = object.variables[property] ?? NULL_REG;
      else object.variables[property] = args[0];
    }
  }

  /**
   * Starts a frame at an export or a method, for the engine to drive.
   *
   * The only way in: nothing here runs on its own, because SCI's own
   * interpreter is driven by its scripts and the engine's job is to keep
   * calling `doit`.
   */
  enter(script: number, pc: number, self: Reg, args: Reg[] = []): void {
    const paramBase = this.stack.length;
    this.push(this.integer(args.length));
    for (const argument of args) this.push(argument);
    this.frames.push({
      self,
      object: self,
      script,
      pc,
      paramBase,
      tempBase: this.stack.length,
      selector: -1,
    });
  }

  /**
   * Runs one method to completion from inside a Kernel call, and answers what
   * it left in the accumulator.
   *
   * **The one re-entrant door, and it exists because `Sort` needs it.** Sierra's
   * `Sort` takes a third object and sends it `doit` once per element to get
   * that element's sort key, so the Kernel call cannot finish until a script
   * has run — which is the opposite of every other call in `SciKernel.ts`.
   * ScummVM does the same thing through `invokeSelector`.
   *
   * Nested rather than queued, and the nesting is safe for a reason worth
   * writing down: `stepOnce` advances the calling frame's `pc` *before* it
   * executes, so by the time a `callk` reaches here the caller is already
   * pointing at its next instruction and the frames pushed below are strictly
   * above it. `ret` unwinds them the ordinary way.
   *
   * The accumulator and `&rest`'s adjustment are saved and put back, because
   * the caller is mid-instruction: a `callk` is about to write its own result
   * into `acc`, and a `&rest` that survived a Kernel call at SCI0 early belongs
   * to the send that follows it rather than to whatever the callback did.
   *
   * **Null means the method did not finish**, whether because it halted or
   * because it outran the budget, and the caller is expected to say so rather
   * than treat the leftover accumulator as an answer. An unfinished callback
   * leaves frames behind that would run as if they were the game's own, so they
   * are dropped here.
   */
  invoke(receiver: Reg, selector: number, args: Reg[], budget = 100_000): Reg | null {
    const object = this.object(receiver);
    if (!object) return null;
    const method = this.resolveMethod(object, selector);
    if (!method) return null;

    // Named before the recursion rather than after it, so the chain printed is
    // the one that got here and not whatever survived the unwind.
    if (this.invokeChain.length >= PMachine.MAX_INVOKE_DEPTH) {
      this.halt(
        `A Kernel call re-entered the machine ${this.invokeChain.length} deep, ` +
          `which is past the cap. The chain of methods that got here, outermost ` +
          `first: ${this.invokeChain.join(' > ')} > ` +
          `${object.name || `obj@${receiver.segment}:${receiver.offset}`}` +
          `(script ${method.object.script})::${this.selectorName(selector) ?? selector}.`,
      );
      return null;
    }
    this.invokeChain.push(
      `${object.name || `obj@${receiver.segment}:${receiver.offset}`}` +
        `(script ${method.object.script})::${this.selectorName(selector) ?? selector}`,
    );
    try {
      return this.invokeInner(receiver, selector, args, budget, method);
    } finally {
      this.invokeChain.pop();
    }
  }

  /** The body of `invoke`, past the depth guard that fronts it. */
  private invokeInner(
    receiver: Reg,
    selector: number,
    args: Reg[],
    budget: number,
    method: { object: SciObject; offset: number },
  ): Reg | null {
    const depth = this.frames.length;
    const savedAcc = this.acc;
    const savedRest = this.restAdjust;
    this.restAdjust = 0;

    const paramBase = this.stack.length;
    this.push(this.integer(args.length));
    for (const argument of args) this.push(argument);
    this.frames.push({
      self: receiver,
      object: method.object.id,
      script: method.object.script,
      pc: method.offset,
      paramBase,
      tempBase: this.stack.length,
      selector,
    });

    let executed = 0;
    while (this.frames.length > depth && !this.halted && executed < budget) {
      if (!this.stepOnce()) break;
      executed++;
    }

    const finished = this.frames.length === depth && !this.halted;
    if (!finished) {
      this.frames.length = depth;
      this.stack.length = Math.min(this.stack.length, paramBase);
    }

    const result = this.acc;
    this.acc = savedAcc;
    this.restAdjust = savedRest;
    return finished ? result : null;
  }

  /**
   * The method the machine is *inside* when something goes wrong.
   *
   * The opcodes say what happened and the Selector says what was wanted; this
   * says **where to look**. King's Quest VII sends `isKindOf` to the number 82
   * from script 64999, and "which method of which object returned 82" is the
   * question that names a place in the game's own source — the other two
   * narrow it and neither answers it.
   */
  private describeCurrentMethod(): string {
    const frame = this.frames[this.frames.length - 1];
    if (!frame) return '';
    const object = this.object(frame.self)?.name;
    const selector = this.selectorName(frame.selector);
    if (!object && !selector) return ` Inside script ${frame.script}`;
    return ` Inside ${object ?? '?'}::${selector ?? '?'} in script ${frame.script}`;
  }

  /** A Selector's name, where this game's table has one for it. */
  private selectorName(selector: number): string | null {
    if (selector < 0) return null;
    if (!this.selectorNamesByNumber && this.selectorNumbers) {
      this.selectorNamesByNumber = new Map(
        [...this.selectorNumbers].map(([name, number]) => [number, name]),
      );
    }
    return this.selectorNamesByNumber?.get(selector) ?? null;
  }

  /**
   * Which Selector a failed send was for, read off the stack it is still on.
   *
   * **The single most useful fact about a send that halts, and it was not in the
   * message.** "send to 0:0" says a receiver was nought; the Selector says what
   * the script was trying to *do*, which is what turns the halt into a place to
   * look — a send of `play` is the boot, a send of `doit` is a room's cycle, a
   * send of `init` is something being set up.
   *
   * Read defensively: the parameter block is on the stack at the moment of the
   * halt, but a send that halted because the block was wrong is exactly the case
   * where reading it may give nonsense, so anything unreadable is left out
   * rather than guessed at.
   */
  private describeSentSelector(argBytes: number): string {
    const words = argBytes / 2 + this.restAdjust;
    if (!Number.isInteger(words) || words < 1 || words > this.stack.length) return '';
    const selector = this.stack[this.stack.length - words];
    if (!selector || selector.segment !== 0) return '';

    const name = this.selectorName(selector.offset);
    return name ? ` — the send was of "${name}"` : ` — the send was of Selector ${selector.offset}`;
  }

  /**
   * Names the Kernel call a null receiver most likely came from.
   *
   * **The gap this closes is the one the coverage table calls "constant".** A
   * call with no handler reports itself the first time a game makes it; a call
   * that answers a fixed nought says nothing at all, and the script carries the
   * nought along until it sends to it. The halt then names a register and the
   * person reading it has no way back to the cause.
   *
   * Offered as a suspicion rather than as a fact, because it is one: the nought
   * in the receiver may have come from an uninitialised variable instead, and
   * saying "this is why" of a guess is how a wrong lead outlives a right one.
   */
  private blameLastKernel(receiver: Reg): string {
    // **Any receiver in segment nought, not only 0:0.** Segment nought is where
    // integers live, so `send to 0:82` is a script sending to the *number* 82 —
    // the same fault as sending to nought and just as far from an object. Only
    // checking for nought meant the one halt that actually stopped King's Quest
    // VII said nothing at all.
    if (receiver.segment !== 0) return '';
    const wasInteger =
      receiver.offset === 0
        ? ''
        : ` Segment nought holds integers rather than objects, so this is a send to the number ` +
          `${receiver.offset} — something answered a count or an index where the script expected ` +
          `an object.`;
    if (this.lastNullKernel === null) return wasInteger;
    const name = this.kernelNames[this.lastNullKernel];
    const called = name
      ? `${name} (Kernel ${this.lastNullKernel})`
      : `Kernel ${this.lastNullKernel}`;
    return (
      wasInteger +
      ` The last Kernel call to answer nought was ${called}, so that is where this receiver ` +
      `probably came from — a call answering a constant is silent, which is why nothing said so ` +
      `at the time.`
    );
  }

  /**
   * Rewrites every object's `-super-` property from a class number to the class.
   *
   * **A SCI script reads `-super-` and sends to it**, and King's Quest VII is
   * where that showed: its `isKindOf` walks the chain by sending `isKindOf` to
   * its own superclass, got the number 82, and sent to an integer. The halt
   * said "send to 0:82" and the cause was four layers away.
   *
   * The property holds a class *number* in the file and a class *address* at
   * run time, and turning one into the other is the interpreter's job, not the
   * script's. ScummVM does it in `Object::initSuperClass` — the same rewrite,
   * including `0xffff` meaning no superclass at all — and until this existed
   * nothing here did it, so every script that walked a class chain walked into
   * an integer.
   *
   * Done in a pass after loading rather than as each object arrives, because a
   * superclass commonly lives in a script that has not been read yet: resolving
   * eagerly would leave the early objects holding numbers and the late ones
   * holding classes, which is worse than either.
   */
  resolveSuperClasses(): number {
    // `-super-` is the second property at SCI0 and SCI1 and the fifth from
    // SCI1.1, which is the same split as `species` and `-info-` beside it.
    const index = SUPER_PROPERTY_INDEX[this.version] ?? 4;
    let resolved = 0;

    for (const object of this.objects.values()) {
      const held = object.variables[index];
      // Only a raw number is rewritten: anything already pointing at a segment
      // has been resolved, and a second pass must not undo it.
      if (!held || held.segment !== 0) continue;

      if (held.offset === 0xffff) {
        // Sierra's "no superclass", which is not class 65535.
        object.variables[index] = NULL_REG;
        resolved++;
        continue;
      }
      if (held.offset !== object.superClass) continue;

      const target = this.classByNumber(held.offset);
      if (!target) continue;
      object.variables[index] = target.id;
      resolved++;
    }
    return resolved;
  }

  /** What the machine is doing, for the diagnostic. */
  describe(): string[] {
    return [
      this.halted ? `halted: ${this.halted}` : `running, ${this.frames.length} frames`,
      `${this.objects.size} objects, ${this.clones.size} of them clones`,
      // **Named rather than numbered.** A stall report that says "selector 285"
      // tells a reader which number the machine is in and nothing about what
      // the game is doing; "kqMusic::doit" says what it is waiting for. The
      // frames are the only place that answer exists, and reading them is free.
      ...this.frames.slice(-4).map((frame) => {
        const object = this.object(frame.self)?.name;
        const selector = this.selectorName(frame.selector);
        const what =
          object && selector ? ` ${object}::${selector}` : selector ? ` ::${selector}` : '';
        return `  frame script ${frame.script} pc ${frame.pc}${what}`;
      }),
      `recent: ${this.recentOpcodes().slice(-6).join(' · ')}`,
    ];
  }
}

/**
 * A view onto the stack that indexes from a frame's base.
 *
 * Temporaries and parameters are on the stack rather than in arrays of their
 * own, because that is where SCI puts them and a `lat 3` has to reach the same
 * slot a `push` did. A `Proxy` rather than a copy so a write goes back to the
 * stack — copying would give a frame its own temporaries that nothing else
 * could see, which reads correctly until a send writes through one.
 */
class StackWindow {
  constructor(stack: Reg[], base: number) {
    return new Proxy(stack, {
      get(target, property) {
        if (typeof property !== 'string') return Reflect.get(target, property);
        const index = Number(property);
        if (!Number.isInteger(index)) return Reflect.get(target, property);
        return target[base + index] ?? NULL_REG;
      },
      set(target, property, value) {
        const index = Number(property);
        if (!Number.isInteger(index)) return Reflect.set(target, property, value);
        target[base + index] = value as Reg;
        return true;
      },
    }) as unknown as StackWindow;
  }
}
