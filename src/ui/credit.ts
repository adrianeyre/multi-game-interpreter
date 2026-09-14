/**
 * The footer credit: who made this, and which version you are looking at.
 *
 * The version comes from `package.json` through the build rather than being
 * written into the markup, because releases are cut automatically and a
 * hand-typed number would be wrong almost immediately. Knowing the exact
 * version is also the first thing anyone reporting a bug needs.
 */

const REPOSITORY = 'https://github.com/adrianeyre/multi-game-interpreter';

/** GitHub's mark, inline so the footer needs no network request to render. */
function githubMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('credit-mark');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'currentColor');
  path.setAttribute(
    'd',
    'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z',
  );
  svg.appendChild(path);
  return svg;
}

/** Builds the credit block. Centred by the footer's own layout. */
export function createCredit(): HTMLElement {
  const credit = document.createElement('div');
  credit.className = 'credit';

  const link = document.createElement('a');
  link.className = 'credit-link';
  link.href = REPOSITORY;
  // Opening in a new tab keeps a game that is mid-load from being thrown away
  // by a click on a credit.
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.title = 'Source code on GitHub';
  // 2.4.4: "Website design" says who, not where. The accessible name keeps the
  // visible words first — 2.5.3 asks that of anything a voice control might be
  // told to click — and adds the destination and the fact that it leaves.
  link.setAttribute('aria-label', 'Website design — source code on GitHub, opens in a new tab');
  link.append(githubMark(), document.createTextNode('Website design'));

  // A separator element rather than punctuation inside the version text, so
  // it disappears with the pieces it separates rather than dangling.
  const separator = document.createElement('span');
  separator.className = 'credit-separator';
  separator.setAttribute('aria-hidden', 'true');
  separator.textContent = '·';

  const version = document.createElement('span');
  version.className = 'credit-version';
  version.textContent = `Version : ${__APP_VERSION__}`;

  credit.append(link, separator, version);
  return credit;
}
