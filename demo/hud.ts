import {
  GameState,
  Tool,
  COLOR_MAP,
  type Game,
  type DemandStat,
  type Inventory,
  type GameColor,
} from '../src/index';
import { icon, type IconName } from './icons';
import { el, iconButton, pill, preventFocusSteal, setPressed } from './ui';

interface ToolSpec {
  tool: Tool;
  name: string;
  key: string;
  glyph: IconName;
  /** Which inventory slot the tool spends, or null for the eraser. */
  stock: keyof Inventory | null;
}

const TOOLS: ToolSpec[] = [
  { tool: Tool.Road, name: 'Road', key: 'R', glyph: 'road', stock: 'roads' },
  { tool: Tool.Highway, name: 'Hwy', key: 'H', glyph: 'highway', stock: 'highways' },
  { tool: Tool.GasStation, name: 'Gas', key: 'G', glyph: 'gas', stock: 'gasStations' },
  { tool: Tool.Eraser, name: 'Erase', key: 'E', glyph: 'eraser', stock: null },
];

function clock(seconds: number): string {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function statChip(label: string): { node: HTMLElement; value: HTMLElement } {
  const value = el('span', { className: 'value', textContent: '0' });
  const node = el('div', { className: 'stat' }, [
    el('span', { className: 'label', textContent: label }),
    value,
  ]);
  return { node, value };
}

/**
 * The heads-up display: stats, demand, the tool dock and the utility cluster.
 *
 * Built once. `update()` only writes text and attributes onto retained nodes,
 * because `onStateUpdate` fires on every frame while the game is playing — its
 * throttle includes `elapsedTime`, which advances every tick — and rebuilding
 * this DOM sixty times a second is exactly what the old panel did.
 */
export function mountHud(game: Game, onRestart: () => void) {
  const statsHost = document.querySelector<HTMLElement>('#hud-stats')!;
  const demandHost = document.querySelector<HTMLElement>('#hud-demand')!;
  const dockHost = document.querySelector<HTMLElement>('#dock')!;
  const utilityHost = document.querySelector<HTMLElement>('#utility')!;

  // --- stats ---------------------------------------------------------------
  const score = statChip('Delivered');
  const time = statChip('Time');
  const week = statChip('Day · Week');
  const pausedChip = pill('paused-chip');
  pausedChip.textContent = 'Paused';
  pausedChip.hidden = true;
  statsHost.append(pausedChip, pill('', score.node, time.node, week.node));

  // --- demand --------------------------------------------------------------
  // Reconciled rather than rebuilt: colours are only ever added as they unlock.
  const demandPill = pill('demand');
  const demandEmpty = el('span', { className: 'demand-empty', textContent: 'No demand yet' });
  demandPill.append(demandEmpty);
  demandHost.append(demandPill);
  const demandChips = new Map<GameColor, { node: HTMLElement; count: HTMLElement }>();

  // --- tool dock -----------------------------------------------------------
  const toolButtons = TOOLS.map((spec) => {
    const badge = spec.stock ? el('span', { className: 'badge', textContent: '0' }) : null;
    const button = el('button', { type: 'button', className: 'tool', title: `${spec.name} (${spec.key})` }, [
      el('span', { className: 'glyph' }, [icon(spec.glyph)]),
      el('span', { className: 'name', textContent: spec.name }),
    ]);
    if (badge) button.append(badge);
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-keyshortcuts', spec.key);
    button.addEventListener('click', () => game.setActiveTool(spec.tool));
    preventFocusSteal(button);
    return { spec, button, badge };
  });

  const undoButton = el('button', { type: 'button', className: 'icon-btn', title: 'Undo (Ctrl/Cmd+Z)' }, [
    icon('undo', 19),
  ]);
  undoButton.setAttribute('aria-label', 'Undo');
  undoButton.addEventListener('click', () => game.performUndo());
  preventFocusSteal(undoButton);

  dockHost.append(
    pill('dock-group', ...toolButtons.map((t) => t.button)),
    pill('dock-group', undoButton),
  );

  // --- utility -------------------------------------------------------------
  const pauseButton = iconButton('', 'Pause (P)', () => game.togglePause());
  pauseButton.append(icon('pause', 19));

  const speedButton = iconButton('', 'Double speed (F)', () => game.toggleSpeed());
  speedButton.append(icon('speed', 19));
  speedButton.setAttribute('aria-pressed', 'false');

  const isoButton = iconButton('', 'Isometric view (V)', () => {
    game.toggleIsometric();
    setPressed(isoButton, game.getIsometric());
  });
  isoButton.append(icon('isometric', 19));

  const musicButton = iconButton('', 'Music', () => {
    game.setMusicEnabled(!game.isMusicEnabled());
    setPressed(musicButton, game.isMusicEnabled());
  });
  musicButton.append(icon('music', 19));

  const restartButton = iconButton('', 'Restart with a fresh board', onRestart);
  restartButton.append(icon('restart', 19));

  utilityHost.append(pill('', pauseButton, speedButton, isoButton, musicButton, restartButton));

  setPressed(isoButton, game.getIsometric());
  setPressed(musicButton, game.isMusicEnabled());

  // --- syncing -------------------------------------------------------------

  function syncTools(): void {
    const active = game.getActiveTool();
    for (const { spec, button } of toolButtons) setPressed(button, spec.tool === active);
  }

  function syncUndo(): void {
    undoButton.disabled = !game.canUndo();
  }

  function syncDemand(demandStats: DemandStat[] | null): void {
    if (!demandStats?.length) {
      demandEmpty.hidden = false;
      return;
    }
    demandEmpty.hidden = true;
    for (const stat of demandStats) {
      let chip = demandChips.get(stat.color);
      if (!chip) {
        const count = el('span', { className: 'count', textContent: '0' });
        const node = el('span', { className: 'demand-chip' }, [
          el('span', { className: 'dot' }),
          count,
        ]);
        node.style.color = COLOR_MAP[stat.color];
        chip = { node, count };
        demandChips.set(stat.color, chip);
        demandPill.append(node);
      }
      const net = stat.supplyPerMin - stat.demandPerMin;
      chip.count.textContent = String(stat.demand);
      // Net rate is what actually decides the run: supply below demand means the
      // pins are accumulating, however healthy the current count looks.
      chip.node.dataset.trend = net < 0 ? 'down' : 'ok';
      chip.node.title =
        `${stat.houses} houses, ${stat.businesses} businesses, ` +
        `${net >= 0 ? '+' : ''}${net.toFixed(1)}/min`;
    }
  }

  function update(
    state: GameState,
    scoreValue: number,
    timeValue: number,
    inventory: Inventory,
    demandStats: DemandStat[] | null,
    gameDay: number,
    timeScale: number,
    gameWeek: number,
  ): void {
    score.value.textContent = String(scoreValue);
    time.value.textContent = clock(timeValue);
    week.value.textContent = `${gameDay} · ${gameWeek}`;

    // The board is the other half of this signal — the renderer draws car routes
    // while paused — so the HUD only needs to name the state, not dim anything.
    pausedChip.hidden = state !== GameState.Paused;

    for (const { spec, button, badge } of toolButtons) {
      if (!spec.stock || !badge) continue;
      const count = inventory[spec.stock];
      badge.textContent = String(count);
      button.dataset.empty = String(count <= 0);
      // setActiveTool() refuses an empty tool anyway; disabling says so up front.
      button.disabled = count <= 0;
    }

    syncUndo();
    setPressed(speedButton, timeScale > 1);

    const playing = state === GameState.Playing;
    pauseButton.replaceChildren(icon(playing ? 'pause' : 'play', 19));
    pauseButton.disabled = state === GameState.WaitingToStart || state === GameState.GameOver;

    syncDemand(demandStats);
  }

  function dispose(): void {
    statsHost.replaceChildren();
    demandHost.replaceChildren();
    dockHost.replaceChildren();
    utilityHost.replaceChildren();
  }

  return { update, syncTools, syncUndo, dispose };
}
