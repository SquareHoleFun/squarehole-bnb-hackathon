import { RELAYS } from './quicknet.mjs';

export const USAGE = 'usage: rescue.mjs (--rpc <url> | --rpc-env <NAME>) [--manifest <path> | --tickets <address> ...] [--now | --backstop <seconds>] [--key-env <NAME> | --ledger [--hd-path <path>]] [--cast <path>] [--yes] [--relay <origin> ...] [--max-fee-wei <wei>] [--urgent-max-fee-wei <wei>] [--max-run-wei <wei>] [--mailer-env <URL_NAME>,<TOKEN_NAME>] [--heartbeat-hour <0..23>]';
export const address = value => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/.test(value);
const name = value => /^[A-Za-z_][A-Za-z_0-9]*$/.test(value);
const bad = () => { throw new Error('bad arguments'); };
const url = value => {
  try { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol)) bad(); return u; }
  catch { bad(); }
};
export function options(argv, env) {
  const values = new Map();
  const repeated = new Set(['tickets', 'relay']);
  const flags = new Set(['now', 'ledger', 'yes']);
  const known = new Set(['rpc', 'rpc-env', 'manifest', 'tickets', 'now', 'backstop', 'key-env', 'ledger',
    'hd-path', 'cast', 'yes', 'relay', 'max-fee-wei', 'urgent-max-fee-wei', 'max-run-wei', 'mailer-env', 'heartbeat-hour']);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].startsWith('--') ? argv[i].slice(2) : '';
    if (!known.has(k) || (values.has(k) && !repeated.has(k))) bad();
    const value = flags.has(k) ? true : argv[++i];
    if (value === undefined || value === '' || (typeof value === 'string' && value.startsWith('--'))) bad();
    values.set(k, repeated.has(k) ? [...(values.get(k) ?? []), value] : value);
  }
  const get = key => values.get(key);
  if (Boolean(get('rpc')) === Boolean(get('rpc-env')) || (get('manifest') && get('tickets'))
    || (get('now') && get('backstop')) || (get('ledger') && get('key-env'))
    || (get('hd-path') && !get('ledger')) || (get('cast') && !get('ledger'))) bad();
  for (const k of ['rpc-env', 'key-env']) if (get(k) && !name(get(k))) bad();
  const rpc = get('rpc') ?? env[get('rpc-env')];
  url(rpc);
  const decimal = (k, fallback) => {
    const raw = get(k) ?? fallback;
    if (!/^\d+$/.test(raw)) bad();
    return BigInt(raw);
  };
  const tickets = [...new Set((get('tickets') ?? []).map(t => t.toLowerCase()))];
  if (!tickets.every(address)) bad();
  const relays = get('relay') ?? RELAYS;
  for (const relay of relays) if (url(relay).origin !== relay) bad();
  const mailer = get('mailer-env')?.split(',');
  if (mailer && (mailer.length !== 2 || !mailer.every(name))) bad();
  const heartbeatHour = decimal('heartbeat-hour', '0');
  if (heartbeatHour > 23n) bad();
  return {
    rpc, tickets, manifest: get('manifest'), now: Boolean(get('now')),
    delay: get('now') ? 0n : decimal('backstop', '3600'),
    keyEnv: get('key-env'), ledger: Boolean(get('ledger')), hdPath: get('hd-path'), cast: get('cast'),
    yes: Boolean(get('yes')), relays, mailer, heartbeatHour,
    maxFee: decimal('max-fee-wei', '3000000000'), urgentMaxFee: decimal('urgent-max-fee-wei', '50000000000'),
    maxRun: decimal('max-run-wei', '50000000000000000'),
  };
}
