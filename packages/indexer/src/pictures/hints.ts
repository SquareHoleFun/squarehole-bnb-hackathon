import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { arweaveIdSchema, pictureHash, type PictureSpec } from './types';
import type { PictureCopiesService } from './service';

export const HINT_PATH = '/v2/pictures/hint';
export const HINT_LIMITS = Object.freeze({ bodyBytes: 1024, bodyMs: 2000, perClient: 10, perMinute: 60, concurrent: 4 });
const submission = z.strictObject({
  chainId: z.number().int().positive().safe(),
  box: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  kind: z.enum(['logo', 'cover']),
  arweaveId: arweaveIdSchema,
});
export interface HintReply { status: number; body: { arweaveId: string } | { error: string }; headers?: Record<string, string> }
const refuse = (status: number, error: string): HintReply => ({ status, body: { error },
  ...([429, 503].includes(status) ? { headers: { 'Retry-After': '60' } } : {}) });

type Body = { text: string } | { error: string; status: number };
function readBody(req: IncomingMessage): Promise<Body> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || BigInt(length) > BigInt(HINT_LIMITS.bodyBytes))) {
    return Promise.resolve({ error: 'body too large', status: 413 });
  }
  return new Promise(resolve => {
    const chunks: Buffer[] = []; let size = 0; let done = false;
    const finish = (result: Body) => {
      if (done) return; done = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed); req.off('close', closed);
      req.pause(); resolve(result);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
      if (size > HINT_LIMITS.bodyBytes) finish({ error: 'body too large', status: 413 }); else chunks.push(bytes);
    };
    const end = () => finish({ text: Buffer.concat(chunks).toString('utf8') });
    const failed = () => finish({ error: 'bad json', status: 400 });
    const closed = () => { if (!req.complete) failed(); };
    const timer = setTimeout(() => finish({ error: 'body timeout', status: 408 }), HINT_LIMITS.bodyMs);
    req.on('data', data); req.on('end', end); req.on('error', failed); req.on('aborted', failed); req.on('close', closed);
  });
}

/** One admission budget per server, including body readers. No queue and at most 60 retained client keys. */
export class PictureHints {
  private active = 0;
  private starts: { client: string; time: number }[] = [];
  constructor(private readonly options: {
    chainId: number; pictures: PictureCopiesService; following: () => boolean;
    specOf: (box: string) => PictureSpec | null; now?: () => number;
  }) {}
  async post(req: IncomingMessage, client: string): Promise<HintReply> {
    const now = (this.options.now ?? Date.now)();
    this.starts = this.starts.filter(start => now - start.time < 60_000);
    if (this.starts.filter(start => start.client === client).length >= HINT_LIMITS.perClient) return refuse(429, 'client limit');
    if (this.active >= HINT_LIMITS.concurrent || this.starts.length >= HINT_LIMITS.perMinute) return refuse(503, 'hint limit');
    this.starts.push({ client, time: now }); this.active++;
    try {
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')
        || (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity')) return refuse(415, 'content type');
      const read = await readBody(req);
      if ('error' in read) return refuse(read.status, read.error);
      let json: unknown;
      try { json = JSON.parse(read.text); } catch { return refuse(400, 'bad json'); }
      const parsed = submission.safeParse(json);
      if (!parsed.success) return refuse(400, 'bad hint');
      const body = parsed.data;
      if (body.chainId !== this.options.chainId) return refuse(404, 'no chain');
      if (!this.options.following()) return refuse(503, 'not following');
      const box = body.box.toLowerCase();
      const spec = this.options.specOf(box);
      if (!spec) return refuse(404, 'no box');
      const field = body.kind === 'logo' ? 'coverSha256' : 'collectionCoverSha256';
      const hash = pictureHash(spec[field]);
      if (!hash) return refuse(422, 'no committed picture');
      const result = await this.options.pictures.hint(hash, body.arweaveId, () =>
        this.options.following() && pictureHash(this.options.specOf(box)?.[field] ?? '') === hash);
      if ('arweaveId' in result) return { status: 200, body: result };
      return refuse(result.error === 'unverified picture' ? 422 : result.error === 'unavailable' ? 503 : 409, result.error);
    } finally { this.active--; }
  }
}
