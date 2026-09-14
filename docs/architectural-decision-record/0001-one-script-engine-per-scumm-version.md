# One script engine per SCUMM version, over a shared engine

Adding SCUMM v6 (Day of the Tentacle, Sam & Max) means adding an instruction
set with nothing in common with v5's: v5 packs operand modes into the opcode
byte, v6 is a stack machine. There is therefore nothing to gain by
version-branching inside the existing handlers, and a great deal to lose, since
every v6 discovery would edit code Monkey 2 depends on. So each version gets its
own script engine, and both drive the same `ScummEngine` semantic surface —
`putActor`, `beginCutscene`, `showText` and the other ~110 methods the v5
interpreter already calls, which are the same operations v6 scripts ask for.

## Consequences

Script slot state and the cutscene stack currently live inside `ScriptEngine`,
and `ScummEngine` reaches into them (`scripts.slots`, `scripts.cutSceneStack`,
`scripts.readVar`). Two engines sharing that means extracting it into something
both use — a refactor of working v5 code, accepted deliberately as the price of
not forking the runtime.

Rejected: a single version-parameterised engine (risk to v5 without reuse, since
decoding cannot be shared), and a separate v6 runtime top to bottom (would
duplicate actors, verbs, sentence handling and cutscenes, which v6 barely
changes, and the two would drift).
