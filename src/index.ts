/**
 * Library entry point.
 *
 * Importing this module gives you the engine without the demo shell, so it can
 * be embedded in another page or driven from a test.
 */
export { ScummEngine, type EngineOptions, type TextOptions } from './engine/ScummEngine.js';
export { SCREEN_HEIGHT, SCREEN_WIDTH, Screen } from './engine/gfx/Screen.js';
export type { EngineResolution, Size } from './engine/AdventureEngine.js';
export { Palette } from './engine/gfx/Palette.js';
export { Charset, wrapText, layoutSpeech } from './engine/gfx/Charset.js';
export { Costume, celToRowMajor, decodeCel, getLimbCel } from './engine/gfx/Costume.js';
export { RoomGraphics } from './engine/gfx/RoomGraphics.js';
export { decodeBomp, decodeBompLine } from './engine/gfx/costume/bomp.js';
export {
  parseAkos,
  decodeAkosCel,
  choreFor,
  AkosCodec,
  type AkosCostume,
  type AkosCel,
} from './engine/gfx/costume/akos.js';
export { stepChore, AkcToken, type ChoreStep, type ChoreVars } from './engine/gfx/costume/chore.js';
export { decodeStrip, decodeMaskStrip, isTransparentCodec } from './engine/gfx/BitmapCodec.js';
export { Room, type RoomObject, type WalkBox } from './engine/room/Room.js';
export { BoxMatrix, closestPtOnLine, closestPtOnBox } from './engine/room/BoxMatrix.js';
export { Actor } from './engine/actor/Actor.js';
export { ScriptEngine } from './engine/script/v5/ScriptEngine.js';
export {
  ScriptState,
  MAX_CUTSCENE_DEPTH,
  type CutSceneLevel,
} from './engine/script/ScriptState.js';
export { ScriptSlot } from './engine/script/ScriptSlot.js';
export { rewriteGame, type ScriptReplacement } from './authoring/exportGame.js';
export {
  exportEditedFiles,
  type EditableSource,
  type EditedArt,
  type ExportedFile,
} from './authoring/exportEdits.js';
export {
  disassembleV6,
  assembleV6,
  formatV6Listing,
  v6SubOpcodeForms,
  type V6Instruction,
  type V6Listing,
  type V6SubOpcodeForm,
} from './authoring/disassembleV6.js';
export {
  SAVE_FORMAT,
  captureState,
  restoreState,
  describeIncompatibleSave,
  type SavedGame,
} from './engine/save/SaveState.js';
export {
  SaveStore,
  SAVE_LOCATION_NOTE,
  type SaveSummary,
  type StorageLike,
} from './engine/save/SaveStore.js';
export { VerbTable, type Verb } from './engine/verbs/Verbs.js';
export {
  SoundEngine,
  decodeAudioBytes,
  decodeVoc,
  decodeSoundResource,
} from './engine/sound/SoundEngine.js';
export { Opl2, OPL2_RATE } from './engine/sound/opl2/Opl2.js';
export {
  AdLibDriver,
  DEFAULT_INSTRUMENT,
  type AdLibInstrument,
} from './engine/sound/AdLibDriver.js';
export { readMidi, type MidiEvent, type MidiFile } from './engine/sound/midi.js';
export { findMidiData, hasAdLibScore, readScummMusic } from './engine/sound/scummAdl.js';
export {
  renderMidiToOpl2,
  renderScummMusic,
  MAX_MUSIC_SECONDS,
  type RenderedMusic,
} from './engine/sound/renderMusic.js';
export {
  detectAudioFormat,
  describeFormat,
  isPlayableFormat,
  whyUnplayable,
  storeAudio,
  loadAudio,
  audioByteLength,
  type AudioFormat,
  type ProjectAudio,
} from './authoring/audio.js';
export {
  ResourceManager,
  type ResourceType,
  type GameLimits,
} from './engine/resource/ResourceManager.js';
export {
  detectGame,
  type DetectedGame,
  type ScummVersion,
} from './engine/resource/GameDetector.js';
export {
  type DataSource,
  type ByteProgress,
  MemoryDataSource,
  FileListDataSource,
  HttpDataSource,
} from './engine/resource/DataSource.js';
export { applyXor, decryptCopy, decryptRange, detectXorKey } from './engine/resource/xor.js';
export {
  LoadProgressTracker,
  formatBytes,
  plural,
  type LoadProgress,
  type LoadStage,
  type ProgressReporter,
} from './engine/resource/progress.js';
export {
  findChunk,
  findChunks,
  findChunkDeep,
  iterateChunks,
  readChunkHeader,
  type Chunk,
} from './engine/resource/Chunk.js';
export { VAR } from './engine/constants.js';
