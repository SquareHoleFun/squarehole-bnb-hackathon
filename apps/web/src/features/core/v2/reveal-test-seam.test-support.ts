/** Loaded only by Vitest's explicit module replacement. Never imported by application code. */
import type { RevealTestOverrides } from './reveal-test-seam';
const overrides = new WeakMap<object, RevealTestOverrides>();
export function installRevealTestSeam(target: object, value: RevealTestOverrides): void {
  overrides.set(target, { ...overrides.get(target), ...value });
}
export const revealTestOverride = (target: object): RevealTestOverrides | undefined => overrides.get(target);
export function authorizeRevealTestTarget<T extends object>(target: T): T {
  installRevealTestSeam(target, { authorized: true }); return target;
}
