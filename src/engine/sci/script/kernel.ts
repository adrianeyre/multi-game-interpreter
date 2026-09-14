/**
 * The Kernel table: the one thing a SCI game does not carry the meaning of.
 *
 * A Kernel call is a call out of the PMachine into the interpreter itself —
 * drawing, sound, input, saving — numbered rather than named, and the table
 * those numbers index lives in Sierra's interpreter rather than in the game
 * from SCI1 on. That is the whole reason a SCI Target has to name a Version
 * (ADR 0016), and it is SCI's characteristic failure mode: a table off by one
 * entry produces a game that runs and does the wrong things, which Tier 1
 * cannot see.
 *
 * **Three tables, not thirteen.** #214 established this and it is what makes
 * the family affordable: SCI0 through SCI1.1 share 139 slots, SCI2 renumbers
 * into 160, SCI2.1 renumbers again into 162, and SCI3's entire delta is eleven
 * annotated slots inside SCI2.1's. Entries carry a Version range, exactly as
 * ScummVM's `SciKernelMapEntry` does, so an entry that does not move is
 * written once.
 *
 * Transcribed from `engines/sci/engine/kernel_tables.h`.
 */

import {
  atLeast,
  before,
  describeSciVersion,
  isSci16,
  selectorIdCarriesReadWriteBit,
  type SciVersion,
} from '../sciVersion.js';

/** An entry, and the Versions it applies at. */
export interface SciKernelEntry {
  name: string;
  /** Earliest Version this number means this, or undefined for "from the start". */
  from?: SciVersion;
  /** Latest Version, or undefined for "to the end of its table". */
  to?: SciVersion;
}

/**
 * `s_defaultKernelNames`: SCI0 through SCI1.1, 139 slots.
 *
 * SCI0's own table ends at `0x6d`; `0x6e` upwards are SCI1 and SCI1.1
 * additions. The dozen slots that are *reused* rather than appended carry a
 * second entry below with a Version range, and those are the ones a wrong
 * Version breaks silently — `0x71` in particular is three different calls.
 */
const SCI16_NAMES: readonly string[] = [
  'Load',
  'UnLoad',
  'ScriptID',
  'DisposeScript',
  'Clone',
  'DisposeClone',
  'IsObject',
  'RespondsTo',
  'DrawPic',
  'Show',
  'PicNotValid',
  'Animate',
  'SetNowSeen',
  'NumLoops',
  'NumCels',
  'CelWide',
  'CelHigh',
  'DrawCel',
  'AddToPic',
  'NewWindow',
  'GetPort',
  'SetPort',
  'DisposeWindow',
  'DrawControl',
  'HiliteControl',
  'EditControl',
  'TextSize',
  'Display',
  'GetEvent',
  'GlobalToLocal',
  'LocalToGlobal',
  'MapKeyToDir',
  'DrawMenuBar',
  'MenuSelect',
  'AddMenu',
  'DrawStatus',
  'Parse',
  'Said',
  'SetSynonyms',
  'HaveMouse',
  'SetCursor',
  'SaveGame',
  'RestoreGame',
  'RestartGame',
  'GameIsRestarting',
  'DoSound',
  'NewList',
  'DisposeList',
  'NewNode',
  'FirstNode',
  'LastNode',
  'EmptyList',
  'NextNode',
  'PrevNode',
  'NodeValue',
  'AddAfter',
  'AddToFront',
  'AddToEnd',
  'FindKey',
  'DeleteKey',
  'Random',
  'Abs',
  'Sqrt',
  'GetAngle',
  'GetDistance',
  'Wait',
  'GetTime',
  'StrEnd',
  'StrCat',
  'StrCmp',
  'StrLen',
  'StrCpy',
  'Format',
  'GetFarText',
  'ReadNumber',
  'BaseSetter',
  'DirLoop',
  'CanBeHere',
  'OnControl',
  'InitBresen',
  'DoBresen',
  'Platform',
  'SetJump',
  'SetDebug',
  'InspectObj',
  'ShowSends',
  'ShowObjs',
  'ShowFree',
  'MemoryInfo',
  'StackUsage',
  'Profiler',
  'GetMenu',
  'SetMenu',
  'GetSaveFiles',
  'GetCWD',
  'CheckFreeSpace',
  'ValidPath',
  'CoordPri',
  'StrAt',
  'DeviceInfo',
  'GetSaveDir',
  'CheckSaveGame',
  'ShakeScreen',
  'FlushResources',
  'SinMult',
  'CosMult',
  'SinDiv',
  'CosDiv',
  'Graph',
  'Joystick',
  // 0x6e onwards: SCI1 and SCI1.1.
  'ShiftScreen',
  'Palette',
  'MemorySegment',
  'Intersections',
  'Memory',
  'ListOps',
  'FileIO',
  'DoAudio',
  'DoSync',
  'AvoidPath',
  'Sort',
  'ATan',
  'Lock',
  'StrSplit',
  'GetMessage',
  'IsItSkip',
  'MergePoly',
  'ResCheck',
  'AssertPalette',
  'TextColors',
  'TextFonts',
  'Record',
  'PlayBack',
  'ShowMovie',
  'SetVideoMode',
  'SetQuitStr',
  'DbugStr',
  'Empty',
  'Empty',
];

/**
 * The slots that mean something different at some Versions.
 *
 * These are the whole of why a SCI Target names a Version, and the reason they
 * are listed separately rather than folded into the array is that the array
 * would then have to be duplicated per Version to express them. ScummVM's own
 * table solves it the same way — narrower ranges listed before broader ones.
 */
const SCI16_REUSED: ReadonlyArray<[number, SciKernelEntry]> = [
  [0x26, { name: 'Portrait', from: 'sci1-1' }],
  [0x4d, { name: 'CantBeHere', from: 'sci1-1' }],
  [0x51, { name: 'DoAvoider', to: 'sci01' }],
  [0x71, { name: 'MoveCursor', from: 'sci1-late', to: 'sci1-late' }],
  [0x71, { name: 'PalVary', from: 'sci1-1' }],
  [0x78, { name: 'StrSplit', from: 'sci01', to: 'sci01' }],
  [0x7c, { name: 'Message', from: 'sci1-1' }],
];

/**
 * `sci2_default_knames`: SCI2, 160 slots, 150 of them named.
 *
 * Renumbered wholesale rather than extended — the compositor's own calls sit at
 * numbers SCI16 used for something else.
 *
 * **Transcribed from ScummVM's `engines/sci/engine/kernel_tables.h`**, which is
 * the same route `compressionFor` took for the decompressors and which
 * `verifying-version-support.md` names as this project's Tier 3 reference. That
 * is what ADR 0020 asks for and the opposite of what it forbids: the ADR rules
 * out filling a table *from memory*, and this is read from a source that can be
 * cited, diffed and checked.
 *
 * It used to hold the nine entries this project had positive evidence for, and
 * everything else reported itself by number. That was the right failure while
 * the table was unread — and it is what stopped every SCI2 and SCI2.1 game:
 * `callk 0x0a` is `SetNowSeen` here and `Clone` at SCI2.1, and returning
 * nothing for it put a null where an object belonged.
 *
 * The ten `Dummy` slots are left unnamed deliberately. Sierra shipped them as
 * placeholders, so a game calling one is a misread instruction rather than a
 * feature, and naming them would hide that.
 */
const SCI2_NAMES: ReadonlyArray<[number, string]> = [
  [0x00, 'Load'],
  [0x01, 'UnLoad'],
  [0x02, 'ScriptID'],
  [0x03, 'DisposeScript'],
  [0x04, 'Lock'],
  [0x05, 'ResCheck'],
  [0x06, 'Purge'],
  [0x07, 'Clone'],
  [0x08, 'DisposeClone'],
  [0x09, 'RespondsTo'],
  [0x0a, 'SetNowSeen'],
  [0x0b, 'NumLoops'],
  [0x0c, 'NumCels'],
  [0x0d, 'CelWide'],
  [0x0e, 'CelHigh'],
  [0x0f, 'GetHighPlanePri'],
  [0x10, 'GetHighItemPri'],
  [0x11, 'ShakeScreen'],
  [0x12, 'OnMe'],
  [0x13, 'ShowMovie'],
  [0x14, 'SetVideoMode'],
  [0x15, 'AddScreenItem'],
  [0x16, 'DeleteScreenItem'],
  [0x17, 'UpdateScreenItem'],
  [0x18, 'FrameOut'],
  [0x19, 'AddPlane'],
  [0x1a, 'DeletePlane'],
  [0x1b, 'UpdatePlane'],
  [0x1c, 'RepaintPlane'],
  [0x1d, 'SetShowStyle'],
  [0x1e, 'ShowStylePercent'],
  [0x1f, 'SetScroll'],
  [0x20, 'AddMagnify'],
  [0x21, 'DeleteMagnify'],
  [0x22, 'IsHiRes'],
  [0x23, 'Graph'],
  [0x24, 'InvertRect'],
  [0x25, 'TextSize'],
  [0x26, 'Message'],
  [0x27, 'TextColors'],
  [0x28, 'TextFonts'],
  [0x2a, 'SetQuitStr'],
  [0x2b, 'EditText'],
  [0x2c, 'InputText'],
  [0x2d, 'CreateTextBitmap'],
  [0x2e, 'DisposeTextBitmap'],
  [0x2f, 'GetEvent'],
  [0x30, 'GlobalToLocal'],
  [0x31, 'LocalToGlobal'],
  [0x32, 'MapKeyToDir'],
  [0x33, 'HaveMouse'],
  [0x34, 'SetCursor'],
  [0x35, 'VibrateMouse'],
  [0x36, 'SaveGame'],
  [0x37, 'RestoreGame'],
  [0x38, 'RestartGame'],
  [0x39, 'GameIsRestarting'],
  [0x3a, 'MakeSaveCatName'],
  [0x3b, 'MakeSaveFileName'],
  [0x3c, 'GetSaveFiles'],
  [0x3d, 'GetSaveDir'],
  [0x3e, 'CheckSaveGame'],
  [0x3f, 'CheckFreeSpace'],
  [0x40, 'DoSound'],
  [0x41, 'DoAudio'],
  [0x42, 'DoSync'],
  [0x43, 'NewList'],
  [0x44, 'DisposeList'],
  [0x45, 'NewNode'],
  [0x46, 'FirstNode'],
  [0x47, 'LastNode'],
  [0x48, 'EmptyList'],
  [0x49, 'NextNode'],
  [0x4a, 'PrevNode'],
  [0x4b, 'NodeValue'],
  [0x4c, 'AddAfter'],
  [0x4d, 'AddToFront'],
  [0x4e, 'AddToEnd'],
  [0x51, 'FindKey'],
  [0x55, 'DeleteKey'],
  [0x58, 'ListAt'],
  [0x59, 'ListIndexOf'],
  [0x5a, 'ListEachElementDo'],
  [0x5b, 'ListFirstTrue'],
  [0x5c, 'ListAllTrue'],
  [0x5d, 'Random'],
  [0x5e, 'Abs'],
  [0x5f, 'Sqrt'],
  [0x60, 'GetAngle'],
  [0x61, 'GetDistance'],
  [0x62, 'ATan'],
  [0x63, 'SinMult'],
  [0x64, 'CosMult'],
  [0x65, 'SinDiv'],
  [0x66, 'CosDiv'],
  [0x67, 'GetTime'],
  [0x68, 'Platform'],
  [0x69, 'BaseSetter'],
  [0x6a, 'DirLoop'],
  [0x6b, 'CantBeHere'],
  [0x6c, 'InitBresen'],
  [0x6d, 'DoBresen'],
  [0x6e, 'SetJump'],
  [0x6f, 'AvoidPath'],
  [0x70, 'InPolygon'],
  [0x71, 'MergePoly'],
  [0x72, 'SetDebug'],
  [0x73, 'InspectObject'],
  [0x74, 'MemoryInfo'],
  [0x75, 'Profiler'],
  [0x76, 'Record'],
  [0x77, 'PlayBack'],
  [0x78, 'MonoOut'],
  [0x79, 'SetFatalStr'],
  [0x7a, 'GetCWD'],
  [0x7b, 'ValidPath'],
  [0x7c, 'FileIO'],
  [0x7e, 'DeviceInfo'],
  [0x7f, 'Palette'],
  [0x80, 'PalVary'],
  [0x81, 'PalCycle'],
  [0x82, 'Array'],
  [0x83, 'String'],
  [0x84, 'RemapColors'],
  [0x85, 'IntegrityChecking'],
  [0x86, 'CheckIntegrity'],
  [0x87, 'ObjectIntersect'],
  [0x88, 'MarkMemory'],
  [0x89, 'TextWidth'],
  [0x8a, 'PointSize'],
  [0x8b, 'AddLine'],
  [0x8c, 'DeleteLine'],
  [0x8d, 'UpdateLine'],
  [0x8e, 'AddPolygon'],
  [0x8f, 'DeletePolygon'],
  [0x90, 'UpdatePolygon'],
  [0x91, 'Bitmap'],
  [0x92, 'ScrollWindow'],
  [0x93, 'SetFontRes'],
  [0x94, 'MovePlaneItems'],
  [0x95, 'PreloadResource'],
  [0x97, 'ResourceTrack'],
  [0x98, 'CheckCDisc'],
  [0x99, 'GetSaveCDisc'],
  [0x9a, 'TestPoly'],
  [0x9b, 'WinHelp'],
  [0x9c, 'LoadChunk'],
  [0x9d, 'SetPalStyleRange'],
  [0x9e, 'AddPicAt'],
  [0x9f, 'MessageBox'],
];

/**
 * `sci21_default_knames`: SCI2.1 and SCI3, 162 slots, 129 of them named.
 *
 * SCI3's entire Kernel delta is here as per-slot annotations rather than a
 * fourth table: five entries stop at SCI2.1 late, and five are SCI3's own
 * (#214).
 *
 * **Transcribed from ScummVM's `engines/sci/engine/kernel_tables.h`**, as
 * `SCI2_NAMES` above is. The two tables differ from slot 7 onwards and that is
 * the point: 0x0a is `SetNowSeen` at SCI2 and `Clone` at SCI2.1, so a single
 * table would dispatch one of them wrongly in every game.
 *
 * The 33 `Dummy` slots are left unnamed for the same reason as SCI2's ten.
 */
const SCI21_NAMES: ReadonlyArray<[number, SciKernelEntry]> = [
  [0x00, { name: 'Load' }],
  [0x01, { name: 'UnLoad' }],
  [0x02, { name: 'ScriptID' }],
  [0x03, { name: 'DisposeScript' }],
  [0x04, { name: 'Lock' }],
  [0x05, { name: 'ResCheck' }],
  [0x06, { name: 'Purge' }],
  [0x07, { name: 'SetLanguage' }],
  [0x0a, { name: 'Clone' }],
  [0x0b, { name: 'DisposeClone' }],
  [0x0c, { name: 'RespondsTo' }],
  [0x0d, { name: 'FindSelector' }],
  [0x0e, { name: 'FindClass' }],
  [0x14, { name: 'SetNowSeen' }],
  [0x15, { name: 'NumLoops' }],
  [0x16, { name: 'NumCels' }],
  [0x17, { name: 'IsOnMe' }],
  [0x18, { name: 'AddMagnify' }],
  [0x19, { name: 'DeleteMagnify' }],
  [0x1a, { name: 'CelRect' }],
  [0x1b, { name: 'BaseLineSpan' }],
  [0x1c, { name: 'CelWide' }],
  [0x1d, { name: 'CelHigh' }],
  [0x1e, { name: 'AddScreenItem' }],
  [0x1f, { name: 'DeleteScreenItem' }],
  [0x20, { name: 'UpdateScreenItem' }],
  [0x21, { name: 'FrameOut' }],
  [0x22, { name: 'CelInfo' }],
  [0x23, { name: 'Bitmap' }],
  [0x24, { name: 'CelLink' }],
  [0x28, { name: 'AddPlane' }],
  [0x29, { name: 'DeletePlane' }],
  [0x2a, { name: 'UpdatePlane' }],
  [0x2b, { name: 'RepaintPlane' }],
  [0x2c, { name: 'GetHighPlanePri' }],
  [0x2d, { name: 'GetHighItemPri' }],
  [0x2e, { name: 'SetShowStyle' }],
  [0x2f, { name: 'ShowStylePercent' }],
  [0x30, { name: 'SetScroll', to: 'sci2-1-late' }],
  [0x31, { name: 'MovePlaneItems' }],
  [0x32, { name: 'ShakeScreen' }],
  [0x37, { name: 'IsHiRes' }],
  [0x38, { name: 'SetVideoMode' }],
  [0x39, { name: 'ShowMovie', to: 'sci2-1-late' }],
  [0x3a, { name: 'Robot' }],
  [0x3b, { name: 'CreateTextBitmap' }],
  [0x3c, { name: 'Random' }],
  [0x3d, { name: 'Abs' }],
  [0x3e, { name: 'Sqrt' }],
  [0x3f, { name: 'GetAngle' }],
  [0x40, { name: 'GetDistance' }],
  [0x41, { name: 'ATan' }],
  [0x42, { name: 'SinMult' }],
  [0x43, { name: 'CosMult' }],
  [0x44, { name: 'SinDiv' }],
  [0x45, { name: 'CosDiv' }],
  [0x46, { name: 'Text' }],
  [0x48, { name: 'Message' }],
  [0x49, { name: 'Font' }],
  [0x4a, { name: 'EditText' }],
  [0x4b, { name: 'InputText' }],
  [0x4c, { name: 'ScrollWindow', to: 'sci2-1-late' }],
  [0x50, { name: 'GetEvent' }],
  [0x51, { name: 'GlobalToLocal' }],
  [0x52, { name: 'LocalToGlobal' }],
  [0x53, { name: 'MapKeyToDir' }],
  [0x54, { name: 'HaveMouse' }],
  [0x55, { name: 'SetCursor' }],
  [0x56, { name: 'VibrateMouse' }],
  [0x5a, { name: 'List' }],
  [0x5b, { name: 'Array' }],
  [0x5c, { name: 'String' }],
  [0x5d, { name: 'FileIO' }],
  [0x5e, { name: 'BaseSetter' }],
  [0x5f, { name: 'DirLoop' }],
  [0x60, { name: 'CantBeHere' }],
  [0x61, { name: 'InitBresen' }],
  [0x62, { name: 'DoBresen' }],
  [0x63, { name: 'SetJump' }],
  [0x64, { name: 'AvoidPath', to: 'sci2-1-late' }],
  [0x65, { name: 'InPolygon' }],
  [0x66, { name: 'MergePoly', to: 'sci2-1-late' }],
  [0x67, { name: 'ObjectIntersect' }],
  [0x69, { name: 'MemoryInfo' }],
  [0x6a, { name: 'DeviceInfo' }],
  [0x6b, { name: 'Palette' }],
  [0x6c, { name: 'PalVary' }],
  [0x6d, { name: 'PalCycle' }],
  [0x6e, { name: 'RemapColors' }],
  [0x6f, { name: 'AddLine' }],
  [0x70, { name: 'DeleteLine' }],
  [0x71, { name: 'UpdateLine' }],
  [0x72, { name: 'AddPolygon' }],
  [0x73, { name: 'DeletePolygon' }],
  [0x74, { name: 'UpdatePolygon' }],
  [0x75, { name: 'DoSound' }],
  [0x76, { name: 'DoAudio' }],
  [0x77, { name: 'DoSync' }],
  [0x78, { name: 'Save' }],
  [0x79, { name: 'GetTime' }],
  [0x7a, { name: 'Platform' }],
  [0x7b, { name: 'CD' }],
  [0x7c, { name: 'SetQuitStr' }],
  [0x7d, { name: 'GetConfig' }],
  [0x7e, { name: 'Table' }],
  [0x7f, { name: 'WinHelp' }],
  [0x81, { name: 'Empty' }],
  [0x83, { name: 'PrintDebug' }],
  [0x8a, { name: 'LoadChunk' }],
  [0x8b, { name: 'SetPalStyleRange' }],
  [0x8c, { name: 'AddPicAt' }],
  [0x8d, { name: 'MessageBox', from: 'sci3' }],
  [0x8e, { name: 'NewRoom' }],
  [0x90, { name: 'Priority' }],
  [0x91, { name: 'MorphOn' }],
  [0x92, { name: 'PlayVMD' }],
  [0x93, { name: 'SetHotRectangles' }],
  [0x94, { name: 'MulDiv' }],
  [0x95, { name: 'GetSierraProfileInt' }],
  [0x96, { name: 'GetSierraProfileString' }],
  [0x97, { name: 'SetWindowsOption' }],
  [0x98, { name: 'GetWindowsOption' }],
  [0x99, { name: 'WinDLL' }],
  [0x9b, { name: 'Minimize', from: 'sci3' }],
  [0x9c, { name: 'DeletePic' }],
  [0x9e, { name: 'WebConnect', from: 'sci3' }],
  [0x9f, { name: 'PlayDuck', from: 'sci3' }],
  [0xa0, { name: 'WinExec', from: 'sci3' }],
  [0xa1, { name: 'WinExec' }],
];

/**
 * `s_kernelNames` as SCI0 and SCI01 actually number them, 112 slots.
 *
 * **Not the same table as SCI1's, and the difference starts at 41.** SCI0 has
 * four file-handling calls there — `FOpen`, `FPuts`, `FGets`, `FClose` — that
 * SCI1 does not, so everything after them sits four slots lower in SCI1's
 * table. Reading a SCI0 game with SCI1's numbering dispatches `NewNode` where
 * the game asked for `FirstNode` and so on down the list, which is the failure
 * `CONTEXT.md` describes: a game that runs and does the wrong things.
 *
 * **Read off the games rather than transcribed.** Four demos ship a
 * `vocab.999` that names their own Kernel calls — the Christmas Card 1988 (SCI0
 * early), Space Quest III and Leisure Suit Larry 2 (SCI0 late) and King's Quest
 * IV (SCI01) — and all four agree on all 113 entries. Island of Dr. Brain ships
 * one too and is SCI1.1, and *its* table is the other one, agreeing with
 * `SCI16_NAMES` on 123 of 128; that disagreement is what says these are two
 * tables and not one with a hole in it.
 *
 * The 113th entry is dropped: every one of the four has a malformed final
 * record that reads as a run of binary, which is a fact about how Sierra wrote
 * the resource rather than a Kernel call.
 */
const SCI0_NAMES: readonly string[] = [
  'Load',
  'UnLoad',
  'ScriptID',
  'DisposeScript',
  'Clone',
  'DisposeClone',
  'IsObject',
  'RespondsTo',
  'DrawPic',
  'Show',
  'PicNotValid',
  'Animate',
  'SetNowSeen',
  'NumLoops',
  'NumCels',
  'CelWide',
  'CelHigh',
  'DrawCel',
  'AddToPic',
  'NewWindow',
  'GetPort',
  'SetPort',
  'DisposeWindow',
  'DrawControl',
  'HiliteControl',
  'EditControl',
  'TextSize',
  'Display',
  'GetEvent',
  'GlobalToLocal',
  'LocalToGlobal',
  'MapKeyToDir',
  'DrawMenuBar',
  'MenuSelect',
  'AddMenu',
  'DrawStatus',
  'Parse',
  'Said',
  'SetSynonyms',
  'HaveMouse',
  'SetCursor',
  'FOpen',
  'FPuts',
  'FGets',
  'FClose',
  'SaveGame',
  'RestoreGame',
  'RestartGame',
  'GameIsRestarting',
  'DoSound',
  'NewList',
  'DisposeList',
  'NewNode',
  'FirstNode',
  'LastNode',
  'EmptyList',
  'NextNode',
  'PrevNode',
  'NodeValue',
  'AddAfter',
  'AddToFront',
  'AddToEnd',
  'FindKey',
  'DeleteKey',
  'Random',
  'Abs',
  'Sqrt',
  'GetAngle',
  'GetDistance',
  'Wait',
  'GetTime',
  'StrEnd',
  'StrCat',
  'StrCmp',
  'StrLen',
  'StrCpy',
  'Format',
  'GetFarText',
  'ReadNumber',
  'BaseSetter',
  'DirLoop',
  'CanBeHere',
  'OnControl',
  'InitBresen',
  'DoBresen',
  'DoAvoider',
  'SetJump',
  'SetDebug',
  'InspectObj',
  'ShowSends',
  'ShowObjs',
  'ShowFree',
  'MemoryInfo',
  'StackUsage',
  'Profiler',
  'GetMenu',
  'SetMenu',
  'GetSaveFiles',
  'GetCWD',
  'CheckFreeSpace',
  'ValidPath',
  'CoordPri',
  'StrAt',
  'DeviceInfo',
  'GetSaveDir',
  'CheckSaveGame',
  'ShakeScreen',
  'FlushResources',
  'TimesSin',
  'TimesCos',
  'TimesTan',
  'TimesCot',
];

function applies(entry: SciKernelEntry, version: SciVersion): boolean {
  if (entry.from && !atLeast(version, entry.from)) return false;
  if (entry.to && atLeast(version, entry.to) && version !== entry.to) return false;
  return true;
}

/**
 * The Kernel names in force at one Version.
 *
 * Built rather than stored, because the alternative is thirteen arrays that
 * agree with each other about a hundred and thirty entries and are edited one
 * at a time.
 */
export function kernelNamesFor(version: SciVersion): Array<string | undefined> {
  const names: Array<string | undefined> = new Array(0xa2).fill(undefined);

  // SCI0 and SCI01 have a table of their own, and the games say so.
  if (before(version, 'sci1-ega-only')) {
    SCI0_NAMES.forEach((name, index) => {
      names[index] = name;
    });
    return names;
  }

  if (isSci16(version)) {
    SCI16_NAMES.forEach((name, index) => {
      // SCI0's own table stops at 0x6d — ScummVM marks the line "End of kernel
      // function table for SCI0" — so a SCI0 game calling 0x74 is a misread
      // instruction rather than a FileIO, and naming it would hide that.
      //
      // **SCI01 is above the line, and that was found rather than assumed.**
      // The cut-off first applied to everything below SCI1, and the static
      // sweep over the King's Quest I SCI demo — which is SCI01 — reported two
      // calls to 0x74 as unknown. They are `FileIO`: SCI01 is where the table
      // grew, not SCI1. This is the sweep doing the job #219 gives it, on the
      // first game it was pointed at.
      if (index > 0x6d && !atLeast(version, 'sci01')) return;
      names[index] = name;
    });
    for (const [number, entry] of SCI16_REUSED) {
      if (applies(entry, version)) names[number] = entry.name;
    }
    return names;
  }

  const table = version === 'sci2' ? SCI2_NAMES : [];
  for (const [number, name] of table) names[number] = name;
  if (version !== 'sci2') {
    for (const [number, entry] of SCI21_NAMES) {
      if (applies(entry, version)) names[number] = entry.name;
    }
  }
  return names;
}

/**
 * What to say when a script calls a Kernel number this engine does not know.
 *
 * **Loud, by number and Version**, which #217 makes an acceptance criterion in
 * bold. SCI's characteristic failure is silent, and a Kernel call that quietly
 * returns zero is a game that runs and does the wrong things — the exact shape
 * `docs/processes/verifying-version-support.md` says no report about engine
 * state will reveal.
 *
 * **The report is instead of silence, not instead of an answer.** `PMachine`'s
 * `callk` writes `NULL_REG` into the accumulator after logging this and carries
 * on, because halting a game on a call Sierra's own interpreter answers would
 * lose every later finding in the same run. So the message says what the
 * machine did rather than implying a refusal: it used to read "reported rather
 * than returning zero", which was the one thing that was not true of it.
 *
 * `vocab999` is the game's own list of Kernel names where it ships one, so the
 * message can say `DrawPic` rather than only `0x08`. #216 found that resource's
 * presence is not the Version marker two documents claimed it was, but it is
 * still exactly this: a name for a number.
 */
export function describeUnknownKernel(
  number: number,
  version: SciVersion,
  names: ReadonlyArray<string | undefined>,
  vocab999?: readonly string[],
): string {
  const known = names[number] ?? vocab999?.[number];
  const called = known ? `${known} (0x${number.toString(16)})` : `0x${number.toString(16)}`;

  // **A slot this Version's table does not name is a different fact** from a
  // call nobody has written, and reading the same sentence for both hid it.
  // Sierra left placeholders in these tables, and a game reaching one means
  // either the Version is wrong or the table is — which is a finding about the
  // release rather than a queue item, and King's Quest VII produced exactly
  // this at 0x8d. It reads as `MessageBox` from SCI3 and as a placeholder
  // before it, so a SCI2.1 game calling it is calling nothing at all.
  if (!known && classifyKernelNumber(number, version, names) === 'unnamed-slot') {
    return (
      `Kernel call ${called} is a slot ${describeSciVersion(version)} leaves unnamed — a ` +
      `placeholder Sierra shipped rather than a call this engine has not written. A game ` +
      `reaching one is a finding: either this game's Version is not ` +
      `${describeSciVersion(version)}, or the table is wrong at this ordinal. The machine has ` +
      `answered zero and carried on. Reported once per number.`
    );
  }

  return (
    `Kernel call ${called} is not implemented at ${describeSciVersion(version)}. ` +
    `The machine has answered zero and carried on, and this line is the only ` +
    `sign of it: a Kernel call that quietly answers is a game that runs and ` +
    `does the wrong things, which nothing on screen distinguishes from a game ` +
    `that is working. Reported once per number, so a loop says it once.`
  );
}

/**
 * Whether a set of Versions differs in **anything this project reads**.
 *
 * ADR 0013 refuses to edit on a guessed Version, and the reason it gives is
 * specific: decoding with the wrong Kernel table produces a game that runs and
 * does the wrong things, and re-emitting with the same wrong table writes that
 * misreading back byte for byte. That reasoning has a converse nobody had
 * written down — **when the Versions still standing decode identically, there
 * is no misreading for an edit to write back**, and refusing is refusing over
 * a difference that does not exist.
 *
 * King's Quest VII is the case that made it worth writing. Its probes narrow it
 * to SCI2.1 middle and SCI2.1 late and can never do better, because
 * `sciVersion.ts` says of that seam, in its own words, that what moves there is
 * "*asserted* — nothing structural this project reads", ScummVM distinguishing
 * the last three tiers "mainly by which builds — full releases, demos, or Mac
 * ports — of the same late-era titles belong to each". A seam that is not in
 * the data cannot be found by a probe of the data. So every SCI2.1 middle game
 * was refused for editing permanently, waiting on evidence that cannot exist.
 *
 * **Measured, not asserted.** The five Version-keyed facts every reader and
 * writer in this project goes through are compared outright:
 *
 * 1. the Kernel table, which is what ADR 0013 is actually about;
 * 2. whether a Selector id carries the read/write bit;
 * 3. **every Version floor any reader in this project gates on.**
 *
 * The third is the one that makes this sound rather than plausible. The floors
 * are not chosen: they are every floor `atLeast` and `before` are called with
 * anywhere under `src/` — `sci01`, `sci1-ega-only`, `sci1-1`, `sci2` and
 * `sci3` — so a pair that agrees on all of them cannot be told apart by any
 * branch this project takes. Picking a subset by eye is how this would go
 * quietly wrong: the first draft compared three of the five and called SCI0
 * late and SCI01 interchangeable, which they are not.
 *
 * If a Version delta lands on any of these, the fingerprints stop matching and
 * the pair stops being interchangeable on its own. `tests/sci-version-axis.test.ts`
 * pins the pairs that hold today, so a new gate cannot be added without
 * somebody looking at this; **and a gate on a floor not in the list below would
 * be invisible to it**, which is the one way to get this wrong and the reason
 * the list is written as a constant rather than inlined.
 */
export const VERSION_GATES: readonly SciVersion[] = [
  'sci01',
  'sci1-ega-only',
  'sci1-1',
  'sci2',
  'sci3',
];

export function versionsDecodeIdentically(versions: readonly SciVersion[]): boolean {
  if (versions.length <= 1) return true;

  const fingerprint = (version: SciVersion): string =>
    JSON.stringify([
      kernelNamesFor(version),
      selectorIdCarriesReadWriteBit(version),
      VERSION_GATES.map((floor) => atLeast(version, floor)),
    ]);

  const first = fingerprint(versions[0]);
  return versions.every((version) => fingerprint(version) === first);
}

/**
 * Reads `vocab.999`, the Kernel names a SCI0 or SCI01 game ships.
 *
 * Same shape as `vocab.997`: a count that is one short, then that many 16-bit
 * offsets to length-prefixed strings.
 */
export function readKernelVocab(vocab999: Uint8Array): string[] {
  const u16 = (at: number): number => vocab999[at] | (vocab999[at + 1] << 8);
  if (vocab999.length < 2) return [];
  const count = u16(0) + 1;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const pointer = 2 + i * 2;
    if (pointer + 1 >= vocab999.length) break;
    const offset = u16(pointer);
    if (offset + 2 > vocab999.length) break;
    const length = u16(offset);
    if (offset + 2 + length > vocab999.length) break;
    let name = '';
    for (let c = 0; c < length; c++) name += String.fromCharCode(vocab999[offset + 2 + c]);
    names.push(name);
  }
  return names;
}

/**
 * How many slots this Version's Kernel table has.
 *
 * The distinction this exists for: a call to a number **past the end of the
 * table** is a fault — a misread instruction, or the wrong Version — and a call
 * to a number *inside* it that this project has not named is a **gap in what we
 * know**, not a fault in what we read. Reporting them as one number made the
 * static sweep say "4,941 unknown Kernel numbers" across six SCI32 demos, which
 * is true and tells a reader nothing about whether anything is broken.
 *
 * `KERNEL_TABLE_SHAPE` in `sciVersion.ts` is where these came from (#214).
 */
export function kernelTableSize(version: SciVersion): number {
  if (isSci16(version)) return atLeast(version, 'sci01') ? 139 : 0x6d + 1;
  return version === 'sci2' ? 160 : 162;
}

/**
 * What a Kernel number is, at a Version: named, an unnamed slot, or out of range.
 *
 * Three answers rather than two, because "we do not know what slot 0x83 does"
 * and "slot 0x83 does not exist" are different facts and only the second one
 * means something is being read wrongly.
 */
export function classifyKernelNumber(
  number: number,
  version: SciVersion,
  names: ReadonlyArray<string | undefined>,
  shipped: ReadonlyArray<string | undefined> = [],
): 'named' | 'unnamed-slot' | 'out-of-range' {
  if (names[number] || shipped[number]) return 'named';
  return number < kernelTableSize(version) ? 'unnamed-slot' : 'out-of-range';
}
