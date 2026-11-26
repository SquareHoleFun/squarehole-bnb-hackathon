// The signing function without a chain: every refusal with its fixed text, every bound at and past its edge, and
// what is signed (the digest Core checks, computed here independently; the createArgs it builds itself); the startup
// checks that need no chain (the schema fields, the preset tuple against the recorded transaction); the body size.
// node --test sign/test/sign.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { ethers } = require("ethers");
const { MAX_BODY_BYTES, SignRefused, buildCreateArgs, check, missingSchemaField, raiseBounds, signCreate, validRules } = require("../sign-create");
const { PRESET_FIELDS, presetMismatch } = require("../service");

// The refusal texts, written out here (not read from the module), so a changed text fails a test.
const TEXT = {
  BAD_BODY: "the request must be a JSON object",
  UNKNOWN_FIELD: "the request has a field that is not allowed",
  BAD_KIND: "kind must be preset or tax, or tax-rules where it is offered",
  BAD_CREATOR: "creator must be a wallet address",
  BAD_NAME: "name: 1 to 32 letters, digits, spaces, dots or dashes",
  BAD_SYMBOL: "symbol: 1 to 10 capital letters or digits",
  BAD_URI: "tokenUri: empty, or https:// or ipfs:// and at most 200 characters",
  BAD_QUOTE: "quote is not one of the allowed coins",
  BAD_RAISE: "raiseAmount: a decimal number within the allowed range",
  BAD_PRESET_FEES: "buyFeeBps and sellFeeBps: whole numbers from 0 to 1000, not both 0",
  BAD_TAX_FEES: "taxBuyBps: a whole number from 0 to 1000; taxSellBps: a whole number from 100 to 1000",
  BAD_RULES: "creatorBps, pileBps and burnBps: whole numbers from 0 to 10000 that sum to 10000",
};

const WBNB = "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd";
const TETH = "0x860822580d4eb2529de0c74c3e2b1d6d7c183302";
const TEMPLATE = "0x1111111111111111111111111111111111111111";
const p = (name, abiType) => ({ name, abiType, decimals: 0, optional: false, defaultValue: "" });
const EMPTY = { token: [], vault: [], curve: [], trade: [], migrate: [], customData: [] };
const CONFIG = {
  chainId: "97", quotes: [WBNB, TETH], raiseWei: raiseBounds("0.1", "2"),
  kinds: {
    preset: { presetId: "1778027700001", schemas: { ...EMPTY, trade: [p("buyFeeBps", "uint16"), p("sellFeeBps", "uint16")] } },
    tax: {
      presetId: "1778027615723", template: TEMPLATE,
      schemas: { ...EMPTY, token: [p("founder", "address"), p("buyFeeRate", "uint256"), p("sellFeeRate", "uint256"), p("rateFounder", "uint256"),
        p("rateHolder", "uint256"), p("rateBurn", "uint256"), p("rateLiquidity", "uint256"), p("minShare", "uint256"),
        p("taxVaultTypeId", "bytes32"), p("taxVaultInitParams", "bytes")] },
    },
  },
};
const wallet = ethers.Wallet.createRandom();
const creator = ethers.Wallet.createRandom().address;
const NOW = 1_800_000_000;
const PRESET = { kind: "preset", creator, name: "Pile Demo", symbol: "PILE", quote: TETH, raiseAmount: "1", buyFeeBps: 100, sellFeeBps: 200 };
const TAX = { kind: "tax", creator, name: "Pile Tax", symbol: "PTAX", quote: WBNB, raiseAmount: "0.3", taxBuyBps: 250, taxSellBps: 700 };
// SH-287: the tax-rules kind, offered only when the configuration has it.
const RULES_TEMPLATE = "0x2222222222222222222222222222222222222222";
const CONFIG_RULES = { ...CONFIG, kinds: { ...CONFIG.kinds, "tax-rules": { ...CONFIG.kinds.tax, template: RULES_TEMPLATE } } };
const RULES = { ...TAX, kind: "tax-rules", creatorBps: 2000, pileBps: 5000, burnBps: 3000 };
const ARGS = "tuple(uint256 requestId,uint256 presetId,uint256 validTimestamp,uint256 createFee,uint256 presaleQuote,bool antiSniperEnabled,address partner,tuple(string name,string symbol,string tokenUri,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,bytes32 tokenSalt,bytes tokenParams,bytes vaultParams,bytes curveParams,bytes tradeParams,bytes migrateParams,bytes customDataParams) initParams)";
const coder = ethers.AbiCoder.defaultAbiCoder();

// Each refusal through the signing entry point itself, and through check(): same code, the literal text.
async function refusedBy(req, code, config = CONFIG) {
  assert.throws(() => check(config, req), (e) => e instanceof SignRefused && e.code === code && e.message === TEXT[code]);
  await assert.rejects(signCreate(config, wallet, req, NOW), (e) => e instanceof SignRefused && e.code === code && e.message === TEXT[code]);
}
const pending = [];
const refused = (req, code, config) => pending.push(refusedBy(req, code, config));
const settle = async () => {
  await Promise.all(pending.splice(0));
};

// Core's digest, computed here without the module: keccak256("createOpenFourToken" ++ uint256 chainId ++ address
// caller ++ keccak256(createArgs)), signed as an EIP-191 personal message.
function coreDigest(chainId, caller, createArgs) {
  return ethers.keccak256(ethers.concat([
    ethers.toUtf8Bytes("createOpenFourToken"), ethers.zeroPadValue(ethers.toBeHex(chainId), 32), ethers.getAddress(caller), ethers.keccak256(createArgs),
  ]));
}

test("a preset request: Core's digest signed by the key, for this creator only; createArgs built from fixed values", async () => {
  const a = await signCreate(CONFIG, wallet, PRESET, NOW);
  assert.equal(ethers.verifyMessage(ethers.getBytes(coreDigest(97n, creator, a.createArgs)), a.signature), wallet.address);
  assert.notEqual(ethers.verifyMessage(ethers.getBytes(coreDigest(97n, wallet.address, a.createArgs)), a.signature), wallet.address);
  assert.notEqual(ethers.verifyMessage(ethers.getBytes(coreDigest(56n, creator, a.createArgs)), a.signature), wallet.address);
  const [d] = coder.decode([ARGS], a.createArgs);
  assert.equal(d.requestId.toString(), a.requestId);
  assert.equal(d.presetId, 1778027700001n);
  assert.equal(d.validTimestamp, BigInt(NOW + 600));
  assert.equal(a.validUntil, NOW + 600);
  assert.deepEqual([d.createFee, d.presaleQuote, d.antiSniperEnabled, d.partner], [0n, 0n, false, ethers.ZeroAddress]);
  const i = d.initParams;
  assert.deepEqual([i.name, i.symbol, i.tokenUri, i.quoteAsset, i.tokenSalt], ["Pile Demo", "PILE", "", ethers.getAddress(TETH), ethers.ZeroHash]);
  assert.deepEqual([i.maxSupply, i.saleAmount, i.raiseAmount], [ethers.parseUnits("1000000000", 18), ethers.parseUnits("800000000", 18), ethers.parseUnits("1", 18)]);
  assert.deepEqual(Array.from(coder.decode(["(uint16,uint16)"], i.tradeParams)[0]), [100n, 200n]);
  assert.equal(i.tokenParams, "0x");
});

test("a tax request: founder tax 100% through ForwardVault into our template, the creator as founder", async () => {
  const a = await signCreate(CONFIG, wallet, TAX, NOW);
  const [d] = coder.decode([ARGS], a.createArgs);
  assert.equal(d.presetId, 1778027615723n);
  const [t] = coder.decode(["(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes)"], d.initParams.tokenParams);
  assert.deepEqual(Array.from(t.slice(0, 8)), [ethers.getAddress(creator), 250n, 700n, 100n, 0n, 0n, 0n, 10000n]); // buy 250, sell 700: not swapped
  assert.equal(t[8], ethers.keccak256(ethers.toUtf8Bytes("SafuSkill.ForwardVault.v1")));
  assert.deepEqual(Array.from(coder.decode(["(address,bytes)"], t[9])[0]), [ethers.getAddress(TEMPLATE), "0x"]);
});

test("every request gets a fresh request id: distinct, nonzero, spread over 256 bits", async () => {
  const ids = [];
  for (let n = 0; n < 20; n++) ids.push(BigInt((await signCreate(CONFIG, wallet, PRESET, NOW)).requestId));
  assert.equal(new Set(ids).size, 20);
  assert.ok(ids.every((i) => i > 0n && i < 2n ** 256n));
  assert.ok(ids.some((i) => i >= 2n ** 255n), "a counter or a small range would stay below 2^255"); // fails by chance with probability 2^-20
});

test("refusals, each with its literal text, from check() and from signCreate()", async () => {
  refused(null, "BAD_BODY");
  refused([PRESET], "BAD_BODY");
  refused({ ...PRESET, kind: "flap" }, "BAD_KIND");
  refused({ ...PRESET, createArgs: "0x00" }, "UNKNOWN_FIELD");
  refused({ ...PRESET, taxBuyBps: 300 }, "UNKNOWN_FIELD");
  refused({ ...TAX, buyFeeBps: 100 }, "UNKNOWN_FIELD");
  refused({ ...PRESET, creator: "0x123" }, "BAD_CREATOR");
  refused({ ...PRESET, creator: ethers.ZeroAddress }, "BAD_CREATOR");
  refused({ ...PRESET, name: "" }, "BAD_NAME");
  refused({ ...PRESET, name: "x".repeat(33) }, "BAD_NAME");
  refused({ ...PRESET, name: "<script>" }, "BAD_NAME");
  refused({ ...PRESET, name: " padded" }, "BAD_NAME");
  refused({ ...PRESET, symbol: "pile" }, "BAD_SYMBOL");
  refused({ ...PRESET, symbol: "ABCDEFGHIJK" }, "BAD_SYMBOL");
  refused({ ...PRESET, tokenUri: "javascript:alert(1)" }, "BAD_URI");
  refused({ ...PRESET, tokenUri: "https://" + "a".repeat(200) }, "BAD_URI");
  refused({ ...PRESET, quote: "0x2222222222222222222222222222222222222222" }, "BAD_QUOTE");
  refused({ ...PRESET, quote: "WBNB" }, "BAD_QUOTE");
  refused({ ...PRESET, raiseAmount: 1 }, "BAD_RAISE");
  refused({ ...PRESET, raiseAmount: "1e18" }, "BAD_RAISE");
  refused({ ...PRESET, raiseAmount: "1.0000000000000000001" }, "BAD_RAISE"); // 19 decimals
  await settle();
});

test("no refusal repeats anything of the request, and nothing native escapes", async () => {
  const secret = "SECRET-0123456789abcdef";
  const bodies = [
    { ...PRESET, [secret]: 1 },
    { ...PRESET, creator: secret },
    { ...PRESET, creator: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" }, // a valid address without 0x: refused, not parsed
    { ...PRESET, quote: secret },
    { ...PRESET, name: secret + "<" },
    { ...PRESET, raiseAmount: secret },
    { ...PRESET, buyFeeBps: secret },
    { ...PRESET, get symbol() { throw new Error(secret); } }, // a getter that throws: no native error leaves
  ];
  for (const b of bodies) {
    let err;
    try {
      check(CONFIG, b);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof SignRefused, `refused: ${err && err.message}`);
    assert.ok(Object.values(TEXT).includes(err.message), err.message);
    assert.ok(!err.message.includes(secret) && !err.message.includes("abcdefabcdef"));
    await assert.rejects(signCreate(CONFIG, wallet, b, NOW), (e) => e instanceof SignRefused && e.message === err.message);
  }
  assert.equal(check(CONFIG, { ...PRESET, creator: creator.toLowerCase() }).creator, creator);
});

test("bounds: at the edge accepted, past it refused", async () => {
  assert.doesNotThrow(() => check(CONFIG, { ...PRESET, name: "N".repeat(32), symbol: "S".repeat(10) }));
  assert.doesNotThrow(() => check(CONFIG, { ...PRESET, tokenUri: "https://" + "a".repeat(192) })); // 200 characters
  refused({ ...PRESET, tokenUri: "https://" + "a".repeat(193) }, "BAD_URI");
  assert.equal(check(CONFIG, { ...PRESET, tokenUri: "ipfs://bafy" }).tokenUri, "ipfs://bafy");
  refused({ ...PRESET, tokenUri: "HTTPS://upper" }, "BAD_URI");
  assert.doesNotThrow(() => check(CONFIG, { ...PRESET, raiseAmount: "0.1" }));
  refused({ ...PRESET, raiseAmount: "0.099999999999999999" }, "BAD_RAISE");
  assert.doesNotThrow(() => check(CONFIG, { ...PRESET, raiseAmount: "2" }));
  refused({ ...PRESET, raiseAmount: "2.000000000000000001" }, "BAD_RAISE");
  assert.doesNotThrow(() => check(CONFIG, { ...PRESET, buyFeeBps: 1000, sellFeeBps: 0 }));
  assert.doesNotThrow(() => check(CONFIG, { ...PRESET, buyFeeBps: 0, sellFeeBps: 1000 }));
  refused({ ...PRESET, buyFeeBps: 1001 }, "BAD_PRESET_FEES");
  refused({ ...PRESET, sellFeeBps: 1001 }, "BAD_PRESET_FEES");
  refused({ ...PRESET, buyFeeBps: 0, sellFeeBps: 0 }, "BAD_PRESET_FEES");
  refused({ ...PRESET, buyFeeBps: 1.5 }, "BAD_PRESET_FEES");
  refused({ ...PRESET, buyFeeBps: "100" }, "BAD_PRESET_FEES");
  assert.doesNotThrow(() => check(CONFIG, { ...TAX, taxBuyBps: 0, taxSellBps: 100 }));
  assert.doesNotThrow(() => check(CONFIG, { ...TAX, taxBuyBps: 1000, taxSellBps: 1000 }));
  refused({ ...TAX, taxSellBps: 99 }, "BAD_TAX_FEES");
  refused({ ...TAX, taxSellBps: 1001 }, "BAD_TAX_FEES");
  refused({ ...TAX, taxBuyBps: 1001 }, "BAD_TAX_FEES");
  refused({ ...TAX, taxBuyBps: -1 }, "BAD_TAX_FEES");
  await settle();
});

test("each kind's values reach only their own module: preset fees only Trade, tax settings only Token", async () => {
  const q = (name, abiType, defaultValue) => ({ name, abiType, decimals: 0, optional: true, defaultValue });
  const config = {
    ...CONFIG,
    kinds: {
      preset: { ...CONFIG.kinds.preset, schemas: { ...CONFIG.kinds.preset.schemas, token: [q("buyFeeBps", "uint16", "7")], vault: [q("sellFeeBps", "uint16", "")] } },
      tax: { ...CONFIG.kinds.tax, schemas: { ...CONFIG.kinds.tax.schemas, trade: [q("founder", "address", ""), q("buyFeeRate", "uint256", "")] } },
    },
  };
  const [d] = coder.decode([ARGS], (await signCreate(config, wallet, PRESET, NOW)).createArgs);
  assert.equal(coder.decode(["(uint16)"], d.initParams.tokenParams)[0][0], 7n); // its default, not the trade fee 100
  assert.equal(coder.decode(["(uint16)"], d.initParams.vaultParams)[0][0], 0n); // not the trade fee 200
  const [t] = coder.decode([ARGS], (await signCreate(config, wallet, TAX, NOW)).createArgs);
  assert.deepEqual(Array.from(coder.decode(["(address,uint256)"], t.initParams.tradeParams)[0]), [ethers.ZeroAddress, 0n]);
});

test("startup: every schema field the signer sets must exist (minShare included)", () => {
  assert.equal(missingSchemaField(CONFIG.kinds), null);
  const without = (kind, module, name) => ({
    ...CONFIG.kinds,
    [kind]: { ...CONFIG.kinds[kind], schemas: { ...CONFIG.kinds[kind].schemas, [module]: CONFIG.kinds[kind].schemas[module].filter((x) => x.name !== name) } },
  });
  assert.equal(missingSchemaField(without("tax", "token", "minShare")), "tax.token.minShare");
  assert.equal(missingSchemaField(without("tax", "token", "taxVaultInitParams")), "tax.token.taxVaultInitParams");
  assert.equal(missingSchemaField(without("preset", "trade", "sellFeeBps")), "preset.trade.sellFeeBps");
});

test("startup: the Registry's preset must equal, in all 15 fields, the tuple the recorded upsertPreset wrote", () => {
  const TUPLE = "tuple(uint256 id, string name, string description, string version, bool active, bool createEnabled, address validator, bytes32 tokenModuleId, bytes32 vaultModuleId, bytes32 curveModuleId, bytes32 tradeModuleId, bytes32 migrateModuleId, bytes32 tokenImplId, bytes32 customDataId, address author)";
  const iface = new ethers.Interface([`function upsertPreset(${TUPLE} preset)`, "function upsertModule(bytes32 moduleKey, address implementation, uint8 kind, tuple(bytes32 moduleId, string version, string name, string description, address author, uint16 feeShareBps) metadata, bool active)"]);
  const h = (n) => ethers.zeroPadValue(ethers.toBeHex(n), 32);
  const written = {
    id: 1778027700001n, name: "Pile Bonding", description: "d", version: "1.0.0", active: true, createEnabled: true,
    validator: ethers.getAddress("0x" + "11".repeat(20)), tokenModuleId: h(1), vaultModuleId: h(2), curveModuleId: h(3), tradeModuleId: h(4),
    migrateModuleId: h(5), tokenImplId: h(6), customDataId: h(7), author: ethers.getAddress("0x" + "22".repeat(20)),
  };
  const data = iface.encodeFunctionData("upsertPreset", [written]);
  assert.equal(PRESET_FIELDS.length, 15);
  assert.equal(presetMismatch(data, 1778027700001n, written), null);
  assert.equal(presetMismatch(data, 1778027700002n, written), "id");
  const other = { id: 1778027700002n, name: "x", description: "x", version: "9", active: false, createEnabled: false, validator: ethers.ZeroAddress,
    tokenModuleId: h(9), vaultModuleId: h(9), curveModuleId: h(9), tradeModuleId: h(9), migrateModuleId: h(9), tokenImplId: h(9), customDataId: h(9), author: ethers.ZeroAddress };
  for (const f of PRESET_FIELDS) assert.equal(presetMismatch(data, 1778027700001n, { ...written, [f]: other[f] }), f, f);
  const moduleCall = iface.encodeFunctionData("upsertModule", [h(4), written.validator, 3, [h(4), "1", "m", "d", written.author, 0], true]);
  assert.equal(presetMismatch(moduleCall, 1778027700001n, written), "not an upsertPreset call");
  assert.equal(presetMismatch("0x", 1778027700001n, written), "not an upsertPreset call");
  const closed = { ...written, createEnabled: false };
  assert.equal(presetMismatch(iface.encodeFunctionData("upsertPreset", [closed]), 1778027700001n, closed), "not open");
});

test("tax-rules: the creator's rules go into the template clone's parameters, the creator part to the requester", async () => {
  const a = await signCreate(CONFIG_RULES, wallet, RULES, NOW);
  assert.equal(ethers.verifyMessage(ethers.getBytes(coreDigest(97n, creator, a.createArgs)), a.signature), wallet.address);
  const [d] = coder.decode([ARGS], a.createArgs);
  assert.equal(d.presetId, 1778027615723n);
  assert.equal(a.kind, "tax-rules");
  const [t] = coder.decode(["(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes)"], d.initParams.tokenParams);
  assert.deepEqual(Array.from(t.slice(0, 8)), [ethers.getAddress(creator), 250n, 700n, 100n, 0n, 0n, 0n, 10000n]);
  assert.equal(t[8], ethers.keccak256(ethers.toUtf8Bytes("SafuSkill.ForwardVault.v1")));
  const [tpl, initData] = coder.decode(["(address,bytes)"], t[9])[0];
  assert.equal(tpl, ethers.getAddress(RULES_TEMPLATE));
  const [r] = coder.decode(["tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)"], initData);
  assert.deepEqual(Array.from(r), [ethers.getAddress(creator), 2000n, 5000n, 3000n]);
  for (const x of [{ creatorBps: 10000, pileBps: 0, burnBps: 0 }, { creatorBps: 0, pileBps: 0, burnBps: 10000 }, { creatorBps: 1, pileBps: 9999, burnBps: 0 }]) {
    assert.doesNotThrow(() => check(CONFIG_RULES, { ...RULES, ...x }));
  }
});

test("tax-rules: refused when not offered, when a part is wrong, and its fields on the other kinds", async () => {
  refused(RULES, "BAD_KIND"); // CONFIG has no tax-rules kind
  for (const x of [{ burnBps: 2999 }, { burnBps: 3001 }, { creatorBps: -1, burnBps: 5001 }, { creatorBps: 1.5 }, { pileBps: "5000" }, { creatorBps: 10001, pileBps: 0, burnBps: -1 }]) {
    refused({ ...RULES, ...x }, "BAD_RULES", CONFIG_RULES);
  }
  const { burnBps, ...noBurn } = RULES;
  refused(noBurn, "BAD_RULES", CONFIG_RULES);
  refused({ ...TAX, creatorBps: 10000, pileBps: 0, burnBps: 0 }, "UNKNOWN_FIELD", CONFIG_RULES);
  refused({ ...RULES, buyFeeBps: 100 }, "UNKNOWN_FIELD", CONFIG_RULES);
  await settle();
});

test("one answer for the valid rule sets: validRules (the service's check and pile.js create-tax-rules use it)", () => {
  const valid = [[10000, 0, 0], [0, 0, 10000], [0, 10000, 0], [4000, 0, 6000], [2000, 5000, 3000], [1, 9999, 0]];
  const invalid = [[0, 0, 0], [5000, 5000, 1], [10000, 1, 0], [-1, 10001, 0], [1.5, 9998.5, 0], ["10000", 0, 0], [10001, 0, -1]];
  for (const [c, p, b] of valid) {
    assert.equal(validRules(c, p, b), true, `${c}/${p}/${b}`);
    assert.doesNotThrow(() => check(CONFIG_RULES, { ...RULES, creatorBps: c, pileBps: p, burnBps: b }));
  }
  for (const [c, p, b] of invalid) {
    assert.equal(validRules(c, p, b), false, `${c}/${p}/${b}`);
    assert.throws(() => check(CONFIG_RULES, { ...RULES, creatorBps: c, pileBps: p, burnBps: b }), (e) => e.code === "BAD_RULES");
  }
});

test("tax-rules leaves the two other kinds byte for byte as they were", () => {
  for (const req of [TAX, PRESET]) {
    const r = check(CONFIG, req);
    assert.equal(buildCreateArgs(CONFIG_RULES, r, 7n, 9n), buildCreateArgs(CONFIG, r, 7n, 9n));
  }
  const [d] = coder.decode([ARGS], buildCreateArgs(CONFIG, check(CONFIG, TAX), 7n, 9n));
  const [t] = coder.decode(["(address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bytes32,bytes)"], d.initParams.tokenParams);
  assert.deepEqual(Array.from(coder.decode(["(address,bytes)"], t[9])[0]), [ethers.getAddress(TEMPLATE), "0x"]);
});

test("the raise bounds: parsed once at configuration, above zero, the lower first", () => {
  assert.deepEqual(raiseBounds("0.1", "2"), [10n ** 17n, 2n * 10n ** 18n]);
  assert.deepEqual(raiseBounds("1", "1"), [10n ** 18n, 10n ** 18n]);
  for (const [lo, hi] of [["2", "0.1"], ["0", "1"], ["0.1", "2e0"], ["0.1", 2], [undefined, "2"], ["0.1", "1.0000000000000000001"]]) {
    assert.throws(() => raiseBounds(lo, hi), /raise bounds/, `${lo} ${hi}`);
  }
  const narrow = { ...CONFIG, raiseWei: raiseBounds("0.5", "1") };
  assert.doesNotThrow(() => check(narrow, { ...PRESET, raiseAmount: "0.5" }));
  assert.throws(() => check(narrow, { ...PRESET, raiseAmount: "0.4" }), (e) => e.code === "BAD_RAISE");
});

test("the body cap: the largest valid requests, as JSON.stringify writes them, are accepted and fit well inside MAX_BODY_BYTES", () => {
  const wide = { ...CONFIG_RULES, raiseWei: raiseBounds("0.1", "999999.999999999999999999") };
  // The longest encoding: ipfs:// (7 characters) leaves 193 for the rest, each a quote mark that JSON escapes to two bytes.
  const common = { creator, name: "N".repeat(32), symbol: "S".repeat(10), tokenUri: "ipfs://" + "\"".repeat(193), quote: TETH, raiseAmount: "999999." + "9".repeat(18) };
  const largest = [
    { kind: "preset", ...common, buyFeeBps: 1000, sellFeeBps: 1000 }, { kind: "tax", ...common, taxBuyBps: 1000, taxSellBps: 1000 },
    { kind: "tax-rules", ...common, taxBuyBps: 1000, taxSellBps: 1000, creatorBps: 3334, pileBps: 3333, burnBps: 3333 },
  ];
  const sizes = largest.map((b) => {
    assert.doesNotThrow(() => check(wide, JSON.parse(JSON.stringify(b))));
    return Buffer.byteLength(JSON.stringify(b));
  });
  assert.deepEqual(sizes, [673, 670, 724]); // JSON.stringify sizes in bytes: preset, tax, tax-rules
  assert.equal(MAX_BODY_BYTES, 2048);
  assert.ok(Math.max(...sizes) * 2.5 <= MAX_BODY_BYTES); // 2048 is 2.8 times the largest (tax-rules)
});
