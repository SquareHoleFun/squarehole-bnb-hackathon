// Types of local-core-chain.mjs for the TypeScript scripts and tests that drive it (test tooling).
export const LIFE_STAGES: readonly ['upcoming', 'window', 'bonding', 'closed', 'graduated', 'word', 'draw', 'busy', 'deepen', 'stream'];
export type LifeStage = (typeof LIFE_STAGES)[number];
export const TWIN_CHAIN_ID: 11155111;
export interface LocalCoreChain {
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly port: number;
  readonly manifest: string;
  readonly factory: `0x${string}`;
  readonly registry: `0x${string}`;
  readonly swapper: `0x${string}`;
  readonly coordinator: `0x${string}`;
  readonly token: `0x${string}`;
  readonly hook: `0x${string}`;
  readonly tickets: `0x${string}`;
  readonly randomness: `0x${string}`;
  readonly creationBlock: bigint;
  /** Box 0's open and window end (Unix seconds; hook.openAt(), hook.windowEndsAt()). */
  readonly openAt: bigint;
  readonly windowEndsAt: bigint;
  readonly accounts: Readonly<Record<'deployer' | 'alice' | 'bob' | 'carol' | 'keeper', `0x${string}`>>;
  readonly stages: Record<string, number>;
  readonly out: string;
  stop(): Promise<void>;
  life(options?: { readonly until?: LifeStage; readonly onStage?: (name: LifeStage, block: number) => Promise<void> | void; readonly log?: (line: string) => void }): Promise<unknown>;
}
/** What `<out>/local-core-chain.json` holds (blocks and times as decimal strings), and what `runLife` needs back (bigint). */
export type CoreChainDescription = Omit<LocalCoreChain, 'stop' | 'life' | 'out' | 'creationBlock' | 'openAt' | 'windowEndsAt'> & { readonly creationBlock: string; readonly openAt: string; readonly windowEndsAt: string };
export function runLife(
  chain: Omit<LocalCoreChain, 'stop' | 'life'>,
  options?: { readonly until?: LifeStage; readonly onStage?: (name: LifeStage, block: number) => Promise<void> | void; readonly log?: (line: string) => void },
): Promise<unknown>;
export function startLocalCoreChain(options: { readonly port: number; readonly outDir: string; readonly openIn?: number; readonly log?: (line: string) => void }): Promise<LocalCoreChain>;
export function rpc(url: string, method: string, params?: readonly unknown[]): Promise<unknown>;
export function head(url: string): Promise<bigint>;
export function drandVectors(): { readonly first: number; timeOf(round: number | bigint): bigint; signatureOf(round: number | bigint): `0x${string}`; readonly period: bigint };
