import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_WALLET_WORDS, useWriteGate } from '../src/components/WalletBar';
import { PlatformBar } from '../src/components/PlatformBar';
import { AppProvider } from '../src/lib/app-context';
import type { AppConfig } from '../src/lib/config';
import { readSiteSignIn, SiteSignInProvider, type SiteSignIn } from '../src/lib/site-signin';
import { WalletProvider, type Eip1193 } from '../src/lib/wallet';

/** SH-280 STEP 1: where no wallet can be used, the page says what to do instead of leaving the button's place empty. */

const answer = (status: number, body: unknown, type = 'application/json') => async () =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

describe('the site’s sign-in, as this page learns it (GET /alpha/me)', () => {
  it('on and signed in, on and signed out, off', async () => {
    expect(await readSiteSignIn(answer(200, { status: 'approved', handle: 'ada_builds', claim: null }) as typeof fetch)).toEqual({ state: 'on', handle: 'ada_builds' });
    expect(await readSiteSignIn(answer(401, { error: 'sign in required' }) as typeof fetch)).toEqual({ state: 'on', handle: null });
    // The stack's switch off: the site's own page answers (HTML), or nothing at all.
    expect(await readSiteSignIn(answer(200, '<!doctype html>', 'text/html') as typeof fetch)).toEqual({ state: 'off' });
    expect(await readSiteSignIn(answer(404, { error: 'not found' }) as typeof fetch)).toEqual({ state: 'off' });
    expect(await readSiteSignIn(answer(503, { error: 'down' }) as typeof fetch)).toEqual({ state: 'off' });
    expect(await readSiteSignIn((async () => { throw new TypeError('offline'); }) as typeof fetch)).toEqual({ state: 'off' });
    expect(await readSiteSignIn(answer(200, { status: 'approved', handle: 'not a handle!' }) as typeof fetch)).toEqual({ state: 'off' });
  });

  it('asks its own origin only, with the browser’s own cookie, and nothing of any wallet', async () => {
    const asked: [string, RequestInit | undefined][] = [];
    await readSiteSignIn((async (url: string, init?: RequestInit) => { asked.push([url, init]); return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } }); }) as typeof fetch);
    expect(asked.map(([url, init]) => [url, init?.method, init?.credentials])).toEqual([['/alpha/me', 'GET', 'same-origin']]);
  });
});

const CONFIG = { chainId: 97, rpcUrl: 'http://127.0.0.1:1', rpcUrls: ['http://127.0.0.1:1'], explorer: 'https://testnet.bscscan.com', fromBlock: '0' } as AppConfig;

function Gate(): ReactElement {
  const { ready, gate } = useWriteGate();
  return createElement('div', { 'data-ready': String(ready) }, gate);
}

function render(signIn: SiteSignIn, node: ReactElement): string {
  const wallet = createElement(WalletProvider, { rpcUrls: CONFIG.rpcUrls, explorer: CONFIG.explorer, children: node });
  return renderToStaticMarkup(createElement(SiteSignInProvider, { initial: signIn, children: createElement(AppProvider, { config: CONFIG, children: wallet }) }));
}

const withBrowserWallet = () => {
  const provider: Eip1193 = { request: async () => { throw new Error('asked'); } };
  (globalThis as { window?: unknown }).window = { ethereum: provider };
};
afterEach(() => { delete (globalThis as { window?: unknown }).window; });

describe('the button’s place and the top bar without a wallet (three states)', () => {
  it('no wallet, sign-in on: the join page’s link and the browser-wallet line, in both places', () => {
    const gate = render({ state: 'on', handle: null }, createElement(Gate));
    expect(gate).toContain('data-ready="false"');
    expect(gate).toContain(`href="/join"`);
    expect(gate).toContain(NO_WALLET_WORDS.signIn);
    expect(gate).toContain(NO_WALLET_WORDS.noBrowserWallet);
    const bar = render({ state: 'on', handle: null }, createElement(PlatformBar));
    expect(bar).toMatch(/<a class="sh-topbar__join" href="\/join"[^>]*>.*Sign in with X/);
    expect(bar.indexOf('data-testid="bar-join"')).toBeLessThan(bar.indexOf('class="sh-source-badge"'));
  });

  it('no wallet, sign-in off: the browser-wallet line only; the bar keeps its place empty', () => {
    const gate = render({ state: 'off' }, createElement(Gate));
    expect(gate).toContain(NO_WALLET_WORDS.noBrowserWallet);
    expect(gate).not.toContain('/join');
    expect(gate).not.toContain(NO_WALLET_WORDS.signIn);
    const bar = render({ state: 'off' }, createElement(PlatformBar));
    expect(bar).not.toContain('/join');
    expect(bar).not.toContain('sh-wallet-button');
  });

  it('a browser wallet, as today: "Connect wallet", whatever the sign-in', () => {
    withBrowserWallet();
    for (const signIn of [{ state: 'on', handle: null }, { state: 'off' }] as SiteSignIn[]) {
      const gate = render(signIn, createElement(Gate));
      expect(gate).toContain('Connect wallet');
      expect(gate).not.toContain('/join');
      expect(gate).not.toContain(NO_WALLET_WORDS.noBrowserWallet);
      expect(render(signIn, createElement(PlatformBar))).toContain('data-testid="connect"');
    }
  });
});
