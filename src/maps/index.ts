import type { MapConfig } from './types';
import { validateMapConfig } from './loadMap';
import classicJson from './classic/classic.json';
import lakelandJson from './lakeland/lakeland.json';
import narrowPassJson from './narrow-pass/narrow-pass.json';
import trafficStressTestJson from './traffic-stress-test/traffic-stress-test.json';
import homeBackgroundJson from './home-background/home-background.json';

export const allMaps: MapConfig[] = [
  validateMapConfig(classicJson),
  validateMapConfig(lakelandJson),
  validateMapConfig(narrowPassJson),
  validateMapConfig(trafficStressTestJson),
];

/**
 * The decorative landing-page backdrop rendered by `DemoGame`. Deliberately not in
 * `allMaps`: it is scenery, not a playable map, and must never appear in a map picker.
 */
export const homeBackgroundMap: MapConfig = validateMapConfig(homeBackgroundJson);

export function getMapById(id: string): MapConfig | undefined {
  return allMaps.find((m) => m.id === id);
}
