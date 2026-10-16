import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const kinds=['normalization','planning','dispatch','discovery','pollPages','maintenance','duplicateHints'];
function count(value,name){if(!Number.isSafeInteger(value)||value<0)throw new Error(`${name} must be a nonnegative safe integer`);return value;}
/** Accounting model, never a claim about measured CPU or total service capacity. */
export function estimateQueueCapacity(input){
 const messages=Object.fromEntries(kinds.map(kind=>[kind,count(input.messages?.[kind]??0,kind)]));
 const totalMessages=Object.values(messages).reduce((a,b)=>a+b,0);
 const retryReads=count(input.retryReads??0,'retryReads');
 const otherOperations=count(input.otherOperations??0,'otherOperations');
 const sharedAccountOperations=count(input.sharedAccountOperations??0,'sharedAccountOperations');
 const operations=totalMessages*3+retryReads+otherOperations+sharedAccountOperations;
 if(!Number.isSafeInteger(operations))throw new Error('Operation total exceeds safe integer range');
 return {messages,totalMessages,retryReads,otherOperations,sharedAccountOperations,estimatedQueueOperations:operations,
  dailyQueueAllowance:10000,remainingQueueOperations:10000-operations,withinQueueAllowance:operations<=10000,
  qualifiedFreeTier:false,
  assumptions:'One small message = write + read + delete. Retries add reads. Include all continuations, duplicate writes, publication ambiguity, other account traffic and maintenance. D1/CPU/storage/provider/backlog qualification is separate.'};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.argv[2])throw new Error('Usage: node scripts/free-tier-capacity.mjs <workload.json>');
 console.log(JSON.stringify(estimateQueueCapacity(JSON.parse(readFileSync(process.argv[2],'utf8'))),null,2));
}
