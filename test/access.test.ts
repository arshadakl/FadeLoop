import {beforeAll,afterEach,describe,it,expect,vi} from 'vitest';
vi.mock('../src/auth/vendor/argon2.js',async()=>({argon2id:(await import('hash-wasm')).argon2id}));
import worker from '../src/index';
import {handleSession,digest,getSession} from '../src/auth/session';
import {verifyAccess} from '../src/auth/access';
import {Engine} from '../src/engine/engine';
import {SendQueue} from '../src/queue/queue';
import {upsertCampaign} from '../src/db';
import {makeTestDbWithHandle} from './helpers/fakeD1';
import {FakeClient} from './helpers/fakeClient';
import type {Env} from '../src/types';
import {hashPassword,verifyPassword} from '../src/auth/password';

const issuer='https://fixture-access.cloudflareaccess.com',origin='https://fixture.test';
let pair:CryptoKeyPair,jwk:JsonWebKey,passwordHash:string;
beforeAll(async()=>{
 pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']) as CryptoKeyPair;
 jwk=await crypto.subtle.exportKey('jwk',pair.publicKey) as JsonWebKey;passwordHash=await hashPassword('fixture-password');
});
afterEach(()=>vi.unstubAllGlobals());
const b64=(value:Uint8Array)=>Buffer.from(value).toString('base64url');
async function token(over:Record<string,unknown>={},header:Record<string,unknown>={}){
 const now=Math.floor(Date.now()/1000),head=b64(new TextEncoder().encode(JSON.stringify({alg:'RS256',kid:'fixture-key',...header})));
 const payload=b64(new TextEncoder().encode(JSON.stringify({iss:issuer,aud:['fixture-audience'],sub:'owner-subject',email:'owner@example.com',iat:now-1,exp:now+3600,...over})));
 const sig=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(`${head}.${payload}`));return `${head}.${payload}.${b64(new Uint8Array(sig))}`;
}
async function fixture(){
 const {db,raw}=makeTestDbWithHandle();
 raw.prepare('INSERT INTO owner_accounts(id,email,password_hash,updated_at) VALUES(1,?,?,0)').run('owner@example.com',passwordHash);
 const env={DB:db,AUTH_MODE:'access',ACCESS_ISSUER:issuer,ACCESS_AUDIENCE:'fixture-audience',ACCESS_OWNER_SUBJECT:'owner-subject',APP_SECRET:'fixture-secret',APP_ID:'fixture',REDIRECT_URI:origin+'/auth/callback',POLL_INTERVAL_SECONDS:'180',GRAPH_VERSION:'v23.0',MODE:'webhook',WEBHOOK_RECONCILE_SECONDS:'off',ASSETS:{fetch:async()=>new Response('asset')} as unknown as Fetcher} satisfies Env;
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{expect(String(input)).toBe(issuer+'/cdn-cgi/access/certs');return Response.json({keys:[{...jwk,kid:'fixture-key',alg:'RS256',use:'sig'}]});}));
 return {env,db,raw};
}
function request(path:string,assertion?:string,cookie='',method='GET'){
 return new Request(origin+path,{method,headers:{origin,cookie,...(assertion?{'cf-access-jwt-assertion':assertion}:{}),'content-type':'application/json'}});
}
async function login(env:Env,assertion:string){const r=await handleSession(request('/session/access',assertion,'','POST'),env,'/session/access');expect(r.status).toBe(200);return r.headers.get('set-cookie')!.split(';')[0]!;}
describe('reversible Access owner gate',()=>{
 it('validates signed issuer/audience/identity/expiry and rejects altered or unsupported tokens',async()=>{
  const {env}=await fixture(),valid=await token();expect(await verifyAccess(request('/session/access',valid),env)).toMatchObject({email:'owner@example.com'});
  for(const over of [{iss:'https://other.cloudflareaccess.com'},{aud:['wrong']},{exp:1},{iat:Math.floor(Date.now()/1000)+100},{sub:'wrong'},{nbf:9999999999}])expect(await verifyAccess(request('/session/access',await token(over)),env)).toBeNull();
  expect(await verifyAccess(request('/session/access',await token({}, {alg:'HS256'})),env)).toBeNull();
  const bits=valid.split('.');bits[1]=b64(new TextEncoder().encode(JSON.stringify({iss:issuer,aud:['fixture-audience'],sub:'owner-subject',email:'attacker@example.com',iat:1,exp:9999999999})));
  expect(await verifyAccess(request('/session/access',bits.join('.')),env)).toBeNull();
 });
 it('does not bootstrap on GET; password operations are disabled without changing the saved hash',async()=>{
  const {env,raw}=await fixture(),assertion=await token();const page=await handleSession(request('/session/access',assertion),env,'/session/access');expect(page.headers.has('set-cookie')).toBe(false);
  expect(raw.prepare('SELECT COUNT(*) n FROM owner_sessions').get()).toMatchObject({n:0});
  for(const path of ['/session/login','/session/password'])expect((await handleSession(request(path,assertion,'','POST'),env,path)).status).toBe(409);
  expect(raw.prepare('SELECT password_hash FROM owner_accounts').get()).toMatchObject({password_hash:passwordHash});
  expect(await verifyPassword('fixture-password',passwordHash)).toBe(true);
 });
 it('requires Access identity as well as the owner cookie on private routes and fails closed only on private routes',async()=>{
  const {env}=await fixture(),assertion=await token(),cookie=await login(env,assertion);
  expect((await worker.fetch(request('/api/status',undefined,cookie),env)).status).toBe(401);
  expect((await worker.fetch(request('/api/status',assertion,cookie),env)).status).toBe(200);
  expect((await worker.fetch(request('/api/status',await token({email:'other@example.com'}),cookie),env)).status).toBe(401);
  expect((await worker.fetch(request('/api/status',assertion,cookie),{...env,ACCESS_ISSUER:undefined})).status).toBe(503);
  expect((await worker.fetch(request('/health'),{...env,ACCESS_ISSUER:undefined})).status).toBe(200);
  expect((await worker.fetch(request('/api/status',undefined,cookie),{...env,AUTH_MODE:'password'})).status).toBe(200);
 });
 it('does not create an owner for another email or allow cross-origin bootstrap',async()=>{
  const {env}=await fixture();expect((await handleSession(request('/session/access',await token({email:'other@example.com'}),'','POST'),env,'/session/access')).status).toBe(403);
  const r=new Request(origin+'/session/access',{method:'POST',headers:{origin:'https://evil.test','cf-access-jwt-assertion':await token()}});
  expect((await handleSession(r,env,'/session/access')).status).toBe(403);
 });
 it('preserves active campaign/conversation/job identities through both modes and continues an existing funnel',async()=>{
  const {env,db,raw}=await fixture();raw.exec("UPDATE automation_control SET enabled=1,account_interval_ms=0,recipient_interval_ms=0; INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture','owner',9999999999)");
  await upsertCampaign(db,{campaign_id:'ongoing',media_id:'post',keywords:['LINK'],check_follow:true,ask_email:true,reward:{type:'text',value:'resource'},copy:{opening:'Tap',opening_button:'Continue',follow_button:'I followed',delivery:'Here {reward}'}});
  const client=new FakeClient(),engine=new Engine(db,client.asClient(),new SendQueue());
  const now=Math.floor(Date.now()/1000)+2;
  await engine.handleComment({kind:'comment',comment_id:'before-access',igsid:'recipient',media_id:'post',text:'LINK',timestamp:now});
  const snapshot=()=>JSON.stringify(['campaigns','conversations','auth','inbound_events','outbound_jobs','send_attempts','polling_checkpoints','instagram_connection_state'].map(t=>raw.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()));
  const before=snapshot(),assertion=await token(),cookie=await login(env,assertion);
  await worker.fetch(request('/session',assertion,cookie),env);await worker.fetch(request('/api/status',assertion,cookie),env);
  expect(snapshot()).toBe(before);expect(await getSession(request('/session',undefined,cookie),db)).not.toBeNull();
  const opening=raw.prepare("SELECT id FROM outbound_jobs WHERE action='opening'").get() as {id:string};
  await engine.handleMessage({kind:'message',message_id:'after-access',igsid:'recipient',payload:'FL1:'+opening.id,timestamp:now+1});
  expect(client.calls.privateReply).toHaveLength(1);expect(client.calls.button).toHaveLength(1);
  expect(raw.prepare("SELECT state FROM conversations WHERE campaign_id='ongoing'").get()).toMatchObject({state:'AWAITING_FOLLOW'});
  expect((await worker.fetch(request('/api/status',undefined,cookie),{...env,AUTH_MODE:'password'})).status).toBe(200);
 });
 it('allows signed webhook persistence and idle scheduled execution with no browser identity',async()=>{
  const {env,raw}=await fixture();raw.exec("INSERT INTO auth(id,access_token,ig_user_id,expires_at) VALUES(1,'fixture','owner',9999999999)");
  const body=JSON.stringify({entry:[]}),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.APP_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const sig=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(body));
  const r=await worker.fetch(new Request(origin+'/webhook',{method:'POST',body,headers:{'x-hub-signature-256':'sha256='+Buffer.from(sig).toString('hex')}}),{...env,ACCESS_ISSUER:undefined});expect(r.status).toBe(200);
  await expect(worker.scheduled({cron:'* * * * *'} as ScheduledController,{...env,ACCESS_ISSUER:undefined})).resolves.toBeUndefined();
 });
});
