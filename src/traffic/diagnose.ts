import { CAR_LENGTH } from '../constants';
import type { GridPos } from '../types';
import type { JunctionCandidate } from './junction';
import { candidatesConflict } from './junction';
import { LaneIndex } from './lanes';
import { ConstraintKind, junctionKey, nearestConstraint } from './obstacles';
import { sampleRoute } from './route';
import { exitBlockers, junctionDecisions } from './step';
import { STOPPED_SPEED } from './tuning';
import { VehicleMode } from './types';
import type { TrafficWorld } from './types';

/**
 * Why a vehicle is not moving, in the stepper's own terms.
 *
 * The string-literal kinds are deliberate where the rest of the engine uses `as const`
 * objects: a diagnosis exists to be read by a human in a browser console or a test
 * failure, and `"no-exit-room"` needs no decoder ring where `3` does.
 */
export type WaitReason =
  | { kind: 'moving' }
  | { kind: 'parked' }
  | { kind: 'no-route' }
  /** At (or braking for) the end of its route — arriving, not blocked. */
  | { kind: 'route-end'; distanceToEnd: number }
  | { kind: 'leader'; leaderId: string; gap: number }
  | {
    kind: 'junction';
    junction: GridPos;
    /**
     * `no-exit-room`: skipped before the admission order ran — a stopped vehicle occupies
     * the directed exit lane. `conflict`: ranked, but a conflicting maneuver was admitted
     * first. `no-candidate`: bound by a stop line for a junction it was never offered to,
     * which no reachable state should produce — its appearance in a dump is itself the bug.
     */
    why: 'no-exit-room' | 'conflict' | 'no-candidate';
    /** Vehicle ids responsible: exit-lane occupants, or the conflicting admitted vehicles. */
    blockedBy: string[];
    /** Everyone admitted to this junction this tick. */
    holders: string[];
    /** World time this vehicle began waiting here; 0 if it has not come to rest. */
    waitingSince: number;
  };

export interface VehicleDiagnosis {
  vehicleId: string;
  routeId: string;
  arc: number;
  speed: number;
  reason: WaitReason;
}

export interface WorldDiagnosis {
  time: number;
  vehicles: VehicleDiagnosis[];
  /**
   * Cycles in the waits-for graph, each a list of vehicle ids in order. A non-empty entry
   * is a deadlock by construction: every member is stopped and waiting on the next.
   */
  cycles: string[][];
  /**
   * Vehicle pairs whose *world positions* are closer than a car length — bodies visually
   * overlapping or touching. Measured on sampled route geometry, not on arc arithmetic, so
   * it sees what the player sees: cross-route queues, corner chord-shortening, cars the
   * lane model cannot pair. Queue spacing itself is arc-exact (measured 16.00px on
   * straight, diagonal and cross-route fixtures alike), so anything listed here is worth
   * reading, not noise.
   */
  overlaps: Array<{ a: string; b: string; distance: number }>;
}

/**
 * Explain every vehicle's standstill from a world state, without advancing it.
 *
 * Replays exactly the decision pass of `step`: the same lane index, the same
 * `junctionDecisions`, the same `nearestConstraint` — so the reason reported is the reason
 * the stepper acted on, not a parallel account that can drift. The *classification* of a
 * junction wait comes off the real candidate (`exitHasRoom`, the admitted set); only the
 * blame lists are reconstructed, and from the same primitives the stepper uses.
 *
 * Pure and read-only, so it can run against a live world between ticks, or against a
 * deserialized snapshot in a test.
 */
export function diagnoseWorld(world: TrafficWorld): WorldDiagnosis {
  const laneIndex = new LaneIndex();
  laneIndex.rebuild(world);
  const decisions = junctionDecisions(world);

  const vehicles: VehicleDiagnosis[] = world.vehicles.map((v) => {
    const base = { vehicleId: v.id, routeId: v.routeId, arc: v.arcDistance, speed: v.speed };
    const route = world.routes.get(v.routeId);

    if (v.mode === VehicleMode.Parked) return { ...base, reason: { kind: 'parked' } };
    if (!route) return { ...base, reason: { kind: 'no-route' } };
    if (v.speed > STOPPED_SPEED) return { ...base, reason: { kind: 'moving' } };

    const constraint = nearestConstraint(world, v, laneIndex, decisions.admitted, decisions.components);

    if (constraint.kind === ConstraintKind.Leader && constraint.leaderId !== undefined) {
      return {
        ...base,
        reason: {
          kind: 'leader',
          leaderId: constraint.leaderId,
          gap: constraint.arc - v.arcDistance,
        },
      };
    }

    if (constraint.kind === ConstraintKind.StopLine && constraint.cellIndex !== undefined) {
      const cell = route.cells[constraint.cellIndex];
      const cellKey = junctionKey(cell.gx, cell.gy);
      // Admission is per region of adjacent junction cells, so blame is looked up there.
      const regionKey = decisions.components.get(cellKey) ?? cellKey;
      const candidates = decisions.byJunction.get(regionKey) ?? [];
      const holders = [...(decisions.admitted.get(regionKey) ?? [])];
      const mine = candidates.find((c) => c.vehicleId === v.id);

      let why: 'no-exit-room' | 'conflict' | 'no-candidate';
      let blockedBy: string[];
      if (mine === undefined) {
        why = 'no-candidate';
        blockedBy = [];
      } else if (!mine.exitHasRoom) {
        why = 'no-exit-room';
        // The room that was refused is at the *far* end of the vehicle's stretch through
        // the region — the last maneuver's cell. `exitBlockers` is the stepper's own scan.
        const last = mine.maneuvers[mine.maneuvers.length - 1].cell;
        const lastIndex = route.cells.findIndex(
          (c, i) => i >= constraint.cellIndex! && junctionKey(c.gx, c.gy) === last,
        );
        blockedBy = lastIndex < 0 ? [] : exitBlockers(world, v.id, route, lastIndex);
      } else {
        why = 'conflict';
        blockedBy = holders.filter((id) => {
          const theirs: JunctionCandidate | undefined = candidates.find((c) => c.vehicleId === id);
          return theirs !== undefined && candidatesConflict(mine, theirs);
        });
      }

      return {
        ...base,
        reason: {
          kind: 'junction',
          junction: { gx: cell.gx, gy: cell.gy },
          why, blockedBy, holders,
          waitingSince: v.arrivalTime,
        },
      };
    }

    return { ...base, reason: { kind: 'route-end', distanceToEnd: route.length - v.arcDistance } };
  });

  return {
    time: world.time,
    vehicles,
    cycles: findWaitCycles(waitEdges(vehicles)),
    overlaps: findOverlaps(world),
  };
}

/** Every pair of vehicles closer than a car length in world space. O(n²), diagnosis-only. */
function findOverlaps(world: TrafficWorld): Array<{ a: string; b: string; distance: number }> {
  const positions: Array<{ id: string; x: number; y: number }> = [];
  for (const v of world.vehicles) {
    const route = world.routes.get(v.routeId);
    if (!route) continue;
    const p = sampleRoute(route, v.arcDistance);
    positions.push({ id: v.id, x: p.x, y: p.y });
  }
  const out: Array<{ a: string; b: string; distance: number }> = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const d = Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y);
      if (d < CAR_LENGTH) out.push({ a: positions[i].id, b: positions[j].id, distance: d });
    }
  }
  return out;
}

/** The waits-for graph: stopped vehicle -> the vehicles its diagnosis blames. */
function waitEdges(vehicles: VehicleDiagnosis[]): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const d of vehicles) {
    if (d.reason.kind === 'leader') edges.set(d.vehicleId, [d.reason.leaderId]);
    else if (d.reason.kind === 'junction') edges.set(d.vehicleId, d.reason.blockedBy);
  }
  return edges;
}

/**
 * Every distinct cycle reachable in a waits-for graph.
 *
 * Depth-first with an explicit stack; a back-edge into the current path is a cycle. Each
 * cycle is reported once, canonicalised to start at its smallest vehicle id. The graphs
 * this sees hold at most a few hundred nodes with out-degree rarely above two, so clarity
 * beats asymptotics.
 */
export function findWaitCycles(edges: Map<string, string[]>): string[][] {
  const seen = new Set<string>();
  const cycles: string[][] = [];
  const found = new Set<string>();

  const visit = (id: string, path: string[], onPath: Set<string>): void => {
    if (onPath.has(id)) {
      const cycle = path.slice(path.indexOf(id));
      const min = cycle.reduce((a, b) => (a < b ? a : b));
      const at = cycle.indexOf(min);
      const canonical = [...cycle.slice(at), ...cycle.slice(0, at)];
      const sig = canonical.join('->');
      if (!found.has(sig)) {
        found.add(sig);
        cycles.push(canonical);
      }
      return;
    }
    if (seen.has(id)) return;
    path.push(id);
    onPath.add(id);
    for (const next of edges.get(id) ?? []) visit(next, path, onPath);
    path.pop();
    onPath.delete(id);
    seen.add(id);
  };

  for (const id of edges.keys()) visit(id, [], new Set());
  return cycles;
}

/** One line per stopped vehicle plus any cycles — what the demo prints when a board freezes. */
export function formatDiagnosis(diagnosis: WorldDiagnosis): string {
  const lines: string[] = [];
  const stopped = diagnosis.vehicles.filter((d) => d.reason.kind !== 'moving');
  lines.push(
    `traffic @ t=${diagnosis.time.toFixed(2)}s — ` +
    `${diagnosis.vehicles.length} vehicles, ${stopped.length} not moving`,
  );
  for (const d of stopped) {
    const r = d.reason;
    let text: string;
    switch (r.kind) {
      case 'parked': text = 'parked'; break;
      case 'no-route': text = 'no route'; break;
      case 'route-end': text = `arriving, ${r.distanceToEnd.toFixed(1)}px to route end`; break;
      case 'leader': text = `behind ${r.leaderId} (gap ${r.gap.toFixed(1)}px)`; break;
      case 'junction':
        text = `junction (${r.junction.gx},${r.junction.gy}) ${r.why}` +
          (r.blockedBy.length > 0 ? ` by [${r.blockedBy.join(', ')}]` : '') +
          (r.holders.length > 0 ? `; admitted: [${r.holders.join(', ')}]` : '') +
          (r.waitingSince > 0 ? `; waiting since t=${r.waitingSince.toFixed(2)}s` : '');
        break;
      // 'moving' is filtered out above; listed so the union stays exhaustive for the compiler.
      case 'moving': text = 'moving'; break;
    }
    lines.push(`  ${d.vehicleId} arc=${d.arc.toFixed(1)} v=${d.speed.toFixed(1)} — ${text}`);
  }
  for (const cycle of diagnosis.cycles) {
    lines.push(`  DEADLOCK CYCLE: ${cycle.join(' -> ')} -> ${cycle[0]}`);
  }
  for (const o of diagnosis.overlaps) {
    lines.push(`  OVERLAP: ${o.a} and ${o.b} are ${o.distance.toFixed(1)}px apart (car length ${CAR_LENGTH})`);
  }
  return lines.join('\n');
}
