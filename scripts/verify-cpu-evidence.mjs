import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {verifyEvidenceManifest} from './evidence-manifest.mjs';

const file=resolve(process.argv[2]??'.wrangler/cpu-investigation/results.json');
const report=JSON.parse(readFileSync(file,'utf8'));
if(!report.manifest)throw new Error('Legacy baseline has no current build manifest; regenerate local evidence');
const verification=verifyEvidenceManifest(report.manifest,resolve(dirname(file),'worker.js'));
console.log(JSON.stringify(verification,null,2));
if(!verification.matches)process.exitCode=1;
else console.log('Local source/bundle match. This does not certify deployed CPU or production configuration.');
