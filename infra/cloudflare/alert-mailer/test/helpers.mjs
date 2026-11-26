import { createMailer } from '../worker.mjs';

export const instant = Date.parse('2026-10-21T12:34:56.000Z');
export const messageId = 'cb008989-b339-44ba-a90e-4f34b455fe13';
export const alert = { source: 'monitor', level: 'INFO', subject: 'Health', text: 'All checks passed.' };

export function request(body = alert, options = {}) {
  return new Request('https://mailer.invalid/alert', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer monitor-test-token' },
    body: JSON.stringify(body),
    ...options,
  });
}

export function harness(overrides = {}) {
  const sent = [];
  let time = instant;
  const env = {
    TOKEN_MONITOR: 'monitor-test-token', TOKEN_RESCUE: 'rescue-test-token',
    MAIL_FROM: 'sender@example.invalid', MAIL_TO: 'receiver@example.invalid',
    EmailMessage: function EmailMessage(from, to, raw) { Object.assign(this, { from, to, raw }); },
    MAILER: { async send(message) { sent.push(message); } },
    ...overrides,
  };
  const worker = createMailer({ now: () => time, randomUUID: () => messageId });
  return { env, sent, worker, fetch: req => worker.fetch(req, env), setTime: value => { time = value; } };
}
