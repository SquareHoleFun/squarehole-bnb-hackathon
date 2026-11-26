import { createCoreService, type CoreServiceOptions } from '../core-service';
import type { ClaimsReaderV2 } from './claims-reads-v2';

export interface ClaimsServiceOptionsV2 extends CoreServiceOptions {
  /** Use claimsRpcReaderV2 for sender-aware creator simulations on the same chain as reader. */
  readonly claimsReader: ClaimsReaderV2;
}

/** Explicit v2 reader entry point using the same composition as the core CLI. */
export function createClaimsServiceV2(options: ClaimsServiceOptionsV2) {
  return createCoreService(options);
}

/** Read-only v2 entry point; no signer, wallet access, deployment or transactions. */
export async function startClaimsServiceV2(options: ClaimsServiceOptionsV2) {
  const service = createClaimsServiceV2(options);
  await service.start();
  return service;
}
