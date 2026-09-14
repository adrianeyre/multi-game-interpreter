/**
 * Recognises a SLUDGE game's data file.
 *
 * The same rule `lureDetect.ts` and `skyDetect.ts` follow — positive evidence
 * this family owns, read from the bytes rather than from a name.
 *
 * **A name alone cannot be the evidence here, and that is the difference from
 * every other family in this project.** SCUMM, AGI, SCI, AGOS, Sky and Lure all
 * ship files whose *names* are fixed by the publisher: `000.LFL`, `LOGDIR`,
 * `RESOURCE.MAP`, `gamepc`, `sky.dsk`, `disk1.vga`. SLUDGE is not a game's
 * engine but an authoring system's, so the file is named after whatever the
 * author called their game — `atw.slg`, `outoforder.slg` — and the extension is
 * a convention rather than a rule. What every SLUDGE file does have is a
 * six-byte signature in its first six bytes, so that is what this reads.
 *
 * Detecting on `.slg` alone would claim any file somebody happened to name that
 * way; detecting on the signature claims exactly the files a SLUDGE
 * interpreter would accept.
 */

/** The six bytes every SLUDGE data file opens with: `SLUDGE`. */
const SIGNATURE = [0x53, 0x4c, 0x55, 0x44, 0x47, 0x45] as const;

/**
 * True when these bytes open with the SLUDGE signature.
 *
 * Takes the head of a file rather than the whole of one: a SLUDGE game is a
 * single container and they run to tens of megabytes, so a detector that wants
 * the lot is a detector nothing can afford to call on every dropped file.
 */
export function looksLikeSludgeFile(head: Uint8Array): boolean {
  if (head.length < SIGNATURE.length) return false;
  return SIGNATURE.every((byte, index) => head[index] === byte);
}

/** Lowercased final path segment, matching `engineSignatures.ts`'s `baseName`. */
function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * The files worth *reading the head of*, in name order.
 *
 * Not a detection — a shortlist. `looksLikeSludgeFile` is the detection, and it
 * needs bytes, which the caller has to go and get. Handing it every file in a
 * dropped folder would read the head of a hundred-megabyte SCUMM volume for
 * nothing, so this narrows the candidates by the convention authors do follow
 * while leaving the claim itself to the signature.
 *
 * `.slg` is the SLUDGE compiler's own output extension. A file with no
 * extension is offered too, because a game shipped as a bare `data` file is a
 * real packaging and costs one head read to rule out.
 */
export function sludgeCandidates(fileNames: string[]): string[] {
  return fileNames
    .filter((name) => {
      const base = baseName(name);
      return base.endsWith('.slg') || !base.includes('.');
    })
    .sort((a, b) => baseName(a).localeCompare(baseName(b)));
}
