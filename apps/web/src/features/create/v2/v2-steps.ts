/** The v2 flow's six steps (F70's order, box-spec-v2-draft.md § 9 item 5): `/create/v2-<step>`, beside v1's `/create/<step>`. */
export type V2StepId = 'v2-basics' | 'v2-contents' | 'v2-fees' | 'v2-raise' | 'v2-opening' | 'v2-overview';

export const V2_STEPS: readonly { readonly id: V2StepId; readonly label: string }[] = Object.freeze([
  { id: 'v2-basics', label: 'Basics' },
  { id: 'v2-contents', label: 'Contents' },
  { id: 'v2-fees', label: 'Fees' },
  { id: 'v2-raise', label: 'Raise' },
  { id: 'v2-opening', label: 'Opening' },
  { id: 'v2-overview', label: 'Overview' },
]);

export const isV2Step = (value: string | undefined): value is V2StepId => V2_STEPS.some((step) => step.id === value);
export const v2Index = (step: V2StepId): number => V2_STEPS.findIndex((entry) => entry.id === step);
export const v2Path = (step: V2StepId): string => `/create/${step}`;
/** `/create/v2` and any other `v2…` slug open Basics. */
export const isV2Slug = (value: string | undefined): boolean => value === 'v2' || (value?.startsWith('v2-') ?? false);
