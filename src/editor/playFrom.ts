import { boxBounds } from '../authoring/GameBuilder.js';
import { visibleRoomRows, type Project, type ProjectRoom } from '../authoring/project.js';
import type { ScummEngine } from '../engine/ScummEngine.js';

/**
 * Where Play should begin.
 *
 * The room being edited, not the game's start room. An editor's Play button is
 * for seeing the thing in front of you: a game imported from a published one
 * starts in whichever room happened to come first, and even in an authored game
 * testing room 14 by walking there from room 1 is not testing room 14.
 *
 * The project itself is untouched — the override is a copy, so playing never
 * quietly rewrites where the finished game begins.
 */
export function playableStart(project: Project, room: ProjectRoom | null): Project {
  if (!room) return project;
  const visibleBottom = visibleRoomRows(project.screen);
  return { ...project, start: { room: room.id, ...startPointIn(room, visibleBottom) } };
}

/**
 * A point the player can stand on *and* be seen at.
 *
 * Inside a walk box, because an actor dropped outside every box has nowhere to
 * walk from and looks stuck. Blocked boxes are skipped for the same reason.
 *
 * Being seen is the other half, and the one that is easy to miss. Actors are
 * drawn clipped to the room view, so an actor placed at or below `visibleBottom`
 * is not partly hidden — it is not drawn at all. A room may legitimately be
 * taller than the view (the camera pans), and an imported room keeps whatever
 * height the published game gave it, which is often the full 200. Deciding
 * where to *start* from the room's own height therefore put the player in the
 * rows behind the verb panel: the room drew perfectly and the character was
 * simply absent.
 *
 * `visibleBottom` is a room row, so it is the *height* of the view and not the
 * screen row the verbs start at — the two differ by the text band above the
 * room, and taking the second for the first leaves a band of legal-looking
 * standing room that nothing is ever drawn in.
 */
export function startPointIn(
  room: ProjectRoom,
  visibleBottom: number = visibleRoomRows(),
): { x: number; y: number } {
  // The floor of the band the player has to end up in: never past the room,
  // never past what the view shows.
  const limit = Math.max(1, Math.min(room.height, visibleBottom));

  // Boxes that are actually in the room. A published game's box list is not
  // all floor: it carries degenerate boxes parked at the coordinates SCUMM
  // uses to put things out of sight, and one of those is a perfectly ordinary
  // unblocked box as far as a filter on `blocked` can tell. Picking one gave a
  // start point of -31999, which Play then applied, and went on applying every
  // time it noticed the player was not visible — putting them back exactly
  // where they could not be seen.
  const standable = room.boxes.filter(
    (candidate) => !candidate.blocked && overlapsRoom(boxBounds(candidate), room),
  );

  // A box that reaches into the visible band is worth far more than the first
  // one in the list, which in an imported room may be anywhere.
  const box = standable.find((candidate) => boxBounds(candidate).y < limit) ?? standable[0];

  if (!box) {
    return { x: Math.round(room.width / 2), y: Math.round(limit * 0.8) };
  }

  const bounds = boxBounds(box);
  // Stand at the box's middle, but never below the box and never out of sight.
  const lowest = Math.min(bounds.y + bounds.height - 1, limit - 1);
  return {
    x: Math.max(0, Math.min(Math.round(bounds.x + bounds.width / 2), room.width - 1)),
    y: Math.max(0, Math.min(Math.round(bounds.y + bounds.height / 2), lowest)),
  };
}

/** Whether a box's bounding rectangle is anywhere inside the room at all. */
function overlapsRoom(
  bounds: { x: number; y: number; width: number; height: number },
  room: ProjectRoom,
): boolean {
  return (
    bounds.x + bounds.width > 0 &&
    bounds.x < room.width &&
    bounds.y + bounds.height > 0 &&
    bounds.y < room.height
  );
}

/**
 * Puts the player back where Play put them, if the room has moved them out of
 * sight.
 *
 * A room imported from a published game brings its own entry script, and a
 * game's opening room may quite reasonably move the player out of sight and
 * expect its own opening cutscene to bring them back. Playing one room never
 * runs that opening, so nothing ever does — the start point Play chose inside
 * a visible walk box is chosen, applied, and then quietly discarded, leaving a
 * room with no character in it and no error to say why.
 *
 * Play exists to show the room in front of you, so the player has to be in it,
 * and here Play wins. But only when the player is genuinely nowhere the screen
 * shows: an opening that walks them somewhere visible is the room working, and
 * putting them back would be Play fighting the game rather than starting it.
 * A room change is left alone for the same reason — the game has gone
 * somewhere on purpose, and this is no longer the room being played.
 *
 * Returns what it did, for the log, or null if it did nothing.
 */
export function keepPlayerVisible(
  engine: ScummEngine,
  start: { room: number; x: number; y: number },
): string | null {
  const number = engine.variables[engine.vars.EGO];
  const ego = engine.actors[number];
  if (!ego) return null;
  if (engine.currentRoom !== start.room) return null;

  const problems = engine.actorPlacementProblems(number);
  if (problems.length === 0) return null;

  engine.putActorInRoom(number, start.room);
  engine.putActor(number, start.x, start.y);
  engine.actorFollowCamera(number);

  // Whether it worked. A start point that is itself off screen — a room whose
  // box list included one parked out of sight — meant Play put the player back
  // exactly where they could not be seen, noticed they were still missing, and
  // did it again. Saying so names the fault instead of repeating it.
  const after = engine.actorPlacementProblems(number);
  if (after.length > 0) {
    return (
      `Play tried to put the player back at ${start.x},${start.y}, but that is ` +
      `not somewhere they can be seen either (${after.join('; ')}). The room's ` +
      `walk boxes do not give a usable start point.`
    );
  }

  return (
    `The room left the player where nothing is drawn (${problems.join('; ')}), ` +
    `so Play put them back at ${start.x},${start.y}.`
  );
}
