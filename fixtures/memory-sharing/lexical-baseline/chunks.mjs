/** Bounded, Unicode-safe text windows; source text and versions remain in D1. */
export const CHUNK_POLICY = 'chars320-overlap64-v1';
export const MAX_CHUNKS = 32;
const SIZE=320,STRIDE=256;
/** Count Unicode code points without allocating every window; matches chunkText, including lone surrogates. */
export function chunkCount(content) {
 const length=content.length-(content.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length??0);
 const count=length===0?0:1+Math.max(0,Math.ceil((length-SIZE)/STRIDE));
 if(count>MAX_CHUNKS)throw new Error('Too many chunks');
 return count;
}
export function chunkText(content) {
 const chars=Array.from(content),chunks=[];
 for(let start=0;start<chars.length;start+=STRIDE){
  chunks.push(chars.slice(start,start+SIZE).join(''));
  if(start+SIZE>=chars.length)break;
 }
 if(chunks.length>MAX_CHUNKS)throw new Error('Too many chunks');
 return chunks;
}
