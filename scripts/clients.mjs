#!/usr/bin/env node
/**
 * Create, grant, ungrant or revoke /memory/mcp bearer clients. A new token is written once to a 0600 file outside
 * the repository and never printed; D1 receives only its SHA-256 digest. A new client can do nothing until granted
 * a collection; the scopes given at creation are the ceiling of every grant.
 *
 *   node manage_clients.mjs create  <label> <scope>...              --config <wrangler.json> --database <name> (--local [--persist-to <dir>] | --remote)
 *   node manage_clients.mjs grant   <label> <collection> <scope>... (same options)
 *   node manage_clients.mjs ungrant <label> <collection>            (same options)
 *   node manage_clients.mjs revoke  <label>                         (same options)
 */
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BEARER_TTL_MS } from '../src/platform/credentials.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = join(root, 'node_modules/.bin/wrangler');
// The override exists only for a local rehearsal in a scratch directory.
export const TOKEN_DIR = process.env.MEMORY_REVIEW_TOKEN_DIR ?? join(homedir(), '.local/state/shared-memory-mcp/tokens');
const SCOPES = ['memory:read', 'memory:write'];

function options(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--local') out.local = true;
    else if (argv[i] === '--remote') out.remote = true;
    else if (['--config', '--database', '--persist-to'].includes(argv[i])) out[argv[i].slice(2)] = argv[++i];
    else out.positional.push(argv[i]);
  }
  return out;
}
/** Returns the result rows. The SQL never contains a token, only validated labels, scopes and a digest. */
function d1(o, sql) {
  const target = o.local ? ['--local', ...(o['persist-to'] ? ['--persist-to', o['persist-to']] : [])] : ['--remote'];
  const out = execFileSync(wrangler, ['d1', 'execute', o.database, ...target, '--config', o.config, '--json', '--command', sql], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const text = out.toString(); // tolerate a version banner before the JSON
  return JSON.parse(text.slice(text.indexOf('[')))[0]?.results ?? [];
}
const fail = text => { console.error(text); process.exit(2); };
const validScopes = scopes => scopes.length && scopes.every(s => SCOPES.includes(s)) && new Set(scopes).size === scopes.length;

function main() {
  const o = options(process.argv.slice(2)), [action, label, ...rest] = o.positional;
  if(action==='list'&&!label&&Boolean(o.local)!==Boolean(o.remote)&&o.config&&/^[a-z0-9-]{1,64}$/.test(o.database??'')){
    const rows=d1(o,'SELECT id,label,scopes,created_at_ms,revoked_at_ms FROM memory_clients ORDER BY created_at_ms DESC,id LIMIT 101');
    console.log(JSON.stringify({clients:rows.slice(0,100).map(row=>({...row,expires_at_ms:row.created_at_ms+BEARER_TTL_MS,status:row.revoked_at_ms!==null?'revoked':row.created_at_ms>Date.now()?'invalid':Date.now()-row.created_at_ms>=BEARER_TTL_MS?'expired':'active'})),has_more:rows.length>100},null,2));return;
  }
  if (Boolean(o.local) === Boolean(o.remote) || !['create', 'grant', 'ungrant', 'revoke'].includes(action) || !/^[a-z0-9-]{1,32}$/.test(label ?? '') || !o.config || !/^[a-z0-9-]{1,64}$/.test(o.database ?? '')) {
    fail('usage: manage_clients.mjs list (no label) or create|grant|ungrant|revoke <label> [<collection>] [<memory:read|memory:write>...] --config <wrangler.json> --database <name> (--local [--persist-to <dir>] | --remote)');
  }
  if (action === 'grant' || action === 'ungrant') {
    const cutoff=Date.now()-BEARER_TTL_MS;
    const [collection, ...scopes] = rest;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(collection ?? '')) fail('Collection must be lowercase letters, digits, _ or -.');
    if (action === 'ungrant') { d1(o, `DELETE FROM memory_client_grants WHERE collection_id='${collection}' AND client_id=(SELECT id FROM memory_clients WHERE label='${label}')`); console.log(`${label}: no access to ${collection}.`); return; }
    if (!validScopes(scopes)) fail('Scopes must be memory:read and/or memory:write.');
    d1(o, `INSERT INTO memory_client_grants(client_id,collection_id,scopes) SELECT id,'${collection}','${scopes.join(' ')}' FROM memory_clients WHERE label='${label}' AND revoked_at_ms IS NULL AND created_at_ms>${cutoff} AND created_at_ms<=${Date.now()}
      ON CONFLICT(client_id,collection_id) DO UPDATE SET scopes=excluded.scopes`);
    // Local and remote D1 report changed rows differently; read the grant back instead.
    const [row] = d1(o, `SELECT g.scopes FROM memory_client_grants g JOIN memory_clients c ON c.id=g.client_id WHERE c.label='${label}' AND c.revoked_at_ms IS NULL AND c.created_at_ms>${cutoff} AND c.created_at_ms<=${Date.now()} AND g.collection_id='${collection}'`);
    if (row?.scopes !== scopes.join(' ')) fail(`No active client ${label}.`);
    console.log(`${label}: ${scopes.join(' ')} on ${collection} (limited by the client's own scopes).`);
    return;
  }
  const scopes = rest;
  if (action === 'create') {
    if (!validScopes(scopes)) fail('Scopes must be memory:read and/or memory:write.');
    const issued = Date.now();
    const token = `pmm_${randomBytes(32).toString('base64url')}`, digest = createHash('sha256').update(token).digest('hex');
    const file = join(TOKEN_DIR, `${label}.token`);
    mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
    const canonical=realpathSync(TOKEN_DIR),relation=relative(realpathSync(root),canonical),directory=statSync(canonical);
    if((!relation.startsWith('../')&&relation!=='..')||(directory.mode&0o077)!==0)fail('Token directory must be private and outside the repository.');
    writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' }); // refuses to overwrite an existing token
    try {
      d1(o, `INSERT INTO memory_clients(id,label,token_sha256,scopes,created_at_ms) VALUES('${label}','${label}','${digest}','${scopes.join(' ')}',${issued})`);
    } catch (error) { rmSync(file); throw error; }
    console.log(`Created ${label} (${scopes.join(' ')}); expires ${new Date(issued + BEARER_TTL_MS).toISOString()}; token saved to ${file}`);
  } else {
    d1(o, `UPDATE memory_clients SET revoked_at_ms=${Date.now()} WHERE label='${label}' AND revoked_at_ms IS NULL`);
    console.log(`Revoked ${label} (the token file is kept; delete it when no longer useful).`);
  }
}
// Importing this module (for TOKEN_DIR) must not run the command line.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
