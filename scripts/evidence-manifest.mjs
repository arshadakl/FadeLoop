import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';

const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function files(root){return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
 const file=`${root}/${entry.name}`;
 return entry.isDirectory()?files(file):[file];
});}
/** No .env, credentials, remote bindings or working-tree contents are emitted. */
export function evidenceManifest(bundle,publicConfig){
 const paths=[...files('src'),...files('schema'),...files('frontend/src'),...files('scripts'),
  'package.json','package-lock.json','wrangler.toml'].sort();
 const source_files=Object.fromEntries(paths.map(file=>[file,hash(file)]));
 let commit=null;try{commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 return {generated_at:new Date().toISOString(),environment:'local-disposable-workerd',production_cpu_measured:false,
  commit,source_tree_sha256:createHash('sha256').update(JSON.stringify(source_files)).digest('hex'),source_files,
  bundle_sha256:hash(bundle),schema_files:paths.filter(p=>p.startsWith('schema/')),public_fixture_config:publicConfig};
}

/** Evidence consumers must check this before treating a report as current. */
export function verifyEvidenceManifest(manifest,bundle){
 const current=evidenceManifest(bundle,manifest.public_fixture_config);
 const differences=[];
 for(const file of new Set([...Object.keys(current.source_files),...Object.keys(manifest.source_files??{})])){
  if(current.source_files[file]!==manifest.source_files?.[file])differences.push(file);
 }
 if(current.bundle_sha256!==manifest.bundle_sha256)differences.push('worker-bundle');
 if(current.source_tree_sha256!==manifest.source_tree_sha256&&!differences.length)differences.push('source-manifest');
 return {matches:differences.length===0,differences,production_cpu_measured:false};
}
