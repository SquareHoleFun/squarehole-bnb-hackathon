/**
 * Wallet boundary (SH-015; 06-ARCHITECTURE "Data and privacy"; UI-09). Two implementations of `WalletAdapter`:
 * - the DEMO adapter (below): synthetic personas from the accounts fixture, no browser wallet, no extension, no
 *   `window.ethereum`, nothing signed or sent;
 * - the INJECTED adapter (`injected-adapter.ts`, Stage C): an EIP-6963 wallet the person picks, or `window.ethereum`
 *   only when the person explicitly picks "Browser wallet".
 * Both only ever act when the app calls them, and the app only calls them after an explicit click (UI-09).
 */
import { TESTNET, isWriteChainId, writeChain } from '@squarehole/chain/write/wallet';
import { DEMO_CHAIN_ID, isChainId, sameAddress, type Address } from '@squarehole/domain';
import { WALLET_PERSONAS, type WalletPersona } from './personas';

// The Demo in this build: false on the production site, where every Demo branch folds away (src/build-mode.ts).
const DEMO_BUILD = !import.meta.env?.SH_PRODUCTION;

export type WalletKind = 'demo' | 'injected';

export interface WalletConnectRequest {
  /** Demo persona to connect as (the demo adapter requires one; a real adapter ignores it). */
  readonly personaId?: string;
  /** Chain the demo wallet should report ("simulate wrong network"); a real adapter ignores it. */
  readonly chainId?: number;
  /** Injected adapter: the EIP-6963 wallet id the person picked, or `BROWSER_WALLET_ID` for `window.ethereum`. */
  readonly walletId?: string;
}

export interface WalletConnection {
  readonly account: Address;
  readonly chainId: number;
  readonly personaId: string | null;
  /** Injected wallets: the announced wallet name (untrusted display text, cleaned). Null for the demo wallet. */
  readonly walletName?: string | null;
}

export interface WalletAdapter {
  readonly kind: WalletKind;
  /** Resolves with the connected account; rejects with `WalletError` (e.g. unknown persona). */
  connect(request?: WalletConnectRequest): Promise<WalletConnection>;
  disconnect(): void;
  /** Resolves once the wallet reports `chainId`; rejects with `WalletError` if it cannot switch. */
  switchChain(chainId: number): Promise<void>;
  /** EIP-1193 semantics: an empty list means the wallet disconnected. Returns an unsubscribe function. */
  onAccountsChanged(listener: (accounts: readonly Address[]) => void): () => void;
  onChainChanged(listener: (chainId: number) => void): () => void;
}

export type WalletErrorCode =
  | 'unknown_persona'
  | 'not_connected'
  | 'invalid_chain'
  | 'unknown_wallet'
  | 'no_browser_wallet'
  | 'rejected'
  | 'wallet_error';

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  constructor(code: WalletErrorCode, message: string) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/** The chain the demo wallet reports when "simulate wrong network" is on (same id as the mock executor's). */
export const DEMO_WRONG_CHAIN_ID = 1;

// SH-258: the build's test network by its own name (Sepolia, or BNB Chain Testnet under SH_TESTNET=bnb).
const LIVE_CHAIN_NAMES: Readonly<Record<number, string>> = { 1: 'Ethereum', [TESTNET.chainId]: TESTNET.networkName };
const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze(DEMO_BUILD ? { [DEMO_CHAIN_ID]: 'Local chain', ...LIVE_CHAIN_NAMES } : LIVE_CHAIN_NAMES);

/** "Local chain (31337)"; unknown ids are shown by number only (a chain id is not a name). */
export function chainLabel(chainId: number): string {
  const name = CHAIN_NAMES[chainId];
  return name ? `${name} (${chainId})` : `Chain ${chainId}`;
}

/**
 * Browser wallets (Stage C): the write chains by their live names ("Local anvil chain (31337)", "Sepolia (11155111)");
 * any other id by number only. Demo views keep `chainLabel`.
 */
export function liveChainLabel(chainId: number): string {
  return isWriteChainId(chainId) ? `${writeChain(chainId).name} (${chainId})` : `Chain ${chainId}`;
}

/** 0x0000…0001: enough to tell demo accounts apart; the full address stays available in the dialog. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function personaForAccount(account: string | null, personas: readonly WalletPersona[] = WALLET_PERSONAS): WalletPersona | null {
  if (account === null) return null;
  return personas.find((persona) => sameAddress(persona.address, account)) ?? null;
}

export interface DemoWalletAdapterOptions {
  personas?: readonly WalletPersona[];
  /** Simulated wallet latency per call in ms (default 250) so "connecting" is visible; tests pass 0. */
  latencyMs?: number;
}

const wait = (ms: number): Promise<void> => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/**
 * Demo wallet: connecting "as" a persona sets its synthetic address. Reconnecting as another persona or to another
 * chain while connected emits `accountsChanged` / `chainChanged`, like a user switching inside a real wallet.
 */
export function createDemoWalletAdapter(options: DemoWalletAdapterOptions = {}): WalletAdapter {
  const personas = options.personas ?? WALLET_PERSONAS;
  const latencyMs = options.latencyMs ?? 250;
  if (!Number.isSafeInteger(latencyMs) || latencyMs < 0) throw new RangeError('latencyMs must be a non-negative integer');
  const accountListeners = new Set<(accounts: readonly Address[]) => void>();
  const chainListeners = new Set<(chainId: number) => void>();
  let connection: WalletConnection | null = null;

  const emitAccounts = (accounts: readonly Address[]) => accountListeners.forEach((listener) => listener(accounts));
  const emitChain = (chainId: number) => chainListeners.forEach((listener) => listener(chainId));

  return {
    kind: 'demo',

    async connect(request = {}) {
      const persona = personas.find((candidate) => candidate.id === request.personaId);
      if (!persona) throw new WalletError('unknown_persona', 'Choose one of the sample accounts');
      const chainId = request.chainId ?? connection?.chainId ?? DEMO_CHAIN_ID;
      if (!isChainId(chainId)) throw new WalletError('invalid_chain', 'Chain id must be a positive integer');
      await wait(latencyMs);
      const previous = connection;
      connection = Object.freeze({ account: persona.address, chainId, personaId: persona.id });
      if (previous && !sameAddress(previous.account, persona.address)) emitAccounts([persona.address]);
      if (previous && previous.chainId !== chainId) emitChain(chainId);
      return connection;
    },

    disconnect() {
      if (connection === null) return;
      connection = null;
      emitAccounts([]);
    },

    async switchChain(chainId) {
      if (!isChainId(chainId)) throw new WalletError('invalid_chain', 'Chain id must be a positive integer');
      if (connection === null) throw new WalletError('not_connected', 'Connect the sample wallet first');
      await wait(latencyMs);
      if (connection === null) throw new WalletError('not_connected', 'The sample wallet disconnected');
      if (connection.chainId === chainId) return;
      connection = Object.freeze({ ...connection, chainId });
      emitChain(chainId);
    },

    onAccountsChanged(listener) {
      accountListeners.add(listener);
      return () => accountListeners.delete(listener);
    },

    onChainChanged(listener) {
      chainListeners.add(listener);
      return () => chainListeners.delete(listener);
    },
  };
}
