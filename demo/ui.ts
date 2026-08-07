/** Tiny DOM helpers. Enough structure to keep the panels readable, and no more. */

/** `style` is swapped for a plain string; the DOM's own type for it is not assignable. */
type Props<K extends keyof HTMLElementTagNameMap> =
  Partial<Omit<HTMLElementTagNameMap[K], 'style'>> & { style?: string };

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props<K> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const { style, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (style !== undefined) node.style.cssText = style;
  node.append(...children);
  return node;
}

export function section(title: string, ...children: (Node | string)[]): HTMLElement {
  return el('section', {}, [el('h2', { textContent: title }), ...children]);
}

export function row(...children: (Node | string)[]): HTMLDivElement {
  return el('div', { className: 'row' }, children);
}

/**
 * A floating surface. Everything the chrome is made of is one of these — the
 * stylesheet gives `.pill` its own hit area, which is what keeps the gaps between
 * them drawable.
 */
export function pill(className: string, ...children: (Node | string)[]): HTMLDivElement {
  return el('div', { className: `pill ${className}` }, children);
}

/**
 * A button that reports whether it is the selected one. `aria-pressed` carries the
 * state so the styling and the accessibility tree cannot disagree.
 */
/**
 * Space is "hold to pan" in the engine, and it is also "activate the focused
 * button". A mouse click that leaves a button focused therefore turns the next pan
 * into a second click on that button. Keeping the mouse from moving focus fixes it
 * without touching keyboard `Tab` focus, which still works.
 */
export function preventFocusSteal(button: HTMLButtonElement): HTMLButtonElement {
  button.addEventListener('mousedown', (e) => e.preventDefault());
  return button;
}

export function toggle(label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', textContent: label });
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', onClick);
  return preventFocusSteal(button);
}

export function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed));
}

export function button(
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const node = el('button', { type: 'button', className, textContent: label });
  node.addEventListener('click', onClick);
  return preventFocusSteal(node);
}

/** A square icon button, for the low-frequency controls in the utility cluster. */
export function iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { type: 'button', className: 'icon-btn', textContent: glyph, title });
  node.setAttribute('aria-label', title);
  node.addEventListener('click', onClick);
  return preventFocusSteal(node);
}

export interface CardOptions {
  /** `over` recolours the headline; nothing else about the card changes. */
  tone?: 'default' | 'over';
  mark?: string;
  eyebrow?: string;
  title: string;
  score?: string;
  body?: string;
  actions?: HTMLElement[];
  footnote?: Node;
}

/**
 * The one card used for starting, losing, and picking a weekly bonus.
 *
 * Which container it is mounted into decides whether it blocks the board:
 * `#overlay` dims and takes every click, `#toast` only takes clicks on the card
 * itself. That distinction matters because the engine keeps the road drawer
 * running during the weekly-bonus pause — see `mountOverlays`.
 */
export function card(opts: CardOptions): HTMLElement {
  const node = el('div', { className: opts.tone === 'over' ? 'card over' : 'card' });
  if (opts.mark) node.append(el('span', { className: 'mark', textContent: opts.mark }));
  if (opts.eyebrow) node.append(el('p', { className: 'eyebrow', textContent: opts.eyebrow }));
  node.append(el('h1', { textContent: opts.title }));
  if (opts.score) node.append(el('p', { className: 'score', textContent: opts.score }));
  if (opts.body) node.append(el('p', { className: 'body', textContent: opts.body }));
  if (opts.actions?.length) {
    node.append(el('div', { className: 'actions' }, opts.actions));
  }
  if (opts.footnote) node.append(opts.footnote);
  return node;
}

export function colorField(label: string, value: string, onInput: (hex: string) => void): HTMLElement {
  const input = el('input', { type: 'color', value });
  input.addEventListener('input', () => onInput(input.value));
  return el('label', { className: 'theme-field' }, [input, label]);
}

/** Offer a string as a file download, then revoke the object URL. */
export function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = el('a', { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}
