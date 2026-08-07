import { Direction } from '../../types';
import type { Grid } from '../../core/Grid';
import { opposite, YIELD_TO_DIRECTION, cardinalConnectionCount } from '../../utils/direction';
import type { IntersectionEntry } from './CarTrafficManager';

/**
 * Maneuver = (entryDirection, exitDirection) through an intersection.
 * Two maneuvers conflict if their paths cross or merge inside the intersection.
 */

/** Check if two maneuvers conflict (crossing or merging) */
export function maneuversConflict(
  entryA: Direction, exitA: Direction,
  entryB: Direction, exitB: Direction,
): boolean {
  // Same entry direction: they're queued on the same lane, no intersection conflict
  if (entryA === entryB) return false;

  // Same exit direction: merge conflict (both want to enter the same outgoing lane)
  if (exitA === exitB) return true;

  // Check if one is entering from the direction the other exits to
  // This catches crossing conflicts
  const aStraight = exitA === opposite(entryA);
  const bStraight = exitB === opposite(entryB);

  // Two perpendicular straights always cross
  if (aStraight && bStraight && entryA !== entryB && entryA !== opposite(entryB)) {
    return true;
  }

  // Left turn crossing oncoming straight:
  // A turns left (exit is 90deg clockwise from entry when viewed from above)
  // and B goes straight from the opposite direction
  if (isLeftTurn(entryA, exitA) && bStraight && entryB === opposite(entryA)) return true;
  if (isLeftTurn(entryB, exitB) && aStraight && entryA === opposite(entryB)) return true;

  // Left turn crossing another left turn from opposite direction
  if (isLeftTurn(entryA, exitA) && isLeftTurn(entryB, exitB) && entryA === opposite(entryB)) return true;

  // Straight crossing a right turn from perpendicular direction (the right-turner enters the straight path)
  // e.g., A goes straight N→S, B enters from W turning right to go N — B's path crosses A's path
  if (aStraight && isRightTurn(entryB, exitB) && exitB === opposite(entryA)) return true;
  if (bStraight && isRightTurn(entryA, exitA) && exitA === opposite(entryB)) return true;

  return false;
}

/** A left turn means exit is 90 degrees counter-clockwise from the travel direction */
function isLeftTurn(entry: Direction, exit: Direction): boolean {
  // Travel direction = opposite(entry). Left turn = 90deg CCW from travel.
  // In grid: Up travel → Left exit, Right travel → Up exit, etc.
  const leftOf = LEFT_TURN_EXIT[entry];
  return leftOf !== undefined && exit === leftOf;
}

/** A right turn means exit is 90 degrees clockwise from the travel direction */
function isRightTurn(entry: Direction, exit: Direction): boolean {
  const rightOf = RIGHT_TURN_EXIT[entry];
  return rightOf !== undefined && exit === rightOf;
}

// When entering from direction X, a left turn exits to:
const LEFT_TURN_EXIT: Partial<Record<Direction, Direction>> = {
  [Direction.Up]: Direction.Left,       // traveling up, turn left = exit left
  [Direction.Right]: Direction.Up,      // traveling right, turn left = exit up
  [Direction.Down]: Direction.Right,    // traveling down, turn left = exit right
  [Direction.Left]: Direction.Down,     // traveling left, turn left = exit down
};

// When entering from direction X, a right turn exits to:
const RIGHT_TURN_EXIT: Partial<Record<Direction, Direction>> = {
  [Direction.Up]: Direction.Right,      // traveling up, turn right = exit right
  [Direction.Right]: Direction.Down,    // traveling right, turn right = exit down
  [Direction.Down]: Direction.Left,     // traveling down, turn right = exit left
  [Direction.Left]: Direction.Up,       // traveling left, turn right = exit up
};

/**
 * Determine if this car should yield to another car at an intersection.
 * Returns true if `me` should yield to `other`.
 *
 * Priority rules (in order):
 * 1. Car already in intersection has absolute priority
 * 2. At T-intersections: straight traffic beats turning traffic
 * 3. Yield to the right (YIELD_TO_DIRECTION)
 * 4. Earlier arrival time as tiebreaker
 */
export function shouldYield(
  me: IntersectionEntry,
  other: IntersectionEntry,
  isTIntersection: boolean,
): boolean {
  // Only yield if our paths actually conflict
  if (!maneuversConflict(me.entryDirection, me.exitDirection, other.entryDirection, other.exitDirection)) {
    return false;
  }

  // Rule 1: car already in intersection has absolute priority
  if (other.inIntersection && !me.inIntersection) return true;
  if (me.inIntersection && !other.inIntersection) return false;

  // Rule 2: at T-intersections, straight traffic beats turning
  if (isTIntersection) {
    const otherStraight = other.exitDirection === opposite(other.entryDirection);
    const meStraight = me.exitDirection === opposite(me.entryDirection);
    if (otherStraight && !meStraight) return true;
    if (meStraight && !otherStraight) return false;
  }

  // Rule 3: yield to the right
  if (other.entryDirection === YIELD_TO_DIRECTION[me.entryDirection]) return true;

  // Rule 4: arrival time tiebreaker (earlier arrival has priority)
  if (other.arrivalTime < me.arrivalTime - 0.05) return true;

  return false;
}

const CARDINAL_DIRS: Direction[] = [Direction.Up, Direction.Down, Direction.Left, Direction.Right];

/**
 * At a T-intersection (3 cardinal connections), find the two directions that form the major road
 * (the pair of opposite directions), and the single minor road direction.
 * Returns null if not a T-intersection.
 */
export function getTIntersectionRoads(grid: Grid, gx: number, gy: number): { majorDirs: [Direction, Direction]; minorDir: Direction } | null {
  const cell = grid.getCell(gx, gy);
  if (!cell) return null;
  if (cardinalConnectionCount(cell.roadConnections) !== 3) return null;

  const connected: Direction[] = [];
  for (const d of CARDINAL_DIRS) {
    if (cell.roadConnections & d) connected.push(d);
  }
  if (connected.length !== 3) return null;

  // Find the pair of opposite directions — those are the major road
  for (let i = 0; i < connected.length; i++) {
    for (let j = i + 1; j < connected.length; j++) {
      if (connected[j] === opposite(connected[i])) {
        const minor = connected.find((_, k) => k !== i && k !== j)!;
        return { majorDirs: [connected[i], connected[j]], minorDir: minor };
      }
    }
  }

  return null;
}

/**
 * Check if a car is entering a T-intersection from the minor road.
 */
export function isMinorRoadEntry(entryDir: Direction, minorDir: Direction): boolean {
  // Car entering "from" the minor direction means it's traveling in the opposite of minorDir
  // e.g., if minor road points Down from the intersection, a car entering from below
  // is traveling Up, so entryDir = Up = opposite(Down) = opposite(minorDir)
  // Wait — entryDir is the direction the car is traveling INTO the intersection.
  // If minor road goes Down, cars on the minor road travel Up into the intersection.
  // Actually: entryDir here is getDirection(prevTile, intersectionTile), so it's the travel direction.
  // The minor road connection goes in the minorDir direction from the intersection tile.
  // A car on the minor road approaches from that direction, so its entry direction is opposite(minorDir).
  return entryDir === opposite(minorDir);
}
