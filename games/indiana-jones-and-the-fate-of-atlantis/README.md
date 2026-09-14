# Indiana Jones and the Fate of Atlantis

SCUMM v5

![Box art: Indy and Sophia Hapgood over a diving bell, a camel chase and a
horned stone gargoyle](image.jpg)

LucasArts, 1992. A point-and-click graphic adventure, and the only Indiana
Jones game whose story was written for a game rather than adapted from a film — it is, in effect, the fourth Indy adventure, seven years
before the films came back to it.

Designed by **Hal Barwood** and **Noah Falstein**, who also wrote it; box art by
**William Eaken**; music sequenced through **iMUSE**, so the score follows what
the player does rather than looping under it.

## The release

The **Full Voice Talkie** — the CD-ROM release, every line recorded. The release
notes that shipped with it date the build **17 May 1993** and open:

> Indy Talkie is a game that takes full advantage of your CD-ROM by presenting
> the entire game with full speech and sound effects.

The floppy release of a year earlier is the same game with subtitles and no
recorded speech. Indy is voiced by **Doug Lee**, who kept the part through the
1990s LucasArts games.

## The story

It is 1939, and Indy is at Barnett College when a man calling himself Smith
turns up asking after a dig crate, steals a small statue with a bead of
**orichalcum** inside it, and turns out to be **Klaus Kerner** of the Nazi
party. What the bead is part of is Plato's account of Atlantis — not the famous
one, but the unfinished dialogue _Hermocrates_, in which the city is described
as real, as powered by orichalcum, and as still findable.

Indy goes after it with **Sophia Hapgood**, a former colleague who has given up
archaeology for the psychic lecture circuit and who knows more about Atlantis
than either of them is comfortable with. Against them is **Dr. Hans Übermann**,
who wants orichalcum as a power source for the coming war, and Kerner, who wants
it for himself.

The trail runs from New York to Iceland, the Azores, Algiers, Monte Carlo,
Knossos on Crete, and Thera — and then down, to a city that is exactly where
Plato said it was and rather less abandoned than advertised. The three stones —
**Sunstone**, **Moonstone**, **Worldstone** — are the keys to it, and the
machine at the centre of it is the thing Übermann has been reading about.

## Three ways through the middle of it

Partway in, once Indy and Sophia have worked out where they are going, the game
asks how you want to go on, and the middle act is a different game depending on
the answer:

- **Team.** Sophia comes with you. Puzzles are built around having two people in
  two places, and it is the path with the most dialogue.
- **Wits.** Indy goes alone, and the path is the hardest and longest set of
  puzzles in the game.
- **Fists.** Indy goes alone and punches his way through, with the most
  set-piece action and the fewest inventory puzzles.

All three converge before Atlantis. Finishing on one path unlocks nothing on
another, so the game is meant to be played through more than once — which was
unusual then and is unusual now.

## How it runs here

**SCUMM v5 is the version this project has played end to end**, which makes this
the game to reach for when something looks wrong elsewhere.

Two things to expect from this particular copy:

- **No speech from a re-compressed copy.** MGI reads the talkie's original
  speech layout — a `VCTL` header, mouth-sync cues, then a VOC. ScummVM's
  compressed re-encodings are not in that layout, so each line falls back to
  being timed by its length: subtitles, and the pacing the floppy release had.
  The original uncompressed speech turns it on.
- **Music that does not always follow.** Some iMUSE commands are not
  implemented yet; they are logged by name as they come up rather than passed
  over, so the log says which cue was missed.

## Elsewhere

- [Wikipedia: Indiana Jones and the Fate of Atlantis](https://en.wikipedia.org/wiki/Indiana_Jones_and_the_Fate_of_Atlantis)
