# A v7 game's text is imported as editable project content

ADR 0005 settled that an imported script is edited as instructions, 1:1, with
byte-identity as the property that makes editing safe. v7 keeps that — it is a
stack machine, so every instruction boundary is measurable — but it moves the
words somewhere the instructions cannot reach. Displayable text lives in an
external language bundle, `LANGUAGE.BND` in Full Throttle and `LANGUAGE.TAB` in
The Dig, and a script refers to a line by index. An author who opens a script to
change a line of dialogue, which is the likeliest edit anyone makes, would see a
number.

So the bundle is read at import and its strings become first-class Project
content, shown resolved where an instruction references them. The author edits
words. Export rewrites the bundle beside the patched container.

## Consequences

A v7 Project now holds three kinds of behaviour rather than two: instructions
for what was imported, `Action`s for what the author adds, and strings that
neither owns but both point at. The editor has to make an edited string's reach
obvious, because one string can be referenced from many scripts and changing it
changes all of them — which is a property Preserved bytes and `Action`s do not
have.

Export gains a file that is not the container. Until now "export an edited
game" meant rewriting one pair of files; for v7 it means rewriting a set, and a
language bundle that fails to write is a game full of missing dialogue rather
than a game that fails to load.

Rejected: showing the resolved string read-only and carrying the bundle through
as Preserved bytes, which is cheap and keeps byte-identity trivially but refuses
the single most obvious edit. Also rejected: leaving the raw index in the
listing, which undercuts why ADR 0005 chose instruction editing — that the
author wants to change part of existing behaviour while understanding it.
