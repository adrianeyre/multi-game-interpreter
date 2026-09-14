# Lure of the Temptress is a fifth Engine family, not a second Sky Release

Revolution Software shipped two adventures on the engine they called **Virtual
Theatre**: Lure of the Temptress (1992) and Beneath a Steel Sky (1994). ADR 0023
took the second as a fourth Engine family. This ADR takes the first, and records
why it is a **fifth** family rather than another point on the fourth's axis —
because the shared engine name makes the wrong answer the obvious one.

## Why it looks like one family

Two games, one developer, one named engine, two years apart. Both are 320x200 in
256 colours. Both drive a world of background characters going about their
business independently of the player, which is the thing Virtual Theatre _is_
and the reason Revolution gave it a name. Both keep part of the game in the
executable rather than in the data files, and ADR 0024 covers them with one
rule.

That is a great deal in common — more than SCUMM v4 and v5 have, and those are
one family. If the test were "same lineage, same developer, same idea", these
would be one family with two Releases and this ADR would not exist.

## Why it is two

`CONTEXT.md`'s test is not lineage. It is three specific things: "two families
share no bytecode, no resource layout and no renderer."

**The resource layout is not shared.** Lure reads `disk1.vga` and its
successors; Sky reads `sky.dsk` addressed through `sky.dnr`. Not a drift — a
different container, indexed differently. Compare SCI, which ADR 0015 kept as
one family precisely because its layout "drifts rather than breaks" and "a
reader that walks one is recognisably the reader that walks the next". These are
not that.

**The bytecode is not shared.** Two separate script systems, and ScummVM's own
structure is the strongest available evidence: `lure` and `sky` are separate
engines in separate directories with no shared code between them. ScummVM
routinely folds related interpreters into one engine when they _are_ related —
its SCUMM engine spans v0 to v8 and the Humongous fork on top. It did not fold
these.

**The renderer is a separable question, and this ADR does not rest on it**, for
the reason ADR 0015 gives at length: "one family with two renderers would still
be one family," and the converse — two families that happen to render alike are
still two.

So Virtual Theatre fails two of three. SCI failed one of three and stayed one
family. The rule is applied consistently rather than to reach a preferred
answer, and it gives opposite results because the cases are genuinely opposite.

## What this costs, stated plainly

**Roughly a second engine's worth of work, not an extension of the first.** A
detector, a resource reader, a script interpreter, a renderer, sound, saves, an
object-table extractor and an editor surface — each written against Lure's own
formats. What the two families share is ADR 0024's rule and ADR 0025's
reasoning, which are documents rather than code.

This is worth recording because the request that produced this ADR was "make
every Virtual Theatre game playable and editable", and that reads like one job.
It is two, and the cost was flagged before the work began rather than
discovered in the middle of it.

**What is not shared is also not wasted.** The app shell is. `AdventureEngine`
absorbed a fourth family without widening (ADR 0023) and Lure is the fifth test
of the same seam. ADR 0011's ceiling of roughly thirty members still stands, and
if Lure forces a member, the member is the finding.

## Naming, revisited

ADR 0023 argued the family should be called **Sky** rather than Virtual Theatre,
because Virtual Theatre "also covers Lure of the Temptress, which is a different
interpreter that ScummVM implements as its own `lure` engine" and is out of
scope. **The out-of-scope half of that sentence is now wrong, and the conclusion
survives anyway** — which is worth writing down rather than quietly correcting,
because the reason changed.

Virtual Theatre is not a family name because it names **two** families. Not
because one of them is unsupported — because a family is one interpreter
lineage, and Virtual Theatre is two of them under a marketing name. So the
families are **Sky** and **Lure**, the names ScummVM uses and the names that
each denote exactly one interpreter, and Virtual Theatre remains the useful word
for the pair.

`CONTEXT.md` keeps Virtual Theatre as an _Avoid_ against either family name and
gains it as a term of its own for the relationship, since "the Virtual Theatre
families" is now a thing a person needs to say.

## Version axis

Lure has none, for ADR 0023's reason applied again: one game, one engine lineage
under it. Its Target carries a **Release** — the floppy release, the demo — and
a platform, `dos` only per
`.out-of-scope/virtual-theatre-non-dos-releases.md`.

That makes two families with no Version between them, which is now a pattern
rather than an oddity, and `CONTEXT.md`'s **Version** entry says so.

## Freeware, and what it is worth

Lure of the Temptress has been freeware since 2003, the same year and the same
gesture as Beneath a Steel Sky, and is distributed from ScummVM's downloads
page.

ADR 0023 leaned hard on that for Sky: it is the only family whose **Completable**
claim can be checked without somebody owning a disc, and therefore the only
escape from Tier 1's trap of "a fixture that encodes our reading of the format".
Lure doubles that, and it doubles it in the way that matters most — **two
independent games** rather than one, so a bug in the shared shell has two chances
to show itself against real shipped bytes.

That is the strongest argument for taking this family, and it is stronger than
the argument for taking Sky was.

## Rejected

**Lure as a Sky Release.** The obvious modelling of "one engine, two games", and
it would put two unrelated bytecodes behind one `Target` arm — which is exactly
the mis-tag ADR 0012 made `Target` a discriminated union to prevent.

**Sky first, Lure never.** What `.out-of-scope/` said while this ADR was being
written, on the ground that nobody had asked. Somebody asked. That note is now
`.out-of-scope/virtual-theatre-non-dos-releases.md` and keeps only its platform
half.

**One "Virtual Theatre" engine with a per-game delta**, on the model of SCUMM's
Classic and Stack encodings sharing a base. Rejected: ADR 0022 governs what a
delta may know, and a delta that has to change the container, the index and the
instruction set is not a delta. It is two engines with an inheritance
relationship pretending to be one, and ADR 0007's test — do these "differ by
degree in a way one model can hold" — answers no.
