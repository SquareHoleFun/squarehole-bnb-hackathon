import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { STORED_ON_DEVICE, TEST_NETWORK_LINK, TEST_NETWORK_NOTICE, TERMS_VERSION } from '../features/legal';
import { appCopyFraming, renderedCopy } from '../features/legal/wording';
import { TestNetworkNoticePage } from './TestNetworkNoticePage';

afterEach(cleanup);

/**
 * The page the Sepolia test site shows on /about/terms and /about/privacy (SH-TA-02). The unit tests run the development
 * modules (vitest defines no build flag), so the page is rendered directly here; the Sepolia test build itself is
 * checked by build-target.test.ts and e2e/production/production-test-network.spec.ts.
 */
describe('the test network notice page (SH-TA-02)', () => {
  it('shows the notice: title, the eleven points of version 3, its data part and its version, with no open item, Demo or Draft mark', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/about/terms']}>
        <TestNetworkNoticePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Test network notice' })).toBeTruthy();
    expect(document.title).toBe('Test network notice · Square Hole');
    const text = container.textContent ?? '';
    expect(text).toContain('It runs on the Sepolia test network only.');
    expect(text).toContain('Version 2026-11-20-sepolia-test-6 · 20 November 2026');
    const points = screen.getByRole('region', { name: 'In short' }).querySelectorAll('li');
    expect(Array.from(points, (point) => point.textContent)).toEqual(TEST_NETWORK_NOTICE.points.map((point) => point.replaceAll('**', '')));
    expect(points).toHaveLength(11);
    // The lead words are bold, the rest plain: one <strong> per point.
    expect(Array.from(points, (point) => point.querySelector('strong')?.textContent)).toEqual(TEST_NETWORK_NOTICE.points.map((point) => /^\*\*([^*]+)\*\*/.exec(point)?.[1]));
    expect(text).toContain('The smart contracts have not been audited by an outside firm. Our own reviews are not audits.');
    expect(text).toContain('Nothing on this site uses real money.');
    expect(text).toContain('The full Terms of Use come before Square Hole runs on mainnet.');
    // SH-ALPHA-NOTICE (F156, F157) and SH-ALPHA-SITE (F161 (4)): the closed alpha's points, as a tester reads them.
    for (const line of [
      'Closed alpha. You sign in with X. We let in the X accounts we approve.',
      'Test trades only. Box pages buy and sell test tokens only.',
      'Launch tax. In a box’s first 6.4 minutes, a tax takes 93.2% of a buy at first, falling to 8.1%.',
      'tETH. A test token with no value. Its faucet opens for the wallet you claim with.',
      'The alpha gives no points or prizes.',
      'We hide a picture on this site only if it is illegal or comes with a legal notice. Its copies on Arweave stay where they are.',
      'Contact. hello@squarehole.fun, for questions, feedback and legal notices.',
    ]) {
      expect(text, line).toContain(line);
    }
    const data = screen.getByRole('region', { name: 'Your data' });
    expect(data.textContent).toContain('You sign in with X through Privy, a Stripe company. X shows Privy’s name. Privy and our server log sign-ins.');
    expect(data.textContent).toContain('A wallet Privy makes for you is yours. You and Privy hold its key, and we cannot move its coins. Export the key to keep it after the alpha.');
    expect(data.textContent).not.toMatch(/Cloudflare Access|one-time code/);
    expect(data.textContent).not.toMatch(/do not sign up|no accounts/i);
    for (const item of STORED_ON_DEVICE) expect(data.textContent, item.key).toContain(item.key);
    // The stored items stay behind their disclosure, closed until opened.
    expect(data.querySelector('details')?.open).toBe(false);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(container.querySelector('.sh-chip')).toBeNull();
    // Case matters: a stored key of the development build is named "draft" (sh.create.draft.v2), never shown as a mark.
    expect(text).not.toMatch(/\[(?:COUNSEL|FOUNDER|ENGINEERING)|\b[Dd]emo\b|\bDEMO\b|\bDraft\b|\bDRAFT\b/);
    expect(appCopyFraming(renderedCopy(container))).toEqual([]);
  });

  it('is not what the development build shows: there the full draft Terms and their links stay', () => {
    expect(TEST_NETWORK_LINK).toBeNull();
    expect(TERMS_VERSION).not.toBe(TEST_NETWORK_NOTICE.version);
  });
});
