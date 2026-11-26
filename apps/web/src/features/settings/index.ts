// Local preferences (settings page, motion, "/" shortcut). Guarded localStorage; see preferences.ts.
export {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  applyMotionPreference,
  parsePreferences,
  readPreferences,
  resetPreferences,
  savePreferences,
  subscribePreferences,
  systemPrefersReducedMotion,
  usePreferences,
  type MotionPreference,
  type Preferences,
  type SaveResult,
} from './preferences';
export { useMotionPreferenceEffect } from './useMotionPreferenceEffect';
export { subscribeSystemMotion, useReducedMotion, useSystemReducedMotion } from './useReducedMotion';
