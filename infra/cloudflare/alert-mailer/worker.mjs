import { createHash, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

const MAX_BYTES = 8192;
const HOURLY_CAP = 120;
const sources = ['monitor', 'rescue'];
const levels = ['INFO', 'WARN', 'ALERT', 'CRITICAL', 'EMERGENCY'];
const fields = ['source', 'level', 'subject', 'text'];

// Native constant-time comparison of fixed-size digests: no length-mismatch throw
// or prefix/character short circuit. Both configured sources are checked per request.
export function tokenMatches(candidate, secret) {
  const a = typeof candidate === 'string' ? candidate : '';
  const b = typeof secret === 'string' ? secret : '';
  const equal = timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
  return equal && a.length > 0 && b.length > 0;
}

function answer(status, body) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

async function readJson(request) {
  if (!request.body) return { status: 400 };
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_BYTES);
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > MAX_BYTES) return { status: 413 };
      bytes.set(value, size);
      size += value.byteLength;
    }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))) };
  } catch {
    return { status: 400 };
  } finally {
    // Cleanup must not wait on a stalled/failed client stream.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && [...value].length <= max;
}

function validAlert(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
    && sources.includes(value.source) && levels.includes(value.level)
    && boundedString(value.subject, 120) && !/[\r\n]/.test(value.subject)
    && boundedString(value.text, 6000);
}

function validAddress(value) {
  // Deployment secrets are bare ASCII mailboxes, never display names or headers.
  return typeof value === 'string' && value.length <= 254
    && /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(value);
}

function encodeSubject(subject) {
  if (/^[ -~]+$/.test(subject) && !subject.includes('=?')) return subject;
  const words = [];
  let chunk = '', size = 0;
  for (const character of subject) {
    const length = Buffer.byteLength(character);
    // 42 UTF-8 bytes -> at most 68 characters per RFC 2047 encoded-word.
    // Including "Subject: " keeps the first line below 78 characters.
    if (size + length > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
      chunk = '';
      size = 0;
    }
    chunk += character;
    size += length;
  }
  words.push(`=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`);
  return words.join('\r\n ');
}

function mime(alert, env, time, id) {
  const date = new Date(time);
  const text = alert.text.replace(/\r\n|\r|\n/g, '\r\n')
    + `\r\n\r\nSource: ${alert.source}\r\nUTC: ${date.toISOString()}\r\n`;
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  const lines = [];
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
  return [
    `From: ${env.MAIL_FROM}`, `To: ${env.MAIL_TO}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${env.MAIL_FROM.split('@')[1]}>`,
    `Subject: ${encodeSubject(`[Square Hole] ${alert.level} ${alert.subject}`)}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', ...lines, '',
  ].join('\r\n');
}

export function createMailer({ now = Date.now, randomUUID = () => crypto.randomUUID() } = {}) {
  // One instance at module scope in entry.mjs: best effort per isolate, at most two rows.
  const counters = new Map();
  return {
    async fetch(request, env) {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/alert') {
        return answer(404, { error: 'not found' });
      }
      const token = /^Bearer +([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
      const matches = {
        monitor: tokenMatches(token, env.TOKEN_MONITOR),
        rescue: tokenMatches(token, env.TOKEN_RESCUE),
      };
      if (!matches.monitor && !matches.rescue) return answer(401, { error: 'unauthorized' });
      // Both match only when the two secrets are equal: the token no longer binds a source, so refuse to send.
      if (matches.monitor && matches.rescue) return answer(502, { error: 'send failed' });
      if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(request.headers.get('content-type') ?? '')) {
        return answer(400, { error: 'bad input' });
      }
      const parsed = await readJson(request);
      if (parsed.status) return answer(parsed.status, { error: parsed.status === 413 ? 'body too large' : 'bad input' });
      const alert = parsed.value;
      if (!validAlert(alert)) return answer(400, { error: 'bad input' });
      if (!matches[alert.source]) return answer(401, { error: 'unauthorized' });

      const time = now(), hour = Math.floor(time / 3600000);
      let counter = counters.get(alert.source);
      // A backwards clock never grants extra slots. Windows are fixed UTC hours.
      if (!counter || hour > counter.hour) {
        counter = { hour, count: 0 };
        counters.set(alert.source, counter);
      }
      if (counter.count >= HOURLY_CAP) return answer(429, { error: 'hourly cap reached' });
      // Reserve synchronously, including failed/ambiguous sends: no concurrent overshoot.
      counter.count++;
      try {
        if (!validAddress(env.MAIL_FROM) || !validAddress(env.MAIL_TO)) throw new Error('invalid configuration');
        const id = randomUUID();
        const message = new env.EmailMessage(env.MAIL_FROM, env.MAIL_TO, mime(alert, env, time, id));
        await env.MAILER.send(message);
        return answer(202, { id });
      } catch {
        // Never log or reflect binding exceptions: they may contain private mail data.
        return answer(502, { error: 'send failed' });
      }
    },
  };
}
