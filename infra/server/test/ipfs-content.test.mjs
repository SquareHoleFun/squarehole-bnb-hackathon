import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { rawCidV1 } from '../../../scripts/ipfs/pin-raw-lib.mjs';
import { createArtHandler } from '../ipfs/gateway.mjs';

const zero = `0x${'0'.repeat(64)}`;
const hash = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const png = Buffer.from('89504e470d0a1a0a', 'hex');
// Sorted keys are the application's canonicalJson order; no whitespace or final newline.
const list = { format: 'squarehole.box-reveal-list/1', items: [{ avatarSha256: zero, id: '1',
  imageSha256: hash(png), modelSha256: zero, salt: zero, traitsPacked: '0' }], n: '1' };
const encode = value => Buffer.from(JSON.stringify(value));
function glb(json = { asset: { version: '2.0' } }, bin) {
  const text = JSON.stringify(json);
  const chunk = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4));
  const bytes = Buffer.alloc(20 + chunk.length + (bin ? 8 + bin.length : 0));
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(chunk.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); chunk.copy(bytes, 20);
  if (bin) { bytes.writeUInt32LE(bin.length, 20 + chunk.length); bytes.writeUInt32LE(0x004e4942, 24 + chunk.length); bin.copy(bytes, 28 + chunk.length); }
  return bytes;
}
async function request(bytes, method = 'GET', cid = rawCidV1(hash(bytes))) {
  const fetch = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': 'text/html' } }));
  const result = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = Buffer.from(body ?? ''); } };
  await createArtHandler({ fetch })({ url: `/ipfs/${cid}`, method }, result);
  expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  return result;
}

describe('SH-KITS-UNIQUE-T04 bounded model and public-list route', () => {
  const models = ['rent-free', 'bag-holders'].map(kit => [kit, readFileSync(`examples/boxes/${kit}/unique/samples/model-1.glb`)]);
  it.each([...models, ['JSON-only GLB', glb()]])('serves %s as exact model/gltf-binary bytes, with verified HEAD', async (_name, bytes) => {
    const get = await request(bytes);
    expect(get.status).toBe(200);
    expect(get.headers['Content-Type']).toBe('model/gltf-binary');
    expect(get.body).toEqual(bytes);
    const head = await request(bytes, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.body.length).toBe(0);
    expect((await request(png, 'HEAD', rawCidV1(hash(bytes)))).status).toBe(502);
  });

  it('serves only canonical public lists as application/json, with the same GET/HEAD guarantees', async () => {
    const bytes = encode(list);
    const get = await request(bytes);
    expect(get.status).toBe(200);
    expect(get.headers['Content-Type']).toBe('application/json');
    expect(get.body).toEqual(bytes);
    const head = await request(bytes, 'HEAD');
    expect(head.headers).toEqual(get.headers);
    expect(head.body.length).toBe(0);
  });

  it('refuses malformed containers, external resources and decoder extensions despite matching CIDs', async () => {
    const changed = (offset, value) => { const bytes = glb(); bytes.writeUInt32LE(value, offset); return bytes; };
    const invalidUtf8 = glb(); invalidUtf8[22] = 0xff;
    const badBin = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }, Buffer.alloc(4));
    const binOffset = 20 + badBin.readUInt32LE(12);
    badBin.writeUInt32LE(8, binOffset);
    const wrongBinType = Buffer.from(badBin); wrongBinType.writeUInt32LE(4, binOffset); wrongBinType.writeUInt32LE(0x4e4f534a, binOffset + 4);
    const trailing = Buffer.concat([glb(), Buffer.alloc(4)]); trailing.writeUInt32LE(trailing.length, 8);
    const cases = [changed(4, 1), changed(8, 20), changed(12, 3), changed(12, 1000), changed(16, 0x004e4942), badBin, wrongBinType, trailing,
      Buffer.concat([glb(), Buffer.alloc(4)]), invalidUtf8, glb(null), glb({ asset: { version: '1.0' } }),
      glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'mesh.bin' }] }),
      glb({ asset: { version: '2.0' }, buffers: [{ byteLength: 8 }] }, Buffer.alloc(4)),
      glb({ asset: { version: '2.0' }, buffers: 'wrong' }),
      glb({ asset: { version: '2.0' }, images: [{ uri: 'https://elsewhere.invalid/a.png' }] }),
      glb({ asset: { version: '2.0' }, images: [{ uri: 'data:image/svg+xml;base64,PHN2Zy8+' }] }),
      glb({ asset: { version: '2.0' }, images: [{ bufferView: 99, mimeType: 'image/png' }] }),
      glb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }),
      glb({ asset: { version: '2.0' }, extensions: { EXT_external: { uri: 'https://elsewhere.invalid/a' } } }),
    ];
    for (const bytes of cases) {
      const result = await request(bytes);
      expect(result.status).toBe(415);
      expect(result.body.length).toBe(0);
      expect(result.headers['Cache-Control']).toBe('no-store');
    }
  });

  it('accepts embedded raster resources and permitted extensions without requiring Misfit anchors', async () => {
    const bytes = glb({ asset: { version: '2.0' }, buffers: [{ byteLength: png.length }],
      bufferViews: [{ buffer: 0, byteLength: png.length }], images: [{ bufferView: 0, mimeType: 'image/png' }],
      extensionsUsed: ['KHR_mesh_quantization', 'KHR_texture_transform'],
    }, png);
    expect((await request(bytes)).status).toBe(200);
    expect((await request(glb({ asset: { version: '2.0' }, images: [{ uri: `data:image/png;base64,${png.toString('base64')}` }] }))).status).toBe(200);
  });

  it('refuses noncanonical or unrelated JSON, extra fields, malformed hashes, IDs and uint128 traits', async () => {
    const item = patch => ({ ...list, items: [{ ...list.items[0], ...patch }] });
    const values = [{}, [], null, { ...list, private: true }, { ...list, n: '2' }, { ...list, n: 1 },
      { ...list, n: '01' }, { ...list, items: [] }, item({ id: '2' }), item({ imageSha256: zero }),
      item({ imageSha256: '0xBAD' }), item({ modelSha256: 'bad' }), item({ avatarSha256: null }),
      item({ traitsPacked: '-1' }), item({ traitsPacked: '00' }), item({ traitsPacked: String(1n << 128n) }),
      item({ salt: '<html/>' }), item({ proof: [] }), { ...list, format: 'squarehole.private/1' }];
    const invalid = [...values.map(encode), Buffer.from(`${JSON.stringify(list)}\n`),
      Buffer.from(JSON.stringify(list, null, 2)), encode({ n: list.n, items: list.items, format: list.format }),
      Buffer.from(JSON.stringify(list).replace('"n":"1"', '"n":"1","n":"1"'))];
    for (const bytes of invalid) expect((await request(bytes)).status).toBe(415);
  });

  it('retains the 1 MiB transport limit for models (502 without sending any upstream body)', async () => {
    const bytes = glb({ asset: { version: '2.0' }, extras: { pad: 'x'.repeat(1_048_576) } });
    const result = await request(bytes);
    expect(result.status).toBe(502);
    expect(result.body.length).toBe(0);
    const overhead = glb({ asset: { version: '2.0' }, extras: { pad: '' } }).length;
    const edge = glb({ asset: { version: '2.0' }, extras: { pad: 'x'.repeat(1_048_576 - overhead) } });
    expect(edge.length).toBe(1_048_576);
    expect((await request(edge)).status).toBe(200);
  });
});
