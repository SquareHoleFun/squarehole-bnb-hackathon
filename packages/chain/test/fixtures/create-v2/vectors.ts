import { readFileSync } from 'node:fs';
import { decodeAbiParameters, type Address, type Hex } from 'viem';
import { boxSpecV2Parameter } from '../../../src/core/v2/abi-v2';
import type { BoxSpecV2 } from '../../../src/core/v2/spec-v2';

interface Part { data: Hex; root: Hex; chunks: Hex[]; nextHashes: Hex[] }
export interface CreateVector {
  factory: Address; creator: Address; priceToken: Address; tokenAddressLimit: Address;
  predictionSpecEncoded: Hex; specEncoded: Hex; chunkMax: string; cs: Hex; hs: Hex; coordinator: Address; token: Address; hook: Address;
  predictions: { coordinator: Address; token: Address; initHash: Hex }[];
  table: Part; texts: Part;
}
export const vectors = [0, 1, 2, 3].map(i => JSON.parse(readFileSync(new URL(`./${i}.json`, import.meta.url), 'utf8')) as CreateVector);
export const specOf = (v: CreateVector): BoxSpecV2 => decodeAbiParameters([boxSpecV2Parameter], v.specEncoded)[0] as BoxSpecV2;

export const reserved = JSON.parse(readFileSync(new URL('./reserved.json', import.meta.url), 'utf8')) as { coordinator: Address; initHash: Hex; hs: Hex; hook: Address };
