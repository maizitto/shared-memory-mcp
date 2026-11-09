#!/usr/bin/env node
/** Operator-only D1 connection listing/revocation. Never reads or prints OAuth tokens. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const usage = 'usage: npm run connection -- list|revoke [CONNECTION_UUID] --config PATH --database NAME (--local [--persist-to DIR] | --remote)';
function fail(message) { console.error(message); process.exit(2); }
const options = { positional: [] };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (['--local', '--remote'].includes(arg)) options[arg.slice(2)] = true;
  else if (['--config', '--database', '--persist-to'].includes(arg)) {
    if (!args[i + 1] || args[i + 1].startsWith('--')) fail(usage);
    options[arg.slice(2)] = args[++i];
  } else if (arg.startsWith('--')) fail(usage);
  else options.positional.push(arg);
}
const [action, id, ...extra] = options.positional;
if (!['list', 'revoke'].includes(action) || extra.length || (action === 'list' && id)
    || (action === 'revoke' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? ''))
    || Boolean(options.local) === Boolean(options.remote) || !options.config
    || !/^[a-z0-9-]{1,64}$/.test(options.database ?? '') || (options.remote && options['persist-to'])) fail(usage);
function query(sql) {
  const target = options.local ? ['--local', ...(options['persist-to'] ? ['--persist-to', options['persist-to']] : [])] : ['--remote'];
  const output = execFileSync(join(root, 'node_modules/.bin/wrangler'), ['d1', 'execute', options.database,
    ...target, '--config', options.config, '--json', '--command', sql], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
  return JSON.parse(output.slice(output.indexOf('[')))[0]?.results ?? [];
}
if (action === 'revoke') {
  const now = Date.now();
  query(`UPDATE memory_oauth_connections SET status='revoked',revoked_at=${now},updated_at=${now} WHERE id='${id}' AND status!='revoked'`);
  const [row] = query(`SELECT id,status FROM memory_oauth_connections WHERE id='${id}'`);
  if (!row || row.status !== 'revoked') fail('Connection not found or revocation could not be confirmed.');
  console.log(`Revoked ${row.id}. Subsequent access and refresh requests are denied by D1.`);
} else {
  const rows = query('SELECT id,client_id,scope,collections_json,status,created_at,expires_at,revoked_at FROM memory_oauth_connections ORDER BY created_at DESC,id LIMIT 101');
  console.log(JSON.stringify({ connections: rows.slice(0, 100).map(({ collections_json, ...row }) => ({ ...row, collections: JSON.parse(collections_json) })), has_more: rows.length > 100 }, null, 2));
}
