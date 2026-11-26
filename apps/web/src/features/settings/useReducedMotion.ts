import { useSyncExternalStore } from 'react';
import { systemPrefersReducedMotion, usePreferences } from './preferences';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** Follows the system reduced-motion setting (a missing or throwing matchMedia means "no change ever"). */
export function subscribeSystemMotion(listener: () => void): () => void {
  try {
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    query.addEventListener('change', listener);
    return () => query.removeEventListener('change', listener);
  } catch {
    return () => undefined;
  }
}

/** Whether the operating system asks for reduced motion, kept current while the page is open. */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(subscribeSystemMotion, () => systemPrefersReducedMotion(), () => false);
}

/**
 * Whether motion is off: the saved "Reduce motion" choice or the system setting, whichever asks for it (the same
 * rule the global CSS applies with `data-motion="reduce"` and `prefers-reduced-motion`).
 */
export function useReducedMotion(): boolean {
  const { motion } = usePreferences();
  const system = useSystemReducedMotion();
  return motion === 'reduce' || system;
}
