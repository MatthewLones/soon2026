/**
 * Shared mechanism for gating global keyboard shortcuts (V, L, WASD, arrows)
 * so they only fire when the 3D canvas — not the chat, a button, a select —
 * has focus.
 *
 * Wrap the focusable canvas region with `data-canvas-focusable` and
 * `tabIndex={0}`, and call `wrapperRef.current?.focus()` on `pointerdown`.
 * Then any `keydown` handler can early-return on `!isCanvasFocused()`.
 *
 * Initial state (nothing focused → `document.activeElement === <body>`)
 * counts as not-focused on purpose: shortcuts shouldn't fire from a cold
 * page, the user has to click into the canvas first. Matches game UX.
 */
export const CANVAS_FOCUS_ATTR = 'data-canvas-focusable';

export function isCanvasFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  return !!el?.closest(`[${CANVAS_FOCUS_ATTR}]`);
}
