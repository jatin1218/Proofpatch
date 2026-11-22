import test from 'node:test';
import assert from 'node:assert/strict';
import {Controller,checkedValidation} from '../src/controller';
import {clientMessage} from '../src/protocol';
import type {AgentEvent, Review, Services, Validation} from '../src/contracts';
const request={instruction:'Fix the behavior',mode:'chat' as const,workspaceUris:[]};
function fixture(){
 let review:Review={id:'r1',revision:0,snapshotId:'snapshot-0',canUndo:false,applied:false,files:[{id:'f1',path:'app.py',original:'a\nb',proposed:'A\nB',hunks:[{id:'h1',before:'a',after:'A',oldStart:1,newStart:1,state:'proposed'},{id:'h2',before:'b',after:'B',oldStart:2,newStart:2,state:'proposed'}]}]};
 const calls:string[]=[];let listener:Parameters<NonNullable<Services['subscribe']>>[0]|undefined;
 const services:Services={label:'Test adapter',subscribe(l){listener=l;return{dispose(){listener=undefined;}};},agent:{async *run(){yield {type:'text',delta:'Found '};yield {type:'text',delta:'the issue.'};yield {type:'review',review:structuredClone(review)};},async cancel(){calls.push('cancel');}},patches:{
  async decide(id,revision,file,hunk,decision){calls.push(`decide:${hunk}:${decision}`);assert.equal(revision,review.revision);review.files[0].hunks.find(h=>h.id===hunk)!.state=decision;review.revision++;review.snapshotId=`snapshot-${review.revision}`;return structuredClone(review);},
  async apply(){calls.push('apply');review.applied=true;review.canUndo=true;return structuredClone(review);},
  async undo(){calls.push('undo');review.applied=false;review.canUndo=false;return structuredClone(review);},
  async discard(){calls.push('discard');}
 },validation:{async run(r){return {state:'FRESH',snapshotId:r.snapshotId,command:'pytest',exitCode:0,fingerprint:'sha256:abc',summary:'Passed'};}}};
 const c=new Controller(()=>{});c.connect(services);
 return {c,services,calls,push:(e:Extract<AgentEvent,{type:'review'|'validation'}>)=>listener?.(e)};
}
test('streams text and preserves review without applying',async()=>{const{c,calls}=fixture();await c.start(request);assert.equal(c.state.messages.at(-1)?.text,'Found the issue.');assert.equal(c.state.status,'review');assert.deepEqual(calls,[]);});
test('accept/reject forwards IDs and revision, apply waits for every hunk',async()=>{const{c,calls}=fixture();await c.start(request);await c.decide('r1',0,'f1','h1','accepted');await assert.rejects(c.apply(),/every hunk/);await c.decide('r1',1,'f1','h2','rejected');await c.apply();assert.deepEqual(calls,['decide:h1:accepted','decide:h2:rejected','apply']);await c.undo();assert.equal(calls.at(-1),'undo');});
test('stale controls and unknown hunks never reach engine',async()=>{const{c,calls}=fixture();await c.start(request);await assert.rejects(c.decide('r1',44,'f1','h1','accepted'),/outdated/);await assert.rejects(c.decide('r1',0,'f1','unknown','accepted'),/unavailable/);assert.deepEqual(calls,[]);});
test('hunk decision invalidates earlier fresh evidence',async()=>{const{c}=fixture();await c.start(request);await c.validate();assert.equal(c.state.validation?.state,'FRESH');await c.decide('r1',0,'f1','h1','accepted');assert.equal(c.state.validation?.state,'STALE');});
test('forged fresh success or mismatching snapshot is not fresh',()=>{const v:Validation={state:'FRESH',snapshotId:'wrong',command:'pytest',exitCode:1,fingerprint:'abc',summary:'Passed'};assert.equal(checkedValidation(v).state,'STALE');});
test('pending review cannot be silently overwritten',async()=>{const{c}=fixture();await c.start(request);await assert.rejects(c.start(request),/reject all/);});
test('cancel confirms cleanup and ignores late stream events',async()=>{
 const{c,services,calls}=fixture();let release!:()=>void;let began!:()=>void;const started=new Promise<void>(r=>began=r),gate=new Promise<void>(r=>release=r);
 services.agent.run=async function*(){began();await gate;yield {type:'text',delta:'late response'};};
 const turn=c.start(request);await started;await c.stop();release();await turn;
 assert.equal(c.state.status,'cancelled');assert.equal(c.state.messages.at(-1)?.text,'');assert.ok(calls.includes('cancel'));
});
test('failed cancellation blocks new work instead of claiming success',async()=>{
 const{c,services}=fixture();let release!:()=>void;let began!:()=>void;const started=new Promise<void>(r=>began=r),gate=new Promise<void>(r=>release=r);
 services.agent.run=async function*(){began();await gate;};services.agent.cancel=async()=>{throw new Error('Runtime did not stop');};
 const turn=c.start(request);await started;await c.stop();assert.equal(c.state.status,'error');assert.equal(c.state.busy,'cleanup failed');await assert.rejects(c.start(request));release();await turn;
});
test('background conflict evidence blocks apply',async()=>{const{c,push}=fixture();await c.start(request);await c.decide('r1',0,'f1','h1','accepted');await c.decide('r1',1,'f1','h2','rejected');push({type:'validation',validation:{state:'CONFLICT',snapshotId:'snapshot-2',summary:'Disk changed'}});await assert.rejects(c.apply(),/conflict/);});
test('late validation for another snapshot is ignored',async()=>{const{c,push}=fixture();await c.start(request);await c.validate();push({type:'validation',validation:{state:'FAILED',snapshotId:'old',summary:'Old failure'}});assert.equal(c.state.validation?.state,'FRESH');});
test('validation can be cancelled without accepting late result',async()=>{
 const{c,services}=fixture();await c.start(request);let release!:(v:Validation)=>void;
 services.validation.run=()=>new Promise(r=>release=r);const validation=c.validate();const stopping=c.stop();release({state:'FRESH',snapshotId:'snapshot-0',summary:'late',command:'pytest',exitCode:0,fingerprint:'hash'});await Promise.all([validation,stopping]);assert.equal(c.state.validation,undefined);assert.equal(c.state.review,undefined);assert.equal(c.state.status,'cancelled');
});
test('runtime error becomes a visible error without apply',async()=>{const{c,services,calls}=fixture();services.agent.run=async function*(){throw new Error('Endpoint unavailable');};await c.start(request);assert.equal(c.state.status,'error');assert.match(c.state.error!,/Endpoint/);assert.deepEqual(calls,[]);});
test('bridge rejects arbitrary commands, malformed IDs and oversized prompts',()=>{for(const m of [{type:'execute',command:'shell'},{type:'send',instruction:' '},{type:'send',instruction:'a'.repeat(32001)},{type:'decide',reviewId:'r',revision:-1,fileId:'f',hunkId:'h',decision:'accepted'}])assert.equal(clientMessage.safeParse(m).success,false);});
test('overlay discard waits until runtime cancellation confirms termination',async()=>{
 const {c,services,calls}=fixture();let cancelReady!:()=>void;const gate=new Promise<void>(r=>cancelReady=r);let begun!:()=>void;const started=new Promise<void>(r=>begun=r);let end!:()=>void;const streamGate=new Promise<void>(r=>end=r);
 const normal=services.agent.run;
 services.agent.run=async function*(r,s){for await(const event of normal(r,s))yield event;begun();await streamGate;};
 services.agent.cancel=async()=>{calls.push('cancel-start');await gate;calls.push('cancel-complete');};
 const run=c.start(request);await started;const stopping=c.stop();assert.equal(calls.includes('discard'),false);cancelReady();await stopping;end();await run;assert.ok(calls.indexOf('discard')>calls.indexOf('cancel-complete'));
});
