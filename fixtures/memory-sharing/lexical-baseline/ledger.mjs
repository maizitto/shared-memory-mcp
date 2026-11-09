/** Explicit fact registry. Principals are supplied by a trusted server auth adapter, never tool arguments. */
import { SQL_NOW } from './schema.mjs';
/** A coach proposes, the owner approves when convenient, the coach writes later: lifetimes sized for a human in the loop. */
export const PROPOSAL_TTL_MS = 86400000, APPROVAL_TTL_MS = 3600000;
/** One fact holds one section of a document; sections of the owner's coaching documents stay below this. */
export const MAX_CONTENT = 8000, MAX_BATCH_APPROVALS = 60;
export class MemoryError extends Error { constructor(code) { super(code); this.code=code; } }
const fail = code => { throw new MemoryError(code); };
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export function strict(args, allowed, required=[]) {
 if (!args || typeof args!=='object' || Array.isArray(args) || Object.keys(args).some(k=>!allowed.includes(k)) || required.some(k=>args[k]===undefined)) fail('INVALID_ARGUMENTS');
}
export function identifier(value) { if (typeof value!=='string' || !ID.test(value)) fail('INVALID_IDENTIFIER'); return value; }
export function authorize(principal, collection, scope) {
 if (!principal || typeof principal.owner_id!=='string' || typeof principal.subject!=='string') fail('FORBIDDEN');
 // Per-collection grants ({collection: [scopes]}) take precedence over the older scopes x collections form.
 if (principal.grants) {
  identifier(collection);
  const scopes=Object.hasOwn(principal.grants,collection)?principal.grants[collection]:null;
  if (!Array.isArray(scopes) || !scopes.includes(scope)) fail('FORBIDDEN');
  return [principal.owner_id,collection];
 }
 if (!Array.isArray(principal.scopes) || !principal.scopes.includes(scope)) fail('FORBIDDEN');
 identifier(collection);
 if (!Array.isArray(principal.collections) || !principal.collections.includes(collection)) fail('FORBIDDEN');
 return [principal.owner_id,collection];
}
export async function hash(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join(''); }
/**
 * ISO 8601 as AI clients actually send it: a date (2026-10-23), a date-time with Z or an offset (+02:00, +0200),
 * or without a zone (read as UTC). Impossible dates are refused. Always stored as canonical UTC with milliseconds.
 */
function instant(value) {
 const m=typeof value==='string'&&/^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.(\d{1,9}))?)?(Z|[+-]\d\d:?\d\d)?)?$/.exec(value.trim());
 if (!m) fail('INVALID_TIME');
 const [,y,mo,d,h='00',mi='00',sec='00',frac='',zone='Z']=m,parts=[+y,+mo-1,+d,+h,+mi,+sec];
 const check=new Date(Date.UTC(...parts));
 if (check.getUTCFullYear()!==parts[0]||check.getUTCMonth()!==parts[1]||check.getUTCDate()!==parts[2]||check.getUTCHours()!==parts[3]||check.getUTCMinutes()!==parts[4]||check.getUTCSeconds()!==parts[5]) fail('INVALID_TIME');
 const offset=zone==='Z'?0:(zone[0]==='-'?-1:1)*(Number(zone.slice(1,3))*60+Number(zone.slice(-2)));
 if (Math.abs(offset)>14*60) fail('INVALID_TIME');
 return new Date(Date.UTC(...parts,frac?Number(frac.padEnd(3,'0').slice(0,3)):0)-offset*60000).toISOString();
}
const today = () => `${new Date().toISOString().slice(0,10)}T00:00:00.000Z`;
function text(value,max) { if (typeof value!=='string' || !value.trim() || value.includes('\0') || value.length>max) fail('INVALID_TEXT'); return value; }
export function normalizeCommand(args) { return command(args); }
function command(args) {
 strict(args,['collection','request_id','fact_id','operation','expected_version','content','source','observed_at','valid_from','expires_at'],['collection','request_id','fact_id','operation','expected_version']); // proposeFact supplies a missing request_id
 const out={collection:identifier(args.collection),request_id:identifier(args.request_id),fact_id:identifier(args.fact_id),operation:args.operation,expected_version:args.expected_version};
 if (!['put','delete'].includes(out.operation) || !Number.isSafeInteger(out.expected_version) || out.expected_version<0 || out.expected_version>1e9) fail('INVALID_COMMAND');
 if (out.operation==='put') {
  // Missing times default to today (UTC midnight), so a retry on the same day keeps the same digest.
  const observed=args.observed_at==null?today():instant(args.observed_at);
  Object.assign(out,{content:text(args.content,MAX_CONTENT),source:text(args.source,500),observed_at:observed,valid_from:args.valid_from==null?observed:instant(args.valid_from),expires_at:args.expires_at===undefined||args.expires_at===null?null:instant(args.expires_at)});
  if (out.expires_at && out.expires_at<=out.valid_from) fail('INVALID_VALIDITY');
 } else if (['content','source','observed_at','valid_from','expires_at'].some(k=>args[k]!==undefined)) fail('INVALID_ARGUMENTS');
 return out;
}
const receipt = (db,owner,collection,requestId) => db.prepare('SELECT * FROM memory_receipts WHERE owner_id=? AND collection_id=? AND request_id=?').bind(owner,collection,requestId).first();
/** Unapproved or unused proposals hold text that never became memory: remove them once expired. Bounded per call. */
export async function cleanupExpiredProposals(db,owner,now=Date.now()) {
 const expired=`SELECT id FROM memory_proposals WHERE owner_id=? AND status!='consumed' AND expires_at_ms<? ORDER BY id LIMIT 50`;
 await db.batch([
  db.prepare(`DELETE FROM memory_approvals WHERE proposal_id IN (${expired})`).bind(owner,now),
  db.prepare(`DELETE FROM memory_proposals WHERE id IN (${expired})`).bind(owner,now),
 ]);
}
export async function proposeFact(db,principal,args) {
 // Without a request_id, the key derives from what is proposed: the same proposal retried is the same request.
 if (args && typeof args==='object' && !Array.isArray(args) && args.request_id===undefined)
  args={...args,request_id:`auto-${(await hash(JSON.stringify([args.collection,args.fact_id,args.operation,args.expected_version,args.content??null]))).slice(0,32)}`};
 const c=command(args), [owner,collection]=authorize(principal,c.collection,'memory:write');
 await cleanupExpiredProposals(db,owner);
 const payload=JSON.stringify(c),digest=await hash(JSON.stringify({owner_id:owner,...c}));
 const prior=await receipt(db,owner,collection,c.request_id);
 if (prior) { if (prior.digest!==digest) fail('IDEMPOTENCY_CONFLICT'); return {...await receiptView(db,prior,true),proposal_id:prior.proposal_id}; }
 const id=crypto.randomUUID(),now=Date.now();
 await db.prepare(`INSERT INTO memory_proposals(id,owner_id,collection_id,request_id,digest,payload_json,fact_id,operation,expected_version,creator,created_at_ms,expires_at_ms)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,collection_id,request_id) DO NOTHING`).bind(id,owner,collection,c.request_id,digest,payload,c.fact_id,c.operation,c.expected_version,principal.subject,now,now+PROPOSAL_TTL_MS).run();
 const p=await db.prepare('SELECT * FROM memory_proposals WHERE owner_id=? AND collection_id=? AND request_id=?').bind(owner,collection,c.request_id).first();
 if (!p || p.digest!==digest) fail('IDEMPOTENCY_CONFLICT');
 return {status:p.status,proposal_id:p.id,digest:p.digest,command:JSON.parse(p.payload_json),expires_at_ms:p.expires_at_ms};
}
export async function inspectProposal(db,principal,{collection,proposal_id}) {
 const [owner]=authorize(principal,collection,'memory:approve');identifier(proposal_id);
 const p=await db.prepare('SELECT * FROM memory_proposals WHERE id=? AND owner_id=? AND collection_id=?').bind(proposal_id,owner,collection).first();
 if (!p) fail('NOT_FOUND');
 return {proposal_id:p.id,digest:p.digest,command:JSON.parse(p.payload_json),status:p.status,creator:p.creator,expires_at_ms:p.expires_at_ms};
}
export async function approveProposal(db,principal,args) {
 strict(args,['collection','proposal_id','expected_digest'],['collection','proposal_id','expected_digest']);
 const [owner,collection]=authorize(principal,args.collection,'memory:approve');identifier(args.proposal_id);
 if (typeof args.expected_digest!=='string'||!/^[0-9a-f]{64}$/.test(args.expected_digest)) fail('INVALID_DIGEST');
 const p=await inspectProposal(db,principal,args);
 if (p.digest!==args.expected_digest) fail('APPROVAL_MISMATCH');
 let a=await db.prepare('SELECT * FROM memory_approvals WHERE proposal_id=? AND owner_id=? AND collection_id=?').bind(p.proposal_id,owner,collection).first();
 if (!a) {
  const id=crypto.randomUUID(),now=Date.now();
  try { await db.prepare(`INSERT INTO memory_approvals(id,proposal_id,owner_id,collection_id,digest,approved_by,approved_at_ms,expires_at_ms)
   VALUES(?,?,?,?,?,?,?,?)`).bind(id,p.proposal_id,owner,collection,p.digest,principal.subject,now,Math.min(p.expires_at_ms,now+APPROVAL_TTL_MS)).run(); }
  catch (error) { a=await db.prepare('SELECT * FROM memory_approvals WHERE proposal_id=? AND owner_id=? AND collection_id=?').bind(p.proposal_id,owner,collection).first(); if(!a) { if(String(error).includes('PROPOSAL_UNAVAILABLE'))fail('PROPOSAL_UNAVAILABLE');throw error; } }
  a??=await db.prepare('SELECT * FROM memory_approvals WHERE id=?').bind(id).first();
 }
 return {approval_id:a.id,proposal_id:p.proposal_id,digest:a.digest,expires_at_ms:a.expires_at_ms,consumed:a.consumed_at_ms!==null};
}
/**
 * The owner approves proposals they have just seen, and approving writes them. Each item binds its exact digest;
 * items no longer pending, expired or changed are skipped, never approved. An approved proposal that cannot be written
 * (its fact changed meanwhile, a second proposal for the same fact, capacity) stays approved and is reported.
 * D1 Free allows few queries per request and 100 parameters per query: whole lists go in a handful of statements.
 */
const CHUNK = 40;
const chunked = list => Array.from({length:Math.ceil(list.length/CHUNK)},(_,i)=>list.slice(i*CHUNK,(i+1)*CHUNK));
const marks = list => list.map(()=>'?').join(',');
export async function approveAndWrite(db,principal,args) {
 strict(args,['collection','items'],['collection','items']);const [owner,collection]=authorize(principal,args.collection,'memory:approve');
 if(!Array.isArray(args.items)||!args.items.length||args.items.length>MAX_BATCH_APPROVALS)fail('INVALID_ARGUMENTS');
 for(const item of args.items){strict(item,['proposal_id','expected_digest'],['proposal_id','expected_digest']);identifier(item.proposal_id);if(typeof item.expected_digest!=='string'||!/^[0-9a-f]{64}$/.test(item.expected_digest))fail('INVALID_DIGEST');}
 if(new Set(args.items.map(i=>i.proposal_id)).size!==args.items.length)fail('INVALID_ARGUMENTS');
 const now=Date.now(),ids=args.items.map(i=>i.proposal_id);
 // INSERT ... SELECT inserts only still-pending exact matches, so the approval guard never aborts the statement.
 await db.batch(chunked(args.items).map(chunk=>db.prepare(`WITH items(id,digest) AS (VALUES ${chunk.map(()=>'(?,?)').join(',')})
  INSERT INTO memory_approvals(id,proposal_id,owner_id,collection_id,digest,approved_by,approved_at_ms,expires_at_ms)
  SELECT lower(hex(randomblob(16))),p.id,p.owner_id,p.collection_id,p.digest,?,?,MIN(p.expires_at_ms,?) FROM memory_proposals p JOIN items i ON i.id=p.id AND i.digest=p.digest
  WHERE p.owner_id=? AND p.collection_id=? AND p.status='pending' AND p.expires_at_ms>?`)
  .bind(...chunk.flatMap(i=>[i.proposal_id,i.expected_digest]),principal.subject,now,now+APPROVAL_TTL_MS,owner,collection,now)));
 const written=await writeApproved(db,owner,collection,ids,now);
 const states=new Map();
 for(const chunk of chunked(ids))for(const r of (await db.prepare(`SELECT id,status FROM memory_proposals WHERE owner_id=? AND collection_id=? AND id IN (${marks(chunk)})`).bind(owner,collection,...chunk).all()).results??[])states.set(r.id,r.status);
 return {written,approved_not_written:ids.filter(id=>states.get(id)==='approved'),skipped:ids.filter(id=>!['approved','consumed'].includes(states.get(id))||(states.get(id)==='consumed'&&!written.includes(id)))};
}
/** Write approved, unconsumed proposals with the same receipts/triggers a writer's put_fact uses; the actor is the proposer. */
export async function writeApproved(db,owner,collection,ids,now=Date.now()) {
 const rows=[];
 for(const chunk of chunked(ids))rows.push(...((await db.prepare(`SELECT p.id,p.fact_id,p.operation,p.expected_version,p.created_at_ms,
  f.version AS head_version,f.deleted AS head_deleted
  FROM memory_proposals p JOIN memory_approvals a ON a.proposal_id=p.id
  LEFT JOIN memory_facts f ON f.owner_id=p.owner_id AND f.collection_id=p.collection_id AND f.id=p.fact_id
  WHERE p.owner_id=? AND p.collection_id=? AND p.id IN (${marks(chunk)}) AND p.status='approved' AND a.consumed_at_ms IS NULL
  AND a.expires_at_ms>? AND p.expires_at_ms>?
  AND NOT EXISTS(SELECT 1 FROM memory_receipts r WHERE r.owner_id=p.owner_id AND r.collection_id=p.collection_id AND r.request_id=p.request_id)`)
  .bind(owner,collection,...chunk,now,now).all()).results??[]));
 // Apply the commit guard's rules here, so that one row can never abort the whole statement.
 const seen=new Set(),ready=[];
 for(const r of rows.sort((x,y)=>x.created_at_ms-y.created_at_ms||(x.id<y.id?-1:1))){
  if(seen.has(r.fact_id)||r.head_deleted||r.expected_version!==(r.head_version??0)||(r.operation==='delete'&&r.head_version===null))continue;
  seen.add(r.fact_id);ready.push(r);
 }
 const live=(await db.prepare('SELECT COUNT(*) AS n FROM memory_facts WHERE owner_id=? AND collection_id=? AND deleted=0').bind(owner,collection).first()).n;
 let room=200-live;const writable=ready.filter(r=>r.operation!=='put'||r.head_version!==null||room-->0).map(r=>r.id);
 if(!writable.length)return [];
 try {
  await db.batch(chunked(writable).map(chunk=>db.prepare(`INSERT INTO memory_receipts(owner_id,collection_id,request_id,digest,proposal_id,approval_id,fact_id,operation,version,actor,committed_at_ms)
   SELECT p.owner_id,p.collection_id,p.request_id,p.digest,p.id,a.id,p.fact_id,p.operation,p.expected_version+1,p.creator,?
   FROM memory_proposals p JOIN memory_approvals a ON a.proposal_id=p.id
   WHERE p.owner_id=? AND p.collection_id=? AND p.id IN (${marks(chunk)}) AND p.status='approved' AND a.consumed_at_ms IS NULL`).bind(now,owner,collection,...chunk)));
 } catch { return []; } // a concurrent write changed a fact: everything stays approved; the proposers' put_fact still works
 return writable;
}
const rowFor = (db,owner,collection,id) => db.prepare(`SELECT f.*,v.payload_json,v.actor,v.recorded_at_ms FROM memory_facts f
 JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version
 WHERE f.owner_id=? AND f.collection_id=? AND f.id=?`).bind(owner,collection,id).first();
export function factView(row) {
 const c=JSON.parse(row.payload_json);
 return {id:row.id,collection:row.collection_id,version:row.version,content:c.content,source:c.source,observed_at:c.observed_at,valid_from:c.valid_from,expires_at:c.expires_at,
 recorded_at_utc:new Date(row.recorded_at_ms).toISOString(),actor:row.actor,index_status:row.indexed_version===row.version?'indexed':'pending'};
}
export function isCurrent(row,now=Date.now()) { if(!row||row.deleted)return false;const c=JSON.parse(row.payload_json);return Date.parse(c.valid_from)<=now&&(!c.expires_at||Date.parse(c.expires_at)>now); }
async function receiptView(db,r,replayed) {
 const row=await rowFor(db,r.owner_id,r.collection_id,r.fact_id);
 if (!row) { // a committed fact without version rows has been purged
  const head=await db.prepare('SELECT version FROM memory_facts WHERE owner_id=? AND collection_id=? AND id=?').bind(r.owner_id,r.collection_id,r.fact_id).first();
  return {status:'deleted',purged:true,id:r.fact_id,committed_version:r.version,current_version:head?.version??null,replayed,superseded:true,fact:null};
 }
 return {status:row?.deleted?'deleted':'stored',id:r.fact_id,committed_version:r.version,current_version:row?.version??null,replayed,
 superseded:row?.version!==r.version,fact:isCurrent(row)?factView(row):null};
}
export async function commitProposal(db,principal,args,operation) {
 strict(args,['collection','proposal_id'],['collection','proposal_id']);const [owner,collection]=authorize(principal,args.collection,'memory:write');identifier(args.proposal_id);
 const p=await db.prepare('SELECT * FROM memory_proposals WHERE id=? AND owner_id=? AND collection_id=?').bind(args.proposal_id,owner,collection).first();
 if (!p) fail('NOT_FOUND');if(p.operation!==operation)fail('WRONG_OPERATION');
 const previous=await receipt(db,owner,collection,p.request_id);
 if(previous){if(previous.digest!==p.digest)fail('IDEMPOTENCY_CONFLICT');return receiptView(db,previous,true);}
 const a=await db.prepare('SELECT * FROM memory_approvals WHERE proposal_id=? AND owner_id=? AND collection_id=?').bind(p.id,owner,collection).first();if(!a)fail('APPROVAL_REQUIRED');
 try {
  await db.prepare(`INSERT INTO memory_receipts(owner_id,collection_id,request_id,digest,proposal_id,approval_id,fact_id,operation,version,actor,committed_at_ms)
  VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(owner,collection,p.request_id,p.digest,p.id,a.id,p.fact_id,operation,p.expected_version+1,principal.subject,Date.now()).run();
 } catch(error) {
  const raced=await receipt(db,owner,collection,p.request_id);if(raced){if(raced.digest!==p.digest)fail('IDEMPOTENCY_CONFLICT');return receiptView(db,raced,true);}
  const code=['VERSION_CONFLICT','DELETED_ID','NOT_FOUND','APPROVAL_REQUIRED','CAPACITY_REACHED'].find(c=>String(error).includes(c));if(code)fail(code);throw error;
 }
 return receiptView(db,await receipt(db,owner,collection,p.request_id),false);
}
export async function getFact(db,principal,args) {
 strict(args,['collection','id','version'],['collection','id']);const [owner,collection]=authorize(principal,args.collection,'memory:read');identifier(args.id);
 const head=await rowFor(db,owner,collection,args.id);if(!head||head.deleted)fail('NOT_FOUND');
 if(args.version!==undefined){
  if(!Number.isSafeInteger(args.version)||args.version<1)fail('INVALID_VERSION');
  const version=await db.prepare('SELECT * FROM memory_versions WHERE owner_id=? AND collection_id=? AND fact_id=? AND version=?').bind(owner,collection,args.id,args.version).first();
  if(!version||version.operation==='delete')fail('NOT_FOUND');return {...factView({...head,...version,id:args.id}),index_status:'not_applicable_to_history',historical:args.version!==head.version,current_version:head.version};
 }
 if(!isCurrent(head))fail('NOT_CURRENT');return factView(head);
}
export async function currentRows(db,owner,collection) {
 return (await db.prepare(`SELECT f.*,v.payload_json,v.actor,v.recorded_at_ms FROM memory_facts f
 JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version
 WHERE f.owner_id=? AND f.collection_id=? AND f.deleted=0 ORDER BY f.id LIMIT 201`).bind(owner,collection).all()).results??[];
}
export async function listFacts(db,principal,args) {
 strict(args,['collection','limit'],['collection']);const [owner,collection]=authorize(principal,args.collection,'memory:read');
 const limit=args.limit??20;if(!Number.isInteger(limit)||limit<1||limit>50)fail('INVALID_LIMIT');
 const rows=(await currentRows(db,owner,collection)).filter(r=>isCurrent(r));return {facts:rows.slice(0,limit).map(factView),has_more:rows.length>limit,consistency:'live',proposal_contents_included:false};
}
export async function indexState(db,owner,collection) {
 return (await db.prepare(`SELECT state,COUNT(*) AS n FROM memory_index_jobs WHERE owner_id=? AND collection_id=? GROUP BY state`).bind(owner,collection).all()).results??[];
}
