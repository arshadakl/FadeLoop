import type { Runtime } from '../runtime';
import type { NormalizedComment } from '../types';
import { checkpoint,beginPoll,clearPollErrorStatement,pollFailure,readPollError } from './checkpoint';
import {WorkBudgetExceeded} from '../reliability/budget';
import {ConnectionChangedError,ConnectionCheckFailedError} from '../connection';
const ERROR_KEY='last_comment_poll_error';
export async function pollComments(rt:Runtime,db:D1Database):Promise<void>{
  const row=await db.prepare(`SELECT p.media_id FROM campaigns p LEFT JOIN polling_checkpoints c ON c.key='comments:'||p.media_id
    WHERE p.active=1 AND p.archived_at IS NULL AND COALESCE(c.next_at,0)<=? ORDER BY COALESCE(c.last_attempt_at,0),p.media_id LIMIT 1`).bind(Date.now()).first<{media_id:string}>();
  if(!row)return;
  const key=`comments:${row.media_id}`,generation=rt.auth.connection_generation;
  await checkpoint(db,key,generation);
  const cp=await beginPoll(db,key,generation);if(!cp)return;
  let page;
  try{page=await rt.client.getCommentsPage(row.media_id,cp.cursor??undefined);}
  catch(error){if(error instanceof WorkBudgetExceeded||error instanceof ConnectionChangedError||error instanceof ConnectionCheckFailedError)throw error;await pollFailure(db,ERROR_KEY,error,cp);return;}
  const events:NormalizedComment[]=page.data.flatMap(c=>{
    const timestamp=c.timestamp?Math.floor(Date.parse(c.timestamp)/1000):0;
    if(c.from?.id===rt.igUserId||!Number.isFinite(timestamp)||timestamp<cp.boundary)return [];
    return [{kind:'comment',comment_id:c.id,igsid:c.from?.id??'',username:c.from?.username??c.username,text:c.text??'',media_id:row.media_id,timestamp,timestamp_ms:Date.parse(c.timestamp!)}];
  });
  await rt.engine.ingest(events,'comment-poll',{key:cp.key,cursor:page.cursor,boundary:cp.boundary,nextAt:page.cursor?0:Date.now()+60_000,attemptAt:cp.last_attempt_at});
  await db.batch([
    clearPollErrorStatement(db,ERROR_KEY,'comments:'),
    db.prepare("INSERT INTO kv(key,value,updated_at) VALUES('last_comment_poll_ts',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(String(Math.floor(Date.now()/1000)),Math.floor(Date.now()/1000)),
  ]);
}
export const getCommentPollError=(db:D1Database)=>readPollError(db,ERROR_KEY);
