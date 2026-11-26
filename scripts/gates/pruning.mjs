/** Accept only an entire Forge contract whose every test body is exactly vm.skip(true). */
export function emptyForgeStub(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const names = [];
  const remainder = clean.replace(/function\s+(test\w+)\s*\(\s*\)\s+public\s*\{\s*vm\.skip\(true\);\s*\}/g, (_match, name) => { names.push(name); return ''; });
  return names.length && /^\s*pragma solidity [^;]+;\s*import\s*\{\s*Test\s*\}\s*from\s*["']forge-std\/Test\.sol["'];\s*contract\s+\w+\s+is\s+Test\s*\{\s*\}\s*$/.test(remainder) ? names : null;
}
