/**
 * F166 af2 (SH-ALPHA-ONBOARDING): the top bar's place for the Sepolia alpha's setup chip. The top bar renders it, empty,
 * in Sepolia trade builds only, and hands it here by its ref (TopBar.tsx); the welcome step
 * (features/trade-sepolia/AlphaWelcome.tsx) reads it and renders the chip into it while a "Set me up" run shows, so the
 * chip stays in the bar on every page.
 */
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

/** The top bar's ref: its place, or null when it goes. */
export function setSetupChipSlot(node: HTMLElement | null): void {
  if (slot === node) return;
  slot = node;
  for (const listener of [...listeners]) listener();
}

/** The place now, or null (no top bar, or a build without it). */
export const setupChipSlot = (): HTMLElement | null => slot;

export function subscribeSetupChipSlot(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
