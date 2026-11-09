import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function collect(dir) {
  const entries = await readdir(new URL(dir, new URL('../', import.meta.url)), { withFileTypes: true });
  const lists = await Promise.all(entries.map(entry => entry.isDirectory()
    ? collect(`${dir}/${entry.name}`)
    : entry.name.endsWith('.test.mjs') ? [`${dir}/${entry.name}`] : []));
  return lists.flat().sort();
}
const mode = process.argv[2];
if (!['unit', 'workerd'].includes(mode)) throw new Error('Choose unit or workerd.');
const files = await collect(mode === 'unit' ? 'test/memory' : 'test/workerd');
if (mode === 'unit') files.push('test/worker.test.mjs');
const child = spawn(process.execPath, ['--experimental-sqlite', '--test', '--test-concurrency=1', ...files], {
  cwd: root, stdio: 'inherit'
});
child.on('error', () => { process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
