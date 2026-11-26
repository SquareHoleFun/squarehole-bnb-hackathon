// @squarehole/indexer/client: the browser-safe part of the live curve indexer, for the app's FIT pair page (v2 T19).
// The launch shapes, the exact v4 math, the curve point, and the JSON views the gateway serves (`sh.live-pool.v1`):
// the page parses the gateway's frames against these types and builds its Demo stream with the same view builders,
// so a Demo frame and a real one have one shape. Nothing here opens a socket, reads an RPC, touches Redis or Node
// (client.test.ts walks the import graph).
export * from './shape';
export * from './v4-math';
export * from './curve';
export * from './model';
export * from './views';
// Core v1 (S10a): the gateway's answers (`sh.core-feed.v1`, `sh.core-box.v1`, `sh.core-wallet.v1`) with their parsers,
// the box's own-order price and amount math, and the phase rule; the site reads boxes through these.
export * from './core/core-math';
export * from './core/core-views';
export * from './core/core-fees';
export { CORE_PHASES, CONTRACT_PHASE, phaseAt, type CorePhase } from './core/derive-core';
export { initialCoreState } from './core/derive-core';
export * from './core/direct-view';
