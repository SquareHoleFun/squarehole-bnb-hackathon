export function afterSetWindow(actions: {
  effectiveOpenAt(): Promise<bigint>;
  windowSeconds(): Promise<bigint>;
  mineTo(timestamp: bigint): Promise<unknown>;
  recipe(): Promise<unknown>;
}): Promise<void>;
export function prepareFundedSetPick<T extends {blockNumber: bigint; quote: {tokenIn: bigint}}>(actions: {
  prepare(): Promise<T>;
  balance(blockNumber: bigint): Promise<bigint>;
  buy(): Promise<unknown>;
}): Promise<T>;
