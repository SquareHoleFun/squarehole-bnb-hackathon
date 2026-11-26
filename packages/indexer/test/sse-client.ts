/** A minimal SSE reader for tests and the measurement scripts: raw HTTP, comments kept (the `: gw <ms>` stamp). */
import { request, type Agent, type IncomingMessage } from 'node:http';

export interface SseMessage {
  readonly event: string;
  readonly id: string | null;
  readonly data: string;
  /** The gateway's write time from the `: gw <ms>` comment, if any. */
  readonly gwAtMs: number | null;
  /** Local receive time (ms). */
  readonly receivedAtMs: number;
}

export interface SseConnection {
  readonly messages: SseMessage[];
  readonly comments: string[];
  readonly status: Promise<number>;
  close(): void;
  waitFor(predicate: (message: SseMessage) => boolean, timeoutMs?: number): Promise<SseMessage>;
}

export function parseSseBlock(block: string, receivedAtMs: number): { message: SseMessage | null; comments: string[] } {
  let event = 'message';
  let id: string | null = null;
  const data: string[] = [];
  const comments: string[] = [];
  let gwAtMs: number | null = null;
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) {
      const comment = line.slice(1).trim();
      comments.push(comment);
      if (comment.startsWith('gw ')) gwAtMs = Number(comment.slice(3));
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  return { message: data.length > 0 ? { event, id, data: data.join('\n'), gwAtMs, receivedAtMs } : null, comments };
}

export function openSse(url: string, options: { headers?: Record<string, string>; agent?: Agent; onMessage?: (m: SseMessage) => void; keep?: boolean } = {}): SseConnection {
  const messages: SseMessage[] = [];
  const comments: string[] = [];
  const waiters: { predicate: (m: SseMessage) => boolean; resolve: (m: SseMessage) => void }[] = [];
  let buffer = '';
  let resolveStatus: (status: number) => void = () => undefined;
  const status = new Promise<number>((resolve) => (resolveStatus = resolve));
  const req = request(url, { headers: { Accept: 'text/event-stream', ...(options.headers ?? {}) }, ...(options.agent ? { agent: options.agent } : {}) }, (res: IncomingMessage) => {
    resolveStatus(res.statusCode ?? 0);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      const receivedAtMs = Date.now();
      buffer += chunk;
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseSseBlock(block, receivedAtMs);
        comments.push(...parsed.comments);
        if (parsed.message) {
          if (options.keep !== false) messages.push(parsed.message);
          options.onMessage?.(parsed.message);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(parsed.message)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(parsed.message);
            }
          }
        }
        index = buffer.indexOf('\n\n');
      }
    });
    res.on('error', () => undefined);
  });
  req.on('error', () => resolveStatus(0));
  req.end();
  return {
    messages,
    comments,
    status,
    close: () => req.destroy(),
    waitFor(predicate, timeoutMs = 5_000) {
      const found = messages.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise<SseMessage>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for an SSE message')), timeoutMs);
        waiters.push({ predicate, resolve: (m) => (clearTimeout(timer), resolve(m)) });
      });
    },
  };
}
