/** Opt-in cloud adapter. Merely importing it never calls AI/Vectorize or modifies deployment settings. */
import {embeddingProvider} from './vectors.mjs';
import {CHUNK_POLICY} from './chunks.mjs';
import {identifier} from './ledger.mjs';
import {runIndexJob} from './indexer.mjs';
import {indexLexicalTick} from './lexical-index.mjs';
import {primary} from '../platform/d1.mjs';
const unavailable=async()=>{throw new Error('semantic search not configured');};
const disabled=()=>({embedding:{fingerprint:'none',embed:unavailable},vectors:{},defaultSearchMode:'semantic'});
export const MEMORY_MODEL='@cf/baai/bge-m3',MEMORY_DIMENSIONS=1024;
export const MEMORY_FINGERPRINT=`bge-m3-1024:${CHUNK_POLICY}`;
/** Model-specific threshold is deliberately required; the local MiniLM calibration is not a BGE calibration. */
function configured(env){
 if(!env.AI?.run||!env.MEMORY_VECTORS?.query||!env.MEMORY_VECTORS?.upsert||!env.MEMORY_VECTORS?.deleteByIds)throw new Error('missing memory search bindings');
 if(env.MEMORY_VECTORS===env.VECTORIZE)throw new Error('memory requires a separate vector index');
 if(typeof env.MEMORY_MIN_SIMILARITY!=='string'||!env.MEMORY_MIN_SIMILARITY.trim())throw new Error('threshold required');
 const minSimilarity=Number(env.MEMORY_MIN_SIMILARITY);
 if(!Number.isFinite(minSimilarity)||minSimilarity<0||minSimilarity>1)throw new Error('invalid threshold');
 const semanticCollections=String(env.MEMORY_SEARCH_COLLECTIONS??'').split(',').map(c=>c.trim());
 if(!semanticCollections[0]||semanticCollections.length>8||new Set(semanticCollections).size!==semanticCollections.length)throw new Error('collections required');
 semanticCollections.forEach(identifier);
 return {lexicalIndex:env.MEMORY_LEXICAL_ENABLED==='true',semanticCollections,embedding:embeddingProvider(env.AI,{model:MEMORY_MODEL,dimensions:MEMORY_DIMENSIONS,fingerprint:MEMORY_FINGERPRINT}),vectors:env.MEMORY_VECTORS,minSimilarity,defaultSearchMode:'hybrid'};
}
export function memorySearch(env){
 if(env.MEMORY_SEARCH_ENABLED!=='true')return disabled();
 try{return configured(env);}catch{return {...disabled(),defaultSearchMode:'hybrid'};}
}
/** One committed job per explicitly configured scheduled invocation; no cron is installed by this module. */
export async function indexMemoryTick(env){
 if(env.MEMORY_SEARCH_ENABLED!=='true')return {status:'disabled'};
 let runtime,owner,collections;
 try{
  runtime=configured(env);
  if(env.MEMORY_REVIEW_ENABLED!=='true'||!/^[1-9][0-9]{0,15}$/.test(env.GITHUB_OWNER_ID??''))throw new Error('owner required');
  owner=`github-${env.GITHUB_OWNER_ID}`;identifier(owner);
  collections=String(env.MEMORY_SEARCH_COLLECTIONS??'').split(',').map(c=>c.trim());
  const allowed=String(env.MEMORY_REVIEW_COLLECTIONS??'').split(',').map(c=>c.trim());
  if(!collections[0]||collections.length>8||new Set(collections).size!==collections.length)throw new Error('collections required');
  for(const collection of collections){identifier(collection);if(!allowed.includes(collection))throw new Error('collection outside review config');}
 }catch{return {status:'configuration_unavailable'};}
 const db=primary(env.DB),result=await runIndexJob(db,{...runtime,owner_id:owner,collections});
 if(result.status==='idle'&&runtime.lexicalIndex)return indexLexicalTick(db,{owner_id:owner,collections});
 return result;
}
