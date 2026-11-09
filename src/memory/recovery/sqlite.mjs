/** Private local bootstrap adapter. Node SQLite, not a Cloudflare emulator or a public server. */
import {DatabaseSync} from 'node:sqlite';
export class RecoverySqlite {
 constructor(path,{readOnly=false}={}){this.raw=new DatabaseSync(path,{readOnly});this.readOnly=readOnly;this.raw.exec('PRAGMA foreign_keys=ON');}
 prepare(sql){const db=this.raw;const make=(args=[])=>{
  const direct=()=>{const s=db.prepare(sql);if(s.columns().length)return {success:true,results:s.all(...args),meta:{changes:0}};const r=s.run(...args);return {success:true,results:[],meta:{changes:Number(r.changes)}};};
  return {bind:(...values)=>make(values),async first(){return direct().results[0]??null;},async all(){return direct();},async run(){return direct();},direct};};return make();}
 async batch(statements){this.raw.exec(this.readOnly?'BEGIN':'BEGIN IMMEDIATE');try{const rows=statements.map(s=>s.direct());this.raw.exec('COMMIT');return rows;}catch(error){this.raw.exec('ROLLBACK');throw error;}}
 close(){this.raw.close();}
}
