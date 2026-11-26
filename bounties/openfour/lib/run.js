// The run's safety rails, shared by every entry point that sends (scripts/kit.js, scripts/pile.js).
//
// preflight  the endpoint is one of two public chain-97 endpoints (a real run) or, with OPENFOUR_LOCAL_FORK=1, a
//            loopback anvil that says it is anvil; chain 97; the signer equals --expect-signer and is not a public
//            test key (real run); the kit's inputs and our overrides are refused by presence; the gas price is
//            eth_gasPrice read now; one writer at a time (out/.lock).
// records    every out/*.json is written atomically (beside, then renamed) and carries the run's identity: endpoint,
//            chain, block-1 hash, signer and, once the copy exists, its Registry; a record of another run, or of
//            another copy (a missing Registry counts as another copy), is refused.
// operations every transaction has a stable operation id. Its record goes signed -> mined -> verified: "signed" is
//            written before the broadcast, "mined" when the receipt is in, "verified" only after the step's own
//            checks ran (the check is stored in the record, so any later invocation can run it). A reverted
//            operation, or one whose nonce something else used, stays open until `pile.js resolve <operation>`
//            moves it to out/ops/failed/ after the operator looked.
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const LOCAL = process.env.OPENFOUR_LOCAL_FORK === "1";
const OUT = process.env.OPENFOUR_OUT_DIR ? path.resolve(ROOT, process.env.OPENFOUR_OUT_DIR) : path.join(ROOT, "out");
const SHOW = path.relative(ROOT, OUT) || ".";
const OPS = path.join(OUT, "ops");
const PUBLIC_RPCS = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet.publicnode.com"];
const RECEIPT_TIMEOUT_MS = 45_000;
// What the kit's fork-from-chain.js (and the dotenv it loads) read, besides RPC_URL, at the pinned commit, and our own
// override: refused when present at all, empty included.
const REFUSED_INPUTS = [
  "BSC_TESTNET_RPC_URL", "DRY_RUN", "PROXY_DEPLOY_TX", "REBATE_ADDRESS", "SIH_POOL_MANAGER", "SOURCE_DEPLOYMENT",
  "TREASURY_ADDRESS", "SIGNER_ADDRESS", "PRESET_AUTHOR", "DOTENV_KEY", "DOTENV_CONFIG_PATH", "OPENFOUR_GAS_PRICE_WEI",
];
const TEST_MNEMONIC = "test test test test test test test test test test test junk";

/// Exit codes: 1 failed check or revert, 2 refused input, 3 no receipt in time, 4 an earlier operation was finished
/// instead of the requested step, 5 an operation needs the operator (resolve).
function stop(message, code = 1) {
  console.error(`stopped: ${message}`);
  process.exit(code);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function json(value) {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json(value));
  fs.renameSync(tmp, file);
}

function syncDir(dir) {
  const fd = fs.openSync(dir, "r");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

/// As writeAtomic, and on disk before it returns: the temporary file is synced, renamed, and the folder synced (so a
/// signed transaction's record survives a host crash right after the broadcast).
function writeDurable(file, value) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    syncDir(path.dirname(dir));
  }
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w");
  fs.writeSync(fd, json(value));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  syncDir(dir);
}

/// The checks an operation can carry (scripts/pile.js runs them); an operation with any other is not sent.
const CHECK_KINDS = ["deploy", "approve", "created", "wrap", "tokens-in", "sell", "redeem", "settle", "module", "preset", "preset-fee", "pile", "signer", "rules", "distribute"];

function withDeadline(promise, until, what) {
  const left = until - Date.now();
  if (left <= 0) return Promise.reject(new Error(`deadline passed: ${what}`));
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`deadline passed: ${what}`)), left); })])
    .finally(() => clearTimeout(t));
}

/// One writer at a time: out/.lock is created exclusively and removed when this process ends. A lock left by a process
/// that died is never taken over automatically: the operator looks, then removes it.
function lock() {
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, ".lock");
  let fd;
  try {
    fd = fs.openSync(file, "wx");
  } catch {
    stop(`${SHOW}/.lock exists (written by process ${fs.readFileSync(file, "utf8")}): another run is writing, or one stopped without cleaning up. Check that no run is active, then remove ${SHOW}/.lock`, 2);
  }
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  process.on("exit", () => {
    try {
      if (fs.readFileSync(file, "utf8") === String(process.pid)) fs.unlinkSync(file);
    } catch {
      /* gone already */
    }
  });
}

function testKeyAddresses() {
  const m = ethers.Mnemonic.fromPhrase(TEST_MNEMONIC);
  const out = new Set();
  for (const i of [...Array(20).keys(), ...Array.from({ length: 61 }, (_, k) => 4240 + k)]) {
    out.add(ethers.HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${i}`).address);
  }
  return out;
}

async function preflight() {
  const rpc = String(process.env.RPC_URL || "").replace(/\/+$/, "");
  if (!rpc) stop("set RPC_URL", 2);
  if (LOCAL) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(rpc)) stop("OPENFOUR_LOCAL_FORK=1 needs a loopback RPC_URL", 2);
  } else {
    if (!PUBLIC_RPCS.includes(rpc)) stop(`RPC_URL must be one of ${PUBLIC_RPCS.join(", ")} for a real run`, 2);
    if ("OPENFOUR_OUT_DIR" in process.env) stop("OPENFOUR_OUT_DIR is set: a real run keeps its records in out/", 2);
  }
  for (const name of REFUSED_INPUTS) if (name in process.env) stop(`${name} is set: unset it (it would change what is sent)`, 2);
  const wallet0 = globalThis[Symbol.for("openfour.signer")];
  if (!wallet0) stop("no signer: run through node -r ./scripts/signer-preload.js", 2);
  const expected = arg("--expect-signer");
  if (!expected || !ethers.isAddress(expected)) stop("give the expected signer: --expect-signer 0x...", 2);
  if (ethers.getAddress(expected) !== wallet0.address) stop(`the keystore holds ${wallet0.address}, not the expected ${ethers.getAddress(expected)}`, 2);
  if (!LOCAL && testKeyAddresses().has(wallet0.address)) stop(`${wallet0.address} is a public test key: not for a real run`, 2);

  const request = new ethers.FetchRequest(rpc);
  request.timeout = RECEIPT_TIMEOUT_MS; // every request to the endpoint gives up after 45 s
  const provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 97n) stop(`chain ${chainId}: BSC Testnet (97) or a fork of it only`, 2);
  if (LOCAL) {
    // A loopback address could forward to the public chain: it must be our own anvil.
    const client = String(await provider.send("web3_clientVersion", []));
    let info = null;
    try {
      info = await provider.send("anvil_nodeInfo", []);
    } catch {
      info = null;
    }
    if (!/anvil/i.test(client) || !info) stop(`${rpc} is not a local anvil (client "${client}")`, 2);
  }
  const block1Hash = (await provider.getBlock(1)).hash;
  const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  if (gasPrice <= 0n) stop("eth_gasPrice answered 0", 2);
  process.env.OPENFOUR_GAS_PRICE_WEI = gasPrice.toString(); // read by the preload, which prices the kit's sends with it
  lock();
  const wallet = wallet0.connect(provider);
  const balance = await provider.getBalance(wallet.address);
  const identity = { endpoint: rpc, chainId: 97, block1Hash, signer: wallet.address };
  console.log(`run: ${rpc} (chain 97${LOCAL ? ", local anvil" : ""}), signer ${wallet.address}, balance ${ethers.formatEther(balance)} BNB, gas price ${ethers.formatUnits(gasPrice, "gwei")} gwei, records ${SHOW}`);
  return { provider, wallet, identity, gasPrice, local: LOCAL };
}

function sameChain(a, b) {
  return Boolean(a && b && a.endpoint === b.endpoint && a.chainId === b.chainId && a.block1Hash === b.block1Hash && a.signer === b.signer);
}

/// Same run AND same copy: both identities name a Registry and it is the same one.
function sameCopy(a, b) {
  return sameChain(a, b) && Boolean(a.registry) && a.registry === b.registry;
}

function readOut(name, identity, { optional = false, copy = true } = {}) {
  const p = path.join(OUT, name);
  if (!fs.existsSync(p)) {
    if (optional) return null;
    stop(`${SHOW}/${name} missing: run the earlier step first`);
  }
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!(copy ? sameCopy(data.run, identity) : sameChain(data.run, identity))) {
    stop(`${SHOW}/${name} belongs to another run or copy (${JSON.stringify(data.run)}): move it away first`, 2);
  }
  return data;
}

function writeOut(name, identity, data) {
  writeAtomic(path.join(OUT, name), { run: identity, ...data });
  console.log(`wrote ${SHOW}/${name}`);
}

function opFile(opId) {
  return path.join(OPS, `${opId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function readOp(opId) {
  const f = opFile(opId);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

function writeOp(rec) {
  writeDurable(opFile(rec.opId), rec);
}

/// The operations of this copy that are not verified (and not resolved as failed).
function openOps(identity) {
  if (!fs.existsSync(OPS)) return [];
  return fs.readdirSync(OPS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(OPS, f), "utf8")))
    .filter((r) => r.status !== "verified")
    .map((r) => {
      if (!sameCopy(r.run, identity)) stop(`${SHOW}/ops/${r.opId} belongs to another run or copy: move it away first`, 2);
      return r;
    });
}

/// Rehearsal only (local fork): OPENFOUR_TEST_CRASH=<operation>:signed|sent|mined ends the process right there, as a
/// crash would, so the restart path can be proven.
function crashHook(opId, stage) {
  if (LOCAL && process.env.OPENFOUR_TEST_CRASH === `${opId}:${stage}`) {
    console.log(`(rehearsal) simulated crash after ${stage}: ${opId}`);
    process.exit(9);
  }
}

/// Sends one transaction under a stable operation id and returns { receipt, rec } once it is mined (status "mined"
/// or, from an earlier run, "verified"). `build` is called only when no record exists. `check` is stored in the
/// record for the step's verification. A reverted or conflicting operation is recorded as such and stops the run.
async function send(ctx, opId, description, build, { gasLimit, check } = {}) {
  const { provider, wallet, identity, gasPrice } = ctx;
  let rec = readOp(opId);
  if (rec && !sameCopy(rec.run, identity)) stop(`${SHOW}/ops/${opId} belongs to another run or copy`, 2);
  if (rec && (rec.status === "reverted" || rec.status === "conflict")) {
    stop(`${opId} is ${rec.status} (${rec.hash}): look the transaction and the signer's history up, then run: pile.js resolve ${opId}`, 5);
  }
  if (rec && (rec.status === "mined" || rec.status === "verified")) {
    const receipt = await withDeadline(provider.getTransactionReceipt(rec.hash), Date.now() + RECEIPT_TIMEOUT_MS, "receipt").catch(() => null);
    if (!receipt) stop(`${opId}: recorded as mined (${rec.hash}) but this endpoint has no receipt: try again later or on the other endpoint`, 3);
    if (receipt.status !== 1) {
      rec.status = "reverted";
      writeOp(rec);
      stop(`${opId}: its receipt now reads reverted (${rec.hash}). Look it up, then run: pile.js resolve ${opId}`, 5);
    }
    return { receipt, rec };
  }
  if (!rec) {
    const request = await build();
    const base = { ...request, from: wallet.address, chainId: 97n, type: 0, gasPrice };
    if (process.env.OPENFOUR_DRY === "1") {
      // Dry mode: the next transaction of this step is built and simulated on the endpoint, never signed or sent and
      // never journaled. The last line names it; operations recorded before are resumed as usual.
      let gas;
      try {
        gas = await provider.estimateGas(base);
      } catch (e) {
        stop(`DRY ${opId}: the simulation reverts (${(e.reason || e.shortMessage || "no reason").slice(0, 200)}); nothing sent`, 6);
      }
      console.log(`DRY would send ${opId}: ${description}; simulated gas ${gas} (at most ${ethers.formatEther((gasLimit || (gas * 13n) / 10n) * gasPrice)} BNB at ${ethers.formatUnits(gasPrice, "gwei")} gwei)`);
      console.log(`DRY ${opId}`);
      process.exit(0);
    }
    const limit = gasLimit || ((await provider.estimateGas(base)) * 13n) / 10n;
    const pending = await provider.getTransactionCount(wallet.address, "pending");
    const latest = await provider.getTransactionCount(wallet.address, "latest");
    if (pending !== latest) stop(`the signer has a pending transaction (nonces ${latest}..${pending - 1}): wait for it, then rerun`, 3);
    const tx = { ...base, gasLimit: limit, nonce: latest };
    delete tx.from;
    const raw = await wallet.signTransaction(tx);
    if (!check || !CHECK_KINDS.includes(check.kind)) stop(`${opId}: an operation without a recognised check is not sent`, 1);
    rec = { run: identity, opId, description, status: "signed", hash: ethers.keccak256(raw), nonce: latest, gasLimit: limit.toString(), check, raw };
    writeOp(rec);
    console.log(`send ${opId}: ${description}; gas limit ${limit} (at most ${ethers.formatEther(limit * gasPrice)} BNB)`);
    crashHook(opId, "signed");
  } else {
    console.log(`resuming ${opId}: ${rec.hash}`);
  }
  const until = Date.now() + RECEIPT_TIMEOUT_MS;
  let receipt = await withDeadline(provider.getTransactionReceipt(rec.hash), until, "receipt").catch(() => null);
  if (!receipt) {
    const used = await withDeadline(provider.getTransactionCount(wallet.address, "latest"), until, "nonce").catch(() => null);
    if (used === null) stop(`no answer from the endpoint for ${opId} (${rec.hash}): look the hash up on the other endpoint, then rerun the same command`, 3);
    if (used <= rec.nonce) {
      try {
        await withDeadline(provider.broadcastTransaction(rec.raw), until, "broadcast");
      } catch (e) {
        const text = String((e.error && e.error.message) || e.shortMessage || e.message || e);
        if (!/already known|known transaction/i.test(text)) stop(`${opId}: the node did not take ${rec.hash}: ${text}. Look the hash up, then rerun the same command`, 3);
      }
      crashHook(opId, "sent");
    }
    while (!receipt && Date.now() < until) {
      receipt = await withDeadline(provider.getTransactionReceipt(rec.hash), until, "receipt").catch(() => null);
      if (!receipt) await new Promise((res) => setTimeout(res, 1000));
    }
    if (!receipt) {
      const now = await withDeadline(provider.getTransactionCount(wallet.address, "latest"), Date.now() + 10_000, "nonce").catch(() => null);
      if (now !== null && now > rec.nonce) {
        rec.status = "conflict";
        writeOp(rec);
        stop(`${opId}: nonce ${rec.nonce} was used, but not by ${rec.hash} as far as this endpoint knows: look the hash and the signer's history up (also on the other endpoint), then run: pile.js resolve ${opId}`, 5);
      }
      stop(`no receipt for ${opId} (${rec.hash}) after 45 seconds: look the hash up on the other endpoint, then rerun the SAME command`, 3);
    }
  }
  delete rec.raw;
  rec.block = receipt.blockNumber;
  if (receipt.status !== 1) {
    rec.status = "reverted";
    writeOp(rec);
    stop(`${opId} reverted on chain (${rec.hash}); nothing after it was sent. Look it up, then run: pile.js resolve ${opId}`, 1);
  }
  rec.status = "mined";
  writeOp(rec);
  console.log(`  mined ${rec.hash} in block ${receipt.blockNumber}, gas ${receipt.gasUsed}`);
  crashHook(opId, "mined");
  return { receipt, rec };
}

function verified(rec, note) {
  rec.status = "verified";
  if (note) rec.verifiedNote = note;
  writeOp(rec);
}

/// `pile.js resolve <operation>`: after the operator looked, moves a reverted or conflicting operation (or a signed one
/// whose nonce was used by another transaction) to out/ops/failed/, so the step can be sent anew.
/// Finds the wallet's mined transaction at `nonce` in the recent chain: the first block whose state shows the nonce used
/// (binary search over the last 20,000 blocks, which needs the endpoint's recent state), then that block's transaction
/// from the wallet with that nonce. Returns its hash, or null when it cannot be established.
async function minedAtNonce(provider, address, nonce) {
  try {
    let hi = await provider.getBlockNumber();
    let lo = Math.max(0, hi - 20_000);
    if ((await provider.getTransactionCount(address, lo)) > nonce) return null; // used before the searched range
    if ((await provider.getTransactionCount(address, hi)) <= nonce) return null; // not used yet
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if ((await provider.getTransactionCount(address, mid)) > nonce) hi = mid;
      else lo = mid;
    }
    const block = await provider.getBlock(hi, true);
    const tx = block.prefetchedTransactions.find((t) => t.from === address && t.nonce === nonce);
    return tx ? tx.hash : null;
  } catch {
    return null;
  }
}

/// `pile.js resolve <operation>`: sets an operation aside (out/ops/failed/) ONLY on proof: its own transaction's
/// receipt reads failed, or a DIFFERENT transaction from the wallet was mined at its nonce (found and printed).
/// Anything else leaves it open: look again later.
async function resolve(ctx, opId) {
  const rec = readOp(opId);
  if (!rec) stop(`no operation ${opId}`, 2);
  if (!sameCopy(rec.run, ctx.identity)) stop(`${SHOW}/ops/${opId} belongs to another run or copy: not touched`, 2);
  if (rec.status === "verified" || rec.status === "mined") stop(`${opId} is ${rec.status}: nothing to resolve`, 2);
  const receipt = await ctx.provider.getTransactionReceipt(rec.hash);
  let proof = null;
  if (receipt && receipt.status === 1) stop(`${opId} was mined successfully (${rec.hash}): rerun the same command instead`, 2);
  if (receipt && receipt.status === 0) proof = `its transaction ${rec.hash} failed (block ${receipt.blockNumber})`;
  if (!receipt) {
    if ((await ctx.provider.getTransactionCount(ctx.wallet.address, "latest")) <= rec.nonce) stop(`${opId}'s nonce is still unused: rerun the same command instead`, 2);
    const other = await minedAtNonce(ctx.provider, ctx.wallet.address, rec.nonce);
    if (other && other !== rec.hash) proof = `nonce ${rec.nonce} was used by another transaction: ${other}`;
  }
  if (!proof) stop(`${opId}: no proof yet that its transaction ${rec.hash} failed or was replaced; it stays open. Look again later`, 3);
  const dest = path.join(OPS, "failed", `${path.basename(opFile(opId), ".json")}.${Date.now()}.json`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(opFile(opId), dest);
  console.log(`resolved ${opId} as failed: ${proof}; moved to ${path.relative(ROOT, dest)}`);
  console.log(`OK resolve ${opId}`);
}

/// A contract call as a request, after a simulation that must succeed.
async function call(ctx, contract, fn, args) {
  const data = contract.interface.encodeFunctionData(fn, args);
  const to = await contract.getAddress();
  await ctx.provider.call({ from: ctx.wallet.address, to, data });
  return { to, data };
}

module.exports = {
  CHECK_KINDS, LOCAL, OUT, sameCopy, testKeyAddresses, PUBLIC_RPCS, arg, call, openOps, preflight, readOp, readOut, resolve, sameChain, send, stop, verified, writeAtomic, writeOut,
};
