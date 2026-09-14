# v6 scripts are edited as instructions, not as project actions

The editor edits behaviour as `Action`s — `say`, `walkTo`, `if` — because that
set was designed for authoring small games from nothing. Editing an imported v6
game is the opposite problem: the behaviour already exists, in thousands of
instructions written by somebody else, and the author wants to change part of it
without disturbing the rest.

So a v6 script is decompiled to a 1:1 instruction representation and edited at
that level, with the stack pushes folded into expressions for display
(`localvar1 = getObjectX(dollar)` rather than three separate stack operations).
v6's stack discipline makes every instruction boundary measurable, so a script
decoded and re-emitted untouched is byte-identical — which is the property that
makes editing safe at all.

Rejected: decompiling into project `Action`s. The `Action` set cannot express
arbitrary Day of the Tentacle scripts, so most scripts would fall back to
Preserved bytes anyway, and the ones that did map would re-emit as different
bytes than they arrived as — a silent behaviour change, which is exactly what
the importer's existing refusal to split scripts was protecting against.

## Consequences

Instruction editing is a new editor surface. `ActionEditor` edits `Action`s and
is not reusable for it. A v6 project therefore has two ways to hold behaviour —
instructions for what was imported, `Action`s for what the author adds — and the
editor has to make which is which obvious.
