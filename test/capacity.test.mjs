import {it,expect} from 'vitest';
import {estimateQueueCapacity} from '../scripts/free-tier-capacity.mjs';

it('includes every scheduling stage, retry and shared-account operations',()=>{
 const result=estimateQueueCapacity({messages:{normalization:100,planning:100,dispatch:400,discovery:10,pollPages:100,maintenance:60,duplicateHints:5},retryReads:20,otherOperations:10,sharedAccountOperations:500});
 expect(result.estimatedQueueOperations).toBe(2855);expect(result.qualifiedFreeTier).toBe(false);
});
it('rejects a 100-thread, 15-minute polling entitlement even before sending a message',()=>{
 const result=estimateQueueCapacity({messages:{pollPages:100*24*4}});
 expect(result.estimatedQueueOperations).toBe(28800);expect(result.withinQueueAllowance).toBe(false);
});
it('rejects misleading fractional, negative and unsafe inputs',()=>{
 for(const value of [-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1])expect(()=>estimateQueueCapacity({messages:{planning:value}})).toThrow();
});
