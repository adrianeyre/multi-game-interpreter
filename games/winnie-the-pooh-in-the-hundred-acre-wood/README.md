# Winnie the Pooh in the Hundred Acre Wood

AGI v2

![Box art](image.jpg)

**Sierra On-Line, 1984.** Winnie the Pooh in the Hundred Acre Wood is a single
player adventure game created by Al Lowe for Sierra On-Line, originally
released in 1984 for the Commodore 64 and Apple II. It is based on Disney's
Winnie the Pooh franchise.

## At a glance

|               |                                                                        |
| ------------- | ---------------------------------------------------------------------- |
| **Developer** | Sierra On-Line                                                         |
| **Publisher** | NA, Sierra On-Line, EU, U.S. Gold                                      |
| **Designer**  | Al Lowe                                                                |
| **Artist**    | Mark Crowe, Doug MacNeill, Jennifer Nelsen, Terry Pierce               |
| **Series**    | Winnie the Pooh                                                        |
| **Platforms** | Apple II, Commodore 64, MS-DOS, Atari ST, Amiga, TRS-80 Color Computer |
| **Released**  | December 1984                                                          |
| **Genre**     | Adventure                                                              |
| **Modes**     | Single-player                                                          |

## How it runs here

**AGI v2 is supported.** The resource layer, the vector Picture renderer with
both buffers and the priority bands, View cels, the Logic interpreter with all
183 action and 20 test commands, `WORDS.TOK` and the parser, `OBJECT` and
inventory, four-voice sound and saves all run.

**No AGI game has been played through here.** Everything above is tested
against the synthetic fixture in `tests/fixtureAgi.ts`, so this game is worth
trying rather than relied upon.

How the bytecode decodes depends on the build of Sierra's interpreter a copy
shipped against, not on the AGI major version. A copy carrying `AGIDATA.OVL` is
read rather than assumed; one that does not still plays, on a documented
default with the fallback logged, and is refused for editing (ADR 0013).

## Where it sits in this project

`docs/released-games.md` lists this title under **AGI v2**. That page is the
scope statement for the whole catalogue and says, per Engine family and per
Version, what has actually been run rather than what is implemented —
**Completable** (`CONTEXT.md`) is claimed for no title on it.

## Elsewhere

- [Wikipedia: Winnie the Pooh in the Hundred Acre Wood](https://en.wikipedia.org/wiki/Winnie_the_Pooh_in_the_Hundred_Acre_Wood)
- [`docs/released-games.md`](../../docs/released-games.md) — the full scope list
- [ScummVM](https://www.scummvm.org/) — the reference implementation this project checks itself against
