import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const excluded = new Set(['node_modules', '.git', '.artifacts', '.wrangler', '.cache']);
async function walk(dir = root) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Shipped symlink: ' + relative(root, path));
    out.push(...(entry.isDirectory() ? await walk(path) : [path]));
  }
  return out.sort();
}
const files = await walk();
const checks = [
  [/\/Users\//, 'personal absolute path'],
  [/https:\/\/[a-z0-9.-]+\.workers\.dev/i, 'deployment hostname'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/, 'GitHub credential'],
  [/\bpmm_[A-Za-z0-9_-]{43}\b/, 'literal bearer token']
];
for (const path of files) {
  const name = relative(root, path);
  if (/\.token$|\.sqlite|\.db$|\.dev\.vars|(?:^|\/)\.env(?:\.|$)/.test(name)) throw new Error('Private file: ' + name);
  const text = await readFile(path, 'utf8');
  for (const [pattern, reason] of checks) {
    if (pattern.test(text)) throw new Error(`${reason}: ${name}`);
  }
  if (extname(path) === '.md') {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const url = match[1].split('#')[0].replace(/^<|>$/g, '');
      if (!url || /^(?:https?:|mailto:)/.test(url)) continue;
      const target = resolve(path, '..', decodeURIComponent(url));
      if (relative(root, target).startsWith('..')) throw new Error('External file link: ' + name);
      await lstat(target).catch(() => { throw new Error(`Broken link in ${name}: ${url}`); });
    }
  }
}
const manifest = JSON.parse(await readFile(resolve(root, 'fixtures/manifest.json'), 'utf8'));
for (const [name, digest] of Object.entries(manifest.files)) {
  const actual = createHash('sha256').update(await readFile(resolve(root, name))).digest('hex');
  if (actual !== digest) throw new Error('Fixture drift: ' + name);
}
execFileSync(process.execPath, ['scripts/schema.mjs', '--check'], { cwd: root });
const bundleDir = resolve(root, '.artifacts/build');
const bundles = await readdir(bundleDir).catch(() => []);
if (!bundles.some(name => name.endsWith('.js'))) throw new Error('Run npm run build first.');
for (const name of bundles.filter(name => name.endsWith('.js'))) {
  const bundle = await readFile(resolve(bundleDir, name), 'utf8');
  if (/node:sqlite|node:fs|fictional-operator|fictional-reviewer|LocalD1|\/operator/.test(bundle)) {
    throw new Error('Private test/operator code in public bundle.');
  }
}
console.log(JSON.stringify({ checked_files: files.length, fixture_hashes: 'pass',
  schema: 'pass', markdown_links: 'pass', public_bundle_boundary: 'pass',
  known_sensitive_patterns: 'pass', independent_security_audit: false }));
