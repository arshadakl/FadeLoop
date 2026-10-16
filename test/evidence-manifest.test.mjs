import {it,expect} from 'vitest';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {evidenceManifest,verifyEvidenceManifest} from '../scripts/evidence-manifest.mjs';

it('rejects changed source identity and changed bundles without treating local evidence as deployed CPU',()=>{
 mkdirSync('.wrangler',{recursive:true});const dir=mkdtempSync('.wrangler/evidence-unit-'),bundle=dir+'/worker.js';
 try{
  writeFileSync(bundle,'fixture');const manifest=evidenceManifest(bundle,{AUTH_MODE:'password'});
  expect(verifyEvidenceManifest(manifest,bundle)).toMatchObject({matches:true,production_cpu_measured:false});
  const altered=structuredClone(manifest);altered.source_files['src/index.ts']='different';
  expect(verifyEvidenceManifest(altered,bundle)).toMatchObject({matches:false,differences:['src/index.ts']});
  writeFileSync(bundle,'changed');expect(verifyEvidenceManifest(manifest,bundle)).toMatchObject({matches:false,differences:['worker-bundle']});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
