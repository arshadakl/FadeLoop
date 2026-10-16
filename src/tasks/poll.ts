import type {Runtime} from '../runtime';
import type {Task} from './store';
import {taskStatement} from './store';
import {checkpoint,beginPoll,pollFailure} from '../poller/checkpoint';
import {ProviderRequestNotStarted} from '../api/client';
import {ConnectionChangedError} from '../connection';
import {WorkBudgetExceeded} from '../reliability/budget';
import type {NormalizedEvent} from '../types';

/** One object/page per task. Pagination is durable and independent across poll kinds. */
export async function pollTask(rt:Runtime,task:Task,interval:number):Promise<number>{
  const db=rt.db,key=task.kind==='comments'?`comments:${task.reference}`:task.reference;
  await checkpoint(db,key,task.generation);
  const cp=await beginPoll(db,key,task.generation);if(!cp)return Date.now()+60_000;
  const errorKey=task.kind==='comments'?'last_comment_poll_error':'last_msg_poll_error';
  try{
    if(key==='conversations'){
      const page=await rt.client.getConversationsPage(cp.cursor??undefined,10),t=Date.now();
      // Ten discovered threads at most; task intents and discovery cursor commit together.
      await db.batch([
        db.prepare(`INSERT OR IGNORE INTO polling_checkpoints(key,generation,boundary,updated_at)
          SELECT 'messages:'||json_extract(value,'$.id'),?,?,0 FROM json_each(?)`).bind(task.generation,cp.boundary,JSON.stringify(page.data)),
        ...page.data.map(thread=>taskStatement(db,'messages',task.generation,`messages:${thread.id}`)),
        db.prepare(`UPDATE polling_checkpoints SET cursor=?,next_at=?,updated_at=?,failure_count=0,last_error=NULL WHERE key=? AND generation=? AND last_attempt_at=?`)
          .bind(page.cursor,page.cursor?0:t+interval*1000,t,key,task.generation,cp.last_attempt_at),
      ]);
      return page.cursor?t:t+interval*1000;
    }
    if(task.kind==='comments'){
      const active=await db.prepare('SELECT 1 FROM campaigns WHERE media_id=? AND active=1 AND archived_at IS NULL').bind(task.reference).first();
      if(!active)return Date.now()+interval*1000;
    }
    const page=task.kind==='comments'?await rt.client.getCommentsPage(task.reference,cp.cursor??undefined,10):await rt.client.getMessagesPage(key.slice(9),cp.cursor??undefined,10);
    const events:NormalizedEvent[]=[];
    for(const item of page.data as unknown as Record<string,any>[]){
      const ms=Date.parse(task.kind==='comments'?item.timestamp:item.created_time),from=item.from?.id;
      if(!Number.isFinite(ms)||ms<cp.boundary*1000||from===rt.igUserId)continue;
      if(task.kind==='comments')events.push({kind:'comment',comment_id:item.id,igsid:from??'',username:item.from?.username??item.username,media_id:task.reference,text:item.text??'',timestamp:Math.floor(ms/1000),timestamp_ms:ms});
      else if(typeof from==='string')events.push({kind:'message',message_id:item.id,igsid:from,text:item.message,timestamp:Math.floor(ms/1000),timestamp_ms:ms});
    }
    const next=page.cursor?Date.now():Date.now()+interval*1000;
    await rt.engine.ingest(events,task.kind==='comments'?'comment-poll':'message-poll',{key,cursor:page.cursor,boundary:cp.boundary,nextAt:next,attemptAt:cp.last_attempt_at},[
      db.prepare(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(task.kind==='comments'?'last_comment_poll_ts':'last_msg_poll_ts',String(Math.floor(Date.now()/1000)),Math.floor(Date.now()/1000)),
    ]);
    return next;
  }catch(error){
    if(error instanceof WorkBudgetExceeded||error instanceof ConnectionChangedError||error instanceof ProviderRequestNotStarted)throw error;
    await pollFailure(db,errorKey,error,cp);
    const failed=await db.prepare('SELECT next_at FROM polling_checkpoints WHERE key=? AND generation=?').bind(key,task.generation).first<{next_at:number}>();
    return failed?.next_at??Date.now()+60_000;
  }
}
