/**
 * Covers the add → remove → restore round trip that undo depends on.
 *
 * `restore` exists rather than reusing `addHighway` because the id has to survive: a
 * `PathStep` of kind `'highway'` refers to a highway by id, so a re-added highway with a
 * fresh id would leave any car mid-route pointing at nothing. Re-inserting also keeps the
 * sampled polyline instead of paying to derive it again.
 */
import { describe, it, expect } from 'vitest';

import { HighwaySystem } from './HighwaySystem';

function addOne(system: HighwaySystem) {
  return system.addHighway({ gx: 2, gy: 2 }, { gx: 8, gy: 8 }, { x: 100, y: 100 }, { x: 300, y: 300 });
}

describe('HighwaySystem', () => {
  it('restores a removed highway under its original id', () => {
    const system = new HighwaySystem();
    const highway = addOne(system);
    const originalId = highway.id;

    system.removeHighway(originalId);
    expect(system.getById(originalId)).toBeUndefined();

    system.restore(highway);

    expect(system.getById(originalId)).toBe(highway);
    expect(system.getAll()).toHaveLength(1);
  });

  it('keeps the sampled geometry, so the restored highway is still traversable', () => {
    const system = new HighwaySystem();
    const highway = addOne(system);
    const { arcLength, polyline, cumDist } = highway;

    system.removeHighway(highway.id);
    system.restore(highway);

    const restored = system.getById(highway.id)!;
    expect(restored.arcLength).toBe(arcLength);
    expect(restored.polyline).toBe(polyline);
    expect(restored.cumDist).toBe(cumDist);
    expect(restored.polyline.length).toBeGreaterThan(1);
  });

  it('is findable by its endpoint cell again, which is how the eraser sees it', () => {
    const system = new HighwaySystem();
    const highway = addOne(system);

    system.removeHighway(highway.id);
    expect(system.getHighwaysAtCell(2, 2)).toHaveLength(0);

    system.restore(highway);

    expect(system.getHighwaysAtCell(2, 2)).toEqual([highway]);
  });

  it('marks itself dirty on restore, which is what repaints it', () => {
    const system = new HighwaySystem();
    const highway = addOne(system);
    system.removeHighway(highway.id);
    system.clearDirty();

    system.restore(highway);

    expect(system.isDirty).toBe(true);
  });
});
