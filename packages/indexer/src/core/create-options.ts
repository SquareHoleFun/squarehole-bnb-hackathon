import { open } from 'node:fs/promises';
import { CREATE_OPTIONS_MAX_BYTES, parseCreateOptions, type CreateOptionsRelease } from '../../../chain/src/create-options/schema';

export const CREATE_OPTIONS_DATA = new URL('../../../chain/src/create-options/data/', import.meta.url);
export interface CreateOptionsReply { readonly status: 200 | 404 | 503; readonly body: Uint8Array | { readonly error: string } }

/** Read at most the bound plus one byte, even if a file grows after stat. No process cache or startup dependency. */
export async function readCreateOptionsFile(file: URL): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > CREATE_OPTIONS_MAX_BYTES) throw new Error('invalid document size or file');
    const bytes = Buffer.alloc(CREATE_OPTIONS_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > CREATE_OPTIONS_MAX_BYTES) throw new Error('document exceeds size bound');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}

export class CreateOptions {
  constructor(
    private readonly releases: readonly CreateOptionsRelease[],
    private readonly directory = CREATE_OPTIONS_DATA,
    private readonly read: (file: URL) => Promise<Uint8Array> = readCreateOptionsFile,
  ) {}

  async get(rawPath: string): Promise<CreateOptionsReply> {
    // Check the original path, without URL normalization or percent decoding, before even constructing a file URL.
    const match = /^\/v2\/create-options\/([1-9][0-9]{0,15})\/(0x[0-9a-f]{40})\.json$/.exec(rawPath);
    const release = match && match[0] === rawPath && this.releases.find(r => String(r.chainId) === match[1] && r.factory === match[2]);
    if (!release) return { status: 404, body: { error: 'no release' } };
    try {
      const bytes = await this.read(new URL(`${match[1]}/${match[2]}.json`, this.directory));
      if (bytes.byteLength > CREATE_OPTIONS_MAX_BYTES) throw new Error('document exceeds size bound');
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!parseCreateOptions(text, release).ok) throw new Error('invalid document');
      return { status: 200, body: bytes };
    } catch {
      return { status: 503, body: { error: 'create options unavailable' } };
    }
  }
}
