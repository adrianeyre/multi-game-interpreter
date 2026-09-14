import { ANIMATE_COMMAND, OF_OWNER_ROOM, VAR, packAnimateActor } from '../engine/constants.js';
import { SCREEN_WIDTH } from '../engine/gfx/Screen.js';
import { Assembler } from './Assembler.js';
import { buildCharset } from './CharsetBuilder.js';
import { buildCostume } from './CostumeBuilder.js';
import { append, chunk, concat, encrypt, messageBytes, u16le, u32le } from './encode.js';
import { encodeObjectImages, encodeRoomImage, type IndexedImage } from './ImageEncoder.js';
import { defaultPalette } from './palette.js';
import { DEFAULT_VERB_TOP } from './project.js';
import { global, local } from './values.js';
import type {
  BoxDefinition,
  GameBuilder,
  ObjectBuilder,
  RoomBuilder,
  ScaleRamp,
} from './GameBuilder.js';
import { isConvexBox, rectangleBox } from './GameBuilder.js';

/** The obfuscation key v5 games use. */
export const XOR_KEY = 0x69;

/** `animateActor`: stop moving and play the actor's own stand frame. */
const ANIMATE_STAND = packAnimateActor(ANIMATE_COMMAND.Stand);

/** Generated script ids. User scripts start at 10. */
const BOOT_SCRIPT = 1;
const SENTENCE_SCRIPT = 2;
const VERB_SCRIPT = 3;

/**
 * Verb dispatch scripts for actors live at this base plus the actor number.
 *
 * Objects carry their verb code inside their own OBCD; actors have no such
 * structure, so each gets a global script instead. Placed high to stay clear of
 * the range authors use.
 */
export const ACTOR_SCRIPT_BASE = 150;

/** Ids below this are actors, at or above are objects. */
export const ACTOR_ID_LIMIT = 20;

/**
 * Scratch globals for generated code.
 *
 * Chosen well above the engine's reserved range (0-72) so they cannot collide
 * with a variable the interpreter itself writes.
 */
const SCRATCH = global(200);
const CURRENT_VERB = global(201);
/** Holds a computed script id, since `startScript` can take a variable. */
const SCRATCH_SCRIPT = global(202);

/**
 * The two click areas the generated input script acts on.
 *
 * ScummVM's `ClickArea`, and mirrored in `engine/constants.ts` — repeated
 * here as plain numbers because the assembler takes operands, not enums.
 */
const CLICK_AREA_VERB = 1;
const CLICK_AREA_SCENE = 2;

export interface CompiledGame {
  /** The index file, `<name>.000`. */
  index: Uint8Array;
  /** The data file, `<name>.001`. */
  data: Uint8Array;
  /** Diagnostics worth showing the author. */
  warnings: string[];
  stats: {
    rooms: number;
    objects: number;
    scripts: number;
    costumes: number;
    dataBytes: number;
  };
}

/**
 * Compiles an authored game to a SCUMM v5 index/data pair.
 *
 * The output is a real game container: the engine loads it through exactly the
 * same path as a commercial title, with no authoring-specific branches.
 */
export function compileGame(game: GameBuilder): CompiledGame {
  const warnings: string[] = [];

  if (game.rooms.length === 0) throw new Error('A game needs at least one room');
  const startRoom = game.rooms.find((room) => room.definition.id === game.options.start.room);
  if (!startRoom) {
    throw new Error(`Start room ${game.options.start.room} is not defined`);
  }
  if (game.actors.length === 0) {
    throw new Error('A game needs at least one actor to play as');
  }

  const ego = game.actors[0];
  const screen = game.options.screen ?? { textHeight: 16, verbTop: DEFAULT_VERB_TOP };

  // --- resources ------------------------------------------------------------

  const charset = buildCharset();

  const costumes = numberCostumes(game, warnings);
  const costumeIndexByActor = new Map(costumes.map((entry) => [entry.actorId, entry.id]));

  const scripts: Array<{ id: number; bytes: number[] }> = [
    { id: BOOT_SCRIPT, bytes: [...buildBootScript(game, screen, costumeIndexByActor)] },
    { id: SENTENCE_SCRIPT, bytes: [...buildSentenceScript(game)] },
    { id: VERB_SCRIPT, bytes: [...buildVerbScript()] },
  ];
  for (const userScript of game.scripts) {
    const assembler = new Assembler();
    userScript.body(assembler);
    assembler.stop();
    scripts.push({ id: userScript.id, bytes: [...assembler.build()] });
  }
  scripts.sort((a, b) => a.id - b.id);

  // --- rooms ----------------------------------------------------------------

  const palette = game.options.palette ?? defaultPalette();
  const roomChunks = game.rooms.map((room) => ({
    id: room.definition.id,
    bytes: buildRoom(room, palette, warnings),
  }));
  roomChunks.sort((a, b) => a.id - b.id);

  // --- disk blocks ----------------------------------------------------------
  //
  // Each room gets its own LFLF. Global resources go in the first one, which is
  // what the directories will point at.

  interface Placement {
    kind: 'script' | 'costume' | 'charset';
    id: number;
    roomId: number;
    offset: number;
  }
  const placements: Placement[] = [];
  const roomPlacements = new Map<number, { roomId: number; offset: number }>();

  const blocks: Array<{ roomId: number; payload: number[] }> = [];

  for (let i = 0; i < roomChunks.length; i++) {
    const entry = roomChunks[i];
    const payload: number[] = [];

    // Offsets are relative to the LFLF chunk header, so start past its 8 bytes.
    roomPlacements.set(entry.id, { roomId: entry.id, offset: 8 });
    append(payload, entry.bytes);

    if (i === 0) {
      for (const script of scripts) {
        placements.push({
          kind: 'script',
          id: script.id,
          roomId: entry.id,
          offset: 8 + payload.length,
        });
        append(payload, chunk('SCRP', script.bytes));
      }
      for (const costume of costumes) {
        placements.push({
          kind: 'costume',
          id: costume.id,
          roomId: entry.id,
          offset: 8 + payload.length,
        });
        append(payload, costume.bytes);
      }
      placements.push({ kind: 'charset', id: 0, roomId: entry.id, offset: 8 + payload.length });
      append(payload, charset);
    }

    blocks.push({ roomId: entry.id, payload });
  }

  // --- container ------------------------------------------------------------

  // LOFF records where each LFLF starts, so it must be sized before the offsets
  // it contains are known. Its size is fixed by the room count, so build a
  // placeholder of the right length first.
  const loffPayload = (offsets: Array<{ room: number; offset: number }>): number[] => [
    offsets.length,
    ...offsets.flatMap((entry) => [entry.room, ...u32le(entry.offset)]),
  ];
  const placeholder = chunk(
    'LOFF',
    loffPayload(blocks.map((block) => ({ room: block.roomId, offset: 0 }))),
  );

  let cursor = 8 + placeholder.length; // past the LECF header and LOFF
  const loffEntries: Array<{ room: number; offset: number }> = [];
  const blockBytes: number[] = [];
  for (const block of blocks) {
    loffEntries.push({ room: block.roomId, offset: cursor });
    const lflf = chunk('LFLF', block.payload);
    append(blockBytes, lflf);
    cursor += lflf.length;
  }

  const data = chunk('LECF', [...chunk('LOFF', loffPayload(loffEntries)), ...blockBytes]);

  // --- index ----------------------------------------------------------------

  const index = buildIndex(game, {
    rooms: roomChunks.map((entry) => entry.id),
    roomPlacements,
    scripts: placements.filter((p) => p.kind === 'script'),
    costumes: placements.filter((p) => p.kind === 'costume'),
    charsetPlacement: placements.find((p) => p.kind === 'charset')!,
  });

  void ego;

  return {
    index: encrypt(index, XOR_KEY),
    data: encrypt(data, XOR_KEY),
    warnings,
    stats: {
      rooms: game.rooms.length,
      objects: game.allObjects().length,
      scripts: scripts.length,
      costumes: costumes.length,
      dataBytes: data.length,
    },
  };
}

/**
 * Decides which resource id each actor's costume is written under.
 *
 * An actor that asks for a particular id gets it, and everyone else takes the
 * lowest id nobody has claimed. Asking is what an imported game does: its own
 * scripts change costumes by the published game's numbers, so a costume given
 * a fresh sequential id here is one those scripts can no longer find — the
 * actor is placed correctly, wears a costume that does not exist, and is
 * simply not drawn.
 *
 * Two actors asking for the same id is a project fault rather than something
 * to resolve silently: the second keeps its artwork but is renumbered, and the
 * warning says so.
 */
function numberCostumes(
  game: GameBuilder,
  warnings: string[],
): Array<{ actorId: number; id: number; bytes: number[] }> {
  const claimed = new Set<number>();
  const requested = new Map<number, number>();

  // Costumes copied through verbatim keep their id unconditionally: they exist
  // precisely so the scripts that name that number find something there.
  const costumes: Array<{ actorId: number; id: number; bytes: number[] }> = [];
  for (const raw of game.rawCostumes) {
    if (claimed.has(raw.id)) {
      warnings.push(`Costume ${raw.id} was given twice; the later one was dropped`);
      continue;
    }
    claimed.add(raw.id);
    costumes.push({ actorId: -1, id: raw.id, bytes: [...raw.bytes] });
  }

  for (const actor of game.actors) {
    const wanted = actor.costumeId;
    if (!actor.costume || wanted === undefined) continue;
    if (!Number.isInteger(wanted) || wanted < 1) {
      warnings.push(
        `Actor ${actor.id} ("${actor.name}") asked for costume id ${wanted}, which is not a ` +
          `resource id; it was numbered with the rest`,
      );
      continue;
    }
    if (claimed.has(wanted)) {
      warnings.push(
        `Actor ${actor.id} ("${actor.name}") asked for costume id ${wanted}, which another ` +
          `actor already has; it was numbered with the rest`,
      );
      continue;
    }
    claimed.add(wanted);
    requested.set(actor.id, wanted);
  }

  let next = 1;
  for (const actor of game.actors) {
    if (!actor.costume) {
      warnings.push(`Actor ${actor.id} ("${actor.name}") has no costume and will be invisible`);
      continue;
    }
    let id = requested.get(actor.id);
    if (id === undefined) {
      while (claimed.has(next)) next++;
      id = next;
      claimed.add(id);
    }
    costumes.push({ actorId: actor.id, id, bytes: buildCostume(actor.costume) });
  }

  return costumes.sort((a, b) => a.id - b.id);
}

// ------------------------------------------------------------ generated code --

/**
 * The boot script.
 *
 * Everything the interpreter needs before it can run a game is set here:
 * the screen split, the font, which scripts handle verbs and sentences, the
 * actors, the verb panel, and finally the first room.
 */
function buildBootScript(
  game: GameBuilder,
  screen: { textHeight: number; verbTop: number },
  costumeIndexByActor: Map<number, number>,
): Uint8Array {
  const s = new Assembler();
  const ego = game.actors[0];

  s.setScreen(screen.textHeight, screen.verbTop);
  s.loadCharset(1);

  s.move(global(VAR.SENTENCE_SCRIPT), SENTENCE_SCRIPT);
  s.move(global(VAR.VERB_SCRIPT), VERB_SCRIPT);
  s.move(global(VAR.EGO), ego.id);
  s.move(global(VAR.CHARINC), 4);
  s.move(CURRENT_VERB, 0);

  for (const actor of game.actors) {
    const ops = s.actorOps(actor.id);
    const costumeId = costumeIndexByActor.get(actor.id);
    if (costumeId !== undefined) ops.costume(costumeId);
    ops.name(actor.name);
    ops.talkColor(actor.talkColor ?? 15);
    const speed = actor.walkSpeed ?? { x: 6, y: 3 };
    ops.walkSpeed(speed.x, speed.y);
    ops.talkFrames(4, 5);
    ops.end();
  }

  // The sentence line, which is verb 0 by convention. Nothing writes its text
  // — the interpreter composes it from the chosen verb and whatever the cursor
  // is over — but it has to exist and be on, or there is nowhere to write. It
  // sits on the first row of the verb panel, above the verbs themselves.
  const sentence = s.verbOps(0);
  sentence.create();
  sentence.at(SCREEN_WIDTH >> 1, screen.verbTop);
  sentence.center();
  sentence.color(15);
  sentence.hiColor(14);
  sentence.dimColor(8);
  sentence.on();
  sentence.end();

  for (const verb of game.verbs) {
    const ops = s.verbOps(verb.id);
    ops.create();
    ops.at(verb.x, verb.y);
    ops.color(verb.color ?? 15);
    ops.hiColor(verb.hiColor ?? 14);
    ops.dimColor(8);
    if (verb.key) ops.key(verb.key.charCodeAt(0));
    ops.text(verb.text);
    ops.on();
    ops.end();
  }

  // Order matters: the room must exist before the actor is placed in it, or
  // the actor has no walk boxes to be snapped onto.
  s.loadRoom(game.options.start.room);
  s.putActorInRoom(ego.id, game.options.start.room);
  s.putActor(ego.id, game.options.start.x, game.options.start.y);
  // Command 1 of `animateActor`: stop moving and play the actor's stand frame.
  // The argument is a packed direction and command, not a frame number, so the
  // literal 3 this used to pass asked to turn rather than to stand.
  s.animateActor(ego.id, ANIMATE_STAND);
  s.actorFollowCamera(ego.id);

  // Everyone else with a declared start. Done after the room loads so an actor
  // placed in it is snapped onto a walk box straight away.
  for (const actor of game.actors) {
    if (actor.id === ego.id || !actor.start) continue;
    s.putActorInRoom(actor.id, actor.start.room);
    s.putActor(actor.id, actor.start.x, actor.start.y);
    s.animateActor(actor.id, ANIMATE_STAND);
  }

  s.cursorOn();
  s.userputOn();
  s.stop();

  return s.build();
}

/**
 * The sentence script.
 *
 * The interpreter hands it (verb, object, secondObject) whenever the player
 * clicks something. It walks the player over, then dispatches to the object's
 * own verb code — or says the fallback line if the object has nothing to say.
 */
function buildSentenceScript(game: GameBuilder): Uint8Array {
  const s = new Assembler();
  const verb = local(0);
  const target = local(1);

  const done = s.label();
  const fallback = s.label();
  const walked = s.label();

  // Nothing to do without a target.
  s.jumpUnlessNotZero(target, done);

  // Actors and objects share one id space in the sentence, so they are told
  // apart by range: below the limit is an actor, at or above is an object.
  const isActor = s.label();
  s.jumpIfAtMost(target, ACTOR_ID_LIMIT - 1, isActor);
  s.walkActorToObject(global(VAR.EGO), target);
  s.jump(walked);

  s.place(isActor);
  s.walkActorToActor(global(VAR.EGO), target);

  s.place(walked);
  s.waitForActor(global(VAR.EGO));

  // Verb 0 means a bare click: walking there was the whole action.
  s.jumpUnlessNotZero(verb, done);

  const actorPath = s.label();
  s.jumpIfAtMost(target, ACTOR_ID_LIMIT - 1, actorPath);

  s.getVerbEntrypoint(SCRATCH, target, verb);
  s.jumpUnlessNotZero(SCRATCH, fallback);
  s.startObject(target, verb);
  s.jump(done);

  // An actor's verb code is a global script, since an actor has no chunk to
  // hang it from. The id is computed, which `startScript` allows.
  s.place(actorPath);
  s.move(SCRATCH_SCRIPT, target);
  s.add(SCRATCH_SCRIPT, ACTOR_SCRIPT_BASE);
  s.startScript(SCRATCH_SCRIPT, [verb]);
  s.jump(done);

  s.place(fallback);
  s.sayEgo(game.options.defaultResponse ?? "That doesn't seem to work.");

  s.place(done);
  s.stop();

  return s.build();
}

/**
 * The input script: what a click means.
 *
 * The interpreter says only *where* the click landed — the verb strip, the
 * scene, or the keyboard — in local 0, with what was hit in local 1
 * (`ScummEngine.runInputScript`). Deciding what that means is the game's job,
 * in every shipped SCUMM game and now here: this is the smallest script that
 * does it, and a project that wants more can replace it.
 *
 * It used to be one instruction — `CURRENT_VERB = local0` — because the
 * interpreter resolved room clicks itself and only told this script which verb
 * had been picked. That divergence cost a shipped game its whole opening: an
 * interpreter that pairs the last verb with whatever is under the cursor
 * cannot play a scene whose own input script is the only thing that knows what
 * a bare click means.
 */
function buildVerbScript(): Uint8Array {
  const s = new Assembler();
  const notVerb = s.label();
  const notScene = s.label();
  const noObject = s.label();

  // A verb was clicked: remember it, and let the next room click use it.
  s.jumpUnlessEqual(local(0), CLICK_AREA_VERB, notVerb);
  s.move(CURRENT_VERB, local(1));
  s.stop();

  // A click in the room: the object under the cursor takes the current verb,
  // and bare floor is a walk.
  s.place(notVerb);
  s.jumpUnlessEqual(local(0), CLICK_AREA_SCENE, notScene);
  s.findObject(SCRATCH, global(VAR.VIRT_MOUSE_X), global(VAR.VIRT_MOUSE_Y));
  s.jumpUnlessNotZero(SCRATCH, noObject);
  s.doSentence(CURRENT_VERB, SCRATCH, 0);
  s.stop();

  s.place(noObject);
  s.walkActorTo(global(VAR.EGO), global(VAR.VIRT_MOUSE_X), global(VAR.VIRT_MOUSE_Y));

  s.place(notScene);
  s.stop();
  return s.build();
}

// ----------------------------------------------------------------- room build --

function buildRoom(room: RoomBuilder, palette: number[][], warnings: string[]): number[] {
  const definition = room.definition;
  const image = definition.background;
  const width = definition.width ?? image.width;
  const height = definition.height ?? image.height;

  if (image.width !== width || image.height !== height) {
    warnings.push(
      `Room ${definition.id}: background is ${image.width}x${image.height} but the room ` +
        `is ${width}x${height}`,
    );
  }

  const roomPalette = definition.palette ?? palette;
  const clut: number[] = [];
  for (let i = 0; i < 256; i++) {
    const entry = roomPalette[i] ?? [0, 0, 0];
    clut.push(entry[0] & 0xff, entry[1] & 0xff, entry[2] & 0xff);
  }

  const boxes = definition.boxes ?? [
    rectangleBox(0, Math.floor(height * 0.7), width, Math.ceil(height * 0.3)),
  ];

  for (const [index, box] of boxes.entries()) {
    if (!isConvexBox(box)) {
      warnings.push(
        `Room ${definition.id}: walk box ${index} is not convex, so parts of it ` +
          `will not be walkable. Split it into two boxes instead.`,
      );
    }
  }

  const parts: number[] = [
    ...chunk('RMHD', [...u16le(width), ...u16le(height), ...u16le(room.objects.length)]),
    ...chunk('TRNS', u16le(255)),
    ...chunk('CLUT', clut),
    ...chunk('BOXD', encodeBoxes(boxes, definition.perspective !== undefined)),
    ...chunk('BOXM', [0xff]),
    ...chunk('SCAL', encodeScaleSlots(definition.perspective)),
    ...encodeRoomImage({ ...image, width, height }, definition.zPlanes ?? []),
  ];

  for (const object of room.objects) {
    append(parts, buildObjectImage(object));
  }
  for (const object of room.objects) {
    append(parts, buildObjectCode(object));
  }

  const entry = new Assembler();
  if (room.entryScript) room.entryScript(entry);
  entry.stop();
  append(parts, chunk('ENCD', entry.build()));

  const exit = new Assembler();
  if (room.exitScript) room.exitScript(exit);
  exit.stop();
  append(parts, chunk('EXCD', exit.build()));

  // Local scripts, each a one byte id followed by its bytecode. NLSC counts
  // them; the engine reads the LSCR chunks themselves.
  parts.push(...chunk('NLSC', u16le(room.localScripts.length)));
  for (const local of room.localScripts) {
    const script = new Assembler();
    local.body(script);
    script.stop();
    append(parts, chunk('LSCR', [local.id & 0xff, ...script.build()]));
  }

  return chunk('ROOM', parts);
}

/**
 * SCAL: four 8 byte slots of (scale, y) pairs.
 *
 * Only slot 0 is used. A box referring to it gets a size interpolated from the
 * actor's y position, which is what produces smooth perspective rather than the
 * size stepping as the actor crosses a box edge.
 */
function encodeScaleSlots(ramp: ScaleRamp | undefined): number[] {
  const payload = new Array(32).fill(0);
  if (!ramp) return payload;

  const clampScale = (value: number): number => Math.max(1, Math.min(255, Math.round(value)));
  const entry = [
    ...u16le(clampScale(ramp.farScale)),
    ...u16le(Math.max(0, Math.round(ramp.farY))),
    ...u16le(clampScale(ramp.nearScale)),
    ...u16le(Math.max(0, Math.round(ramp.nearY))),
  ];
  for (let i = 0; i < entry.length; i++) payload[i] = entry[i];
  return payload;
}

/** BOXD: a count then 20 byte records, each a quadrilateral plus flags. */
function encodeBoxes(boxes: BoxDefinition[], hasPerspective: boolean): number[] {
  const payload: number[] = [...u16le(boxes.length)];

  for (const box of boxes) {
    // Written in the order the engine reads them.
    payload.push(
      ...u16le(box.ul.x),
      ...u16le(box.ul.y),
      ...u16le(box.ur.x),
      ...u16le(box.ur.y),
      ...u16le(box.lr.x),
      ...u16le(box.lr.y),
      ...u16le(box.ll.x),
      ...u16le(box.ll.y),
      box.mask ?? 0,
      box.blocked ? 0x80 : 0x00,
      // Bit 15 means "look the size up in scale slot n" rather than "this is
      // the size". Only slot 0 is written, so the index is always 0.
      ...u16le(box.perspective && hasPerspective ? 0x8000 : (box.scale ?? 255)),
    );
  }

  return payload;
}

function buildObjectImage(object: ObjectBuilder): number[] {
  const definition = object.definition;
  const states = definition.states ?? [];
  if (states.length === 0) return [];

  const hotspots: number[] = [];
  for (let i = 0; i < 15; i++) {
    hotspots.push(...u16le(definition.width >> 1), ...u16le(definition.height));
  }

  const header = chunk('IMHD', [
    ...u16le(definition.id),
    ...u16le(states.length),
    ...u16le(0),
    0,
    0,
    ...u16le(0),
    ...u16le(0),
    ...u16le(definition.width),
    ...u16le(definition.height),
    ...u16le(15),
    ...hotspots,
  ]);

  return chunk('OBIM', [...header, ...encodeObjectImages(states).flat()]);
}

/**
 * Builds an `OBCD`: the object's header, its verb code, and its name.
 *
 * Verb table entries are offsets from the start of the OBCD chunk, so the
 * layout has to be measured before the table can be written.
 */
function buildObjectCode(object: ObjectBuilder): number[] {
  const definition = object.definition;

  const facingToDir: Record<string, number> = { west: 0, east: 1, south: 2, north: 3 };
  const walkTo = definition.walkTo ?? {
    x: definition.x + (definition.width >> 1),
    y: definition.y + definition.height + 8,
  };

  const cdhd = chunk('CDHD', [
    ...u16le(definition.id),
    Math.round(definition.x / 8),
    Math.round(definition.y / 8),
    Math.round(definition.width / 8),
    Math.round(definition.height / 8),
    definition.initialState ?? 1,
    0, // parent
    ...u16le(walkTo.x),
    ...u16le(walkTo.y),
    facingToDir[definition.facing ?? 'south'] ?? 2,
  ]);

  const handlers = [...object.handlers];
  const bodies: Array<{ verbId: number; bytes: number[] }> = handlers.map((handler) => {
    const assembler = new Assembler();
    handler.body(assembler);
    assembler.stop();
    return { verbId: handler.verbId, bytes: [...assembler.build()] };
  });

  if (object.defaultHandler) {
    const assembler = new Assembler();
    object.defaultHandler(assembler);
    assembler.stop();
    // 0xFF is the catch-all entry the engine falls back to.
    bodies.push({ verbId: 0xff, bytes: [...assembler.build()] });
  }

  const obna = chunk('OBNA', messageBytes(definition.name));

  // Counted from the `VERB` chunk's own first byte, which is what the engine
  // resolves a verb table's offsets against: its header (8) then the table
  // (three bytes per entry plus a terminator).
  const tableSize = bodies.length * 3 + 1;
  const codeBase = 8 + tableSize;

  const table: number[] = [];
  const code: number[] = [];
  for (const body of bodies) {
    table.push(body.verbId, ...u16le(codeBase + code.length));
    append(code, body.bytes);
  }
  table.push(0);

  const verb = chunk('VERB', [...table, ...code]);

  return chunk('OBCD', [...cdhd, ...verb, ...obna]);
}

// ---------------------------------------------------------------- index build --

interface IndexInputs {
  rooms: number[];
  roomPlacements: Map<number, { roomId: number; offset: number }>;
  scripts: Array<{ id: number; roomId: number; offset: number }>;
  costumes: Array<{ id: number; roomId: number; offset: number }>;
  charsetPlacement: { roomId: number; offset: number };
}

function buildIndex(game: GameBuilder, inputs: IndexInputs): number[] {
  const objects = game.allObjects();
  const maxObjectId = objects.reduce((max, object) => Math.max(max, object.definition.id), 0);
  const objectCount = maxObjectId + 1;

  // RNAM: room names, obfuscated with a second XOR the format applies itself.
  const roomNames: number[] = [];
  for (const room of game.rooms) {
    const name = (room.definition.name ?? `room${room.definition.id}`).slice(0, 9).padEnd(9, '\0');
    roomNames.push(room.definition.id);
    for (const character of name) roomNames.push(character.charCodeAt(0) ^ 0xff);
  }
  roomNames.push(0);

  const maxs = chunk('MAXS', [
    ...u16le(800), // variables
    ...u16le(16),
    ...u16le(2048), // bit variables
    ...u16le(200), // local objects
    ...u16le(50),
    ...u16le(9), // charsets
    ...u16le(100),
    ...u16le(50),
    ...u16le(80), // inventory
  ]);

  const directory = (entries: Array<{ room: number; offset: number }>): number[] => [
    ...u16le(entries.length),
    ...entries.map((entry) => entry.room),
    ...entries.flatMap((entry) => u32le(entry.offset)),
  ];

  // Directory index 0 is unused for rooms, scripts and costumes; entry n must
  // sit at index n so ids and slots line up.
  const roomEntries: Array<{ room: number; offset: number }> = [{ room: 0, offset: 0 }];
  const highestRoom = Math.max(...inputs.rooms);
  for (let id = 1; id <= highestRoom; id++) {
    const placement = inputs.roomPlacements.get(id);
    roomEntries[id] = placement ? { room: id, offset: placement.offset } : { room: 0, offset: 0 };
  }

  const scriptEntries: Array<{ room: number; offset: number }> = [{ room: 0, offset: 0 }];
  const highestScript = inputs.scripts.reduce((max, script) => Math.max(max, script.id), 0);
  for (let id = 1; id <= highestScript; id++) {
    const placement = inputs.scripts.find((script) => script.id === id);
    scriptEntries[id] = placement
      ? { room: placement.roomId, offset: placement.offset }
      : { room: 0, offset: 0 };
  }

  // Written densely from 1 to the highest id in use. A costume id the game
  // does not fill is still an entry — a directory with a hole in it is read as
  // a shorter directory, which silently unnumbers every costume after it.
  const costumeEntries: Array<{ room: number; offset: number }> = [{ room: 0, offset: 0 }];
  const highestCostume = inputs.costumes.reduce((max, costume) => Math.max(max, costume.id), 0);
  for (let id = 1; id <= highestCostume; id++) {
    const placement = inputs.costumes.find((costume) => costume.id === id);
    costumeEntries[id] = placement
      ? { room: placement.roomId, offset: placement.offset }
      : { room: 0, offset: 0 };
  }

  // Two charset slots point at the same resource: slot 0 is the engine's
  // default and slot 1 is what the boot script selects.
  const charsetEntries = [
    { room: inputs.charsetPlacement.roomId, offset: inputs.charsetPlacement.offset },
    { room: inputs.charsetPlacement.roomId, offset: inputs.charsetPlacement.offset },
  ];

  // Column-wise, as v5 and v6 both store it: every owner/state byte, then
  // every 32-bit class field. Written as interleaved records instead, the
  // interpreter reads the owner column as class flags and a built game is
  // unplayable in exactly the way a shipped one was.
  const byId = new Map(objects.map((object) => [object.definition.id, object.definition]));
  const owners: number[] = [];
  const classFields: number[] = [];
  for (let id = 0; id < objectCount; id++) {
    const definition = byId.get(id);
    let classBits = 0;
    for (const classId of definition?.classes ?? []) {
      if (classId >= 1) classBits |= 1 << (classId - 1);
    }
    classFields.push(...u32le(classBits >>> 0));

    // An object nobody carries belongs to the room, and the room is
    // `OF_OWNER_ROOM` rather than 0 — 0 means nobody has it at all, which the
    // interpreter reads as "not here", so writing 0 produced a game whose
    // objects were in no room: not drawn, not clickable, no verbs on hover.
    // An id no object was defined for keeps 0, because there really is nothing
    // there to own.
    const owner = definition ? (definition.owner ?? OF_OWNER_ROOM) : 0;
    const state = definition?.initialState ?? (definition ? 1 : 0);
    owners.push((owner & 0x0f) | ((state & 0x0f) << 4));
  }
  const dobj: number[] = [...u16le(objectCount), ...owners, ...classFields];

  return concat(
    chunk('RNAM', roomNames),
    maxs,
    chunk('DROO', directory(roomEntries)),
    chunk('DSCR', directory(scriptEntries)),
    chunk('DCOS', directory(costumeEntries)),
    chunk('DCHR', directory(charsetEntries)),
    chunk('DSOU', directory([{ room: 0, offset: 0 }])),
    chunk('DOBJ', dobj),
  );
}

export type { IndexedImage };
