import { randomUUID } from 'node:crypto';
import type { AgentEvent, Request, Review, Services, State, Validation } from './contracts';
export const initialState = ():State => ({status:'idle',service:'No integration connected',demo:false,connected:false,messages:[],activity:[],tools:[],context:[],budget:0,used:0});
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
export function checkedValidation(v:Validation, review?:Review):Validation {
 if(v.state==='FRESH' && (v.exitCode!==0 || !v.command || !v.fingerprint || v.snapshotId!==review?.snapshotId))
  return {...v,state:'STALE',summary:'Evidence does not establish success for the current snapshot. Revalidate.'};
 return v;
}
export class Controller {
 state=initialState(); private services?:Services; private abort?:AbortController; private validationTask?:Promise<Validation>; private generation=0; private subscription?:{dispose():void};
 constructor(private changed:(state:State)=>void){}
 emit(){this.changed(structuredClone(this.state));}
 get locked(){return !!this.state.busy || this.state.status==='running'||this.state.status==='cancelling';}
 connect(services:Services){
  if(this.locked || (this.state.review && !this.state.review.applied && this.state.review.files.some(f=>f.hunks.some(h=>h.state!=='rejected')))) throw new Error('Finish the current review before switching integrations.');
  this.subscription?.dispose();this.services=services;this.state={...initialState(),connected:true,service:services.label,capabilities:services.capabilities,demo:!!services.demo};
  this.subscription=services.subscribe?.(event=>{
   if(this.services!==services||this.state.status==='cancelling'||this.state.status==='cancelled')return;
   const r=this.state.review;if(!r)return;
   if(event.type==='review' && event.review.id===r.id && event.review.revision>r.revision)this.setReview(event.review);
   if(event.type==='validation' && event.validation.snapshotId===r.snapshotId)this.state.validation=checkedValidation(event.validation,r);
   this.emit();
  });this.emit();
 }
 disconnect(){this.subscription?.dispose();this.subscription=undefined;this.generation++;this.abort?.abort();this.services=undefined;this.state=initialState();this.emit();}
 fail(e:unknown){this.state.error=errorText(e);this.emit();}
 async start(input:Omit<Request,'id'>){
  if(!this.services)throw new Error('Connect the team integration or start Demo Mode.');
  if(this.locked)throw new Error('A request or review operation is already running.');
  if(this.state.review && !this.state.review.applied && this.state.review.files.some(f=>f.hunks.some(h=>h.state!=='rejected')))
   throw new Error('Apply the accepted changes or reject all hunks before starting a new request.');
  const services=this.services;
  const oldReview=this.state.review;
  const id=randomUUID(), generation=++this.generation, abort=this.abort=new AbortController();
  this.state={...initialState(),service:services.label,capabilities:services.capabilities,demo:!!services.demo,connected:true,status:'running',requestId:id,
   messages:[...this.state.messages.slice(-38),{role:'user',text:input.instruction},{role:'assistant',text:''}]};this.emit();
  try{
   if(oldReview && !oldReview.applied)await services.patches.discard(oldReview.id);
   if(abort.signal.aborted)return;
   for await(const event of services.agent.run({...input,id},abort.signal)){
    if(generation!==this.generation || abort.signal.aborted)break;
    this.event(event);this.emit();
   }
   if(generation===this.generation){this.state.status=this.state.error?'error':this.state.review?'review':'idle';}
  }catch(e){if(generation===this.generation){this.state.status='error';this.state.error=errorText(e);}}
  finally{if(generation===this.generation){this.abort=undefined;this.emit();}}
 }
 private event(e:AgentEvent){
  switch(e.type){
   case 'text': {const last=this.state.messages.at(-1);if(last?.role==='assistant')last.text=(last.text+e.delta).slice(-200000);break;}
   case 'progress': this.state.activity=[...this.state.activity,e.message].slice(-100);break;
   case 'tool': this.state.tools=[...this.state.tools.filter(t=>t.id!==e.id),e].slice(-100);break;
   case 'context': this.state.context=e.items;this.state.budget=e.budget;this.state.used=e.used;break;
   case 'review': this.setReview(e.review);break;
   case 'validation': this.state.validation=checkedValidation(e.validation,this.state.review);break;
   case 'error': this.state.error=e.message;break;
  }
 }
 private setReview(review:Review){
  const prior=this.state.review;this.state.review=review;
  if(this.state.validation && (prior?.snapshotId!==review.snapshotId || prior?.revision!==review.revision))
   this.state.validation={...this.state.validation,state:'STALE',summary:'Staged content changed. Run validation again.'};
 }
 async stop(){
  if(!this.abort || !this.services || this.state.status==='cancelling')return;
  const services=this.services, id=this.state.requestId, review=this.state.review;
  ++this.generation;this.abort.abort();this.abort=undefined;this.state.status='cancelling';this.emit();
  // Do not claim cancellation until the adapter confirms runtime/child-process cleanup.
  try{
   if(id)await services.agent.cancel(id);
   if(this.validationTask)await this.validationTask;
   // Wait for runtime termination before clearing the overlay: late tools must not recreate it.
   if(review)await services.patches.discard(review.id);
   this.state.review=undefined;this.state.validation=undefined;this.state.status='cancelled';
  }catch(e){this.state.status='error';this.state.error=`Cancellation cleanup failed: ${errorText(e)}. Resolve this with the integration before starting again.`;this.state.busy='cleanup failed';}
  this.emit();
 }
 async decide(reviewId:string,revision:number,fileId:string,hunkId:string,decision:'accepted'|'rejected'){
  await this.operation('Updating review',async(s,r)=>{
   if(reviewId!==r.id||revision!==r.revision)throw new Error('This review is outdated. Use the latest controls.');
   const h=r.files.find(f=>f.id===fileId)?.hunks.find(h=>h.id===hunkId);
   if(!h||h.state==='applied'||r.applied)throw new Error('Hunk is unavailable for review.');
   this.setReview(await s.patches.decide(r.id,r.revision,fileId,hunkId,decision));
   if(this.state.validation)this.state.validation={...this.state.validation,state:'STALE',summary:'Review decision changed. Revalidate the staged snapshot.'};
  });
 }
 async apply(){await this.operation('Applying',async(s,r)=>{
  if(r.applied||!r.files.some(f=>f.hunks.some(h=>h.state==='accepted')))throw new Error('Accept at least one hunk first.');
  if(r.files.some(f=>f.hunks.some(h=>h.state==='proposed')))throw new Error('Review every hunk before Apply.');
  if(this.state.validation?.state==='CONFLICT')throw new Error('Resolve the workspace conflict before applying.');
  this.setReview(await s.patches.apply(r.id,r.revision));
 });}
 async undo(){await this.operation('Undoing',async(s,r)=>{if(!r.canUndo)throw new Error('No apply operation to undo.');this.setReview(await s.patches.undo(r.id,r.revision));});}
 async validate(){await this.operation('Validating',async(s,r)=>{
  const abort=this.abort=new AbortController(),generation=this.generation;
  try{const result=await (this.validationTask=s.validation.run(r,abort.signal));if(!abort.signal.aborted&&generation===this.generation)this.state.validation=checkedValidation(result,this.state.review);}
  finally{this.validationTask=undefined;if(this.abort===abort)this.abort=undefined;}
 });}
 private async operation(label:string,fn:(s:Services,r:Review)=>Promise<void>){
  if(this.locked)throw new Error('Wait for the current operation to finish.');
  if(!this.services||!this.state.review)throw new Error('No review is available.');
  this.state.busy=label;this.state.error=undefined;this.emit();
  try{await fn(this.services,this.state.review);}catch(e){this.state.error=errorText(e);throw e;}
  finally{if(this.state.busy!=='cleanup failed')this.state.busy=undefined;this.emit();}
 }
}
