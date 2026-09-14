# SCI has one instruction encoding, and SCI3 rode on an assumption now checked

> **Amended by #214.** The assumption below was checked against ScummVM's
> source and **holds**. All three questions are answered in "What the check
> found"; the assumption text is kept rather than deleted, because the
> falsification test is still the thing that would reopen this and a reader
> needs to see what was asked as well as what came back.

ADR 0014 settled that SCUMM has two encodings across seven Versions rather than
seven, and ADR 0012 generalised the rule: one Script engine per encoding, not per
Target. SCI takes that rule as far as it goes — **one encoding, one Script
engine, SCI0 to SCI3** — which is a wider sharing claim over a wider range than
SCUMM makes, and it should be read with the caveat at the bottom attached.

## Why one

`CONTEXT.md` distinguishes an encoding by how instruction length is determined;
that is what separates the Classic encoding from the Stack encoding. By that
test SCI has one. Every Version takes length from the low bit of the opcode
byte, which selects 8-bit or 16-bit operands.

What varies across the family varies **outside** the instruction table:

- **The Kernel table** — which number means `DrawPic`. Moves at nearly every
  Version seam, and is the reason ADR 0016 puts a Version on the Target.
- **The object layout** — SCI0 and SCI1 carry object data inline in a Script
  resource with a relocation list; SCI1.1 splits it into a code and heap pair;
  SCI3 changes it again.
- **A handful of SCI3 opcode reassignments**, carried as a per-Version delta the
  way ADR 0006 has each Stack Version install its own.

Naming it the **PMachine encoding** takes Sierra's own word for the VM rather
than inventing one, and avoids "the SCI encoding", where the family name adds
nothing because there is only one.

## The part that is an assumption

**Nobody has read SCI3's opcode table.** This ADR was written without a ScummVM
checkout to hand, and Lighthouse and RAMA are the least-documented corner of the
family. Asserting a table here would be precisely the confident misreading
`docs/processes/verifying-version-support.md` exists to guard against, so the
claim is recorded as an assumption with its falsification test attached.

One thing is already accounted for and is worth stating so it is not
mis-taken as evidence against: **SCI3's object-layout change does not threaten
this ADR.** Object layout is named above as varying outside the encoding. It
costs a different reader of the Script resource, not a different decoder of
instructions.

Three questions would settle it, and any one of them going the wrong way makes
SCI3 a second encoding:

1. Does instruction length still come from the low bit of the opcode byte for
   **every** SCI3 opcode — no fixed-width exceptions, no new prefix byte?
2. How many opcodes change meaning between SCI2.1 and SCI3, measured against the
   v6→v8 deltas already in this repo?
3. Do any operands change **kind** — a relative offset becoming absolute, or the
   reverse?

The third matters most and is listed last because it is the one that hides. This
repo has been bitten by it twice: `jump` landing two bytes early in v6, and
recorded speech read eight bytes past its start in v7. Both passed their tests.

## Consequences

**The tripwire:** if SCI3's delta grows past the size of the v6→v8 deltas, SCI3
is a second encoding and this was decided wrongly. Splitting it then is a normal
outcome, not a failure — and it does not reopen ADR 0015, because the family
claim never rested on a single encoding.

Until questions 1–3 are answered, SCI0 through SCI2.1 are decided and SCI3 is
provisional. An issue adding SCI3 support names this ADR and answers them first.

## What the check found (#214)

Read against ScummVM's `engines/sci/`. The evidence is also kept as data in
`src/engine/sci/sciVersion.ts` (`SCI3_ENCODING_EVIDENCE`), so a reader of the
code can find out why there is no second Script engine without leaving it.

**1. Length still comes from the low bit, for every opcode. Yes.**
`readPMachineInstruction` (`engine/vm.cpp` ~400-470) is one function for every
Version and contains no `getSciVersion()` call. The operand-width switch keys on
`extOpcode & 1` for the whole variable, property, local, temp, global, param and
offset group. No prefix byte, no fixed-width exception at SCI3.

**2. Two opcodes change meaning, against 142 for v6→v8.** `op_info` (0x26) and
`op_superP` (0x27) are "Dummy opcode" errors below `SCI_VERSION_3` and real
instructions at it (`vm.cpp` ~700-720); `op_super` (0x2b) additionally leaves
the superclass pointer in the accumulator at SCI3 only (~750). The comparison
the question asks for: `V8_FROM_V6` in `src/engine/script/v8/ScriptEngine.ts` is
118 renumbered opcodes plus 24 new ones, and every immediate widens from 16 bits
to 32 — and ADR 0014 still calls v6-v8 **one** encoding. Two reassignments is
an order of magnitude short of the tripwire.

**3. No operand changes kind. One operand changes resolution.** The question
that hides, and this is the answer that needed care. `findOffset` (`vm.cpp`
~472-498) switches on `detectLofsType()` and, for SCI3, resolves a `lofsa`/
`lofss` operand through the script's own relocation table
(`relocateOffsetSci3`) instead of adding a base. The operand is the same width,
read the same way, at the same place in the instruction; what differs is what
the _reader of the Script resource_ does with the value. And `detectLofsType`
already answers four different ways across SCI0 early, SCI1 middle, SCI1.1 and
SCI3 — so lofs resolution was never a property of the encoding.

**One caveat, recorded rather than smoothed over.** ScummVM carries a note on
that SCI3 case that the one-byte-argument variant of `lofs` may break. That is
the only place in the family where this project should expect to be wrong about
SCI3's encoding, and it is exactly the shape of the two faults this ADR names
(`jump` two bytes early in v6, speech eight bytes late in v7). It is checked
against real data before SCI3 is claimed, not before it is written.

**Also accounted for, and not evidence against.** SCI3's Script resource is a
22-byte fixed header with code, string and relocation offsets as 32-bit words at
0, 4 and 8; objects located arithmetically past a dword-aligned export table and
locals array; a 10-byte-entry relocation table; and no separate heap resource,
so a script may exceed 64K (`engine/script.cpp`). That is object layout, which
this ADR names as varying outside the encoding — it costs a different reader,
exactly as SCI1.1's heap split did.

**Verdict: confirmed.** SCI3 is a per-Version delta on one PMachine, and #229
is the cheap shape rather than the expensive one.
