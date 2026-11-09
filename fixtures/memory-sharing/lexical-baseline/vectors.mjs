/** Derived identifiers and a shape-checked embedding adapter; no model calls during fact commits. */
import {hash} from './ledger.mjs';
export const vectorId=(owner,collection,id,version,chunk=0)=>hash(JSON.stringify(chunk===0?[owner,collection,id,version]:[owner,collection,id,version,chunk]));
export const namespace=async(owner,collection)=>(await hash(JSON.stringify([owner,collection]))).slice(0,32);
export function embeddingProvider(ai,{model,dimensions,fingerprint}){
 if(!Number.isInteger(dimensions)||dimensions<1||typeof fingerprint!=='string'||!fingerprint||fingerprint.length>100)throw new Error('Invalid embedding configuration');
 const embedMany=async texts=>{
  if(!Array.isArray(texts)||!texts.length||texts.length>32||texts.some(t=>typeof t!=='string'||!t))throw new Error('Invalid embedding input');
  const result=await ai.run(model,{text:texts}),rows=result?.data;
  if(!Array.isArray(rows)||rows.length!==texts.length)throw new Error('Invalid embedding response');
  return rows.map(values=>{
   if((!Array.isArray(values)&&!ArrayBuffer.isView(values))||values.length!==dimensions)throw new Error('Invalid embedding response');
   const copy=new Array(dimensions);let nonzero=false;
   for(let i=0;i<dimensions;i++){
    const value=values[i];
    if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid embedding response');
    copy[i]=value;if(value!==0)nonzero=true;
   }
   if(!nonzero)throw new Error('Invalid embedding response');
   return copy;
  });
 };
 return {dimensions,fingerprint,embedMany,async embed(text){return (await embedMany([text]))[0];}};
}
