import { Game, MapDesigner, allMaps, type MapConfig } from '../src/index';
import { mountPlayPanel } from './playPanel';
import { wireTrafficDebug } from './trafficDebug';
import { mountDesignPanel } from './designPanel';
import { el, pill, setPressed } from './ui';

type Mode = 'play' | 'design';

const BLANK = '__blank__';

const host = document.querySelector<HTMLDivElement>('#canvas-host')!;
const topbar = document.querySelector<HTMLElement>('#topbar')!;
const panel = document.querySelector<HTMLElement>('#panel')!;

let mode: Mode = 'play';
let mapId: string = allMaps[0].id;
let teardown: (() => void) | null = null;

// --- topbar ----------------------------------------------------------------
// Three separate pills rather than one edge-to-edge bar: it reads better, and it
// is why the whole top of the board stays drawable — only the pills take clicks.

const modeButtons: HTMLButtonElement[] = (['play', 'design'] as const).map((value) => {
  const button = el('button', {
    type: 'button',
    textContent: value === 'play' ? 'Play' : 'Design',
  });
  button.setAttribute('aria-pressed', String(value === mode));
  button.addEventListener('click', () => {
    if (value === mode) return;
    mode = value;
    mount();
  });
  return button;
});

const picker = el('select', { id: 'map-picker' });
for (const map of allMaps) picker.append(new Option(map.name, map.id));
picker.append(new Option('Blank canvas', BLANK));
picker.value = mapId;
picker.addEventListener('change', () => {
  mapId = picker.value;
  mount();
});

topbar.append(
  pill(
    'brand',
    el('span', { className: 'mark', textContent: '🚗' }),
    'tinytire',
    el('span', { className: 'sub', textContent: '/engine' }),
  ),
  pill('', el('div', { className: 'segmented' }, modeButtons)),
  pill('', el('span', { className: 'field', textContent: 'Map' }), picker),
);

function selectedMap(): MapConfig | undefined {
  return allMaps.find((m) => m.id === mapId);
}

/**
 * Tear down whatever is running and start fresh.
 *
 * The canvas is recreated every time rather than reused: `Game` and `MapDesigner` each
 * build their own `WebGLRenderer` bound to the canvas they are given, and a disposed
 * renderer leaves its context behind.
 */
function mount(): void {
  teardown?.();
  teardown = null;
  host.replaceChildren();
  panel.replaceChildren();

  const canvas = document.createElement('canvas');
  host.append(canvas);

  if (mode === 'play') {
    const map = selectedMap();
    const game = new Game(canvas, map);
    game.start();
    const unwireDebug = wireTrafficDebug(game);
    const unmountPanel = mountPlayPanel(game, map, {
      onRestart: mount,
      onChangeMap: () => picker.focus(),
    });
    teardown = () => {
      unwireDebug();
      unmountPanel();
      game.dispose();
    };
  } else {
    const designer = new MapDesigner(canvas);
    // Load before `start()`: `loadMapConfig` rebuilds the grid and the renderer's
    // static geometry, which the render loop then reads every frame.
    const map = selectedMap();
    if (map) designer.loadMapConfig(map);
    designer.start();
    // Reset wipes the board rather than reloading the map: a map's own forest, terrain and
    // roads would all come straight back. The picker follows, so it never names a map the
    // board no longer shows.
    const unmountPanel = mountDesignPanel(designer, panel, () => {
      mapId = BLANK;
      picker.value = BLANK;
      mount();
    });
    teardown = () => {
      unmountPanel();
      designer.dispose();
    };
  }

  for (const [i, button] of modeButtons.entries()) setPressed(button, i === (mode === 'play' ? 0 : 1));
}

mount();
