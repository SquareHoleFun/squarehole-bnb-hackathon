/**
 * The data source cannot serve the request right now (network, indexer or RPC outage). A read failure is never a
 * zero balance or an empty feed (06-ARCHITECTURE): the UI shows an explicit unavailable state and may retry.
 */
export class ProviderUnavailableError extends Error {
  override readonly name = 'ProviderUnavailableError';
  readonly code = 'provider_unavailable';
  readonly retryable = true;
}
