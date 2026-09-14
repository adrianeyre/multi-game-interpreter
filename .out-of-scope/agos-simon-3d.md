# Simon the Sorcerer 3D

**Decision: not in scope, permanently.** Settled while scoping the AGOS family
(ADR 0027).

Simon the Sorcerer 3D (1998) shares a name, a protagonist and a publisher with
the AGOS catalogue. It shares no engine. It is a hardware-accelerated 3D game
with polygonal characters and a free camera, and the parts of AGOS this project
is implementing — an item tree, a subroutine bytecode, a 2D cel renderer over a
band layout — describe nothing about it.

## Why it is declined

**It is a different engine wearing a familiar name.** ScummVM does not implement
it either, and for the same reason: its own engine work would have almost no
overlap with the AGOS one. Taking it on would mean a 3D renderer inside a project
whose `Screen` is a 2D surface hardcoded in dozens of places, to reach one game.

**The scope it appears to belong to is a naming coincidence.** "Every AGOS game"
(ADR 0027) is a claim about an engine. "Every Simon game" would be a claim about
a character, and this project has never scoped by character — King's Quest IV
shipped as AGI v3 and as SCI0 and `CONTEXT.md` calls those different games that
share a name.

## What would reopen it

Nothing short of the project acquiring a 3D renderer for some other reason. This
is a permanent exclusion rather than a deferral, which is the distinction
`.out-of-scope/` exists to record.
