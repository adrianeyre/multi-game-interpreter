import { referenceAudio, storeAudio, type ProjectAudio } from '../authoring/audio.js';
import {
  deleteAudioBytes,
  INLINE_LIMIT,
  isAudioStoreAvailable,
  newAudioKey,
  putAudioBytes,
} from './audioStore.js';
import { createImage } from '../authoring/ImageEncoder.js';
import { rectangleBox } from '../authoring/GameBuilder.js';
import { storeImage } from '../authoring/imageCodec.js';
import {
  ACTOR_ID_LIMIT,
  createProject,
  nextId,
  type Project,
  type ProjectActor,
  type ProjectObject,
  type ProjectRoom,
  type SpritePose,
  POSE_DIRECTIONS,
} from '../authoring/project.js';
import { DEFAULT_HOLD, defaultSpriteFrames } from './SpriteCanvas.js';
import { putAutosave } from './importedStorage.js';
import { loadLocal, saveLocal } from './storage.js';

export interface Selection {
  roomId: number | null;
  objectId: number | null;
  boxIndex: number | null;
  actorId: number;
}

type Listener = () => void;

/**
 * The editor's single source of truth.
 *
 * Every mutation goes through `update`, which snapshots for undo, autosaves and
 * notifies. Centralising it means no code path can change the project without
 * the author being able to undo it or the autosave missing it — the two ways an
 * editor loses someone's work.
 */
export class EditorState {
  private project: Project;
  private selection: Selection = { roomId: null, objectId: null, boxIndex: null, actorId: 1 };

  private readonly undoStack: string[] = [];
  private readonly redoStack: string[] = [];
  private readonly listeners = new Set<Listener>();

  /** Bounded so a long session cannot exhaust memory. */
  private readonly undoLimit = 60;

  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  lastError: string | null = null;

  /**
   * Bumped on every change to the project.
   *
   * Lets a view cache work derived from the project — compiling it, most of
   * all — without comparing megabytes to find out whether anything moved.
   */
  private revisionCounter = 0;

  get revision(): number {
    return this.revisionCounter;
  }

  constructor(project?: Project) {
    this.project = project ?? loadLocal() ?? withStarterContent(createProject('My Game'));
    if (this.project.rooms.length > 0) this.selection.roomId = this.project.rooms[0].id;
  }

  // ------------------------------------------------------------ observing --

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get current(): Project {
    return this.project;
  }

  get selected(): Selection {
    return this.selection;
  }

  get currentRoom(): ProjectRoom | null {
    return this.project.rooms.find((room) => room.id === this.selection.roomId) ?? null;
  }

  get currentActor(): ProjectActor | null {
    return this.project.actors.find((actor) => actor.id === this.selection.actorId) ?? null;
  }

  get currentObject(): ProjectObject | null {
    const room = this.currentRoom;
    if (!room || this.selection.objectId === null) return null;
    return room.objects.find((object) => object.id === this.selection.objectId) ?? null;
  }

  // -------------------------------------------------------------- editing --

  /**
   * Applies a mutation.
   *
   * `transient` skips the undo snapshot, for the continuous stream of changes a
   * drag produces — otherwise one drag would fill the undo stack and a single
   * undo would move the object by a pixel.
   */
  update(mutate: (project: Project) => void, options: { transient?: boolean } = {}): void {
    if (!options.transient) {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
      this.redoStack.length = 0;
    }

    mutate(this.project);
    this.revisionCounter++;
    this.scheduleSave();
    this.notify();
  }

  /** Takes an undo snapshot without changing anything — call before a drag. */
  beginTransaction(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > this.undoLimit) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  select(selection: Partial<Selection>): void {
    this.selection = { ...this.selection, ...selection };
    this.notify();
  }

  undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.snapshot());
    this.restore(previous);
    this.revisionCounter++;
    this.clampSelection();
    this.scheduleSave();
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    this.revisionCounter++;
    this.clampSelection();
    this.scheduleSave();
    this.notify();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  replaceProject(project: Project): void {
    this.undoStack.push(this.snapshot());
    this.project = project;
    this.revisionCounter++;
    this.selection = {
      roomId: project.rooms[0]?.id ?? null,
      objectId: null,
      boxIndex: null,
      actorId: project.actors[0]?.id ?? 1,
    };
    this.scheduleSave();
    this.notify();
  }

  /**
   * Serialises everything except the parts carried across undo untouched.
   *
   * Undo keeps up to sixty snapshots, so the parts of a project measured in
   * megabytes rather than kilobytes are left out and carried unversioned:
   *
   * - **audio** — a handful of imported tracks would put hundreds of megabytes
   *   of duplicated base64 in memory. Importing and deleting tracks are not
   *   undoable; the editor confirms a delete instead.
   * - **the Virtual Theatre picture surfaces** — Sky's screens, room backgrounds,
   *   palettes and sprites, and Lure's room pictures. These are read-only Preserved
   *   bytes (a viewer, ADR 0025), so nothing edits them and there is nothing to
   *   undo; versioning them would copy several megabytes on every keystroke.
   *   Excluded by path, not by key name: AGI's `pictures` and Lure's `palettes`
   *   are editable and must stay in the history.
   */
  private snapshot(): string {
    const { audio: _audio, sky, lure, ...rest } = this.project;
    const trimmed: Record<string, unknown> = { ...rest };
    if (sky) {
      const { pictures: _p, palettes: _q, sprites: _r, ...skyRest } = sky;
      trimmed.sky = skyRest;
    }
    if (lure) {
      const { pictures: _lp, ...lureRest } = lure;
      trimmed.lure = lureRest;
    }
    return JSON.stringify(trimmed);
  }

  private restore(json: string): void {
    const { audio, sky, lure } = this.project;
    const next = JSON.parse(json) as Project;
    // Re-attach the untouched, unversioned parts from the live project.
    const restored: Project = { ...next, audio };
    if (next.sky && sky) {
      restored.sky = {
        ...next.sky,
        pictures: sky.pictures,
        palettes: sky.palettes,
        sprites: sky.sprites,
      };
    }
    if (next.lure && lure) {
      restored.lure = { ...next.lure, pictures: lure.pictures };
    }
    this.project = restored;
  }

  private clampSelection(): void {
    if (!this.project.rooms.some((room) => room.id === this.selection.roomId)) {
      this.selection.roomId = this.project.rooms[0]?.id ?? null;
    }
    if (!this.currentRoom?.objects.some((o) => o.id === this.selection.objectId)) {
      this.selection.objectId = null;
    }
    if (!this.project.actors.some((actor) => actor.id === this.selection.actorId)) {
      this.selection.actorId = this.project.actors[0]?.id ?? 1;
    }
  }

  /**
   * Autosave, debounced.
   *
   * Writing on every keystroke would serialise the whole project — megabytes of
   * base64 images — dozens of times a second.
   */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        saveLocal(this.project);
        this.lastError = null;
      } catch (error) {
        // Almost always a project too big for local storage, which is what a
        // decompiled game is. IndexedDB has room, so the work is kept rather
        // than the author being told it cannot be.
        void putAutosave(this.project).then(
          () => {
            this.lastError = null;
            this.notify();
          },
          () => {
            this.lastError = error instanceof Error ? error.message : String(error);
            this.notify();
          },
        );
      }
      this.notify();
    }, 400);
  }

  /** Forces an immediate autosave, for beforeunload. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      saveLocal(this.project);
    } catch {
      // Nothing useful to do while the page is closing.
    }
  }

  // ------------------------------------------------------------- creating --

  addRoom(): ProjectRoom {
    const id = nextId(this.project.rooms.map((room) => room.id));
    const room = blankRoom(id);
    this.update((project) => project.rooms.push(room));
    this.select({ roomId: id, objectId: null, boxIndex: null });
    return room;
  }

  /**
   * Adds an imported file to the audio library.
   *
   * The id is what scripts will say, so it is allocated from the sounds
   * already present rather than from the position in the list — deleting a
   * track must not silently repoint a `playSound` action at a different one.
   */
  /**
   * Adds an imported file to the audio library.
   *
   * The id is what scripts will say, so it is allocated from the sounds
   * already present rather than from the position in the list — deleting a
   * track must not silently repoint a `playSound` action at a different one.
   *
   * Small audio goes into the project, where it travels with a `.json` export
   * for free. Anything larger goes into the audio store and the project keeps
   * a reference: a CD soundtrack is hundreds of megabytes, and the project is
   * a document that gets re-serialised every time anything is edited.
   */
  async addAudio(filename: string, bytes: Uint8Array): Promise<ProjectAudio> {
    const id = nextId(this.project.audio.map((track) => track.id));

    if (bytes.length <= INLINE_LIMIT || !isAudioStoreAvailable()) {
      const track = storeAudio(id, filename, bytes);
      this.update((project) => project.audio.push(track));
      return track;
    }

    const key = newAudioKey();
    // Written before the project mentions it, so a failed write leaves no
    // track pointing at audio that was never stored.
    await putAudioBytes(key, bytes);

    const track = referenceAudio(id, filename, bytes, key);
    this.update((project) => project.audio.push(track));
    return track;
  }

  /**
   * Puts new bytes behind a track that already exists, keeping its id.
   *
   * The id is what a script says, so replacing a recording must not change it:
   * this is the difference between "this line now sounds different" and
   * "every script that played this line now plays nothing". For the same
   * reason the `resource` stays — a game's own recording that an author
   * replaced is still *that* recording, and an export needs to know which of
   * the game's sounds to write the new bytes over.
   *
   * Same two homes as an import, on the same threshold: small audio inlines
   * into the document and anything larger goes to the audio store. The old
   * store entry is dropped afterwards, because a replaced track is the only
   * thing that could ever have reached it.
   */
  async replaceAudio(
    id: number,
    filename: string,
    bytes: Uint8Array,
  ): Promise<ProjectAudio | null> {
    const existing = this.project.audio.find((track) => track.id === id);
    if (!existing) return null;
    const previousKey = existing.storeKey;

    // Built through the same two constructors an import uses, so a replacement
    // is classified by the same sniffing rather than by a second rule that
    // could disagree with it.
    const inline = bytes.length <= INLINE_LIMIT || !isAudioStoreAvailable();
    let key: string | undefined;
    if (!inline) {
      key = newAudioKey();
      // Written before the project mentions it, as `addAudio` does: a failed
      // write must not leave a track pointing at audio that was never stored.
      await putAudioBytes(key, bytes);
    }
    const built = inline
      ? storeAudio(id, filename, bytes, existing.name)
      : referenceAudio(id, filename, bytes, key!, existing.name);

    this.update((project) => {
      const track = project.audio.find((entry) => entry.id === id);
      if (!track) return;
      track.format = built.format;
      track.filename = built.filename;
      track.bytes = built.bytes;
      // Exactly one of the two, always: leaving the old `data` beside a new
      // `storeKey` is a track with two sets of bytes and no rule about which
      // wins.
      if (inline) {
        track.data = built.data;
        delete track.storeKey;
      } else {
        track.storeKey = built.storeKey;
        delete track.data;
      }
    });

    if (previousKey && previousKey !== key) {
      void deleteAudioBytes(previousKey).catch(() => undefined);
    }

    return this.project.audio.find((track) => track.id === id) ?? null;
  }

  renameAudio(id: number, name: string): void {
    this.update((project) => {
      const track = project.audio.find((entry) => entry.id === id);
      if (track) track.name = name.trim() || track.filename;
    });
  }

  deleteAudio(id: number): void {
    const removed = this.project.audio.find((track) => track.id === id);

    this.update((project) => {
      const index = project.audio.findIndex((track) => track.id === id);
      if (index >= 0) project.audio.splice(index, 1);
    });

    // The bytes go too, or the store keeps hundreds of megabytes alive for a
    // track nothing can reach. Failing to delete them is untidy rather than
    // harmful, so it must not take the removal down with it.
    if (removed?.storeKey) void deleteAudioBytes(removed.storeKey).catch(() => undefined);
  }

  addObject(x: number, y: number): ProjectObject | null {
    const room = this.currentRoom;
    if (!room) return null;

    // Object ids are global across every room, because saved state keys on them.
    const used = this.project.rooms.flatMap((r) => r.objects.map((o) => o.id));
    const id = nextId(used, 100);

    const object: ProjectObject = {
      id,
      name: `object ${id}`,
      x: Math.max(0, Math.round(x / 8) * 8),
      y: Math.max(0, Math.round(y / 8) * 8),
      width: 16,
      height: 16,
      walkTo: { x: Math.round(x), y: Math.min(room.height - 8, Math.round(y) + 32) },
      facing: 'south',
      initialState: 1,
      classes: [],
      states: [storeImage(createImage(16, 16, 7))],
      handlers: [],
      otherwise: [],
    };

    this.update((project) => {
      const target = project.rooms.find((r) => r.id === room.id);
      target?.objects.push(object);
    });
    this.select({ objectId: id });
    return object;
  }

  deleteObject(id: number): void {
    this.update((project) => {
      for (const room of project.rooms) {
        const index = room.objects.findIndex((object) => object.id === id);
        if (index >= 0) room.objects.splice(index, 1);
      }
    });
    this.select({ objectId: null });
  }

  /**
   * Adds an actor, copying the player's costume as a starting point.
   *
   * A new actor with no artwork would be invisible, and an invisible NPC is
   * indistinguishable from one that failed to appear.
   */
  addActor(): ProjectActor | null {
    const used = this.project.actors.map((actor) => actor.id);
    const id = nextId(used, 2);
    if (id >= ACTOR_ID_LIMIT) return null;

    const template = this.project.actors[0];
    const actor: ProjectActor = {
      id,
      name: `Actor ${id}`,
      talkColor: 14,
      walkSpeed: { x: 5, y: 2 },
      palette: [...(template?.palette ?? [])],
      poses: (template?.poses ?? []).map(copyPose),
      handlers: [],
      otherwise: [],
      start: this.selection.roomId ? { room: this.selection.roomId, x: 200, y: 120 } : undefined,
    };

    this.update((project) => project.actors.push(actor));
    this.select({ actorId: id });
    return actor;
  }

  deleteActor(id: number): void {
    // Actor 1 is the player; a game without one cannot start.
    if (id === 1 || this.project.actors.length <= 1) return;
    this.update((project) => {
      const index = project.actors.findIndex((actor) => actor.id === id);
      if (index >= 0) project.actors.splice(index, 1);
    });
    this.select({ actorId: 1 });
  }

  /**
   * Deletes a room and repairs everything that pointed at it.
   *
   * A dangling reference is worse than a missing room. The game stops
   * compiling, and if the reference is the start room there is nothing in the
   * editor to change it with, so the project becomes unplayable with no way
   * back. Deleting therefore has to fix the references it breaks.
   */
  deleteRoom(id: number): void {
    if (this.project.rooms.length <= 1) return;

    this.update((project) => {
      const index = project.rooms.findIndex((room) => room.id === id);
      if (index >= 0) project.rooms.splice(index, 1);

      const survivor = project.rooms[0];
      if (!survivor) return;

      if (project.start.room === id) {
        project.start = { room: survivor.id, x: project.start.x, y: project.start.y };
      }

      // An actor whose room is gone becomes unplaced, rather than being moved
      // somewhere the author never chose.
      for (const actor of project.actors) {
        if (actor.start?.room === id) actor.start = undefined;
      }
    });

    this.select({ roomId: this.project.rooms[0]?.id ?? null, objectId: null, boxIndex: null });
  }
}

/**
 * Deep-copies a pose, so a new actor made from a template never shares cels
 * with the actor it was copied from.
 */
function copyPose(pose: SpritePose): SpritePose {
  const copy: SpritePose = {};
  for (const facing of ['all', ...POSE_DIRECTIONS] as const) {
    const cels = pose[facing];
    if (cels) copy[facing] = cels.map((cel) => ({ ...cel, image: { ...cel.image } }));
  }
  return copy;
}

export function blankRoom(id: number): ProjectRoom {
  const width = 320;
  const height = 144;
  const background = createImage(width, height, 0);

  // A visible floor and horizon, so a new room is obviously a room rather than
  // a black rectangle the author has to guess the size of.
  for (let y = 0; y < height; y++) {
    const color = y < 100 ? 1 : 8;
    background.pixels.fill(color, y * width, (y + 1) * width);
  }

  return {
    id,
    name: `room${id}`,
    width,
    height,
    background: storeImage(background),
    zPlanes: [],
    // Perspective on by default with a gentle ramp: a flat room is the more
    // surprising default, and the numbers are easy to change or switch off.
    boxes: [rectangleBox(0, 104, width, 36, { perspective: true })],
    perspective: { farY: 104, farScale: 160, nearY: height - 1, nearScale: 255 },
    objects: [],
    onEnter: [],
    onExit: [],
  };
}

/**
 * Gives a brand-new project a room and a drawable character.
 *
 * Starting with a visible person rather than a placeholder block matters: the
 * player character is the thing an author looks at most, and an editor that
 * opens on something already recognisable invites editing rather than
 * puzzlement.
 */
function withStarterContent(project: Project): Project {
  project.rooms.push(blankRoom(1));
  project.actors[0].poses = defaultSpriteFrames().map((pose) => ({
    all: pose.map((image) => ({ image: storeImage(image), hold: DEFAULT_HOLD })),
  }));
  return project;
}
