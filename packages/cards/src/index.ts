/**
 * What a box's card says and the box read behind it, for the Pages function (apps/web/src/share: the box page's tags)
 * and the card service (./service). Runtime-neutral: no node: imports, no renderer. The drawing is in ./render, the
 * Node engine in ./engine.
 */
export * from './share-model';
export * from './share-read';
export { chainShareReader, MAX_DIRECT_ROWS, readDirectBox, shareClient, type DirectClient } from './share-direct';
export { originOf, rpcUrlsOf } from './origin';
