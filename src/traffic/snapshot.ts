import type { Route, TrafficWorld, Vehicle } from './types';

/**
 * A frozen, JSON-safe copy of a `TrafficWorld`.
 *
 * This exists for one workflow: a board freezes in the demo, the player dumps the world
 * from the console, and the dump becomes a Node fixture — `deserializeWorld` restores it
 * and the suite can step it, `diagnose` it, and pin the fix. Everything in a world is
 * already plain data (that is what the purity guard buys), so "serialize" is a deep copy
 * and nothing more; `Route` and `Vehicle` are their own wire format.
 *
 * `version` is bumped whenever `Route` or `Vehicle` grows a field a replay depends on, so
 * an old fixture fails loudly instead of restoring a half-world that stalls for reasons
 * the live board never had.
 */
export interface WorldSnapshot {
  version: 1;
  time: number;
  routes: Route[];
  vehicles: Vehicle[];
}

const SNAPSHOT_VERSION = 1;

/** Deep copy via JSON, which is exact here: a world holds only numbers, strings and arrays. */
function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serializeWorld(world: TrafficWorld): WorldSnapshot {
  return deepCopy({
    version: SNAPSHOT_VERSION,
    time: world.time,
    routes: [...world.routes.values()],
    vehicles: world.vehicles,
  });
}

/**
 * Restore a snapshot into a fresh, steppable world.
 *
 * The restored world shares nothing with the snapshot object — a test may deserialize the
 * same fixture twice and step the copies independently, which is exactly how the
 * determinism sweep uses it.
 */
export function deserializeWorld(snapshot: WorldSnapshot): TrafficWorld {
  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `traffic snapshot version ${String(snapshot.version)} is not ${SNAPSHOT_VERSION}; ` +
      're-capture the dump against the current model',
    );
  }
  const copy = deepCopy(snapshot);
  const world: TrafficWorld = { routes: new Map(), vehicles: copy.vehicles, time: copy.time };
  for (const route of copy.routes) world.routes.set(route.id, route);
  return world;
}
