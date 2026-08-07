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
 * A button that reports whether it is the selected one. `aria-pressed` carries the
 * state so the styling and the accessibility tree cannot disagree.
 */
export function toggle(label: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', { type: 'button', textContent: label });
  button.setAttribute('aria-pressed', 'false');
  button.addEventListener('click', onClick);
  return button;
}

export function setPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.setAttribute('aria-pressed', String(pressed));
}

export function stats(entries: [string, string][]): HTMLElement {
  const list = el('dl', { className: 'stats' });
  for (const [term, value] of entries) {
    list.append(el('dt', { textContent: term }), el('dd', { textContent: value }));
  }
  return list;
}

export function colorField(label: string, value: string, onInput: (hex: string) => void): HTMLElement {
  const input = el('input', { type: 'color', value });
  input.addEventListener('input', () => onInput(input.value));
  return el('label', { className: 'field' }, [label, input]);
}

/** Offer a string as a file download, then revoke the object URL. */
export function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const link = el('a', { href: url, download: filename });
  link.click();
  URL.revokeObjectURL(url);
}
