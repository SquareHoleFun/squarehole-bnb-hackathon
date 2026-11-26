import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { PRIVACY_NOTICE, STORED_ON_DEVICE, TERMS_PATH, TermsText, type PrivacySection } from '../features/legal';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';
import { StoredItems } from './stored-items';
import { TestNetworkNoticePage } from './TestNetworkNoticePage';

// The Sepolia test site (SH-TA-02, apps/web/build-target.ts): the test network notice in place of the draft notice.
const TEST_NETWORK_BUILD = !!import.meta.env?.SH_PRODUCTION && import.meta.env?.SH_TEST_NETWORK === true;

/** A section card: a plain <section> with its anchor, not a landmark (as on the Terms page). */
function NoticeSection({ section, children }: { section: PrivacySection; children?: ReactNode }) {
  return (
    <section id={section.id} className="sh-detail-card sh-legal__section">
      <h2 id={`${section.id}-title`} className="sh-detail-card__title">
        {section.title}
      </h2>
      {section.paragraphs?.map((paragraph) => (
        <p key={paragraph}>
          <TermsText text={paragraph} />
        </p>
      ))}
      {section.bullets ? (
        <ul className="sh-legal__bullets">
          {section.bullets.map((bullet) => (
            <li key={bullet}>
              <TermsText text={bullet} />
            </li>
          ))}
        </ul>
      ) : null}
      {children}
    </section>
  );
}

/**
 * `/about/privacy` (Fable review S1): the one-page privacy notice, readable before accepting the Terms (the entry gate
 * never covers this route). Text comes from features/legal/privacy.ts; the list of stored items is checked against the
 * source by privacy.test.ts. The Sepolia test site shows the test network notice here instead (SH-TA-02).
 */
export function PrivacyPage() {
  return TEST_NETWORK_BUILD ? <TestNetworkNoticePage /> : <FullPrivacyPage />;
}

function FullPrivacyPage() {
  usePageTitle('Privacy notice');
  const [device, ...rest] = PRIVACY_NOTICE.sections;
  return (
    <section className="sh-page sh-legal" aria-labelledby={PAGE_TITLE_ID}>
      <div className="sh-detail-card sh-legal__intro">
        {/\bdraft\b/i.test(PRIVACY_NOTICE.status) ? <p className="sh-chip sh-chip--pending">Draft</p> : null}
        <PageHeading>{PRIVACY_NOTICE.title}</PageHeading>
        <p className="sh-legal__status">
          <strong>
            <TermsText text={PRIVACY_NOTICE.status} />
          </strong>
        </p>
        <p className="sh-legal__meta">{PRIVACY_NOTICE.versionLine}</p>
      </div>

      <section className="sh-detail-card sh-legal__section" aria-labelledby="privacy-summary">
        <h2 id="privacy-summary" className="sh-detail-card__title">
          {PRIVACY_NOTICE.summary.title}
        </h2>
        <ul className="sh-legal__bullets">
          {PRIVACY_NOTICE.summary.bullets.map((bullet) => (
            <li key={bullet}>
              <TermsText text={bullet} />
            </li>
          ))}
        </ul>
      </section>

      {device ? (
        <NoticeSection section={device}>
          <StoredItems items={STORED_ON_DEVICE} />
        </NoticeSection>
      ) : null}
      {rest.map((section) => (
        <NoticeSection key={section.id} section={section} />
      ))}

      <p>
        <Link to="/">Back to the feed</Link> · <Link to={TERMS_PATH}>Terms of Use</Link> · <Link to="/about/risks">About &amp; risks</Link>
      </p>
    </section>
  );
}
