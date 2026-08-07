import type { GridPos } from '../types';
import { TILE_SIZE } from '../constants';

export interface InputState {
  leftDown: boolean;
  rightDown: boolean;
  shiftDown: boolean;
  gridPos: GridPos;
  canvasX: number;
  canvasY: number;
}

export class InputHandler {
  readonly state: InputState = {
    leftDown: false,
    rightDown: false,
    shiftDown: false,
    gridPos: { gx: -1, gy: -1 },
    canvasX: 0,
    canvasY: 0,
  };

  panningActive = false;

  private canvas: HTMLCanvasElement;
  private screenToWorld: (sx: number, sy: number) => { x: number; z: number };

  constructor(
    canvas: HTMLCanvasElement,
    screenToWorld: (sx: number, sy: number) => { x: number; z: number },
  ) {
    this.canvas = canvas;
    this.screenToWorld = screenToWorld;
    this.bindEvents();
  }

  private bindEvents(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private updatePosition(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const world = this.screenToWorld(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    this.state.canvasX = world.x;
    this.state.canvasY = world.z;
    this.state.gridPos = {
      gx: Math.floor(world.x / TILE_SIZE),
      gy: Math.floor(world.z / TILE_SIZE),
    };
  }

  private onMouseDown(e: MouseEvent): void {
    this.updatePosition(e);
    this.state.shiftDown = e.shiftKey;
    if (e.button === 0 && !this.panningActive) this.state.leftDown = true;
    if (e.button === 2) this.state.rightDown = true;
  }

  private onMouseUp(e: MouseEvent): void {
    this.updatePosition(e);
    this.state.shiftDown = e.shiftKey;
    if (e.button === 0) this.state.leftDown = false;
    if (e.button === 2) this.state.rightDown = false;
  }

  private onMouseMove(e: MouseEvent): void {
    this.updatePosition(e);
    this.state.shiftDown = e.shiftKey;
  }

  private onMouseLeave(): void {
    this.state.leftDown = false;
    this.state.rightDown = false;
    this.state.shiftDown = false;
  }
}
