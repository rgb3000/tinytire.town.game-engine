import { GameColor } from '../types';
import { DesignerTool } from './MapDesigner';
import type { KeyBindingTable } from '../input/KeyBindings';

/**
 * What the designer's keyboard can trigger.
 *
 * Verbs rather than `MapDesigner` method names, for the same reason `GameInputActions`
 * exists: the table below reads as a spec and the designer stays free to rename its
 * internals.
 */
export interface DesignerInputActions {
  zoomBy(direction: 1 | -1): void;
  selectTool(tool: DesignerTool): void;
  selectColor(color: GameColor): void;
  toggleIsometric(): void;
  beginSpacePan(): void;
  endSpacePan(): void;
}

/**
 * The palette the digit row picks from, in key order: `1` is Red, `6` is Orange.
 *
 * One array drives both the accepted keys and the colour they map to, so the two cannot
 * fall out of step. The chain this replaces derived the keys from a `'1' <= e.key <= '6'`
 * string-range test and the colours from a separate literal — correct only as long as
 * nobody added a seventh colour.
 */
const COLOR_KEYS = [
  GameColor.Red, GameColor.Blue, GameColor.Yellow,
  GameColor.Green, GameColor.Purple, GameColor.Orange,
] as const;

/**
 * The designer's window-level keyboard shortcuts.
 *
 * These were a flat chain of thirteen `if`s in `MapDesigner`'s constructor — a second,
 * independently drifted copy of the chain `gameKeyBindings` came from. Same table shape
 * now, but deliberately *not* the same table: the two shells share a keyboard mechanism,
 * not a vocabulary.
 *
 * Where they differ, and why merging them would be wrong:
 *
 * - `p` is Paint here and pause in the game; the designer has no pause.
 * - `h` is House here and Highway in the game, which pushes Highway to `w`.
 * - The designer has no undo and no speed toggle; the game has no colour picker.
 *
 * The website renders these letters as the shortcut hints on its tool palette
 * (`components/game/DesignerUI.tsx`), so a key that moves here is a key that lies there.
 */
export function designerKeyBindings(actions: DesignerInputActions): KeyBindingTable {
  return {
    // Order matches the original chain, so that even a future overlap behaves identically.
    keydown: [
      { keys: ['+', '='], run: () => actions.zoomBy(1) },
      { keys: ['-'], run: () => actions.zoomBy(-1) },
      { keys: ['r', 'R'], run: () => actions.selectTool(DesignerTool.Road) },
      { keys: ['e', 'E'], run: () => actions.selectTool(DesignerTool.Eraser) },
      { keys: ['h', 'H'], run: () => actions.selectTool(DesignerTool.House) },
      { keys: ['b', 'B'], run: () => actions.selectTool(DesignerTool.Business) },
      { keys: ['m', 'M'], run: () => actions.selectTool(DesignerTool.Mountain) },
      { keys: ['l', 'L'], run: () => actions.selectTool(DesignerTool.Lake) },
      { keys: ['g', 'G'], run: () => actions.selectTool(DesignerTool.GasStation) },
      { keys: ['w', 'W'], run: () => actions.selectTool(DesignerTool.Highway) },
      { keys: ['p', 'P'], run: () => actions.selectTool(DesignerTool.Paint) },
      { keys: ['v', 'V'], run: () => actions.toggleIsometric() },
      {
        keys: COLOR_KEYS.map((_, i) => String(i + 1)),
        run: (e) => actions.selectColor(COLOR_KEYS[Number(e.key) - 1]!),
      },
      { keys: [' '], when: (e) => !e.repeat, preventDefault: true, run: () => actions.beginSpacePan() },
    ],
    keyup: [
      { keys: [' '], run: () => actions.endSpacePan() },
    ],
  };
}
