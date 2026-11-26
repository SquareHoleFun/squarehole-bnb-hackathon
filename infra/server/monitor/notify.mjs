import { spawn as spawnProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULTS, channelNames, heartbeatConfig, httpsUrl, requireValue } from './config.mjs';
import { boundedRequest } from './collect.mjs';
const required = x => { requireValue(typeof x === 'string' && x.length > 0 && x.length <= 4096 && !/[\r\n\0]/.test(x)); return x; };
export async function pingHeartbeat(env, request = boundedRequest) {
  const h = heartbeatConfig(env);
  if (!h.configured) return 'not configured';
  if (!h.valid) return 'failed';
  try {
    const r = await request(env.SH_MONITOR_HEARTBEAT_URL, { method: 'GET' });
    return r.status >= 200 && r.status < 300 ? 'accepted' : 'failed';
  } catch { return 'failed'; }
}
// F145: the mailer owns the private recipient and Cloudflare account; this sender owns only its token.
export function mailer(env, request = boundedRequest, log = line => process.stderr.write(line + '\n')) {
  const url = httpsUrl(required(env.SH_MONITOR_MAILER_URL)); requireValue(!url.search);
  const token = required(env.SH_MONITOR_MAILER_TOKEN); requireValue(/^[!-~]+$/.test(token));
  return async text => {
    let status;
    try {
      requireValue(typeof text === 'string' && text.length > 0 && text.length <= 6000);
      const subject = text.split('\n')[0]; requireValue(subject.length > 0 && subject.length <= 120);
      const event = subject.replace(/^Square Hole monitor: /, '');
      const level = ['INFO', 'WARN', 'ALERT', 'CRITICAL', 'EMERGENCY'].includes(event) ? event
        : event === 'INTERNAL FAILURE' ? 'ALERT' : 'INFO';
      const body = JSON.stringify({ source: 'monitor', level, subject, text });
      requireValue(Buffer.byteLength(body, 'utf8') <= 8192);
      const r = await request(url.href.replace(/\/$/, '') + '/alert', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body,
      });
      if (Number.isInteger(r.status) && r.status >= 100 && r.status <= 599) status = r.status;
      requireValue(status === 202);
    } catch {
      log(`monitor mailer delivery failed: ${status === undefined ? 'request failed' : `HTTP ${status}`}`);
      throw new Error('notification failed');
    }
  };
}
const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
export function smtp(env, spawn = spawnProcess, stateDir = DEFAULTS.stateDir) {
  const url = new URL(required(env.SH_MONITOR_SMTP_URL));
  requireValue(url.protocol === 'smtps:' && !url.username && !url.password && !url.search && !url.hash && (!url.pathname || url.pathname === '/'));
  const from = required(env.SH_MONITOR_MAIL_FROM), to = required(env.SH_MONITOR_MAIL_TO);
  requireValue([from, to].every(x => /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+$/.test(x)));
  const user = required(env.SH_MONITOR_SMTP_USER), password = required(env.SH_MONITOR_SMTP_PASSWORD);
  requireValue(!user.includes(':'));
  const path = join(stateDir, 'smtp-message.eml');
  requireValue(!/[\r\n\0]/.test(path));
  const config = ['silent', 'show-error', 'ssl-reqd', 'connect-timeout = 10', 'max-time = 20',
    'proto = "=smtps"', `url = ${quote(url.href)}`, `user = ${quote(`${user}:${password}`)}`,
    `mail-from = ${quote(from)}`, `mail-rcpt = ${quote(to)}`, `upload-file = ${quote(path)}`].join('\n') + '\n';
  return async text => {
    let file, writable = false, failed = false;
    try {
      requireValue(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      // Reuse one private file under the wrapper's process lock, including after a killed run.
      // Do not truncate until type, permissions and hard links have been checked.
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      const st = await file.stat();
      requireValue(st.isFile() && st.nlink === 1 && (st.mode & 0o777) === 0o600);
      writable = true;
      await file.truncate(0);
      const message = `From: ${from}\r\nTo: ${to}\r\nSubject: Square Hole monitor\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`
        + (Buffer.from(text).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n') + '\r\n';
      await file.writeFile(message);
      await new Promise((resolve, reject) => {
        // -q disables curlrc. Credentials stay on stdin, never in the upload file or argv.
        const child = spawn('/usr/bin/curl', ['-q', '--config', '-'], {
          stdio: ['pipe', 'ignore', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 25000, killSignal: 'SIGKILL',
        });
        let childFailed = false;
        child.on('error', () => { childFailed = true; });
        child.stdin.on('error', () => { childFailed = true; child.kill('SIGKILL'); });
        // Wait for close even on pipe/spawn errors so cleanup cannot race curl's upload.
        child.on('close', code => code === 0 && !childFailed ? resolve() : reject(new Error('notification failed')));
        child.stdin.end(config);
      });
    } catch { failed = true; }
    finally {
      if (file) {
        try { if (writable) await file.truncate(0); }
        catch { failed = true; }
        try { await file.close(); } catch { failed = true; }
      }
    }
    if (failed) throw new Error('notification failed');
  };
}
export function notifiers(env, stateDir = DEFAULTS.stateDir, channels = DEFAULTS.channels) {
  const names = channelNames(env.SH_MONITOR_CHANNELS ?? channels);
  return Object.fromEntries(names.map(name => {
    try { return [name, name === 'mailer' ? mailer(env) : smtp(env, spawnProcess, stateDir)]; }
    catch { return [name, async () => { throw new Error('notification configuration invalid'); }]; }
  }));
}
