import type { Address, Hex } from 'viem';

export interface Order {
  readonly sellToken: Address;
  readonly buyToken: Address;
  readonly receiver: Address;
  readonly sellAmount: bigint;
  readonly buyAmount: bigint;
  readonly validTo: number;
  readonly appData: Hex;
  readonly feeAmount: bigint;
  readonly kind: Hex;
  readonly partiallyFillable: boolean;
  readonly sellTokenBalance: Hex;
  readonly buyTokenBalance: Hex;
}
export interface Target {
  readonly inbox: Address;
  readonly coin: Address;
  readonly composableCow: Address;
  readonly settlement: Address;
  readonly params: { readonly handler: Address; readonly salt: Hex; readonly staticInput: Hex };
}
export type Tradeable =
  | { readonly type: 'order'; readonly order: Order; readonly signature: Hex; readonly domainSeparator: Hex }
  | { readonly type: 'PollTryAtEpoch'; readonly epoch: bigint }
  | { readonly type: 'PollTryNextBlock'; readonly block: bigint }
  | { readonly type: 'OrderNotValid' | 'no_data' };
export interface ChainReader {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  discover(): Promise<{ targets: Target[]; errors: number }>;
  tradeable(target: Target): Promise<Tradeable>;
}
export interface CowApi {
  quote(order: Order, from: Address): Promise<{ feeAmount: bigint } | null>;
  post(order: Order, from: Address, signature: Hex): Promise<string | null>;
  status(uid: string): Promise<string | null>;
  /** The stored order's status and signature bytes (RC6RR2-COW-2); null when CoW gives no such order. */
  stored(uid: string): Promise<{ status: string | null; signature: Hex | null } | null>;
}
export interface ReservationStore {
  has(uid: string): Promise<boolean>;
  /** Durable exclusive reservation BEFORE the HTTP side effect; false means already reserved. */
  reserve(uid: string): Promise<boolean>;
}
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}
export type Log = (event: string, fields?: Readonly<Record<string, string | number | bigint | boolean>>) => void;
export interface Health {
  phase: 'running' | 'idle';
  /** A dry run discovers, reads and quotes but never reserves or posts; only `live` posts. */
  mode: 'dry-run' | 'live';
  chainId: number;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  targets: number;
  posted: number;
  skipped: number;
  errors: number;
}
