import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createMember5Validation,type Member5Options,type ReviewSnapshot} from '../src/validation/adapter';
import {Controller} from '../src/controller';
import type {Review,Services} from '../src/contracts';
const review:Review={id:'review',revision:1,snapshotId:'member4-opaque-id',files:[],canUndo:false,applied:false};
const base=():ReviewSnapshot=>({reviewId:review.id,revision:1,snapshotId:review.snapshotId,complete:true,snapshot:{files:[{path:'sample.js',content:'export const answer=42;'}]}});
const options=(getSnapshot:Member5Options['getSnapshot']=async()=>base(),code="console.log('checked staged files')"):Member5Options=>({
 getSnapshot,checks:[{command:{kind:'test',executable:process.execPath,args:['-e',code],timeoutMs:5000}}],
 fingerprintKeyProvider:{getFingerprintKey:()=>new Uint8Array(32).fill(4)},environmentAllowlist:[],security:{secrets:true}
});
const signal=()=>new AbortController().signal;
test('real Member 5 runner feeds fresh check details into Member 3',async()=>{
 const validation=createMember5Validation(options(undefined,"const fs=require('node:fs');if(!fs.readFileSync('sample.js','utf8').includes('42'))process.exit(1);console.log('snapshot verified')"),async()=>true);
 const value=await validation.run(review,signal());assert.equal(value.state,'FRESH');assert.equal(value.snapshotId,review.snapshotId);
 assert.match(value.fingerprint!,/sha256/);assert.match(value.details!.checks[0].stdout,/snapshot verified/);assert.match(value.details!.security[0],/passed/);
 const controller=new Controller(()=>{});
 controller.connect({label:'integration test',agent:{async *run(){yield {type:'review',review}},async cancel(){}},patches:{} as Services['patches'],validation});
 await controller.start({instruction:'review',mode:'chat',workspaceUris:[]});await controller.validate();assert.equal(controller.state.validation?.state,'FRESH');
});
test('failing commands never become FRESH',async()=>{
 const result=await createMember5Validation(options(undefined,'process.exit(2)'),async()=>true).run(review,signal());assert.equal(result.state,'FAILED');assert.equal(result.exitCode,2);
});
test('missing approval and incomplete snapshots do not execute',async()=>{
 let approvals=0;const opts=options(async()=>({...base(),complete:false,limitations:['binary content']}));
 const result=await createMember5Validation(opts,async()=>{approvals++;return true}).run(review,signal());assert.equal(result.state,'NOT RUN');assert.equal(approvals,0);
 const denied=await createMember5Validation(options(),async()=>false).run(review,signal());assert.equal(denied.state,'NOT RUN');assert.equal(denied.fingerprint,undefined);
});
test('snapshot identity mismatch and conflicts block execution',async()=>{
 const mismatch=await createMember5Validation(options(async()=>({...base(),revision:2})),async()=>{throw Error('must not approve')}).run(review,signal());assert.equal(mismatch.state,'STALE');
 const conflict=await createMember5Validation(options(async()=>({...base(),conflictingPaths:['sample.js']})),async()=>true).run(review,signal());assert.equal(conflict.state,'CONFLICT');
});
test('changed content during execution demotes evidence',async()=>{
 let reads=0;const result=await createMember5Validation(options(async()=>{reads++;const v=base();if(reads>=5)v.snapshot={files:[{path:'sample.js',content:'changed'}]};return v}),async()=>true).run(review,signal());assert.equal(result.state,'STALE');
});
test('cancellation terminates running child and never reports FRESH',async()=>{
 const abort=new AbortController();const validation=createMember5Validation(options(undefined,'setTimeout(()=>{},10000)'),async()=>true);
 const task=validation.run(review,abort.signal);setTimeout(()=>abort.abort(),100);const result=await task;assert.equal(result.state,'NOT RUN');
});
test('Stop waits for validation cleanup before discarding Member 4 snapshot',async()=>{
 let finish!:(value:any)=>void;let discarded=false;
 const controller=new Controller(()=>{});controller.connect({label:'test',agent:{async *run(){yield {type:'review',review}},async cancel(){}},patches:{async discard(){discarded=true},async decide(){return review},async apply(){return review},async undo(){return review}},validation:{run:()=>new Promise(resolve=>{finish=resolve})}});
 await controller.start({instruction:'test',mode:'chat',workspaceUris:[]});const task=controller.validate();const stop=controller.stop();await new Promise(resolve=>setImmediate(resolve));assert.equal(discarded,false);
 finish({state:'NOT RUN',snapshotId:review.snapshotId,summary:'Cancelled'});await Promise.all([task,stop]);assert.equal(discarded,true);assert.equal(controller.state.status,'cancelled');
});
