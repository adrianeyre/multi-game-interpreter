/**
 * The VGA opcode slots the reference leaves **without a handler**, per Version.
 *
 * `vgaOpcodeTables.ts` is generated from ScummVM's *name* table, and a name
 * table names every slot — including ones no game's interpreter ever assigned a
 * routine to. Elvira 1's table says `ON_STOP`, `TEST_STOP`, `VC_36` … `VC_55`,
 * but `AGOSEngine_Elvira1::setupVideoOpcodes` (`vga.cpp`) leaves those slots
 * NULL, and `runVgaScript` treats reaching one as a fatal "Invalid VGA opcode".
 * A name with no behaviour behind it in the reference is not work outstanding
 * here: there is nothing to implement *from*, and inventing behaviour for it
 * would be a guess wearing an opcode's name.
 *
 * So this list is the other half of the coverage figure's honesty. An opcode in
 * it is left out of a Version's total rather than counted as missing, and the
 * machine reports reaching one by saying so ("no handler in the reference")
 * rather than as an ordinary gap — reaching one means a script and a Version
 * disagree, which is a different finding from "not written yet".
 *
 * ## How each list was derived
 *
 * By walking the reference's `setupVideoOpcodes` chain for each engine class
 * and listing the slots no link assigns. The chains are not the class
 * hierarchy, which is the trap: `AGOSEngine_Simon1` derives from Waxworks but
 * calls the **base** `AGOSEngine::setupVideoOpcodes`, skipping Elvira 2's and
 * Waxworks' additions — so Simon 1 has no `vc19_loop`, `vc28_playSFX` or
 * `vc57_blackPalette` even though its name table spells those slots.
 *
 * - base `AGOSEngine`: 1–10, 12–16, 18, 20, 21, 23–27, 29–31, 33–36, 38–47,
 *   49–52, 55
 * - Elvira 1: its own list, not chained — 1–10, 13–35, 38, 40, 41, 51–54, 56
 * - Elvira 2: base + 17, 19, 22, 28, 32, 37, 45–48, 53, 54, 56–59
 * - Waxworks: Elvira 2 + 58, 60–63
 * - Simon 1: base + 11, 17, 22, 32, 37, 48, 59–63
 * - Simon 2: Simon 1 + 56, 58, 59, 64–74
 * - The Feeble Files (and the Puzzle Pack, which does not override it): Simon 2
 *   + 75–84
 *
 * Slot 0 is the terminator in every Version and is handled by the run loop.
 *
 * Two findings worth stating because a name suggests otherwise: `ON_STOP`
 * (`vc11_onStop`) is assigned only in Personal Nightmare, which this family
 * does not run, so it is unassigned in Elvira 2 and Waxworks too; and
 * `PAN_SFX` (slot 53 in AGOS 2) is assigned by no link of the Feeble chain.
 */
export const VGA_REFERENCE_UNASSIGNED: Readonly<Record<string, readonly number[]>> = {
  elvira1: [11, 12, 36, 37, 39, 42, 43, 44, 45, 46, 47, 48, 49, 50, 55],
  elvira2: [11, 60, 61, 62, 63],
  waxworks: [11],
  simon1: [19, 28, 53, 54, 56, 57, 58],
  simon2: [19, 28, 53, 54, 57],
  feeblefiles: [19, 28, 53, 54, 57],
  puzzlepack: [19, 28, 53, 54, 57],
};

/** Whether the reference gives a Version's opcode slot a handler at all. */
export function vgaReferenceHasHandler(table: string, opcode: number): boolean {
  return !(VGA_REFERENCE_UNASSIGNED[table]?.includes(opcode) ?? false);
}
