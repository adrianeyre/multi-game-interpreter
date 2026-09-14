/**
 * The two icons the games folder needs, drawn rather than typed.
 *
 * `▶` and `×` are characters, and characters are a font's business: they sit
 * off the optical centre of a square button, they change size between
 * platforms, and a screen reader reads them out as "black right-pointing
 * triangle". Built as SVG they are the same everywhere, and `aria-hidden`
 * leaves the label the button already carries as the only thing announced.
 */

const SVG = 'http://www.w3.org/2000/svg';

function icon(): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  // Named as well as hidden: IE-era focus behaviour aside, an SVG inside a
  // button is not a tab stop and Safari has been known to make one of it.
  svg.setAttribute('focusable', 'false');
  return svg;
}

/** A filled triangle: play. */
export function playIcon(): SVGSVGElement {
  const svg = icon();
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M4.5 2.6 13 8l-8.5 5.4z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/** A cross: close. */
export function closeIcon(): SVGSVGElement {
  const svg = icon();
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'M3.5 3.5 12.5 12.5 M12.5 3.5 3.5 12.5');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.75');
  path.setAttribute('stroke-linecap', 'round');
  svg.appendChild(path);
  return svg;
}
