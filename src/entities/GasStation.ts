import type { GridPos } from '../types';
import { generateId } from '../utils/math';

export class GasStation {
  readonly id: string;
  /** The single tile where the gas station sits. */
  readonly pos: GridPos;

  constructor(pos: GridPos) {
    this.id = generateId();
    this.pos = pos;
  }

  /** Returns the single cell position. */
  getCells(): GridPos[] {
    return [this.pos];
  }
}
