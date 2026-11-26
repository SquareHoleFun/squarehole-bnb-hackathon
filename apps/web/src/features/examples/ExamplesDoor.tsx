import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { Loader } from '../brand';
import { examplesNavigation, examplesPageFor } from './examples-page';

/**
 * SH-252: the route at /examples. It opens the explainer's own page (examples-page.ts) in place of the app, with the
 * place a link names (`/examples#rent-free`); until the browser has left, the app's loader shows with the site's own
 * "Loading…". It sits inside the entry terms gate like every route, so a first visit meets the gate first.
 */
export function ExamplesDoor() {
  const { hash } = useLocation();
  useEffect(() => {
    examplesNavigation.go(examplesPageFor(hash));
  }, [hash]);
  return (
    <section className="sh-page" aria-busy="true">
      <Loader mode="waiting" size="page" label="Loading…" />
    </section>
  );
}
