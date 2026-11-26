// Founder helper, offline: prints the alpha-api env line holding every public key of the Privy app's JWKS, as saved
// from https://auth.privy.io/api/v1/apps/<app ID>/jwks.json. It reads that one file: no network, no secret.
//   node infra/server/services/alpha/privy-keys.mjs <saved JWKS file>
import { closeSync, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { need, privyKeys, PRIVY_KEYS_MAX } from './auth.mjs';

export function privyKeyLine(text) {
  const { keys } = JSON.parse(text) ?? {};
  need(Array.isArray(keys) && keys.length > 0 && keys.length <= PRIVY_KEYS_MAX, 400);
  const pems = keys.map(k => {
    need(k?.kty === 'EC' && k.crv === 'P-256' && k.d === undefined && [undefined, 'ES256'].includes(k.alg) && [undefined, 'sig'].includes(k.use)
      && (k.key_ops === undefined || (Array.isArray(k.key_ops) && k.key_ops.length === 1 && k.key_ops[0] === 'verify')), 400);
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).trim();
  }).join('\n');
  privyKeys(pems); // alpha-api's own check of the result: distinct P-256 keys, at most four
  return `SH_ALPHA_PRIVY_VERIFICATION_KEY=${pems.replaceAll('\n', '\\n')}\n`;
}
if (process.argv[1] && import.meta.url === (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ''; } })()) {
  try {
    const [file, ...extra] = process.argv.slice(2);
    need(typeof file === 'string' && !extra.length, 400);
    const fd = openSync(file, 'r');
    try {
      const stat = fstatSync(fd); need(stat.isFile() && stat.size <= 65536, 400);
      process.stdout.write(privyKeyLine(readFileSync(fd, 'utf8')));
    } finally { closeSync(fd); }
  } catch { process.stderr.write('privy keys refused: give the saved JWKS file of the Privy app; details suppressed\n'); process.exitCode = 1; }
}
