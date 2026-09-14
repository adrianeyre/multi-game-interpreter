# A SCI room is a view over a Script and the Picture it names, keyed by the Script

`docs/editor-parity.md` rows 5 to 8 ask a question SCUMM answers with one
resource. Open a SCUMM room and the objects are _in_ it: their positions, their
names and their scripts, in the file. Rows 5, 6, 7 and 8 — draw the room, outline
the things on it, drag one, drag its walk-to point — are all downstream of that
one fact, and until this decision the SCI column answered **No** to every one of
them with the same reason: "there is no canvas on this surface at all."

The reason there was no canvas is not that nobody had got round to it. It is
that **SCI has no room resource**, and so there was no obvious thing for a
canvas to be a canvas _of_. A SCI room is three things, and no single resource
holds them together:

- a **Script resource**, which defines a subclass of `Room` and the instances
  the room puts on screen;
- a **Picture**, named by a property on that room instance, living in its own
  resource, and shared with whatever other room cares to name it;
- a **cast assembled at run time**, by the room's own `init` calling `addToPic`
  and friends — on instances the script may never have declared statically at
  all.

ADR 0013's standard is the same capability in the family's own terms and never
a pretend SCUMM room. So the question is not "how do we make SCI look like
SCUMM" but "what, in SCI's own vocabulary, is the thing an author opens?"

## The decision

**A room is a `Script` resource that defines an instance whose class chain
reaches `Room`, and the editor's room surface is a derived view over that
script and the Picture its room instance names. It is keyed by the Script
number.**

Nothing is stored. `sciRooms(project)` derives the list on demand from
`SciProject`, and an edit writes back into the property words it came from —
the same two words the properties table on the Script surface already edits.
There is no room record, no room id, and no third resource.

Keyed by the **Script** because that is what SCI itself keys a room by. The
Kernel call is `NewRoom(n)` where `n` is a script number; the interpreter loads
that Script resource and asks _it_ what the room looks like. An author who
knows King's Quest VII knows its menu as script 30, and `rm30` is the name the
game itself recorded for the instance. Numbering rooms any other way would be
inventing a namespace the game does not have.

The base class is matched by **name** — `Room`, and `Rm` for the releases that
ship it under the shorter one — walked up the whole class chain rather than one
hop, because almost every SCI game subclasses `Room` once and hangs its rooms
off that. A one-hop test finds no rooms at all in such a game and every room in
a game that did not bother, which is the worst possible pair of answers.

## Two alternatives, and why each is worse

**The Picture is the room.** Tempting, because the Picture is the thing you can
see, and it is one resource with a number. It fails on both halves of the row
it would have to satisfy. A Picture holds no cast, so row 6 has nothing to
outline and row 7 nothing to drag — the capability would stop at row 5. And a
Picture is not one room: rooms share Pictures, and a Picture named by three
scripts would be three rooms wearing one face, with no way to say which cast
belonged to which. It also puts the Picture's own composition — the cel items
that rows 20 and 24 are about — in the same panel as the room's cast, which are
two different edits of two different resources.

**The Script alone is the room, with no art.** This is what the surface already
had: the class graph, the property words, and no picture of anything. It is
honest and it is not a room surface. Rows 5 to 8 are all about seeing where
something _is_, and a list of x and y words is exactly the thing those rows
exist to distinguish an editor from.

A third option — **import the run-time cast by running the room's `init`** —
was not rejected on principle and is not done. See below.

## What this view can see, and what it cannot

It reads the **authored** state: the property words as the resource ships them.
That is precisely the state an author can edit and an export can write back,
which is the only state an editor should claim to edit.

It cannot see the run-time cast. A SCI room commonly assigns its cast's
positions in `init` rather than declaring them, and where it does, this surface
draws the shipped default — which is the truth about the file and is **not**
where the thing appears when the game runs. King's Quest VII's own main menu is
the sharpest case available: all five of its buttons ship with `y` at nought and
are placed by script 30's `init`, so the room surface stacks them on the top
edge while the running game reads them as a centred column.

This is stated on the panel itself, every time, rather than being a footnote in
this file. An editor that draws a position without saying which position it is
has made a promise the file does not keep.

Running `init` to collect the real cast is the obvious next move and is
deliberately not taken here. It would mean the editor booting the PMachine to
show a room, which makes what an author sees depend on how far the interpreter
gets — a room that draws correctly today and wrongly after an unrelated Kernel
change, with no way for the author to tell which they are looking at. The
authored state has the opposite property: it is exactly as good as the file, and
it is the state the export writes. If the run-time cast is added later it should
be a **second, labelled** layer over this one, never a silent replacement for
it.

## What this decides for the rows

Rows 5, 6 and 7 become Yes, in the family's own terms: the Picture drawn from
the game's own art and palette, every instance that declares both an `x` and a
`y` outlined over it and hit-tested topmost-first, and a drag — mouse or
keyboard — that writes those two property words.

Row 8 stays **No**, and this ADR is why it is a different kind of No from the
other three. A SCUMM walk-to point is a field on the object; a SCI walk target
is a `Polygon` the room's script builds at run time, and there is no authored
word to drag. Rows 9, 11 and 20 stay No for the neighbouring reason: SCI16 keeps
where-you-may-walk as a colour in a vector Picture's control plane rather than
as a record, and SCI32 has no control plane at all.

Rows 14, 15, 18 and 19 stay No because they are about a _character's_ pane and a
frame strip, which is row 13's cast section — not yet written — rather than this
canvas.
