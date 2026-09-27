/**
 * Adding a SCI room by copying one, and deleting a room this editor added
 * (row 12, `docs/editor-parity.md` §12s).
 *
 * §12s said a new room needs "a `Room` subclass, a method dictionary, a
 * property table and an entry in `vocab.996`'s class table", and that is true
 * of a room written from nothing. A room **copied** from one the game ships
 * needs none of it: the room instance and its things are instances of classes
 * that already exist, their dispatch is to code the copy carries with it, and
 * nothing in a SCI0 block chain, a SCI1.1 code-and-heap pair or a SCI3 script
 * records the script's own number — `newRoom` names a script, the interpreter
 * loads that resource, and export 0 is the room. So the copy is the source's
 * bytes under a new number, packed by `packSciGame` like any other Script.
 *
 * **A script that defines a class is refused.** Its copy would be a second
 * definition of the same species, and `vocab.996` names one script per
 * species — the copy's class would never be the one the game loads, and an
 * instance of it elsewhere would resolve to the original.
 *
 * **The Picture is optional and copied, never shared by accident.** A room's
 * `picture` property names a Picture resource; the copy keeps naming the
 * source's unless the author asks for a Picture of its own, in which case the
 * source's is copied to the new number and the copy's `picture` word points
 * at it — a property word, written like any other.
 *
 * What the copy does not get is anything keyed by the *room's* number that
 * the script only names by literal: a Message or Text resource the source
 * reads as `pushi 12`. Those operands are numbers in code, not references,
 * and the copy says the same things the source did.
 */

import type { SciProject, SciProjectInstruction, SciProjectScript } from '../project.js';
import { kernelNamesFor } from '../../engine/sci/script/kernel.js';
import { SCI_BASE_AUDIO_MAP } from '../../engine/sci/sound/sciAudio.js';
import { describeSciRelinking } from './sciLinker.js';
import { sciPropertyName, sciRooms } from './sciRooms.js';

/**
 * The resources a room's words are keyed by its number in: Messages from
 * SCI1.1, Text resources before them.
 */
const WORD_TYPES = ['message', 'text'] as const;

/**
 * Which argument of a Kernel call is the module — the resource number whose
 * words it reads. `Message(func, module, noun, verb, cond, seq…)` and
 * `GetFarText(module, index, buffer)`, as ScummVM's `kMessage` and
 * `kGetFarText` take them.
 */
const MODULE_ARGUMENT: Record<string, number> = { Message: 1, GetFarText: 0 };

/** Instructions that push exactly one word and nothing else. */
function pushesOne(instruction: SciProjectInstruction): boolean {
  return (
    /^(push|pushi|push0|push1|push2|pushSelf|lofss|dup|pprev|ptos|iptos|dptos)$/.test(
      instruction.name,
    ) || /^ls/.test(instruction.name)
  );
}

/**
 * Copies the room's Messages and Text to the new number, and points the
 * copy's module arguments at them.
 *
 * **What counts as a reference is what the disassembly can show.** A `callk`
 * to `Message` or `GetFarText` takes its arguments from the pushes just before
 * it — the argument count first (ScummVM's `op_callk` pops `argbytes / 2 + 1`
 * words), then the arguments in order — so the module is a known push. A
 * `pushi` of the old number there is retargeted; a variable (most often the
 * `curRoomNum` global) is left, because at run time it is the new room's
 * number anyway.
 *
 * **Anything else holding the old number is refused, by name.** A literal
 * equal to the room's number that is not a module argument — handed to a
 * script's `Print` procedure, a `messager say:`, or used as a coordinate — may
 * or may not be a module, and the disassembly cannot tell which. Guessing
 * either way writes a room that reads the wrong words, so the copy is refused
 * with the first such place named. None of this applies to a room with no
 * Messages or Text of its own: then there is nothing a literal could name.
 */
function copyRoomWords(
  project: SciProject,
  next: SciProject,
  copy: SciProjectScript,
  from: number,
  number: number,
): null | string {
  const types = WORD_TYPES.filter((type) =>
    project.resources.some((one) => one.type === type && one.number === from),
  );
  if (types.length === 0) return null;
  for (const type of types) {
    if (project.resources.some((one) => one.type === type && one.number === number)) {
      return `a ${type} resource ${number} already exists, and the new room's own would collide with it`;
    }
  }

  const kernel = project.version ? kernelNamesFor(project.version) : [];
  const relinkable = describeSciRelinking(copy) === null;
  // A procedure that could not be read is a place a module could hide.
  if ((copy.unreadProcedures ?? []).length > 0) {
    return (
      `script ${from} exports a procedure at ${copy.unreadProcedures![0]} that did not ` +
      `disassemble to a clean body of its own, so whether it reads this room's words could not ` +
      `be identified`
    );
  }
  let retargeted = 0;
  const bodies = [...copy.objects, { name: 'procedure', methods: copy.procedures ?? [] }];
  for (const object of bodies) {
    for (const method of object.methods) {
      const module = new Set<number>();
      for (const [index, instruction] of method.instructions.entries()) {
        if (instruction.name !== 'callk') continue;
        const name = kernel[instruction.operands[0] ?? -1];
        const argument = name === undefined ? undefined : MODULE_ARGUMENT[name];
        if (argument === undefined) continue;
        const pushes = (instruction.operands[1] ?? 0) / 2 + 1;
        const run = method.instructions.slice(Math.max(0, index - pushes), index);
        if (run.length !== pushes || !run.every(pushesOne)) {
          return (
            `the ${name} call at ${instruction.offset} in ${object.name}::${method.selector} ` +
            `does not have its arguments pushed immediately before it, so which module it reads ` +
            `could not be identified`
          );
        }
        module.add(index - pushes + 1 + argument);
      }

      for (const [index, instruction] of method.instructions.entries()) {
        const literal =
          (instruction.name === 'pushi' || instruction.name === 'ldi') &&
          instruction.operands[0] === from;
        if (!literal) continue;
        if (!module.has(index)) {
          return (
            `${object.name}::${method.selector} holds the number ${from} at ${instruction.offset} ` +
            `where the disassembly cannot tell whether it names this room's words — it is not ` +
            `the module argument of a Message or GetFarText call — so the copy is refused rather ` +
            `than guessed at`
          );
        }
        const narrow = (instruction.raw & 1) !== 0;
        if (narrow && number > 0x7f && !relinkable) {
          return (
            `the module ${from} at ${instruction.offset} is a one-byte operand, ${number} needs ` +
            `two, and this script's layout cannot change length (${describeSciRelinking(copy)})`
          );
        }
        instruction.operands[0] = number;
        retargeted++;
      }
    }
  }

  next.resources = [
    ...next.resources,
    ...project.resources
      .filter((one) => (types as readonly string[]).includes(one.type) && one.number === from)
      .map((one) => ({ ...one, number })),
  ];
  // **The speech comes too, by copying the room's audio map.** A line's
  // recording and mouth timing are found through the per-room `map` resource
  // numbered for the room, keyed by the same (noun, verb, cond, seq) tuple the
  // Message carries (ScummVM's `readAudioMapSCI11`) — so the new room's lines
  // have speech exactly when a map numbered for the new room lists their
  // tuples. Nothing in that map names its own number: an entry is a tuple and
  // an offset into `RESOURCE.AUD` (absolute in the early form, cumulative from
  // a leading word in the late one). So the copy is the same bytes under the
  // new number, and its entries address the recordings where they already
  // are. That is the append-don't-move rule `sciAudioVolume.ts` follows taken
  // one step further: nothing is appended because nothing needs to be, and no
  // other map's offsets can move because the Volume is not written at all.
  const speech = project.resources.find((one) => one.type === 'map' && one.number === from);
  const copied: string[] = [...types];
  if (speech && from !== SCI_BASE_AUDIO_MAP) {
    if (project.resources.some((one) => one.type === 'map' && one.number === number)) {
      return `an audio map ${number} already exists, and the new room's speech map would collide with it`;
    }
    next.resources = [...next.resources, { ...speech, number }];
    copied.push('map');
  }
  if (types.includes('message')) {
    next.messages = [
      ...next.messages,
      ...project.messages
        .filter((one) => one.resource === from)
        .map(({ audio, sync, ...line }) => ({
          ...line,
          resource: number,
          // The tuple-keyed numbers stay true only if the map came too.
          ...(speech
            ? { ...(audio === undefined ? {} : { audio }), ...(sync === undefined ? {} : { sync }) }
            : {}),
        })),
    ];
  }
  copy.addedRoom = { ...copy.addedRoom!, words: copied, retargeted };
  return null;
}

/** Why a room cannot be copied from this script, or null. */
export function describeSciRoomAdding(project: SciProject, from: number): string | null {
  const script = project.scripts.find((one) => one.number === from);
  if (!script) return `there is no script ${from}`;
  if (script.unrecovered || script.bytes === '') {
    return `script ${from} was not read as a graph, so what it defines is not known`;
  }
  if (!sciRooms(project).some((room) => room.script === from)) {
    return `script ${from} defines no instance of Room, so a copy of it would not be a room`;
  }
  const classes = script.objects.filter((object) => object.isClass);
  if (classes.length > 0) {
    return (
      `script ${from} defines ${classes.map((one) => one.name).join(', ')}, and a copy would be ` +
      `a second definition of ${classes.length === 1 ? 'that class' : 'those classes'} — the ` +
      `class table (vocab 996) names one script per species`
    );
  }
  return null;
}

/** Every Picture the project holds, by number, wherever it is held. */
function pictureNumbers(project: SciProject): Set<number> {
  return new Set([
    ...project.vectorPictures.map((one) => one.number),
    ...project.celPictures.map((one) => one.number),
    ...project.resources.filter((one) => one.type === 'pic').map((one) => one.number),
  ]);
}

/**
 * The project with a copy of room `from` as script `number`, or a sentence.
 *
 * With `picture`, the room's own Picture is also copied to that number and
 * the copy's `picture` property names it.
 */
export function addSciRoom(
  project: SciProject,
  from: number,
  number: number,
  options: { picture?: number } = {},
): SciProject | string {
  const refusal = describeSciRoomAdding(project, from);
  if (refusal) return refusal;
  if (!Number.isInteger(number) || number < 0 || number > 0xfffe) {
    return `${number} is not a script number: a resource number is sixteen bits and 65535 is SCI's own "none"`;
  }
  if (project.scripts.some((one) => one.number === number)) {
    return `script ${number} already exists, and a new room needs a number nothing else has`;
  }
  if (project.resources.some((one) => one.type === 'heap' && one.number === number)) {
    return `a heap resource ${number} already exists, and the copy's heap would collide with it`;
  }

  const source = project.scripts.find((one) => one.number === from)!;
  const room = sciRooms(project).find((one) => one.script === from)!;
  const copy: SciProjectScript = structuredClone(source);
  copy.number = number;
  delete copy.addedObjects;
  copy.addedRoom = { from };

  const next: SciProject = { ...project, scripts: [...project.scripts, copy] };

  // The words the room says, keyed by its number: copied to the new number,
  // and the copy's references to the old one retargeted where they are found.
  const words = copyRoomWords(project, next, copy, from, number);
  if (typeof words === 'string') return words;

  if (options.picture !== undefined) {
    const picture = options.picture;
    if (room.picture === null) {
      return `room ${from} names no Picture, so there is none to copy for the new room`;
    }
    if (!Number.isInteger(picture) || picture < 0 || picture > 0xfffe) {
      return `${picture} is not a Picture number`;
    }
    if (pictureNumbers(project).has(picture)) {
      return `Picture ${picture} already exists, and the new room's Picture needs a number of its own`;
    }
    const roomObject = copy.objects.find((object) => object.name === room.name && !object.isClass);
    const index = roomObject
      ? roomObject.variables.findIndex(
          (_, i) => sciPropertyName(roomObject, i, project) === 'picture',
        )
      : -1;
    if (!roomObject || index < 0 || !roomObject.variablesAt) {
      return `the room instance's picture property could not be found where it can be written`;
    }
    roomObject.variables[index] = picture;

    const vector = project.vectorPictures.find((one) => one.number === room.picture);
    const cel = project.celPictures.find((one) => one.number === room.picture);
    const plain = project.resources.find(
      (one) => one.type === 'pic' && one.number === room.picture,
    );
    if (vector) next.vectorPictures = [...project.vectorPictures, { ...vector, number: picture }];
    else if (cel)
      next.celPictures = [...project.celPictures, { ...structuredClone(cel), number: picture }];
    else if (plain) next.resources = [...project.resources, { ...plain, number: picture }];
    else
      return `Picture ${room.picture} is named by room ${from} and this release does not ship it`;
    copy.addedRoom = { ...copy.addedRoom, picture };
  }

  return next;
}

/** The project without a room this editor added, and without its Picture. */
export function deleteSciRoom(project: SciProject, number: number): SciProject | string {
  const script = project.scripts.find((one) => one.number === number);
  if (!script) return `there is no script ${number}`;
  if (!script.addedRoom) {
    return (
      `script ${number} is one the game shipped. Delete removes only a room this editor added: ` +
      `a shipped room may be named by any other script's newRoom, and nothing says which`
    );
  }
  const picture = script.addedRoom.picture;
  const words = new Set(script.addedRoom.words ?? []);
  return {
    ...project,
    scripts: project.scripts.filter((one) => one !== script),
    messages: words.has('message')
      ? project.messages.filter((one) => one.resource !== number)
      : project.messages,
    vectorPictures: project.vectorPictures.filter((one) => one.number !== picture),
    celPictures: project.celPictures.filter((one) => one.number !== picture),
    resources: project.resources.filter(
      (one) =>
        !(one.type === 'pic' && one.number === picture) &&
        !(words.has(one.type) && one.number === number),
    ),
  };
}
