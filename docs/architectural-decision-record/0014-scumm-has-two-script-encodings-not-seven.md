# SCUMM has two script encodings, not seven

ADR 0001 gave each SCUMM version its own script engine, on a premise it stated
plainly: v5 packs operand modes into the opcode byte, v6 is a stack machine, and
they "share an instruction set with nothing in common". ADR 0006 then found the
opposite relationship between v6 and v7 — v7 _is_ v6's stack machine plus a
delta — and moved the shared decode loop into `script/StackScriptEngine.ts`.
ADR 0012 restated the rule as **one script engine per encoding**, and ADR 0001's
"one per version" as the special case where no two Targets agreed.

Widening SCUMM to v2–v8 settles which of those is the general case. It is not
seven encodings. It is two:

| Encoding | Shared base                     | Deltas         |
| -------- | ------------------------------- | -------------- |
| Classic  | `script/ClassicScriptEngine.ts` | v2, v3, v4, v5 |
| Stack    | `script/StackScriptEngine.ts`   | v6, v7, v8     |

ADR 0001's premise does not hold looking _backwards_ from v5 the way it holds
looking forwards. v2, v3 and v4 pack operand modes into the opcode byte exactly
as v5 does; they differ from it by instructions added, removed and renumbered.
ScummVM records the same fact by derivation, `ScummEngine_v5` <- `v4` <- `v3` <-
`v2`, each subtracting from the one after it. v8 sits on the other side of the
same line: v7's stack machine again, with 32-bit resource directories and script
numbering.

So `v5/ScriptEngine.ts` — today a concrete 2216-line class with no delta seam —
is refactored into an abstract Classic base with v5 as its first delta, and v8
arrives as a third Stack delta. Two bases, seven deltas.

Rejected: seven engines, one per Version, which is ADR 0001 applied past its own
premise. Four of them would be near-copies of the Classic base, and every fault
found in shared behaviour — which in this codebase means every fault found by
running a real game — would be fixed four times and drift between them.

Rejected: `v4` extending `v5` directly, ScummVM-style. That inverts ADR 0001's
rationale exactly as ADR 0006 refused to let v7 extend v6: v5 becomes a base
class, so every v4 discovery edits code Monkey Island 2 and Fate of Atlantis
depend on. ScummVM can afford the chain because its v5 is settled; ours carries
the Atlantis fault list and is the version this project is least willing to
disturb.

Open, deliberately: **v2 may need its own depth.** Its delta is much the largest
— it changes the object and verb model, not only instructions — and it may read
better as a subclass of the v3 delta than as a fourth flat sibling. That is
decided with the opcode table in front of us, not here.

## Consequences

Extracting the Classic base is a refactor of the most hand-verified code in the
repository. ADR 0006 accepted the same risk one rung up and set the discipline
this follows: it lands as its own change with **no new Version attached**, so a
regression in Fate of Atlantis is attributable to it rather than to v4 arriving
at the same time, and the Tier 2 checkpoints in
`docs/processes/verifying-version-support.md` are re-confirmed before anything
new lands.

`ScummVersionTarget` widens from `5 | 6 | 7` to `2 | 3 | 4 | 5 | 6 | 7 | 8`, and
`ScummVersion` in `GameDetector` gains `2`. The ESLint boundary rule stands: a
version folder still may not import a sibling, because everything shared lives
in a base rather than in a neighbour.

**Encoding is not layout.** The two bases above cover instruction decoding only.
Resource layout varies on its own axis — `LFL` room files (v2, v3), `LEC` disk
containers (v4), one `LECF` container (v5–v8) — so v4 and v5 nearly share an
encoding and share no layout at all. `exportGame.ts` describes itself as
"version-agnostic, which is the useful surprise"; that surprise is a property of
the `LECF` container, not of SCUMM, and it does not survive the move backwards.
Three writers, one principle: copy what was not touched, substitute what was,
rebuild the index.
