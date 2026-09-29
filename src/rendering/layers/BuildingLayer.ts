import * as THREE from 'three';
import type { House } from '../../entities/House';
import type { Business } from '../../entities/Business';
import type { GasStation } from '../../entities/GasStation';
import type { Car } from '../../entities/Car';
import { HouseLayer } from './buildings/HouseLayer';
import { BusinessLayer } from './buildings/BusinessLayer';
import { GasStationLayer } from './buildings/GasStationLayer';

export class BuildingLayer {
  private houseLayer = new HouseLayer();
  private businessLayer = new BusinessLayer();
  private gasStationLayer = new GasStationLayer();

  setPlateColor(color: string): void {
    this.houseLayer.setPlateColor(color);
    this.businessLayer.setPlateColor(color);
    this.gasStationLayer.setPlateColor(color);
  }

  setGameColors(colors: Record<number, string>): void {
    this.houseLayer.setGameColors(colors);
    this.businessLayer.setGameColors(colors);
  }

  /**
   * Returns whether any building's shadow-casting geometry changed, which is what tells the
   * renderer its baked shadow map is stale. Every sub-layer runs regardless; `||` would
   * short-circuit the later ones.
   */
  update(scene: THREE.Scene, houses: House[], businesses: Business[], gasStations: GasStation[] = [], cars: Car[] = []): boolean {
    const houseShadows = this.houseLayer.update(scene, houses, cars);
    const businessShadows = this.businessLayer.update(scene, businesses);
    const stationShadows = this.gasStationLayer.update(scene, gasStations);
    return houseShadows || businessShadows || stationShadows;
  }

  dispose(scene: THREE.Scene): void {
    this.houseLayer.dispose(scene);
    this.businessLayer.dispose(scene);
    this.gasStationLayer.dispose(scene);
  }
}
