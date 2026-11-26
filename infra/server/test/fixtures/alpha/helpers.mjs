import { generateKeyPairSync, sign } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { resolve, join } from 'node:path';

export const { privateKeyToAccount } = createRequire(new URL('../../../../../packages/keeper/package.json', import.meta.url))('viem/accounts');
export const wallet = privateKeyToAccount(`0x${'11'.repeat(32)}`);
export const otherWallet = privateKeyToAccount(`0x${'22'.repeat(32)}`);
export const privy = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const access = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const origin = 'https://test-app.example.org';
export const issuer = 'https://fixture.cloudflareaccess.com';
export const instant = Date.parse('2026-10-29T12:00:00.000Z');
export const publicKey = privy.publicKey.export({ type: 'spki', format: 'pem' });
export const jwk = { ...access.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
export function jwt(payload, key = privy.privateKey, header = { alg: 'ES256' }) {
  const input = [header, payload].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
export function identity(xId = '123456789012345678', overrides = {}) {
  return { iss: 'privy.io', aud: 'fixture-app', sub: 'did:privy:fixture', iat: instant / 1000, exp: instant / 1000 + 3600,
    linked_accounts: JSON.stringify([{ type: 'twitter_oauth', subject: xId, username: 'fixture_user', name: 'Fixture User', profilePictureUrl: 'https://example.org/avatar.png' }]), ...overrides };
}
export function deskToken(overrides = {}, key = access.privateKey, header = {}) {
  return jwt({ iss: issuer, aud: ['fixture-desk'], sub: 'founder-fixture', email: 'founder@example.org', type: 'app', exp: instant / 1000 + 3600, ...overrides }, key, { alg: 'RS256', kid: 'fixture', ...header });
}
export function directories() {
  mkdirSync('.cache/tmp', { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp/alpha-api-'));
  for (const name of ['state', 'queue', 'receipts']) mkdirSync(join(root, name));
  return { root, dbPath: join(root, 'state/alpha.sqlite'), queueDir: join(root, 'queue'), receiptsDir: join(root, 'receipts') };
}
