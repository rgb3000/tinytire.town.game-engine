import { type Grid } from '../core/Grid';

import { House } from '../entities/House';
import { Business } from '../entities/Business';
import { CellType, type GameColor, type GridPos, type BusinessRotation } from '../types';
// Only the two that are *not* `GameConstants` keys: everything a map can override
// arrives through the constructor's `cfg` instead. See the constructor note below.
import { COLOR_UNLOCK_ORDER, SPAWN_AREA_INTERVALS } from '../constants';
import { octileDist, clamp, lerp } from '../utils/math';
import type { GameConstants } from '../maps/types';

const ALL_ROTATIONS: BusinessRotation[] = [0, 90, 180, 270];

/**
 * The only thing spawning needs from demand: how fast a colour is currently consuming.
 *
 * Declared here rather than depending on the whole `DemandSystem` so that the map
 * designer — which spawns buildings but has no demand simulation — can supply a
 * standing-still stub without an `as any` cast. `DemandSystem` satisfies this
 * structurally, so `Game` passes the real one unchanged.
 */
export interface SpawnDemandSource {
  getColorPinOutputRate(color: GameColor): number;
}

interface Empty2x2 {
  pos: GridPos;
  rotation: BusinessRotation;
}

export class SpawnSystem {
  private houses: House[] = [];
  private businesses: Business[] = [];
  private unlockedColors: GameColor[] = [COLOR_UNLOCK_ORDER[0]];
  private nextColorIndex = 1;
  private elapsedTime = 0;
  private nextColorUnlockTime: number;
  private spawnTimer = 0;
  private currentSpawnInterval: number;
  private grid: Grid;
  private demandSystem: SpawnDemandSource;
  private dirty = false;
  onSpawn: (() => void) | null = null;
  onHouseSpawn: ((house: House) => void) | null = null;
  disableAutoSpawn = false;
  private colorUnlockInterval: number;
  private houseClusterRadius: number;
  private minSpawnInterval: number;
  private spawnIntervalDecay: number;
  private houseSupplyPerMinute: number;
  private houseSupplyPerMinuteMin: number;
  private houseSupplyNearDistance: number;
  private houseSupplyFarDistance: number;
  private minBusinessDistance: number;
  private houseRandomPlacementChance: number;

  /**
   * Bumped whenever a house or business is added or removed — see {@link getColorSupplyRate},
   * which memoises against it. Distinct from `dirty`, which the renderer clears on its own
   * schedule and so cannot be used as a cache key.
   */
  private mutationEpoch = 0;
  private supplyCacheEpoch = -1;
  private supplyCache = new Map<GameColor, number>();

  get isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  /**
   * Takes a *fully resolved* `GameConstants`, not a `Partial`.
   *
   * `buildConfig()` is the only place defaults are applied — it merges a map's overrides
   * over `DEFAULT_GAME_CONSTANTS` and returns a complete object, and every caller passes
   * one. The previous signature took a `Partial` and re-defaulted each field as
   * `config?.X ?? MODULE_X`, so there were two default sources and no way to tell which
   * won; every one of those fallback branches was in fact unreachable.
   *
   * Requiring the parameter is what keeps it that way: a future caller that forgets it no
   * longer silently gets module defaults while a map's override is discarded — it fails to
   * compile.
   */
  constructor(grid: Grid, demandSystem: SpawnDemandSource, cfg: GameConstants) {
    this.grid = grid;
    this.demandSystem = demandSystem;
    this.nextColorUnlockTime = cfg.INITIAL_SPAWN_DELAY;
    this.currentSpawnInterval = cfg.SPAWN_INTERVAL;
    this.colorUnlockInterval = cfg.COLOR_UNLOCK_INTERVAL;
    this.houseClusterRadius = cfg.HOUSE_CLUSTER_RADIUS;
    this.minSpawnInterval = cfg.MIN_SPAWN_INTERVAL;
    this.spawnIntervalDecay = cfg.SPAWN_INTERVAL_DECAY;
    this.houseSupplyPerMinute = cfg.HOUSE_SUPPLY_PER_MINUTE;
    this.houseSupplyPerMinuteMin = cfg.HOUSE_SUPPLY_PER_MINUTE_MIN;
    this.houseSupplyNearDistance = cfg.HOUSE_SUPPLY_NEAR_DISTANCE;
    this.houseSupplyFarDistance = cfg.HOUSE_SUPPLY_FAR_DISTANCE;
    this.minBusinessDistance = cfg.MIN_BUSINESS_DISTANCE;
    this.houseRandomPlacementChance = cfg.HOUSE_RANDOM_PLACEMENT_CHANCE;
  }

  getHouses(): House[] {
    return this.houses;
  }

  getBusinesses(): Business[] {
    return this.businesses;
  }

  removeHouse(id: string): void {
    this.houses = this.houses.filter(h => h.id !== id);
    this.dirty = true;
    this.mutationEpoch++;
  }

  removeBusiness(id: string): void {
    this.businesses = this.businesses.filter(b => b.id !== id);
    this.dirty = true;
    this.mutationEpoch++;
  }

  getUnlockedColors(): GameColor[] {
    return this.unlockedColors;
  }

  unlockAllColors(): void {
    for (let i = this.nextColorIndex; i < COLOR_UNLOCK_ORDER.length; i++) {
      this.unlockedColors.push(COLOR_UNLOCK_ORDER[i]);
    }
    this.nextColorIndex = COLOR_UNLOCK_ORDER.length;
  }

  spawnInitial(): void {
    const hx = Math.floor(this.grid.cols * 0.45) + Math.floor(Math.random() * 5 - 2);
    const hy = Math.floor(this.grid.rows * 0.45) + Math.floor(Math.random() * 3 - 1);
    this.spawnHouse({ gx: hx, gy: hy }, COLOR_UNLOCK_ORDER[0]);

    // For initial business, find a 2x2 spot near desired location
    const bx = Math.floor(this.grid.cols * 0.55) + Math.floor(Math.random() * 5 - 2);
    const by = Math.floor(this.grid.rows * 0.55) + Math.floor(Math.random() * 3 - 1);
    const spot = this.findEmpty2x2Near({ gx: bx, gy: by }, 5, COLOR_UNLOCK_ORDER[0]);
    if (spot) {
      this.spawnBusiness(spot.pos, COLOR_UNLOCK_ORDER[0], spot.rotation);
    }
  }

  update(dt: number): void {
    this.elapsedTime += dt;
    if (this.disableAutoSpawn) return;

    if (this.nextColorIndex < COLOR_UNLOCK_ORDER.length && this.elapsedTime >= this.nextColorUnlockTime) {
      const newColor = COLOR_UNLOCK_ORDER[this.nextColorIndex];
      this.unlockedColors.push(newColor);
      this.nextColorIndex++;
      this.nextColorUnlockTime += this.colorUnlockInterval;
      this.spawnPairForColor(newColor);
    }

    this.spawnTimer += dt;
    if (this.spawnTimer >= this.currentSpawnInterval) {
      this.spawnTimer = 0;
      this.currentSpawnInterval = Math.max(this.minSpawnInterval, this.currentSpawnInterval * this.spawnIntervalDecay);
      this.spawnRandom();
    }
  }

  /**
   * How many demand pins per minute a colour's houses can currently clear.
   *
   * A house far from the businesses it serves spends most of its time driving rather than
   * delivering, so each house's contribution is scaled by its average octile distance to
   * same-colour businesses: at or below `HOUSE_SUPPLY_NEAR_DISTANCE` it contributes the max
   * rate, at or beyond `HOUSE_SUPPLY_FAR_DISTANCE` the min, linearly interpolated between.
   * See the note above `HOUSE_SUPPLY_PER_MINUTE` in `src/constants.ts`.
   *
   * Public because this is also what the HUD reports. It used to be inlined in
   * `spawnRandom` while the HUD computed a flat `houses × HOUSE_SUPPLY_PER_MINUTE` of its
   * own, so the number players saw was not the number the spawner acted on, and the
   * MIN/NEAR/FAR overrides — all map-configurable — changed nothing on screen.
   *
   * Memoised per colour, because `Game.render()` now calls this on every rendered frame and
   * it is O(houses × businesses). The memo is exact rather than approximate: `House.pos` and
   * `Business.connectorPos` are `readonly`, so the result can only change when an entity is
   * added or removed. **Anything that starts moving entities must bump `mutationEpoch`.**
   */
  getColorSupplyRate(color: GameColor): number {
    if (this.supplyCacheEpoch !== this.mutationEpoch) {
      this.supplyCache.clear();
      this.supplyCacheEpoch = this.mutationEpoch;
    }
    const cached = this.supplyCache.get(color);
    if (cached !== undefined) return cached;

    const sameColorHouses = this.houses.filter(h => h.color === color);
    const sameColorBiz = this.businesses.filter(b => b.color === color);

    let rate: number;
    if (sameColorBiz.length === 0) {
      // No businesses yet — nothing to be far from, so use the max rate as fallback.
      rate = sameColorHouses.length * this.houseSupplyPerMinute;
    } else {
      // Note this averages *distances* and then converts once, rather than averaging
      // per-business rates. The two differ as soon as the clamp bites.
      rate = sameColorHouses.reduce((sum, house) => {
        const avgDist = sameColorBiz.reduce((s, b) => s + octileDist(house.pos, b.connectorPos), 0) / sameColorBiz.length;
        const t = clamp((avgDist - this.houseSupplyNearDistance) / (this.houseSupplyFarDistance - this.houseSupplyNearDistance), 0, 1);
        return sum + lerp(this.houseSupplyPerMinute, this.houseSupplyPerMinuteMin, t);
      }, 0);
    }

    this.supplyCache.set(color, rate);
    return rate;
  }

  private spawnRandom(): void {
    // Compute per-color balance: supplyRate - demandRate
    const balances = this.unlockedColors.map(color => {
      const demandRate = this.demandSystem.getColorPinOutputRate(color);
      return { color, balance: this.getColorSupplyRate(color) - demandRate };
    });

    // Find most under-supplied color (most negative balance = needs houses)
    // Find most over-supplied color (most positive balance = can absorb more demand)
    const sorted = [...balances].sort((a, b) => a.balance - b.balance);
    const mostDeficit = sorted[0];
    const mostSurplus = sorted[sorted.length - 1];

    // Decide house vs business: if any color has deficit, spawn house; otherwise spawn business
    if (mostDeficit.balance < 0) {
      this.trySpawnHouseForColor(mostDeficit.color);
    } else {
      // All colors have surplus or are balanced → spawn a business for the color with most surplus
      this.trySpawnBusinessForColor(mostSurplus.color);
    }
  }

  private spawnPairForColor(color: GameColor): void {
    this.trySpawnHouseForColor(color);
    this.trySpawnBusinessForColor(color);
  }

  private trySpawnHouseForColor(color: GameColor): void {
    const sameColorHouses = this.houses.filter(h => h.color === color);

    let pos: GridPos | null = null;

    const skipClustering = Math.random() < this.houseRandomPlacementChance;
    if (!skipClustering && sameColorHouses.length > 0) {
      const anchor = sameColorHouses[Math.floor(Math.random() * sameColorHouses.length)];
      pos = this.findEmptyNear(anchor.pos, this.houseClusterRadius);
    }

    if (!pos) {
      pos = this.findRandomEmpty();
    }

    if (pos) {
      this.spawnHouse(pos, color);
    }
  }

  private trySpawnBusinessForColor(color: GameColor): void {
    const spot = this.findRandomEmpty2x2(color);
    if (spot) {
      this.spawnBusiness(spot.pos, color, spot.rotation);
    }
  }

  spawnHouse(pos: GridPos, color: GameColor): void {
    this.dirty = true;
    this.mutationEpoch++;

    const house = new House(pos, color);
    this.houses.push(house);
    this.onHouseSpawn?.(house);
    this.onSpawn?.();

    // House cell — roads connect directly to this cell
    this.grid.setCell(pos.gx, pos.gy, {
      type: CellType.House,
      entityId: house.id,
      color,
      connectorDir: null,
    });
  }

  spawnBusiness(pos: GridPos, color: GameColor, rotation: BusinessRotation): void {
    this.dirty = true;
    this.mutationEpoch++;
    const business = new Business(pos, color, rotation);
    this.businesses.push(business);
    this.onSpawn?.();

    // Building cell
    this.grid.setCell(business.buildingPos.gx, business.buildingPos.gy, {
      type: CellType.Business,
      entityId: business.id,
      color,
      connectorDir: null,
    });

    // Pins cell (also CellType.Business to block road placement)
    this.grid.setCell(business.pinsPos.gx, business.pinsPos.gy, {
      type: CellType.Business,
      entityId: business.id,
      color,
      connectorDir: null,
    });

    // Ground plate cell (blocks spawning and road placement)
    this.grid.setCell(business.groundPlatePos.gx, business.groundPlatePos.gy, {
      type: CellType.Business,
      entityId: business.id,
      color,
      connectorDir: null,
    });

    // Connector cell owned by the business — roads connect here
    this.grid.setCell(business.connectorPos.gx, business.connectorPos.gy, {
      type: CellType.Connector,
      entityId: business.id,
      color: null,
      roadConnections: 0,
      connectorDir: null,
    });
  }

  getSpawnBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const totalEntities = this.houses.length + this.businesses.length;
    let inset = SPAWN_AREA_INTERVALS[0].inset;
    for (const interval of SPAWN_AREA_INTERVALS) {
      if (totalEntities >= interval.threshold) {
        inset = interval.inset;
      }
    }
    return {
      minX: Math.floor(this.grid.cols * inset),
      maxX: Math.floor(this.grid.cols * (1 - inset)) - 1,
      minY: Math.floor(this.grid.rows * inset),
      maxY: Math.floor(this.grid.rows * (1 - inset)) - 1,
    };
  }

  private isInBounds(gx: number, gy: number): boolean {
    const b = this.getSpawnBounds();
    return gx >= b.minX && gx <= b.maxX && gy >= b.minY && gy <= b.maxY;
  }

  private findEmpty2x2Near(center: GridPos, radius: number, color?: GameColor): Empty2x2 | null {
    const candidates: Empty2x2[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const gx = center.gx + dx;
        const gy = center.gy + dy;
        if (!this.isInBounds(gx, gy)) continue;
        this.try2x2Candidates(gx, gy, candidates);
      }
    }
    let filtered = candidates;
    if (color !== undefined) {
      filtered = candidates.filter(spot => this.isFarFromSameColorHouses(spot.pos, color, this.minBusinessDistance));
    }
    if (filtered.length === 0) return null;
    return filtered[Math.floor(Math.random() * filtered.length)];
  }

  private findRandomEmpty2x2(color?: GameColor): Empty2x2 | null {
    let candidates = this.getAllEmpty2x2().filter(spot => this.isInBounds(spot.pos.gx, spot.pos.gy));
    if (color !== undefined) {
      candidates = candidates.filter(spot => this.isFarFromSameColorHouses(spot.pos, color, this.minBusinessDistance));
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private getAllEmpty2x2(): Empty2x2[] {
    const results: Empty2x2[] = [];
    for (let gy = 0; gy < this.grid.rows - 1; gy++) {
      for (let gx = 0; gx < this.grid.cols - 1; gx++) {
        this.try2x2Candidates(gx, gy, results);
      }
    }
    return results;
  }

  private try2x2Candidates(gx: number, gy: number, results: Empty2x2[]): void {
    // Check all 4 cells of the 2x2 block are empty
    if (
      this.isCellEmpty(gx, gy) &&
      this.isCellEmpty(gx + 1, gy) &&
      this.isCellEmpty(gx, gy + 1) &&
      this.isCellEmpty(gx + 1, gy + 1)
    ) {
      // All 4 rotations are valid for any empty 2x2 block; pick one randomly
      const rotation = ALL_ROTATIONS[Math.floor(Math.random() * ALL_ROTATIONS.length)];
      results.push({ pos: { gx, gy }, rotation });
    }
  }

  private isCellEmpty(gx: number, gy: number): boolean {
    const cell = this.grid.getCell(gx, gy);
    return cell !== null && cell.type === CellType.Empty;
  }

  private isFarFromSameColorHouses(pos: GridPos, color: GameColor, minDist: number): boolean {
    for (const house of this.houses) {
      if (house.color !== color) continue;
      const dx = Math.abs(pos.gx - house.pos.gx);
      const dy = Math.abs(pos.gy - house.pos.gy);
      if (Math.max(dx, dy) < minDist) return false;
    }
    return true;
  }

  private findEmptyNear(center: GridPos, radius: number): GridPos | null {
    const candidates: GridPos[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx === 0 && dy === 0) continue;
        const gx = center.gx + dx;
        const gy = center.gy + dy;
        if (!this.isInBounds(gx, gy)) continue;
        if (this.isCellEmpty(gx, gy)) {
          candidates.push({ gx, gy });
        }
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private findRandomEmpty(): GridPos | null {
    const empty = this.grid.getEmptyCells()
      .filter(p => this.isInBounds(p.gx, p.gy));
    if (empty.length === 0) return null;
    return empty[Math.floor(Math.random() * empty.length)];
  }

}
