/**
 * SH-EXISTING-NFTS-E08C: the existing-NFTs Create flow's four steps, `/create/set-<step>`, beside the format 2 flow's
 * `/create/v2-<step>`: Basics (price coin, name, ticker, logo), Items (the collection, the ids, the pick fee), Raise
 * (the listed raise, the deadline, an optional first buy), Overview (every parameter, the full list, the list file,
 * then Create, loading and its resume).
 */
export type SetStepId = 'set-basics' | 'set-items' | 'set-raise' | 'set-overview';

export const SET_STEPS: readonly { readonly id: SetStepId; readonly label: string }[] = /* @__PURE__ */ Object.freeze([
  { id: 'set-basics', label: 'Basics' },
  { id: 'set-items', label: 'Items' },
  { id: 'set-raise', label: 'Raise' },
  { id: 'set-overview', label: 'Overview' },
]);

export const isSetStep = (value: string | undefined): value is SetStepId => SET_STEPS.some((step) => step.id === value);
export const setIndex = (step: SetStepId): number => SET_STEPS.findIndex((entry) => entry.id === step);
export const setPath = (step: SetStepId): string => `/create/${step}`;
