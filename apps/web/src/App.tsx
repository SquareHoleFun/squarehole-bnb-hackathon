import { BrowserRouter } from 'react-router';
import { AppProviders } from './app-providers';
import { DataSourceProvider, useDataSource } from './features/data-source';
import { TermsGate } from './features/legal';
import { AppRoutes } from './routes';
import { RevealKeepCleanup } from './features/core/v2/RevealKeepCleanup';

/**
 * Static client (D08): react-router library mode with browser history, one shared query cache.
 *
 * Navigations commit synchronously (`useTransitions={false}`): the app has no Suspense boundaries for a transition to
 * keep, and a transition leaves a window in which the URL has changed but the page has not rendered it. A Back/Forward
 * inside that window returned to a memoised, unchanged location, so the feed controls kept the abandoned choice and the
 * next change was merged into the abandoned URL (FEED-05 "Back/Forward restores the controls").
 *
 * The data source (Settings: demo fixtures, local chain, Sepolia) wraps everything; the providers and routes below are
 * keyed by it, so a switch starts a fresh session (the URL and scroll position stay).
 *
 * The entry terms gate (F19) sits between the router and the routes: until the current Terms are accepted it renders
 * instead of every route but the full Terms and About & risks, so no page mounts behind it (the providers read and
 * request nothing on their own; the one exception, F135's silent reconnect of a remembered browser wallet, waits for the
 * acceptance too, app-providers.tsx).
 */
export function App() {
  return (
    <DataSourceProvider>
      <SourcedApp />
    </DataSourceProvider>
  );
}

function SourcedApp() {
  const { id } = useDataSource();
  return (
    <AppProviders key={id}>
      <BrowserRouter useTransitions={false}>
        <TermsGate>
          <RevealKeepCleanup />
          <AppRoutes />
        </TermsGate>
      </BrowserRouter>
    </AppProviders>
  );
}
