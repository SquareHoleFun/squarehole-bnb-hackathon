#!/usr/bin/env node
// A curl process fixture for alpha.squarehole.fun (SH-LANDING-ALPHA): answers as the Caddyfile's alpha site does, with
// the headers of its alpha_headers snippet and the files in LANDING_FIXTURE_PUBLIC, without binding a port or making a
// request. LANDING_FIXTURE_FAULT plants one drift for the checker to catch.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const url = new URL(args.at(-1));
const fault = process.env.LANDING_FIXTURE_FAULT;
appendFileSync(process.env.LANDING_FIXTURE_TRACE, `${url}\n`);
appendFileSync(`${process.env.LANDING_FIXTURE_TRACE}.files`, `${args[args.indexOf('--dump-header') + 1]}\n`);
// The checker must start with -q, so no ~/.curlrc can add redirect following or tracing (XR-SH-ACCESS-SMOKE F1).
if (args[0] !== '-q') process.exit(2);
if (fault === 'network') process.exit(7);
// 'curl-error': like real curl's parser errors (e.g. an invalid chunk size), the message quotes response bytes, here
// the token's; curl prints it only with --show-error (XR-SH-ACCESS-SMOKE-R2 F2).
if (fault === 'curl-error') {
  const tokenAt = args.findIndex((arg, i) => args[i - 1] === '--header' && arg.startsWith('@'));
  writeFileSync(args[args.indexOf('--dump-header') + 1], 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n');
  if (args.includes('--show-error')) process.stderr.write(`curl: (56) invalid chunk size: 'f${tokenAt < 0 ? 'none' : readFileSync(args[tokenAt].slice(1), 'utf8').slice(0, 60)}'\n`);
  process.exit(56);
}

const caddy = readFileSync(process.env.LANDING_FIXTURE_CADDYFILE, 'utf8');
const start = caddy.indexOf('(alpha_headers) {\n');
const headers = {};
for (const line of start < 0 ? [] : caddy.slice(start, caddy.indexOf('\n}', start)).split('\n')) {
  const match = line.match(/^\t\t(\S+) "(.*)"$/);
  if (match) headers[match[1]] = match[2];
}
headers['Cache-Control'] = 'no-cache';

const publicDir = process.env.LANDING_FIXTURE_PUBLIC;
let status = 200;
let body = Buffer.alloc(0);
if (url.hostname !== 'alpha.squarehole.fun') {
  status = 421;
} else if (url.pathname === '/robots.txt') {
  headers['Content-Type'] = 'text/plain; charset=utf-8';
  body = Buffer.from(fault === 'robots' ? 'User-agent: *\nAllow: /\n' : 'User-agent: *\nDisallow: /\n');
} else {
  try {
    if (url.pathname === '/_headers' || url.pathname === '/_routes.json') throw new Error('not published');
    body = readFileSync(join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
  } catch {
    status = 404;
    body = readFileSync(join(publicDir, '404.html'));
  }
}
if (fault === 'redirect') {
  status = 301;
  headers.Location = `https://squarehole.fun${url.pathname}${url.search}`;
  body = Buffer.alloc(0);
}
// 'access': Cloudflare Access sends its login redirect unless curl reads a service token header file (--header @file).
const tokenFile = args.find((arg, i) => args[i - 1] === '--header' && arg.startsWith('@'));
if (fault === 'access' && !/^CF-Access-Client-Id: \S+\nCF-Access-Client-Secret: \S+\n$/.test(tokenFile ? readFileSync(tokenFile.slice(1), 'utf8') : '')) {
  status = 302;
  for (const key of Object.keys(headers)) Reflect.deleteProperty(headers, key);
  headers.Location = 'https://example-team.cloudflareaccess.com/cdn-cgi/access/login/alpha.squarehole.fun';
  body = Buffer.alloc(0);
}
// 'reflect': the response echoes the token file's contents back (XR-SH-ACCESS-SMOKE F2).
if (fault === 'reflect' && tokenFile) headers['X-Robots-Tag'] = readFileSync(tokenFile.slice(1), 'utf8').replace(/\n/g, ' ');
if (fault === 'noindex') delete headers['X-Robots-Tag'];
if (fault === 'security') delete headers['X-Frame-Options'];
if (fault === 'cache') headers['Cache-Control'] = 'public, max-age=604800';
if (fault === 'body' && url.pathname === '/') body = Buffer.from('an older preview');
if (fault === 'status' && status === 404) status = 200;
writeFileSync(args[args.indexOf('--dump-header') + 1], `HTTP/2 ${status}\r\n${Object.entries(headers).map(([key, value]) => `${key.toLowerCase()}: ${value}\r\n`).join('')}\r\n`);
writeFileSync(args[args.indexOf('--output') + 1], body);
process.stdout.write(String(status));
