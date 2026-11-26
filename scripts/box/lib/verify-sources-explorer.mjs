import { API, ZERO, hex, keccak256, chainId, stable, requireValue, VerificationError } from './verify-sources-common.mjs';

const sleepDefault = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pause = 350; // Fewer than three requests/sec, sequential across all parts and retries.
const attempts = 4;
const polls = 5;

function client(options, id) {
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? sleepDefault;
  requireValue(typeof options.key === 'string' && options.key.length > 0, 'explorer key environment variable is empty');
  return async (fields) => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await sleep(pause);
      try {
        // POST keeps the key out of URLs, generated plans and command lines. Never follow a redirect with it.
        const response = await fetch(API, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...fields, chainid: id, apikey: options.key }).toString() });
        const retryAfter = response.headers?.get('Retry-After');
        if (response.status === 429 || response.status >= 500) {
          const seconds = /^\d{1,2}$/.test(retryAfter ?? '') ? parseInt(retryAfter, 10) : 0;
          await sleep(Math.min(30_000, Math.max(1000 * 2 ** attempt, seconds * 1000)));
          continue;
        }
        requireValue(response.ok, 'explorer HTTP request refused');
        const data = await response.json();
        if (/rate limit|too many requests|temporarily unavailable/i.test(typeof data?.result === 'string' ? data.result : '')) {
          await sleep(1000 * 2 ** attempt); continue;
        }
        requireValue(data && typeof data === 'object' && !data.error, 'explorer API request refused');
        return data;
      } catch (error) {
        if (error instanceof VerificationError) throw error;
        if (attempt + 1 < attempts) await sleep(1000 * 2 ** attempt);
      }
    }
    throw new VerificationError('explorer request failed after bounded retries');
  };
}

function compilationSettings(settings) {
  const result = structuredClone(settings);
  // outputSelection chooses returned compiler diagnostics/artifacts, not deployed bytes.
  delete result.outputSelection;
  result.viaIR ??= false;
  result.libraries ??= {};
  for (const names of Object.values(result.libraries)) for (const key of Object.keys(names)) names[key] = names[key].toLowerCase();
  return result;
}

function sourceState(entry, data) {
  if (data.status !== '1' || !Array.isArray(data.result) || data.result.length !== 1) return 'explorer-error';
  const row = data.result[0];
  if (!row.SourceCode || row.ABI === 'Contract source code not verified') return 'unverified';
  if (row.SimilarMatch && row.SimilarMatch.toLowerCase() !== ZERO) return 'similar-match';
  if (row.Proxy === '1') return 'source-mismatch';
  try {
    const text = row.SourceCode.trim();
    const actual = JSON.parse(text.startsWith('{{') && text.endsWith('}}') ? text.slice(1, -1) : text);
    const expected = JSON.parse(entry.request.fields.sourceCode);
    const contractName = entry.contract.split(':').at(-1);
    const argumentsHex = hex(`0x${row.ConstructorArguments.replace(/^0x/, '')}`);
    const matches = row.CompilerVersion === entry.compilerVersion
      && (row.ContractName === contractName || row.ContractName === entry.contract)
      && (!row.ContractFileName || row.ContractFileName === entry.sourcePath)
      && argumentsHex === entry.constructorArguments
      && actual.language === expected.language && stable(actual.sources) === stable(expected.sources)
      && stable(compilationSettings(actual.settings)) === stable(compilationSettings(expected.settings))
      && row.OptimizationUsed === (entry.settings.optimizer.enabled ? '1' : '0')
      && String(row.Runs) === String(entry.settings.optimizer.runs)
      && row.EVMVersion?.toLowerCase() === entry.settings.evmVersion.toLowerCase();
    return matches ? 'verified' : 'source-mismatch';
  } catch { return 'source-unconfirmed'; }
}

/** No transaction RPC, signer or provider is used. Verification is an explorer operation only. */
export async function runExplorer(plan, options) {
  requireValue(['submit', 'status'].includes(options.mode), 'invalid explorer mode');
  const id = chainId(plan.chainId, options.allowMainnet);
  requireValue(id !== '31337', 'local chain supports --plan only');
  const request = client(options, id);
  const states = new Map();
  // Check the entire inventory before the first source submission. A late mismatch cannot cause partial sends.
  for (const entry of plan.contracts) {
    let state;
    try {
      if (!entry.codeHash) state = 'missing-code-pin';
      else {
        const code = await request({ module: 'proxy', action: 'eth_getCode', address: entry.address, tag: 'latest' });
        state = keccak256(hex(code.result)) === entry.codeHash ? 'code-matched' : 'runtime-mismatch';
      }
    } catch { state = 'explorer-error'; }
    states.set(entry.address, { address: entry.address, kind: entry.kind, state });
  }
  const preflight = [...states.values()].every((r) => r.state === 'code-matched');
  for (const entry of plan.contracts) {
    const report = states.get(entry.address);
    if (report.state !== 'code-matched') continue;
    if (entry.kind === 'external') { report.state = 'dependency-hash-matched'; continue; }
    if (entry.kind === 'clone') {
      report.state = states.get(entry.implementation)?.state === 'verified' ? 'proxy-note' : 'implementation-unverified';
      report.note = entry.note; continue;
    }
    if (options.mode === 'submit' && !preflight) { report.state = 'submission-blocked'; continue; }
    try {
      if (options.mode === 'submit') {
        if (entry.dependencies.some((at) => states.get(at)?.state !== 'verified')) {
          report.state = 'dependency-unverified'; continue;
        }
        const submitted = await request(entry.request.fields);
        if (submitted.status === '1') {
          // GUID stays inside this call. No raw explorer response is returned or logged.
          requireValue(typeof submitted.result === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(submitted.result), 'invalid explorer submission receipt');
          for (let i = 0; i < polls; i++) {
            const checked = await request({ module: 'contract', action: 'checkverifystatus', guid: submitted.result });
            if (checked.status === '1' || !/pending|queue/i.test(checked.result ?? '')) break;
            await (options.sleep ?? sleepDefault)(1000 * (i + 1));
          }
        } else if (!/already verified|already been verified/i.test(submitted.result ?? '')) {
          report.state = 'submission-rejected'; continue;
        }
      }
      // Neither an "already verified" response nor a successful GUID is evidence of this source identity.
      const result = await request({ module: 'contract', action: 'getsourcecode', address: entry.address });
      report.state = sourceState(entry, result);
      if (report.state === 'verified') {
        // Recheck after explorer processing too; report no success for code that changed during this run.
        const code = await request({ module: 'proxy', action: 'eth_getCode', address: entry.address, tag: 'latest' });
        if (keccak256(hex(code.result)) !== entry.codeHash) report.state = 'runtime-mismatch';
      }
    } catch { report.state = 'explorer-error'; }
  }
  const contracts = [...states.values()];
  return { format: 'squarehole.source-verification-status/1', chainId: id, mode: options.mode,
    ok: contracts.every((r) => ['verified', 'proxy-note', 'dependency-hash-matched'].includes(r.state)),
    notes: plan.notes, contracts };
}
