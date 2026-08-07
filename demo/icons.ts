/**
 * The icon set, as path data.
 *
 * Drawn on a 24px box with a 2px round stroke so they sit at the same optical
 * weight as the rounded type. `currentColor` throughout, so a selected tool's
 * icon inverts with the rest of the button and nothing needs a second rule.
 */
const PATHS: Record<string, string[]> = {
  // Two kerbs and a dashed centre line.
  road: ['M8 3v18', 'M16 3v18', 'M12 4.5v3', 'M12 10.5v3', 'M12 16.5v3'],
  // An overpass: highways in this game are elevated and bridge the terrain.
  highway: ['M3 19v-2a9 9 0 0 1 18 0v2', 'M2 19h20', 'M8 19v-4.5', 'M16 19v-4.5'],
  gas: ['M4 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16', 'M3 21h12', 'M6 9h5', 'M13 8h3a2 2 0 0 1 2 2v6a1.5 1.5 0 0 0 3 0V11l-2-2'],
  eraser: ['M20 20h-9l-4-4a2 2 0 0 1 0-2.8l7.6-7.6a2 2 0 0 1 2.8 0l4.4 4.4a2 2 0 0 1 0 2.8L14 20', 'M9.5 10.5 15 16'],
  undo: ['M9 14 4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-4'],
  pause: ['M9 5v14', 'M15 5v14'],
  play: ['M8 5.5v13l11-6.5z'],
  speed: ['M4 5.5v13l8-6.5z', 'M13 5.5v13l8-6.5z'],
  isometric: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12v9', 'M4 7.5l8 4.5 8-4.5'],
  music: ['M9 18V6l11-2v12', 'M4 18.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0', 'M15 16.5a2.5 2.5 0 1 0 5 0 2.5 2.5 0 1 0-5 0'],
  restart: ['M20.5 12a8.5 8.5 0 1 1-2.5-6', 'M20.5 3.5v5h-5'],
};

const NS = 'http://www.w3.org/2000/svg';

export type IconName = keyof typeof PATHS;

export function icon(name: IconName, size = 22): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of PATHS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
