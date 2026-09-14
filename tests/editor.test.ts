import { describe, expect, it } from 'vitest';
import { Assembler } from '../src/authoring/Assembler.js';
import {
  containsCode,
  describeAction,
  emitActions,
  flagVar,
  type Action,
} from '../src/authoring/actions.js';
import { loadImage, loadMask, storeImage, storeMask } from '../src/authoring/imageCodec.js';
import { createImage } from '../src/authoring/ImageEncoder.js';
import { getPixel, rect } from '../src/authoring/draw.js';
import {
  createProject,
  migrate,
  PROJECT_VERSION,
  nextId,
  validateProject,
  type Project,
} from '../src/authoring/project.js';
import { buildProject, projectToGame } from '../src/authoring/projectToGame.js';
import { buildCostume, encodeCelPixels } from '../src/authoring/CostumeBuilder.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { VAR } from '../src/engine/constants.js';
import { boxContains, dragBoxHandle } from '../src/editor/RoomCanvas.js';
import { boxBounds, isConvexBox, rectangleBox } from '../src/authoring/GameBuilder.js';
import { defaultSpriteFrames } from '../src/editor/SpriteCanvas.js';
import { EditorState } from '../src/editor/state.js';

/** A project that compiles: one room, one actor, one object, one verb. */
function playableProject(): Project {
  const project = createProject('Test Game');
  const background = createImage(320, 144, 3);
  rect(background, 0, 100, 320, 44, 8);

  project.rooms.push({
    id: 1,
    name: 'room1',
    width: 320,
    height: 144,
    background: storeImage(background),
    zPlanes: [],
    boxes: [rectangleBox(0, 104, 320, 40)],
    objects: [
      {
        id: 100,
        name: 'lamp',
        x: 160,
        y: 60,
        width: 16,
        height: 16,
        walkTo: { x: 168, y: 120 },
        facing: 'north',
        initialState: 1,
        classes: [],
        states: [storeImage(createImage(16, 16, 14))],
        handlers: [{ verbId: 1, actions: [{ type: 'setFlag', flag: 5, value: 9 }] }],
        otherwise: [],
      },
    ],
    onEnter: [],
    onExit: [],
  });

  project.actors[0].poses = [{}, { all: [{ image: storeImage(createImage(8, 16, 1)), hold: 6 }] }];
  return project;
}

describe('image storage', () => {
  it('round-trips an image through run-length encoding', () => {
    const image = createImage(32, 8, 4);
    rect(image, 4, 2, 8, 3, 11);

    const restored = loadImage(storeImage(image));
    expect(restored.width).toBe(32);
    expect(restored.height).toBe(8);
    expect([...restored.pixels]).toEqual([...image.pixels]);
  });

  it('compresses flat artwork to a fraction of its raw size', () => {
    const image = createImage(320, 144, 7);
    const stored = storeImage(image);
    // 46 KB of identical pixels must not cost anything like 46 KB.
    expect(stored.data.length).toBeLessThan(1024);
  });

  it('handles runs longer than the 255 cap', () => {
    const image = createImage(100, 100, 3);
    expect([...loadImage(storeImage(image)).pixels]).toEqual([...image.pixels]);
  });

  it('round-trips a mask', () => {
    const mask = new Uint8Array(64);
    mask[10] = 1;
    mask[63] = 1;
    expect([...loadMask(storeMask(mask, 8, 8))]).toEqual([...mask]);
  });
});

describe('actions', () => {
  it('emits bytecode for a simple action list', () => {
    const script = new Assembler();
    emitActions(script, [
      { type: 'setFlag', flag: 3, value: 1 },
      { type: 'say', actor: 'ego', text: 'Hi' },
    ]);
    const bytes = script.build();
    expect(bytes.length).toBeGreaterThan(0);
    // `move` into the flag variable comes first.
    expect(bytes[0]).toBe(0x1a);
    expect(bytes[1] | (bytes[2] << 8)).toBe(flagVar(3).index);
  });

  it('places flags clear of the engine and compiler variables', () => {
    // The engine owns 0-72 and the compiler uses 200-201.
    expect(flagVar(0).index).toBeGreaterThan(201);
  });

  it('emits a two-armed conditional', () => {
    const script = new Assembler();
    emitActions(script, [
      {
        type: 'if',
        flag: 1,
        equals: 1,
        then: [{ type: 'setFlag', flag: 2, value: 1 }],
        else: [{ type: 'setFlag', flag: 2, value: 2 }],
      },
    ]);
    expect(script.build().length).toBeGreaterThan(10);
  });

  it('refuses custom code unless the host permits it', () => {
    const script = new Assembler();
    expect(() => emitActions(script, [{ type: 'code', source: 's.stop();' }])).toThrow(
      /not enabled/,
    );
  });

  it('collects a skipped code action as a warning when asked', () => {
    const warnings: string[] = [];
    const script = new Assembler();
    emitActions(script, [{ type: 'code', source: 's.stop();' }], { warnings });
    expect(warnings).toHaveLength(1);
  });

  it('describes actions for the list view', () => {
    expect(describeAction({ type: 'say', actor: 'ego', text: 'Hello' })).toContain('Hello');
    expect(describeAction({ type: 'gotoRoom', room: 4 })).toContain('room 4');
  });

  it('finds code nested inside a conditional', () => {
    const actions: Action[] = [
      { type: 'if', flag: 0, equals: 1, then: [{ type: 'code', source: '' }] },
    ];
    expect(containsCode(actions)).toBe(true);
    expect(containsCode([{ type: 'wait', frames: 1 }])).toBe(false);
  });
});

describe('project model', () => {
  it('allocates the next free id', () => {
    expect(nextId([1, 2, 4])).toBe(3);
    expect(nextId([], 100)).toBe(100);
  });

  it('reports a missing start room', () => {
    const project = createProject();
    expect(validateProject(project)).toContain('The game has no rooms');
  });

  it('reports duplicate object ids across rooms', () => {
    const project = playableProject();
    project.rooms.push({ ...project.rooms[0], id: 2, name: 'room2' });
    const problems = validateProject(project);
    expect(problems.some((p) => p.includes('used more than once'))).toBe(true);
  });

  it('reports a room with no walk boxes', () => {
    const project = playableProject();
    project.rooms[0].boxes = [];
    expect(validateProject(project).some((p) => p.includes('no walk boxes'))).toBe(true);
  });

  it('accepts a valid project', () => {
    expect(validateProject(playableProject())).toEqual([]);
  });

  it('refuses a project from a newer editor', () => {
    expect(() => migrate({ version: 99 })).toThrow(/newer version/);
  });

  it('refuses something that is not a project', () => {
    expect(() => migrate({ hello: true })).toThrow(/Not a project/);
    expect(() => migrate(null)).toThrow(/Not a project/);
  });

  it('fills in fields a hand-edited file omits', () => {
    const project = migrate({ version: 1, name: 'Partial' });
    expect(project.name).toBe('Partial');
    expect(project.verbs.length).toBeGreaterThan(0);
    expect(project.rooms).toEqual([]);
  });
});

describe('building a project', () => {
  it('returns validation errors instead of compiling', () => {
    const built = buildProject(createProject());
    expect(built.errors.length).toBeGreaterThan(0);
    expect(built.data.length).toBe(0);
  });

  it('compiles a valid project to a container', () => {
    const built = buildProject(playableProject());
    expect(built.errors).toEqual([]);
    expect(built.stats.rooms).toBe(1);
    expect(built.stats.objects).toBe(1);
    expect(built.data.length).toBeGreaterThan(1000);
  });

  it('produces a game the engine boots and runs', async () => {
    const built = buildProject(playableProject());
    const source = new MemoryDataSource('built');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);

    expect(engine.currentRoom).toBe(1);
    expect(engine.variables[VAR.EGO]).toBe(1);
    expect(engine.getActor(1)!.visible).toBe(true);
    expect(engine.currentRoomData!.findObject(100)!.name).toBe('lamp');
    expect(engine.verbs.get(1)!.text).toBe('Look at');
  });

  it('runs an action list through the sentence script', async () => {
    const built = buildProject(playableProject());
    const source = new MemoryDataSource('built');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);

    engine.doSentence(1, 100, 0); // "Look at" the lamp
    const flag = flagVar(5).index;
    for (let i = 0; i < 500 && engine.variables[flag] !== 9; i++) engine.step();

    expect(engine.variables[flag]).toBe(9);
  });

  it('compiles a custom code action when permitted', () => {
    const project = playableProject();
    project.rooms[0].objects[0].handlers[0].actions = [
      { type: 'code', source: 's.move(s.constructor === Object ? 0 : 0, 0);' },
    ];
    // Compiles the source rather than executing anything meaningful.
    const built = buildProject(project, { allowCode: true });
    expect(built.errors).toEqual([]);
  });

  it('reports unparseable custom code rather than crashing the build', () => {
    const project = playableProject();
    project.rooms[0].objects[0].handlers[0].actions = [
      { type: 'code', source: 'this is not javascript {{{' },
    ];
    // Reported, not thrown. The editor rebuilds on every render to keep its
    // status bar honest, so a throw here does not fail one build — it takes
    // the whole editor down on a project the author then cannot open to fix.
    expect(buildProject(project, { allowCode: true }).errors.join(' ')).toMatch(/failed to parse/);
  });
});

describe('sprite frames', () => {
  it('supplies a recognisable starter character rather than a block', () => {
    const poses = defaultSpriteFrames();
    // Index by SCUMM frame number: 1 init, 2 walk, 3 stand, 4 talk, 5 talk-stop.
    expect(poses[0]).toHaveLength(0);
    expect(poses[2].length).toBeGreaterThan(0);
    expect(poses[3].length).toBeGreaterThan(0);
    expect(poses[4].length).toBeGreaterThan(0);

    const standing = poses[3][0];
    expect(standing.width).toBeGreaterThan(4);
    expect(standing.height).toBeGreaterThan(8);
    // More than one costume colour, or it is a block by another name.
    expect(new Set(standing.pixels).size).toBeGreaterThan(2);
  });

  it('gives the walk enough cels to read as walking', () => {
    const walk = defaultSpriteFrames()[2];
    expect(walk.length).toBeGreaterThanOrEqual(4);

    // The cels must actually differ, or it is a slideshow of one pose.
    const distinct = new Set(walk.map((cel) => cel.pixels.join(',')));
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('uses transparent (0) around the edges so the sprite is not a rectangle', () => {
    const standing = defaultSpriteFrames()[3][0];
    expect(standing.pixels[0]).toBe(0);
  });

  it('compiles actor frames into a costume the engine draws', async () => {
    const project = playableProject();
    project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));

    const built = buildProject(project);
    expect(built.errors).toEqual([]);

    const source = new MemoryDataSource('sprite');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    for (let i = 0; i < 10; i++) engine.step();
    engine.render();

    // The actor must actually appear: look for its costume colours in the band
    // of the screen just above its feet.
    const actor = engine.getActor(1)!;
    const pixels = engine.screen.copyPixels();
    const feet = actor.y + engine.screen.main.top;

    let drawn = 0;
    for (let y = feet - 14; y < feet; y++) {
      for (let x = actor.x - 8; x < actor.x + 8; x++) {
        if (x < 0 || y < 0 || x >= 320 || y >= 200) continue;
        // The room floor is colour 8; anything else here came from the sprite.
        if (pixels[y * 320 + x] !== 8) drawn++;
      }
    }
    expect(drawn).toBeGreaterThan(20);
  });

  it('maps costume colours through the actor palette', async () => {
    const project = playableProject();
    project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));
    // Costume colour 1 (hair) becomes bright red.
    project.actors[0].palette = [12, 14, 2, 1, 8, 4];

    const built = buildProject(project);
    const source = new MemoryDataSource('sprite');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    for (let i = 0; i < 10; i++) engine.step();
    engine.render();

    expect(engine.screen.copyPixels().includes(12)).toBe(true);
  });
});

describe('walk boxes', () => {
  it('can be removed, leaving the room valid to edit but flagged', () => {
    const project = playableProject();
    expect(project.rooms[0].boxes).toHaveLength(1);

    project.rooms[0].boxes.splice(0, 1);
    expect(project.rooms[0].boxes).toHaveLength(0);
    expect(validateProject(project).some((p) => p.includes('no walk boxes'))).toBe(true);
  });

  it('keeps the remaining boxes when one of several is removed', () => {
    const project = playableProject();
    project.rooms[0].boxes.push(rectangleBox(0, 60, 100, 40), rectangleBox(200, 60, 100, 40));

    project.rooms[0].boxes.splice(1, 1);
    expect(project.rooms[0].boxes).toHaveLength(2);
    expect(project.rooms[0].boxes[1].ul.x).toBe(200);
    expect(validateProject(project)).toEqual([]);
  });
});

describe('walk box shaping', () => {
  const origin = rectangleBox(100, 50, 40, 20);

  it('moves a single corner, leaving the others alone', () => {
    const result = dragBoxHandle(origin, 'ne', 10, -5);
    expect(result.ur).toEqual({ x: origin.ur.x + 10, y: origin.ur.y - 5 });
    expect(result.ul).toEqual(origin.ul);
    expect(result.lr).toEqual(origin.lr);
    expect(result.ll).toEqual(origin.ll);
  });

  it('moves both corners of an edge from a side handle', () => {
    const result = dragBoxHandle(origin, 'n', 0, -8);
    expect(result.ul.y).toBe(origin.ul.y - 8);
    expect(result.ur.y).toBe(origin.ur.y - 8);
    expect(result.ll).toEqual(origin.ll);
    expect(result.lr).toEqual(origin.lr);
  });

  it('makes a trapezoid, which a rectangle-only editor could not', () => {
    // Pulling the top edge in on one side is how a receding corridor is shaped.
    const trapezoid = dragBoxHandle(dragBoxHandle(origin, 'nw', 10, 0), 'ne', -10, 0);
    expect(trapezoid.ul.x).toBeGreaterThan(trapezoid.ll.x);
    expect(trapezoid.ur.x).toBeLessThan(trapezoid.lr.x);
    expect(isConvexBox(trapezoid)).toBe(true);
  });

  it('cannot be dragged off the top-left of the room', () => {
    const result = dragBoxHandle(origin, 'nw', -1000, -1000);
    expect(result.ul.x).toBe(0);
    expect(result.ul.y).toBe(0);
  });

  it('leaves the box alone for a zero-distance drag', () => {
    expect(dragBoxHandle(origin, 'se', 0, 0)).toEqual(origin);
  });

  it('reports the bounding box of a slanted shape', () => {
    const slanted = dragBoxHandle(origin, 'ne', 20, -10);
    const bounds = boxBounds(slanted);
    expect(bounds.x).toBe(100);
    expect(bounds.y).toBe(40);
    expect(bounds.width).toBe(60);
  });

  it('detects a shape the engine cannot fully walk', () => {
    expect(isConvexBox(origin)).toBe(true);
    // Dragging one corner across the diagonal folds the quad.
    const folded = dragBoxHandle(origin, 'ne', -60, 30);
    expect(isConvexBox(folded)).toBe(false);
  });

  it('treats a box flattened to a line as usable', () => {
    const line = { ...origin, ll: { ...origin.ul }, lr: { ...origin.ur } };
    expect(isConvexBox(line)).toBe(true);
  });
});

describe('walk box containment', () => {
  it('agrees with the engine about a rectangle', () => {
    const box = rectangleBox(10, 10, 20, 20);
    expect(boxContains(box, 15, 15)).toBe(true);
    expect(boxContains(box, 5, 15)).toBe(false);
    expect(boxContains(box, 15, 40)).toBe(false);
  });

  it('follows a slanted edge rather than its bounding box', () => {
    // A triangle-ish quad: the top edge collapses to one point.
    const wedge = {
      ul: { x: 50, y: 0 },
      ur: { x: 50, y: 0 },
      lr: { x: 100, y: 50 },
      ll: { x: 0, y: 50 },
    };
    expect(boxContains(wedge, 50, 45)).toBe(true);
    // Inside the bounding box, but outside the wedge.
    expect(boxContains(wedge, 5, 5)).toBe(false);
  });
});

describe('animated poses', () => {
  /** Reads the costume's animation table back out of a compiled game. */
  function costumeAnimation(project: Project, frame: number) {
    const game = projectToGame(project);
    const actor = game.actors[0];
    const bytes = new Uint8Array(buildCostume(actor.costume!));

    // The palette sits between the header and the tables, so its size decides
    // where they start. Byte 9 is the format: 0x59 is the 32 colour variant.
    const numColors = (bytes[9] & 0x7f) === 0x59 ? 32 : 16;
    const tableBase = 2 + 8 + numColors;
    const dataOffsets = tableBase + 34;

    // Direction 0 (west) of the requested frame.
    const animOffset =
      bytes[dataOffsets + frame * 4 * 2] | (bytes[dataOffsets + frame * 4 * 2 + 1] << 8);
    const at = 2 + animOffset;

    return {
      mask: bytes[at] | (bytes[at + 1] << 8),
      start: bytes[at + 2] | (bytes[at + 3] << 8),
      // The length byte is (cel count - 1); bit 7 would mean "play once".
      length: (bytes[at + 4] & 0x7f) + 1,
      loops: (bytes[at + 4] & 0x80) === 0,
    };
  }

  function projectWithWalk(cels: number, hold: number): Project {
    const project = playableProject();
    project.actors[0].poses = [
      {},
      { all: [{ image: storeImage(createImage(8, 16, 1)), hold: 6 }] },
      {
        all: Array.from({ length: cels }, (_, i) => ({
          image: storeImage(createImage(8, 16, (i % 3) + 1)),
          hold,
        })),
      },
      { all: [{ image: storeImage(createImage(8, 16, 1)), hold: 6 }] },
      { all: [{ image: storeImage(createImage(8, 16, 3)), hold: 6 }] },
      { all: [{ image: storeImage(createImage(8, 16, 1)), hold: 6 }] },
    ];
    return project;
  }

  it('gives a single-cel pose held one tick a one-entry animation', () => {
    // Frame 2 is the walk pose, which is the one the helper parameterises.
    const animation = costumeAnimation(projectWithWalk(1, 1), 2);
    expect(animation.length).toBe(1);
    expect(animation.loops).toBe(true);
  });

  it('expands a single cel with a longer hold into repeated entries', () => {
    expect(costumeAnimation(projectWithWalk(1, 5), 2).length).toBe(5);
  });

  it('gives a multi-cel pose an animation range covering every cel', () => {
    // Four cels held one tick each: a four-entry range.
    const animation = costumeAnimation(projectWithWalk(4, 1), 2);
    expect(animation.length).toBe(4);
  });

  it('expands the hold into repeated command entries', () => {
    // Two cels held three ticks each is a six-entry range, which is how the
    // format expresses timing — there is no per-cel duration field.
    const animation = costumeAnimation(projectWithWalk(2, 3), 2);
    expect(animation.length).toBe(6);
  });

  it('loops rather than playing once', () => {
    expect(costumeAnimation(projectWithWalk(4, 2), 2).loops).toBe(true);
  });

  it('animates only limb 0', () => {
    expect(costumeAnimation(projectWithWalk(3, 2), 2).mask).toBe(0x8000);
  });

  it('advances the drawn cel as the engine ticks', async () => {
    const built = buildProject(projectWithWalk(4, 2));
    expect(built.errors).toEqual([]);

    const source = new MemoryDataSource('anim');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);

    // Walk, so the walk pose is playing, and sample what is drawn over time.
    engine.startWalkActor(1, 300, 120, -1);

    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      engine.step();
      engine.render();
      const actor = engine.getActor(1)!;
      const y = actor.y + engine.screen.main.top - 8;
      const row: number[] = [];
      for (let x = actor.x - 6; x < actor.x + 6; x++) row.push(engine.screen.getPixel(x, y));
      seen.add(row.join(','));
    }

    // A static pose would produce one distinct row for a given position; an
    // animated one cycles through several.
    expect(seen.size).toBeGreaterThan(1);
  });

  it('rejects a costume with more distinct cels than the format allows', () => {
    const project = playableProject();
    project.actors[0].poses = [
      {},
      { all: [{ image: storeImage(createImage(4, 4, 1)), hold: 1 }] },
      {
        // Every cel genuinely different: identical ones now share a single
        // entry, so repeating fifteen pictures would no longer reach the limit.
        all: Array.from({ length: 200 }, (_, i) => {
          const image = createImage(4, 4, 1);
          image.pixels[i % image.pixels.length] = (i % 15) + 2;
          image.pixels[(i * 7) % image.pixels.length] = (i % 13) + 2;
          return { image: storeImage(image), hold: 1 };
        }),
      },
      { all: [{ image: storeImage(createImage(4, 4, 1)), hold: 1 }] },
      { all: [{ image: storeImage(createImage(4, 4, 1)), hold: 1 }] },
      { all: [{ image: storeImage(createImage(4, 4, 1)), hold: 1 }] },
    ];
    // Reported like any other build problem now, rather than thrown: nothing
    // the compiler refuses should be able to take the editor down with it.
    expect(buildProject(project).errors.join(' ')).toMatch(/at most/);
  });
});

describe('project migration', () => {
  it('upgrades a version 1 actor to cel sequences without losing artwork', () => {
    const image = storeImage(createImage(8, 16, 5));
    const upgraded = migrate({
      version: 1,
      name: 'Old',
      actors: [
        {
          id: 1,
          name: 'Player',
          talkColor: 11,
          walkSpeed: { x: 5, y: 2 },
          palette: [6, 14, 2],
          frames: [null, image, null, image],
        },
      ],
    });

    const actor = upgraded.actors[0];
    expect(upgraded.version).toBe(PROJECT_VERSION);
    // A version 1 frame was one drawing shown whichever way the character
    // faced, which is exactly what the shared `all` artwork means now.
    expect(actor.poses[0]).toEqual({});
    expect(actor.poses[1].all).toHaveLength(1);
    expect(actor.poses[1].all?.[0].image).toEqual(image);
    expect(actor.poses[3].all).toHaveLength(1);
    // The old field is gone rather than lingering alongside the new one.
    expect((actor as unknown as { frames?: unknown }).frames).toBeUndefined();
  });

  it('leaves an already-upgraded actor alone', () => {
    const project = playableProject();
    const again = migrate(JSON.parse(JSON.stringify(project)));
    expect(again.actors[0].poses).toEqual(project.actors[0].poses);
  });
});

describe('idle poses do not animate', () => {
  /** Fingerprints the sprite's bounding box on screen. */
  function fingerprint(engine: ScummEngine): string {
    engine.render();
    const actor = engine.getActor(1)!;
    const out: number[] = [];
    for (let y = actor.y + engine.screen.main.top - 16; y < actor.y + engine.screen.main.top; y++) {
      for (let x = actor.x - 8; x < actor.x + 8; x++) out.push(engine.screen.getPixel(x, y));
    }
    return out.join(',');
  }

  async function engineWithDefaultSprite(): Promise<ScummEngine> {
    const project = playableProject();
    project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));

    const built = buildProject(project);
    const source = new MemoryDataSource('idle');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    return engine;
  }

  it('stays on one frame while standing still', async () => {
    const engine = await engineWithDefaultSprite();

    const seen = new Set<string>();
    for (let i = 0; i < 90; i++) {
      engine.step();
      seen.add(fingerprint(engine));
    }
    expect(seen.size).toBe(1);
  });

  it('cycles while walking', async () => {
    const engine = await engineWithDefaultSprite();
    engine.startWalkActor(1, 260, 120, -1);

    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      engine.step();
      seen.add(fingerprint(engine));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('returns to a still pose once it arrives', async () => {
    const engine = await engineWithDefaultSprite();
    engine.startWalkActor(1, 200, 120, -1);

    const actor = engine.getActor(1)!;
    for (let i = 0; i < 500 && actor.moving; i++) engine.step();
    expect(actor.moving).toBe(0);
    expect(actor.frame).toBe(actor.standFrame);

    const seen = new Set<string>();
    for (let i = 0; i < 90; i++) {
      engine.step();
      seen.add(fingerprint(engine));
    }
    expect(seen.size).toBe(1);
  });

  it('animates while idle only when the standing pose itself has several cels', async () => {
    // The engine has no "animate only when moving" rule; a pose cycles whenever
    // it is shown. That is why the editor names the pose being edited.
    const project = playableProject();
    const frames = defaultSpriteFrames();
    project.actors[0].poses = frames.map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 2 })),
    }));
    // Give standing the walk's cels, which is the mistake the editor warns about.
    project.actors[0].poses[3] = {
      all: frames[2].map((image) => ({ image: storeImage(image), hold: 2 })),
    };

    const built = buildProject(project);
    const source = new MemoryDataSource('idle2');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);

    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      engine.step();
      seen.add(fingerprint(engine));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('perspective scaling', () => {
  function roomWithRamp(
    ramp: { farY: number; farScale: number; nearY: number; nearScale: number } | undefined,
    perspective: boolean,
  ): Project {
    const project = playableProject();
    project.rooms[0].boxes = [rectangleBox(0, 60, 320, 84, { perspective })];
    project.rooms[0].perspective = ramp;
    project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));
    return project;
  }

  async function engineFor(project: Project): Promise<ScummEngine> {
    const built = buildProject(project);
    expect(built.errors).toEqual([]);
    const source = new MemoryDataSource('scale');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    return engine;
  }

  it('shrinks the actor as it moves away from the camera', async () => {
    const engine = await engineFor(
      roomWithRamp({ farY: 60, farScale: 60, nearY: 143, nearScale: 255 }, true),
    );
    const actor = engine.getActor(1)!;

    engine.putActor(1, 160, 64);
    const far = actor.getScale(engine.boxes);

    engine.putActor(1, 160, 142);
    const near = actor.getScale(engine.boxes);

    expect(far).toBeLessThan(near);
    expect(far).toBeLessThan(100);
    expect(near).toBeGreaterThan(200);
  });

  it('interpolates smoothly rather than stepping', async () => {
    const engine = await engineFor(
      roomWithRamp({ farY: 60, farScale: 60, nearY: 143, nearScale: 255 }, true),
    );
    const actor = engine.getActor(1)!;

    const scales = [70, 90, 110, 130].map((y) => {
      engine.putActor(1, 160, y);
      return actor.getScale(engine.boxes);
    });

    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeGreaterThan(scales[i - 1]);
    }
  });

  it('keeps one size when the box opts out', async () => {
    const engine = await engineFor(
      roomWithRamp({ farY: 60, farScale: 60, nearY: 143, nearScale: 255 }, false),
    );
    const actor = engine.getActor(1)!;

    engine.putActor(1, 160, 64);
    const far = actor.getScale(engine.boxes);
    engine.putActor(1, 160, 142);
    expect(actor.getScale(engine.boxes)).toBe(far);
  });

  it('keeps one size when the room has no ramp', async () => {
    const engine = await engineFor(roomWithRamp(undefined, false));
    const actor = engine.getActor(1)!;

    engine.putActor(1, 160, 64);
    expect(actor.getScale(engine.boxes)).toBe(255);
    engine.putActor(1, 160, 142);
    expect(actor.getScale(engine.boxes)).toBe(255);
  });

  it('does not shrink to nothing when a box asks for a slot that was never written', async () => {
    // Bit 15 set with an all-zero SCAL would interpolate to 0 and clamp to 1,
    // leaving a one-pixel actor.
    const engine = await engineFor(roomWithRamp(undefined, true));
    const actor = engine.getActor(1)!;
    engine.putActor(1, 160, 120);
    expect(actor.getScale(engine.boxes)).toBe(255);
  });

  it('draws a smaller sprite when scaled down', async () => {
    const engine = await engineFor(
      roomWithRamp({ farY: 60, farScale: 60, nearY: 143, nearScale: 255 }, true),
    );

    // Counting costume pixels is more robust than finding edges: the room has
    // two background colours, so an edge search picks up the horizon too.
    // Sampled well away from x=160, where the fixture stamps its object.
    const background = new Set([0, 3, 8]);
    const drawnPixels = (y: number): number => {
      engine.putActor(1, 60, y);
      engine.step();
      engine.render();

      const actor = engine.getActor(1)!;
      const feet = actor.y + engine.screen.main.top;
      let count = 0;
      for (let row = Math.max(0, feet - 40); row <= feet; row++) {
        for (let x = actor.x - 20; x <= actor.x + 20; x++) {
          if (!background.has(engine.screen.getPixel(x, row))) count++;
        }
      }
      return count;
    };

    // Both rows must keep the whole sprite inside the room view, or the near
    // one is clipped at the bottom and draws fewer pixels for the wrong reason.
    const far = drawnPixels(70);
    const near = drawnPixels(120);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(near);
  });
});

describe('walks cancelled by a script', () => {
  async function walkingEngine(): Promise<ScummEngine> {
    const project = playableProject();
    project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));
    const built = buildProject(project);
    const source = new MemoryDataSource('stop');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.startWalkActor(1, 300, 120, -1);
    for (let i = 0; i < 10; i++) engine.step();
    return engine;
  }

  it('returns to the standing pose when a script moves the actor mid-walk', async () => {
    const engine = await walkingEngine();
    const actor = engine.getActor(1)!;
    expect(actor.frame).toBe(actor.walkFrame);

    engine.putActor(1, 120, 120);
    expect(actor.moving).toBe(0);
    expect(actor.frame).toBe(actor.standFrame);
  });

  it('stops animating once the walk is cancelled', async () => {
    const engine = await walkingEngine();
    engine.putActor(1, 120, 120);

    const actor = engine.getActor(1)!;
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      engine.step();
      engine.render();
      const row: number[] = [];
      for (
        let y = actor.y + engine.screen.main.top - 16;
        y < actor.y + engine.screen.main.top;
        y++
      ) {
        for (let x = actor.x - 8; x < actor.x + 8; x++) row.push(engine.screen.getPixel(x, y));
      }
      seen.add(row.join(','));
    }
    expect(seen.size).toBe(1);
  });

  it('returns to the standing pose after a room change mid-walk', async () => {
    const engine = await walkingEngine();
    engine.loadRoomWithEgo(0, 1, -1, -1);

    const actor = engine.getActor(1)!;
    expect(actor.moving).toBe(0);
    expect(actor.frame).toBe(actor.standFrame);
  });

  it('stops an actor moved to another room mid-walk', async () => {
    const engine = await walkingEngine();
    engine.putActorInRoom(1, 5);

    // The pose is not reset here, because an actor outside the current room has
    // no costume loaded to reset. It is not drawn either, so nothing shows.
    expect(engine.getActor(1)!.moving).toBe(0);
  });

  it('does not arrive mid-stride when placed back into the current room', async () => {
    const engine = await walkingEngine();
    engine.putActorInRoom(1, 5);
    engine.putActorInRoom(1, 1);

    const actor = engine.getActor(1)!;
    expect(actor.moving).toBe(0);
    // Reappearing runs the init frame, as the original does; what matters is
    // that it is not the walk cycle.
    expect(actor.frame).not.toBe(actor.walkFrame);
  });
});

describe('migrating a version 2 project', () => {
  const legacyRoom = {
    id: 1,
    name: 'old',
    width: 320,
    height: 144,
    background: storeImage(createImage(320, 144, 3)),
    zPlanes: [],
    // Version 2 stored rectangles and had no perspective at all.
    boxes: [{ x: 10, y: 100, width: 100, height: 40 }],
    objects: [],
    onEnter: [],
    onExit: [],
  };

  it('turns a rectangle into the equivalent quadrilateral', () => {
    const project = migrate({ version: 2, name: 'Old', rooms: [legacyRoom] });
    const box = project.rooms[0].boxes[0];

    expect(box.ul).toEqual({ x: 10, y: 100 });
    expect(box.ur).toEqual({ x: 109, y: 100 });
    expect(box.lr).toEqual({ x: 109, y: 139 });
    expect(box.ll).toEqual({ x: 10, y: 139 });
    expect(boxBounds(box)).toEqual({ x: 10, y: 100, width: 100, height: 40 });
    expect(isConvexBox(box)).toBe(true);
  });

  it('gives an old room a perspective ramp, because flat was never a choice', () => {
    const project = migrate({ version: 2, name: 'Old', rooms: [legacyRoom] });
    const room = project.rooms[0];

    expect(room.perspective).toBeDefined();
    expect(room.perspective!.nearScale).toBeGreaterThan(room.perspective!.farScale);
    // The ramp is useless unless the boxes opt in.
    expect(room.boxes[0].perspective).toBe(true);
  });

  it('leaves a room that already has perspective settings alone', () => {
    const ramp = { farY: 10, farScale: 20, nearY: 100, nearScale: 200 };
    const project = migrate({
      version: 2,
      name: 'Old',
      rooms: [{ ...legacyRoom, perspective: ramp }],
    });
    expect(project.rooms[0].perspective).toEqual(ramp);
  });

  it('produces a project that still compiles and scales', async () => {
    const project = migrate({
      version: 2,
      name: 'Old',
      rooms: [{ ...legacyRoom, boxes: [{ x: 0, y: 60, width: 320, height: 84 }] }],
    });
    project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));
    project.start = { room: 1, x: 100, y: 120 };

    const built = buildProject(project);
    expect(built.errors).toEqual([]);

    const source = new MemoryDataSource('migrated');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);

    const actor = engine.getActor(1)!;
    engine.putActor(1, 160, 105);
    const far = actor.getScale(engine.boxes);
    engine.putActor(1, 160, 142);
    expect(actor.getScale(engine.boxes)).toBeGreaterThan(far);
  });
});

describe('costume colour depth', () => {
  function celBytes(colors: 16 | 32, pixels: number[]): number[] {
    const image = createImage(pixels.length, 1, 0);
    image.pixels.set(pixels);
    return encodeCelPixels(image, colors);
  }

  it('packs a colour and a run into one byte at 16 colours', () => {
    // Four bits of colour, four of run length.
    expect(celBytes(16, [5, 5, 5])).toEqual([(5 << 4) | 3]);
  });

  it('packs three bits of run length at 32 colours', () => {
    expect(celBytes(32, [5, 5, 5])).toEqual([(5 << 3) | 3]);
  });

  it('reaches colours above 15 only in the 32 colour format', () => {
    // Colour 20 survives at 32 colours...
    expect(celBytes(32, [20])[0] >> 3).toBe(20);
    // ...but is masked to 4 bits at 16.
    expect(celBytes(16, [20])[0] >> 4).toBe(20 & 0x0f);
  });

  it('falls back to an explicit length byte past the inline limit', () => {
    // 16 colours can inline a run of 15; 32 colours only 7.
    expect(celBytes(16, new Array(15).fill(3))).toHaveLength(1);
    expect(celBytes(32, new Array(15).fill(3))).toHaveLength(2);
    expect(celBytes(32, new Array(15).fill(3))[1]).toBe(15);
  });

  it('declares the 32 colour format in the costume header', () => {
    const bytes = new Uint8Array(
      buildCostume({
        colors: 32,
        palette: new Array(31).fill(7),
        frames: [{}, { all: { image: createImage(4, 4, 1) } }],
      }),
    );
    // Byte 9 is the format; 0x59 is the 32 colour variant.
    expect(bytes[9] & 0x7f).toBe(0x59);
  });

  it('still declares the 16 colour format when asked', () => {
    const bytes = new Uint8Array(
      buildCostume({
        colors: 16,
        palette: new Array(15).fill(7),
        frames: [{}, { all: { image: createImage(4, 4, 1) } }],
      }),
    );
    expect(bytes[9] & 0x7f).toBe(0x58);
  });

  it('round-trips a high colour index through the engine', async () => {
    const project = playableProject();
    // Costume colour 20 maps to a bright game colour.
    project.actors[0].palette = new Array(31).fill(7);
    project.actors[0].palette[19] = 14;

    const sprite = createImage(8, 12, 20);
    project.actors[0].poses = [
      {},
      { all: [{ image: storeImage(sprite), hold: 6 }] },
      { all: [{ image: storeImage(sprite), hold: 6 }] },
      { all: [{ image: storeImage(sprite), hold: 6 }] },
      { all: [{ image: storeImage(sprite), hold: 6 }] },
      { all: [{ image: storeImage(sprite), hold: 6 }] },
    ];

    const built = buildProject(project);
    expect(built.errors).toEqual([]);

    const source = new MemoryDataSource('colours');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);

    const engine = await ScummEngine.create(source);
    engine.boot(0);
    engine.putActor(1, 60, 120);
    engine.step();
    engine.render();

    // Colour 14 can only be on screen if costume index 20 survived encoding,
    // decoding and the palette lookup.
    expect(engine.screen.copyPixels().includes(14)).toBe(true);
  });
});

describe('multiple actors', () => {
  function castProject(): Project {
    const project = playableProject();
    const frames = defaultSpriteFrames().map((pose) => ({
      all: pose.map((image) => ({ image: storeImage(image), hold: 6 })),
    }));
    project.actors[0].poses = frames;

    project.actors.push({
      id: 2,
      name: 'Barman',
      talkColor: 14,
      walkSpeed: { x: 4, y: 2 },
      palette: [...project.actors[0].palette],
      poses: frames,
      start: { room: 1, x: 220, y: 120 },
      handlers: [{ verbId: 4, actions: [{ type: 'setFlag', flag: 7, value: 3 }] }],
      otherwise: [{ type: 'setFlag', flag: 8, value: 1 }],
    });
    return project;
  }

  async function engineFor(project: Project): Promise<ScummEngine> {
    const built = buildProject(project);
    expect(built.errors).toEqual([]);
    const source = new MemoryDataSource('cast');
    source.set('GAME.000', built.index);
    source.set('GAME.001', built.data);
    const engine = await ScummEngine.create(source);
    engine.boot(0);
    return engine;
  }

  it('places a second actor in its starting room', async () => {
    const engine = await engineFor(castProject());
    const barman = engine.getActor(2)!;

    expect(barman.room).toBe(1);
    expect(barman.visible).toBe(true);
    expect(barman.x).toBe(220);
    expect(barman.name).toBe('Barman');
    expect(barman.costume).not.toBe(0);
  });

  it('gives each actor its own talk colour and speed', async () => {
    const engine = await engineFor(castProject());
    expect(engine.getActor(1)!.talkColor).toBe(11);
    expect(engine.getActor(2)!.talkColor).toBe(14);
    expect(engine.getActor(2)!.speedX).toBe(4);
  });

  it('runs an actor verb handler when the player interacts', async () => {
    const engine = await engineFor(castProject());

    // Target 2 is an actor, not an object: the sentence script has to route it
    // to the actor's dispatch script rather than looking for a room object.
    engine.doSentence(4, 2, 0);
    const flag = flagVar(7).index;
    for (let i = 0; i < 600 && engine.variables[flag] !== 3; i++) engine.step();

    expect(engine.variables[flag]).toBe(3);
  });

  it('falls back to the actor default for a verb with no handler', async () => {
    const engine = await engineFor(castProject());

    engine.doSentence(1, 2, 0); // "Look at", which the barman has no handler for
    const flag = flagVar(8).index;
    for (let i = 0; i < 600 && engine.variables[flag] !== 1; i++) engine.step();

    expect(engine.variables[flag]).toBe(1);
  });

  it('still routes objects to their own verb code', async () => {
    const project = castProject();
    project.rooms[0].objects[0].handlers = [
      { verbId: 1, actions: [{ type: 'setFlag', flag: 9, value: 5 }] },
    ];

    const engine = await engineFor(project);
    engine.doSentence(1, 100, 0);
    const flag = flagVar(9).index;
    for (let i = 0; i < 600 && engine.variables[flag] !== 5; i++) engine.step();

    expect(engine.variables[flag]).toBe(5);
  });

  it('leaves an unplaced actor out of every room', async () => {
    const project = castProject();
    project.actors[1].start = undefined;

    const engine = await engineFor(project);
    expect(engine.getActor(2)!.visible).toBe(false);
  });

  it('rejects an object id that collides with the actor range', () => {
    const project = castProject();
    project.rooms[0].objects[0].id = 5;
    expect(validateProject(project).some((p) => p.includes('clashes with the actor id'))).toBe(
      true,
    );
  });

  it('rejects a duplicate actor id', () => {
    const project = castProject();
    project.actors[1].id = 1;
    expect(validateProject(project).some((p) => p.includes('used more than once'))).toBe(true);
  });
});

describe('deleting a room', () => {
  function twoRoomProject(): Project {
    const project = playableProject();
    project.rooms.push({
      ...project.rooms[0],
      id: 2,
      name: 'room2',
      objects: [],
    });
    return project;
  }

  it('moves the game start when its room is deleted', () => {
    const state = new EditorState(twoRoomProject());
    expect(state.current.start.room).toBe(1);

    state.deleteRoom(1);

    expect(state.current.rooms.map((room) => room.id)).toEqual([2]);
    expect(state.current.start.room).toBe(2);
    // The project must still be playable, which is the whole point.
    expect(validateProject(state.current)).toEqual([]);
  });

  it('keeps the start position when only the room changes', () => {
    const project = twoRoomProject();
    project.start = { room: 1, x: 77, y: 133 };
    const state = new EditorState(project);

    state.deleteRoom(1);
    expect(state.current.start.x).toBe(77);
    expect(state.current.start.y).toBe(133);
  });

  it('leaves the start alone when a different room is deleted', () => {
    const state = new EditorState(twoRoomProject());
    state.deleteRoom(2);
    expect(state.current.start.room).toBe(1);
  });

  it('unplaces an actor whose room is deleted', () => {
    const project = twoRoomProject();
    project.actors.push({
      ...project.actors[0],
      id: 2,
      name: 'Extra',
      start: { room: 2, x: 100, y: 120 },
    });

    const state = new EditorState(project);
    state.deleteRoom(2);

    expect(state.current.actors[1].start).toBeUndefined();
    expect(validateProject(state.current)).toEqual([]);
  });

  it('refuses to delete the only room', () => {
    const state = new EditorState(playableProject());
    state.deleteRoom(1);
    expect(state.current.rooms).toHaveLength(1);
  });
});

describe('dangling room references', () => {
  it('reports an actor starting in a room that does not exist', () => {
    const project = playableProject();
    project.actors.push({
      ...project.actors[0],
      id: 2,
      name: 'Ghost',
      start: { room: 99, x: 0, y: 0 },
    });
    expect(validateProject(project).some((p) => p.includes('room 99'))).toBe(true);
  });

  it('reports a "go to room" step aimed at a room that does not exist', () => {
    const project = playableProject();
    project.rooms[0].objects[0].handlers = [
      { verbId: 1, actions: [{ type: 'gotoRoom', room: 42 }] },
    ];
    const problems = validateProject(project);
    expect(problems.some((p) => p.includes('goes to room 42'))).toBe(true);
    // The message must say where, or it is a needle in a haystack.
    expect(problems.some((p) => p.includes('Object 100'))).toBe(true);
  });

  it('looks inside conditional branches', () => {
    const project = playableProject();
    project.rooms[0].onEnter = [
      { type: 'if', flag: 1, equals: 1, then: [{ type: 'gotoRoom', room: 77 }] },
    ];
    expect(validateProject(project).some((p) => p.includes('room 77'))).toBe(true);
  });

  it('accepts a "go to room" step aimed at a room that exists', () => {
    const project = playableProject();
    project.rooms[0].objects[0].handlers = [
      { verbId: 1, actions: [{ type: 'gotoRoom', room: 1 }] },
    ];
    expect(validateProject(project)).toEqual([]);
  });
});

describe('sampling a colour from artwork', () => {
  it('returns the palette index at a point', () => {
    const image = createImage(16, 8, 3);
    rect(image, 4, 2, 3, 3, 42);

    expect(getPixel(image, 5, 3)).toBe(42);
    expect(getPixel(image, 0, 0)).toBe(3);
  });

  it('is bounds-checked, so a pick at the edge cannot read a neighbour row', () => {
    const image = createImage(4, 4, 7);
    // Without the guard, x = 4 would wrap onto the start of the next row.
    expect(getPixel(image, 4, 0)).toBe(0);
    expect(getPixel(image, -1, 0)).toBe(0);
    expect(getPixel(image, 0, 4)).toBe(0);
  });

  it('samples the stored artwork, which is what round-trips through a project', () => {
    // The editor picks from the room's own pixels rather than the rendered
    // canvas, so overlays like walk boxes cannot contaminate the colour.
    const image = createImage(32, 32, 5);
    rect(image, 10, 10, 4, 4, 200);

    const restored = loadImage(storeImage(image));
    expect(getPixel(restored, 11, 11)).toBe(200);
    expect(getPixel(restored, 1, 1)).toBe(5);
  });
});

describe('undo and the Virtual Theatre picture surfaces', () => {
  function skyDrawableProject(pictureId: number): Project {
    return {
      ...playableProject(),
      sky: {
        identification: 'the cd release',
        editable: { editable: true, unrecovered: 0, reasons: [] },
        records: [],
        text: { languages: [], read: false, note: '' },
        scripts: [],
        pictures: [{ id: pictureId, kind: 'screen', width: 320, height: 200, bytesBase64: 'AA==' }],
        palettes: [{ id: 99, bytesBase64: 'AA==', source: 'resource' }],
      },
    };
  }

  it('does not version the read-only pictures — undo keeps the current ones', () => {
    // The pictures are Preserved-bytes drawables (ADR 0025), excluded from the
    // undo snapshot like audio. If they were versioned, undoing the edit below
    // would bring the first picture back; because they are not, the current
    // picture survives. That is the whole reason they are held out: several
    // megabytes must not be copied onto the undo stack on every keystroke.
    const state = new EditorState(skyDrawableProject(1));
    state.update((project) => {
      project.name = 'edited';
      // A stand-in for the drawables being replaced out of band (a re-import),
      // which is the case the exclusion protects: undo must not revert it.
      (project.sky as { pictures: unknown }).pictures = [
        { id: 2, kind: 'screen', width: 320, height: 200, bytesBase64: 'AA==' },
      ];
    });

    state.undo();

    // The name reverted (it is versioned); the picture did not (it is not).
    expect(state.current.name).toBe('Test Game');
    expect(state.current.sky?.pictures?.map((p) => p.id)).toEqual([2]);
    expect(state.current.sky?.palettes).toHaveLength(1);
  });
});
