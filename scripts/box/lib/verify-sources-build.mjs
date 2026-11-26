import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { API, address, hex, keccak256, toHex, requireValue, localPath, readJson, decodeAbiParameters, encodeAbiParameters, VerificationError } from './verify-sources-common.mjs';

function qualified(value) {
  requireValue(typeof value === 'string' && /^[^:\\]+\.sol:[A-Za-z_$][A-Za-z0-9_$]*$/.test(value), 'missing qualified source contract binding');
  const split = value.lastIndexOf(':');
  return [value.slice(0, split), value.slice(split + 1)];
}

async function compilation(record, options) {
  if (record.buildInfo) {
    const build = await readJson(localPath(options.baseDir, record.buildInfo));
    requireValue(build.input?.sources && build.input?.settings && build.output?.contracts, 'full compiler build info required (input and output)');
    let target = record.contract;
    if (!target && record.name) {
      const found = Object.entries(build.output.contracts).filter(([, contracts]) => contracts[record.name]);
      requireValue(found.length === 1, 'ambiguous or missing source binding');
      target = `${found[0][0]}:${record.name}`;
    }
    const [path, name] = qualified(target);
    const output = build.output.contracts[path]?.[name];
    requireValue(output?.evm?.bytecode && output?.evm?.deployedBytecode && output?.abi, 'build info lacks contract bytecode/ABI');
    return { input: structuredClone(build.input), output, target, version: build.solcLongVersion ?? build.solcVersion };
  }
  const targetName = record.name ?? (record.contract ? qualified(record.contract)[1] : undefined);
  requireValue(record.artifact || targetName, 'missing supplemental build binding');
  const artifact = await readJson(localPath(options.buildDir, record.artifact ?? `${targetName}.sol/${targetName}.json`));
  let metadata;
  try { metadata = artifact.metadata ?? JSON.parse(artifact.rawMetadata); }
  catch { throw new VerificationError('artifact lacks compiler metadata'); }
  const targets = Object.entries(metadata?.settings?.compilationTarget ?? {});
  requireValue(targets.length === 1, 'artifact has no unique compilation target');
  const target = targets[0].join(':');
  requireValue(!record.contract || record.contract === target, 'artifact source binding mismatch');
  const settings = structuredClone(metadata.settings);
  delete settings.compilationTarget;
  // solc metadata uses "source.sol:Library" keys; standard JSON requires source -> name -> address.
  settings.libraries = {};
  for (const [binding, at] of Object.entries(metadata.settings.libraries ?? {})) {
    const [path, name] = qualified(binding);
    settings.libraries[path] = { ...settings.libraries[path], [name]: address(at) };
  }
  const sources = {};
  for (const [path, details] of Object.entries(metadata.sources ?? {})) {
    let content;
    try { content = await readFile(localPath(options.sourceRoot, path), 'utf8'); }
    catch { throw new VerificationError('missing local compiler source'); }
    requireValue(keccak256(toHex(content)) === hex(details.keccak256, 32), 'local source differs from compiler metadata');
    sources[path] = { content };
  }
  requireValue(Object.keys(sources).length > 0, 'artifact has no compiler source hashes');
  return { target, input: { language: metadata.language, sources, settings }, version: metadata.compiler?.version,
    output: { abi: artifact.abi, evm: { bytecode: artifact.bytecode, deployedBytecode: artifact.deployedBytecode } } };
}

function patchObject(object, replacements) {
  let result = object.replace(/^0x/, '');
  const occupied = new Set();
  for (const { start, length, value } of replacements) {
    requireValue(Number.isSafeInteger(start) && Number.isSafeInteger(length) && start >= 0 && length > 0 && (start + length) * 2 <= result.length, 'invalid compiler bytecode reference');
    const bytes = hex(value, length).slice(2);
    for (let i = start; i < start + length; i++) {
      requireValue(!occupied.has(i), 'overlapping compiler bytecode references'); occupied.add(i);
    }
    result = result.slice(0, start * 2) + bytes + result.slice((start + length) * 2);
  }
  return hex(`0x${result}`);
}

function linkPatches(refs, libraries) {
  return Object.entries(refs ?? {}).flatMap(([path, names]) => Object.entries(names).flatMap(([name, offsets]) => {
    requireValue(libraries[path]?.[name], 'missing linked library address');
    return offsets.map((ref) => { requireValue(ref.length === 20, 'invalid library reference length'); return { ...ref, value: libraries[path][name] }; });
  }));
}

/** Exact local runtime, including metadata, links and every immutable. No masking of hash differences. */
export async function sourcePlan(record, inventory, options) {
  const build = await compilation(record, { baseDir: '.', buildDir: 'packages/contracts/out', sourceRoot: 'packages/contracts', ...options });
  const [path, name] = qualified(build.target);
  requireValue(!record.name || record.name === name || record.kind === 'external', 'manifest contract name disagrees with source');
  requireValue(/^\d+\.\d+\.\d+\+commit\.[0-9a-fA-F]{8}$/.test(build.version), 'full compiler version with commit required');
  requireValue(build.input.language === 'Solidity' && build.input.sources[path]?.content !== undefined, 'standard JSON requires embedded Solidity sources');
  for (const s of Object.values(build.input.sources)) requireValue(typeof s.content === 'string' && !s.urls, 'standard JSON requires embedded source contents');
  const settings = build.input.settings;
  requireValue(typeof settings.optimizer?.enabled === 'boolean' && Number.isSafeInteger(settings.optimizer.runs)
    && settings.optimizer.runs >= 0 && typeof settings.evmVersion === 'string', 'compiler optimizer/EVM settings required');
  requireValue(settings.viaIR === undefined || typeof settings.viaIR === 'boolean', 'invalid via-IR compiler setting');
  const libraries = structuredClone(settings.libraries ?? {});
  for (const [file, names] of Object.entries(record.libraries ?? {})) {
    libraries[file] ??= {};
    for (const [lib, at] of Object.entries(names)) {
      requireValue(!libraries[file][lib] || address(libraries[file][lib]) === address(at), 'library binding conflicts with compiler settings');
      libraries[file][lib] = address(at);
    }
  }
  const { bytecode, deployedBytecode } = build.output.evm;
  requireValue(typeof bytecode?.object === 'string' && typeof deployedBytecode?.object === 'string', 'missing local build bytecode');
  const usedLibraries = new Set();
  for (const refs of [bytecode.linkReferences, deployedBytecode.linkReferences]) {
    for (const [file, names] of Object.entries(refs ?? {})) {
      libraries[file] ??= {};
      for (const lib of Object.keys(names)) {
        usedLibraries.add(`${file}:${lib}`);
        if (!libraries[file][lib]) {
          const found = inventory.filter((r) => r.contract === `${file}:${lib}` || r.name === lib);
          requireValue(found.length === 1, 'missing or ambiguous linked library in inventory');
          libraries[file][lib] = found[0].address;
        }
      }
    }
  }
  const dependencies = [];
  for (const [file, names] of Object.entries(libraries)) {
    for (const [lib, at] of Object.entries(names)) {
      libraries[file][lib] = address(at);
      const dependency = inventory.find((r) => r.address === libraries[file][lib]);
      requireValue(dependency && dependency.kind === 'source' && (dependency.contract === `${file}:${lib}` || dependency.name === lib), 'linked library lacks a matching source inventory binding');
      if (usedLibraries.has(`${file}:${lib}`) && at.toLowerCase() !== record.address && !dependencies.includes(at.toLowerCase())) dependencies.push(at.toLowerCase());
    }
  }
  settings.libraries = libraries;
  const runtimePatches = linkPatches(deployedBytecode.linkReferences, libraries);
  const immutables = record.immutables ?? {};
  const references = deployedBytecode.immutableReferences ?? {};
  requireValue(Object.keys(immutables).every((id) => references[id]), 'unknown immutable binding');
  for (const [id, offsets] of Object.entries(references)) {
    requireValue(immutables[id] !== undefined, 'missing constructor immutable binding');
    runtimePatches.push(...offsets.map((ref) => ({ ...ref, value: immutables[id] })));
  }
  // solc's library call-protection prologue substitutes ADDRESS during creation, outside immutableReferences.
  if (/^(0x)?730{40}3014/.test(deployedBytecode.object)) runtimePatches.push({ start: 1, length: 20, value: record.address });
  const runtime = patchObject(deployedBytecode.object, runtimePatches);
  requireValue(runtime !== '0x' && keccak256(runtime) === hex(record.codeHash, 32), 'manifest runtime hash disagrees with local build');
  const constructor = build.output.abi?.find((entry) => entry.type === 'constructor');
  const inputs = constructor?.inputs ?? [];
  let constructorArguments;
  try {
    constructorArguments = hex(record.constructorArguments ?? (inputs.length === 0 ? '0x' : undefined));
    if (inputs.length === 0) requireValue(constructorArguments === '0x', 'unexpected constructor bytes');
    else requireValue(encodeAbiParameters(inputs, decodeAbiParameters(inputs, constructorArguments)).toLowerCase() === constructorArguments, 'noncanonical constructor bytes');
  } catch { throw new VerificationError('missing or invalid ABI-encoded constructor arguments'); }
  if (record.creationInput !== undefined) {
    const creation = patchObject(bytecode.object, linkPatches(bytecode.linkReferences, libraries));
    requireValue(hex(record.creationInput) === `${creation}${constructorArguments.slice(2)}`, 'creation input disagrees with build and constructor arguments');
  }
  const compilerVersion = `v${build.version}`;
  const fields = { chainid: String(options.chainId), module: 'contract', action: 'verifysourcecode', contractaddress: record.address,
    sourceCode: JSON.stringify(build.input), codeformat: 'solidity-standard-json-input', contractname: build.target,
    compilerversion: compilerVersion, constructorArguements: constructorArguments.slice(2) };
  return { kind: 'source', address: record.address, codeHash: hex(record.codeHash, 32), contract: build.target, sourcePath: path,
    compilerVersion, settings: { ...settings, viaIR: settings.viaIR ?? false }, constructorArguments, libraries,
    runtime, dependencies, request: { method: 'POST', url: API, contentType: 'application/x-www-form-urlencoded', fields } };
}

export function defaultBuildOptions(options) {
  return { ...options, baseDir: resolve(options.baseDir ?? '.'), buildDir: resolve(options.buildDir ?? 'packages/contracts/out'), sourceRoot: resolve(options.sourceRoot ?? 'packages/contracts') };
}
