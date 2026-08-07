/**
 * The per-frame bookkeeping every world does between "systems have been mutated" and
 * "the renderer may draw".
 *
 * This existed in three hand-maintained copies — in `Game.update`, `DemoGame.update` and
 * `MapDesigner`'s render loop — which had already drifted: `DemoGame` never looked at the
 * highway or gas-station flags (so `highwaySystem.isDirty`, set once by `applyMapConfig`,
 * stayed true forever), and the designer never recomputed intersection flags after a road
 * edit.
 *
 * Scope is deliberately *reaction only*: read the dirty flags, tell the affected parties,
 * clear them. Deciding when to run this, and what else a frame does, stays with each caller.
 */
import type { Grid } from './Grid';
import type { Business } from '../entities/Business';
import type { House } from '../entities/House';
import type { RoadSystem } from '../systems/RoadSystem';
import type { HighwaySystem } from '../systems/HighwaySystem';
import type { GasStationSystem } from '../systems/GasStationSystem';
import type { CarSystem } from '../systems/CarSystem';
import type { Pathfinder } from '../pathfinding/Pathfinder';

/**
 * The slice of the renderer this touches.
 *
 * A structural interface rather than a `Renderer` import, for the same reason
 * `SpawnDemandSource` (`src/systems/SpawnSystem.ts`) and `CameraView`
 * (`src/input/CameraController.ts`) exist: it states from the signature exactly what can be
 * affected, and it keeps this module — and its test — free of WebGL. `Renderer` satisfies it
 * without declaring anything.
 */
export interface FrameRenderTarget {
  markGroundDirty(): void;
  markHighwayDirty(): void;
}

/**
 * The systems a world flushes. The optional ones are genuinely absent in some worlds, not
 * merely inconvenient to pass: the demo backdrop has no gas stations, and the designer has
 * no pathfinder or cars because it never simulates.
 */
export interface WorldFrameSystems {
  grid: Grid;
  roadSystem: RoadSystem;
  highwaySystem: HighwaySystem;
  gasStationSystem?: GasStationSystem;
  pathfinder?: Pathfinder;
  carSystem?: CarSystem;
  getHouses?: () => House[];
}

/**
 * React to whatever changed the traversable world this frame, then clear the flags.
 *
 * The three flags are read once, up front: clearing one must not change whether the others
 * are seen to have fired. A road change is the only one that invalidates the cached
 * intersection flags, but *any* of them invalidates the path cache and the cars' routes,
 * which is why those two run before the per-flag branches.
 */
export function flushWorldDirty(systems: WorldFrameSystems, renderer: FrameRenderTarget): void {
  const { grid, roadSystem, highwaySystem, gasStationSystem, pathfinder, carSystem, getHouses } = systems;

  const roadDirty = roadSystem.isDirty;
  const highwayDirty = highwaySystem.isDirty;
  const gasStationDirty = gasStationSystem?.isDirty ?? false;
  if (!roadDirty && !highwayDirty && !gasStationDirty) return;

  pathfinder?.clearCache();
  if (carSystem && getHouses) carSystem.onRoadsChanged(getHouses());

  if (roadDirty) {
    roadSystem.clearDirty();
    grid.recomputeIntersectionFlags();
    renderer.markGroundDirty();
  }
  if (highwayDirty) {
    highwaySystem.clearDirty();
    renderer.markHighwayDirty();
  }
  if (gasStationDirty) {
    gasStationSystem!.clearDirty();
    renderer.markGroundDirty();
  }
}

/**
 * Refresh each business's "a road reaches me" flag, which drives the spinning-connector
 * prompt. Cheap enough to run unconditionally: the alternative is tracking which cells a
 * road edit touched, and every world already runs this every frame.
 */
export function updateConnectorStatus(grid: Grid, businesses: Business[]): void {
  for (const biz of businesses) {
    const cell = grid.getCell(biz.connectorPos.gx, biz.connectorPos.gy);
    biz.connected = cell ? cell.roadConnections !== 0 : false;
  }
}
