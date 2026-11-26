/**
 * LINKS-WEB acceptance tests (docs/design/box-links-v2.md § 7 "LINKS-WEB", tests 1 to 7; the POST is mocked): bad data
 * never breaks a card, the row (the whole host, @handle, t.me/name, the exact link attributes), Edit or Add links for the
 * creator only with no request on page load, the one `eth_signTypedData_v4` against the pinned vector (v 0 or 1
 * normalized), `issuedAt` = max(asOf, saved + 1) and Sign again after a 409, sending (waits for the feed, 503 and 429
 * waits, 2 minutes then Try again with the same signature, never more than 10 POSTs a minute), and the card after
 * Create. Test 1's feed-wide half is in indexer-v2.test.ts; test 8 is e2e/core-v2-chain/create-v2-links.spec.mjs.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect } from 'react';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address } from '@squarehole/domain';
import { createQueryClient } from '../../../app-providers';
import { BROWSER_WALLET_ID, WalletProvider, createInjectedWalletAdapter, useWallet, type WalletContextValue } from '../../wallet';
import { BoxLinksAfterCreate, BoxLinksV2, LINKS_WORDS, type BoxLinksV2Props } from './BoxLinksV2';
import {
  LINKS_SEND, PostLimiter, canonicalLinks, fieldsOf, linkItems, linksBody, nextIssuedAt, parseLinksV2, retryAfterMs, savedLinksOf, sendLinks,
  type LinksFetch, type SendLinksOptions, type ShownLinks,
} from './box-links';
import { feedReadsStarted, readFeedV2, type V2Source } from './indexer-v2';
import { publishedV2 } from './test-support/published-v2';
import type { BoxLinks } from '../../../../../../packages/chain/src/core/v2';

const HERE = dirname(fileURLToPath(import.meta.url));
// The vector both links tickets pin (packages/chain/src/core/v2/box-links-v2.test.ts).
// Anvil's accounts 0 and 1: the public Foundry and Hardhat development keys.
const ANVIL_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CREATOR = privateKeyToAccount(ANVIL_0).address as Address;
const OTHER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d').address as Address;
const SEPOLIA = 11155111;
const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
const VECTOR = { website: 'https://junkyard.fun', x: 'Junk_yard', telegram: 'junkyard' };
const ISSUED = 1761300000n;
const DIGEST = '0x3ee7daa83f48c332b7fccac94f8e94f89f6352e8072583318e2e72097bed86f1';
const SIGNATURE = '0xc2d0a83af6fe0e097b39a042b1e5fe56184a621be711cc968e0263d7a2ed4f590cea0ad7e60e38f02a6a9652805470c19e68dc0484b741c5ab06df3df62ea73e1c';
const ORIGIN = 'https://indexer.links.test';
const SOURCE = { origin: ORIGIN, manifest: { chainId: SEPOLIA } } as unknown as Pick<V2Source, 'origin' | 'manifest'>;
const LINKS_URL = `${ORIGIN}/v2/boxes/${SEPOLIA}/${TOKEN}/links`;
const TRUST_WORDS = /\b(verified|trusted|official|safe)\b/i;

type Json = Record<string, unknown>;
const shown = (links: Partial<ShownLinks> = {}): ShownLinks => ({ ...VECTOR, issuedAt: ISSUED, ...links });

/** A JSON-RPC-shaped answer of the links endpoint. */
function reply(status: number, body: unknown = null, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers), json: async () => body };
}
const viewBody = (record: Json | null) => ({ schema: 'sh.box-links.v1', chainId: SEPOLIA, token: TOKEN, creator: CREATOR.toLowerCase(), record });

/**
 * A browser wallet holding one account (Anvil account 0 by default): it records every request and signs what it is
 * sent with EIP-712. `answer` rewrites the signature (v 0 or 1, a contract wallet); `refuse` is an EIP-1193 error code.
 */
class SigningWallet {
  requests: string[] = [];
  typed: Json[] = [];
  chainId = SEPOLIA;
  answer: ((signature: Hex) => unknown) | null = null;
  refuse: number | null = null;
  /** How long the signature takes (a Safe collecting its owners' signatures); 0 answers at once. */
  delayMs = 0;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  constructor(readonly key: Hex = ANVIL_0) {}
  get address(): Address { return privateKeyToAccount(this.key).address as Address; }
  request = async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    this.requests.push(method);
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [this.address];
    if (method === 'eth_chainId') return `0x${this.chainId.toString(16)}`;
    if (method === 'wallet_switchEthereumChain') {
      this.chainId = Number(BigInt((params as [{ chainId: string }])[0].chainId));
      this.listeners.get('chainChanged')?.forEach((listener) => listener(`0x${this.chainId.toString(16)}`));
      return null;
    }
    if (method === 'wallet_revokePermissions') return null;
    if (method !== 'eth_signTypedData_v4') throw Object.assign(new Error('Unsupported method'), { code: 4200 });
    if (this.refuse !== null) throw Object.assign(new Error('refused'), { code: this.refuse });
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const [from, text] = params as [string, string];
    expect(from).toBe(this.address);
    const data = JSON.parse(text) as Json & { domain: Json & { chainId: number }; message: Json & { issuedAt: string } };
    this.typed.push(data);
    const signature = await privateKeyToAccount(this.key).signTypedData({ ...data, domain: { ...data.domain, chainId: BigInt(data.domain.chainId) }, message: { ...data.message, issuedAt: BigInt(data.message.issuedAt) } } as never);
    return this.answer ? this.answer(signature) : signature;
  };
  on(event: string, listener: (...args: unknown[]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); }
  signs(): number { return this.requests.filter((method) => method === 'eth_signTypedData_v4').length; }
}

const live = {} as { wallet: WalletContextValue };
function Probe() {
  const wallet = useWallet();
  useEffect(() => { live.wallet = wallet; });
  return null;
}

let wallet: SigningWallet;
let posts: { url: string; init: RequestInit }[];
let answers: (() => ReturnType<typeof reply> | Promise<never>)[];
let limiter: PostLimiter;
const post: LinksFetch = async (url, init) => {
  posts.push({ url, init });
  const next = answers.shift() ?? (() => reply(200, viewBody(null)));
  return next() as never;
};
const bodies = () => posts.map((p) => JSON.parse(String(p.init.body)) as Record<string, string>);

beforeEach(() => {
  wallet = new SigningWallet();
  posts = [];
  answers = [];
  limiter = new PostLimiter();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderLinks(props: Partial<BoxLinksV2Props> = {}) {
  const target = Object.assign(new EventTarget(), { ethereum: wallet });
  const storage = new Map<string, string>();
  const injectedAdapter = createInjectedWalletAdapter({ target: target as unknown as Window, storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => void storage.set(k, v), removeItem: (k) => void storage.delete(k) } });
  const client = createQueryClient();
  const all = (p: Partial<BoxLinksV2Props>): BoxLinksV2Props => ({ source: SOURCE, token: TOKEN, creator: CREATOR, inFeed: true, links: null, asOf: ISSUED, post, limiter, ...p });
  const tree = (p: Partial<BoxLinksV2Props>) => (
    <QueryClientProvider client={client}>
      <WalletProvider injectedAdapter={injectedAdapter} defaultDialog="browser" walletKinds="browser" targetChainId={SEPOLIA}>
        <Probe />
        <BoxLinksV2 {...all(p)} />
      </WalletProvider>
    </QueryClientProvider>
  );
  const view = render(tree(props));
  return { ...view, rerender: (next: Partial<BoxLinksV2Props>) => view.rerender(tree({ ...props, ...next })) };
}
const connect = () => act(async () => { await live.wallet.connectBrowserWallet(BROWSER_WALLET_ID); });
const click = (name: string) => act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
const settle = () => act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
const fill = (label: string, value: string) => fireEvent.change(screen.getByRole('textbox', { name: label }), { target: { value } });
async function signVectorInEditor() {
  await click(LINKS_WORDS.add);
  fill('Website', ' https://junkyard.fun ');
  fill('X', '@Junk_yard');
  fill('Telegram', 't.me/junkyard');
  await click(LINKS_WORDS.sign);
  await settle();
}

describe('LINKS-WEB 1: bad data parses to null and never throws', () => {
  it('reads a well-formed value and refuses every malformed one', () => {
    expect(parseLinksV2({ ...VECTOR, issuedAt: '1761300000' })).toEqual(shown());
    expect(parseLinksV2({ website: '', x: 'h', telegram: '', issuedAt: '0' })).toEqual({ website: '', x: 'h', telegram: '', issuedAt: 0n });
    const hostile = { get website() { throw new Error('no'); }, x: 'h', telegram: '', issuedAt: '1' };
    [
      undefined, null, 'links', 7, [], [VECTOR], { ...VECTOR }, { x: 'h', telegram: '', issuedAt: '1' }, { ...VECTOR, website: 1, issuedAt: '1' },
      { ...VECTOR, website: 'https://A.com/', issuedAt: '1' }, { ...VECTOR, x: '@h', issuedAt: '1' }, { ...VECTOR, telegram: 't.me/name', issuedAt: '1' },
      { ...VECTOR, website: 'http://a.com', issuedAt: '1' }, { ...VECTOR, website: 'https://localhost', issuedAt: '1' },
      { ...VECTOR, issuedAt: 1761300000 }, { ...VECTOR, issuedAt: '1e9' }, { ...VECTOR, issuedAt: '01' }, { ...VECTOR, issuedAt: (1n << 64n).toString() },
      { website: '', x: '', telegram: '', issuedAt: '1' }, hostile,
    ].forEach((bad, at) => expect(() => parseLinksV2(bad), `case ${at}`).not.toThrow());
    for (const bad of [undefined, null, 'links', { ...VECTOR }, { ...VECTOR, x: '@h', issuedAt: '1' }, { ...VECTOR, issuedAt: '1e9' }, { website: '', x: '', telegram: '', issuedAt: '1' }, hostile]) {
      expect(parseLinksV2(bad)).toBeNull();
    }
  });

  it('a POST answer is read only when it is this box’s sh.box-links.v1 body', () => {
    const record = { ...VECTOR, issuedAt: '1761300000', signature: SIGNATURE, signerKind: 'eoa', verifiedBlock: '9' };
    expect(savedLinksOf(viewBody(record), SEPOLIA, TOKEN)).toEqual({ kind: 'saved', links: shown() });
    expect(savedLinksOf(viewBody(null), SEPOLIA, TOKEN)).toEqual({ kind: 'saved', links: null });
    // Fix round 2 (F4): `verifiedBlock` is never read (the server takes it before it checks and writes).
    expect(savedLinksOf(viewBody({ ...record, verifiedBlock: 'not a block' }), SEPOLIA, TOKEN)).toEqual({ kind: 'saved', links: shown() });
    for (const bad of [null, [], { ...viewBody(record), schema: 'x' }, { ...viewBody(record), chainId: 1 }, { ...viewBody(record), token: OTHER }, viewBody({ ...record, x: '@x' })]) {
      expect(savedLinksOf(bad, SEPOLIA, TOKEN)).toBeUndefined();
    }
  });
});

describe('LINKS-WEB 2: the row', () => {
  it('shows the whole hostname, @handle and t.me/name, each a plain link with exactly these attributes', () => {
    const long = shown({ website: 'https://junkyard.fun.other.example.com/a?b=c#d' });
    renderLinks({ links: long });
    const row = document.querySelector('.sh-v2-links') as HTMLElement;
    expect(row.textContent).toBe('junkyard.fun.other.example.com · @Junk_yard · t.me/junkyard');
    const anchors = within(row).getAllByRole('link');
    expect(anchors.map((a) => [a.textContent, a.getAttribute('href'), a.getAttribute('title')])).toEqual([
      ['junkyard.fun.other.example.com', long.website, long.website],
      ['@Junk_yard', 'https://x.com/Junk_yard', 'https://x.com/Junk_yard'],
      ['t.me/junkyard', 'https://t.me/junkyard', 'https://t.me/junkyard'],
    ]);
    for (const a of anchors) {
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
      expect(a.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(a.getAttribute('target')).toBe('_blank');
    }
    // Nothing labels the links: no badge, no "verified" (F149).
    expect(document.body.textContent).not.toMatch(TRUST_WORDS);
    expect(document.querySelectorAll('[title]').length).toBe(3);
  });

  it('wraps the host and never cuts it (no ellipsis, no nowrap, no hidden overflow in the links rules)', () => {
    const css = readFileSync(join(HERE, 'v2-page.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.sh-v2-links[^{}]*)\{([^}]*)\}/g)].map((m) => [m[1]?.trim() ?? '', m[2] ?? ''] as const);
    expect(rules.length).toBeGreaterThan(3);
    expect(rules.find(([selector]) => selector === '.sh-v2-links')?.[1]).toMatch(/overflow-wrap:\s*anywhere/);
    for (const [selector, body] of rules) expect(body, selector).not.toMatch(/text-overflow|ellipsis|nowrap|overflow:\s*hidden|line-clamp/);
  });

  it('only canonical values become links; an empty row renders nothing', () => {
    expect(linkItems({ website: 'javascript:alert(1)', x: 'a b', telegram: '+abc' })).toEqual([]);
    expect(linkItems({ website: '', x: 'h', telegram: '' })).toEqual([{ key: 'x', text: '@h', href: 'https://x.com/h' }]);
    renderLinks({ links: null });
    expect(document.querySelector('.sh-v2-links')).toBeNull();
  });
});

describe('LINKS-WEB 3: Edit or Add links only for the creator; loading asks nothing', () => {
  it('nobody connected, another account, then the creator: Add links without links, Edit links with them', async () => {
    const view = renderLinks({ links: shown() });
    expect(screen.queryByRole('button')).toBeNull();
    expect(wallet.requests).toEqual([]);
    expect(posts).toEqual([]);
    view.unmount();

    wallet = new SigningWallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const other = renderLinks({ links: shown() });
    await connect();
    expect(live.wallet.account).toBe(OTHER);
    expect(screen.queryByRole('button', { name: LINKS_WORDS.edit })).toBeNull();
    expect(screen.queryByRole('button', { name: LINKS_WORDS.add })).toBeNull();
    expect(document.querySelector('.sh-v2-links')?.textContent).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    other.unmount();

    wallet = new SigningWallet();
    const mine = renderLinks({ links: null });
    await connect();
    expect(wallet.requests).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(screen.getByRole('button', { name: LINKS_WORDS.add })).toBeTruthy();
    mine.rerender({ links: shown() });
    expect(screen.getByRole('button', { name: LINKS_WORDS.edit })).toBeTruthy();
    // Showing the buttons and the row asked the wallet nothing more and sent nothing.
    expect(wallet.requests).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(posts).toEqual([]);
  });

  it('the editor opens with the saved links, each in a form that canonicalizes back', async () => {
    renderLinks({ links: shown() });
    await connect();
    await click(LINKS_WORDS.edit);
    expect((screen.getByRole('textbox', { name: 'Website' }) as HTMLInputElement).value).toBe('https://junkyard.fun');
    expect((screen.getByRole('textbox', { name: 'X' }) as HTMLInputElement).value).toBe('@Junk_yard');
    expect((screen.getByRole('textbox', { name: 'Telegram' }) as HTMLInputElement).value).toBe('t.me/junkyard');
    expect(canonicalLinks(fieldsOf(VECTOR)).links).toEqual(VECTOR);
    expect(wallet.signs()).toBe(0);
    await click(LINKS_WORDS.cancel);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('LINKS-WEB 4: one eth_signTypedData_v4 with the pinned domain and types', () => {
  it('signs the vector: its digest and signature are the pinned ones, and the POST carries them as text/plain', async () => {
    answers = [() => reply(200, viewBody({ ...VECTOR, issuedAt: '1761300000', signature: SIGNATURE, signerKind: 'eoa', verifiedBlock: '9' }))];
    renderLinks();
    await connect();
    await signVectorInEditor();
    expect(wallet.signs()).toBe(1);
    const typed = wallet.typed[0] as Json & { domain: Json; types: Json; message: Json };
    expect(typed.domain).toEqual({ name: 'Square Hole', version: '1', chainId: SEPOLIA });
    expect(typed.primaryType).toBe('BoxLinks');
    expect(typed.types).toEqual({
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
      BoxLinks: [{ name: 'token', type: 'address' }, { name: 'website', type: 'string' }, { name: 'x', type: 'string' }, { name: 'telegram', type: 'string' }, { name: 'issuedAt', type: 'uint64' }],
    });
    expect(typed.message).toEqual({ token: TOKEN, ...VECTOR, issuedAt: '1761300000' });
    expect(hashTypedData({ ...typed, domain: { ...typed.domain, chainId: BigInt(SEPOLIA) }, message: { ...typed.message, issuedAt: ISSUED } } as never)).toBe(DIGEST);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(LINKS_URL);
    expect(posts[0]?.init.method).toBe('POST');
    expect(new Headers(posts[0]?.init.headers).get('Content-Type')).toBe('text/plain');
    expect(posts[0]?.init.credentials).toBe('omit');
    expect(bodies()[0]).toEqual({ ...VECTOR, issuedAt: '1761300000', signature: SIGNATURE });
    expect(Object.keys(bodies()[0] ?? {})).toEqual(['website', 'x', 'telegram', 'issuedAt', 'signature']);
    expect(await recoverAddress({ hash: DIGEST, signature: SIGNATURE })).toBe(CREATOR);
    // The answer updates the page at once, and the editor closes.
    expect(document.querySelector('.sh-v2-links')?.textContent).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: LINKS_WORDS.edit })).toBeTruthy();
  });

  it('a v of 0 or 1 from the wallet is sent as 27 or 28', async () => {
    for (const [v, sent] of [['00', '1b'], ['01', '1c']] as const) {
      wallet = new SigningWallet();
      wallet.answer = (signature) => `${signature.slice(0, 130)}${v}`;
      posts = [];
      const view = renderLinks();
      await connect();
      await signVectorInEditor();
      expect(bodies()[0]?.signature).toBe(`${SIGNATURE.slice(0, 130)}${sent}`);
      view.unmount();
    }
  });

  it('a field the canonicalizer refuses stops the Sign press with the Create page’s message; the wallet is not asked', async () => {
    renderLinks();
    await connect();
    await click(LINKS_WORDS.add);
    fill('Website', 'https://1.2.3.4');
    fill('Telegram', 't.me/+invite');
    await click(LINKS_WORDS.sign);
    expect(screen.getByText('Use a full https:// link')).toBeTruthy();
    expect(screen.getByText('A t.me link')).toBeTruthy();
    expect(wallet.signs()).toBe(0);
    expect(posts).toEqual([]);
  });

  it('wrong network: Switch network comes first; a declined signature sends nothing', async () => {
    wallet.chainId = 31337;
    renderLinks();
    await connect();
    await click(LINKS_WORDS.add);
    fill('X', '@Junk_yard');
    expect(screen.queryByRole('button', { name: LINKS_WORDS.sign })).toBeNull();
    await click(LINKS_WORDS.switchNetwork);
    await settle();
    expect(wallet.requests).toContain('wallet_switchEthereumChain');
    expect(wallet.signs()).toBe(0);
    wallet.refuse = 4001;
    await click(LINKS_WORDS.sign);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(LINKS_WORDS.declined);
    expect(posts).toEqual([]);
    wallet.refuse = -32002;
    await click(LINKS_WORDS.sign);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(LINKS_WORDS.pending);
  });

  it('removal: signing empty links sends three empty strings, and the row goes', async () => {
    answers = [() => reply(200, viewBody(null))];
    renderLinks({ links: shown() });
    await connect();
    await click(LINKS_WORDS.edit);
    for (const label of ['Website', 'X', 'Telegram']) fill(label, '');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(bodies()[0]).toMatchObject({ website: '', x: '', telegram: '', issuedAt: String(ISSUED + 1n) });
    expect(document.querySelector('.sh-v2-links')).toBeNull();
    expect(screen.getByRole('button', { name: LINKS_WORDS.add })).toBeTruthy();
  });
});

describe('LINKS-WEB 5: issuedAt = max(asOf, saved + 1); Sign again after a 409', () => {
  it('the rule', () => {
    expect(nextIssuedAt(100n, null)).toBe(100n);
    expect(nextIssuedAt(100n, 99n)).toBe(100n);
    expect(nextIssuedAt(100n, 100n)).toBe(101n);
    expect(nextIssuedAt(100n, 500n)).toBe(501n);
  });

  it('signs after the saved record, and after a 409 signs again at savedIssuedAt + 1', async () => {
    answers = [() => reply(409, { error: 'not newer', savedIssuedAt: '1761300100' }), () => reply(200, viewBody(null))];
    renderLinks({ links: shown({ issuedAt: ISSUED + 5n }), asOf: ISSUED });
    await connect();
    await click(LINKS_WORDS.edit);
    fill('Telegram', '');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(wallet.typed[0]?.message).toMatchObject({ issuedAt: String(ISSUED + 6n), telegram: '' });
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.conflict);
    await click(LINKS_WORDS.signAgain);
    await settle();
    expect(wallet.signs()).toBe(2);
    expect(wallet.typed[1]?.message).toMatchObject({ issuedAt: '1761300101' });
    expect(bodies().map((b) => b.issuedAt)).toEqual([String(ISSUED + 6n), '1761300101']);
  });

  it('chain time only: a newer asOf wins over saved + 1', async () => {
    renderLinks({ links: shown({ issuedAt: ISSUED }), asOf: ISSUED + 1000n });
    await connect();
    await click(LINKS_WORDS.edit);
    await click(LINKS_WORDS.sign);
    await settle();
    expect(wallet.typed[0]?.message).toMatchObject({ issuedAt: String(ISSUED + 1000n) });
  });
});

/** A virtual clock: sleeping moves it on at once, so a whole 2-minute send runs in microseconds. */
function clock() {
  let now = 0;
  const sleeps: number[] = [];
  return { now: () => now, sleep: async (ms: number) => { sleeps.push(ms); now += ms; }, sleeps, advance: (ms: number) => { now += ms; } };
}
function sending(over: Partial<SendLinksOptions> & { readonly answers: readonly ((at: number) => ReturnType<typeof reply> | Promise<never>)[] }) {
  const time = clock();
  const sent: number[] = [];
  let i = 0;
  const options: SendLinksOptions = {
    source: SOURCE, token: TOKEN, signed: { links: VECTOR, issuedAt: ISSUED, signature: SIGNATURE }, inFeed: () => true, signal: new AbortController().signal,
    now: time.now, sleep: time.sleep, limiter: new PostLimiter(),
    fetch: async () => { sent.push(time.now()); const answer = over.answers[Math.min(i, over.answers.length - 1)]; i += 1; return (answer as (at: number) => ReturnType<typeof reply>)(time.now()) as never; },
    ...over,
  };
  return { time, sent, run: () => sendLinks(options) };
}

describe('LINKS-WEB 6: sending', () => {
  it('waits for the box to appear in the feed before the one POST', async () => {
    let listed = false;
    const s = sending({ answers: [() => reply(200, viewBody(null))], inFeed: () => listed });
    const time = s.time;
    const pending = s.run();
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(s.sent).toEqual([]);
    listed = true;
    await expect(pending).resolves.toEqual({ kind: 'saved', links: null });
    expect(s.sent).toHaveLength(1);
    expect(time.sleeps.every((ms) => ms === LINKS_SEND.feedCheckMs)).toBe(true);
  });

  it('503: waits max(Retry-After, 10 s) and doubles; stops at 2 minutes after at most 4 POSTs', async () => {
    const s = sending({ answers: [() => reply(503, { error: 'signature check busy' })] });
    await expect(s.run()).resolves.toEqual({ kind: 'stopped' });
    expect(s.sent).toEqual([0, 10_000, 30_000, 70_000]);
    const r = sending({ answers: [() => reply(503, null, { 'Retry-After': '15' }), () => reply(503, null, { 'Retry-After': '45' }), () => reply(200, viewBody(null))] });
    await expect(r.run()).resolves.toMatchObject({ kind: 'saved' });
    // 15 s (Retry-After over the 10 s floor), then max(45, 2 × 15) = 45 s.
    expect(r.sent).toEqual([0, 15_000, 60_000]);
  });

  it('429 follows Retry-After (a whole minute when unreadable); a network failure waits like a 503', async () => {
    const s = sending({ answers: [() => reply(429, null, { 'Retry-After': '7' }), () => reply(429), () => reply(200, viewBody(null))] });
    await expect(s.run()).resolves.toMatchObject({ kind: 'saved' });
    expect(s.sent).toEqual([0, 7_000, 67_000]);
    const n = sending({ answers: [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.reject(new TypeError('Failed to fetch')), () => reply(200, viewBody(null))] });
    await expect(n.run()).resolves.toMatchObject({ kind: 'saved' });
    expect(n.sent).toEqual([0, 10_000, 30_000]);
    expect(retryAfterMs(' 12 ')).toBe(12_000);
    for (const header of [null, '', 'Wed, 21 Oct 2026 07:28:00 GMT', '-1', '1.5']) expect(retryAfterMs(header)).toBeNull();
  });

  it('never more than 10 POSTs a minute, even when told to retry at once', async () => {
    const s = sending({ answers: [() => reply(429, null, { 'Retry-After': '0' })] });
    await expect(s.run()).resolves.toEqual({ kind: 'stopped' });
    expect(s.sent.length).toBeGreaterThan(10);
    for (const start of s.sent) expect(s.sent.filter((at) => at >= start && at < start + 60_000).length).toBeLessThanOrEqual(10);
    expect(Math.max(...s.sent)).toBeLessThanOrEqual(LINKS_SEND.windowMs);
    // The tab's limit holds across sends (a Try again right after): the limiter is shared.
    const shared = new PostLimiter();
    const a = sending({ answers: [() => reply(429, null, { 'Retry-After': '0' })], limiter: shared });
    await a.run();
    expect(shared.wait(a.time.now())).toBeGreaterThan(0);
  });

  it('200, 409, 400 and 403 end it; any other answer stops it for Try again', async () => {
    expect(await sending({ answers: [() => reply(200, viewBody({ ...VECTOR, issuedAt: '7', signature: '0x', signerKind: 'erc1271', verifiedBlock: '1' }))] }).run()).toEqual({ kind: 'saved', links: shown({ issuedAt: 7n }) });
    // A 200 this page cannot read still means the server kept the signed links.
    expect(await sending({ answers: [() => reply(200, { odd: true })] }).run()).toEqual({ kind: 'saved', links: shown() });
    expect(await sending({ answers: [() => reply(409, { error: 'not newer', savedIssuedAt: '9' })] }).run()).toEqual({ kind: 'conflict', savedIssuedAt: 9n });
    expect(await sending({ answers: [() => reply(409, { error: 'not newer', savedIssuedAt: 9 })] }).run()).toEqual({ kind: 'conflict', savedIssuedAt: null });
    expect(await sending({ answers: [() => reply(400, { error: 'issuedAt ahead of chain' })] }).run()).toEqual({ kind: 'refused', status: 400 });
    expect(await sending({ answers: [() => reply(403, { error: 'not the creator' })] }).run()).toEqual({ kind: 'refused', status: 403 });
    for (const status of [404, 408, 413, 415, 500]) {
      const s = sending({ answers: [() => reply(status)] });
      expect(await s.run(), String(status)).toEqual({ kind: 'stopped' });
      expect(s.sent).toHaveLength(1);
    }
  });

  it('the body is exactly five strings, and stays under the server’s 4,096 bytes with the longest website and signature', () => {
    const longest = { links: { website: `https://a.com/${'a'.repeat(186)}`, x: 'a'.repeat(15), telegram: `a${'b'.repeat(31)}` }, issuedAt: (1n << 64n) - 1n, signature: `0x${'ab'.repeat(1024)}` as const };
    const text = linksBody(longest);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
    expect(Object.values(JSON.parse(text)).every((v) => typeof v === 'string')).toBe(true);
  });

  it('in the page: after 2 minutes Try again re-sends the same signature with no wallet request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answers = [() => reply(503), () => reply(503), () => reply(503), () => reply(503), () => reply(200, viewBody(null))];
    renderLinks();
    await connect();
    await signVectorInEditor();
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.sending);
    for (let i = 0; i < 4; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
    expect(posts).toHaveLength(4);
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.stopped);
    const signsBefore = wallet.signs();
    const requestsBefore = wallet.requests.length;
    await click(LINKS_WORDS.tryAgain);
    await settle();
    expect(posts).toHaveLength(5);
    expect(bodies()[4]).toEqual(bodies()[0]);
    expect(wallet.signs()).toBe(signsBefore);
    expect(wallet.requests).toHaveLength(requestsBefore);
  });

  it('a final 403 or 400 says so in one line, with no Try again', async () => {
    answers = [() => reply(403, { error: 'not the creator' })];
    renderLinks();
    await connect();
    await signVectorInEditor();
    expect(screen.getByRole('alert').textContent).toContain(LINKS_WORDS.notCreator);
    expect(screen.queryByRole('button', { name: LINKS_WORDS.tryAgain })).toBeNull();
    answers = [() => reply(400, { error: 'website not canonical' })];
    await click(LINKS_WORDS.sign);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain(LINKS_WORDS.refused);
    expect(posts).toHaveLength(2);
  });
});

describe('LINKS-WEB 7: the card after Create', () => {
  const draft = { website: 'https://junkyard.fun/', x: 'https://mobile.twitter.com/Junk_yard/', telegram: '@junkyard' };

  it('shows the draft’s links read-only, leaves out what the canonicalizer refuses, and none without links', async () => {
    const view = renderLinks({ draft: canonicalLinks(draft).links, inFeed: false });
    expect(document.querySelector('[data-links-card]')).toBeNull();
    await connect();
    const card = screen.getByRole('region', { name: LINKS_WORDS.label });
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(card.querySelector('.sh-v2-links')?.textContent).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    expect(within(card).getByRole('button', { name: LINKS_WORDS.sign })).toBeTruthy();
    view.rerender({ draft: canonicalLinks({ website: 'https://1.2.3.4', x: '@ok_handle', telegram: 't.me/+join' }).links });
    expect(screen.getByRole('region', { name: LINKS_WORDS.label }).querySelector('.sh-v2-links')?.textContent).toBe('@ok_handle');
    view.rerender({ draft: canonicalLinks({ website: 'http://a.com', x: '', telegram: '' }).links });
    expect(screen.queryByRole('region', { name: LINKS_WORDS.label })).toBeNull();
    expect(canonicalLinks(draft)).toEqual({ links: VECTOR, refused: [] });
    expect(canonicalLinks({ website: 'https://xn--80ak6aa92e.com', x: 'a/status/1', telegram: 'joinchat/abc' }).refused).toEqual(['website', 'x', 'telegram']);
  });

  it('Sign links · free signs once; the POST waits until the feed lists the box; then Saved', async () => {
    const view = renderLinks({ draft: VECTOR, inFeed: false, links: null });
    await connect();
    await click(LINKS_WORDS.sign);
    await settle();
    expect(wallet.signs()).toBe(1);
    expect(posts).toEqual([]);
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.sending);
    view.rerender({ inFeed: true });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, LINKS_SEND.feedCheckMs + 200)); });
    await settle();
    expect(posts).toHaveLength(1);
    expect(bodies()[0]).toEqual({ ...VECTOR, issuedAt: '1761300000', signature: SIGNATURE });
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.saved);
    expect(screen.queryByRole('button', { name: LINKS_WORDS.sign })).toBeNull();
    expect(document.body.textContent).not.toMatch(TRUST_WORDS);
  });

  it('after Create it reads the feed the box page reads: asOf from any card, the POST only once the box is listed', async () => {
    const { feed, source } = await publishedV2(false);
    const listed = (feed.cards[0] as { token: string }).token as Address;
    const asOf = BigInt((feed.asOf as { timestamp: string }).timestamp);
    const stub = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(feed)));
    vi.stubGlobal('fetch', stub);
    wallet.chainId = source.manifest.chainId;
    const target = Object.assign(new EventTarget(), { ethereum: wallet });
    const injectedAdapter = createInjectedWalletAdapter({ target: target as unknown as Window, storage: null });
    const client = createQueryClient();
    const tree = (token: Address, draftLinks: BoxLinks) => (
      <QueryClientProvider client={client}>
        <WalletProvider injectedAdapter={injectedAdapter} defaultDialog="browser" walletKinds="browser" targetChainId={source.manifest.chainId}>
          <Probe />
          <BoxLinksAfterCreate source={source} token={token} creator={CREATOR} draft={draftLinks} post={post} limiter={limiter} />
        </WalletProvider>
      </QueryClientProvider>
    );
    try {
      // A draft without links: no card, and the feed is not read for one.
      const view = render(tree(TOKEN, { website: '', x: '', telegram: '' }));
      await connect();
      await settle();
      expect(document.querySelector('[data-links-card]')).toBeNull();
      expect(stub).not.toHaveBeenCalled();
      // A new box the feed does not list yet: signed at the feed's asOf, and nothing sent while it is not listed.
      view.rerender(tree(TOKEN, { website: 'https://junkyard.fun', x: '', telegram: '' }));
      await act(async () => { await vi.waitFor(() => expect(screen.getByRole('button', { name: LINKS_WORDS.sign })).toHaveProperty('disabled', false)); });
      expect(String(stub.mock.calls[0]?.[0])).toBe(`${source.origin}/v2/feed?chain=${source.manifest.chainId}`);
      await click(LINKS_WORDS.sign);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, LINKS_SEND.feedCheckMs + 200)); });
      expect(wallet.typed[0]?.message).toMatchObject({ token: TOKEN, website: 'https://junkyard.fun', issuedAt: asOf.toString() });
      expect(posts).toEqual([]);
      expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.sending);
      view.unmount();
      // The box the feed lists: the POST goes at once, to this box, at the feed's chain.
      wallet.typed = [];
      render(tree(listed, { website: '', x: '@made_box', telegram: '' }));
      await connect();
      await act(async () => { await vi.waitFor(() => expect(screen.getByRole('button', { name: LINKS_WORDS.sign })).toHaveProperty('disabled', false)); });
      await click(LINKS_WORDS.sign);
      await act(async () => { await vi.waitFor(() => expect(posts).toHaveLength(1)); });
      expect(posts[0]?.url).toBe(`${source.origin}/v2/boxes/${source.manifest.chainId}/${listed.toLowerCase()}/links`);
      expect(bodies()[0]).toMatchObject({ website: '', x: 'made_box', telegram: '', issuedAt: asOf.toString() });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Fix round 1, F1 (XR-SH-LINKS-WEB): one total deadline of 2 minutes from the start of a send, across the wait for the
 * feed, the fetch and reading the answer's body. At the deadline the transport is aborted and the send settles as
 * stopped (Try again keeps the signature), even when the transport ignores its abort; a late answer changes nothing.
 * The wallet's signature is outside it: a slow wallet (a Safe) is waited for as long as it takes.
 */
describe('Fix round 1, F1: one total send deadline', () => {
  const signed = { links: VECTOR, issuedAt: ISSUED, signature: SIGNATURE } as const;
  /** A transport that never answers: it records its signal and ignores the abort unless told to honour it. */
  function stalledFetch(honour: boolean) {
    const signals: AbortSignal[] = [];
    const fetch: LinksFetch = (_url, init) => {
      signals.push(init.signal as AbortSignal);
      return new Promise((_resolve, reject) => {
        if (honour) init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      });
    };
    return { fetch, signals };
  }
  /** Where a send stands, read without awaiting it (a send that never settles must fail the test, not hang it). */
  function watch(work: Promise<unknown>) {
    const state: { done: boolean; value: unknown } = { done: false, value: undefined };
    void work.then((value) => { state.done = true; state.value = value; });
    return state;
  }
  const options = (over: Partial<SendLinksOptions>): SendLinksOptions => ({ source: SOURCE, token: TOKEN, signed, inFeed: () => true, signal: new AbortController().signal, limiter: new PostLimiter(), ...over });

  it('a fetch that never answers: stopped at 2 minutes and its transport aborted, also when the transport ignores the abort', async () => {
    vi.useFakeTimers();
    for (const honour of [false, true]) {
      const transport = stalledFetch(honour);
      const outcome = watch(sendLinks(options({ fetch: transport.fetch })));
      await vi.advanceTimersByTimeAsync(LINKS_SEND.windowMs - 1);
      expect(outcome.done, `honours abort: ${honour}`).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome, `honours abort: ${honour}`).toEqual({ done: true, value: { kind: 'stopped' } });
      expect(transport.signals).toHaveLength(1);
      expect(transport.signals[0]?.aborted).toBe(true);
    }
  });

  it('the 2 minutes count from the start of the send: 100 s waiting for the feed leave 20 s for the fetch', async () => {
    vi.useFakeTimers();
    let listed = false;
    const transport = stalledFetch(false);
    const outcome = watch(sendLinks(options({ fetch: transport.fetch, inFeed: () => listed })));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(transport.signals).toHaveLength(0);
    listed = true;
    await vi.advanceTimersByTimeAsync(19_999);
    expect(transport.signals).toHaveLength(1);
    expect(outcome.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome.value).toEqual({ kind: 'stopped' });
  });

  it('an answer whose body never ends: a 200 or a 409 stops at 2 minutes as well', async () => {
    vi.useFakeTimers();
    for (const status of [200, 409]) {
      const signals: AbortSignal[] = [];
      const fetch: LinksFetch = async (_url, init) => {
        signals.push(init.signal as AbortSignal);
        return { status, headers: new Headers(), json: () => new Promise<never>(() => undefined) };
      };
      const outcome = watch(sendLinks(options({ fetch })));
      await vi.advanceTimersByTimeAsync(LINKS_SEND.windowMs);
      expect(outcome.value, String(status)).toEqual({ kind: 'stopped' });
      expect(signals[0]?.aborted, String(status)).toBe(true);
    }
  });

  it('an answer that comes after the deadline changes nothing', async () => {
    vi.useFakeTimers();
    let answer: (value: ReturnType<typeof reply>) => void = () => undefined;
    const fetch: LinksFetch = () => new Promise((resolve) => { answer = resolve as never; });
    const outcome = watch(sendLinks(options({ fetch })));
    await vi.advanceTimersByTimeAsync(LINKS_SEND.windowMs);
    expect(outcome.value).toEqual({ kind: 'stopped' });
    answer(reply(200, viewBody(null)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(outcome.value).toEqual({ kind: 'stopped' });
  });

  it('in the page: a stalled POST shows Try again at 2 minutes, its late answer is dropped, and Try again re-sends the signature', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let late: (value: ReturnType<typeof reply>) => void = () => undefined;
    answers = [() => new Promise<never>((resolve) => { late = resolve as never; }), () => reply(200, viewBody({ ...VECTOR, issuedAt: '1761300000', signature: SIGNATURE, signerKind: 'eoa', verifiedBlock: '9' }))];
    renderLinks();
    await connect();
    await signVectorInEditor();
    expect(posts).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.sending);
    await act(async () => { await vi.advanceTimersByTimeAsync(LINKS_SEND.windowMs); });
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.stopped);
    expect(screen.getByRole('button', { name: LINKS_WORDS.tryAgain })).toBeTruthy();
    // The stalled POST answers after all ("removed"): the page does not take it.
    await act(async () => { late(reply(200, viewBody(null))); await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.stopped);
    const signs = wallet.signs();
    const requests = wallet.requests.length;
    await click(LINKS_WORDS.tryAgain);
    await settle();
    expect(posts).toHaveLength(2);
    expect(bodies()[1]).toEqual(bodies()[0]);
    expect(wallet.signs()).toBe(signs);
    expect(wallet.requests).toHaveLength(requests);
    expect(document.querySelector('.sh-v2-links')?.textContent).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
  });

  it('the wallet is not timed: a signature that takes 5 minutes (a Safe) is still sent and saved', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    wallet.delayMs = 300_000;
    answers = [() => reply(200, viewBody({ ...VECTOR, issuedAt: '1761300000', signature: SIGNATURE, signerKind: 'eoa', verifiedBlock: '9' }))];
    renderLinks();
    await connect();
    await click(LINKS_WORDS.add);
    fill('Website', 'https://junkyard.fun');
    fill('X', '@Junk_yard');
    fill('Telegram', 't.me/junkyard');
    await click(LINKS_WORDS.sign);
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.confirm);
    await act(async () => { await vi.advanceTimersByTimeAsync(299_000); });
    expect(posts).toHaveLength(0);
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.confirm);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await settle();
    expect(posts).toHaveLength(1);
    expect(document.querySelector('.sh-v2-links')?.textContent).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
  });
});

/**
 * Fix round 1, F3 (XR-SH-LINKS-WEB), as fix round 2 (F4) left it: the row this page saved shows at once, and gives way
 * to the feed once a feed record confirms or supersedes the save, or a feed read that started after the POST completed
 * answers (it holds the save, so whatever it says is the truth: a removal in another tab or straight through the API
 * removes the row). The newest signing time this page knows stays apart, for the next signature's order.
 */
describe('Fix round 1, F3: the page’s own save gives way to the feed', () => {
  const record = (links: Partial<ShownLinks>, verifiedBlock = '9') => ({ ...VECTOR, ...links, issuedAt: String(links.issuedAt ?? ISSUED), signature: SIGNATURE, signerKind: 'eoa', verifiedBlock });
  const row = () => document.querySelector('.sh-v2-links')?.textContent ?? null;

  it('once the feed shows the save, a later links: null (removed in another tab or through the API) removes the row', async () => {
    answers = [() => reply(200, viewBody(record({ x: 'new_handle', issuedAt: ISSUED + 1n })))];
    const read = feedReadsStarted();
    const view = renderLinks({ links: shown(), asOf: ISSUED, feedRead: read });
    await connect();
    await click(LINKS_WORDS.edit);
    fill('X', '@new_handle');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(row()).toBe('junkyard.fun · @new_handle · t.me/junkyard');
    // A read that started before the POST completed (the record before the save): the save still shows.
    view.rerender({ links: shown(), feedRead: read });
    expect(row()).toBe('junkyard.fun · @new_handle · t.me/junkyard');
    // The feed shows the save.
    view.rerender({ links: shown({ x: 'new_handle', issuedAt: ISSUED + 1n }) });
    expect(row()).toBe('junkyard.fun · @new_handle · t.me/junkyard');
    // Then the links are removed elsewhere: the feed's null is the truth.
    view.rerender({ links: null });
    expect(row()).toBeNull();
    expect(screen.getByRole('button', { name: LINKS_WORDS.add })).toBeTruthy();
  });

  it('a feed read that started after the POST completed is the truth, even if it never showed the save', async () => {
    answers = [() => reply(200, viewBody(record({}, '9')))];
    const read = feedReadsStarted();
    const view = renderLinks({ links: null, asOf: ISSUED, feedRead: read });
    await connect();
    await signVectorInEditor();
    expect(row()).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    // Reads that started before the POST completed (in flight, or cached) may predate the save: they do not undo it.
    view.rerender({ links: null, feedRead: read });
    expect(row()).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    // A read that started after it still has no links: removed meanwhile.
    view.rerender({ links: null, feedRead: read + 1 });
    expect(row()).toBeNull();
    expect(screen.getByRole('button', { name: LINKS_WORDS.add })).toBeTruthy();
  });

  it('after the row gives way, the next signature still comes after the newest save this page knows', async () => {
    answers = [() => reply(200, viewBody(record({ telegram: '', issuedAt: ISSUED + 5n }))), () => reply(200, viewBody(record({ x: 'again', telegram: '', issuedAt: ISSUED + 6n })))];
    const view = renderLinks({ links: shown({ issuedAt: ISSUED + 4n }), asOf: ISSUED, feedRead: feedReadsStarted() });
    await connect();
    await click(LINKS_WORDS.edit);
    fill('Telegram', '');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(wallet.typed[0]?.message).toMatchObject({ issuedAt: String(ISSUED + 5n), telegram: '' });
    view.rerender({ links: shown({ telegram: '', issuedAt: ISSUED + 5n }) });
    // Removed elsewhere: the feed has no links and no time; this page still knows its own save's.
    view.rerender({ links: null });
    expect(row()).toBeNull();
    await click(LINKS_WORDS.add);
    fill('X', '@again');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(wallet.typed[1]?.message).toMatchObject({ issuedAt: String(ISSUED + 6n), x: 'again' });
  });

  it('a removal this page signed: hidden at once, confirmed by a later read’s null; links added later elsewhere show', async () => {
    answers = [() => reply(200, viewBody(null))];
    const read = feedReadsStarted();
    const view = renderLinks({ links: shown(), asOf: ISSUED, feedRead: read });
    await connect();
    await click(LINKS_WORDS.edit);
    for (const label of ['Website', 'X', 'Telegram']) fill(label, '');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(row()).toBeNull();
    // A read from before the removal still shows the links: the removal holds.
    view.rerender({ links: shown(), feedRead: read });
    expect(row()).toBeNull();
    view.rerender({ links: null, feedRead: read + 1 });
    expect(row()).toBeNull();
    view.rerender({ links: shown({ website: 'https://later.fun', issuedAt: ISSUED + 9n }) });
    expect(row()).toBe('later.fun · @Junk_yard · t.me/junkyard');
  });
});

/**
 * Fix round 2, F4 (XR-SH-LINKS-WEB-R2): the save's head (`verifiedBlock`) is read before the server checks the signature
 * and writes the record, so the chain block cannot order an off-chain save: a feed answer from a higher block may have
 * been read while the save was still running. Only a feed read that started after the POST completed, or a feed record
 * at least as new as the save, takes over from the page's own save.
 */
describe('Fix round 2, F4: never order the save by the chain block', () => {
  const record = (links: Partial<ShownLinks>, verifiedBlock = '9') => ({ ...VECTOR, ...links, issuedAt: String(links.issuedAt ?? ISSUED), signature: SIGNATURE, signerKind: 'eoa', verifiedBlock });
  const row = () => document.querySelector('.sh-v2-links')?.textContent ?? null;
  // The feed is already at block 10 (the round-1 rule's block); the POST was verified at block 9.
  const higherBlock = { feedBlock: 10n } as Partial<BoxLinksV2Props>;

  it('a feed answer from a higher block read during the save, with no links, does not undo the save', async () => {
    answers = [() => reply(200, viewBody(record({}, '9')))];
    const read = feedReadsStarted();
    const view = renderLinks({ links: null, asOf: ISSUED, feedRead: read, ...higherBlock });
    await connect();
    await signVectorInEditor();
    expect(row()).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    expect(screen.getByRole('button', { name: LINKS_WORDS.edit })).toBeTruthy();
    expect(screen.queryByRole('button', { name: LINKS_WORDS.add })).toBeNull();
    // The next read, started after the POST completed, holds the save.
    view.rerender({ links: shown(), feedRead: read + 1, ...({ feedBlock: 11n } as Partial<BoxLinksV2Props>) });
    expect(row()).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
  });

  it('a feed answer from a higher block read during the save, with the older record, does not undo the edit', async () => {
    answers = [() => reply(200, viewBody(record({ x: 'new_handle', issuedAt: ISSUED + 1n }, '9')))];
    const read = feedReadsStarted();
    const view = renderLinks({ links: shown(), asOf: ISSUED, feedRead: read, ...higherBlock });
    await connect();
    await click(LINKS_WORDS.edit);
    fill('X', '@new_handle');
    await click(LINKS_WORDS.sign);
    await settle();
    expect(row()).toBe('junkyard.fun · @new_handle · t.me/junkyard');
    // Another answer of a read that started before the POST completed, older record again: the edit holds.
    view.rerender({ links: shown(), feedRead: read });
    expect(row()).toBe('junkyard.fun · @new_handle · t.me/junkyard');
    expect(screen.getByRole('button', { name: LINKS_WORDS.edit })).toBeTruthy();
  });

  it('a read that started while the POST was still saving (its answer first) is older than the save', async () => {
    const { feed, source } = await publishedV2(false);
    let finish: (value: ReturnType<typeof reply>) => void = () => undefined;
    answers = [() => new Promise<never>((resolve) => { finish = resolve as never; })];
    const view = renderLinks({ links: null, asOf: ISSUED, feedRead: feedReadsStarted() });
    await connect();
    await signVectorInEditor();
    expect(posts).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.sending);
    // While the server checks the signature and writes, a feed read starts and answers: no links yet.
    const during = await readFeedV2(source, async () => new Response(JSON.stringify(feed)));
    view.rerender({ links: null, feedRead: during.read });
    await act(async () => { finish(reply(200, viewBody(record({}, '9')))); });
    await settle();
    expect(row()).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
    expect(screen.getByRole('button', { name: LINKS_WORDS.edit })).toBeTruthy();
    // The first read that starts after the POST completed takes over (here it holds the save).
    view.rerender({ links: shown(), feedRead: during.read + 1 });
    expect(row()).toBe('junkyard.fun · @Junk_yard · t.me/junkyard');
  });

  it('after a save the feed is asked for a read that starts then; only such a read, or a record as new, takes over', async () => {
    const { feed, source } = await publishedV2(false);
    const listed = (feed.cards[0] as { token: string }).token as Address;
    const reads: number[] = [];
    const stub = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (_url, init) => {
      reads.push(feedReadsStarted());
      expect(init?.cache).toBe('no-cache');
      return new Response(JSON.stringify(feed));
    });
    vi.stubGlobal('fetch', stub);
    wallet.chainId = source.manifest.chainId;
    const target = Object.assign(new EventTarget(), { ethereum: wallet });
    const injectedAdapter = createInjectedWalletAdapter({ target: target as unknown as Window, storage: null });
    try {
      render(
        <QueryClientProvider client={createQueryClient()}>
          <WalletProvider injectedAdapter={injectedAdapter} defaultDialog="browser" walletKinds="browser" targetChainId={source.manifest.chainId}>
            <Probe />
            <BoxLinksAfterCreate source={source} token={listed} creator={CREATOR} draft={{ website: '', x: '@made_box', telegram: '' }} post={post} limiter={limiter} />
          </WalletProvider>
        </QueryClientProvider>,
      );
      await connect();
      await act(async () => { await vi.waitFor(() => expect(screen.getByRole('button', { name: LINKS_WORDS.sign })).toHaveProperty('disabled', false)); });
      const before = stub.mock.calls.length;
      const startedBefore = feedReadsStarted();
      await click(LINKS_WORDS.sign);
      await act(async () => { await vi.waitFor(() => expect(posts).toHaveLength(1)); });
      // The save asks for a new read at once (no 4 s poll wait), numbered after every read before the POST completed.
      await act(async () => { await vi.waitFor(() => expect(stub.mock.calls.length).toBeGreaterThan(before)); });
      expect(reads.at(-1)).toBeGreaterThan(startedBefore);
      expect(screen.getByRole('status').textContent).toBe(LINKS_WORDS.saved);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
