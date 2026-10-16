import type {NormalizedEvent} from '../types';
/** Only content events enter the engine. Provider times remain authoritative. */
export function normalizeWebhook(body:unknown,owner:string):NormalizedEvent[]{
  if(!body||typeof body!=='object'||!Array.isArray((body as {entry?:unknown}).entry))return [];
  const events:NormalizedEvent[]=[];
  for(const entry of (body as {entry:unknown[]}).entry){
    if(!entry||typeof entry!=='object')continue;
    const e=entry as {changes?:unknown[];messaging?:unknown[]};
    for(const change of Array.isArray(e.changes)?e.changes:[]){
      if(!change||typeof change!=='object')continue;
      const c=change as {field?:unknown;value?:Record<string,any>};if(c.field!=='comments'||!c.value)continue;
      const v=c.value,from=v.from,media=v.media;
      if(typeof v.id!=='string'||typeof media?.id!=='string'||from?.id===owner)continue;
      const raw=v.timestamp||v.created_time||v.created_at;
      const ms=typeof raw==='number'?(raw>1e11?raw:raw*1000):typeof raw==='string'&&Number.isFinite(Date.parse(raw))?Date.parse(raw):0;
      events.push({kind:'comment',comment_id:v.id,igsid:typeof from?.id==='string'?from.id:'',username:typeof from?.username==='string'?from.username:undefined,
        media_id:media.id,text:typeof v.text==='string'?v.text:'',timestamp_ms:ms,timestamp:ms>0?Math.floor(ms/1000):0});
    }
    for(const message of Array.isArray(e.messaging)?e.messaging:[]){
      if(!message||typeof message!=='object')continue;
      const m=message as Record<string,any>,sender=m.sender?.id;
      if(typeof sender!=='string'||sender===owner||(m.recipient?.id&&m.recipient.id!==owner)||m.message?.is_echo||(!m.message&&!m.postback))continue;
      const ms=typeof m.timestamp==='number'&&Number.isFinite(m.timestamp)?m.timestamp:0;
      const text=m.message?.text??m.postback?.title,payload=m.postback?.payload??m.message?.quick_reply?.payload,id=m.message?.mid??m.postback?.mid;
      events.push({kind:'message',igsid:sender,message_id:typeof id==='string'?id:undefined,text:typeof text==='string'?text:undefined,
        payload:typeof payload==='string'?payload:undefined,timestamp_ms:ms,timestamp:ms?Math.floor(ms/1000):0});
    }
  }
  return events;
}
