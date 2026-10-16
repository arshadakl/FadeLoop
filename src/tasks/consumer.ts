import type {Env} from '../types';
import {buildRuntime,pollIntervalSeconds} from '../runtime';
import {budgetDatabase,remainingQueries,WorkBudgetExceeded} from '../reliability/budget';
import {claimTask,settleTask,deferTask,publishTasks,type Notification} from './store';
import {normalizeEnvelope} from './ingress';
import {pollTask} from './poll';
import {ConnectionChangedError} from '../connection';

export async function consumeTasks(batch:MessageBatch<Notification>,environment:Env):Promise<void>{
  if(environment.EXECUTION_MODE!=='tasks'){for(const message of batch.messages)message.retry({delaySeconds:60});return;}
  const [message,...extra]=batch.messages;
  // Misconfigured batching must not combine ten tasks into one CPU allowance.
  for(const item of extra)item.retry({delaySeconds:30});
  if(!message)return;
  const value=message.body;
  if(!value||value.schema!==1||typeof value.taskId!=='string'||value.taskId.length>1024||!Number.isSafeInteger(value.generation)){message.ack();return;}
  const env={...environment,DB:budgetDatabase(environment.DB,40)},rt=await buildRuntime(env,true);
  if(!rt||rt.auth.connection_generation!==value.generation){message.ack();return;}
  const task=await claimTask(rt.db,value.taskId,value.generation);if(!task){message.ack();return;}
  try{
    let next:number|undefined;
    switch(task.kind){
      case 'normalize':next=await normalizeEnvelope(rt,task);break;
      case 'plan':next=await rt.engine.planEvent(task.reference);break;
      case 'dispatch':{
        await rt.engine.dispatchOne(task.reference);
        const job=await rt.db.prepare('SELECT status,next_at FROM outbound_jobs WHERE id=? AND generation=?').bind(task.reference,task.generation).first<{status:string;next_at:number}>();
        if(job&&['pending','held','retry_scheduled'].includes(job.status))next=Math.max(Date.now()+2000,job.next_at);
        break;
      }
      case 'comments':case 'messages':{
        const interval=pollIntervalSeconds(env);
        if(interval===null||rt.auth.expires_at<=Math.floor(Date.now()/1000))next=Date.now()+60_000;
        else next=await pollTask(rt,task,interval);
        break;
      }
      default:throw new Error('Unsupported durable task kind');
    }
    await settleTask(rt.db,task,next);
    message.ack();
    if(remainingQueries(env.DB)>=4)try{await publishTasks(env,rt.db,task.generation,1);}catch{console.warn('[FadeLoop] task notification retained for recovery');}
  }catch(error){
    if(error instanceof ConnectionChangedError){message.ack();return;}
    console.warn('[FadeLoop] durable task deferred',task.kind,error instanceof WorkBudgetExceeded?'work-budget':'execution-failed');
    try{await deferTask(rt.db,task,error instanceof WorkBudgetExceeded?'Work budget reached; continuation retained':'Task failed; inspect sanitized worker logs');message.ack();}
    catch{message.retry({delaySeconds:60});}
  }
}
