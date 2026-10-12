import type { Runtime } from '../runtime';
import type { NormalizedMessage } from '../types';
import { checkpoint,beginPoll,pollFailure,readPollError,clearPollErrorStatement } from './checkpoint';
import {WorkBudgetExceeded, remainingQueries} from '../reliability/budget';
import {ConnectionChangedError,ConnectionCheckFailedError} from '../connection';
const ERROR_KEY='last_msg_poll_error';
export async function pollMessages(rt:Runtime,db:D1Database):Promise<void>{
  const generation=rt.auth.connection_generation;
  await checkpoint(db,'conversations',generation);
  const discovery=await beginPoll(db,'conversations',generation);
  let completed=false;
  if(discovery){
    let page;
    try{page=await rt.client.getConversationsPage(discovery.cursor??undefined);}
    catch(error){
      if(error instanceof WorkBudgetExceeded||error instanceof ConnectionChangedError||error instanceof ConnectionCheckFailedError)throw error;
      await pollFailure(db,ERROR_KEY,error,discovery);
    }
    if(page){
      const t=Date.now();
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO polling_checkpoints(key,generation,boundary,updated_at) SELECT 'messages:'||json_extract(value,'$.id'),?,?,0 FROM json_each(?)`)
          .bind(generation,discovery.boundary,JSON.stringify(page.data)),
        db.prepare(`UPDATE polling_checkpoints SET cursor=?,next_at=?,updated_at=?,failure_count=0,last_error=NULL
          WHERE key='conversations' AND generation=? AND last_attempt_at=?`)
          .bind(page.cursor,page.cursor?0:t+60_000,t,generation,discovery.last_attempt_at),
      ]);
      completed=true;
    }
  }
  const due=await db.prepare(`SELECT key FROM polling_checkpoints WHERE generation=? AND substr(key,1,9)='messages:' AND next_at<=? ORDER BY last_attempt_at,key LIMIT 1`)
    .bind(generation,Date.now()).first<{key:string}>();
  const cp=due?await beginPoll(db,due.key,generation):null;
  if(cp){
    let page;
    try{page=await rt.client.getMessagesPage(cp.key.slice(9),cp.cursor??undefined);}
    catch(error){
      if(error instanceof WorkBudgetExceeded||error instanceof ConnectionChangedError||error instanceof ConnectionCheckFailedError)throw error;
      await pollFailure(db,ERROR_KEY,error,cp);
    }
    if(page){
      const events:NormalizedMessage[]=page.data.flatMap(m=>{
        const ms=m.created_time?Date.parse(m.created_time):NaN;
        if(!m.from?.id||m.from.id===rt.igUserId||!Number.isFinite(ms)||ms<cp.boundary*1000)return [];
        return [{kind:'message',message_id:m.id,igsid:m.from.id,text:m.message,timestamp:Math.floor(ms/1000),timestamp_ms:ms}];
      });
      await rt.engine.ingest(events,'message-poll',{key:cp.key,cursor:page.cursor,boundary:cp.boundary,nextAt:page.cursor?0:Date.now()+60_000,attemptAt:cp.last_attempt_at});
      completed=true;
    }
  }
  if(completed)await db.batch([
    db.prepare(`INSERT INTO kv(key,value,updated_at) VALUES('last_msg_poll_ts',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(String(Math.floor(Date.now()/1000)),Math.floor(Date.now()/1000)),
    clearPollErrorStatement(db,ERROR_KEY,'messages:'),
  ]);
}
export const getPollError=(db:D1Database)=>readPollError(db,ERROR_KEY);
export async function getPollAgeSeconds(db:D1Database):Promise<number|null>{
  const row=await db.prepare("SELECT value FROM kv WHERE key='last_msg_poll_ts'").first<{value:string}>();
  return row?Math.max(0,Math.floor(Date.now()/1000)-Number(row.value)):null;
}
