import { readFile, lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export async function runHost(io) {
  try {
    const env = io.env;
    const path = env.DRAND_RESCUE_KEY_FILE;
    if (!path || !env.DRAND_RESCUE_TICKETS || !env.DRAND_RESCUE_RPC_URL
      || !env.DRAND_RESCUE_MAILER_URL || !env.DRAND_RESCUE_MAILER_TOKEN) throw new Error();
    // The unattended host signs on these reads and the URL carries the provider key: HTTPS only, no userinfo.
    const rpc = new URL(env.DRAND_RESCUE_RPC_URL);
    if (rpc.protocol !== 'https:' || rpc.username || rpc.password) throw new Error();
    const stat = await io.lstat(path);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== io.uid()) throw new Error();
    const material = (await io.readFile(path, 'utf8')).trim();
    if (!/^0x[\da-f]{64}$/i.test(material)) throw new Error();
    const { main } = await import('../../scripts/box/drand-rescue/main.mjs');
    return await main([
      '--rpc-env', 'DRAND_RESCUE_RPC_URL', '--key-env', 'RESCUE_SIGNING_MATERIAL',
      '--mailer-env', 'DRAND_RESCUE_MAILER_URL,DRAND_RESCUE_MAILER_TOKEN',
      '--tickets', env.DRAND_RESCUE_TICKETS, '--backstop', '3600', '--yes',
      '--heartbeat-hour', env.DRAND_RESCUE_HEARTBEAT_HOUR ?? '0',
    ], { ...io, env: { ...env, RESCUE_SIGNING_MATERIAL: material } });
  } catch {
    io.stderr.write('rescue host configuration unavailable\n');
    return 1;
  }
}
// Node gives import.meta.url as the real path, so compare it with the real path of the started file (symlinks).
function startedDirectly() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}
if (startedDirectly()) {
  process.exitCode = await runHost({
    env: process.env, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin,
    fetch: globalThis.fetch, readFile, lstat, uid: () => process.getuid(),
    clock: () => BigInt(Date.now()),
    wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds.toString())),
  });
}
