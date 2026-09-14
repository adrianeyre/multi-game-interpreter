# SCI is a third Engine family, and one family rather than two

Sierra's Creative Interpreter ran for a decade after AGI and shares nothing with
it — an object system with classes and message dispatch where AGI had a fixed
instruction set, `RESOURCE.MAP` over volumes where AGI had `*DIR` files. It is a
third Engine family, and it lands in this repository for the reasons ADR 0011
already settled for the second: one deploy, one issue tracker, no
published-package seam between a shell and the engines that need to share a
screen.

The decision worth recording is not _that_ SCI is a family. It is that SCI is
**one** family, because the obvious reading says two.

## Why it looks like two

SCI2 is where Sierra rewrote the graphics. SCI0 through SCI1.1 — "SCI16" — draw
a Picture into three parallel buffers, blit View cels against a per-pixel
priority mask, and run at 320x200. SCI2 through SCI3 — "SCI32" — have no
priority buffer at all: Planes hold screen items, the compositor sorts plane
then item then insertion order, and the display is 640x480 with full-motion
video woven through it. ScummVM walls the second off behind `ENABLE_SCI32` with
a graphics tree of its own.

`CONTEXT.md` says two families "share no bytecode, no resource layout and no
renderer". SCI32 satisfies exactly one of those three.

## Why it is one

The two that matter are the two it fails.

**The bytecode is shared.** SCI0 through SCI2.1 run the same PMachine, and
instruction length comes from the low bit of the opcode byte throughout. ADR
0017 takes this further and carries SCI3 on it as a flagged assumption.

**The resource layout drifts rather than breaks.** `RESOURCE.MAP` entry widths
change, a type directory appears at the front, `RESSCI.MAP` arrives — but every
step is the previous one moved, and a reader that walks one is recognisably the
reader that walks the next. Compare SCUMM, where v4's `LEC` disk containers and
v5's single `LECF` share nothing, and both are still SCUMM.

**The renderer is a separable question, and this ADR deliberately does not rest
on it.** That is the correction worth writing down, because the first draft of
this reasoning did rest on it. ADR 0007's test — do these "differ by degree in a
way one model can hold" — was applied to the compositor and gave an answer, but
the family decision does not depend on that answer. **One family with two
renderers would still be one family.** A future reader who finds a split
compositor should not conclude this ADR was wrong.

## What the renderer decision actually is

One compositor, in which the **priority buffer is optional data on a Plane**
rather than a branch in the code. A Plane either carries the per-pixel mask
SCI16 paints from a Picture or it does not; a screen item's visibility test
reads it when present and falls through to pure ordering when absent. SCI32
Planes never carry one.

This is ADR 0007's move a third time — widen the data so nothing asks which
Version it is — and it survives the case that kills the naive reading. "SCI16 is
one full-screen Plane" is false, because a sorted display list cannot reproduce
scenery occluding the middle of an actor while its head shows above. Carrying
the mask on the Plane can.

**Robot is a screen item, not a video.** SCI2's `RBT` is pre-rendered actor
footage composited into a Plane with a priority — Phantasmagoria's protagonist
is one. It is drawn into the scene, unlike VMD, SEQ and DUK, which are played at
the screen and get SMUSH's treatment unchanged. Holding Robot as a screen-item
kind is what keeps one compositor honest, and it is also the test of it:
Phantasmagoria will answer whether the claim was real.

**The tripwire.** If the priority buffer's presence starts being asked about
outside the visibility test — in dirty-rect tracking, in cel clipping, in
hit-testing — it is not optional data, it is a second renderer, and the renderer
should split rather than grow flags. Splitting it does not reopen this ADR.

## Consequences

Input needs no family branch and, unexpectedly, needs less than either sibling.
ADR 0011 kept input out of the host seam because a verb bar and a typed parser
"do not differ by degree" — and SCI contains both, parser-driven at SCI0 and
icon-bar-driven at SCI1. It costs nothing, because SCI moved the UI into the
game: the icon bar is a class the shipped scripts build, the input window is a
control the game creates, and the parse is a Kernel call over the game's own
vocabulary. SCI's Engine exposes keyboard and pointer events and nothing else.

What it does need that neither sibling does is a **queue**. SCI scripts poll for
the next event matching a type mask rather than being handed one, so events must
be buffered with their masks and timestamps. Dispatching them as they arrive
loses input in a way that never errors and is very hard to trace.

The mouse cursor is a resource in SCI and has no analogue in SCUMM or AGI. Small,
but it is a subsystem with a resource type behind it rather than a detail.
