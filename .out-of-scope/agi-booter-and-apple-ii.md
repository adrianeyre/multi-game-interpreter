# AGI booter, Apple II and pre-AGI releases

**Decision: not in scope.** Asked by #144, closed after deep triage.

The AGI work in #115 covers Sierra's DOS releases — the ones with `logdir`,
`picdir`, `viewdir` and `snddir` over `vol.n` files, or AGI v3's combined index.
It does not cover the earlier and stranger things that ScummVM's AGI engine also
handles.

## What was actually being asked for

#144 was filed believing "AGI v1" was one more instruction encoding, behind the
original CGA King's Quest 1 and 2. That was wrong, and the mistake is worth
recording because it is an easy one to repeat. ScummVM's `AgiGameType` has six
values, not three:

| Type           | What it is                                                                                    | ScummVM's own status                                                                            |
| -------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GType_PreAGI` | Troll's Tale, Winnie the Pooh, Mickey's Space Adventure                                       | A different engine sharing the directory                                                        |
| `GType_V1`     | DOS **self-booting floppy images** — King's Quest 2, Black Cauldron, Donald Duck's Playground | Mostly `ADGF_UNSTABLE`                                                                          |
| `GType_V2`     | The DOS games with `logdir`                                                                   | Supported                                                                                       |
| `GType_V3`     | The DOS games with a combined `*dir` and LZW volumes                                          | Supported                                                                                       |
| `GType_A2`     | **Apple II** disk images — King's Quest 2, Black Cauldron                                     | `ADGF_UNSTABLE`                                                                                 |
| `GType_GAL`    | Sierra's pre-AGI Graphic Adventure Language — early King's Quest 1                            | `ADGF_UNSUPPORTED`, with the message "Early King's Quest releases are not currently supported." |

So the request was really for three families, not one, and the one it named —
early King's Quest 1 — is the one nobody supports.

## Why it is declined

**Nothing in scope needs it.** Every title #115 names — King's Quest 1–3, Space
Quest 1–2, Leisure Suit Larry 1, Police Quest 1 — has a DOS release with a
`logdir`. `GType_V1` and `GType_A2` would add _booter and Apple II_ releases of
King's Quest 2 and Black Cauldron on top of games that already play. It is a
second way to load the same titles, not a way to load new ones.

**It is not the work it looks like.** The interesting part is not the opcode
table, though that differs too — 99 entries against 183, and `said` is encoded
as three fixed-arity forms rather than one count-prefixed variable one. The
interesting part is that a booter has **no filesystem**. `GAME` and `GAME3`
detect on a filename; `BOOTER` and `A2` detect on `"*"`, because there are no
files, just a raw disk image with sectors where Sierra put them. That is a disk
format problem, and it has nothing to do with any decision in ADR 0011, 0012 or 0013.

**It cannot be edited anyway.** ADR 0013 requires the Interpreter version to be
positively identified before a game is offered for editing, ideally by reading
the game's own `agidata.ovl` — which is the authoritative argument-count table.
A raw booter image has no `agidata.ovl` to read. So a booter would land on the
refuse-to-edit path by construction, and this project's whole reason for
implementing AGI is the editing half.

**Upstream has not finished it either.** Every `GType_V1` and `GType_A2` entry
except Donald Duck's Playground carries `ADGF_UNSTABLE`, and `GType_GAL` carries
`ADGF_UNSUPPORTED`. Following a reference implementation into its own
unfinished corners is a poor use of the effort.

## What would change this

A concrete want for a specific release that has no DOS equivalent. Black
Cauldron is the nearest candidate, since it is not on #115's list at all — but
it has a DOS AGI v3 release, so it belongs in the v3 work rather than here.

If it ever is wanted, it is three issues and not one: a disk-image reader, the
v1 opcode table and its `said` forms, and Apple II's own graphics and sound.
None of it shares code with the DOS path beyond the Logic interpreter.

## Asked by

- #144 — "AGI v1: the original CGA King's Quest 1 and 2 need their own script
  engine". Closed. The premise was wrong; the corrected facts are above.
