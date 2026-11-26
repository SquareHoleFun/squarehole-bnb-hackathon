/**
 * A page that fails to render shows a message, not a blank app (without a boundary React unmounts the whole root, and
 * a value kept in the tab's storage would blank it again on every reload). React itself reports the error to the
 * console. The boundary resets when the route changes, so the rest of the app keeps working.
 */
import { Component, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from '../pages/page-parts';

function RouteError() {
  usePageTitle('This page hit a problem');
  return (
    <section className="sh-page" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>This page hit a problem</PageHeading>
      </div>
      <div className="sh-panel">
        <p>Nothing was sent. Reload to try again.</p>
        <p>
          <button type="button" className="sh-button sh-button--primary" onClick={() => window.location.reload()}>
            Reload
          </button>{' '}
          <Link to="/" className="sh-button">
            Back to the boxes
          </Link>
        </p>
      </div>
    </section>
  );
}

interface BoundaryProps {
  readonly resetKey: string;
  readonly children: ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
  readonly resetKey: string;
}

class Boundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<BoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override render() {
    return this.state.failed ? <RouteError /> : this.props.children;
  }
}

/** Wraps one route's page; a new path clears a failure. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname}>{children}</Boundary>;
}
