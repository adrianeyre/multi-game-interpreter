/**
 * A SCI save is a heap, not a schema (ADR 0019).
 *
 * There is no "room, ego, inventory" layer to serialise, because the VM's
 * object graph *is* the game state. So the format is segments with declared
 * types and references written as segment-plus-offset pairs — which is why the
 * segments exist in `segments.ts` from the moment a reference is made rather
 * than being invented here.
 *
 * **The distinction that decides correctness is static objects versus Clones.**
 * A static object is restored by reloading its script and re-applying the
 * properties that changed; a Clone has to be recreated whole, along with every
 * reference into it. Confuse the two and a save loads a world that looks
 * entirely right and whose actors are not the ones the running scripts hold
 * pointers to — no error, no symptom until much later.
 */

import type { SavedGameEnvelope } from '../../AdventureEngine.js';
import type { PMachine, Reg, SciObject } from '../script/PMachine.js';
import { reg } from '../script/PMachine.js';
import type { SciHeap } from '../script/segments.js';

/**
 * Format 2: property values are references, not numbers.
 *
 * ADR 0019 makes a SCI save the object graph, and a property holds a `reg_t` —
 * a segment and an offset. Format 1 wrote each one as a bare number, which
 * threw the segment away and so could not restore a property holding an object
 * pointer. Bumped rather than migrated: no SCI game has been playable, so there
 * are no format 1 saves to migrate.
 */
export const SCI_SAVE_FORMAT = 2;

/** A reference, as a save writes one: never a bare number. */
type SavedReg = [segment: number, offset: number];

/**
 * A static object's *changes*, not its contents.
 *
 * Only the properties that differ from what its script defines. That is what
 * makes the save small and, more importantly, what makes it survive an edit: a
 * Project whose script changed reloads the new script and re-applies these,
 * where a whole-object save would restore the old layout over the new one.
 */
interface SavedStatic {
  id: SavedReg;
  /** Property index to its value, for the ones that changed. */
  changed: Array<[index: number, value: SavedReg]>;
}

/**
 * A Clone, whole.
 *
 * Everything, because there is nothing to reload it from — `kClone` made it and
 * no Script resource has any record of it (ADR 0019).
 */
interface SavedClone {
  id: SavedReg;
  species: number;
  superClass: number;
  info: number;
  /** Where this object's properties start, which its layout decides. */
  propertyBias: number;
  script: number;
  variables: SavedReg[];
  /** Which Selector each variable answers to, when the Clone carries its own. */
  variableSelectors: number[];
  name?: string;
}

export interface SciSavedGame extends SavedGameEnvelope {
  /** Globals, which are script 0's locals. */
  globals: SavedReg[];
  /** Locals per script, by script number. */
  locals: Array<[script: number, values: SavedReg[]]>;
  statics: SavedStatic[];
  clones: SavedClone[];
  /** The interpreter's own lists and nodes. */
  lists: Array<[id: number, first: SavedReg, last: SavedReg]>;
  nodes: Array<[id: number, key: SavedReg, value: SavedReg, previous: SavedReg, next: SavedReg]>;
}

function saveReg(value: Reg): SavedReg {
  return [value.segment, value.offset];
}

function loadReg(value: SavedReg): Reg {
  return reg(value[0], value[1]);
}

export const SCI_SAVE_NOTE =
  'SCI saves are kept in this browser and are specific to this game and this ' +
  'interpreter. They are not Sierra save files and ScummVM cannot read them. A ' +
  'save from another Engine family, or another SCI Version, is refused rather ' +
  'than half-applied — a SCI save is the game’s own object graph, and applying ' +
  'one graph to a different game’s objects loads a world that looks right and is ' +
  'not the one the scripts hold pointers to.';

/**
 * Captures the machine's state.
 *
 * `original` is what each static object's script defines, so only the changes
 * are written. A caller that cannot supply it saves every property, which is
 * correct and larger — the difference is a size optimisation, not a
 * correctness one, and it is worth saying so because the *Clone* half is the
 * opposite: there, whole is the only correct answer.
 */
export function captureSciState(
  machine: PMachine,
  heap: SciHeap,
  original: (object: SciObject) => readonly Reg[] | null,
): Omit<SciSavedGame, keyof SavedGameEnvelope> {
  const statics: SavedStatic[] = [];
  const clones: SavedClone[] = [];

  for (const object of machine.objects.values()) {
    if (object.clone) {
      clones.push({
        id: saveReg(object.id),
        species: object.species,
        superClass: object.superClass,
        info: object.info,
        propertyBias: object.propertyBias,
        script: object.script,
        variables: object.variables.map(saveReg),
        variableSelectors: [...object.variableSelectors],
        name: object.name,
      });
      continue;
    }

    const base = original(object);
    const changed: Array<[number, SavedReg]> = [];
    for (const [index, value] of object.variables.entries()) {
      const was = base?.[index];
      // A property counts as changed when either half of its register moved.
      // Comparing offsets alone would call an object pointer unchanged when it
      // had been reassigned to a different script's object at the same offset.
      if (!was || was.segment !== value.segment || was.offset !== value.offset) {
        changed.push([index, saveReg(value)]);
      }
    }
    if (changed.length > 0) statics.push({ id: saveReg(object.id), changed });
  }

  return {
    globals: machine.globals.map(saveReg),
    locals: [...machine.locals].map(([script, values]) => [script, values.map(saveReg)]),
    statics,
    clones,
    lists: heap.saveLists(),
    nodes: heap.saveNodes(),
  };
}

/**
 * Restores it, Clones first.
 *
 * The order is the correctness argument. A static object's restored properties
 * may refer to a Clone, so the Clones have to exist before those references are
 * applied — otherwise the reference resolves to nothing at the moment it is
 * written and to something else later, which is the silent form of the fault
 * ADR 0019 names.
 */
export function restoreSciState(
  machine: PMachine,
  heap: SciHeap,
  saved: Omit<SciSavedGame, keyof SavedGameEnvelope>,
): void {
  // Every Clone from the previous run goes: they have no backing anywhere, so
  // leaving one behind leaves an object the restored graph does not know about
  // and something may still reach. Through `dropClones` rather than through
  // the Kernel's `disposeClone`, which defers the free for a script that keeps
  // writing to what it disposed — there is no such script here, the world is
  // being replaced.
  machine.dropClones();

  for (const clone of saved.clones) {
    machine.addObject({
      id: loadReg(clone.id),
      species: clone.species,
      superClass: clone.superClass,
      info: clone.info,
      propertyBias: clone.propertyBias,
      script: clone.script,
      variables: clone.variables.map(loadReg),
      variableSelectors: [...clone.variableSelectors],
      // A Clone's methods are its class's and are found by the graph walk, so
      // there is nothing to restore — which is the whole reason a Clone is
      // cheap and also why it cannot be restored by reloading a script.
      methods: new Map(),
      clone: true,
      name: clone.name,
    });
  }

  for (const entry of saved.statics) {
    const object = machine.object(loadReg(entry.id));
    if (!object) continue;
    for (const [index, value] of entry.changed) object.variables[index] = loadReg(value);
  }

  machine.locals.clear();
  for (const [script, values] of saved.locals) {
    machine.locals.set(script, values.map(loadReg));
  }

  heap.restoreLists(saved.lists);
  heap.restoreNodes(saved.nodes);
}
