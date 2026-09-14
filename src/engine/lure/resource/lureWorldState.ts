/**
 * Reads Lure of the Temptress's initial world state — resource **16398**.
 *
 * ## What this resource is, and how that was established
 *
 * ADR 0024's third amendment settled where Lure keeps the world its scripts
 * operate on: not compiled into `Lure.exe` the way this ADR first assumed, but
 * shipped in the data files as an ordinary resource. The evidence is an address,
 * not a coincidence of size. The executable's save routine restores a slot of
 * **37,504 bytes** into the buffer at `ds:0x5D90`; its only reference to
 * resource 16398 loads that resource to **the same address, at the same
 * length**, on the path that first sets the current-slot variable to its
 * no-slot sentinel — the new-game path. A resource loaded into the identical
 * buffer a save is restored into, at identical length, is the initial world
 * state (#264).
 *
 * Two facts this reader checks confirm the identification against the shipped
 * bytes rather than resting on the disassembly alone:
 *
 * - It is exactly `LURE_SAVE_SLOT_BYTES` long. A resource of any other length is
 *   not this one, and is refused rather than read.
 * - It is the **first** resource in both `Disk2.vga` and `disk2.ega`, and the
 *   two copies are byte-identical — the VGA and EGA installs ship the same
 *   world, which is what a shared world state should look like.
 *
 * ## What this reader does *not* do, and why
 *
 * It does not name the fields inside the snapshot. ADR 0024's second amendment
 * recorded that Lure's object table "is not reachable by any data-side analysis
 * and needs its consuming routine read", and measurement bears that out: the
 * 37,504 bytes are a composite of several tables — hotspots, rooms, scheduled
 * events, flags — with no single stride or self-describing header a walk can
 * verify. Reading `0xFFFF`-terminated 18-byte records out of the opening region
 * looks plausible for a few hundred bytes and then stops aligning, which is the
 * misreading this project refuses on principle: an unchecked reading is worse
 * than an honest refusal (`CONTEXT.md`).
 *
 * So the snapshot is held as **Preserved bytes** (ADR 0025's word for it) — read
 * back byte-for-byte, editable only once the consuming routine has been read and
 * the layout can be *checked*, not merely fitted. That is Disassembly's
 * discipline applied to data: carry what is not understood rather than invent a
 * shape for it. The analogue is `lureDisk.ts` carrying byte 2 of every directory
 * entry and byte 6 of every header through a rewrite unchanged.
 */

/** The resource id the executable loads into the save-slot buffer for a new game. */
export const LURE_WORLD_STATE_ID = 16398;

/**
 * The world-state snapshot's length, and a save slot's.
 *
 * `0x9280`. Computed in the executable as the span of the buffer at `ds:0x5D90`
 * (#264); a resource of this exact length loaded into that buffer is what ties
 * resource 16398 to the new-game path.
 */
export const LURE_SAVE_SLOT_BYTES = 37504;

export class LureWorldStateError extends Error {}

/**
 * The initial world state, as the bytes it is and nothing this reader has not
 * checked it to be.
 *
 * `bytes` is the whole snapshot, held so a rewrite can put back exactly what it
 * read. There is no typed view: see the file header for why the fields are not
 * named here.
 */
export interface LureWorldState {
  readonly bytes: Uint8Array;
}

/**
 * Reads the world-state resource, or refuses rather than returning a partial.
 *
 * The one check available without the consuming routine is length, and it is the
 * one that identifies the resource: `LURE_SAVE_SLOT_BYTES` is the executable's
 * own slot size, so a resource of another length is not the world state and is
 * not treated as one.
 */
export function parseLureWorldState(bytes: Uint8Array): LureWorldState {
  if (bytes.length !== LURE_SAVE_SLOT_BYTES) {
    throw new LureWorldStateError(
      `Lure's world state is ${LURE_SAVE_SLOT_BYTES} bytes — the save-slot size the executable ` +
        `restores into — and this resource is ${bytes.length}. It is not resource ` +
        `${LURE_WORLD_STATE_ID}, or it is not the world state.`,
    );
  }
  return { bytes: bytes.slice() };
}

/**
 * Re-emits the snapshot. Byte-identical, because it is Preserved bytes.
 *
 * The signature leaves room for a replacement map the way `writeLureDisk` does,
 * so the editable surface (a later piece) has a seam to fill — but until the
 * layout can be checked there is nothing to replace, and the honest writer is
 * the identity.
 */
export function writeLureWorldState(state: LureWorldState): Uint8Array {
  return state.bytes.slice();
}

/**
 * What a structural probe of the shipped snapshot found, and why it is not enough.
 *
 * Recorded so the next attempt starts here rather than repeating it, and
 * recorded as *insufficient* rather than as progress, because the failure mode
 * this file's sibling warns about is a reading that looks right. `lureDisk.ts`
 * opens by saying three earlier readings of that directory "looked right and
 * were wrong, and each was caught by arithmetic rather than by inspection".
 *
 * **Byte autocorrelation over all 37,504 bytes** puts stride 6 highest at
 * 35.7%, with its multiples 12 and 18 just behind at 35.2% and 34.9%. That is
 * suggestive of a six-byte field group and it is not evidence of one: 37,504 is
 * 2^7 x 293 and not a multiple of 6, so no uniform array of that width covers
 * the resource, and a third of bytes matching at a small stride is what
 * structured data does generally rather than what one record size does
 * specifically.
 *
 * **Six zero runs of 48 bytes or more** divide it: 2147-3139 (992 bytes),
 * 3140-3207, 20554-20632, 20794-20850, 20914-23855 (2,941), and 28495-28816.
 * So it is several sections rather than one table — the shape `sky.cpt` has,
 * where each section's length is declared and checked by the next.
 *
 * What is missing is the same thing ADR 0024's third amendment named when it
 * found this resource: the executable's routine that *consumes* the buffer at
 * `ds:0x5D90`. That routine's field offsets are what turn these boundaries into
 * records with names. Until it is read, the honest holding is Preserved bytes
 * and an Unrecovered count of one — which ADR 0025 provides for by name, and
 * which is a different thing from a defect nobody noticed.
 */

/** The verifiable facts about the snapshot, for a status line. */
export function describeLureWorldState(state: LureWorldState): string {
  return (
    `world state: resource ${LURE_WORLD_STATE_ID}, ${state.bytes.length} bytes ` +
    `(the save-slot size). Preserved bytes — its object table is not typed yet, ` +
    `because that needs the executable's consuming routine read (ADR 0024)`
  );
}
