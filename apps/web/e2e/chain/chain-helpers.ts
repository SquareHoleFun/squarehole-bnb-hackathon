/**
 * Chain E2E helpers (SH-C). TEST ONLY: nothing here is bundled or imported by the app.
 *
 * `installAnvilWallet` injects a test-only EIP-6963 browser wallet into the page. It answers the account and chain
 * requests itself and forwards `eth_sendTransaction` (and any other request) to the local anvil chain, which signs
 * with the account's key: anvil's PUBLIC default test accounts are unlocked on the local chain only. It records every
 * request and every discovery ping, can report another chain (wrong-network tests) and can decline the next
 * transaction with EIP-1193 code 4001 (reject tests). Never used outside tests.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

/**
 * The launches of the F10 local plan (packages/contracts/script/config/31337.json): THE_MISFITS (T = FIT, 10,000 NFTs,
 * quote WETH, R = Q) and ORCHARD (T = ORCH, 1,000 NFTs, quote FIT, R = T).
 */
export type LaunchKey = 'THE_MISFITS' | 'ORCHARD';

export interface LocalPair {
  readonly appPairId: string;
  readonly token: string;
  readonly quote: string;
  readonly rewardSide: 'T' | 'Q';
  readonly symbol: string;
}

export interface LocalChain {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly harness: string;
  readonly head: number;
  readonly accounts: Readonly<Record<'deployer' | 'alice' | 'bob' | 'carol' | 'dave' | 'creator' | 'keeper', string>>;
  readonly pairs: Readonly<Record<LaunchKey, LocalPair>>;
  readonly manifest: string;
}

const CHAIN_FILE = fileURLToPath(new URL('../.chain/local-chain.json', import.meta.url));

export function localChain(): LocalChain {
  return JSON.parse(readFileSync(CHAIN_FILE, 'utf8')) as LocalChain;
}

export interface ManifestLaunch {
  readonly poolId: string;
  readonly contracts: Readonly<Record<string, { address: string }>>;
}

export function manifest(): { contracts: Record<string, { address: string }>; launches: Partial<Record<LaunchKey, ManifestLaunch>> & Record<string, ManifestLaunch | undefined> } {
  return JSON.parse(readFileSync(localChain().manifest, 'utf8')) as never;
}

/** A contract of one of the plan's launches from the manifest (throws when the manifest lacks it). */
export function launchContract(key: LaunchKey, contract: 'rewardLedger' | 'token' | 'feeCollector' | 'mirror'): string {
  const address = manifest().launches[key]?.contracts[contract]?.address;
  if (!address) throw new Error(`the manifest has no ${key}.contracts.${contract}`);
  return address;
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(localChain().rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** `cast` against the local chain (independent reads for assertions); offline subcommands take no RPC URL. */
export function cast(args: readonly string[]): string {
  const offline = new Set(['index', 'keccak', 'abi-encode', 'to-dec', 'to-hex']);
  const rpcArgs = offline.has(args[0] ?? '') ? [] : ['--rpc-url', localChain().rpcUrl];
  const result = spawnSync(join(homedir(), '.foundry/bin/cast'), [...args, ...rpcArgs], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cast ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A uint256 view read, as a bigint (cast prints "123 [1.23e2]"). */
export function callUint(to: string, signature: string, args: readonly string[] = []): bigint {
  return BigInt(cast(['call', to, signature, ...args]).split(' ')[0] ?? '');
}

/** Chooses the "Local chain (anvil 31337)" data source before the app loads (as Settings stores it). */
export async function chooseLocalSource(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.setItem('squarehole.data-source.v1', JSON.stringify({ source: 'local' })));
}

export interface AnvilWalletOptions {
  readonly account: string;
  /** Chain the wallet reports first (default the local chain 0x7a69). */
  readonly chainIdHex?: string;
}

export async function installAnvilWallet(page: Page, { account, chainIdHex = '0x7a69' }: AnvilWalletOptions): Promise<void> {
  const { rpcUrl } = localChain();
  await page.addInitScript(
    ({ account, chainIdHex, rpcUrl }) => {
      type Listener = (...args: unknown[]) => void;
      const listeners = new Map<string, Set<Listener>>();
      const emit = (event: string, value: unknown) => listeners.get(event)?.forEach((listener) => listener(value));
      const state = { chainId: chainIdHex, rejectNextSend: false, calls: [] as string[], pings: 0, sent: [] as string[] };
      Object.defineProperty(window, '__anvilWallet', {
        value: {
          state,
          setChain(hex: string) {
            state.chainId = hex;
            emit('chainChanged', hex);
          },
        },
      });
      async function forward(method: string, params: unknown) {
        const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? [] }) });
        const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
        return body.result;
      }
      const provider = {
        async request({ method, params }: { method: string; params?: unknown }) {
          state.calls.push(method);
          switch (method) {
            case 'eth_requestAccounts':
            case 'eth_accounts':
              return [account];
            case 'eth_chainId':
              return state.chainId;
            case 'wallet_switchEthereumChain': {
              const next = (params as [{ chainId: string }])[0].chainId;
              state.chainId = next;
              emit('chainChanged', next);
              return null;
            }
            case 'wallet_addEthereumChain':
            case 'wallet_revokePermissions':
              return null;
            case 'eth_sendTransaction': {
              if (state.rejectNextSend) {
                state.rejectNextSend = false;
                throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
              }
              if (state.chainId !== '0x7a69') throw Object.assign(new Error('The test wallet only signs on the local chain.'), { code: 4901 });
              const hash = (await forward(method, params)) as string;
              state.sent.push(hash);
              return hash;
            }
            default:
              return forward(method, params);
          }
        },
        on(event: string, listener: Listener) {
          const set = listeners.get(event) ?? new Set<Listener>();
          set.add(listener);
          listeners.set(event, set);
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener);
        },
      };
      window.addEventListener('eip6963:requestProvider', () => {
        state.pings += 1;
        window.dispatchEvent(
          new CustomEvent('eip6963:announceProvider', {
            detail: Object.freeze({
              info: { uuid: '6c1f3a52-8f7e-4a4b-9a55-0e2d7c9b1a01', name: 'Anvil test wallet', rdns: 'dev.squarehole.anviltest', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNiIgZmlsbD0iIzJmOWU4ZiIvPjwvc3ZnPg==' },
              provider,
            }),
          }),
        );
      });
    },
    { account, chainIdHex, rpcUrl },
  );
}

interface WalletState {
  readonly calls: string[];
  readonly pings: number;
  readonly sent: string[];
}

export const walletState = (page: Page): Promise<WalletState> =>
  page.evaluate(() => {
    const { state } = (window as unknown as { __anvilWallet: { state: WalletState } }).__anvilWallet;
    return { calls: [...state.calls], pings: state.pings, sent: [...state.sent] };
  });

export const rejectNextSend = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __anvilWallet: { state: { rejectNextSend: boolean } } }).__anvilWallet.state.rejectNextSend = true;
  });

export const walletButton = (page: Page): Locator => page.getByRole('banner').locator('.sh-wallet-button');

/** Opens the browser-wallet window from the top bar and connects the anvil test wallet (an explicit click). */
export async function connectAnvilWallet(page: Page): Promise<void> {
  await walletButton(page).click();
  const chooser = page.getByRole('dialog', { name: 'Connect a browser wallet' });
  await chooser.getByRole('button', { name: /Anvil test wallet/ }).click();
  await expect(chooser).toHaveCount(0);
}

export const txPanel = (scope: Page | Locator): Locator => scope.locator('[data-tx-status]');

/** Walks a chain request from "Confirm in wallet" to finalized (UI-08: nothing before finalized is success). */
export async function confirmAndFinalize(scope: Page | Locator, successText: RegExp | string): Promise<void> {
  const panel = txPanel(scope);
  await expect(panel).toHaveAttribute('data-tx-status', 'awaiting_signature');
  await expect(scope.getByTestId('chain-signature-request')).toBeVisible();
  await scope.getByRole('button', { name: 'Confirm in wallet' }).click();
  await expect(panel).toHaveAttribute('data-tx-status', /submitted|pending|confirmed_unfinalized|finalized/);
  await expect(panel).toHaveAttribute('data-tx-status', 'finalized', { timeout: 60_000 });
  await expect(panel.getByText(successText).first()).toBeVisible();
}

export async function evidence(page: Page, testInfo: TestInfo, name: string, { fullPage = true } = {}): Promise<void> {
  const file =
    process.env.SH_EVIDENCE_SCREENSHOTS === '1'
      ? fileURLToPath(new URL(`../../../../docs/evidence/screenshots/${name}.png`, import.meta.url))
      : testInfo.outputPath(`${name}.png`);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: file, fullPage });
}

/**
 * The feed's bounded quote figure of an 18-decimal raw amount (apps/web chain-markets.ts `formatQuoteFigure`), computed
 * independently: at most 6 decimals AND at most 6 significant digits, truncated, grouped ("1,071.61", "0.264784").
 */
export function formatQuoteFigure18(raw: bigint): string {
  if (raw >= 10n ** 24n) throw new Error('the compact form (from one million) is not expected in this E2E');
  if (raw === 0n) return '0';
  if (raw < 10n ** 12n) return '<0.000001';
  const whole = raw / 10n ** 18n;
  const fraction6 = (raw % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole > 0n) {
    const kept = fraction6.slice(0, Math.max(0, 6 - whole.toString().length)).replace(/0+$/, '');
    return kept === '' ? grouped : `${grouped}.${kept}`;
  }
  return `0.${fraction6.replace(/0+$/, '')}`;
}

export interface FigureBox {
  readonly text: string;
  readonly lines: number;
  readonly overflow: number;
}

/**
 * Every quote-denominated amount and mid price on the page: how many line boxes it spans (1 = never broken inside the
 * number) and by how many CSS pixels it sticks out of its cell's content box (0 = fits the fixed column).
 */
export async function quoteFigureBoxes(page: Page): Promise<FigureBox[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.sh-q-figure .sh-numeric, .sh-chain-price .sh-numeric')].map((el) => {
      const cell = el.closest<HTMLElement>('td, dd, p, li') ?? el.parentElement ?? el;
      // CSS Typed OM (Chromium): the computed padding in px, without parsing strings.
      const px = (property: string): number => (cell.computedStyleMap().get(property) as CSSUnitValue | undefined)?.value ?? 0;
      const box = cell.getBoundingClientRect();
      const left = box.left + cell.clientLeft + px('padding-left');
      const right = box.left + cell.clientLeft + cell.clientWidth - px('padding-right');
      const own = el.getBoundingClientRect();
      return {
        text: el.textContent ?? '',
        lines: el.getClientRects().length,
        overflow: Math.max(0, Math.round(own.right - right), Math.round(left - own.left)),
      };
    }),
  );
}

/** The document scrolls sideways by this many CSS pixels (0 = no horizontal page scroll). */
export const horizontalOverflow = (page: Page): Promise<number> =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** "997,538,440.099701" — the app's truncated grouping of an 18-decimal raw amount (6 fraction digits). */
export function formatRaw18(raw: bigint, digits = 6): string {
  const whole = raw / 10n ** 18n;
  const fraction = (raw % 10n ** 18n).toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === '' ? grouped : `${grouped}.${fraction}`;
}
