import { isTypingTarget } from './keyboardTarget';

export interface KeyBinding {
  /** Exact `KeyboardEvent.key` values — case matters, hence `['r', 'R']`. */
  keys: readonly string[];
  /** Extra guard, e.g. a modifier requirement or `!e.repeat`. */
  when?: (e: KeyboardEvent) => boolean;
  /** Calls `preventDefault()` before running, matching the hand-written order. */
  preventDefault?: boolean;
  /**
   * Receives the event so a single row can cover a family of keys — the designer's
   * `1`–`6` colour picker reads `e.key` rather than spelling out six near-identical
   * rows, which would be the `if`-chain again wearing a table's clothes.
   */
  run: (e: KeyboardEvent) => void;
}

export interface KeyBindingTable {
  keydown: readonly KeyBinding[];
  keyup: readonly KeyBinding[];
}

/**
 * Window-level keyboard shortcuts, driven by a table the caller supplies.
 *
 * This was `GameInputBindings`, which owned both the dispatch mechanism and `Game`'s key
 * vocabulary in one class. That made it unusable by the other shell, so `MapDesigner` grew
 * a second copy — a flat chain of eleven `if`s in its constructor that had already drifted:
 * no pause, no undo, no speed, but Paint/House/Business/Mountain/Lake and a colour picker,
 * and `h` bound to House where the game binds it to Highway.
 *
 * Splitting mechanism from vocabulary is what lets both shells share the dispatcher while
 * keeping tables that genuinely differ. The tables live next to the shell whose verbs they
 * name — `src/core/gameKeyBindings.ts` and `src/designer/designerKeyBindings.ts` — so that
 * `src/input/` never imports a shell's vocabulary, and no import cycle arises.
 *
 * Space is split deliberately: the table owns the *event* (which key, not on auto-repeat,
 * suppress the page scroll), while `CameraController` owns the *state* it starts. Putting
 * `spaceDown` on both sides would mean two objects sharing a boolean.
 */
export class KeyBindings {
  private table: KeyBindingTable;
  private keydownHandler: (e: KeyboardEvent) => void;
  private keyupHandler: (e: KeyboardEvent) => void;

  constructor(table: KeyBindingTable) {
    this.table = table;
    this.keydownHandler = (e) => this.dispatch(this.table.keydown, e);
    this.keyupHandler = (e) => this.dispatch(this.table.keyup, e);
    window.addEventListener('keydown', this.keydownHandler);
    window.addEventListener('keyup', this.keyupHandler);
  }

  /**
   * Runs *every* matching binding, not just the first. The chains this replaces were
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
      binding.run(e);
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('keyup', this.keyupHandler);
  }
}
