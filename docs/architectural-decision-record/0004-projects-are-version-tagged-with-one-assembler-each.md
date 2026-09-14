# Projects are version-tagged, with one assembler per version

The editor's round trip works today because everything is v5: `Assembler.raw()`
passes a published game's preserved bytecode straight through, and authored
actions compile to v5 bytecode alongside it in the same script. For an imported
v6 game that breaks — the preserved bytes are v6, and the compiler would emit v5
bytecode into the middle of them.

So a project carries the SCUMM version it targets, and there is one assembler
per version, mirroring ADR 0001 on the write side. An imported Day of the
Tentacle is a v6 project: preserved bytes pass through unchanged, authored
actions compile through the v6 assembler, and the editor's play path runs the
result on the v6 script engine. Export produces patched game files a v6
interpreter can run.

The v6 assembler is scoped initially to whatever the v6 decompiler emits —
enough to close the round trip and prove it byte-for-byte — rather than to the
whole `Action` set on day one. The remaining actions land as authors ask for
them.

## Consequences

`Project.version` already exists and means the _project format_ version, with a
migration path for older files. The SCUMM version is a second, unrelated number
and gets its own field: overloading one of them would break either migration or
version selection, and eventually both.

Compiling a v6 project to v5 output is not supported and will not be: the v6
features, the AKOS costume format and the preserved bytes have nowhere to go.
`compile.ts`, which compiles the `code` action's source, needs a v6 mode before
that action is available in a v6 project; until then it is refused rather than
mis-compiled.
