import { xIdPattern } from './message.mjs';
import { createPublicKey, verify, createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

export class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function need(condition, status = 400, message = 'request refused') { if (!condition) throw new Refusal(status, message); }
const part = value => {
  need(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value), 401);
  const bytes = Buffer.from(value, 'base64url');
  need(bytes.toString('base64url') === value, 401);
  return bytes;
};
function decode(token) {
  need(typeof token === 'string' && token.length <= 16384, 401);
  const parts = token.split('.'); need(parts.length === 3, 401);
  try {
    const header = JSON.parse(part(parts[0])), payload = JSON.parse(part(parts[1]));
    need(header && payload && typeof payload === 'object' && !Array.isArray(payload), 401);
    need(!header.crit && !header.jku && !header.x5u && header.b64 === undefined, 401);
    return { header, payload, signature: part(parts[2]), input: Buffer.from(parts.slice(0, 2).join('.')) };
  } catch { throw new Refusal(401, 'invalid identity'); }
}
function checked(decoded, keys, alg, issuer, audience, now) {
  const { header, payload: p, input, signature } = decoded;
  need(header.alg === alg && keys.some(key => verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, signature)), 401, 'invalid identity');
  need(p.iss === issuer && (p.aud === audience || (Array.isArray(p.aud) && p.aud.every(a => typeof a === 'string') && p.aud.includes(audience))), 401, 'invalid identity');
  const seconds = Math.floor(now / 1000);
  need(Number.isSafeInteger(p.exp) && p.exp > seconds - 30, 401, 'expired identity');
  for (const claim of ['nbf', 'iat']) if (p[claim] !== undefined) need(Number.isSafeInteger(p[claim]) && p[claim] <= seconds + 30, 401, 'future identity');
  need(typeof p.sub === 'string' && p.sub.length > 0 && p.sub.length <= 256, 401, 'invalid identity');
  return p;
}
/** Every key Privy publishes for the app: 1 to 4 distinct P-256 SPKI PEMs, only whitespace around them. */
export const PRIVY_KEYS_MAX = 4;
const pemBlock = /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\s]+)-----END PUBLIC KEY-----/g;
export function privyKeys(pems) {
  need(typeof pems === 'string', 500);
  const blocks = [...pems.matchAll(pemBlock)];
  need(blocks.length > 0 && blocks.length <= PRIVY_KEYS_MAX && pems.replace(pemBlock, '').trim() === '', 500);
  const keys = blocks.map(([block, body]) => {
    let key; try { key = createPublicKey(block); } catch { throw new Refusal(500, 'request refused'); }
    // Exactly one key per block: OpenSSL would skip extra bytes, so a second key pasted inside a block refuses.
    need(key.export({ type: 'spki', format: 'der' }).toString('base64') === body.replace(/\s/g, ''), 500);
    return key;
  });
  need(keys.every((key, i) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails.namedCurve === 'prime256v1'
    && keys.findIndex(other => other.equals(key)) === i), 500);
  return keys;
}
/** A token verifies if any configured key verifies it; every other check is the same for each key. */
export function privyVerifier(pems, audience) {
  need(typeof audience === 'string' && audience.length > 0, 500);
  const keys = privyKeys(pems);
  return (token, now) => {
    const p = checked(decode(token), keys, 'ES256', 'privy.io', audience, now);
    need(/^did:privy:[A-Za-z0-9_-]+$/.test(p.sub), 401);
    let accounts;
    try { accounts = typeof p.linked_accounts === 'string' ? JSON.parse(p.linked_accounts) : p.linked_accounts; } catch { throw new Refusal(401, 'invalid linked accounts'); }
    need(Array.isArray(accounts), 401);
    const twitter = accounts.filter(a => a?.type === 'twitter_oauth');
    need(twitter.length === 1, 401, 'one X account required');
    const a = twitter[0];
    need(typeof a.subject === 'string' && xIdPattern.test(a.subject) && typeof a.username === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(a.username), 401);
    need(typeof a.name === 'string' && a.name.length <= 256, 401);
    const picture = a.profilePictureUrl ?? null;
    need(picture === null || (typeof picture === 'string' && picture.length <= 2048 && /^https:\/\/[^\s]+$/.test(picture)), 401);
    return { xId: a.subject, privyDid: p.sub, handle: a.username, name: a.name, picture };
  };
}

/** Only the configured team's endpoint is used. Bounded cache, coalesced refresh, no stale-key fallback. */
export function accessVerifier({ issuer, audience, fetch: fetcher = fetch, now = Date.now }) {
  need(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) && typeof audience === 'string' && audience.length > 0, 500);
  let keys = new Map(), expires = 0, retryAt = 0, pending;
  const refresh = async () => {
    if (pending) return pending;
    need(now() >= retryAt, 401, 'Access unavailable');
    retryAt = now() + 30000;
    pending = (async () => {
      const response = await fetcher(`${issuer}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      need(response.ok, 401, 'Access unavailable');
      const reader = response.body.getReader(); let size = 0; const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; need(size <= 65536, 401); chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      need(Array.isArray(body.keys) && body.keys.length > 0 && body.keys.length <= 16, 401);
      const next = new Map();
      for (const k of body.keys) {
        need(k.kty === 'RSA' && !k.d && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig') && typeof k.kid === 'string' && k.kid.length <= 256 && !next.has(k.kid), 401);
        const key = createPublicKey({ key: k, format: 'jwk' });
        need(key.asymmetricKeyDetails.modulusLength >= 2048, 401); next.set(k.kid, key);
      }
      keys = next; expires = now() + 300000;
    })();
    try { await pending; } finally { pending = undefined; }
  };
  return async token => {
    try {
      const decoded = decode(token);
      need(decoded.header.alg === 'RS256' && typeof decoded.header.kid === 'string', 401);
      if (now() >= expires || !keys.has(decoded.header.kid)) await refresh();
      need(now() < expires && keys.has(decoded.header.kid), 401);
      const p = checked(decoded, [keys.get(decoded.header.kid)], 'RS256', issuer, audience, now());
      need(p.type === 'app', 401, 'Access application token required');
      return p.sub;
    } catch { throw new Refusal(401, 'Access identity required'); }
  };
}
export const COOKIE = '__Host-alpha_session';
export const SESSION_MS = 7 * 86400000;
export const digest = id => createHash('sha256').update(id).digest('hex');
export function sessionCookies(key, name = COOKIE, lifetime = SESSION_MS) {
  need(Buffer.isBuffer(key) && key.length === 32, 500);
  const mac = id => createHmac('sha256', key).update(name === COOKIE ? id : `${name}:${id}`).digest('base64url');
  const cookie = (value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
  return {
    issue() { const id = randomBytes(32).toString('base64url'); return { hash: digest(id), cookie: cookie(`${id}.${mac(id)}`, lifetime / 1000) }; },
    clear: () => cookie('', 0),
    read(header) {
      const values = (header ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${name}=`));
      if (values.length !== 1) return null;
      const value = values[0].slice(name.length + 1), match = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
      if (!match || !timingSafeEqual(Buffer.from(match[2]), Buffer.from(mac(match[1])))) return null;
      return digest(match[1]);
    },
  };
}
