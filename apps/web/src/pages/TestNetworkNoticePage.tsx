import { Link } from 'react-router';
import { STORED_ON_DEVICE, TEST_NETWORK_NOTICE, TermsText, type StoredItem, type TestNetworkNotice } from '../features/legal';
import { PAGE_TITLE_ID, PageHeading, usePageTitle } from './page-parts';
import { StoredItems } from './stored-items';

/**
 * The test network notice (SH-TA-02): on the Sepolia test site (`SH_TARGET=sepolia`, apps/web/build-target.ts) both
 * `/about/terms` and `/about/privacy` show it in place of the draft production Terms and privacy notice, and every
 * legal link points here. Text from features/legal/test-network.ts. Readable before accepting it (GATE_FREE_PATHS).
 */
export function TestNetworkNoticePage({ notice = TEST_NETWORK_NOTICE, stored = STORED_ON_DEVICE }: { notice?: TestNetworkNotice; stored?: readonly StoredItem[] }) {
  usePageTitle(notice.title);
  return (
    <section className="sh-page sh-legal" aria-labelledby={PAGE_TITLE_ID} data-legal="test-network">
      <div className="sh-detail-card sh-legal__intro">
        <PageHeading>{notice.title}</PageHeading>
        <p className="sh-legal__status">
          <strong>{notice.lede}</strong>
        </p>
        <p className="sh-legal__meta">{notice.versionLine}</p>
      </div>

      <section className="sh-detail-card sh-legal__section" aria-labelledby="notice-points">
        <h2 id="notice-points" className="sh-detail-card__title">
          {notice.document.readFirst.title}
        </h2>
        <ul className="sh-legal__bullets">
          {notice.points.map((point) => (
            <li key={point}>
              <TermsText text={point} />
            </li>
          ))}
        </ul>
      </section>

      <section id="notice-privacy" className="sh-detail-card sh-legal__section" aria-labelledby="notice-privacy-title">
        <h2 id="notice-privacy-title" className="sh-detail-card__title">
          {notice.privacy.title}
        </h2>
        <ul className="sh-legal__bullets">
          {notice.privacy.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
        {/* The stored items are details on demand: the notice itself stays short. */}
        <details className="sh-legal__details">
          <summary className="sh-legal__subtitle">{notice.privacy.deviceTitle}</summary>
          <p>{notice.privacy.device}</p>
          <StoredItems items={stored} />
        </details>
      </section>

      <p>
        <Link to="/">Back to the feed</Link> · <Link to="/about/risks">About &amp; risks</Link>
        {/* SH-THIRD-PARTY-NOTICES integrator request 2: the file every production build carries at its root (G07). */}
        {import.meta.env?.SH_PRODUCTION ? <> · <a href={`${import.meta.env.BASE_URL}third-party-notices.txt`}>Third-party notices</a></> : null}
      </p>
    </section>
  );
}
