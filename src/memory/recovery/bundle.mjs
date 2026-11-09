/** Explicit local packages. No credentials, automatic cloud access, compression or index snapshots. */
import {constants} from 'node:fs';
import {open,mkdir,readdir,lstat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {MemoryError,hash,identifier,strict} from '../ledger.mjs';
import {validateCollectionExport} from './archive.mjs';
import {CHUNK_POLICY} from '../chunks.mjs';
import {LEXICAL_POLICY} from '../lexical.mjs';
export const MAX_ARCHIVE_BYTES=32*1024*1024;
const fail=code=>{throw new MemoryError(code);};
const bytes=text=>new TextEncoder().encode(text).length;
export const recoveryPrincipal=(owner,collection)=>({owner_id:identifier(owner),subject:'offline-owner-recovery',collections:[identifier(collection)],scopes:['memory:export','memory:restore','memory:read']});
export const bootstrapFor=data=>({format:'persistent-memory-bootstrap-template',format_version:1,role:'template_not_source_configuration',enabled:false,owner_id:data.owner_id,collections:[data.collection],client_grants:[],search:{enabled:false,model:'@cf/baai/bge-m3',dimensions:1024,fingerprint:'bge-m3-1024:'+CHUNK_POLICY,min_similarity:0.45,chunk_policy:CHUNK_POLICY,lexical_policy:LEXICAL_POLICY},requires:['separate owner authentication and explicit client grants','fresh or verified-clean dedicated vector index','rebuild semantic and lexical projections from canonical data']});
const instructions=`# Private collection recovery package\n\nContains plaintext fact history and deletion tombstones. Keep outside source repositories.\nSHA-256 detects accidental corruption; it does not authenticate the author or encrypt data.\nOnly restore a trusted owner export into an isolated empty destination.\nbootstrap.json is a disabled deployment template, not a captured live configuration.\nAuthentication, sessions, grants, receipts, proposals, workout archives and secrets are excluded.\nA snapshot cannot know deletions made after its creation. Reconcile later deletion records before reconnecting clients.\nDo not reuse a stale vector index or reconnect clients before checking the restoration.\nDo not expose any recovery command through MCP or the public Worker.\n`;
const json=x=>JSON.stringify(x,null,2)+'\n';
export async function readRegular(path,maximum=MAX_ARCHIVE_BYTES){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const s=await f.stat();if(!s.isFile()||s.size>maximum)fail('RECOVERY_FILE_TOO_LARGE');const b=await f.readFile();if(b.length>maximum)fail('RECOVERY_FILE_TOO_LARGE');return new TextDecoder('utf-8',{fatal:true}).decode(b);}finally{await f.close();}
}
const writePrivate=async(path,text)=>{const f=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await f.writeFile(text);await f.sync();}finally{await f.close();}};
export async function packBundle(data,directory){
 const stats=await validateCollectionExport(recoveryPrincipal(data.owner_id,data.collection),data);
 const archive=json(data);if(bytes(archive)>MAX_ARCHIVE_BYTES)fail('RECOVERY_FILE_TOO_LARGE');
 const files={'archive.json':archive,'bootstrap.json':json(bootstrapFor(data)),'README.md':instructions};
 const manifest={format:'persistent-memory-recovery',format_version:1,created_at_utc:new Date().toISOString(),owner_id:data.owner_id,collection:data.collection,canonical_sha256:data.sha256,counts:{facts:stats.facts,versions:stats.versions,purged:stats.purged,active:stats.active},files:await Promise.all(Object.entries(files).map(async([name,text])=>({name,bytes:bytes(text),sha256:await hash(text)})))};
 // Exclusive directory + exclusive files; manifest is the completion marker, written last.
 await mkdir(directory,{mode:0o700});
 for(const [name,text]of Object.entries(files))await writePrivate(join(directory,name),text);
 await writePrivate(join(directory,'manifest.json'),json(manifest));return manifest;
}
export async function readBundle(directory,{owner,collection}={}){
 const d=await lstat(directory);if(!d.isDirectory()||d.isSymbolicLink())fail('INVALID_RECOVERY_BUNDLE');
 const names=(await readdir(directory)).sort();if(JSON.stringify(names)!==JSON.stringify(['README.md','archive.json','bootstrap.json','manifest.json']))fail('INVALID_RECOVERY_BUNDLE');
 const manifest=JSON.parse(await readRegular(join(directory,'manifest.json'),16384));
 strict(manifest,['format','format_version','created_at_utc','owner_id','collection','canonical_sha256','counts','files'],['format','format_version','created_at_utc','owner_id','collection','canonical_sha256','counts','files']);
 if(manifest.format!=='persistent-memory-recovery'||manifest.format_version!==1||typeof manifest.created_at_utc!=='string'||!Number.isFinite(Date.parse(manifest.created_at_utc))||new Date(manifest.created_at_utc).toISOString()!==manifest.created_at_utc||!Array.isArray(manifest.files)||manifest.files.length!==3)fail('INVALID_RECOVERY_BUNDLE');
 const expected=['archive.json','bootstrap.json','README.md'],contents={};
 for(let i=0;i<3;i++){
  const file=manifest.files[i];strict(file,['name','bytes','sha256'],['name','bytes','sha256']);
  if(file.name!==expected[i]||!Number.isSafeInteger(file.bytes)||file.bytes<0||typeof file.sha256!=='string'||!/^[0-9a-f]{64}$/.test(file.sha256))fail('INVALID_RECOVERY_BUNDLE');
  const text=await readRegular(join(directory,file.name),i===0?MAX_ARCHIVE_BYTES:16384);
  if(bytes(text)!==file.bytes||await hash(text)!==file.sha256)fail('RECOVERY_DIGEST_MISMATCH');contents[file.name]=text;
 }
 const data=JSON.parse(contents['archive.json']);
 const principal=recoveryPrincipal(owner??manifest.owner_id,collection??manifest.collection),stats=await validateCollectionExport(principal,data);
 if(manifest.owner_id!==data.owner_id||manifest.collection!==data.collection||manifest.canonical_sha256!==data.sha256||JSON.stringify(manifest.counts)!==JSON.stringify({facts:stats.facts,versions:stats.versions,purged:stats.purged,active:stats.active}))fail('INVALID_RECOVERY_BUNDLE');
 if(JSON.stringify(JSON.parse(contents['bootstrap.json']))!==JSON.stringify(bootstrapFor(data))||contents['README.md']!==instructions)fail('INVALID_RECOVERY_BUNDLE');
 return {data,manifest,directory:resolve(directory)};
}
