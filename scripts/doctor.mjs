#!/usr/bin/env node
/** Offline validation only: no account discovery, secret loading, requests or deployment. */
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {reviewConfig} from '../src/memory/review/identity.mjs';
import {authConfig} from '../src/auth/config.mjs';

export function inspectConfig(config) {
  const errors=[],warnings=['worker_secret_not_checked','account_plan_and_resource_existence_not_checked'];
  const vars=config?.vars??{},bindings=Array.isArray(config?.d1_databases)?config.d1_databases:[];
  const bad=code=>errors.push(code);
  if(typeof vars!=='object'||vars===null||Array.isArray(vars))return {ok:false,errors:['invalid_vars_object'],warnings};
  if (!config || typeof config!=='object' || Array.isArray(config)) return {ok:false,errors:['invalid_config'],warnings};
  if (Object.keys(vars).some(k=>/secret|token|password|private.?key/i.test(k))) bad('secret_like_variable_in_file');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name??'')) bad('worker_name_required');
  const db=bindings.filter(d=>d.binding==='DB');
  if (db.length!==1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(db[0]?.database_id??'') || /^0+-0+-0+-0+-0+$/.test(db[0]?.database_id??'')
      || !/^[a-z0-9-]{1,64}$/.test(db[0]?.database_name??'')) bad('database_binding_or_placeholder');
  let identity;
  try {identity=reviewConfig({...vars,DB:{},GITHUB_CLIENT_SECRET:'offline-validation-only'});}catch{bad('owner_origin_or_collection_config_invalid');}
  if (/REPLACE|YOUR_|example\.invalid/i.test([vars.GITHUB_CLIENT_ID,vars.MEMORY_PUBLIC_ORIGIN].join(' '))) bad('configuration_placeholders_remain');
  const limiters=Array.isArray(config.ratelimits)?config.ratelimits:[];
  for (const name of ['AUTH_LOGIN_LIMIT','AUTH_API_LIMIT']) {
    const found=limiters.filter(x=>x.name===name),r=found[0];
    if(found.length!==1 || !/^[1-9][0-9]*$/.test(String(r?.namespace_id??'')) || !Number.isSafeInteger(Number(r?.namespace_id))
      || !Number.isInteger(r?.simple?.limit) || r.simple.limit<1 || ![10,60].includes(r.simple.period)) bad(name.toLowerCase()+'_invalid');
  }
  if(new Set(limiters.map(x=>String(x.namespace_id))).size!==limiters.length) bad('rate_limit_namespace_collision');
  for(const name of ['MEMORY_ENABLED','MEMORY_REVIEW_ENABLED','AUTH_GUARDS_REQUIRED','MEMORY_OAUTH_ENABLED','MEMORY_SEARCH_ENABLED','MEMORY_LEXICAL_ENABLED']) {
    if(!['true','false'].includes(vars[name])) bad(name.toLowerCase()+'_must_be_boolean_string');
  }
  if(vars.AUTH_GUARDS_REQUIRED!=='true'||vars.MEMORY_REVIEW_ENABLED!=='true') bad('mandatory_review_or_guards_disabled');
  if(vars.MEMORY_ENABLED!=='true') warnings.push('memory_disabled');
  if(vars.MEMORY_OAUTH_ENABLED==='true') {
    const kv=(Array.isArray(config.kv_namespaces)?config.kv_namespaces:[]).filter(x=>x.binding==='OAUTH_KV');
    if(kv.length!==1||!/^[a-f0-9]{32}$/i.test(kv[0]?.id??'')||/^0+$/.test(kv[0]?.id??'')) bad('oauth_kv_binding_or_placeholder');
    if(!config.compatibility_flags?.includes('global_fetch_strictly_public')) bad('oauth_public_fetch_flag_missing');
    try {authConfig({...vars,DB:{},OAUTH_KV:{},GITHUB_CLIENT_SECRET:'offline-validation-only'});}catch{bad('oauth_collection_config_invalid');}
  }
  if(vars.MEMORY_SEARCH_ENABLED==='true') {
    if(config.ai?.binding!=='AI'||!(Array.isArray(config.vectorize)?config.vectorize:[]).some(x=>x.binding==='MEMORY_VECTORS'&&x.index_name)) bad('semantic_bindings_missing');
    if(!config.triggers?.crons?.length) bad('semantic_schedule_missing');
    if(!vars.MEMORY_MIN_SIMILARITY||!Number.isFinite(Number(vars.MEMORY_MIN_SIMILARITY))||Number(vars.MEMORY_MIN_SIMILARITY)<0||Number(vars.MEMORY_MIN_SIMILARITY)>1) bad('semantic_threshold_missing_or_invalid');
    const selected=String(vars.MEMORY_SEARCH_COLLECTIONS??'').split(',').map(x=>x.trim());
    if(!selected[0]||new Set(selected).size!==selected.length||selected.some(c=>!identity?.collections.includes(c))) bad('semantic_collection_config_invalid');
    warnings.push('vector_dimensions_metadata_indexes_and_cost_not_checked');
  } else if(config.triggers?.crons?.length) warnings.push('cron_configured_while_semantic_disabled');
  if(!config.workers_dev&&!config.routes?.length) warnings.push('no_public_route_selected');
  if(config.preview_urls!==false) warnings.push('preview_urls_not_explicitly_disabled');
  const callbacks=identity?[identity.callback,...(vars.MEMORY_OAUTH_ENABLED==='true'?[identity.origin+'/oauth/github/callback']:[])]:[];
  return {ok:errors.length===0,errors:[...new Set(errors)],warnings,github_exact_callbacks_to_check:callbacks,
    scope:'offline_config_only',secret_store_or_account_accessed:false};
}
async function main() {
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--config') throw new Error('usage: npm run doctor -- --config PATH_TO_JSON_CONFIG');
  let config;try{config=JSON.parse(await readFile(args[1],'utf8'));}catch{throw new Error('Cannot read JSON config; file contents were not printed.');}
  const result=inspectConfig(config);console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
