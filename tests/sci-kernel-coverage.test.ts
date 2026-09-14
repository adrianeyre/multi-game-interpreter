/**
 * Which Kernel calls this engine answers, at every Version, as a standing check.
 *
 * **Why this is a test and not a paragraph.** The count this replaces was taken
 * with `awk` and `comm` against the handler table, and it was wrong four ways:
 * it counted a placeholder slot as a call, it read SCI16 as one table when SCI0
 * ships a different one, it put calls Sierra never implemented in with calls
 * this project has not written, and it missed that SCI1 late and SCI1.1 have
 * their own missing sets. `docs/processes/verifying-version-support.md` calls
 * the standing version of such a check the thing that stops a claim decaying,
 * and this is the Kernel's.
 *
 * **A fifth way, found by asking the code a sharper question.** Moving the
 * count inside the code fixed the first four and left one: "implemented" meant
 * a key existed in `SCI_KERNEL`, not that anything happened when it was called.
 * Fifty-four handlers — `DoSound`, `Parse`, `SaveGame`, `AvoidPath`, the menu
 * calls — answer the same value whatever a game passes them, and were counted
 * as implemented. They now have a column, and the column is probed rather than
 * declared, so it cannot be settled by argument.
 *
 * **Tier 1, and it says so.** This measures the tables this repository carries
 * against the handlers this repository has. No SCI game data is mounted on the
 * machine these figures were taken on, and below SCI1 most games ship their own
 * `vocab.999` — which `SciEngine.kernelNameFor` prefers over the table here. So
 * every figure below is a claim about this code, not about any release.
 *
 * The command: `npm run sweep:sci -- --kernel-coverage` prints the same thing.
 */

import { describe, expect, it } from 'vitest';

import {
  kernelCoverage,
  kernelCoverageFor,
  unreachableHandlers,
} from '../src/engine/sci/script/kernelCoverage.js';
import { NULL_REG, PMachine } from '../src/engine/sci/script/PMachine.js';
import {
  SCI_CONSTANT_KERNEL_NAMES,
  SCI_KERNEL,
  SCI_UNUSED_KERNEL_NAMES,
  type SciKernelWorld,
} from '../src/engine/sci/script/SciKernel.js';
import { SciHeap } from '../src/engine/sci/script/segments.js';
import { SCI_VERSIONS } from '../src/engine/sci/sciVersion.js';

describe('the Kernel gap, per Version', () => {
  it('sorts every named call into exactly one of four columns', () => {
    for (const coverage of kernelCoverage()) {
      const counted = [
        ...coverage.implemented,
        ...coverage.constant,
        ...coverage.unused,
        ...coverage.missing,
      ].sort();
      expect(counted, `${coverage.version} counts a call twice or not at all`).toEqual(
        coverage.named,
      );
      // A placeholder is a slot Sierra shipped empty, not a call this engine
      // owes anyone — counting one inflates the gap and the total together.
      expect(coverage.named).not.toContain('Empty');
      expect(coverage.named).not.toContain('Dummy');
    }
  });

  /**
   * The distinction the whole run turns on. Eleven calls are answered by a stub
   * that logs and returns zero — Sierra's own debugger's surface, plus the
   * slots ScummVM's table marks "never called?" — and a report that folded them
   * into "implemented" would be claiming behaviour for eleven calls nothing is
   * written behind.
   */
  it('never counts a call answered by the unused stub as implemented', () => {
    const unused = new Set(SCI_UNUSED_KERNEL_NAMES);
    for (const coverage of kernelCoverage()) {
      expect(coverage.implemented.filter((name) => unused.has(name))).toEqual([]);
      expect(coverage.constant.filter((name) => unused.has(name))).toEqual([]);
      expect(coverage.missing.filter((name) => unused.has(name))).toEqual([]);
    }
  });

  /**
   * The fourth column, and the largest correction this measurement has taken.
   *
   * "Implemented" used to mean *a key exists in `SCI_KERNEL` under this name*,
   * and a key is not a behaviour. `DoSound`, `Parse`, `Said`, `SaveGame`,
   * `RestoreGame`, `Graph` and `Palette` are each `() => int(0)`, and each was
   * counted beside `Format` and `DrawPic`. What that made possible is the thing
   * the whole table exists to refuse: `MergePoly: () => NULL_REG` would have
   * closed SCI1's gap without a line of polygon arithmetic.
   *
   * So the list is **probed rather than declared**. Every handler is called
   * with ten arguments behind a recording proxy and a world behind another; a
   * handler that reads no argument and touches nothing answers the same value
   * whatever a game passes it, and belongs in the column. This fails if
   * `SCI_CONSTANT_KERNEL_NAMES` is not exactly that set — so a call that gains
   * behaviour has to leave the list, and one that loses it has to join.
   *
   * The column is not a defect list. `SetVideoMode` has no mode to leave and
   * `CanBeHere` answers permissively on purpose. Which of the fifty-four are
   * finished is a judgement per call and is not made here; what the column
   * buys is that "this engine answers 120 of SCI1's 137" can no longer be read
   * as 120 calls that do something.
   */
  it('probes every handler rather than trusting the constant list', () => {
    const probe = (name: string): 'constant' | 'behaviour' => {
      let touched = false;
      const base = {
        machine: new PMachine('sci1-late', {
          scriptCode: () => new Uint8Array([0x48]),
          callKernel: () => null,
          exportOffset: () => null,
          heapStart: () => 0,
          log: () => {},
        }),
        heap: new SciHeap(),
        input: { next: () => null },
        scriptExport: () => null,
        log: () => {},
        random: () => 0,
        ticks: () => 0,
      } as unknown as SciKernelWorld;

      const world = new Proxy(base as object, {
        get(target, key) {
          touched = true;
          return (target as Record<string | symbol, unknown>)[key];
        },
      }) as SciKernelWorld;
      const args = new Proxy(
        Array.from({ length: 10 }, () => NULL_REG),
        {
          get(target, key) {
            // A symbol read is the iterator protocol rather than the handler
            // asking what it was passed, and counting it would make every
            // handler look as though it read its arguments.
            if (typeof key === 'string') touched = true;
            return (target as unknown as Record<string | symbol, unknown>)[key];
          },
        },
      );

      SCI_KERNEL[name](world, args);
      return touched ? 'behaviour' : 'constant';
    };

    const probed = Object.keys(SCI_KERNEL)
      .filter((name) => !SCI_UNUSED_KERNEL_NAMES.includes(name))
      .filter((name) => probe(name) === 'constant')
      .sort();

    expect(probed).toEqual([...SCI_CONSTANT_KERNEL_NAMES].sort());
  });

  /**
   * SCI0 and SCI01 ship a table of their own — 112 named calls, and eight of
   * them (`TimesSin` through `TimesCot`, `FOpen` through `FClose`) are not in
   * SCI1's at all. The measurement this replaces reported SCI16's gap as the
   * whole gap and never counted these.
   *
   * **Nothing is absent from SCI0's table now.** The last four were one
   * surface rather than four calls — a file the game opens, writes lines to and
   * reads back — and `sciFiles.ts` is it, wired through `SciKernelWorld.files`.
   *
   * Pinned as an equality against the empty list rather than a length, so that
   * a call which arrives later and is *not* answered fails here by name.
   *
   * **Zero missing is not "SCI0 runs".** Thirty-eight of its calls still answer
   * a constant, `DoSound` and `SaveGame` among them, and this file's other
   * tests pin that number for exactly that reason. What this asserts is
   * narrower and worth having on its own: no SCI0 script can now reach a name
   * this engine has never heard of.
   */
  it('has nothing left absent from SCI0’s table', () => {
    for (const version of ['sci0-early', 'sci0-late', 'sci01'] as const) {
      expect(kernelCoverageFor(version).missing).toEqual([]);
    }
  });

  /**
   * SCI1's gap, which is the one the run was aimed at, and it is not one set:
   * SCI1 late renumbers 0x71 from `MoveCursor` and SCI1.1 renumbers it again to
   * `PalVary` and 0x26 to `Portrait`, so each has a missing set of its own.
   *
   * `Intersections` left this list by being written. It was the only name on it
   * that needed nothing from the renderer — ten arguments, two buffers the
   * script already owns, and integer arithmetic between them.
   *
   * Four of the five need a `SciKernelWorld` hook that does not exist:
   * `IsItSkip` a cel's pixels, `AssertPalette` a palette loader, `TextFonts`
   * the text-code font store, `ResCheck` resource presence. Each is wired in
   * `SciEngine.ts`, which is outside what this run may change. Recorded as the
   * boundary rather than answered with a fallback — which, as the constant
   * column now shows, is what closing a gap without writing anything looks
   * like.
   *
   * **`MergePoly` left it by being written**, and it is worth saying why it
   * took two attempts. It needs no hook either: it walks a list of polygon
   * objects with `world.heap.list`, reads their `points`, `size` and `type` by
   * name through the game's own Selector table, and allocates its answer on the
   * heap — every one of those already in `script/` and reachable from here. It
   * was declined once on the argument that nothing would read the answer,
   * because this engine's pathfinder is `AvoidPath` and `AvoidPath` is
   * `() => NULL_REG` in the constant column. That argument was about sequencing
   * and not about a boundary, and it would have excluded `Intersections` too.
   * A call that answers correctly and is not yet consumed is still a call this
   * engine answers; `AvoidPath` is the next thing to write, not a precondition
   * for this one.
   *
   * ScummVM's own `mergeSinglePolygon` carries the comment that it "matches
   * qfg1new closely, and is a bit error-prone", and no SCI game data is mounted
   * here to tell a faithful transcription from a subtly wrong one — so the
   * transcription is checked in `sci-pmachine.test.ts` against the definition
   * of a union rather than against itself: a point is inside the merged outline
   * exactly when it was inside either shape, over two hundred random crossing
   * convex pairs.
   */
  it('leaves nothing absent before SCI1.1, and one there', () => {
    // `AssertPalette`, `IsItSkip`, `ResCheck` and `TextFonts` each needed a
    // hook into the engine — a palette loader, a cel's pixels and its clear
    // key, the resource map, the text-code font store — and each has one now.
    // `MoveCursor` was SCI1 late's fifth.
    for (const version of [
      'sci0-early',
      'sci0-late',
      'sci01',
      'sci1-ega-only',
      'sci1-early',
      'sci1-middle',
      'sci1-late',
    ] as const) {
      expect(kernelCoverageFor(version).missing).toEqual([]);
    }

    // `PalVary` has since been written — a palette fade the cycle advances —
    // and `Portrait` is what is left: the talking-head surface, with its own
    // resource kind and its own audio sync, which is not a hook away.
    expect(kernelCoverageFor('sci1-1').missing).toEqual(['Portrait']);
  });

  /**
   * The four columns as figures, pinned so none of them can move quietly.
   *
   * The one worth reading twice is SCI1 early: 85 of its 137 named calls have
   * behaviour, 41 answer a constant, 11 are the unused stub and none are
   * missing. The figure this replaces was 120 implemented and 6 missing, and
   * both halves of that were true only under the reading that a key is an
   * implementation.
   *
   * The two that moved before last are `FileIO` and `CheckFreeSpace`, out of
   * the constant column and into the implemented one: twenty sub-functions and
   * three questions that had all been answered with the same nought.
   *
   * **The one that moved last is `DoSound`, and it moved every row by one.**
   * That is the shape to expect of a call every Version names: each row here
   * gains one implemented and loses one constant, and nothing else changes.
   * A row that moved by more than one would mean the edit reached further than
   * the call it was for.
   *
   * The command: `npm run sweep:sci -- --kernel-coverage`.
   */
  it('pins what each column holds, per Version', () => {
    const row = (version: Parameters<typeof kernelCoverageFor>[0]) => {
      const coverage = kernelCoverageFor(version);
      return [
        coverage.named.length,
        coverage.implemented.length,
        coverage.constant.length,
        coverage.unused.length,
        coverage.missing.length,
      ];
    };

    // named, implemented, constant, unused stub, missing.
    //
    // `Text` is the most recent to move, and it moved SCI2.1 and SCI3 only —
    // `kText_subops` arrives at SCI2.1 middle, and both of its sub-functions
    // are measurements this file already had under SCI16's name for them.
    //
    // `FileIO` moved a column in every Version from SCI1 on, which is what one
    // call gaining behaviour looks like from here: it was `() => int(0)` and is
    // now a dispatch onto the file surface and the answers this file already
    // had. King's Quest VII's "Start New Game" is what it cost — sub 17 is
    // `CheckFreeSpace`, the game was told there was no room to write a save,
    // and it declined to start one.
    //
    // `AddPicAt` moved every SCI32 column by one, and it is the call King's
    // Quest VII draws a room's background with: room 1250 sets no `picture` on
    // its Plane at all and calls this once. Answering nought meant the room
    // ran correctly with no scenery in it, which on screen is a black frame.
    //
    // `InPolygon` moved them again, and answering nought to that one is not a
    // missing picture but a missing *floor*: it is what a SCI32 game asks of a
    // click before it will move the ego, so a constant zero is a room that
    // draws, runs its loop, polls its events and refuses every click on it.
    //
    // `AvoidPath` moved out of the **constant** column and into the
    // implemented one at every Version, which is why the middle two numbers
    // shift by one across the board rather than the last. It answered
    // `NULL_REG` to everything, and a SCI32 room's `PolyPath` uses what it
    // returns as the route — so the destination of every click fell out as
    // 0, 0 and the ego walked toward the origin until she left the room.
    expect(row('sci0-early')).toEqual([112, 76, 30, 6, 0]);
    expect(row('sci01')).toEqual([112, 76, 30, 6, 0]);
    expect(row('sci1-early')).toEqual([137, 87, 39, 11, 0]);
    expect(row('sci1-late')).toEqual([137, 87, 39, 11, 0]);
    expect(row('sci1-1')).toEqual([137, 87, 38, 11, 1]);
    expect(row('sci2')).toEqual([150, 86, 27, 13, 24]);
    expect(row('sci2-1-early')).toEqual([123, 71, 21, 11, 20]);
    // SCI3 does not move: its table lists `AvoidPath` as a dummy.
    expect(row('sci3')).toEqual([122, 68, 21, 11, 22]);
  });

  /**
   * SCI32's gap, published rather than closed.
   *
   * ADR 0020 asks for the gap between what this project can play and what it
   * can edit to be a published number rather than an impression, and this is
   * the same shape of claim for the Kernel: 58 calls at SCI2 and SCI2.1, 59 at
   * SCI3, untouched by this run by instruction. The one that moved did so
   * sideways — `MergePoly` is named at SCI2 and SCI2.1 and was written for
   * SCI16, so SCI32 inherited it without SCI32 being worked on. SCI3 does not
   * name it, which is why SCI3 is the row that did not move. Pinned so that
   * closing one is a deliberate edit to this line rather than a number that
   * quietly drifts.
   */
  it('publishes SCI32s gap rather than closing it', () => {
    const gap = Object.fromEntries(
      SCI_VERSIONS.filter((version) => version.startsWith('sci2') || version === 'sci3').map(
        (version) => [version, kernelCoverageFor(version).missing.length],
      ),
    );
    expect(gap).toEqual({
      // SCI2 sits above the SCI2.1 rows because `Font`, `CD` and `Text`'s
      // sub-opped forms arrive at SCI2.1 middle: a call this engine answers
      // there has no slot to answer at SCI2, so closing it does not move
      // SCI2's number. SCI3 sits above them because `SetScroll` is a dummy
      // there, and a dummy is not a handler.
      sci2: 24,
      'sci2-1-early': 20,
      'sci2-1-middle': 20,
      'sci2-1-late': 20,
      sci3: 22,
    });
  });

  /**
   * The other direction of the same check, and the one that catches a rename:
   * a handler written as `SinDiv` where the table says `CosDiv` is not missing
   * by the count above — it is present, unreachable, and reads as working.
   */
  it('has no handler no Version can reach', () => {
    expect(unreachableHandlers()).toEqual([]);
  });
});
