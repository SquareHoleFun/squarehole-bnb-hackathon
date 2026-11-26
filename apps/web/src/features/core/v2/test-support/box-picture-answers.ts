/**
 * SH-255 fixtures, the answers alone (no parser, so a browser spec can import them): the six boxes live on Sepolia as
 * api.squarehole.fun answered them on 23 November 2026, 11:51 UTC (block 12,195,510; Rent Free's one block later),
 * saved by the box-page prototype, each less its row's role-keyed copy of the code hashes (`row.codeHashes`), as the
 * box-life fixtures drop it. Public chain data only. box-picture-v2.ts parses them as the page does.
 */
import gpuPoor from '../../../../../e2e/fixtures/box-picture/gpu-poor.json' with { type: 'json' };
import dragonsHoard from '../../../../../e2e/fixtures/box-picture/dragons-hoard.json' with { type: 'json' };
import oneDollar from '../../../../../e2e/fixtures/box-picture/one-dollar.json' with { type: 'json' };
import theAlchemist from '../../../../../e2e/fixtures/box-picture/the-alchemist.json' with { type: 'json' };
import sam from '../../../../../e2e/fixtures/box-picture/sam.json' with { type: 'json' };
import rentFree from '../../../../../e2e/fixtures/box-picture/rent-free.json' with { type: 'json' };

type Json = Record<string, unknown>;

/** The block the six were read at (Rent Free's one later). */
export const BOX_PICTURE_BLOCK = 12_195_510n;

export const BOX_PICTURE_ANSWERS: Readonly<Record<string, Json>> = Object.freeze({
  'gpu-poor': gpuPoor as Json, 'dragons-hoard': dragonsHoard as Json, 'one-dollar': oneDollar as Json,
  'the-alchemist': theAlchemist as Json, sam: sam as Json, 'rent-free': rentFree as Json,
});
export const BOX_PICTURE_NAMES: readonly string[] = Object.freeze(Object.keys(BOX_PICTURE_ANSWERS));

/**
 * The listed price and pile coins the six boxes use, by address, as their contracts answer `symbol()` and `decimals()`.
 * Copied from the committed Sepolia coin deployment (packages/chain/src/trade-sepolia/coin-deployment.json, its `pairs`),
 * which test code outside the trade folders may not import (no-trade-source.test.ts): one named constant per coin.
 */
export const BOX_PICTURE_COINS: readonly { readonly coin: string; readonly symbol: string; readonly decimals: number }[] = Object.freeze([
  { coin: '0x5B397F65571deF193Ba5DBE8b2a353C3963c65F6', symbol: 'tUSDC', decimals: 6 },
  { coin: '0x2cbBAD2607fCCFEe778d959d386997862099f33B', symbol: 'tNVDA', decimals: 18 },
  { coin: '0x25f276Ce776f5C9b0686250e78EA34bF7aB4C17A', symbol: 'tGOLD', decimals: 18 },
  { coin: '0x1C5231c8BDde9ED7AA80Fe13EDb634db9Bd3E1c7', symbol: 'tPEPE', decimals: 18 },
]);
