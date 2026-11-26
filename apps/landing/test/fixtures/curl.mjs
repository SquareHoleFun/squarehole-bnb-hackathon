#!/usr/bin/env node
// A curl process fixture: exercises the real shell smoke checker without binding a port or making a request.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const url = new URL(args.at(-1));
const fault = process.env.LANDING_FIXTURE_FAULT;
const publicDir = process.env.LANDING_FIXTURE_PUBLIC;
appendFileSync(process.env.LANDING_FIXTURE_TRACE, `${url}\n`);
if (fault === 'network') process.exit(7);
let status = 200;
let body = Buffer.alloc(0);
const headers = {};
if (url.hostname !== 'squarehole.fun') {
  status = 301;
  headers.Location = `https://squarehole.fun${url.pathname}${fault === 'redirect' ? '' : url.search}`;
  headers['Cache-Control'] = 'public, max-age=86400';
} else {
  for (const line of readFileSync(join(publicDir, '_headers'), 'utf8').split('\n\n')[0].split('\n')) {
    const match = line.match(/^\s+([^:]+): (.+)$/);
    if (match) headers[match[1]] = match[2];
  }
  headers['Cache-Control'] = /^(\/art\/|\/fonts\/|\/brand\/)/.test(url.pathname) ? 'public, max-age=604800' : 'no-cache';
  if (url.pathname.startsWith('/nft/')) {
    status = 404;
    headers['Cache-Control'] = 'public, max-age=86400';
    if (fault === 'nft') body = Buffer.from('expensive metadata response');
  } else {
    try {
      if (url.pathname.startsWith('/_')) throw new Error('not published');
      body = readFileSync(join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
    } catch {
      status = 404;
      headers['Cache-Control'] = 'no-cache';
      body = readFileSync(join(publicDir, '404.html'));
    }
  }
  if (fault === 'security') delete headers['X-Frame-Options'];
  if (fault === 'cache') headers['Cache-Control'] = 'public, max-age=14400';
  if (fault === 'body') body = Buffer.from('wrong release');
  if (fault === 'status') status = 200;
}
writeFileSync(args[args.indexOf('--dump-header') + 1], `HTTP/2 ${status}\r\n${Object.entries(headers).map(([key, value]) => `${key.toLowerCase()}: ${value}\r\n`).join('')}\r\n`);
writeFileSync(args[args.indexOf('--output') + 1], body);
process.stdout.write(String(status));
