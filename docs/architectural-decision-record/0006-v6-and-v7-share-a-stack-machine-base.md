# v6 and v7 share a stack machine base, held in `script/`

ADR 0001 gave each SCUMM version its own script engine because v5 and v6 share
nothing: v5 packs operand modes into the opcode byte, v6 is a stack machine.
v7 is not that relationship. v7 _is_ v6's stack machine, plus a delta — a
handful of replaced instructions, its own `wait` and `kernelGetFunctions`
sub-opcodes, and a different message encoding. ScummVM records the same fact by
deriving `ScummEngine_v7` from `ScummEngine_v6`.

So the decode loop, the operand stack, variable and array addressing, the
opcode budget and the instructions the two versions genuinely share move into
`script/StackScriptEngine.ts`, and `v6` and `v7` each extend it and install
their own opcode deltas. The ESLint boundary rule stands unchanged — a version
still may not import a sibling — because the shared code is not in a sibling
any more.

## Consequences

This is a refactor of v6 code that four faults were only just beaten out of
against real game data, which is the risk ADR 0001 accepted in the other
direction. It lands as its own change with no v7 behaviour attached, so a
regression in Day of the Tentacle is attributable to it rather than to the new
version arriving at the same time. The delta itself is readable from ScummVM up
front, so the seam is measured rather than guessed.

Rejected: `v7` extending `v6` directly, which inverts ADR 0001's rationale —
v6 becomes a base class, so every v7 discovery edits code Day of the Tentacle
depends on, which is the precise harm that ADR exists to prevent. Also rejected:
copying the v6 engine into `v7` and letting the two diverge, which fixes every
fault in shared behaviour twice and drifts, in a codebase where most faults were
found only by running a real game.
