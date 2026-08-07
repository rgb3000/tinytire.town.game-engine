import type { Game, MapConfig } from '../src/index';
import { mountHud } from './hud';
import { mountOverlays } from './overlays';

/**
 * Wiring for a running `Game`.
 *
 * `onStateUpdate` is a single-slot setter on the engine — there is no way to
 * register twice — so this is the one subscriber, and it fans out to the HUD and
 * the cards. Neither of them holds state of its own.
 */
export function mountPlayPanel(
  game: Game,
  map: MapConfig | undefined,
  handlers: { onRestart: () => void; onChangeMap: () => void },
): () => void {
  const hud = mountHud(game, handlers.onRestart);
  const overlays = mountOverlays(game, map, handlers.onChangeMap);

  hud.syncTools();
  game.onToolChange(hud.syncTools);
  // Roads can still be drawn while paused, when the state callback is frozen
  // because every scalar it watches has stopped moving. This keeps Undo honest.
  game.setOnUndoStateChange(hud.syncUndo);

  game.onStateUpdate((
    state,
    score,
    time,
    inventory,
    demandStats,
    gameDay,
    timeScale,
    gameWeek,
    weekChoicePending,
    pendingChoiceOptions,
  ) => {
    hud.update(state, score, time, inventory, demandStats, gameDay, timeScale, gameWeek);
    overlays.sync(state, score, gameWeek, weekChoicePending, pendingChoiceOptions);
  });

  // The callback is throttled on changed values, so paint once from the getters
  // rather than waiting for the first frame that happens to differ.
  hud.update(
    game.getState(),
    game.getScore(),
    game.getElapsedTime(),
    game.getInventory(),
    null,
    game.getGameDay(),
    game.getTimeScale(),
    game.getGameWeek(),
  );
  overlays.sync(
    game.getState(),
    game.getScore(),
    game.getGameWeek(),
    game.isWeekChoicePending(),
    game.getPendingChoiceOptions(),
  );

  return () => {
    game.onToolChange(null);
    game.setOnUndoStateChange(null);
    hud.dispose();
    overlays.dispose();
  };
}
