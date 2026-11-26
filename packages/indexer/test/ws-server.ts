/**
 * A minimal local websocket server for the head-feed tests (RFC 6455 handshake and unmasked text frames from the
 * server; what the client sends is ignored). Enough to push `newHeads` notifications, stay silent, or close at once,
 * without a network or a dependency.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface TestWsServer {
  readonly url: string;
  /** Connections accepted so far. */
  readonly connections: () => number;
  /** Times at which connections were accepted (ms). */
  readonly connectedAt: number[];
  /** Pushes a newHeads notification to every open connection. */
  push(head: { number: bigint; hash: string; parentHash: string; timestamp: bigint }): void;
  /** Closes every open connection (an abnormal close, as a dropped TCP connection). */
  dropAll(): void;
  close(): Promise<void>;
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** `acceptAfter`: the first N connections are closed right after the handshake (a provider refusing sockets). */
export async function startWsServer(options: { acceptAfter?: number } = {}): Promise<TestWsServer> {
  const sockets = new Set<Socket>();
  const connectedAt: number[] = [];
  let accepted = 0;
  const server: Server = createServer((_req, res) => res.writeHead(426).end());
  server.on('upgrade', (req, socket: Socket) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    accepted += 1;
    connectedAt.push(Date.now());
    socket.on('error', () => undefined);
    socket.on('data', () => undefined);
    if (accepted <= (options.acceptAfter ?? 0)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return {
    url: `ws://127.0.0.1:${address.port}`,
    connections: () => accepted,
    connectedAt,
    push(head) {
      const message = JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_subscription',
        params: { subscription: '0x1', result: { number: `0x${head.number.toString(16)}`, hash: head.hash, parentHash: head.parentHash, timestamp: `0x${head.timestamp.toString(16)}` } },
      });
      for (const socket of sockets) socket.write(frame(message));
    },
    dropAll() {
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
