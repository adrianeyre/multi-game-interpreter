# Projects are tagged with a Target, not a version number

ADR 0004 gave a project two numbers: `version`, the project _format_ version
with a migration path, and `scummVersion: ScummTarget`, the SCUMM version it
compiles to. Its reasoning was that overloading one field would break either
migration or version selection, and eventually both.

`ScummTarget` has since widened to `5 | 6 | 7`, and that widening is the proof
the field works as designed: a third SCUMM version cost one union member and one
entry in `SCUMM_TARGETS`. A second Engine family is not that.

A second Engine family breaks the second field the same way. AGI has versions of
its own — v1, v2 and v3 — and they are not points on SCUMM's scale. `{engine:
'agi', version: 6}` is not a thing that exists, and neither is a version without
a family.

Then AGI breaks the field a second way, which is the part worth writing down. A
version number is enough to decode SCUMM and is **not** enough to decode AGI.
The number of arguments an AGI instruction takes is not encoded in the bytecode:
it comes from a table in `agidata.ovl`, and that table varies by interpreter
build, by platform, and for three titles by game. `quit` takes no argument under
2.089 and one under everything later — both AGI v2. `hide.mouse` takes one under
3.002.086 and none later — both AGI v3. On Apple IIgs, `discard.sound` is not
even the same opcode number. The axis that determines the encoding cuts across
the major version, not along it.

So a Target is not "family plus version". It is **everything that must be known
before a byte can be read**, held as one value.

So `scummVersion` is replaced by a discriminated union:

```ts
type Target =
  | { engine: 'scumm'; version: 5 | 6 | 7 }
  | { engine: 'agi'; interpreter: InterpreterVersion; platform: AgiPlatform };
```

The two arms are not symmetrical, and that asymmetry is the decision. A SCUMM
Version fixes the instruction encoding. An AGI major version does not — it fixes
only the resource layout. What fixes AGI's encoding is the Interpreter version
and the platform, so those are what the Target carries. The major is derived
(`interpreter >= 0x3000`) and used only where it is actually meaningful: the
combined index and the LZW volumes.

Rejected: two optional fields (`scummVersion?`, `agiVersion?`), which permits
both-set and neither-set — precisely the overloading ADR 0004 warned about, one
level up. Rejected: a flat string (`'scumm5' | 'agi3'`), which makes ambiguity
impossible but costs the ability to say "every SCUMM version shares this"
without parsing, and grows a case per combination — a cost that rises with each
version, and v7 has just shown versions keep arriving. Rejected: an `engine`
field beside a plain `version: number`, where the illegal pair typechecks.

`version` — the format version — is untouched. This is ADR 0004's second number
becoming a pair, not a third number arriving.

## Consequences

A Target selects an Engine, a Script engine and an assembler together. ADR 0004
said one assembler per version and now reads "per Target".

Script engines were never quite one per version, and v7 made that explicit
before AGI arrived: ADR 0006 moved the stack machine v6 and v7 share into
`script/StackScriptEngine.ts`, with each installing its own opcode delta. AGI
takes the same rule further — v2 and v3 share an instruction encoding outright,
so every Target between them shares one script engine with no delta at all.
ScummVM settles the question: its `setupOpCodes` selects a single 183-entry table
for every interpreter at or above 2.0, v2 and v3 alike, and varies only argument
counts within it.

**"AGI" here means AGI v2 and v3.** ScummVM keeps a separate 99-entry table for
interpreters below 2.0, and it serves DOS booter and Apple II releases whose
resources are not files at all but sectors of a self-booting disk image. Those
are out of scope and recorded as such in
`.out-of-scope/agi-booter-and-apple-ii.md`, so this ADR's AGI arm describes the
DOS releases with a `*DIR` index and nothing else. The interpreter version is
still the right field: it simply never holds a value below `0x2000`.

**One per encoding** is the rule; ADR 0001's "one per version" was the special
case where no two Targets agreed.

Project files written before this carry `scummVersion` and are migrated to
`{engine: 'scumm', version: n}` by the existing format-version path — which is
what that path is for. `readProject` already tolerates an out-of-range
`scummVersion` by falling back to a default, so the migration has one behaviour
to preserve as well as one to add.

An AGI Target cannot be inferred from resource files alone. The interpreter
version lives in the interpreter, not the data, and ScummVM identifies it by
hashing each known release and falling back to a guess with a warning when that
fails. ADR 0013 decides what this project does when identification falls back:
play on the guess, refuse to edit.

Prose, commits, branch names and issue labels never write a bare version.
"AGI v3" and "SCUMM v3" are different engines, and "v3" is not a thing this
project says any more. The existing `v6` and `v7` labels keep their names
because they predate AGI and mean SCUMM; AGI labels are prefixed.
