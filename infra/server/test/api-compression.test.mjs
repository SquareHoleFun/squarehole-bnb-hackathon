import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const config = readFileSync(new URL('../Caddyfile', import.meta.url), 'utf8');

// Deliberately small parse of the owned site's blocks; ignore comments and placeholder braces.
function block(text, start) {
  const lines = text.slice(text.indexOf(start)).split('\n');
  expect(text).toContain(start);
  let depth = 0;
  const out = [];
  for (const line of lines) {
    const code = line.split('#')[0].trim();
    if (code.endsWith('{')) depth++;
    if (code === '}') depth--;
    out.push(code);
    if (depth === 0) return out.join('\n');
  }
  throw new Error(`unclosed block: ${start}`);
}

it('CAP-1: API negotiates zstd/gzip only for JSON, preserving SSE flushes and upstream validators', () => {
  const site = block(config, 'http://api.squarehole.fun, https://api.squarehole.fun {');
  expect(site).toContain('import gateway');
  const encode = block(site, 'encode zstd gzip {');
  const match = block(encode, 'match {');
  expect(match).toMatch(/header Content-Type application\/json\*/);
  expect(match).not.toMatch(/text\/|\*\/\*|event-stream/);
  const gateway = block(config, '(gateway) {');
  const api = block(gateway, 'handle @api {');
  expect(api).toContain('flush_interval -1');
  expect(api).not.toMatch(/buffer_responses|response_buffers|header_down [-+]?Cache-Control|header_down [-+]?ETag/i);
  expect(gateway).toContain('Access-Control-Allow-Headers If-None-Match');
  expect(gateway).toContain('Access-Control-Allow-Origin {http.request.header.Origin}');
});
