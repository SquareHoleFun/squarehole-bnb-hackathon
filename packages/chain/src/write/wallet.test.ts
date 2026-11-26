/**
 * Injected wallet session and EIP-6963 discovery: requests only on explicit calls, connect/switch/add/disconnect
 * semantics, event parsing, untrusted announcements.
 */
import { describe, expect, it } from 'vitest';
import { hashTypedData, recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { boxLinksDigest, boxLinksTypedData } from '../core/v2/box-links-v2';
import { LOCAL_CHAIN_ID, SEPOLIA_CHAIN_ID } from './chains';
import type { Eip1193RequestArguments } from './eip1193';
import { discoverWallets, parseAnnouncement, safeWalletIcon, type DiscoveredWallet } from './eip6963';
import { InjectedWalletSession, normalizeSignatureV, signTypedDataV4 } from './injected-wallet';
import { ACCOUNT_A, ACCOUNT_B, FakeChain, FakeWallet } from './test-support/fake-chain';

const META = { id: 'test', name: 'Test Wallet', rdns: 'org.example.wallet', source: 'eip6963' as const };

describe('InjectedWalletSession', () => {
  it('makes no request until connect(); connect is eth_requestAccounts then eth_chainId', async () => {
    const wallet = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: SEPOLIA_CHAIN_ID });
    const session = new InjectedWalletSession(wallet, META);
    expect(wallet.requests).toEqual([]);
    await expect(session.connect()).resolves.toEqual({ account: ACCOUNT_A, chainId: SEPOLIA_CHAIN_ID });
    expect(wallet.requests).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(session.isConnected).toBe(true);
  });

  it('a declined connection (4001) and an empty account list are errors, never a connection', async () => {
    const wallet = new FakeWallet(new FakeChain(), [ACCOUNT_A]);
    wallet.sendBehaviour = 'reject';
    await expect(new InjectedWalletSession(wallet, META).connect()).rejects.toMatchObject({ code: 'rejected' });
    const empty = new FakeWallet(new FakeChain(), []);
    await expect(new InjectedWalletSession(empty, META).connect()).rejects.toMatchObject({ code: 'no_accounts' });
  });

  it('switches only to write chains; adds the local anvil chain on 4902, never Sepolia or mainnet', async () => {
    const wallet = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: SEPOLIA_CHAIN_ID, knownChains: [SEPOLIA_CHAIN_ID] });
    const session = new InjectedWalletSession(wallet, META, { localRpcUrl: 'http://127.0.0.1:8552' });
    await expect(session.switchChain(LOCAL_CHAIN_ID)).rejects.toMatchObject({ code: 'not_connected' });
    await session.connect();
    await expect(session.switchChain(1)).rejects.toMatchObject({ code: 'unsupported_chain' });
    await session.switchChain(LOCAL_CHAIN_ID);
    expect(wallet.chainId).toBe(LOCAL_CHAIN_ID);
    expect(wallet.requests.slice(2)).toEqual(['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']);

    const noSepolia = new FakeWallet(new FakeChain(), [ACCOUNT_A], { chainId: LOCAL_CHAIN_ID, knownChains: [LOCAL_CHAIN_ID] });
    const s2 = new InjectedWalletSession(noSepolia, META);
    await s2.connect();
    await expect(s2.switchChain(SEPOLIA_CHAIN_ID)).rejects.toMatchObject({ code: 'chain_unknown_to_wallet' });
    expect(noSepolia.requests).not.toContain('wallet_addEthereumChain');
  });

  it('parses accountsChanged / chainChanged, and disconnect detaches listeners and revokes where supported', async () => {
    const wallet = new FakeWallet(new FakeChain(), [ACCOUNT_A]);
    const session = new InjectedWalletSession(wallet, META);
    await session.connect();
    const accounts: string[][] = [];
    const chains: number[] = [];
    session.onAccountsChanged((list) => accounts.push([...list]));
    session.onChainChanged((id) => chains.push(id));
    wallet.setAccounts([ACCOUNT_B, 'not-an-address' as never, ACCOUNT_B]);
    wallet.emit('chainChanged', '0xaa36a7');
    wallet.emit('chainChanged', 'garbage');
    expect(accounts).toEqual([[ACCOUNT_B]]);
    expect(chains).toEqual([SEPOLIA_CHAIN_ID]);
    await session.disconnect();
    expect(wallet.listenerCount('accountsChanged')).toBe(0);
    expect(wallet.listenerCount('chainChanged')).toBe(0);
    expect(wallet.requests).toContain('wallet_revokePermissions');
    expect(session.isConnected).toBe(false);
    const quiet = new FakeWallet(new FakeChain(), [ACCOUNT_A]);
    quiet.supportsRevoke = false;
    const s2 = new InjectedWalletSession(quiet, META);
    await s2.connect();
    await expect(s2.disconnect()).resolves.toBeUndefined();
  });
});

describe('EIP-6963 discovery', () => {
  const provider = { request: async () => null };
  const announcement = (overrides: Record<string, unknown> = {}) => ({
    info: { uuid: '350670db-19fa-4704-a166-e52e178b59d2', name: 'Example Wallet', rdns: 'com.example.wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+', ...overrides },
    provider,
  });

  it('accepts well-formed announcements and rejects hostile ones', () => {
    expect(parseAnnouncement(announcement())).toMatchObject({ name: 'Example Wallet', rdns: 'com.example.wallet', icon: 'data:image/svg+xml;base64,PHN2Zy8+' });
    expect(parseAnnouncement(announcement({ uuid: 'nope' }))).toBeNull();
    expect(parseAnnouncement(announcement({ rdns: 'javascript:alert(1)' }))).toBeNull();
    expect(parseAnnouncement(announcement({ name: '   ' }))).toBeNull();
    expect(parseAnnouncement({ info: announcement().info, provider: {} })).toBeNull();
    expect(parseAnnouncement(announcement({ name: 'Evil‮Wallet\n' }))?.name).toBe('Evil Wallet');
    expect(parseAnnouncement(announcement({ icon: 'https://evil.example/icon.png' }))?.icon).toBeNull();
    expect(safeWalletIcon('data:text/html;base64,PHNjcmlwdD4=')).toBeNull();
    expect(safeWalletIcon(`data:image/png;base64,${'A'.repeat(100_001)}`)).toBeNull();
  });

  it('asks wallets to announce, deduplicates by uuid and stops listening on demand', () => {
    const target = new EventTarget();
    let requests = 0;
    target.addEventListener('eip6963:requestProvider', () => {
      requests += 1;
      target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail: announcement() }));
    });
    const seen: (readonly DiscoveredWallet[])[] = [];
    const stop = discoverWallets(target, (wallets) => seen.push(wallets));
    target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail: announcement({ name: 'Renamed' }) }));
    target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail: { junk: true } }));
    expect(requests).toBe(1);
    expect(seen.map((list) => list.map((w) => w.name))).toEqual([['Example Wallet'], ['Renamed']]);
    stop();
    target.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), { detail: announcement({ uuid: '11111111-1111-4111-8111-111111111111' }) }));
    expect(seen).toHaveLength(2);
  });
});

/**
 * LINKS-WEB (docs/design/box-links-v2.md § 5): the Sign click's one `eth_signTypedData_v4`, against the vector both
 * links tickets pin (box-links-v2.test.ts: Anvil account 0, Sepolia, token 0x1111…1111, 1761300000).
 */
describe('signTypedDataV4 (LINKS-WEB)', () => {
  // Anvil's account 0: the public Foundry and Hardhat development key, the one the pinned vector is signed with.
  const ANVIL_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const TOKEN = '0x1111111111111111111111111111111111111111';
  const LINKS = { website: 'https://junkyard.fun', x: 'Junk_yard', telegram: 'junkyard' };
  const DIGEST = '0x3ee7daa83f48c332b7fccac94f8e94f89f6352e8072583318e2e72097bed86f1';
  const SIGNATURE = '0xc2d0a83af6fe0e097b39a042b1e5fe56184a621be711cc968e0263d7a2ed4f590cea0ad7e60e38f02a6a9652805470c19e68dc0484b741c5ab06df3df62ea73e1c';
  const typed = () => boxLinksTypedData(SEPOLIA_CHAIN_ID, TOKEN, LINKS, 1761300000n);

  /** A wallet holding Anvil account 0: it signs what it is sent, and answers with `answer(signature)` when given. */
  function signingWallet(answer?: (signature: Hex) => unknown) {
    const account = privateKeyToAccount(ANVIL_0);
    const calls: Eip1193RequestArguments[] = [];
    const request = async (args: Eip1193RequestArguments): Promise<unknown> => {
      calls.push(args);
      if (args.method === 'eth_requestAccounts' || args.method === 'eth_accounts') return [account.address];
      if (args.method === 'eth_chainId') return '0xaa36a7';
      if (args.method !== 'eth_signTypedData_v4') throw Object.assign(new Error('Unsupported method'), { code: 4200 });
      const [, text] = args.params as [string, string];
      const data = JSON.parse(text);
      // viem wants bigint for the EIP712Domain's uint256 and the uint64 (box-links-v2.ts `boxLinksDigest`).
      const signature = await account.signTypedData({ ...data, domain: { ...data.domain, chainId: BigInt(data.domain.chainId) }, message: { ...data.message, issuedAt: BigInt(data.message.issuedAt) } });
      return answer ? answer(signature) : signature;
    };
    return { account, calls, request };
  }

  it('sends exactly one eth_signTypedData_v4: the account, then the typed data as JSON text; the answer is the pinned signature', async () => {
    const wallet = signingWallet();
    await expect(signTypedDataV4(wallet.request, wallet.account.address, typed())).resolves.toBe(SIGNATURE);
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_signTypedData_v4']);
    const [account, text] = wallet.calls[0]?.params as [string, string];
    expect(account).toBe(wallet.account.address);
    expect(typeof text).toBe('string');
    const sent = JSON.parse(text);
    expect(sent).toEqual(typed());
    expect(sent.domain).toEqual({ name: 'Square Hole', version: '1', chainId: SEPOLIA_CHAIN_ID });
    expect(sent.types.EIP712Domain).toEqual([{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }]);
    expect(sent.types.BoxLinks.map((field: { name: string }) => field.name)).toEqual(['token', 'website', 'x', 'telegram', 'issuedAt']);
    expect(hashTypedData({ ...sent, domain: { ...sent.domain, chainId: BigInt(sent.domain.chainId) }, message: { ...sent.message, issuedAt: BigInt(sent.message.issuedAt) } })).toBe(DIGEST);
    expect(boxLinksDigest(SEPOLIA_CHAIN_ID, TOKEN, LINKS, 1761300000n)).toBe(DIGEST);
    expect(await recoverAddress({ hash: DIGEST, signature: SIGNATURE })).toBe(wallet.account.address);
  });

  it('a 65-byte signature with v 0 or 1 comes back with v 27 or 28; any other signature as the wallet gave it', async () => {
    for (const [v, expected] of [['00', '1b'], ['01', '1c']] as const) {
      const wallet = signingWallet((signature) => `${signature.slice(0, 130)}${v}`);
      const signed = await signTypedDataV4(wallet.request, wallet.account.address, typed());
      expect(signed).toBe(`${SIGNATURE.slice(0, 130)}${expected}`);
      expect(wallet.calls).toHaveLength(1);
    }
    expect(normalizeSignatureV(SIGNATURE)).toBe(SIGNATURE);
    const upper = `0x${SIGNATURE.slice(2, 130)}1B` as const;
    expect(normalizeSignatureV(upper)).toBe(upper);
    // A contract wallet's answer: a Safe message approved on chain (`0x`), or a longer signature; never altered.
    for (const contract of ['0x', `0x${'ab'.repeat(130)}`, `${SIGNATURE}00`] as const) {
      const wallet = signingWallet(() => contract);
      await expect(signTypedDataV4(wallet.request, wallet.account.address, typed())).resolves.toBe(contract);
    }
  });

  it('a declined or pending request and a malformed answer are wallet errors, never a signature', async () => {
    const refusing = (code: number) => async () => { throw Object.assign(new Error('nope'), { code }); };
    await expect(signTypedDataV4(refusing(4001), ACCOUNT_A, typed())).rejects.toMatchObject({ code: 'rejected' });
    await expect(signTypedDataV4(refusing(-32002), ACCOUNT_A, typed())).rejects.toMatchObject({ code: 'pending_request' });
    await expect(signTypedDataV4(refusing(-32603), ACCOUNT_A, typed())).rejects.toMatchObject({ code: 'wallet_error' });
    for (const garbage of [null, 7, '0x1', 'c2d0', '0xzz', { signature: SIGNATURE }]) {
      const wallet = signingWallet(() => garbage);
      await expect(signTypedDataV4(wallet.request, ACCOUNT_A, typed()), String(garbage)).rejects.toMatchObject({ code: 'wallet_error' });
    }
  });

  it('the session signs only once connected, with that one request and nothing else', async () => {
    const wallet = signingWallet();
    const session = new InjectedWalletSession({ request: wallet.request }, META);
    await expect(session.signTypedData(wallet.account.address, typed())).rejects.toMatchObject({ code: 'not_connected' });
    expect(wallet.calls).toEqual([]);
    await session.connect();
    await expect(session.signTypedData(wallet.account.address, typed())).resolves.toBe(SIGNATURE);
    expect(wallet.calls.map((call) => call.method)).toEqual(['eth_requestAccounts', 'eth_chainId', 'eth_signTypedData_v4']);
  });
});
