/**
 * The viem entry points the service adapter (infra/server/services/keeper.mjs) builds its clients and signers with,
 * from this package's own viem. Every error such a client throws is then one of the classes read-failure.ts checks
 * with instanceof. A CommonJS `require('viem')` loads a second copy of viem whose reverts are never recognized as
 * reverts: on Sepolia each reverted simulation became "simulation error" and waiting work (SH-109).
 */
export { createPublicClient, defineChain, http } from 'viem';
export { privateKeyToAccount } from 'viem/accounts';
