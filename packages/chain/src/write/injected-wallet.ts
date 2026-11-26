/**
 * One connection to a browser wallet (an EIP-6963 provider, or `window.ethereum` when the person explicitly picks
 * "Browser wallet"). Every wallet request here follows an explicit action (UI-09):
 * - `connect()` (the Connect click) is the only `eth_requestAccounts`;
 * - `switchChain()` (the "Switch network" click) asks `wallet_switchEthereumChain`, and adds the chain with
 *   `wallet_addEthereumChain` only when the wallet does not know it (4902) and the chain has add-chain parameters (the
 *   local anvil chain; BNB Chain testnet, SH-258). Only write chains (31337 and the build's test network) are ever
 *   requested;
 * - `disconnect()` (the Disconnect click) asks `wallet_revokePermissions` (EIP-2255) where supported, and always
 *   forgets the connection locally (EIP-1193 has no standard disconnect);
 * - `signTypedData()` (a box creator's "Sign links" click, LINKS-WEB) asks one `eth_signTypedData_v4`.
 * Transactions are sent by the executor's `submitWrite` through `request`, after its own checks.
 */
import type { Address } from '@squarehole/domain';
import { chainIdHex, isWriteChainId, writeChain, type WriteChain } from './chains';
import { RPC_CODES, errorMessage, parseAccounts, parseChainId, rpcErrorCode, type Eip1193Provider, type Eip1193Request } from './eip1193';

export type InjectedSource = 'eip6963' | 'window_ethereum';

export interface InjectedWalletMeta {
  readonly id: string;
  readonly name: string;
  readonly rdns: string | null;
  readonly source: InjectedSource;
}

export type InjectedWalletErrorCode =
  | 'rejected'
  | 'no_accounts'
  | 'pending_request'
  | 'unsupported_chain'
  | 'chain_unknown_to_wallet'
  | 'not_connected'
  | 'wallet_error';

export class InjectedWalletError extends Error {
  readonly code: InjectedWalletErrorCode;
  constructor(code: InjectedWalletErrorCode, message: string) {
    super(message);
    this.name = 'InjectedWalletError';
    this.code = code;
  }
}

function walletError(error: unknown, action: string): InjectedWalletError {
  const code = rpcErrorCode(error);
  if (code === RPC_CODES.userRejected) return new InjectedWalletError('rejected', `${action} was declined in the wallet.`);
  if (code === RPC_CODES.requestPending) return new InjectedWalletError('pending_request', 'The wallet already has a request open; finish or close it in the wallet first.');
  return new InjectedWalletError('wallet_error', `${action} failed: ${errorMessage(error)}`);
}

export interface InjectedConnection {
  readonly account: Address;
  readonly chainId: number;
}

/** Hex bytes: what a signature must look like, whatever its length. */
const SIGNATURE_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

/**
 * A 65-byte signature whose v is 0 or 1 (what some wallets return) with v as 27 or 28; every other byte, and every
 * other signature, unchanged (docs/design/box-links-v2.md § 5).
 */
export function normalizeSignatureV(signature: `0x${string}`): `0x${string}` {
  if (signature.length !== 132) return signature;
  const v = signature.slice(130).toLowerCase();
  const rs = signature.slice(2, 130);
  return v === '00' ? `0x${rs}1b` : v === '01' ? `0x${rs}1c` : signature;
}

/**
 * One `eth_signTypedData_v4` for `account`, with the typed data as its JSON text (EIP-712, `EIP712Domain` included);
 * asked only after the person's click (LINKS-WEB: a box creator's "Sign links"). The answer must be hex bytes. A
 * 65-byte signature comes back with v as 27 or 28; a contract wallet's (any length, or `0x` for a Safe message
 * approved on chain) is passed on as it is. A wallet that takes long (a Safe collecting its owners' signatures) is
 * simply waited for: EIP-1193 has no way to cancel a request.
 */
export async function signTypedDataV4(request: Eip1193Request, account: Address, typedData: unknown): Promise<`0x${string}`> {
  const text = JSON.stringify(typedData);
  let answer: unknown;
  try {
    answer = await request({ method: 'eth_signTypedData_v4', params: [account, text] });
  } catch (error) {
    throw walletError(error, 'Signing');
  }
  if (typeof answer !== 'string' || !SIGNATURE_BYTES.test(answer)) throw new InjectedWalletError('wallet_error', 'The wallet returned a malformed signature.');
  return normalizeSignatureV(answer as `0x${string}`);
}

type Listener = (...args: unknown[]) => void;

export class InjectedWalletSession {
  readonly meta: InjectedWalletMeta;
  private readonly provider: Eip1193Provider;
  private readonly attached: [string, Listener][] = [];
  private connected = false;
  private readonly localRpcUrl: string | undefined;

  constructor(provider: Eip1193Provider, meta: InjectedWalletMeta, options: { localRpcUrl?: string } = {}) {
    this.provider = provider;
    this.meta = Object.freeze({ ...meta });
    this.localRpcUrl = options.localRpcUrl;
  }

  /** The wallet's EIP-1193 request function (the executor's `submitWrite` sends through it after its checks). */
  get request(): Eip1193Request {
    return (args) => this.provider.request(args);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** The Connect click: `eth_requestAccounts`, then `eth_chainId`. */
  async connect(): Promise<InjectedConnection> {
    let accounts: Address[];
    try {
      accounts = parseAccounts(await this.provider.request({ method: 'eth_requestAccounts' }));
    } catch (error) {
      throw walletError(error, 'Connecting');
    }
    const account = accounts[0];
    if (account === undefined) throw new InjectedWalletError('no_accounts', 'The wallet did not share an account.');
    let chainId: number | null;
    try {
      chainId = parseChainId(await this.provider.request({ method: 'eth_chainId' }));
    } catch (error) {
      throw walletError(error, 'Reading the network');
    }
    if (chainId === null) throw new InjectedWalletError('wallet_error', 'The wallet reported a malformed chain id.');
    this.connected = true;
    return Object.freeze({ account, chainId });
  }

  /** The Switch click: only to a write chain; adds it (local anvil, BNB Chain testnet) when the wallet does not know it. */
  async switchChain(chainId: number): Promise<void> {
    if (!this.connected) throw new InjectedWalletError('not_connected', 'Connect the wallet first.');
    if (!isWriteChainId(chainId)) throw new InjectedWalletError('unsupported_chain', `Square Hole does not send transactions on chain ${chainId}.`);
    const chain: WriteChain = writeChain(chainId, { localRpcUrl: this.localRpcUrl });
    try {
      await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex(chainId) }] });
      return;
    } catch (error) {
      if (rpcErrorCode(error) !== RPC_CODES.unrecognizedChain) throw walletError(error, 'Switching networks');
      if (chain.addChain === null) {
        throw new InjectedWalletError('chain_unknown_to_wallet', `The wallet does not know ${chain.name} (${chainId}); add it in the wallet, then switch again.`);
      }
    }
    try {
      await this.provider.request({ method: 'wallet_addEthereumChain', params: [chain.addChain] });
      await this.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex(chainId) }] });
    } catch (error) {
      throw walletError(error, `Adding ${chain.name}`);
    }
  }

  /** The Sign click (LINKS-WEB): `signTypedDataV4` on this wallet, once connected. */
  async signTypedData(account: Address, typedData: unknown): Promise<`0x${string}`> {
    if (!this.connected) throw new InjectedWalletError('not_connected', 'Connect the wallet first.');
    return signTypedDataV4(this.request, account, typedData);
  }

  onAccountsChanged(listener: (accounts: readonly Address[]) => void): () => void {
    return this.attach('accountsChanged', (value) => listener(parseAccounts(value)));
  }

  onChainChanged(listener: (chainId: number) => void): () => void {
    return this.attach('chainChanged', (value) => {
      const chainId = parseChainId(value);
      if (chainId !== null) listener(chainId);
    });
  }

  /** EIP-1193 `disconnect`: the wallet lost its connection to every chain. */
  onDisconnect(listener: () => void): () => void {
    return this.attach('disconnect', () => listener());
  }

  /** The Disconnect click. Best-effort permission revocation; the local connection is always dropped. */
  async disconnect(): Promise<void> {
    const wasConnected = this.connected;
    this.connected = false;
    this.detachAll();
    if (!wasConnected) return;
    try {
      await this.provider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    } catch {
      // Not every wallet supports EIP-2255; the app forgets the connection either way.
    }
  }

  private attach(event: string, listener: Listener): () => void {
    if (typeof this.provider.on !== 'function') return () => undefined;
    this.provider.on(event, listener);
    const entry: [string, Listener] = [event, listener];
    this.attached.push(entry);
    return () => {
      const index = this.attached.indexOf(entry);
      if (index >= 0) this.attached.splice(index, 1);
      this.provider.removeListener?.(event, listener);
    };
  }

  private detachAll(): void {
    for (const [event, listener] of this.attached.splice(0)) this.provider.removeListener?.(event, listener);
  }
}
