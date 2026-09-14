# Issue lifecycle

How an issue gets from "somebody noticed something" to "an agent or a human can
pick it up and finish it". Every issue carries **exactly one category label** and
**exactly one state label**; anything else is a triage bug in itself.

## Labels

### Category — what kind of thing this is

| Label         | Meaning                    |
| ------------- | -------------------------- |
| `bug`         | Something is broken        |
| `enhancement` | New feature or improvement |

### State — where it is in the machine

| Label             | Meaning                                               |
| ----------------- | ----------------------------------------------------- |
| `needs-triage`    | Nobody has evaluated it yet                           |
| `classified`      | Marker: been through Pass 1, awaiting the deep pass   |
| `needs-info`      | Waiting on the reporter; the question is on the issue |
| `ready-for-agent` | Fully specified, agent brief attached                 |
| `ready-for-human` | Ready to build, but needs a person                    |
| `wontfix`         | Will not be actioned (closed)                         |

### Target — which Engine family and Version the work is for

`v6` for anything adding or fixing SCUMM v6 support (Day of the Tentacle, Sam &
Max), `v7` for SCUMM v7 (Full Throttle, The Dig), `AGI` for Sierra's AGI family
(King's Quest 1–3, Space Quest 1–2, Leisure Suit Larry 1, Police Quest 1) — in
the engine or the editor either way, `sci0`–`sci3` for the SCI Versions, and
`AGOS` for Adventure Soft's family (Elvira 1–2, Waxworks, Simon the Sorcerer 1–2,
The Feeble Files, the Puzzle Pack). Target labels are an extra axis, not a
replacement for the category and state labels: an issue still carries exactly
one of each of those.

The SCUMM labels are bare numbers because they predate AGI. Nothing new should
be: a bare "v3" names both SCUMM v3 and AGI v3, which are unrelated engines
(ADR 0012).

### Area — which part of the system

`area:editor` (the in-browser authoring editor), `area:engine` (any Engine
family's interpreter and renderer). Add one when it is clear; leave it off when
it is not.

### PRD — which body of work this belongs to

A `prd:*` label groups every issue that makes up one large, pre-designed piece of
work, so the set can be listed, scheduled and closed as a unit. `prd:agos` is the
first: the AGOS family, designed in ADRs 0027–0030 before any of it was built.

A PRD label is an extra axis like a Target label — it replaces neither the
category nor the state label, and it says nothing about readiness. An issue
carrying one is still ready only when it carries a queue label.

### Queue — which run picks it up

A queue label is both "this is ready" and "this is where it goes". Applying one
is what actually schedules the work.

| Label             | For                                               |
| ----------------- | ------------------------------------------------- |
| `bugs-for-agent`  | A triaged bug                                     |
| `ready-for-agent` | A triaged enhancement, or ready for any AFK agent |

The run that picks them up is a Sandcastle run —
[`running-sandcastle.md`](running-sandcastle.md) says how to set one up and what
its prompt has to tell the agent.

## Triage — the two passes

Triage is deliberately two passes, because the two jobs need different amounts
of thought and it is wasteful to spend the second on an issue that has not had
the first.

### Pass 1 — bulk classify

A sweep over the raw pile. For each issue: check it is real, give it a title that
says what is wrong, apply the category and any `area:*` label, and add
**`classified`** while leaving `needs-triage` in place.

Pass 1 does **not** write acceptance criteria or decide how the work gets done.

### Pass 2 — deep triage

The pass that **makes an issue ready**. Its input is the classified backlog:
issues with **both** `needs-triage` and `classified`. An issue with
`needs-triage` but no `classified` has not had Pass 1 yet — send it there rather
than triaging it raw.

Pass 2, per issue:

1. **Gather context** — read the issue and its comments, and explore the code in
   the area. Check two things before anything else: is this **already
   implemented**, and has it been **rejected before**?
2. **Verify the claim** — for a bug, reproduce it. For a PR, check out the diff
   and run the relevant tests. Report what happened: confirmed, failed, or not
   enough detail. **A verified reproduction is what makes the brief worth
   trusting**; "could not reproduce" is a strong `needs-info` signal and a
   perfectly good outcome.
3. **Grill the gaps** — resolve genuinely ambiguous requirements _with the
   maintainer_. Do not guess and do not paper over.
4. **Apply the outcome** (below).

## Outcomes

**Ready for work.** Post an agent brief — current behaviour, desired behaviour,
key interfaces, checkbox acceptance criteria, and an explicit **out of scope**
list. Then make the label transition: **remove `needs-triage` and `classified`**
and add the queue label (`bugs-for-agent` for a bug,
`ready-for-agent` for an enhancement, unless told otherwise). Confirm the
`area:*` label is present.

`ready-for-human` takes the same brief, plus a line on why it cannot be
delegated: a judgment call, external access, a design decision, or manual
testing.

**Needs info.** Post triage notes with what has been **established** so far —
everything learned during verification, so the work is not lost if somebody else
picks it up — and a short list of **specific, answerable** questions. Not
"please provide more info". Add `needs-info`, remove `needs-triage`. Do not add a
queue label: the issue is not ready.

**Wontfix.** Close it, and let the reason pick the comment:

- **Already implemented** — say where the behaviour lives. Nothing is written to
  `.out-of-scope/`; that record is for what was rejected, not for what was built.
- **Rejected enhancement** — write it up in `.out-of-scope/<concept>.md` with the
  decision, the reasoning, and the issues that asked for it, then link to that
  file from the closing comment. The next person to ask gets an answer instead of
  a re-litigation.
- **Rejected bug** — a plain explanation, then close.

## Transitions

```
(unlabelled) ──► needs-triage ──► needs-triage + classified
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
               needs-info      queue label (ready)          wontfix
                    │            ready-for-human            (closed)
                    └──► back to needs-triage
                         once the reporter replies
```

The maintainer can override any of this at any point. Flag a transition that
looks unusual and ask before making it.

## Two standing rules

**A QA report enters one step ahead.** A report filed through a QA session
arrives already named and classified, so it is filed with `needs-triage` +
`classified` and skips Pass 1. It is still a **bug report, not a build spec** —
no acceptance criteria, no scope boundaries. Writing those is Pass 2's job, and
a report should not be quietly promoted into a specification.

**Anything written by an AI says so.** Every comment or issue an AI posts during
triage opens with:

```
> *This was generated by AI during triage.*
```
