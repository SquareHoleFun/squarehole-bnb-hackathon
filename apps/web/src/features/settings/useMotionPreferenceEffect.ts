import { useEffect } from 'react';
import { applyMotionPreference, usePreferences } from './preferences';

/** Keeps `data-motion` on <html> in line with the saved motion preference (main.tsx applies it before first paint). */
export function useMotionPreferenceEffect(): void {
  const preferences = usePreferences();
  useEffect(() => {
    applyMotionPreference(preferences);
  }, [preferences]);
}
