import { Tool } from '../types';
import { isTypingTarget } from './keyboardTarget';

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

interface KeyBinding {
  /** Exact `KeyboardEvent.key` values — case matters, hence `['r', 'R']`. */
  keys: readonly string[];
  /** Extra guard, e.g. a modifier requirement or `!e.repeat`. */
  when?: (e: KeyboardEvent) => boolean;
  /** Calls `preventDefault()` before running, matching the hand-written order. */
  preventDefault?: boolean;
  run: () => void;
}

/**
 * The board's window-level keyboard shortcuts.
 *
 * These were a flat chain of eleven `if`s in `Game`'s constructor, mixing camera zoom,
 * pause, undo, tool selection, speed, isometric and space-panning. A table separates the
 * key vocabulary from the actions, which is the part worth reading.
 *
 * Space is split deliberately: the table owns the *event* (which key, not on auto-repeat,
 * suppress the page scroll), while `CameraController` owns the *state* it starts. Putting
 * `spaceDown` on both sides would mean two objects sharing a boolean.
 */
export class GameInputBindings {
  private keydownBindings: readonly KeyBinding[];
  private keyupBindings: readonly KeyBinding[];
  private keydownHandler: (e: KeyboardEvent) => void;
  private keyupHandler: (e: KeyboardEvent) => void;

  constructor(actions: GameInputActions) {
    // Order matches the original chain, so that even a future overlap behaves identically.
    this.keydownBindings = [
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
    ];
    this.keyupBindings = [
      { keys: [' '], run: () => actions.endSpacePan() },
    ];

    this.keydownHandler = (e) => this.dispatch(this.keydownBindings, e);
    this.keyupHandler = (e) => this.dispatch(this.keyupBindings, e);
    window.addEventListener('keydown', this.keydownHandler);
    window.addEventListener('keyup', this.keyupHandler);
  }

  /**
   * Runs *every* matching binding, not just the first. The chain this replaces was
   * independent `if`s rather than `else if`s; no two bindings overlap today, but
   * first-match-wins would be a silent semantic change waiting to bite.
   */
  private dispatch(bindings: readonly KeyBinding[], e: KeyboardEvent): void {
    // Window-level, so a host's own form controls would otherwise swallow-and-act on every
    // keystroke typed into them. Guarded once, before any binding runs.
    if (isTypingTarget(e.target)) return;
    for (const binding of bindings) {
      if (!binding.keys.includes(e.key)) continue;
      if (binding.when && !binding.when(e)) continue;
      if (binding.preventDefault) e.preventDefault();
      binding.run();
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('keyup', this.keyupHandler);
  }
}
