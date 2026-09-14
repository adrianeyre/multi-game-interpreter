# SCUMM v0, v1 and the non-DOS releases

**Decision: not in scope.** Settled while scoping SCUMM v2–v8.

The SCUMM work covers **LucasArts' DOS releases of v2 through v8**. It does not
cover the 8-bit releases below v2, and it does not cover the ports of the games
it does cover. Two different reasons, and only the first of them is permanent.

## Releases that are not files

v0 and v1 — Maniac Mansion on C64 and Apple II, its NES port, Zak McKracken on
C64 and Apple II — ship as **disk images and a cartridge ROM**: D64, `.dsk`,
`.nes`. There is no index file and no room file, only sectors and banks where
Lucasfilm put them.

This project has declined that shape once already. `.out-of-scope/agi-booter-and-apple-ii.md`
refuses AGI's booter and Apple II releases because "a booter has **no
filesystem** … That is a disk format problem, and it has nothing to do with any
decision in ADR 0011, 0012 or 0013." The same sentence is true here, and the
rule is written once so that it covers every such release rather than a list of
version numbers: **a release this project reads is one whose resources are
files.**

That rule also catches two releases of Versions that _are_ in scope, which is
the reason it is worth stating as a rule at all — Loom on PC-Engine/TurboGrafx
and The Secret of Monkey Island on Sega CD are console CD images, and "v4 is
supported" must not be read as a claim about them.

**It buys almost no new content.** Both v1 titles have v2 DOS releases already in
scope, so v1 is a second way to load games that would already load. The one real
exception is **Maniac Mansion on NES**, which has rooms and art the DOS release
does not. If that is ever wanted it is wanted as itself — an NES ROM reader for
one title — and not as "v1 support".

**It is three problems, not one**, exactly as the AGI note found: an image reader
per container, the v0/v1 opcode tables, and C64 graphics and SID sound, none of
which is shared with anything else here.

## Ports of games that are in scope

FM Towns (Zak, Indy 3, Loom), Amiga, Atari ST and Macintosh releases **are**
file-based, so the rule above does not exclude them. They are excluded for the
ordinary reason instead: they are not the release the work is verified against,
and each one changes graphics, sound or both — FM Towns is 256-colour with its
own audio, Amiga has its own palette handling.

There is no SCUMM platform handling in the codebase at all today: `BitmapCodec.ts`
mentions EGA and Amiga in a comment and nothing reads a platform anywhere. Adding
it means widening the SCUMM arm of `Target` the way AGI's already carries a
platform (`target.ts`), which is a real change to a value ADR 0012 deliberately
kept asymmetric.

**Deferred, not refused.** A DOS release of every in-scope title exists, so
nothing is unreachable without this.

## Humongous Entertainment

Recorded separately, in `.out-of-scope/humongous-entertainment.md`.

## What would change this

For the 8-bit releases: a concrete want for Maniac Mansion NES specifically, as
its own piece of work with its own container reader.

For the ports: a title whose DOS release is missing or broken in a way its port
is not, or a decision that the SCUMM arm of `Target` should carry a platform for
reasons of its own.
