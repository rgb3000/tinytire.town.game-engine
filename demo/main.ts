import { Game, MapDesigner, allMaps, type MapConfig } from '../src/index';
import { mountPlayPanel } from './playPanel';
import { mountDesignPanel } from './designPanel';
import { setPressed } from './ui';

type Mode = 'play' | 'design';

const BLANK = '__blank__';

const host = document.querySelector<HTMLDivElement>('#canvas-host')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const picker = document.querySelector<HTMLSelectElement>('#map-picker')!;
const reload = document.querySelector<HTMLButtonElement>('#reload')!;
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-mode]')];

let mode: Mode = 'play';
let mapId: string = allMaps[0].id;
let teardown: (() => void) | null = null;

for (const map of allMaps) picker.append(new Option(map.name, map.id));
picker.append(new Option('Blank canvas', BLANK));
picker.value = mapId;

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
    const unmountPanel = mountPlayPanel(game, panel);
    teardown = () => {
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
    const unmountPanel = mountDesignPanel(designer, panel);
    teardown = () => {
      unmountPanel();
      designer.dispose();
    };
  }

  for (const button of modeButtons) setPressed(button, button.dataset.mode === mode);
}

for (const button of modeButtons) {
  button.addEventListener('click', () => {
    const next = button.dataset.mode;
    if (next !== 'play' && next !== 'design') return;
    if (next === mode) return;
    mode = next;
    mount();
  });
}

picker.addEventListener('change', () => {
  mapId = picker.value;
  mount();
});

reload.addEventListener('click', mount);

mount();
