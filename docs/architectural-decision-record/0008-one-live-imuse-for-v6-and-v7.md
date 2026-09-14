# One live iMUSE sequencer, serving v6 and v7

v6 music is rendered to samples up front and played, which is why the README
records iMUSE sequencing as not implemented: the commands that need a live
sequencer cannot be served by a finished buffer. That simplification cannot be
carried into v7. There the music _is_ digital audio — compressed streams inside
the `.BUN` bundles — and iMUSE's whole job is crossfading between musical
states as scripts ask for them. The Dig's score is a state machine, not a track
list, and there is nothing to render ahead of time.

So v7 forces a live sequencer, and rather than standing a second music path
beside the existing one, v6's is retrofitted onto it. One mechanism drives both:
v6 feeds it a synthesised OPL2 voice, v7 feeds it decoded bundle streams, and
the transition logic above that is shared. This closes a documented v6 gap as a
side effect rather than leaving two half-answers to the same question.

## One sequencer, two command decoders

What is shared is the sequencer and the transitions above it, not the commands
that reach it. v6 and v7 use the same opcode — `soundKludge` — and nothing else
about it: v6 packs a scope byte and a command byte into its first argument and
addresses a MIDI player, while v7's first argument is a single sixteen-bit
iMUSE **Digital** command with its own numbering, its own parameter IDs and its
own mixer groups.

So the decoder is per version even though the sequencer is not. Reading one
numbering through the other's decoder is not a near miss that plays the wrong
music: The Dig's `0x1000`, "set the musical state", came through v6's split as
"command 0, scope 16" and was reported unimplemented for the whole of v7, so no
amount of work on a scope-16 branch would ever have found it.

## Consequences

This rewrites audio that currently works. Day of the Tentacle and Sam & Max
both have music today, and "the music still plays, in the right places, at the
right volume" is not something the test suite can assert about a synthesised
score. Characterisation cover for the current v6 behaviour lands as its own
change before the sequencer replaces it, and the demos are re-checked at Tier 2
afterwards.

Rejected: a v7-only live mixer with v6 left alone, which is smaller and safer
but leaves two music systems for one concept and the v6 gap permanently open.
Also rejected: treating v7 iMUSE commands as start and stop on a cue, which
plays the right music with the wrong transitions — hard cuts through a score
written to crossfade. The project's habit is to label what it cannot do
faithfully, as it does with scores that shipped without an AdLib arrangement,
rather than to approximate it silently.
