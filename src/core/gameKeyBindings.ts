import { Tool } from '../types';
import type { KeyBindingTable } from '../input/KeyBindings';

/**
 * What the board's keyboard can trigger.
 *
 * Verbs rather than `Game` method names, so the binding table below reads as a spec and
 * `Game` stays free to rename its internals. Same idea as `SpawnDemandSource` in
 * `src/systems/SpawnSystem.ts`: depend on the operations, not the class.
 */
export interface GameInputActions {
  zoomBy(direction: 1 | -1): void;
  togglePause(): void;
  undo(): void;
  selectTool(tool: Tool): void;
  toggleSpeed(): void;
  toggleIsometric(): void;
  beginSpacePan(): void;
  endSpacePan(): void;
}

/**
 * The board's window-level keyboard shortcuts.
 *
 * These were a flat chain of eleven `if`s in `Game`'s constructor, mixing camera zoom,
 * pause, undo, tool selection, speed, isometric and space-panning. A table separates the
 * key vocabulary from the actions, which is the part worth reading.
 *
 * It lives in `src/core/` beside the shell whose verbs it names, not in `src/input/` with
 * the {@link KeyBindings} dispatcher that runs it. That is the rule the split turns on:
 * `src/input/` holds the mechanism and never imports a shell's vocabulary, so the designer's
 * table can import `DesignerTool` from `src/designer/` without a cycle.
 *
 * Note where the two shells genuinely diverge, which is why these are two tables and not one:
 * here `p` is pause and `h` is Highway; in `designerKeyBindings` `p` is Paint, `h` is House
 * and Highway moves to `w`.
 */
export function gameKeyBindings(actions: GameInputActions): KeyBindingTable {
  return {
    // Order matches the original chain, so that even a future overlap behaves identically.
    keydown: [
      { keys: ['+', '='], run: () => actions.zoomBy(1) },
      { keys: ['-'], run: () => actions.zoomBy(-1) },
      { keys: ['Escape', 'p'], run: () => actions.togglePause() },
      { keys: ['z'], when: (e) => e.ctrlKey || e.metaKey, preventDefault: true, run: () => actions.undo() },
      { keys: ['r', 'R'], run: () => actions.selectTool(Tool.Road) },
      { keys: ['e', 'E'], run: () => actions.selectTool(Tool.Eraser) },
      { keys: ['h', 'H'], run: () => actions.selectTool(Tool.Highway) },
      { keys: ['g', 'G'], run: () => actions.selectTool(Tool.GasStation) },
      { keys: ['f', 'F'], run: () => actions.toggleSpeed() },
      { keys: ['v', 'V'], run: () => actions.toggleIsometric() },
      { keys: [' '], when: (e) => !e.repeat, preventDefault: true, run: () => actions.beginSpacePan() },
    ],
    keyup: [
      { keys: [' '], run: () => actions.endSpacePan() },
    ],
  };
}
