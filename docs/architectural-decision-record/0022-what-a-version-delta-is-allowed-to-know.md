# What a Version delta is allowed to know

> **Renumbered from 0015.** Two ADRs were written the same day and both took
> that number: this one, and the SCI family decision that is now the only 0015. Every "ADR 0015" in the code and the tests means the SCI one, so this
> is the record that moved. Nothing about the decision below changed.

ADR 0014 settled the shape: two encodings, two abstract bases, seven deltas. It
left three questions to be answered with the tables in hand rather than up
front. Writing the tables answered them, and the answers are the same answer
three times.

## v2 does not subclass v3

ADR 0014 and #203 both left this open: v2's delta "may read better as a subclass
of the v3 delta than as a fourth flat sibling", and the ADR asked for the
reasoning to be recorded either way.

It is a flat sibling, and the table is why. v2 shares v3's _encoding_ — operand
modes packed into the opcode byte — and almost none of its _numbering_. Sixteen
of v2's opcodes are object-state instructions with the state baked into the
number, where v4 spends two numbers and an operand. Its bit variables are
instructions rather than an address space. Several of its sub-opcode streams are
fixed records where v3's are terminated by 0xFF. A subclass would inherit a
table it then overwrote in nearly every entry, which is not reuse — it is
inheritance used as a way of not writing something down.

And it would carry every later v3 correction into v2 unasked. That is exactly
the shape ADR 0006 refused for v7-over-v6, for exactly the same reason: the
Version being extended is the one with real games behind it, and the Version
doing the extending is the one nobody has played through.

So `installOpcodes` in `v2/ScriptEngine.ts` calls neither shared installer. A v2
script reaching an instruction v2 does not have is reported as such rather than
run as v5's.

## Two shared installers, not one

The Classic base ends up with `installClassicSharedOpcodes` — the instructions
v2 through v5 share at the numbers they share — and `installPreV5Opcodes` —
everything v2, v3 and v4 have and v5 does not.

The second one is the interesting decision. It would have been easier to leave
those in v4 and let v3 duplicate them. The reason not to is that they are not
"v4's opcodes": `ifState`, `pickupObject`'s single-operand form and
`saveLoadVars` belong to an era rather than to a Version, and a Version that
listed them again would be asserting they are its own. Putting the boundary at
the era makes v4 shrink to the two facts only v4 knows, which is what a delta
should be.

What is _not_ in either installer is anything a later Version renumbered.
`getAnimCounter` at 0x22 is v5's alone, because v3 and v4 put `saveLoadGame`
there — and a shared binding would not fail, it would run the wrong instruction
and consume the wrong number of bytes after it.

## A delta answers questions; it does not branch on itself

Three seams came out of writing four Classic tables, and each replaced a
scattering of version checks with one question the base asks:

- **`fetchVarRef`** — how wide a variable reference is. One byte at v2 and two
  from v3 on, with no indexed form at v2. It reaches every comparison, every
  getter's destination and every operand whose mode bit is set.
- **`actorOpFor`** — which numbering an `actorOps` sub-opcode uses. v2, v3 and
  v4 run theirs through a conversion table, and it has to be applied _before_
  the switch because the numbers disagree about operand counts.
- **`classicVersion`** — for the handful of shared instructions that read a
  different _number_ of operands: `actorOps` scale, two `roomOps` forms, and
  `roomOps`'s operands coming before its sub-opcode at v3 and after it
  everywhere else.

Every one of those is a desync rather than a wrong value. That is the test for
whether something belongs in a seam: if getting it wrong misreads the _next_
instruction, the base has to ask, because a Version that quietly disagreed would
not fail anywhere near the disagreement.

## v8 is a renumbering, and one width

On the Stack side the same principle produced a smaller answer than expected.
118 of v8's 142 opcodes are instructions v6 already has, at different numbers,
and 24 are v8's own. So `v8/ScriptEngine.ts` installs the shared table and then
_moves_ it, from a correspondence read off ScummVM's two `setupOpcodes` tables
by matching handler names.

The other half is one line: `fetchScriptWord` returns `fetchScriptDWord` at v8,
so every shared instruction that reads an immediate reads four bytes rather than
two. One override rather than a hundred.

The reader carries a **second copy** of that correspondence rather than
importing the interpreter's. A reader and a runner that disagreed about which
instruction a byte is would produce an edit that re-emits as something else,
which is the one failure the whole editing model exists to prevent — and two
tables can be diffed against each other, where one table shared between them
cannot be checked against anything.

## Consequence

A Version delta is a table plus answers. It is not a place to put behaviour, and
it is not a base class for the Version after it. Where a Version genuinely needs
different behaviour in shared code — and four of them do — the base asks a
question the Version answers, and the question is named after what it is asking
rather than after who is asking.
