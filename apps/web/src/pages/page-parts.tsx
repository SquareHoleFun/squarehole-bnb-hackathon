import { CastCharacter, type CastId } from '@squarehole/design';
import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';

export const PAGE_TITLE_ID = 'page-title';

export function usePageTitle(title: string) {
  useEffect(() => {
    // F130 (founder, 2026-10-11): no Demo word in any title, in every build.
    document.title = `${title} · Square Hole`;
  }, [title]);
}

/** The page's single h1. Focusable (not tabbable) so route changes can move focus to it. */
export function PageHeading({ children }: { children: ReactNode }) {
  return (
    <h1 id={PAGE_TITLE_ID} className="sh-page__title" tabIndex={-1}>
      {children}
    </h1>
  );
}

/** "Arrives in M2" chip plus the delivering task ids. */
export function MilestoneStatus({ milestone, tasks }: { milestone: string; tasks: string }) {
  return (
    <p className="sh-placeholder__status">
      <span className="sh-chip sh-chip--pending">Arrives in {milestone}</span>{' '}
      <span className="sh-placeholder__tasks">{tasks}</span>
    </p>
  );
}

interface PlaceholderPageProps {
  title: string;
  /** Milestone that delivers the page, e.g. "M2". */
  milestone: string;
  /** Task ids that deliver it, e.g. "SH-009 · SH-010". */
  tasks: string;
  /** The cast character that introduces the page… */
  cast?: CastId;
  /** …or other art in its place (e.g. a pair avatar). */
  art?: ReactNode;
  children: ReactNode;
}

/** Honest placeholder: says what arrives and when, with no fake controls or data. */
export function PlaceholderPage({ title, milestone, tasks, cast, art, children }: PlaceholderPageProps) {
  usePageTitle(title);
  return (
    <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>{title}</PageHeading>
      </div>
      <div className="sh-panel sh-placeholder">
        {art ? <div className="sh-placeholder__art">{art}</div> : null}
        {!art && cast ? <CastCharacter id={cast} size={96} className="sh-placeholder__art" /> : null}
        <div className="sh-placeholder__body">
          <MilestoneStatus milestone={milestone} tasks={tasks} />
          {children}
          <p>
            <Link to="/">Back to the feed</Link>
          </p>
        </div>
      </div>
    </section>
  );
}
