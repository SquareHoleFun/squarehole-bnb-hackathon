// The deployment anchor: the one check that a deployment file is THIS attempt's copy, used by scripts/kit.js (on
// import and recovery), by scripts/pile.js (before every command) and by the signing service (at startup).
//
// The start record (fork-started.json) holds the deploying wallet's nonce and the block when the kit started, both
// non-negative integers. A deployment file is this attempt's copy only when, on the chain: its Registry, FeeRouter,
// CreateDeployer, Core and Tools are the contracts the wallet's first five transactions from that nonce created (and
// have code); the Registry's owner is the wallet (the one owner read: the other four are proven by the nonces that
// created them); Core's signer is the expected one (when one is given); the kit's two presets are open and its WBNB is
// Core's wrapped native coin; and the receipt of the Registry's deployment (the hash noted in kit-sends.jsonl at the
// start nonce) is on this endpoint at or after the start block. A lookup that fails or finds no receipt is
// INCONCLUSIVE (retry later or on the other endpoint), never evidence that the copy is incomplete.
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ORDER = ["registry", "feeRouter", "createDeployer", "core", "tools"]; // fork-from-chain.js deploys these first, in this order
const PRESET_ABI = ["function getPreset(uint256) view returns (tuple(uint256 id, string name, string description, string version, bool active, bool createEnabled, address validator, bytes32 tokenModuleId, bytes32 vaultModuleId, bytes32 curveModuleId, bytes32 tradeModuleId, bytes32 migrateModuleId, bytes32 tokenImplId, bytes32 customDataId, address author))"];

/// Returns { d } when `d` is the anchored copy, else { reason, inconclusive }.
async function validate(provider, { signer, sendsFile, started, d, coreSigner }) {
  const no = (reason) => ({ reason });
  if (!d) return no("no deployment file");
  if (!started) return no("no start record of this attempt");
  const whole = (n) => Number.isSafeInteger(n) && n >= 0;
  if (!whole(started.startNonce) || !whole(started.startBlock)) return no("the start record's nonce and block must be non-negative integers");
  try {
    if (d.chainId !== 97 || d.deployer !== signer) return no("the file is for another chain or deployer");
    for (let i = 0; i < ORDER.length; i++) {
      const want = ethers.getCreateAddress({ from: signer, nonce: started.startNonce + i });
      if (!d.addresses || d.addresses[ORDER[i]] !== want) return no(`the file's ${ORDER[i]} is not the contract transaction ${started.startNonce + i} created`);
      if ((await provider.getCode(want)) === "0x") return no(`no code at the ${ORDER[i]} ${want}`);
    }
    const registry = new ethers.Contract(d.addresses.registry, ["function owner() view returns (address)", ...PRESET_ABI], provider);
    if ((await registry.owner()) !== signer) return no("the Registry is not owned by the wallet");
    const core = new ethers.Contract(d.addresses.core, ["function signer() view returns (address)", "function wrappedNative() view returns (address)"], provider);
    if (coreSigner && (await core.signer()) !== coreSigner) return no(`Core's signer is not ${coreSigner}`);
    for (const key of ["bondingV1", "bondingTaxV1"]) {
      const p = d.presets && d.presets[key] ? await registry.getPreset(BigInt(d.presets[key])) : null;
      if (!p || p.id === 0n || !p.active || !p.createEnabled) return no(`the copy's preset ${key} is not registered and open`);
    }
    if (!d.addresses.wbnb || (await core.wrappedNative()) !== d.addresses.wbnb) return no("the file's WBNB is not Core's wrapped native coin");
    let first = null;
    try {
      first = fs.readFileSync(sendsFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.nonce === started.startNonce);
    } catch {
      first = null;
    }
    if (!first) return no("no record of the kit's first transaction");
    const receipt = await provider.getTransactionReceipt(first.hash);
    if (!receipt) return { reason: `no receipt for the Registry's deployment ${first.hash} on this endpoint`, inconclusive: true };
    if (receipt.contractAddress !== d.addresses.registry || receipt.blockNumber < started.startBlock) return no("the Registry's deployment receipt does not match the start record");
    return { d };
  } catch (e) {
    return { reason: `a lookup failed (${e.shortMessage || e.message || e})`, inconclusive: true };
  }
}

/// For pile.js and the signing service: the anchored deployment of the records in `outDir` (run = the expected
/// identity without the Registry). Returns { d } or { reason, inconclusive }.
async function anchored(provider, outDir, run, coreSigner) {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(outDir, f), "utf8"));
    } catch {
      return null;
    }
  };
  const started = read("fork-started.json");
  const d = read("fork-deployment.json");
  const same = (a) => a && a.endpoint === run.endpoint && a.chainId === run.chainId && a.block1Hash === run.block1Hash && a.signer === run.signer;
  if (!started || !d || !same(started.run) || !same(d.run)) return { reason: "the start record or the deployment file is missing or of another run" };
  if (!d.run.registry || d.run.registry !== d.addresses.registry) return { reason: "the deployment file names two Registries" };
  return validate(provider, { signer: run.signer, sendsFile: path.join(outDir, "kit-sends.jsonl"), started, d, coreSigner });
}

module.exports = { anchored, validate };
