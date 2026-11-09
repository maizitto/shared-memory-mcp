#!/usr/bin/env node
/** Operator-only encrypted D1 snapshots. Never imported by the Worker. No automatic restore or scheduling. */
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {open,realpath,mkdtemp,rm,chmod,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve,relative,join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const MAGIC=Buffer.from('SMD1BK01'),MAX_SQL=32*1024*1024,MAX_CONTAINER=MAX_SQL*2+65536;
const fail=code=>{throw new Error(code);};
async function outside(path) {
  const parent=await realpath(dirname(resolve(path))),target=join(parent,resolve(path).split('/').at(-1));
  const relation=relative(await realpath(root),target);
  if(!relation.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&relation!=='..')fail('BACKUP_PATH_MUST_BE_OUTSIDE_REPOSITORY');
  return target;
}
async function readPrivate(path,limit) {
  const target=await outside(path),f=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {const s=await f.stat();if(!s.isFile()||s.size>limit)fail('BACKUP_INPUT_INVALID_OR_TOO_LARGE');
    if((s.mode&0o077)!==0||(process.getuid&&s.uid!==process.getuid()))fail('BACKUP_INPUT_REQUIRES_OWNER_ONLY_PERMISSIONS');
    return await f.readFile();
  }finally{await f.close();}
}
async function writePrivate(path,bytes) {
  const target=await outside(path),parent=await open(dirname(target),constants.O_RDONLY);
  try {const s=await parent.stat();if((s.mode&0o077)!==0)fail('BACKUP_PARENT_REQUIRES_PRIVATE_DIRECTORY');}finally{await parent.close();}
  const f=await open(target,'wx',0o600);
  try{await f.writeFile(bytes);await f.sync();}catch(e){await rm(target,{force:true});throw e;}finally{await f.close();}
}
async function keyFrom(path) {
  const raw=(await readPrivate(path,128)).toString('utf8').trim();
  if(!/^[A-Za-z0-9+/]{43}=$/.test(raw))fail('BACKUP_KEY_FORMAT_INVALID');
  const key=Buffer.from(raw,'base64');if(key.length!==32)fail('BACKUP_KEY_FORMAT_INVALID');return key;
}
export async function createKey(path) {await writePrivate(path,randomBytes(32).toString('base64')+'\n');}
export async function sealSql({sql,database,keyFile,output}) {
  if(typeof sql!=='string'||!sql.trim()||Buffer.byteLength(sql)>MAX_SQL)fail('BACKUP_SQL_INVALID_OR_TOO_LARGE');
  if(!/^[a-z0-9-]{1,64}$/.test(database??''))fail('BACKUP_DATABASE_NAME_INVALID');
  const key=await keyFrom(keyFile),iv=randomBytes(12);
  try {
    const payload=Buffer.from(JSON.stringify({format:'shared-memory-d1',version:1,database,created_at_utc:new Date().toISOString(),
      sql_sha256:createHash('sha256').update(sql).digest('hex'),sql}));
    if(payload.length>MAX_CONTAINER-36)fail('BACKUP_PAYLOAD_TOO_LARGE');
    const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(MAGIC);
    const encrypted=Buffer.concat([cipher.update(payload),cipher.final()]);
    await writePrivate(output,Buffer.concat([MAGIC,iv,cipher.getAuthTag(),encrypted]));
  }finally{key.fill(0);}
}
export async function openSnapshot({input,keyFile}) {
  const bytes=await readPrivate(input,MAX_CONTAINER),key=await keyFrom(keyFile);
  try {
    if(bytes.length<37||!bytes.subarray(0,8).equals(MAGIC))fail('BACKUP_AUTHENTICATION_FAILED');
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));decipher.setAAD(MAGIC);decipher.setAuthTag(bytes.subarray(20,36));
    let payload;try{payload=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(36)),decipher.final()]).toString('utf8'));}catch{fail('BACKUP_AUTHENTICATION_FAILED');}
    if(payload.format!=='shared-memory-d1'||payload.version!==1||typeof payload.sql!=='string'||Buffer.byteLength(payload.sql)>MAX_SQL
       || !/^[a-z0-9-]{1,64}$/.test(payload.database??'')||!Number.isFinite(Date.parse(payload.created_at_utc))
       ||createHash('sha256').update(payload.sql).digest('hex')!==payload.sql_sha256)fail('BACKUP_PAYLOAD_INVALID');
    return payload;
  }finally{key.fill(0);}
}
export function restoreSql(payload,now=Date.now()) {
  if(!Number.isSafeInteger(now)||now<0)fail('BACKUP_TIME_INVALID');
  const required=['memory_facts','memory_versions','memory_clients','memory_client_grants','memory_review_sessions','memory_oauth_connections','memory_index_jobs'];
  if(required.some(t=>!payload.sql.includes(t)))fail('BACKUP_UNSUPPORTED_SCHEMA');
  return payload.sql+`\n\n-- Restore only into a NEW EMPTY database with its Worker disabled.\n-- Invalidate snapshot credentials and outstanding approvals; reauthorize clients.\n
UPDATE memory_clients SET revoked_at_ms=${now} WHERE revoked_at_ms IS NULL;
UPDATE memory_review_sessions SET revoked_at_ms=${now} WHERE revoked_at_ms IS NULL;
DELETE FROM memory_review_logins;
UPDATE memory_oauth_connections SET status='revoked',revoked_at=${now},updated_at=${now} WHERE status!='revoked';
UPDATE memory_proposals SET expires_at_ms=0 WHERE status!='consumed';
UPDATE memory_approvals SET expires_at_ms=0 WHERE consumed_at_ms IS NULL;
UPDATE memory_facts SET indexed_version=0,indexed_fingerprint=NULL;
UPDATE memory_index_jobs SET state='pending',attempts=0,available_at_ms=0,lease_token=NULL,lease_until_ms=NULL,last_error_code=NULL
WHERE state='running' OR EXISTS(SELECT 1 FROM memory_facts f WHERE f.owner_id=memory_index_jobs.owner_id
 AND f.collection_id=memory_index_jobs.collection_id AND f.id=memory_index_jobs.fact_id AND f.version=memory_index_jobs.version);
`;
}
export async function runBackupCli(args) {
  const [action,...rest]=args,allowed={keygen:['key-file'],snapshot:['config','database','output','key-file'],
    scheduled:['config','database','directory','key-file'],seal:['sql','database','output','key-file'],inspect:['input','key-file'],'prepare-restore':['input','output','key-file']};
  if(!Object.hasOwn(allowed,action))fail('BACKUP_USAGE');const o={};
  for(let i=0;i<rest.length;i+=2){const k=rest[i]?.slice(2);if(!rest[i]?.startsWith('--')||!allowed[action].includes(k)||Object.hasOwn(o,k)||!rest[i+1]||rest[i+1].startsWith('--'))fail('BACKUP_USAGE');o[k]=rest[i+1];}
  if(allowed[action].some(k=>!o[k]))fail('BACKUP_USAGE');
  if(action==='scheduled'){
    const output=join(resolve(o.directory),new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(4).toString('hex')+'.smbak');
    return {...await runBackupCli(['snapshot','--config',o.config,'--database',o.database,'--key-file',o['key-file'],'--output',output]),snapshot_file:output};
  }
  if(action==='keygen'){await createKey(o['key-file']);return {status:'key_created',key_printed:false};}
  if(action==='inspect'||action==='prepare-restore') {
    const payload=await openSnapshot({input:o.input,keyFile:o['key-file']});
    if(action==='prepare-restore')await writePrivate(o.output,restoreSql(payload));
    return {status:action==='inspect'?'verified':'plaintext_restore_prepared',database:payload.database,created_at_utc:payload.created_at_utc,
      includes_provider_kv:false,credentials_reused:false,applied_to_database:false};
  }
  if(action==='seal') {await sealSql({sql:(await readPrivate(o.sql,MAX_SQL)).toString('utf8'),database:o.database,keyFile:o['key-file'],output:o.output});}
  else {
    if(!/^[a-z0-9-]{1,64}$/.test(o.database))fail('BACKUP_DATABASE_NAME_INVALID');
    // This operator command accepts JSON, never loads .env files, and requires the exact DB binding.
    let config;try{config=JSON.parse(await readFile(o.config,'utf8'));}catch{fail('BACKUP_JSON_CONFIG_REQUIRED');}
    if(!config.d1_databases?.some(d=>d.binding==='DB'&&d.database_name===o.database))fail('BACKUP_TARGET_NOT_CONFIGURED_AS_MEMORY_DB');
    await keyFrom(o['key-file']).then(key=>key.fill(0));
    const scratch=await mkdtemp(join(tmpdir(),'shared-memory-backup-'));await chmod(scratch,0o700);
    try {
      const exported=join(scratch,'snapshot.sql');
      try {execFileSync(join(root,'node_modules/.bin/wrangler'),['d1','export',o.database,'--remote','--config',resolve(o.config),'--output',exported,'--skip-confirmation'],
        {cwd:root,stdio:'ignore',env:{...process.env,CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:'false',WRANGLER_SEND_METRICS:'false'}});}catch{fail('D1_EXPORT_FAILED_CHECK_LOGIN_CONFIG_AND_TARGET');}
      await chmod(exported,0o600);await sealSql({sql:(await readPrivate(exported,MAX_SQL)).toString('utf8'),database:o.database,keyFile:o['key-file'],output:o.output});
    }finally{await rm(scratch,{recursive:true,force:true});}
  }
  return {status:'encrypted_snapshot_created',includes_provider_kv:false,plaintext_temp_removed:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runBackupCli(process.argv.slice(2))
 .then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message?.startsWith('EEXIST')?'BACKUP_OUTPUT_ALREADY_EXISTS':/^[A-Z0-9_]+$/.test(error.message)?error.message:'BACKUP_IO_FAILED');process.exitCode=1;});
