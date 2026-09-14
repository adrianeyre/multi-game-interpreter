# Version folders live inside subsystems, not at the top of src

With one script engine per version (ADR 0001), the obvious layout is
`src/v5`, `src/v6` and `src/core`. We are deliberately not doing that.

Only three parts of the engine vary by version: the script engine entirely, the
costume format (classic v4/v5 vs v6 AKOS), and sound (shipped-format selection
vs iMUSE plus digital audio). `Actor`, `Room`, `BoxMatrix`, `Screen`, `Palette`,
`RoomGraphics` and `Verbs` carry no version assumption at all, and `authoring`,
`editor` and `ui` are not on the version axis. A top-level `core` would
therefore mean "everything that is not a script engine", and a top-level `v6`
would be a bucket with room in it — the first time v6 wanted slightly different
actor behaviour, the cheap move would be to copy `Actor.ts` into it, which is
the fork ADR 0001 exists to prevent.

So the layout stays subsystem-first, with version leaves only where the version
actually varies: `engine/script/v5`, `engine/script/v6`, and the same for the
costume and sound decoders. An ESLint boundary rule forbids `v5` importing `v6`
and vice versa, doing the job the directory split would have done.

## Consequences

"What does v6 consist of?" cannot be answered by listing one directory. This ADR
and the module layout in the README are where that answer lives instead.
