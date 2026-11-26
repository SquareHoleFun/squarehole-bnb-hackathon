// Runs one of the OpenFour kit's own scripts behind the same preflight as our steps:
//   node -r ./scripts/signer-preload.js scripts/kit.js fork --expect-signer 0x...      (npm run fork -- --expect-signer 0x...)
//   node -r ./scripts/signer-preload.js scripts/kit.js create-test-preset --expect-signer 0x...   (local fork only)
//
// `fork` brings up the developer-owned copy with the kit's fork-from-chain.js, unchanged (its own sends are not
// journaled), priced at eth_gasPrice read now, each wait capped at 45 seconds. Before it starts, out/fork-started.json
// records the signer's next nonce and the block. The copy is accepted (now, or on a later run if the process stopped
// after the kit finished) only from the kit's own output file and only when the chain confirms it: the five proxies
// (Registry, FeeRouter, CreateDeployer, Core, Tools) sit at the addresses the signer's first five transactions from
// the recorded nonce create, they have code, the Registry is owned by the signer, Core's signer is the signer, and the
// receipt of the Registry's deployment is on this endpoint at or after the recorded block. A run that stopped before
// the kit finished leaves a partial copy: the next run refuses unless given --fresh-copy, which abandons it and brings
// up a new copy (about 34M gas: about 0.0034 tBNB at 0.1 gwei).
"use strict";

const fs = require("fs");
const path = require("path");
const { AbstractSigner, ethers } = require("ethers");
const { LOCAL, OUT, preflight, readOut, stop, writeOut } = require("../lib/run");
const { validate } = require("../lib/anchor");

const KIT = path.resolve(__dirname, "..", "node_modules", "openfour-kit", "developer", "fork-deploy");
const KIT_OUT = path.join(KIT, "out", "fork-deployment.json");
const SENDS = path.join(OUT, "kit-sends.jsonl");
const OWN_COPY = path.join(OUT, "kit-output.json"); // this attempt's copy of the kit's shared output, taken when the kit ends
const check = (ctx, started, d) => validate(ctx.provider, { signer: ctx.wallet.address, sendsFile: SENDS, started, d, coreSigner: ctx.wallet.address });

/// This attempt's copy of the kit's output, if it is readable; else the kit's shared file (validated just the same).
function kitFile() {
  for (const f of [OWN_COPY, KIT_OUT]) {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      /* unreadable or absent: try the next */
    }
  }
  return null;
}

function runKit(script) {
  // The kit reads its signer from this variable; it exists in this process only from here on (see the preload).
  process.env.DEPLOYER_PRIVATE_KEY = globalThis[Symbol.for("openfour.signer")].privateKey;
  process.argv = [process.argv[0], path.join(KIT, script)];
  require("module").runMain();
}

async function main() {
  const sub = process.argv[2];
  const ctx = await preflight();
  if (sub === "create-test-preset") {
    if (!LOCAL) stop("create-test-preset is the kit's smoke script: local fork only", 2);
    return runKit("create-test-preset.js");
  }
  if (sub !== "fork") stop("usage: kit.js <fork|create-test-preset> --expect-signer 0x...", 2);

  const started = readOut("fork-started.json", ctx.identity, { optional: true, copy: false });
  const done = readOut("fork-deployment.json", ctx.identity, { optional: true, copy: false });
  if (done) {
    // The same anchor as a recovery: a deployment file of another copy, even by the same wallet, is refused.
    const v = await check(ctx, started, done);
    if (v.inconclusive) stop(`inconclusive: ${v.reason}. Retry later, or on the other endpoint; nothing was decided`, 3);
    if (!v.d || done.addresses.registry !== done.run.registry) stop(`out/fork-deployment.json is not this attempt's copy (${v.d ? "two Registries named" : v.reason}): move it away first`, 2);
    console.log(`the copy of this run is up: Registry ${done.run.registry}; nothing sent`);
    console.log("OK fork");
    return;
  }
  if (started) {
    // This attempt's own copy of the kit's output, or the shared file when that copy is absent or unreadable.
    const v = await check(ctx, started, kitFile());
    if (v.inconclusive) stop(`inconclusive: ${v.reason}. Retry later, or on the other endpoint; do not abandon the copy on this`, 3);
    if (v.d) {
      writeOut("fork-deployment.json", { ...ctx.identity, registry: v.d.addresses.registry }, v.d);
      console.log(`recovered the copy the kit completed earlier, checked on chain: Registry ${v.d.addresses.registry}; nothing sent`);
      console.log("OK fork");
      return;
    }
    if (!process.argv.includes("--fresh-copy")) {
      stop(`an earlier fork started at nonce ${started.startNonce} and its copy is not complete (${v.reason}). To abandon it and bring up a new copy (about 0.0034 tBNB): node -r ./scripts/signer-preload.js scripts/kit.js fork --expect-signer ${ctx.wallet.address} --fresh-copy`, 5);
    }
    console.log(`abandoning the copy started at nonce ${started.startNonce} (${v.reason})`);
  }
  const latest = await ctx.provider.getTransactionCount(ctx.wallet.address, "latest");
  if ((await ctx.provider.getTransactionCount(ctx.wallet.address, "pending")) !== latest) stop("the signer has a pending transaction: wait for it, then rerun", 3);
  const mark = { startedAt: new Date().toISOString(), startNonce: latest, startBlock: await ctx.provider.getBlockNumber() };
  writeOut("fork-started.json", ctx.identity, mark);
  for (const f of [SENDS, OWN_COPY]) if (fs.existsSync(f)) fs.renameSync(f, `${f}.${Date.now()}`);
  // Each of the kit's sends is noted (nonce and hash only: no journal, no recovery) so its deployment can be checked.
  const sendTx = AbstractSigner.prototype.sendTransaction;
  AbstractSigner.prototype.sendTransaction = async function noted(tx) {
    const res = await sendTx.call(this, tx);
    fs.appendFileSync(SENDS, JSON.stringify({ nonce: res.nonce, hash: res.hash }) + "\n");
    return res;
  };
  process.once("beforeExit", async () => {
    if (LOCAL && process.env.OPENFOUR_TEST_CRASH === "fork:before-import") {
      console.log("(rehearsal) simulated crash after the kit finished, before the import");
      process.exit(9);
    }
    if (!fs.existsSync(KIT_OUT)) stop("the kit wrote no deployment file", 1);
    // This attempt's own copy, published whole (temporary file, then rename).
    const tmp = `${OWN_COPY}.tmp-${process.pid}`;
    fs.copyFileSync(KIT_OUT, tmp);
    fs.renameSync(tmp, OWN_COPY);
    const v = await check(ctx, mark, kitFile());
    if (v.inconclusive) stop(`the kit finished; the check is inconclusive: ${v.reason}. Rerun the same command later: it recovers the copy without sending`, 3);
    if (!v.d) stop(`the kit finished but its copy cannot be confirmed: ${v.reason}`, 1);
    writeOut("fork-deployment.json", { ...ctx.identity, registry: v.d.addresses.registry }, v.d);
    console.log(`copy up and checked on chain: Registry ${v.d.addresses.registry}`);
    console.log("OK fork");
  });
  console.log(`fork: the kit's fork-from-chain.js from nonce ${latest} (about 50 transactions, about 34M gas)`);
  runKit("fork-from-chain.js");
}

main().catch((e) => stop(e.shortMessage || e.message || String(e)));
