/**
 * Who a gateway request counts against, for the per-client stream cap (core-gateway.ts). The peer is the client unless
 * it is a trusted proxy (`SH_CORE_TRUSTED_PROXIES`): then the last X-Forwarded-For entry names the client. On the
 * server that proxy is Caddy, which sets X-Forwarded-For to its `{client_ip}` (Cloudflare's CF-Connecting-IP, believed
 * only from Cloudflare's ranges; infra/server/Caddyfile), so the gateway never reads CF-Connecting-IP itself. An IPv6
 * client counts by its /64 (one host usually holds the whole /64), as Caddy's rate limit does.
 */
import { BlockList, isIP } from 'node:net';

const MAPPED_V4 = '::ffff:';

function plain(address: string): string {
  const lower = address.trim().toLowerCase();
  return lower.startsWith(MAPPED_V4) && isIP(lower.slice(MAPPED_V4.length)) === 4 ? lower.slice(MAPPED_V4.length) : lower;
}

/** The eight 16-bit groups of a valid IPv6 address (zone dropped, `::` and a dotted IPv4 tail expanded). */
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%')[0] ?? '';
  const tail: number[] = [];
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    tail.push(a * 256 + b, c * 256 + d);
    text = text.slice(0, -dotted[0].length);
    if (text.endsWith(':') && !text.endsWith('::')) text = text.slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] => (part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16)));
  const head = groups(halves[0] ?? '');
  const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  const all = [...head, ...new Array<number>(8 - given).fill(0), ...rest, ...tail];
  return all.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? all : null;
}

/** The key a client counts under: an IPv4 address as is, an IPv6 address as its /64 (`2001:db8:0:1::/64`). */
export function clientKey(address: string): string {
  const ip = plain(address);
  if (isIP(ip) !== 6) return ip;
  const groups = ipv6Groups(ip);
  return groups ? `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64` : ip;
}

/** The trusted proxies as a list to check peers against: addresses and CIDRs (`172.16.0.0/12`); null when empty. */
export function trustedProxyList(entries: readonly string[]): BlockList | null {
  if (entries.length === 0) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', prefix, extra] = entry.trim().split('/');
    const family = isIP(address);
    if (family === 0 || extra !== undefined) throw new Error(`trusted proxy is not an address or CIDR: ${entry}`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefix === undefined) {
      list.addAddress(address, type);
      continue;
    }
    if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)) throw new Error(`trusted proxy has a bad prefix length: ${entry}`);
    list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

function trusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family === 0 ? false : list.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The client of a request: the forwarded address from a trusted proxy (its last X-Forwarded-For entry), else the peer. */
export function clientOf(peer: string | undefined, forwardedFor: string | readonly string[] | undefined, proxies: BlockList | null): string {
  const from = plain(peer ?? '');
  if (!proxies || !trusted(proxies, from)) return clientKey(from);
  const header = typeof forwardedFor === 'string' ? forwardedFor : forwardedFor?.join(',');
  const last = plain(header?.split(',').at(-1) ?? '');
  return isIP(last) === 0 ? clientKey(from) : clientKey(last);
}
