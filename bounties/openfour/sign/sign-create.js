// The creation signer for a developer-owned OpenFour copy: lets a visitor create a launch from the browser with their
// own wallet. OpenFour's Core accepts `createToken(createArgs, signature)` only with a signature of its configured
// signer over keccak256(abi.encodePacked("createOpenFourToken", chainId, caller, keccak256(createArgs))), an EIP-191
// personal message; `caller` is the address that sends the transaction, a used requestId is refused
// (CoreErrRequestAlreadyUsed) and so is a request after its validTimestamp (CoreErrRequestExpired).
//
// `signCreate(config, wallet, request, now)` is pure apart from the signature: it checks the request against fixed
// bounds, builds createArgs ITSELF (it never takes bytes from the caller) for one of our two launch kinds, and signs.
//   preset  our Pile Bonding preset (module.trade.pile), fees per side 0 to 1000 bps, not both 0;
//   tax     OpenFour's Bonding Tax V1 with the founder tax (100%) going through ForwardVault into OUR PileTaxVault
//           template; buy tax 0 to 1000 bps, sell tax 100 to 1000 bps (TaxToken's own limits).
//   tax-rules  (SH-287, only when the service is configured for it) the same tax token, its founder tax going into
//           OUR RulesTaxVault template, which shares it by the creator's rules: creatorBps (paid to the requester),
//           pileBps (the holders' pile), burnBps (buys the token and sends it to the dead address); 0 to 10000 each,
//           summing to 10000. The rules sit in the signed createArgs, so they are final before the token exists.
// Fixed for both: supply 1,000,000,000, sale 800,000,000, createFee 0, presale 0, no anti-sniper, no partner, salt 0;
// quote from the allowlist; raise within the configured bounds; a fresh random requestId; valid for 10 minutes; the
// creator in the digest is the requester, so the signature works only for a transaction that the creator sends.
// Refusals are SignRefused errors with a fixed code and text (TEXTS below).
"use strict";

const crypto = require("crypto");
const { ethers } = require("ethers");

const VALID_SECONDS = 600;
// The host's cap on the HTTP body in bytes, enforced while reading it and BEFORE parsing (sign/README.md): the largest
// valid request is 724 bytes as JSON.stringify writes it (tax-rules; preset 673, tax 670; sign/test/sign.test.js
// measures them), so 2048 leaves a margin of 2.8.
const MAX_BODY_BYTES = 2048;
const SUPPLY = "1000000000";
const SALE = "800000000";
const FORWARD_VAULT_TYPE_ID = ethers.keccak256(ethers.toUtf8Bytes("SafuSkill.ForwardVault.v1"));

const TEXTS = {
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

/// A refusal: a fixed code and its fixed text, nothing from the request in it.
class SignRefused extends Error {
  constructor(code) {
    super(TEXTS[code]);
    this.code = code;
  }
}

const FIELDS = {
  preset: ["kind", "creator", "name", "symbol", "tokenUri", "quote", "raiseAmount", "buyFeeBps", "sellFeeBps"],
  tax: ["kind", "creator", "name", "symbol", "tokenUri", "quote", "raiseAmount", "taxBuyBps", "taxSellBps"],
  "tax-rules": ["kind", "creator", "name", "symbol", "tokenUri", "quote", "raiseAmount", "taxBuyBps", "taxSellBps", "creatorBps", "pileBps", "burnBps"],
};
const RULES_TUPLE = "tuple(address creator,uint16 creatorBps,uint16 pileBps,uint16 burnBps)";

function bps(v, lo, hi) {
  return Number.isInteger(v) && v >= lo && v <= hi;
}

function amount18(text) {
  if (typeof text !== "string" || !/^\d{1,6}(\.\d{1,18})?$/.test(text)) return null;
  return ethers.parseUnits(text, 18);
}

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/// The ONE answer to which rule sets are valid (the service, pile.js create-tax-rules and RulesTaxVault agree): three
/// whole numbers from 0 to 10000 summing to 10000. A part of 0 means that rule is not there (the shared splitter
/// takes 1 to 3 rules here, each above 0); with a pile part of 0 no pile is deployed. The creator part, when above 0,
/// is paid to the requester, so it always has a payee.
function validRules(creatorBps, pileBps, burnBps) {
  return bps(creatorBps, 0, 10000) && bps(pileBps, 0, 10000) && bps(burnBps, 0, 10000) && creatorBps + pileBps + burnBps === 10000;
}

/// The raise bounds, parsed once when the configuration is made: two decimal strings in the request's own format,
/// above zero, lower <= upper. Returns [min, max] in 18-decimal units; throws on anything else.
function raiseBounds(min, max) {
  const lo = amount18(min);
  const hi = amount18(max);
  if (lo === null || hi === null || lo <= 0n || lo > hi) throw new Error("raise bounds: two decimal strings, above zero, the lower first");
  return [lo, hi];
}

/// Checks the request and returns the normalised values. Throws SignRefused only (fixed texts).
function check(config, req) {
  try {
    return checkInner(config, req);
  } catch (e) {
    if (e instanceof SignRefused) throw e;
    throw new SignRefused("BAD_BODY"); // nothing native, and nothing of the request, leaves here
  }
}

function checkInner(config, req) {
  if (!req || typeof req !== "object" || Array.isArray(req)) throw new SignRefused("BAD_BODY");
  if (req.kind !== "preset" && req.kind !== "tax" && !(req.kind === "tax-rules" && config.kinds["tax-rules"])) throw new SignRefused("BAD_KIND");
  for (const k of Object.keys(req)) if (!FIELDS[req.kind].includes(k)) throw new SignRefused("UNKNOWN_FIELD");
  if (typeof req.creator !== "string" || !HEX_ADDRESS.test(req.creator)) throw new SignRefused("BAD_CREATOR");
  const creator = ethers.getAddress(req.creator.toLowerCase());
  if (creator === ethers.ZeroAddress) throw new SignRefused("BAD_CREATOR");
  if (typeof req.name !== "string" || !/^[A-Za-z0-9 .-]{1,32}$/.test(req.name) || req.name.trim() !== req.name) throw new SignRefused("BAD_NAME");
  if (typeof req.symbol !== "string" || !/^[A-Z0-9]{1,10}$/.test(req.symbol)) throw new SignRefused("BAD_SYMBOL");
  const uri = req.tokenUri === undefined ? "" : req.tokenUri;
  if (typeof uri !== "string" || uri.length > 200 || (uri !== "" && !/^(https|ipfs):\/\/[\x21-\x7e]+$/.test(uri))) throw new SignRefused("BAD_URI");
  const quote = typeof req.quote === "string" && HEX_ADDRESS.test(req.quote) ? ethers.getAddress(req.quote.toLowerCase()) : null;
  if (!quote || !config.quotes.map((q) => ethers.getAddress(q)).includes(quote)) throw new SignRefused("BAD_QUOTE");
  const raise = amount18(req.raiseAmount);
  if (raise === null || raise < config.raiseWei[0] || raise > config.raiseWei[1]) throw new SignRefused("BAD_RAISE");
  if (req.kind === "preset") {
    if (!bps(req.buyFeeBps, 0, 1000) || !bps(req.sellFeeBps, 0, 1000) || req.buyFeeBps + req.sellFeeBps === 0) throw new SignRefused("BAD_PRESET_FEES");
  } else if (!bps(req.taxBuyBps, 0, 1000) || !bps(req.taxSellBps, 100, 1000)) {
    throw new SignRefused("BAD_TAX_FEES");
  }
  if (req.kind === "tax-rules" && !validRules(req.creatorBps, req.pileBps, req.burnBps)) throw new SignRefused("BAD_RULES");
  return { ...req, creator, quote, tokenUri: uri, raiseAmount: req.raiseAmount };
}

function zeroValue(abiType) {
  if (abiType.endsWith("[]")) return [];
  if (abiType === "address") return ethers.ZeroAddress;
  if (abiType === "bool") return false;
  if (abiType === "bytes32") return ethers.ZeroHash;
  if (abiType === "bytes") return "0x";
  if (abiType === "string") return "";
  return 0n;
}

/// Encodes one module's parameters from its on-chain schema; our values first, then the schema's defaults.
function encodeModule(params, values) {
  if (!params.length) return "0x";
  const out = params.map((p) => {
    let raw = values[p.name];
    if (raw === undefined || raw === null || String(raw) === "") raw = p.defaultValue;
    if (raw === undefined || raw === null || String(raw) === "") {
      if (p.optional) return zeroValue(p.abiType);
      throw new Error(`the schema needs ${p.name}, which the signer does not set`);
    }
    const s = String(raw);
    if (p.abiType === "bool") return s === "true" || s === "1";
    if (["address", "string", "bytes32", "bytes"].includes(p.abiType)) return s;
    return Number(p.decimals) > 0 ? ethers.parseUnits(s, Number(p.decimals)) : BigInt(s);
  });
  return ethers.AbiCoder.defaultAbiCoder().encode([`(${params.map((p) => p.abiType).join(",")})`], [out]);
}

/// Builds createArgs for a checked request. `kind` selects our preset or the tax preset with our template.
function buildCreateArgs(config, r, requestId, validTimestamp) {
  const k = config.kinds[r.kind];
  // tax-rules: the template clone's own parameters are the creator's rules, the creator part paid to the requester.
  const initData = r.kind === "tax-rules"
    ? ethers.AbiCoder.defaultAbiCoder().encode([RULES_TUPLE], [[r.creator, r.creatorBps, r.pileBps, r.burnBps]])
    : "0x";
  const values = r.kind === "preset"
    ? { buyFeeBps: r.buyFeeBps, sellFeeBps: r.sellFeeBps }
    : {
        founder: r.creator, buyFeeRate: r.taxBuyBps, sellFeeRate: r.taxSellBps,
        rateFounder: 100, rateHolder: 0, rateBurn: 0, rateLiquidity: 0, minShare: 10000,
        taxVaultTypeId: FORWARD_VAULT_TYPE_ID,
        taxVaultInitParams: ethers.AbiCoder.defaultAbiCoder().encode(["(address,bytes)"], [[k.template, initData]]),
      };
  const s = k.schemas;
  // Each kind's values go only to the module they belong to: the preset's fees to Trade, the tax settings to Token.
  const trade = r.kind === "preset" ? values : {};
  const token = r.kind === "tax" || r.kind === "tax-rules" ? values : {};
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint256 requestId,uint256 presetId,uint256 validTimestamp,uint256 createFee,uint256 presaleQuote,bool antiSniperEnabled,address partner,tuple(string name,string symbol,string tokenUri,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,bytes32 tokenSalt,bytes tokenParams,bytes vaultParams,bytes curveParams,bytes tradeParams,bytes migrateParams,bytes customDataParams) initParams)"],
    [[requestId, BigInt(k.presetId), validTimestamp, 0n, 0n, false, ethers.ZeroAddress, [
      r.name, r.symbol, r.tokenUri, ethers.parseUnits(SUPPLY, 18), ethers.parseUnits(SALE, 18), ethers.parseUnits(r.raiseAmount, 18),
      r.quote, ethers.ZeroHash,
      encodeModule(s.token, token), encodeModule(s.vault, {}), encodeModule(s.curve, {}),
      encodeModule(s.trade, trade), encodeModule(s.migrate, {}), encodeModule(s.customData, {}),
    ]]],
  );
}

/// The schema fields the signer sets, which must exist (or a wrong preset would silently drop them).
const REQUIRED_FIELDS = {
  preset: { trade: ["buyFeeBps", "sellFeeBps"] },
  tax: { token: ["founder", "buyFeeRate", "sellFeeRate", "rateFounder", "rateHolder", "rateBurn", "rateLiquidity", "minShare", "taxVaultTypeId", "taxVaultInitParams"] },
  "tax-rules": { token: ["founder", "buyFeeRate", "sellFeeRate", "rateFounder", "rateHolder", "rateBurn", "rateLiquidity", "minShare", "taxVaultTypeId", "taxVaultInitParams"] },
};

/// Returns the first missing field as "kind.module.field", or null when every field the signer sets is present.
function missingSchemaField(kinds) {
  for (const [kind, modules] of Object.entries(REQUIRED_FIELDS)) {
    if (kind === "tax-rules" && !kinds[kind]) continue; // offered only when configured
    for (const [module, names] of Object.entries(modules)) {
      const list = (kinds[kind] && kinds[kind].schemas && kinds[kind].schemas[module]) || [];
      for (const n of names) if (!list.some((p) => p.name === n)) return `${kind}.${module}.${n}`;
    }
  }
  return null;
}

/// The digest Core checks for `caller` creating with `createArgs`.
function createDigest(chainId, caller, createArgs) {
  return ethers.keccak256(ethers.solidityPacked(["string", "uint256", "address", "bytes32"], ["createOpenFourToken", chainId, caller, ethers.keccak256(createArgs)]));
}

/// The signing function. `now` is the current time in seconds: the service passes its own clock (sign/service.js),
/// never a value from the request.
/// Returns { createArgs, signature, requestId, validUntil, kind, presetId, quote, creator }.
async function signCreate(config, wallet, request, now) {
  const r = check(config, request);
  let requestId = 0n;
  while (requestId === 0n) requestId = BigInt("0x" + crypto.randomBytes(32).toString("hex"));
  const validUntil = BigInt(now) + BigInt(VALID_SECONDS);
  const createArgs = buildCreateArgs(config, r, requestId, validUntil);
  const signature = await wallet.signMessage(ethers.getBytes(createDigest(BigInt(config.chainId), r.creator, createArgs)));
  return {
    createArgs, signature, requestId: requestId.toString(), validUntil: Number(validUntil),
    kind: r.kind, presetId: String(config.kinds[r.kind].presetId), quote: r.quote, creator: r.creator,
  };
}

module.exports = { MAX_BODY_BYTES, REQUIRED_FIELDS, validRules, SignRefused, TEXTS, VALID_SECONDS, buildCreateArgs, check, createDigest, missingSchemaField, raiseBounds, signCreate };
