import type { PathStep } from '../highways/types';
import type { HighwaySystem } from '../systems/HighwaySystem';
import { TILE_SIZE } from '../constants';

/** Compute the fuel cost (in tile-units) of a path */
export function computePathFuelCost(steps: PathStep[], highwaySystem?: HighwaySystem | null): number {
  let cost = 0;
  for (let i = 1; i < steps.length; i++) {
    const prev = steps[i - 1];
    const cur = steps[i];

    if (prev.kind === 'grid' && cur.kind === 'grid') {
      const dx = Math.abs(cur.pos.gx - prev.pos.gx);
      const dy = Math.abs(cur.pos.gy - prev.pos.gy);
      cost += (dx !== 0 && dy !== 0) ? Math.SQRT2 : 1;
    } else if (cur.kind === 'highway' && highwaySystem) {
      const hw = highwaySystem.getById(cur.highwayId);
      if (hw) {
        cost += hw.arcLength / TILE_SIZE;
      }
    }
  }
  return cost;
}
