/**
 * Demo clock for transaction deadlines (SH-015). Demo time starts at the fixture snapshot (`DEMO_NOW`) when the app
 * loads and then runs at wall-clock speed, so a demo quote (deadline = asOf + 20 min) really expires 20 minutes into a
 * session. Pass `demoNow` as the mock account provider's `now` so claim estimates and flow deadlines agree.
 */
import { DEMO_NOW, parseIsoTimestamp } from '@squarehole/domain';

const DEMO_START_MS = parseIsoTimestamp(DEMO_NOW);
const LOADED_AT_MS = Date.now();

export function demoNowMs(): number {
  return DEMO_START_MS + Math.max(0, Date.now() - LOADED_AT_MS);
}

export function demoNow(): string {
  return new Date(demoNowMs()).toISOString();
}
