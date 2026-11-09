import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const isolated = await mkdtemp(join(tmpdir(), 'memory-build-'));
try {
  const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run',
    '--config', 'config/wrangler.example.json', '--outdir', join(root, '.artifacts/build')], {
    cwd: root, stdio: 'inherit', env: {
      PATH: process.env.PATH, LANG: process.env.LANG ?? 'en_US.UTF-8',
      XDG_CONFIG_HOME: isolated, WRANGLER_SEND_METRICS: 'false',
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false'
    }
  });
  process.exitCode = await new Promise(resolve => {
    child.on('error', () => resolve(1)); child.on('exit', code => resolve(code ?? 1));
  });
} finally { await rm(isolated, { recursive: true, force: true }); }
