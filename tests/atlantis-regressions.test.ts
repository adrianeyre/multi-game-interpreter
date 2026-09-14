import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { OBJECT_CLASS, VAR } from '../src/engine/constants.js';
import { buildFixture, u16le } from './fixture.js';

/**
 * The faults a shipped v5 game found that the fixture alone could not.
 *
 * Every one of these is the class `docs/processes/verifying-version-support.md`
 * warns about: the fixture and the engine agreed with each other and disagreed
 * with Indiana Jones and the Fate of Atlantis. They are gathered here rather
 * than scattered, because what they have in common — a plausible reading of the
 * format that produces a plausible-looking wrong result — is the point.
 *
 * Tier 1 (`docs/processes/verifying-version-support.md`): each is checked
 * against the synthetic fixture, with the shipped game named as the evidence
 * that the reading was wrong before.
 */
async function booted() {
  const fixture = buildFixture();
  const source = new MemoryDataSource('fixture');
  source.set(fixture.indexName, fixture.index);
  source.set(fixture.dataName, fixture.data);
  const engine = await ScummEngine.create(source);
  engine.boot(0);
  return engine;
}

describe('object classes are numbered as the games number them', () => {
  /**
   * `Untouchable` is class 32, not 20. Class 20 is `NeverClip`, and reading it
   * as the touchability flag inverted the whole room: Atlantis's attic sets no
   * object's class 20, but the misread `DOBJ` filled the low three bytes with
   * 0x0f0f0f, so all fifteen of its objects tested untouchable at once.
   */
  it('puts Untouchable at 32 and Player at 31', () => {
    expect(OBJECT_CLASS.Untouchable).toBe(32);
    expect(OBJECT_CLASS.Player).toBe(31);
  });

  it('reads class 32 from bit 31, which only a 32-bit field has room for', async () => {
    const engine = await booted();

    engine.putClass(500, OBJECT_CLASS.Untouchable, true);
    expect(engine.getClass(500, OBJECT_CLASS.Untouchable)).toBe(true);
    // Nothing else moved with it.
    expect(engine.getClass(500, OBJECT_CLASS.NeverClip)).toBe(false);
    expect(engine.getClass(500, OBJECT_CLASS.Player)).toBe(false);
  });
});

describe('a message that names something', () => {
  /**
   * Escape `FF 06` is "the name of the object *or actor* in this variable".
   * Resolved as an actor alone, every object name in every message came out
   * empty — and Atlantis's attic names what the cursor is over through this
   * escape and nothing else, so the room read as containing nothing.
   */
  it('names an object, not only an actor', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);
    engine.variables[100] = 500;

    expect(engine.decodeMessage([0xff, 0x06, 100, 0])).toBe(engine.getObjectName(500));
    expect(engine.getObjectName(500)).not.toBe('');
  });

  it('names an actor when the number is one', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);
    const ego = engine.getActor(engine.variables[VAR.EGO]);
    ego!.name = 'Indy';
    engine.variables[100] = ego!.number;

    expect(engine.decodeMessage([0xff, 0x06, 100, 0])).toBe('Indy');
  });

  it('keeps naming an object the player has picked up', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);
    const name = engine.getObjectName(500);
    engine.pickupObject(500, 1);
    engine.startScene(0, null, 0);

    // The object's name lives in the room it came from, and the room is gone.
    expect(engine.getObjectName(500)).toBe(name);
  });
});

describe('startScript reads its flags from its own opcode', () => {
  /**
   * Bits 0x20 and 0x40 of the `startScript` opcode choose "survives freezing"
   * and "allow recursion". They have to be read *before* the argument list,
   * because reading the list overwrites the current opcode with each entry's
   * own byte and finishes on the 0xFF terminator — which has both bits set.
   *
   * Read afterwards, every script in every game started freeze-resistant, so a
   * cutscene froze nothing and the background scripts it exists to silence ran
   * straight through it. In Atlantis that is the script that reprints the name
   * under the cursor every frame, which held `VAR_HAVE_MSG` set for ever and
   * hung the first `waitForMessage` after the player fell through the attic
   * floor.
   */
  /**
   * Runs `startScript <opcode> 1, []` and reports the flags it asked for.
   *
   * Taken at the call rather than off the slot afterwards, because the script
   * it starts finishes within the same frame and its slot is recycled.
   */
  async function startedBy(opcode: number) {
    const fixture = buildFixture({ script2: [opcode, 1, 0xff, 0x00] });
    const source = new MemoryDataSource('flags');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);

    const asked: Array<{ script: number; freezeResistant: boolean; recursive: boolean }> = [];
    const scripts = engine.scripts;
    const original = scripts.runScript.bind(scripts);
    scripts.runScript = (script, freezeResistant, recursive, args) => {
      asked.push({ script, freezeResistant, recursive });
      return original(script, freezeResistant, recursive, args);
    };

    original(2, false, false, []);
    return asked.find((entry) => entry.script === 1);
  }

  it('starts a plain script that a cutscene can freeze', async () => {
    const slot = await startedBy(0x0a);
    expect(slot?.freezeResistant).toBe(false);
    expect(slot?.recursive).toBe(false);
  });

  it('honours the freeze-resistant bit when it really is set', async () => {
    const slot = await startedBy(0x2a);
    expect(slot?.freezeResistant).toBe(true);
    expect(slot?.recursive).toBe(false);
  });

  it('honours the recursive bit', async () => {
    const slot = await startedBy(0x4a);
    expect(slot?.freezeResistant).toBe(false);
    expect(slot?.recursive).toBe(true);
  });
});

describe('chainScript hands its slot over cleanly', () => {
  /**
   * `chainScript` kills the caller's slot and starts the chained script, which
   * takes the slot that was just freed — so the chained script has to come back
   * from its own `breakHere`, at its own offset, in a slot that used to belong
   * to something else.
   *
   * This is the shape of the fault a room change in Atlantis hit, not the fault
   * itself: that one needs a slot whose owner has changed *while the loop that
   * saves the program counter is still running*, which the fixture cannot yet
   * be made to produce. The guard for it is in `executeSlot`, and its evidence
   * is Tier 2 — room 2 of the shipped game, which had no control before it and
   * does after.
   */
  it('leaves the chained script running from its own start', async () => {
    const chained = [
      0x80, // breakHere, so the slot has to be resumed correctly
      0x1a,
      ...u16le(300),
      ...u16le(7), // VAR[300] = 7
      0x00, // stopObjectCode
    ];
    const fixture = buildFixture({
      bootScript: chained,
      // `chainScript 1, []`
      script2: [0x42, 1, 0xff],
    });
    const source = new MemoryDataSource('chain');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.variables[300] = 0;

    engine.scripts.runScript(2, false, false, []);
    // The chained script broke; the next frame has to resume it where it was.
    engine.step();

    expect(engine.variables[300]).toBe(7);
  });
});

describe('a line of speech keeps the font it was measured in', () => {
  /**
   * A script may change the current charset between printing a line and the
   * frames that show it, and Atlantis's title sequence does: the copyright
   * notice is laid out in charset 1 and, two hundred frames later, the credits
   * switch to charset 3 while it is still on screen. Drawn in whatever font
   * happens to be current, its lines were spaced for one font and drawn in
   * another — overlapping each other and running off the right of the screen.
   */
  it('draws it in the charset that was current when it was printed', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);

    engine.setCharsetResource(0);
    engine.showText({ ...engine.beginTextOptions(255), text: 'ABC' });
    const laidOut = engine.displayedTextForTest();
    expect(laidOut).toHaveLength(1);
    expect(laidOut[0].charset).toBe(0);

    // Whatever the scripts do next, the line still belongs to charset 0.
    engine.setCharsetResource(3);
    expect(engine.displayedTextForTest()[0].charset).toBe(0);
  });
});

describe('the room lights', () => {
  /**
   * Nobody else sets this. The interpreter owns the initial value
   * (`resetScummVars`) and a game changes it only when a room *is* dark.
   *
   * Left at zero — which is pitch dark — Atlantis answers "It's too dark to
   * see it." to every look, in every room, for the whole game. Its scripts
   * test the variable against zero and nothing finer, so what matters is that
   * it starts lit at all.
   */
  it('start lit, because nothing else will do it', async () => {
    const engine = await booted();

    expect(engine.variables[VAR.CURRENT_LIGHTS]).not.toBe(0);
    expect(engine.isLightOn()).toBe(true);
  });
});

describe('the verb panel', () => {
  /**
   * The original searches its verb slots from the last one down
   * (`findVerbAtPos`), and a game relies on it: Atlantis draws the frame
   * around its verb panel as an image verb created before any of the words and
   * covering the whole strip. Found first, it answers for every click in the
   * panel and none of the words can ever be pressed.
   */
  it('finds the newest verb under the point, not the oldest', async () => {
    const engine = await booted();
    const frame = engine.verbs.getOrCreate(1);
    frame.enabled = true;
    frame.bounds = { left: 0, top: 144, right: 320, bottom: 200 };

    const word = engine.verbs.getOrCreate(12);
    word.enabled = true;
    word.bounds = { left: 53, top: 173, right: 97, bottom: 183 };

    expect(engine.verbs.hitTest(57, 175)).toBe(12);
    // And the frame still answers where nothing overlaps it.
    expect(engine.verbs.hitTest(10, 190)).toBe(1);
  });

  /**
   * `saveRestoreVerbs` stashes a range of verbs and later brings them back.
   * The original keeps a second slot per saved verb and never touches the
   * first one's mode, so a verb that was off is off again afterwards.
   * Restoring everything as *on* switches on whatever the game had left
   * hidden — Atlantis keeps three unused slots in the right of its panel, and
   * they came back showing raw variables beside the inventory.
   */
  it('brings a hidden verb back hidden', async () => {
    const engine = await booted();
    const shown = engine.verbs.getOrCreate(3);
    const hidden = engine.verbs.getOrCreate(4);
    shown.enabled = true;
    hidden.enabled = false;

    engine.verbs.saveRange(3, 4, 1);
    expect(shown.enabled).toBe(false);
    expect(hidden.enabled).toBe(false);

    engine.verbs.restoreRange(3, 4, 1);
    expect(shown.enabled).toBe(true);
    expect(hidden.enabled).toBe(false);
  });
});

describe("an object's name", () => {
  /**
   * LucasArts pads a name with `@` so a script can write a longer one into the
   * same space later. The interpreter never shows the padding, and the glyph
   * is not blank in these fonts — left in, "urn@@@@@@@@" appears on the
   * sentence line and in every line of dialogue that names the object.
   */
  async function named(objectName: string) {
    const fixture = buildFixture({ objectName });
    const source = new MemoryDataSource('padded');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.startScene(1, null, 0);
    return engine.getObjectName(500);
  }

  /**
   * The padding turns up wherever the spare room was wanted, and Atlantis has
   * all three shapes: at the end, at the start, and in the middle where a count
   * goes.
   */
  it('drops the padding a game leaves room with', async () => {
    expect(await named('urn@@@@@@@@')).toBe('urn');
    expect(await named('@@@@@@@@coal')).toBe('coal');
    expect(await named('orichalcum (@@@@@ beads)')).toBe('orichalcum (beads)');
  });

  it('leaves a name that has none of it alone', async () => {
    expect(await named('ticket taker')).toBe('ticket taker');
  });
});

describe('a pseudo-room', () => {
  /**
   * A room number of 128 or more is a name for a place whose artwork is shared
   * with another room, resolved through the table `pseudoRoom` fills in. The
   * player's room stays the number the script asked for — its own scripts test
   * that — but the resource loaded is the one the table names.
   *
   * Unmapped, every one of them is a room the data file does not have.
   * Atlantis leans on them: walking through a door in a dozen rooms asks for
   * 130, 132, 141, 144 and on up to 226, and each was a dead end with "room is
   * missing from the data file" in the log.
   */
  it('loads the room its table names, and keeps the number it was asked for', async () => {
    const engine = await booted();
    // `pseudoRoom 1, [0x81]` — pseudo-room 129 is really room 1.
    engine.setPseudoRoom(1, 1);

    engine.startScene(0x81, null, 0);

    expect(engine.currentRoom).toBe(0x81);
    expect(engine.variables[VAR.ROOM]).toBe(0x81);
    expect(engine.variables[VAR.ROOM_RESOURCE]).toBe(1);
    // And the room's data really is there.
    expect(engine.currentRoomData).not.toBeNull();
    expect(engine.currentRoomData?.findObject(500)).toBeDefined();
  });

  it('leaves an ordinary room number alone', async () => {
    const engine = await booted();
    engine.setPseudoRoom(1, 1);

    engine.startScene(1, null, 0);

    expect(engine.variables[VAR.ROOM_RESOURCE]).toBe(1);
    expect(engine.currentRoomData).not.toBeNull();
  });

  it('says what it mapped to when the mapped room is missing', async () => {
    const messages: string[] = [];
    const fixture = buildFixture();
    const source = new MemoryDataSource('pseudo');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);
    const engine = await ScummEngine.create(source, { onLog: (m) => messages.push(m) });
    engine.boot(0);
    engine.setPseudoRoom(2, 42);

    engine.startScene(0x82, null, 0);

    expect(messages.some((m) => m.includes('maps to room 42'))).toBe(true);
  });
});

describe('the camera following an actor out of the room', () => {
  /**
   * `setCameraFollows` starts the scene when the actor it is handed is
   * somewhere else, and for a v5 game that is a room-change mechanism in its
   * own right: Atlantis drops Indy through the attic trapdoor with
   * `putActorInRoom`, places him, and hands the camera over. There is no
   * `loadRoom` anywhere in it. Without this the player left and the picture
   * stayed, which looks exactly like a game that has stopped.
   */
  it('changes room when the followed actor is somewhere else', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);
    const ego = engine.variables[VAR.EGO];

    engine.putActorInRoom(ego, 1);
    engine.startScene(0, null, 0);
    engine.actorFollowCamera(ego);

    expect(engine.currentRoom).toBe(1);
  });

  it('does not follow an actor parked in room 0, which is nowhere', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);
    const ego = engine.variables[VAR.EGO];

    // The idiom for hiding an actor mid-cutscene. Following it would blank the
    // screen the cutscene is playing on.
    engine.putActorInRoom(ego, 0);
    engine.actorFollowCamera(ego);

    expect(engine.currentRoom).toBe(1);
  });

  it('leaves the room alone when the actor is already in it', async () => {
    const engine = await booted();
    engine.startScene(1, null, 0);
    const ego = engine.variables[VAR.EGO];
    // A scene change does not move actors — the game's own scripts do — so the
    // ego has to be put here before "already in it" means anything.
    engine.putActorInRoom(ego, 1);

    engine.actorFollowCamera(ego);

    expect(engine.currentRoom).toBe(1);
  });
});
