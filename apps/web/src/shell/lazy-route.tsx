import { Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { Loader } from '../features/brand';
import { focusHeadingIfRequested } from './heading-focus';
import { RouteErrorBoundary } from './route-error';

function Loading({ what }: { what: string }) {
  return (
    <section className="sh-page" aria-busy="true">
      <Loader mode="waiting" size="page" label={`Loading ${what}…`} />
    </section>
  );
}

/** Rendered after the page inside its boundary: its effect runs once the page itself is on screen. */
function HeadingFocusOnShow() {
  useEffect(() => {
    focusHeadingIfRequested();
  }, []);
  return null;
}

/**
 * A lazy page in its own Suspense boundary, with the logo loader and "Loading …" while its chunk loads. Once the page has rendered it takes
 * over the Shell's focus request (the heading was not there when the route changed). A page that fails to render (or
 * whose chunk fails to load) shows "This page hit a problem" instead of blanking the app (route-error.tsx).
 *
 * The boundary is keyed by the page: two lazy routes would otherwise share one boundary, and leaving one for another
 * whose chunk is still loading would keep the old page mounted (hidden) behind the loader, where the Shell would find
 * and "focus" its hidden heading, leaving focus on nothing once the new page arrived.
 */
export function lazyRoute<P extends object>(Page: ComponentType<P>, what: string, props: P): ReactNode {
  return (
    <RouteErrorBoundary key={what}>
      <Suspense key={what} fallback={<Loading what={what} />}>
        <Page {...props} />
        {/* Keyed per route: a boundary reused by the next lazy route still runs this effect again for the new page. */}
        <HeadingFocusOnShow key={what} />
      </Suspense>
    </RouteErrorBoundary>
  );
}
