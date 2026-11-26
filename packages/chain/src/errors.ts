/**
 * Typed chain errors. A read failure is never turned into a zero, an empty list or an empty feed (06-ARCHITECTURE:
 * "A chain read failure is not zero balance"): callers get one of these and show an unavailable or stale state.
 */

abstract class CodedChainError<Code extends string> extends Error {
  readonly code: Code;

  constructor(code: Code, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

export type ChainConfigErrorCode =
  | 'unsupported_chain'
  | 'invalid_manifest'
  | 'manifest_chain_mismatch'
  | 'non_canonical_pool_manager'
  | 'invalid_rpc_url'
  | 'no_rpc_url';

/** The per-chain configuration or its deployment manifest cannot be used. Nothing is read from such a config. */
export class ChainConfigError extends CodedChainError<ChainConfigErrorCode> {
  override readonly name = 'ChainConfigError';
}

/**
 * Square Hole has no deployment manifest for this chain (for Sepolia: Stage E has not happened yet). Honest "not
 * deployed" state, never an empty feed.
 */
export class ChainNotDeployedError extends CodedChainError<'not_deployed'> {
  override readonly name = 'ChainNotDeployedError';
  readonly chainId: number;

  constructor(chainId: number, message: string) {
    super('not_deployed', message);
    this.chainId = chainId;
  }
}

/**
 * The RPC could not answer (all fallback endpoints failed, timed out, or answered for another chain). Retryable;
 * mirrors `ProviderUnavailableError` of @squarehole/providers (same `code`), so the UI treats both alike.
 */
export class ChainUnavailableError extends CodedChainError<'provider_unavailable'> {
  override readonly name = 'ChainUnavailableError';
  readonly retryable = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super('provider_unavailable', message, options);
  }
}

export type ChainDataErrorCode = 'wrong_chain' | 'inconsistent_state' | 'unknown_event' | 'reorg_too_deep';

/** The chain answered with data that contradicts the deployment or itself. Never silently repaired. */
export class ChainDataError extends CodedChainError<ChainDataErrorCode> {
  override readonly name = 'ChainDataError';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException ? error.name === 'AbortError' : error instanceof Error && error.name === 'AbortError';
}

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
