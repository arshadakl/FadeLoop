import {describe,it,expect} from 'vitest';
import {handleApi} from '../src/routes/api';
import {handleConfigImport} from '../src/routes/config';
import {makeTestDbWithHandle} from './helpers/fakeD1';
import type {Env} from '../src/types';

function request(path:string,text:string){
  // No Content-Length: the ceiling must apply while streaming too.
  return new Request('https://fixture.test'+path,{method:'POST',headers:{'content-type':'application/json'},body:text});
}
describe('owner write operation bounds',()=>{
  it('rejects oversized campaign, folder and import requests before database work',async()=>{
    const {db,raw}=makeTestDbWithHandle(),env={DB:db} as Env;
    for(const path of ['/api/campaigns','/api/folders','/api/automation/control']){
      const req=request(path,JSON.stringify({text:'x'.repeat(33*1024)}));
      expect((await handleApi(env,req,new URL(req.url))).status).toBe(413);
    }
    expect((await handleConfigImport(env,request('/config/import','x'.repeat(65*1024)))).status).toBe(413);
    expect(raw.prepare('SELECT COUNT(*) n FROM campaigns').get()).toMatchObject({n:0});
  });
  it('returns validation errors for null or array write bodies instead of throwing',async()=>{
    const {db}=makeTestDbWithHandle(),env={DB:db} as Env;
    for(const path of ['/api/campaigns','/api/campaigns/status','/api/campaigns/archive','/api/campaigns/delete']){
      for(const body of ['null','[]']){
        const req=request(path,body);
        expect((await handleApi(env,req,new URL(req.url))).status).toBe(400);
      }
    }
  });
});
