import {useState} from 'react';
import {api} from './lib/api';
import {useResource} from './hooks/use-resource';
import {Button} from './components/ui/button';
import {Failure} from './components/shared';
interface Safety {
 status:{enabled:number;hold_reason:string|null;pending_events:number;pending_jobs:number;unknown_jobs:number;rejected_jobs:number;attempts:number;confirmed_jobs:number;oldest_pending_at:number|null;oldest_event_at:number|null;last_ingested_at:number|null;build_revision:string;recipient_holds:number;failed_conversations?:number;closed_conversations?:number};
 jobs:{id:string;campaign_id:string;recipient:string;action:string;status:string;error:string|null;trace_id:string|null;created_at:number;campaign_suspended?:number;can_close_unresolved?:number}[];
 conflicts:{campaign_id:string;media_id:string}[];maintenance:boolean;next_offset:number|null;
 health:{connected:boolean;token_expired:boolean;generation:number|null;polling_enabled:boolean;poll:Record<string,string>;poll_failures?:{key:string;failure_count:number;next_at:number}[]};build_revision:string;
}
export function AutomationSafety(){
 const [revision,setRevision]=useState(0),[verified,setVerified]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [offset,setOffset]=useState(0);
 const resource=useResource<Safety>(`/api/automation?offset=${offset}`,revision);
 async function change(path:string,body:unknown){if(busy)return;setBusy(true);setError('');try{await api(path,{method:'POST',body});setRevision(n=>n+1);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 if(!resource.data)return <section><h3>Automation safety</h3>{resource.error&&<Failure message={resource.error}/>}</section>;
 const {status,jobs,conflicts,maintenance,health}=resource.data;
 const date=(value:string|number|undefined)=>value?new Date(typeof value==='string'?Number(value)*1000:value).toLocaleString():'Not yet';
 return <section className="automation-safety" aria-label="Automation safety"><h3>Automation safety</h3>
  <p>Instagram: {health.connected?health.token_expired?'Token expired':'Connected':'Disconnected'} · Connection {health.generation??'—'}</p>
  <p>Polling: {health.polling_enabled?'Enabled':'Disabled'} · Last messages: {date(health.poll.last_msg_poll_ts)} · Last comments: {date(health.poll.last_comment_poll_ts)}</p>
  <p>Last ingestion: {date(status.last_ingested_at??undefined)} · Oldest pending event: {date(status.oldest_event_at??undefined)}</p>
  {['last_msg_poll_error','last_comment_poll_error'].filter(key=>health.poll[key]).map(key=><p role="alert" key={key}>Polling needs attention ({key.includes('comment')?'comments':'messages'}). Details: {health.poll[key]}</p>)}
  {health.poll_failures?.map(cp=><p key={cp.key}>Polling {cp.key}: {cp.failure_count} failed reads. Next retry: {date(cp.next_at)}.</p>)}
  <p>{maintenance?'Maintenance hold':status.enabled?'Sending enabled':'Sending disabled'}{status.hold_reason?` · ${status.hold_reason}`:''}</p>
  <p>{status.pending_events} pending events · {status.pending_jobs} pending sends · {status.unknown_jobs} uncertain · {status.rejected_jobs} rejected</p>
  <p>{status.confirmed_jobs} confirmed sends from {status.attempts} attempts · {status.recipient_holds} recipient holds</p>
  <p>{status.failed_conversations??0} failed conversations · {status.closed_conversations??0} closed unresolved</p>
  {status.oldest_pending_at&&<p>Oldest pending send: {new Date(status.oldest_pending_at).toLocaleString()}</p>}
  <p>Pausing an automation holds its existing conversations. Requests already in flight may finish.</p>
  {conflicts.length>0&&<p role="alert">Choose one active automation for each conflicting post: {conflicts.map(c=>c.campaign_id).join(', ')}. Activate your choice in Automations.</p>}
  {!status.enabled&&<label><input type="checkbox" checked={verified} onChange={e=>setVerified(e.target.checked)}/> I completed the documented cutover checks and verified sending with a test Instagram account.</label>}
  <div><Button disabled={busy||maintenance||(!status.enabled&&!verified)} onClick={()=>change('/api/automation/control',{enabled:!status.enabled,verified})}>{status.enabled?'Stop all sending':'Enable sending'}</Button> <Button variant="outline" disabled={busy} onClick={()=>setRevision(n=>n+1)}>Refresh</Button></div>
  {error&&<Failure message={error}/>}
  <ul>{jobs.map(job=><li key={job.id}><p><strong>{job.campaign_id}</strong> · {job.recipient} · {job.action} · {job.status}{job.campaign_suspended?' · Campaign paused or archived':''}</p><p>{job.error}{job.trace_id?` · Trace ${job.trace_id}`:''}</p>
    {(job.status==='unknown'||!!job.can_close_unresolved)&&<div><p>Check the Instagram thread before confirming receipt. Closing leaves this action unresolved; neither action resends the DM.</p>{job.status==='unknown'&&<Button disabled={busy} onClick={()=>change('/api/automation/resolve',{job_id:job.id,action:'confirm_received'})}>I verified receipt</Button>} <Button variant="outline" disabled={busy} onClick={()=>change('/api/automation/resolve',{job_id:job.id,action:'close_unresolved'})}>Close unresolved</Button></div>}</li>)}</ul>
  <div><Button variant="outline" disabled={busy||offset===0} onClick={()=>setOffset(Math.max(0,offset-100))}>Previous</Button> <Button variant="outline" disabled={busy||resource.data.next_offset===null} onClick={()=>setOffset(resource.data!.next_offset!)}>Next</Button></div>
  <small>Build {resource.data.build_revision}</small>
 </section>;
}
