// The signer preload and the preflight refuse every input but the accepted ones, before any network call.
// node --test test-node/signer.test.js   (no chain needed: every case stops before the first request)
// The fixture keystore holds a PUBLIC test key, encrypted with a random password made here, under .cache/.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { HDNodeWallet, Mnemonic, Wallet } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(ROOT, ".cache", "test-signer");
const KIT = path.join(ROOT, "node_modules", "openfour-kit", "developer");
const ENV_FILES = [path.join(ROOT, ".env"), path.join(KIT, ".env"), path.join(KIT, "fork-deploy", ".env"), path.join(KIT, "startup", ".env")];
const PUBLIC = "https://bsc-testnet-rpc.publicnode.com";
const REFUSED = ["BSC_TESTNET_RPC_URL", "DRY_RUN", "PROXY_DEPLOY_TX", "REBATE_ADDRESS", "SIH_POOL_MANAGER", "SOURCE_DEPLOYMENT",
  "TREASURY_ADDRESS", "SIGNER_ADDRESS", "PRESET_AUTHOR", "DOTENV_KEY", "DOTENV_CONFIG_PATH", "OPENFOUR_GAS_PRICE_WEI"];

fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
const wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase("test test test test test test test test test test test junk"), "m/44'/60'/0'/0/4270");
const KS = path.join(TMP, "ks.json");
const PW = path.join(TMP, "pw");
const BAD_PW = path.join(TMP, "bad-pw");
const password = crypto.randomBytes(24).toString("hex");
fs.writeFileSync(PW, password + "\n", { mode: 0o600 });
fs.writeFileSync(KS, new Wallet(wallet.privateKey).encryptSync(password), { mode: 0o600 });
fs.writeFileSync(BAD_PW, crypto.randomBytes(24).toString("hex") + "\n", { mode: 0o600 });

function run(env, script = ["-e", "0"]) {
  const r = spawnSync(process.execPath, ["-r", "./scripts/signer-preload.js", ...script], {
    cwd: ROOT, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 60_000,
  });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}
// The WHOLE output must be exactly the refusal (after the preload's address line when the preflight refuses).
function refused(r, line) {
  assert.equal(r.code, 2, r.out);
  const want = line.startsWith("stopped:") ? `signer: ${wallet.address}\n${line}` : line;
  assert.equal(r.out, want);
}

const both = { OPENFOUR_KEYSTORE: KS, OPENFOUR_KEYSTORE_PASSWORD_FILE: PW, RPC_URL: PUBLIC };
const pile = ["scripts/pile.js", "status", "--launch", "tax"];
const expect = ["--expect-signer", wallet.address];

test("accepts the keystore pair on a public endpoint and prints exactly the address", () => {
  const r = run(both);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `signer: ${wallet.address}`);
});
test("refuses without a signer", () => refused(run({ RPC_URL: PUBLIC }), "signer: no signer: set OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE"));
test("refuses half of the pair, an empty one included", () => {
  refused(run({ OPENFOUR_KEYSTORE: KS, RPC_URL: PUBLIC }), "signer: set both OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
  refused(run({ OPENFOUR_KEYSTORE_PASSWORD_FILE: PW, RPC_URL: PUBLIC }), "signer: set both OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
  refused(run({ ...both, OPENFOUR_KEYSTORE: "" }), "signer: set both OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
  refused(run({ OPENFOUR_LOCAL_FORK: "1", OPENFOUR_LOCAL_DEV: "1", OPENFOUR_KEYSTORE: "", RPC_URL: "http://127.0.0.1:8580" }), "signer: set both OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
});
test("refuses an unreadable file", () => {
  refused(run({ ...both, OPENFOUR_KEYSTORE: path.join(TMP, "missing.json") }), "signer: OPENFOUR_KEYSTORE: the file cannot be read");
  refused(run({ ...both, OPENFOUR_KEYSTORE_PASSWORD_FILE: path.join(TMP, "missing") }), "signer: OPENFOUR_KEYSTORE_PASSWORD_FILE: the file cannot be read");
});
test("a wrong password gives the fixed text and nothing else", () => {
  const r = run({ ...both, OPENFOUR_KEYSTORE_PASSWORD_FILE: BAD_PW });
  assert.equal(r.code, 2);
  assert.equal(r.out, "signer: keystore: decryption failed");
});
test("refuses the kit's key variable when present, empty included", () => {
  for (const v of [wallet.privateKey, ""]) {
    refused(run({ ...both, DEPLOYER_PRIVATE_KEY: v }), "signer: DEPLOYER_PRIVATE_KEY is set in the environment: unset it; the signer comes only from the keystore");
  }
});
test("refuses a .env file at each place the kit or the project would load one", () => {
  for (const file of ENV_FILES) {
    if (fs.existsSync(file)) assert.fail(`${file} exists before the test: not touched`);
  }
  for (const file of ENV_FILES) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "# test file: no key\n");
    try {
      refused(run(both), `signer: ${path.relative(ROOT, file)} exists: remove it; no key is read from .env files`);
    } finally {
      fs.unlinkSync(file);
    }
  }
});
test("the public test key needs the local-fork switch and a loopback endpoint", () => {
  refused(run({ OPENFOUR_LOCAL_DEV: "1", RPC_URL: "http://127.0.0.1:8580" }), "signer: RPC_URL is a loopback address: a real run uses the public testnet endpoint (a rehearsal sets OPENFOUR_LOCAL_FORK=1)");
  refused(run({ OPENFOUR_LOCAL_DEV: "1", RPC_URL: PUBLIC }), "signer: no signer: set OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
  refused(run({ OPENFOUR_LOCAL_FORK: "1", OPENFOUR_LOCAL_DEV: "1", RPC_URL: PUBLIC }), "signer: OPENFOUR_LOCAL_FORK=1 needs RPC_URL on 127.0.0.1 or localhost");
  const ok = run({ OPENFOUR_LOCAL_FORK: "1", OPENFOUR_LOCAL_DEV: "1", RPC_URL: "http://127.0.0.1:8580" });
  assert.equal(ok.code, 0, ok.out);
});
test("the preflight refuses another endpoint, a missing or different expected signer", () => {
  refused(run({ ...both, RPC_URL: "https://example.org" }, [...pile, ...expect]), "stopped: RPC_URL must be one of https://bsc-testnet-rpc.publicnode.com, https://bsc-testnet.publicnode.com for a real run");
  refused(run(both, pile), "stopped: give the expected signer: --expect-signer 0x...");
  refused(run(both, [...pile, "--expect-signer", "0x000000000000000000000000000000000000dEaD"]), `stopped: the keystore holds ${wallet.address}, not the expected 0x000000000000000000000000000000000000dEaD`);
});
test("the preflight refuses every kit input and our override by presence, empty included", () => {
  for (const name of REFUSED) {
    for (const v of ["x", ""]) refused(run({ ...both, [name]: v }, [...pile, ...expect]), `stopped: ${name} is set: unset it (it would change what is sent)`);
  }
});
test("a real run refuses OPENFOUR_OUT_DIR and a public test key", () => {
  refused(run({ ...both, OPENFOUR_OUT_DIR: "out/elsewhere" }, [...pile, ...expect]), "stopped: OPENFOUR_OUT_DIR is set: a real run keeps its records in out/");
  refused(run(both, [...pile, ...expect]), `stopped: ${wallet.address} is a public test key: not for a real run`);
});
