import {
  GameState,
  Tool,
  COLOR_MAP,
  type Game,
  type DemandStat,
  type Inventory,
  type WeeklyChoiceOption,
} from '../src/index';
import { el, row, section, setPressed, stats, toggle } from './ui';

const TOOLS: [Tool, string, string][] = [
  [Tool.Road, 'Road', 'R'],
  [Tool.Highway, 'Highway', 'H'],
  [Tool.GasStation, 'Gas', 'G'],
  [Tool.Eraser, 'Eraser', 'E'],
];

const STATE_LABEL: Record<GameState, string> = {
  [GameState.WaitingToStart]: 'Waiting to start',
  [GameState.Playing]: 'Playing',
  [GameState.Paused]: 'Paused',
  [GameState.GameOver]: 'Game over',
};

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function demandList(demandStats: DemandStat[]): HTMLElement {
  const list = el('div', { className: 'row' });
  for (const stat of demandStats) {
    // Net rate is what actually decides the run: supply below demand means the pins
    // are accumulating, however healthy the current count looks.
    const net = stat.supplyPerMin - stat.demandPerMin;
    list.append(
      el('span', {
        title: `${stat.houses} houses, ${stat.businesses} businesses, ${net >= 0 ? '+' : ''}${net.toFixed(1)}/min`,
        textContent: `${stat.demand}`,
        style: `color:${COLOR_MAP[stat.color]};font-weight:600;font-variant-numeric:tabular-nums`,
      }),
    );
  }
  return list;
}

/**
 * Read-out and controls for a running `Game`.
 *
 * Everything here is driven by `game.onStateUpdate`, which the engine calls once per
 * simulation tick — the panel holds no state of its own.
 */
export function mountPlayPanel(game: Game, root: HTMLElement): () => void {
  const readout = el('div');
  const demand = el('div');
  const banner = el('div');

  const toolButtons = TOOLS.map(([tool, label, key]) => {
    const button = toggle(label, () => game.setActiveTool(tool));
    button.append(el('kbd', { textContent: ` ${key}` }));
    return button;
  });

  const pauseButton = toggle('Pause', () => game.togglePause());
  const speedButton = toggle('Speed', () => game.toggleSpeed());
  const isoButton = toggle('Isometric', () => {
    game.toggleIsometric();
    setPressed(isoButton, game.getIsometric());
  });
  const undoButton = toggle('Undo', () => game.performUndo());
  const musicButton = toggle('Music', () => {
    game.setMusicEnabled(!game.isMusicEnabled());
    setPressed(musicButton, game.isMusicEnabled());
  });

  root.append(
    section('Status', readout, banner),
    section('Demand', demand),
    section('Tool', row(...toolButtons)),
    section('Controls', row(pauseButton, speedButton, undoButton), row(isoButton, musicButton)),
    section(
      'Camera',
      el('p', {
        className: 'note',
        textContent: 'Drag to draw roads. Scroll to zoom, hold space to pan.',
      }),
    ),
  );

  const syncTools = () => {
    const active = game.getActiveTool();
    for (const [i, button] of toolButtons.entries()) setPressed(button, TOOLS[i][0] === active);
  };
  syncTools();
  game.onToolChange(syncTools);
  setPressed(isoButton, game.getIsometric());
  setPressed(musicButton, game.isMusicEnabled());

  game.onStateUpdate((
    state: GameState,
    score: number,
    time: number,
    inventory: Inventory,
    demandStats: DemandStat[] | null,
    gameDay: number,
    timeScale: number,
    gameWeek: number,
    weekChoicePending: boolean,
    pendingChoiceOptions: WeeklyChoiceOption[],
  ) => {
    readout.replaceChildren(
      stats([
        ['State', STATE_LABEL[state]],
        ['Score', String(score)],
        ['Time', clock(time)],
        ['Day / week', `${gameDay} / ${gameWeek}`],
        ['Speed', `${timeScale}x`],
        ['Roads', String(inventory.roads)],
        ['Highways', String(inventory.highways)],
        ['Gas stations', String(inventory.gasStations)],
      ]),
    );

    demand.replaceChildren(demandStats?.length ? demandList(demandStats) : el('p', {
      className: 'note',
      textContent: 'No businesses yet.',
    }));

    setPressed(pauseButton, state === GameState.Paused);
    setPressed(speedButton, timeScale > 1);
    undoButton.disabled = !game.canUndo();

    // `startGame()` must be reached from a real click: it awaits `initAudio()`, and
    // browsers refuse to start an AudioContext outside a user gesture.
    if (state === GameState.WaitingToStart) {
      const start = el('button', { type: 'button', textContent: 'Start' });
      start.addEventListener('click', () => void game.startGame());
      banner.className = 'banner';
      banner.replaceChildren(el('p', { textContent: 'Ready.' }), start);
      return;
    }

    if (state === GameState.GameOver) {
      const again = el('button', { type: 'button', textContent: 'Play again' });
      again.addEventListener('click', () => void game.restart());
      banner.className = 'banner over';
      banner.replaceChildren(el('p', { textContent: `Game over — ${score} delivered.` }), again);
      return;
    }

    if (weekChoicePending) {
      banner.className = 'banner';
      banner.replaceChildren(
        el('p', { textContent: `Week ${gameWeek} — pick a bonus:` }),
        row(...pendingChoiceOptions.map((option) => {
          const button = el('button', { type: 'button', textContent: option.label });
          button.addEventListener('click', () => game.applyWeeklyChoice(option));
          return button;
        })),
      );
      return;
    }

    banner.className = '';
    banner.replaceChildren();
  });

  return () => {
    game.onToolChange(null);
    root.replaceChildren();
  };
}
