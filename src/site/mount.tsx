import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import { Features } from './Features';
import { HeroDemo } from './HeroDemo';
import './look.css';

/*
 * The landing page's illustrations, mounted into the slots `index.html` leaves
 * for them. Loaded by `main.ts` with a dynamic import, so React and the
 * stageshow kit are their own chunk and never stand between a page load and
 * the player's controls — the drop zone and both pickers work before this
 * arrives, and keep working if it never does.
 *
 * The hero's slot is `aria-hidden`: it is an animation of what the page's own
 * text already says. The feature grid's copy is real page text and stays
 * readable; only its pictures are decoration.
 */
export function mountLanding(): void {
  const slots: Array<[string, () => ReactNode]> = [
    ['hero-demo', () => <HeroDemo />],
    ['feature-grid', () => <Features />],
  ];
  for (const [id, render] of slots) {
    const slot = document.getElementById(id);
    if (!slot) continue;
    createRoot(slot).render(<StrictMode>{render()}</StrictMode>);
  }
}
