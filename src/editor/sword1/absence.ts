/**
 * Naming what is not here, which is a different job from drawing what is.
 *
 * Its own module rather than a helper on either side of it, because both the
 * screen surface (`screenScene.ts`) and the picture surface (`pictureFiles.ts`
 * through `Sword1Editor`) have to say it and they already point at each other.
 */

import type { Sword1Project } from '../../authoring/sword1/project.js';
import { clusterOf, formatResourceId } from '../../engine/sword1/resource/rif.js';

/**
 * Why a resource the project does not hold is not here, naming the cluster.
 *
 * Two different absences read identically on a surface and are not the same
 * thing at all. A picture can be missing because importing passed it over —
 * pictures are taken largest-first until a budget runs out — or because the
 * cluster it lives in is on a disc this install does not have. The first is
 * this project's doing and a bigger budget would fix it; the second is a
 * property of the *install*, and on a retail one the same resource is there.
 *
 * So this says which, by cluster, from the index's own labels. Three of the
 * demo's five characters are the case that made it worth writing: their
 * sprites are 0x08010000 and 0x08020000 in `paris3` and 0x0c010000 in `syria`,
 * neither of which a one-disc demo ships.
 */
export function sword1AbsentPictureReason(sword1: Sword1Project, resource: number): string {
  const id = formatResourceId(resource);
  const label = sword1.clusters.labels?.[clusterOf(resource)];
  if (label === undefined) {
    return (
      `${id} is not in this project, and this project does not carry the index's cluster ` +
      `names, so which cluster it lives in cannot be said from here. Either the release does ` +
      `not ship that cluster or importing passed the resource over: pictures are taken ` +
      `largest-first until a budget runs out.`
    );
  }
  const absent = sword1.clusters.absent.some((each) => each.toUpperCase() === label.toUpperCase());
  return absent
    ? `${id} lives in the ${label.toUpperCase()} cluster, which swordres.rif names and this ` +
        `install does not ship — a one-disc demo keeps it on the other disc. So there is ` +
        `nothing here to draw, export or replace. A retail install has that cluster, and this ` +
        `same resource with it.`
    : `${id} lives in the ${label.toUpperCase()} cluster, which this install does have, so it ` +
        `was importing that passed it over: pictures are taken largest-first until the budget ` +
        `runs out. The frames are still in the game's cluster, unchanged.`;
}
