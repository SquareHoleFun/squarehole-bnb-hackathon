// Makes the rehearsal's throwaway keystore (local forks only): a PUBLIC test key (anvil's test mnemonic, index 4250)
// encrypted with a random password made here, both written under the folder given (never committed). Reuses them
// when they exist. Prints the address only.
// usage: node scripts/make-rehearsal-keystore.js <folder> [mnemonic index, default 4250 | random]
// `random`: a fresh random key instead (no public derivation), e.g. the rehearsal's signing-service key.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { HDNodeWallet, Mnemonic, Wallet } = require("ethers");

const dir = path.resolve(process.argv[2] || ".cache/rehearsal-keystore");
const keystore = path.join(dir, "rehearsal.json");
const password = path.join(dir, "password");
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(keystore) || !fs.existsSync(password)) {
  const phrase = "test test test test test test test test test test test junk"; // public: anvil and hardhat
  const which = process.argv[3] || "4250";
  const wallet = which === "random" ? Wallet.createRandom() : HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), `m/44'/60'/0'/0/${Number(which)}`);
  const secret = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(password, secret + "\n", { mode: 0o600 });
  fs.writeFileSync(keystore, new Wallet(wallet.privateKey).encryptSync(secret), { mode: 0o600 });
}
console.log(JSON.parse(fs.readFileSync(keystore, "utf8")).address.replace(/^(0x)?/, "0x"));
