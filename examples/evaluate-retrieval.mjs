/** Offline development-fixture comparison. No live inference and no personal-data discovery. */
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {LocalD1,localSearch,writer,reviewer} from '../test/memory/testkit.mjs';
import {proposeFact,approveProposal,commitProposal} from '../src/memory/ledger.mjs';
import {runIndexJob,searchFacts} from '../src/memory/indexer.mjs';

const args=process.argv.slice(2),options={};
for(let i=0;i<args.length;i+=2){if(!['--dataset','--vectors'].includes(args[i])||!args[i+1]||options[args[i]])throw new Error('Use --dataset PATH --vectors PATH, or no options for fictional fixtures.');options[args[i]]=args[i+1];}
if(Boolean(options['--dataset'])!==Boolean(options['--vectors']))throw new Error('A custom dataset requires its own precomputed vectors.');
const custom=Boolean(options['--dataset']);
const vectors=JSON.parse(await readFile(custom?options['--vectors']:new URL('../fixtures/embeddings/second-brain.json',import.meta.url),'utf8'));
const t=JSON.parse(await readFile(new URL('../fixtures/memory-sharing/second-brain.json',import.meta.url),'utf8')).texts;
const dataset=custom?JSON.parse(await readFile(options['--dataset'],'utf8')):{
  facts:[['preference',t.preference],['logo',t.distractor1],['writing',t.distractor2],['recipe',t.distractor3],['language',t.retry],['export',t.outage]].map(([id,content])=>({id,content})),
  queries:[['keyword',t.keyword,['preference']],['paraphrase',t.paraphrase,['preference']],['language',t.retryQuery,['language']],['export',t.outageQuery,['export']],['no-approved-match',t.proposal,[]]].map(([id,query,relevant])=>({id,query,relevant})),min_similarity:0.5
};
if(!Array.isArray(dataset.facts)||!dataset.facts.length||dataset.facts.length>200||!Array.isArray(dataset.queries)||!dataset.queries.length||dataset.queries.length>200)throw new Error('Dataset needs 1..200 facts and labelled queries.');
const ids=new Set(dataset.facts.map(f=>f.id));
if(ids.size!==dataset.facts.length||dataset.facts.some(f=>typeof f.content!=='string')||dataset.queries.some(q=>typeof q.id!=='string'||typeof q.query!=='string'||!Array.isArray(q.relevant)||q.relevant.some(id=>!ids.has(id))))throw new Error('Invalid dataset IDs or relevance labels.');
if(!Number.isFinite(dataset.min_similarity)||dataset.min_similarity<0||dataset.min_similarity>1)throw new Error('Provide an explicit min_similarity between zero and one.');
for(const text of [...dataset.facts.map(f=>f.content),...dataset.queries.map(q=>q.query)])if(!Array.isArray(vectors.vectors?.[text])||vectors.vectors[text].length!==vectors.dimensions||vectors.vectors[text].some(v=>!Number.isFinite(v)))throw new Error('Every text/query needs a matching finite precomputed embedding.');
const db=await new LocalD1().init(),principal=writer(),search=localSearch(vectors),results=[];
try {
  for(const fact of dataset.facts){const p=await proposeFact(db,principal,{collection:'shared',request_id:fact.id,fact_id:fact.id,operation:'put',expected_version:0,content:fact.content,source:'explicit retrieval evaluation',observed_at:'2020-01-01',valid_from:'2020-01-01'});await approveProposal(db,reviewer,{collection:'shared',proposal_id:p.proposal_id,expected_digest:p.digest});await commitProposal(db,principal,{collection:'shared',proposal_id:p.proposal_id},'put');}
  for(let i=0;i<dataset.facts.length;i++){const result=await runIndexJob(db,search);if(result.status!=='indexed')throw new Error('Fixture indexing failed.');}
  for(const mode of ['lexical','semantic','hybrid']){
    const rows=[];const start=performance.now();
    for(const q of dataset.queries){const r=await searchFacts(db,principal,{collection:'shared',query:q.query,mode,limit:3},{...search,minSimilarity:dataset.min_similarity});const hits=r.candidates.map(c=>c.id),rank=hits.findIndex(id=>q.relevant.includes(id));rows.push({query_id:q.id,result_ids:hits,positive_query:q.relevant.length>0,hit_at_3:rank>=0,reciprocal_rank:rank<0?0:1/(rank+1)});}
    const positives=rows.filter(r=>r.positive_query),negatives=rows.filter(r=>!r.positive_query);
    results.push({mode,positive_queries:positives.length,negative_queries:negatives.length,hit_at_3:positives.length?positives.reduce((s,r)=>s+Number(r.hit_at_3),0)/positives.length:null,mrr_at_3:positives.length?positives.reduce((s,r)=>s+r.reciprocal_rank,0)/positives.length:null,negative_queries_with_results:negatives.filter(r=>r.result_ids.length).length,elapsed_local_ms:Math.round((performance.now()-start)*100)/100,rows});
  }
  console.log(JSON.stringify({scope:{fictional_default:!custom,development_fixture_only:!custom,held_out_quality_claim:false,live_inference:false,cloud_cost_or_latency_measured:false,content_printed:false,facts:dataset.facts.length,queries:dataset.queries.length,model:vectors.model,dimensions:vectors.dimensions,min_similarity:dataset.min_similarity},results},null,2));
}finally{db.close();}
