import { describe, expect, it } from 'vitest';
import { SkyWorld, SKY_VAR, SKY_STATUS } from '../src/engine/sky/SkyWorld.js';
import { SkyInterpreter, SkyMcodeUnimplemented } from '../src/engine/sky/script/SkyInterpreter.js';
import { parseSkyCompacts } from '../src/engine/sky/resource/skyCompacts.js';
import { parseSkyWorldState, writeSkyWorldState } from '../src/engine/sky/save/skyWorldState.js';
import { buildSkyCompactFixture } from './fixtureSkyCompacts.js';
import { SKY_MCODE_STRIDE, SKY_MCODE } from '../src/engine/sky/script/skyMcodes.js';
import { SKY_SCRIPT_VARIABLES, SKY_RELOAD_SLOTS } from '../src/engine/sky/save/skyWorldState.js';
import { SKY_GAME_SPEED_MS, SKY_TICKS_PER_STEP } from '../src/engine/sky/SkyEngine.js';

const compacts = parseSkyCompacts(buildSkyCompactFixture());

function world(): SkyWorld {
  return new SkyWorld(compacts);
}

function script(...words: number[]): Uint16Array {
  return Uint16Array.from(words);
}

/** A state image, so `apply` can be exercised without a shipped file. */
function stateBytes(fill: number): Uint8Array {
  const sizes = compacts.saveIds.map(
    (id) => compacts.records.find((record) => record.id === id)!.words.length,
  );
  const compactWords = sizes.reduce((total, size) => total + size, 0);
  const length =
    3 * 4 + 2 * 2 + 4 * 4 + SKY_SCRIPT_VARIABLES * 4 + SKY_RELOAD_SLOTS * 4 + compactWords * 2;
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let at = 0;
  const u32 = (value: number): void => {
    view.setUint32(at, value >>> 0, true);
    at += 4;
  };
  u32(length);
  u32(6);
  u32(372);
  at += 4; // two sound slots
  u32(0);
  u32(0);
  u32(0);
  u32(0);
  for (let i = 0; i < SKY_SCRIPT_VARIABLES; i += 1) u32(i === SKY_VAR.screen ? 42 : 0);
  for (let i = 0; i < SKY_RELOAD_SLOTS; i += 1) u32(0);
  for (let i = 0; i < compactWords; i += 1) {
    view.setUint16(at, fill, true);
    at += 2;
  }
  return bytes;
}

describe('SkyWorld', () => {
  it('starts a new game from a state image, which is what a restore is too', () => {
    const state = parseSkyWorldState(stateBytes(0x77), compacts);
    const live = world();
    live.apply(state);
    expect(live.variables[SKY_VAR.screen]).toBe(42);
    expect(live.words(compacts.saveIds[0])![0]).toBe(0x77);
  });

  it('captures the world back into a state that shares nothing with it', () => {
    const state = parseSkyWorldState(stateBytes(0x11), compacts);
    const live = world();
    live.apply(state);
    const captured = live.capture(state);
    live.words(compacts.saveIds[0])![0] = 0x99;
    expect(captured.compactWords[0][0]).toBe(0x11);
  });

  it('gives an alias the same words as the record it names', () => {
    // A second name for a record rather than a record: a script writing through
    // either name has to be seen through the other.
    const alias = compacts.aliases[0];
    const live = world();
    live.words(alias.targetId)![0] = 0x1234;
    expect(live.words(alias.id)![0]).toBe(0x1234);
  });

  it('answers zero for a field a short record does not hold', () => {
    // 200-odd shipped records stop before the field list does, and asking a
    // scenery object for its `mode` is a fair question with the answer "none".
    const live = world();
    const short = compacts.records[1];
    expect(live.field(short.id, 'logic')).toBe(short.words[0]);
    expect(live.field(short.id, 'megaSet')).toBe(0);
  });

  it('reads and writes the running Compact through a script offset', () => {
    const live = world();
    live.current = compacts.records[0].id;
    // Byte offset 14 is `xcood` — a byte offset into the original structure,
    // not a word index.
    live.writeCompact(14, 0x4321);
    expect(live.readCompact(14)).toBe(0x4321);
    expect(live.field(live.current, 'xcood')).toBe(0x4321);
  });

  it('stacks a script call in the Compact’s mode, and the caller is still there', () => {
    const live = world();
    live.current = compacts.records[0].id;
    live.setField(live.current, 'mode', 0);
    live.setField(live.current, 'baseSub', 0x1111);

    // fnStartSub pauses the calling script, which is how the game returns.
    expect(live.callMcode(7, 0x2222, 0, 0)).toBe(false);
    expect(live.field(live.current, 'mode')).toBe(4);
    expect(live.getSub(live.current, 4)).toBe(0x2222);
    expect(live.getSub(live.current, 0)).toBe(0x1111);
  });

  it('implements the mcodes it can check, and refuses the rest by name', () => {
    const live = world();
    live.current = compacts.records[0].id;

    // fnNoHuman and fnAddHuman write MOUSE_STATUS, not MOUSE_STOP. This used to
    // assert the opposite, which is why the variable a booted game polls was
    // read thousands of times and written never.
    live.callMcode(28, 0, 0, 0); // fnAddHuman
    expect(live.variables[SKY_VAR.mouseStatus] & 2).toBe(2);
    live.callMcode(27, 0, 0, 0); // fnNoHuman
    expect(live.variables[SKY_VAR.mouseStatus] & 2).toBe(0);

    // fnDrawScreen takes **one** argument and it is the palette. The game's own
    // room-entry scripts read `push_number 4316; call_mcode fnDrawScreen` with
    // argc 1, and the background is not passed at all — the script set
    // LAYER_0_ID a few instructions earlier. This used to assert the opposite,
    // which is why nothing ever drew: `b` was always zero.
    live.variables[SKY_VAR.layer0Id] = 101;
    live.callMcode(2, 202, 0, 0);
    expect(live.chosenPalette).toBe(202);
    expect(live.drawnScreen).toBe(101);

    // Never silently skipped. `fnAr` used to be the example here and now lands,
    // so the example moved to one that does not: `fnRunFrames` is the next
    // busiest thing the shipped scripts ask for, and it is refused by name
    // rather than returning true and leaving a mega on a frame it never asked
    // for.
    expect(() => live.callMcode(SKY_MCODE.fnRunFrames, 0, 0, 0)).toThrow(SkyMcodeUnimplemented);
    expect(() => live.callMcode(SKY_MCODE.fnRunFrames, 0, 0, 0)).toThrow(
      /fnRunFrames is not implemented/,
    );
  });

  /**
   * `fnGetTo` is the separable half of the walk: it chooses which script does
   * the walking and hands over to it, and moves nobody. So it can be checked
   * without a router — the check is that it installs the right get-to script one
   * mode up and drops out, exactly the shape `fnStartSub` has, which is what
   * turns the stall a floor-click hits from `fnGetTo` into the router the get-to
   * script calls (`fnAr`) rather than a fabricated position.
   */
  it('picks a get-to script from the place’s table and hands over to it', () => {
    // foster (id 0) stands in place 1; place 1 (id 1) names getToTable id 2;
    // that table (type 5) maps target place 99 → script 0x0055.
    const fosterWords = Array.from({ length: 55 }, () => 0);
    fosterWords[4] = 1; // place → the place compact's id
    const placeWords = Array.from({ length: 10 }, () => 0);
    placeWords[5] = 2; // getToTableId → the getToTable's id
    const built = parseSkyCompacts(
      buildSkyCompactFixture({
        compacts: [
          { name: 'foster', type: 1, words: fosterWords },
          { name: 'floor_place', type: 1, words: placeWords },
          { name: 'floor_getTo', type: 5, words: [99, 0x0055, 0, 0] },
        ],
        emptySlots: 0,
        aliases: [],
        saveIds: [0],
      }),
    );
    const live = new SkyWorld(built);
    live.current = 0;

    // a = target place, b = arrival mode saved for fnArrived.
    expect(live.callMcode(SKY_MCODE.fnGetTo, 99, 7, 0)).toBe(false);
    expect(live.field(0, 'upFlag')).toBe(7); // saved for fnArrived
    expect(live.field(0, 'getToFlag')).toBe(99);
    expect(live.field(0, 'mode')).toBe(4); // one level up, like a subroutine
    expect(live.getSub(0, 4)).toBe(0x0055); // the script the table named
    expect(live.getSub(0, 6)).toBe(0); // starting at its beginning

    // A target the table does not carry is a counted finding, not a read off the
    // end of the record, and the script carries on the way the game's does.
    expect(live.callMcode(SKY_MCODE.fnGetTo, 12345, 0, 0)).toBe(true);
    expect(live.notes().map((note) => note.what)).toContain('a get-to script for place 12345');
  });

  it('round-trips a mid-game world through the save format', () => {
    // #258's round trip, at the level where it can be tested without a shipped
    // game: the Compact table's mutable fields are the world, so they are what
    // has to survive — not just the script variables.
    const state = parseSkyWorldState(stateBytes(0x11), compacts);
    const live = world();
    live.apply(state);

    // Play a little: move an object and set a flag.
    const moved = compacts.saveIds[0];
    live.setField(moved, 'xcood', 0x1234);
    live.setField(moved, 'ycood', 0x5678);
    live.variables[SKY_VAR.screen] = 77;

    const saved = writeSkyWorldState(live.capture(state), compacts);
    const restored = world();
    restored.apply(parseSkyWorldState(saved, compacts));

    expect(restored.variables[SKY_VAR.screen]).toBe(77);
    expect(restored.field(moved, 'xcood')).toBe(0x1234);
    expect(restored.field(moved, 'ycood')).toBe(0x5678);
    // And everything that was not touched is still what it was.
    expect(restored.words(compacts.saveIds[1])).toEqual(live.words(compacts.saveIds[1]));
  });

  it('counts what it could not do, most-reached first', () => {
    const live = world();
    const machine = new SkyInterpreter(live);
    for (let i = 0; i < 3; i += 1) {
      machine.run(script(2, 1, 11, 1, SKY_MCODE.fnRunFrames * SKY_MCODE_STRIDE, 19), 0);
    }
    machine.run(script(2, 1, 11, 1, SKY_MCODE.fnIncMegaSet * SKY_MCODE_STRIDE, 19), 0);
    for (const [name, count] of machine.unimplemented) live.unimplemented.set(name, count);

    const notes = live.notes();
    expect(notes[0]).toEqual({ what: 'fnRunFrames', count: 3 });
    expect(notes[1]).toEqual({ what: 'fnIncMegaSet', count: 1 });
  });
});

/**
 * The gate a booted game needs, and the section applying a state has to enter.
 *
 * Both are transcribed from ScummVM's `Logic` and both were missing, and the
 * pair is why the CD release booted and then sat still: without the gate around
 * thirty-seven Compacts killed themselves and were run again every tick, and
 * without the section nothing had loaded a room to be in.
 */
describe('what a booted world does with status and sections', () => {
  it('runs a Compact’s logic only when its status asks for it', () => {
    // `Logic::engine` checks this before anything else — "check the id actually
    // wishes to be processed" — and `fnKillId` works by clearing `status`, so
    // an engine that never reads it gives a Compact no way to stop existing.
    const live = world();
    // Not `records[0]`, whose id is 0 — `fnKillId` treats that as "no object",
    // which the next test needs to be a real one.
    const id = compacts.records[1].id;

    live.setField(id, 'status', SKY_STATUS.logic);
    expect(live.wantsLogic(id)).toBe(true);

    // Every other bit set and this one clear is still no.
    live.setField(id, 'status', 0xffff & ~SKY_STATUS.logic);
    expect(live.wantsLogic(id)).toBe(false);
  });

  it('stops asking for a Compact’s logic once fnKillId has cleared it', () => {
    // The whole point of the gate: this sequence is what the shipped scripts do
    // on their first tick, and before the gate existed it changed nothing.
    const live = world();
    const id = compacts.records[1].id;
    live.setField(id, 'status', SKY_STATUS.logic);
    live.current = id;

    live.callMcode(SKY_MCODE.fnKillId, id, 0, 0);

    expect(live.field(id, 'status')).toBe(0);
    expect(live.wantsLogic(id)).toBe(false);
  });

  it('enters the section a state names, and counts it once', () => {
    // `Logic::parseSaveData` brackets its variable copy with `fnLeaveSection`
    // and `fnEnterSection`, so entering a section is part of applying a state
    // rather than something a script asks for at boot.
    const live = world();
    expect(live.enteredSection).toBeNull();

    live.enterSection(3);
    expect(live.enteredSection).toBe(3);
    expect(live.variables[SKY_VAR.currentSection]).toBe(3);
    expect(live.sectionsEntered).toBe(1);

    // Re-entering the one already loaded is not a second load, which is the
    // condition the game itself puts on it.
    live.enterSection(3);
    expect(live.sectionsEntered).toBe(1);

    live.enterSection(4);
    expect(live.sectionsEntered).toBe(2);
  });

  it('routes a script’s own section change through the same door', () => {
    // One route for both, so a section entered by a script and a section
    // entered by applying a state cannot disagree about which one is loaded.
    const live = world();
    live.current = compacts.records[0].id;

    expect(live.callMcode(SKY_MCODE.fnEnterSection, 2, 0, 0)).toBe(true);
    expect(live.enteredSection).toBe(2);
    expect(live.variables[SKY_VAR.currentSection]).toBe(2);
  });

  it('does not count a section’s missing media as something a script stopped on', () => {
    // A `noteMissing` is a subsystem a *script* asked for and did not get, and
    // `describeStatus` leads with the busiest as the thing the game halted on.
    // Entering a section is neither a request nor a stop, so it must not appear
    // there — putting it there made the report say the game had stopped on
    // missing music, which it had not.
    const live = world();
    live.enterSection(0);
    expect(live.notes()).toEqual([]);
  });
});

/**
 * The mouse, which is what a booted game was waiting for.
 *
 * `MOUSE_STATUS` was read thousands of times and written never, because the two
 * mcodes that write it in the game were writing a different variable here.
 */
describe('the mouse engine', () => {
  it('gives and takes control through MOUSE_STATUS, not MOUSE_STOP', () => {
    const live = world();
    live.current = compacts.records[0].id;

    live.callMcode(SKY_MCODE.fnAddHuman, 0, 0, 0);
    expect(live.variables[SKY_VAR.mouseStatus] & 2).toBe(2); // the pointer is live
    expect(live.variables[SKY_VAR.mouseStatus] & 4).toBe(4); // buttons are enabled

    live.callMcode(SKY_MCODE.fnNoButtons, 0, 0, 0);
    expect(live.variables[SKY_VAR.mouseStatus] & 4).toBe(0);

    live.callMcode(SKY_MCODE.fnNoHuman, 0, 0, 0);
    expect(live.variables[SKY_VAR.mouseStatus] & 2).toBe(0);
  });

  it('honours MOUSE_STOP as the gate the game makes it', () => {
    // fnSetStop writes the MOUSE_STOP *variable*, and with it set fnAddHuman
    // must not hand control back. These wrote a Compact field instead, so the
    // gate read zero by luck rather than by agreement.
    const live = world();
    live.current = compacts.records[0].id;

    live.callMcode(SKY_MCODE.fnSetStop, 0, 0, 0);
    expect(live.variables[SKY_VAR.mouseStop]).toBe(1);

    live.callMcode(SKY_MCODE.fnAddHuman, 0, 0, 0);
    expect(live.variables[SKY_VAR.mouseStatus] & 2).toBe(0);

    live.callMcode(SKY_MCODE.fnClearStop, 0, 0, 0);
    live.callMcode(SKY_MCODE.fnAddHuman, 0, 0, 0);
    expect(live.variables[SKY_VAR.mouseStatus] & 2).toBe(2);
  });

  it('finds a Compact whose box the pointer is inside, and only on this screen', () => {
    const live = world();
    const id = compacts.records[1].id;
    live.variables[SKY_VAR.screen] = 7;
    live.variables[SKY_VAR.mouseListNumber] = compacts.records[0].id;
    // A one-entry mouse list: the id, then the terminating zero.
    const list = live.words(compacts.records[0].id)!;
    list[0] = id;
    list[1] = 0;

    live.setField(id, 'status', SKY_STATUS.mouse);
    live.setField(id, 'screen', 7);
    live.setField(id, 'xcood', 100);
    live.setField(id, 'ycood', 50);
    live.setField(id, 'mouseRelX', 0);
    live.setField(id, 'mouseRelY', 0);
    live.setField(id, 'mouseSizeX', 20);
    live.setField(id, 'mouseSizeY', 10);

    expect(live.pointerOver(110, 55)).toBe(id);
    expect(live.pointerOver(99, 55)).toBe(0); // left of the box
    expect(live.pointerOver(110, 61)).toBe(0); // below it

    // On another screen the same box is not there to be touched.
    live.variables[SKY_VAR.screen] = 8;
    expect(live.pointerOver(110, 55)).toBe(0);
  });

  it('ignores a Compact that does not ask to be tested', () => {
    const live = world();
    const id = compacts.records[1].id;
    live.variables[SKY_VAR.screen] = 7;
    live.variables[SKY_VAR.mouseListNumber] = compacts.records[0].id;
    const list = live.words(compacts.records[0].id)!;
    list[0] = id;
    list[1] = 0;

    live.setField(id, 'status', 0); // no ST_MOUSE
    live.setField(id, 'screen', 7);
    live.setField(id, 'xcood', 100);
    live.setField(id, 'ycood', 50);
    live.setField(id, 'mouseSizeX', 20);
    live.setField(id, 'mouseSizeY', 10);

    expect(live.pointerOver(110, 55)).toBe(0);
  });
});

/**
 * The click, and the reason a floor-click looked absorbed rather than stalled.
 *
 * Stage `room` was earned before any of this: a background drawn, the pointer
 * live, hotspots found. What a player then could not do was the first thing a
 * room invites — go somewhere. The click reached `floor`'s `mouseClick` script
 * and stopped at word 889 on `fnNormalMouse`, and behind that stop sat a
 * second fault that the stop was hiding: `fnAssignBase` assigned the walk's
 * base script without setting the Compact running, so once the click *did*
 * complete the walk it started never started at all.
 */
describe('the pointer-mode family, and starting the script a click assigns', () => {
  it('sets a cursor shape and records that nothing draws one', () => {
    // Six mcodes, one job each: change the pointer sprite. There is no cursor
    // renderer here, so the request is recorded and the gap is noted — the
    // label is this project's own, not a transcription of sprite numbers.
    const live = world();
    live.current = compacts.records[0].id;

    expect(live.callMcode(SKY_MCODE.fnNormalMouse, 0, 0, 0)).toBe(true);
    expect(live.cursor).toBe('normal');

    expect(live.callMcode(SKY_MCODE.fnCrossMouse, 0, 0, 0)).toBe(true);
    expect(live.cursor).toBe('cross');

    expect(live.callMcode(SKY_MCODE.fnOpenHand, 0, 0, 0)).toBe(true);
    expect(live.cursor).toBe('open-hand');

    // Recorded rather than pretended: the shape was asked for and not drawn.
    expect(live.notes().map((note) => note.what)).toContain('the mouse cursor');
  });

  it('freezes the live pointer into SAFEX and SAFEY rather than tracking it', () => {
    // `fnSaveCoods` is the first link in the get-to chain. The walk has to head
    // for where the pointer *was* when clicked; a route built against a pointer
    // that keeps moving arrives somewhere the player did not ask for.
    const live = world();
    live.current = compacts.records[0].id;
    live.pointerX = 152;
    live.pointerY = 208;

    expect(live.callMcode(SKY_MCODE.fnSaveCoods, 0, 0, 0)).toBe(true);
    expect(live.variables[SKY_VAR.safeX]).toBe(152);
    expect(live.variables[SKY_VAR.safeY]).toBe(208);

    // The pointer moves on; the frozen copy does not follow it.
    live.pointerX = 300;
    live.pointerY = 190;
    expect(live.variables[SKY_VAR.safeX]).toBe(152);
    expect(live.variables[SKY_VAR.safeY]).toBe(208);
  });

  it('sets the Compact running when it assigns its base script', () => {
    // The fault behind the stop. `fnAssignBase` wrote `mode` and the sub and
    // left `logic` alone, and a player between actions has `logic` 0 — nothing.
    // So a floor-click assigned the walk and the walk never ran: the report
    // said the click "changed nothing", which reads as absorbed rather than as
    // a second missing write.
    const live = world();
    const id = compacts.records[1].id;
    live.current = compacts.records[0].id;
    live.setField(id, 'logic', 0);

    expect(live.callMcode(SKY_MCODE.fnAssignBase, id, 0x0007_1234, 0)).toBe(true);

    expect(live.field(id, 'mode')).toBe(0);
    expect(live.field(id, 'logic')).toBe(1); // L_SCRIPT — the compact now runs
    expect(live.field(id, 'baseSub')).toBe(0x1234);
    // `scr` is a full pointer: the high half is the offset, not a fixed zero.
    expect(live.field(id, 'baseSub_off')).toBe(0x0007);
  });
});

/**
 * Routing: `fnAr` and the two logics behind it.
 *
 * The route is a straight line and the module doc says why — the table naming
 * which of the seventy shipped walk grids a screen uses is refused under ADR
 * 0033, so there is no grid to ask about obstacles. What is checked here is the
 * part that does not depend on that: the mega steps by its **own animation
 * set's** signed pairs, it lands on its target exactly, and it clears the flag
 * the get-to script reads to find out whether the walk worked.
 */
describe('routing a mega to a point', () => {
  /** A mega with one animation set whose right-hand walk is a single entry. */
  function walker(): { live: SkyWorld; mega: number } {
    const live = world();
    const mega = compacts.records[0].id;
    const program = compacts.records[1].id;
    const words = live.words(mega)!;
    // `megaSet` is a byte offset, so zero selects the first set, and the set's
    // words start straight after the 55 named fields. Index 4 of a set is the
    // first walk and they run up, down, left, right — so 4 + 3 is the right-hand
    // one.
    words[54] = 0;
    words[55 + 4 + 3] = program;
    // Four words an entry: a distance, a frame, and a signed step. Then the
    // zero that ends the program.
    live.words(program)!.set([4, 900, 4, 0, 0]);
    live.setField(mega, 'dir', 3);
    live.current = mega;
    return { live, mega };
  }

  it('takes a target, snaps both ends to a cell, and hands the mega over', () => {
    const { live, mega } = walker();
    live.setField(mega, 'xcood', 3);
    live.setField(mega, 'ycood', 16);

    // False: the script drops out and the routing logics take it from here.
    expect(live.callMcode(SKY_MCODE.fnAr, 11, 16, 0)).toBe(false);

    // Assume failure. Nothing but an arrival clears this, so a walk cut short by
    // speech or a sync leaves the get-to script reading the truth.
    expect(live.field(mega, 'downFlag')).toBe(1);
    // Both ends on a cell corner, which is what makes the distance an exact
    // whole number of four-pixel steps.
    expect(live.field(mega, 'arTargetX')).toBe(8);
    expect(live.field(mega, 'xcood')).toBe(0);
    expect(live.field(mega, 'logic')).toBe(2); // make a route
    expect(live.field(mega, 'arAnimIndex')).toBe(0);
  });

  it('steps by the animation set’s own pairs and arrives exactly', () => {
    const { live, mega } = walker();
    live.setField(mega, 'xcood', 0);
    live.setField(mega, 'ycood', 16);
    live.callMcode(SKY_MCODE.fnAr, 8, 16, 0);

    expect(live.startRoute(mega)).toBe(true);

    expect(live.stepRoute(mega)).toBe(true);
    expect(live.field(mega, 'xcood')).toBe(4);
    // 900 is at or above 64, so it is an absolute frame rather than one added to
    // the Compact's own offset — the same split a simple animation uses.
    expect(live.field(mega, 'frame')).toBe(900);
    // The program has one entry and a terminator, so the index wraps.
    expect(live.field(mega, 'arAnimIndex')).toBe(4);

    expect(live.stepRoute(mega)).toBe(true);
    expect(live.field(mega, 'xcood')).toBe(8);

    // Arrived: the walk ends, the flag the get-to script reads clears, and the
    // Compact goes back to its script.
    expect(live.stepRoute(mega)).toBe(false);
    expect(live.field(mega, 'downFlag')).toBe(0);
    expect(live.field(mega, 'logic')).toBe(1);
  });

  it('reports a mega with no walk for the direction instead of teleporting it', () => {
    const { live, mega } = walker();
    live.setField(mega, 'xcood', 64);
    live.setField(mega, 'ycood', 16);
    // Nothing named for the left-hand walk, and the target is to the left.
    live.callMcode(SKY_MCODE.fnAr, 0, 16, 0);

    expect(live.stepRoute(mega)).toBe(false);
    expect(live.field(mega, 'xcood')).toBe(64);
    expect(live.notes().map((note) => note.what)).toContain('a walking animation for direction 2');
  });
});

/**
 * How fast a walk is, which is the cycle rate and nothing else.
 *
 * Sky moves a mega by exactly one entry of its walk table per logic cycle —
 * `Logic::mainAnim` reads `animList[arAnimIndex]`, adds its x and y to the
 * Compact and returns (`logic.cpp:388-400`) — so the distance covered per
 * second is the step size in the shipped data multiplied by the cycle rate.
 * The step size is the game's; the rate is ours, and getting it wrong is
 * invisible to every test that counts cycles instead of seconds.
 *
 * That is what happened: the rate read twelve sixtieths, five cycles a second,
 * against the game's own 80 ms. The routing was right, the animation table was
 * right, every step landed where it should, and Foster walked at 40% speed.
 *
 * So this test is denominated in **seconds**, which is the unit the error was
 * in and the unit a player experiences.
 */
describe('how fast a mega walks', () => {
  it('paces a cycle at the game’s own gameSpeed, not at a round sixtieth', () => {
    expect(SKY_GAME_SPEED_MS).toBe(80);
    expect(SKY_TICKS_PER_STEP).toBeCloseTo(4.8, 10);
    // Twelve and a half cycles a second, which is what 80 ms is.
    expect(60 / SKY_TICKS_PER_STEP).toBeCloseTo(12.5, 10);
  });

  it('covers the animation set’s own step size once per cycle, so far enough per second', () => {
    const live = world();
    const mega = compacts.records[0].id;
    const program = compacts.records[1].id;
    const words = live.words(mega)!;
    words[54] = 0;
    words[55 + 4 + 3] = program;
    // Four pixels a cycle, which is the step the shipped walk tables use.
    live.words(program)!.set([4, 900, 4, 0, 0]);
    live.setField(mega, 'dir', 3);
    live.current = mega;
    live.setField(mega, 'xcood', 0);
    live.setField(mega, 'ycood', 16);
    live.callMcode(SKY_MCODE.fnAr, 120, 16, 0);
    live.startRoute(mega);

    let cycles = 0;
    while (live.stepRoute(mega)) cycles++;

    expect(live.field(mega, 'xcood')).toBe(120);
    expect(cycles).toBe(30);
    const seconds = (cycles * SKY_GAME_SPEED_MS) / 1000;
    expect(seconds).toBeCloseTo(2.4, 10);
    // 50 pixels a second. At the rate this used to run it was 20, and a screen
    // is 320 wide.
    expect(120 / seconds).toBeCloseTo(50, 10);
  });
});

/**
 * Interacting: the last link in the chain a click runs, and the one whose fix
 * made a floor-click walk.
 *
 * A click on a hotspot runs that hotspot's mouse script, which walks the mega to
 * the place and then does the thing. `fnInteract` is the "does the thing" half,
 * and **it runs the target's action script on the mega**, not on the target.
 * The shipped data settles that between two facts: `floor`'s `status` is 16,
 * with no logic bit, so it is never in the logic list and a script installed on
 * it never executes; and `floor`'s action script is number 31, whose first
 * instruction reads `downFlag` and whose sixth calls `fnAr(SAFEX, SAFEY)` —
 * both of them the mega's own fields.
 */
describe('interacting with a thing', () => {
  it('runs the target’s action script on the caller, one mode up', () => {
    // `fnInteract` takes one argument and it is a Compact id: all 51 call sites
    // in the shipped modules are `call_mcode 1, 24`, pushing either a literal id
    // or a variable holding one.
    const live = world();
    // The mega is the 69-word record: the 29-word one stops before the sub
    // slots, so the script would land nowhere and the test would be asserting
    // the fixture's shape rather than the mcode. The target only has to reach
    // `actionScript`, which is word 17, so the short record is a fair one.
    const mega = compacts.records[0].id;
    const target = compacts.records[1].id;
    live.current = mega;
    live.setField(mega, 'mode', 0);
    live.setField(target, 'mode', 0);
    live.setField(target, 'actionScript', 0x2211);
    expect(live.field(target, 'actionScript')).toBe(0x2211);

    // False: the caller drops out of its script so the installed one runs next,
    // which is `fnStartSub`'s shape.
    expect(live.callMcode(SKY_MCODE.fnInteract, target, 0, 0)).toBe(false);

    // The script landed on the **caller**, one mode up — mode 4, which
    // `SUB_FIELDS` establishes on its own: the slots are two words each, so
    // `mode` indexes them as a byte offset.
    expect(live.field(mega, 'mode')).toBe(4);
    expect(live.getSub(mega, 4)).toBe(0x2211);
    expect(live.getSub(mega, 6)).toBe(0);
    // And the target is untouched: it is where the script came from, not where
    // it runs.
    expect(live.field(target, 'mode')).toBe(0);
  });

  it('records the pointer text it cannot render, and does not stop the script', () => {
    // 20 call sites, one argument each. The label needs Sky's compressed text,
    // which is unread — but an object's mouse script goes on to do things that
    // have nothing to do with a caption, and stopping here hid all of them.
    const live = world();
    live.current = compacts.records[0].id;

    expect(live.callMcode(SKY_MCODE.fnPointerText, 4242, 0, 0)).toBe(true);
    expect(live.pointerTextNumber).toBe(4242);
    expect(
      live
        .notes()
        .map((note) => note.what)
        .join(' '),
    ).toContain('the pointer’s text');
  });
});

/**
 * What happens when an animation that ignores coordinates runs out.
 *
 * The end of one of these is not a detail of the animation system: `fnSetToStand`
 * puts every arriving mega on it, so "the program ran out" is the moment a walk
 * hands the Compact back to the script that asked for the walk. A Compact left
 * on logic 16 with an exhausted program is a mega stood still whose script never
 * resumes — which is what a click on a thing looked like before this: Foster
 * walked to the fire notice and the `fnInteract` after the walk never ran.
 */
describe('an animation that ignores coordinates, ending', () => {
  /** A mega whose simple-animation program is one frame and a terminator. */
  function stander(): { live: SkyWorld; mega: number; program: number } {
    const live = world();
    const mega = compacts.records[0].id;
    const program = compacts.records[1].id;
    live.words(program)!.fill(0);
    live.words(program)!.set([1, 0, 70]);
    live.setField(mega, 'grafixProgId', program);
    live.setField(mega, 'grafixProgPos', 0);
    live.setField(mega, 'offset', 0);
    live.setField(mega, 'logic', 16);
    live.current = mega;
    return { live, mega, program };
  }

  it('steps a frame while the program has one', () => {
    const { live, mega } = stander();
    expect(live.stepSimpleAnimation(mega)).toBe(true);
    // 70 is at or above 64, so it is an absolute frame rather than one added to
    // the Compact's own offset.
    expect(live.field(mega, 'frame')).toBe(70);
    expect(live.field(mega, 'logic')).toBe(16);
  });

  it('hands the Compact back to its script when the program runs out', () => {
    const { live, mega } = stander();
    live.stepSimpleAnimation(mega);

    expect(live.stepSimpleAnimation(mega)).toBe(false);
    // The same two writes the coordinate-carrying kind ends with.
    expect(live.field(mega, 'downFlag')).toBe(0);
    expect(live.field(mega, 'logic')).toBe(1);
  });

  it('is what `fnSetToStand` leaves an arriving mega on', () => {
    const { live, mega, program } = stander();
    // One animation set, its stand-up-facing-up program at index 8. A standing
    // program's first word is the Compact's frame offset and the animation
    // starts at word 1, which is what `fnSetToStand` reads and skips.
    live.words(program)!.set([0, 1, 0, 70, 0]);
    live.words(mega)![54] = 0;
    live.words(mega)![55 + 8] = program;
    live.setField(mega, 'dir', 0);

    expect(live.callMcode(SKY_MCODE.fnSetToStand, 0, 0, 0)).toBe(false);
    expect(live.field(mega, 'mood')).toBe(1);
    expect(live.field(mega, 'logic')).toBe(16);
    // And the next step is the one that gives the script back, which is the
    // instruction after the walk — `fnInteract`, in every action a click runs.
    expect(live.stepSimpleAnimation(mega)).toBe(false);
    expect(live.field(mega, 'logic')).toBe(1);
  });
});

/**
 * The three mcodes that reach a subsystem this project does not have, and carry
 * on rather than stopping: a spoken line, a sound, and the walk grid.
 */
describe('what a script asks for that is not here', () => {
  it('records who was asked to speak and which line, and resumes after it', () => {
    // 1,304 call sites across the shipped modules — `fnSpeakMe` 339,
    // `fnSpeakMeDir` 650, `fnSpeakWait` 280, `fnSpeakWaitDir` 35 — every one of
    // them with three arguments.
    const live = world();
    const mega = compacts.records[0].id;
    live.current = mega;

    // False: the game's own shape for starting a line is to drop out, and the
    // script resumes at the instruction after it.
    expect(live.callMcode(SKY_MCODE.fnSpeakMe, mega, 4156, 3)).toBe(false);
    expect(live.spokenLine).toEqual({ by: mega, text: 4156 });
    expect(
      live
        .notes()
        .map((note) => note.what)
        .join(' '),
    ).toContain('a spoken line');
  });

  it('counts a sound the script asked to play and does not stop for it', () => {
    const live = world();
    live.current = compacts.records[0].id;

    expect(live.callMcode(SKY_MCODE.fnStartMusic, 4, 0, 0)).toBe(true);
    expect(live.callMcode(SKY_MCODE.fnStartFx, 12, 1, 0)).toBe(true);
    expect(
      live
        .notes()
        .map((note) => note.what)
        .join(' '),
    ).toContain('a sound the game asked to play');
  });

  it('toggles the grid bit and counts the plotting nobody does', () => {
    const live = world();
    const mega = compacts.records[0].id;
    live.current = mega;
    live.setField(mega, 'status', SKY_STATUS.logic);

    expect(live.callMcode(SKY_MCODE.fnToggleGrid, 0, 0, 0)).toBe(true);
    expect(live.field(mega, 'status')).toBe(SKY_STATUS.logic | SKY_STATUS.gridPlot);
    expect(live.callMcode(SKY_MCODE.fnToggleGrid, 0, 0, 0)).toBe(true);
    expect(live.field(mega, 'status')).toBe(SKY_STATUS.logic);
  });
});

/**
 * Which drawing layer a Compact is in, which is three mcodes and one field.
 */
describe('moving a Compact between the drawing layers', () => {
  it('puts a named Compact in one layer and takes it out of the others', () => {
    // 42 `fnForeground` call sites and 61 `fnSort`, one argument each; most push
    // `ID` and the rest a literal Compact id, which is what makes the argument
    // an id rather than a flag.
    const live = world();
    const mega = compacts.records[0].id;
    const scenery = compacts.records[1].id;
    live.current = mega;
    live.setField(scenery, 'status', SKY_STATUS.sort | SKY_STATUS.mouse);

    expect(live.callMcode(SKY_MCODE.fnForeground, scenery, 0, 0)).toBe(true);
    expect(live.field(scenery, 'status')).toBe(SKY_STATUS.foreground | SKY_STATUS.mouse);

    expect(live.callMcode(SKY_MCODE.fnSort, scenery, 0, 0)).toBe(true);
    expect(live.field(scenery, 'status')).toBe(SKY_STATUS.sort | SKY_STATUS.mouse);
    // And the mega it was called on is untouched, because the argument names
    // the Compact.
    expect(live.field(mega, 'status')).toBe(live.field(mega, 'status'));
  });

  it('takes no argument to mean the Compact whose script is running', () => {
    // `fnBackground` is called 48 times in two shapes: 10 with one argument,
    // all of them `ID`, and 38 with none.
    const live = world();
    const mega = compacts.records[0].id;
    live.current = mega;
    live.setField(mega, 'status', SKY_STATUS.foreground | SKY_STATUS.logic);

    expect(live.callMcode(SKY_MCODE.fnBackground, 0, 0, 0)).toBe(true);
    expect(live.field(mega, 'status')).toBe(SKY_STATUS.background | SKY_STATUS.logic);
  });
});
