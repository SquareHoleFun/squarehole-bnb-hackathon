/**
 * SH-258 fix round, finding 2: under `SH_TESTNET=bnb` the test-coin page has no alpha Claim card (no call to the alpha
 * server, no sign-in link, no claim signature) and never resumes a wallet Privy made. BNB Chain testnet's faucet is
 * public: the page offers its drip with its own words ("Get 1 tETH"). Sepolia keeps the card.
 *
 * SH-275: that is now the BNB build WITHOUT a Privy app (the placeholder, alpha-on.ts); with the BNB site's own app the
 * card is there, with the starter in tBNB, and the made wallet's resume is mounted.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('./made-wallet');
  vi.doUnmock('./TradeBox');
  vi.doUnmock('../alpha-sepolia/privy-config');
});

/** SH-275: the build's Privy app as the placeholder (a BNB build without its own app). */
function noPrivyApp() {
  vi.doMock('../alpha-sepolia/privy-config', async (actual) => {
    const real = await actual<typeof import('../alpha-sepolia/privy-config')>();
    return { ...real, PRIVY_APP_ID: real.PRIVY_APP_ID_PLACEHOLDER, privyAppIdOf: () => null };
  });
}

/** Calls of the wallet resume's hook (made-wallet.ts), counted at the module boundary the pages import. */
const resumes = vi.fn();
function countResumes() {
  resumes.mockClear();
  vi.doMock('./made-wallet', async (actual) => {
    const real = await actual<typeof import('./made-wallet')>();
    const useMadeWalletResume = () => { resumes(); };
    return { ...real, useMadeWalletResume, MadeWalletResume: () => { useMadeWalletResume(); return null; } };
  });
}

async function renderPage(bnb: boolean, app = true) {
  if (bnb) vi.stubEnv('SH_TESTNET', 'bnb');
  vi.resetModules();
  countResumes();
  if (!app) noPrivyApp();
  const fetcher = vi.fn(async () => new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const [{ TestCoinPage }, { AppProviders }, { createDemoWalletAdapter }] = await Promise.all([
    import('./TestCoinPage'), import('../../app-providers'), import('../wallet'),
  ]);
  render(<AppProviders walletAdapter={createDemoWalletAdapter({ latencyMs: 0 })}><MemoryRouter><TestCoinPage target={{ reason: 'deployment_predicted' }} /></MemoryRouter></AppProviders>);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const urls = () => fetcher.mock.calls.map((call) => String((call as unknown[])[0]));
  return { urls };
}

describe('the test-coin page and the alpha', () => {
  it('SH_TESTNET=bnb without a Privy app: no Claim card, nothing asked of the alpha server, no sign-in link', async () => {
    const { urls } = await renderPage(true, false);
    expect(screen.getByRole('status').textContent).toBe('Test coins are not live yet.');
    expect(urls().filter((url) => url.includes('/alpha/'))).toEqual([]);
    expect(document.querySelector('a[href*="/join"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Claim|Sign in|SepETH|Privy/);
    // Re-read finding 11: the wallet resume is not mounted at all.
    expect(resumes).not.toHaveBeenCalled();
  });

  it('SH-275: SH_TESTNET=bnb with its own Privy app: the Claim card asks who is signed in and names the starter in tBNB', async () => {
    const { urls } = await renderPage(true);
    await vi.waitFor(() => expect(urls().some((url) => url.includes('/alpha/me'))).toBe(true));
    await vi.waitFor(() => expect(screen.getByRole('region', { name: 'Claim' }).textContent).toContain('Starter tBNB, for one wallet.'));
    expect(document.querySelector('a[href="/join"]')?.textContent).toBe('Open the sign-in page');
    expect(document.body.textContent).not.toMatch(/SepETH|Sepolia/);
    expect(resumes).toHaveBeenCalled();
  });

  it('the trade slot: no wallet resume on BNB Chain testnet without a Privy app, the resume on Sepolia and (SH-275) on BNB with its app', async () => {
    for (const [bnb, app] of [[true, false], [false, true], [true, true]] as const) {
      vi.unstubAllEnvs();
      if (bnb) vi.stubEnv('SH_TESTNET', 'bnb');
      vi.resetModules();
      countResumes();
      vi.doUnmock('../alpha-sepolia/privy-config');
      if (!app) noPrivyApp();
      vi.doMock('./TradeBox', () => ({ TradeBox: () => <p>trade box</p> }));
      const { default: TradeSlot } = await import('./TradeSlot');
      render(<TradeSlot {...({} as Parameters<typeof TradeSlot>[0])} />);
      expect(screen.getByText('trade box')).toBeTruthy();
      expect(resumes.mock.calls.length > 0).toBe(app);
      cleanup();
    }
  });

  it('the default build (Sepolia) keeps the Claim card, which asks the alpha server who is signed in', async () => {
    const { urls } = await renderPage(false);
    await vi.waitFor(() => expect(urls().some((url) => url.includes('/alpha/'))).toBe(true));
    expect(resumes).toHaveBeenCalled();
  });

  it('the alpha switch the page and the wallet resume read (SH-275: alpha-on.ts)', async () => {
    vi.stubEnv('SH_TESTNET', 'bnb');
    vi.resetModules();
    const { TESTNET } = await import('@squarehole/chain/write/wallet');
    const { ALPHA_ON, ALPHA_OPEN, alphaOn } = await import('../alpha-sepolia/alpha-on');
    expect([TESTNET.switches.alphaGate, TESTNET.switches.alphaOpen]).toEqual([true, true]);
    expect([ALPHA_ON, ALPHA_OPEN]).toEqual([true, true]);
    // The placeholder turns the open-site alpha off; Sepolia's closed alpha does not depend on it (as before).
    expect(alphaOn(TESTNET.switches, null)).toBe(false);
    expect(alphaOn({ alphaGate: true, alphaOpen: false }, null)).toBe(true);
    expect(alphaOn({ alphaGate: false, alphaOpen: false }, 'cmwwb2y9p00gv0gl9m9im0uve')).toBe(false);
  });
});
