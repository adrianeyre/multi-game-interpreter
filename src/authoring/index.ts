/**
 * The authoring toolkit.
 *
 * Declare a game with `defineGame`, compile it with `compileGame`, and the
 * result is a SCUMM v5 container the engine loads like any other game.
 */
export {
  defineGame,
  GameBuilder,
  RoomBuilder,
  ObjectBuilder,
  rectangleBox,
  boxBounds,
  translateBox,
  isConvexBox,
} from './GameBuilder.js';
export type {
  GameOptions,
  RoomDefinition,
  ObjectDefinition,
  ActorDefinition,
  VerbDefinition,
  BoxDefinition,
} from './GameBuilder.js';

export { compileGame, XOR_KEY } from './compile.js';
export type { CompiledGame } from './compile.js';

export { Assembler, ActorOps, VerbOps, Label } from './Assembler.js';
export { global, local, bit, VarRef } from './values.js';
export type { Operand } from './values.js';

export { buildCostume, encodeCelPixels } from './CostumeBuilder.js';
export type { CostumeDefinition, CostumeFrame, CostumeCel } from './CostumeBuilder.js';

export { buildCharset, measureText } from './CharsetBuilder.js';
export { defaultPalette, nearestColor } from './palette.js';

export {
  createImage,
  encodeSmap,
  encodeZPlane,
  encodeRoomImage,
  encodeObjectImages,
} from './ImageEncoder.js';
export type { IndexedImage } from './ImageEncoder.js';

export {
  fill,
  rect,
  outline,
  verticalGradient,
  setPixel,
  getPixel,
  blit,
  pixels,
  mask,
  maskRect,
  speckle,
} from './draw.js';

export { chunk, encrypt, concat, u16le, u32le, u32be, messageBytes } from './encode.js';

export { VAR } from '../engine/constants.js';
