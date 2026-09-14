/**
 * A small complete game, built entirely in code.
 *
 * It exists to be read: every feature the authoring API has is used once, in
 * the order you would use them, with no art assets on disk. Compile it with
 * `npm run build:game examples/demo/game.ts`.
 */
import {
  createImage,
  defineGame,
  global,
  pixels,
  rect,
  rectangleBox,
  speckle,
  verticalGradient,
  maskRect,
  VAR,
  type IndexedImage,
} from '../../src/authoring/index.js';

// Palette indices from the default palette. Naming them keeps the drawing code
// readable and makes a palette change a one-line edit.
const BLACK = 0;
const DARK_GREY = 8;
const GREY = 7;
const WHITE = 15;
const YELLOW = 14;
const BROWN = 6;
const RED = 4;
const GREEN = 2;
const CYAN = 11;
const BLUE = 1;

const ROOM_WIDTH = 320;
const ROOM_HEIGHT = 144;

/** A flag remembering whether the player has already been told about the door. */
const WARNED_ABOUT_DOOR = global(210);

// ----------------------------------------------------------------- artwork --

function streetBackground(): IndexedImage {
  const image = createImage(ROOM_WIDTH, ROOM_HEIGHT, BLACK);

  // Night sky, fading down toward the horizon.
  verticalGradient(image, 0, 80, BLUE, DARK_GREY);
  speckle(image, 0, 0, ROOM_WIDTH, 60, WHITE, 60, 20250830);

  // Building facade on the left, with lit windows.
  rect(image, 0, 40, 150, 62, DARK_GREY);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 4; column++) {
      const lit = (row + column) % 3 !== 0;
      rect(image, 14 + column * 34, 50 + row * 18, 16, 11, lit ? YELLOW : BLACK);
    }
  }

  // Road and pavement.
  rect(image, 0, 102, ROOM_WIDTH, 6, GREY);
  rect(image, 0, 108, ROOM_WIDTH, ROOM_HEIGHT - 108, DARK_GREY);
  for (let x = 8; x < ROOM_WIDTH; x += 40) rect(image, x, 128, 20, 2, GREY);

  // A lamp post on the right, which the player can walk behind.
  rect(image, 250, 30, 4, 78, GREY);
  rect(image, 240, 26, 24, 6, GREY);

  return image;
}

function officeBackground(): IndexedImage {
  const image = createImage(ROOM_WIDTH, ROOM_HEIGHT, BLACK);

  rect(image, 0, 0, ROOM_WIDTH, 104, BROWN);
  rect(image, 0, 104, ROOM_WIDTH, ROOM_HEIGHT - 104, DARK_GREY);

  // Skirting and a picture on the wall.
  rect(image, 0, 100, ROOM_WIDTH, 4, GREY);
  rect(image, 60, 30, 40, 30, GREY);
  rect(image, 63, 33, 34, 24, GREEN);

  // A desk.
  rect(image, 170, 70, 90, 8, BROWN);
  rect(image, 174, 78, 6, 26, DARK_GREY);
  rect(image, 250, 78, 6, 26, DARK_GREY);

  return image;
}

/** The door, drawn in two states: shut, then open. */
function doorStates(): IndexedImage[] {
  const shut = createImage(24, 44, BLACK);
  rect(shut, 0, 0, 24, 44, BROWN);
  rect(shut, 1, 1, 22, 42, RED);
  rect(shut, 18, 22, 3, 3, YELLOW);

  const open = createImage(24, 44, BLACK);
  rect(open, 0, 0, 24, 44, BROWN);
  rect(open, 3, 2, 21, 42, BLACK);

  return [shut, open];
}

/** A key, small enough that it reads as pick-up-able. */
function keyStates(): IndexedImage[] {
  return [
    pixels(
      `
      ..###..
      .#...#.
      .#...#.
      ..###..
      ...#...
      ...#...
      ...##..
      ...#...
      ...##..
      `,
      { '#': YELLOW, '.': BLACK },
    ),
  ];
}

/**
 * The player character.
 *
 * One cel per animation frame, reused for every facing — the engine mirrors it
 * when he walks west, which is enough for a character this simple.
 */
function heroCostume() {
  const key = {
    '.': 0,
    h: 1, // hair
    f: 2, // face
    c: 3, // coat
    l: 4, // legs
    s: 5, // shoes
  };

  const standing = pixels(
    `
    ..hhhh..
    .hffffh.
    .ffffff.
    ..ffff..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    ..l..l..
    ..l..l..
    ..l..l..
    .ss..ss.
    `,
    key,
  );

  const walking = pixels(
    `
    ..hhhh..
    .hffffh.
    .ffffff.
    ..ffff..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    .l....l.
    .l....l.
    .l....l.
    ss....ss
    `,
    key,
  );

  const talking = pixels(
    `
    ..hhhh..
    .hffffh.
    .ffffff.
    ..fddf..
    ...cc...
    ..cccc..
    .cccccc.
    .cccccc.
    ..cccc..
    ..c..c..
    ..llll..
    ..l..l..
    ..l..l..
    ..l..l..
    .ss..ss.
    `,
    { ...key, d: 6 },
  );

  return {
    // Costume colour 0 is transparent; 1-6 map onto palette entries.
    palette: [BLACK, BROWN, YELLOW, GREEN, BLUE, DARK_GREY, RED],
    frames: [
      {}, // frame 0 is never played
      { all: { image: standing } }, // 1 init
      { all: { image: walking } }, // 2 walk
      { all: { image: standing } }, // 3 stand
      { all: { image: talking } }, // 4 talk start
      { all: { image: standing } }, // 5 talk stop
    ],
  };
}

// -------------------------------------------------------------------- game --

const game = defineGame({
  name: 'Nightfall',
  start: { room: 1, x: 80, y: 126 },
  screen: { textHeight: 16, verbTop: 144 },
  defaultResponse: "I don't think that would help.",
});

// Verbs, laid out in the panel below the play area.
const LOOK = 1;
const PICK_UP = 2;
const OPEN = 3;
const TALK_TO = 4;
const USE = 5;

game.verb({ id: LOOK, text: 'Look at', x: 12, y: 152, key: 'l' });
game.verb({ id: PICK_UP, text: 'Pick up', x: 12, y: 164, key: 'p' });
game.verb({ id: OPEN, text: 'Open', x: 12, y: 176, key: 'o' });
game.verb({ id: TALK_TO, text: 'Talk to', x: 120, y: 152, key: 't' });
game.verb({ id: USE, text: 'Use', x: 120, y: 164, key: 'u' });

game.actor({
  id: 1,
  name: 'Foster',
  costume: heroCostume(),
  talkColor: CYAN,
  walkSpeed: { x: 5, y: 2 },
});

// --- room 1: the street ------------------------------------------------------

const street = game.room({
  id: 1,
  name: 'street',
  width: ROOM_WIDTH,
  height: ROOM_HEIGHT,
  background: streetBackground(),
  // The lamp post occludes the player, so he can walk behind it.
  zPlanes: [maskRect(ROOM_WIDTH, ROOM_HEIGHT, [{ x: 248, y: 26, width: 18, height: 82 }])],
  boxes: [rectangleBox(0, 108, ROOM_WIDTH, 36, { perspective: true })],
});

street.onEnter((s) => {
  s.move(global(VAR.CAMERA_MIN_X), 160);
  s.move(global(VAR.CAMERA_MAX_X), 160);
});

const door = street.object({
  id: 100,
  name: 'door',
  x: 40,
  y: 58,
  width: 24,
  height: 44,
  walkTo: { x: 52, y: 116 },
  facing: 'north',
  states: doorStates(),
  initialState: 1,
});

door
  .on(LOOK, (s) => s.sayEgo('A red door. It has seen better decades.'))
  .on(OPEN, (s) => {
    // Object state 2 is the open door; setting it restamps the background.
    s.ifEqual(WARNED_ABOUT_DOOR, 0, (body) => {
      body.sayEgo('It sticks a little.');
      body.move(WARNED_ABOUT_DOOR, 1);
    });
    s.setState(100, 2);
    // `loadRoomWithEgo` places the player at object 201 — the way out, on the
    // office side. A plain `loadRoom` would not work here: changing room kills
    // the object script that called it, so anything after it never runs.
    s.loadRoomWithEgo(201, 2, -1, -1);
  })
  .otherwise((s) => s.sayEgo("That's not going to open it."));

const lamp = street.object({
  id: 101,
  name: 'lamp post',
  x: 240,
  y: 26,
  width: 24,
  height: 82,
  walkTo: { x: 230, y: 124 },
  facing: 'east',
});

lamp
  .on(LOOK, (s) => s.sayEgo('The light flickers. Nobody has fixed it in years.'))
  .on(TALK_TO, (s) => {
    s.sayEgo('Hello, lamp post.');
    s.waitForMessage();
    s.sayEgo('It says nothing. As expected.');
  });

// --- room 2: the office ------------------------------------------------------

const office = game.room({
  id: 2,
  name: 'office',
  width: ROOM_WIDTH,
  height: ROOM_HEIGHT,
  background: officeBackground(),
  boxes: [rectangleBox(0, 106, ROOM_WIDTH, 38, { perspective: true })],
});

const officeKey = office.object({
  id: 200,
  name: 'small key',
  x: 200,
  y: 60,
  width: 8,
  height: 10,
  walkTo: { x: 204, y: 118 },
  facing: 'north',
  states: keyStates(),
  initialState: 1,
  classes: [22], // pickupable
});

officeKey
  .on(LOOK, (s) => s.sayEgo('A small brass key, left on the desk.'))
  .on(PICK_UP, (s) => {
    s.sayEgo('I might need this.');
    s.pickupObject(200);
  });

const exitDoor = office.object({
  id: 201,
  name: 'way out',
  x: 20,
  y: 58,
  width: 24,
  height: 46,
  walkTo: { x: 32, y: 116 },
  facing: 'west',
});

exitDoor
  .on(LOOK, (s) => s.sayEgo('The way back to the street.'))
  .on(OPEN, (s) => s.loadRoomWithEgo(100, 1, -1, -1));

office.onEnter((s) => {
  s.move(global(VAR.CAMERA_MIN_X), 160);
  s.move(global(VAR.CAMERA_MAX_X), 160);
  s.ifEqual(global(220), 0, (body) => {
    body.move(global(220), 1);
    body.sayEgo('Someone left in a hurry.');
  });
});

// A named script, callable from anywhere with `startScript(10)`.
game.script(10, (s) => {
  s.sayEgo('Nothing here but the hum of the city.');
});

export default game;
