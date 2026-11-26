import { spawn } from 'node:child_process';
import type { Hex } from 'viem';
import type { DigestSigner } from './types';
import { hash, requireThat } from './schema';

export type SignCommand = (command: string, digest: Hex) => Promise<string>;
const run: SignCommand = (command, digest) => new Promise((resolve, reject) => {
  // No shell, command arguments, key file, passphrase handling or inherited stdout/stderr.
  const child = spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let length = 0;
  const timeout = setTimeout(() => { child.kill(); reject(new Error('managed signer unavailable')); }, 30000);
  child.stdout.on('data', (data: Buffer) => {
    length += data.length;
    if (length > 256) { child.kill(); return; }
    output += data.toString('utf8');
  });
  child.stderr.resume();
  child.on('error', () => { clearTimeout(timeout); reject(new Error('managed signer unavailable')); });
  child.stdin.on('error', () => { /* close/error handles a refusing command */ });
  child.on('close', code => {
    clearTimeout(timeout);
    if (code === 0 && length <= 256) resolve(output.trim()); else reject(new Error('managed signer unavailable'));
  });
  child.stdin.end(`${digest}\n`);
});
/** External managed command consumes one EIP-712 digest on stdin and returns only its r,s,v signature. */
export class CommandDigestSigner implements DigestSigner {
  constructor(private command: string, private execute: SignCommand = run) {
    requireThat(command.length > 0 && !/[\r\n\0]/.test(command), 'managed signer command required');
  }
  async signDigest(digest: Hex): Promise<Hex> {
    hash.parse(digest);
    let output: string;
    try { output = await this.execute(this.command, digest); } catch { throw new Error('managed signer unavailable'); }
    requireThat(/^0x[0-9a-fA-F]{128}(1b|1c)$/i.test(output), 'invalid managed signer response');
    return output as Hex;
  }
}
