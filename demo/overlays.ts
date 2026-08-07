import { GameState, type Game, type MapConfig, type WeeklyChoiceOption } from '../src/index';
import { button, card, el } from './ui';

/** The designer stamps this on every export; it is not worth showing a player. */
const BOILERPLATE_DESCRIPTION = 'Created with Map Designer';

function legend(): HTMLElement {
  const line = (...parts: (Node | string)[]) => el('div', {}, parts);
  return el('p', { className: 'footnote' }, [
    line(el('b', { textContent: 'Drag' }), ' to draw a road · ', el('b', { textContent: 'Shift-click' }), ' to auto-route'),
    line(el('b', { textContent: 'Right-drag' }), ' to erase · ', el('b', { textContent: 'R E H G' }), ' pick a tool'),
    line(el('b', { textContent: 'Space' }), ' to pan · ', el('b', { textContent: 'Scroll' }), ' to zoom · ', el('b', { textContent: 'P' }), ' to pause'),
  ]);
}

/**
 * The start, game-over and weekly-bonus cards.
 *
 * Which host a card is mounted into is a gameplay decision, not a visual one:
 * `#overlay` dims the board and takes every click, `#toast` takes clicks only on
 * the card. The weekly bonus must be a `#toast`, because the engine runs the road
 * drawer during that pause — `Game.update()` reaches `roadDrawer.update()` before
 * it bails on `state !== Playing` — so the player is meant to keep drawing while
 * deciding.
 */
export function mountOverlays(game: Game, map: MapConfig | undefined, onChangeMap: () => void) {
  const overlayHost = document.querySelector<HTMLElement>('#overlay')!;
  const toastHost = document.querySelector<HTMLElement>('#toast')!;

  /** What is on screen right now, so a card is rebuilt on transitions only. */
  let showing = '';

  function startCard(): HTMLElement {
    const description = map?.description === BOILERPLATE_DESCRIPTION ? undefined : map?.description;
    return card({
      mark: '🚗',
      eyebrow: map ? 'Map' : 'No map file',
      title: map?.name ?? 'Blank canvas',
      body: description ?? 'Engine defaults on a procedurally generated board.',
      // startGame() must be reached from a real click: it awaits initAudio(), and
      // browsers refuse to start an AudioContext outside a user gesture.
      actions: [button('Start', 'btn-go', () => void game.startGame())],
      footnote: legend(),
    });
  }

  function gameOverCard(score: number): HTMLElement {
    return card({
      tone: 'over',
      title: 'Gridlock',
      score: String(score),
      body: score === 1 ? '1 delivery made.' : `${score} deliveries made.`,
      actions: [
        // restart() resumes straight into Playing, so there is no second start card.
        button('Play again', 'btn-go', () => void game.restart()),
        button('Change map', 'btn-ghost', onChangeMap),
      ],
    });
  }

  function weeklyCard(gameWeek: number, options: WeeklyChoiceOption[]): HTMLElement {
    return card({
      title: `Week ${gameWeek} — pick a bonus`,
      actions: options.map((option) =>
        button(option.label, 'btn-choice', () => game.applyWeeklyChoice(option)),
      ),
    });
  }

  function sync(
    state: GameState,
    score: number,
    gameWeek: number,
    weekChoicePending: boolean,
    options: WeeklyChoiceOption[],
  ): void {
    const next = state === GameState.WaitingToStart
      ? 'start'
      : state === GameState.GameOver
        ? `over:${score}`
        : weekChoicePending
          ? `week:${gameWeek}`
          : 'none';

    if (next === showing) return;
    showing = next;

    overlayHost.replaceChildren();
    toastHost.replaceChildren();

    if (next === 'start') overlayHost.append(startCard());
    else if (next.startsWith('over:')) overlayHost.append(gameOverCard(score));
    else if (next.startsWith('week:')) toastHost.append(weeklyCard(gameWeek, options));

    // Put the caret on the primary action so Enter works and a keyboard user is
    // dropped straight onto the thing the card exists for. Only the blocking
    // cards do this — stealing focus for the weekly bonus would interrupt a drag.
    overlayHost.querySelector<HTMLButtonElement>('.btn-go')?.focus();
  }

  function dispose(): void {
    overlayHost.replaceChildren();
    toastHost.replaceChildren();
  }

  return { sync, dispose };
}
