# AGOS on Amiga, Atari ST, Acorn and Macintosh

**Decision: not in scope.** Settled while scoping the AGOS family (ADR 0028).

AGOS shipped widely off the PC. Elvira, Elvira II and Waxworks saw Amiga and
Atari ST releases; Simon the Sorcerer saw Amiga floppy in both ECS and AGA
flavours, an Amiga CD32 talkie, an Acorn Archimedes release and a Macintosh one;
Simon II and The Feeble Files saw Macintosh and Amiga releases of their own.

## Why it is declined

**It is a second way to load games that already play.** Every AGOS game in scope
has a DOS or Windows release. Supporting these adds _other packagings of the
same games_, not new games — the argument `scumm-non-dos-releases.md`,
`agi-booter-and-apple-ii.md` and `sci-non-dos-releases.md` already make, applied
a fourth time for consistency rather than invented here.

**The work is the pixels and the packaging, not the bytecode.** No AGOS platform
changes an instruction's meaning or its length: the Version is the title and the
title carries the opcode table (ADR 0027). What changes is how graphics are
packed, how cels are encoded — Amiga's planar bitplanes against the PC's
chunky bytes — and how music is played, which on Amiga is module playback with
no sibling anywhere in this repo to borrow from. That is a resource layer and a
sound backend per platform, under an interpreter that would not notice either.

## What this does not decide

**The Target still carries a platform.** ADR 0028 keeps it there, and this file
narrows which values are implemented rather than removing the axis. A Project
tagged `AGOS Simon1 / DOS` is saying something true about itself, and would go on
being true beside an `Amiga` sibling.

**Adding one later is additive.** ADR 0030 splits packaging from encoding
deliberately: a reader per packaging layout, with cel encoding, palette depth
and colour count declared by the release and read by one decoder. An Amiga
release is a new packaging reader and two new declared values, not a second
renderer and not a fork of the interpreter. That is the shape this decision is
designed to leave behind, and it is why declining now costs little later.

## What would reopen it

A game that exists **only** off the PC. Nothing in the AGOS catalogue is known to
be one; if a release turns up that is, the argument above stops applying to it
and this file should be revisited rather than worked around.
