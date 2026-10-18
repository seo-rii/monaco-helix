import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, realpathSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = realpathSync(process.cwd());
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--pack-destination' && args[1]),
  'Usage: node scripts/verify-package.mjs [--pack-destination <directory>]');
let packDestination;
if (args.length) {
  const requested = resolve(args[1]);
  let ancestor = requested;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  packDestination = resolve(realpathSync(ancestor), relative(ancestor, requested));
  const fromRoot = relative(root, packDestination);
  assert(fromRoot && (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)),
    'The pack destination must be outside the physical repository root');
  mkdirSync(packDestination, { recursive: true, mode: 0o700 });
}
const temporary = mkdtempSync(join(tmpdir(), 'monaco-helix-package-'));
let artifact;
try {
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packDestination ?? temporary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  artifact = join(packDestination ?? temporary, pack.filename);
  chmodSync(artifact, 0o600);
  const integrity = `sha512-${createHash('sha512').update(readFileSync(artifact)).digest('base64')}`;
  assert.equal(integrity, pack.integrity, 'Packed artifact integrity mismatch');
  const files = new Set(pack.files.map(file => file.path));
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  function targetsOf(entry) {
    if (typeof entry === 'string') return [entry];
    if (!entry) return [];
    return Object.values(entry).flatMap(targetsOf);
  }
  for (const [name, entry] of Object.entries(metadata.exports)) {
    const targets = targetsOf(entry);
    for (const target of targets) {
      if (target.includes('*')) {
        const [prefix, suffix] = target.replace(/^\.\//, '').split('*');
        assert([...files].some(file => file.startsWith(prefix) && file.endsWith(suffix)), `Missing export ${name}`);
      } else assert(files.has(target.replace(/^\.\//, '')), `Missing export ${name}: ${target}`);
    }
  }
  assert(files.has('LICENSE') && files.has('THIRD_PARTY_NOTICES.md'));
  assert(![...files].some(file => /(^|\/)(node_modules|\.reference|test-results|\.env|\.git)(\/|$)/.test(file)));
  for (const name of ['./syntax', './tree-sitter', './syntax-worker', './syntax-assets/*']) {
    assert(metadata.exports[name], `Missing optional syntax export ${name}`);
  }
  assert.equal(metadata.optionalDependencies?.['web-tree-sitter'], '0.25.10', 'The verified runtime must remain an exact optional dependency');
  for (const name of ['LICENSES.txt', 'manifest.json', 'tree-sitter.wasm', 'tree-sitter-python.wasm', 'tree-sitter-cpp.wasm', 'tree-sitter-typescript.wasm']) {
    assert(files.has(`dist/syntax-assets/${name}`), `Missing syntax asset ${name}`);
  }
  const modules = join(temporary, 'node_modules');
  mkdirSync(modules);
  execFileSync('tar', ['-xzf', artifact, '-C', modules]);
  const extracted = join(modules, 'package');
  symlinkSync(extracted, join(modules, 'monaco-helix'), 'dir');
  symlinkSync(resolve(root, 'node_modules/monaco-editor'), join(modules, 'monaco-editor'), 'dir');
  writeFileSync(join(temporary, 'package.json'), '{"type":"module"}');
  writeFileSync(join(temporary, 'consumer.ts'), `
import { initHelixMode, type HelixBinding, type HelixOptions } from 'monaco-helix';
import type { editor } from 'monaco-editor';
declare const instance: editor.IStandaloneCodeEditor;
const options: HelixOptions = { onCommand: async command => {}, onModeChange: mode => {} };
const binding: HelixBinding = initHelixMode(instance, undefined, options);
await binding.execute('select_all');
await binding.feedKeys('miw');
binding.setKeymap({normal: {x: 'no_op'}});
binding.onDidChangeMode(mode => {}).dispose();
binding.dispose();
`);
  writeFileSync(join(temporary, 'syntax-consumer.ts'), `
import { initHelixMode, type HelixOptions } from 'monaco-helix';
import { SyntaxCoordinator, type SyntaxProvider, type SyntaxOperation } from 'monaco-helix/syntax';
import { createTreeSitterProvider, TreeSitterEngine, treeSitterQueries, type TreeSitterOptions } from 'monaco-helix/tree-sitter';
import type { editor } from 'monaco-editor';
declare const instance: editor.IStandaloneCodeEditor;
const syntaxOptions: TreeSitterOptions = { languages: { python: { wasm: '/python.wasm', query: treeSitterQueries.python } } };
const provider: SyntaxProvider = createTreeSitterProvider(syntaxOptions);
const options: HelixOptions = { syntaxProvider: provider };
const binding = initHelixMode(instance, undefined, options);
const operation: SyntaxOperation = { kind: 'object', object: 'function', around: false };
const coordinator = new SyntaxCoordinator(provider);
await coordinator.query({ id: 'editor:model', version: 1, languageId: 'python', text: '' }, [{ anchor: 0, head: 0 }], operation);
coordinator.dispose(); binding.dispose(); provider.dispose?.();
const inline = new TreeSitterEngine({ execution: 'inline' }); inline.release('editor:model'); inline.dispose();
`);
  // No web-tree-sitter installation is present here: even optional entrypoint
  // declarations and core types must be usable without runtime dependencies.
  execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,ES2022.Intl,DOM,DOM.Iterable', join(temporary, 'consumer.ts'), join(temporary, 'syntax-consumer.ts')], { cwd: temporary, stdio: 'pipe' });
  const assets = join(extracted, 'dist/syntax-assets');
  const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'));
  assert.equal(manifest.runtime.version, '0.25.10');
  assert.equal(manifest.grammars.version, '0.1.13');
  const names = ['tree-sitter.wasm', 'tree-sitter-python.wasm', 'tree-sitter-cpp.wasm', 'tree-sitter-typescript.wasm'];
  assert.deepEqual(Object.keys(manifest.assets).sort(), names.sort());
  for (const name of names) {
    const bytes = readFileSync(join(assets, name));
    assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d', `Invalid WASM file ${name}`);
    assert.equal(bytes.length, manifest.assets[name].bytes, `Size mismatch for ${name}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.assets[name].sha256, `Hash mismatch for ${name}`);
  }
  const notices = readFileSync(join(assets, 'LICENSES.txt'), 'utf8');
  for (const name of ['web-tree-sitter', 'tree-sitter-wasms', 'tree-sitter-python', 'tree-sitter-cpp', 'tree-sitter-typescript']) assert(notices.includes(name), `Missing license attribution ${name}`);

  // Merely importing the adapter and creating/disposal of an inline provider
  // must not load its optional WASM dependency.
  writeFileSync(join(temporary, 'lazy.mjs'), `
import { createTreeSitterProvider } from 'monaco-helix/tree-sitter';
const provider = createTreeSitterProvider({ execution: 'inline' }); provider.dispose();
`);
  execFileSync(process.execPath, [join(temporary, 'lazy.mjs')], { cwd: temporary, stdio: 'pipe' });

  // Parse the actual extracted artifacts, resolving the runtime as an installed
  // optional dependency. This never falls back to repository source or assets.
  const optionalRuntime = resolve(root, 'node_modules/web-tree-sitter');
  assert(existsSync(optionalRuntime), 'Install optional runtime dependencies before verifying the syntax package');
  symlinkSync(optionalRuntime, join(modules, 'web-tree-sitter'), 'dir');
  writeFileSync(join(temporary, 'parse.mjs'), `
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createTreeSitterProvider, treeSitterQueries } from 'monaco-helix/tree-sitter';
const assets = new URL('./node_modules/package/dist/syntax-assets/', import.meta.url);
const provider = createTreeSitterProvider({ execution: 'inline', wasmUrl: fileURLToPath(new URL('tree-sitter.wasm', assets)),
  languages: Object.fromEntries(['python', 'cpp', 'typescript'].map(id => [id, { wasm: fileURLToPath(new URL('tree-sitter-' + id + '.wasm', assets)), query: treeSitterQueries[id] }])) });
const fixtures = [
  ['python', '# 👩‍💻 한글\\r\\ndef solve():\\r\\n    pass', 'def solve():\\r\\n    pass'],
  ['cpp', '// 👩‍💻 한글\\r\\nint solve() { return 1; }', 'int solve() { return 1; }'],
  ['typescript', '// 👩‍💻 한글\\r\\nfunction solve() { return 1; }', 'function solve() { return 1; }'],
];
try { for (const [languageId, text, expected] of fixtures) {
  const offset = text.indexOf('solve');
  const result = await provider.provide({ document: { id: languageId, version: 1, languageId, text },
    selections: [{ anchor: offset, head: offset + 1 }], operation: { kind: 'object', object: 'function', around: true }, signal: new AbortController().signal });
  assert(result, 'No syntax result for ' + languageId);
  assert.equal(text.slice(result.selections[0].anchor, result.selections[0].head), expected);
} } finally { provider.dispose(); }
`);
  execFileSync(process.execPath, [join(temporary, 'parse.mjs')], { cwd: temporary, stdio: 'pipe' });
  console.log(`Package verified: ${pack.files.length} files, ${pack.size} bytes; exports, optional-free TypeScript consumers, asset hashes/licenses, and extracted WASM parsing passed.`);
  if (packDestination) console.log(`Verified tarball: ${artifact}\nIntegrity: ${integrity}`);
} catch (error) {
  if (packDestination && artifact && existsSync(artifact)) console.error(`Package verification failed; unverified tarball retained for inspection: ${artifact}`);
  throw error;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
