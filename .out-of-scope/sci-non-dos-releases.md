# SCI on Amiga, Macintosh and Atari ST

**Decision: not in scope.** Settled while scoping SCI0–SCI3 (ADR 0016).

SCI shipped on more than DOS. Amiga saw Leisure Suit Larry 2 and 3, Space Quest
III, Conquests of Camelot and others; Macintosh saw a run of SCI1.1 titles
including King's Quest VI and Freddy Pharkas; Atari ST saw a handful of SCI0
games.

## Why it is declined

**It is a second way to load games that already play.** Every SCI title in scope
has a DOS release. Supporting Amiga and Mac would add _other releases of the
same games_, not new games — which is `agi-booter-and-apple-ii.md`'s argument
verbatim, and it was right there too.

**The bytecode is not the work; the resources are.** This is worth stating
because it is the opposite of AGI's situation and the two are easy to conflate.
AGI's platform is on its Target because Apple IIgs changes an instruction's
length and one instruction's opcode number — a decoding problem. No SCI platform
touches the bytecode at all. What changes is View cel encoding, palette depth,
sound drivers, and on Macintosh the packaging itself, because resources live in
resource forks rather than in volumes laid out the way `RESOURCE.MAP` expects.
So it is a second resource layer per platform, sitting under an interpreter that
would not notice.

**The verification cost is the real one, again.**
`docs/processes/verifying-version-support.md` cannot assert _Completable_ from
CI, and the fan-made games that give SCI its only free test data are DOS. A Mac
release would be verified by a person with a Mac copy, per title.

## What is deliberately not covered by this decision

**Windows is not one of these platforms.** SCI1.1 and later "Windows" releases
are the same DOS-loadable data carrying an alternate hi-res or palette variant
selected by a flag — King's Quest VI's Windows portraits are the familiar case.
Filing that under "non-DOS, out of scope" would wrongly exclude content shipping
inside games we do support. It is a display option in the resource layer.

## What is kept

`SciPlatform` exists in the Target type with only `dos` implemented, exactly as
`AgiPlatform` did before AGI's platforms were needed. Adding one later is a
value and a resource-layer implementation, not a change of shape.
