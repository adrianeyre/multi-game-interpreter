# Out of Order

SLUDGE — reads and disassembles; does not run here

Hurford Schlitzting is woken by a thunderstorm and finds that he — and his
entire bedroom — have been moved to somewhere called The Town, an alternate
future full of aliens. He explores it in a bathrobe and teddy-bear slippers,
trying to work out why he was taken.

Tim Furnish built it at Hungry Software as a commercial title and decided
shortly before release to give it away instead, to show off the engine he had
written for it. That engine is **SLUDGE**, started in 2000 for this game, later
released for free and open-sourced around 2010. So this is the game SLUDGE
exists because of, which is why it is the one title from that family with a
folder here.

## At a glance

|           |                                 |
| --------- | ------------------------------- |
| Developer | Tim Furnish                     |
| Publisher | Hungry Software                 |
| Released  | 2003                            |
| Platforms | Microsoft Windows, macOS, Linux |
| Genre     | 2D adventure                    |
| Engine    | SLUDGE                          |

## How it runs here

**It does not run.** This section is this repository's own status and not the
source's, per ADR 0031.

SLUDGE is a seventh Engine family with a **reader and no interpreter**. What is
built is the container reader — the header, its four indices and every resource
located — the compiled-function disassembler, and 42 generated command names.
What is not built is anything that executes an instruction.

So SLUDGE data is recognised and **refused by name** rather than run: it is
still in `src/engine/resource/engineSignatures.ts` and out of
`IMPLEMENTED_FAMILIES`. Dropping this game in will tell you which engine it
belongs to and that this project cannot yet play it. The bar for leaving that
table is having an interpreter's foundation, which five families crossed in
turn, and a reader is not one.

**`Completable` is not claimed**, for this title or any other in this
repository.

## Where it sits in this project

The reader was checked against **Above The Waves** rather than this game — a
different freeware SLUDGE title, chosen because it was to hand: 124 resources,
217 functions, 10,248 instructions, 24 distinct commands and none unnamed. Out
of Order has **not** been read here, so nothing on this page is evidence about
this game's bytes specifically.

The family is also deliberately **off the critical path**. Once the scope of
this work became the famous adventure engines, SLUDGE's argument — fourteen
freeware games for the least reference material in ScummVM — stopped buying
what that scope wants, because these are indie adventures rather than the
catalogue in question. The reader stands and nothing further is owed it. See
[`docs/scummvm-parity-roadmap.md`](../../docs/scummvm-parity-roadmap.md).

## No image beside this README

Every other game folder here carries an `image.jpg`, which ADR 0031 defines as
the cited article's lead image. That article's lead image is non-free
promotional artwork, and committing it into a GPL-licensed repository is a
licensing decision for the repository's owner rather than one to make in
passing — so this folder ships without one. `games/README.md` renders a folder
with no image perfectly well.

## Elsewhere

- [Out of Order on English Wikipedia](<https://en.wikipedia.org/wiki/Out_of_Order_(video_game)>) — the cited source for everything under **At a glance** and the summary above
- [The SLUDGE engine's own site](https://opensludge.github.io/) — the engine, and the other games on it
- [`docs/released-games.md`](../../docs/released-games.md) — what each Engine family here does with a game
- ScummVM's `sludge` engine is the reference this project reads the format against
