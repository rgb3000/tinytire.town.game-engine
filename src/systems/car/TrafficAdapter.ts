import type { Grid } from '../../core/Grid';
import type { Car } from '../../entities/Car';
import { CarState } from '../../entities/Car';
import type { PathStep } from '../../highways/types';
import type { HighwaySystem } from '../HighwaySystem';
import type { CarTuning } from './CarTuning';
import { CellType } from '../../types';
import type { GridPos, PixelPos } from '../../types';
import { INTERSECTION_SPEED_MULTIPLIER, TILE_SIZE } from '../../constants';
import { gridToPixelCenter, pixelToGrid } from '../../utils/math';
import {
  buildRoute, sampleRoute, step, createWorld, routeCoversCell, cellsBetween,
  SegmentKind, VehicleMode, TrafficEventKind,
  DEFAULT_IDM, LEADER_SCAN_EDGES, MAX_DECELERATION, STALL_WATCHDOG_SECONDS, STOPPED_SPEED,
} from '../../traffic';
import type {
  Route, RouteCellInput, RouteSpan, TrafficEvent, TrafficWorld, Vehicle,
} from '../../traffic';

/**
 * How close two points must be before one counts as already lying on the other.
 *
 * Used only when folding a lone grid cell into a highway span. In every path the
 * pathfinder actually produces the polyline already terminates on that cell's centre, so
 * the fold is a no-op; the tolerance is what says so without assuming it.
 */
const COINCIDENT_EPS = 0.5;

/**
 * The seam between the engine and the traffic simulation.
 *
 * The only file that knows about both `Grid`/`Car` and `TrafficWorld`. Everything under
 * `src/traffic/` is plain data and pure functions; everything above it is the game. Game
 * rules — fuel, scoring, which building a car is going to — stay on this side, so the
 * simulation never grows a special case for them.
 *
 * Four preconditions the simulation cannot check for itself are established here, because
 * this is the only place that can. Each has a measured failure behind it:
 *
 * 1. **Every grid span carries at least two cells.** `buildRoute` refuses fewer, and a
 *    dropped span silently splices its neighbours together. See `buildSpans`.
 * 2. **No grid span *begins* on a junction cell.** Such a cell is invisible to both
 *    `nextJunctionCell` and `insideJunctionCell`, so the car would cross it unregulated
 *    while other code believed it was reserved. See `describeCell`.
 * 3. **The worst speed a map can ask for is within the model's lookahead.** Asserted in the
 *    constructor, because `CAR_SPEED` cannot be read from inside `src/traffic/`.
 * 4. **A vehicle that stops for ever is reported.** See `update`.
 */
export class TrafficAdapter {
  private world: TrafficWorld = createWorld();
  private vehiclesByCar = new Map<string, Vehicle>();
  /** Seconds each vehicle has spent at a standstill it did not choose. See `update`. */
  private stalledFor = new Map<string, number>();
  /** How far along `route.cells` each vehicle has been reported past. See `consumePassedCells`. */
  private passedCells = new Map<string, number>();
  private grid: Grid;
  private cfg: CarTuning;
  private highwaySystem: HighwaySystem | null;

  constructor(grid: Grid, cfg: CarTuning, highwaySystem?: HighwaySystem) {
    this.grid = grid;
    this.cfg = cfg;
    this.highwaySystem = highwaySystem ?? null;
    assertSpeedWithinLookahead(cfg);
  }

  /**
   * Compile a path into a route and attach the car to it.
   *
   * `preservePosition` is the difference between rerouting a moving car and starting a new
   * journey. When set, the car's current position is projected onto the new route to find
   * its arc distance — and because arc distance *is* the rendered position, the car stays
   * where it is. The old `reassignPath` computed the same projection but wrote it to a
   * field the renderer ignored, which is why reroutes made cars jump.
   *
   * The position projected is the one the *simulation* holds — `sampleRoute` of the old
   * route at the old arc — and not `car.pixelPos`. They are the same number whenever
   * `writeBack` has run since the last `update`, and `car.pixelPos` is a tick stale
   * otherwise. Reading the mirror would put the second representation back into the one
   * code path the whole design exists to keep it out of, and the failure is not subtle:
   * rerouting without an intervening `writeBack` snapped a car back to wherever it was last
   * drawn, which on a car rerouted once a second held it 30px short of a junction it had
   * already been admitted to, permanently. `car.pixelPos` is still the fallback for a car
   * that has no vehicle yet, which is the only case where the simulation holds no position.
   *
   * It also keeps `arrivalTime`, and that is not cosmetic. The stamp is a car's whole grip
   * on its place in a junction queue, and zero is the sentinel for "has not begun waiting",
   * which sorts *last*. Clearing it on a reroute would drop a car that had been at the line
   * for eight seconds to the back of the queue — and since the stall watchdog below asks
   * the caller to reroute exactly the cars that have been waiting longest, that would make
   * the watchdog the *cause* of the starvation it exists to break.
   *
   * Returns false when the path cannot form a curve: fewer than two points, a lone grid
   * cell with no highway to fold it into, an unresolvable highway id, or a joint between
   * spans wider than a tile. The caller decides what that means — today `CarRouter` strands
   * the car.
   */
  installRoute(car: Car, path: PathStep[], preservePosition: boolean): boolean {
    const spans = this.buildSpans(path);
    if (spans === null) return false;
    const route = buildRoute({ id: car.id, spans });
    if (route === null) return false;

    // Read before the store below overwrites it: routes are keyed by car id, so installing
    // is what destroys the old one, and the old one is where the car currently is.
    const anchor = this.simulatedPosition(car) ?? car.pixelPos;
    this.world.routes.set(route.id, route);

    let vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) {
      vehicle = {
        id: car.id, routeId: route.id, arcDistance: 0, speed: 0,
        mode: VehicleMode.Driving, lastAcceleration: 0, arrivalTime: 0,
        distanceThisTick: 0,
      };
      this.vehiclesByCar.set(car.id, vehicle);
      this.world.vehicles.push(vehicle);
    }

    vehicle.routeId = route.id;
    vehicle.mode = VehicleMode.Driving;
    vehicle.arcDistance = preservePosition ? projectOntoRoute(anchor, route) : 0;
    if (!preservePosition) {
      vehicle.speed = 0;
      vehicle.arrivalTime = 0;
      vehicle.distanceThisTick = 0;
    }
    this.stalledFor.set(car.id, 0);
    this.passedCells.set(car.id, 0);

    return true;
  }

  removeVehicle(car: Car): void {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return;
    this.vehiclesByCar.delete(car.id);
    this.stalledFor.delete(car.id);
    this.passedCells.delete(car.id);
    this.world.routes.delete(vehicle.routeId);
    const i = this.world.vehicles.indexOf(vehicle);
    if (i >= 0) this.world.vehicles.splice(i, 1);
  }

  /**
   * Is this car standing still because it was told to, rather than because of traffic?
   *
   * The caller needs to tell those apart: a car in a driving state that the simulation has
   * parked is stopped for ever, since parked vehicles are exempt from the stall watchdog and
   * so cannot even report it. A car the simulation holds no vehicle for is not parked — it
   * has nothing to un-park, and its remedy is a route.
   */
  isParked(car: Car): boolean {
    return this.vehiclesByCar.get(car.id)?.mode === VehicleMode.Parked;
  }

  /** A parked car still occupies road and still blocks followers. */
  setParked(car: Car, parked: boolean): void {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return;
    vehicle.mode = parked ? VehicleMode.Parked : VehicleMode.Driving;
    if (parked) vehicle.speed = 0;
    this.stalledFor.set(car.id, 0);
  }

  /**
   * Advance the simulation and report what happened.
   *
   * Two kinds of event come back, and the caller must act on both.
   *
   * **`Arrived` obliges the caller to either despawn the vehicle or park it.** A vehicle
   * left driving at the end of its route sits on the road for ever with nothing able to
   * pass it: measured on a Task 7 fixture as a 55.6-second stall that never cleared. Which
   * of the two is right is a game decision — a car reaching a business parks and keeps
   * blocking because it is physically there, a car reaching home leaves the board — which
   * is exactly why it is not made here.
   *
   * **`Blocked` is the watchdog**, and it exists because the simulation offers no guarantee
   * that a junction's exit cell ever drains. `exitHasRoom` skips any candidate whose exit
   * cell holds a stopped vehicle, which is what stops a ring of junctions gridlocking; the
   * price is that a *permanently* stopped vehicle in that cell holds its queue for ever.
   * That is reachable in play and not only in theory: a car with no route home is left
   * standing on whatever road cell it stopped on until a rescue succeeds, and a rescue may
   * never succeed. Since nothing below this line can promise drainage, and nothing below
   * this line can perform the remedy — repathing needs the pathfinder, the fuel model and
   * the destination — the adapter measures and the caller acts.
   *
   * The threshold is `STALL_WATCHDOG_SECONDS`, and the note at its definition is the whole
   * of its justification: it must sit above the worst stall healthy congestion produces and
   * below the bound past which the simulation's own sweeps call a run defective. It is
   * deliberately *not* the old eight-second stuck timeout the previous movement code used,
   * which fired below observed-healthy behaviour. The counter resets on emission, so a
   * vehicle that stays stuck keeps asking rather than asking once and going quiet.
   *
   * Parked vehicles are exempt: standing still is what parking *is*.
   */
  update(dt: number): TrafficEvent[] {
    const events = step(this.world, dt);

    for (const vehicle of this.world.vehicles) {
      if (vehicle.mode === VehicleMode.Parked || vehicle.speed > STOPPED_SPEED) {
        this.stalledFor.set(vehicle.id, 0);
        continue;
      }
      const stalled = (this.stalledFor.get(vehicle.id) ?? 0) + dt;
      if (stalled >= STALL_WATCHDOG_SECONDS) {
        this.stalledFor.set(vehicle.id, 0);
        events.push({ kind: TrafficEventKind.Blocked, vehicleId: vehicle.id });
      } else {
        this.stalledFor.set(vehicle.id, stalled);
      }
    }

    return events;
  }

  /**
   * Copy simulated positions onto cars for the renderers.
   *
   * `pixelPos` and `renderAngle` are derived from `arcDistance` every frame and never
   * written anywhere else. That single source of truth is what makes position jumps
   * impossible: there is no second representation to fall out of step with.
   */
  writeBack(cars: Car[]): void {
    for (const car of cars) {
      const vehicle = this.vehiclesByCar.get(car.id);
      if (!vehicle) continue;
      const route = this.world.routes.get(vehicle.routeId);
      if (!route) continue;

      car.prevPixelPos.x = car.pixelPos.x;
      car.prevPixelPos.y = car.pixelPos.y;
      car.prevRenderAngle = car.renderAngle;
      car.prevElevationY = car.elevationY;

      const sample = sampleRoute(route, vehicle.arcDistance);
      car.pixelPos.x = sample.x;
      car.pixelPos.y = sample.y;
      car.renderAngle = sample.angle;
      car.elevationY = sample.elevationY;
      car.onHighway = sample.elevationY !== 0;
      car.currentSpeed = vehicle.speed;
    }
  }

  getRouteFor(car: Car): Route | null {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return null;
    return this.world.routes.get(vehicle.routeId) ?? null;
  }

  getArc(car: Car): number {
    return this.vehiclesByCar.get(car.id)?.arcDistance ?? 0;
  }

  /**
   * The grid cell this car is standing on, or null when the simulation holds no route for it.
   *
   * Nearest cell centre by arc, which is what `CarRouter.getCarCurrentTile` computed from
   * `segmentProgress >= 0.5 ? next : current` — the same rule, read off the one position
   * that now exists instead of off a second representation of it.
   *
   * Two callers, and they want it for opposite reasons. `rerouteCar` needs a cell the
   * pathfinder can start from; the junction guard needs to know whether that cell is an
   * intersection. Both are satisfied by a cell the route actually visits, which is why this
   * answers from `route.cells` and not from `pixelToGrid(car.pixelPos)`: a car halfway
   * across a highway is over water, and rounding its pixels yields a cell no path can leave.
   * The nearest *route* cell there is the on- or off-ramp, which is a road.
   *
   * `cellDist` is strictly increasing, so the scan stops as soon as the gap starts widening.
   */
  getCurrentCell(car: Car): GridPos | null {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return null;
    const route = this.world.routes.get(vehicle.routeId);
    if (!route || route.cells.length === 0) return null;

    let best = 0;
    let bestDelta = Math.abs(route.cellDist[0] - vehicle.arcDistance);
    for (let i = 1; i < route.cells.length; i++) {
      const delta = Math.abs(route.cellDist[i] - vehicle.arcDistance);
      if (delta > bestDelta) break;
      bestDelta = delta;
      best = i;
    }
    return route.cells[best];
  }

  /**
   * Is any vehicle currently standing on this grid cell?
   *
   * Replaces the lane-keyed occupancy map `CarSystem` rebuilt every tick and threaded
   * through `dispatch`, whose single remaining use was refusing to spawn a car on top of
   * another. Asked of the simulation's own positions rather than of `car.pixelPos`, because
   * dispatch runs *before* `writeBack` and the mirror is therefore a tick stale.
   *
   * Coarser than what it replaces in one direction: the old key was `(gx, gy, lane)`, so two
   * cars in opposing lanes of the same tile were distinct. Merging the lanes can only refuse
   * a spawn the old code would have allowed, and the cost of a refusal is that the car waits
   * one dispatch interval — the safe direction for a check whose failure mode is spawning a
   * car inside another one.
   */
  isCellOccupied(gx: number, gy: number): boolean {
    for (const vehicle of this.world.vehicles) {
      const route = this.world.routes.get(vehicle.routeId);
      if (!route) continue;
      const sample = sampleRoute(route, vehicle.arcDistance);
      const cell = pixelToGrid(sample.x, sample.y);
      if (cell.gx === gx && cell.gy === gy) return true;
    }
    return false;
  }

  /**
   * Report each grid cell this car has driven clear of since the last call.
   *
   * `PendingDeletionSystem` holds, per cell marked for deletion, the set of cars still
   * depending on it, and finalises the deletion when that set empties. A homebound car
   * shrinks its own dependency as it drives, and the only thing that ever told the system so
   * was one call in `CarMovement` on each `pathIndex` advance. Without a replacement, a cell
   * a car was standing on when the player deleted it stays pending until that car reaches
   * home — and since nothing removes a car from the set on arrival, in practice for ever.
   *
   * "Driven clear of" is the old rule exactly: cell *i* is behind the car once the car has
   * reached cell *i+1*'s centre. The last cell is therefore never reported, as it never was —
   * a journey's final cell is its destination, and a car sitting on its destination has not
   * left it.
   *
   * The cursor resets whenever a route is installed, and that is correct in both directions.
   * A fresh route puts the car at arc 0 with nothing behind it. A reroute that preserves
   * position re-walks the cells the *new* route passes before the car's arc — cells the car
   * did not drive, but does not have to drive either, so releasing them is exactly right.
   */
  consumePassedCells(car: Car, visit: (gx: number, gy: number) => void): void {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return;
    const route = this.world.routes.get(vehicle.routeId);
    if (!route) return;

    let cursor = this.passedCells.get(car.id) ?? 0;
    while (cursor + 1 < route.cells.length && route.cellDist[cursor + 1] <= vehicle.arcDistance) {
      const cell = route.cells[cursor];
      visit(cell.gx, cell.gy);
      cursor++;
    }
    this.passedCells.set(car.id, cursor);
  }

  /**
   * Does the road this car has still to drive include a cell the player has marked for
   * deletion?
   *
   * Read from the grid rather than from `RouteSegment.pendingDeletion`, which is a snapshot
   * taken when the route was built and so cannot see a cell marked since. The caller —
   * `CarRescueManager.rerouteActiveCars` — asks precisely because the marking just happened.
   *
   * Cells are compared by extent, so the cell under the car counts as ahead of it: a car
   * standing on a cell about to vanish is the case that most needs rerouting.
   */
  crossesPendingDeletionAhead(car: Car): boolean {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return false;
    const route = this.world.routes.get(vehicle.routeId);
    if (!route) return false;

    for (const cell of cellsBetween(route, vehicle.arcDistance, route.length)) {
      if (this.grid.getCell(cell.gx, cell.gy)?.pendingDeletion) return true;
    }
    return false;
  }

  /**
   * Vehicle and route counts. For tests and the debug overlay.
   *
   * The two must stay equal: routes are keyed by car id and only `removeVehicle` drops
   * them, so a route outliving its vehicle is a leak that nothing else can see — every
   * consumer reaches a route through `vehicle.routeId`, so an orphan is invisible while
   * still holding a few hundred points per despawned car for the life of the session.
   */
  debugCounts(): { vehicles: number; routes: number } {
    return { vehicles: this.world.vehicles.length, routes: this.world.routes.size };
  }

  /** Where the simulation currently holds this car, or null if it holds no route for it. */
  private simulatedPosition(car: Car): PixelPos | null {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return null;
    const route = this.world.routes.get(vehicle.routeId);
    if (!route) return null;
    const sample = sampleRoute(route, vehicle.arcDistance);
    return { x: sample.x, y: sample.y };
  }

  /** Pixels per second. Diagnostic — the renderers derive everything from `writeBack`. */
  getSpeed(car: Car): number {
    return this.vehiclesByCar.get(car.id)?.speed ?? 0;
  }

  /** Arc distance this car covered in the most recent `update`, in pixels. */
  getDistanceThisTick(car: Car): number {
    return this.vehiclesByCar.get(car.id)?.distanceThisTick ?? 0;
  }

  /**
   * How long this car has been at an unchosen standstill, in seconds.
   *
   * Resets to zero when it moves, when it parks, when it is given a route, and when the
   * watchdog fires — so it sawtooths rather than growing without bound.
   */
  getStalledSeconds(car: Car): number {
    return this.stalledFor.get(car.id) ?? 0;
  }

  /**
   * Whether removing this road cell would strand or cut off the car.
   *
   * The asymmetry is the point, and it is preserved exactly from the three loops this
   * replaces in `Game.tryRemoveRoad`: a car on its way to a business depends on the road
   * *behind* it, because that is how it gets home; a car on its way home depends on the
   * road *ahead*; a parked car depends on all of it. States the old loops did not cover —
   * `Idle`, `Stranded`, `GoingToGasStation` — still do not, so this change cannot alter
   * which cells the player may delete.
   *
   * The raw `arcDistance` is passed through with no nudging and no special case for the
   * cell the car is standing on. `routeCoversCell` matches on a cell's full extent rather
   * than its centre, so the cell underneath the car falls in both directions already. A car
   * mid-highway reports the cells at *both* ends of the crossing — its on-ramp and its
   * off-ramp — because a highway span contributes no cells of its own and so stretches its
   * two neighbours across the whole crossing. That over-includes, and over-including is the
   * safe direction for a query whose answer decides whether road may be deleted.
   */
  carDependsOnCell(car: Car, gx: number, gy: number): boolean {
    const vehicle = this.vehiclesByCar.get(car.id);
    if (!vehicle) return false;
    const route = this.world.routes.get(vehicle.routeId);
    if (!route) return false;

    if (car.state === CarState.Unloading || car.state === CarState.Refueling) {
      return routeCoversCell(route, gx, gy, 0, route.length);
    }
    if (car.state === CarState.GoingToBusiness) {
      return routeCoversCell(route, gx, gy, 0, vehicle.arcDistance);
    }
    if (car.state === CarState.GoingHome) {
      return routeCoversCell(route, gx, gy, vehicle.arcDistance, route.length);
    }
    return false;
  }

  /**
   * Group a path into contiguous grid runs and highway crossings.
   *
   * Returns null rather than an approximation whenever the path cannot be expressed. The
   * temptation is to drop whatever does not fit and carry on, and that is precisely what
   * must not happen: `buildRoute` splices a dropped span's neighbours into one curve, so a
   * silently discarded highway becomes a straight line across the water it was built to
   * cross, and a silently discarded cell moves the destination.
   *
   * **A grid run of one cell.** `buildRoute` refuses a grid span with fewer than two cells,
   * because one cell is a point and not a curve. The shape that produces one is a
   * destination sitting at a highway exit: the pathfinder emits `… grid(A), highway(A→B),
   * grid(B)`, and when B *is* the destination the trailing run is `[B]` alone. There is no
   * second grid cell to pair it with — the cell before it is on the far side of the
   * crossing — so the run is folded into the adjacent highway span, extending that span
   * back through the exit cell. The polyline is sampled between the two endpoint tile
   * centres, so it already ends on B and the extension is a no-op on geometry; writing it
   * as an extension rather than as a drop is what keeps it a no-op *on the route* too, and
   * keeps a cell that is not the highway's own endpoint from vanishing. The same fold
   * handles the mirror case, an origin sitting at a highway entrance.
   *
   * The one thing the fold costs is that B does not appear in `route.cells`, so
   * `carDependsOnCell` cannot see it. B is necessarily a highway endpoint, and the
   * pathfinder only builds highways between `Road` and `Connector` cells; a `Connector`
   * cannot be deleted as road at all, so the reachable gap is a plain road cell that is
   * simultaneously a highway endpoint and a journey's destination.
   *
   * A lone grid cell with no highway on either side cannot be folded anywhere, and a
   * one-step path is not a journey: null.
   */
  private buildSpans(path: PathStep[]): RouteSpan[] | null {
    const runs = splitIntoRuns(path);
    const spans: RouteSpan[] = [];
    /** A lone cell waiting for the highway that follows it to be built. */
    let pendingFold: GridPos | null = null;

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];

      if (run.kind === 'highway') {
        const polyline = this.highwayPolyline(run.highwayId, run.from);
        if (polyline === null) return null;
        if (pendingFold !== null) {
          extendThrough(polyline, pendingFold, 'start');
          pendingFold = null;
        }
        spans.push({
          kind: 'highway',
          polyline,
          speedLimit: this.cfg.CAR_SPEED * this.cfg.HIGHWAY_SPEED_MULTIPLIER * TILE_SIZE,
        });
        continue;
      }

      if (run.cells.length >= 2) {
        spans.push({
          kind: 'grid',
          cells: run.cells.map((pos, index) => this.describeCell(pos, index === 0)),
        });
        continue;
      }

      const lone = run.cells[0];
      const previous = spans[spans.length - 1];
      if (previous !== undefined && previous.kind === 'highway') {
        extendThrough(previous.polyline, lone, 'end');
        continue;
      }
      if (runs[i + 1]?.kind === 'highway') {
        pendingFold = lone;
        continue;
      }
      return null;
    }

    return spans;
  }

  /**
   * Describe one grid cell to the route builder.
   *
   * `spanStart` demotes a junction to plain road, and that is the whole of precondition 2.
   * A junction cell at the start of a grid span is invisible to `nextJunctionCell` and to
   * `insideJunctionCell` alike — both resolve a cell's kind through `segmentAt` at the
   * cell's centre arc, and at a span's first cell that arc is the boundary, which resolves
   * to the *preceding* span's segment (a highway's, or nothing at all when the route starts
   * there). Labelling it a junction therefore buys no regulation whatsoever; what it does
   * buy is a discrepancy waiting to be uncovered, because the moment either lookup changes
   * how it resolves the boundary the two stop agreeing, and a junction one of them can see
   * and the other cannot is a reservation with no stop line — strictly worse than the
   * unregulated crossing they get by agreeing.
   *
   * So the cell keeps its slower speed limit, because it is still physically a junction and
   * cars should still slow for it, and loses only the kind that would have lied.
   *
   * The two shapes this covers are a route that *starts* on a junction — a car rerouted
   * while it stands in one — and a junction immediately after a highway exit. Junctions at
   * the *end* of a span keep their kind: those the stepper handles, by offering a
   * straight-through maneuver when there is no exit cell.
   */
  private describeCell(pos: GridPos, spanStart: boolean): RouteCellInput {
    const cell = this.grid.getCell(pos.gx, pos.gy);
    const isIntersection = cell !== null && cell._isIntersection;
    const isConnector = cell !== null && cell.type === CellType.Connector;

    const kind = isIntersection && !spanStart ? SegmentKind.Intersection
      : isConnector ? SegmentKind.Connector
      : SegmentKind.Road;

    const base = this.cfg.CAR_SPEED * TILE_SIZE;
    const speedLimit = (isIntersection || isConnector)
      ? base * INTERSECTION_SPEED_MULTIPLIER
      : base;

    return {
      pos,
      kind,
      speedLimit,
      pendingDeletion: cell !== null && cell.pendingDeletion,
    };
  }

  /**
   * The highway's sampled curve, oriented the way this car crosses it.
   *
   * Always a copy. The stored polyline is the one `HighwayLayer` draws and the one every
   * other car's route reads, and `buildSpans` may extend the returned array.
   */
  private highwayPolyline(highwayId: string, from: GridPos): PixelPos[] | null {
    if (!this.highwaySystem) return null;
    const hw = this.highwaySystem.getById(highwayId);
    if (!hw) return null;
    const reversed = from.gx === hw.toPos.gx && from.gy === hw.toPos.gy;
    const points = hw.polyline.map(p => ({ x: p.x, y: p.y }));
    return reversed ? points.reverse() : points;
  }
}

type PathRun =
  | { kind: 'grid'; cells: GridPos[] }
  | { kind: 'highway'; highwayId: string; from: GridPos };

/** Split a path into maximal runs of grid cells separated by highway crossings. */
function splitIntoRuns(path: PathStep[]): PathRun[] {
  const runs: PathRun[] = [];
  let cells: GridPos[] = [];

  for (const entry of path) {
    if (entry.kind === 'grid') {
      cells.push(entry.pos);
      continue;
    }
    if (cells.length > 0) {
      runs.push({ kind: 'grid', cells });
      cells = [];
    }
    runs.push({ kind: 'highway', highwayId: entry.highwayId, from: entry.from });
  }
  if (cells.length > 0) runs.push({ kind: 'grid', cells });

  return runs;
}

/**
 * Extend a polyline to pass through a grid cell's centre, unless it already ends there.
 *
 * Appending a duplicate point would put a zero-length edge in the route, which
 * `sampleAtDistance` and the lane index both read as a repeated cumulative distance.
 */
function extendThrough(polyline: PixelPos[], cell: GridPos, where: 'start' | 'end'): void {
  const centre = gridToPixelCenter(cell);
  const terminal = where === 'start' ? polyline[0] : polyline[polyline.length - 1];
  const dx = centre.x - terminal.x;
  const dy = centre.y - terminal.y;
  if (Math.sqrt(dx * dx + dy * dy) <= COINCIDENT_EPS) return;
  if (where === 'start') polyline.unshift(centre);
  else polyline.push(centre);
}

/**
 * Refuse a configuration whose fastest car cannot stop inside the model's field of view.
 *
 * `LaneIndex.findLeader` scans `LEADER_SCAN_EDGES` route edges ahead and gives up, so a car
 * simply cannot see an obstacle further away than that. A grid edge is one tile, so the
 * horizon is `LEADER_SCAN_EDGES * TILE_SIZE` = 120px. A car needs `v² / (2a) + s0` to come
 * to rest behind something, and if that exceeds the horizon the car meets its leader before
 * it has been given any reason to brake — the collision clamp in `step` then binds every
 * time, which in a `CAR_DEBUG` build is a thrown error and otherwise a visible snap.
 *
 * The ceiling works out at 4.60 tiles/sec. The defaults are 2 tiles/sec worst case (a
 * highway at `CAR_SPEED * HIGHWAY_SPEED_MULTIPLIER`), needing 34px against 120 — a 3.5×
 * margin — so this can only fire for a map that raises `CAR_SPEED`, which is exactly the
 * case it is here to catch.
 *
 * It lives in the adapter and nowhere else because `CAR_SPEED` and
 * `HIGHWAY_SPEED_MULTIPLIER` are `GameConstants` keys: `src/constants.test.ts` forbids
 * reading them as module constants, and `src/traffic/purity.test.ts` forbids importing them
 * under `src/traffic/` at all. This is the one place where the resolved config and the
 * model's tuning are both in scope, which makes it the only place the comparison can be
 * made.
 *
 * It throws rather than clamping. A map that asks for an unsafe speed has a bug in it, and
 * the alternative to a loud failure at construction is quiet, permanently wrong traffic.
 */
function assertSpeedWithinLookahead(cfg: CarTuning): void {
  const fastest = cfg.CAR_SPEED * Math.max(1, cfg.HIGHWAY_SPEED_MULTIPLIER) * TILE_SIZE;
  const stoppingDistance = (fastest * fastest) / (2 * MAX_DECELERATION) + DEFAULT_IDM.s0;
  const lookahead = LEADER_SCAN_EDGES * TILE_SIZE;
  if (stoppingDistance <= lookahead) return;

  const ceiling = Math.sqrt(2 * MAX_DECELERATION * (lookahead - DEFAULT_IDM.s0)) / TILE_SIZE;
  throw new Error(
    `TrafficAdapter: CAR_SPEED ${cfg.CAR_SPEED} with HIGHWAY_SPEED_MULTIPLIER ` +
    `${cfg.HIGHWAY_SPEED_MULTIPLIER} needs ${stoppingDistance.toFixed(1)}px to stop but the ` +
    `leader search only sees ${lookahead}px ahead. The safe ceiling is ` +
    `${ceiling.toFixed(2)} tiles/sec of effective top speed.`,
  );
}

/** Nearest arc distance on a route to a pixel position. */
function projectOntoRoute(pos: PixelPos, route: Route): number {
  let bestDistSq = Infinity;
  let bestArc = 0;

  for (let i = 0; i < route.points.length - 1; i++) {
    const ax = route.points[i].x;
    const ay = route.points[i].y;
    const dx = route.points[i + 1].x - ax;
    const dy = route.points[i + 1].y - ay;
    const segLenSq = dx * dx + dy * dy;

    let t = 0;
    if (segLenSq > 0) {
      t = ((pos.x - ax) * dx + (pos.y - ay) * dy) / segLenSq;
      t = Math.max(0, Math.min(1, t));
    }

    const px = ax + t * dx;
    const py = ay + t * dy;
    const distSq = (pos.x - px) * (pos.x - px) + (pos.y - py) * (pos.y - py);

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestArc = route.cumDist[i] + t * Math.sqrt(segLenSq);
    }
  }

  return bestArc;
}
