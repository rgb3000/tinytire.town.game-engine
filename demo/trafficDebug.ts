import type { Game } from '../src/index';

/**
 * The debugging tap for a board that locks up.
 *
 * Two ways in, both console-shaped because a deadlock is seen by a person watching the
 * demo, not by code:
 *
 * - `window.dumpTraffic()` — on demand: prints the per-car diagnosis (who is waiting for
 *   whom, and any waits-for cycle) and stashes the world snapshot as JSON on
 *   `window.__lastTrafficDump`, ready for `copy(window.__lastTrafficDump)`.
 * - A freeze watchdog — automatic: polls once a second, and when every non-parked car has
 *   been standing for `FREEZE_SECONDS` straight, captures the same dump *once* and says
 *   so. Automatic because the interesting moment is the freeze itself; by the time a
 *   person reaches for the console, reroutes and despawns may already have disturbed the
 *   evidence. One capture per freeze, so a long-ignored deadlock does not spam.
 *
 * The snapshot restores in a Node test via `deserializeWorld` from `src/traffic/snapshot.ts`
 * and steps tick-for-tick identically to the live world — that is the whole workflow:
 * freeze → copy JSON → fixture file → failing test.
 */
const FREEZE_SECONDS = 5;
/** Fewer standing cars than this is a quiet board, not a deadlock. */
const MIN_STANDING = 2;

declare global {
  interface Window {
    dumpTraffic?: () => ReturnType<Game['dumpTraffic']>;
    __lastTrafficDump?: string;
  }
}

export function wireTrafficDebug(game: Game): () => void {
  const capture = (): ReturnType<Game['dumpTraffic']> => {
    const dump = game.dumpTraffic();
    window.__lastTrafficDump = JSON.stringify(dump.snapshot);
    console.warn(
      `${dump.text}\n` +
      'Snapshot stashed — run copy(window.__lastTrafficDump) and save it as a .json ' +
      'fixture to replay this exact state in a Node test.',
    );
    return dump;
  };

  window.dumpTraffic = capture;

  let frozenFor = 0;
  let reported = false;
  const timer = window.setInterval(() => {
    const { diagnosis } = game.dumpTraffic();
    const standing = diagnosis.vehicles.filter(
      (v) => v.reason.kind !== 'moving' && v.reason.kind !== 'parked',
    ).length;
    const anyMoving = diagnosis.vehicles.some((v) => v.reason.kind === 'moving');

    if (standing >= MIN_STANDING && !anyMoving) {
      frozenFor += 1;
      if (frozenFor >= FREEZE_SECONDS && !reported) {
        reported = true;
        console.warn(`traffic frozen for ${frozenFor}s — capturing automatically`);
        capture();
      }
    } else {
      frozenFor = 0;
      reported = false;
    }
  }, 1000);

  return () => {
    window.clearInterval(timer);
    delete window.dumpTraffic;
    delete window.__lastTrafficDump;
  };
}
