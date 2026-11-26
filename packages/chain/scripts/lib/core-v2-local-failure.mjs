import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Shared by Playwright's parent, workers and webServer; the config gives each run a fresh path. */
export function markLocalFailure(reason) {
  const path = process.env.SH_CORE_V2_FAILURE_FILE;
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${reason}\n`, { flag: 'a' });
}

export function localRunFailed() {
  const path = process.env.SH_CORE_V2_FAILURE_FILE;
  return Boolean(path && existsSync(path));
}
