/**
 * A View's cels, shown one at a time, stepped through and played back.
 *
 * `docs/editor-parity.md` rows 15 and 18 for the SCI column, and row 14 through
 * them. Both were **No** for the same reason and it was not a fact about SCI:
 * the SCI surface had no image on it anywhere. Every kind of artwork left it as
 * a PNG (row 16) and none of it was ever drawn in the pane, so "pick a frame"
 * and "play it back" had nothing to pick a frame of.
 *
 * ## Why this is one widget and not two panes
 *
 * A View is the only animated thing SCI ships, and a cast member is a View seen
 * as a person (ADR 0037's point, one layer down — the same one `sciCast` makes).
 * So the View pane and the Cast pane want the same three controls over the same
 * bytes, and the alternative is two implementations of a frame strip that drift.
 *
 * ## Speed
 *
 * **A SCI View does not carry a frame rate**, and that is a fact about the
 * format rather than a gap here: what an animation runs at is the `cycleSpeed`
 * the *instance* is given, in game cycles, and the game's cycle is what the
 * interpreter is pacing at. So a caller that knows an instance's own speed
 * passes it and the strip says where the number came from; a caller with only a
 * View passes nothing and gets SCI's own default of one cel per cycle, said
 * plainly rather than implied. Neither is invented — the label always names
 * which of the two is being played.
 */

import { announce } from '../../ui/a11y.js';
import { groupItem, rovingGroup } from '../a11yWidgets.js';
import type { SciViewResource } from '../../engine/sci/gfx/SciView.js';
import type { RenderedImage } from '../imageExport.js';
import { renderSciViewCel, type SciColours } from './sciImages.js';
import { readSciView } from '../../engine/sci/gfx/SciView.js';
import { fromBase64 } from '../../authoring/base64.js';
import { sciPropertyValue } from '../../authoring/sci/sciRooms.js';
import type { SciProject, SciProjectObject } from '../../authoring/project.js';

/**
 * SCI's own cycle, in milliseconds.
 *
 * Sierra's interpreter runs its game loop at 60 ticks a second and a `Cycle`
 * advances a cel once per `cycleSpeed` of them. `SciEngine.ticksPerStep` is the
 * same 1 from the other side.
 */
const SCI_TICK_MS = 1000 / 60;

/** How fast to step, and where the number came from. */
export interface SciCelSpeed {
  /** Game cycles per cel. SCI's own default, when nothing says otherwise, is 1. */
  cycles: number;
  /** Named on the panel, so a played speed is never mistaken for a measured one. */
  how: string;
}

export interface SciCelStripOptions {
  /** Unique per pane, so two strips' element ids never collide. */
  id: string;
  view: SciViewResource;
  colours: SciColours;
  /** Which loop's cels the strip shows. */
  loop: number;
  /** Which cel of it is drawn. */
  cel: number;
  onSelect: (loop: number, cel: number) => void;
  /** What this View is, said to a screen reader. */
  title: string;
  speed?: SciCelSpeed;
}

/** SCI's default, which is one cel per game cycle. */
export const SCI_DEFAULT_CEL_SPEED: SciCelSpeed = {
  cycles: 1,
  how: "SCI's own default of one cel a cycle, this View carrying no rate of its own",
};

/**
 * A loop picker, a frame strip, the frame drawn, and a Play button.
 *
 * Returns the element and a `stop`, because a pane that is torn down while a
 * loop is playing leaves a timer writing into a canvas that is no longer in the
 * document — which in this editor's own shell is a leak per selection change.
 */
export function sciCelStrip(options: SciCelStripOptions): {
  element: HTMLElement;
  stop: () => void;
} {
  const panel = document.createElement('div');
  panel.className = 'sci-cel-strip';

  const status = document.createElement('p');
  status.className = 'sci-note';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const loop = options.view.loops[options.loop];
  if (!loop || loop.cels.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sci-note';
    empty.textContent = 'This loop has no cels, so there is nothing to draw or to play.';
    panel.appendChild(empty);
    return { element: panel, stop: () => {} };
  }

  // Which cel is showing *now*, which playback moves and the strip follows.
  // Held here rather than in `options` because a play is not a selection: it
  // must not write an author's chosen frame back through `onSelect` sixty
  // times a second.
  let showing = Math.min(Math.max(0, options.cel), loop.cels.length - 1);
  let timer: ReturnType<typeof setInterval> | null = null;

  const figure = document.createElement('div');
  figure.className = 'sci-cel-figure';
  const canvas = document.createElement('canvas');
  canvas.className = 'sci-cel-canvas';
  figure.appendChild(canvas);
  const caption = document.createElement('p');
  caption.className = 'sci-note';

  const strip = document.createElement('div');
  strip.className = 'sci-frame-strip';
  const frames: HTMLButtonElement[] = [];

  const draw = (): void => {
    const image = renderSciViewCel(options.view, options.loop, showing, options.colours);
    if (!image) return;
    paint(canvas, image);
    const cel = loop.cels[showing];
    caption.textContent =
      `Cel ${showing} of ${loop.cels.length}, ${cel.width}x${cel.height}, ` +
      `origin ${cel.displaceX}, ${cel.displaceY}.`;
    for (const [index, button] of frames.entries()) {
      button.setAttribute('aria-checked', String(index === showing));
    }
  };

  for (const [index, cel] of loop.cels.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sci-frame';
    button.textContent = String(index);
    groupItem(button, {
      role: 'radio',
      selected: index === showing,
      label: `cel ${index}, ${cel.width} by ${cel.height}`,
    });
    button.addEventListener('click', () => {
      stop();
      showing = index;
      draw();
      options.onSelect(options.loop, index);
      announce(`cel ${index} of loop ${options.loop}`);
    });
    frames.push(button);
    strip.appendChild(button);
  }
  rovingGroup(strip, {
    role: 'radiogroup',
    label: `cels of loop ${options.loop} of ${options.title}`,
    orientation: 'horizontal',
  });

  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    play.textContent = 'Play the loop at its real speed';
    play.setAttribute('aria-pressed', 'false');
  };

  const speed = options.speed ?? SCI_DEFAULT_CEL_SPEED;
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'sci-play';
  play.textContent = 'Play the loop at its real speed';
  play.setAttribute('aria-pressed', 'false');
  play.addEventListener('click', () => {
    if (timer !== null) {
      stop();
      status.textContent = `Stopped on cel ${showing}.`;
      return;
    }
    // A one-cel loop has nothing to play, and a timer that redraws the same
    // pixels forever is a button that looks like it worked.
    if (loop.cels.length < 2) {
      status.textContent = 'This loop has one cel, so there is nothing to play.';
      return;
    }
    play.textContent = 'Stop';
    play.setAttribute('aria-pressed', 'true');
    timer = setInterval(
      () => {
        showing = (showing + 1) % loop.cels.length;
        draw();
      },
      Math.max(1, speed.cycles) * SCI_TICK_MS,
    );
    status.textContent = `Playing at ${speed.how}.`;
  });

  const rate = document.createElement('p');
  rate.className = 'sci-carried';
  rate.textContent =
    `Played at ${speed.how}. A SCI View carries no frame rate of its own — what an animation ` +
    `runs at is the cycleSpeed its instance is given, in the interpreter's own 60-a-second ` +
    `cycles — so this names which of the two is being used rather than implying a measurement.`;

  panel.appendChild(strip);
  panel.appendChild(figure);
  panel.appendChild(caption);
  panel.appendChild(play);
  panel.appendChild(rate);
  panel.appendChild(status);
  draw();
  return { element: panel, stop };
}

/**
 * An image onto a canvas, at whole-number magnification.
 *
 * Nearest-neighbour and never smoothed, for the reason the compositor gives:
 * a smoothed SCI cel is a different picture from the one the artist drew. A
 * cel of 30 pixels across shown at 30 pixels is unreadable on a modern screen,
 * so it is doubled until it is not, and never past the pane.
 */
function paint(canvas: HTMLCanvasElement, image: RenderedImage): void {
  const zoom = Math.max(1, Math.min(6, Math.floor(240 / Math.max(image.width, image.height)) || 1));
  canvas.width = image.width * zoom;
  canvas.height = image.height * zoom;
  const context = canvas.getContext('2d');
  // jsdom has no 2D context, and a surface that throws there is a surface the
  // tests cannot reach at all.
  if (!context) return;
  context.imageSmoothingEnabled = false;
  const buffer = document.createElement('canvas');
  buffer.width = image.width;
  buffer.height = image.height;
  const into = buffer.getContext('2d');
  if (!into) return;
  // Through the context rather than `new ImageData`, which wants a buffer this
  // one does not have — the same reason `imageExport` and the room canvas do.
  const source = into.createImageData(image.width, image.height);
  source.data.set(image.rgba);
  into.putImageData(source, 0, 0);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(buffer, 0, 0, canvas.width, canvas.height);
}

/**
 * The View a cast member wears, or a sentence saying why there is none.
 *
 * **Three property words and no guessing.** A SCI instance carries `view`,
 * `loop` and `cel`, and `cycleSpeed` where it declares one. What is drawn is
 * what those say; where `view` is 65535 or 0 — SCI's "none" and the class
 * default an instance that never declared one ships with — this says so rather
 * than drawing View 0, which is a real resource in most games and is never the
 * one meant.
 *
 * A great many of King's Quest VII's cast are in that second case, because a
 * SCI room commonly dresses its actors in `init`. That is the same fact the
 * room canvas already states about positions, and it is stated the same way:
 * the shipped default is what an author can edit and an export can write back,
 * so it is what an editor should claim.
 */
export function sciCastArt(
  member: { object: SciProjectObject; name: string },
  project: SciProject,
): { number: number; view: SciViewResource; speed: SciCelSpeed } | string {
  const declared = sciPropertyValue(member.object, 'view', project);
  if (declared === null) {
    return `${member.name} declares no view property, so this release names no artwork for them.`;
  }
  if (declared === 0 || declared === 0xffff) {
    return (
      `${member.name} ships ${declared === 0xffff ? "SCI's own “no View”, 65535" : 'View 0'} ` +
      `in its view property, which means the room dresses them in its own init rather than in ` +
      `the file. There is no artwork here to draw without running the game.`
    );
  }

  const resource = project.resources.find((one) => one.type === 'view' && one.number === declared);
  if (!resource) {
    return `${member.name} wears View ${declared}, which this release does not ship.`;
  }

  let view: SciViewResource;
  try {
    view = readSciView(fromBase64(resource.bytes));
  } catch (error) {
    return `View ${declared} could not be read: ${String(error)}`;
  }

  const cycleSpeed = sciPropertyValue(member.object, 'cycleSpeed', project);
  const speed: SciCelSpeed =
    cycleSpeed !== null && cycleSpeed > 0 && cycleSpeed < 0x8000
      ? { cycles: cycleSpeed, how: `this instance's own cycleSpeed of ${cycleSpeed}` }
      : SCI_DEFAULT_CEL_SPEED;
  return { number: declared, view, speed };
}
