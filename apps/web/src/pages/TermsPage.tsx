import { Link, useLocation } from 'react-router';
import { PRIVACY_PATH, TERMS_DOCUMENT, TermsSections, TermsText, termsReturnPath } from '../features/legal';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';
import { TestNetworkNoticePage } from './TestNetworkNoticePage';

// The Sepolia test site (SH-TA-02, apps/web/build-target.ts): the test network notice in place of the draft Terms.
const TEST_NETWORK_BUILD = !!import.meta.env?.SH_PRODUCTION && import.meta.env?.SH_TEST_NETWORK === true;

/**
 * `/about/terms` (F19): the full draft Terms of Use, readable before accepting them (the entry gate never covers this
 * route). Text comes from features/legal/terms.ts, the same source as the gate. Opened from the gate, it leads back to
 * the page the visitor asked for (the gate's link carries it), so accepting there opens that page, not the feed.
 * The Sepolia test site shows the test network notice here instead (SH-TA-02).
 */
export function TermsPage() {
  return TEST_NETWORK_BUILD ? <TestNetworkNoticePage /> : <FullTermsPage />;
}

function FullTermsPage() {
  usePageTitle('Terms of Use');
  const { readFirst } = TERMS_DOCUMENT;
  const back = termsReturnPath(useLocation().state);
  return (
    <section className="sh-page sh-legal" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-detail-card sh-legal__intro">
        {/* The chip goes with the draft status line (SH-V2-FE7: the production text drops both at counsel's sign-off). */}
        {/\bdraft\b/i.test(TERMS_DOCUMENT.status) ? <p className="sh-chip sh-chip--pending">Draft</p> : null}
        <PageHeading>{TERMS_DOCUMENT.title}</PageHeading>
        <p className="sh-legal__status">
          <strong>
            <TermsText text={TERMS_DOCUMENT.status} />
          </strong>
        </p>
        <p className="sh-legal__meta">{TERMS_DOCUMENT.versionLine}</p>
        <p>
          <TermsText text={TERMS_DOCUMENT.disputeNotice} />
        </p>
      </div>

      <section className="sh-detail-card sh-legal__section" aria-labelledby="terms-read-first">
        <h2 id="terms-read-first" className="sh-detail-card__title">
          {readFirst.title}
        </h2>
        <ul className="sh-legal__bullets">
          {readFirst.bullets.map((bullet) => (
            <li key={bullet}>
              <TermsText text={bullet} />
            </li>
          ))}
        </ul>
      </section>

      <TermsSections />

      <p className="sh-legal__status">
        <em>{TERMS_DOCUMENT.closing}</em>
      </p>
      <p>
        {back && back !== '/' ? <Link to={back}>Back to the page you opened</Link> : <Link to="/">Back to the feed</Link>} ·{' '}
        <Link to="/about/risks">About &amp; risks</Link> · <Link to={PRIVACY_PATH}>Privacy notice</Link>
      </p>
    </section>
  );
}
