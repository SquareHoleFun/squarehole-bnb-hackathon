// signer-preload.js: the signer for our scripts and the kit's, loaded with `node -r ./scripts/signer-preload.js`.
//
// What it accepts (anything else stops the process with exit code 2 before any network call):
//   real run      OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE, both set, both readable files; RPC_URL not
//                 a loopback address.
//   local fork    OPENFOUR_LOCAL_FORK=1 and RPC_URL on 127.0.0.1 or localhost (lib/run.js then checks it is an anvil);
//                 then either the keystore pair, or
//                 OPENFOUR_LOCAL_DEV=1 for a publicly known test key (anvil's test mnemonic, index
//                 OPENFOUR_LOCAL_DEV_INDEX, default 4242).
// It refuses when DEPLOYER_PRIVATE_KEY (the key variable the kit reads) is present in the environment, when a .env
// file exists where the kit or this project would load one, when only one of the two keystore variables is set, and
// when the keystore does not decrypt (fixed text: "keystore: decryption failed"). Either keystore variable counts as
// set when present at all, empty included. lib/run.js refuses a public test key in a real run.
//
// Where the key travels: the keystore and password files are read as text; ethers decrypts them into a Wallet in
// this process. The Wallet is kept in this process's memory (a global symbol read by lib/run.js); our steps sign
// with it. scripts/kit.js, and only it, also copies the key as plain text into process.env.DEPLOYER_PRIVATE_KEY
// right before it starts the kit's fork-from-chain.js in the same process, because that script reads it only there
// (it builds `new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)`). A child process started afterwards
// would inherit that variable: fork-from-chain.js and its lib/ start none at the pinned kit commit (079a45e9; no
// child_process in them), and our scripts start none after the key exists (scripts/fetch-kit.js runs git at install
// time, in another process, before any key is read). The key is never printed or written by our code. It lives for
// the lifetime of the process; nothing erases it earlier.
//
// Also applied: the nonce is read past ethers' 250 ms request cache (sends in quick succession otherwise reuse a
// stale nonce); OPENFOUR_GAS_PRICE_WEI, when set (lib/run.js sets it from eth_gasPrice), prices every transaction;
// a transaction without a receipt after 45 seconds stops the process with a plain message; every JSON-RPC request
// (sends included) gives up after 45 seconds.
"use strict";

const fs = require("fs");
const path = require("path");
const { AbstractSigner, HDNodeWallet, JsonRpcProvider, Mnemonic, TransactionResponse, Wallet } = require("ethers");

const ROOT = path.resolve(__dirname, "..");
const KIT = path.join(ROOT, "node_modules", "openfour-kit", "developer");
const ENV_FILES = [path.join(ROOT, ".env"), path.join(KIT, ".env"), path.join(KIT, "fork-deploy", ".env"), path.join(KIT, "startup", ".env")];
const KEY_VARS = ["DEPLOYER_PRIVATE_KEY"];
const RECEIPT_TIMEOUT_MS = 45_000;

function refuse(message) {
  console.error(`signer: ${message}`);
  process.exit(2);
}

const local = process.env.OPENFOUR_LOCAL_FORK === "1";
const loopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(String(process.env.RPC_URL || ""));
if (local && !loopback) refuse("OPENFOUR_LOCAL_FORK=1 needs RPC_URL on 127.0.0.1 or localhost");
if (!local && loopback) refuse("RPC_URL is a loopback address: a real run uses the public testnet endpoint (a rehearsal sets OPENFOUR_LOCAL_FORK=1)");
for (const name of KEY_VARS) if (name in process.env) refuse(`${name} is set in the environment: unset it; the signer comes only from the keystore`);
for (const file of ENV_FILES) if (fs.existsSync(file)) refuse(`${path.relative(ROOT, file)} exists: remove it; no key is read from .env files`);

const keystore = process.env.OPENFOUR_KEYSTORE;
const passwordFile = process.env.OPENFOUR_KEYSTORE_PASSWORD_FILE;
let wallet;
if ("OPENFOUR_KEYSTORE" in process.env || "OPENFOUR_KEYSTORE_PASSWORD_FILE" in process.env) {
  if (!keystore || !passwordFile) refuse("set both OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
  for (const [name, file] of [["OPENFOUR_KEYSTORE", keystore], ["OPENFOUR_KEYSTORE_PASSWORD_FILE", passwordFile]]) {
    try {
      fs.accessSync(file, fs.constants.R_OK);
    } catch {
      refuse(`${name}: the file cannot be read`);
    }
  }
  try {
    wallet = Wallet.fromEncryptedJsonSync(fs.readFileSync(keystore, "utf8"), fs.readFileSync(passwordFile, "utf8").replace(/\r?\n$/, ""));
  } catch {
    refuse("keystore: decryption failed");
  }
} else if (local && process.env.OPENFOUR_LOCAL_DEV === "1") {
  const index = Number(process.env.OPENFOUR_LOCAL_DEV_INDEX || "4242");
  const phrase = "test test test test test test test test test test test junk"; // public: anvil and hardhat
  wallet = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), `m/44'/60'/0'/0/${index}`);
} else {
  refuse("no signer: set OPENFOUR_KEYSTORE and OPENFOUR_KEYSTORE_PASSWORD_FILE");
}
globalThis[Symbol.for("openfour.signer")] = wallet;
console.log(`signer: ${wallet.address}${local ? " (local fork)" : ""}`);

// Every JSON-RPC request in this process (the kit's provider too, its sends included) gives up after 45 seconds.
const connection = JsonRpcProvider.prototype._getConnection;
JsonRpcProvider.prototype._getConnection = function boundedConnection() {
  const request = connection.call(this);
  request.timeout = RECEIPT_TIMEOUT_MS;
  return request;
};

JsonRpcProvider.prototype.getTransactionCount = async function getTransactionCount(address, blockTag) {
  const addr = typeof address === "string" ? address : await address.getAddress();
  const tag = blockTag == null ? "latest" : typeof blockTag === "number" ? "0x" + blockTag.toString(16) : blockTag;
  return Number(BigInt(await this.send("eth_getTransactionCount", [addr, tag])));
};

const populate = AbstractSigner.prototype.populateTransaction;
AbstractSigner.prototype.populateTransaction = async function populateTransaction(tx) {
  if (!process.env.OPENFOUR_GAS_PRICE_WEI) return populate.call(this, tx);
  const price = BigInt(process.env.OPENFOUR_GAS_PRICE_WEI);
  const fixed = { type: 0, gasPrice: price, maxFeePerGas: null, maxPriorityFeePerGas: null };
  return { ...(await populate.call(this, { ...tx, ...fixed })), ...fixed };
};

const wait = TransactionResponse.prototype.wait;
TransactionResponse.prototype.wait = async function waitWithTimeout(confirms, timeout) {
  try {
    return await wait.call(this, confirms, timeout == null ? RECEIPT_TIMEOUT_MS : Math.min(Number(timeout) || RECEIPT_TIMEOUT_MS, RECEIPT_TIMEOUT_MS));
  } catch (e) {
    if (e && e.code === "TIMEOUT") {
      console.error(`no receipt for transaction ${this.hash} after 45 seconds: the run stops here. Look the transaction up, then rerun the same step.`);
      process.exit(3);
    }
    throw e;
  }
};
