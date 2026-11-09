/** Compact ranking metadata followed by final canonical hydration; at most one retry for racing heads. */
import {factView,isCurrent} from './ledger.mjs';
import {queryTerms,rankDocuments} from './lexical.mjs';
import {chunkCount} from './chunks.mjs';
import {searchSnapshot,snapshotDocuments,hydrateCandidates,DerivedIndexUnavailable} from './lexical-index.mjs';
export async function indexedSearch(db,{owner,collection,query,limit,mode,matches,semanticError,embedding,minSimilarity,response}){
 const terms=mode==='semantic'?[]:queryTerms(query),semanticIds=[...new Set(matches.map(m=>m.metadata.fact_id))];
 for(let attempt=0;attempt<2;attempt++){
  const rows=await searchSnapshot(db,{owner,collection,terms,semanticIds,needWords:mode!=='semantic'&&terms.length>0});
  const payloads=new WeakMap(),payload=row=>{if(!payloads.has(row))payloads.set(row,JSON.parse(row.payload_json));return payloads.get(row);};
  const pending=rows.filter(r=>r.indexed_version!==r.version||r.indexed_fingerprint!==embedding?.fingerprint).length;
  const byId=new Map(rows.map(r=>[r.id,r])),best=new Map();
  for(const match of matches){
   const row=byId.get(match.metadata.fact_id);if(!row||row.version!==match.metadata.version)continue;
   const count=row.chunk_count??chunkCount(payload(row).content);if(match.chunk>=count)continue;
   if(!best.has(row.id)||best.get(row.id).similarity<match.score)best.set(row.id,{row,similarity:match.score,chunk:match.chunk});
  }
  const semantic=[...best.values()].sort((a,b)=>b.similarity-a.similarity||a.row.id.localeCompare(b.row.id));
  const lexical=mode!=='semantic'&&terms.length?rankDocuments(snapshotDocuments(rows,terms,payload),terms):[];
  let ranked;
  if(mode==='semantic')ranked=semantic.map(item=>({...item,retrieval:{channels:['semantic'],chunk:item.chunk}}));
  else if(mode==='lexical')ranked=lexical.map(item=>({...item,retrieval:{channels:['lexical'],lexical_score:item.score}}));
  else{
   const combined=new Map();
   for(const [channel,list]of[['lexical',lexical],['semantic',semantic]])list.forEach((item,i)=>{
    const r=combined.get(item.row.id)??{row:item.row,score:0,channels:[]};r.score+=1/(60+i+1);r.channels.push(channel);
    if(channel==='semantic'){r.similarity=item.similarity;r.chunk=item.chunk;}else r.lexical_score=item.score;combined.set(item.row.id,r);
   });
   ranked=[...combined.values()].sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id)).map(r=>({...r,retrieval:{channels:r.channels,fusion_score:r.score,...(r.chunk!==undefined&&{chunk:r.chunk}),...(r.lexical_score!==undefined&&{lexical_score:r.lexical_score})}}));
  }
  const selected=ranked.slice(0,limit),hydrated=await hydrateCandidates(db,owner,collection,selected.map(r=>r.row.id));
  const current=new Map(hydrated.filter(r=>isCurrent(r)).map(r=>[r.id,r]));
  const raced=selected.some(item=>current.get(item.row.id)?.version!==item.row.version);
  if(raced&&attempt===0)continue;
  const candidates=[];
  for(const item of selected){
   const row=current.get(item.row.id);if(!row||row.version!==item.row.version)continue;
   if(item.chunk!==undefined&&item.chunk>=chunkCount(JSON.parse(row.payload_json).content))throw new DerivedIndexUnavailable('Derived chunk count disagrees with canonical content');
   candidates.push({...factView(row),...(item.similarity!==undefined&&{similarity:item.similarity}),retrieval:item.retrieval});
  }
  const method=mode==='hybrid'&&semanticError?'lexical':mode;
  return response(candidates,method,pending,{degraded:!!semanticError,...(semanticError&&{semantic_error:semanticError}),...(mode!=='lexical'&&{semantic_min_similarity:minSimilarity})});
 }
}
