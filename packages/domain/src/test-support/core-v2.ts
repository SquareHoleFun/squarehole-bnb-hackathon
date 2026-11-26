/**
 * Test-only, read-only access to the core v2.0 handoff (`square-hole-core-v2/`, hash-checked). Never imported by
 * runtime code, and never writes into the handoff folder.
 */
import { readFileSync } from 'node:fs';
import { REPO_ROOT } from './handoff';

export const CORE_V2_ROOT = `${REPO_ROOT}square-hole-core-v2/`;

/** A fresh, independent parse on every call (safe to mutate in a test). */
export function readCoreV2Json(relativePath: string): unknown {
  return JSON.parse(readFileSync(`${CORE_V2_ROOT}${relativePath}`, 'utf8')) as unknown;
}
