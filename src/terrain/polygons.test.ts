import { describe, it, expect } from 'vitest';
import { signedArea, ensureWinding, pointInPolygon, simplifyLoop, nestLoops } from './polygons';

const square = (x: number, y: number, s: number): number[][] => [
  [x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y],
];

const reversed = (loop: number[][]): number[][] => [...loop].reverse();

describe('signedArea', () => {
  it('has magnitude equal to the enclosed area', () => {
    expect(Math.abs(signedArea(square(0, 0, 10)))).toBeCloseTo(100);
  });

  it('flips sign with winding', () => {
    const a = signedArea(square(0, 0, 10));
    const b = signedArea(reversed(square(0, 0, 10)));
    expect(Math.sign(a)).toBe(-Math.sign(b));
  });
});

describe('ensureWinding', () => {
  it('leaves a loop alone when it already winds the wanted way', () => {
    const loop = square(0, 0, 5);
    const positive = signedArea(loop) > 0;
    expect(ensureWinding(loop, positive)).toEqual(loop);
  });

  it('reverses a loop that winds the wrong way', () => {
    const loop = square(0, 0, 5);
    const positive = signedArea(loop) > 0;
    const flipped = ensureWinding(loop, !positive);
    expect(Math.sign(signedArea(flipped))).toBe(positive ? -1 : 1);
  });
});

describe('pointInPolygon', () => {
  it('accepts an interior point', () => {
    expect(pointInPolygon([5, 5], square(0, 0, 10))).toBe(true);
  });

  it('rejects an exterior point', () => {
    expect(pointInPolygon([15, 5], square(0, 0, 10))).toBe(false);
  });

  it('is unaffected by winding direction', () => {
    expect(pointInPolygon([5, 5], reversed(square(0, 0, 10)))).toBe(true);
  });
});

describe('simplifyLoop', () => {
  it('drops collinear points', () => {
    const loop = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(simplifyLoop(loop, 0.1).length).toBeLessThan(loop.length);
  });

  it('keeps corners', () => {
    const simplified = simplifyLoop(square(0, 0, 10), 0.1);
    expect(simplified.length).toBe(5);
  });

  it('never falls below a triangle', () => {
    const loop = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    const simplified = simplifyLoop(loop, 1000);
    expect(simplified.length).toBeGreaterThanOrEqual(4);
  });

  it('stays closed', () => {
    const s = simplifyLoop(square(0, 0, 10), 0.1);
    expect(s[0]).toEqual(s[s.length - 1]);
  });
});

describe('nestLoops', () => {
  it('treats a lone loop as an outer boundary', () => {
    const result = nestLoops([square(0, 0, 10)]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(0);
  });

  it('assigns a contained loop as a hole', () => {
    const result = nestLoops([square(0, 0, 20), square(5, 5, 5)]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(1);
  });

  it('treats disjoint loops as separate outers', () => {
    const result = nestLoops([square(0, 0, 10), square(50, 50, 10)]);
    expect(result).toHaveLength(2);
    expect(result[0].holes).toHaveLength(0);
    expect(result[1].holes).toHaveLength(0);
  });

  it('handles an island inside a hole', () => {
    // outer ring, its hole, and a smaller shape sitting inside that hole
    const result = nestLoops([square(0, 0, 40), square(5, 5, 30), square(15, 15, 5)]);
    expect(result).toHaveLength(2);
    const big = result.find(p => Math.abs(signedArea(p.outer)) > 1000)!;
    expect(big.holes).toHaveLength(1);
    const island = result.find(p => Math.abs(signedArea(p.outer)) < 1000)!;
    expect(island.holes).toHaveLength(0);
  });

  it('gives outers and holes opposite winding', () => {
    const [poly] = nestLoops([square(0, 0, 20), square(5, 5, 5)]);
    expect(Math.sign(signedArea(poly.outer))).toBe(-Math.sign(signedArea(poly.holes[0])));
  });
});

// The tests below were added on top of the briefed suite. Each one closes a gap found by
// mutating the implementation and watching the briefed tests stay green: the assertions
// above are almost all *relative* (this sign is the opposite of that one, this is shorter
// than that), so they pin no absolute convention and no actual geometry.

describe('signedArea (conventions)', () => {
  // Killed mutant: `return -sum / 2`. Every briefed assertion compares two signs against
  // each other, so a globally flipped convention was invisible — yet downstream winding
  // for THREE.Shape depends on which direction is positive.
  it('is positive for a loop traversed +x, +y, -x, -y', () => {
    expect(signedArea(square(0, 0, 10))).toBeCloseTo(100);
    expect(signedArea(reversed(square(0, 0, 10)))).toBeCloseTo(-100);
  });

  // Killed mutant: `closedCount` returning the raw length. Marching squares always repeats
  // the first point, but hand-built loops may not; both forms must measure the same.
  it('ignores whether the closing point is repeated', () => {
    const closed = square(0, 0, 10);
    const open = closed.slice(0, closed.length - 1);
    expect(signedArea(open)).toBeCloseTo(signedArea(closed));
  });
});

describe('ensureWinding (aliasing)', () => {
  // Killed mutant: `loop.reverse()` instead of `[...loop].reverse()`. nestLoops calls this
  // on arrays the caller still owns, so reversing in place would corrupt the input.
  it('does not mutate the loop it reverses', () => {
    const loop = square(0, 0, 5);
    const before = loop.map(p => [...p]);
    const flipped = ensureWinding(loop, signedArea(loop) < 0);
    expect(loop).toEqual(before);
    expect(flipped).not.toEqual(loop);
  });
});

describe('pointInPolygon (concave shapes)', () => {
  // A U opening towards +y. Its notch is inside the bounding box but outside the polygon.
  const uShape: number[][] = [
    [0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10], [0, 0],
  ];

  // Killed mutant: a bounding-box containment test. The briefed cases only ever ask about
  // a convex square, where a box test is indistinguishable from ray casting.
  it('rejects a point in a concave notch', () => {
    expect(pointInPolygon([5, 7], uShape)).toBe(false);
  });

  it('accepts points in each arm and in the base', () => {
    expect(pointInPolygon([1, 7], uShape)).toBe(true);
    expect(pointInPolygon([9, 7], uShape)).toBe(true);
    expect(pointInPolygon([5, 1], uShape)).toBe(true);
  });

  it('still rejects points outside the bounding box', () => {
    expect(pointInPolygon([-1, 5], uShape)).toBe(false);
    expect(pointInPolygon([5, 20], uShape)).toBe(false);
  });
});

describe('simplifyLoop (geometry, not just counts)', () => {
  // Killed mutant: dropping every other point regardless of geometry. The briefed tests
  // only compare lengths, so blind decimation satisfied all four of them.
  it('keeps exactly the corners and no invented points', () => {
    const loop = [[0, 0], [3, 0], [7, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(simplifyLoop(loop, 0.1)).toEqual([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
  });

  it('respects the tolerance at the boundary', () => {
    // The middle point sits 0.5 off the bottom edge.
    const loop = [[0, 0], [5, 0.5], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(simplifyLoop(loop, 0.1)).toContainEqual([5, 0.5]);
    expect(simplifyLoop(loop, 1)).not.toContainEqual([5, 0.5]);
  });

  it('returns a subset of the input points', () => {
    const loop = [[0, 0], [3, 0], [7, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const input = new Set(loop.map(p => `${p[0]},${p[1]}`));
    for (const p of simplifyLoop(loop, 0.1)) {
      expect(input.has(`${p[0]},${p[1]}`)).toBe(true);
    }
  });
});

describe('nestLoops (conventions and depth)', () => {
  // Killed mutant: swapping the two ensureWinding arguments. "Opposite winding" is
  // satisfied by either assignment; only one of them is the contract.
  it('winds outers positive and holes negative', () => {
    const [poly] = nestLoops([square(0, 0, 20), square(5, 5, 5)]);
    expect(signedArea(poly.outer)).toBeGreaterThan(0);
    expect(signedArea(poly.holes[0])).toBeLessThan(0);
  });

  // Killed mutants: capping containment depth at 1, and attaching a hole to the largest
  // container rather than the smallest. The briefed suite stops at one level of nesting.
  it('nests to four levels: lake, island, pond, islet', () => {
    const lake = square(0, 0, 100);
    const island = square(10, 10, 80);
    const pond = square(20, 20, 60);
    const islet = square(30, 30, 40);
    const result = nestLoops([lake, island, pond, islet]);

    expect(result).toHaveLength(2);
    const areaOf = (loop: number[][]) => Math.abs(signedArea(loop));

    const outerPoly = result.find(p => areaOf(p.outer) > 9000)!;
    expect(outerPoly).toBeDefined();
    expect(outerPoly.holes).toHaveLength(1);
    expect(areaOf(outerPoly.holes[0])).toBeCloseTo(6400);

    const pondPoly = result.find(p => areaOf(p.outer) < 9000)!;
    expect(pondPoly).toBeDefined();
    expect(areaOf(pondPoly.outer)).toBeCloseTo(3600);
    expect(pondPoly.holes).toHaveLength(1);
    expect(areaOf(pondPoly.holes[0])).toBeCloseTo(1600);
  });

  it('attaches a hole to the smallest loop containing it', () => {
    // Two concentric outers; the hole lies inside both but belongs to the inner one.
    const result = nestLoops([square(0, 0, 100), square(10, 10, 80), square(20, 20, 60), square(30, 30, 40)]);
    const inner = result.find(p => Math.abs(signedArea(p.outer)) < 9000)!;
    expect(Math.abs(signedArea(inner.holes[0]))).toBeCloseTo(1600);
  });

  // Killed mutant: dropping the `closedCount(l) >= 3` filter. A degenerate loop has zero
  // area and would sort last, then be misfiled as a hole of whatever contains it.
  it('discards degenerate loops that bound no area', () => {
    const degenerate: number[][] = [[5, 5], [6, 6], [5, 5]];
    const result = nestLoops([square(0, 0, 10), degenerate]);
    expect(result).toHaveLength(1);
    expect(result[0].holes).toHaveLength(0);
  });
});
