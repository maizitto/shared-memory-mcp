/** Exact normalized-word BM25 contract, shared by canonical fallback and derived statistics. */
const STOP=new Set('a ad al alla alle allo agli ai anche che chi ci coi col come con da dal dalla dalle degli dei del della delle dello di dove e ed è era essere fa fare gli ha hai hanno i il in io la le lo ma mi ne nel nella nelle nello noi non o ogni per più quale quali quando quanto se si sia sono su sul sulla sulle tra un una uno voi the a an and or is of to for in how what when where'.split(' '));
export const LEXICAL_POLICY='nfkd-it-word-bm25-v1';
const normalized=text=>text.normalize('NFKD').replace(/\p{M}/gu,'').toLocaleLowerCase('it');
const WORDS=/[a-z0-9]+(?![\p{L}\p{N}])|[\p{L}\p{N}]+/gu;
export const queryTerms=text=>[...new Set((normalized(text).match(WORDS)??[]).filter(t=>!STOP.has(t)))];
export function documentStatistics(id,payload){
 const words=normalized(id+' '+payload.source+' '+payload.content).match(WORDS)??[],frequencies=Object.create(null);
 for(const word of words)frequencies[word]=(frequencies[word]??0)+1;
 return {length:words.length,frequencies};
}
export function queryDocument(row,terms,payload){
 const c=payload(row),text=normalized(row.id+' '+c.source+' '+c.content),frequency=new Map();
 const wanted=new RegExp('(?<![\\p{L}\\p{N}])(?:'+terms.join('|')+')(?![\\p{L}\\p{N}])','gu');
 for(const word of text.match(wanted)??[])frequency.set(word,(frequency.get(word)??0)+1);
 return {row,length:(text.match(WORDS)??[]).length,frequency};
}
export function rankDocuments(docs,terms){
 if(!terms.length)return [];
 const df=new Map(terms.map(t=>[t,0]));
 for(const d of docs)for(const word of d.frequency.keys())df.set(word,df.get(word)+1);
 const avg=docs.reduce((s,d)=>s+d.length,0)/Math.max(1,docs.length);
 const idf=new Map(terms.map(t=>[t,Math.log(1+(docs.length-df.get(t)+0.5)/(df.get(t)+0.5))]));
 const results=[];
 for(const d of docs){
  let matched=0,score=0;
  for(const term of terms){const tf=d.frequency.get(term)??0;if(!tf)continue;matched++;score+=idf.get(term)*tf*2.2/(tf+1.2*(0.25+0.75*d.length/Math.max(1,avg)));}
  if(matched>=Math.ceil(terms.length/2))results.push({row:d.row,score});
 }
 return results.sort((a,b)=>b.score-a.score||a.row.id.localeCompare(b.row.id));
}
export function lexicalRanks(rows,query,payload){const terms=queryTerms(query);return terms.length?rankDocuments(rows.map(row=>queryDocument(row,terms,payload)),terms):[];}
