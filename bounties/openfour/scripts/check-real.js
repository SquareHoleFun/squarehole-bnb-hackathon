// Read-only check of the real run against BSC Testnet (public endpoints; no transaction, no key):
//   - the deployment anchor (lib/anchor.js) passes for the run's records;
//   - Core's signer, in either state of the handoff, from the run's own records and the chain: with no completed
//     `set-signer` operation in ops/, the run wallet; after one, exactly the address the last completed one (the
//     highest nonce among the verified set-signer records, its receipt on chain from the run wallet to Core) recorded.
//     An unsettled set-signer record (signed, mined, conflict) fails the check. The line says which case it read;
//   - both launches read Migrated;
//   - both piles hold at least what the run log's last status lines say, and their totals received and paid out are
//     at least those figures.
// usage: node scripts/check-real.js <records folder (the run's out/)> <the run's log>
//   The public endpoints; with OPENFOUR_LOCAL_FORK=1 (the rehearsal) the loopback RPC_URL instead.
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { anchored } = require("../lib/anchor");
const { PHASE } = require("../lib/openfour");

const PUBLIC = ["https://bsc-testnet-rpc.publicnode.com", "https://bsc-testnet-dataseed.bnbchain.org"];

function endpoints() {
  if (process.env.OPENFOUR_LOCAL_FORK !== "1") return PUBLIC;
  const rpc = String(process.env.RPC_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(rpc)) throw new Error("OPENFOUR_LOCAL_FORK=1 needs a loopback RPC_URL");
  return [rpc];
}

/// Which signer Core must have, from the run's records: { want, reason } or { error }.
async function expectedSigner(provider, dir, fork) {
  const opsDir = path.join(dir, "ops");
  const names = fs.existsSync(opsDir) ? fs.readdirSync(opsDir).filter((n) => /^set-signer\..*\.json$/.test(n)) : [];
  const recs = names.map((n) => JSON.parse(fs.readFileSync(path.join(opsDir, n), "utf8")));
  const unsettled = recs.find((r) => ["signed", "mined", "conflict"].includes(r.status));
  if (unsettled) return { error: `${unsettled.opId} is ${unsettled.status}: finish or resolve it first` };
  const done = recs.filter((r) => r.status === "verified").sort((x, y) => y.nonce - x.nonce);
  if (!done.length) return { want: fork.run.signer, reason: `the run wallet ${fork.run.signer} (no completed set-signer operation in the records)` };
  const last = done[0];
  const r = await provider.getTransactionReceipt(last.hash);
  if (!r || r.status !== 1 || r.from !== fork.run.signer || r.to !== fork.addresses.core) {
    return { error: `${last.opId}: its transaction ${last.hash} is not on chain as a successful call from the run wallet to Core` };
  }
  const want = ethers.getAddress(String(last.check.address).toLowerCase());
  const after = want === fork.run.signer ? "the run wallet signs creations again (a handover window: the service's key comes next)" : "the run wallet no longer signs creations";
  return { want, reason: `${want}, the address of the last completed set-signer operation (${last.opId}, nonce ${last.nonce}, block ${r.blockNumber}); ${after}` };
}

/// The last status figures of each launch in the run's log.
function lastStatus(logFile) {
  const last = {};
  let current = null;
  for (const line of fs.readFileSync(logFile, "utf8").split("\n")) {
    const m = line.match(/"(launch|pile_balance|totalReceived|totalPaidOut)": "([^"]*)"/);
    if (!m) continue;
    if (m[1] === "launch") current = m[2];
    else if (current) last[current] = { ...(last[current] || {}), [m[1]]: BigInt(m[2]) };
  }
  return last;
}

async function main() {
  const [dir, logFile] = process.argv.slice(2);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const fork = read("fork-deployment.json");
  const logged = lastStatus(logFile);
  let failures = 0;
  const check = (ok, line) => {
    console.log(`${ok ? "pass" : "FAIL"}  ${line}`);
    if (!ok) failures += 1;
  };
  let provider = null;
  for (const url of endpoints()) {
    const req = new ethers.FetchRequest(url);
    req.timeout = 45_000;
    const p = new ethers.JsonRpcProvider(req, 97, { staticNetwork: true });
    try {
      await p.getBlockNumber();
      provider = p;
      console.log(`endpoint ${url}, block ${await p.getBlockNumber()}`);
      break;
    } catch {
      console.log(`endpoint ${url} did not answer`);
    }
  }
  if (!provider) throw new Error("no endpoint answered");
  check((await provider.getBlock(1)).hash === fork.run.block1Hash, "chain 97, the run's block-1 hash");

  const a = await anchored(provider, dir, fork.run, null);
  check(Boolean(a.d), `deployment anchor: Registry ${fork.addresses.registry}, Core ${fork.addresses.core}, Tools ${fork.addresses.tools} are the run's first five transactions' contracts, the Registry owned by the run wallet${a.d ? "" : ` (${a.reason})`}`);
  const core = new ethers.Contract(fork.addresses.core, ["function signer() view returns (address)"], provider);
  const e = await expectedSigner(provider, dir, fork);
  const now = await core.signer();
  if (e.error) check(false, `Core's signer is ${now}: ${e.error}`);
  else check(now === e.want, now === e.want ? `Core's signer is ${e.reason}` : `Core's signer is ${now}, not ${e.reason}`);

  const PILE_ABI = ["function pile() view returns (uint256)", "function totalReceived() view returns (uint256)", "function totalPaidOut() view returns (uint256)", "function circulatingSupply() view returns (uint256)"];
  for (const which of ["tax", "preset"]) {
    const l = read(`launch-${which}.json`);
    const vault = new ethers.Contract(l.vault, ["function phase() view returns (uint8)"], provider);
    const phase = PHASE[Number(await vault.phase())];
    check(phase === "Migrated", `${which} launch ${l.token}: phase ${phase}`);
    const pile = new ethers.Contract(l.pile, PILE_ABI, provider);
    const [bal, rec, paid] = [await pile.pile(), await pile.totalReceived(), await pile.totalPaidOut()];
    const want = logged[which] || {};
    check(want.pile_balance !== undefined && bal >= want.pile_balance, `${which} pile ${l.pile}: holds ${bal} (log: ${want.pile_balance})`);
    check(want.totalReceived !== undefined && rec >= want.totalReceived, `${which} pile: received ${rec} in all (log: ${want.totalReceived})`);
    check(want.totalPaidOut !== undefined && paid >= want.totalPaidOut, `${which} pile: paid out ${paid} in all (log: ${want.totalPaidOut})`);
  }
  if (failures) {
    console.error(`stopped: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("OK check-real");
}

main().catch((e) => {
  console.error(`stopped: ${e.shortMessage || e.message || e}`);
  process.exit(1);
});
