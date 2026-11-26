import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { harness, request } from './helpers.mjs';

test('production entry supplies Cloudflare EmailMessage to the offline-tested handler', async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'cloudflare:email') return {
      url: 'data:text/javascript,export class EmailMessage { constructor(from,to,raw) { Object.assign(this,{from,to,raw}); } }',
      shortCircuit: true,
    };
    return next(specifier, context);
  } });
  try {
    const { default: entry } = await import('../entry.mjs');
    const h = harness({ EmailMessage: undefined });
    const response = await entry.fetch(request(), h.env);
    assert.equal(response.status, 202);
    assert.match((await response.json()).id, /^[0-9a-f-]{36}$/);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].from, h.env.MAIL_FROM);
  } finally { hooks.deregister(); }
});

test('deployment config binds email, enables native crypto, and contains no addresses or secrets', async () => {
  const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(config, /main\s*=\s*"entry.mjs"/);
  assert.match(config, /compatibility_flags\s*=\s*\["nodejs_compat"\]/);
  assert.match(config, /\[\[send_email\]\]\s+name\s*=\s*"MAILER"/);
  assert.doesNotMatch(config, /@|destination_address|allowed_destination_addresses|TOKEN_MONITOR|TOKEN_RESCUE|MAIL_FROM|MAIL_TO/);
});
