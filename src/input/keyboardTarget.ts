/**
 * Whether a key event originated in a text-entry context.
 *
 * `Game` and `MapDesigner` bind their shortcuts to `window` rather than to the
 * canvas, so the board responds wherever the pointer happens to be. That also puts
 * a host's own form controls in the firing line: without this guard, typing `5`
 * into a number field picks a colour in the designer, `-` zooms the camera out,
 * `e` selects the eraser, and a space resets the camera tilt.
 *
 * Every `<input>` is guarded, not only the textual ones — `color`, `checkbox` and
 * `range` all consume space and the arrow keys as their own activation, and so
 * does a focused `<select>`.
 *
 * `BUTTON` is deliberately absent: space is both "activate the focused button" and
 * "hold to pan", so guarding buttons would break panning after any tool click.
 * Hosts should stop the mouse from focusing their buttons instead.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
