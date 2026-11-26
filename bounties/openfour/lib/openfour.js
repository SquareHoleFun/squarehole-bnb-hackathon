// Shared helpers for the tests and scripts: the OpenFour ABIs we call (from the kit's own scripts), create-argument
// encoding from the on-chain schemas (as developer/fork-deploy/create-test-preset.js does it), and the signature
// OpenFour's Core expects from its signer.
"use strict";

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PARAM_TUPLE =
  "tuple(string name,string abiType,uint8 decimals,bool optional,string title,string defaultValue,string hint,string minValue,string maxValue)";
const MODULE_SCHEMA = `tuple(string kind,uint8 version,${PARAM_TUPLE}[] params)`;
const PRESET_TUPLE =
  "tuple(uint256 id, string name, string description, string version, bool active, bool createEnabled, address validator, bytes32 tokenModuleId, bytes32 vaultModuleId, bytes32 curveModuleId, bytes32 tradeModuleId, bytes32 migrateModuleId, bytes32 tokenImplId, bytes32 customDataId, address author)";
const METADATA_TUPLE =
  "tuple(bytes32 moduleId, string version, string name, string description, address author, uint16 feeShareBps)";
const FEE_CFG_TUPLE =
  "tuple(uint16 protocolFeeBps, uint16 developerFeePoolBps, uint16 maxProtocolDevFeeBps, uint16 maxTaxBps, uint8 maxTaxTiers, bool active, uint256 partnerProtocolShareBps)";

const ABI = {
  registry: [
    "function owner() view returns (address)",
    `function getPreset(uint256 presetId) view returns (${PRESET_TUPLE})`,
    "function getModuleImplementation(bytes32 moduleKey) view returns (address)",
    "function getModuleBeacon(bytes32 moduleKey) view returns (address)",
    `function upsertModule(bytes32 moduleKey, address implementation, uint8 kind, ${METADATA_TUPLE} metadata, bool active)`,
    `function upsertPreset(${PRESET_TUPLE} preset)`,
  ],
  feeRouter: [
    "function presetFeeConfig(uint256 presetId) view returns (uint16 protocolFeeBps, uint16 developerFeePoolBps, uint16 maxProtocolDevFeeBps, uint16 maxTaxBps, uint8 maxTaxTiers, bool active, uint256 partnerProtocolShareBps)",
    `function setPresetFeeConfig(uint256 presetId, ${FEE_CFG_TUPLE} cfg)`,
    "function feeConfig() view returns (uint16 protocolFeeBps, uint16 developerFeePoolBps, uint16 maxProtocolDevFeeBps, uint16 maxTaxBps, uint8 maxTaxTiers, uint256 partnerProtocolShareBps, uint256 placeholder2, uint256 placeholder3, uint256 placeholder4, uint256 placeholder5, uint256 placeholder6)",
  ],
  core: [
    "function signer() view returns (address)",
    "function createToken(bytes createArgs, bytes signature) payable returns (address)",
    "function buy(address token,uint256 amount,uint256 maxQuotePayAmount,uint256 options,bytes proof) payable",
    "function buyByBudget(address token,uint256 maxPayAmount,uint256 minAmountOut,uint256 options,bytes proof) payable",
    "function sell(address token,uint256 amount,uint256 minQuoteRecvAmount,uint256 options,bytes proof)",
    "function tokens(address) view returns (uint32 version,address creator,uint256 presetId,address token,string name,string symbol,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,address vault,address curveModule,address tradeModule,address migrateModule,address tokenModule,address customData,uint256 createBlock,bool exists,bool paused,bool antiSniperEnabled)",
    "event TokenCreated(uint256 requestId, uint256 indexed presetId, address indexed creator, address indexed token, string name, string symbol, uint256 maxSupply, uint256 saleAmount, uint256 raiseAmount, uint256 initialPrice, address quoteAsset, address vault, address curveModule, address tradeModule, address migrateModule, address customData, address tokenModule, string tokenMetaUri, uint256 flags, bytes encodedTags)",
  ],
  tools: [
    `function getPresetEncodeSchemas(uint256) view returns (${MODULE_SCHEMA},${MODULE_SCHEMA},${MODULE_SCHEMA},${MODULE_SCHEMA},${MODULE_SCHEMA},${MODULE_SCHEMA})`,
    "function estimateBuy(address token,address trader,uint256 amount,uint256 options,bytes proof) returns (tuple(uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))",
    "function estimateBuyByBudget(address token,address trader,uint256 maxQuotePayAmount,uint256 options,bytes proof) returns (tuple(uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))",
    "function estimateSell(address token,address trader,uint256 amount,uint256 options,bytes proof) returns (tuple(uint256 curveQuote, uint256 totalFee, uint256 userPays, uint256 userReceives, uint256 tokenAmount, uint256 executionPrice))",
  ],
  vault: [
    "function remainingForSale() view returns (uint256)",
    "function totalRaised() view returns (uint256)",
    "function phase() view returns (uint8)",
    "function isSoldOut() view returns (bool)",
  ],
  erc20: [
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function transfer(address,uint256) returns (bool)",
    "function decimals() view returns (uint8)",
  ],
};

const PHASE = ["Created", "Trading", "MigratePending", "Migrated", "Terminal", "SoldOut"];
const TRADE_MODULE_KEY_SOURCE = "module.trade.pile";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const coder = ethers.AbiCoder.defaultAbiCoder();

function loadFork(file) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new Error(`fork deployment not found: ${p}. Bring the copy up first (npm run fork).`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function mapSchema(s) {
  return Array.from(s.params).map((p) => ({
    name: p.name,
    abiType: p.abiType,
    decimals: Number(p.decimals || 0),
    optional: Boolean(p.optional),
    defaultValue: p.defaultValue || "",
  }));
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

function resolveParam(desc, form) {
  let raw = form[desc.name];
  if (raw == null || String(raw).trim() === "") {
    if (desc.defaultValue != null && String(desc.defaultValue).trim() !== "") raw = desc.defaultValue;
    else if (desc.optional) return zeroValue(desc.abiType);
    else throw new Error(`missing ${desc.name}`);
  }
  const str = String(raw).trim();
  if (desc.abiType === "bool") return str === "true" || str === "1";
  if (["address", "string", "bytes32", "bytes"].includes(desc.abiType)) return str;
  return desc.decimals > 0 ? ethers.parseUnits(str, desc.decimals) : BigInt(str);
}

function encodeModuleParams(params, form) {
  if (!params.length) return "0x";
  return coder.encode([`(${params.map((p) => p.abiType).join(",")})`], [params.map((p) => resolveParam(p, form))]);
}

async function presetSchemas(tools, presetId) {
  const [token, vault, curve, trade, migrate, customData] = await tools.getPresetEncodeSchemas(presetId);
  return {
    token: mapSchema(token),
    vault: mapSchema(vault),
    curve: mapSchema(curve),
    trade: mapSchema(trade),
    migrate: mapSchema(migrate),
    customData: mapSchema(customData),
  };
}

/// Create arguments in OpenFour's layout. Amounts in `form` are whole-token strings (18 decimals, as the kit does).
function encodeCreateArgs({ requestId, presetId, validTimestamp, quoteAsset, form, schemas }) {
  return coder.encode(
    [
      "tuple(uint256 requestId,uint256 presetId,uint256 validTimestamp,uint256 createFee,uint256 presaleQuote,bool antiSniperEnabled,address partner,tuple(string name,string symbol,string tokenUri,uint256 maxSupply,uint256 saleAmount,uint256 raiseAmount,address quoteAsset,bytes32 tokenSalt,bytes tokenParams,bytes vaultParams,bytes curveParams,bytes tradeParams,bytes migrateParams,bytes customDataParams) initParams)",
    ],
    [[
      requestId, presetId, validTimestamp, 0n, 0n, false, ethers.ZeroAddress,
      [
        form.name, form.symbol, form.tokenUri || "",
        ethers.parseUnits(String(form.maxSupply), 18),
        ethers.parseUnits(String(form.saleAmount), 18),
        ethers.parseUnits(String(form.raiseAmount), 18),
        quoteAsset, ethers.ZeroHash,
        encodeModuleParams(schemas.token, form),
        encodeModuleParams(schemas.vault, form),
        encodeModuleParams(schemas.curve, form),
        encodeModuleParams(schemas.trade, form),
        encodeModuleParams(schemas.migrate, form),
        encodeModuleParams(schemas.customData, form),
      ],
    ]],
  );
}

/// What Core.signer signs to allow `caller` to create with `createArgs` (create-test-preset.js signCreate).
async function signCreate(coreSigner, chainId, caller, createArgs) {
  const digest = ethers.keccak256(
    ethers.solidityPacked(["string", "uint256", "address", "bytes32"], ["createOpenFourToken", chainId, caller, ethers.keccak256(createArgs)]),
  );
  return coreSigner.signMessage(ethers.getBytes(digest));
}

module.exports = {
  ABI, DEAD, PHASE, TRADE_MODULE_KEY_SOURCE, coder, encodeCreateArgs, loadFork, presetSchemas, signCreate,
};
