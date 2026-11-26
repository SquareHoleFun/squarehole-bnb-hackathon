/**
 * The page's gates (box creation flow § 5): Next checks the step's own fields with the rules' code and then a probe
 * spec (this step's values, the defaults after it) with `validateBoxSpecV1`, the factory's check; the Overview and
 * Create run every check and the zod schema of the version context. Both use the source's network (F74 U1: the Demo
 * offers holder payouts; a chain source does not). Messages come from reason-copy.ts.
 */
import { CONTEXT_V2, validateBoxSpecV1, type BoxSpecV1 } from '@squarehole/box-spec';
import type { Address } from '@squarehole/domain';
import { STEPS, buildSpec, probeForm, stepIndex, type StepId } from './create-model';
import { dedupe, fieldIssues, finalGate, issueForVerdict, type CheckInput, type Issue } from './reason-copy';

/** Stands in for the creator's address before the Overview (its row is there). */
export const PROBE_OWNER = '0x0000000000000000000000000000000000000001' as Address;

export interface GateInput extends CheckInput {
  readonly owner: Address | null;
}

/** What blocks Next on `step`: its own field checks, then the probe spec's verdict when it belongs to this step or an earlier one. */
export function stepIssues(step: StepId, input: GateInput): Issue[] {
  if (step === 'overview') return reviewIssues(input).issues;
  const own = fieldIssues(step, input);
  const form = probeForm(input.form, step);
  const spec = buildSpec({ form, art: input.art, commitment: input.commitment, cover: input.cover, collectionCover: input.collectionCover, page: input.page, owner: input.owner ?? PROBE_OWNER, nowMs: input.nowMs });
  const verdict = unpicked(input, issueForVerdict(validateBoxSpecV1(spec, CONTEXT_V2, input.network), spec, input.form));
  const rank = stepIndex(step);
  return dedupe([...own, ...(verdict && stepIndex(verdict.step) <= rank ? [verdict] : [])]);
}

/** Nothing picked on Contents yet: "Pick what's in the box" says it all (the probe would name a collection's art). */
const unpicked = (input: GateInput, issue: Issue | null): Issue | null => (issue && input.form.contents === null && issue.step === 'contents' ? null : issue);

/** Every check on the full spec: the page's own for each step, then the schema (the final gate). */
export function reviewIssues(input: GateInput): { spec: BoxSpecV1; issues: Issue[] } {
  const own = STEPS.flatMap((step) => fieldIssues(step.id, input));
  const spec = buildSpec({ form: input.form, art: input.art, commitment: input.commitment, cover: input.cover, collectionCover: input.collectionCover, page: input.page, owner: input.owner, nowMs: input.nowMs });
  const gate = unpicked(input, finalGate(spec, input.form, input.network));
  return { spec, issues: dedupe([...own, ...(gate ? [gate] : [])]) };
}

/** The steps that have something to fix (the stepper and the Overview's groups mark them "Fix"). */
export function stepsToFix(issues: readonly Issue[]): ReadonlySet<StepId> {
  return new Set(issues.map((issue) => issue.step));
}

/** How far the stepper reaches (§ 0): Basics always, Contents once Basics is complete, every step once Contents is. */
export function reachableSteps(input: GateInput): number {
  if (stepIssues('basics', input).length > 0) return 1;
  if (stepIssues('contents', input).length > 0) return 2;
  return STEPS.length;
}
