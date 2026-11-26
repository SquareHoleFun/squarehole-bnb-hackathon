import { Link } from 'react-router';
import { TERMS_PATH, TEST_NETWORK_LINK } from '../../legal';

/**
 * The link that ends a Details panel holding a risk line (SH-ALCHEMIST-LESS-TEXT; founder, 2026-10-01: legal disclosures
 * stay reachable, collapsed, with a link to the Terms): the Terms' risks, Section 6. On the Sepolia test site every legal
 * link goes to the test network notice (SH-TA-02), and so does this one.
 */
export function RisksLink() {
  return (
    <p className="sh-details__terms">
      {TEST_NETWORK_LINK ? <Link to={TERMS_PATH}>{TEST_NETWORK_LINK}</Link> : <Link to={`${TERMS_PATH}#terms-6`}>Terms, Section 6</Link>}
    </p>
  );
}
