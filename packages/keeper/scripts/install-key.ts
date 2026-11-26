/**
 * Installs the keeper's key file from a Web3 Secret Storage (v3) keystore, such as Foundry's (SH-259 review points 1 and
 * 11). The password comes from a file, never from the environment or the command line; the key is never printed.
 * The key must belong to the configured signer address. It is written to a private temporary file beside the target
 * (created exclusively, mode 0600, synced), set to 0400, then renamed over the target, so a failed decryption, a
 * wrong password or a wrong key leaves the previous key file (or none) as it was, never an empty or partial one.
 *
 *   node --experimental-transform-types --import ./scripts/register-ts.mjs scripts/install-key.ts \
 *     --keystore <file> --password-file <file> --address <0x signer> --out <dir>/gas.key
 *
 * The format it writes is the one the service reads (infra/server/services/runtime.mjs readKeyFile): one line, `0x`
 * and 64 hex digits, owner-only.
 */
import { createDecipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync, constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export class KeyInstallError extends Error {}

interface KeystoreV3 {
  readonly version?: number;
  readonly crypto?: {
    readonly cipher?: string; readonly ciphertext?: string; readonly cipherparams?: { readonly iv?: string };
    readonly kdf?: string; readonly kdfparams?: Record<string, unknown>; readonly mac?: string;
  };
}

const hex = (value: unknown, what: string): Uint8Array => {
  if (typeof value !== 'string' || !/^(0x)?([0-9a-fA-F]{2})+$/.test(value)) throw new KeyInstallError(`keystore ${what} malformed`);
  return hexToBytes((value.startsWith('0x') ? value : `0x${value}`) as Hex);
};
const int = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new KeyInstallError(`keystore ${what} malformed`);
  return value;
};

/** The 32-byte private key in a v3 keystore (scrypt or pbkdf2-hmac-sha256, aes-128-ctr), checked by its MAC. */
export function decryptKeystore(json: string, password: string): Hex {
  let store: KeystoreV3;
  try { store = JSON.parse(json) as KeystoreV3; } catch { throw new KeyInstallError('keystore is not JSON'); }
  const c = store.crypto ?? (store as { Crypto?: KeystoreV3['crypto'] }).Crypto;
  if (store.version !== 3 || !c || c.cipher !== 'aes-128-ctr') throw new KeyInstallError('keystore is not a v3 aes-128-ctr keystore');
  const params = c.kdfparams ?? {};
  const salt = hex(params.salt, 'salt');
  const dklen = int(params.dklen, 'dklen');
  if (dklen < 32) throw new KeyInstallError('keystore dklen too short');
  let derived: Buffer;
  if (c.kdf === 'scrypt') {
    const N = int(params.n, 'n'), r = int(params.r, 'r'), p = int(params.p, 'p');
    derived = scryptSync(Buffer.from(password, 'utf8'), salt, dklen, { N, r, p, maxmem: 256 * N * r + 64 * 1024 * 1024 });
  } else if (c.kdf === 'pbkdf2') {
    if (params.prf !== 'hmac-sha256') throw new KeyInstallError('keystore pbkdf2 prf unsupported');
    derived = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, int(params.c, 'c'), dklen, 'sha256');
  } else throw new KeyInstallError('keystore kdf unsupported');
  const ciphertext = hex(c.ciphertext, 'ciphertext');
  const mac = keccak256(concat([derived.subarray(16, 32), ciphertext]));
  if (mac.slice(2).toLowerCase() !== bytesToHex(hex(c.mac, 'mac')).slice(2).toLowerCase()) throw new KeyInstallError('wrong password or damaged keystore');
  const decipher = createDecipheriv('aes-128-ctr', derived.subarray(0, 16), hex(c.cipherparams?.iv, 'iv'));
  const key = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (key.length !== 32) throw new KeyInstallError('keystore key is not 32 bytes');
  return bytesToHex(key);
}

/** A password file's content: its text without one trailing line end. */
export function passwordOf(text: string): string {
  return text.replace(/\r?\n$/, '');
}

export interface InstallOptions { readonly keystore: string; readonly passwordFile: string; readonly address: string; readonly out: string }

/** Decrypts, checks the signer, writes privately and renames. Returns the address; throws without touching `out`. */
export function installKey(options: InstallOptions, read = (path: string) => readFileSync(path, 'utf8')): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(options.address)) throw new KeyInstallError('the signer address is malformed');
  const key = decryptKeystore(read(options.keystore), passwordOf(read(options.passwordFile)));
  if (!/^0x[0-9a-f]{64}$/.test(key)) throw new KeyInstallError('decrypted key malformed');
  const address = privateKeyToAccount(key).address;
  if (address.toLowerCase() !== options.address.toLowerCase()) throw new KeyInstallError('the key does not belong to the configured signer');
  // A stage of this invocation's own (random name, exclusive create); keeper-key.sh also holds one lock per folder.
  const staged = join(dirname(options.out), `.${basename(options.out)}.${randomBytes(16).toString('hex')}.new`);
  let fd: number | undefined, made = false;
  try {
    fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    made = true;
    const line = Buffer.from(`${key}\n`, 'utf8');
    if (writeSync(fd, line) !== line.length) throw new KeyInstallError('short write');
    fsyncSync(fd);
    fchmodSync(fd, 0o400);
    closeSync(fd);
    fd = undefined;
    renameSync(staged, options.out);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    // Only this invocation's own stage is removed; a failed exclusive create never touches another file.
    if (made) rmSync(staged, { force: true });
    throw error instanceof KeyInstallError ? error : new KeyInstallError('the key file could not be written');
  }
  // Installed once the rename succeeded, whatever the directory sync then does (it only hastens durability).
  try {
    const dir = openSync(dirname(options.out), constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* The rename stands; the file system writes the directory later. */ }
  return address;
}

function argument(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new KeyInstallError(`--${name} is required`);
  return value;
}

if (import.meta.main) {
  try {
    const address = installKey({ keystore: argument('keystore'), passwordFile: argument('password-file'),
      address: argument('address'), out: argument('out') });
    process.stdout.write(`keeper key installed for ${address}; the key was not printed\n`);
  } catch (error) {
    // Fixed messages only: never a path's content, a password or a key.
    process.stderr.write(`keeper key refused: ${error instanceof KeyInstallError ? error.message : 'unexpected failure'}\n`);
    process.exitCode = 1;
  }
}
