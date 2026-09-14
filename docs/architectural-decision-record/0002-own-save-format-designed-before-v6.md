# Saved games use our own format, and land before the v6 script engine

"Completable" is the bar for Day of the Tentacle and Sam & Max, and neither is
completable in one sitting, so the engine needs saved games — which it has none
of today. Two decisions follow.

The state format is ours, not ScummVM's `.s01`. Reading ScummVM's saves would
buy interoperability at the price of pinning our internal state layout to the
field order of another project's C++ structs, permanently, including for the v5
games that already work.

Saving lands before the v6 script engine, not after. Script slot state and the
cutscene stack are exactly what a save has to capture, and they are also what
the second script engine forces us to extract from `ScriptEngine`. Designing the
state format once, against one engine, is cheaper and less error-prone than
retrofitting it onto two.

## Consequences

Saves are version-tagged and specific to this interpreter. A save made in a v5
game cannot be loaded by ScummVM, and vice versa, and we are not going to
pretend otherwise in the UI.
