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

  update(scene: THREE.Scene, houses: House[], businesses: Business[], gasStations: GasStation[] = [], cars: Car[] = []): void {
    this.houseLayer.update(scene, houses, cars);
    this.businessLayer.update(scene, businesses);
    this.gasStationLayer.update(scene, gasStations);
  }

  dispose(scene: THREE.Scene): void {
    this.houseLayer.dispose(scene);
    this.businessLayer.dispose(scene);
    this.gasStationLayer.dispose(scene);
  }
}
