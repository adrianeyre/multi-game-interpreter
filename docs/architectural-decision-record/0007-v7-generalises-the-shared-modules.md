# v7 generalises the shared modules rather than branching them

ADR 0003 kept version folders out of the top of `src` on a factual claim: that
only the script engine, the costume format and sound vary by version, and that
`Actor`, `Room`, `BoxMatrix`, `Screen`, `Palette`, `RoomGraphics` and `Verbs`
carry no version assumption at all. v7 falsifies the claim in two places. The
Dig has rooms taller than the screen, so v7 tracks a screen top as well as a
camera x, where the camera here has no y at all. And v7 gives the whole
320x200 to the room, drawing its interface — Full Throttle's verb coin, The
Dig's cursor menu — as a script-drawn overlay rather than in a verb band.

Neither becomes a version branch. The camera becomes two-dimensional
unconditionally, and v5 and v6 get a y range one screen tall, so their
behaviour is the degenerate case of one model rather than the other side of an
`if`. The band layout was already data driven through `setLayout`, and v7 is a
game that sets a full-height room band. Nothing asks which version it is.

SMUSH is not on the version axis at all — it is a format v7 introduced and
nothing else uses — so it gets its own subsystem, `engine/video/`, alongside
`gfx` and `sound` rather than a leaf inside one of them.

## Consequences

ADR 0003's claim is narrowed, not reversed: the layout stays subsystem-first
with version leaves only under `script`, `gfx/costume` and `sound`. What changes
is the reason the other modules have no leaves — not that they carry no version
assumption, but that the versions differ by degree in a way one model can hold.

Generalising touches code v5 and v6 depend on, and a camera is exercised by
every frame of every game. Regression cover for the existing scroll behaviour
lands before the generalisation, not after.

Rejected: asking the version inside `Screen` and the camera, which is the
version-branching-inside-handlers ADR 0001 refused, and where the second branch
is free once the first exists. Also rejected: version leaves under `gfx` for the
camera and screen, which ADR 0003 already argued against as a bucket with room
in it — and these sit far closer to the shared core than a costume decoder does.
