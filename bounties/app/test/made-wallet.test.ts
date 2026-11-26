import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NO_WALLET_WORDS, NoWallet, SET_UP_PATH } from '../src/components/WalletBar';
import { guardSends } from '../src/lib/app-context';
import { PageRefusal } from '../src/lib/errors';
import { CEILING_WEI, sendFees97, withFees } from '../src/lib/fees';
import { PRIVY_TOKEN_ITEM, shouldLoadPrivy } from '../src/lib/privy-load';
import { PRIVY_CHAIN, PRIVY_CLIENT_CONFIG } from '../src/lib/privy-settings';
import { walletKindOf, type Eip1193 } from '../src/lib/wallet';
import { platformPrivyAppId } from '../vite.config';

/** SH-280 STEP 2: the made wallet on the launch pages. */
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

describe('which wallet (the platform’s rule: the made wallet, never over the person’s choice)', () => {
  it('made, browser, none', () => {
    expect(walletKindOf(true, true, null)).toBe('made');
    expect(walletKindOf(true, false, null)).toBe('made');
    expect(walletKindOf(false, true, null)).toBe('browser');
    expect(walletKindOf(false, false, null)).toBeNull();
    // The person chose the browser wallet on this page: it stays, while it exists.
    expect(walletKindOf(true, true, 'browser')).toBe('browser');
    expect(walletKindOf(true, false, 'browser')).toBe('made');
  });
});

describe('when Privy loads at all', () => {
  const store = (items: Record<string, string>) => ({ getItem: (key: string) => items[key] ?? null });
  it('only with the site’s sign-in on AND Privy’s token in this browser, and an app id', () => {
    const app = 'cmwwb2y9p00gv0gl9m9im0uve';
    expect(shouldLoadPrivy({ state: 'on', handle: 'ada_builds' }, store({ [PRIVY_TOKEN_ITEM]: 'x' }), app, false)).toBe(true);
    expect(shouldLoadPrivy({ state: 'on', handle: null }, store({ [PRIVY_TOKEN_ITEM]: 'x' }), app, false)).toBe(true);
    expect(shouldLoadPrivy({ state: 'on', handle: 'ada_builds' }, store({}), app, false)).toBe(false);
    expect(shouldLoadPrivy({ state: 'off' }, store({ [PRIVY_TOKEN_ITEM]: 'x' }), app, false)).toBe(false);
    expect(shouldLoadPrivy({ state: 'checking' }, store({ [PRIVY_TOKEN_ITEM]: 'x' }), app, false)).toBe(false);
    expect(shouldLoadPrivy({ state: 'on', handle: 'ada_builds' }, store({ [PRIVY_TOKEN_ITEM]: 'x' }), null, false)).toBe(false);
    expect(shouldLoadPrivy({ state: 'on', handle: 'ada_builds' }, null, app, false)).toBe(false);
  });
  it('the token item is the one the platform names (privy-storage.ts)', () => {
    expect(readFileSync(repo('apps/web/src/features/alpha-sepolia/privy-storage.ts'), 'utf8')).toContain(`privy('${PRIVY_TOKEN_ITEM}', 'localStorage'`);
  });
});

describe('the settings and the build are the platform’s', () => {
  it('the app id comes from the platform’s own file (no copy here)', () => {
    expect(platformPrivyAppId()).toBe('cmwwb2y9p00gv0gl9m9im0uve');
    expect(platformPrivyAppId('/nonexistent/privy-config.ts')).toBeNull();
  });
  it('chain 97 as the platform’s profile has it (read as text: the launch stage builds without packages/)', () => {
    const source = readFileSync(repo('packages/chain/src/config/testnet-profile.ts'), 'utf8');
    const bnb = source.slice(source.indexOf('const BNB: TestnetProfile = {'), source.indexOf('};', source.indexOf('const BNB: TestnetProfile = {')));
    const explorer = /const BNB_EXPLORER = '([^']+)';/.exec(source)?.[1];
    expect(PRIVY_CHAIN.id).toBe(97);
    expect(bnb).toContain('chainId: BNB_TESTNET_CHAIN_ID,');
    expect(source).toContain('export const BNB_TESTNET_CHAIN_ID = 97;');
    expect(bnb).toContain(`networkName: '${PRIVY_CHAIN.name}',`);
    expect(bnb).toContain(`coin: { name: '${PRIVY_CHAIN.nativeCurrency.name}', walletSymbol: '${PRIVY_CHAIN.nativeCurrency.symbol}', symbol: 'BNB' },`);
    expect(bnb).toContain(`publicRpcUrls: [${PRIVY_CHAIN.rpcUrls.default.http.map((u) => `'${u}'`).join(', ')}],`);
    expect(bnb).toContain(`explorers: [{ id: 'bscscan-testnet', name: '${PRIVY_CHAIN.blockExplorers?.default.name}', origin: BNB_EXPLORER }],`);
    expect(explorer).toBe(PRIVY_CHAIN.blockExplorers?.default.url);
  });
  it('the client settings are privy-live.tsx’s, line for line', () => {
    const live = readFileSync(repo('apps/web/src/features/trade-sepolia/privy-live.tsx'), 'utf8');
    for (const line of ["loginMethods: ['twitter']", "appearance: { theme: 'dark', walletChainType: 'ethereum-only' }", "embeddedWallets: { ethereum: { createOnLogin: 'off' }, showWalletUIs: false }",
      'externalWallets: { walletConnect: { enabled: false }, disableAllExternalWallets: true }', "sessions: { cookieWriteBehavior: 'never' }"]) expect(live).toContain(line);
    expect(PRIVY_CLIENT_CONFIG).toMatchObject({ loginMethods: ['twitter'], appearance: { theme: 'dark', walletChainType: 'ethereum-only' }, embeddedWallets: { ethereum: { createOnLogin: 'off' }, showWalletUIs: false },
      externalWallets: { walletConnect: { enabled: false }, disableAllExternalWallets: true }, sessions: { cookieWriteBehavior: 'never' }, defaultChain: PRIVY_CHAIN, supportedChains: [PRIVY_CHAIN] });
  });
  it('the build’s Privy plugins and the notices inventory are the platform’s files, byte for byte', () => {
    for (const name of ['privy-trims.ts', 'privy-fixes.ts', 'third-party-notices.ts', 'notice-overrides.json']) {
      expect(readFileSync(new URL(`../build/${name}`, import.meta.url), 'utf8')).toBe(readFileSync(repo(`apps/web/build/${name}`), 'utf8'));
    }
  });
});

describe('fees: set by the page for every send (the platform’s rule for chain 97)', () => {
  it('both fields from the chain’s price plus a tenth; refused without a price or above 5 gwei', () => {
    expect(sendFees97(0n, 0n, 100_000_000n)).toEqual({ maxPriorityFeePerGas: 110_000_000n, maxFeePerGas: 110_000_000n });
    expect(sendFees97(0n, 200_000_000n, 100_000_000n)).toEqual({ maxPriorityFeePerGas: 220_000_000n, maxFeePerGas: 220_000_000n });
    expect(sendFees97(7n, 0n, 100_000_000n).maxFeePerGas).toBe(110_000_014n);
    expect(sendFees97(0n, 0n, CEILING_WEI).maxPriorityFeePerGas).toBe(CEILING_WEI);
    const refusal = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof PageRefusal ? e.refusal : 'other'; } return null; };
    expect(refusal(() => sendFees97(0n, 0n, null))).toBe('no-price');
    expect(refusal(() => sendFees97(0n, 0n, 0n))).toBe('no-price');
    expect(refusal(() => sendFees97(0n, 0n, CEILING_WEI + 1n))).toBe('price-above-ceiling');
  });
  it('the guard hands the wallet both fields and no legacy price', async () => {
    const asked: unknown[] = [];
    const eth: Eip1193 = { request: async (args) => { asked.push(args); return '0xhash'; } };
    const guarded = guardSends(eth, '0x00000000000000000000000000000000000a1b2c', () => undefined, () => undefined, async () => null,
      async () => sendFees97(0n, 0n, 100_000_000n));
    await guarded.request({ method: 'eth_sendTransaction', params: [{ to: '0x0000000000000000000000000000000000000001', gasPrice: '0x1', type: '0x0', gas: '0x5208' }] });
    const [tx] = (asked[0] as { params: Record<string, unknown>[] }).params;
    expect(tx).toMatchObject({ maxFeePerGas: '0x68e7780', maxPriorityFeePerGas: '0x68e7780', gas: '0x5208', chainId: '0x61' });
    expect(tx).not.toHaveProperty('gasPrice');
    expect(tx).not.toHaveProperty('type');
    expect(withFees({ gasPrice: '0x1' }, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toEqual({ maxFeePerGas: '0x1', maxPriorityFeePerGas: '0x1' });
  });
});

describe('without a wallet, signed in with X but no wallet Privy made: the platform’s “Set me up”', () => {
  it('links the page whose Claim card offers it', () => {
    const html = renderToStaticMarkup(createElement(NoWallet, { signIn: { state: 'on', handle: 'ada_builds' } }));
    expect(html).toContain(`href="${SET_UP_PATH}"`);
    expect(html).toContain(NO_WALLET_WORDS.setUp);
    expect(html).not.toContain('/join');
    // While Privy is still read, nothing is said.
    expect(renderToStaticMarkup(createElement(NoWallet, { signIn: { state: 'on', handle: 'ada_builds' }, pending: true }))).not.toContain(NO_WALLET_WORDS.noBrowserWallet);
  });
});
