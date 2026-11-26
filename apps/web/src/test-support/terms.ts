/**
 * Unit tests that render the whole <App /> (with the entry terms gate, F19) start as a visitor who has accepted the
 * current Terms. Call in `beforeEach`; the usual `localStorage.clear()` in `afterEach` removes it again.
 */
import { TERMS_ACCEPTANCE_KEY, TERMS_VERSION } from '../features/legal';

export function acceptTermsForTests(version: string = TERMS_VERSION): void {
  window.localStorage.setItem(TERMS_ACCEPTANCE_KEY, JSON.stringify({ version, acceptedAt: '2026-09-27T00:00:00.000Z' }));
}
