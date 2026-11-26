import { createServer } from 'node:http';
import { createArtHandler } from './gateway.mjs';

const handler = createArtHandler();
const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000, keepAliveTimeout: 1000 }, handler);
server.maxConnections = 32;
server.listen(8081, '0.0.0.0');
process.on('SIGTERM', () => server.close());
