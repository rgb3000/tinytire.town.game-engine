import {
  DesignerTool,
  GameColor,
  DEFAULT_GAME_CONSTANTS,
  COLOR_MAP,
  type MapDesigner,
  type BusinessRotation,
  type GameConstants,
} from '../src/index';
import { colorField, download, el, row, section, setPressed, toggle } from './ui';

const TOOLS: [DesignerTool, string, string][] = [
  [DesignerTool.Road, 'Road', 'R'],
  [DesignerTool.Eraser, 'Eraser', 'E'],
  [DesignerTool.House, 'House', 'H'],
  [DesignerTool.Business, 'Business', 'B'],
  [DesignerTool.Mountain, 'Mountain', 'M'],
  [DesignerTool.Lake, 'Lake', 'L'],
  [DesignerTool.GasStation, 'Gas', 'G'],
  [DesignerTool.Highway, 'Highway', 'W'],
  [DesignerTool.Paint, 'Paint', 'P'],
  [DesignerTool.Forest, 'Forest', 'F'],
];

const COLORS: [GameColor, string][] = [
  [GameColor.Red, 'Red'],
  [GameColor.Blue, 'Blue'],
  [GameColor.Yellow, 'Yellow'],
  [GameColor.Green, 'Green'],
  [GameColor.Purple, 'Purple'],
  [GameColor.Orange, 'Orange'],
];

const THEME_FIELDS: ['background' | 'road' | 'highway' | 'gridLines' | 'groundPlate' | 'mountainColor' | 'waterColor' | 'foliage', string][] = [
  ['background', 'Background'],
  ['groundPlate', 'Ground'],
  ['road', 'Road'],
  ['highway', 'Highway'],
  ['gridLines', 'Grid'],
  ['mountainColor', 'Mountain'],
  ['waterColor', 'Water'],
  ['foliage', 'Trees'],
];

/**
 * A representative slice of `GameConstants`, not all of it. The full set is ~40 keys and
 * a wall of number inputs helps nobody; these are the ones that visibly change a map.
 * Everything else is still editable by hand in the exported JSON.
 */
const TUNABLE: (keyof GameConstants)[] = [
  'STARTING_ROADS',
  'STARTING_GAS_STATIONS',
  'STARTING_HIGHWAYS',
  'WEEKLY_ROAD_BONUS',
  'CARS_PER_HOUSE',
  'CAR_SPEED',
  'MAX_DEMAND_PINS',
];

/**
 * Controls for `MapDesigner`.
 *
 * The designer owns its own pointer input — placement, road dragging, panning and the
 * keyboard shortcuts are all handled inside the engine. This panel only sets the mode
 * the input runs in, and reads back through `onToolChange`.
 *
 * Unlike the play HUD this stays a docked sidebar: it is a dense tool panel and the
 * density is the point. It collapses, so the strip of board underneath can be reached.
 */
export function mountDesignPanel(
  designer: MapDesigner,
  root: HTMLElement,
  onReset: () => void,
): () => void {
  const toolButtons = TOOLS.map(([tool, label, key]) => {
    const button = toggle(label, () => designer.setTool(tool));
    button.append(el('kbd', { textContent: ` ${key}` }));
    return button;
  });

  const colorButtons = COLORS.map(([color, name]) => {
    const button = toggle('', () => {
      designer.activeColor = color;
      syncColors();
    });
    button.className = 'swatch';
    button.title = name;
    button.style.background = COLOR_MAP[color];
    return button;
  });

  const rotationButton = toggle('Rotate business', () => {
    designer.businessRotation = ((designer.businessRotation + 1) % 4) as BusinessRotation;
    rotationButton.textContent = `Business facing ${designer.businessRotation * 90}°`;
  });
  rotationButton.textContent = `Business facing ${designer.businessRotation * 90}°`;

  const isoButton = toggle('Isometric', () => {
    designer.toggleIsometric();
    setPressed(isoButton, designer.getIsometric());
  });

  const constantFields = TUNABLE.map((key) => {
    const input = el('input', {
      type: 'number',
      value: String(designer.constantsOverrides[key] ?? DEFAULT_GAME_CONSTANTS[key]),
    });
    input.addEventListener('change', () => {
      const parsed = Number(input.value);
      // An empty or unparseable field means "no override", not NaN. Writing NaN into
      // the overrides would reach engine arithmetic through `buildConfig`.
      if (input.value.trim() === '' || Number.isNaN(parsed)) {
        delete designer.constantsOverrides[key];
        input.value = String(DEFAULT_GAME_CONSTANTS[key]);
        return;
      }
      designer.constantsOverrides[key] = parsed;
    });
    return el('label', { className: 'const-field' }, [key, input]);
  });

  const exportButton = el('button', { type: 'button', textContent: 'Export JSON' });
  exportButton.addEventListener('click', () => {
    const config = designer.toMapConfig();
    download(`${config.id || 'map'}.json`, designer.exportConfig());
  });

  const logButton = el('button', { type: 'button', textContent: 'Log to console' });
  logButton.addEventListener('click', () => {
    // eslint-disable-next-line no-console -- the point of the button
    console.log(JSON.parse(designer.exportConfig()));
  });

  const resetButton = el('button', { type: 'button', textContent: 'Reset', title: 'Clear the board' });
  resetButton.addEventListener('click', onReset);

  const collapseButton = el('button', { type: 'button', textContent: '▾', title: 'Collapse panel' });
  collapseButton.setAttribute('aria-label', 'Collapse panel');
  collapseButton.addEventListener('click', () => {
    const collapsed = root.dataset.collapsed === 'true';
    root.dataset.collapsed = String(!collapsed);
    collapseButton.textContent = collapsed ? '▾' : '▸';
    collapseButton.title = collapsed ? 'Collapse panel' : 'Expand panel';
  });

  root.append(
    el('div', { className: 'panel-head' }, [
      'Designer',
      el('div', { className: 'row' }, [resetButton, collapseButton]),
    ]),
    section('Tool', row(...toolButtons)),
    section('Colour', row(...colorButtons), row(rotationButton)),
    section('Theme', row(...THEME_FIELDS.map(([key, label]) =>
      colorField(label, designer.colorTheme[key], (hex) => designer.updateThemeField(key, hex)),
    ))),
    el('section', {}, [
      el('details', {}, [el('summary', { textContent: 'Constants' }), ...constantFields]),
    ]),
    section('View', row(isoButton)),
    section('Export', row(exportButton, logButton)),
    section(
      'Help',
      el('p', {
        className: 'note',
        textContent: 'Click to place, drag to draw roads. 1–6 pick a colour, space pans, scroll zooms.',
      }),
    ),
  );

  const syncColors = () => {
    for (const [i, button] of colorButtons.entries()) {
      setPressed(button, COLORS[i][0] === designer.activeColor);
    }
  };
  const syncTools = () => {
    for (const [i, button] of toolButtons.entries()) {
      setPressed(button, TOOLS[i][0] === designer.activeTool);
    }
    syncColors();
    setPressed(isoButton, designer.getIsometric());
  };

  syncTools();
  designer.onToolChange = syncTools;

  return () => {
    designer.onToolChange = null;
    delete root.dataset.collapsed;
    root.replaceChildren();
  };
}
