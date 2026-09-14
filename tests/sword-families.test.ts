import { describe, expect, it } from 'vitest';
import {
  identifySword1,
  looksLikeSword1,
  SWORD1_RELEASES,
} from '../src/engine/sword1/resource/swordDetect.js';
import {
  identifySword2,
  looksLikeSword2,
  refineSword2Release,
  SWORD2_RELEASES,
} from '../src/engine/sword2/resource/sword2Detect.js';
import { identifyForeignEngine } from '../src/engine/resource/engineSignatures.js';
import {
  IMPLEMENTED_FAMILIES,
  describeImplementedFamilies,
} from '../src/engine/resource/families.js';
import { describeTarget, parseTarget, sameTarget, type Target } from '../src/authoring/target.js';
import { Sword2Engine } from '../src/engine/sword2/Sword2Engine.js';
import { SV2, SWORD2_CUR_PLAYER_ID } from '../src/engine/sword2/script/sword2Vars.js';
import { Sword2Logic } from '../src/engine/sword2/script/Sword2Logic.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import type { SavedGameEnvelope } from '../src/engine/AdventureEngine.js';
import {
  buildSword2Fixture,
  buildSword2Globals,
  buildSword2Anim,
  buildSword2Object,
  buildSword2ScreenManager,
  buildSword2RunList,
  buildSword2Screen,
  buildSword2Text,
  sword2Header,
} from './fixtureSword.js';
import { CP } from '../src/engine/sword2/script/sword2Tokens.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { Sword2FileType } from '../src/engine/sword2/resource/sword2Headers.js';

/** The mounted demo's `resource.inf`, in its own order and its own casing. */
const DEMO_CLUSTERS = [
  'SCRIPTS.CLU',
  'Pyramid2.clu',
  'General.clu',
  'Carib1.clu',
  'Carib2.clu',
  'Pyramid1.clu',
  'Carib3.clu',
  'Players.clu',
  'Warehous.clu',
  'Paris.clu',
  'Jungle.clu',
  'Quaramon.clu',
  'Docks.clu',
  'TEXT.CLU',
] as const;

/** A 16-bit script operand, little endian, as the interpreter reads one. */
function i16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

/** `CP.PUSH_INT32` and the four little-endian bytes of its operand. */
function i32Push(value: number): number[] {
  return [
    CP.PUSH_INT32,
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

describe('detection', () => {
  it('claims Broken Sword on its index plus a cluster, never on either alone', () => {
    expect(looksLikeSword1(['clusters/swordres.rif', 'clusters/general.clu'])).toBe(true);
    expect(looksLikeSword1(['clusters/swordres.rif'])).toBe(false);
    expect(looksLikeSword1(['clusters/general.clu'])).toBe(false);
  });

  it('accepts the Macintosh release’s .CLM extension', () => {
    expect(looksLikeSword1(['swordres.rif', 'GENERAL.CLM'])).toBe(true);
  });

  it('claims Broken Sword II on both index files, never on general.clu', () => {
    // `general.clu` was the old foreign-engine signature and *both* games ship
    // one, which is the mis-detection the index-file rule exists to prevent.
    expect(looksLikeSword2(['resource.inf', 'resource.tab'])).toBe(true);
    expect(looksLikeSword2(['general.clu'])).toBe(false);
    expect(looksLikeSword2(['resource.inf'])).toBe(false);
  });

  it('does not confuse the two games in a folder holding both', () => {
    const both = ['swordres.rif', 'general.clu', 'resource.inf', 'resource.tab'];
    expect(looksLikeSword1(both)).toBe(true);
    expect(looksLikeSword2(both)).toBe(true);
    // The order in `loadEngine` decides, and Sword1's index is the more exact
    // evidence — but the point is that neither claims on a shared file name.
  });

  // The platform used to be the constant word "DOS" in `targetName`, which made
  // the Macintosh demo on scummvm.org/demos announce itself as DOS and the
  // PlayStation one as "psx release, DOS". It is evidence now, and a folder
  // whose files do not say is not called anything.
  it('names the platform its files state, and abstains when they do not', () => {
    expect(identifySword1(['swordres.rif', 'paris1.clu', 'ppc.inf']).platform).toBe('macintosh');
    expect(identifySword1(['swordres.rif', 'speech.inf']).platform).toBe('playstation');
    expect(identifySword1(['swordres.rif', 'paris2.clu', 'dos4gw.exe']).platform).toBe('dos');
    expect(identifySword1(['swordres.rif', 'paris2.clu', 'sword.exe']).platform).toBe('dos');

    // Clusters alone are not evidence of a platform. This is the case the old
    // constant got wrong: it called every such folder DOS.
    expect(identifySword1(['swordres.rif', 'paris2.clu']).platform).toBe('unknown');

    // The PlayStation platform and the psx Release rest on the same file, so
    // they agree by construction rather than by coincidence.
    const psx = identifySword1(['swordres.rif', 'speech.inf']);
    expect(psx.release).toBe('psx');
    expect(psx.platform).toBe('playstation');
  });

  it('names each Release from a file only that Release ships', () => {
    expect(identifySword1(['swordres.rif', 'paris2.clu'])).toMatchObject({
      release: 'cd',
      identification: 'shipped-files',
    });
    expect(identifySword1(['swordres.rif', 'paris1.clu', 'cows.mad', 'enddemo.smk'])).toMatchObject(
      { release: 'demo', identification: 'shipped-files' },
    );
    // The absence argument this used to make: PARIS1 and nothing after it. A
    // retail CD1-only install looks exactly like that, so it is no longer read
    // as the demo.
    expect(identifySword1(['swordres.rif', 'paris1.clu']).release).toBe('cd');
    // One half rather than two still identifies, and says so in its evidence.
    expect(identifySword1(['swordres.rif', 'paris1.clu', 'cows.mad'])).toMatchObject({
      release: 'demo',
    });
    expect(identifySword1(['swordres.rif', 'paris1.clu', 'cows.mad']).evidence).toMatch(
      /one half rather than two/,
    );
    expect(identifySword1(['swordres.rif', 'english/speech.inf'])).toMatchObject({
      release: 'psx',
    });
    expect(identifySword1(['swordres.rif', 'other.clu']).identification).toBe('fallback');
  });

  it('names the PlayStation Sword2 by a pair, not by an absence', () => {
    expect(identifySword2(['resource.inf', 'resource.tab', 'screens.clu'])).toMatchObject({
      release: 'psx',
    });
    expect(identifySword2(['resource.inf', 'resource.tab', 'cd.inf', 'speech2.clu'])).toMatchObject(
      { release: 'cd' },
    );
  });

  it('narrows a Sword2 Release from what the index names, not how much', () => {
    const guessed = identifySword2(['resource.inf', 'resource.tab', 'cd.inf']);
    expect(guessed.identification).toBe('fallback');
    // The mounted demo's own `resource.inf`, verbatim. Fourteen clusters — more
    // than the `< 12` count this used to test — and not a speech or music
    // cluster among them, because a demo's index still names the regions of the
    // game it was cut from.
    expect(refineSword2Release(guessed, DEMO_CLUSTERS)).toMatchObject({
      release: 'demo',
      identification: 'index-structure',
    });
    expect(DEMO_CLUSTERS).toHaveLength(14);
    expect(
      refineSword2Release(guessed, [...DEMO_CLUSTERS, 'Speech1.clu', 'Music1.clu']).release,
    ).toBe('cd');
  });

  it('does not read the demo’s docks section as a retail region cluster', () => {
    // `docks.clu` was read as "a region cluster no demo ships" and the demo is
    // the docks section, so every demo folder was called retail — and because
    // the claim was `shipped-files` the refinement above returned early rather
    // than correcting it.
    const found = identifySword2([
      'resource.inf',
      'resource.tab',
      'cd.inf',
      'Docks.clu',
      'General.clu',
      'SCRIPTS.CLU',
      'Enddemo.smk',
    ]);
    expect(found).toMatchObject({ release: 'demo', identification: 'shipped-files' });
    expect(refineSword2Release(found, DEMO_CLUSTERS).release).toBe('demo');
  });

  it('has retired both games from the foreign-engine table', () => {
    expect(identifyForeignEngine(['swordres.rif'])).toBeNull();
    expect(identifyForeignEngine(['general.clu'])).toBeNull();
    // Broken Sword 2.5 is a different engine and stays refused.
    expect(identifyForeignEngine(['data.b25c'])?.engine).toBe('Sword25');
  });

  it('names both families in the message a refused dump gets', () => {
    expect(IMPLEMENTED_FAMILIES).toContain('Sword1');
    expect(IMPLEMENTED_FAMILIES).toContain('Sword2');
    expect(describeImplementedFamilies()).toMatch(/Sword1 and Sword2$/);
  });
});

describe('the Target', () => {
  it('writes each family with its own name and Release', () => {
    expect(describeTarget({ engine: 'sword1', release: 'cd', platform: 'dos' })).toBe(
      'Sword1 (cd)',
    );
    expect(describeTarget({ engine: 'sword2', release: 'demo', platform: 'dos' })).toBe(
      'Sword2 (demo)',
    );
  });

  it('round-trips through JSON, and refuses a Release that is not one', () => {
    for (const engine of ['sword1', 'sword2'] as const) {
      const releases = engine === 'sword1' ? SWORD1_RELEASES : SWORD2_RELEASES;
      for (const release of releases) {
        const target = { engine, release, platform: 'dos', identification: 'shipped-files' };
        expect(parseTarget(JSON.parse(JSON.stringify(target)))).toMatchObject(target);
      }
      expect(parseTarget({ engine, release: 'floppy', platform: 'dos' })).toBeNull();
      expect(parseTarget({ engine, release: 'cd', platform: 'amiga' })).toBeNull();
    }
  });

  it('treats the two families as different Targets, never as one game’s Releases', () => {
    const one: Target = { engine: 'sword1', release: 'cd', platform: 'dos' };
    const two: Target = { engine: 'sword2', release: 'cd', platform: 'dos' };
    expect(sameTarget(one, two)).toBe(false);
    expect(sameTarget(one, { ...one })).toBe(true);
    expect(sameTarget(one, { ...one, release: 'demo' })).toBe(false);
  });
});

describe('Broken Sword II end to end', () => {
  function install(
    options: {
      retail?: boolean;
      human?: boolean;
      noHuman?: boolean;
      clickable?: boolean;
      /** An object that draws a mega frame and asks for the shape it drew. */
      sprite?: boolean;
      /** The same object with `fnNoSprite` in place of `fnSortSprite`. */
      hidden?: boolean;
      /** An object that runs `fnInitFloorMouse` and then registers the result. */
      floor?: boolean;
      /** A mouse area whose pointer field is zero, which is "switched off". */
      switchedOff?: boolean;
      /** A transparent square in the background, so a packeted row is read. */
      hole?: boolean;
      /** A mask layer over the sprite's rectangle, drawn back in front of it. */
      maskLayer?: boolean;
      /**
       * How the player waits for an interaction, and — for the first two — a
       * clickable object with a script 2 for the click to reach.
       *
       *  * `pause` loops in `fnPauseForEvent`, which is what a mega standing
       *    still runs.
       *  * `poll` pauses a cycle at a time and asks `fnCheckForEvent`, which is
       *    the other half of the same mechanism and a different return path.
       *  * `sent` never picks the event up: it watches one arrive from
       *    `fnSendEvent` and then throws it away with `fnClearEvent`.
       */
      event?: 'pause' | 'poll' | 'sent';
    } = {},
  ) {
    const script = [CP.PUSH_INT32, 1, 0, 0, 0, CP.POP_GLOBAL_VAR32, 62, 0, CP.QUIT, CP.END_SCRIPT];
    // The same script, plus `fnUpdatePlayerStats` (31): the opcode is handed
    // the address of the object's own `ObjectMega`, and copies the feet and
    // the facing out of it into the globals the rest of the game reads. So the
    // fixture fills the mega — feet at 32 and 36, direction at 40 — and lets
    // the opcode do the copying, which is the thing under test.
    const humanBody = [
      ...i32Push(300),
      CP.POP_LOCAL_VAR32,
      ...i16(32),
      ...i32Push(400),
      CP.POP_LOCAL_VAR32,
      ...i16(36),
      ...i32Push(4),
      CP.POP_LOCAL_VAR32,
      ...i16(40),
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(31),
      1,
      ...i32Push(1),
      CP.POP_GLOBAL_VAR32,
      ...i16(62),
    ];
    const humanScript = [...humanBody, CP.QUIT, CP.END_SCRIPT];
    /**
     * The same player, standing still the way a Sword2 player stands still.
     *
     * Nothing in this game polls the mouse: the player's own logic loops in
     * `fnPauseForEvent`, and the event the mouse sends is what ends the loop.
     * `CP_SAVE_MCODE_START` is what a compiled script puts before a repeating
     * mcode, and without it `IR_REPEAT` would resume at byte 0 rather than at
     * the pause.
     *
     * The logic structure lives past the fourteen words of `ObjectMega`, at
     * byte 56, so the two do not overlap.
     */
    const pauseForEventScript = [
      ...humanBody,
      CP.SAVE_MCODE_START,
      CP.PUSH_LOCAL_ADDR,
      ...i16(56),
      ...i32Push(1000),
      CP.CALL_MCODE,
      ...i16(85), // fnPauseForEvent
      2,
      CP.END_SCRIPT,
    ];
    /**
     * The other way in: a one-cycle `fnPause`, then `fnCheckForEvent`, then
     * round again.
     *
     * `fnPauseForEvent` returns `IR_TERMINATE` from inside a pause it was
     * already looping in; `fnCheckForEvent` returns `IR_CONT` when there is
     * nothing and `IR_TERMINATE` when there is. A version that only handled
     * one of the two would leave half the game's characters deaf.
     */
    const checkForEventScript = [
      ...humanBody,
      CP.SAVE_MCODE_START,
      CP.PUSH_LOCAL_ADDR,
      ...i16(56),
      ...i32Push(1),
      CP.CALL_MCODE,
      ...i16(21), // fnPause
      2,
      CP.CALL_MCODE,
      ...i16(84), // fnCheckForEvent
      0,
      CP.RESTART_SCRIPT,
      CP.END_SCRIPT,
    ];
    /**
     * A player that only watches: is an event waiting, throw it away, is one
     * waiting now.
     *
     * Both answers come from the same opcode with only `fnClearEvent` between
     * them, so "1 then 0" is the list working and either constant answer is it
     * not. The lever re-sends every cycle and runs after the player in the run
     * list, so the pair is the same every cycle.
     */
    const observeEventScript = [
      ...humanBody,
      CP.CALL_MCODE,
      ...i16(50), // fnCheckEventWaiting
      0,
      CP.PUSH_GLOBAL_VAR32,
      ...i16(1), // SV2.RESULT
      CP.POP_GLOBAL_VAR32,
      ...i16(65),
      CP.CALL_MCODE,
      ...i16(86), // fnClearEvent
      0,
      CP.CALL_MCODE,
      ...i16(50),
      0,
      CP.PUSH_GLOBAL_VAR32,
      ...i16(1),
      CP.POP_GLOBAL_VAR32,
      ...i16(66),
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    /**
     * What a click is supposed to reach: script **2** of the thing clicked.
     *
     * It writes `ID` — the object whose logic is running — so the test can see
     * that the *player* ran the lever's code, which is the whole shape of an
     * interaction in this engine, and a marker so "did not run" and "ran and
     * wrote zero" are different answers.
     */
    const interactionScript = [
      CP.PUSH_GLOBAL_VAR32,
      ...i16(0), // SV2.ID
      CP.POP_GLOBAL_VAR32,
      ...i16(63),
      ...i32Push(42),
      CP.POP_GLOBAL_VAR32,
      ...i16(64),
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    // `fnNoHuman` (37): the script takes the pointer away, which is what every
    // cutscene and every conversation in the game does.
    const noHumanScript = [
      CP.CALL_MCODE,
      ...i16(37),
      0,
      ...i32Push(1),
      CP.POP_GLOBAL_VAR32,
      ...i16(62),
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    // An object that asks for a piece of the screen, which is all
    // `fnRegisterMouse` (8) does. The opcode is handed the *address* of six
    // words in the object's own locals — x1, y1, x2, y2, priority, pointer —
    // so the script fills them first and pushes the address second.
    const mouseArea = [
      ...i32Push(100),
      CP.POP_LOCAL_VAR32,
      ...i16(0),
      ...i32Push(50),
      CP.POP_LOCAL_VAR32,
      ...i16(4),
      ...i32Push(200),
      CP.POP_LOCAL_VAR32,
      ...i16(8),
      ...i32Push(150),
      CP.POP_LOCAL_VAR32,
      ...i16(12),
      ...i32Push(1),
      CP.POP_LOCAL_VAR32,
      ...i16(16),
      ...i32Push(7),
      CP.POP_LOCAL_VAR32,
      ...i16(20),
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(8),
      1,
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    /**
     * The same area, with `fnSendEvent(8, script 1 of me)` in front of it.
     *
     * `sendEvent` is how anything other than the mouse starts an interaction —
     * a conversation, a sequence, one character asking another to move — and it
     * names any script, not just script 2.
     */
    const senderArea = [
      ...i32Push(8),
      ...i32Push((10 << 16) | 1),
      CP.CALL_MCODE,
      ...i16(81), // fnSendEvent
      2,
      ...mouseArea,
    ];
    /**
     * A mega that draws a frame and asks for the shape of it.
     *
     * The locals are laid out the way a shipped object's are: an `ObjectMouse`
     * at 0 (six words), an `ObjectGraphic` at 24 (three words) and an
     * `ObjectMega` at 36 (fourteen words, so `MEGA.SCALE_A` is byte 60,
     * `SCALE_B` 64, `FEET_X` 68 and `FEET_Y` 72). The script fills all three,
     * sets the sprite's list with `fnSortSprite`, names its pointer text, and
     * then calls `fnRegisterFrame(&mouse, &graphic, &mega)` — which is the
     * order a service script does it in, and the reason the pointer text has
     * to be held until the registration that follows it.
     */
    const megaScript = (spriteOpcode: number) => [
      ...i32Push(5),
      CP.POP_LOCAL_VAR32,
      ...i16(16), // mouse priority
      ...i32Push(7),
      CP.POP_LOCAL_VAR32,
      ...i16(20), // mouse pointer
      ...i32Push(300),
      CP.POP_LOCAL_VAR32,
      ...i16(28), // graphic anim resource
      ...i32Push(0),
      CP.POP_LOCAL_VAR32,
      ...i16(32), // graphic anim pc
      ...i32Push(0),
      CP.POP_LOCAL_VAR32,
      ...i16(60), // mega scale A
      ...i32Push(65536),
      CP.POP_LOCAL_VAR32,
      ...i16(64), // mega scale B, so the scale works out at 1:1
      ...i32Push(100),
      CP.POP_LOCAL_VAR32,
      ...i16(68), // mega feet X
      ...i32Push(200),
      CP.POP_LOCAL_VAR32,
      ...i16(72), // mega feet Y
      CP.PUSH_LOCAL_ADDR,
      ...i16(24),
      CP.CALL_MCODE,
      ...i16(spriteOpcode),
      1,
      ...i32Push(77),
      CP.CALL_MCODE,
      ...i16(97), // fnRegisterPointerText
      1,
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.PUSH_LOCAL_ADDR,
      ...i16(24),
      CP.PUSH_LOCAL_ADDR,
      ...i16(36),
      CP.CALL_MCODE,
      ...i16(28), // fnRegisterFrame
      3,
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    // `fnInitFloorMouse` fills the structure it is handed and registers
    // nothing; the floor's own `fnRegisterMouse` is the call that puts it in
    // the list. Both are here because either one alone proves nothing.
    const floorScript = [
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(33), // fnInitFloorMouse
      1,
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(8), // fnRegisterMouse
      1,
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    // Everything `mouseArea` fills except the pointer, which stays zero.
    const switchedOffArea = [
      ...i32Push(10),
      CP.POP_LOCAL_VAR32,
      ...i16(0),
      ...i32Push(10),
      CP.POP_LOCAL_VAR32,
      ...i16(4),
      ...i32Push(300),
      CP.POP_LOCAL_VAR32,
      ...i16(8),
      ...i32Push(300),
      CP.POP_LOCAL_VAR32,
      ...i16(12),
      ...i32Push(1),
      CP.POP_LOCAL_VAR32,
      ...i16(16),
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(8),
      1,
      CP.QUIT,
      CP.END_SCRIPT,
    ];
    // The demo's start screen manager, at the id ScummVM's `startGame()` uses.
    // Its script 1 calls `fnSetSession(2)`, which is how the opening run list
    // comes out of the game instead of being guessed at by the engine.
    const startScript = [
      // fnInitBackground(70, 1) first, so the palette a harness reads is one a
      // background actually set.
      ...i32Push(70),
      ...i32Push(1),
      CP.CALL_MCODE,
      ...i16(3),
      2,
      ...i32Push(40),
      CP.CALL_MCODE,
      ...i16(4),
      1,
      CP.END_SCRIPT,
    ];
    // A decoy at a *lower* id than the session's own run list. Booting used to
    // scan the id table for the first RUN_LIST, and on the mounted demo that is
    // resource 2 — "Run list for 111", which lives in Players.clu and is not a
    // section. This object writes 99 rather than 1, so picking it is visible.
    const decoy = [CP.PUSH_INT32, 99, 0, 0, 0, CP.POP_GLOBAL_VAR32, 62, 0, CP.QUIT, CP.END_SCRIPT];
    const session = [
      8,
      ...(options.clickable || options.event ? [10] : []),
      ...(options.sprite || options.hidden ? [11] : []),
      ...(options.floor ? [12] : []),
      ...(options.switchedOff ? [13] : []),
    ];
    const fixture = buildSword2Fixture([
      {
        name: 'general.clu',
        resources: [
          { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'pointer', 0) },
          { id: 1, bytes: buildSword2Globals(new Array(1400).fill(0)) },
          { id: 2, bytes: buildSword2RunList([9]) },
          {
            id: 8,
            // Fourteen locals, which is `OBJECT_MEGA_SIZE` in words: the
            // structure `fnUpdatePlayerStats` is pointed at lives in them.
            bytes: buildSword2Object(
              'george',
              [
                options.event === 'pause'
                  ? pauseForEventScript
                  : options.event === 'poll'
                    ? checkForEventScript
                    : options.event === 'sent'
                      ? observeEventScript
                      : options.human
                        ? humanScript
                        : options.noHuman
                          ? noHumanScript
                          : script,
                [CP.END_SCRIPT],
              ],
              // Seventeen when the player waits on an event: fourteen of
              // `ObjectMega` and three more for the `ObjectLogic` the pause
              // counts down in.
              options.event ? 17 : 14,
              3,
              // George owns his own logic script. Without this the hub says
              // "object 0 owns my level-0 script", `runObject` goes looking for
              // a resource that is not an object, and the only thing that ever
              // runs is the service pass — which throws its result away, so a
              // script that terminates into an interaction terminates into
              // nothing.
              8,
            ),
          },
          {
            id: 70,
            bytes: buildSword2Screen(
              'lobby',
              640,
              480,
              3,
              options.hole ? { x: 300, y: 200, width: 40, height: 20 } : undefined,
              // Exactly over nico's 20x30 frame at 90,160, and its bottom edge
              // is her feet, which is the ordering test `applyMasks` makes.
              options.maskLayer ? { x: 90, y: 160, width: 20, height: 40, colour: 5 } : undefined,
            ),
          },
          { id: 9, bytes: buildSword2Object('decoy', [decoy, [CP.END_SCRIPT]]) },
          { id: 40, bytes: buildSword2RunList(session) },
          ...(options.clickable || options.event
            ? [
                {
                  id: 10,
                  bytes: buildSword2Object(
                    'lever',
                    options.event
                      ? [
                          options.event === 'sent' ? senderArea : mouseArea,
                          [CP.END_SCRIPT],
                          interactionScript,
                        ]
                      : [mouseArea, [CP.END_SCRIPT]],
                    6,
                    3,
                    10,
                  ),
                },
              ]
            : []),
          ...(options.sprite || options.hidden
            ? [
                {
                  id: 11,
                  // 23 words of locals: six for the mouse, three for the
                  // graphic, fourteen for the mega.
                  bytes: buildSword2Object(
                    'nico',
                    [megaScript(options.hidden ? 29 : 6), [CP.END_SCRIPT]],
                    23,
                    3,
                    11,
                  ),
                },
                // One 20x30 frame, placed ten left and forty up from the feet
                // that draw it — a `FRAME_OFFSET` entry, which is what every
                // walking animation in the game is.
                {
                  id: 300,
                  bytes: buildSword2Anim('nico.anim', [
                    { x: -10, y: -40, width: 20, height: 30, frameType: 1, colour: 9 },
                  ]),
                },
              ]
            : []),
          ...(options.floor
            ? [
                {
                  id: 12,
                  bytes: buildSword2Object('floor', [floorScript, [CP.END_SCRIPT]], 6, 3, 12),
                },
              ]
            : []),
          ...(options.switchedOff
            ? [
                {
                  id: 13,
                  bytes: buildSword2Object('dark', [switchedOffArea, [CP.END_SCRIPT]], 6, 3, 13),
                },
              ]
            : []),
          {
            id: 19,
            bytes: buildSword2ScreenManager('DOCKS SECTION START', [[CP.END_SCRIPT], startScript]),
          },
          // 949 as well, so the retail arm of the Release test below boots the
          // same way the demo arm does and the only difference is the Release.
          {
            id: 949,
            bytes: buildSword2ScreenManager('INTRO & PARIS START', [[CP.END_SCRIPT], startScript]),
          },
        ],
      },
      { name: 'text.clu', resources: [{ id: 9, bytes: buildSword2Text(['hello', 'again']) }] },
      // A speech cluster in the *index* is what makes a folder retail: a demo's
      // index still names the regions of the game it was cut from, so the
      // Release is read from what the index names rather than how much.
      ...(options.retail
        ? [
            {
              name: 'speech1.clu',
              resources: [{ id: 2000, bytes: sword2Header(Sword2FileType.WAV_FILE, 'speech', 0) }],
            },
          ]
        : []),
    ]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, bytes] of fixture.clusters) entries.push([name, bytes]);
    return new MemoryDataSource('sword2 fixture', entries);
  }

  /** One global, out of the save's byte-for-byte copy of the variable block. */
  function globalAt(engine: Sword2Engine, index: number): number {
    const bytes = (engine.saveState('probe') as unknown as { globals: number[] }).globals;
    const at = index * 4;
    return (
      ((bytes[at] as number) |
        ((bytes[at + 1] as number) << 8) |
        ((bytes[at + 2] as number) << 16) |
        ((bytes[at + 3] as number) << 24)) >>>
      0
    );
  }

  it('is claimed by the Sword2 family', async () => {
    const engine = await loadAdventureEngine(install(), { progress: new LoadProgressTracker() });
    expect(engine).toBeInstanceOf(Sword2Engine);
    expect(engine.targetName).toMatch(/^Sword2 /);
  });

  it('writes DEMO from the Release, which is a global only the engine can set', async () => {
    // `sword2.cpp:229` — `if (_features & ADGF_DEMO) writeVar(DEMO, 1) else
    // writeVar(DEMO, 0)`. The scripts branch on it and nothing in the shipped
    // data sets it, so an engine that leaves it at its zero tells every demo
    // script it is the retail game.
    const demo = await Sword2Engine.create(install());
    demo.boot();
    expect(demo.gameId).toBe('sword2-demo');
    expect(globalAt(demo, SV2.DEMO)).toBe(1);

    const retail = await Sword2Engine.create(install({ retail: true }));
    retail.boot();
    expect(retail.gameId).toBe('sword2-cd');
    // Written, not left: zero is also the uninitialised value, so the test
    // that matters is the demo one above and this one is the pair to it.
    expect(globalAt(retail, SV2.DEMO)).toBe(0);
  });

  it('reads its globals out of the game rather than from a table we carry', async () => {
    const engine = await Sword2Engine.create(install());
    engine.boot();
    expect(engine.describeStall().join('\n')).toMatch(/1400 script variables/);
  });

  it('runs a cycle over the run list and advances a global', async () => {
    const engine = await Sword2Engine.create(install());
    engine.boot();
    for (let tick = 0; tick < 5; tick++) {
      engine.step();
      await Promise.resolve();
    }
    // The script writes 1 into LOCATION, which is what `currentRoom` reports.
    expect(engine.currentRoom).toBe(1);
  });

  it('draws a room whose cluster arrived after the only script that asked for it', async () => {
    // The asynchronous seam this project has and ScummVM does not:
    // `openResource` there blocks, so a script can ask for a screen and get it
    // mid-cycle. Here the cluster load is a promise, so the ask misses — and
    // the ask that matters is made *once*, by the start-up screen manager,
    // which never runs again. Before the retry that room stayed black for the
    // whole session. This is what the mounted demo does: screen manager 19
    // calls `fnInitBackground(22)` and 22 lives in the 20 MB `Docks.clu`.
    const startScript = [
      // fnInitBackground(70, 1)
      CP.PUSH_INT32,
      70,
      0,
      0,
      0,
      CP.PUSH_INT32,
      1,
      0,
      0,
      0,
      CP.CALL_MCODE,
      3,
      0,
      2,
      // fnSetSession(60)
      CP.PUSH_INT32,
      60,
      0,
      0,
      0,
      CP.CALL_MCODE,
      4,
      0,
      1,
      CP.END_SCRIPT,
    ];
    const fixture = buildSword2Fixture([
      {
        name: 'general.clu',
        resources: [
          { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'pointer', 0) },
          { id: 1, bytes: buildSword2Globals(new Array(1400).fill(0)) },
          // `CUR_PLAYER_ID`, which is the *data* half of `runResObjScript`.
          { id: 8, bytes: buildSword2Object('george', [[CP.END_SCRIPT]], 4, 3, 8) },
          { id: 19, bytes: buildSword2ScreenManager('START', [[CP.END_SCRIPT], startScript]) },
        ],
      },
      {
        // Not resident, so the room's own resources arrive through the LRU —
        // which is to say, later than the script that asked for them.
        name: 'docks.clu',
        resources: [
          { id: 60, bytes: buildSword2RunList([61]) },
          { id: 61, bytes: buildSword2Object('room', [[CP.END_SCRIPT]], 4, 3, 61) },
          { id: 70, bytes: buildSword2Screen('docks', 700, 500) },
        ],
      },
      { name: 'text.clu', resources: [{ id: 9, bytes: buildSword2Text(['hi']) }] },
    ]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, bytes] of fixture.clusters) entries.push([name, bytes]);
    const engine = await Sword2Engine.create(new MemoryDataSource('late room', entries));
    engine.boot();
    // Nothing could be read at boot, so the room is the fallback 640x480.
    expect(engine.describeStall().join('\n')).toMatch(/640x480/);
    for (let tick = 0; tick < 6; tick++) {
      engine.step();
      engine.render();
      await Promise.resolve();
      await Promise.resolve();
    }
    // The screen is 700x500, so a room still 640x480 is one that never read
    // the resource, and a framebuffer of index 0 is a black screen.
    expect(engine.describeStall().join('\n')).toMatch(/700x500/);
    const lit = [...engine.screen.pixels].filter((index) => index !== 0).length;
    expect(lit).toBe(engine.screen.pixels.length);
  });

  it('files no fault for a cluster that is merely one cycle early', async () => {
    /*
     * The other half of the test above. Both the run list and the screen were
     * asked for before `docks.clu` was resident, both paths already retry, and
     * both filed a note anyway — into lists nothing clears. So the demo's
     * status line carried "run list 20 is in Docks.clu, which is not resident
     * yet" and "screen 22: … not resident yet" for the rest of the session,
     * describing two frames at the very start of a game that then ran for
     * three thousand more. A fault that heals itself and is reported for ever
     * is worse than no fault: it sends somebody to fix a working engine.
     */
    const startScript = [
      // fnInitBackground(70, 1)
      CP.PUSH_INT32,
      70,
      0,
      0,
      0,
      CP.PUSH_INT32,
      1,
      0,
      0,
      0,
      CP.CALL_MCODE,
      3,
      0,
      2,
      // fnSetSession(60)
      CP.PUSH_INT32,
      60,
      0,
      0,
      0,
      CP.CALL_MCODE,
      4,
      0,
      1,
      CP.END_SCRIPT,
    ];
    const fixture = buildSword2Fixture([
      {
        name: 'general.clu',
        resources: [
          { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'pointer', 0) },
          { id: 1, bytes: buildSword2Globals(new Array(1400).fill(0)) },
          { id: 8, bytes: buildSword2Object('george', [[CP.END_SCRIPT]], 4, 3, 8) },
          { id: 19, bytes: buildSword2ScreenManager('START', [[CP.END_SCRIPT], startScript]) },
        ],
      },
      {
        name: 'docks.clu',
        resources: [
          { id: 60, bytes: buildSword2RunList([61]) },
          { id: 61, bytes: buildSword2Object('room', [[CP.END_SCRIPT]], 4, 3, 61) },
          { id: 70, bytes: buildSword2Screen('docks', 700, 500) },
        ],
      },
      { name: 'text.clu', resources: [{ id: 9, bytes: buildSword2Text(['hi']) }] },
    ]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, bytes] of fixture.clusters) entries.push([name, bytes]);
    const engine = await Sword2Engine.create(new MemoryDataSource('late room', entries));
    engine.boot();
    for (let tick = 0; tick < 6; tick++) {
      engine.step();
      engine.render();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(engine.describeStall().join('\n')).toMatch(/700x500/);
    expect(engine.describeStall().join('\n')).not.toMatch(/not resident yet/);
  });

  it('does file one for a cluster this folder does not hold', async () => {
    // The control for the test above: same shape, `docks.clu` left out, and
    // the note has to survive — it is the difference between "wait" and "gone".
    const startScript = [
      // fnInitBackground(70, 1)
      CP.PUSH_INT32,
      70,
      0,
      0,
      0,
      CP.PUSH_INT32,
      1,
      0,
      0,
      0,
      CP.CALL_MCODE,
      3,
      0,
      2,
      // fnSetSession(60)
      CP.PUSH_INT32,
      60,
      0,
      0,
      0,
      CP.CALL_MCODE,
      4,
      0,
      1,
      CP.END_SCRIPT,
    ];
    const fixture = buildSword2Fixture([
      {
        name: 'general.clu',
        resources: [
          { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'pointer', 0) },
          { id: 1, bytes: buildSword2Globals(new Array(1400).fill(0)) },
          { id: 8, bytes: buildSword2Object('george', [[CP.END_SCRIPT]], 4, 3, 8) },
          { id: 19, bytes: buildSword2ScreenManager('START', [[CP.END_SCRIPT], startScript]) },
        ],
      },
      {
        name: 'docks.clu',
        resources: [
          { id: 60, bytes: buildSword2RunList([61]) },
          { id: 61, bytes: buildSword2Object('room', [[CP.END_SCRIPT]], 4, 3, 61) },
          { id: 70, bytes: buildSword2Screen('docks', 700, 500) },
        ],
      },
      { name: 'text.clu', resources: [{ id: 9, bytes: buildSword2Text(['hi']) }] },
    ]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, bytes] of fixture.clusters) {
      if (name !== 'docks.clu') entries.push([name, bytes]);
    }
    const engine = await Sword2Engine.create(new MemoryDataSource('no docks', entries));
    engine.boot();
    for (let tick = 0; tick < 6; tick++) {
      engine.step();
      engine.render();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(engine.describeStall().join('\n')).toMatch(/not in this folder/);
  });

  it('sizes the floor to the room, even when the room arrives after the floor', async () => {
    /*
     * `fnInitFloorMouse` writes `screen_wide - 1` and `screen_deep - 1` into
     * the floor's rectangle (`function.cpp:508-511`), and `screen_wide` is the
     * *background layer's* size (`screen.h:142`), not the display's. ScummVM
     * reads its resources synchronously, so by the time any floor script runs
     * the background has been read and that size is the room's.
     *
     * Here clusters arrive asynchronously, so the floor's script can run a
     * cycle before the screen resource is readable — and then the room is
     * still the fallback 640x480. The floor's script ends in `CP_QUIT`, so the
     * write happens once and is never revisited: the floor stayed 640x480 in
     * a 700x500 room, and the strip of room outside it answered no clicks at
     * all. On the mounted demo that is a 960x597 room with a 640x480 floor,
     * with George standing at 750,500 — outside his own floor, so the walk a
     * click asks for was never even attempted.
     */
    /*
     * The floor as the shipped scripts actually write one: `fnInitFloorMouse`
     * once, then a cycle-by-cycle loop that re-registers the area.
     *
     * The distinction is the whole test. A fixture that lets the script fall
     * off its end re-runs it from the top every cycle — `runObject` resets a
     * terminating level-0 script's pc — so the floor would be re-initialised
     * every cycle and would pick the new room size up on its own. The demo's
     * floor is called exactly once in 3000 frames, which is why the stale
     * rectangle there is permanent. `fnPauseForEvent` parks the script after
     * the initialisation, which is what the real one does and what makes the
     * one-shot write observable.
     */
    const floorScript = [
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(33), // fnInitFloorMouse — once, and never again
      1,
      CP.SAVE_MCODE_START,
      CP.PUSH_LOCAL_ADDR,
      ...i16(0),
      CP.CALL_MCODE,
      ...i16(8), // fnRegisterMouse — every cycle, from the structure above
      1,
      CP.PUSH_LOCAL_ADDR,
      ...i16(32),
      ...i32Push(1000),
      CP.CALL_MCODE,
      ...i16(85), // fnPauseForEvent, which repeats from SAVE_MCODE_START
      2,
      CP.END_SCRIPT,
    ];
    const startScript = [
      // fnInitBackground(70, 1), then fnSetSession(60) — the room resource and
      // the run list are both in the cluster that is not resident.
      ...i32Push(70),
      ...i32Push(1),
      CP.CALL_MCODE,
      ...i16(3),
      2,
      ...i32Push(60),
      CP.CALL_MCODE,
      ...i16(4),
      1,
      CP.END_SCRIPT,
    ];
    const fixture = buildSword2Fixture([
      {
        name: 'general.clu',
        resources: [
          { id: 0, bytes: sword2Header(Sword2FileType.MOUSE_FILE, 'pointer', 0) },
          { id: 1, bytes: buildSword2Globals(new Array(1400).fill(0)) },
          { id: 8, bytes: buildSword2Object('george', [[CP.END_SCRIPT]], 4, 3, 8) },
          { id: 19, bytes: buildSword2ScreenManager('START', [[CP.END_SCRIPT], startScript]) },
          // The session and its floor are *resident*, the way the demo's are:
          // it is only the screen resource that is in the cluster still
          // loading. So the floor's script runs on cycle one, while the room
          // is still the fallback — which is the ordering being tested, and
          // the one the mounted demo actually has.
          { id: 60, bytes: buildSword2RunList([61]) },
          { id: 61, bytes: buildSword2Object('floor', [floorScript, [CP.END_SCRIPT]], 20, 3, 61) },
        ],
      },
      {
        name: 'docks.clu',
        resources: [{ id: 70, bytes: buildSword2Screen('docks', 700, 500) }],
      },
      { name: 'text.clu', resources: [{ id: 9, bytes: buildSword2Text(['hi']) }] },
    ]);
    const entries: Array<[string, Uint8Array]> = [
      ['resource.inf', fixture.inf],
      ['resource.tab', fixture.tab],
      ['cd.inf', fixture.cdInf],
    ];
    for (const [name, bytes] of fixture.clusters) entries.push([name, bytes]);
    const engine = await Sword2Engine.create(new MemoryDataSource('late floor', entries));
    engine.boot();
    /*
     * Stepped to the cycle the room arrives on, and measured on the next one.
     *
     * The one cycle is the asynchronous retry's and not the floor's: a screen
     * whose cluster was late is re-read from `draw`, which runs *after*
     * `processSession`, so the cycle the room becomes known is a cycle whose
     * session has already run. From the following cycle the floor is derived
     * from a room that is known, and stays so.
     *
     * What is being pinned is that it is derived at all. Before this, the
     * rectangle was whatever the room measured during the single cycle
     * `fnInitFloorMouse` happened to run in, and on the demo that is one cycle
     * out of three thousand.
     */
    let arrived = -1;
    for (let tick = 0; tick < 8; tick++) {
      engine.step();
      engine.render();
      await Promise.resolve();
      await Promise.resolve();
      if (arrived < 0 && engine.describeStall().join('\n').includes('700x500')) arrived = tick;
      if (arrived >= 0 && tick > arrived) break;
    }
    expect(arrived).toBeGreaterThanOrEqual(0);
    const floor = engine.pointerTargets().find((target) => target.id === 61);
    // Display pixels, so the room's 0..699 by 0..499 less the scroll, which is
    // 0 here because nothing has scrolled. A floor that kept the fallback the
    // room was sized at before its resource arrived comes back 639 by 479.
    expect(floor).toBeDefined();
    expect({ right: floor!.right, bottom: floor!.bottom }).toEqual({ right: 699, bottom: 499 });
  });

  it('boots through its Release’s screen manager, not the first run list it finds', async () => {
    const engine = await Sword2Engine.create(install());
    engine.boot();
    const stall = engine.describeStall().join('\n');
    // ScummVM's `startGame()` runs script 1 of screen manager 19 for the demo
    // and 949 for retail (`sword2.cpp:552`), and that script calls
    // `fnSetSession` itself — so the opening run list comes out of the game.
    expect(stall).toMatch(/started through screen manager 19 onto run list 40/);
    for (let tick = 0; tick < 5; tick++) {
      engine.step();
      await Promise.resolve();
    }
    // 1 is the object the screen manager's session names; 99 is the decoy the
    // old first-RUN_LIST scan would have run instead.
    expect(engine.currentRoom).toBe(1);
  });

  it('no longer carries a caveat about an unimplemented walk router', async () => {
    const engine = await Sword2Engine.create(install());
    engine.boot();
    engine.step();
    const stall = engine.describeStall().join('\n');
    expect(stall).not.toMatch(/router is not implemented/);
    expect(stall).toMatch(/router: \d+ walk grids/);
  });

  it('saves and restores its globals, refusing another family’s save', async () => {
    const engine = await Sword2Engine.create(install());
    engine.boot();
    const saved = engine.saveState('slot');
    expect(() => engine.loadState(saved)).not.toThrow();
    expect(() => engine.loadState({ ...saved, gameId: 'sword1-cd' })).toThrow(/refused/);
    expect(() => engine.loadState({ ...saved, format: 99 })).toThrow(/format 99/);
  });

  it('opens an editable project whose objects re-emit byte-identically', async () => {
    const engine = await Sword2Engine.create(install());
    expect(engine.describeEditRefusal()).toBeNull();
    const editable = await engine.toEditableGame({ progress: new LoadProgressTracker() });
    const sword2 = editable!.project.sword2!;
    expect(sword2.objects.length).toBeGreaterThan(0);
    expect(sword2.objects.every((object) => object.roundTrips)).toBe(true);
    expect(sword2.editable.unrecovered).toBe(0);
    expect(sword2.globals.count).toBe(1400);
    expect(sword2.runLists.map((list) => list.objects)).toEqual([[9], [8]]);
    expect(sword2.text[0].lines).toEqual(['hello', 'again']);
  });

  it('names its own structure sizes, which are the format', () => {
    expect(Sword2Logic.structureSizes.objectHub).toBe(44);
    expect(Sword2Logic.structureSizes.objectMega).toBe(56);
    expect(Sword2Engine.resourceHeaderSize).toBe(44);
  });

  describe('what a harness may ask', () => {
    /**
     * Steps the engine, letting the event loop turn between frames.
     *
     * The turn is not optional: a session change starts an asynchronous cluster
     * read from inside a synchronous `step`, and a loop that never yields
     * leaves the engine on `loading` forever. `bin/play-probe.ts` awaits every
     * frame for the same reason, and a test written without it measures a game
     * that never got past its first session.
     */
    async function run(engine: Sword2Engine, frames: number): Promise<void> {
      for (let at = 0; at < frames; at++) {
        engine.step();
        engine.render();
        await new Promise((done) => setImmediate(done));
      }
    }

    it('says why the player is not in control, in the game’s own words', async () => {
      // `startGame` gives the mouse back after the start script runs
      // (`startup.cpp:174`), so the honest answer for a session nobody took it
      // away in is that nothing registered a mouse area — `fnRegisterMouse` is
      // what puts one there and this fixture has no object that calls it.
      const bare = await Sword2Engine.create(install());
      bare.boot();
      await run(bare, 6);
      expect(bare.describeNotInteractive()).toMatch(
        /nothing in session \d+ is asking for the mouse/,
      );

      // A script that calls `fnNoHuman`, which is what every cutscene does.
      const taken = await Sword2Engine.create(install({ noHuman: true }));
      taken.boot();
      await run(taken, 6);
      expect(taken.describeNotInteractive()).toMatch(/MOUSE_AVAILABLE is 0/);
    });

    it('reports the player’s feet from the globals the game keeps them in', async () => {
      const engine = await Sword2Engine.create(install({ human: true }));
      // Before boot nobody has said where the player is, and 0,0 would read as
      // the top-left corner rather than as silence.
      expect(engine.playerAt()).toBeNull();
      engine.boot();
      await run(engine, 6);
      expect(engine.playerAt()).toEqual({ x: 300, y: 400 });
      // `fnUpdatePlayerStats` copies the facing too, and hands the scripts the
      // scroll back — the one field of the four that travels engine to script
      // rather than the other way (`function.cpp:461-483`).
      expect(globalAt(engine, SV2.PLAYER_CUR_DIR)).toBe(4);
      expect(globalAt(engine, SV2.SCROLL_OFFSET_X)).toBe(0);
    });

    it('reads MOUSE_AVAILABLE as the flag the game sets, never as a guess', async () => {
      const bare = await Sword2Engine.create(install());
      bare.boot();
      await run(bare, 6);
      // Given by the boot, as `startGame` does, so that a game restarted while
      // a cutscene had the pointer is not left without one.
      expect(bare.mouseAvailable).toBe(true);
      // Nothing called `fnUpdatePlayerStats`, so nobody has said where the
      // player is and the globals are still their zero.
      expect(bare.playerAt()).toEqual({ x: 0, y: 0 });

      const taken = await Sword2Engine.create(install({ noHuman: true }));
      taken.boot();
      await run(taken, 6);
      expect(taken.mouseAvailable).toBe(false);
    });

    it('turns a synthetic press into the button global the scripts read', async () => {
      const engine = await Sword2Engine.create(install({ human: true }));
      engine.boot();
      await run(engine, 4);
      expect(globalAt(engine, SV2.LEFT_BUTTON)).toBe(0);

      // What a `pointerdown` over the canvas does, without a DOM. The shell's
      // handler calls the same method, so there is only one copy of the
      // mapping from a button to Revolution's globals.
      engine.input.x = 120;
      engine.input.y = 90;
      engine.input.pressButton('left');
      await run(engine, 1);
      expect(globalAt(engine, SV2.LEFT_BUTTON)).toBe(1);
      // The pointer is in room coordinates: display plus the scroll, with no
      // 128 origin and no menu bar. This screen does not scroll, so the two
      // are equal, and the conversion back in `pointerTargets` is its inverse.
      expect(globalAt(engine, SV2.MOUSE_X)).toBe(120);
      expect(globalAt(engine, SV2.MOUSE_Y)).toBe(90);

      // Drained, not held: the scripts read the global as "went down this
      // cycle", so a press that stayed set would be a click every frame.
      await run(engine, 1);
      expect(globalAt(engine, SV2.LEFT_BUTTON)).toBe(0);
    });

    it('hands a harness the palette the background set', async () => {
      const engine = await Sword2Engine.create(install({ human: true }));
      engine.boot();
      await run(engine, 6);
      // The fixture screen's palette is a grey ramp, so entry 100 is grey 100.
      // Read through the engine because that is where a harness has to read
      // it: the other four families keep the palette on the engine and both
      // Swords keep it on the renderer, so without this getter `pixels()` in
      // the probe would have to reach into a private field.
      expect(engine.palette.getColor(100)).toEqual([100, 100, 100]);
      // `rgba` is a lazily rebuilt cache, so the probe flushes before reading
      // it and so does this — a test that only checked `getColor` would pass
      // while every screenshot came out black.
      engine.palette.flush();
      expect([...engine.palette.rgba.slice(100 * 4, 100 * 4 + 4)]).toEqual([100, 100, 100, 255]);
    });

    it('hit-tests a click against the list the cycle just built', async () => {
      // `sword2.cpp:491-521`: `gameCycle` resets the mouse list *before* each
      // `processSession`, and `mouseEngine()` runs after it, on what the
      // service scripts left behind. Resetting afterwards instead — which is
      // what this engine did — means every click is tested against an empty
      // list, so `CLICKED_ID` is always 0 and nothing in either game can be
      // clicked. It is invisible from the outside: the scripts run, the screen
      // draws, and the pointer simply never touches anything.
      const engine = await Sword2Engine.create(install({ human: true, clickable: true }));
      engine.boot();
      await run(engine, 6);
      // 100..200 by 50..150 in room coordinates; this screen does not scroll,
      // so the middle of it is 150,100 on the display.
      expect(engine.pointerTargets()).toEqual([
        {
          id: 10,
          x: 150,
          y: 100,
          left: 100,
          top: 50,
          right: 200,
          bottom: 150,
          priority: 1,
          pointer: 7,
          pointerText: 0,
        },
      ]);
      expect(engine.describeNotInteractive()).toBeNull();

      engine.input.x = 150;
      engine.input.y = 100;
      engine.input.pressButton('left');
      await run(engine, 1);
      expect(globalAt(engine, SV2.CLICKED_ID)).toBe(10);

      // Outside the area the same press reports nothing, rather than leaving
      // the last thing clicked in place for a script to act on twice. Ten
      // pixels down would be the system menu rather than the room — the top
      // forty belong to the panel — so this is ten across and well below it.
      engine.input.x = 10;
      engine.input.y = 300;
      engine.input.pressButton('left');
      await run(engine, 1);
      expect(globalAt(engine, SV2.CLICKED_ID)).toBe(0);
    });

    it('lets no click reach the room while the human is switched off', async () => {
      // "If the mouse is not visible, do nothing" (`mouse.cpp:240-243`): a
      // cycle with `fnNoHuman` in force runs no mouse engine at all. This
      // engine hit-tested every click regardless, which is invisible for a
      // cutscene — nothing is registered during one — and wrong the moment a
      // conversation is on screen: `fnChoose` switches the human off precisely
      // "so there will be no normal mouse engine" (`function.cpp:178-186`), and
      // without the guard a click picking an answer off the chooser bar is
      // also a click on whatever floor the bar is drawn over.
      const engine = await Sword2Engine.create(install({ noHuman: true, clickable: true }));
      engine.boot();
      await run(engine, 6);
      expect(engine.mouseAvailable).toBe(false);
      // The area is registered — the guard is about the click, not about the
      // list, and the same object is clickable again the moment the scripts
      // give the pointer back.
      expect(engine.pointerTargets().some((target) => target.id === 10)).toBe(true);

      engine.input.x = 150;
      engine.input.y = 100;
      engine.input.pressButton('left');
      await run(engine, 1);
      expect(globalAt(engine, SV2.CLICKED_ID)).toBe(0);
    });

    it('turns a click into the clicked object’s script 2, through an event', async () => {
      // `Mouse::normalMouse` writes `CLICKED_ID` *and* calls
      // `setPlayerActionEvent(CUR_PLAYER_ID, _mouseTouching)`
      // (`mouse.cpp:847-857`), which queues script 2 of the thing clicked for
      // the player to run. Nothing in this game polls `CLICKED_ID`: the player
      // is looping in `fnPauseForEvent` and the event is what ends the loop.
      //
      // With the event list missing — which is what this engine had — the click
      // was recorded in a global no script was waiting on, `fnCheckEventWaiting`
      // answered “no” 5,190 times in three thousand frames of the mounted demo,
      // and not one click in either the intro or the docks did anything at all.
      const engine = await Sword2Engine.create(install({ event: 'pause' }));
      engine.boot();
      await run(engine, 6);

      // Standing still and waiting: the lever's script 2 has not run.
      expect(globalAt(engine, 64)).toBe(0);
      expect(engine.pointerTargets()).toEqual([
        {
          id: 10,
          x: 150,
          y: 100,
          left: 100,
          top: 50,
          right: 200,
          bottom: 150,
          priority: 1,
          pointer: 7,
          pointerText: 0,
        },
      ]);

      engine.input.x = 150;
      engine.input.y = 100;
      engine.input.pressButton('left');
      await run(engine, 1);
      // The click lands after the session has already run, so this cycle only
      // queues it.
      expect(globalAt(engine, SV2.CLICKED_ID)).toBe(10);
      expect(globalAt(engine, 64)).toBe(0);

      await run(engine, 1);
      expect(globalAt(engine, 64)).toBe(42);
      // Script 2 came out of the lever's resource and ran with the *player's*
      // structures, which is what `logicOne` on the player means: the object
      // whose logic is running is still 8.
      expect(globalAt(engine, 63)).toBe(SWORD2_CUR_PLAYER_ID);
    });

    it('picks the same event up from fnCheckForEvent', async () => {
      // The other entry point, and a different return path: `fnCheckForEvent`
      // answers `IR_CONT` when the list is empty and only terminates when it is
      // not, where `fnPauseForEvent` terminates out of a pause it was already
      // looping in. This player pauses one cycle at a time and asks.
      const engine = await Sword2Engine.create(install({ event: 'poll' }));
      engine.boot();
      await run(engine, 6);
      expect(globalAt(engine, 64)).toBe(0);

      engine.input.x = 150;
      engine.input.y = 100;
      engine.input.pressButton('left');
      // Three cycles, because the poll only comes round every other one.
      await run(engine, 3);
      expect(globalAt(engine, 64)).toBe(42);
      expect(globalAt(engine, 63)).toBe(SWORD2_CUR_PLAYER_ID);
    });

    it('queues an event for another object, says it is waiting, and clears it', async () => {
      // No mouse in this one: the lever sends the player an event by script,
      // and the player asks twice with `fnClearEvent` in between. The same
      // opcode answering 1 and then 0 is the list holding an event and then
      // losing it; a stub that always answered would give two equal answers
      // whichever constant it picked.
      const engine = await Sword2Engine.create(install({ event: 'sent' }));
      engine.boot();
      await run(engine, 6);
      expect(globalAt(engine, 65)).toBe(1);
      expect(globalAt(engine, 66)).toBe(0);
    });

    it('draws a mega where its own feet are, and hit-tests the shape it drew', async () => {
      // Three defects in one path, all of them invisible from outside:
      //
      //  * the eight `fnXxxSprite` opcodes were modelled as "draw now". In
      //    ScummVM they set the low word of the object's own `ObjectGraphic`
      //    and return (`Router::setSpriteStatus`); the drawing is
      //    `fnRegisterFrame`, which every service script calls a few
      //    instructions later — 34,600 times in three thousand frames of the
      //    mounted demo, and it was unimplemented, so nothing was ever drawn.
      //  * what *was* pushed used `PLAYER_FEET_X/Y` for every object, so a
      //    room full of megas drew them all on top of the player.
      //  * `cdt.frameOffset` was read from the start of the resource rather
      //    than from the anim header, 44 bytes early.
      //
      // The fixture pins all three: the mega's feet are 100,200 while the
      // player's globals say 300,400, and the frame is a `FRAME_OFFSET` entry
      // at -10,-40 with a scale that works out at 1:1.
      const engine = await Sword2Engine.create(install({ human: true, sprite: true }));
      engine.boot();
      await run(engine, 6);

      const nico = engine.pointerTargets().find((target) => target.id === 11);
      // 100 - 10 = 90 across, 200 - 40 = 160 down, 20 by 30 — so the middle of
      // the rectangle is 100,175, and the structure's own zeroed x1..y2 are
      // not what was registered.
      expect(nico).toEqual({
        id: 11,
        x: 100,
        y: 175,
        left: 90,
        top: 160,
        right: 110,
        bottom: 190,
        priority: 5,
        pointer: 7,
        pointerText: 77,
      });

      // Drawn, not merely listed: the frame is colour 9 and the background 3.
      const pixels = engine.screen.pixels;
      expect(pixels[170 * 640 + 95]).toBe(9);
      expect(pixels[170 * 640 + 200]).toBe(3);
    });

    it('lets fnNoSprite switch a frame off through the field it writes', async () => {
      // The same object with opcode 29 in place of 6. If the sprite calls were
      // still "draw now" this would differ only in which list the frame went
      // into, and the frame would still be drawn.
      const engine = await Sword2Engine.create(install({ human: true, hidden: true }));
      engine.boot();
      await run(engine, 6);
      expect(engine.pointerTargets().some((target) => target.id === 11)).toBe(false);
      expect([...engine.screen.pixels].some((index) => index === 9)).toBe(false);
    });

    it('fills the floor’s mouse structure from the room, and registers nothing itself', async () => {
      // `fnInitFloorMouse` *writes* 0, 0, screen_wide-1, screen_deep-1,
      // priority 9 and `NORMAL_MOUSE_ID` into the structure it is handed
      // (`function.cpp:498-517`); the floor object's own `fnRegisterMouse` is
      // what puts it in the list. Registering from inside the opcode instead —
      // which this did — handed the list the structure as the script left it,
      // all zeroes, which is why the probe reported a floor target at 0,0 with
      // no area to click.
      const engine = await Sword2Engine.create(install({ human: true, floor: true }));
      engine.boot();
      await run(engine, 6);
      const floor = engine.pointerTargets().find((target) => target.id === 12);
      // The fixture room is 640x480, so 0..639 by 0..479 and its middle 319,239.
      expect(floor).toEqual({
        id: 12,
        x: 319,
        y: 239,
        left: 0,
        top: 0,
        right: 639,
        bottom: 479,
        // The floor is always the lowest priority there is (`function.cpp:511`).
        priority: 9,
        pointer: 17,
        pointerText: 0,
      });
    });

    it('draws the background as the parallax layer it is', async () => {
      // `renderParallax(_vm->fetchBackgroundLayer(file), 2)` (`screen.cpp:310`):
      // the background is layer 2 of five and is packed like the other four.
      // Copying its bytes straight into the buffer — which is what this did —
      // reads the row-offset table and the packet counts as pixels, and the
      // result is horizontal noise that still fills the screen, so every
      // screenshot looked like a picture that had gone wrong rather than like
      // a format that was never read.
      const engine = await Sword2Engine.create(install({ human: true, hole: true }));
      engine.boot();
      await run(engine, 6);
      const pixels = engine.screen.pixels;
      // A solid row is written raw; the rows through the hole are written as
      // packets, and 0 is transparent in a background exactly as in a parallax.
      expect(pixels[100 * 640 + 100]).toBe(3);
      expect(pixels[210 * 640 + 320]).toBe(0);
      expect(pixels[210 * 640 + 280]).toBe(3);
    });

    it('reads a mask layer from the end of the resource header, not from the file', async () => {
      // `Screen::processLayer` takes the mask at
      // `file + ResHeader::size() + layer_head.offset` (`screen.cpp:528`), the
      // same base every offset in the multi-screen header uses. Reading it as
      // absolute lands 44 bytes early: on the demo's four shipped layers one of
      // the four still decodes and three become noise, and here the rectangle
      // would either stay colour 9 or be stamped with rubbish.
      const engine = await Sword2Engine.create(
        install({ human: true, sprite: true, maskLayer: true }),
      );
      engine.boot();
      await run(engine, 6);
      const pixels = engine.screen.pixels;
      // Nico is colour 9 at 95,170 without the layer; the layer is colour 5 and
      // covers her, and the background outside it is untouched.
      expect(pixels[170 * 640 + 95]).toBe(5);
      expect(pixels[170 * 640 + 200]).toBe(3);
    });

    /**
     * Saving and restoring, which is the half of the system menu the engine owns.
     *
     * The panel is `Sword2Pointer`'s and is covered there. What is here is the
     * payload: format 1 wrote every object it had loaded and put none of them
     * back, so a restored game came back in the right room with the world
     * wherever the live game had left it. These pin the two halves of the fix —
     * that the save carries the player, and that the restore applies it.
     */
    describe('saving and restoring', () => {
      it('saves the globals and the player, and not a heap of stale objects', async () => {
        const engine = await Sword2Engine.create(install({ human: true }));
        engine.boot();
        await run(engine, 6);

        const saved = engine.saveState('a slot') as unknown as {
          format: number;
          player?: number[];
          objects?: unknown;
          globals: number[];
          session: number;
        };
        expect(saved.format).toBe(2);
        expect(saved.player?.length).toBeGreaterThan(0);
        // The field format 1 wrote and never read.
        expect(saved.objects).toBeUndefined();
        expect(saved.session).toBeGreaterThan(0);
      });

      it('puts the saved globals back', async () => {
        const engine = await Sword2Engine.create(install({ human: true }));
        engine.boot();
        await run(engine, 6);

        const saved = engine.saveState('a slot') as unknown as {
          globals: number[];
        } & SavedGameEnvelope;
        // A world that differs from the live one by one global, so what is
        // read back afterwards can only have come out of the save.
        const globals = [...saved.globals];
        globals[SV2.LOCATION * 4] = 42;
        engine.loadState({ ...saved, globals } as SavedGameEnvelope);

        // Read before stepping: this fixture's own script writes `LOCATION`
        // every cycle, which is what makes it a good needle and a bad thing to
        // look for a cycle later.
        expect(engine.currentRoom).toBe(42);
      });

      it('leaves the world running after a restore', async () => {
        const engine = await Sword2Engine.create(install({ human: true, clickable: true }));
        engine.boot();
        await run(engine, 6);
        const targets = engine.pointerTargets().length;
        expect(targets).toBeGreaterThan(0);

        const saved = engine.saveState('a slot');
        engine.loadState(saved);
        await run(engine, 6);

        // Every object was dropped and every one came back from its resource,
        // which is what `killAll(false)` buys: the session's mouse areas are
        // registered again rather than lost with the objects that registered
        // them.
        expect(engine.pointerTargets().length).toBe(targets);
        expect(engine.describeNotInteractive()).toBeNull();
      });

      it('refuses a save from the format that could not restore', async () => {
        const engine = await Sword2Engine.create(install({ human: true }));
        engine.boot();
        await run(engine, 6);

        const saved = engine.saveState('a slot');
        expect(() => engine.loadState({ ...saved, format: 1 })).toThrow(/format 1/);
      });

      it('refuses another game’s save, and another install’s player', async () => {
        const engine = await Sword2Engine.create(install({ human: true, clickable: true }));
        engine.boot();
        await run(engine, 6);

        const saved = engine.saveState('a slot') as unknown as {
          player: number[];
        } & SavedGameEnvelope;
        expect(() => engine.loadState({ ...saved, gameId: 'monkey2' })).toThrow(/monkey2/);
        expect(() =>
          engine.loadState({ ...saved, player: saved.player.slice(0, -4) } as SavedGameEnvelope),
        ).toThrow(/player object/);
        // Refused rather than half-applied: the game is still playable.
        expect(engine.describeNotInteractive()).toBeNull();
      });
    });

    it('ignores a mouse area whose pointer field is zero', async () => {
      // `Mouse::registerMouse` returns before it writes a slot when there is no
      // pointer graphic (`mouse.cpp:163`), which is how the scripts switch an
      // area off without removing the object from the session.
      const engine = await Sword2Engine.create(install({ human: true, switchedOff: true }));
      engine.boot();
      await run(engine, 6);
      expect(engine.pointerTargets().some((target) => target.id === 13)).toBe(false);
    });
  });
});
