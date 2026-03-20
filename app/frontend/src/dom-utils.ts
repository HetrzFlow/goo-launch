/**
 * Safe DOM utilities -- no innerHTML, all rendering via createElement + textContent.
 * Prevents XSS by design.
 */

/** Create an element with attributes and children. */
export function el(
  tag: string,
  attrs?: Record<string, string> | null,
  ...children: (Node | string)[]
): HTMLElement {
  const element = document.createElement(tag);
  if (attrs) {
    for (const [key, val] of Object.entries(attrs)) {
      if (key === 'className') {
        element.className = val;
      } else {
        element.setAttribute(key, val);
      }
    }
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      element.appendChild(child);
    } else {
      element.appendChild(document.createTextNode(String(child)));
    }
  }
  return element;
}

/** Create a text node. */
export function text(content: string): Text {
  return document.createTextNode(content);
}

/** Shorten an address: 0x1234...abcd */
export function shortAddr(addr: string): string {
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/** Human-readable time-ago from an ISO date string. */
export function timeAgo(dateStr: string): string {
  if (!dateStr) return 'unknown';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/** Format a bigint-as-string token amount compactly (18 decimals assumed). */
export function formatCompact(weiStr: string): string {
  const n = Number(weiStr) / 1e18;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n === 0) return '0';
  return n.toFixed(0);
}

/** Format BNB amount (wei string) with 2-4 decimal places. */
export function formatBnb(weiStr: string): string {
  const n = Number(weiStr) / 1e18;
  return n.toFixed(2);
}

/** Clear all children of an element. */
export function clearChildren(element: HTMLElement): void {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

/** Show/hide an element. Removes .hidden class when showing so !important doesn't block it. */
export function setVisible(element: HTMLElement, visible: boolean): void {
  if (visible) element.classList.remove('hidden');
  element.style.display = visible ? '' : 'none';
}

/** Copy text to clipboard. */
export async function copyToClipboard(value: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
  const orig = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => {
    btn.textContent = orig;
  }, 1500);
}
