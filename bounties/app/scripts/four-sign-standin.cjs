// A stand-in for the site's creation signer, for the browser tests on a LOCAL fork only: the OpenFour entry's own
// signing function (bounties/openfour/sign/service.js) with the fork copy's signer, which on a local fork is anvil's
// PUBLIC test key (mnemonic index 4242, as the entry's scripts use with OPENFOUR_LOCAL_DEV=1). Refuses anything but a
// loopback endpoint. Loaded by the dev server (vite.config.ts) when PILE_SIGN_STANDIN names this file.
// Environment: FOUR_WORK (the folder holding bounties/openfour, installed), FOUR_RPC, FOUR_OUT (the run's out folder),
// FOUR_QUOTES (comma-separated allowed quote coins), FOUR_RULES_TEMPLATE (SH-287: our RulesTaxVault template on the
// fork; set, the stand-in offers the tax-rules kind as the service does with taxRules: true; empty, it does not).
'use strict';

const path = require('path');

const rpc = process.env.FOUR_RPC || '';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(rpc)) throw new Error('the signer stand-in serves a local fork only');
const openfour = path.join(process.env.FOUR_WORK || '', 'bounties/openfour');
const { ethers } = require(require.resolve('ethers', { paths: [openfour] }));
const { loadConfig } = require(path.join(openfour, 'sign/service'));
const { signCreate } = require(path.join(openfour, 'sign/sign-create'));
const fs = require('fs');

// The entry's production factory takes its key from a keystore and the real run's records only; on a local fork the
// stand-in builds the same configuration with the entry's own loadConfig and signs with the entry's own signCreate,
// as its fork test does (test/SignCreate.fork.test.js).
let service;
async function sign(body) {
  if (!service) {
    const phrase = 'test test test test test test test test test test test junk'; // public: anvil and hardhat
    const key = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(phrase), "m/44'/60'/0'/0/4242");
    const provider = new ethers.JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
    const read = (f) => JSON.parse(fs.readFileSync(path.join(process.env.FOUR_OUT || '', f), 'utf8'));
    const fork = read('fork-deployment.json');
    const config = await loadConfig({
      provider,
      addresses: fork.addresses,
      presetId: BigInt(read('preset-registration.json').presetId),
      taxPresetId: BigInt(fork.presets.bondingTaxV1),
      template: read('tax-template.json').template,
      quotes: (process.env.FOUR_QUOTES || '').split(',').filter(Boolean),
      raiseMin: '0.1',
      raiseMax: '2',
      ...(process.env.FOUR_RULES_TEMPLATE ? { rulesTemplate: process.env.FOUR_RULES_TEMPLATE } : {}),
    });
    const core = new ethers.Contract(fork.addresses.core, ['function signer() view returns (address)'], provider);
    if ((await core.signer()) !== key.address) throw new Error("Core's signer is not the fork's development key");
    service = { sign: (b) => signCreate(config, key, b, Math.floor(Date.now() / 1000)) };
  }
  return service.sign(body);
}

module.exports = { sign };
