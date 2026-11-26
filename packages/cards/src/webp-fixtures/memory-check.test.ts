import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shLimit } from '../../../../vitest.timeouts.mjs';

type Answer = { status: number; headers: Record<string, string>; body: Buffer };
type Reply = { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: Buffer) => void; destroy: (error: Error) => void };
const stub = vi.hoisted(() => ({
  handle: undefined as undefined | (() => Promise<Answer>),
  request: undefined as undefined | ((request: object, reply: Reply) => void),
  draws: 0, conversionsPerDraw: 1, invalidCard: false,
  close: vi.fn(),
}));
const card = () => {
  const bytes = Buffer.alloc(100);
  bytes.writeUInt32BE(1200, 16); bytes.writeUInt32BE(stub.invalidCard ? 1 : 630, 20);
  return bytes;
};
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: (path: Parameters<typeof actual.readFileSync>[0]) => {
    if (String(path).endsWith('/memory.max')) return '1073741824';
    if (String(path).endsWith('/memory.events')) return 'oom 0\noom_kill 0';
    if (String(path).startsWith('/sys/fs/cgroup/')) return '100000000';
    return actual.readFileSync(path);
  } };
});
vi.mock('node:http', () => ({ createServer: (request: typeof stub.request) => {
  stub.request = request;
  const server = new EventEmitter();
  return Object.assign(server, {
    listen() { queueMicrotask(() => server.emit('listening')); },
    address: () => ({ port: 1 }), closeAllConnections: vi.fn(), close: vi.fn(),
  });
} }));
vi.mock('@squarehole/artwork/box-picture', () => ({ inspectBoxPicture: () => ({ type: 'image/webp', width: 2048, height: 2048, frames: 1 }) }));
vi.mock('../webp-decoder.ts', () => ({ WebpDecoder: { start: async () => ({ available: true }) }, WEBP_LIMITS: { deadlineMs: shLimit(2500) } }));
vi.mock('../engine.ts', () => ({ nodeCardEngine: async () => ({ decodeWebp: async () => ({ bytes: { length: 14370469 } }) }), nodeCardAssets: () => ({}) }));
vi.mock('../share-render.ts', () => ({ renderCardPng: async () => card() }));
vi.mock('./memory-input.ts', () => ({ memoryWebp: (density: number) => Buffer.alloc(790040, density) }));
vi.mock('../service/card-service.ts', () => {
  class Cache extends Map<string, Buffer> {
    get totalBytes() { return [...this.values()].reduce((sum, bytes) => sum + bytes.length, 0); }
  }
  return { cardName: () => 'drawn', CardService: class {
    cards = new Cache();
    facts = new Map();
    constructor(options: { engine: { decodeWebp: () => Promise<unknown> } }) {
      stub.handle = async () => {
        for (let i = 0; i < stub.conversionsPerDraw; i++) await options.engine.decodeWebp();
        stub.draws++;
        return { status: 200, headers: { 'x-sh-card': 'logo=yes; card=drawn' }, body: card() };
      };
    }
    handle() { return stub.handle?.(); }
    close = stub.close;
  } };
});
beforeEach(() => {
  vi.resetModules();
  stub.draws = 0; stub.conversionsPerDraw = 1; stub.invalidCard = false;
  stub.close.mockClear();
  vi.stubGlobal('fetch', async (url: string) => {
    let status = 0, headers: Record<string, string> = {};
    const body = await new Promise<Buffer>((resolve, reject) => stub.request?.({ method: 'GET', url }, {
      writeHead: (code, values) => { status = code; headers = values; }, end: resolve, destroy: reject,
    }));
    return { status, headers: { get: (name: string) => headers[name] }, arrayBuffer: async () => body };
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const runMemoryCheck = () => {
  // @ts-expect-error This executable JavaScript fixture exports no typed API.
  return import('./memory-check.mjs');
};

it('memory check counts four conversions and four completed card responses', async () => {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  await runMemoryCheck();
  expect(stub.draws).toBe(4);
  expect(output.filter(line => line.startsWith('cards memory: draw=')).map(line => line.match(/draw=(\d)\/4/)?.[1])).toEqual(['1', '2', '3', '4']);
  expect(output.at(-1)).toMatch(/^cards memory: conversions=4 completed=4 memory_max=1073741824 /);
  expect(stub.close).toHaveBeenCalledOnce();
});

it.each([0, 2])('memory check rejects %i conversions for one card response', async count => {
  stub.conversionsPerDraw = count;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await expect(runMemoryCheck()).rejects.toThrow('each request must run its own decoder child');
  expect(output).not.toHaveBeenCalled();
  expect(stub.close).toHaveBeenCalledOnce();
});

it('memory check refuses an incomplete card before recording a draw', async () => {
  stub.invalidCard = true;
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  await expect(runMemoryCheck()).rejects.toThrow();
  expect(output).not.toHaveBeenCalled();
  expect(stub.close).toHaveBeenCalledOnce();
});
