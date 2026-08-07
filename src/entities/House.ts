import type { GameColor, GridPos } from '../types';
import { generateId } from '../utils/math';

export class House {
  readonly id: string;
  readonly pos: GridPos;
  readonly color: GameColor;
  carIds: string[] = [];
  deliveryCount = 0;

  constructor(pos: GridPos, color: GameColor) {
    this.id = generateId();
    this.pos = pos;
    this.color = color;
  }
}
