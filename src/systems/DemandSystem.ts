import type { Business } from '../entities/Business';
import type { GameColor } from '../types';
import type { GameConstants } from '../maps/types';

export class DemandSystem {
  private _gameOver = false;
  private colorDemands: Map<GameColor, number> = new Map();
  private colorPinOutputRates: Map<GameColor, number> = new Map();
  private demandBaseRate: number;
  private demandRateGrowth: number;
  private demandPinCooldown: number;
  private maxDemandPins: number;

  /** Takes a resolved `GameConstants` — see the note on {@link SpawnSystem}'s constructor. */
  constructor(cfg: GameConstants) {
    this.demandBaseRate = cfg.DEMAND_BASE_RATE;
    this.demandRateGrowth = cfg.DEMAND_RATE_GROWTH;
    this.demandPinCooldown = cfg.DEMAND_PIN_COOLDOWN;
    this.maxDemandPins = cfg.MAX_DEMAND_PINS;
  }

  get isGameOver(): boolean {
    return this._gameOver;
  }

  /** Returns total demand pins for a given color */
  getColorDemand(color: GameColor): number {
    return this.colorDemands.get(color) ?? 0;
  }

  /** Returns the full per-color demand map */
  getColorDemands(): Map<GameColor, number> {
    return this.colorDemands;
  }

  /** Returns total pin output rate (pins/min) for a given color */
  getColorPinOutputRate(color: GameColor): number {
    return this.colorPinOutputRates.get(color) ?? 0;
  }

  /** Returns the full per-color pin output rate map */
  getColorPinOutputRates(): Map<GameColor, number> {
    return this.colorPinOutputRates;
  }

  update(dt: number, businesses: Business[]): void {
    if (this._gameOver) return;

    // Reset per-color totals
    this.colorDemands.clear();
    this.colorPinOutputRates.clear();

    for (const biz of businesses) {
      // Age the business
      biz.age += dt;

      // Tick cooldown
      biz.pinCooldown = Math.max(0, biz.pinCooldown - dt);

      // Compute pin output rate (pins/min)
      biz.pinOutputRate = this.demandBaseRate + this.demandRateGrowth * (biz.age / 60);

      // Accumulate fractional pins
      biz.pinAccumulator += (biz.pinOutputRate / 60) * dt;

      // Add pin when accumulator reaches 1.0, respecting cooldown and max
      if (biz.pinAccumulator >= 1.0 && biz.pinCooldown <= 0 && biz.demandPins < this.maxDemandPins) {
        biz.demandPins++;
        biz.pinAccumulator -= 1.0;
        biz.pinCooldown = this.demandPinCooldown;
      }

      // Prevent backlog when at max pins
      if (biz.demandPins >= this.maxDemandPins) {
        biz.pinAccumulator = 0;
      }

      // Accumulate per-color demand
      const prevDemand = this.colorDemands.get(biz.color) ?? 0;
      this.colorDemands.set(biz.color, prevDemand + biz.demandPins);

      // Accumulate per-color pin output rate
      const prevRate = this.colorPinOutputRates.get(biz.color) ?? 0;
      this.colorPinOutputRates.set(biz.color, prevRate + biz.pinOutputRate);

      // Game over check
      if (biz.demandPins >= this.maxDemandPins) {
        this._gameOver = true;
        return;
      }
    }
  }

  reset(): void {
    this._gameOver = false;
    this.colorDemands.clear();
    this.colorPinOutputRates.clear();
  }
}
