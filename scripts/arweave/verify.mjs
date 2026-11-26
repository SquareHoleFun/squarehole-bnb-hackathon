import { arBlockHash, arId, decimal, fail, jsonRequest, request, sha256 } from './common.mjs';

// Arweave's REST API uses JSON numbers for block heights, never monetary amounts.
function height(value) {
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (decimal(value)) return BigInt(value);
  fail('invalid Arweave height');
}

async function inclusion(fetch, gateway, id, minConfirmations) {
  const graph = await jsonRequest(fetch, `${gateway}/graphql`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query Item($id: ID!) { transactions(ids: [$id], first: 2) { edges { node { id bundledIn { id } } } } }', variables: { id } }),
    limit: 65_536,
  });
  const edges = graph?.data?.transactions?.edges;
  if (graph.errors || !Array.isArray(edges) || edges.length !== 1 || edges[0].node?.id !== id || !arId(edges[0].node.bundledIn?.id)) fail('data item not indexed in a layer-1 bundle');
  const bundleId = edges[0].node.bundledIn.id;
  const status = await jsonRequest(fetch, `${gateway}/tx/${bundleId}/status`, { limit: 16_384 });
  const blockHeight = height(status.block_height);
  // Arweave independent block hashes are 48 bytes (64 base64url chars).
  if (!arBlockHash(status.block_indep_hash)) fail('invalid Arweave block hash');
  const headText = (await request(fetch, `${gateway}/height`, { limit: 128 })).toString('utf8').trim();
  if (!decimal(headText)) fail('invalid Arweave chain height');
  const head = BigInt(headText);
  const block = await jsonRequest(fetch, `${gateway}/block/height/${blockHeight}`, { limit: 8_388_608 });
  if (height(block.height) !== blockHeight || block.indep_hash !== status.block_indep_hash || !Array.isArray(block.txs) || !block.txs.includes(bundleId)) fail('bundle is absent from canonical Arweave block');
  const confirmations = head >= blockHeight ? head - blockHeight + 1n : 0n;
  if (height(status.number_of_confirmations) < minConfirmations || confirmations < minConfirmations) fail('Arweave confirmation depth is insufficient');
  return { bundleId, blockHeight: blockHeight.toString(), blockHash: block.indep_hash, confirmations: confirmations.toString() };
}

/** Both independent gateway views must serve exact bytes and agree on inclusion.
 * This is a trusted-gateway chain check, not a full Arweave consensus verifier.
 */
export async function verifyFile({ fetch, gateways, id, file, minConfirmations, time }) {
  const checks = [];
  try {
    for (const gateway of gateways) {
      const bytes = await request(fetch, `${gateway}/${id}`, { limit: Number(BigInt(file.size)) });
      if (String(bytes.length) !== file.size || sha256(bytes) !== file.sha256) fail('gateway payload differs from receipt');
      checks.push(await inclusion(fetch, gateway, id, minConfirmations));
    }
    if (['bundleId', 'blockHeight', 'blockHash'].some((key) => checks[0][key] !== checks[1][key])) fail('gateways disagree on bundle inclusion');
    const confirmations = checks.reduce((a, b) => BigInt(b.confirmations) < a ? BigInt(b.confirmations) : a, BigInt(checks[0].confirmations)).toString();
    return { status: 'final', time, ...checks[0], confirmations };
  } catch {
    return { status: 'pending', time };
  }
}
