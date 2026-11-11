import { useEffect, type RefObject } from 'react';

/**
 * Full-screen layers (photo viewer, compare, sheets) sit over the app. While
 * one is open the app underneath is made inert, so Tab can never wander into
 * controls that are hidden behind it. Notices stay usable (Undo, above all).
 */
let layers = 0;

function setBackgroundInert(on: boolean): void {
  for (const el of document.querySelectorAll<HTMLElement>('.app > *')) {
    if (el.classList.contains('toasts')) continue;
    el.inert = on;
  }
}

export function useBackgroundInert(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (layers++ === 0) setBackgroundInert(true);
    return () => {
      if (--layers === 0) setBackgroundInert(false);
    };
  }, [active]);
}

/** Inert background, plus: focus moves into the layer when it opens and goes back where it was when it closes. */
export function useOverlayFocus(active: boolean, ref: RefObject<HTMLElement | null>): void {
  useBackgroundInert(active);
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus?.({ preventScroll: true });
    };
  }, [active, ref]);
}
