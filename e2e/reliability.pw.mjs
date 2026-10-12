import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const width of [320,1440])test(`owner reliability review ${width}`,async({page})=>{
 await page.setViewportSize({width,height:850});let resolved=false,closed=false;const mutations=[];
 await page.route('**/api/automation**',async route=>{
  const request=route.request();
  if(request.method()==='POST'){const body=request.postDataJSON();mutations.push(body);if(body.action==='confirm_received')resolved=true;else closed=true;return route.fulfill({json:{ok:true}});}
  return route.fulfill({json:{status:{enabled:0,hold_reason:null,pending_events:2,pending_jobs:closed?0:1,unknown_jobs:resolved?0:1,rejected_jobs:0,attempts:2,confirmed_jobs:0,failed_conversations:1,closed_conversations:closed?2:1,oldest_pending_at:null,oldest_event_at:Date.now(),last_ingested_at:Date.now(),recipient_holds:1},
   jobs:[...(resolved?[]:[{id:'job',campaign_id:'Creator guide',recipient:'test-recipient',action:'opening',status:'unknown',error:'Send outcome unknown; no automatic replay',trace_id:'sanitized-trace',created_at:Date.now()}]),...(closed?[]:[{id:'held',campaign_id:'Paused guide',recipient:'held-recipient',action:'opening',status:'held',error:'Legacy retry deadline requires owner review',campaign_suspended:1,can_close_unresolved:1,created_at:Date.now()}])],conflicts:[],maintenance:false,next_offset:null,build_revision:'test-build',health:{connected:true,token_expired:false,generation:0,polling_enabled:false,poll:{},poll_failures:[{key:'messages:test-thread',failure_count:2,next_at:Date.now()+120000}]}}});
 });
 await page.goto('/');await page.getByLabel('Email address').fill('owner@example.com');await page.getByLabel('Password',{exact:true}).fill('mobile test password with spaces');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('button',{name:/^(Open account menu|Account & appearance)$/}).click();
 const safety=page.getByRole('region',{name:'Automation safety'});
 await expect(safety).toContainText('1 uncertain');await expect(safety).toContainText('Polling: Disabled');await expect(safety.getByRole('button',{name:'Enable sending',exact:true})).toBeDisabled();
 await expect(safety.getByRole('button',{name:/resend/i})).toHaveCount(0);
 await safety.getByRole('button',{name:'I verified receipt',exact:true}).click();
 await expect(safety).toContainText('0 uncertain');expect(mutations).toEqual([{job_id:'job',action:'confirm_received'}]);
 await expect(safety).toContainText('1 failed conversations');await expect(safety).toContainText('Campaign paused or archived');await expect(safety).toContainText('2 failed reads');
 await expect(safety.getByRole('button',{name:'I verified receipt',exact:true})).toHaveCount(0);
 await safety.getByRole('button',{name:'Close unresolved',exact:true}).click();
 await expect(safety).toContainText('2 closed unresolved');expect(mutations).toEqual([{job_id:'job',action:'confirm_received'},{job_id:'held',action:'close_unresolved'}]);
 await expect(safety).toContainText('Build test-build');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 expect((await new AxeBuilder({page}).include('.account-dialog').analyze()).violations).toEqual([]);
});
