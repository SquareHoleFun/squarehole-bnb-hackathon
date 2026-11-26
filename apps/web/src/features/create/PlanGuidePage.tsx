/**
 * `/create/plan` (SH-AI-PLAN): the plan guide, linked from the Contents step's hidden-art line. It is the public format
 * of docs/guides/hidden-collection-plan.md in short: an example plan, its rules and the prompt to copy for an AI (words
 * in plan-guide.ts). Nothing here reads a file or follows a link to a plan: the plan is added on the Contents step and
 * read in this browser only. The page never names an AI tool.
 */
import { Link } from 'react-router';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from '../../pages/page-parts';
import { CopyButton } from '../pair/CopyButton';
import { PLAN_AI_TITLE, PLAN_BACK, PLAN_EXAMPLE, PLAN_LEAD, PLAN_NEXT, PLAN_PICTURES, PLAN_PROMPT, PLAN_RULES, PLAN_TITLE } from './plan-guide';
import { v2Path } from './v2/v2-steps';

export const PLAN_FORMAT_TITLE = 'The plan';
export const COPY_PROMPT = 'Copy the prompt';
export const COPY_PROMPT_FAILED = 'Copy failed: select the prompt and copy it by hand.';

export function PlanGuidePage() {
  usePageTitle(PLAN_TITLE);
  return (
    <section className="sh-page sh-plan-guide" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>{PLAN_TITLE}</PageHeading>
        <p className="sh-page__lede">{PLAN_LEAD}</p>
      </div>
      <section className="sh-panel sh-plan-guide__part" aria-labelledby="plan-guide-format">
        <h2 id="plan-guide-format" className="sh-plan-guide__title">
          {PLAN_FORMAT_TITLE}
        </h2>
        <pre className="sh-plan-guide__code" data-plan-example="">
          <code>{PLAN_EXAMPLE}</code>
        </pre>
        <ul className="sh-plan-guide__rules">
          {PLAN_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p className="sh-plan-guide__line">{PLAN_PICTURES}</p>
      </section>
      <section className="sh-panel sh-plan-guide__part" aria-labelledby="plan-guide-ai">
        <h2 id="plan-guide-ai" className="sh-plan-guide__title">
          {PLAN_AI_TITLE}
        </h2>
        <pre className="sh-plan-guide__code" data-plan-prompt="">
          <code>{PLAN_PROMPT}</code>
        </pre>
        <CopyButton value={PLAN_PROMPT} label={COPY_PROMPT} failed={COPY_PROMPT_FAILED} />
      </section>
      <p className="sh-plan-guide__line">{PLAN_NEXT}</p>
      <p>
        <Link to={v2Path('v2-contents')} className="sh-button">
          {PLAN_BACK}
        </Link>
      </p>
    </section>
  );
}

export default PlanGuidePage;
