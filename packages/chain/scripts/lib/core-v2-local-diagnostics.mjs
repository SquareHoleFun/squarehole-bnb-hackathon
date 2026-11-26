import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeErrorResult, parseAbi } from 'viem';

const standard = parseAbi(['error Error(string)', 'error Panic(uint256)']);

/** Local compiled errors only: decoding never queries a selector service or public RPC. */
export function artifactErrors(contracts) {
  const errors = [...standard];
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'build-info') visit(path);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try { errors.push(...(JSON.parse(readFileSync(path, 'utf8')).abi ?? []).filter(e => e.type === 'error')); }
        catch { /* A partial build must not hide the original broadcast failure. */ }
      }
    }
  };
  try { visit(join(contracts, 'out')); } catch { /* Standard errors remain decodable before the first build. */ }
  return errors;
}

function decode(data, errors, depth = 0) {
  // RPC implementations may nest revert bytes in error.data.data (or error.data.originalError.data).
  if (data && typeof data === 'object' && depth < 4) {
    return decode(data.data ?? data.originalError, errors, depth + 1);
  }
  if (typeof data !== 'string' || !/^0x[\da-f]+$/i.test(data) || data.length < 10) return null;
  try {
    const result = decodeErrorResult({ abi: [...standard, ...errors], data });
    const args = (result.args ?? []).map(arg => typeof arg === 'bigint' ? arg.toString() : String(arg));
    // v4 wraps hook errors in WrappedError(...,bytes reason,bytes details).
    const nested = depth < 4 ? args.map(arg => decode(arg, errors, depth + 1)).filter(Boolean) : [];
    return `${result.errorName}(${args.join(', ')})${nested.length ? ` -> ${nested.join(' -> ')}` : ''}`;
  } catch { return null; }
}

function traceReasons(trace, errors) {
  const result = [];
  const visit = frame => {
    if (frame.error || frame.failed || frame.revertReason) {
      const raw = frame.output ?? frame.returnValue;
      const data = raw && !raw.startsWith('0x') ? `0x${raw}` : raw;
      result.push(decode(data, errors) ?? frame.revertReason ?? `${frame.error ?? 'execution reverted'} (${data || 'empty revert data'})`);
    }
    for (const call of frame.calls ?? []) visit(call);
  };
  visit(trace);
  return [...new Set(result)];
}

/** Replay mined failures while anvil still exists. Never retry a value-changing transaction. */
export async function diagnoseLocalFailure(chain, step, error, { request, report, errors }) {
  const abi = errors();
  const candidates = [...new Set([error.transactionHash,
    ...String(error.message).matchAll(/0x[\da-f]{64}\b/gi)].map(value => Array.isArray(value) ? value[0] : value).filter(Boolean))];
  let mined = false;
  for (const hash of candidates) {
    try {
      const receipt = await request(chain.rpcUrl, 'eth_getTransactionReceipt', [hash]);
      if (receipt?.status !== '0x0') continue;
      mined = true;
      let trace;
      try { trace = await request(chain.rpcUrl, 'debug_traceTransaction', [hash, { tracer: 'callTracer' }]); }
      catch {
        // Older anvil builds expose the default tracer only. Its returnValue still contains revert data.
        trace = await request(chain.rpcUrl, 'debug_traceTransaction', [hash, { disableStorage: true, disableStack: true, enableMemory: false }]);
      }
      const reasons = traceReasons(trace, abi);
      report(`[core-v2] FAILED ${step}: ${hash}\n${reasons.join('\n') || 'Replay returned no revert data; inspect the saved trace.'}`);
      if (chain.out) writeFileSync(join(chain.out, `failed-${hash}.json`), JSON.stringify({ step, receipt, trace }, null, 2));
    } catch (traceError) {
      report(`[core-v2] FAILED ${step}: replay unavailable for ${hash}: ${traceError.message}`);
    }
  }
  if (!mined) report(`[core-v2] FAILED ${step}: transaction not mined or no failed receipt found; no transaction to replay.\n` +
    `${decode(error.data, abi) ?? error.message}`);
}
