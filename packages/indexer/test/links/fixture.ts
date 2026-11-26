import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { privateKeyToAccount } from 'viem/accounts';
import { type Address, type Hex } from 'viem';
import { vi } from 'vitest';
import { boxLinksTypedData } from '../../../chain/src/core/v2/box-links-v2';
import { LinksService } from '../../src/links/links-service';
import { MemoryLinks } from '../../src/links/memory-links';
import type { LinksStore } from '../../src/links/types';
import { LinksV2, Erc1271Verifier, type SignatureCall, type CreatorCodeCall } from '../../src/core/v2/links-v2';

export const CHAIN = 11155111;
export const TOKEN = '0x1111111111111111111111111111111111111111';
export const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
export const HEAD = { number: 123n, timestamp: 1761300000n, hash: `0x${'ab'.repeat(32)}` as Hex };
export const LINKS = { website: 'https://junkyard.fun', x: 'Junk_yard', telegram: 'junkyard' };
export const SIGNATURE = '0xc2d0a83af6fe0e097b39a042b1e5fe56184a621be711cc968e0263d7a2ed4f590cea0ad7e60e38f02a6a9652805470c19e68dc0484b741c5ab06df3df62ea73e1c';
export const BODY = { ...LINKS, issuedAt: HEAD.timestamp.toString(), signature: SIGNATURE };
export const PATH = `/v2/boxes/${CHAIN}/${TOKEN}/links`;

export function request(body: unknown = BODY, options: { url?: string; method?: string; type?: string; length?: string; raw?: string; stall?: boolean } = {}) {
  const read = vi.fn();
  const req = new Readable({ read() { read(); if (options.stall) return; this.push(Buffer.from(options.raw ?? JSON.stringify(body))); this.push(null); } }) as IncomingMessage;
  Object.assign(req, { url: options.url ?? PATH, method: options.method ?? 'POST', headers: { 'content-type': options.type ?? 'text/plain', ...(options.length ? { 'content-length': options.length } : {}) }, socket: { remoteAddress: '198.51.100.17' } });
  return { req, read };
}
export class ResponseDouble extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  body = '';
  writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])); this.headersSent = true; }
  end(body = '') { this.body += body; }
  write(body: string) { this.body += body; return true; }
  destroy() { this.emit('close'); }
  asResponse() { return this as unknown as ServerResponse; }
  json() { return JSON.parse(this.body) as Record<string, unknown>; }
}

export async function signed(overrides: Partial<typeof BODY> = {}, chain = CHAIN, token: Address = TOKEN, account = ACCOUNT) {
  const body = { ...BODY, ...overrides };
  const data = boxLinksTypedData(chain, token, body, body.issuedAt);
  return { ...body, signature: await account.signTypedData({ ...data, domain: { ...data.domain, chainId: BigInt(chain) }, message: { ...data.message, issuedAt: BigInt(body.issuedAt) } }) };
}

export async function fixture(store: LinksStore = new MemoryLinks()) {
  const log = vi.fn();
  const service = new LinksService(store, CHAIN);
  await service.start();
  const code = vi.fn<CreatorCodeCall>(async () => '0x6000');
  const rpc = Object.assign(vi.fn<SignatureCall>(async () => '0x'), { getCode: code });
  const following = vi.fn(() => true);
  const creatorOf = vi.fn((token: string) => token.toLowerCase() === TOKEN ? ACCOUNT.address : null);
  const head = vi.fn(() => HEAD);
  const verifier = new Erc1271Verifier(rpc);
  const links = new LinksV2({ chainId: CHAIN, store: service, verifier, following, creatorOf, head, log });
  return { store, service, links, rpc, code, log, head, following, creatorOf, verifier };
}
