/**
 * The mcode table: the calls a Sky script makes out of the interpreter.
 *
 * A script's `call_mcode` carries a **byte** offset into this table, which the
 * game divides by four to get an index — the same unit change `push_variable`
 * makes for script variables, and worth stating in both places rather than
 * hidden in one expression.
 *
 * ## Why the names are here before the implementations are
 *
 * Because a report that says "mcode 63 is not implemented" costs a person a
 * search through somebody else's source, and one that says `fnRunFrames` does
 * not. `CONTEXT.md` gives the Unrecovered count a target of zero, and a count
 * is only useful if each entry says what is missing.
 *
 * That is the whole of what this file claims. **A name here is not a claim that
 * anything runs it** — `SkyInterpreter` reports every call it cannot make, by
 * name and by script offset, and the count is what a sweep prints.
 *
 * Transcribed from ScummVM's `Logic::_mcodeTable`, in its order, which is the
 * order the shipped bytecode indexes.
 */

/** 115 entries, in the order a script's byte offset indexes them. */
export const SKY_MCODES: readonly string[] = [
  'fnCacheChip',
  'fnCacheFast',
  'fnDrawScreen',
  'fnAr',
  'fnArAnimate',
  'fnIdle',
  'fnInteract',
  'fnStartSub',
  'fnTheyStartSub',
  'fnAssignBase',
  'fnDiskMouse',
  'fnNormalMouse',
  'fnBlankMouse',
  'fnCrossMouse',
  'fnCursorRight',
  'fnCursorLeft',
  'fnCursorDown',
  'fnOpenHand',
  'fnCloseHand',
  'fnGetTo',
  'fnSetToStand',
  'fnTurnTo',
  'fnArrived',
  'fnLeaving',
  'fnSetAlternate',
  'fnAltSetAlternate',
  'fnKillId',
  'fnNoHuman',
  'fnAddHuman',
  'fnAddButtons',
  'fnNoButtons',
  'fnSetStop',
  'fnClearStop',
  'fnPointerText',
  'fnQuit',
  'fnSpeakMe',
  'fnSpeakMeDir',
  'fnSpeakWait',
  'fnSpeakWaitDir',
  'fnChooser',
  'fnHighlight',
  'fnTextKill',
  'fnStopMode',
  'fnWeWait',
  'fnSendSync',
  'fnSendFastSync',
  'fnSendRequest',
  'fnClearRequest',
  'fnCheckRequest',
  'fnStartMenu',
  'fnUnhighlight',
  'fnFaceId',
  'fnForeground',
  'fnBackground',
  'fnNewBackground',
  'fnSort',
  'fnNoSpriteEngine',
  'fnNoSpritesA6',
  'fnResetId',
  'fnToggleGrid',
  'fnPause',
  'fnRunAnimMod',
  'fnSimpleMod',
  'fnRunFrames',
  'fnAwaitSync',
  'fnIncMegaSet',
  'fnDecMegaSet',
  'fnSetMegaSet',
  'fnMoveItems',
  'fnNewList',
  'fnAskThis',
  'fnRandom',
  'fnPersonHere',
  'fnToggleMouse',
  'fnMouseOn',
  'fnMouseOff',
  'fnFetchX',
  'fnFetchY',
  'fnTestList',
  'fnFetchPlace',
  'fnCustomJoey',
  'fnSetPalette',
  'fnTextModule',
  'fnChangeName',
  'fnMiniLoad',
  'fnFlushBuffers',
  'fnFlushChip',
  'fnSaveCoods',
  'fnPlotGrid',
  'fnRemoveGrid',
  'fnEyeball',
  'fnCursorUp',
  'fnLeaveSection',
  'fnEnterSection',
  'fnRestoreGame',
  'fnRestartGame',
  'fnNewSwingSeq',
  'fnWaitSwingEnd',
  'fnSkipIntroCode',
  'fnBlankScreen',
  'fnPrintCredit',
  'fnLookAt',
  'fnLincTextModule',
  'fnTextKill2',
  'fnSetFont',
  'fnStartFx',
  'fnStopFx',
  'fnStartMusic',
  'fnStopMusic',
  'fnFadeDown',
  'fnFadeUp',
  'fnQuitToDos',
  'fnPauseFx',
  'fnUnPauseFx',
  'fnPrintf',
];

/** A `call_mcode` operand is a byte offset into a table of pointers. */
export const SKY_MCODE_STRIDE = 4;

/**
 * Each mcode's number, by its name.
 *
 * Derived from the table rather than written out, and that is not tidiness: the
 * first version of `SkyWorld` hand-counted six of these and got **five of them
 * wrong** — `fnSkipIntroCode` off by one, and four of the fetches. Every one of
 * those would have been an mcode implemented under another mcode's number,
 * which is the failure this project's notes call the worst shape: it runs, and
 * it does the wrong thing somewhere else.
 *
 * A name is checkable by eye against ScummVM's table. A number is not.
 */
export const SKY_MCODE: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(SKY_MCODES.map((name, number) => [name, number])),
);

/** The name of an mcode, or a description of why there is not one. */
export function skyMcodeName(number: number): string {
  return (
    SKY_MCODES[number] ??
    `mcode ${number}, which is past the end of a ${SKY_MCODES.length}-entry table`
  );
}
