import { ART } from '@squarehole/design';
import { Link } from 'react-router';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';

const box = ART.get('square-hole-box');

/** Not-found page; home of the recurring joke (C02). */
export function NotFoundPage() {
  usePageTitle('Page not found');
  return (
    <section className="sh-page sh-notfound" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-page__header">
        <PageHeading>Page not found</PageHeading>
      </div>
      <div className="sh-panel sh-notfound__panel">
        {box ? <img className="sh-notfound__art" src={box.src} width={box.width} height={box.height} alt={box.alt} /> : null}
        <p>This page doesn’t fit anywhere we know. So where does it go?</p>
        <p className="sh-notfound__joke">That's right. The square hole.</p>
        <p>
          <Link to="/" className="sh-button sh-button--primary">
            Back to the feed
          </Link>
        </p>
      </div>
    </section>
  );
}
