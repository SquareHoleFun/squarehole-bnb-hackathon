import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alert, harness, messageId, request } from './helpers.mjs';

const envelope = [
  'From: sender@example.invalid', 'To: receiver@example.invalid',
  'Date: Wed, 21 Oct 2026 12:34:56 +0000',
  `Message-ID: <${messageId}@example.invalid>`,
];
const contentHeaders = [
  'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8',
  'Content-Transfer-Encoding: base64', '',
];

test('ASCII MIME matches exact bytes including CRLF, envelope, timestamp and body', async () => {
  const h = harness();
  assert.equal((await h.fetch(request())).status, 202);
  const expected = [...envelope, 'Subject: [Square Hole] INFO Health', ...contentHeaders,
    'QWxsIGNoZWNrcyBwYXNzZWQuDQoNClNvdXJjZTogbW9uaXRvcg0KVVRDOiAyMDI2LTEwLTIxVDEy',
    'OjM0OjU2LjAwMFoNCg==', '',
  ].join('\r\n');
  assert.deepEqual(Buffer.from(h.sent[0].raw), Buffer.from(expected));
});

test('Unicode MIME matches exact UTF-8 bytes and RFC 2047 subject encoding', async () => {
  const h = harness();
  const headers = { 'content-type': 'application/json', authorization: 'Bearer rescue-test-token' };
  await h.fetch(request({ source: 'rescue', level: 'WARN', subject: 'Café ☕', text: 'Température élevée 🔥' }, { headers }));
  const expected = [...envelope, 'Subject: =?UTF-8?B?W1NxdWFyZSBIb2xlXSBXQVJOIENhZsOpIOKYlQ==?=', ...contentHeaders,
    'VGVtcMOpcmF0dXJlIMOpbGV2w6llIPCflKUNCg0KU291cmNlOiByZXNjdWUNClVUQzogMjAyNi0x',
    'MC0yMVQxMjozNDo1Ni4wMDBaDQo=', '',
  ].join('\r\n');
  assert.deepEqual(Buffer.from(h.sent[0].raw), Buffer.from(expected));
});

test('long encoded subjects fold without breaking UTF-8 characters or encoded-word limits', async () => {
  const h = harness();
  const subject = '🔥é'.repeat(60);
  await h.fetch(request({ ...alert, level: 'EMERGENCY', subject, text: 'x'.repeat(6000) }));
  const [header, body] = h.sent[0].raw.split('\r\n\r\n');
  const subjectLines = header.split('\r\n').filter(line => line.startsWith('Subject:') || line.startsWith(' '));
  assert.ok(subjectLines.length > 1);
  assert.ok(subjectLines.every(line => line.length <= 78));
  const words = subjectLines.join(' ').match(/=\?UTF-8\?B\?[^?]+\?=/g);
  assert.ok(words.every(word => word.length <= 75));
  const decoded = words.map(word => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(word.slice(10, -2), 'base64'))).join('');
  assert.equal(decoded, `[Square Hole] EMERGENCY ${subject}`);
  assert.ok(body.split('\r\n').every(line => line.length <= 76));
});

test('body normalizes line endings; text cannot inject MIME headers', async () => {
  const h = harness();
  await h.fetch(request({ ...alert, text: 'a\nb\r\nc\rd\r\nBcc: nobody' }));
  const [header, body] = h.sent[0].raw.split('\r\n\r\n');
  assert.ok(!header.includes('Bcc:'));
  assert.equal(Buffer.from(body, 'base64').toString('utf8'),
    'a\r\nb\r\nc\r\nd\r\nBcc: nobody\r\n\r\nSource: monitor\r\nUTC: 2026-10-21T12:34:56.000Z\r\n');
});

test('literal encoded-word syntax in an ASCII subject is preserved on decoding', async () => {
  const h = harness();
  const subject = '=?UTF-8?B?SGk=?=';
  await h.fetch(request({ ...alert, subject }));
  const line = h.sent[0].raw.split('\r\n').find(line => line.startsWith('Subject: '));
  const word = line.slice('Subject: '.length);
  assert.match(word, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(word.slice(10, -2), 'base64').toString('utf8'), `[Square Hole] INFO ${subject}`);
});
