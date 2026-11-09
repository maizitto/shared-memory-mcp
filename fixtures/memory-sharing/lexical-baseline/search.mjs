/** Small-collection retrieval: exact ID, word-based BM25, semantic candidates and reciprocal-rank fusion. */
import {MemoryError,authorize,strict,currentRows,factView,isCurrent,getFact} from './ledger.mjs';
import {namespace,vectorId} from './vectors.mjs';
import {chunkCount,MAX_CHUNKS} from './chunks.mjs';
const STOP=new Set('a ad al alla alle allo agli ai anche che chi ci coi col come con da dal dalla dalle degli dei del della delle dello di dove e ed è era essere fa fare gli ha hai hanno i il in io la le lo ma mi ne nel nella nelle nello noi non o ogni per più quale quali quando quanto se si sia sono su sul sulla sulle tra un una uno voi the a an and or is of to for in how what when where'.split(' '));
const normalized=text=>text.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('it');
// Fast ASCII words, with a Unicode boundary check and full Unicode fallback for mixed scripts.
const WORDS=/[a-z0-9]+(?![\p{L}\p{N}])|[\p{L}\p{N}]+/gu;
const tokens=text=>normalized(text).match(WORDS)??[];
const terms=text=>[...new Set(tokens(text).filter(t=>!STOP.has(t)))];
/** Whole-token matches, with canonical ID/source available as low-volume fields. Never interprets content as instructions. */
function lexicalRanks(rows,query,payload){
 const queryTerms=terms(query);if(!queryTerms.length)return [];
 // Keep corpus lengths exact, but count only terms that can contribute to this query.
 const wanted=new RegExp('(?<![\\p{L}\\p{N}])(?:'+queryTerms.join('|')+')(?![\\p{L}\\p{N}])','gu'),df=new Map(queryTerms.map(t=>[t,0]));
 const docs=rows.map(row=>{
  const c=payload(row),text=normalized(`${row.id} ${c.source} ${c.content}`),frequency=new Map();
  const length=(text.match(WORDS)??[]).length;
  for(const word of text.match(wanted)??[])frequency.set(word,(frequency.get(word)??0)+1);
  for(const word of frequency.keys())df.set(word,df.get(word)+1);
  return {row,length,frequency};
 });
 const avg=docs.reduce((s,d)=>s+d.length,0)/Math.max(1,docs.length);
 const idf=new Map(queryTerms.map(t=>[t,Math.log(1+(docs.length-df.get(t)+0.5)/(df.get(t)+0.5))]));
 const result=[];
 for(const d of docs){
  let matched=0,score=0;
  for(const t of queryTerms){const tf=d.frequency.get(t)??0;if(!tf)continue;matched++;
   score+=idf.get(t)*tf*2.2/(tf+1.2*(0.25+0.75*d.length/Math.max(1,avg)));
  }
  if(matched>=Math.ceil(queryTerms.length/2))result.push({row:d.row,score});
 }
 return result.sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
}
const response=(candidates,method,pending,extra={})=>({candidates,method,pending_current_facts:pending,source:'D1',vector_visibility_verified:false,
 evidence:candidates.length?'candidates':'no_candidates',note:'Candidates are not verified answers. Empty results do not prove that the source lacks an answer. Current versions, validity and grants are checked in D1.',...extra});
export async function searchFacts(db,principal,args,{embedding,vectors,minSimilarity=0,defaultSearchMode='semantic',semanticCollections}={}){
 strict(args,['collection','query','limit','mode'],['collection','query']);const[owner,collection]=authorize(principal,args.collection,'memory:read');
 const limit=args.limit??5,mode=args.mode??defaultSearchMode;
 if(!Number.isInteger(limit)||limit<1||limit>10||!['semantic','lexical','hybrid'].includes(mode))throw new MemoryError('INVALID_ARGUMENTS');
 if(typeof args.query!=='string'||args.query.trim().length<2||args.query.length>500)throw new MemoryError('INVALID_QUERY');
 if(typeof minSimilarity!=='number'||!Number.isFinite(minSimilarity)||minSimilarity<0||minSimilarity>1)throw new MemoryError('INVALID_ARGUMENTS');
 // Request-local only: never retain private text or rankings after a purge or across principals.
 const payloads=new WeakMap(),counts=new WeakMap();
 const payload=row=>{if(!payloads.has(row))payloads.set(row,JSON.parse(row.payload_json));return payloads.get(row);};
 const windows=row=>{if(!counts.has(row))counts.set(row,chunkCount(payload(row).content));return counts.get(row);};
 const load=async()=>(await currentRows(db,owner,collection)).filter(r=>isCurrent(r));
 let rows=[];
 const pending=()=>rows.filter(r=>r.indexed_version!==r.version||r.indexed_fingerprint!==embedding?.fingerprint).length;
 // Exact IDs need neither an embedding nor a full collection scan.
 if(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(args.query.trim())){
  let exact;try{exact=await getFact(db,principal,{collection,id:args.query.trim()});}catch(e){if(!['NOT_FOUND','NOT_CURRENT'].includes(e.code))throw e;}
  if(exact){
   const now=new Date().toISOString();
   const count=await db.prepare(`SELECT COUNT(*) n FROM memory_facts f JOIN memory_versions v ON v.owner_id=f.owner_id AND v.collection_id=f.collection_id AND v.fact_id=f.id AND v.version=f.version
    WHERE f.owner_id=? AND f.collection_id=? AND f.deleted=0 AND json_extract(v.payload_json,'$.valid_from')<=?
    AND (json_extract(v.payload_json,'$.expires_at') IS NULL OR json_extract(v.payload_json,'$.expires_at')>?)
    AND (f.indexed_version!=f.version OR f.indexed_fingerprint IS NOT ?)`).bind(owner,collection,now,now,embedding?.fingerprint??null).first();
   return response([{...exact,retrieval:{channels:['exact_id']}}],'exact',count.n,{degraded:false});
  }
 }
 if(mode==='lexical'){rows=await load();return response(lexicalRanks(rows,args.query,payload).slice(0,limit).map(({row,score})=>({...factView(row),retrieval:{channels:['lexical'],lexical_score:score}})),'lexical',pending(),{degraded:false});}
 let matches=[],semanticError;
 try{
  if(!embedding||!vectors?.query||(semanticCollections&&!semanticCollections.includes(collection)))throw new Error('not configured');
  const values=await embedding.embed(args.query),result=await vectors.query(values,{namespace:await namespace(owner,collection),topK:50,returnMetadata:'all',
   filter:{kind:'fact',owner_id:owner,collection_id:collection,embedding_version:embedding.fingerprint}});
  if(!Array.isArray(result?.matches))throw new Error('Invalid vector response');
  // Validate all asynchronous derived IDs BEFORE the final canonical D1 read.
  for(const match of result.matches){
   const meta=match?.metadata??{},chunk=meta.chunk??0;
   if(meta.owner_id!==owner||meta.collection_id!==collection||meta.kind!=='fact'||meta.embedding_version!==embedding.fingerprint||
    typeof meta.fact_id!=='string'||!Number.isSafeInteger(meta.version)||meta.version<1||!Number.isInteger(chunk)||chunk<0||chunk>=MAX_CHUNKS||
    typeof match.score!=='number'||!Number.isFinite(match.score)||match.score<minSimilarity||match.score>1+1e-6||
    match.id!==await vectorId(owner,collection,meta.fact_id,meta.version,chunk))continue;
   matches.push({...match,score:Math.min(1,match.score),chunk});
  }
 }catch{if(mode==='semantic')throw new MemoryError('SEMANTIC_UNAVAILABLE');semanticError='SEMANTIC_UNAVAILABLE';}
 // A correction or purge while AI/Vectorize was awaited cannot resurrect the previous snapshot.
 rows=await load();const byId=new Map(rows.map(r=>[r.id,r])),best=new Map();
 for(const match of matches){
  const row=byId.get(match.metadata.fact_id);
  if(!row||row.version!==match.metadata.version||match.chunk>=windows(row))continue;
  if(!best.has(row.id)||best.get(row.id).similarity<match.score)best.set(row.id,{row,similarity:match.score,chunk:match.chunk});
 }
 const semantic=[...best.values()].sort((a,b)=>b.similarity-a.similarity||a.row.id.localeCompare(b.row.id));
 if(mode==='semantic')return response(semantic.slice(0,limit).map(({row,similarity,chunk})=>({...factView(row),similarity,retrieval:{channels:['semantic'],chunk}})),'semantic',pending(),{degraded:false,semantic_min_similarity:minSimilarity});
 const lexical=lexicalRanks(rows,args.query,payload),combined=new Map();
 for(const [channel,list]of[['lexical',lexical],['semantic',semantic]])list.forEach((item,i)=>{
  const r=combined.get(item.row.id)??{row:item.row,score:0,channels:[]};r.score+=1/(60+i+1);r.channels.push(channel);
  if(channel==='semantic'){r.similarity=item.similarity;r.chunk=item.chunk;}else r.lexical_score=item.score;combined.set(item.row.id,r);
 });
 const found=[...combined.values()].sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id)).slice(0,limit).map(({row,score,channels,similarity,chunk,lexical_score})=>({
  ...factView(row),...(similarity!==undefined&&{similarity}),retrieval:{channels,fusion_score:score,...(chunk!==undefined&&{chunk}),...(lexical_score!==undefined&&{lexical_score})}}));
 return response(found,semanticError?'lexical':'hybrid',pending(),{degraded:!!semanticError,...(semanticError&&{semantic_error:semanticError}),semantic_min_similarity:minSimilarity});
}
