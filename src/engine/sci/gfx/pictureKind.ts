/**
 * Which kind of Picture a resource is (ADR 0018).
 *
 * **Two resource kinds that happen to share a resource type number**, not one
 * editor with a Version mode. A vector drawing tool and a bitmap composition
 * tool share no editing operation, and one editor with half its buttons greyed
 * out by Version is the bag of flags ADR 0007's test exists to prevent.
 *
 * Decided from the resource's own bytes rather than from the Version, which
 * matters because the two overlap: SCI1.1 ships both, and a game bucketed at
 * the wrong Version would otherwise get the wrong editor for every Picture in
 * it. The test is the one ScummVM makes — a SCI1.1 or later Picture opens with
 * a header size rather than with a drawing operation.
 */

export type SciPictureKind =
  /** Vector operations painted into visual, priority and control buffers. */
  | 'vector'
  /**
   * An arrangement of cels, with vector operations after them.
   *
   * SCI1.1 introduced these alongside its vectors, behind a header size of
   * `0x26`; by SCI2 they are essentially all there is, behind a header size of
   * `0x0e` that carries the display resolution (#227).
   */
  | 'cel'
  /** Neither shape recognised — reported rather than guessed at. */
  | 'unknown';

/**
 * The header sizes a cel Picture opens with.
 *
 * `0x26` is SCI1.1's and `0x0e` is SCI32's — read from the real demos rather
 * than assumed, and the SCI32 one carries its own evidence: the header of every
 * Torin, King's Quest VII and Lighthouse Picture has `0x0280` and `0x01e0` in
 * it, which are 640 and 480. That is the display size sitting in a Picture,
 * which is what a bitmap Picture is and a vector one never has.
 */
const CEL_PICTURE_HEADERS = new Set([0x26, 0x0e]);

/**
 * Every drawing operation is at or above `0xf0`, so a first byte below it is
 * not a vector Picture. That single fact is what lets the two be told apart
 * without asking which Version is running.
 */
const FIRST_DRAWING_OPERATION = 0xf0;

export function sciPictureKind(resource: Uint8Array): SciPictureKind {
  if (resource.length < 2) return 'unknown';

  const header = resource[0] | (resource[1] << 8);
  if (CEL_PICTURE_HEADERS.has(header)) return 'cel';
  if (resource[0] >= FIRST_DRAWING_OPERATION) return 'vector';
  return 'unknown';
}

/**
 * What to tell an author about a Picture they opened.
 *
 * The editor says which kind it is rather than offering one surface and
 * disabling half of it, because "this is a bitmap composition and the drawing
 * tools do not apply to it" is a fact about the resource and "these buttons are
 * greyed out" is a fact about the editor.
 */
export function describePictureKind(kind: SciPictureKind): string {
  switch (kind) {
    case 'vector':
      return (
        'A vector Picture: lines, fills and patterns painted into a visual, a priority and a ' +
        'control buffer. Edited as drawing operations.'
      );
    case 'cel':
      return (
        'A cel Picture: an arrangement of bitmaps with vector operations after them. Edited as ' +
        'a composition — it shares no editing operation with the vector tools, which is why it ' +
        'is a separate surface rather than the same one with buttons disabled (ADR 0018).'
      );
    default:
      return (
        'This Picture is in neither shape this project reads: it does not open with a drawing ' +
        'operation and it does not carry a SCI1.1 header. It is held as its original bytes and ' +
        'shown read-only rather than opened in an editor that would misread it.'
      );
  }
}
