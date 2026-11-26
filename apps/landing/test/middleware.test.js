import { describe, expect, it, vi } from 'vitest';
import { CANONICAL_HOST, SECURITY_HEADERS, onRequest, redirectTarget } from '../functions/_middleware.js';

/** Runs the middleware for one URL; `next` stands in for Cloudflare's static file server. */
async function run(url, nextResponse = () => new Response('<!doctype html>page', { status: 200, headers: { 'Content-Type': 'text/html' } })) {
  const next = vi.fn(async () => nextResponse());
  const response = await onRequest({ request: new Request(url), next });
  return { response, next };
}

const REDIRECTED_HOSTS = [
  'www.squarehole.fun',
  'squarehole.xyz',
  'www.squarehole.xyz',
  'squarehole.fit',
  'www.squarehole.fit',
  'squarehole.pages.dev',
  '3f2a91c4.squarehole.pages.dev',
  'main.squarehole.pages.dev',
];

describe('landing middleware: the canonical host', () => {
  it('serves squarehole.fun and passes the static response through', async () => {
    const { response, next } = await run('https://squarehole.fun/');
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(await response.text()).toBe('<!doctype html>page');
  });

  it('serves any path on squarehole.fun, a 404 included, with its status kept', async () => {
    const { response, next } = await run('https://squarehole.fun/nothing/here?x=1', () => new Response('missing', { status: 404 }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('missing');
  });

  it('adds the security headers to what it serves', async () => {
    const { response } = await run('https://squarehole.fun/');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers.get(name), name).toBe(value);
    }
  });

  it('keeps a cache check (304) bodiless instead of throwing', async () => {
    const { response } = await run('https://squarehole.fun/styles.css', () => new Response(null, { status: 304, headers: { ETag: '"a"' } }));
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"a"');
    expect(response.body).toBeNull();
  });

  it('serves the host in any letter case and a plain-http request without a redirect loop', async () => {
    for (const url of ['https://SquareHole.FUN/', 'http://squarehole.fun/']) {
      const { response, next } = await run(url);
      expect(next, url).toHaveBeenCalledTimes(1);
      expect(response.status, url).toBe(200);
    }
  });

  it('serves local hosts for wrangler pages dev', async () => {
    for (const url of ['http://localhost:8788/', 'http://127.0.0.1:8788/a', 'http://[::1]:8788/']) {
      const { response, next } = await run(url);
      expect(next, url).toHaveBeenCalledTimes(1);
      expect(response.status, url).toBe(200);
    }
  });
});

describe('landing middleware: every other host answers 301 to squarehole.fun', () => {
  it.each(REDIRECTED_HOSTS)('%s', async (host) => {
    const { response, next } = await run(`https://${host}/`);
    expect(next).not.toHaveBeenCalled();
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://squarehole.fun/');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
  });

  it.each(REDIRECTED_HOSTS)('%s keeps the path and the query', async (host) => {
    const { response } = await run(`http://${host}/some/page.html?ref=a&b=2`);
    expect(response.status).toBe(301);
    expect(response.headers.get('Location')).toBe('https://squarehole.fun/some/page.html?ref=a&b=2');
  });

  it('drops a port and a trailing dot', () => {
    expect(redirectTarget('https://www.squarehole.fun:8443/a')).toBe('https://squarehole.fun/a');
    expect(redirectTarget('https://squarehole.fun./a')).toBe('https://squarehole.fun/a');
  });

  it('never turns a path into another host (no open redirect)', () => {
    const cases = {
      'https://www.squarehole.fun//example.com/x': 'https://squarehole.fun//example.com/x',
      'https://www.squarehole.fun/\\example.com': 'https://squarehole.fun//example.com',
      'https://squarehole.xyz/%2F%2Fexample.com': 'https://squarehole.fun/%2F%2Fexample.com',
      'https://squarehole.fit/@example.com': 'https://squarehole.fun/@example.com',
    };
    for (const [from, to] of Object.entries(cases)) {
      const target = redirectTarget(from);
      expect(target, from).toBe(to);
      expect(new URL(target).host, from).toBe(CANONICAL_HOST);
    }
  });

  it('redirects a host that only contains the name', () => {
    for (const host of ['squarehole.fun.example.com', 'evilsquarehole.fun', 'squarehole.fun-x.dev']) {
      expect(redirectTarget(`https://${host}/`), host).toBe('https://squarehole.fun/');
    }
  });
});
