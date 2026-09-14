/**
 * Synthetic Broken Sword and Broken Sword II installs, built from the formats.
 *
 * `processes/verifying-version-support.md` names both the purpose and the trap:
 * "a fixture encodes our reading of the format. If that reading is wrong, the
 * fixture and the engine agree with each other and disagree with the game."
 *
 * So these builders are written from the *format* — the RIF's nested presence
 * tables, the compact resource's one-based offset table, the script module's
 * count-then-offsets header, Sword2's `resource.inf`/`resource.tab` pair and the
 * cluster's own tail index — rather than from what the readers happen to accept.
 * Where a builder had to choose, it chose the thing the shipped games do (a
 * cluster with holes; a text resource with a zero offset), because those are
 * exactly the cases a reader written against a tidy fixture gets wrong.
 *
 * What these cannot do is stand in for a real install. Broken Sword is not
 * freeware, so this family rests on a fixture in the way
 * `scummvm-parity-roadmap.md` predicted for every famous engine that is not
 * Sky or Lure — and both engines say so on their own status lines rather than
 * implying otherwise.
 */
import { SWORD1_ROOM_DEF_BYTES } from '../src/authoring/sword1/executable.js';
import { SWORD1_ROOMS } from '../src/engine/sword1/resource/swordRooms.js';

/** Grows as parts are appended, so no length has to be worked out twice. */
export class Writer {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  ascii(text: string, width?: number): this {
    for (const character of text) this.u8(character.charCodeAt(0));
    if (width !== undefined) for (let at = text.length; at < width; at++) this.u8(0);
    return this;
  }

  raw(bytes: Uint8Array | readonly number[]): this {
    for (const byte of bytes) this.bytes.push(byte & 0xff);
    return this;
  }

  get length(): number {
    return this.bytes.length;
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

// ---------------------------------------------------------------------------
// Broken Sword 1
// ---------------------------------------------------------------------------

/** One resource to place in a cluster. */
export interface SwordFixtureResource {
  readonly group: number;
  readonly index: number;
  readonly bytes: Uint8Array;
}

/** One cluster, named as `swordres.rif` spells it. */
export interface SwordFixtureCluster {
  readonly label: string;
  /** How many groups the index declares, holes included. */
  readonly groups: number;
  readonly resources: readonly SwordFixtureResource[];
}

/** A built install: the index, and each cluster's bytes. */
export interface SwordFixture {
  readonly rif: Uint8Array;
  readonly clusters: ReadonlyMap<string, Uint8Array>;
  /** `(cluster + 1) << 24 | group << 16 | index` for each resource placed. */
  readonly ids: ReadonlyMap<string, number>;
}

/** The 20-byte header every cluster resource begins with. */
export function swordHeader(type: string, decompLength: number, version = 1): Uint8Array {
  return new Writer()
    .ascii(type, 6)
    .u16(version)
    .u32(decompLength)
    .ascii('None', 4)
    .u32(decompLength)
    .done();
}

/**
 * Builds `swordres.rif` and the clusters it names.
 *
 * The presence tables are written the way the format defines them: a word per
 * slot, zero for a hole, and **no offset/length pair for a hole**. That is the
 * detail a reader that skips eight bytes per hole gets wrong, and building it
 * correctly here is what makes the test meaningful.
 */
export function buildSwordFixture(clusters: readonly SwordFixtureCluster[]): SwordFixture {
  const clusterBytes = new Map<string, Uint8Array>();
  const ids = new Map<string, number>();

  // Pass one: lay each cluster's resources out and remember where they went.
  const placed = clusters.map((cluster) => {
    const body = new Writer();
    const entries = new Map<string, { offset: number; length: number }>();
    for (const resource of cluster.resources) {
      const offset = body.length;
      body.raw(resource.bytes);
      entries.set(`${resource.group}:${resource.index}`, {
        offset,
        length: resource.bytes.length,
      });
    }
    clusterBytes.set(cluster.label, body.done());
    return { cluster, entries };
  });

  // Pass two: the index.
  const rif = new Writer();
  rif.u32(clusters.length);
  for (let at = 0; at < clusters.length; at++) rif.u32(1);

  placed.forEach(({ cluster, entries }, clusterIndex) => {
    rif.ascii(cluster.label, 32);
    rif.u32(cluster.groups);
    const groupPresent: number[] = [];
    for (let group = 0; group < cluster.groups; group++) {
      groupPresent.push(cluster.resources.some((resource) => resource.group === group) ? 1 : 0);
    }
    for (const present of groupPresent) rif.u32(present);

    for (let group = 0; group < cluster.groups; group++) {
      if (!groupPresent[group]) continue;
      const inGroup = cluster.resources.filter((resource) => resource.group === group);
      const declared = Math.max(...inGroup.map((resource) => resource.index)) + 1;
      rif.u32(declared);
      const present: number[] = [];
      for (let index = 0; index < declared; index++) {
        present.push(inGroup.some((resource) => resource.index === index) ? 1 : 0);
      }
      for (const flag of present) rif.u32(flag);
      for (let index = 0; index < declared; index++) {
        if (!present[index]) continue;
        const entry = entries.get(`${group}:${index}`);
        if (!entry) continue;
        rif.u32(entry.offset);
        rif.u32(entry.length);
        ids.set(
          `${cluster.label}:${group}:${index}`,
          ((clusterIndex + 1) << 24) | (group << 16) | index,
        );
      }
    }
  });

  return { rif: rif.done(), clusters: clusterBytes, ids };
}

/**
 * A compact resource: a header, a count, a one-based offset table, then the
 * compacts.
 *
 * `words` is per object; each is padded to whatever length the caller gives,
 * which is how a text compact (short) and a mega (3,085 words) both fit the
 * same resource shape.
 */
export function buildCompactResource(objects: readonly (readonly number[])[]): Uint8Array {
  const tableBytes = 4 + objects.length * 4;
  const body = new Writer();
  body.u32(objects.length);
  let offset = tableBytes;
  for (const object of objects) {
    body.u32(offset);
    offset += object.length * 4;
  }
  for (const object of objects) for (const word of object) body.i32(word);
  const payload = body.done();
  return new Writer().raw(swordHeader('File', payload.length)).raw(payload).done();
}

/**
 * A script module: a header, a count, an offset table in words, then code.
 *
 * The offsets are **word indexes into the payload**, and the first instruction
 * therefore starts at `1 + scriptCount`. Building it any other way produces a
 * module whose offset table reads as instructions.
 */
export function buildScriptResource(scripts: readonly (readonly number[])[]): Uint8Array {
  const words: number[] = [scripts.length];
  let at = 1 + scripts.length;
  for (const script of scripts) {
    words.push(at);
    at += script.length;
  }
  for (const script of scripts) words.push(...script);

  const body = new Writer();
  for (const word of words) body.i32(word);
  const payload = body.done();
  // Version 13 is what every shipped release carries and what the interpreter
  // checks, so a fixture that writes anything else is testing the refusal.
  return new Writer()
    .raw(swordHeader('Script', words.length, 13))
    .raw(payload)
    .done();
}

/** A text resource: a count, an offset table, then NUL-terminated strings. */
export function buildTextResource(lines: readonly string[]): Uint8Array {
  const header = 4 + lines.length * 4;
  const offsets: number[] = [];
  const strings = new Writer();
  for (const line of lines) {
    if (line === '') {
      // A zero offset is how the shipped resources spell "this language has no
      // such line", and it is a case a tidy fixture would not cover.
      offsets.push(0);
      continue;
    }
    offsets.push(header + strings.length);
    strings.ascii(line).u8(0);
  }
  const body = new Writer().u32(lines.length);
  for (const offset of offsets) body.u32(offset);
  body.raw(strings.done());
  const payload = body.done();
  return new Writer().raw(swordHeader('Text', payload.length)).raw(payload).done();
}

/**
 * A sprite resource: a header, a frame count, a frame offset table, then frames.
 *
 * The offset table is one-based in the same way the compact table is — entry 0
 * is the count — which is the detail `SwordScreen.frame` depends on.
 */
export function buildSpriteResource(
  frames: readonly {
    width: number;
    height: number;
    pixels: Uint8Array;
    offsetX?: number;
    offsetY?: number;
    /** The four-byte compression tag. `'Nu  '` — this family's "none" — by default. */
    tag?: string;
  }[],
  /**
   * The resource header's type tag.
   *
   * `'Anim'` by default, which is what a frame-fetching test wants. An import
   * finds a *picture* by this tag being `'Sprite'` and by nothing else, so a
   * test that wants the picture surface to see the resource has to say so.
   */
  type = 'Anim',
): Uint8Array {
  const tableBytes = 4 + frames.length * 4;
  const bodies = frames.map((frame) =>
    new Writer()
      .ascii(frame.tag ?? 'Nu  ', 4)
      .u32(frame.pixels.length)
      .u16(frame.width)
      .u16(frame.height)
      .u16((frame.offsetX ?? 0) & 0xffff)
      .u16((frame.offsetY ?? 0) & 0xffff)
      .raw(frame.pixels)
      .done(),
  );

  const body = new Writer();
  body.u32(frames.length);
  let offset = 20 + tableBytes;
  for (const frameBody of bodies) {
    body.u32(offset);
    offset += frameBody.length;
  }
  for (const frameBody of bodies) body.raw(frameBody);
  const payload = body.done();
  return new Writer().raw(swordHeader(type, payload.length)).raw(payload).done();
}

/** An animation table: a frame count, then (x, y, frame) triples. */
export function buildAnimTable(
  units: readonly { x: number; y: number; frame: number }[],
): Uint8Array {
  const body = new Writer().u32(units.length);
  for (const unit of units) body.i32(unit.x).i32(unit.y).i32(unit.frame);
  const payload = body.done();
  return new Writer().raw(swordHeader('Anim', payload.length)).raw(payload).done();
}

// ---------------------------------------------------------------------------
// Broken Sword 2
// ---------------------------------------------------------------------------

/** One resource to place in a Sword2 cluster. */
export interface Sword2FixtureResource {
  readonly id: number;
  readonly bytes: Uint8Array;
}

export interface Sword2FixtureCluster {
  readonly name: string;
  readonly resources: readonly Sword2FixtureResource[];
}

export interface Sword2Fixture {
  readonly inf: Uint8Array;
  readonly tab: Uint8Array;
  readonly cdInf: Uint8Array;
  readonly clusters: ReadonlyMap<string, Uint8Array>;
}

/** `ResHeader` is 44 bytes, and every offset inside a resource counts from its start. */
export const SWORD2_RES_HEADER_SIZE = 44;

/** One menu icon's pixels: 35 across, 30 deep. `RDMENU_ICONWIDE`, `RDMENU_ICONDEEP`. */
export const SWORD2_ICON_PIXELS = 35 * 30;

/** The 44-byte header every Sword2 resource begins with. */
export function sword2Header(fileType: number, name: string, decompSize: number): Uint8Array {
  return new Writer().u8(fileType).u8(0).u32(decompSize).u32(decompSize).ascii(name, 34).done();
}

/**
 * Builds `resource.inf`, `resource.tab`, `cd.inf` and the clusters.
 *
 * `resource.tab` is dense over the id space: an id nobody placed gets `0xffff`
 * for its cluster, which is the format's own "no such resource" marker and a
 * case the reader has to answer with null rather than a throw.
 */
export function buildSword2Fixture(clusters: readonly Sword2FixtureCluster[]): Sword2Fixture {
  const clusterBytes = new Map<string, Uint8Array>();
  const table = new Map<number, { cluster: number; index: number }>();

  clusters.forEach((cluster, clusterIndex) => {
    const body = new Writer();
    // The first word is the offset of the tail index, filled in once the body
    // is laid out — so a placeholder goes in and the real value is patched.
    body.u32(0);
    const entries: Array<{ offset: number; length: number }> = [];
    cluster.resources.forEach((resource, resourceIndex) => {
      entries.push({ offset: body.length, length: resource.bytes.length });
      body.raw(resource.bytes);
      table.set(resource.id, { cluster: clusterIndex, index: resourceIndex });
    });
    const tableOffset = body.length;
    for (const entry of entries) body.u32(entry.offset).u32(entry.length);
    const bytes = body.done();
    new DataView(bytes.buffer).setUint32(0, tableOffset, true);
    clusterBytes.set(cluster.name, bytes);
  });

  const highest = Math.max(0, ...[...table.keys()]);
  const tab = new Writer();
  for (let id = 0; id <= highest; id++) {
    const entry = table.get(id);
    if (entry) tab.u16(entry.cluster).u16(entry.index);
    else tab.u16(0xffff).u16(0xffff);
  }

  const inf = new Writer();
  for (const cluster of clusters) inf.ascii(cluster.name).u8(0x0a);

  const cdInf = new Writer();
  for (const cluster of clusters) cdInf.ascii(cluster.name, 20).u8(0);

  return { inf: inf.done(), tab: tab.done(), cdInf: cdInf.done(), clusters: clusterBytes };
}

/**
 * A `GAME_OBJECT` resource: header, hub, locals, offset table, checksum, code.
 *
 * The checksum is computed rather than stubbed, because a wrong one is exactly
 * what the reader reports as a note — and a fixture that always trips that note
 * would hide a real mismatch.
 */
export function buildSword2Object(
  name: string,
  scripts: readonly (readonly number[])[],
  localWords = 4,
  fileType = 3,
  /**
   * The id this object is addressed by, written into its hub's level-0 script
   * id as `id * SIZE`.
   *
   * Worth passing whenever the object's own script has to run. `runObject`
   * reads the owner out of the script id, and a hub of zeros says "object 0
   * owns my script", so an object built without this one runs nobody's logic —
   * which is a fixture artefact and not something shipped data does.
   */
  owner = 0,
): Uint8Array {
  const code: number[] = [];
  const offsets: number[] = [];
  for (const script of scripts) {
    offsets.push(code.length);
    code.push(...script);
  }

  const hub = new Writer();
  for (let word = 0; word < 11; word++) hub.u32(word === 5 ? owner * 0x10000 : 0);

  const body = new Writer();
  body.raw(hub.done());
  body.u32(localWords * 4);
  for (let word = 0; word < localWords; word++) body.u32(0);
  body.u32(scripts.length);
  for (const offset of offsets) body.u32(offset);
  body.u32(12345678);
  body.u32(code.length);
  let checksum = 0;
  for (const byte of code) checksum = (checksum + (byte & 0xff)) >>> 0;
  body.u32(checksum);
  body.raw(code);

  const payload = body.done();
  return new Writer()
    .raw(sword2Header(fileType, name, payload.length))
    .raw(payload)
    .done();
}

/**
 * A `SCREEN_MANAGER`, which is a `GAME_OBJECT`'s layout under a different type.
 *
 * ScummVM's `runScript2` reads the hub, the locals, the offset table and the
 * code from whichever of the two it is handed, and `runResObjScript` accepts
 * both file types by name (`interpreter.cpp:216`) — so a start-up fixture is a
 * game object with byte 4 of its header changed. This is what the engine boots
 * through: `startGame()` runs script 1 of a screen manager, and that script
 * calls `fnSetSession` itself.
 */
export function buildSword2ScreenManager(
  name: string,
  scripts: readonly (readonly number[])[],
  localWords = 4,
): Uint8Array {
  return buildSword2Object(name, scripts, localWords, 9);
}

/**
 * One parallax layer, in the layout `initializeBackgroundLayer` reads.
 *
 * `rows` is one array of palette indices per row, or null for a row nothing was
 * drawn on. A row with no transparent pixel is written in the raw form
 * (`packets == 0`, then `width` bytes), which is what a background's rows are;
 * any other row is written as the alternating literal/skip packets, starting
 * with a zero-length literal when the row begins with a gap. Both forms are
 * here on purpose — a fixture that only ever emitted one would let a reader
 * that mishandled the other pass.
 */
export function buildSword2ParallaxLayer(
  width: number,
  height: number,
  rows: readonly (readonly number[] | null)[],
): Uint8Array {
  const bodies: (number[] | null)[] = [];
  for (let row = 0; row < height; row++) {
    const pixels = rows[row] ?? null;
    if (!pixels || pixels.every((pixel) => pixel === 0)) {
      bodies.push(null);
      continue;
    }
    if (pixels.every((pixel) => pixel !== 0)) {
      bodies.push([0, 0, 0, 0, ...pixels]);
      continue;
    }

    const packets: number[] = [];
    let count = 0;
    let at = pixels.findIndex((pixel) => pixel !== 0);
    const offset = at;
    let literal = true;
    while (at < width) {
      if (literal) {
        let run = 0;
        while (at + run < width && pixels[at + run] !== 0 && run < 255) run++;
        packets.push(run, ...pixels.slice(at, at + run));
        at += run;
        count++;
        literal = false;
      } else {
        let run = 0;
        while (at + run < width && pixels[at + run] === 0 && run < 255) run++;
        // Trailing transparency needs no packet: the row simply stops.
        if (at + run >= width && pixels[width - 1] === 0) break;
        packets.push(run);
        at += run;
        count++;
        literal = true;
      }
    }
    bodies.push([
      count & 0xff,
      (count >> 8) & 0xff,
      offset & 0xff,
      (offset >> 8) & 0xff,
      ...packets,
    ]);
  }

  const header = new Writer().u16(width).u16(height);
  let at = 4 + height * 4;
  const offsets = new Writer();
  for (const body of bodies) {
    if (body === null) {
      offsets.u32(0);
      continue;
    }
    offsets.u32(at);
    at += body.length;
  }
  const out = new Writer().raw(header.done()).raw(offsets.done());
  for (const body of bodies) if (body !== null) out.raw(body);
  return out.done();
}

/**
 * A `SCREEN_FILE`: the nine-offset multi-screen header, then one background.
 *
 * The smallest one the reader accepts — a palette, a `ScreenHeader` and the
 * background, with every parallax and layer offset zero, which is what "no
 * parallax" is spelled as in the shipped data too.
 *
 * The background is a *parallax layer*, not a rectangle of pixels: the original
 * draws it with `renderParallax(fetchBackgroundLayer(file), 2)` and fetches it
 * from `multi.screen + ScreenHeader::size()` (`screen.cpp:310`,
 * `protocol.cpp:217-240`). Writing raw pixels here instead would agree with a
 * reader that copied raw pixels, and both would disagree with every shipped
 * screen.
 *
 * `hole` punches a transparent square into the middle, so that a fixture
 * exercises the packet form as well as the raw-row one, and `layer` adds one
 * mask layer — a rectangle and an RLE256 bitmap of it, which is the scenery the
 * renderer stamps back over a sprite that walked behind it.
 */
export function buildSword2Screen(
  name: string,
  width: number,
  height: number,
  colour = 3,
  hole?: { x: number; y: number; width: number; height: number },
  layer?: { x: number; y: number; width: number; height: number; colour: number },
): Uint8Array {
  const MULTI = 36;
  const paletteAt = MULTI;
  const screenAt = paletteAt + 256 * 4;
  const rows: number[][] = [];
  for (let row = 0; row < height; row++) {
    const pixels = new Array<number>(width).fill(colour);
    if (hole && row >= hole.y && row < hole.y + hole.height) {
      for (let column = hole.x; column < hole.x + hole.width && column < width; column++) {
        pixels[column] = 0;
      }
    }
    rows.push(pixels);
  }

  const background = buildSword2ParallaxLayer(width, height, rows);
  // A layer is a rectangle and an RLE256 mask of it, written flat here: a
  // length and a colour, then an empty raw block, until the rectangle is full.
  const mask = new Writer();
  if (layer) {
    let remaining = layer.width * layer.height;
    while (remaining > 0) {
      const run = Math.min(255, remaining);
      mask.u8(run).u8(layer.colour).u8(0);
      remaining -= run;
    }
  }
  const maskBytes = mask.done();
  const layersAt = screenAt + 6 + background.length;
  const maskAt = layersAt + 16;

  const body = new Writer();
  body.u32(paletteAt).u32(0).u32(0).u32(screenAt).u32(0).u32(0);
  body
    .u32(layer ? layersAt : 0)
    .u32(0)
    .u32(0);
  // 256 RGBA quads. Entry 0 is forced black by the reader whatever is here.
  for (let index = 0; index < 256; index++) body.u8(index).u8(index).u8(index).u8(0);
  body
    .u16(width)
    .u16(height)
    .u16(layer ? 1 : 0);
  body.raw(background);
  if (layer) {
    // `LayerHeader.offset` is measured from the end of the resource header, the
    // same as every offset in the multi-screen header —
    // `file + ResHeader::size() + layer_head.offset` in `Screen::processLayer`
    // (`screen.cpp:528`). A fixture that wrote it absolute would agree with a
    // reader that read it absolute, and both would be 44 bytes out.
    body.u16(layer.x).u16(layer.y).u16(layer.width).u16(layer.height);
    body.u32(maskBytes.length).u32(maskAt);
    body.raw(maskBytes);
  }
  const payload = body.done();
  return new Writer()
    .raw(sword2Header(2, name, payload.length))
    .raw(payload)
    .done();
}

/**
 * An `ANIMATION_FILE`: an anim header, one CDT entry per frame, then frames.
 *
 * Uncompressed (`runTimeComp` 0), so the frame bytes are the pixels and a test
 * can assert on them. The one detail worth stating is `frameOffset`: it is
 * measured from the *anim header*, not from the start of the resource, which is
 * `fetchFrameHeader`'s `animFile + ResHeader::size() + cdt.frameOffset`
 * (`protocol.cpp:174-182`). A fixture that wrote it from the resource start
 * would agree with a reader that read it that way, and both would be wrong.
 */
export function buildSword2Anim(
  name: string,
  frames: readonly {
    x: number;
    y: number;
    width: number;
    height: number;
    frameType?: number;
    colour?: number;
    /** Exactly `width * height` bytes, when a flat fill will not do. */
    pixels?: Uint8Array;
  }[],
): Uint8Array {
  const ANIM_HEADER_SIZE = 15;
  const CDT_ENTRY_SIZE = 9;
  const FRAME_HEADER_SIZE = 8;

  const body = new Writer();
  // AnimHeader: no compression, the frame count, and feet/blend fields the
  // renderer does not read.
  body.u8(0).u16(frames.length).u16(0).u16(0).u8(0).u16(0).u16(0).u8(0).u16(0);

  let frameAt = ANIM_HEADER_SIZE + frames.length * CDT_ENTRY_SIZE;
  for (const frame of frames) {
    body
      .u16(frame.x)
      .u16(frame.y)
      .u32(frameAt)
      .u8(frame.frameType ?? 0);
    frameAt += FRAME_HEADER_SIZE + frame.width * frame.height;
  }
  for (const frame of frames) {
    const pixels = frame.width * frame.height;
    body.u32(pixels).u16(frame.width).u16(frame.height);
    for (let pixel = 0; pixel < pixels; pixel++)
      body.u8(frame.pixels?.[pixel] ?? frame.colour ?? 9);
  }

  const payload = body.done();
  return new Writer()
    .raw(sword2Header(1, name, payload.length))
    .raw(payload)
    .done();
}

/** The ink a font fixture's glyph body uses, which `Sword2Text` turns into the pen. */
export const SWORD2_FONT_LETTER = 193;
/** Any other non-zero ink, which becomes the border pen. */
export const SWORD2_FONT_INK = 7;

/**
 * A Broken Sword II font: an animation whose frames are the characters.
 *
 * `widths[n]` is the width of character `32 + n`, so a font is proportional
 * the way the game's is. Each glyph is a solid block of `SWORD2_FONT_LETTER`
 * with its leftmost column in `SWORD2_FONT_INK` and its top-left pixel
 * transparent — enough ink to tell the three cases apart: the pen, the border,
 * and the hole.
 */
export function buildSword2Font(widths: readonly number[], height = 8): Uint8Array {
  return buildSword2Anim(
    'font',
    widths.map((width) => {
      const pixels = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          pixels[y * width + x] = x === 0 ? SWORD2_FONT_INK : SWORD2_FONT_LETTER;
        }
      }
      pixels[0] = 0;
      return { x: 0, y: 0, width, height, pixels };
    }),
  );
}

/**
 * An `ICON_FILE`: two 35x30 images, the greyed one then the coloured one.
 *
 * The doubling is the format and not a convenience — `buildMenu` and
 * `chooseMouse` both reach a coloured icon by adding `RDMENU_ICONWIDE *
 * RDMENU_ICONDEEP` to the pointer they opened the resource at
 * (`icons.cpp:176-183`), so a menu icon resource is exactly 2,100 bytes of
 * payload and the demo's are: `EXIT`, `GRUB`, `LABEL` and `NEWSCUT` are all
 * 2,144 bytes including the header.
 */
export function buildSword2Icon(name: string, grey: number, coloured: number): Uint8Array {
  const pixels = new Uint8Array(SWORD2_ICON_PIXELS * 2);
  pixels.fill(grey, 0, SWORD2_ICON_PIXELS);
  pixels.fill(coloured, SWORD2_ICON_PIXELS);
  return new Writer()
    .raw(sword2Header(12, name, pixels.length))
    .raw(pixels)
    .done();
}

/** A `GLOBAL_VAR_FILE`: a header and that many 32-bit variables. */
export function buildSword2Globals(values: readonly number[]): Uint8Array {
  const body = new Writer();
  for (const value of values) body.i32(value);
  const payload = body.done();
  return new Writer()
    .raw(sword2Header(5, 'globals', payload.length))
    .raw(payload)
    .done();
}

/** A `RUN_LIST`: object ids, NUL-terminated. */
export function buildSword2RunList(ids: readonly number[]): Uint8Array {
  const body = new Writer();
  for (const id of ids) body.u32(id);
  body.u32(0);
  const payload = body.done();
  return new Writer()
    .raw(sword2Header(7, 'run list', payload.length))
    .raw(payload)
    .done();
}

/**
 * A `TEXT_FILE`: a count, an offset table, then lines with a two-byte wav id.
 *
 * The offsets are measured from the **resource's start**, header included,
 * which is where `fetchTextLine` measures them from. This fixture used to write
 * them from the payload's start instead, and because the reader made the same
 * mistake the round trip closed on a game the engine could not read — the demo
 * came back with every subtitle 44 bytes late.
 *
 * `wavIds` is optional so the many callers that only care about words can pass
 * lines alone; the game's own numbers are what a text round trip has to keep.
 */
export function buildSword2Text(
  lines: readonly string[],
  wavIds: readonly number[] = [],
): Uint8Array {
  const header = SWORD2_RES_HEADER_SIZE + 4 + lines.length * 4;
  const offsets: number[] = [];
  const strings = new Writer();
  lines.forEach((line, at) => {
    offsets.push(header + strings.length);
    strings
      .u16(wavIds[at] ?? 0)
      .ascii(line)
      .u8(0);
  });
  const body = new Writer().u32(lines.length);
  for (const offset of offsets) body.u32(offset);
  body.raw(strings.done());
  const payload = body.done();
  return new Writer()
    .raw(sword2Header(8, 'text', payload.length))
    .raw(payload)
    .done();
}

/**
 * A 96-glyph font resource: space, then every printable character.
 *
 * Uniform 6x6 boxes of `LETTER_COL`. Enough for a sprite to be measured and
 * drawn, which is what a test of the text path needs; it is not a typeface.
 */
export function buildFontResource(): Uint8Array {
  const frames: Array<{ width: number; height: number; pixels: Uint8Array }> = [];
  for (let code = 32; code < 128; code++) {
    const width = code === 32 ? 4 : 6;
    const pixels = new Uint8Array(width * 6);
    pixels.fill(193);
    frames.push({ width, height: 6, pixels });
  }
  return buildSpriteResource(frames);
}

// ---------------------------------------------------------------------------
// The interpreter, which is where Broken Sword keeps two of its editable
// surfaces. Built here rather than in one test file because both the finder's
// tests and the exporter's want the same bytes, and a fixture each would be two
// answers to one question.
// ---------------------------------------------------------------------------

function writeExeWord(bytes: Uint8Array, at: number, value: number): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(at, value, true);
}

/**
 * An executable-shaped buffer with the built-in room table planted in it.
 *
 * Padded with a repeating pattern rather than zeroes, because a finder that
 * only works in a field of zeroes has not been asked the question a real file
 * asks: which of many candidate offsets is the table.
 */
export function sword1ExecutableWithRooms(at: number): Uint8Array {
  const bytes = new Uint8Array(at + SWORD1_ROOMS.length * SWORD1_ROOM_DEF_BYTES + 4096);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 7) & 0xff;
  SWORD1_ROOMS.forEach((room, screen) => {
    const start = at + screen * SWORD1_ROOM_DEF_BYTES;
    const words = [
      room.totalLayers,
      room.sizeX,
      room.sizeY,
      room.gridWidth,
      ...room.layers,
      ...room.grids,
      ...room.palettes,
      ...room.parallax,
    ];
    words.forEach((word, index) => writeExeWord(bytes, start + index * 4, word));
  });
  return bytes;
}

/** One `mov dword ptr [base + field], value`, as the interpreter emits it. */
function movAbsolute(bytes: Uint8Array, at: number, address: number, value: number): void {
  bytes[at] = 0xc7;
  bytes[at + 1] = 0x05;
  writeExeWord(bytes, at + 2, address);
  writeExeWord(bytes, at + 6, value);
}

/**
 * A buffer holding `placements` runs of the four writes, and nothing else.
 *
 * Every run addresses the same object base, which is what the real code does:
 * the placement writes go to one compact's fields and the *compact id* is the
 * fourth immediate. Runs are separated by filler so that the finder is made to
 * group them rather than read one long stretch.
 */
export function sword1ExecutableWithStarts(
  base: number,
  placements: ReadonlyArray<{ x: number; y: number; direction: number; place: number }>,
): Uint8Array {
  const bytes = new Uint8Array(0x400 + placements.length * 64);
  for (let index = 0; index < bytes.length; index++) bytes[index] = 0x90;
  placements.forEach((placement, index) => {
    const at = 0x200 + index * 64;
    movAbsolute(bytes, at, base + 0, placement.x);
    movAbsolute(bytes, at + 10, base + 4, placement.y);
    movAbsolute(bytes, at + 20, base + 12, placement.direction);
    movAbsolute(bytes, at + 30, base + 8, placement.place);
  });
  return bytes;
}
